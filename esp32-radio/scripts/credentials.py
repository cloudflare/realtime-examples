"""Canonical private credentials and the generated Wrangler development export."""
import os
import secrets
import tempfile

from config import ENV_ASSIGNMENT, env_value, read_env

WORKER_KEYS = ("REALTIME_APP_ID", "REALTIME_APP_TOKEN", "DEVICE_TOKEN", "VIEWER_PASSWORD")
GENERATED_KEYS = ("DEVICE_TOKEN", "VIEWER_PASSWORD")
EXPORT_HEADER = "# Generated from ../.credential.env. Edit that file; this export is overwritten.\n"


def private_write(path, contents):
    """Replace a private file atomically, keeping unchanged exports stable."""
    if path.exists() and path.read_text() == contents:
        path.chmod(0o600)
        return
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as output:
            output.write(contents)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def validate_worker(values):
    missing = [key for key in WORKER_KEYS if not values.get(key)]
    if missing:
        raise SystemExit(
            f"Set {', '.join(missing)} in .credential.env; run make secrets for initial setup."
        )
    if not 32 <= len(values["DEVICE_TOKEN"]) <= 128:
        raise SystemExit("DEVICE_TOKEN in .credential.env must be 32–128 characters")
    if len(values["VIEWER_PASSWORD"].encode("utf-16-le")) // 2 > 256:
        raise SystemExit("VIEWER_PASSWORD in .credential.env must be at most 256 characters")
    return {key: values[key] for key in WORKER_KEYS}


def worker_secrets(root):
    path = root / ".credential.env"
    if not path.exists():
        raise SystemExit("Create .credential.env from .credential.env.example and run make secrets")
    return validate_worker(read_env(path))


def export_contents(values):
    return EXPORT_HEADER + "".join(f"{key}={env_value(key, values[key])}\n" for key in WORKER_KEYS)


def sync_worker_secrets(root, *, optional=False):
    """Refresh only the export; ordinary commands never create credentials."""
    source = root / ".credential.env"
    export = root / "worker/.dev.vars"
    if optional and not source.exists() and not export.exists():
        return
    values = worker_secrets(root)
    private_write(export, export_contents(values))


def initialize_credentials(root):
    """Import credentials from an older export, or generate them during first setup."""
    source = root / ".credential.env"
    export = root / "worker/.dev.vars"
    if not source.exists():
        raise SystemExit("Create .credential.env from .credential.env.example first")
    contents = source.read_text()
    values = read_env(source)
    missing = [key for key in GENERATED_KEYS if not values.get(key)]
    updates = {}
    if missing and export.exists():
        if export.read_text().startswith(EXPORT_HEADER):
            raise SystemExit(
                f"Restore {', '.join(missing)} in .credential.env; credentials are already initialized."
            )
        legacy = read_env(export)
        if any(not legacy.get(key) for key in missing):
            raise SystemExit("Legacy worker/.dev.vars is incomplete; restore its device/viewer credentials first")
        updates = {key: legacy[key] for key in missing}
    elif missing:
        updates = {key: secrets.token_urlsafe(32) for key in missing}
    values.update(updates)
    rendered = export_contents(validate_worker(values))
    remaining = updates.copy()
    lines = []
    for line in contents.splitlines(keepends=True):
        match = ENV_ASSIGNMENT.fullmatch(line.rstrip("\r\n"))
        if match and match[1] in remaining:
            key = match[1]
            lines.append(f"{key}={env_value(key, remaining.pop(key))}\n")
        else:
            lines.append(line)
    contents = "".join(lines)
    if remaining:
        if contents and not contents.endswith("\n"):
            contents += "\n"
        contents += "".join(f"{key}={env_value(key, value)}\n" for key, value in remaining.items())
    private_write(source, contents)
    private_write(export, rendered)
