#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include "radio_bridge.h"
#include "dsps_fft2r.h"
#include "esp_audio_dec.h"
#include "esp_opus_dec.h"
#include "esp_heap_caps.h"

#define FFT_SIZE 2048
#define PCM_SAMPLES (960 * 2)
_Static_assert(sizeof(float) == 4, "FFT ABI requires float32");

struct radio_dsp {
    void *decoder;
    esp_opus_dec_cfg_t config;
    float *fft;
    int16_t pcm[PCM_SAMPLES];
    uint8_t opus[1275];
};
/* ESP-DSP tables are process-global. Permit one owner, with no reinitialization
 * after Drop. There are no asynchronous decoder or FFT callbacks. */
static atomic_bool dsp_taken;

radio_dsp *radio_dsp_open(void)
{
    if (atomic_exchange(&dsp_taken, true))
        return NULL;
    radio_dsp *d = heap_caps_calloc(1, sizeof(*d), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!d)
        return NULL;
    d->fft = heap_caps_aligned_alloc(16, 2 * FFT_SIZE * sizeof(float),
                                     MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!d->fft) {
        free(d);
        return NULL;
    }
    memset(d->fft, 0, 2 * FFT_SIZE * sizeof(float));
    d->config = (esp_opus_dec_cfg_t){.sample_rate = 48000,
                                     .channel = 2,
                                     .frame_duration = ESP_OPUS_DEC_FRAME_DURATION_20_MS,
                                     .self_delimited = false};
    if (esp_opus_dec_open(&d->config, sizeof(d->config), &d->decoder) != ESP_AUDIO_ERR_OK) {
        free(d->fft);
        free(d);
        return NULL;
    }
    if (dsps_fft2r_init_fc32(NULL, FFT_SIZE) != ESP_OK) {
        radio_dsp_free(d);
        return NULL;
    }
    return d;
}
void radio_dsp_free(radio_dsp *d)
{
    if (!d)
        return;
    if (d->decoder)
        esp_opus_dec_close(d->decoder);
    dsps_fft2r_deinit_fc32();
    free(d->fft);
    free(d);
}
int32_t radio_dsp_reset(radio_dsp *d)
{
    return esp_opus_dec_reset(d->decoder);
}
int32_t radio_dsp_decode(radio_dsp *d, const uint8_t *opus, size_t length)
{
    if (!length || length > sizeof(d->opus))
        return -1;
    memcpy(d->opus, opus, length);
    esp_audio_dec_in_raw_t input = {.buffer = d->opus, .len = length};
    esp_audio_dec_out_frame_t output = {.buffer = (uint8_t *)d->pcm, .len = sizeof(d->pcm)};
    esp_audio_dec_info_t info = {0};
    int err = esp_opus_dec_decode(d->decoder, &input, &output, &info);
    if (err)
        return err;
    if (input.consumed != length || output.decoded_size != sizeof(d->pcm) ||
        info.sample_rate != 48000 || info.channel != 2 || info.bits_per_sample != 16)
        return -1;
    return 0;
}
const int16_t *radio_dsp_pcm(radio_dsp *d)
{
    return d->pcm;
}
float *radio_dsp_fft_buffer(radio_dsp *d)
{
    return d->fft;
}
int32_t radio_dsp_transform(radio_dsp *d)
{
    int err = dsps_fft2r_fc32(d->fft, FFT_SIZE);
    return err ? err : dsps_bit_rev_fc32(d->fft, FFT_SIZE);
}
float *radio_analysis_history_alloc(void)
{
    return heap_caps_calloc(2 * FFT_SIZE, sizeof(float), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}
void radio_analysis_history_free(float *history)
{
    free(history);
}
