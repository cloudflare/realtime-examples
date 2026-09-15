fn main() {
    // CMake owns linking; only relay HAL's SDK configuration to this crate.
    // Host checks have no ESP-IDF dependency metadata.
    if let Ok(cfg) = embuild::build::CfgArgs::try_from_env("ESP_IDF_HAL") {
        cfg.output();
    }
}
