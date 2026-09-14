//! Task ownership and terminal recovery. All ordinary state is explicitly owned.
use crate::{
    analysis, console,
    error::{Error, Result},
    platform::{self, Board, SpawnConfig},
    radio, signaling,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::sync_channel,
    },
    thread,
    time::Duration,
};

pub(crate) fn run() -> Result<()> {
    platform::log("Pocket Radio: Rust application starting");
    let board = Board::init()?;
    let (analysis, analysis_worker) = analysis::channel();
    {
        let _configuration = SpawnConfig::analysis()?;
        thread::Builder::new()
            .name("analysis".into())
            .stack_size(20_480)
            .spawn(move || {
                if let Err(error) = analysis_worker.run() {
                    recover(error);
                }
            })
            .map_err(|_| Error::new("cannot start analysis task"))?;
    }
    let (metrics, metrics_worker) = crate::metrics::channel();
    {
        let _configuration = SpawnConfig::metrics()?;
        thread::Builder::new()
            .name("metrics".into())
            .stack_size(8192)
            .spawn(move || {
                if let Err(error) = metrics_worker.run() {
                    platform::log(&format!("Hardware metrics unavailable: {error}"));
                }
            })
            .map_err(|_| Error::new("cannot start metrics task"))?;
    }
    let station = crate::station::Station::default();
    let radio_station = station.clone();
    let (requests, radio_requests) = sync_channel(4);
    let (radio_events, events) = sync_channel(8);
    {
        let _configuration = SpawnConfig::radio()?;
        thread::Builder::new()
            .name("radio".into())
            .stack_size(49_152)
            .spawn(move || {
                if let Err(error) = radio::run(
                    board,
                    radio_requests,
                    radio_events,
                    analysis,
                    radio_station,
                    metrics,
                ) {
                    recover(error);
                }
            })
            .map_err(|_| Error::new("cannot start radio task"))?;
    }
    thread::Builder::new()
        .name("signaling".into())
        .stack_size(16_384)
        .spawn(move || {
            if let Err(error) = signaling::run(requests, events, station) {
                recover(error);
            }
        })
        .map_err(|_| Error::new("cannot start signaling task"))?;
    console::run()
}

static RECOVERING: AtomicBool = AtomicBool::new(false);

/// Fatal runtime failures restart the device. One caller owns
/// the recovery counter; concurrent failures park until reset, avoiding races.
pub(crate) fn recover(error: Error) -> ! {
    if RECOVERING.swap(true, Ordering::AcqRel) {
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }
    let seconds = 5u64 << platform::recovery_attempt(false).min(3);
    platform::log(&format!("{error}; restarting in {seconds} seconds"));
    thread::sleep(Duration::from_millis(
        seconds * 1000 + u64::from(platform::random() % 1000),
    ));
    platform::restart()
}
