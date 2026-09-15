#include <string.h>
#include "radio_bridge.h"
#include "esp_err.h"
#include "sdkconfig.h"
#include "mbedtls/md.h"
#include "mbedtls/sha256.h"
#include "mbedtls/sha512.h"
#include "mbedtls/platform_util.h"

#if !CONFIG_IDF_TARGET_ESP32S3
#error "Review the SHA context lifetime and hardware locking before porting this adapter"
#endif

/* The pinned S3 SHA contexts contain only counters, digest words, a partial
 * block, and scalar mode flags. Hardware locks are released after each update.
 * No native pointer, allocation, or retained peripheral ownership crosses calls.
 * Review sha256_alt.h/sha512_alt.h and the port implementations on SDK upgrades. */
typedef struct {
    int32_t bits;
    union {
        mbedtls_sha256_context sha256;
        mbedtls_sha512_context sha512;
    } context;
} hash_state;
_Static_assert(sizeof(hash_state) <= RADIO_CRYPTO_HASH_STATE_BYTES, "SHA state ABI capacity");

int32_t radio_crypto_sha256(const uint8_t *input, size_t length, uint8_t output[32])
{
    return mbedtls_sha256(input, length, output, 0);
}

int32_t radio_crypto_hmac(int32_t bits, const uint8_t *key, size_t key_length,
                          const radio_crypto_part *parts, size_t count, uint8_t *output,
                          size_t capacity)
{
    mbedtls_md_type_t type;
    switch (bits) {
    case 160:
        type = MBEDTLS_MD_SHA1;
        break;
    case 256:
        type = MBEDTLS_MD_SHA256;
        break;
    case 384:
        type = MBEDTLS_MD_SHA384;
        break;
    default:
        return ESP_ERR_INVALID_ARG;
    }
    if (count > 8 || capacity < (size_t)bits / 8)
        return ESP_ERR_INVALID_SIZE;
    mbedtls_md_context_t context;
    mbedtls_md_init(&context);
    int result = mbedtls_md_setup(&context, mbedtls_md_info_from_type(type), 1);
    if (!result)
        result = mbedtls_md_hmac_starts(&context, key, key_length);
    for (size_t i = 0; !result && i < count; i++)
        result = mbedtls_md_hmac_update(&context, parts[i].bytes, parts[i].length);
    if (!result)
        result = mbedtls_md_hmac_finish(&context, output);
    mbedtls_md_free(&context);
    return result;
}

int32_t radio_crypto_hash_init(uint8_t out[RADIO_CRYPTO_HASH_STATE_BYTES], int32_t bits)
{
    if (bits != 256 && bits != 384)
        return ESP_ERR_INVALID_ARG;
    hash_state state;
    memset(&state, 0, sizeof(state));
    state.bits = bits;
    int result;
    if (bits == 256) {
        mbedtls_sha256_init(&state.context.sha256);
        result = mbedtls_sha256_starts(&state.context.sha256, 0);
    } else {
        mbedtls_sha512_init(&state.context.sha512);
        result = mbedtls_sha512_starts(&state.context.sha512, 1);
    }
    memset(out, 0, RADIO_CRYPTO_HASH_STATE_BYTES);
    if (!result)
        memcpy(out, &state, sizeof(state));
    mbedtls_platform_zeroize(&state, sizeof(state));
    return result;
}

int32_t radio_crypto_hash_update(uint8_t bytes[RADIO_CRYPTO_HASH_STATE_BYTES], const uint8_t *input,
                                 size_t length)
{
    hash_state state;
    memcpy(&state, bytes, sizeof(state));
    int result = ESP_ERR_INVALID_ARG;
    if (state.bits == 256)
        result = mbedtls_sha256_update(&state.context.sha256, input, length);
    else if (state.bits == 384)
        result = mbedtls_sha512_update(&state.context.sha512, input, length);
    if (!result)
        memcpy(bytes, &state, sizeof(state));
    mbedtls_platform_zeroize(&state, sizeof(state));
    return result;
}

int32_t radio_crypto_hash_finish(const uint8_t bytes[RADIO_CRYPTO_HASH_STATE_BYTES],
                                 uint8_t *output, size_t capacity)
{
    hash_state state;
    memcpy(&state, bytes, sizeof(state));
    uint8_t digest[64] = {0};
    int result = ESP_ERR_INVALID_ARG;
    if (state.bits == 256 && capacity >= 32)
        result = mbedtls_sha256_finish(&state.context.sha256, digest);
    else if (state.bits == 384 && capacity >= 48)
        result = mbedtls_sha512_finish(&state.context.sha512, digest);
    if (!result)
        memcpy(output, digest, state.bits / 8);
    mbedtls_platform_zeroize(digest, sizeof(digest));
    mbedtls_platform_zeroize(&state, sizeof(state));
    return result;
}
