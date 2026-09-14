#include "radio_bridge.h"
#include "esp_err.h"
#include "esp_random.h"
#include "mbedtls/ecdh.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/md.h"
#include "mbedtls/pk.h"
#include "mbedtls/x509_crt.h"

static int curve_bits(const mbedtls_pk_context *key)
{
    if (!mbedtls_pk_can_do(key, MBEDTLS_PK_ECDSA))
        return 0;
    mbedtls_ecp_group_id id = mbedtls_pk_ec(*key)->MBEDTLS_PRIVATE(grp).id;
    if (id == MBEDTLS_ECP_DP_SECP256R1)
        return 256;
    if (id == MBEDTLS_ECP_DP_SECP384R1)
        return 384;
    return 0;
}

static int crypto_random(void *context, unsigned char *bytes, size_t length)
{
    (void)context;
    /* Board initialization starts Wi-Fi, enabling the hardware entropy source. */
    esp_fill_random(bytes, length);
    return 0;
}

static int load_key(mbedtls_pk_context *key, const uint8_t *der, size_t length)
{
    if (!length || length > 4096)
        return ESP_ERR_INVALID_SIZE;
    int result = mbedtls_pk_parse_key(key, der, length, NULL, 0, crypto_random, NULL);
    if (!result && !curve_bits(key))
        result = ESP_ERR_INVALID_ARG;
    if (!result) {
        mbedtls_ecp_keypair *ec = mbedtls_pk_ec(*key);
        result = mbedtls_ecp_check_privkey(&ec->MBEDTLS_PRIVATE(grp), &ec->MBEDTLS_PRIVATE(d));
    }
    return result;
}

int32_t radio_crypto_key_info(const uint8_t *der, size_t length, int32_t *bits)
{
    *bits = 0;
    mbedtls_pk_context key;
    mbedtls_pk_init(&key);
    int result = load_key(&key, der, length);
    if (!result)
        *bits = curve_bits(&key);
    mbedtls_pk_free(&key);
    return result;
}

int32_t radio_crypto_sign(const uint8_t *der, size_t key_length, const uint8_t *data,
                          size_t data_length, int32_t hash_bits, uint8_t *output, size_t capacity,
                          size_t *used)
{
    *used = 0;
    if (data_length > 65536 || (hash_bits != 256 && hash_bits != 384))
        return ESP_ERR_INVALID_SIZE;
    mbedtls_pk_context key;
    mbedtls_pk_init(&key);
    uint8_t hash[64] = {0};
    mbedtls_md_type_t type = hash_bits == 256 ? MBEDTLS_MD_SHA256 : MBEDTLS_MD_SHA384;
    int result = load_key(&key, der, key_length);
    if (!result)
        result = mbedtls_md(mbedtls_md_info_from_type(type), data, data_length, hash);
    if (!result)
        result = mbedtls_pk_sign(&key, type, hash, hash_bits / 8, output, capacity, used,
                                 crypto_random, NULL);
    mbedtls_pk_free(&key);
    if (result) {
        *used = 0;
        mbedtls_platform_zeroize(output, capacity);
    }
    mbedtls_platform_zeroize(hash, sizeof(hash));
    return result;
}

int32_t radio_crypto_p256_keygen(uint8_t secret[32], uint8_t public_key[65])
{
    mbedtls_ecp_keypair key;
    mbedtls_ecp_keypair_init(&key);
    int result = mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1, &key, crypto_random, NULL);
    size_t used = 0;
    if (!result)
        result = mbedtls_mpi_write_binary(&key.MBEDTLS_PRIVATE(d), secret, 32);
    if (!result)
        result = mbedtls_ecp_point_write_binary(&key.MBEDTLS_PRIVATE(grp), &key.MBEDTLS_PRIVATE(Q),
                                                MBEDTLS_ECP_PF_UNCOMPRESSED, &used, public_key, 65);
    if (!result && used != 65)
        result = ESP_ERR_INVALID_SIZE;
    mbedtls_ecp_keypair_free(&key);
    if (result) {
        mbedtls_platform_zeroize(secret, 32);
        mbedtls_platform_zeroize(public_key, 65);
    }
    return result;
}

int32_t radio_crypto_p256_shared(const uint8_t secret[32], const uint8_t public_key[65],
                                 uint8_t shared[32])
{
    mbedtls_ecp_group group;
    mbedtls_ecp_point peer;
    mbedtls_mpi scalar, value;
    mbedtls_ecp_group_init(&group);
    mbedtls_ecp_point_init(&peer);
    mbedtls_mpi_init(&scalar);
    mbedtls_mpi_init(&value);
    int result = mbedtls_ecp_group_load(&group, MBEDTLS_ECP_DP_SECP256R1);
    if (!result)
        result = mbedtls_mpi_read_binary(&scalar, secret, 32);
    if (!result)
        result = mbedtls_ecp_check_privkey(&group, &scalar);
    if (!result)
        result = mbedtls_ecp_point_read_binary(&group, &peer, public_key, 65);
    if (!result)
        result = mbedtls_ecp_check_pubkey(&group, &peer);
    if (!result)
        result = mbedtls_ecdh_compute_shared(&group, &value, &peer, &scalar, crypto_random, NULL);
    if (!result)
        result = mbedtls_mpi_write_binary(&value, shared, 32);
    mbedtls_mpi_free(&value);
    mbedtls_mpi_free(&scalar);
    mbedtls_ecp_point_free(&peer);
    mbedtls_ecp_group_free(&group);
    if (result)
        mbedtls_platform_zeroize(shared, 32);
    return result;
}

int32_t radio_crypto_verify_ec(const uint8_t *certificate, size_t certificate_length,
                               const uint8_t *data, size_t data_length, const uint8_t *signature,
                               size_t signature_length, int32_t hash_bits)
{
    if (certificate_length > 65536 || data_length > 65536 || signature_length > 128 ||
        (hash_bits != 256 && hash_bits != 384))
        return ESP_ERR_INVALID_SIZE;
    mbedtls_x509_crt parsed;
    mbedtls_x509_crt_init(&parsed);
    uint8_t hash[64] = {0};
    mbedtls_md_type_t type = hash_bits == 256 ? MBEDTLS_MD_SHA256 : MBEDTLS_MD_SHA384;
    int result = mbedtls_x509_crt_parse_der(&parsed, certificate, certificate_length);
    if (!result && !curve_bits(&parsed.pk))
        result = ESP_ERR_INVALID_ARG;
    if (!result)
        result = mbedtls_md(mbedtls_md_info_from_type(type), data, data_length, hash);
    if (!result)
        result =
            mbedtls_pk_verify(&parsed.pk, type, hash, hash_bits / 8, signature, signature_length);
    mbedtls_x509_crt_free(&parsed);
    return result;
}
