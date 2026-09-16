#!/usr/bin/env python3
"""Back up and verify 32 MiB of flash. Reading enters the bootloader and resets the board."""
import argparse
from serial_device import device_port
import subprocess

from flash_backup import backup_directory, create_backup, require_backup
from project import ROOT

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check saved files and SHA-256 without contacting hardware")
    args = parser.parse_args()
    try:
        if args.check:
            image = require_backup()
            print(f"Saved backup and SHA-256 verified: {image}")
        else:
            port = device_port()
            image = create_backup(backup_directory(), port)
            print(f"Flash backup verified and preserved: {image}")
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from None


if __name__ == "__main__":
    main()
