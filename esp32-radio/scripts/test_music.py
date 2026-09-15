"""Validate playlist packing and limits with synthetic Opus packets."""
from pathlib import Path
import runpy
import unittest

prepare = runpy.run_path(str(Path(__file__).with_name("prepare_music.py")))
song = prepare["pack_song"]
catalog = prepare["pack_catalog"]


class MusicTests(unittest.TestCase):
    def test_catalog_matches_the_independent_rust_fixture(self):
        packets = [b"\xf8\xff\xfe"]
        packed = catalog([song(packets*2, "First café", "Artist"), song(packets*3, "第二首", "")])
        fixture = Path(__file__).resolve().parents[1] / "firmware/crates/radio-core/tests/fixtures/playlist-v4.pack"
        self.assertEqual(packed, fixture.read_bytes())

    def test_bounds_are_applied_before_writing(self):
        packet = b"\xf8\xff\xfe"
        for packets in [[], [b""], [b"x"*1276]]:
            with self.assertRaises(ValueError): song(packets,"Title","")
        packed = song([packet], "Title", "")
        for songs in [[], [packed]*33]:
            with self.assertRaises(ValueError): catalog(songs)
        large = song([packet]*30000, "Title", "")
        with self.assertRaises(ValueError): catalog([large]*7)


if __name__ == "__main__":
    unittest.main()
