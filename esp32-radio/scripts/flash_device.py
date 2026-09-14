#!/usr/bin/env python3
"""Flash firmware and music, or either alone, then reboot. Requires a verified saved backup."""
import argparse
from contextlib import nullcontext
from serial_device import device_port, device_identity
from pathlib import Path
import subprocess
import sys
import tempfile
from project import ROOT, build_dir
from flash_backup import require_backup
from music_partition import MUSIC_BYTES, MUSIC_OFFSET, require_music_partition
from flash_cache import FlashCache, flash_images, layout_digest

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    contents = parser.add_mutually_exclusive_group()
    contents.add_argument("--firmware-only", action="store_true", help="Keep the previously flashed music partition")
    contents.add_argument("--music-only", action="store_true", help="Update only the music and track metadata, then reboot")
    parser.add_argument("--full", action="store_true", help="Write the selected images in full")
    args = parser.parse_args()
    build = build_dir()
    try:
        require_backup()
    except ValueError as error:
        raise SystemExit(str(error)) from None
    if not args.firmware_only:
        music = ROOT / "artifacts/radio/music.bin"
        header = music.read_bytes()[:64]
        if len(header) != 64 or header[:8] != b"S3MUSIC\0" or music.stat().st_size > MUSIC_BYTES:
            raise SystemExit("Prepare a valid music pack with make music before flashing")
    images = []
    if not args.music_only:
        images.extend([(0, build / "bootloader/bootloader.bin"), (0x8000, build / "partition_table/partition-table.bin"), (0x10000, build / "s3_radio.bin")])
    if not args.firmware_only:
        images.append((MUSIC_OFFSET, music))
    if any(not path.is_file() for _, path in images):
        raise SystemExit("Build the selected firmware and prepare music before flashing")
    port = device_port()
    identity = device_identity(port)
    cache = FlashCache(identity, "") if identity else None
    with cache.locked() if cache else nullcontext():
        if args.music_only:
            # Read the installed table; a locally built table does not prove migration.
            with tempfile.TemporaryDirectory(prefix="radio-partition-") as directory:
                table = Path(directory) / "partition.bin"
                subprocess.run([sys.executable, "-m", "esptool", "--chip", "esp32s3", "--port", port,
                                "--before", "default-reset", "--after", "hard-reset", "read-flash", "0x8000", "0x1000", str(table)], check=True)
                installed_table = table.read_bytes()
                try: require_music_partition(installed_table)
                except ValueError as error: raise SystemExit(str(error)) from None
        table = installed_table if args.music_only else (build / "partition_table/partition-table.bin").read_bytes()
        require_music_partition(table)
        command = [sys.executable, "-m", "esptool", "--chip", "esp32s3", "--port", port,
                   "--baud", "460800", "--before", "default-reset", "--after", "hard-reset"]
        if cache:
            cache.layout = layout_digest(table)
        result = flash_images(images, command, subprocess.run, cache, args.full)
    raise SystemExit(result)


if __name__ == "__main__":
    main()
