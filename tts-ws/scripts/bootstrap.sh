#!/usr/bin/env bash
set -euo pipefail

# Local toolchain bootstrapper
# Downloads and installs pinned versions of:
#  - wasi-sdk (clang/wasm-ld)
#  - Binaryen (wasm-opt)
# Usage:
#   ./scripts/bootstrap.sh
#   export PATH="${PWD}/.tooling/wasi-sdk/bin:${PATH}"
#   export PATH="${PWD}/.tooling/binaryen/bin:${PATH}"
#   clang --version
#   wasm-opt --version

: "${WASI_SDK_VERSION:=27}"
: "${WASI_SDK_VERSION_MINOR:=0}"
: "${BINARYEN_VERSION:=123}"
: "${TOOLING_DIR:=.tooling}"

echo "==> Ensuring tooling directory at ${TOOLING_DIR}"
mkdir -p "${TOOLING_DIR}"

# Detect platform
PLATFORM=""
case "$(uname -s)" in
  Darwin)
    if [ "$(uname -m)" = "arm64" ]; then
      PLATFORM="arm64-macos"
    else
      PLATFORM="x86_64-macos"
    fi
    # Binaryen uses same naming for macOS
    BINARYEN_PLATFORM="$PLATFORM"
    ;;
  Linux)
    if [ "$(uname -m)" = "x86_64" ]; then
      PLATFORM="x86_64-linux"
      BINARYEN_PLATFORM="x86_64-linux"
    elif [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ]; then
      PLATFORM="arm64-linux"
      # Binaryen release artifacts use aarch64-linux
      BINARYEN_PLATFORM="aarch64-linux"
    else
      echo "Unsupported Linux architecture: $(uname -m)"
      exit 1
    fi
    ;;
  *)
    echo "Unsupported platform: $(uname -s)"
    exit 1
    ;;
esac

WASI_SDK_DIR="${TOOLING_DIR}/wasi-sdk"
WASI_SDK_FULL_VERSION="${WASI_SDK_VERSION}.${WASI_SDK_VERSION_MINOR}"
BINARYEN_DIR="${TOOLING_DIR}/binaryen"

if [ ! -d "${WASI_SDK_DIR}" ]; then
  echo "==> Downloading wasi-sdk ${WASI_SDK_FULL_VERSION} for ${PLATFORM}"
  
  # Download URL format: https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-22/wasi-sdk-22.0-darwin-arm64.tar.gz
  DOWNLOAD_URL="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_FULL_VERSION}-${PLATFORM}.tar.gz"
  
  echo "    Downloading from: ${DOWNLOAD_URL}"
  curl -L -o "${TOOLING_DIR}/wasi-sdk.tar.gz" "${DOWNLOAD_URL}"
  
  echo "==> Extracting wasi-sdk"
  tar -xzf "${TOOLING_DIR}/wasi-sdk.tar.gz" -C "${TOOLING_DIR}"
  
  # Rename to consistent directory name
  mv "${TOOLING_DIR}/wasi-sdk-${WASI_SDK_FULL_VERSION}"* "${WASI_SDK_DIR}"
  
  # Clean up
  rm "${TOOLING_DIR}/wasi-sdk.tar.gz"
  
  echo "==> wasi-sdk installed successfully"
else
  echo "==> wasi-sdk already installed at ${WASI_SDK_DIR}"
fi

if [ ! -d "${BINARYEN_DIR}" ]; then
  echo "==> Downloading Binaryen ${BINARYEN_VERSION} for ${BINARYEN_PLATFORM}"
  # Download URL format: https://github.com/WebAssembly/binaryen/releases/download/version_116/binaryen-version_116-arm64-macos.tar.gz
  BIN_URL="https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-${BINARYEN_PLATFORM}.tar.gz"
  echo "    Downloading from: ${BIN_URL}"
  curl -L -o "${TOOLING_DIR}/binaryen.tar.gz" "${BIN_URL}"

  echo "==> Extracting Binaryen"
  tar -xzf "${TOOLING_DIR}/binaryen.tar.gz" -C "${TOOLING_DIR}"

  # Move extracted directory (binaryen-version_XXX) to a stable path
  BIN_EXTRACT_DIR=$(tar -tzf "${TOOLING_DIR}/binaryen.tar.gz" | head -1 | cut -f1 -d"/")
  mv "${TOOLING_DIR}/${BIN_EXTRACT_DIR}" "${BINARYEN_DIR}"

  # Clean up
  rm "${TOOLING_DIR}/binaryen.tar.gz"

  echo "==> Binaryen installed successfully"
else
  echo "==> Binaryen already installed at ${BINARYEN_DIR}"
fi

cat <<EOF

==> wasi-sdk ready.
Add to your PATH for this shell session:
  export PATH="${PWD}/${WASI_SDK_DIR}/bin:\${PATH}"
  export PATH="${PWD}/${BINARYEN_DIR}/bin:\${PATH}"

Or use directly:
  ${WASI_SDK_DIR}/bin/clang --version
  ${BINARYEN_DIR}/bin/wasm-opt --version

Notes:
- You can override the version via WASI_SDK_VERSION and WASI_SDK_VERSION_MINOR env vars.
- You can override the Binaryen version via BINARYEN_VERSION env var.
- This installs locally under ${TOOLING_DIR} and does not affect system-wide toolchains.
- The SDK includes clang, wasm-ld, and wasi-libc headers/libraries.
- Binaryen provides wasm-opt and related tools useful for post-link optimization.
EOF
