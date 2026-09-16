use radio_core::{
    playback::{Due, Playback},
    protocol::Action,
    spectrum::{Continuity, FFT_SIZE, HISTORY_FLOATS, Tag, Window},
};
use std::num::NonZeroU32;

#[test]
fn window_keeps_the_latest_pcm_and_applies_periodic_hann() {
    let mut storage = vec![0.0; HISTORY_FLOATS];
    let mut window = Window::new(&mut storage).unwrap();
    let mut fft = vec![9.0; FFT_SIZE * 2];
    assert!(!window.write_complex(&mut fft).unwrap());
    let pcm: Vec<i16> = (0..FFT_SIZE * 2)
        .flat_map(|i| [i as i16, i as i16])
        .collect();
    for chunk in pcm.chunks(1920) {
        window.push_stereo(chunk).unwrap();
    }
    assert!(window.write_complex(&mut fft).unwrap());
    assert_eq!(fft[0], 0.0);
    assert!((fft[FFT_SIZE] - 3072.0 / 32768.0).abs() < 1e-6);
    assert!((fft[FFT_SIZE / 2] - 2560.0 / 32768.0 * 0.5).abs() < 1e-6);
    assert!(fft.chunks_exact(2).all(|pair| pair[1] == 0.0));
    window.clear();
    assert!(!window.write_complex(&mut fft).unwrap());
}

#[test]
fn band_mapping_has_known_silence_and_amplitude_calibration() {
    let mut storage = vec![0.0; HISTORY_FLOATS];
    let window = Window::new(&mut storage).unwrap();
    let mut fft = vec![0.0; FFT_SIZE * 2];
    assert_eq!(window.bands(&fft).unwrap(), [0; 32]);
    // A periodic-Hann-windowed 1.5 kHz tone of amplitude 1/16 has a central
    // bin magnitude N/64 = 32. Its -24.08 dBFS maps to 185/255 in band 19.
    fft[64 * 2] = 32.0;
    let levels = window.bands(&fft).unwrap();
    assert_eq!(levels[19], 185);
    assert_eq!(levels.iter().filter(|&&value| value != 0).count(), 1);
}

#[test]
fn invalid_buffers_are_rejected_before_mutating_history() {
    assert!(Window::new(&mut [0.0; 3]).is_err());
    let mut storage = vec![0.0; HISTORY_FLOATS];
    let mut window = Window::new(&mut storage).unwrap();
    assert!(window.push_stereo(&[1, 2, 3]).is_err());
    assert!(window.write_complex(&mut [0.0; 8]).is_err());
    assert!(window.bands(&[0.0; 8]).is_err());
}

fn due(epoch: u32, pts_ms: u32) -> Due {
    Due {
        epoch,
        track_index: 0,
        revision: 0,
        pts_ms,
        index: 0,
        paused: false,
        spectrum: true,
    }
}

#[test]
fn missing_packets_and_epoch_changes_reset_decoder_continuity() {
    let mut cursor = Continuity::default();
    assert!(cursor.begin(due(0, 0)));
    assert!(!cursor.begin(due(0, 20)));
    assert!(cursor.begin(due(0, 60)));
    assert!(cursor.begin(due(1, 80)));
    assert!(!cursor.begin(due(1, 100)));
    cursor.clear();
    assert!(cursor.begin(due(1, 120)));
    assert!(cursor.begin(due(1, u32::MAX - 19)));
    assert!(!cursor.begin(due(1, 0)));
}

#[test]
fn old_analysis_cannot_cross_pause_restart_or_track_loop() {
    let mut player = Playback::new(NonZeroU32::new(4).unwrap(), 0);
    let first = player.due(0).unwrap();
    let tag = Tag {
        due: first,
        queued_us: 0,
    };
    assert!(tag.is_fresh(player.epoch(), 5000));
    player.apply(Action::Pause);
    assert!(!tag.is_fresh(player.epoch(), 5000));
    let paused_epoch = player.epoch();
    player.apply(Action::Pause);
    assert_eq!(paused_epoch, player.epoch());
    player.apply(Action::Play);
    let playing_epoch = player.epoch();
    assert_ne!(playing_epoch, paused_epoch);
    player.apply(Action::Restart);
    assert_ne!(playing_epoch, player.epoch());
    let epoch = player.epoch();
    for i in 1..=4 {
        player.due(i * 20000);
    }
    assert_eq!(player.epoch(), epoch);
    player.due(100_000);
    assert_ne!(player.epoch(), epoch);
    assert!(
        !Tag {
            due: due(epoch, 80),
            queued_us: 0
        }
        .is_fresh(epoch, 120_001)
    );
    assert!(
        !Tag {
            due: due(epoch, 80),
            queued_us: 100
        }
        .is_fresh(epoch, 99)
    );
}
