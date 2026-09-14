#!/usr/bin/env python3
"""Build the S3 radio with credential headers generated in the private build directory."""
import argparse
import json
import os
import subprocess

from config import read_env
from project import (
    CODEC_REVISION,
    DSP_REVISION,
    IDF_REVISION,
    ROOT,
    RUST_RELEASE,
    VENDOR,
    build_dir,
    idf_environment,
    sdk_root as configured_sdk_root,
    verify_checkout,
)


def require_supported_sdk_configuration(build):
    path = build / "config/sdkconfig.json"
    try:
        contents = path.read_text()
    except (OSError, UnicodeError):
        raise SystemExit(
            "ESP-IDF did not produce a readable resolved sdkconfig.json. "
            "Remove firmware/sdkconfig and rerun the firmware build."
        ) from None
    try:
        config = json.loads(contents)
    except json.JSONDecodeError:
        raise SystemExit(
            "ESP-IDF produced an invalid resolved sdkconfig.json. "
            "Remove firmware/sdkconfig and rerun the firmware build."
        ) from None
    if not isinstance(config, dict):
        raise SystemExit(
            "ESP-IDF resolved sdkconfig.json must contain a JSON object. "
            "Remove firmware/sdkconfig and rerun the firmware build."
        )

    required_booleans = (
        "COMPILER_OPTIMIZATION_PERF",
        "COMPILER_OPTIMIZATION_ASSERTIONS_ENABLE",
        "MBEDTLS_HARDWARE_AES",
        "MBEDTLS_HARDWARE_SHA",
        "MBEDTLS_HARDWARE_MPI",
    )
    supported = all(config.get(name) is True for name in required_booleans)
    supported = supported and config.get("SPIRAM_MALLOC_ALWAYSINTERNAL") == 1024
    if not supported:
        raise SystemExit(
            "The resolved ESP-IDF settings do not match the supported S3 profile: "
            "-O2, assertions, a 1 KiB PSRAM allocation threshold, and hardware "
            "AES/SHA/MPI are required. Remove firmware/sdkconfig to reapply "
            "firmware/sdkconfig.defaults."
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--signaling-url", default=os.environ.get("SIGNALING_URL"),
                        help="Worker HTTPS origin (defaults to SIGNALING_URL)")
    parser.add_argument(
        "--crypto-self-test",
        action="store_true",
        help="Build an image that runs extended crypto tests before streaming",
    )
    parser.add_argument(
        "--crypto-profile",
        action="store_true",
        help="Build an image that profiles native crypto calls and allocations for 30 seconds",
    )
    args = parser.parse_args()
    if not args.signaling_url:
        parser.error("Set SIGNALING_URL or --signaling-url to your deployed Worker HTTPS origin")
    if not args.signaling_url.startswith("https://") or len(args.signaling_url) > 180:
        raise SystemExit(
            "The autonomous signaling URL must use HTTPS and be at most 180 characters"
        )

    root = ROOT
    sdk_root = configured_sdk_root()
    sdk = sdk_root / "esp-idf"
    build = build_dir()
    verify_checkout(sdk, IDF_REVISION)
    verify_checkout(VENDOR / "esp-dsp", DSP_REVISION)
    verify_checkout(VENDOR / "esp-adf-libs", CODEC_REVISION)
    version = subprocess.check_output(
        ["rustup", "run", "esp-radio", "rustc", "--version"], text=True
    )
    if f"({RUST_RELEASE})" not in version:
        raise SystemExit("Run make setup to install the pinned Xtensa Rust compiler")
    private = build / "private"
    private.mkdir(parents=True, exist_ok=True)
    private.chmod(0o700)
    values = read_env(root / ".credential.env")
    ssid = values.get("WIFI_SSID", "").encode()
    password = values.get("WIFI_PASSWORD", "").encode()
    if not 1 <= len(ssid) <= 32 or len(password) > 64:
        raise SystemExit("Check WIFI_SSID and WIFI_PASSWORD lengths in .credential.env")

    def c_bytes(value):
        return '"' + "".join(f"\\x{byte:02x}" for byte in value) + '"'

    header = private / "wifi_private.h"
    header.write_text(
        f"#pragma once\n#define WIFI_SSID {c_bytes(ssid)}\n"
        f"#define WIFI_PASSWORD {c_bytes(password)}\n"
    )
    header.chmod(0o600)
    signaling = private / "signaling_private.h"
    device_token = values.get("DEVICE_TOKEN", "")
    if not 32 <= len(device_token) <= 128:
        raise SystemExit(
            "Set a 32–128 character DEVICE_TOKEN in .credential.env; run make secrets for initial setup"
        )
    signaling.write_text(
        "#pragma once\n"
        "#define SIGNALING_AUTONOMOUS 1\n"
        f"#define SIGNALING_URL {c_bytes(args.signaling_url.rstrip('/').encode())}\n"
        f"#define SIGNALING_DEVICE_TOKEN {c_bytes(device_token.encode())}\n"
    )
    signaling.chmod(0o600)
    python, env = idf_environment()
    os.umask(0o077)
    command = [
        str(python),
        str(sdk / "tools/idf.py"),
        "-B",
        str(build),
        f"-DRADIO_CRYPTO_SELF_TEST={'ON' if args.crypto_self_test else 'OFF'}",
        f"-DRADIO_CRYPTO_PROFILE={'ON' if args.crypto_profile else 'OFF'}",
    ]
    configured = subprocess.run([*command, "reconfigure"], cwd=root / "firmware", env=env)
    if configured.returncode:
        raise SystemExit(configured.returncode)
    require_supported_sdk_configuration(build)
    result = subprocess.run([*command, "build"], cwd=root / "firmware", env=env)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
