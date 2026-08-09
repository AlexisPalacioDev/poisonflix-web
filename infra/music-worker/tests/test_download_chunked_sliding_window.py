"""Tests for _download_chunked's sliding-window chunk fetch.

Motivating measurement (see server.py, next to _download_chunked): the old
implementation fetched _CHUNK_PARALLEL chunks with pool.map() and blocked
until the whole batch finished before asking for the next one. Measured on
the real server, one such batch had three chunks land in 0.6-0.7s each and a
fourth take 10.1s — the three fast ones then sat idle for ~9.5s. The sliding
window removes that specific waste: as soon as one request completes, the
next is submitted immediately instead of waiting out the rest of the batch.

These tests do NOT claim the 10s straggler itself is fixed — its cause is
unidentified and may be upstream throttling — only that the scheduler no
longer discards already-available concurrency slots.
"""

import tempfile
import threading
import time
import unittest
from unittest import mock

from tests._pathsetup import server


class SlidingWindowOrderingTests(unittest.TestCase):
    """Chunks can now complete out of order; the file on disk must not."""

    def test_out_of_order_completion_still_writes_correct_byte_order(self):
        """Chunk at offset 4 is made deliberately slower than the chunk that
        follows it at offset 8, so the second chunk's future resolves first.
        The final bytes on disk must still be in ascending-offset order."""
        total = 16  # first 4-byte chunk + three more 4-byte chunks
        first_body = b"AAAA"
        chunk_bodies = {4: b"BBBB", 8: b"CCCC", 12: b"DDDD"}
        # offset 4 (the first of the three) finishes LAST despite being asked
        # for first; offset 8 and 12 finish sooner.
        delays = {4: 0.12, 8: 0.0, 12: 0.03}

        def fake_range_get(url, start, end, cap=None):
            if start == 0:
                return first_body, total
            time.sleep(delays[start])
            return chunk_bodies[start], total

        with mock.patch.object(server, "_CHUNK_BYTES", 4), \
             mock.patch.object(server, "_range_get", side_effect=fake_range_get), \
             tempfile.TemporaryDirectory() as tmp:
            dest = f"{tmp}/out.bin"
            ok = server._download_chunked("http://cdn/x.m4a", dest)
            self.assertTrue(ok)
            with open(dest, "rb") as fh:
                data = fh.read()

        self.assertEqual(data, b"AAAABBBBCCCCDDDD")

    def test_refill_path_with_more_chunks_than_parallelism_lands_every_byte_correctly(self):
        """With only _CHUNK_PARALLEL (4) chunks pending, every one gets
        submitted in the initial priming loop and the refill-on-completion
        branch never runs at all — a scheduler bug there (e.g. never
        resubmitting, or resubmitting with the wrong offset) would be
        invisible to a 3-or-4-chunk test. This uses 9 remaining chunks, each
        with distinguishable content and a distinct delay, so the refill
        loop must fire repeatedly and any offset mixup shows up directly in
        the final bytes."""
        chunk_count = 9  # > _CHUNK_PARALLEL: forces multiple refill rounds
        first_body = b"0000"
        total = 4 + 4 * chunk_count
        # Each chunk's body is 4 repeats of its own index digit, so a chunk
        # landing at the wrong offset (or not landing at all) is visible
        # directly in the assembled bytes, not just in the file size.
        bodies = {4 + 4 * i: bytes(str((i + 1) % 10), "ascii") * 4 for i in range(chunk_count)}
        # Deliberately out of monotonic order and reused values, so nothing
        # about the delay schedule itself hints at completion order.
        delay_cycle = [0.05, 0.0, 0.03, 0.01, 0.04, 0.0, 0.02, 0.05, 0.0]
        delays = {start: delay_cycle[i] for i, start in enumerate(sorted(bodies))}

        def fake_range_get(url, start, end, cap=None):
            if start == 0:
                return first_body, total
            time.sleep(delays[start])
            return bodies[start], total

        with mock.patch.object(server, "_CHUNK_BYTES", 4), \
             mock.patch.object(server, "_range_get", side_effect=fake_range_get), \
             tempfile.TemporaryDirectory() as tmp:
            dest = f"{tmp}/out.bin"
            ok = server._download_chunked("http://cdn/x.m4a", dest)
            self.assertTrue(ok)
            with open(dest, "rb") as fh:
                data = fh.read()

        expected = first_body + b"".join(bodies[start] for start in sorted(bodies))
        self.assertEqual(len(data), total)
        self.assertEqual(data, expected)


