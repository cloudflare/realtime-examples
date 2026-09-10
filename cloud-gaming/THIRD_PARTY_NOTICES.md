# Third-Party Notices

This repository distributes a Dockerfile and first-party publisher source. It
does not distribute a prebuilt OCI image. Each deployer builds a private image
in their own account.

Versions below are the versions locked or resolved for the Ubuntu 24.04
linux/amd64 build on September 8, 2026. `publisher/Cargo.lock` is authoritative
for the complete Rust dependency graph. Ubuntu package copyright files in
`/usr/share/doc/*/copyright` are authoritative for the built image and are not
removed by the Dockerfile.

## Base image and runtime application

The Dockerfile pins the Ubuntu 24.04 OCI index digest
`sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517`.
It copies Rust `1.89.0` from the official Rust image pinned at
`sha256:d7fc7de78bb8c1469933aeecbf801314d30d7d6e9f0578bba4cfa285bfa37fe6`.
Ubuntu package source and license information is available from:

- Ubuntu base image: https://hub.docker.com/_/ubuntu
- Rust toolchain image: https://hub.docker.com/_/rust
- Ubuntu package source: https://packages.ubuntu.com/noble/
- Ubuntu source packages: https://launchpad.net/ubuntu/noble/+packages

| Direct runtime package | Version used | Purpose | Source and license |
| --- | --- | --- | --- |
| `crispy-doom` | `6.0-2build2` | Software-rendered Doom engine | https://github.com/fabiangreffrath/crispy-doom, GPL-2.0-or-later |
| `freedoom` | `0.13.0-1` | Freedoom Phase 2 IWAD and supporting data | https://github.com/freedoom/freedoom, primarily BSD-3-Clause; the Ubuntu copyright file also records CC0-1.0, MIT, and GPL-2.0-or-later components |
| `libavcodec60`, `libavformat60`, `libavutil58`, `libswscale7` | `6.1.1-3ubuntu5` | H.264 and Opus encoding plus BGR0-to-YUV420P scaling | https://ffmpeg.org/, LGPL-2.1-or-later and GPL-2.0-or-later components; Ubuntu's build is GPL-enabled |
| `libx264-164` | `0.164.3108+git31e19f9-1` | H.264 encoder used through libavcodec | https://code.videolan.org/videolan/x264, GPL-2.0 |
| `libopus0` | `1.4-1build1` | Opus encoder used through libavcodec | https://opus-codec.org/, BSD-3-Clause |
| `pulseaudio` | `16.1+dfsg1-2ubuntu10.1` | Private null sink and application-audio capture | https://gitlab.freedesktop.org/pulseaudio/pulseaudio, LGPL-2.1-or-later for client libraries and effectively GPL-2.0-or-later for the daemon/server side, plus separately licensed permissive components |
| `xvfb` | `21.1.12-1ubuntu1.6` | In-memory X11 server with MIT-SHM and XTEST | https://gitlab.freedesktop.org/xorg/xserver, MIT/X11 family licenses |

The image also contains transitive Ubuntu packages required by these direct
packages. Their installed copyright files remain under `/usr/share/doc`.

## Build-only native dependencies

These Ubuntu packages are installed only in the discarded build stage:

| Direct build package | Version used | Source and license |
| --- | --- | --- |
| `build-essential` | `12.10ubuntu1` | https://packages.ubuntu.com/noble/build-essential; compiler and build-tool licenses recorded by Ubuntu |
| `ca-certificates` | `20260601~24.04.1` | https://packages.ubuntu.com/noble/ca-certificates; MPL-2.0 certificate data and Debian packaging terms |
| `cmake` | `3.28.3-1build7` | https://gitlab.kitware.com/cmake/cmake, BSD-3-Clause |
| `libavcodec-dev`, `libavformat-dev`, `libavutil-dev`, `libswscale-dev` | `6.1.1-3ubuntu5` | https://ffmpeg.org/, LGPL-2.1-or-later and GPL-2.0-or-later components |
| `libclang-dev` | `18.0-59~exp2` | https://github.com/llvm/llvm-project, Apache-2.0 WITH LLVM-exception |
| `libpulse-dev` | `16.1+dfsg1-2ubuntu10.1` | https://gitlab.freedesktop.org/pulseaudio/pulseaudio, LGPL-2.1-or-later |
| `pkg-config` | `1.8.1-2build1` | https://gitlab.freedesktop.org/pkg-config/pkg-config, GPL-2.0-or-later |

The build copies Rust `1.89.0` and rustup from the pinned official Rust image:

- Rust: https://github.com/rust-lang/rust, Apache-2.0 and MIT
- rustup: https://github.com/rust-lang/rustup, Apache-2.0 and MIT

## Direct Rust dependencies

| Crate | Locked version | License | Source |
| --- | --- | --- | --- |
| `anyhow` | `1.0.104` | MIT OR Apache-2.0 | https://github.com/dtolnay/anyhow |
| `bytes` | `1.12.1` | MIT | https://github.com/tokio-rs/bytes |
| `clap` | `4.6.6` | MIT OR Apache-2.0 | https://github.com/clap-rs/clap |
| `ffmpeg-next` | `8.1.0` | WTFPL | https://github.com/zmwangx/rust-ffmpeg |
| `libpulse-binding` | `2.30.1` | MIT OR Apache-2.0 | https://github.com/jnqnfe/pulse-binding-rust |
| `libpulse-simple-binding` | `2.29.0` | MIT OR Apache-2.0 | https://github.com/jnqnfe/pulse-binding-rust |
| `memmap2` | `0.9.11` | MIT OR Apache-2.0 | https://github.com/RazrFalcon/memmap2-rs |
| `reqwest` | `0.12.28` | MIT OR Apache-2.0 | https://github.com/seanmonstar/reqwest |
| `serde` | `1.0.229` | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| `serde_json` | `1.0.151` | MIT OR Apache-2.0 | https://github.com/serde-rs/json |
| `tokio` | `1.53.1` | MIT | https://github.com/tokio-rs/tokio |
| `tracing` | `0.1.44` | MIT | https://github.com/tokio-rs/tracing |
| `tracing-subscriber` | `0.3.23` | MIT | https://github.com/tokio-rs/tracing |
| `uuid` | `1.26.0` | Apache-2.0 OR MIT | https://github.com/uuid-rs/uuid |
| `webrtc` | `0.17.1` | MIT OR Apache-2.0 | https://github.com/webrtc-rs/webrtc |
| `x11rb` | `0.13.2` | MIT OR Apache-2.0 | https://github.com/psychon/x11rb |
