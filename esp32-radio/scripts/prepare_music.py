#!/usr/bin/env python3
"""Prepare locally supplied audio for the S3. Requires ffmpeg and ffprobe.

The v4 catalog contains ordered v3 songs with metadata and 20 ms Opus packets.
Writes the flash image music.bin and local summary music.json to artifacts/radio.
"""
import argparse
import json
import os
from pathlib import Path
import struct
import subprocess
import unicodedata
import zlib


from project import ROOT
from music_partition import MUSIC_BYTES
MAX_TAG_BYTES = 256
MAX_TRACKS = 32
MAX_TOTAL_FRAMES = 180_000
AUDIO_SUFFIXES = {".flac", ".wav", ".mp3", ".m4a", ".ogg", ".opus"}


def music_tag(value, name, required=False):
    value = value.strip()
    if (required and not value) or len(value.encode("utf-8")) > MAX_TAG_BYTES:
        raise ValueError(f"{name} must be {'1' if required else '0'}..{MAX_TAG_BYTES} UTF-8 bytes; use --{name.lower()} to override it")
    if any(unicodedata.category(character) == "Cc" for character in value):
        raise ValueError(f"{name} contains control characters; use --{name.lower()} to override it")
    return value


def ogg_packets(data):
    cursor = 0
    packet = bytearray()
    while cursor < len(data):
        if data[cursor:cursor + 4] != b"OggS":
            raise ValueError("Invalid Ogg page")
        segments = data[cursor + 26]
        sizes = data[cursor + 27:cursor + 27 + segments]
        cursor += 27 + segments
        for size in sizes:
            packet.extend(data[cursor:cursor + size])
            cursor += size
            if size < 255:
                yield bytes(packet)
                packet.clear()
    if packet:
        raise ValueError("Truncated Ogg packet")


def pack_song(packets, title, artist):
    title = music_tag(title, "Title", required=True)
    artist = music_tag(artist, "Artist")
    if not 1 <= len(packets) <= 30000:
        raise ValueError("Each song must contain 1..30000 audio frames (up to 10 minutes)")
    title_bytes, artist_bytes = title.encode(), artist.encode()
    payload = bytearray(struct.pack("<HH", len(title_bytes), len(artist_bytes)) + title_bytes + artist_bytes)
    for packet in packets:
        if not 0 < len(packet) <= 1275:
            raise ValueError("Unexpected Opus packet size")
        payload.extend(struct.pack("<H", len(packet)) + packet)
    header = struct.pack("<8sIIIIII32x", b"S3MUSIC\0", 3, len(packets), 48000, 2, 20, zlib.crc32(payload))
    return header + payload


def pack_catalog(songs):
    if not 1 <= len(songs) <= MAX_TRACKS:
        raise ValueError(f"A playlist needs 1..{MAX_TRACKS} songs")
    if sum(struct.unpack_from("<I", song, 12)[0] for song in songs) > MAX_TOTAL_FRAMES:
        raise ValueError("Playlist exceeds the bounded 60-minute frame index")
    payload = b"".join(struct.pack("<I", len(song)) + song for song in songs)
    used = 64 + len(payload)
    if used > MUSIC_BYTES:
        raise ValueError("Encoded playlist exceeds the 16 MiB music partition")
    header = bytearray(struct.pack("<8sIIIIII32x", b"S3MUSIC\0", 4, len(songs), 48000, 2, 20, zlib.crc32(payload)))
    struct.pack_into("<I", header, 32, used)
    return header + payload


def inputs(args):
    if args.playlist and args.files:
        raise ValueError("Use either audio files or --playlist")
    playlist = args.playlist or (os.environ.get("PLAYLIST") if not args.files else None)
    if playlist:
        path = Path(playlist)
        entries = json.loads(path.read_text())
        if not isinstance(entries, list):
            raise ValueError("A playlist JSON file must contain an ordered array")
        result = []
        for entry in entries:
            if isinstance(entry, str): entry = {"file": entry}
            if not isinstance(entry, dict) or set(entry) - {"file", "title", "artist"} or not isinstance(entry.get("file"), str):
                raise ValueError("Each playlist entry needs a file and optional title/artist")
            if any(key in entry and not isinstance(entry[key], str) for key in ["title", "artist"]):
                raise ValueError("Title and artist overrides must be strings")
            result.append({**entry, "file": path.parent / entry["file"]})
    else:
        paths = args.files or ([Path(os.environ["TRACK"])] if os.environ.get("TRACK") else [])
        result = []
        for path in paths:
            if path.is_dir():
                result.extend({"file": child} for child in sorted(path.rglob("*")) if child.suffix.lower() in AUDIO_SUFFIXES)
            else: result.append({"file": path})
    if not 1 <= len(result) <= MAX_TRACKS:
        raise ValueError(f"Provide 1..{MAX_TRACKS} songs, a folder, or --playlist")
    if args.title is not None or args.artist is not None:
        if len(result) != 1: raise ValueError("Use playlist entries for per-song metadata overrides")
        if args.title is not None: result[0]["title"] = args.title
        if args.artist is not None: result[0]["artist"] = args.artist
    return result


def encode_song(entry):
    file = entry["file"]
    metadata = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_format", "-of", "json", str(file)]))["format"]
    tags = {key.lower(): value for key, value in metadata.get("tags", {}).items()}
    title = music_tag(entry.get("title", tags.get("title", file.stem)), "Title", required=True)
    artist = music_tag(entry.get("artist", tags.get("artist", "")), "Artist")
    encoded = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(file), "-map", "0:a:0", "-vn",
        "-ar", "48000", "-ac", "2", "-c:a", "libopus", "-b:a", "96k",
        "-vbr", "on", "-frame_duration", "20", "-application", "audio", "-f", "opus", "pipe:1"])
    packets = list(ogg_packets(encoded))
    if len(packets) < 3 or not packets[0].startswith(b"OpusHead") or not packets[1].startswith(b"OpusTags"):
        raise ValueError("Expected Opus headers")
    packets = packets[2:]
    packed = pack_song(packets, title, artist)
    return packed, {"title": title, "artist": artist, "durationMs": len(packets) * 20,
                    "sourceDurationMs": round(float(metadata["duration"]) * 1000),
                    "frames": len(packets), "bytes": len(packed)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", type=Path, nargs="*", help="Audio files or folders in playlist order")
    parser.add_argument("--playlist", type=Path, help="Ordered JSON list of files and optional metadata overrides")
    parser.add_argument("--title", help="Override the title for a single input")
    parser.add_argument("--artist", help="Override the artist for a single input")
    args = parser.parse_args()
    try:
        encoded = [encode_song(entry) for entry in inputs(args)]
        binary = pack_catalog([song for song, _ in encoded])
    except ValueError as error:
        parser.error(str(error))
    manifest = {"packVersion": 4, "trackCount": len(encoded), "tracks": [track for _, track in encoded],
                "durationMs": sum(track["durationMs"] for _, track in encoded), "bytes": len(binary),
                "codec": "Opus", "sampleRate": 48000, "channels": 2, "frameMs": 20, "spectrum": "live-fft"}
    out = ROOT / "artifacts/radio"
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, value in [("music.bin", binary), ("music.json", (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode())]:
        temporary = out / (name + ".tmp")
        temporary.touch(mode=0o600, exist_ok=True)
        temporary.chmod(0o600)
        temporary.write_bytes(value)
        temporary.replace(out / name)
    print(json.dumps(manifest, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
