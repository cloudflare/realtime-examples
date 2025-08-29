#!/usr/bin/env bash
set -euo pipefail

# Build SpeexDSP resampler to a standalone WebAssembly module using wasi-sdk.
# Output: src/wasm/speexdsp.wasm (placed under src to enable Wrangler's ESM bundling)
# Usage:
#   # Ensure wasi-sdk is installed:
#   ./scripts/bootstrap.sh
#   export PATH="${PWD}/.tooling/wasi-sdk/bin:${PATH}"
#   # Build
#   ./scripts/build-speexdsp-wasm.sh
#
# Notes:
# - This script auto-detects Binaryen's wasm-opt from (in order):
#     1) WASM_OPT env var (path to the binary or name on PATH)
#     2) PATH (wasm-opt)
#     3) .tooling/binaryen/bin/wasm-opt

: "${TOOLING_DIR:=.tooling}"
: "${SPEEXDSP_DIR:=${TOOLING_DIR}/speexdsp}"
: "${SPEEXDSP_TAG:=SpeexDSP-1.2.1}"
: "${OUT_DIR:=src/wasm}"
: "${WASI_SDK_DIR:=${TOOLING_DIR}/wasi-sdk}"

# Check if wasi-sdk is available
if [ ! -d "${WASI_SDK_DIR}" ]; then
  echo "wasi-sdk not found. Run: ./scripts/bootstrap.sh"
  exit 1
fi

WASI_CC="${WASI_SDK_DIR}/bin/clang"

if [ ! -x "${WASI_CC}" ]; then
  echo "wasi-sdk clang not found at ${WASI_CC}"
  exit 1
fi

mkdir -p "${TOOLING_DIR}" "${OUT_DIR}"

# Clone SpeexDSP
if [ ! -d "${SPEEXDSP_DIR}" ]; then
  echo "==> Cloning SpeexDSP"
  git clone https://github.com/xiph/speexdsp.git "${SPEEXDSP_DIR}"
  (cd "${SPEEXDSP_DIR}" && git checkout "${SPEEXDSP_TAG}")
else
  echo "==> Updating SpeexDSP"
  (cd "${SPEEXDSP_DIR}" && git fetch --tags && git checkout "${SPEEXDSP_TAG}")
fi

# SpeexDSP expects config types header. Generate minimal version for wasi-sdk.
CONFIG_TYPES_H="${SPEEXDSP_DIR}/include/speex/speexdsp_config_types.h"
if [ ! -f "${CONFIG_TYPES_H}" ]; then
  echo "==> Generating ${CONFIG_TYPES_H} for wasi-sdk"
  cat > "${CONFIG_TYPES_H}" <<'EOF'
#ifndef SPEEXDSP_CONFIG_TYPES_H
#define SPEEXDSP_CONFIG_TYPES_H
#include <stdint.h>
typedef int16_t spx_int16_t;
typedef uint16_t spx_uint16_t;
typedef int32_t spx_int32_t;
typedef uint32_t spx_uint32_t;
#endif
EOF
fi

# Build resampler to a standalone WASI module (SIMD-enabled). We export a minimal C ABI plus malloc/free.
"${WASI_CC}" \
  "${SPEEXDSP_DIR}/libspeexdsp/resample.c" \
  -O3 \
  -msimd128 \
  -g0 -ffunction-sections -fdata-sections \
  -I "${SPEEXDSP_DIR}/include" \
  -DFLOATING_POINT \
  -DEXPORT= \
  --target=wasm32-wasi \
  -nostartfiles \
  -Wl,--gc-sections \
  -Wl,--no-entry \
  -Wl,--export=speex_resampler_init \
  -Wl,--export=speex_resampler_process_interleaved_int \
  -Wl,--export=speex_resampler_set_rate \
  -Wl,--export=speex_resampler_destroy \
  -Wl,--export=malloc \
  -Wl,--export=free \
  -Wl,--export=__heap_base \
  -Wl,--export=__data_end \
  -Wl,--strip-debug \
  -Wl,--allow-undefined \
  -o "${OUT_DIR}/speexdsp.wasm"

# Optional post-link optimization via Binaryen (wasm-opt)
OUT_WASM="${OUT_DIR}/speexdsp.wasm"

# Resolve wasm-opt location: env var -> PATH -> local tooling dir
WASM_OPT_BIN=""
if [ -n "${WASM_OPT:-}" ]; then
  if [ -x "${WASM_OPT}" ]; then
    WASM_OPT_BIN="${WASM_OPT}"
  elif command -v "${WASM_OPT}" >/dev/null 2>&1; then
    WASM_OPT_BIN="$(command -v "${WASM_OPT}")"
  fi
fi
if [ -z "${WASM_OPT_BIN}" ] && command -v wasm-opt >/dev/null 2>&1; then
  WASM_OPT_BIN="$(command -v wasm-opt)"
fi
if [ -z "${WASM_OPT_BIN}" ] && [ -x "${TOOLING_DIR}/binaryen/bin/wasm-opt" ]; then
  WASM_OPT_BIN="${TOOLING_DIR}/binaryen/bin/wasm-opt"
fi

if [ -n "${WASM_OPT_BIN}" ] && [ -x "${WASM_OPT_BIN}" ]; then
  echo "==> Optimizing with wasm-opt at ${WASM_OPT_BIN}"
  TMP_WASM="${OUT_DIR}/speexdsp.opt.wasm"
  "${WASM_OPT_BIN}" "${OUT_WASM}" -o "${TMP_WASM}" \
    -O3 \
    --strip-debug \
    --strip-producers \
    --enable-simd
  mv "${TMP_WASM}" "${OUT_WASM}"
else
  echo "==> wasm-opt not found; skipping optimization (run ./scripts/bootstrap.sh to install Binaryen)"
fi

echo "==> Wrote ${OUT_DIR}/speexdsp.wasm"

echo "Usage in Workers (ESM import; Wrangler auto-bundles .wasm):"
cat <<'EOF'

// Example (TypeScript)
// Place this near the top-level module scope so the instance is reused.
import speexWasm from "./wasm/speexdsp.wasm";

// WASI modules typically need minimal or no imports for pure computation
const importObject = {
  wasi_snapshot_preview1: {
    // Empty or minimal stubs - SpeexDSP doesn't need WASI syscalls
  }
};
const { instance } = await WebAssembly.instantiate(speexWasm, importObject);
// instance.exports now contains your exported functions
EOF
