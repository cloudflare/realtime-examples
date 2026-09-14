"""Validate the music allocation before a music-only update."""
import struct

MUSIC_OFFSET = 0x410000
MUSIC_BYTES = 16 * 1024 * 1024


def require_music_partition(table):
    found = []
    for offset in range(0, min(len(table), 0xC00), 32):
        entry = table[offset:offset + 32]
        if len(entry) != 32 or entry[:2] != b"\xaa\x50":
            break
        magic, kind, subtype, address, size, label, flags = struct.unpack('<HBBII16sI', entry)
        if label.rstrip(b'\0') == b'music':
            found.append((kind, subtype, address, size, flags))
    if found != [(1, 0x40, MUSIC_OFFSET, MUSIC_BYTES, 0)]:
        raise ValueError("Install the 16 MiB partition layout with make flash before using make flash-music.")
