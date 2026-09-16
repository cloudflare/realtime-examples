# HAL 0.46 compiles wrappers for these S3 drivers even when only its task API is used.
set(RUST_DRIVER_DEPS driver sdmmc esp_driver_gptimer esp_driver_i2c esp_driver_i2s
    esp_driver_ledc esp_driver_pcnt esp_driver_rmt esp_driver_sdmmc
    esp_driver_sdspi esp_driver_spi esp_driver_twai esp_driver_uart
    esp_driver_usb_serial_jtag)

idf_component_register(
    SRCS "../platform/entry.c" "../platform/board.c" "../platform/certificate.c"
        "../platform/http.c" "../platform/audio.c" "../platform/metrics.c"
        "../platform/crypto_aes.c" "../platform/crypto_hash.c" "../platform/crypto_ec.c"
    WHOLE_ARCHIVE
    INCLUDE_DIRS "../platform/include" "${CMAKE_BINARY_DIR}/private"
    PRIV_REQUIRES esp_psram esp_driver_gpio esp_wifi wpa_supplicant esp_netif esp_event
        esp_timer esp_system spi_flash esp_partition heap json mbedtls
        esp_http_client esp-tls esp_driver_tsens pthread vfs esp_vfs_console esp-dsp esp_audio_codec
        ${RUST_DRIVER_DEPS})

if(RADIO_CRYPTO_PROFILE)
    target_sources(${COMPONENT_LIB} PRIVATE "../platform/crypto_profile.c")
    target_link_options(${COMPONENT_LIB} INTERFACE
        "-Wl,--wrap=radio_crypto_hmac"
        "-Wl,--wrap=radio_crypto_aes_ctr"
        "-Wl,--wrap=radio_crypto_aes_gcm"
        "-Wl,--wrap=esp_mbedtls_mem_calloc")
endif()

set(RUST_TARGET "xtensa-esp32s3-espidf")
set(RUST_TARGET_DIR "${CMAKE_BINARY_DIR}/cargo")
set(RUST_ARCHIVE "${RUST_TARGET_DIR}/${RUST_TARGET}/release/libesp32_radio.a")
set(RUST_FEATURE_ARGS "")
if(RADIO_CRYPTO_SELF_TEST)
    list(APPEND RUST_FEATURE_ARGS --features crypto-self-test)
endif()
if(RADIO_CRYPTO_PROFILE)
    list(APPEND RUST_FEATURE_ARGS --features crypto-profile)
endif()
idf_build_get_property(radio_sdkconfig SDKCONFIG)
idf_build_get_property(radio_idf_path IDF_PATH)

# esp-idf-sys does not track CMake's SDK inputs in Cargo.
# Include their fingerprint in RUSTFLAGS so SDK changes regenerate bindings.
# The build helper verifies native checkouts against the pins in project.py.
set(radio_binding_files "${radio_sdkconfig}"
    "${CMAKE_CURRENT_LIST_DIR}/../CMakeLists.txt" "${CMAKE_CURRENT_LIST_FILE}"
    "${CMAKE_CURRENT_LIST_DIR}/idf_component.yml"
    "${CMAKE_CURRENT_LIST_DIR}/../dependencies.lock"
    "${CMAKE_CURRENT_LIST_DIR}/../../scripts/project.py")
get_target_property(radio_binding_includes ${COMPONENT_LIB} INCLUDE_DIRECTORIES)
get_target_property(radio_binding_components ${COMPONENT_LIB} LINK_LIBRARIES)
set(radio_binding_inputs
    "${radio_idf_path}|${radio_sdkconfig}|${CMAKE_BINARY_DIR}|${CMAKE_C_COMPILER}|${CMAKE_C_COMPILER_VERSION}|$ENV{LIBCLANG_PATH}|${radio_binding_includes}|${radio_binding_components}")
foreach(radio_binding_file IN LISTS radio_binding_files)
    get_filename_component(radio_binding_file "${radio_binding_file}" ABSOLUTE)
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${radio_binding_file}")
    file(SHA256 "${radio_binding_file}" radio_binding_file_hash)
    string(APPEND radio_binding_inputs "|${radio_binding_file}|${radio_binding_file_hash}")
endforeach()
string(SHA256 radio_binding_fingerprint "${radio_binding_inputs}")

add_custom_target(radio_rust_build
    COMMAND ${CMAKE_COMMAND} -E env
        "CARGO_CMAKE_BUILD_INCLUDES=$<TARGET_PROPERTY:${COMPONENT_LIB},INCLUDE_DIRECTORIES>"
        "CARGO_CMAKE_BUILD_LINK_LIBRARIES=$<TARGET_PROPERTY:${COMPONENT_LIB},LINK_LIBRARIES>"
        "CARGO_CMAKE_BUILD_SDKCONFIG=${radio_sdkconfig}"
        "CARGO_CMAKE_BUILD_ESP_IDF=${radio_idf_path}"
        "CARGO_CMAKE_BUILD_COMPILER=${CMAKE_C_COMPILER}"
        "CARGO_WORKSPACE_DIR=${CMAKE_CURRENT_LIST_DIR}/.."
        "RUSTFLAGS=--cfg espidf_time64 --cfg radio_idf_build_${radio_binding_fingerprint}"
        "CARGO_TARGET_DIR=${RUST_TARGET_DIR}"
        cargo +esp-radio build --manifest-path "${CMAKE_CURRENT_LIST_DIR}/../Cargo.toml"
            --package esp32-radio --release --locked --target ${RUST_TARGET}
            -Zbuild-std=std,panic_abort ${RUST_FEATURE_ARGS}
    BYPRODUCTS "${RUST_ARCHIVE}"
    WORKING_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}/.."
    VERBATIM USES_TERMINAL)
add_prebuilt_library(radio_rust "${RUST_ARCHIVE}" PRIV_REQUIRES pthread vfs)
add_dependencies(radio_rust radio_rust_build)
target_link_libraries(${COMPONENT_LIB} PRIVATE radio_rust)
