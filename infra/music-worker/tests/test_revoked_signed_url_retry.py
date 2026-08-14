"""Tests for the re-resolve-and-retry path when googlevideo revokes a URL.

MOTIVATING MEASUREMENT, taken against the live server before this was written.
Roughly half of all cold plays, googlevideo answers the FIRST Range request
with a clean `206` and then answers every chunk after it with `403`
(`Server: gvs 1.0`, `Content-Length: 0`):

    [range 0-1048575] status=206 CR='bytes 0-1048575/2761917' total=2761917
    BRANCH: chunk raised HTTPError: <HTTPError 403: 'Forbidden'>

Over six runs each, with a fresh resolve every time:

    sequential:  1/6 failed
    four-at-a-time: 4/6 failed

and, on a failure, retrying the SAME url never recovered while a FRESH resolve
recovered 3 times out of 4.

`_fetch_upstream_to` already had the right answer to this — re-resolve on
403/410 and try again — but `_download_chunked` swallowed the chunk's
exception into a bare `return False`, so that retry was unreachable for every
chunk except the zeroth. The track then died as a 502, which the listener
experienced as a song that stayed silent while the UI said it was playing.

These tests pin the exception PATH, which is the part that was broken. They do
not re-measure the upstream's behaviour.
"""

import tempfile
import unittest
import urllib.error
from unittest import mock

from tests._pathsetup import server


def _forbidden():
    return urllib.error.HTTPError("http://x/", 403, "Forbidden", {}, None)


class RevokedUrlPropagationTests(unittest.TestCase):
    """A 403 on a non-first chunk must leave `_download_chunked` as an
    exception, not as a plain False."""

    def test_403_on_a_later_chunk_propagates(self):
        total = 3 * server._CHUNK_BYTES

        def fake_range_get(url, start, end, cap=None):
            if start == 0:
                return b"\0" * server._CHUNK_BYTES, total
            raise _forbidden()

        with tempfile.NamedTemporaryFile() as dest:
            with mock.patch.object(server, "_range_get", side_effect=fake_range_get):
                with self.assertRaises(urllib.error.HTTPError):
                    server._download_chunked("http://signed/", dest.name)

    def test_a_non_http_failure_is_still_a_clean_false(self):
        """The bare `except Exception` still has a job: only HTTP errors are
        worth re-resolving for, and a partial file must never read as success."""
        total = 3 * server._CHUNK_BYTES

        def fake_range_get(url, start, end, cap=None):
            if start == 0:
                return b"\0" * server._CHUNK_BYTES, total
            raise ValueError("garbage")

        with tempfile.NamedTemporaryFile() as dest:
            with mock.patch.object(server, "_range_get", side_effect=fake_range_get):
                self.assertIs(server._download_chunked("http://signed/", dest.name), False)


class ReResolveOnRevokedUrlTests(unittest.TestCase):
    """The propagated 403 must actually buy a fresh resolve."""

    def test_a_revoked_url_is_re_resolved_and_the_track_survives(self):
        urls = ["http://signed/first", "http://signed/second"]
        resolved = []

        def fake_resolve(video_id, source, force=False):
            url = urls[min(len(resolved), len(urls) - 1)]
            resolved.append((url, force))
            return url

        def fake_download(url, dest, chunk_pool=None):
            if url == "http://signed/first":
                raise _forbidden()  # revoked mid-fetch, exactly as measured
            return True

        with mock.patch.object(server, "_resolve_stream_url", side_effect=fake_resolve), \
             mock.patch.object(server, "_download_chunked", side_effect=fake_download):
            ok = server._fetch_upstream_to("vid", "auto", "/tmp/ignored", None)

        self.assertIs(ok, True)
        self.assertEqual(len(resolved), 2)
        # The retry must FORCE a new resolve. Reusing the cached url is the one
        # thing measurement showed never recovers.
        self.assertEqual(resolved[0][1], False)
        self.assertEqual(resolved[1][1], True)

    def test_two_revocations_in_a_row_still_get_a_third_attempt(self):
        """Measured: even the first re-resolve came back revoked once in four.
        A track should not die on the second bad roll of the same dice."""
        attempts = []

        def fake_download(url, dest, chunk_pool=None):
            attempts.append(url)
            if len(attempts) < 3:
                raise _forbidden()
            return True

        with mock.patch.object(server, "_resolve_stream_url", return_value="http://signed/x"), \
             mock.patch.object(server, "_download_chunked", side_effect=fake_download):
            ok = server._fetch_upstream_to("vid", "auto", "/tmp/ignored", None)

        self.assertIs(ok, True)
        self.assertEqual(len(attempts), 3)

    def test_it_gives_up_rather_than_resolving_forever(self):
        attempts = []

        def fake_download(url, dest, chunk_pool=None):
            attempts.append(url)
            raise _forbidden()

        with mock.patch.object(server, "_resolve_stream_url", return_value="http://signed/x"), \
             mock.patch.object(server, "_download_chunked", side_effect=fake_download):
            ok = server._fetch_upstream_to("vid", "auto", "/tmp/ignored", None)

        self.assertIs(ok, False)
        self.assertEqual(len(attempts), 3)


if __name__ == "__main__":
    unittest.main()
