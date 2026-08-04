# geometry-studio-viewer Contracts

Versioned, code-as-contract validators that gate JSON inputs to the
viewer.

## What is a contract here

A **contract** is a Python module that, given a parsed JSON object,
either:

- returns silently — the input satisfies the contract, OR
- raises `ContractError` — the input violates the contract.

There is no document. The contract **is** the validator. Passing it
**is** the certification.

## Versions shipped

| Contract | Version | Validates |
|---|---|---|
| `manifest_v1` | `1.0` | The top-level `manifest.json` enumerating cases |
| `case_v1`     | `1.0` | A single case JSON (geometry output envelope) |

The top-level `schema_version` field on each JSON selects the contract:

- `manifest.json` must carry `"schema_version": "1.0"`
- each case file must carry `"schema_version": "1.0"`

The viewer and kernel-app agree on these version strings.

## Usage

### As a library (Python)

```python
from contracts import validate_manifest_v1, validate_case_v1, ContractError
import json

with open("manifest.json") as f:
    data = json.load(f)
try:
    validate_manifest_v1(data)
except ContractError as e:
    print(f"FAIL: code={e.code} path={e.path} message={e}")
    raise
```

### As a CLI

```bash
# Single file (auto-detects contract from schema_version).
python -m contracts validate path/to/manifest.json
python -m contracts validate path/to/gallery_outputs/case_xxx.json

# Manifest + all referenced cases (kernel-app CI gate).
python -m contracts validate-dir kernel-app/data/manifest.json

# Print package version.
python -m contracts schema-version
```

### CI gate integration

In `kernel-app` CI, after Gallery runs and writes
`kernel-app/data/gallery_outputs/*.json` + `manifest.json`:

```bash
python -m contracts validate-dir kernel-app/data/manifest.json
```

Non-zero exit fails the build. The viewer trusts the JSON iff this
gate passes.

## Bumping a contract

1. Copy `_v1.py` → `_v2.py` in this directory.
2. Update `MANIFEST_V1`/`CASE_V1` constants (e.g. `"2.0"`).
3. Update `_helpers` if the cross-cutting checks change.
4. Add a `_v1 → _v2` migration helper if you want automatic upgrade.
5. Bump the kernel-app writer to emit `schema_version: "2.0"`.
6. Until kernel-app ships the new version, the validator rejects
   `1.0` inputs as `UNSUPPORTED_SCHEMA_VERSION`.

The viewer consumes whatever `schema_version` it sees; the validator
rejects all but the package's current version. No silent fall-through.

## Directory layout

```
contracts/
├── __init__.py        # public exports
├── __main__.py        # CLI entry point (`python -m contracts ...`)
├── _errors.py         # ContractError
├── _helpers.py        # shared require_* helpers
├── manifest_v1.py     # manifest validator
└── case_v1.py         # case validator
```

## Error codes (machine-readable via `ContractError.code`)

| Code | Meaning |
|---|---|
| `CONTRACT_VIOLATION` | Generic contract violation |
| `UNSUPPORTED_SCHEMA_VERSION` | `schema_version` is not the package's current version |
| `MISSING_KEY` | Required field absent |
| `TYPE_ERROR` | Field is the wrong Python type |
| `EMPTY_LIST` | List field has zero items where at least one is required |
| `LIST_TOO_SHORT` / `LIST_TOO_LONG` | List length outside the allowed range |
| `BAD_FILE_EXT` / `BAD_FILE_PATH` | Manifest entry's `file` field is malformed |
| `DUPLICATE_ID` | Manifest contains two entries with the same `id` |
| `COUNT_MISMATCH` | `manifest.count` ≠ `len(manifest.cases)` |
| `EMPTY_STRING` | Required string field is empty |
| `VALUE_OUT_OF_RANGE` | Number outside the allowed `[min,max]` |
| `ENUM_VIOLATION` | String not in the documented allowlist |
| `NAME_TOO_LONG` | Display-name string is too long |
| `MESH_LENGTH_MISMATCH` | `vertices` and `normals` arrays disagree |
| `MESH_LENGTH_INVALID` | Mesh array length not a multiple of 3 |
| `KNOTS_TOO_SHORT` | Knot vector shorter than `2p+2` (or `2p+1` if periodic) |
| `T_RANGE_INVALID` | `t_max <= t_min` |
| `JSON_PARSE_ERROR` | File is not valid JSON |
| `TAG_PREFIX_UNKNOWN` | Tag uses a prefix outside the documented set |

CI scripts can switch on `ContractError.code` for actionable messages.