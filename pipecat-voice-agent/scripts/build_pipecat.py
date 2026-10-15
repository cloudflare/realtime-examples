"""Rebuild the vendored Workers profile from a pinned upstream Git revision."""

import argparse
import base64
import csv
import hashlib
import io
import re
import subprocess
import tarfile
import tempfile
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REVISION = "1559a684b1ee9771b36454b72418d7364b518e7f"
VERSION = "1.12.0+workersprofile.5"
EXCLUDED_DEPENDENCIES = {"sentencex", "onnxruntime", "loudness", "numba", "resampy", "soundfile"}
EXCLUDED_ASSETS = {
    "pipecat/audio/turn/smart_turn/data/smart-turn-v3.2-cpu.onnx",
    "pipecat/audio/vad/data/silero_vad.onnx",
}


def build(source: Path, output: Path) -> Path:
    archive = subprocess.check_output(
        ["git", "-C", str(source), "archive", REVISION, "src/pipecat", "pyproject.toml", "LICENSE"]
    )
    with tempfile.TemporaryDirectory(prefix="pipecat-workers-") as directory:
        checkout = Path(directory)
        with tarfile.open(fileobj=io.BytesIO(archive)) as files:
            files.extractall(checkout, filter="data")
        subprocess.run(
            ["git", "apply", str(ROOT / "vendor/pipecat.patch")], cwd=checkout, check=True
        )
        project = tomllib.loads((checkout / "pyproject.toml").read_text())["project"]
        requirements = []
        for requirement in project["dependencies"]:
            name = re.split(r"[<>=!~;\[ ]", requirement, maxsplit=1)[0].lower()
            if name in EXCLUDED_DEPENDENCIES:
                continue
            requirement = {
                "soxr": "soxr==0.5.0.post1",
                "pydantic": "pydantic==2.12.5",
            }.get(name, requirement)
            if requirement not in requirements:
                requirements.append(requirement)

        files = {
            path.relative_to(checkout / "src").as_posix(): path.read_bytes()
            for path in (checkout / "src/pipecat").rglob("*")
            if path.is_file()
        }
        for name in EXCLUDED_ASSETS:
            del files[name]
        dist_info = f"pipecat_ai-{VERSION}.dist-info"
        licenses = {
            "LICENSE": (checkout / "LICENSE").read_bytes(),
            "CLOUDFLARE-LICENSE": (ROOT / "LICENSE").read_bytes(),
            "NOTICE": (ROOT / "vendor/NOTICE").read_bytes(),
            **{
                path.name: path.read_bytes()
                for path in sorted((ROOT / "vendor/licenses").glob("*-LICENSE"))
            },
        }
        metadata = [
            "Metadata-Version: 2.3",
            "Name: pipecat-ai",
            f"Version: {VERSION}",
            "Summary: Hosted-turn Workers profile of Pipecat 1.12.0",
            "Requires-Python: >=3.11",
            "License: BSD-2-Clause AND Apache-2.0 AND MIT",
            *[f"Requires-Dist: {requirement}" for requirement in requirements],
        ]
        files[f"{dist_info}/METADATA"] = ("\n".join(metadata) + "\n\n").encode()
        files[f"{dist_info}/WHEEL"] = (
            b"Wheel-Version: 1.0\nGenerator: pipecat-workers-profile\n"
            b"Root-Is-Purelib: true\nTag: py3-none-any\n"
        )
        files[f"{dist_info}/top_level.txt"] = b"pipecat\n"
        for name, content in licenses.items():
            files[f"{dist_info}/licenses/{name}"] = content

    record = io.StringIO()
    writer = csv.writer(record, lineterminator="\n")
    for name, content in sorted(files.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode()
        writer.writerow((name, "sha256=" + digest, len(content)))
    writer.writerow((f"{dist_info}/RECORD", "", ""))
    files[f"{dist_info}/RECORD"] = record.getvalue().encode()

    output.mkdir(parents=True, exist_ok=True)
    wheel = output / f"pipecat_ai-{VERSION}-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 6, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o644 << 16
            archive.writestr(info, content)
    return wheel


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source", type=Path, help="Upstream Pipecat Git checkout containing the pinned revision"
    )
    parser.add_argument("--output", type=Path, default=ROOT / "vendor")
    args = parser.parse_args()
    wheel = build(args.source.resolve(), args.output.resolve())
    print(f"{wheel.name}: sha256:{hashlib.sha256(wheel.read_bytes()).hexdigest()}")
