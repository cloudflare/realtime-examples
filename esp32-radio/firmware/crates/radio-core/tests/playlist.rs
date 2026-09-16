use radio_core::{
    music::{Catalog, Error, ReadAt},
    now_playing::{Message, NowPlaying, Snapshot},
    playback::Playback,
    protocol::Action,
};
use std::num::NonZeroU32;

const FIXTURE: &[u8] = include_bytes!("fixtures/playlist-v4.pack");

#[test]
fn catalog_preserves_order_unicode_metadata_and_individual_frames() {
    let mut source = FIXTURE;
    let catalog = Catalog::parse(&mut source).unwrap();
    assert_eq!(catalog.songs().len(), 2);
    assert_eq!(
        catalog.songs()[0].metadata.as_ref().unwrap().title,
        "First café"
    );
    assert_eq!(
        catalog.songs()[1].metadata.as_ref().unwrap().title,
        "第二首"
    );
    assert_eq!(
        catalog.songs()[1].metadata.as_ref().unwrap().duration_ms,
        60
    );
    let mut packet = [0; 1275];
    assert_eq!(
        catalog.read_frame(&mut source, 1, 2, &mut packet).unwrap(),
        3
    );
    assert_eq!(&packet[..3], [0xf8, 0xff, 0xfe]);
    assert!(catalog.read_frame(&mut source, 1, 3, &mut packet).is_err());
    assert!(catalog.read_frame(&mut source, 2, 0, &mut packet).is_err());
}

#[test]
fn catalog_rejects_partial_corrupt_and_hostile_track_tables() {
    for end in 0..FIXTURE.len() {
        assert!(Catalog::parse(&mut &FIXTURE[..end]).is_err());
    }
    let mut bytes = FIXTURE.to_vec();
    *bytes.last_mut().unwrap() ^= 1;
    assert_eq!(
        Catalog::parse(&mut bytes.as_slice()).unwrap_err(),
        Error::Checksum
    );
    for count in [0u32, 33, u32::MAX] {
        let mut bytes = FIXTURE.to_vec();
        bytes[12..16].copy_from_slice(&count.to_le_bytes());
        assert!(Catalog::parse(&mut bytes.as_slice()).is_err());
    }
    let mut bytes = FIXTURE.to_vec();
    bytes[64..68].copy_from_slice(&u32::MAX.to_le_bytes());
    let crc = crc32fast::hash(&bytes[64..]);
    bytes[28..32].copy_from_slice(&crc.to_le_bytes());
    assert!(Catalog::parse(&mut bytes.as_slice()).is_err());
}

