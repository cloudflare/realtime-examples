#include <assert.h>
#include <stdlib.h>
#include "radio_bridge.h"

/* Separate object so the test exercises the same link-time wraps as the device. */
extern unsigned test_lock_depth;
extern int64_t test_now_us;
void test_allocate(size_t count, size_t size);
void test_crypto_allocations(int32_t bits);

void *esp_mbedtls_mem_calloc(size_t count, size_t size)
{
    assert(test_lock_depth == 0);
    return count == 99 ? NULL : calloc(count, size);
}

int32_t radio_crypto_hmac(int32_t bits, const uint8_t *key, size_t key_length,
                          const radio_crypto_part *parts, size_t count, uint8_t *output,
                          size_t capacity)
{
    assert(key && key_length == 16 && parts && count == 1);
    assert(parts[0].bytes && parts[0].length == 4 && output && capacity == 64);
    test_crypto_allocations(bits);
    test_now_us += 10;
    return bits == 384 ? -7 : 0;
}

int32_t radio_crypto_aes_ctr(const uint8_t *key, size_t key_length, const uint8_t iv[16],
                             const uint8_t *input, size_t length, uint8_t *output, size_t capacity)
{
    assert(key && key_length == 16 && iv && input && length == 4 && output && capacity == 64);
    test_allocate(1, 16);
    test_now_us += 20;
    return 0;
}

int32_t radio_crypto_aes_gcm(int32_t decrypt, const uint8_t *key, size_t key_length,
                             const uint8_t iv[12], const uint8_t *aad, size_t aad_length,
                             const uint8_t *input, size_t length, uint8_t *output, size_t capacity)
{
    assert(key && key_length == 16 && iv && aad && aad_length == 4);
    assert(input && length == 4 && output && capacity == 64);
    test_allocate(1, 20);
    test_now_us += 30;
    return decrypt ? -9 : 0;
}
