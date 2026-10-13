"""Run the pinned Python Workers toolchain from the repository root."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main(args=None):
    command = ["uvx", "--with", "uv==0.12.23", "--from", "workers-py==1.17.6", "pywrangler"]
    return subprocess.call(command + (args or sys.argv[1:]), cwd=ROOT)


if __name__ == "__main__":
    raise SystemExit(main())
