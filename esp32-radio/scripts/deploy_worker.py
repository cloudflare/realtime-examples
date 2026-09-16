#!/usr/bin/env python3
"""Deploy the Worker with only its four production secrets. Supports --dry-run."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
from credentials import worker_secrets
from project import ROOT

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    application = ROOT / "worker"
    config = application / "dist/esp32_radio/wrangler.json"
    if not config.exists():
        raise SystemExit("Run make build-web before deploying the Vite application")
    values = worker_secrets(ROOT)
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="pocket-radio-deploy-") as directory:
        secret_file = Path(directory) / "secrets.json"
        secret_file.write_text(json.dumps(values))
        secret_file.chmod(0o600)
        command = [str(application / "node_modules/.bin/wrangler"), "deploy", "--no-autoconfig", "--config", str(config),
                   "--secrets-file", str(secret_file)]
        if args.dry_run: command.append("--dry-run")
        result = subprocess.run(command, cwd=application)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
