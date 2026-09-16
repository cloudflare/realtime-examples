/* Opt-in diagnostics. This file and its linker wraps are absent from normal builds. */
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "radio_bridge.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

typedef enum {
    HMAC_SHA1,
    HMAC_SHA256,
    HMAC_SHA384,
    AES_CTR,
    GCM_ENCRYPT,
    GCM_DECRYPT,
    OPERATION_COUNT,
    NO_OPERATION = OPERATION_COUNT,
} operation;

typedef struct {
    uint64_t calls;
    uint64_t failures;
    uint64_t elapsed_us;
    uint64_t allocation_calls;
    uint64_t allocation_failures;
    uint64_t requested_bytes;
} counters;

static portMUX_TYPE profile_lock = portMUX_INITIALIZER_UNLOCKED;
static struct {
    TaskHandle_t owner;
    operation active;
    bool enabled;
    int64_t started_us;
    counters totals[OPERATION_COUNT];
} profile;

/* All instrumentation state is fixed-size and contains no keys or payloads.
 * Only the owner task enters measured calls; the lock also excludes concurrent
 * allocation wrappers from unrelated SDK tasks. Never allocate or log here. */
static bool begin(operation op)
{
    if (xPortInIsrContext())
        return false;
    TaskHandle_t current = xTaskGetCurrentTaskHandle();
    portENTER_CRITICAL(&profile_lock);
    bool measured = profile.enabled && profile.owner == current && profile.active == NO_OPERATION &&
                    op < OPERATION_COUNT;
    if (measured)
        profile.active = op;
    portEXIT_CRITICAL(&profile_lock);
    return measured;
}

static void finish(operation op, int32_t result, int64_t started_us)
{
    uint64_t elapsed_us = esp_timer_get_time() - started_us;
    portENTER_CRITICAL(&profile_lock);
    counters *total = &profile.totals[op];
    total->calls++;
    total->failures += result != 0;
    total->elapsed_us += elapsed_us;
    profile.active = NO_OPERATION;
    portEXIT_CRITICAL(&profile_lock);
}

int32_t radio_crypto_profile_start(void)
{
    if (xPortInIsrContext())
        return -1;
    int64_t now = esp_timer_get_time();
    TaskHandle_t current = xTaskGetCurrentTaskHandle();
    portENTER_CRITICAL(&profile_lock);
    if (profile.enabled) {
        portEXIT_CRITICAL(&profile_lock);
        return -1;
    }
    memset(profile.totals, 0, sizeof(profile.totals));
    profile.owner = current;
    profile.active = NO_OPERATION;
    profile.started_us = now;
    profile.enabled = true;
    portEXIT_CRITICAL(&profile_lock);
    return 0;
}

int32_t radio_crypto_profile_finish(void)
{
    if (xPortInIsrContext())
        return -1;
    counters totals[OPERATION_COUNT];
    TaskHandle_t current = xTaskGetCurrentTaskHandle();
    int64_t now = esp_timer_get_time();
    portENTER_CRITICAL(&profile_lock);
    if (!profile.enabled || profile.owner != current || profile.active != NO_OPERATION) {
        portEXIT_CRITICAL(&profile_lock);
        return -1;
    }
    uint64_t elapsed_us = now - profile.started_us;
    memcpy(totals, profile.totals, sizeof(totals));
    profile.enabled = false;
    profile.owner = NULL;
    portEXIT_CRITICAL(&profile_lock);

    /* Format after releasing the lock, with profiling disabled. */
    char line[256];
    snprintf(line, sizeof(line), "Crypto profile: elapsed_us=%" PRIu64, elapsed_us);
    radio_log(line);
    static const char *const names[OPERATION_COUNT] = {"hmac-sha1", "hmac-sha256", "hmac-sha384",
                                                       "aes-ctr",   "gcm-encrypt", "gcm-decrypt"};
    for (size_t i = 0; i < OPERATION_COUNT; i++) {
        const counters *total = &totals[i];
        snprintf(line, sizeof(line),
                 "Crypto profile: op=%s calls=%" PRIu64 " failures=%" PRIu64 " us=%" PRIu64
                 " calloc=%" PRIu64 " calloc_failures=%" PRIu64 " requested_bytes=%" PRIu64,
                 names[i], total->calls, total->failures, total->elapsed_us,
                 total->allocation_calls, total->allocation_failures, total->requested_bytes);
        radio_log(line);
    }
    return 0;
}

