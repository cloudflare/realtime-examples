# Music catalog

## Prepare a playlist

Put your audio in ignored `tracks/` and use the
[README music commands](../../README.md#change-the-playlist) to prepare and flash
it in filename order. For custom order or metadata, copy
[playlist.example.json](../../playlist.example.json) to ignored `playlist.json`,
edit its entries, and run `make music PLAYLIST=playlist.json` from `esp32-radio/`.

Preparation uses 48 kHz stereo Opus with a 96 kb/s variable-bitrate target.
A catalog holds up to 32 songs of at most 10 minutes each, totaling at most
60 minutes, and must fit the 16 MiB music partition. The board supplies title,
artist, and duration; replacing the music needs no Worker deployment.

Playback loops. **Next track** advances while preserving pause; **Restart**
begins the current song and resumes playback. Flashing music reboots the board.
See [compatibility](../../ERRATA.md#music-pack-compatibility) before updating an
older partition layout or firmware.

## Binary format

The `music` partition starts at `0x410000` and occupies 16 MiB. It is read-only
while the application runs. The radio task uses synchronous partition reads
through a 32 KiB cache; compressed audio is never loaded as a whole partition.

All integers are little-endian. The 64-byte v4 header is:

| Offset | Type     | Meaning                                                 |
| ------ | -------- | ------------------------------------------------------- |
| 0      | 8 bytes  | `S3MUSIC\0`                                             |
| 8      | u32      | Version, 4                                              |
| 12     | u32      | Song count, 1–32                                        |
| 16     | u32      | Sample rate, 48000                                      |
| 20     | u32      | Channels, 2                                             |
| 24     | u32      | Frame duration, 20 ms                                   |
| 28     | u32      | CRC32 of bytes after the header through the used length |
| 32     | u32      | Total used bytes, including this header                 |
| 36     | 28 bytes | Reserved, zero when generated                           |

The generator writes one u32 length followed by a complete v3 pack for each
song, in playback order. There is no padding between songs. Each v3 pack has
a 64-byte header, with version 3 and frame count at offset 12. Bytes 32–63
are reserved in v3; only the outer v4 header stores used length at offset 32.
The v3 payload starts with u16 title/artist byte lengths, their UTF-8 strings,
then records of u16 Opus length followed by the packet. V3's CRC covers its
complete payload.

Tags are limited to 256 UTF-8 bytes each. Titles must contain non-whitespace
text, and control characters are rejected in both tags. Packets contain
1–1275 bytes. Songs have 1–30,000 frames, and the catalog has at most 180,000
frames. Its 32-bit offset entries occupy at most 720,000 bytes (about 703 KiB),
excluding spare allocation capacity and song metadata. Duration is derived from
packet count.

Legacy v1 and v2 packs are treated as one-song catalogs without title metadata.
V1 records include 32 precomputed spectrum bytes, which are ignored. A standalone
v3 pack is also accepted. Partition bytes beyond the standalone pack's final
record or the v4 header's used length are ignored.

The player maintains a continuous transport clock and separate values for the
song index, song position and playback revision. Advancing to another song or
restarting the current song increments the revision.

An analysis epoch tags every queued FFT job and its result. Pause, resume,
restart and song changes increment the epoch, and the radio accepts a result
only when its epoch matches the current value and it is at most 120 ms old.
Spectrum v2 frames are 48 bytes; the final four bytes contain the little-endian
playback revision. The Worker assigns a new publisher generation to each board
session, so metadata revisions are compared only within the session that
produced them.
