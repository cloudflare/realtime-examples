//! Indexed playlists over bounded random-access storage. Audio stays in storage.
use super::{
    BANDS, Error, FRAME_MS, HEADER_BYTES, MAX_FRAMES, MAX_OPUS_BYTES, MAX_TAG_BYTES, Track, le32,
    tag,
};
use std::num::NonZeroU32;

pub const MAX_MUSIC_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_TRACKS: usize = 32;
/// At most 180,000 u32 offsets (720,000 bytes of entries), even for compressible input.
pub const MAX_TOTAL_FRAMES: usize = 180_000;

/// Random-access storage whose contents remain unchanged while its catalog is used.
pub trait ReadAt {
    fn size(&self) -> usize;
    fn read_exact(&mut self, offset: usize, out: &mut [u8]) -> Result<(), Error>;
}

impl ReadAt for &[u8] {
    fn size(&self) -> usize {
        self.len()
    }
    fn read_exact(&mut self, offset: usize, out: &mut [u8]) -> Result<(), Error> {
        let end = offset.checked_add(out.len()).ok_or(Error::Truncated)?;
        out.copy_from_slice(self.get(offset..end).ok_or(Error::Truncated)?);
        Ok(())
    }
}

#[derive(Debug)]
pub struct Song {
    pub metadata: Option<Track>,
    pub frames: NonZeroU32,
    first: usize,
    prefix: usize,
    end: usize,
}

#[derive(Debug)]
pub struct Catalog {
    songs: Vec<Song>,
    offsets: Vec<u32>,
    used: usize,
}

impl Catalog {
    /// Validates all boundaries and checksums before returning a playable catalog.
    pub fn parse(source: &mut impl ReadAt) -> Result<Self, Error> {
        let size = source.size();
        let header = read::<HEADER_BYTES>(source, 0, size)?;
        if &header[..8] != b"S3MUSIC\0" {
            return Err(Error::Header);
        }
        let mut catalog = Self {
            songs: Vec::new(),
            offsets: Vec::new(),
            used: 0,
        };
        if le32(&header, 8) != 4 {
            catalog.used = catalog.add_song(source, 0, size.min(MAX_MUSIC_BYTES))?;
            return Ok(catalog);
        }
        let count = le32(&header, 12) as usize;
        if !(1..=MAX_TRACKS).contains(&count) {
            return Err(Error::TrackCount);
        }
        format(&header)?;
        let used = le32(&header, 32) as usize;
        if !(HEADER_BYTES..=MAX_MUSIC_BYTES).contains(&used) || used > source.size() {
            return Err(Error::Truncated);
        }
        checksum(source, HEADER_BYTES, used, le32(&header, 28))?;
        let mut cursor = HEADER_BYTES;
        for _ in 0..count {
            let length = u32::from_le_bytes(read::<4>(source, cursor, used)?) as usize;
            cursor = cursor.checked_add(4).ok_or(Error::Truncated)?;
            let end = cursor
                .checked_add(length)
                .filter(|&end| end <= used)
                .ok_or(Error::Truncated)?;
            if length < HEADER_BYTES {
                return Err(Error::Truncated);
            }
            if catalog.add_song(source, cursor, end)? != end {
                return Err(Error::Truncated);
            }
            cursor = end;
        }
        if cursor != used {
            return Err(Error::Truncated);
        }
        catalog.used = used;
        Ok(catalog)
    }

