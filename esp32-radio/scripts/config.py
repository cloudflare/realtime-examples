"""Read single-line dotenv values without evaluating shell expressions."""
import re

ENV_ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")


def read_env(path):
    values = {}
    if path.exists():
        for number, line in enumerate(path.read_text().splitlines(), 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            match = ENV_ASSIGNMENT.fullmatch(line)
            if not match:
                raise SystemExit(f"{path.name}:{number}: expected NAME=value")
            key, raw = match.groups()
            if key in values:
                raise SystemExit(f"{path.name}:{number}: duplicate {key}")
            if raw.startswith(("'", '"', "`")):
                quote = raw[0]
                end = raw.find(quote, 1)
                if end < 0 or (raw[end + 1:].strip() and not raw[end + 1:].lstrip().startswith("#")):
                    raise SystemExit(
                        f"{path.name}:{number}: wrap {key} in a quote style absent from its value"
                    )
                value = raw[1:end]
                if quote == '"':
                    value = value.replace("\\n", "\n").replace("\\r", "\r")
            else:
                value = raw.split("#", 1)[0].strip()
            if any(character in value for character in ("\n", "\r", "\0")):
                raise SystemExit(f"{path.name}:{number}: {key} must be a single-line value")
            values[key] = value
    return values


def env_value(key, value):
    """Quote a literal value identically for this reader, Node and Wrangler."""
    if any(character in value for character in ("\n", "\r", "\0")):
        raise SystemExit(f"{key} must be a single-line value")
    for quote in ("'", '"', "`"):
        if quote in value:
            continue
        if quote == '"' and ("\\n" in value or "\\r" in value):
            continue
        return f"{quote}{value}{quote}"
    raise SystemExit(f"{key} needs a value that can be wrapped in one dotenv quote style")
