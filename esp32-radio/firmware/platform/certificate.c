#include <string.h>
#include <time.h>
#include "radio_bridge.h"
#include "esp_random.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/pk.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/x509_crt.h"

static int entropy(void *context, unsigned char *out, size_t length)
{
    (void)context;
    /* Wi-Fi is running before this call, enabling ESP-IDF's hardware entropy source. */
    esp_fill_random(out, length);
    return 0;
}

int32_t radio_certificate_generate(uint8_t *cert, size_t cert_capacity, size_t *cert_length,
                                   uint8_t *key, size_t key_capacity, size_t *key_length)
{
    if (!cert || !key || !cert_length || !key_length)
        return -1;
    *cert_length = *key_length = 0;
    time_t now = time(NULL), before = now - 60, after = now + 30 * 24 * 60 * 60;
    struct tm tm;
    char start[15], end[15];
    if (now < 1700000000 || !gmtime_r(&before, &tm) ||
        strftime(start, sizeof(start), "%Y%m%d%H%M%S", &tm) != 14 || !gmtime_r(&after, &tm) ||
        strftime(end, sizeof(end), "%Y%m%d%H%M%S", &tm) != 14)
        return -1;
    mbedtls_ctr_drbg_context rng;
    mbedtls_pk_context pk;
    mbedtls_x509write_cert crt;
    mbedtls_ctr_drbg_init(&rng);
    mbedtls_pk_init(&pk);
    mbedtls_x509write_crt_init(&crt);
    const unsigned char purpose[] = "pocket-radio-dtls";
    int result = mbedtls_ctr_drbg_seed(&rng, entropy, NULL, purpose, sizeof(purpose) - 1);
    if (result != 0)
        goto done;
    result = mbedtls_pk_setup(&pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY));
    if (result != 0)
        goto done;
    result = mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1, mbedtls_pk_ec(pk),
                                 mbedtls_ctr_drbg_random, &rng);
    if (result != 0)
        goto done;
    mbedtls_x509write_crt_set_version(&crt, MBEDTLS_X509_CRT_VERSION_3);
    mbedtls_x509write_crt_set_md_alg(&crt, MBEDTLS_MD_SHA256);
    mbedtls_x509write_crt_set_subject_key(&crt, &pk);
    mbedtls_x509write_crt_set_issuer_key(&crt, &pk);
    unsigned char serial[16];
    esp_fill_random(serial, sizeof(serial));
    serial[0] = (serial[0] & 0x7f) | 1;
    if ((result = mbedtls_x509write_crt_set_serial_raw(&crt, serial, sizeof(serial))) != 0 ||
        (result = mbedtls_x509write_crt_set_subject_name(&crt, "CN=Pocket Radio")) != 0 ||
        (result = mbedtls_x509write_crt_set_issuer_name(&crt, "CN=Pocket Radio")) != 0 ||
        (result = mbedtls_x509write_crt_set_validity(&crt, start, end)) != 0)
        goto done;
    result = mbedtls_x509write_crt_der(&crt, cert, cert_capacity, mbedtls_ctr_drbg_random, &rng);
    if (result < 0)
        goto done;
    *cert_length = (size_t)result;
    memmove(cert, cert + cert_capacity - *cert_length, *cert_length);
    result = mbedtls_pk_write_key_der(&pk, key, key_capacity);
    if (result < 0)
        goto done;
    *key_length = (size_t)result;
    memmove(key, key + key_capacity - *key_length, *key_length);
    mbedtls_platform_zeroize(key + *key_length, key_capacity - *key_length);
    result = 0;
done:
    mbedtls_x509write_crt_free(&crt);
    mbedtls_pk_free(&pk);
    mbedtls_ctr_drbg_free(&rng);
    if (result != 0) {
        mbedtls_platform_zeroize(key, key_capacity);
        *cert_length = *key_length = 0;
    }
    return result;
}
