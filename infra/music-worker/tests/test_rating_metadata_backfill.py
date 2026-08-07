"""Repairing likes that were stored without renderable metadata.

The reported bug: "Tus me gusta" rendered raw videoIds (`N-iWzk2_fOM`,
`J3DWAJGaf7o`) with "Desconocido" as the artist and no artwork. Reproduced on
the running worker: a vote posted without title/artist/thumb comes back from
`GET /ratings` as `title: "<videoId>"`, `artist: null`, because `user_liked`
falls back to `row.get("title") or vid` and nothing ever resolves the id
afterwards.

The frontend side of that is fixed separately (`MusicResultRow` now sends the
metadata it always had). This is the other half: rows ALREADY stored bare —
by an older client, or by any future caller that forgets — must repair
themselves instead of staying unrenderable for good. The repair is written
back so it costs one lookup ever, not one per page view.
"""

import threading
import time
import unittest
from unittest import mock

from tests._pathsetup import server


class RatingMetadataBackfillTests(unittest.TestCase):
    def setUp(self):
        # The vote table is module-global; isolate every test from the others
        # and from whatever the running container happened to persist.
        self._saved = server._ratings
        server._ratings = {}
        self.addCleanup(lambda: setattr(server, "_ratings", self._saved))
        persist = mock.patch.object(server, "_persist_ratings")
        self.persist = persist.start()
        self.addCleanup(persist.stop)

    @staticmethod
    def _watch_playlist(video_id):
        return {
            "tracks": [
                {
                    "videoId": video_id,
                    "title": "Todo Lo Bueno Tarda",
                    "artists": [{"name": "Alcolirykoz"}],
                    "album": {"name": "Recuerdos"},
                    "thumbnail": [{"url": "https://img.example/small.jpg"},
                                  {"url": "https://img.example/large.jpg"}],
                }
            ]
        }

    def test_fills_in_a_like_that_was_stored_without_metadata(self):
        server._ratings = {"u1": {"bare-vid": {"v": 1, "at": 100.0}}}
        yt = mock.Mock()
        yt.get_watch_playlist.return_value = self._watch_playlist("bare-vid")

        with mock.patch.object(server, "_get_ytmusic", return_value=yt):
            server._repair_liked_metadata_now("u1")

        liked = server.user_liked("u1")
        self.assertEqual(len(liked), 1)
        self.assertEqual(liked[0]["title"], "Todo Lo Bueno Tarda")
        self.assertEqual(liked[0]["artist"], "Alcolirykoz")
        self.assertEqual(liked[0]["thumbnailUrl"], "https://img.example/large.jpg")

    def test_writes_the_repair_back_so_it_is_paid_once(self):
        server._ratings = {"u1": {"bare-vid": {"v": 1, "at": 100.0}}}
        yt = mock.Mock()
        yt.get_watch_playlist.return_value = self._watch_playlist("bare-vid")

        with mock.patch.object(server, "_get_ytmusic", return_value=yt):
            server._repair_liked_metadata_now("u1")
            server._repair_liked_metadata_now("u1")

        # Second call has nothing left to resolve.
        self.assertEqual(yt.get_watch_playlist.call_count, 1)
        self.persist.assert_called()

    def test_leaves_a_like_that_already_has_a_title_alone(self):
        server._ratings = {
            "u1": {"good-vid": {"v": 1, "at": 100.0, "title": "Caos", "artist": "Doble Porción"}}
        }
        yt = mock.Mock()

        with mock.patch.object(server, "_get_ytmusic", return_value=yt):
            server._repair_liked_metadata_now("u1")

        yt.get_watch_playlist.assert_not_called()

    def test_ignores_dislikes_since_they_are_never_rendered(self):
        server._ratings = {"u1": {"down-vid": {"v": -1, "at": 100.0}}}
        yt = mock.Mock()

        with mock.patch.object(server, "_get_ytmusic", return_value=yt):
            server._repair_liked_metadata_now("u1")

        yt.get_watch_playlist.assert_not_called()

    def test_a_failed_lookup_leaves_the_row_readable_instead_of_raising(self):
        # YouTube is a third party on the render path of a screen the user is
        # already looking at. A dead lookup must degrade to the old fallback,
        # not 500 the whole "Tus me gusta" row.
        server._ratings = {"u1": {"bare-vid": {"v": 1, "at": 100.0}}}
        yt = mock.Mock()
        yt.get_watch_playlist.side_effect = RuntimeError("upstream is down")

        with mock.patch.object(server, "_get_ytmusic", return_value=yt):
            server._repair_liked_metadata_now("u1")

        liked = server.user_liked("u1")
        self.assertEqual(liked[0]["title"], "bare-vid")

    def test_does_nothing_for_an_anonymous_caller(self):
        yt = mock.Mock()
        with mock.patch.object(server, "_get_ytmusic", return_value=yt):
            server._repair_liked_metadata_now("")
        yt.get_watch_playlist.assert_not_called()


