cmake_minimum_required(VERSION 3.16)
set(EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/../.tools/vendor/esp-dsp"
    "${CMAKE_CURRENT_LIST_DIR}/../.tools/vendor/esp-adf-libs/esp_audio_codec")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(s3_radio)
