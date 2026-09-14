"""Select the native USB serial port; explicit ESP32_PORT takes precedence."""
import os
from pathlib import Path

def device_port():
    explicit = os.environ.get("ESP32_PORT")
    if explicit:
        return explicit
    ports = list(Path("/dev/serial/by-id").glob("usb-Espressif_USB_JTAG_serial_debug_unit_*-if00"))
    if len(ports) != 1:
        raise RuntimeError("Expected one Espressif USB debug device; set ESP32_PORT explicitly otherwise")
    return str(ports[0])


def device_identity(port):
    """Use USB serial identity rather than the reusable ttyACM device number."""
    from serial.tools.list_ports import comports
    selected = Path(port).resolve()
    for device in comports():
        if Path(device.device).resolve() == selected and device.serial_number:
            return f"usb:{device.vid}:{device.pid}:{device.serial_number}"
    return None
