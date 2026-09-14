use super::ffi;
use crate::error::{Error, Result, check};
use radio_core::metrics::Memory;
use std::{ffi::c_void, marker::PhantomData, ptr::NonNull, rc::Rc};

pub(crate) struct Sample {
    pub now_us: u64,
    pub idle_us: [u64; 2],
    pub temperature_mc: Option<i32>,
    pub rssi: Option<i32>,
    pub internal: Memory,
    pub psram: Memory,
}

/// Single-task sensor owner that keeps temperature conversion on core 1.
pub(crate) struct Metrics {
    handle: NonNull<c_void>,
    _task: PhantomData<Rc<()>>,
}

impl Metrics {
    pub(crate) fn open() -> Result<Self> {
        // SAFETY: scalar query of this task before any sensor floating-point work.
        if unsafe { ffi::radio_current_core() } != 1 {
            return Err(Error::new("metrics must run on core 1"));
        }
        // SAFETY: C owns the driver and context. It borrows no Rust memory and
        // registers no callbacks; a missing temperature sensor remains optional.
        let handle = NonNull::new(unsafe { ffi::radio_metrics_open() })
            .ok_or(Error::new("metrics initialization failed"))?;
        Ok(Self {
            handle,
            _task: PhantomData,
        })
    }

    pub(crate) fn sample(&mut self, detailed: bool) -> Result<Sample> {
        let mut clocks = [0; 3];
        let mut memory = [0; 6];
        let mut sensors = [i32::MIN; 2];
        // SAFETY: live same-task handle and initialized output arrays of exactly
        // the ABI's 3/6/2 elements. C writes synchronously and retains no pointers.
        let status = unsafe {
            ffi::radio_metrics_sample(
                self.handle.as_ptr(),
                clocks.as_mut_ptr(),
                memory.as_mut_ptr(),
                sensors.as_mut_ptr(),
                i32::from(detailed),
            )
        };
        check(status, "metrics sampling failed")?;
        let pool = |offset| Memory {
            free: memory[offset],
            minimum_free: memory[offset + 1],
            largest_block: memory[offset + 2],
        };
        Ok(Sample {
            now_us: clocks[0],
            idle_us: [clocks[1], clocks[2]],
            temperature_mc: (sensors[0] != i32::MIN).then_some(sensors[0]),
            rssi: (sensors[1] != i32::MIN).then_some(sensors[1]),
            internal: pool(0),
            psram: pool(3),
        })
    }
}

impl Drop for Metrics {
    fn drop(&mut self) {
        // SAFETY: sole task-affine owner; native sensor APIs have no callbacks.
        unsafe { ffi::radio_metrics_free(self.handle.as_ptr()) };
    }
}
