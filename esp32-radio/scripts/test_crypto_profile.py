"""Check opt-in native profiling without altering the crypto implementation."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CryptoProfileTests(unittest.TestCase):
    def test_native_calls_are_forwarded_and_allocations_are_task_scoped(self):
        compiler = shutil.which("cc")
        self.assertIsNotNone(compiler, "A host C compiler is required for native adapter tests")
        platform = ROOT / "firmware/platform"
        fixtures = platform / "tests/crypto_profile"
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "crypto-profile-test"
            compiled = subprocess.run(
                [
                    compiler, "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-I", str(fixtures), "-I", str(platform / "include"),
                    str(platform / "crypto_profile.c"), str(fixtures / "profile_test.c"),
                    str(fixtures / "native.c"),
                    "-Wl,--wrap=radio_crypto_hmac", "-Wl,--wrap=radio_crypto_aes_ctr",
                    "-Wl,--wrap=radio_crypto_aes_gcm", "-Wl,--wrap=esp_mbedtls_mem_calloc",
                    "-o", str(executable),
                ],
                capture_output=True, text=True,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
