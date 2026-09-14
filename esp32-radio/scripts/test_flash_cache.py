"""Snapshot association, interruption recovery and immutable flash inputs."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from flash_cache import FlashCache, flash_images, layout_digest


class FlashCacheTests(unittest.TestCase):
    def test_diff_files_follow_sorted_addresses_and_incomplete_cache_uses_skip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / "old.bin"
            old.write_bytes(b"old music")
            firmware = root / "firmware.bin"
            firmware.write_bytes(b"firmware")
            music = root / "music.bin"
            music.write_bytes(b"new music")
            cache = FlashCache("board-a", "layout-a", root / "cache")
            with cache.locked():
                cache.remember([(0x410000, old)])
                commands = []
                def run(command):
                    commands.append(command)
                    # A caller may prepare another catalog while this flash runs.
                    music.write_bytes(b"later catalog")
                    return SimpleNamespace(returncode=0)
                self.assertEqual(flash_images([(0x410000, music), (0x10000, firmware)], ["esptool"], run, cache), 0)
                command = commands[0]
                start = command.index("--diff-with")
                self.assertEqual(command[start + 1], "skip")
                self.assertEqual(Path(command[start + 2]).name, "00410000.bin")
                self.assertEqual(command[start + 3], "--flash-mode")
                self.assertNotIn("--trust-flash-content", command)
                self.assertNotIn("--skip-flashed", command)
                saved = cache.bases([0x410000])[0]
                self.assertEqual(saved.read_bytes(), b"new music")

    def test_failed_flash_retains_old_snapshot_and_full_mode_disables_fast_options(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "image.bin"
            image.write_bytes(b"previous")
            cache = FlashCache("board", "layout", root / "cache")
            with cache.locked():
                cache.remember([(0x10000, image)])
                image.write_bytes(b"new")
                def fail(command):
                    self.assertNotIn("--diff-with", command)
                    self.assertNotIn("--skip-flashed", command)
                    return SimpleNamespace(returncode=2)
                self.assertEqual(flash_images([(0x10000, image)], ["esptool"], fail, cache, full=True), 2)
                self.assertEqual(cache.bases([0x10000])[0].read_bytes(), b"previous")

    def test_wrong_device_layout_or_corrupt_cache_cannot_supply_a_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "image.bin"
            image.write_bytes(b"payload")
            cache = FlashCache("board-a", "layout-a", root / "cache")
            with cache.locked():
                cache.remember([(0x10000, image)])
                self.assertEqual(FlashCache("board-b", "layout-a", root / "cache").bases([0x10000]), [None])
                self.assertEqual(FlashCache("board-a", "layout-b", root / "cache").bases([0x10000]), [None])
                cache.bases([0x10000])[0].write_bytes(b"damaged")
                self.assertEqual(cache.bases([0x10000]), [None])
                def run(command):
                    self.assertIn("--skip-flashed", command)
                    self.assertNotIn("--diff-with", command)
                    return SimpleNamespace(returncode=0)
                flash_images([(0x10000, image)], ["esptool"], run, cache)
                (cache.directory / "verified.json").write_text("[]")
                self.assertEqual(cache.bases([0x10000]), [None])

    def test_sector_padding_does_not_change_partition_identity(self):
        table = b"partition data".ljust(0xC00, b"\xff")
        self.assertEqual(layout_digest(table), layout_digest(table + b"\xff" * 0x400))
        self.assertNotEqual(layout_digest(table), layout_digest(b"other partition"))


if __name__ == "__main__":
    unittest.main()
