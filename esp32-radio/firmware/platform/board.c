#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "radio_bridge.h"
#include "esp_attr.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_partition.h"
#include "esp_psram.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "led_strip.h"
#include "wifi_private.h"

static EventGroupHandle_t wifi_events;
static led_strip_handle_t led;
static RTC_DATA_ATTR uint32_t recovery_attempt;
static portMUX_TYPE recovery_lock = portMUX_INITIALIZER_UNLOCKED;

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP)
        xEventGroupSetBits(wifi_events, BIT0);
    else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(wifi_events, BIT0);
        esp_wifi_connect();
    }
}

int32_t radio_board_init(void)
{
    esp_log_level_set("wifi", ESP_LOG_WARN);
    led_strip_config_t strip = {.strip_gpio_num = 38, .max_leds = 1};
    led_strip_rmt_config_t rmt = {.resolution_hz = 10000000};
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip, &rmt, &led));
    radio_led(8, 4, 0);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    if (!esp_netif_create_default_wifi_sta())
        return -1;
    wifi_events = xEventGroupCreate();
    if (!wifi_events)
        return -1;
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    init.nvs_enable = 0;
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));
    wifi_config_t config = {0};
    memcpy(config.sta.ssid, WIFI_SSID, sizeof(WIFI_SSID) - 1);
    memcpy(config.sta.password, WIFI_PASSWORD, sizeof(WIFI_PASSWORD) - 1);
    config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    config.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &config));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_ERROR_CHECK(esp_wifi_connect());
    if (!(xEventGroupWaitBits(wifi_events, BIT0, false, false, pdMS_TO_TICKS(60000)) & BIT0))
        return -1;
    radio_led(0, 12, 4);
    printf("PROBE "
           "{\"event\":\"hardware_ready\",\"firmware\":\"rust\",\"wifi\":true,\"psram_bytes\":%u,"
           "\"internal_free\":%u}\n",
           (unsigned)esp_psram_get_size(), (unsigned)radio_heap_free());
    return 0;
}

int32_t radio_network_ready(void)
{
    return wifi_events && (xEventGroupGetBits(wifi_events) & BIT0);
}

int32_t radio_ipv4(uint8_t octets[4])
{
    esp_netif_ip_info_t info;
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (!netif || !radio_network_ready() || esp_netif_get_ip_info(netif, &info) != ESP_OK)
        return -1;
    memcpy(octets, &info.ip.addr, 4);
    return 0;
}

int32_t radio_clock_sync(void)
{
    static bool initialized;
    if (!initialized) {
        esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG_MULTIPLE(
            2, ESP_SNTP_SERVER_LIST("time.cloudflare.com", "pool.ntp.org"));
        if (esp_netif_sntp_init(&config) != ESP_OK)
            return -1;
        initialized = true;
    }
    if (time(NULL) < 1700000000)
        esp_netif_sntp_sync_wait(pdMS_TO_TICKS(20000));
    return time(NULL) >= 1700000000;
}

uint64_t radio_now_us(void)
{
    return esp_timer_get_time();
}
uint32_t radio_random(void)
{
    return esp_random();
}
uint32_t radio_heap_free(void)
{
    return heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}
uint32_t radio_stack_free(void)
{
    return uxTaskGetStackHighWaterMark(NULL);
}
int32_t radio_current_core(void)
{
    return xPortGetCoreID();
}
int32_t radio_led(uint8_t r, uint8_t g, uint8_t b)
{
    int err = led_strip_set_pixel(led, 0, r, g, b);
    return err ? err : led_strip_refresh(led);
}
int32_t radio_console_byte(void)
{
    int ch = getchar();
    if (ch == EOF)
        clearerr(stdin);
    return ch;
}
void radio_log(const char *message)
{
    ESP_LOGI("signaling", "%s", message);
}
uint32_t radio_recovery_attempt(int32_t reset)
{
    portENTER_CRITICAL(&recovery_lock);
    uint32_t previous = recovery_attempt;
    if (reset)
        recovery_attempt = 0;
    else if (recovery_attempt < 3)
        recovery_attempt++;
    portEXIT_CRITICAL(&recovery_lock);
    return previous;
}
void radio_restart(void)
{
    esp_restart();
    abort();
}

size_t radio_music_size(void)
{
    const esp_partition_t *part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, "music");
    return part && part->size <= 16 * 1024 * 1024 ? part->size : 0;
}
int32_t radio_music_read(size_t offset, uint8_t *out, size_t length)
{
    const esp_partition_t *part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, "music");
    if (!part || !out || offset > part->size || length > part->size - offset)
        return ESP_ERR_INVALID_ARG;
    return esp_partition_read(part, offset, out, length);
}