void *__real_esp_mbedtls_mem_calloc(size_t count, size_t size);
void *__wrap_esp_mbedtls_mem_calloc(size_t count, size_t size)
{
    void *allocation = __real_esp_mbedtls_mem_calloc(count, size);
    if (xPortInIsrContext())
        return allocation;
    TaskHandle_t current = xTaskGetCurrentTaskHandle();
    portENTER_CRITICAL(&profile_lock);
    if (profile.enabled && profile.owner == current && profile.active < OPERATION_COUNT) {
        counters *total = &profile.totals[profile.active];
        total->allocation_calls++;
        total->allocation_failures += allocation == NULL;
        total->requested_bytes += (uint64_t)count * size;
    }
    portEXIT_CRITICAL(&profile_lock);
    return allocation;
}

int32_t __real_radio_crypto_hmac(int32_t bits, const uint8_t *key, size_t key_length,
                                 const radio_crypto_part *parts, size_t count, uint8_t *output,
                                 size_t capacity);
int32_t __wrap_radio_crypto_hmac(int32_t bits, const uint8_t *key, size_t key_length,
                                 const radio_crypto_part *parts, size_t count, uint8_t *output,
                                 size_t capacity)
{
    operation op = bits == 160   ? HMAC_SHA1
                   : bits == 256 ? HMAC_SHA256
                   : bits == 384 ? HMAC_SHA384
                                 : NO_OPERATION;
    bool measured = begin(op);
    int64_t started_us = measured ? esp_timer_get_time() : 0;
    int32_t result =
        __real_radio_crypto_hmac(bits, key, key_length, parts, count, output, capacity);
    if (measured)
        finish(op, result, started_us);
    return result;
}

int32_t __real_radio_crypto_aes_ctr(const uint8_t *key, size_t key_length, const uint8_t iv[16],
                                    const uint8_t *input, size_t length, uint8_t *output,
                                    size_t capacity);
int32_t __wrap_radio_crypto_aes_ctr(const uint8_t *key, size_t key_length, const uint8_t iv[16],
                                    const uint8_t *input, size_t length, uint8_t *output,
                                    size_t capacity)
{
    bool measured = begin(AES_CTR);
    int64_t started_us = measured ? esp_timer_get_time() : 0;
    int32_t result =
        __real_radio_crypto_aes_ctr(key, key_length, iv, input, length, output, capacity);
    if (measured)
        finish(AES_CTR, result, started_us);
    return result;
}

int32_t __real_radio_crypto_aes_gcm(int32_t decrypt, const uint8_t *key, size_t key_length,
                                    const uint8_t iv[12], const uint8_t *aad, size_t aad_length,
                                    const uint8_t *input, size_t length, uint8_t *output,
                                    size_t capacity);
int32_t __wrap_radio_crypto_aes_gcm(int32_t decrypt, const uint8_t *key, size_t key_length,
                                    const uint8_t iv[12], const uint8_t *aad, size_t aad_length,
                                    const uint8_t *input, size_t length, uint8_t *output,
                                    size_t capacity)
{
    operation op = decrypt ? GCM_DECRYPT : GCM_ENCRYPT;
    bool measured = begin(op);
    int64_t started_us = measured ? esp_timer_get_time() : 0;
    int32_t result = __real_radio_crypto_aes_gcm(decrypt, key, key_length, iv, aad, aad_length,
                                                 input, length, output, capacity);
    if (measured)
        finish(op, result, started_us);
    return result;
}
