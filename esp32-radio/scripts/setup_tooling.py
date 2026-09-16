#!/usr/bin/env python3
"""Set up the pinned Linux x86_64 S3 toolchain without changing global defaults."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import urllib.request
from project import (ROOT, IDF_REVISION, RUST_RELEASE, RUST_TOOLCHAIN,
                     ESPUP_VERSION, ESPUP_SHA256, sdk_root, verify_checkout, idf_environment,
                     rust_libclang, VENDOR, DSP_REVISION, CODEC_REVISION)


def run(command, **kwargs):
    subprocess.run([str(part) for part in command], check=True, **kwargs)


def checkout(path, url, revision):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "init", path])
        run(["git", "-C", path, "remote", "add", "origin", url])
        run(["git", "-C", path, "fetch", "--depth", "1", "origin", revision])
        run(["git", "-C", path, "checkout", "--detach", "FETCH_HEAD"])
    verify_checkout(path, revision)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify native source pins, Rust and libclang without downloading")
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise SystemExit("This setup helper supports Linux x86_64. See firmware/README.md for toolchain details.")
    required = ["git", "cmake", "make", "gcc", "g++", "pkg-config", "rustup", "cargo"]
    missing = [command for command in required if not shutil.which(command)]
    if missing:
        raise SystemExit("Install these prerequisites first: " + ", ".join(missing))
    sdk = sdk_root()
    if args.check:
        verify_checkout(sdk / "esp-idf", IDF_REVISION)
        verify_checkout(VENDOR / "esp-dsp", DSP_REVISION)
        verify_checkout(VENDOR / "esp-adf-libs", CODEC_REVISION)
        idf_environment()
        version = subprocess.check_output(["rustup", "run", RUST_TOOLCHAIN, "rustc", "--version"], text=True)
        if f"({RUST_RELEASE})" not in version:
            raise SystemExit("Rust compiler differs from the pinned release")
        print("Pinned ESP-IDF, DSP, codecs, and Xtensa Rust toolchains are ready.")
        return
    checkout(VENDOR / "esp-dsp", "https://github.com/espressif/esp-dsp.git", DSP_REVISION)
    checkout(VENDOR / "esp-adf-libs", "https://github.com/espressif/esp-adf-libs.git", CODEC_REVISION)
    checkout(sdk / "esp-idf", "https://github.com/espressif/esp-idf.git", IDF_REVISION)
    run(["git", "-C", sdk / "esp-idf", "submodule", "update", "--init", "--recursive", "--depth", "1"])
    version = subprocess.run(["rustup", "run", RUST_TOOLCHAIN, "rustc", "--version"], capture_output=True, text=True)
    try:
        rust_libclang()
        clang_ready = True
    except SystemExit:
        clang_ready = False
    if version.returncode or f"({RUST_RELEASE})" not in version.stdout or not clang_ready:
        espup = ROOT / ".tools/espup"
        espup.parent.mkdir(exist_ok=True)
        if not espup.exists() or hashlib.sha256(espup.read_bytes()).hexdigest() != ESPUP_SHA256:
            url = f"https://github.com/esp-rs/espup/releases/download/v{ESPUP_VERSION}/espup-x86_64-unknown-linux-gnu"
            with urllib.request.urlopen(url, timeout=60) as response:
                binary = response.read()
            if hashlib.sha256(binary).hexdigest() != ESPUP_SHA256:
                raise SystemExit("espup download checksum mismatch")
            espup.write_bytes(binary)
            espup.chmod(0o755)
        # --std installs Rust and Xtensa libclang; ESP-IDF supplies GCC.
        run([espup, "install", "--std", "--targets", "esp32s3", "--toolchain-version", RUST_RELEASE,
             "--name", RUST_TOOLCHAIN, "--export-file", ROOT / ".tools/export-esp-radio.sh"])
    rust_libclang()
    try:
        idf_environment()
    except SystemExit:
        env = os.environ.copy()
        env.update(IDF_TOOLS_PATH=str(sdk / "tools"), PIP_CACHE_DIR=str(sdk / "pip-cache"))
        run(["bash", sdk / "esp-idf/install.sh", "esp32s3"], env=env)
    esptool = ROOT / ".tools/esptool/bin/python"
    if not esptool.exists():
        run([sys.executable, "-m", "venv", esptool.parent.parent])
    run([esptool, "-m", "pip", "install", "esptool==5.4.0", "pyserial==3.5"])
    run(["cargo", "fetch", "--locked", "--manifest-path", ROOT / "firmware/Cargo.toml"])
    print("Firmware tooling ready. Existing Rust defaults and shell profiles were preserved.")


if __name__ == "__main__":
    main()
