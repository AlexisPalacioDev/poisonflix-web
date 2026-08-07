"""Tests for the library maintenance tool: sample-based fragmentation
verification and a purely diagnostic defect report.

ROUND 2 MENOR fixes: an audit found the previous `--write` repair path
(1) discarded embedded cover art (`-map 0:a:0` drops every non-audio stream)
and (2) replaced the original file in place with `os.replace` and no backup.
Per the audit's own suggested simplification ("if it's simpler, make --write
not exist yet and have the tool be diagnostic-only"), the actual re-encode
path (`repair_file`, `RepairState`, `--write`, `--concurrency`) has been
removed entirely rather than patched — there is no code path left in this
tool that can touch a file in MUSIC_DIR. `run_repair` only ever reports.
"""

import os
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


class RunRepairTests(unittest.TestCase):
    """`run_repair` is now a pure report: no `repair_file`, no `RepairState`,
    no `--write`. Nothing it does can touch a file under MUSIC_DIR or write
    anything to DATA_DIR — there is no attribute left to patch to prove
    otherwise, which is itself the guarantee the previous `write=False`
    dry-run only achieved by convention (and got wrong once already: `ok`
    marks were written to state.json regardless of the flag)."""

    def test_reports_defective_files_without_touching_anything(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "x.m4a")
            _write(path)

            with mock.patch.object(
                media_repair, "needs_repair", return_value=(True, "unexpected codec(s) ['opus']")
            ):
                results = media_repair.run_repair(tmp)

            self.assertEqual(results["candidates"], 1)
            self.assertEqual(results["would_repair"], [{"path": path, "reason": "unexpected codec(s) ['opus']"}])
            # No state file, no repair artifact — this run wrote nothing at all.
            self.assertEqual(os.listdir(tmp), ["x.m4a"])

    def test_good_files_produce_an_empty_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "x.m4a")
            _write(path)

            with mock.patch.object(media_repair, "needs_repair", return_value=(False, None)):
                results = media_repair.run_repair(tmp)

            self.assertEqual(results["candidates"], 0)
            self.assertEqual(results["would_repair"], [])

    def test_limit_caps_how_many_candidates_are_collected(self):
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(5):
                _write(os.path.join(tmp, f"x{i}.m4a"))

            with mock.patch.object(media_repair, "needs_repair", return_value=(True, "bad")):
                results = media_repair.run_repair(tmp, limit=2)

            self.assertEqual(results["candidates"], 2)

    def test_repair_file_and_write_mode_no_longer_exist(self):
        """Regression guard: the destructive path must be gone, not merely
        unreachable — same discipline this codebase already applied to the
        removed fragmented-bytes fallback in server.py."""
        self.assertFalse(hasattr(media_repair, "repair_file"))
        self.assertFalse(hasattr(media_repair, "RepairState"))
        import inspect

        self.assertNotIn("write", inspect.signature(media_repair.run_repair).parameters)


if __name__ == "__main__":
    unittest.main()
