"""The documented SFU protobuf and PCM conversion for the SFU audio transport."""

import numpy as np
import soxr


def _varint(value):
    out = bytearray()
    while value > 127:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def encode_packet(pcm, sequence=0, timestamp=0):
    if len(pcm) > 32000 or len(pcm) % 4:
        raise ValueError("Expected bounded stereo PCM16")
    return (
        b"\x08"
        + _varint(sequence & 0xFFFFFFFF)
        + b"\x10"
        + _varint(timestamp & 0xFFFFFFFF)
        + b"\x2a"
        + _varint(len(pcm))
        + pcm
    )


def decode_packet(raw):
    if len(raw) > 32768:
        raise ValueError("SFU packet exceeds message limit")
    offset = 0
    result = {"sequence": 0, "timestamp": 0, "payload": b""}

    def varint():
        nonlocal offset
        value = 0
        for shift in range(0, 70, 7):
            if offset >= len(raw):
                raise ValueError("Truncated protobuf")
            byte = raw[offset]
            offset += 1
            value |= (byte & 127) << shift
            if not byte & 128:
                return value
        raise ValueError("Invalid protobuf varint")

    while offset < len(raw):
        tag = varint()
        field, wire = tag >> 3, tag & 7
        if not field:
            raise ValueError("Invalid protobuf field")
        if wire == 0:
            value = varint()
            if field in (1, 2):
                result["sequence" if field == 1 else "timestamp"] = value
        elif wire in (1, 2, 5):
            length = varint() if wire == 2 else (8 if wire == 1 else 4)
            if offset + length > len(raw):
                raise ValueError("Truncated protobuf field")
            if field == 5 and wire == 2:
                result["payload"] = raw[offset : offset + length]
            offset += length
        else:
            raise ValueError("Unsupported protobuf field")
    if len(result["payload"]) % 4:
        raise ValueError("Expected interleaved stereo PCM16")
    return result


class AudioConverter:
    def __init__(self):
        self.resampler = soxr.ResampleStream(48000, 16000, 1, dtype="int16")

    def incoming(self, stereo):
        samples = np.frombuffer(stereo, dtype="<i2").reshape((-1, 2))
        mono = samples.astype(np.int32).sum(axis=1) // 2
        return self.resampler.resample_chunk(mono.astype(np.int16)).tobytes()

    def outgoing(self, mono):
        samples = np.frombuffer(mono, dtype="<i2")
        return np.repeat(samples, 2).tobytes()
