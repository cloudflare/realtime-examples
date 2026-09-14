"""Create and validate a private, verified backup of the supported board's flash."""
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from project import ROOT

FLASH_BYTES = 32 * 1024 * 1024
IMAGE_NAME = "factory-flash-32mb.bin"
RECORD_NAME = "factory-backup.json"


def backup_directory():
    return Path(os.environ.get("RADIO_BACKUP_DIR", ROOT / "artifacts/hardware-validation"))


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_backup(directory=None):
    directory = Path(directory) if directory is not None else backup_directory()
    image = directory / IMAGE_NAME
    try:
        record = json.loads((directory / RECORD_NAME).read_text())
        valid = (isinstance(record, dict) and
                 record.get("verified_against_device_flash") is True and
                 record.get("bytes") == FLASH_BYTES and
                 image.stat().st_size == FLASH_BYTES and
                 record.get("sha256") == sha256(image))
    except (OSError, ValueError):
        valid = False
    if not valid:
        raise ValueError(f"No valid saved backup in {directory}. Run make backup before the first flash.")
    return image


def create_backup(directory, port, run=None):
    """Publish a record only after esptool verifies the complete saved image."""
    run = subprocess.run if run is None else run
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = os.open(directory / ".backup.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another backup is already running in this directory.") from None
        image, record = directory / IMAGE_NAME, directory / RECORD_NAME
        if image.exists() or record.exists():
            raise ValueError("A backup already exists. Use make backup-check to check it; choose a different RADIO_BACKUP_DIR for another board.")
        with tempfile.TemporaryDirectory(prefix=".backup-", dir=directory) as temporary:
            saved = Path(temporary) / IMAGE_NAME
            saved.touch(mode=0o600)
            base = [sys.executable, "-m", "esptool", "--chip", "esp32s3",
                    "--port", port, "--baud", "460800"]
            run(base + ["--before", "default-reset", "--after", "no-reset",
                        "read-flash", "0", str(FLASH_BYTES), str(saved)], check=True)
            if saved.stat().st_size != FLASH_BYTES:
                raise ValueError("The flash read was incomplete; no verified backup was recorded.")
            run(base + ["--before", "no-reset", "--after", "hard-reset",
                        "verify-flash", "0", str(saved)], check=True)
            metadata = {
                "bytes": FLASH_BYTES,
                "sha256": sha256(saved),
                "chip": "ESP32-S3",
                "port": port,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "verification": "esptool verify-flash",
                "verified_against_device_flash": True,
            }
            pending = Path(temporary) / RECORD_NAME
            pending.touch(mode=0o600)
            pending.write_text(json.dumps(metadata, indent=2) + "\n")
            for path in (saved, pending):
                with path.open("rb") as output:
                    os.fsync(output.fileno())
            # Exclusive links also protect against a destination created outside our lock.
            os.link(saved, image)
            os.link(pending, record)
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        return image
    finally:
        os.close(lock)
