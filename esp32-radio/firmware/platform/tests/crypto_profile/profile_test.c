#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "radio_bridge.h"
#include "freertos/task.h"

/* Synthetic native operations exercise wrappers without keys, SDK or hardware. */
unsigned test_lock_depth;
static TaskHandle_t current_task = (void *)(uintptr_t)1;
static bool in_isr;
static bool expect_active;
int64_t test_now_us;
static char lines[7][256];
static size_t line_count;

int xPortInIsrContext(void)
{
    return in_isr;
}

TaskHandle_t xTaskGetCurrentTaskHandle(void)
{
    return current_task;
}

int64_t esp_timer_get_time(void)
{
    assert(test_lock_depth == 0);
    return test_now_us;
}

void radio_log(const char *message)
{
    assert(test_lock_depth == 0);
    assert(line_count < sizeof(lines) / sizeof(lines[0]));
    assert(strlen(message) < sizeof(lines[0]));
    strcpy(lines[line_count++], message);
}

void *esp_mbedtls_mem_calloc(size_t count, size_t size);

void test_allocate(size_t count, size_t size)
{
    free(esp_mbedtls_mem_calloc(count, size));
}

void test_crypto_allocations(int32_t bits)
{
    assert(test_lock_depth == 0);
    if (expect_active)
        assert(radio_crypto_profile_finish() == -1);
    free(esp_mbedtls_mem_calloc(2, 16));
    free(esp_mbedtls_mem_calloc(2, 64));
    if (bits == 384)
        assert(esp_mbedtls_mem_calloc(99, 1) == NULL);
    /* Concurrent allocations from another task must not inherit this tag. */
    TaskHandle_t saved = current_task;
    current_task = (void *)(uintptr_t)2;
    free(esp_mbedtls_mem_calloc(3, 128));
    current_task = saved;
}

int main(void)
{
    const uint8_t key[16] = {0};
    const uint8_t iv[16] = {0};
    const uint8_t data[4] = {0};
    uint8_t output[64] = {0};
    const radio_crypto_part part = {data, sizeof(data)};

    /* Disabled wrappers retain their native return values and stay silent. */
    assert(radio_crypto_hmac(160, key, sizeof(key), &part, 1, output, sizeof(output)) == 0);
    assert(radio_crypto_profile_finish() == -1);
    assert(line_count == 0);

    assert(radio_crypto_profile_start() == 0);
    assert(radio_crypto_profile_start() == -1);
    current_task = (void *)(uintptr_t)2;
    assert(radio_crypto_profile_finish() == -1);
    assert(radio_crypto_hmac(160, key, sizeof(key), &part, 1, output, sizeof(output)) == 0);
    current_task = (void *)(uintptr_t)1;
    in_isr = true;
    assert(radio_crypto_profile_start() == -1);
    assert(radio_crypto_profile_finish() == -1);
    assert(radio_crypto_hmac(160, key, sizeof(key), &part, 1, output, sizeof(output)) == 0);
    in_isr = false;
    expect_active = true;
    assert(radio_crypto_hmac(160, key, sizeof(key), &part, 1, output, sizeof(output)) == 0);
    assert(radio_crypto_hmac(256, key, sizeof(key), &part, 1, output, sizeof(output)) == 0);
    assert(radio_crypto_hmac(384, key, sizeof(key), &part, 1, output, sizeof(output)) == -7);
    expect_active = false;
    assert(radio_crypto_aes_ctr(key, sizeof(key), iv, data, sizeof(data), output, sizeof(output)) ==
           0);
    assert(radio_crypto_aes_gcm(0, key, sizeof(key), iv, data, sizeof(data), data, sizeof(data),
                                output, sizeof(output)) == 0);
    assert(radio_crypto_aes_gcm(1, key, sizeof(key), iv, data, sizeof(data), data, sizeof(data),
                                output, sizeof(output)) == -9);
    /* Untagged mbedTLS work is deliberately outside the native crypto totals. */
    free(esp_mbedtls_mem_calloc(1, 999));
    assert(radio_crypto_profile_finish() == 0);
    assert(strcmp(lines[0], "Crypto profile: elapsed_us=130") == 0);
    assert(strcmp(lines[1], "Crypto profile: op=hmac-sha1 calls=1 failures=0 us=10 calloc=2 "
                            "calloc_failures=0 requested_bytes=160") == 0);
    assert(strcmp(lines[2], "Crypto profile: op=hmac-sha256 calls=1 failures=0 us=10 calloc=2 "
                            "calloc_failures=0 requested_bytes=160") == 0);
    assert(strcmp(lines[3], "Crypto profile: op=hmac-sha384 calls=1 failures=1 us=10 calloc=3 "
                            "calloc_failures=1 requested_bytes=259") == 0);
    assert(strcmp(lines[4], "Crypto profile: op=aes-ctr calls=1 failures=0 us=20 calloc=1 "
                            "calloc_failures=0 requested_bytes=16") == 0);
    assert(strcmp(lines[5], "Crypto profile: op=gcm-encrypt calls=1 failures=0 us=30 calloc=1 "
                            "calloc_failures=0 requested_bytes=20") == 0);
    assert(strcmp(lines[6], "Crypto profile: op=gcm-decrypt calls=1 failures=1 us=30 calloc=1 "
                            "calloc_failures=0 requested_bytes=20") == 0);
    assert(radio_crypto_profile_finish() == -1);
    assert(radio_crypto_hmac(160, key, sizeof(key), &part, 1, output, sizeof(output)) == 0);
    assert(line_count == 7);
    puts("Native crypto profile ownership, attribution and delegation passed");
    return 0;
}
