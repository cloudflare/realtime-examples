#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "radio_bridge.h"
#include "driver/temperature_sensor.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"

#if !configGENERATE_RUN_TIME_STATS
#error "Reapply sdkconfig.defaults to enable the metrics runtime counters"
#endif
_Static_assert(sizeof(configRUN_TIME_COUNTER_TYPE) == 8, "Metrics require U64 runtime counters");

struct radio_metrics {
    temperature_sensor_handle_t temperature;
    uint32_t memory[6];
};

radio_metrics *radio_metrics_open(void)
{
    radio_metrics *m = calloc(1, sizeof(*m));
    if (!m)
        return NULL;
    temperature_sensor_config_t config = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
    if (temperature_sensor_install(&config, &m->temperature) != ESP_OK)
        m->temperature = NULL;
    if (m->temperature && temperature_sensor_enable(m->temperature) != ESP_OK) {
        temperature_sensor_uninstall(m->temperature);
        m->temperature = NULL;
    }
    return m;
}

int32_t radio_metrics_sample(radio_metrics *m, uint64_t clocks[3], uint32_t memory[6],
                             int32_t sensors[2], int32_t detailed)
{
    if (!m || !clocks || !memory || !sensors)
        return ESP_ERR_INVALID_ARG;
    clocks[0] = esp_timer_get_time();
    clocks[1] = ulTaskGetIdleRunTimeCounterForCore(0);
    clocks[2] = ulTaskGetIdleRunTimeCounterForCore(1);
    const uint32_t caps[2] = {MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT,
                              MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT};
    for (int pool = 0; pool < 2; pool++) {
        m->memory[pool * 3] = heap_caps_get_free_size(caps[pool]);
        if (detailed) {
            m->memory[pool * 3 + 1] = heap_caps_get_minimum_free_size(caps[pool]);
            m->memory[pool * 3 + 2] = heap_caps_get_largest_free_block(caps[pool]);
        }
    }
    memcpy(memory, m->memory, sizeof(m->memory));
    sensors[0] = sensors[1] = INT32_MIN;
    float celsius;
    if (m->temperature && temperature_sensor_get_celsius(m->temperature, &celsius) == ESP_OK &&
        isfinite(celsius) && celsius >= -10 && celsius <= 80) {
        sensors[0] = (int32_t)lroundf(celsius * 1000);
    }
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK)
        sensors[1] = ap.rssi;
    return ESP_OK;
}

void radio_metrics_free(radio_metrics *m)
{
    if (!m)
        return;
    if (m->temperature) {
        temperature_sensor_disable(m->temperature);
        temperature_sensor_uninstall(m->temperature);
    }
    free(m);
}
