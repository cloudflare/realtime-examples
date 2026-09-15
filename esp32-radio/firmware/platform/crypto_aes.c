#include <string.h>
#include "radio_bridge.h"
#include "esp_err.h"
#include "mbedtls/aes.h"
#include "mbedtls/gcm.h"
#include "mbedtls/platform_util.h"

static int valid_key(size_t length)
{
    return length == 16 || length == 32;
}

int32_t radio_crypto_aes_ctr(const uint8_t *key, size_t key_length, const uint8_t iv[16],
                             const uint8_t *input, size_t length, uint8_t *output, size_t capacity)
{
    if (!valid_key(key_length) || capacity < length)
        return ESP_ERR_INVALID_ARG;
    mbedtls_aes_context context;
    mbedtls_aes_init(&context);
    uint8_t counter[16], stream[16] = {0};
    size_t offset = 0;
    memcpy(counter, iv, sizeof(counter));
    int result = mbedtls_aes_setkey_enc(&context, key, key_length * 8);
    if (!result)
        result = mbedtls_aes_crypt_ctr(&context, length, &offset, counter, stream, input, output);
    mbedtls_aes_free(&context);
    mbedtls_platform_zeroize(stream, sizeof(stream));
    return result;
}

int32_t radio_crypto_aes_ecb(const uint8_t *key, size_t key_length, const uint8_t input[16],
                             uint8_t output[16])
{
    if (!valid_key(key_length))
        return ESP_ERR_INVALID_ARG;
    mbedtls_aes_context context;
    mbedtls_aes_init(&context);
    int result = mbedtls_aes_setkey_enc(&context, key, key_length * 8);
    if (!result)
        result = mbedtls_aes_crypt_ecb(&context, MBEDTLS_AES_ENCRYPT, input, output);
    mbedtls_aes_free(&context);
    return result;
}

int32_t radio_crypto_aes_gcm(int32_t decrypt, const uint8_t *key, size_t key_length,
                             const uint8_t iv[12], const uint8_t *aad, size_t aad_length,
                             const uint8_t *input, size_t length, uint8_t *output, size_t capacity)
{
    if (!valid_key(key_length) || (decrypt && length < 16))
        return ESP_ERR_INVALID_ARG;
    size_t clear_length = decrypt ? length - 16 : length;
    if (clear_length > 16384 || aad_length > 65536 || capacity < clear_length + (decrypt ? 0 : 16))
        return ESP_ERR_INVALID_SIZE;
    mbedtls_gcm_context context;
    mbedtls_gcm_init(&context);
    int result = mbedtls_gcm_setkey(&context, MBEDTLS_CIPHER_ID_AES, key, key_length * 8);
    if (!result && decrypt)
        result = mbedtls_gcm_auth_decrypt(&context, clear_length, iv, 12, aad, aad_length,
                                          input + clear_length, 16, input, output);
    else if (!result)
        result = mbedtls_gcm_crypt_and_tag(&context, MBEDTLS_GCM_ENCRYPT, clear_length, iv, 12, aad,
                                           aad_length, input, output, 16, output + clear_length);
    mbedtls_gcm_free(&context);
    if (result && decrypt)
        mbedtls_platform_zeroize(output, clear_length);
    return result;
}
