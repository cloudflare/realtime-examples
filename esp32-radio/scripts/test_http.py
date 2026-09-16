"""Exercise the maintained native HTTP adapter with public synthetic responses."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class HttpTests(unittest.TestCase):
    def test_response_borrow_bounds_and_retry_state(self):
        compiler = shutil.which("cc")
        self.assertIsNotNone(compiler, "A host C compiler is required for native adapter tests")
        platform = ROOT / "firmware/platform"
        fixtures = platform / "tests/http"
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "http-test"
            compiled = subprocess.run(
                [
                    compiler, "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-I", str(fixtures), "-I", str(platform / "include"),
                    str(platform / "http.c"), str(fixtures / "http_test.c"),
                    "-o", str(executable),
                ],
                capture_output=True, text=True,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
