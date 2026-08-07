"""Tests for `pure` seeded radios (mobile-music-overhaul: fix-seeded-rows).

The reported bug: every "Porque escuchaste X" row on the frontend showed the
same five tracks. Root cause, confirmed by running the real `_interleave`:
three of `recommendations()`'s five sources — `_src_your_artists`,
`_src_your_likes`, `_src_history` — depend only on `user_id`, not on the seed,
so every seeded radio for the same user shared over half its material in the
same positions. `_src_history` made it worse: it replays the user's own
plays, which now include the very track just used as a seed.

The fix is a `pure` flag on `recommendations()`: when set, only the
seed-dependent sources (`_src_seed`, `_src_related`) contribute, and the
seed's own videoId is excluded from the result. The default (`pure=False`,
the implicit default of every existing caller) must keep including the three
user-global sources — `useAutoplayRadio`'s "Mix para vos" wants exactly that
mixing.
"""

import unittest
from unittest import mock

from tests._pathsetup import server


def _track(video_id, artist="Artist"):
    return {
        "type": "song",
        "videoId": video_id,
        "title": f"Title {video_id}",
        "artist": artist,
        "artists": [artist],
        "album": None,
        "durationSeconds": None,
        "thumbnailUrl": None,
        "source": "ytmusic",
    }


class PureModeSourceSelectionTests(unittest.TestCase):
    """Which sources feed the radio, per mode."""

    def setUp(self):
        # Fresh cache per test: `recommendations()` memoises by (seed, user,
        # limit, pure), and a hit from an earlier test would let `_src_seed`
        # et al. go uncalled for the wrong reason.
        server._radio_cache.clear()
        patcher = mock.patch.object(server, "_get_ytmusic", return_value=object())
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_pure_mode_does_not_call_the_three_user_global_sources(self):
        with mock.patch.object(
            server, "_src_seed", return_value=([_track("seed-track")], "related-id")
        ) as seed_fn, mock.patch.object(
            server, "_src_related", return_value=[_track("related-track")]
        ) as related_fn, mock.patch.object(
            server, "_src_your_artists", return_value=[_track("artist-track")]
        ) as artists_fn, mock.patch.object(
            server, "_src_your_likes", return_value=[_track("liked-track")]
        ) as likes_fn, mock.patch.object(
            server, "_src_history", return_value=[_track("history-track")]
        ) as history_fn:
            results = server.recommendations("seed-vid", 10, user_id="u1", pure=True)

        seed_fn.assert_called_once()
        related_fn.assert_called_once()
        artists_fn.assert_not_called()
        likes_fn.assert_not_called()
        history_fn.assert_not_called()
        video_ids = {row["videoId"] for row in results}
        self.assertIn("seed-track", video_ids)
        self.assertIn("related-track", video_ids)
        self.assertNotIn("artist-track", video_ids)
        self.assertNotIn("liked-track", video_ids)
        self.assertNotIn("history-track", video_ids)

    def test_default_mode_still_calls_all_five_sources(self):
        # The implicit default (no `pure` argument at all) is what every
        # existing caller — search, `useAutoplayRadio`'s "Mix para vos" —
        # depends on, and must not change.
        with mock.patch.object(
            server, "_src_seed", return_value=([_track("seed-track")], "related-id")
        ) as seed_fn, mock.patch.object(
            server, "_src_related", return_value=[_track("related-track")]
        ) as related_fn, mock.patch.object(
            server, "_src_your_artists", return_value=[_track("artist-track")]
        ) as artists_fn, mock.patch.object(
            server, "_src_your_likes", return_value=[_track("liked-track")]
        ) as likes_fn, mock.patch.object(
            server, "_src_history", return_value=[_track("history-track")]
        ) as history_fn:
            results = server.recommendations("seed-vid", 10, user_id="u1")

        seed_fn.assert_called_once()
        related_fn.assert_called_once()
        artists_fn.assert_called_once()
        likes_fn.assert_called_once()
        history_fn.assert_called_once()
        video_ids = {row["videoId"] for row in results}
        self.assertIn("artist-track", video_ids)
        self.assertIn("liked-track", video_ids)
        self.assertIn("history-track", video_ids)

    def test_pure_mode_excludes_the_seeds_own_videoid_from_the_result(self):
        # `_src_related` returning the seed itself (YouTube's "related" set
        # sometimes echoes the seed) must not leak it back into a seeded row.
        with mock.patch.object(
            server, "_src_seed", return_value=([_track("other-track")], "related-id")
        ), mock.patch.object(
            server, "_src_related", return_value=[_track("seed-vid"), _track("related-track")]
        ):
            results = server.recommendations("seed-vid", 10, user_id="u1", pure=True)

        video_ids = [row["videoId"] for row in results]
        self.assertNotIn("seed-vid", video_ids)
        self.assertIn("other-track", video_ids)
        self.assertIn("related-track", video_ids)

    def test_pure_mode_does_not_fall_back_to_home_recommendations_when_empty(self):
        # A silent fallback to the worker's generic home feed would reproduce
        # the exact reported bug: every seeded row that comes up empty would
        # show the same generic tracks instead of genuinely nothing, and the
        # frontend would never learn the radio was empty.
        with mock.patch.object(server, "_src_seed", return_value=([], None)), \
             mock.patch.object(server, "_src_related", return_value=[]), \
             mock.patch.object(server, "_home_recommendations") as home_fn:
            results = server.recommendations("seed-vid", 10, user_id="u1", pure=True)

        home_fn.assert_not_called()
        self.assertEqual(results, [])

    def test_pure_and_default_results_are_cached_separately(self):
        # Both modes can be requested for the same seed/user/limit (a seeded
        # row plus the mixed autoplay radio) — sharing a cache slot would let
        # one silently serve the other's shape.
        with mock.patch.object(
            server, "_src_seed", return_value=([_track("seed-track")], "related-id")
        ), mock.patch.object(server, "_src_related", return_value=[]), \
                mock.patch.object(server, "_src_your_artists", return_value=[_track("artist-track")]), \
                mock.patch.object(server, "_src_your_likes", return_value=[]), \
                mock.patch.object(server, "_src_history", return_value=[]):
            pure_results = server.recommendations("seed-vid", 10, user_id="u1", pure=True)
            default_results = server.recommendations("seed-vid", 10, user_id="u1", pure=False)

        pure_ids = {row["videoId"] for row in pure_results}
        default_ids = {row["videoId"] for row in default_results}
        self.assertNotIn("artist-track", pure_ids)
        self.assertIn("artist-track", default_ids)


if __name__ == "__main__":
    unittest.main()