class SlidingWindowFailureTests(unittest.TestCase):
    """A partial file must never be reported as a success."""

    def test_one_chunk_raising_fails_cleanly_without_partial_success(self):
        total = 16
        first_body = b"AAAA"

        def fake_range_get(url, start, end, cap=None):
            if start == 0:
                return first_body, total
            if start == 4:
                raise OSError("simulated upstream failure")
            time.sleep(0.02)  # let the other in-flight chunks actually run
            return b"X" * (end - start + 1), total

        with mock.patch.object(server, "_CHUNK_BYTES", 4), \
             mock.patch.object(server, "_range_get", side_effect=fake_range_get), \
             tempfile.TemporaryDirectory() as tmp:
            dest = f"{tmp}/out.bin"
            ok = server._download_chunked("http://cdn/x.m4a", dest)

        self.assertFalse(ok)

    def test_short_chunk_returns_false(self):
        """Upstream answers a Range request with fewer bytes than asked for.
        Writing it anyway would silently splice the audio and still reach
        `total`, so this must be refused instead."""
        total = 16
        first_body = b"AAAA"

        def fake_range_get(url, start, end, cap=None):
            if start == 0:
                return first_body, total
            if start == 4:
                return b"BB", total  # asked for 4 bytes, got 2
            return b"X" * (end - start + 1), total

        with mock.patch.object(server, "_CHUNK_BYTES", 4), \
             mock.patch.object(server, "_range_get", side_effect=fake_range_get), \
             tempfile.TemporaryDirectory() as tmp:
            dest = f"{tmp}/out.bin"
            ok = server._download_chunked("http://cdn/x.m4a", dest)

        self.assertFalse(ok)


class SlidingWindowConcurrencyCapTests(unittest.TestCase):
    """The window must never exceed _CHUNK_PARALLEL requests in flight."""

    def test_never_more_than_chunk_parallel_requests_in_flight(self):
        chunk_count = 20  # comfortably more than _CHUNK_PARALLEL
        total = 4 + 4 * chunk_count
        first_body = b"AAAA"
        lock = threading.Lock()
        state = {"current": 0, "max": 0}

        def fake_range_get(url, start, end, cap=None):
            if start == 0:
                return first_body, total
            with lock:
                state["current"] += 1
                state["max"] = max(state["max"], state["current"])
            # A real sleep, not a mock return: this is what makes the counter
            # meaningful — a mock that always resolves instantly could never
            # catch a scheduler that overshoots the cap.
            time.sleep(0.02)
            with lock:
                state["current"] -= 1
            return b"X" * (end - start + 1), total

        with mock.patch.object(server, "_CHUNK_BYTES", 4), \
             mock.patch.object(server, "_range_get", side_effect=fake_range_get), \
             tempfile.TemporaryDirectory() as tmp:
            dest = f"{tmp}/out.bin"
            ok = server._download_chunked("http://cdn/x.m4a", dest)

        self.assertTrue(ok)
        self.assertLessEqual(state["max"], server._CHUNK_PARALLEL)
        # Also prove real overlap happened, not accidental serialization.
        self.assertGreaterEqual(state["max"], server._CHUNK_PARALLEL - 1)


class TotalTriStateTests(unittest.TestCase):
    """_range_get's `total` is int | None | -1; _download_chunked must
    handle all three (see _range_get's own docstring)."""

    def test_total_minus_one_upstream_ignored_range_and_sent_everything(self):
        def fake_range_get(url, start, end, cap=None):
            return b"WHOLEFILE", -1

        with mock.patch.object(server, "_range_get", side_effect=fake_range_get), \
             tempfile.TemporaryDirectory() as tmp:
            dest = f"{tmp}/out.bin"
            ok = server._download_chunked("http://cdn/x.m4a", dest)
            self.assertTrue(ok)
            with open(dest, "rb") as fh:
                self.assertEqual(fh.read(), b"WHOLEFILE")

    def test_total_none_with_short_first_chunk_is_treated_as_complete(self):
        """No parseable Content-Range, but the first chunk came back shorter
        than a full _CHUNK_BYTES: that short read IS the whole file."""
        def fake_range_get(url, start, end, cap=None):
            return b"SHORT", None

        with mock.patch.object(server, "_range_get", side_effect=fake_range_get), \
             tempfile.TemporaryDirectory() as tmp:
            dest = f"{tmp}/out.bin"
            ok = server._download_chunked("http://cdn/x.m4a", dest)
            self.assertTrue(ok)
            with open(dest, "rb") as fh:
                self.assertEqual(fh.read(), b"SHORT")

    def test_total_none_with_a_full_first_chunk_cannot_be_bounded(self):
        """No Content-Range AND the first chunk filled the whole
        _CHUNK_BYTES: there is no way to know whether more data follows, so
        this must fail rather than silently truncate the track."""
        full_chunk = b"X" * server._CHUNK_BYTES

        def fake_range_get(url, start, end, cap=None):
            return full_chunk, None

        with mock.patch.object(server, "_range_get", side_effect=fake_range_get), \
             tempfile.TemporaryDirectory() as tmp:
            dest = f"{tmp}/out.bin"
            ok = server._download_chunked("http://cdn/x.m4a", dest)

        self.assertFalse(ok)

    def test_total_as_int_is_the_normal_multi_chunk_path(self):
        total = 12
        first_body = b"AAAA"
        rest = {4: b"BBBB", 8: b"CCCC"}

        def fake_range_get(url, start, end, cap=None):
            if start == 0:
                return first_body, total
            return rest[start], total

        with mock.patch.object(server, "_CHUNK_BYTES", 4), \
             mock.patch.object(server, "_range_get", side_effect=fake_range_get), \
             tempfile.TemporaryDirectory() as tmp:
            dest = f"{tmp}/out.bin"
            ok = server._download_chunked("http://cdn/x.m4a", dest)
            self.assertTrue(ok)
            with open(dest, "rb") as fh:
                self.assertEqual(fh.read(), b"AAAABBBBCCCC")


if __name__ == "__main__":
    unittest.main()
