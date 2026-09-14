#!/usr/bin/env python3
"""Install, run, or check the pinned formatter for the maintained C adapters."""
import argparse
import subprocess
import sys

from project import CLANG_FORMAT_VERSION, ROOT

ENVIRONMENT = ROOT / ".tools/clang-format"
FORMATTER = ENVIRONMENT / "bin/clang-format"
EXPECTED_VERSION = f"clang-format version {CLANG_FORMAT_VERSION}"


def installed_version():
    try:
        result = subprocess.run(
            [str(FORMATTER), "--version"], capture_output=True, text=True
        )
    except OSError:
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def require_formatter():
    if installed_version() != EXPECTED_VERSION:
        raise SystemExit(
            f"Expected clang-format {CLANG_FORMAT_VERSION}. Run make setup-c-format."
        )


def setup():
    if installed_version() != EXPECTED_VERSION:
        python = ENVIRONMENT / "bin/python"
        if not python.exists():
            subprocess.run(
                [sys.executable, "-m", "venv", str(ENVIRONMENT)], check=True
            )
        subprocess.run(
            [
                str(python), "-m", "pip", "install", "--disable-pip-version-check",
                "--only-binary=:all:", "--no-deps",
                f"clang-format=={CLANG_FORMAT_VERSION}",
            ],
            check=True,
        )
    require_formatter()
    print(f"{EXPECTED_VERSION} is ready in .tools/clang-format.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--setup", action="store_true", help="Install the pinned formatter")
    action.add_argument("--check", action="store_true", help="Check formatting without editing")
    action.add_argument("--version", action="store_true", help="Verify and print the installed version")
    args = parser.parse_args()
    if args.setup:
        setup()
        return 0
    require_formatter()
    if args.version:
        print(EXPECTED_VERSION)
        return 0
    sources = sorted(
        path for path in (ROOT / "firmware/platform").rglob("*")
        if path.is_file() and path.suffix in {".c", ".h"}
    )
    if not sources:
        raise SystemExit("No maintained C sources found in firmware/platform.")
    return subprocess.run(
        [
            str(FORMATTER), f"--style=file:{ROOT / 'firmware/.clang-format'}",
            "--fail-on-incomplete-format",
            *(["--dry-run", "--Werror"] if args.check else ["-i"]),
            *map(str, sources),
        ],
        cwd=ROOT,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
