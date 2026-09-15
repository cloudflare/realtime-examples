#pragma once
#include <stdbool.h>
#include <stddef.h>

/* Minimal SDK surface used to exercise the actual HTTP adapter on the host. */
typedef int esp_err_t;
#define ESP_OK 0
#define HTTP_METHOD_POST 1
#define HTTP_EVENT_ON_DATA 2

typedef struct {
    void *user_data;
    int event_id;
    int data_len;
    void *data;
} esp_http_client_event_t;

typedef struct {
    const char *url;
    esp_err_t (*crt_bundle_attach)(void *);
    int timeout_ms;
    esp_err_t (*event_handler)(esp_http_client_event_t *);
    void *user_data;
    int buffer_size;
    int buffer_size_tx;
    bool disable_auto_redirect;
    bool keep_alive_enable;
} esp_http_client_config_t;

typedef struct fake_http_client *esp_http_client_handle_t;
esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t *config);
esp_err_t esp_http_client_set_method(esp_http_client_handle_t client, int method);
esp_err_t esp_http_client_set_header(esp_http_client_handle_t client, const char *name,
                                     const char *value);
esp_err_t esp_http_client_set_url(esp_http_client_handle_t client, const char *url);
esp_err_t esp_http_client_set_post_field(esp_http_client_handle_t client, const char *body,
                                         int length);
esp_err_t esp_http_client_perform(esp_http_client_handle_t client);
int esp_http_client_get_status_code(esp_http_client_handle_t client);
esp_err_t esp_http_client_close(esp_http_client_handle_t client);
esp_err_t esp_http_client_cleanup(esp_http_client_handle_t client);
