use super::ffi;
use crate::error::{Error, Result, check};
use radio_webrtc::Certificate;
use std::net::Ipv4Addr;

pub(crate) fn certificate() -> Result<Certificate> {
    let mut cert = vec![0; 2048];
    let mut key = vec![0; 512];
    let mut cert_len = 0;
    let mut key_len = 0;
    // SAFETY: separate initialized writable buffers and lengths live for this
    // synchronous call. C bounds each output and retains no Rust pointers.
    let result = unsafe {
        ffi::radio_certificate_generate(
            cert.as_mut_ptr(),
            cert.len(),
            &mut cert_len,
            key.as_mut_ptr(),
            key.len(),
            &mut key_len,
        )
    };
    if result != 0 {
        key.fill(0);
    }
    check(result, "certificate generation failed")?;
    if cert_len > cert.len() || key_len > key.len() {
        key.fill(0);
        return Err(Error::new("invalid certificate output length"));
    }
    cert.truncate(cert_len);
    key.truncate(key_len);
    Ok(Certificate::from_der(cert, key)?)
}

pub(crate) fn ipv4() -> Result<Ipv4Addr> {
    let mut octets = [0; 4];
    check(
        // SAFETY: C writes exactly four octets and retains no pointer.
        unsafe { ffi::radio_ipv4(octets.as_mut_ptr()) },
        "Wi-Fi address unavailable",
    )?;
    Ok(Ipv4Addr::from(octets))
}
