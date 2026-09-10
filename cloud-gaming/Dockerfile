# syntax=docker/dockerfile:1

FROM rust:1.89.0-slim-bookworm@sha256:d7fc7de78bb8c1469933aeecbf801314d30d7d6e9f0578bba4cfa285bfa37fe6 AS rust-toolchain

FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517 AS build-deps

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        build-essential \
        ca-certificates \
        cmake \
        libavcodec-dev \
        libavformat-dev \
        libavutil-dev \
        libclang-dev \
        libpulse-dev \
        libswscale-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

FROM build-deps AS build

WORKDIR /build/cloud-gaming-publisher

COPY publisher/Cargo.toml publisher/Cargo.lock ./
COPY publisher/src ./src
RUN --mount=type=cache,id=cloud-gaming-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cloud-gaming-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=cloud-gaming-cargo-target,target=/build/cloud-gaming-publisher/target \
    cargo build --release --locked \
    && install -Dm755 \
        target/release/cloud-gaming-publisher \
        /out/cloud-gaming-publisher \
    && strip /out/cloud-gaming-publisher

FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        crispy-doom=6.0-2build2 \
        freedoom=0.13.0-1 \
        libavcodec60 \
        libavformat60 \
        libavutil58 \
        libopus0 \
        libswscale7 \
        libx264-164 \
        pulseaudio \
        xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && test -f /usr/share/doc/crispy-doom/copyright \
    && test -f /usr/share/doc/freedoom/copyright \
    && test -f /usr/share/doc/libavcodec60/copyright \
    && test -f /usr/share/doc/libx264-164/copyright \
    && test -f /usr/share/doc/libopus0/copyright \
    && test -f /usr/share/doc/pulseaudio/copyright \
    && test -f /usr/share/doc/xvfb/copyright

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin publisher \
    && install -d -o publisher -g publisher /home/publisher/.config

COPY --from=build \
    /out/cloud-gaming-publisher \
    /usr/local/bin/cloud-gaming-publisher
COPY THIRD_PARTY_NOTICES.md /usr/share/doc/cloud-gaming/THIRD_PARTY_NOTICES.md

ENV HOME=/home/publisher \
    XDG_CONFIG_HOME=/home/publisher/.config \
    RUST_LOG=info

WORKDIR /home/publisher
USER publisher
STOPSIGNAL SIGTERM
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/cloud-gaming-publisher"]
