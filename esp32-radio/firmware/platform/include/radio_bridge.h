#pragma once
#include <stddef.h>
#include <stdint.h>

/* Private ABI, implemented in C and imported only by esp32-radio::platform.
 * Call with valid pointer/length pairs; no Rust-layout or owned Rust values cross.
 * All input bytes are borrowed only for the call. Output storage is caller-owned
 * except for explicitly documented borrows from native handles.
 * HTTP handles stay on their creating task. See docs/ffi.md for lifetimes.
 */
int32_t radio_board_init(void);
int32_t radio_network_ready(void);
int32_t radio_clock_sync(void);
uint64_t radio_now_us(void);
uint32_t radio_random(void);
uint32_t radio_heap_free(void);
uint32_t radio_stack_free(void);
int32_t radio_led(uint8_t r, uint8_t g, uint8_t b);
int32_t radio_console_byte(void);
void radio_log(const char *message);
uint32_t radio_recovery_attempt(int32_t reset);
void radio_restart(void) __attribute__((noreturn));
/* Read-only partition access; output is borrowed for this synchronous copy only. */
size_t radio_music_size(void);
int32_t radio_music_read(size_t offset, uint8_t *out, size_t length);

/* Synchronous copies: four IPv4 octets and bounded DER certificate/key output.
 * Call certificate generation only after Wi-Fi and clock initialization. */
int32_t radio_ipv4(uint8_t octets[4]);
int32_t radio_certificate_generate(uint8_t *cert, size_t cert_capacity, size_t *cert_length,
                                   uint8_t *key, size_t key_capacity, size_t *key_length);

/* Crypto calls borrow all buffers synchronously and use ESP-IDF's peripheral locks.
 * GCM permits identical input/output buffers; failed authentication clears plaintext.
 * Hash state is a pointer-free value snapshot for the pinned S3 mbedTLS port. */
#define RADIO_CRYPTO_HASH_STATE_BYTES 256
typedef struct {
    const uint8_t *bytes;
    size_t length;
} radio_crypto_part;
int32_t radio_crypto_aes_ctr(const uint8_t *key, size_t key_length, const uint8_t iv[16],
                             const uint8_t *input, size_t length, uint8_t *output, size_t capacity);
int32_t radio_crypto_aes_ecb(const uint8_t *key, size_t key_length, const uint8_t input[16],
                             uint8_t output[16]);
int32_t radio_crypto_aes_gcm(int32_t decrypt, const uint8_t *key, size_t key_length,
                             const uint8_t iv[12], const uint8_t *aad, size_t aad_length,
                             const uint8_t *input, size_t length, uint8_t *output, size_t capacity);
int32_t radio_crypto_sha256(const uint8_t *input, size_t length, uint8_t output[32]);
int32_t radio_crypto_hmac(int32_t bits, const uint8_t *key, size_t key_length,
                          const radio_crypto_part *parts, size_t count, uint8_t *output,
                          size_t capacity);
int32_t radio_crypto_hash_init(uint8_t state[RADIO_CRYPTO_HASH_STATE_BYTES], int32_t bits);
int32_t radio_crypto_hash_update(uint8_t state[RADIO_CRYPTO_HASH_STATE_BYTES], const uint8_t *input,
                                 size_t length);
int32_t radio_crypto_hash_finish(const uint8_t state[RADIO_CRYPTO_HASH_STATE_BYTES],
                                 uint8_t *output, size_t capacity);
int32_t radio_crypto_verify_ec(const uint8_t *certificate, size_t certificate_length,
                               const uint8_t *data, size_t data_length, const uint8_t *signature,
                               size_t signature_length, int32_t hash_bits);
/* EC private material is borrowed or copied into caller-owned fixed buffers.
 * Wi-Fi must be started for hardware entropy. Native contexts never escape. */
int32_t radio_crypto_key_info(const uint8_t *der, size_t length, int32_t *bits);
int32_t radio_crypto_sign(const uint8_t *der, size_t key_length, const uint8_t *data,
                          size_t data_length, int32_t hash_bits, uint8_t *output, size_t capacity,
                          size_t *used);
int32_t radio_crypto_p256_keygen(uint8_t secret[32], uint8_t public_key[65]);
int32_t radio_crypto_p256_shared(const uint8_t secret[32], const uint8_t public_key[65],
                                 uint8_t shared[32]);

/* Diagnostic-image symbols only. Start/finish on the same task; finish logs
 * aggregate native counts/timing after leaving the lock. Return 0 on success. */
int32_t radio_crypto_profile_start(void);
int32_t radio_crypto_profile_finish(void);

/* Blocking HTTP callbacks write only C-owned storage. A successful post lends
 * exactly *used initialized response bytes until the next post/free on this
 * handle. Every transport failure returns NULL/0; end the borrow before
 * any mutation or cleanup. Response callbacks finish before the post returns;
 * cleanup callbacks complete before the client-owned storage is freed. */
typedef struct radio_http radio_http;
radio_http *radio_http_open(void);
int32_t radio_http_post(radio_http *http, const char *path, const uint8_t *body, size_t length,
                        const uint8_t **response, size_t *used);
void radio_http_free(radio_http *http);

/* Single-task audio analysis. FFT buffers are 4096 float32 values; PCM is
 * exactly 1920 int16 values. Native operations retain only C-owned storage. */
typedef struct radio_dsp radio_dsp;
/* Single-task temperature driver, no callbacks. Sample writes exactly 3 clocks
 * (boot/idle0/idle1 us), 6 memory values (free/minimum/largest, internal then PSRAM),
 * and 2 sensors (chip milli-Celsius/RSSI; INT32_MIN means unavailable).
 * No output pointer is retained. detailed refreshes slow heap diagnostics. */
typedef struct radio_metrics radio_metrics;
radio_metrics *radio_metrics_open(void);
int32_t radio_metrics_sample(radio_metrics *metrics, uint64_t clocks[3], uint32_t memory[6],
                             int32_t sensors[2], int32_t detailed);
void radio_metrics_free(radio_metrics *metrics);
int32_t radio_current_core(void);
radio_dsp *radio_dsp_open(void);
void radio_dsp_free(radio_dsp *dsp);
int32_t radio_dsp_reset(radio_dsp *dsp);
int32_t radio_dsp_decode(radio_dsp *dsp, const uint8_t *opus, size_t length);
const int16_t *radio_dsp_pcm(radio_dsp *dsp);
float *radio_dsp_fft_buffer(radio_dsp *dsp);
int32_t radio_dsp_transform(radio_dsp *dsp);
float *radio_analysis_history_alloc(void);
void radio_analysis_history_free(float *history);

/* Called exactly once by app_main. The Rust release profile aborts on panic. */
void radio_rust_main(void);
