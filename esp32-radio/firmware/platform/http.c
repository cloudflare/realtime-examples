#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "radio_bridge.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "signaling_private.h"

#define RESPONSE_LIMIT 24576
static const char empty_post_body[] = "";

struct radio_http {
    esp_http_client_handle_t client;
    esp_http_client_config_t config;
    char *response;
    size_t used;
    bool overflow;
};

static esp_err_t on_http(esp_http_client_event_t *event)
{
    radio_http *h = event->user_data;
    if (event->event_id == HTTP_EVENT_ON_DATA && event->data_len > 0) {
        size_t length = event->data_len;
        if (length > RESPONSE_LIMIT - h->used)
            h->overflow = true;
        else if (!h->overflow) {
            memcpy(h->response + h->used, event->data, length);
            h->used += length;
        }
    }
    return ESP_OK;
}

radio_http *radio_http_open(void)
{
    radio_http *h = calloc(1, sizeof(*h));
    if (!h)
        return NULL;
    h->response = heap_caps_malloc(RESPONSE_LIMIT, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!h->response) {
        free(h);
        return NULL;
    }
    h->config = (esp_http_client_config_t){.url = SIGNALING_URL,
                                           .crt_bundle_attach = esp_crt_bundle_attach,
                                           .timeout_ms = 12000,
                                           .event_handler = on_http,
                                           .user_data = h,
                                           .buffer_size = 4096,
                                           .buffer_size_tx = 4096,
                                           .disable_auto_redirect = true,
                                           .keep_alive_enable = true};
    h->client = esp_http_client_init(&h->config);
    if (!h->client) {
        radio_http_free(h);
        return NULL;
    }
    int err = esp_http_client_set_method(h->client, HTTP_METHOD_POST);
    if (!err)
        err = esp_http_client_set_header(h->client, "Content-Type", "application/json");
    if (!err)
        err = esp_http_client_set_header(h->client, "Authorization",
                                         "Bearer " SIGNALING_DEVICE_TOKEN);
    if (!err)
        err = esp_http_client_set_header(h->client, "User-Agent", "PocketRadio-S3-Rust/1.0");
    if (err) {
        radio_http_free(h);
        return NULL;
    }
    return h;
}

int32_t radio_http_post(radio_http *h, const char *path, const uint8_t *body, size_t length,
                        const uint8_t **response, size_t *used)
{
    *response = NULL;
    *used = 0;
    h->used = 0;
    h->overflow = false;
    if (!radio_network_ready() || length > 20000)
        return -1;
    char url[256];
    int count = snprintf(url, sizeof(url), "%s/api/device/%s", SIGNALING_URL, path);
    if (count < 0 || (size_t)count >= sizeof(url))
        return -1;
    int err = esp_http_client_set_url(h->client, url);
    if (!err)
        err = esp_http_client_set_post_field(h->client, (const char *)body, length);
    if (!err)
        err = esp_http_client_perform(h->client);
    int status = esp_http_client_get_status_code(h->client);
    /* perform is blocking, so callbacks have finished. Replace the Rust borrow
     * with C-static storage; NULL would also remove Content-Type in ESP-IDF.
     * The pinned setter stores this pointer before a header lookup can fail. */
    int release_error = esp_http_client_set_post_field(h->client, empty_post_body, 0);
    if (!err)
        err = release_error;
    if (err || h->overflow) {
        esp_http_client_close(h->client);
        h->used = 0;
        return -1;
    }
    /* The caller borrows only these initialized bytes until the next post/free. */
    *response = (const uint8_t *)h->response;
    *used = h->used;
    return status;
}
void radio_http_free(radio_http *h)
{
    if (!h)
        return;
    if (h->client)
        esp_http_client_cleanup(h->client);
    free(h->response);
    free(h);
}
