//! Hand-written declarations for our small private C ABI, not vendor layouts.
//! Keep signatures in sync with platform/include/radio_bridge.h.
use std::ffi::{c_char, c_void};

/// Private C pointer/length pair, borrowed only by one synchronous HMAC call.
#[repr(C)]
#[derive(Clone, Copy)]
pub(super) struct CryptoPart {
    pub bytes: *const u8,
    pub length: usize,
}

pub(super) const CRYPTO_HASH_STATE_BYTES: usize = 256;

unsafe extern "C" {
    pub(super) fn radio_crypto_key_info(der: *const u8, length: usize, bits: *mut i32) -> i32;
    pub(super) fn radio_crypto_sign(
        der: *const u8,
        key_length: usize,
        data: *const u8,
        data_length: usize,
        hash_bits: i32,
        output: *mut u8,
        capacity: usize,
        used: *mut usize,
    ) -> i32;
    pub(super) fn radio_crypto_p256_keygen(secret: *mut u8, public: *mut u8) -> i32;
    pub(super) fn radio_crypto_p256_shared(
        secret: *const u8,
        public: *const u8,
        shared: *mut u8,
    ) -> i32;
    #[cfg(feature = "crypto-profile")]
    pub(super) fn radio_crypto_profile_start() -> i32;
    #[cfg(feature = "crypto-profile")]
    pub(super) fn radio_crypto_profile_finish() -> i32;
    pub(super) fn radio_crypto_aes_ctr(
        key: *const u8,
        key_length: usize,
        iv: *const u8,
        input: *const u8,
        length: usize,
        output: *mut u8,
        capacity: usize,
    ) -> i32;
    pub(super) fn radio_crypto_aes_ecb(
        key: *const u8,
        key_length: usize,
        input: *const u8,
        output: *mut u8,
    ) -> i32;
    pub(super) fn radio_crypto_aes_gcm(
        decrypt: i32,
        key: *const u8,
        key_length: usize,
        iv: *const u8,
        aad: *const u8,
        aad_length: usize,
        input: *const u8,
        length: usize,
        output: *mut u8,
        capacity: usize,
    ) -> i32;
    pub(super) fn radio_crypto_sha256(input: *const u8, length: usize, output: *mut u8) -> i32;
    pub(super) fn radio_crypto_hmac(
        bits: i32,
        key: *const u8,
        key_length: usize,
        parts: *const CryptoPart,
        count: usize,
        output: *mut u8,
        capacity: usize,
    ) -> i32;
    pub(super) fn radio_crypto_hash_init(state: *mut u8, bits: i32) -> i32;
    pub(super) fn radio_crypto_hash_update(state: *mut u8, input: *const u8, length: usize) -> i32;
    pub(super) fn radio_crypto_hash_finish(
        state: *const u8,
        output: *mut u8,
        capacity: usize,
    ) -> i32;
    pub(super) fn radio_crypto_verify_ec(
        certificate: *const u8,
        certificate_length: usize,
        data: *const u8,
        data_length: usize,
        signature: *const u8,
        signature_length: usize,
        hash_bits: i32,
    ) -> i32;
    pub(super) fn radio_board_init() -> i32;
    pub(super) fn radio_clock_sync() -> i32;
    pub(super) fn radio_now_us() -> u64;
    pub(super) fn radio_random() -> u32;
    pub(super) fn radio_heap_free() -> u32;
    pub(super) fn radio_stack_free() -> u32;
    pub(super) fn radio_led(r: u8, g: u8, b: u8) -> i32;
    pub(super) fn radio_console_byte() -> i32;
    pub(super) fn radio_log(message: *const c_char);
    pub(super) fn radio_recovery_attempt(reset: i32) -> u32;
    pub(super) fn radio_restart() -> !;
    pub(super) fn radio_music_size() -> usize;
    pub(super) fn radio_music_read(offset: usize, out: *mut u8, length: usize) -> i32;
    pub(super) fn radio_ipv4(octets: *mut u8) -> i32;
    pub(super) fn radio_certificate_generate(
        cert: *mut u8,
        cert_capacity: usize,
        cert_length: *mut usize,
        key: *mut u8,
        key_capacity: usize,
        key_length: *mut usize,
    ) -> i32;
    pub(super) fn radio_http_open() -> *mut c_void;
    pub(super) fn radio_http_post(
        http: *mut c_void,
        path: *const c_char,
        body: *const u8,
        length: usize,
        response: *mut *const u8,
        used: *mut usize,
    ) -> i32;
    pub(super) fn radio_http_free(http: *mut c_void);
    pub(super) fn radio_metrics_open() -> *mut c_void;
    pub(super) fn radio_metrics_sample(
        metrics: *mut c_void,
        clocks: *mut u64,
        memory: *mut u32,
        sensors: *mut i32,
        detailed: i32,
    ) -> i32;
    pub(super) fn radio_metrics_free(metrics: *mut c_void);
    pub(super) fn radio_current_core() -> i32;
    pub(super) fn radio_dsp_open() -> *mut c_void;
    pub(super) fn radio_dsp_free(dsp: *mut c_void);
    pub(super) fn radio_dsp_reset(dsp: *mut c_void) -> i32;
    pub(super) fn radio_dsp_decode(dsp: *mut c_void, opus: *const u8, length: usize) -> i32;
    pub(super) fn radio_dsp_pcm(dsp: *mut c_void) -> *const i16;
    pub(super) fn radio_dsp_fft_buffer(dsp: *mut c_void) -> *mut f32;
    pub(super) fn radio_dsp_transform(dsp: *mut c_void) -> i32;
    pub(super) fn radio_analysis_history_alloc() -> *mut f32;
    pub(super) fn radio_analysis_history_free(history: *mut f32);
}
