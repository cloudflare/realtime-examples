"""Backup integrity and failure behavior without serial I/O."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import flash_backup as backup


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.size = patch.object(backup, "FLASH_BYTES", 64)
        self.size.start()
        self.addCleanup(self.size.stop)

    def run_tool(self, command, **kwargs):
        self.assertTrue(kwargs["check"])
        self.assertNotIn("write-flash", command)
        self.assertNotIn("erase-flash", command)
        if "read-flash" in command:
            Path(command[-1]).write_bytes(b"x" * 64)

    def test_verified_image_is_preserved_and_rechecked(self):
        image = backup.create_backup(self.root, "test-port", self.run_tool)
        self.assertEqual(backup.require_backup(self.root), image)
        self.assertEqual(image.stat().st_mode & 0o777, 0o600)
        record = self.root / backup.RECORD_NAME
        self.assertEqual(record.stat().st_mode & 0o777, 0o600)
        self.assertTrue(json.loads(record.read_text())["verified_against_device_flash"])
        with self.assertRaisesRegex(ValueError, "already exists"):
            backup.create_backup(self.root, "another-port", lambda *a, **k: self.fail("Must not contact hardware"))
        image.write_bytes(b"y" * 64)
        with self.assertRaisesRegex(ValueError, "No valid saved backup"):
            backup.require_backup(self.root)

    def test_failed_verification_publishes_no_backup(self):
        def failing(command, **kwargs):
            self.run_tool(command, **kwargs)
            if "verify-flash" in command:
                raise subprocess.CalledProcessError(1, command)
        with self.assertRaises(subprocess.CalledProcessError):
            backup.create_backup(self.root, "test-port", failing)
        self.assertFalse((self.root / backup.IMAGE_NAME).exists())
        self.assertFalse((self.root / backup.RECORD_NAME).exists())

    def test_partial_read_is_not_verified(self):
        def partial(command, **kwargs):
            self.assertIn("read-flash", command)
            Path(command[-1]).write_bytes(b"short")
        with self.assertRaisesRegex(ValueError, "incomplete"):
            backup.create_backup(self.root, "test-port", partial)
        self.assertFalse((self.root / backup.RECORD_NAME).exists())

    def test_missing_or_malformed_record_is_rejected(self):
        for contents in [None, "not json", "[]", '{"verified_against_device_flash": true}']:
            if contents is not None:
                (self.root / backup.RECORD_NAME).write_text(contents)
            with self.assertRaisesRegex(ValueError, "No valid saved backup"):
                backup.require_backup(self.root)


if __name__ == "__main__":
    unittest.main()
