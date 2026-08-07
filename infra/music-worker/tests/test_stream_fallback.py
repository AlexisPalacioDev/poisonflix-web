"""Tests for the removed fragmented-bytes fallback (Task 1).

The old behaviour re-proxied the raw DASH-fragmented upstream whenever the
progressive remux cache failed to build, on the theory that "a doubled
duration beats no audio". That is backwards: a doubled duration means the
audio element's `ended` event never fires on time, so the queue never
advances and the whole playback session hangs — one track failing outright
(which the client's `onError` already skips past) is strictly better.
"""

import subprocess
import unittest
from unittest import mock

from tests._pathsetup import server


class _FakeHandler:
    """Duck-types just enough of BaseHTTPRequestHandler for server.Handler's
    unbound methods to run without a real socket."""

    def __init__(self, range_header=None):
        self.headers = {"Range": range_header} if range_header else {}
        self.sent = None
        self.served_cache_calls = []

    def _send(self, status, payload):
        self.sent = (status, payload)

    def _serve_cached_stream(self, path, range_header):
        self.served_cache_calls.append((path, range_header))
        return False  # simulate: file vanished / never existed


class StreamFallbackRemovedTests(unittest.TestCase):
    def test_no_fragmented_proxy_helpers_remain_in_the_module(self):
        # Regression guard for the fallback itself: these existed ONLY to
        # support re-proxying the fragmented upstream and must be gone, not
        # merely unreachable dead code.
        self.assertFalse(hasattr(server, "_open_stream_upstream"))
        self.assertFalse(hasattr(server, "_neutralize_sidx"))

    def test_failed_remux_returns_an_explicit_error_not_fragmented_bytes(self):
        fake = _FakeHandler()
        with mock.patch.object(server, "_build_stream_cache", return_value=None), \
             mock.patch.object(server.os.path, "exists", return_value=False):
            server.Handler._stream(fake, {"videoId": ["dQw4w9WgXcQ"]})

        self.assertIsNotNone(fake.sent, "must send a response instead of proxying")
        status, payload = fake.sent
        self.assertGreaterEqual(status, 400, "a failed track must not look like a 2xx stream")
        self.assertEqual(payload.get("videoId"), "dQw4w9WgXcQ")

    def test_build_raising_also_fails_the_track_instead_of_proxying(self):
        fake = _FakeHandler()
        with mock.patch.object(
            server, "_build_stream_cache", side_effect=RuntimeError("boom")
        ), mock.patch.object(server.os.path, "exists", return_value=False):
            server.Handler._stream(fake, {"videoId": ["dQw4w9WgXcQ"]})

        self.assertIsNotNone(fake.sent)
        status, _ = fake.sent
        self.assertGreaterEqual(status, 400)

    def test_successful_cache_build_is_served_and_never_errors(self):
        fake = _FakeHandler()

        def fake_serve(path, range_header):
            fake.sent = ("served", path)
            return True

        fake._serve_cached_stream = fake_serve
        with mock.patch.object(server, "_build_stream_cache", return_value="/cache/x.m4a"), \
             mock.patch.object(server.os.path, "exists", return_value=False), \
             mock.patch.object(server.os, "utime", return_value=None):
            server.Handler._stream(fake, {"videoId": ["dQw4w9WgXcQ"]})

        self.assertEqual(fake.sent, ("served", "/cache/x.m4a"))


