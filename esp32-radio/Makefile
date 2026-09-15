.DEFAULT_GOAL := help
PYTHON ?= python3
CARGO ?= cargo
SIGNALING_URL ?=
SERIAL_PREFIX ?=
FLASH_ARGS ?= --firmware-only
MONITOR_ARGS ?=
export TRACK PLAYLIST SIGNALING_URL PYTHON

.PHONY: help setup setup-firmware setup-web setup-c-format tooling-check check check-c-format check-rust check-web check-scripts check-transport-patches test-worker test-worker-bundle fmt fmt-c build build-firmware build-web backup backup-check flash flash-music monitor music secrets dev dev-live deploy-dry-run deploy

help:
	@printf '%s\n' 'Pocket Radio — ESP32-S3 × Cloudflare SFU' \
	  'make setup          Install pinned firmware tools and web dependencies' \
	  'make setup-c-format Install the pinned C formatter without the SDK' \
	  'make fmt            Format Rust, C and web source' \
	  'make check          C formatting, Rust, web and host-tool checks' \
	  'make check-transport-patches Run the vendored transport library tests' \
	  'make build          Build Rust firmware and browser assets' \
	  'make backup         Read and verify the original flash before changing firmware' \
	  'make backup-check   Check the saved backup without accessing the board' \
	  'make flash          Flash changed firmware sectors; preserves music' \
	  'make flash-music    Flash changed music sectors with full verification' \
	  'make monitor        Stream USB logs (MONITOR_ARGS=--check for a health check)' \
	  'make music TRACK=…  Prepare audio files/folder (or PLAYLIST=playlist.json)' \
	  'make secrets        Initialize credentials and refresh worker/.dev.vars' \
	  'make dev            Run Vite and the local Worker on port 11880' \
	  'make dev-live       Preview the exhibit with the deployed board API' \
	  'make test-worker    Run Worker/RPC tests in the Vitest runtime' \
	  'make test-worker-bundle Check the production bundle and real lease alarm' \
	  'make deploy-dry-run Validate Worker deployment' \
	  'make deploy         Deploy the Worker and its four production secrets' \
	  'Set SIGNALING_URL to the HTTPS origin of your deployed Worker.'

setup: setup-firmware setup-web
setup-firmware: setup-c-format
	$(PYTHON) scripts/setup_tooling.py
setup-web:
	cd worker && npm ci --ignore-scripts
	cd worker && ./node_modules/.bin/wrangler types
setup-c-format:
	$(PYTHON) scripts/format_c.py --setup
tooling-check:
	$(PYTHON) scripts/format_c.py --version
	$(PYTHON) scripts/setup_tooling.py --check

check: check-c-format check-rust check-web check-scripts
check-c-format:
	$(PYTHON) scripts/format_c.py --check
check-rust:
	$(CARGO) fmt --manifest-path firmware/Cargo.toml --all -- --check
	$(CARGO) test --manifest-path firmware/Cargo.toml --locked
	$(CARGO) clippy --manifest-path firmware/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
	RUSTDOCFLAGS='-D warnings' $(CARGO) doc --manifest-path firmware/Cargo.toml --workspace --all-features --no-deps --locked
check-web:
	cd worker && npm run check
check-scripts:
	$(PYTHON) -m unittest discover -s scripts -p 'test_*.py'
check-transport-patches:
	$(CARGO) test --manifest-path firmware/vendor/sctp-proto/Cargo.toml --locked --lib --target-dir artifacts/vendor-tests
	$(CARGO) test --manifest-path firmware/vendor/str0m/Cargo.toml --locked --no-default-features --features rust-crypto --lib \
	  --config 'patch.crates-io.sctp-proto.path="firmware/vendor/sctp-proto"' \
	  --config 'patch.crates-io.str0m-rust-crypto.path="firmware/vendor/str0m-rust-crypto"' \
	  --target-dir artifacts/vendor-tests
	$(CARGO) test --manifest-path firmware/vendor/str0m/Cargo.toml --locked --no-default-features --features rust-crypto,_internal_test_exports \
	  --test contiguous --test keyframes --test loss \
	  --config 'patch.crates-io.sctp-proto.path="firmware/vendor/sctp-proto"' \
	  --config 'patch.crates-io.str0m-rust-crypto.path="firmware/vendor/str0m-rust-crypto"' \
	  --target-dir artifacts/vendor-tests
test-worker:
	cd worker && npm run test:worker
test-worker-bundle: build-web
	cd worker && npm run test:bundle
fmt: fmt-c
	$(CARGO) fmt --manifest-path firmware/Cargo.toml --all
	cd worker && npm run format
fmt-c:
	$(PYTHON) scripts/format_c.py

build: build-firmware build-web
build-firmware:
	$(PYTHON) scripts/build_firmware.py
build-web:
	cd worker && ./node_modules/.bin/vite build
backup:
	$(SERIAL_PREFIX) .tools/esptool/bin/python scripts/backup_flash.py
backup-check:
	.tools/esptool/bin/python scripts/backup_flash.py --check
flash:
	$(SERIAL_PREFIX) .tools/esptool/bin/python scripts/flash_device.py $(FLASH_ARGS)
flash-music:
	$(SERIAL_PREFIX) .tools/esptool/bin/python scripts/flash_device.py --music-only
monitor:
	$(SERIAL_PREFIX) .tools/esptool/bin/python scripts/monitor_device.py $(MONITOR_ARGS)
music:
	$(PYTHON) scripts/prepare_music.py
secrets:
	$(PYTHON) scripts/prepare_secrets.py
dev:
	cd worker && ./node_modules/.bin/vite
dev-live:
	@test -n "$$SIGNALING_URL" || { printf '%s\n' 'Set SIGNALING_URL to your deployed Worker HTTPS origin.'; exit 1; }
	cd worker && RADIO_API_ORIGIN="$$SIGNALING_URL" ./node_modules/.bin/vite
deploy-dry-run: build-web check-web
	$(PYTHON) scripts/deploy_worker.py --dry-run
deploy: build-web check-web
	$(PYTHON) scripts/deploy_worker.py
