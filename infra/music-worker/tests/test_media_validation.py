"""Tests for the ffprobe-backed validation added to close the doubled-duration
defect described in server.py's iOS fMP4 comment block.

Most tests below mock ffmpeg/ffprobe subprocess calls. `RealFfmpegValidationTests`
deliberately does NOT — see its docstring for why a mocked-only suite here was
itself the bug that let BLOQUEANTE 1 through.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from tests._pathsetup import server


def _ffprobe_result(
    returncode=0, codecs=("aac",), format_name="mov,mp4,m4a", duration="161.469000", streams=None
):
    """Build a fake `ffprobe -of json` payload. `streams`, when given, lets a
    test describe a full multi-stream file (codec_type, attached_pic) instead
    of the simplified `codecs` shorthand, which always produces plain
    `codec_type: audio` streams."""
    if streams is None:
        streams = [{"codec_name": c, "codec_type": "audio"} for c in codecs]
    payload = {
        "streams": streams,
        "format": {"format_name": format_name, "duration": duration},
    }
    return subprocess.CompletedProcess(
        args=["ffprobe"], returncode=returncode, stdout=json.dumps(payload), stderr=""
    )


def _video_stream(codec_name="mjpeg", attached_pic=True):
    return {
        "codec_name": codec_name,
        "codec_type": "video",
        "disposition": {"attached_pic": 1 if attached_pic else 0},
    }


class ProbeMediaTests(unittest.TestCase):
    """server._probe_media parses ffprobe's `-of json` output."""

    def test_parses_codec_container_and_duration(self):
        with mock.patch.object(server.subprocess, "run", return_value=_ffprobe_result()) as run:
            info = server._probe_media("/tmp/whatever.m4a")
        self.assertIsNotNone(info)
        self.assertEqual(info["codecs"], ["aac"])
        self.assertIn("mp4", info["format_name"])
        self.assertAlmostEqual(info["duration"], 161.469, places=2)
        # Must invoke ffprobe, not ffmpeg, and must ask for exactly the fields
        # the design calls for.
        called_cmd = run.call_args.args[0]
        self.assertEqual(called_cmd[0], "ffprobe")
        self.assertIn("-of", called_cmd)
        self.assertIn("json", called_cmd)

    def test_nonzero_returncode_is_a_failed_probe(self):
        with mock.patch.object(
            server.subprocess, "run", return_value=_ffprobe_result(returncode=1)
        ):
            info = server._probe_media("/tmp/corrupt.m4a")
        self.assertIsNone(info)

    def test_malformed_json_is_a_failed_probe(self):
        bad = subprocess.CompletedProcess(
            args=["ffprobe"], returncode=0, stdout="not json at all", stderr=""
        )
        with mock.patch.object(server.subprocess, "run", return_value=bad):
            info = server._probe_media("/tmp/weird.m4a")
        self.assertIsNone(info)

    def test_subprocess_error_is_a_failed_probe(self):
        with mock.patch.object(
            server.subprocess, "run", side_effect=subprocess.TimeoutExpired("ffprobe", 15)
        ):
            info = server._probe_media("/tmp/slow.m4a")
        self.assertIsNone(info)

    def test_missing_duration_is_none_not_a_crash(self):
        payload = {"streams": [{"codec_name": "aac"}], "format": {"format_name": "mp4"}}
        result = subprocess.CompletedProcess(
            args=["ffprobe"], returncode=0, stdout=json.dumps(payload), stderr=""
        )
        with mock.patch.object(server.subprocess, "run", return_value=result):
            info = server._probe_media("/tmp/no-duration.m4a")
        self.assertIsNotNone(info)
        self.assertIsNone(info["duration"])

    def test_embedded_cover_stream_is_excluded_from_codecs(self):
        """The BLOQUEANTE 1 reproduction: yt-dlp's --embed-thumbnail leaves an
        mjpeg `covr` atom that ffprobe reports as a second stream. It must
        never show up in `codecs` — an embedded cover is desirable, not a
        defect, and treating it as an unexpected codec deletes every download
        that has a thumbnail (which is every download, by default)."""
        streams = [
            {"codec_name": "aac", "codec_type": "audio"},
            _video_stream("mjpeg", attached_pic=True),
        ]
        with mock.patch.object(
            server.subprocess, "run", return_value=_ffprobe_result(streams=streams)
        ):
            info = server._probe_media("/tmp/with-cover.m4a")
        self.assertEqual(info["codecs"], ["aac"])

    def test_non_audio_stream_excluded_even_without_attached_pic_flag(self):
        """Belt-and-braces: anything whose codec_type isn't `audio` is not a
        candidate for the audio codec gate, disposition or not."""
        streams = [
            {"codec_name": "aac", "codec_type": "audio"},
            {"codec_name": "png", "codec_type": "video"},
        ]
        with mock.patch.object(
            server.subprocess, "run", return_value=_ffprobe_result(streams=streams)
        ):
            info = server._probe_media("/tmp/weird-video-stream.m4a")
        self.assertEqual(info["codecs"], ["aac"])

    def test_probe_requests_codec_type_and_disposition(self):
        """Regression guard for the fix itself: the ffprobe invocation must
        actually ask for codec_type and attached_pic, or there is nothing to
        filter on."""
        with mock.patch.object(server.subprocess, "run", return_value=_ffprobe_result()) as run:
            server._probe_media("/tmp/whatever.m4a")
        called_cmd = " ".join(run.call_args.args[0])
        self.assertIn("codec_type", called_cmd)
        self.assertIn("attached_pic", called_cmd)


