"""Shared paths and the pinned firmware toolchain; never modifies the shell profile."""
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
IDF_REVISION = "880a203ae603d08a94d06aa01e0d6761958e5e9e"
DSP_REVISION = "3c8ac0fdfec83740b783e200862c8d0c056de0ad"
CODEC_REVISION = "da256e5f462a8e010667d35314a5ba5cdc4a8d9a"
VENDOR = ROOT / ".tools/vendor"
RUST_RELEASE = "1.97.0.0"
RUST_TOOLCHAIN = "esp-radio"
ESPUP_VERSION = "0.19.0"
ESPUP_SHA256 = "f31411c64dffff4da0f0e23c432b9a5fda48942ff8695b8b21009ceb7007bcc0"
CLANG_FORMAT_VERSION = "23.1.5"


def sdk_root():
    configured = os.environ.get("RADIO_SDK_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    existing = ROOT / ".tools/validation-sdk"
    return (existing if existing.exists() else ROOT / ".tools/sdk").resolve()


def build_dir():
    return sdk_root() / "rust-radio-build"


def verify_checkout(path, revision):
    actual = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    if actual != revision:
        raise SystemExit(f"{path.name} revision differs from the pinned version; use a separate checkout")
    changes = subprocess.check_output(["git", "-C", str(path), "status", "--porcelain", "--untracked-files=no"], text=True)
    if changes:
        raise SystemExit(f"{path.name} has tracked modifications; use a clean pinned checkout")


def rust_libclang():
    """Find libclang bundled with the named Xtensa Rust toolchain."""
    compiler = subprocess.run(
        ["rustup", "which", "--toolchain", RUST_TOOLCHAIN, "rustc"],
        capture_output=True, text=True,
    )
    if not compiler.returncode:
        toolchain = Path(compiler.stdout.strip()).parent.parent
        libraries = sorted(toolchain.glob("xtensa-esp32-elf-clang/*/esp-clang/lib/libclang.so"))
        for library in reversed(libraries):
            if library.is_file():
                return library.parent
    raise SystemExit("Xtensa libclang is missing. Run make setup first.")


def idf_environment():
    """Return ESP-IDF's Python and the build environment, including Xtensa libclang."""
    sdk = sdk_root()
    tools = sdk / "tools"
    try:
        python = next((tools / "python_env").glob("idf5.5_py*_env/bin/python"))
        gcc = next((tools / "tools/xtensa-esp-elf").rglob("xtensa-esp32s3-elf-gcc"))
        ninja = next((tools / "tools/ninja").rglob("ninja"))
        rom = next((tools / "tools/esp-rom-elfs").glob("*"))
    except StopIteration:
        raise SystemExit("ESP-IDF tools are missing. Run make setup first.") from None
    env = os.environ.copy()
    env.update(IDF_PATH=str(sdk / "esp-idf"), IDF_TOOLS_PATH=str(tools), IDF_TARGET="esp32s3",
               IDF_PYTHON_ENV_PATH=str(python.parent.parent), PIP_CACHE_DIR=str(sdk / "pip-cache"),
               ESP_ROM_ELF_DIR=str(rom), LIBCLANG_PATH=str(rust_libclang()),
               ESP_IDF_ESPUP_CLANG_SYMLINK="ignore")
    env["PATH"] = os.pathsep.join([str(python.parent), str(gcc.parent), str(ninja.parent), env["PATH"]])
    return python, env
