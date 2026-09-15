"""Reject unsupported resolved SDK settings before compiling a radio image."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "build_firmware", Path(__file__).with_name("build_firmware.py")
)
build_firmware = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_firmware)

SUPPORTED_CONFIGURATION = {
    "COMPILER_OPTIMIZATION_PERF": True,
    "COMPILER_OPTIMIZATION_ASSERTIONS_ENABLE": True,
    "SPIRAM_MALLOC_ALWAYSINTERNAL": 1024,
    "MBEDTLS_HARDWARE_AES": True,
    "MBEDTLS_HARDWARE_SHA": True,
    "MBEDTLS_HARDWARE_MPI": True,
}


class BuildConfigurationTests(unittest.TestCase):
    def test_firmware_uses_the_canonical_device_token(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build = root / "build"
            (build / "config").mkdir(parents=True)
            (build / "config/sdkconfig.json").write_text(json.dumps(SUPPORTED_CONFIGURATION))
            (root / ".credential.env").write_text(
                'WIFI_SSID="synthetic network"\nWIFI_PASSWORD="synthetic password"\n'
                f'DEVICE_TOKEN="{"c" * 43}"\n'
            )
            (root / "worker").mkdir()
            (root / "worker/.dev.vars").write_text(f'DEVICE_TOKEN="{"s" * 43}"\n')
            with (
                patch.object(build_firmware, "ROOT", root),
                patch.object(build_firmware, "build_dir", return_value=build),
                patch.object(build_firmware, "configured_sdk_root", return_value=root / "sdk"),
                patch.object(build_firmware, "verify_checkout"),
                patch.object(build_firmware, "idf_environment", return_value=("python3", {})),
                patch.object(build_firmware.subprocess, "check_output", return_value=f"rustc ({build_firmware.RUST_RELEASE})"),
                patch.object(build_firmware.subprocess, "run", return_value=SimpleNamespace(returncode=0)),
                patch("sys.argv", ["build_firmware.py", "--signaling-url", "https://radio.example.com"]),
            ):
                with self.assertRaises(SystemExit) as result:
                    build_firmware.main()
            self.assertEqual(result.exception.code, 0)
            header = (build / "private/signaling_private.h").read_text()
            self.assertIn('"' + "\\x63" * 43 + '"', header)
            self.assertNotIn("\\x73" * 43, header)

    def check_configuration(self, config):
        with tempfile.TemporaryDirectory() as directory:
            build = Path(directory)
            (build / "config").mkdir()
            (build / "config/sdkconfig.json").write_text(json.dumps(config))
            build_firmware.require_supported_sdk_configuration(build)

    def test_supported_s3_configuration_is_accepted(self):
        self.check_configuration(SUPPORTED_CONFIGURATION)

    def test_stale_debug_configuration_is_rejected(self):
        config = {**SUPPORTED_CONFIGURATION, "COMPILER_OPTIMIZATION_PERF": False}
        with self.assertRaisesRegex(SystemExit, "-O2"):
            self.check_configuration(config)

    def test_disabled_assertions_are_rejected(self):
        config = {
            **SUPPORTED_CONFIGURATION,
            "COMPILER_OPTIMIZATION_ASSERTIONS_ENABLE": False,
        }
        with self.assertRaisesRegex(SystemExit, "assertions"):
            self.check_configuration(config)

    def test_stale_psram_threshold_is_rejected(self):
        config = {**SUPPORTED_CONFIGURATION, "SPIRAM_MALLOC_ALWAYSINTERNAL": 16384}
        with self.assertRaisesRegex(SystemExit, "1 KiB PSRAM"):
            self.check_configuration(config)

    def test_disabled_hardware_crypto_is_rejected(self):
        for setting in (
            "MBEDTLS_HARDWARE_AES",
            "MBEDTLS_HARDWARE_SHA",
            "MBEDTLS_HARDWARE_MPI",
        ):
            with self.subTest(setting=setting):
                config = {**SUPPORTED_CONFIGURATION, setting: False}
                with self.assertRaisesRegex(SystemExit, "hardware AES/SHA/MPI"):
                    self.check_configuration(config)

    def test_missing_resolved_configuration_has_an_actionable_error(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(SystemExit, "did not produce a readable"):
                build_firmware.require_supported_sdk_configuration(Path(directory))

    def test_malformed_resolved_configuration_has_an_actionable_error(self):
        with tempfile.TemporaryDirectory() as directory:
            build = Path(directory)
            (build / "config").mkdir()
            (build / "config/sdkconfig.json").write_text("{")
            with self.assertRaisesRegex(SystemExit, "invalid resolved"):
                build_firmware.require_supported_sdk_configuration(build)

    def test_resolved_configuration_must_be_an_object(self):
        with tempfile.TemporaryDirectory() as directory:
            build = Path(directory)
            (build / "config").mkdir()
            (build / "config/sdkconfig.json").write_text("[]")
            with self.assertRaisesRegex(SystemExit, "JSON object"):
                build_firmware.require_supported_sdk_configuration(build)


if __name__ == "__main__":
    unittest.main()
