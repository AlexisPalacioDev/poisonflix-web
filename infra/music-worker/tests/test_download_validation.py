"""Tests for closing the `.opus -> .m4a` rename hole in the download path
(server.py, historically around :1372) and for validating every downloaded
file the same way the stream cache validates its remux.
"""

import subprocess
import unittest
from unittest import mock

from tests._pathsetup import server


class FinalizeDownloadOutputTests(unittest.TestCase):
    """server._finalize_download_output — the single place a downloaded file
    is accepted or rejected, regardless of which extension yt-dlp left it as.
    """

    def test_happy_path_m4a_already_at_out_path_is_validated(self):
        with mock.patch.object(server.os.path, "exists", return_value=True), \
             mock.patch.object(
                 server, "_validate_audio_output", return_value="audio/mp4"
             ) as validate:
            path, err = server._finalize_download_output("vid1", "/music/x [vid1].m4a")

        self.assertEqual(path, "/music/x [vid1].m4a")
        self.assertIsNone(err)
        validate.assert_called_once_with(
            "vid1", "/music/x [vid1].m4a", label="download"
        )

    def test_happy_path_failing_validation_removes_the_file_and_fails_the_job(self):
        with mock.patch.object(server.os.path, "exists", return_value=True), \
             mock.patch.object(server, "_validate_audio_output", return_value=None), \
             mock.patch.object(server.os, "remove") as remove:
            path, err = server._finalize_download_output("vid1", "/music/x [vid1].m4a")

        self.assertIsNone(path)
        self.assertIsNotNone(err)
        remove.assert_called_once_with("/music/x [vid1].m4a")

    def test_opus_candidate_is_transcoded_not_renamed(self):
        """This is the hole itself: yt-dlp's postprocessor did not convert to
        AAC, so what is sitting on disk is raw Opus. A bare `shutil.move`
        would mislabel it as `.m4a`; it must go through a real transcode."""
        out_path = "/music/x [vid1].m4a"
        opus_path = "/music/x [vid1].opus"

        def exists_side_effect(path):
            return path == opus_path

        with mock.patch.object(server.os.path, "exists", side_effect=exists_side_effect), \
             mock.patch.object(server, "_transcode_to_aac", return_value=True) as transcode, \
             mock.patch.object(server.os, "remove") as remove, \
             mock.patch.object(server.shutil, "move") as move, \
             mock.patch.object(
                 server, "_validate_audio_output", return_value="audio/mp4"
             ):
            path, err = server._finalize_download_output("vid1", out_path)

        self.assertEqual(path, out_path)
        self.assertIsNone(err)
        transcode.assert_called_once_with("vid1", opus_path, out_path)
        move.assert_not_called()  # the fix: never a bare rename for .opus
        remove.assert_any_call(opus_path)  # the leftover raw file is cleaned up

    def test_opus_transcode_failure_fails_the_job_instead_of_serving_raw_opus(self):
        out_path = "/music/x [vid1].m4a"
        opus_path = "/music/x [vid1].opus"

        def exists_side_effect(path):
            return path == opus_path

        with mock.patch.object(server.os.path, "exists", side_effect=exists_side_effect), \
             mock.patch.object(server, "_transcode_to_aac", return_value=False), \
             mock.patch.object(server.os, "remove") as remove, \
             mock.patch.object(server.shutil, "move") as move:
            path, err = server._finalize_download_output("vid1", out_path)

        self.assertIsNone(path)
        self.assertIsNotNone(err)
        move.assert_not_called()
        remove.assert_any_call(opus_path)

    def test_no_candidate_found_is_a_clean_failure(self):
        with mock.patch.object(server.os.path, "exists", return_value=False):
            path, err = server._finalize_download_output("vid1", "/music/x [vid1].m4a")
        self.assertIsNone(path)
        self.assertIn("no output file", err)

    def test_recovered_mp4_extension_is_renamed_then_validated(self):
        out_path = "/music/x [vid1].m4a"
        mp4_path = "/music/x [vid1].mp4"

        def exists_side_effect(path):
            return path == mp4_path

        with mock.patch.object(server.os.path, "exists", side_effect=exists_side_effect), \
             mock.patch.object(server.shutil, "move") as move, \
             mock.patch.object(
                 server, "_validate_audio_output", return_value="audio/mp4"
             ):
            path, err = server._finalize_download_output("vid1", out_path)

        self.assertEqual(path, out_path)
        self.assertIsNone(err)
        move.assert_called_once_with(mp4_path, out_path)


class TranscodeToAacTests(unittest.TestCase):
    def test_successful_transcode_replaces_destination(self):
        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        with mock.patch.object(server.subprocess, "run", return_value=ok_proc), \
             mock.patch.object(server.os.path, "exists", return_value=True), \
             mock.patch.object(server.os.path, "getsize", return_value=2048), \
             mock.patch.object(
                 server, "_validate_audio_output", return_value="audio/mp4"
             ), \
             mock.patch.object(server.os, "replace") as replace, \
             mock.patch.object(server.os, "remove"):
            ok = server._transcode_to_aac("vid1", "/raw.opus", "/final.m4a")

        self.assertTrue(ok)
        replace.assert_called_once()

    def test_ffmpeg_nonzero_exit_fails_without_replacing(self):
        bad_proc = subprocess.CompletedProcess(
            args=["ffmpeg"], returncode=1, stdout="", stderr="Unknown encoder"
        )
        with mock.patch.object(server.subprocess, "run", return_value=bad_proc), \
             mock.patch.object(server.os.path, "exists", return_value=False), \
             mock.patch.object(server.os, "replace") as replace, \
             mock.patch.object(server.os, "remove"):
            ok = server._transcode_to_aac("vid1", "/raw.opus", "/final.m4a")

        self.assertFalse(ok)
        replace.assert_not_called()

    def test_ffmpeg_exit_zero_but_failed_validation_does_not_replace(self):
        """Mirrors the ffmpeg 8.0.1 opus-in-mp4 exit-0 case at the download
        layer, not just the stream cache."""
        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        with mock.patch.object(server.subprocess, "run", return_value=ok_proc), \
             mock.patch.object(server.os.path, "exists", return_value=True), \
             mock.patch.object(server.os.path, "getsize", return_value=2048), \
             mock.patch.object(server, "_validate_audio_output", return_value=None), \
             mock.patch.object(server.os, "replace") as replace, \
             mock.patch.object(server.os, "remove"):
            ok = server._transcode_to_aac("vid1", "/raw.opus", "/final.m4a")

        self.assertFalse(ok)
        replace.assert_not_called()


if __name__ == "__main__":
    unittest.main()
