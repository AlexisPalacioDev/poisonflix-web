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

    def test_unreadable_raw_probe_transcodes_instead_of_assuming_safe_copy(self):
        """ROUND 2 SOSPECHA: an unreadable raw probe is NOT proof the source
        is safe to `-c copy`. The previous version treated `raw_codecs == []`
        (the unreadable-probe case) as falsy, so it took the cheap copy path
        — if that raw was actually Opus, `-c copy -f mp4` produces the exact
        unplayable container `_validate_audio_output` rejects, killing the
        track for a source a transcode would have saved. In the genuinely
        ambiguous case (probe failed) the safe default is now to transcode."""
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
        self.assertIn("-c:a", ffmpeg_cmd)
        self.assertIn("aac", ffmpeg_cmd)


class TranscodeTimeoutTests(unittest.TestCase):
    """ROUND 2 BLOQUEANTE: measured with real ffmpeg 8.0.1 (i7-1270P) that the
    native AAC encoder ("Threading capabilities: none" per `ffmpeg -h
    encoder=aac`) takes 46.0s at 1 core to transcode a 210s/3:30 track, and a
    720s/12:00 track hits the old fixed `REMUX_TIMEOUT_S = 120` and raises
    `subprocess.TimeoutExpired`. Since the fragmented-bytes fallback is
    already gone, that timeout used to fail the track PERMANENTLY: every
    retry repeats the identical fetch + encode and times out again forever.
    This class covers three complementary fixes: (1) a faster encoder
    setting, (2) a timeout proportional to source duration instead of one
    fixed value that is guaranteed to be wrong for some duration, and (3) a
    non-terminal timeout — a video_id that has timed out once gets a
    genuinely different (cheaper) encode on its next attempt instead of
    repeating the exact path that already failed."""

    def setUp(self):
        self.tmp = mock.patch.object(server, "STREAM_CACHE_DIR", "/tmp/pf-streamcache-test")
        self.tmp.start()
        self.addCleanup(self.tmp.stop)
        server._transcode_timeout_counts.clear()
        self.addCleanup(server._transcode_timeout_counts.clear)

    def _build(self, run_side_effect, duration=180.0, video_id="dQw4w9WgXcQ"):
        lock_ctx = mock.MagicMock(__enter__=mock.Mock(), __exit__=mock.Mock(return_value=False))
        with mock.patch.object(server, "_remux_lock_for", return_value=lock_ctx), \
             mock.patch.object(server.os.path, "exists", side_effect=lambda p: ".out." in p), \
             mock.patch.object(server.os, "makedirs"), \
             mock.patch.object(server, "_fetch_upstream_to", return_value=True), \
             mock.patch.object(
                 server, "_probe_media",
                 return_value={"codecs": ["opus"], "format_name": "webm", "duration": duration},
             ), \
             mock.patch.object(server.subprocess, "run", side_effect=run_side_effect) as run, \
             mock.patch.object(server.os.path, "getsize", return_value=1024), \
             mock.patch.object(server, "_validate_audio_output", return_value="audio/mp4"), \
             mock.patch.object(server.os, "replace"), \
             mock.patch.object(server, "_write_content_type"), \
             mock.patch.object(server, "_prune_stream_cache"):
            result = server._build_stream_cache(video_id, "auto")
        return result, run

    def test_transcode_uses_fast_aac_coder_by_default(self):
        """Measured (real ffmpeg 8.0.1, this environment): `-aac_coder fast`
        cut a 210s track's 1-core transcode from ~9.5s to ~5.5s (~42% faster)
        against the default `twoloop` search, and from ~9.0s to ~5.9s
        (~34% faster) against a harder white-noise source. Must be the
        default for every transcode, not an opt-in."""
        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        result, run = self._build(run_side_effect=[ok_proc])
        self.assertIsNotNone(result)
        ffmpeg_cmd = run.call_args.args[0]
        self.assertIn("-aac_coder", ffmpeg_cmd)
        self.assertEqual(ffmpeg_cmd[ffmpeg_cmd.index("-aac_coder") + 1], "fast")

    def test_timeout_scales_with_probed_duration(self):
        """A 720s (12:00) source must not get the same timeout budget as a
        30s clip — the encoder's cost is duration-bound, so a fixed timeout
        is eventually wrong for some track no matter what it is set to."""
        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        _, run = self._build(run_side_effect=[ok_proc], duration=720.0)
        used_timeout = run.call_args.kwargs["timeout"]
        self.assertEqual(used_timeout, server.REMUX_TIMEOUT_CEILING_S)
        self.assertGreater(used_timeout, 120.0)

    def test_short_track_timeout_uses_a_sane_floor(self):
        """A tiny duration must not produce a near-zero timeout — fetch,
        decode and mux overhead alone can exceed a couple of seconds."""
        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        _, run = self._build(run_side_effect=[ok_proc], duration=5.0)
        used_timeout = run.call_args.kwargs["timeout"]
        self.assertEqual(used_timeout, server.REMUX_TIMEOUT_FLOOR_S)

    def test_mid_length_track_timeout_is_proportional_not_ceiling_or_floor(self):
        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        _, run = self._build(run_side_effect=[ok_proc], duration=210.0)
        used_timeout = run.call_args.kwargs["timeout"]
        self.assertEqual(
            used_timeout,
            max(
                server.REMUX_TIMEOUT_FLOOR_S,
                min(server.REMUX_TIMEOUT_CEILING_S, 210.0 * server.REMUX_TIMEOUT_PER_SECOND),
            ),
        )

    def test_timeout_expired_fails_the_track_without_crashing(self):
        timeout_exc = subprocess.TimeoutExpired(cmd=["ffmpeg"], timeout=120.0)
        result, _run = self._build(run_side_effect=timeout_exc, duration=720.0)
        self.assertIsNone(result)

    def test_retry_after_a_timeout_uses_a_cheaper_bitrate_not_the_same_path(self):
        """Non-terminal timeout: the FIRST attempt times out. A SECOND
        attempt for the SAME video_id must not repeat the identical ffmpeg
        invocation — it gets a lower target bitrate (cheaper for the encoder
        to search), a genuinely different strategy with a real chance of
        finishing where the first one didn't."""
        video_id = "timeoutTrack1"
        timeout_exc = subprocess.TimeoutExpired(cmd=["ffmpeg"], timeout=600.0)
        first_result, first_run = self._build(
            run_side_effect=timeout_exc, duration=720.0, video_id=video_id
        )
        self.assertIsNone(first_result)
        first_cmd = first_run.call_args.args[0]
        self.assertEqual(first_cmd[first_cmd.index("-b:a") + 1], "192k")

        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        second_result, second_run = self._build(
            run_side_effect=[ok_proc], duration=720.0, video_id=video_id
        )
        self.assertIsNotNone(second_result)
        second_cmd = second_run.call_args.args[0]
        self.assertEqual(second_cmd[second_cmd.index("-b:a") + 1], "128k")

    def test_successful_build_clears_the_timeout_marker(self):
        """A one-off timeout (system under transient load) must not
        permanently degrade quality for a video_id that goes on to succeed —
        the NEXT time it needs a transcode from scratch (e.g. after cache
        eviction), it should get the normal bitrate again."""
        video_id = "timeoutTrack2"
        timeout_exc = subprocess.TimeoutExpired(cmd=["ffmpeg"], timeout=600.0)
        self._build(run_side_effect=timeout_exc, duration=720.0, video_id=video_id)

        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        self._build(run_side_effect=[ok_proc], duration=720.0, video_id=video_id)

        # Simulate the cache entry being evicted and rebuilt from scratch.
        ok_proc2 = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        _, third_run = self._build(run_side_effect=[ok_proc2], duration=720.0, video_id=video_id)
        third_cmd = third_run.call_args.args[0]
        self.assertEqual(third_cmd[third_cmd.index("-b:a") + 1], "192k")


if __name__ == "__main__":
    unittest.main()