class BuildStreamCacheValidationTests(unittest.TestCase):
    """server._build_stream_cache must reject an ffmpeg exit-0 that produced
    an unplayable file — not just check the returncode."""

    def setUp(self):
        self.tmp = mock.patch.object(server, "STREAM_CACHE_DIR", "/tmp/pf-streamcache-test")
        self.tmp.start()
        self.addCleanup(self.tmp.stop)

    def test_remux_rejected_by_validation_returns_none_and_does_not_replace(self):
        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        with mock.patch.object(server, "_remux_lock_for", return_value=mock.MagicMock(
            __enter__=mock.Mock(), __exit__=mock.Mock(return_value=False)
        )), mock.patch.object(
            server.os.path, "exists", side_effect=lambda p: ".out." in p
        ), \
             mock.patch.object(server.os, "makedirs"), \
             mock.patch.object(server, "_fetch_upstream_to", return_value=True), \
             mock.patch.object(server, "_probe_media", return_value=None), \
             mock.patch.object(server.subprocess, "run", return_value=ok_proc), \
             mock.patch.object(server.os.path, "getsize", return_value=1024), \
             mock.patch.object(server, "_validate_audio_output", return_value=None) as validate, \
             mock.patch.object(server.os, "replace") as replace, \
             mock.patch.object(server.os, "remove"), \
             mock.patch.object(server, "_prune_stream_cache"):
            result = server._build_stream_cache("dQw4w9WgXcQ", "auto")

        self.assertIsNone(result)
        validate.assert_called_once()
        replace.assert_not_called()

    def test_aac_source_is_remuxed_with_stream_copy(self):
        """The common case (yt-dlp already gave us an m4a/AAC track): `-c
        copy` is a ~90ms remux, no re-encode, no quality loss — must stay the
        default whenever the source is already an expected codec."""
        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        with mock.patch.object(server, "_remux_lock_for", return_value=mock.MagicMock(
            __enter__=mock.Mock(), __exit__=mock.Mock(return_value=False)
        )), mock.patch.object(
            server.os.path, "exists", side_effect=lambda p: ".out." in p
        ), \
             mock.patch.object(server.os, "makedirs"), \
             mock.patch.object(server, "_fetch_upstream_to", return_value=True), \
             mock.patch.object(
                 server, "_probe_media",
                 return_value={"codecs": ["aac"], "format_name": "mp4", "duration": 180.0},
             ), \
             mock.patch.object(server.subprocess, "run", return_value=ok_proc) as run, \
             mock.patch.object(server.os.path, "getsize", return_value=1024), \
             mock.patch.object(server, "_validate_audio_output", return_value="audio/mp4"), \
             mock.patch.object(server.os, "replace"), \
             mock.patch.object(server, "_write_content_type"), \
             mock.patch.object(server, "_prune_stream_cache"):
            server._build_stream_cache("dQw4w9WgXcQ", "auto")

        ffmpeg_cmd = run.call_args.args[0]
        self.assertIn("copy", ffmpeg_cmd)
        self.assertNotIn("aac", ffmpeg_cmd)

    def test_opus_source_is_transcoded_to_aac_instead_of_stream_copied(self):
        """BLOQUEANTE 3: when the resolved bestaudio format is Opus (the
        fallback branch of `bestaudio[ext=m4a]/bestaudio`), `-c copy -f mp4`
        produces opus-in-mp4 — a container ffmpeg exits 0 for and iOS cannot
        play — which then fails validation and turns into a routine 502. The
        fix transcodes to AAC instead of copying whenever the source codec
        isn't already one this worker can serve."""
        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        with mock.patch.object(server, "_remux_lock_for", return_value=mock.MagicMock(
            __enter__=mock.Mock(), __exit__=mock.Mock(return_value=False)
        )), mock.patch.object(
            server.os.path, "exists", side_effect=lambda p: ".out." in p
        ), \
             mock.patch.object(server.os, "makedirs"), \
             mock.patch.object(server, "_fetch_upstream_to", return_value=True), \
             mock.patch.object(
                 server, "_probe_media",
                 return_value={"codecs": ["opus"], "format_name": "matroska,webm", "duration": 180.0},
             ), \
             mock.patch.object(server.subprocess, "run", return_value=ok_proc) as run, \
             mock.patch.object(server.os.path, "getsize", return_value=1024), \
             mock.patch.object(server, "_validate_audio_output", return_value="audio/mp4"), \
             mock.patch.object(server.os, "replace"), \
             mock.patch.object(server, "_write_content_type"), \
             mock.patch.object(server, "_prune_stream_cache"):
            server._build_stream_cache("dQw4w9WgXcQ", "auto")

        ffmpeg_cmd = run.call_args.args[0]
        self.assertIn("-c:a", ffmpeg_cmd)
        self.assertIn("aac", ffmpeg_cmd)
        # Must not blindly stream-copy an Opus source into an MP4 container.
        copy_index = ffmpeg_cmd.index("-c") if "-c" in ffmpeg_cmd else -1
        if copy_index != -1:
            self.assertNotEqual(ffmpeg_cmd[copy_index + 1], "copy")

    def test_unreadable_raw_probe_falls_back_to_stream_copy(self):
        """An unreadable raw probe is not itself proof of a bad codec — the
        existing post-remux `_validate_audio_output` gate is still the final
        word. Copy remains the (cheap) default when the source codec cannot
        be determined."""
        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        with mock.patch.object(server, "_remux_lock_for", return_value=mock.MagicMock(
            __enter__=mock.Mock(), __exit__=mock.Mock(return_value=False)
        )), mock.patch.object(
            server.os.path, "exists", side_effect=lambda p: ".out." in p
        ), \
             mock.patch.object(server.os, "makedirs"), \
             mock.patch.object(server, "_fetch_upstream_to", return_value=True), \
             mock.patch.object(server, "_probe_media", return_value=None), \
             mock.patch.object(server.subprocess, "run", return_value=ok_proc) as run, \
             mock.patch.object(server.os.path, "getsize", return_value=1024), \
             mock.patch.object(server, "_validate_audio_output", return_value="audio/mp4"), \
             mock.patch.object(server.os, "replace"), \
             mock.patch.object(server, "_write_content_type"), \
             mock.patch.object(server, "_prune_stream_cache"):
            server._build_stream_cache("dQw4w9WgXcQ", "auto")

        ffmpeg_cmd = run.call_args.args[0]
        self.assertIn("copy", ffmpeg_cmd)


if __name__ == "__main__":
    unittest.main()
