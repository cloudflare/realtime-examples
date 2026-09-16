//! USB maintenance only. Browser commands cannot reach this parser.
use crate::{error::Result, platform};
use serde::Deserialize;
use std::{thread, time::Duration};

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case", deny_unknown_fields)]
enum Maintenance {
    Ping,
    RestartDevice,
}

pub(crate) fn run() -> Result<()> {
    let mut line = Vec::with_capacity(128);
    let mut overflow = false;
    loop {
        match platform::console_byte() {
            -1 => thread::sleep(Duration::from_millis(10)),
            10 => {
                if !overflow {
                    match serde_json::from_slice::<Maintenance>(&line) {
                        Ok(Maintenance::RestartDevice) => platform::restart(),
                        Ok(Maintenance::Ping) => println!(
                            "PROBE {{\"event\":\"command_result\",\"cmd\":\"ping\",\"result\":0,\"firmware\":\"rust\"}}"
                        ),
                        Err(_) => {}
                    }
                }
                line.clear();
                overflow = false;
            }
            byte => {
                if line.len() < 128 {
                    line.push(byte as u8);
                } else {
                    overflow = true;
                }
            }
        }
    }
}
