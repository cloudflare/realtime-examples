"""Private successful-flash snapshots for esptool's verified sector comparison."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from project import ROOT


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def layout_digest(table):
    # IDF reserves 0xc00 bytes for the table; a USB read may include sector padding.
    return hashlib.sha256(table[:0xC00].ljust(0xC00, b"\xff")).hexdigest()


class FlashCache:
    def __init__(self, identity, layout, root=None):
        self.identity = identity
        self.layout = layout
        root = Path(root) if root is not None else ROOT / "artifacts/flash-cache"
        self.directory = root / hashlib.sha256(identity.encode()).hexdigest()[:24]

    @contextmanager
    def locked(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = os.open(self.directory / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("Another flash operation is already using this device cache") from None
            yield self
        finally:
            os.close(lock)

    def record(self):
        try:
            value = json.loads((self.directory / "verified.json").read_text())
            if (value.get("version") == 1 and value.get("identity") == self.identity
                    and value.get("layout") == self.layout and isinstance(value.get("images"), dict)):
                return value["images"]
        except (OSError, ValueError, AttributeError):
            pass
        return {}

    def bases(self, addresses):
        record = self.record()
        result = []
        for address in addresses:
            path = self.directory / f"{address:08x}.bin"
            try:
                valid = record.get(str(address)) == digest(path)
            except OSError:
                valid = False
            result.append(path if valid else None)
        return result

    def remember(self, images):
        """Record the immutable input copies only after successful device verification."""
        records = self.record()
        for address, source in images:
            destination = self.directory / f"{address:08x}.bin"
            self._replace(destination, lambda output: _copy(source, output))
            records[str(address)] = digest(destination)
        value = {"version": 1, "identity": self.identity, "layout": self.layout, "images": records}
        self._replace(self.directory / "verified.json", lambda output: output.write((json.dumps(value, indent=2) + "\n").encode()))
        descriptor = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _replace(self, destination, write):
        with tempfile.NamedTemporaryFile(dir=self.directory, delete=False) as temporary:
            path = Path(temporary.name)
            try:
                write(temporary)
                temporary.flush()
                os.fsync(temporary.fileno())
                path.replace(destination)
            finally:
                path.unlink(missing_ok=True)


def _copy(source, output):
    with Path(source).open("rb") as source_file:
        shutil.copyfileobj(source_file, output)


def flash_images(images, base_command, run, cache=None, full=False):
    """Stage inputs so concurrent catalog preparation cannot change a running flash."""
    with tempfile.TemporaryDirectory(prefix="radio-flash-") as directory:
        staged = []
        for address, source in sorted(images):
            target = Path(directory) / f"{address:08x}.bin"
            with target.open("xb") as output:
                os.chmod(target, 0o600)
                _copy(source, output)
            staged.append((address, target))
        bases = cache.bases([address for address, _ in staged]) if cache else []
        options = []
        if not full:
            if any(bases):
                options = ["--diff-with", *(str(path) if path else "skip" for path in bases)]
            else:
                options = ["--skip-flashed"]
        # A following option terminates esptool's variadic --diff-with list.
        command = base_command + ["write-flash", *options, "--flash-mode", "dout", "--flash-size", "32MB", "--flash-freq", "80m"]
        for address, path in staged:
            command.extend([hex(address), str(path)])
        result = run(command)
        if result.returncode == 0 and cache:
            cache.remember(staged)
        return result.returncode
