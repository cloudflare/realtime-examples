#!/usr/bin/env python3
"""Stream filtered USB device logs. --check waits for a successful HTTPS heartbeat."""
import argparse
import json
import termios
import time

from config import read_env
from project import ROOT
from serial_device import device_port

VISIBLE_LOG_MARKERS = (
    "HTTPS ",
    "ON AIR:",
    "Music validated:",
    "Live spectrum ready:",
    "Crypto ",
    "Crypto:",
    "crypto security tests passed",
    "str0m initialized",
)


def open_port():
    import serial
    port = serial.Serial(port=None, baudrate=115200, timeout=0.1, exclusive=True)
    port.dtr = True
    port.rts = True
    port.port = device_port()
    port.open()
    attrs = termios.tcgetattr(port.fileno())
    attrs[2] &= ~termios.HUPCL
    termios.tcsetattr(port.fileno(), termios.TCSANOW, attrs)
    return port


def main(argv=None):
    import serial
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reset", action="store_true", help="Reboot the board before monitoring"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Require a successful heartbeat (and startup banner with --reset); nonzero on failure",
    )
    parser.add_argument(
        "--seconds",
        type=float,
        help="Stop after this duration (check defaults to 90 seconds)",
    )
    args = parser.parse_args(argv)
    if args.seconds is not None and args.seconds <= 0:
        parser.error("--seconds must be positive")
    seconds = args.seconds if args.seconds is not None else (90 if args.check else None)
    secrets = read_env(ROOT / ".credential.env")
    out = ROOT / "artifacts/radio"
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    prefix = "autonomous-check" if args.check else "autonomous-monitor"
    path = out / (prefix + ".log")
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    port = open_port()
    if args.reset:
        port.write(b'{"cmd":"restart_device"}\n')
        port.flush()
    pending = bytearray()
    result = {
        "reset_requested": args.reset,
        "usb_signaling_commands_sent": 0,
        "on_air_banner_captured": False,
        "https_stages": [],
        "successful_heartbeats": 0,
    }
    deadline = time.monotonic() + seconds if seconds is not None else None
    try:
        with path.open("w") as log:
            while deadline is None or time.monotonic() < deadline:
                try:
                    pending.extend(port.read(8192))
                except (serial.SerialException, OSError):
                    port.close()
                    time.sleep(0.3)
                    try:
                        port = open_port()
                    except (serial.SerialException, OSError, RuntimeError):
                        continue
                    continue
                while b"\n" in pending:
                    raw, _, pending = pending.partition(b"\n")
                    line = raw.decode(errors="replace").strip()
                    for value in secrets.values():
                        if value:
                            line = line.replace(value, "[redacted]")
                    log.write(line + "\n")
                    log.flush()
                    # Print selected diagnostics; save all redacted lines in the private log.
                    if any(marker in line for marker in VISIBLE_LOG_MARKERS):
                        print(line[:400], flush=True)
                    if "ON AIR: autonomous" in line:
                        result["on_air_banner_captured"] = True
                    for stage in ("start", "channels", "ready"):
                        if (
                            f"HTTPS {stage}: status=200" in line
                            and stage not in result["https_stages"]
                        ):
                            result["https_stages"].append(stage)
                    if "HTTPS heartbeat: status=200" in line:
                        result["successful_heartbeats"] += 1
                if (
                    args.check
                    and result["successful_heartbeats"]
                    and (not args.reset or result["on_air_banner_captured"])
                ):
                    break
    except KeyboardInterrupt:
        pass
    finally:
        port.close()
    if args.check:
        result["passed"] = bool(result["successful_heartbeats"]) and (
            not args.reset or result["on_air_banner_captured"]
        )
        summary = out / (prefix + ".json")
        summary.touch(mode=0o600, exist_ok=True)
        summary.chmod(0o600)
        summary.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2), flush=True)
        return 0 if result["passed"] else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
