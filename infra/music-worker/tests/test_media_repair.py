"""Tests for the library maintenance tool (Task 4): sample-based verification
(Task 3) and the bounded, resumable repair pass.
"""

import json
import os
import subprocess
import tempfile
import unittest
from unittest import mock

import tests._pathsetup  # noqa: F401  (sys.path fix-up so `import media_repair` resolves)
import media_repair


def _write(path, content=b"not a real mp4"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(content)


class FragmentationDetectionTests(unittest.TestCase):
    def test_progressive_mp4_has_no_fragmentation_markers(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "clean.m4a")
            _write(path, b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00moovdata..." + b"\x00" * 4096)
            self.assertFalse(media_repair.is_fragmented_mp4(path))

    def test_fragmented_mp4_has_moof(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "frag.m4a")
            _write(path, b"\x00\x00\x00\x18ftypmp42" + b"junk" + b"moof" + b"\x00" * 4096)
            self.assertTrue(media_repair.is_fragmented_mp4(path))

    def test_mvex_alone_also_counts_as_fragmented(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "frag2.m4a")
            _write(path, b"\x00\x00\x00\x18ftypmp42" + b"mvex" + b"\x00" * 4096)
            self.assertTrue(media_repair.is_fragmented_mp4(path))

    def test_missing_file_returns_none_not_a_crash(self):
        self.assertIsNone(media_repair.is_fragmented_mp4("/does/not/exist.m4a"))


class NeedsRepairTests(unittest.TestCase):
    def test_unreadable_probe_needs_repair(self):
        with mock.patch.object(media_repair.server, "_probe_media", return_value=None):
            bad, reason = media_repair.needs_repair("/x.m4a")
        self.assertTrue(bad)
        self.assertIn("unreadable", reason)

    def test_bad_codec_needs_repair(self):
        info = {"codecs": ["opus"], "format_name": "mp4", "duration": 100.0}
        with mock.patch.object(media_repair.server, "_probe_media", return_value=info):
            bad, reason = media_repair.needs_repair("/x.m4a")
        self.assertTrue(bad)
        self.assertIn("codec", reason)

    def test_fragmented_but_valid_codec_needs_repair(self):
        info = {"codecs": ["aac"], "format_name": "mp4", "duration": 100.0}
        with mock.patch.object(media_repair.server, "_probe_media", return_value=info), \
             mock.patch.object(media_repair, "is_fragmented_mp4", return_value=True):
            bad, reason = media_repair.needs_repair("/x.m4a")
        self.assertTrue(bad)
        self.assertIn("fragmented", reason)

    def test_clean_file_does_not_need_repair(self):
        info = {"codecs": ["aac"], "format_name": "mp4", "duration": 100.0}
        with mock.patch.object(media_repair.server, "_probe_media", return_value=info), \
             mock.patch.object(media_repair, "is_fragmented_mp4", return_value=False):
            bad, reason = media_repair.needs_repair("/x.m4a")
        self.assertFalse(bad)
        self.assertIsNone(reason)


class SampleFragmentationReportTests(unittest.TestCase):
    def test_counts_fragmented_files_in_a_sample(self):
        with tempfile.TemporaryDirectory() as tmp:
            clean = os.path.join(tmp, "a", "clean.m4a")
            frag = os.path.join(tmp, "b", "frag.m4a")
            _write(clean, b"ftyp" + b"\x00" * 100)
            _write(frag, b"ftyp" + b"moof" + b"\x00" * 100)

            report = media_repair.sample_fragmentation_report(tmp, sample_size=50)

        self.assertEqual(report["library_total"], 2)
        self.assertEqual(report["sampled"], 2)
        self.assertEqual(report["fragmented"], 1)
        self.assertIn(frag, report["fragmented_paths"])

    def test_empty_library_reports_zero_not_a_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = media_repair.sample_fragmentation_report(tmp, sample_size=50)
        self.assertEqual(report["library_total"], 0)
        self.assertEqual(report["fragmented"], 0)

    def test_sampling_never_exceeds_sample_size(self):
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(10):
                _write(os.path.join(tmp, f"f{i}.m4a"), b"ftyp" + b"\x00" * 50)
            report = media_repair.sample_fragmentation_report(tmp, sample_size=3, seed=1)
        self.assertEqual(report["library_total"], 10)
        self.assertEqual(report["sampled"], 3)


class RepairFileTests(unittest.TestCase):
    def test_successful_repair_replaces_the_original(self):
        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        with mock.patch.object(media_repair.subprocess, "run", return_value=ok_proc), \
             mock.patch.object(media_repair.os.path, "exists", return_value=True), \
             mock.patch.object(media_repair.os.path, "getsize", return_value=4096), \
             mock.patch.object(
                 media_repair.server, "_validate_audio_output", return_value="audio/mp4"
             ), \
             mock.patch.object(media_repair, "is_fragmented_mp4", return_value=False), \
             mock.patch.object(media_repair.os, "replace") as replace:
            ok, err = media_repair.repair_file("/music/x.m4a")

        self.assertTrue(ok)
        self.assertIsNone(err)
        replace.assert_called_once()

    def test_ffmpeg_failure_does_not_touch_the_original(self):
        bad_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=1, stdout="", stderr="x")
        with mock.patch.object(media_repair.subprocess, "run", return_value=bad_proc), \
             mock.patch.object(media_repair.os.path, "exists", return_value=False), \
             mock.patch.object(media_repair.os, "replace") as replace:
            ok, err = media_repair.repair_file("/music/x.m4a")

        self.assertFalse(ok)
        self.assertIsNotNone(err)
        replace.assert_not_called()

    def test_repaired_output_still_fragmented_is_rejected(self):
        ok_proc = subprocess.CompletedProcess(args=["ffmpeg"], returncode=0, stdout="", stderr="")
        with mock.patch.object(media_repair.subprocess, "run", return_value=ok_proc), \
             mock.patch.object(media_repair.os.path, "exists", return_value=True), \
             mock.patch.object(media_repair.os.path, "getsize", return_value=4096), \
             mock.patch.object(
                 media_repair.server, "_validate_audio_output", return_value="audio/mp4"
             ), \
             mock.patch.object(media_repair, "is_fragmented_mp4", return_value=True), \
             mock.patch.object(media_repair.os, "replace") as replace:
            ok, err = media_repair.repair_file("/music/x.m4a")

        self.assertFalse(ok)
        self.assertIn("fragmented", err)
        replace.assert_not_called()


class RepairStateTests(unittest.TestCase):
    def test_marks_are_persisted_and_reloadable(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = os.path.join(tmp, "state.json")
            state = media_repair.RepairState(state_path)
            self.assertFalse(state.is_done("/a.m4a"))
            state.mark("/a.m4a", "ok")
            self.assertTrue(state.is_done("/a.m4a"))

            reloaded = media_repair.RepairState(state_path)
            self.assertTrue(reloaded.is_done("/a.m4a"))
            with open(state_path, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), {"/a.m4a": "ok"})

    def test_corrupt_state_file_starts_clean_instead_of_crashing(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = os.path.join(tmp, "state.json")
            with open(state_path, "w", encoding="utf-8") as fh:
                fh.write("{not json")
            state = media_repair.RepairState(state_path)
            self.assertFalse(state.is_done("/a.m4a"))


class RunRepairTests(unittest.TestCase):
    def test_already_marked_done_is_skipped_entirely(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "x.m4a")
            _write(path)
            state_path = os.path.join(tmp, "state.json")
            with open(state_path, "w", encoding="utf-8") as fh:
                json.dump({path: "ok"}, fh)

            with mock.patch.object(media_repair, "needs_repair") as needs, \
                 mock.patch.object(media_repair, "repair_file") as repair:
                results = media_repair.run_repair(tmp, state_path=state_path)

        needs.assert_not_called()
        repair.assert_not_called()
        self.assertEqual(results["candidates"], 0)

    def test_good_file_is_marked_ok_and_not_repaired(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "x.m4a")
            _write(path)
            state_path = os.path.join(tmp, "state.json")

            with mock.patch.object(media_repair, "needs_repair", return_value=(False, None)), \
                 mock.patch.object(media_repair, "repair_file") as repair:
                results = media_repair.run_repair(tmp, state_path=state_path)

            repair.assert_not_called()
            self.assertEqual(results["candidates"], 0)
            state = media_repair.RepairState(state_path)
            self.assertEqual(state.data[path], "ok")

    def test_bad_file_is_sent_to_repair_and_recorded_when_write_is_requested(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "x.m4a")
            _write(path)
            state_path = os.path.join(tmp, "state.json")

            with mock.patch.object(
                media_repair, "needs_repair", return_value=(True, "unexpected codec(s) ['opus']")
            ), mock.patch.object(media_repair, "repair_file", return_value=(True, None)):
                results = media_repair.run_repair(tmp, state_path=state_path, write=True)

            self.assertEqual(results["candidates"], 1)
            self.assertEqual(results["repaired"], 1)
            self.assertEqual(results["failed"], 0)
            state = media_repair.RepairState(state_path)
            self.assertEqual(state.data[path], "fixed")

    def test_limit_caps_how_many_candidates_are_collected(self):
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(5):
                _write(os.path.join(tmp, f"x{i}.m4a"))
            state_path = os.path.join(tmp, "state.json")

            with mock.patch.object(media_repair, "needs_repair", return_value=(True, "bad")), \
                 mock.patch.object(media_repair, "repair_file", return_value=(True, None)):
                results = media_repair.run_repair(tmp, limit=2, state_path=state_path, write=True)

            self.assertEqual(results["candidates"], 2)

    def test_default_is_dry_run_and_never_calls_repair_file(self):
        """The default invocation must be safe: `--repair` alone, with no
        explicit `write=True`, reports what it WOULD do and touches nothing —
        no re-encode, no replace, no state mutation for the defective files."""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "x.m4a")
            _write(path)
            state_path = os.path.join(tmp, "state.json")

            with mock.patch.object(
                media_repair, "needs_repair", return_value=(True, "unexpected codec(s) ['opus']")
            ), mock.patch.object(media_repair, "repair_file") as repair:
                results = media_repair.run_repair(tmp, state_path=state_path)

            repair.assert_not_called()
            self.assertTrue(results["dry_run"])
            self.assertEqual(results["candidates"], 1)
            state = media_repair.RepairState(state_path)
            self.assertFalse(state.is_done(path))

    def test_dry_run_lists_the_candidates_it_would_repair(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "x.m4a")
            _write(path)
            state_path = os.path.join(tmp, "state.json")

            with mock.patch.object(
                media_repair, "needs_repair", return_value=(True, "unexpected codec(s) ['opus']")
            ), mock.patch.object(media_repair, "repair_file"):
                results = media_repair.run_repair(tmp, state_path=state_path)

            self.assertEqual(len(results["would_repair"]), 1)
            self.assertEqual(results["would_repair"][0]["path"], path)


if __name__ == "__main__":
    unittest.main()