    fn add_song(
        &mut self,
        source: &mut impl ReadAt,
        start: usize,
        limit: usize,
    ) -> Result<usize, Error> {
        let header = read::<HEADER_BYTES>(source, start, limit)?;
        if &header[..8] != b"S3MUSIC\0" {
            return Err(Error::Header);
        }
        let version = le32(&header, 8);
        let prefix = match version {
            1 => 2 + BANDS,
            2 | 3 => 2,
            _ => return Err(Error::Header),
        };
        format(&header)?;
        let frames = NonZeroU32::new(le32(&header, 12))
            .filter(|n| n.get() <= MAX_FRAMES)
            .ok_or(Error::FrameCount)?;
        if self.offsets.len() + frames.get() as usize > MAX_TOTAL_FRAMES {
            return Err(Error::FrameCount);
        }
        let mut cursor = start + HEADER_BYTES;
        let metadata = if version == 3 {
            let lengths = read::<4>(source, cursor, limit)?;
            cursor += 4;
            let title_len = u16::from_le_bytes([lengths[0], lengths[1]]) as usize;
            let artist_len = u16::from_le_bytes([lengths[2], lengths[3]]) as usize;
            if !(1..=MAX_TAG_BYTES).contains(&title_len) || artist_len > MAX_TAG_BYTES {
                return Err(Error::Metadata);
            }
            let title = read_tag(source, &mut cursor, title_len, limit)?;
            let artist = read_tag(source, &mut cursor, artist_len, limit)?;
            if title.trim().is_empty() {
                return Err(Error::Metadata);
            }
            Some(Track {
                title,
                artist,
                duration_ms: frames.get() * FRAME_MS,
            })
        } else {
            None
        };
        self.offsets
            .try_reserve_exact(frames.get() as usize)
            .map_err(|_| Error::Memory)?;
        let first = self.offsets.len();
        for _ in 0..frames.get() {
            let length = u16::from_le_bytes(read::<2>(source, cursor, limit)?) as usize;
            if !(1..=MAX_OPUS_BYTES).contains(&length) {
                return Err(Error::PacketSize);
            }
            let end = cursor
                .checked_add(prefix + length)
                .filter(|&end| end <= limit)
                .ok_or(Error::Truncated)?;
            self.offsets.push(cursor as u32);
            cursor = end;
        }
        checksum(source, start + HEADER_BYTES, cursor, le32(&header, 28))?;
        self.songs.push(Song {
            metadata,
            frames,
            first,
            prefix,
            end: cursor,
        });
        Ok(cursor)
    }

    pub fn songs(&self) -> &[Song] {
        &self.songs
    }
    /// Frame-offset capacity in bytes, excluding allocator overhead and song metadata.
    pub fn index_bytes(&self) -> usize {
        self.offsets.capacity() * size_of::<u32>()
    }
    pub fn used_bytes(&self) -> usize {
        self.used
    }

    /// Copies a packet from the unchanged storage supplied to [`Self::parse`].
    pub fn read_frame(
        &self,
        source: &mut impl ReadAt,
        song: usize,
        index: u32,
        out: &mut [u8],
    ) -> Result<usize, Error> {
        let song = self.songs.get(song).ok_or(Error::TrackCount)?;
        if index >= song.frames.get() {
            return Err(Error::FrameCount);
        }
        let offset = self.offsets[song.first + index as usize] as usize;
        let length = u16::from_le_bytes(read::<2>(source, offset, song.end)?) as usize;
        let start = offset + song.prefix;
        if !(1..=MAX_OPUS_BYTES).contains(&length) || length > out.len() {
            return Err(Error::PacketSize);
        }
        if start + length > song.end {
            return Err(Error::Truncated);
        }
        source.read_exact(start, &mut out[..length])?;
        Ok(length)
    }
}

fn format(header: &[u8; HEADER_BYTES]) -> Result<(), Error> {
    if le32(header, 16) != 48_000 || le32(header, 20) != 2 || le32(header, 24) != FRAME_MS {
        return Err(Error::Format);
    }
    Ok(())
}

fn read<const N: usize>(
    source: &mut impl ReadAt,
    offset: usize,
    limit: usize,
) -> Result<[u8; N], Error> {
    if offset.checked_add(N).is_none_or(|end| end > limit) {
        return Err(Error::Truncated);
    }
    let mut out = [0; N];
    source.read_exact(offset, &mut out)?;
    Ok(out)
}

fn read_tag(
    source: &mut impl ReadAt,
    cursor: &mut usize,
    length: usize,
    limit: usize,
) -> Result<String, Error> {
    if *cursor + length > limit {
        return Err(Error::Truncated);
    }
    let mut bytes = [0; MAX_TAG_BYTES];
    source.read_exact(*cursor, &mut bytes[..length])?;
    *cursor += length;
    Ok(tag(&bytes[..length])?.to_owned())
}

fn checksum(
    source: &mut impl ReadAt,
    start: usize,
    end: usize,
    expected: u32,
) -> Result<(), Error> {
    let mut hash = crc32fast::Hasher::new();
    let mut offset = start;
    let mut bytes = [0; 1024];
    while offset < end {
        let length = bytes.len().min(end - offset);
        source.read_exact(offset, &mut bytes[..length])?;
        hash.update(&bytes[..length]);
        offset += length;
    }
    if hash.finalize() != expected {
        return Err(Error::Checksum);
    }
    Ok(())
}