class RepairSchedulingTests(unittest.TestCase):
    """`repair_liked_metadata` is what `GET /ratings` calls, and that request
    must never wait on YouTube."""

    def setUp(self):
        self._saved = server._ratings
        server._ratings = {"u1": {"bare-vid": {"v": 1, "at": 100.0}}}
        self.addCleanup(lambda: setattr(server, "_ratings", self._saved))
        persist = mock.patch.object(server, "_persist_ratings")
        persist.start()
        self.addCleanup(persist.stop)
        server._repair_inflight.clear()
        self.addCleanup(server._repair_inflight.clear)

    def test_returns_while_the_lookup_is_still_hanging(self):
        # The blocker this guards: the repair used to run inline in the
        # `GET /ratings` handler, with no timeout on the ytmusicapi call, no
        # `AbortSignal` in the app's fetch wrapper and no timeout for /bff/* in
        # the Caddyfile. A stalled upstream stalled the user's screen, on a
        # route refetched every five minutes. Nothing downstream would cut it
        # short, so the handler must not be the one waiting.
        hang = threading.Event()
        entered = threading.Event()

        def never_answers(**_kwargs):
            entered.set()
            hang.wait(30)
            return {}

        yt = mock.Mock()
        yt.get_watch_playlist.side_effect = never_answers

        try:
            with mock.patch.object(server, "_get_ytmusic", return_value=yt):
                started = time.monotonic()
                server.repair_liked_metadata("u1")
                elapsed = time.monotonic() - started
                self.assertTrue(entered.wait(5), "the repair never started")
                # Elapsed time is the whole assertion. Checking only that the
                # lookup was entered, or that the hang was still set, passes
                # against the inline version too — it just takes thirty
                # seconds to do it, which is precisely the defect.
                self.assertLess(
                    elapsed, 2.0, f"the handler waited {elapsed:.1f}s on YouTube"
                )
        finally:
            hang.set()

    def test_does_not_stack_a_second_pass_while_one_is_running(self):
        started = threading.Event()
        hang = threading.Event()

        def slow(**_kwargs):
            started.set()
            hang.wait(10)
            return {}

        yt = mock.Mock()
        yt.get_watch_playlist.side_effect = slow

        try:
            with mock.patch.object(server, "_get_ytmusic", return_value=yt):
                server.repair_liked_metadata("u1")
                self.assertTrue(started.wait(5))
                server.repair_liked_metadata("u1")
                server.repair_liked_metadata("u1")
        finally:
            hang.set()

        # Three calls, one pass: the extra two found the user already in
        # flight and returned without touching YouTube.
        self.assertEqual(yt.get_watch_playlist.call_count, 1)

    def test_an_anonymous_caller_starts_no_thread(self):
        before = threading.active_count()
        server.repair_liked_metadata("")
        self.assertEqual(threading.active_count(), before)


if __name__ == "__main__":
    unittest.main()
