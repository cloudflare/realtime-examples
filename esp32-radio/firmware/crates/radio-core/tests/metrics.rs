use radio_core::metrics::CpuWindow;

#[test]
fn cpu_windows_measure_each_core_and_keep_u64_counters() {
    let mut meter = CpuWindow::default();
    let base = u32::MAX as u64 + 1_000_000;
    assert_eq!(meter.sample(base, [base - 1000, base - 2000]), [None, None]);
    assert_eq!(
        meter.sample(base + 1_000_000, [base + 799_000, base + 398_000]),
        [Some(2000), Some(6000)]
    );
    assert_eq!(
        meter.sample(base + 2_000_000, [base + 1_799_000, base + 398_000]),
        [Some(0), Some(10_000)]
    );
}

#[test]
fn invalid_or_discontinuous_accounting_is_unavailable_and_recovers() {
    let mut meter = CpuWindow::default();
    meter.sample(1_000_000, [500_000, 500_000]);
    assert_eq!(meter.sample(2_000_000, [400_000, 1_600_000]), [None, None]);
    assert_eq!(
        meter.sample(3_000_000, [900_000, 2_100_000]),
        [Some(5000), Some(5000)]
    );
    assert_eq!(
        meter.sample(10_000_000, [1_000_000, 2_200_000]),
        [None, None]
    );
    assert_eq!(
        meter.sample(10_000_001, [1_000_001, 2_200_001]),
        [None, None]
    );
    assert_eq!(
        meter.sample(11_000_001, [1_500_001, 2_700_001]),
        [Some(5000), Some(5000)]
    );
    assert_eq!(meter.sample(0, [0, 0]), [None, None]);
}

#[test]
fn hardware_telemetry_fits_the_transport_data_limit_at_counter_limits() {
    use radio_core::{
        metrics::{Hardware, Memory},
        protocol::{Color, MusicStatus, SpectrumStatus, Telemetry},
    };
    let memory = Memory {
        free: u32::MAX,
        minimum_free: u32::MAX,
        largest_block: u32::MAX,
    };
    let packet = Telemetry {
        event: "telemetry",
        firmware: "rust",
        sequence: u64::MAX,
        uptime_ms: u64::MAX,
        position_ms: u32::MAX,
        duration_ms: u32::MAX,
        playback_revision: u32::MAX,
        music: MusicStatus {
            cache_bytes: u32::MAX,
            index_bytes: u32::MAX,
            reads: u32::MAX,
            max_read_us: u32::MAX,
        },
        paused: false,
        rssi: Some(-127),
        heap: u32::MAX,
        led: Color([255; 3]),
        audio_errors: u64::MAX,
        data_errors: u64::MAX,
        skipped_frames: u64::MAX,
        rejected_commands: u64::MAX,
        dropped_commands: u32::MAX,
        stack_free: u32::MAX,
        spectrum: SpectrumStatus {
            frames: u64::MAX,
            errors: u64::MAX,
            resets: u64::MAX,
            input_dropped: u64::MAX,
            output_dropped: u64::MAX,
            stale: u64::MAX,
            mean_us: u32::MAX,
            max_us: u32::MAX,
            stack_free: u32::MAX,
            ..SpectrumStatus::default()
        },
        hardware: Some(Hardware {
            sampled_at_ms: u64::MAX,
            cpu_busy_bps: [Some(10000); 2],
            chip_temperature_mc: Some(-10000),
            internal: memory,
            psram: memory,
            sample_cost_us: u32::MAX,
            sampler_stack_free: u32::MAX,
        }),
    };
    let bytes = serde_json::to_vec(&packet).unwrap();
    assert!(
        bytes.len() <= 2048,
        "{} bytes exceed the native packet capacity",
        bytes.len()
    );
    assert!(
        !serde_json::from_slice::<serde_json::Value>(&bytes)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("random")
    );
}
