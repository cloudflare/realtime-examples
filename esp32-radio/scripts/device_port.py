#!/usr/bin/env python3
"""Print the selected ESP32 native USB port."""
from serial_device import device_port


if __name__ == "__main__":
    print(device_port())
