//! Blocking certificate-verified HTTPS, owned exclusively by signaling.
use super::ffi;
use crate::error::{Error, Result};
use std::{
    ffi::{CStr, c_void},
    marker::PhantomData,
    ptr::{self, NonNull},
    rc::Rc,
    sync::atomic::{AtomicBool, Ordering},
};

static HTTP_TAKEN: AtomicBool = AtomicBool::new(false);
const RESPONSE_LIMIT: usize = 24_576;

#[derive(Debug)]
pub(crate) struct Http {
    handle: NonNull<c_void>,
    _task: PhantomData<Rc<()>>,
}

impl Http {
    pub(crate) fn open() -> Result<Self> {
        if HTTP_TAKEN.swap(true, Ordering::AcqRel) {
            return Err(Error::new("HTTP task already initialized"));
        }
        // SAFETY: C returns a fresh client owning all callback buffers. It uses
        // compiled credentials internally; no secret enters Rust diagnostics.
        let handle = NonNull::new(unsafe { ffi::radio_http_open() })
            .ok_or(Error::new("HTTPS initialization failed"))?;
        Ok(Self {
            handle,
            _task: PhantomData,
        })
    }
    /// The response borrows this client, excluding another post or its cleanup.
    pub(crate) fn post(&mut self, path: &CStr, body: &[u8]) -> Result<(i32, &[u8])> {
        let mut response = ptr::null();
        let mut used = 0;
        // SAFETY: all arguments are live for this blocking call, and &mut self
        // excludes prior response borrows. C replaces the borrowed POST field with
        // static storage before return; response callbacks have finished writing.
        let status = unsafe {
            ffi::radio_http_post(
                self.handle.as_ptr(),
                path.as_ptr(),
                body.as_ptr(),
                body.len(),
                &mut response,
                &mut used,
            )
        };
        if used > RESPONSE_LIMIT || (used > 0 && response.is_null()) {
            return Err(Error::new("invalid HTTPS response length"));
        }
        let bytes = if used == 0 {
            &[]
        } else {
            // SAFETY: C returns exactly `used` initialized bytes from this
            // client's live allocation, bounded above. The returned borrow is
            // tied to &mut self, so neither another post nor Drop can mutate or
            // free it. Http cannot cross tasks; C has no asynchronous callback.
            unsafe { std::slice::from_raw_parts(response, used) }
        };
        Ok((status, bytes))
    }
}
impl Drop for Http {
    fn drop(&mut self) {
        // SAFETY: all blocking calls/callbacks have returned; same task and sole
        // owner. C cleans up the client before freeing its callback context.
        unsafe { ffi::radio_http_free(self.handle.as_ptr()) };
    }
}
