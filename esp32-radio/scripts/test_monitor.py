"""The monitor stays open; explicit health checks return meaningful status."""
import contextlib
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("monitor_cli", Path(__file__).with_name("monitor_device.py"))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class Port:
    def __init__(self, chunks):
        self.chunks = iter(chunks)
        self.reads = 0
        self.closed = False
        self.writes = []

    def read(self, size):
        self.reads += 1
        item = next(self.chunks, KeyboardInterrupt())
        if isinstance(item, BaseException):
            raise item
        return item

    def close(self):
        self.closed = True

    def write(self, data):
        self.writes.append(data)

    def flush(self):
        pass


class MonitorTests(unittest.TestCase):
    def test_monitor_redacts_canonical_credentials_even_with_a_stale_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".credential.env").write_text('VIEWER_PASSWORD="canonical-secret"\n')
            (root / "worker").mkdir()
            (root / "worker/.dev.vars").write_text('VIEWER_PASSWORD="stale-secret"\n')
            port = Port([b"HTTPS canonical-secret\n", KeyboardInterrupt()])
            output = io.StringIO()
            with (
                patch.object(monitor, "ROOT", root),
                patch.object(monitor, "open_port", return_value=port),
                patch.dict("sys.modules", {"serial": SimpleNamespace(SerialException=OSError)}),
                contextlib.redirect_stdout(output),
            ):
                self.assertEqual(monitor.main([]), 0)
            self.assertNotIn("canonical-secret", output.getvalue())
            self.assertEqual((root / "artifacts/radio/autonomous-monitor.log").read_text(), "HTTPS [redacted]\n")

    def run_monitor(self, port, args, clock=None):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(monitor, "ROOT", Path(directory)))
            stack.enter_context(patch.object(monitor, "open_port", return_value=port))
            stack.enter_context(patch.dict("sys.modules", {"serial": SimpleNamespace(SerialException=OSError)}))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            if clock is not None:
                stack.enter_context(patch.object(monitor.time, "monotonic", side_effect=clock))
            return monitor.main(args)

    def test_monitor_continues_after_heartbeat_until_interrupted(self):
        port = Port([b"HTTPS heartbeat: status=200\n", KeyboardInterrupt()])
        self.assertEqual(self.run_monitor(port, []), 0)
        self.assertEqual(port.reads, 2)
        self.assertTrue(port.closed)

    def test_check_timeout_is_a_failure(self):
        port = Port([])
        self.assertEqual(self.run_monitor(port, ["--check", "--seconds", "1"], [0, 2]), 1)
        self.assertTrue(port.closed)

    def test_reboot_check_requires_both_on_air_and_a_good_heartbeat(self):
        port = Port([b"HTTPS heartbeat: status=200\n", b"ON AIR: autonomous Wi-Fi signaling\n"])
        self.assertEqual(self.run_monitor(port, ["--check", "--reset"]), 0)
        self.assertEqual(port.reads, 2)
        self.assertEqual(port.writes, [b'{"cmd":"restart_device"}\n'])
        self.assertTrue(port.closed)
