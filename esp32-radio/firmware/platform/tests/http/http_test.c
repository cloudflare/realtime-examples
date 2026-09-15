#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_http_client.h"
#include "esp_heap_caps.h"
#include "radio_bridge.h"

#define RESPONSE_LIMIT 24576

struct fake_http_client {
    const esp_http_client_config_t *config;
    const char *body;
    int body_length;
    const char *content_type;
};

typedef struct {
    const uint8_t *bytes;
    size_t length;
} chunk;

static struct {
    chunk chunks[4];
    size_t count;
    int status;
    int perform_result;
    int set_url_result;
    int set_body_result;
    int release_body_result;
    int performs;
    int releases;
    int null_clears;
    int form_defaults;
    int closes;
    int cleanups;
    bool online;
    void *response_allocation;
    esp_http_client_handle_t client;
} fake;

static const uint8_t request[] = "{}";

void *heap_caps_malloc(size_t length, uint32_t capabilities)
{
    assert(length == RESPONSE_LIMIT);
    assert(capabilities == (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    fake.response_allocation = malloc(length);
    return fake.response_allocation;
}

esp_err_t esp_crt_bundle_attach(void *context)
{
    (void)context;
    return ESP_OK;
}

int32_t radio_network_ready(void)
{
    return fake.online;
}

esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t *config)
{
    assert(config->disable_auto_redirect);
    assert(config->crt_bundle_attach);
    esp_http_client_handle_t client = calloc(1, sizeof(*client));
    assert(client);
    client->config = config;
    fake.client = client;
    return client;
}

esp_err_t esp_http_client_set_method(esp_http_client_handle_t client, int method)
{
    assert(client && method == HTTP_METHOD_POST);
    return ESP_OK;
}

esp_err_t esp_http_client_set_header(esp_http_client_handle_t client, const char *name,
                                     const char *value)
{
    assert(client && name);
    if (strcmp(name, "Content-Type") == 0)
        client->content_type = value;
    else
        assert(value);
    return ESP_OK;
}

esp_err_t esp_http_client_set_url(esp_http_client_handle_t client, const char *url)
{
    assert(client && strstr(url, "/api/device/"));
    return fake.set_url_result;
}

esp_err_t esp_http_client_set_post_field(esp_http_client_handle_t client, const char *body,
                                         int length)
{
    /* Match ESP-IDF: the pointer is stored before header work can fail. NULL
     * also deletes Content-Type; a later body installs the form default. */
    client->body = body;
    client->body_length = length;
    if (!body) {
        assert(length == 0);
        client->content_type = NULL;
        fake.null_clears++;
        return ESP_OK;
    }
    if (!client->content_type) {
        client->content_type = "application/x-www-form-urlencoded";
        fake.form_defaults++;
    }
    if (length == 0) {
        fake.releases++;
        return fake.release_body_result;
    }
    if (fake.set_body_result)
        return fake.set_body_result;
    return ESP_OK;
}

esp_err_t esp_http_client_perform(esp_http_client_handle_t client)
{
    assert(client->body == (const char *)request);
    assert(client->body_length == sizeof(request) - 1);
    assert(strcmp(client->content_type, "application/json") == 0);
    fake.performs++;
    for (size_t i = 0; i < fake.count; i++) {
        esp_http_client_event_t event = {.user_data = client->config->user_data,
                                         .event_id = HTTP_EVENT_ON_DATA,
                                         .data_len = (int)fake.chunks[i].length,
                                         .data = (void *)fake.chunks[i].bytes};
        assert(client->config->event_handler(&event) == ESP_OK);
    }
    return fake.perform_result;
}

int esp_http_client_get_status_code(esp_http_client_handle_t client)
{
    assert(client);
    return fake.status;
}

esp_err_t esp_http_client_close(esp_http_client_handle_t client)
{
    assert(client->body);
    assert(client->body != (const char *)request);
    assert(client->body_length == 0);
    assert(strcmp(client->content_type, "application/json") == 0);
    fake.closes++;
    return ESP_OK;
}

esp_err_t esp_http_client_cleanup(esp_http_client_handle_t client)
{
    assert(client->body);
    assert(client->body != (const char *)request);
    assert(client->body_length == 0);
    assert(strcmp(client->content_type, "application/json") == 0);
    /* The retained configuration remains valid until cleanup completes. */
    assert(client->config->user_data);
    fake.cleanups++;
    free(client);
    return ESP_OK;
}

static void expect_failure(radio_http *http, const char *path, size_t request_length)
{
    uint8_t *large_request = NULL;
    if (request_length > sizeof(request) - 1) {
        large_request = calloc(request_length, 1);
        assert(large_request);
    }
    const uint8_t *response = (const uint8_t *)(uintptr_t)1;
    size_t used = SIZE_MAX;
    assert(radio_http_post(http, path, large_request ? large_request : request, request_length,
                           &response, &used) == -1);
    assert(response == NULL && used == 0);
    assert(fake.client->body);
    assert(fake.client->body != (const char *)request);
    assert(fake.client->body_length == 0);
    assert(strcmp(fake.client->content_type, "application/json") == 0);
    free(large_request);
}

static void expect_response(radio_http *http, int status, const uint8_t *bytes, size_t length)
{
    const uint8_t *response = NULL;
    size_t used = SIZE_MAX;
    int releases_before = fake.releases;
    assert(radio_http_post(http, "heartbeat", request, sizeof(request) - 1, &response, &used) ==
           status);
    assert(fake.releases == releases_before + 1);
    assert(fake.client->body);
    assert(fake.client->body != (const char *)request);
    assert(fake.client->body_length == 0);
    assert(strcmp(fake.client->content_type, "application/json") == 0);
    /* A successful response borrows the original allocation, without a copy. */
    assert(response == fake.response_allocation && used == length);
    if (length)
        assert(memcmp(response, bytes, length) == 0);
}

int main(void)
{
    fake.online = true;
    fake.status = 200;
    radio_http *http = radio_http_open();
    assert(http);

    static const uint8_t first[] = "{\"ok\":true}";
    fake.chunks[0] = (chunk){first, 3};
    fake.chunks[1] = (chunk){first + 3, sizeof(first) - 4};
    fake.count = 2;
    expect_response(http, 200, first, sizeof(first) - 1);

    /* A shorter next response must not expose the previous response's tail. */
    fake.chunks[0] = (chunk){request, sizeof(request) - 1};
    fake.count = 1;
    expect_response(http, 200, request, sizeof(request) - 1);
    fake.count = 0;
    fake.status = 204;
    expect_response(http, 204, NULL, 0);

    /* Error-status bodies are still complete HTTP responses for retry policy. */
    fake.status = 503;
    fake.count = 1;
    expect_response(http, 503, request, sizeof(request) - 1);
    fake.status = 200;

    uint8_t *large = malloc(RESPONSE_LIMIT + 1);
    assert(large);
    memset(large, 'x', RESPONSE_LIMIT + 1);
    fake.chunks[0] = (chunk){large, RESPONSE_LIMIT};
    expect_response(http, 200, large, RESPONSE_LIMIT);

    /* Overflow latches across chunks, including later chunks that would fit. */
    fake.chunks[0] = (chunk){large, RESPONSE_LIMIT - 1};
    fake.chunks[1] = (chunk){large, 2};
    fake.chunks[2] = (chunk){large, 1};
    fake.count = 3;
    int closed_before = fake.closes;
    expect_failure(http, "heartbeat", sizeof(request) - 1);
    assert(fake.closes == closed_before + 1);
    fake.chunks[0] = (chunk){large, RESPONSE_LIMIT + 1};
    fake.count = 1;
    expect_failure(http, "heartbeat", sizeof(request) - 1);

    /* A partial transport failure never lends its partial response. */
    fake.chunks[0] = (chunk){first, sizeof(first) - 1};
    fake.perform_result = -1;
    expect_failure(http, "heartbeat", sizeof(request) - 1);
    fake.perform_result = 0;
    expect_response(http, 200, first, sizeof(first) - 1);

    fake.set_url_result = -1;
    expect_failure(http, "heartbeat", sizeof(request) - 1);
    fake.set_url_result = 0;
    fake.set_body_result = -1;
    expect_failure(http, "heartbeat", sizeof(request) - 1);
    fake.set_body_result = 0;

    /* A failed release still replaces the borrowed Rust pointer before return. */
    fake.release_body_result = -1;
    expect_failure(http, "heartbeat", sizeof(request) - 1);
    fake.release_body_result = 0;
    expect_response(http, 200, first, sizeof(first) - 1);

    int performed_before = fake.performs;
    fake.online = false;
    expect_failure(http, "heartbeat", sizeof(request) - 1);
    fake.online = true;
    expect_failure(http, "heartbeat", 20001);
    char long_path[300];
    memset(long_path, 'a', sizeof(long_path) - 1);
    long_path[sizeof(long_path) - 1] = '\0';
    expect_failure(http, long_path, sizeof(request) - 1);
    assert(fake.performs == performed_before);
    expect_response(http, 200, first, sizeof(first) - 1);
    assert(fake.null_clears == 0);
    assert(fake.form_defaults == 0);

    radio_http_free(http);
    assert(fake.cleanups == 1);
    radio_http_free(NULL);
    free(large);
    puts("HTTP response borrowing, bounds, retry state and cleanup passed");
    return 0;
}