class ValidateAudioOutputTests(unittest.TestCase):
    """server._validate_audio_output — the real acceptance gate for any file
    this worker is about to serve or keep, not just `returncode == 0`."""

    def _probe_map(self, mapping):
        """Route server._probe_media(path) through a dict keyed by path."""
        return mock.patch.object(server, "_probe_media", side_effect=lambda p: mapping.get(p))

    def test_accepts_aac_in_mp4_with_sane_duration(self):
        probes = {
            "/out.m4a": {"codecs": ["aac"], "format_name": "mov,mp4,m4a", "duration": 161.4},
        }
        with self._probe_map(probes):
            content_type = server._validate_audio_output("vid123", "/out.m4a")
        self.assertEqual(content_type, "audio/mp4")

    def test_rejects_ffmpeg_8_opus_in_mp4_exit_zero_case(self):
        """ffmpeg 8.0.1 happily muxes Opus into an MP4 container and exits 0 —
        this is the exact ffprobe-blind case the task description calls out."""
        probes = {
            "/out.m4a": {"codecs": ["opus"], "format_name": "mov,mp4,m4a", "duration": 161.4},
        }
        with self._probe_map(probes):
            content_type = server._validate_audio_output("vid123", "/out.m4a")
        self.assertIsNone(content_type)

    def test_rejects_unreadable_output(self):
        with mock.patch.object(server, "_probe_media", return_value=None):
            content_type = server._validate_audio_output("vid123", "/out.m4a")
        self.assertIsNone(content_type)

    def test_rejects_non_finite_or_zero_duration(self):
        for bad_duration in (None, 0, -1.0):
            probes = {
                "/out.m4a": {"codecs": ["aac"], "format_name": "mp4", "duration": bad_duration},
            }
            with self._probe_map(probes):
                content_type = server._validate_audio_output("vid123", "/out.m4a")
            self.assertIsNone(content_type, msg=f"duration={bad_duration!r} should be rejected")

    def test_rejects_doubled_duration_against_raw_source(self):
        """The core device-observed defect: elementDuration 322.926 for a
        trackDuration 162 source is a ~2x ratio. A remux landing there must be
        rejected instead of served."""
        probes = {
            "/raw.opus": {"codecs": ["opus"], "format_name": "webm", "duration": 162.0},
            "/out.m4a": {"codecs": ["aac"], "format_name": "mp4", "duration": 322.926},
        }
        with self._probe_map(probes):
            content_type = server._validate_audio_output(
                "vid123", "/out.m4a", raw_path="/raw.opus"
            )
        self.assertIsNone(content_type)

    def test_accepts_matching_duration_against_raw_source(self):
        probes = {
            "/raw.mp4": {"codecs": ["aac"], "format_name": "mp4", "duration": 161.9},
            "/out.m4a": {"codecs": ["aac"], "format_name": "mp4", "duration": 161.4},
        }
        with self._probe_map(probes):
            content_type = server._validate_audio_output(
                "vid123", "/out.m4a", raw_path="/raw.mp4"
            )
        self.assertEqual(content_type, "audio/mp4")

    def test_unreadable_raw_does_not_block_an_otherwise_valid_output(self):
        # The duplicate-duration cross-check is a bonus signal, not a hard
        # dependency — a raw file that vanished (already cleaned up) must not
        # turn a valid output into a rejected one.
        probes = {
            "/out.m4a": {"codecs": ["aac"], "format_name": "mp4", "duration": 161.4},
        }
        with self._probe_map(probes):
            content_type = server._validate_audio_output(
                "vid123", "/out.m4a", raw_path="/raw-gone.mp4"
            )
        self.assertEqual(content_type, "audio/mp4")

    def test_mp3_codec_maps_to_mpeg_content_type(self):
        probes = {
            "/out.mp3": {"codecs": ["mp3"], "format_name": "mp3", "duration": 161.4},
        }
        with self._probe_map(probes):
            content_type = server._validate_audio_output("vid123", "/out.mp3")
        self.assertEqual(content_type, "audio/mpeg")


_HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


@unittest.skipUnless(_HAS_FFMPEG, "ffmpeg/ffprobe not available in this environment")
class RealFfmpegValidationTests(unittest.TestCase):
    """Every other test in this module mocks `_probe_media` or
    `_validate_audio_output` directly — which means they exercise that the
    validator gets CALLED, never what it actually DECIDES against real
    ffmpeg/ffprobe output. This class runs the real gate against files a real
    ffmpeg produced, reproducing BLOQUEANTE 1 (an embedded cover getting the
    whole download deleted) end-to-end instead of asserting on a hand-fed
    dict."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="pf-media-validation-")
        self.addCleanup(shutil.rmtree, self._tmpdir, ignore_errors=True)

    def _path(self, name):
        return os.path.join(self._tmpdir, name)

    def _run(self, *args):
        proc = subprocess.run(args, capture_output=True, text=True, timeout=30)
        self.assertEqual(
            proc.returncode, 0, msg=f"fixture generation failed: {proc.stderr[-800:]}"
        )

    def test_plain_aac_m4a_is_accepted(self):
        out = self._path("plain.m4a")
        self._run(
            "ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
            "-c:a", "aac", "-b:a", "128k", out, "-loglevel", "error",
        )
        content_type = server._validate_audio_output("vid", out)
        self.assertEqual(content_type, "audio/mp4")

    def test_aac_with_embedded_cover_is_still_accepted(self):
        """The exact reproduction from the bug report: ffprobe reports the
        embedded thumbnail as a second `mjpeg` stream with
        disposition.attached_pic=1. Before the fix this made
        `_validate_audio_output` reject the file and `_finalize_download_output`
        delete it — every downloaded track has a thumbnail by default, so this
        was not an edge case, it was the common case."""
        plain = self._path("plain.m4a")
        cover = self._path("cover.jpg")
        out = self._path("with_cover.m4a")
        self._run(
            "ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
            "-c:a", "aac", "-b:a", "128k", plain, "-loglevel", "error",
        )
        self._run(
            "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1",
            cover, "-loglevel", "error",
        )
        self._run(
            "ffmpeg", "-y", "-i", plain, "-i", cover, "-map", "0", "-map", "1",
            "-c", "copy", "-c:v:0", "mjpeg", "-disposition:v:0", "attached_pic",
            out, "-loglevel", "error",
        )
        content_type = server._validate_audio_output("vid", out)
        self.assertEqual(content_type, "audio/mp4")

    def test_opus_muxed_into_mp4_container_is_rejected(self):
        """ffmpeg 8.0.1's exit-0-with-opus-in-mp4 case, reproduced against the
        real binary instead of a hand-authored ffprobe payload."""
        opus_src = self._path("opus.webm")
        out = self._path("opus_in_mp4.m4a")
        self._run(
            "ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
            "-c:a", "libopus", "-b:a", "96k", opus_src, "-loglevel", "error",
        )
        # `-c copy -f mp4` on an opus source is exactly what a fallback-format
        # remux does; ffmpeg happily exits 0 here even though iOS cannot
        # decode the result.
        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", opus_src, "-c", "copy", "-f", "mp4", out, "-loglevel", "error"],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 0)
        content_type = server._validate_audio_output("vid", out)
        self.assertIsNone(content_type)

    def test_fully_downloaded_fragmented_source_does_not_false_positive_the_duplicate_ratio(self):
        """SOSPECHA: a fragmented (DASH-style) raw file that only exposed a
        partial/init-segment duration to ffprobe would make a perfectly good
        full-length remux look ~2x too long and get rejected. This cannot
        happen here because `_download_chunked` never hands `raw_path` to the
        validator until every byte has landed (see its own contract: "Returns
        True ONLY when every byte landed") — ffprobe always sees the complete,
        seekable file, so it reports the real total duration rather than a
        partial one. Reproduced directly: a real fragmented mp4 (frag_keyframe
        + empty_moov, matching the DASH shape this worker downloads) probes to
        its true duration, not a fraction of it."""
        frag = self._path("frag.m4a")
        remuxed = self._path("remuxed.m4a")
        self._run(
            "ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "empty_moov+frag_keyframe+default_base_moof",
            frag, "-loglevel", "error",
        )
        self._run(
            "ffmpeg", "-y", "-i", frag, "-map", "0:a:0", "-c", "copy",
            "-movflags", "+faststart", "-f", "mp4", remuxed, "-loglevel", "error",
        )
        content_type = server._validate_audio_output("vid", remuxed, raw_path=frag)
        self.assertEqual(content_type, "audio/mp4")


if __name__ == "__main__":
    unittest.main()
