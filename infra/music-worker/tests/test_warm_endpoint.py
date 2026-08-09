"""Tests for POST /warm and the concurrent-resolve dedupe it depends on.

Motivating measurement (see server.py comments near _resolve_stream_url and
_warm_pool): `yt-dlp -g` timed on this server with the exact command
`_resolve_stream_url` runs took 2324ms, which is ~85% of a cold first play's
2.758s TTFB. Warming splits into two depths for exactly that reason:
resolving the URL alone removes most of the wait for cheap; building the
whole file is the expensive, all-or-nothing version reserved for a track
that is very likely to play next.
"""

import subprocess
import threading
import time
import unittest
from unittest import mock

from tests._pathsetup import server


class _FakeHandler:
    """Duck-types just enough of BaseHTTPRequestHandler for Handler._warm to
    run without a real socket — same shape as test_stream_fallback's
    _FakeHandler."""

    def __init__(self):
        self.sent = None

    def _send(self, status, payload):
        self.sent = (status, payload)


class WarmEndpointValidationTests(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(server, "_warm_inflight", {})
        patch.start()
        self.addCleanup(patch.stop)

    def test_missing_video_id_returns_400(self):
        fake = _FakeHandler()
        server.Handler._warm(fake, {"depth": "url"})
        self.assertEqual(fake.sent[0], 400)

    def test_invalid_video_id_returns_400(self):
        fake = _FakeHandler()
        server.Handler._warm(fake, {"videoId": "not valid!", "depth": "url"})
        self.assertEqual(fake.sent[0], 400)

    def test_invalid_source_returns_400(self):
        fake = _FakeHandler()
        server.Handler._warm(
            fake, {"videoId": "dQw4w9WgXcQ", "source": "spotify", "depth": "url"}
        )
        self.assertEqual(fake.sent[0], 400)

    def test_invalid_depth_returns_400(self):
        fake = _FakeHandler()
        server.Handler._warm(fake, {"videoId": "dQw4w9WgXcQ", "depth": "deep"})
        self.assertEqual(fake.sent[0], 400)

    def test_missing_depth_returns_400(self):
        fake = _FakeHandler()
        server.Handler._warm(fake, {"videoId": "dQw4w9WgXcQ"})
        self.assertEqual(fake.sent[0], 400)


class WarmEndpointAlreadyWarmTests(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(server, "_warm_inflight", {})
        patch.start()
        self.addCleanup(patch.stop)

    def test_url_depth_already_cached_returns_204_without_submitting(self):
        fake = _FakeHandler()
        fresh_cache = {"dQw4w9WgXcQ": ("http://cdn/x.m4a", time.monotonic() + 60)}
        with mock.patch.object(server, "_stream_cache", fresh_cache), \
             mock.patch.object(server._warm_pool, "submit") as submit:
            server.Handler._warm(fake, {"videoId": "dQw4w9WgXcQ", "depth": "url"})
        self.assertEqual(fake.sent, (204, None))
        submit.assert_not_called()

    def test_full_depth_already_on_disk_returns_204_without_submitting(self):
        fake = _FakeHandler()
        with mock.patch.object(server.os.path, "exists", return_value=True), \
             mock.patch.object(server.os.path, "getsize", return_value=1024), \
             mock.patch.object(server._warm_pool, "submit") as submit:
            server.Handler._warm(fake, {"videoId": "dQw4w9WgXcQ", "depth": "full"})
        self.assertEqual(fake.sent, (204, None))
        submit.assert_not_called()

    def test_url_depth_with_expired_cache_entry_still_warms(self):
        fake = _FakeHandler()
        expired_cache = {"dQw4w9WgXcQ": ("http://cdn/x.m4a", time.monotonic() - 1)}
        with mock.patch.object(server, "_stream_cache", expired_cache), \
             mock.patch.object(server._warm_pool, "submit") as submit:
            server.Handler._warm(fake, {"videoId": "dQw4w9WgXcQ", "depth": "url"})
        self.assertEqual(fake.sent, (202, {"status": "warming"}))
        submit.assert_called_once()


class WarmEndpointDedupeTests(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(server, "_warm_inflight", {})
        patch.start()
        self.addCleanup(patch.stop)

    def test_cold_request_submits_a_job_and_returns_202(self):
        fake = _FakeHandler()
        with mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(server._warm_pool, "submit") as submit:
            server.Handler._warm(fake, {"videoId": "dQw4w9WgXcQ", "depth": "url"})
        self.assertEqual(fake.sent, (202, {"status": "warming"}))
        submit.assert_called_once()

    def test_second_request_for_the_same_key_dedupes_without_a_second_submit(self):
        """The core requirement: two concurrent /warm calls for the same
        (videoId, depth) must not build the artifact twice."""
        fake1, fake2 = _FakeHandler(), _FakeHandler()
        with mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(server._warm_pool, "submit") as submit:
            server.Handler._warm(fake1, {"videoId": "dQw4w9WgXcQ", "depth": "url"})
            server.Handler._warm(fake2, {"videoId": "dQw4w9WgXcQ", "depth": "url"})
        self.assertEqual(fake1.sent, (202, {"status": "warming"}))
        self.assertEqual(fake2.sent, (202, {"status": "warming"}))
        submit.assert_called_once()

    def test_different_depths_for_the_same_video_do_not_dedupe_each_other(self):
        """depth="url" and depth="full" are different jobs (one cheap resolve,
        one full build) and must be tracked independently."""
        fake1, fake2 = _FakeHandler(), _FakeHandler()
        with mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(server.os.path, "exists", return_value=False), \
             mock.patch.object(server._warm_pool, "submit") as submit:
            server.Handler._warm(fake1, {"videoId": "dQw4w9WgXcQ", "depth": "url"})
            server.Handler._warm(fake2, {"videoId": "dQw4w9WgXcQ", "depth": "full"})
        self.assertEqual(fake1.sent, (202, {"status": "warming"}))
        self.assertEqual(fake2.sent, (202, {"status": "warming"}))
        self.assertEqual(submit.call_count, 2)

    def test_job_clears_its_own_inflight_marker_when_it_finishes(self):
        fake = _FakeHandler()
        captured = {}

        def fake_submit(fn):
            captured["fn"] = fn
            return mock.Mock()

        with mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(server, "_resolve_stream_url", return_value="http://cdn/x.m4a"), \
             mock.patch.object(server._warm_pool, "submit", side_effect=fake_submit):
            server.Handler._warm(fake, {"videoId": "dQw4w9WgXcQ", "depth": "url"})

            self.assertIn(("dQw4w9WgXcQ", "url"), server._warm_inflight)
            # Run the job synchronously, exactly like the pool would — INSIDE
            # the patch context, otherwise this would call the real
            # _resolve_stream_url (real yt-dlp subprocess, real 30s timeout).
            captured["fn"]()
            self.assertNotIn(("dQw4w9WgXcQ", "url"), server._warm_inflight)

    def test_job_clears_its_marker_even_if_the_build_raises(self):
        fake = _FakeHandler()
        captured = {}

        def fake_submit(fn):
            captured["fn"] = fn
            return mock.Mock()

        with mock.patch.object(server.os.path, "exists", return_value=False), \
             mock.patch.object(
                 server, "_build_stream_cache", side_effect=RuntimeError("boom")
             ), \
             mock.patch.object(server._warm_pool, "submit", side_effect=fake_submit):
            server.Handler._warm(fake, {"videoId": "dQw4w9WgXcQ", "depth": "full"})

            self.assertIn(("dQw4w9WgXcQ", "full"), server._warm_inflight)
            # Same reasoning as above: run INSIDE the patch context so this
            # exercises the mocked RuntimeError, not a real build attempt.
            captured["fn"]()  # must not propagate — warming must never crash the pool
            self.assertNotIn(("dQw4w9WgXcQ", "full"), server._warm_inflight)

    def test_full_depth_job_uses_the_dedicated_warm_chunk_pool_not_chunk_pool(self):
        """Regression guard: a depth="full" warm's download must not fetch its
        Range chunks through _chunk_pool (shared with a real play) or
        _warm_pool (self-deadlock risk — see _warm_chunk_pool's comment).
        Caught in review: the first version of this feature isolated only the
        ORCHESTRATING thread and left the download itself on _chunk_pool."""
        fake = _FakeHandler()
        captured = {}

        def fake_submit(fn):
            captured["fn"] = fn
            return mock.Mock()

        with mock.patch.object(server.os.path, "exists", return_value=False), \
             mock.patch.object(server, "_build_stream_cache") as build, \
             mock.patch.object(server._warm_pool, "submit", side_effect=fake_submit):
            server.Handler._warm(fake, {"videoId": "dQw4w9WgXcQ", "depth": "full"})
            captured["fn"]()

        build.assert_called_once_with(
            "dQw4w9WgXcQ", "auto", chunk_pool=server._warm_chunk_pool
        )

    def test_submit_failure_still_releases_the_inflight_marker(self):
        """If _warm_pool.submit itself raises (e.g. thread creation fails
        under exactly the load pressure this feature is meant to avoid
        adding to), `run` never executes and its own `finally` never fires.
        Without an explicit release here, this (videoId, depth) would report
        "already warming" forever."""
        fake = _FakeHandler()
        with mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(
                 server._warm_pool, "submit", side_effect=RuntimeError("cannot start new thread")
             ):
            server.Handler._warm(fake, {"videoId": "dQw4w9WgXcQ", "depth": "url"})

        self.assertEqual(fake.sent, (202, {"status": "warming"}))
        self.assertNotIn(("dQw4w9WgXcQ", "url"), server._warm_inflight)

    def test_backlog_at_capacity_skips_without_submitting(self):
        """_warm_inflight must stay bounded (_WARM_MAX_INFLIGHT) like every
        other client-keyed tracking dict in this file (_remux_locks,
        _transcode_timeout_counts) — an unbounded version is a client-
        triggered, unbounded yt-dlp/ffmpeg queue on a box that has already
        gone down under load once."""
        fake = _FakeHandler()
        full_backlog = {(f"video{i:03d}", "url"): True for i in range(server._WARM_MAX_INFLIGHT)}
        with mock.patch.object(server, "_warm_inflight", full_backlog), \
             mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(server._warm_pool, "submit") as submit:
            server.Handler._warm(fake, {"videoId": "dQw4w9WgXcQ", "depth": "url"})

        self.assertEqual(fake.sent, (202, {"status": "warming"}))
        submit.assert_not_called()
        self.assertNotIn(("dQw4w9WgXcQ", "url"), full_backlog)

    def test_below_capacity_still_submits_normally(self):
        fake = _FakeHandler()
        near_full_backlog = {
            (f"video{i:03d}", "url"): True for i in range(server._WARM_MAX_INFLIGHT - 1)
        }
        with mock.patch.object(server, "_warm_inflight", near_full_backlog), \
             mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(server._warm_pool, "submit") as submit:
            server.Handler._warm(fake, {"videoId": "dQw4w9WgXcQ", "depth": "url"})

        self.assertEqual(fake.sent, (202, {"status": "warming"}))
        submit.assert_called_once()
        self.assertIn(("dQw4w9WgXcQ", "url"), near_full_backlog)


class SendNoContentTests(unittest.TestCase):
    """The 204 special-case in Handler._send, exercised through the REAL
    method (every other test in this file stubs `_send` on _FakeHandler,
    which would hide a regression here entirely)."""

    class _WireHandler:
        """Records exactly what the real Handler._send would put on the
        wire, without a real socket. `wfile` is `self`: `_send` only ever
        calls `.write()` on it, and this object provides one directly."""

        def __init__(self):
            self.status = None
            self.headers = []
            self.written = b""
            self.wfile = self

        def send_response(self, status, message=None):
            self.status = status

        def send_header(self, name, value):
            self.headers.append((name, value))

        def end_headers(self):
            pass

        def write(self, data):
            self.written += data

    def test_204_has_no_body_and_no_content_type(self):
        wire = self._WireHandler()
        server.Handler._send(wire, 204, None)

        self.assertEqual(wire.status, 204)
        self.assertEqual(wire.written, b"")
        header_names = {name.lower() for name, _ in wire.headers}
        self.assertNotIn("content-type", header_names)
        self.assertIn(("Content-Length", "0"), wire.headers)

    def test_non_204_status_still_gets_a_json_body(self):
        wire = self._WireHandler()
        server.Handler._send(wire, 400, {"error": "invalid depth"})

        self.assertEqual(wire.status, 400)
        self.assertEqual(wire.written, b'{"error": "invalid depth"}')
        header_names = {name.lower() for name, _ in wire.headers}
        self.assertIn("content-type", header_names)


class DownloadChunkedPoolSelectionTests(unittest.TestCase):
    """Lower-level guard for the same F1 fix: _download_chunked must submit
    chunk fetches to whichever pool it is given, defaulting to _chunk_pool."""

    def _run_multichunk_download(self, pool_kwarg):
        # Two chunks: force the multi-chunk loop (the one that touches a pool)
        # instead of the single-first-chunk short circuits.
        total = server._CHUNK_BYTES + 10
        first_body = b"a" * server._CHUNK_BYTES
        rest_body = b"b" * 10

        call_count = {"n": 0}

        def fake_range_get(url, start, end, cap=None):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return first_body, total
            return rest_body, total

        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            dest = f"{tmp}/out.bin"
            with mock.patch.object(server, "_range_get", side_effect=fake_range_get):
                ok = server._download_chunked("http://cdn/x.m4a", dest, **pool_kwarg)
        return ok

    def test_default_pool_is_chunk_pool(self):
        with mock.patch.object(server, "_chunk_pool") as fake_pool:
            fake_pool.map.return_value = [b"b" * 10]
            self._run_multichunk_download({})
        fake_pool.map.assert_called_once()

    def test_explicit_pool_overrides_the_default(self):
        custom_pool = mock.Mock()
        custom_pool.map.return_value = [b"b" * 10]
        with mock.patch.object(server, "_chunk_pool") as fake_default_pool:
            self._run_multichunk_download({"chunk_pool": custom_pool})
        custom_pool.map.assert_called_once()
        fake_default_pool.map.assert_not_called()


class ResolveStreamUrlDedupeTests(unittest.TestCase):
    """_resolve_stream_url is the function POST /warm(depth="url") calls
    directly, and that a real play's _build_stream_cache -> _fetch_upstream_to
    also calls. Dedupe lives here so BOTH paths — and any real play racing a
    warm of the same track — share one in-flight yt-dlp subprocess."""

    def test_second_caller_waits_and_reuses_the_first_callers_result(self):
        """Regression guard against a false green: if the owner thread writes
        the result BEFORE the caller under test ever reaches the dedupe
        branch, this call returns from the top-level cache check at the top
        of _resolve_stream_url and never exercises the waiter branch at all
        — the assertions below would still pass with the whole dedupe
        mechanism deleted. `_ObservedEvent.wait` proves the waiter branch was
        actually entered before the owner is allowed to finish."""
        video_id = "dQw4w9WgXcQ"
        real_event = threading.Event()
        waiting_started = threading.Event()

        class _ObservedEvent:
            def wait(self, timeout=None):
                waiting_started.set()
                return real_event.wait(timeout)

        def owner_finishes():
            # Do not publish the result until the caller under test is
            # PROVABLY blocked inside event.wait() — otherwise this thread
            # could win the race and the caller would short-circuit on the
            # cache hit before ever consulting _resolve_inflight.
            self.assertTrue(waiting_started.wait(2), "waiter branch was never entered")
            with server._stream_lock:
                server._stream_cache[video_id] = (
                    "http://cdn/owner.m4a",
                    time.monotonic() + 60,
                )
            real_event.set()

        with mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(server, "_resolve_inflight", {video_id: _ObservedEvent()}), \
             mock.patch.object(server.subprocess, "run") as run:
            threading.Thread(target=owner_finishes).start()
            # We are NOT the owner: an inflight entry for this videoId already
            # exists, so this call must wait on it and reuse the result
            # instead of invoking yt-dlp itself.
            result = server._resolve_stream_url(video_id, "auto")

        self.assertTrue(waiting_started.is_set(), "the waiter branch must actually run")
        self.assertEqual(result, "http://cdn/owner.m4a")
        run.assert_not_called()

    def test_waiter_returns_none_if_the_owner_finishes_without_a_result(self):
        video_id = "dQw4w9WgXcQ"
        owner_event = threading.Event()
        owner_event.set()  # owner already finished, but failed (no cache entry)

        with mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(server, "_resolve_inflight", {video_id: owner_event}), \
             mock.patch.object(server.subprocess, "run") as run:
            result = server._resolve_stream_url(video_id, "auto")

        self.assertIsNone(result)
        run.assert_not_called()

    def test_waiter_gives_up_after_timeout_and_resolves_independently(self):
        """Safety valve: yt-dlp's own subprocess timeout (30s) bounds a
        legitimate owner, so a stuck owner should not happen — but a waiter
        must not hang forever if it does."""
        video_id = "dQw4w9WgXcQ"
        stuck_event = threading.Event()  # never set
        ok_proc = subprocess.CompletedProcess(
            args=["yt-dlp"], returncode=0, stdout="http://cdn/independent.m4a\n", stderr=""
        )

        with mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(server, "_resolve_inflight", {video_id: stuck_event}), \
             mock.patch.object(server, "_RESOLVE_WAIT_TIMEOUT_S", 0.05), \
             mock.patch.object(server.subprocess, "run", return_value=ok_proc) as run:
            result = server._resolve_stream_url(video_id, "auto")

        self.assertEqual(result, "http://cdn/independent.m4a")
        run.assert_called_once()

    def test_concurrent_resolves_of_the_same_video_id_call_yt_dlp_once(self):
        call_count = 0
        call_lock = threading.Lock()
        started = threading.Event()
        release = threading.Event()
        ok_proc = subprocess.CompletedProcess(
            args=["yt-dlp"], returncode=0, stdout="http://cdn/shared.m4a\n", stderr=""
        )

        def fake_run(*_args, **_kwargs):
            nonlocal call_count
            with call_lock:
                call_count += 1
            started.set()
            release.wait(5)
            return ok_proc

        results = []

        def worker():
            results.append(server._resolve_stream_url("dQw4w9WgXcQ", "auto"))

        with mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(server, "_resolve_inflight", {}), \
             mock.patch.object(server.subprocess, "run", side_effect=fake_run):
            t1 = threading.Thread(target=worker)
            t1.start()
            self.assertTrue(started.wait(2), "owner thread should have started resolving")
            t2 = threading.Thread(target=worker)
            t2.start()
            time.sleep(0.1)  # give t2 a chance to register as a waiter, not a second owner
            release.set()
            t1.join(5)
            t2.join(5)

        self.assertEqual(call_count, 1, "only one yt-dlp subprocess for two concurrent resolves")
        self.assertEqual(results, ["http://cdn/shared.m4a", "http://cdn/shared.m4a"])

    def test_successful_resolve_cleans_up_its_own_inflight_entry(self):
        video_id = "dQw4w9WgXcQ"
        ok_proc = subprocess.CompletedProcess(
            args=["yt-dlp"], returncode=0, stdout="http://cdn/z.m4a\n", stderr=""
        )
        inflight = {}
        with mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(server, "_resolve_inflight", inflight), \
             mock.patch.object(server.subprocess, "run", return_value=ok_proc):
            server._resolve_stream_url(video_id, "auto")
        self.assertNotIn(video_id, inflight)

    def test_force_bypasses_dedupe_entirely(self):
        """force=True is used for the post-403/410 re-resolve retry, which
        needs a genuinely fresh URL every time — it must not wait on, or
        register itself in, the shared inflight map."""
        video_id = "dQw4w9WgXcQ"
        ok_proc = subprocess.CompletedProcess(
            args=["yt-dlp"], returncode=0, stdout="http://cdn/forced.m4a\n", stderr=""
        )
        inflight = {}
        with mock.patch.object(server, "_stream_cache", {}), \
             mock.patch.object(server, "_resolve_inflight", inflight), \
             mock.patch.object(server.subprocess, "run", return_value=ok_proc) as run:
            result = server._resolve_stream_url(video_id, "auto", force=True)
        self.assertEqual(result, "http://cdn/forced.m4a")
        run.assert_called_once()
        self.assertEqual(inflight, {})


if __name__ == "__main__":
    unittest.main()
