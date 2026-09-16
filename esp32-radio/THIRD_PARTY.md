# Third-party components

First-party application code is covered by [MIT](LICENSE); see
[source attribution](UPSTREAM.md). The licenses below continue to govern their
respective components, including copied vendor code and test fixtures.

External checkouts are downloaded by setup into ignored `.tools/vendor/` and
the configured SDK directory. Their original licenses continue to apply; they
are not relicensed by the application.

| Component                      | Pinned version / revision                         | License and upstream                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESP-IDF                        | 5.5.3, `2c211b236707889e8400c4dc5644dd5c4ee071e0` | Primarily Apache-2.0; component notices in [Espressif's repository](https://github.com/espressif/esp-idf/tree/v5.5.3)                                                                         |
| esp-idf-hal | 0.46.2 | MIT OR Apache-2.0; [HAL](https://github.com/esp-rs/esp-idf-hal) |
| esp-idf-sys | 0.37.2 | MIT OR Apache-2.0; [SDK bindings](https://github.com/esp-rs/esp-idf-sys) |
| embuild | 0.33.5 | MIT OR Apache-2.0; [ESP Rust build support](https://github.com/esp-rs/embuild) |
| str0m | 0.23.1 | MIT option; [local source and patch](firmware/vendor/str0m/PATCH.md) |
| sctp-proto | 0.10.4 | MIT OR Apache-2.0; [local source and patch](firmware/vendor/sctp-proto/PATCH.md) |
| str0m-rust-crypto | 0.6.0 | MIT option; [local source and patch](firmware/vendor/str0m-rust-crypto/PATCH.md) |
| dimpl | 0.7.3 | MIT OR Apache-2.0; [algesten/dimpl](https://github.com/algesten/dimpl) |
| ESP-DSP                        | `3c8ac0fdfec83740b783e200862c8d0c056de0ad`        | Apache-2.0; [Espressif DSP library](https://github.com/espressif/esp-dsp)                                                                                                                     |
| esp_audio_codec                | 2.6.2, `da256e5f462a8e010667d35314a5ba5cdc4a8d9a` | Espressif Modified MIT; [audio codec component](https://github.com/espressif/esp-adf-libs/tree/master/esp_audio_codec)                                                                        |
| led_strip                      | 3.0.3                                             | Apache-2.0, resolved by the ESP-IDF component manager                                                                                                                                         |
| esp-rs Rust compiler           | 1.97.0.0                                          | Rust/LLVM licenses; [esp-rs/rust-build](https://github.com/esp-rs/rust-build/releases/tag/v1.97.0.0)                                                                                          |
| espup                          | 0.17.1                                            | MIT OR Apache-2.0; [esp-rs/espup](https://github.com/esp-rs/espup)                                                                                                                            |
| clang-format                   | 23.1.1                                            | Apache-2.0; [Python distribution of the LLVM formatter](https://github.com/ssciwr/clang-format-wheel)                                                                                         |
| serde / serde_json             | Cargo.lock                                        | MIT OR Apache-2.0; [serde-rs](https://github.com/serde-rs)                                                                                                                                    |
| crc32fast                      | 1.5.2                                             | MIT OR Apache-2.0; [srijs/rust-crc32fast](https://github.com/srijs/rust-crc32fast)                                                                                                            |

The web application uses React, Hono, Zod, Floating UI, Tailwind CSS, Vite,
Prettier, and Cloudflare's Vite plugin (MIT), TypeScript (Apache-2.0), and
Wrangler (MIT OR Apache-2.0). Their package metadata contains the original licenses.
The self-hosted IBM Plex fonts come from Fontsource's
[Sans](https://fontsource.org/fonts/ibm-plex-sans/install) and
[Mono](https://fontsource.org/fonts/ibm-plex-mono/install) packages (SIL Open Font
License 1.1). Vite bundles the font assets; copyright and license
notices are distributed in [worker/public/fonts/LICENSE.txt](worker/public/fonts/LICENSE.txt).

[scripts/project.py](scripts/project.py) pins external native sources and toolchains.
`firmware/dependencies.lock`, `firmware/Cargo.lock`, and `worker/package-lock.json`
record the managed component, Rust, and web dependency versions. The Cloudflare examples at
`cloudflare/realtime-examples` informed the signaling/data-channel flows; the
local reference checkout under `.tools/references/` is not required for building
this application.

The active flashing and monitoring helpers install pyserial 3.5 (BSD) and
esptool 5.4.0 (GPL-2.0-or-later) locally. Music preparation invokes FFmpeg and
ffprobe supplied by the developer's environment; their installed build's
licenses apply. Historical probes and their separate dependencies remain in
the [upstream repository](UPSTREAM.md) and are not needed by this blueprint.

Music inputs and generated packs stay private. Test fixtures contain Opus
silence, synthetic metadata, and spectrum bytes.