#[test]
fn catalog_reads_beyond_four_mib_without_loading_the_partition() {
    let mut song = vec![0; 64];
    song[..8].copy_from_slice(b"S3MUSIC\0");
    for (offset, value) in [(8, 2u32), (12, 7000), (16, 48000), (20, 2), (24, 20)] {
        song[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    for _ in 0..7000 {
        song.extend(1275u16.to_le_bytes());
        song.extend([7; 1275]);
    }
    let crc = crc32fast::hash(&song[64..]);
    song[28..32].copy_from_slice(&crc.to_le_bytes());
    struct Storage {
        bytes: Vec<u8>,
        largest: usize,
    }
    impl ReadAt for Storage {
        fn size(&self) -> usize {
            self.bytes.len()
        }
        fn read_exact(&mut self, offset: usize, out: &mut [u8]) -> Result<(), Error> {
            self.largest = self.largest.max(out.len());
            out.copy_from_slice(
                self.bytes
                    .get(offset..offset + out.len())
                    .ok_or(Error::Truncated)?,
            );
            Ok(())
        }
    }
    let mut storage = Storage {
        bytes: song,
        largest: 0,
    };
    let catalog = Catalog::parse(&mut storage).unwrap();
    let mut frame = [0; 1275];
    catalog
        .read_frame(&mut storage, 0, 6999, &mut frame)
        .unwrap();
    assert!(frame.iter().all(|&n| n == 7));
    assert!(storage.largest <= 1275);
    assert!(catalog.index_bytes() <= 7000 * 4);
}

fn player() -> Playback {
    Playback::playlist(
        [2, 3]
            .into_iter()
            .map(|n| NonZeroU32::new(n).unwrap())
            .collect(),
        0,
    )
    .unwrap()
}

#[test]
fn automatic_transitions_and_next_preserve_the_transport_clock() {
    let mut p = player();
    assert_eq!(p.due(0).unwrap().track_index, 0);
    p.due(20000);
    let next = p.due(40000).unwrap();
    assert_eq!(
        (next.track_index, next.index, next.pts_ms, next.revision),
        (1, 0, 40, 1)
    );
    p.apply(Action::Next);
    let skipped = p.due(60000).unwrap();
    assert_eq!(
        (
            skipped.track_index,
            skipped.index,
            skipped.pts_ms,
            skipped.revision
        ),
        (0, 0, 60, 2)
    );
    p.apply(Action::Pause);
    p.apply(Action::Next);
    let paused = p.due(80000).unwrap();
    assert_eq!(
        (paused.track_index, paused.index, paused.paused),
        (1, 0, true)
    );
    p.apply(Action::Play);
    assert_eq!(p.due(100000).unwrap().pts_ms, 100);
}

#[test]
fn long_stalls_skip_across_song_boundaries_without_bursting() {
    let mut p = player();
    p.due(0);
    let due = p.due(100_060_000).unwrap();
    assert_eq!((due.track_index, due.index, due.pts_ms), (1, 1, 100060));
    assert!(due.revision > 1000);
    assert!(p.due(100_060_001).is_none());
}

fn final_frame_player() -> Playback {
    let mut p = Playback::playlist(
        [2, 3, 4]
            .into_iter()
            .map(|n| NonZeroU32::new(n).unwrap())
            .collect(),
        0,
    )
    .unwrap();
    p.due(0);
    let last = p.due(20_000).unwrap();
    assert_eq!((last.track_index, last.index), (0, 1));
    assert_eq!(p.epoch(), last.epoch);
    p
}

#[test]
fn commands_between_the_final_packet_and_next_deadline_target_the_announced_song() {
    for (action, track, revision) in [(Action::Next, 1, 1), (Action::Restart, 0, 1)] {
        let mut p = final_frame_player();
        p.apply(action);
        assert!(p.due(39_999).is_none());
        let due = p.due(40_000).unwrap();
        assert_eq!(
            (due.track_index, due.index, due.revision, due.pts_ms),
            (track, 0, revision, 40)
        );
    }
    let mut p = final_frame_player();
    p.apply(Action::Pause);
    let held = p.due(40_000).unwrap();
    assert_eq!(
        (held.track_index, held.index, held.revision, held.paused),
        (0, 1, 0, true)
    );
    p.apply(Action::Play);
    let next = p.due(60_000).unwrap();
    assert_eq!(
        (next.track_index, next.index, next.revision, next.pts_ms),
        (1, 0, 1, 60)
    );

    let mut p = final_frame_player();
    p.apply(Action::Pause);
    p.apply(Action::Next);
    let next = p.due(40_000).unwrap();
    assert_eq!(
        (next.track_index, next.index, next.revision, next.paused),
        (1, 0, 1, true)
    );
}

#[test]
fn pending_transition_and_a_stall_advance_once_then_skip_elapsed_packets() {
    let mut p = final_frame_player();
    let due = p.due(1_040_000).unwrap();
    assert_eq!(
        (due.track_index, due.index, due.revision, due.pts_ms),
        (2, 2, 17, 1040)
    );
    assert_eq!(p.skipped_frames(), 50);
    assert!(p.due(1_040_001).is_none());
}

#[test]
fn published_metadata_position_and_duration_follow_the_emitted_song() {
    let mut source = FIXTURE;
    let catalog = Catalog::parse(&mut source).unwrap();
    let mut snapshot = Snapshot::new(&catalog);
    let mut p = player();
    snapshot.record(&catalog, p.due(0).unwrap()).unwrap();
    assert!(!snapshot.record(&catalog, p.due(20_000).unwrap()).unwrap());
    assert_eq!(
        (
            snapshot.now_playing.track_index,
            snapshot.position_ms,
            snapshot.duration_ms
        ),
        (0, 20, 40)
    );
    let next = p.due(40_000).unwrap();
    assert!(snapshot.record(&catalog, next).unwrap());
    assert_eq!(snapshot.now_playing.track.as_ref().unwrap().title, "第二首");
    assert_eq!(
        (
            snapshot.now_playing.revision,
            snapshot.position_ms,
            snapshot.duration_ms
        ),
        (1, 0, 60)
    );
    assert!(
        snapshot
            .record(&catalog, radio_core::playback::Due { index: 3, ..next })
            .is_err()
    );
    assert_eq!(snapshot.position_ms, 0);
}

#[test]
fn maximal_escaped_metadata_fits_the_transport_data_limit() {
    let state = NowPlaying {
        revision: u32::MAX,
        track_index: 31,
        track_count: 32,
        track: Some(radio_core::music::Track {
            title: "\\".repeat(256),
            artist: "\"".repeat(256),
            duration_ms: 600000,
        }),
    };
    let bytes = serde_json::to_vec(&Message {
        event: "nowPlaying",
        now_playing: &state,
    })
    .unwrap();
    assert!(bytes.len() <= 2048);
}
