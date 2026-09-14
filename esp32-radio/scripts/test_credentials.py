"""Keep credential migration, exports and deployments consistent using fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from config import env_value, read_env
from credentials import (
    EXPORT_HEADER,
    WORKER_KEYS,
    initialize_credentials,
    sync_worker_secrets,
    worker_secrets,
)

spec = importlib.util.spec_from_file_location(
    "deploy_worker", Path(__file__).with_name("deploy_worker.py")
)
deploy_worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy_worker)

BASE = {
    "REALTIME_APP_ID": "synthetic-app-id",
    "REALTIME_APP_TOKEN": "example-app-token",
    "WIFI_SSID": "Synthetic network",
    "WIFI_PASSWORD": "synthetic-wifi-password",
}
TOKENS = {"DEVICE_TOKEN": "d" * 43, "VIEWER_PASSWORD": "synthetic-viewer-password"}


def write_env(path, values):
    path.write_text("".join(f"{key}={env_value(key, value)}\n" for key, value in values.items()))


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "worker").mkdir()
        self.source = self.root / ".credential.env"
        self.export = self.root / "worker/.dev.vars"

    def test_migration_preserves_credentials_and_source_comments(self):
        write_env(self.source, BASE)
        original = "# Keep this private.\n" + self.source.read_text()
        self.source.write_text(original)
        self.export.write_text("".join(
            f"{key}={json.dumps(value)}\n"
            for key, value in {**BASE, **TOKENS, "LOCAL_DEMO_ORIGIN": "obsolete"}.items()
        ))
        with patch("credentials.secrets.token_urlsafe") as generate:
            initialize_credentials(self.root)
        generate.assert_not_called()
        self.assertEqual(read_env(self.source), {**BASE, **TOKENS})
        self.assertTrue(self.source.read_text().startswith(original))
        self.assertEqual(read_env(self.export), {key: {**BASE, **TOKENS}[key] for key in WORKER_KEYS})
        self.assertTrue(self.export.read_text().startswith(EXPORT_HEADER))
        self.assertEqual(self.source.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.export.stat().st_mode & 0o777, 0o600)
        original_source = self.source.read_bytes()
        export_time = self.export.stat().st_mtime_ns
        with patch("credentials.secrets.token_urlsafe") as generate:
            initialize_credentials(self.root)
        generate.assert_not_called()
        self.assertEqual(self.source.read_bytes(), original_source)
        self.assertEqual(self.export.stat().st_mtime_ns, export_time)

    def test_first_setup_fills_empty_template_fields_once(self):
        write_env(self.source, {**BASE, "DEVICE_TOKEN": "", "VIEWER_PASSWORD": ""})
        with patch("credentials.secrets.token_urlsafe", side_effect=TOKENS.values()) as generate:
            initialize_credentials(self.root)
        self.assertEqual(generate.call_count, 2)
        self.assertEqual(read_env(self.source), {**BASE, **TOKENS})
        with patch("credentials.secrets.token_urlsafe") as generate:
            initialize_credentials(self.root)
        generate.assert_not_called()

    def test_canonical_values_override_stale_exports_and_can_recreate_them(self):
        write_env(self.source, {**BASE, **TOKENS})
        initialize_credentials(self.root)
        changed = {**BASE, **TOKENS, "VIEWER_PASSWORD": "changed # with spaces"}
        write_env(self.source, changed)
        self.assertEqual(worker_secrets(self.root)["VIEWER_PASSWORD"], changed["VIEWER_PASSWORD"])
        sync_worker_secrets(self.root)
        self.assertEqual(read_env(self.export), {key: changed[key] for key in WORKER_KEYS})
        self.export.unlink()
        sync_worker_secrets(self.root)
        self.assertEqual(read_env(self.export), {key: changed[key] for key in WORKER_KEYS})

    def test_explicit_canonical_token_wins_during_migration(self):
        write_env(self.source, {**BASE, "DEVICE_TOKEN": TOKENS["DEVICE_TOKEN"]})
        write_env(self.export, {**TOKENS, "DEVICE_TOKEN": "obsolete" * 6})
        initialize_credentials(self.root)
        self.assertEqual(read_env(self.source), {**BASE, **TOKENS})

    def test_routine_sync_never_generates_missing_credentials(self):
        write_env(self.source, BASE)
        original = self.source.read_bytes()
        with patch("credentials.secrets.token_urlsafe") as generate:
            with self.assertRaisesRegex(SystemExit, "DEVICE_TOKEN, VIEWER_PASSWORD"):
                sync_worker_secrets(self.root)
        generate.assert_not_called()
        self.assertEqual(self.source.read_bytes(), original)
        self.assertFalse(self.export.exists())

    def test_initialized_credentials_are_not_recovered_from_generated_export(self):
        write_env(self.source, {**BASE, **TOKENS})
        initialize_credentials(self.root)
        write_env(self.source, {**BASE, "DEVICE_TOKEN": TOKENS["DEVICE_TOKEN"]})
        original_export = self.export.read_bytes()
        with patch("credentials.secrets.token_urlsafe") as generate:
            with self.assertRaisesRegex(SystemExit, "Restore VIEWER_PASSWORD"):
                initialize_credentials(self.root)
        generate.assert_not_called()
        self.assertEqual(self.export.read_bytes(), original_export)

    def test_incomplete_legacy_export_is_not_replaced(self):
        write_env(self.source, BASE)
        write_env(self.export, {"VIEWER_PASSWORD": TOKENS["VIEWER_PASSWORD"]})
        original_source, original_export = self.source.read_bytes(), self.export.read_bytes()
        with self.assertRaisesRegex(SystemExit, "Legacy worker/.dev.vars is incomplete"):
            initialize_credentials(self.root)
        self.assertEqual(self.source.read_bytes(), original_source)
        self.assertEqual(self.export.read_bytes(), original_export)

    def test_frontend_checkout_can_skip_secrets_but_never_use_an_orphan_export(self):
        sync_worker_secrets(self.root, optional=True)
        self.assertFalse(self.source.exists())
        self.assertFalse(self.export.exists())
        write_env(self.export, TOKENS)
        with self.assertRaisesRegex(SystemExit, "Create .credential.env"):
            sync_worker_secrets(self.root, optional=True)

    def test_invalid_credentials_do_not_modify_private_files(self):
        for overrides in ({"DEVICE_TOKEN": "short"}, {"VIEWER_PASSWORD": "x" * 257}):
            with self.subTest(keys=tuple(overrides)):
                write_env(self.source, {**BASE, **TOKENS, **overrides})
                original = self.source.read_bytes()
                with self.assertRaises(SystemExit):
                    initialize_credentials(self.root)
                self.assertEqual(self.source.read_bytes(), original)
                self.assertFalse(self.export.exists())

    def test_deploy_uploads_current_canonical_worker_secrets_only(self):
        write_env(self.source, {**BASE, **TOKENS})
        initialize_credentials(self.root)
        changed = {**BASE, **TOKENS, "VIEWER_PASSWORD": "new canonical password"}
        write_env(self.source, changed)
        config = self.root / "worker/dist/esp32_radio/wrangler.json"
        config.parent.mkdir(parents=True)
        config.write_text("{}")
        uploaded = []

        def run(command, **kwargs):
            path = Path(command[command.index("--secrets-file") + 1])
            uploaded.append(json.loads(path.read_text()))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            return SimpleNamespace(returncode=0)

        original_umask = os.umask(0o077)
        self.addCleanup(os.umask, original_umask)
        with patch.object(deploy_worker, "ROOT", self.root), patch.object(deploy_worker.subprocess, "run", side_effect=run):
            with self.assertRaises(SystemExit) as result:
                deploy_worker.main([])
        self.assertEqual(result.exception.code, 0)
        self.assertEqual(uploaded, [{key: changed[key] for key in WORKER_KEYS}])

    def test_python_node_and_wrangler_agree_on_literal_credentials(self):
        values = {
            "SPACES": "  two  spaces  ",
            "PUNCTUATION": "# $HOME $(command) `text` \\",
            "SINGLE_QUOTE": "it's private",
            "DOUBLE_QUOTE": 'say "hello"',
            "BOTH_QUOTES": "it's a \"password\"",
            "BACKSLASH": r"keep\n\r\t literal",
            "UNICODE": "café ☕",
            "EMPTY": "",
        }
        write_env(self.source, values)
        self.assertEqual(read_env(self.source), values)
        script = "import {parseEnv} from 'node:util'; import {readFileSync} from 'node:fs'; process.stdout.write(JSON.stringify(parseEnv(readFileSync(process.argv[1], 'utf8'))));"
        decoded = json.loads(subprocess.check_output(
            ["node", "--input-type=module", "-e", script, str(self.source)], text=True,
        ))
        self.assertEqual(decoded, values)
        self.export.write_text(self.source.read_text())
        script = "import {unstable_getVarsForDev as read} from 'wrangler'; const values = read(process.argv[1], undefined, {}, undefined, true); process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(values).map(([key, binding]) => [key, binding.value]))));"
        decoded = json.loads(subprocess.check_output(
            ["node", "--input-type=module", "-e", script, str(self.root / "worker/wrangler.jsonc")],
            cwd=Path(__file__).resolve().parents[1] / "worker", text=True,
        ))
        self.assertEqual(decoded, values)

    def test_dotenv_comments_export_and_quotes_are_literal(self):
        self.source.write_text(
            "# comment\nexport UNQUOTED = two  spaces # comment\n"
            "QUOTED=' # $HOME `command` ' # comment\n"
        )
        self.assertEqual(read_env(self.source), {
            "UNQUOTED": "two  spaces", "QUOTED": " # $HOME `command` ",
        })

    def test_parse_errors_do_not_include_secret_values(self):
        for contents in (
            "not-an-assignment synthetic-secret",
            "VALUE='synthetic-secret",
            "VALUE='synthetic-secret' extra",
            "VALUE='synthetic-secret'\nVALUE=duplicate",
        ):
            self.source.write_text(contents)
            with self.assertRaises(SystemExit) as error:
                read_env(self.source)
            self.assertNotIn("synthetic-secret", str(error.exception))


if __name__ == "__main__":
    unittest.main()
