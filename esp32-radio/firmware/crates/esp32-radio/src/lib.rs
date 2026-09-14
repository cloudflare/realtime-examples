//! ESP32-S3 application. Only `platform` and the C entry point use unsafe code.
mod analysis;
mod app;
mod console;
mod error;
mod metrics;
mod platform;
mod radio;
mod signaling;
mod station;

// SAFETY: unique symbol called exactly once by platform/entry.c on app_main's
// task. No arguments or Rust-owned values cross C ABI. Panics abort, never unwind.
#[unsafe(no_mangle)]
pub extern "C" fn radio_rust_main() {
    if let Err(error) = app::run() {
        app::recover(error);
    }
}
