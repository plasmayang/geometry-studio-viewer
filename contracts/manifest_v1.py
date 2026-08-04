"""Manifest contract v1.0.

The manifest enumerates the cases a data source offers to the viewer.
Each entry carries a `file` pointer relative to the data root; the
viewer resolves it via the active data source (directory or protocol).

Required shape:
{
  "schema_version": "1.0",
  "version": "1.0",
  "count": int,
  "cases": [
    {
      "file": str,                # relative path under data root
      "id": str,                  # stable identifier (unique within manifest)
      "name": str,
      "tags": [str, ...],         # at least 1 tag
      "type": str,                # e.g. "LoftedSurface"
      "version": str              # per-case format version
    },
    ...
  ]
}

Passing this validator == satisfying the manifest contract.
"""

from __future__ import annotations

from typing import Any, Iterable

from ._errors import ContractError
from ._helpers import (
    require, require_str, require_list, require_number,
    optional_str, check_tag_shape,
)


MANIFEST_V1 = "1.0"

VALID_CASE_TYPES = frozenset({
    "LoftedSurface",
})


def validate_manifest_v1(data: Any) -> None:
    """Raise ContractError on any violation. Returns None on success."""

    schema_version = require_str(data, key="schema_version")
    if schema_version != MANIFEST_V1:
        raise ContractError(
            f"manifest.schema_version must be {MANIFEST_V1!r}, "
            f"got {schema_version!r}",
            code="UNSUPPORTED_SCHEMA_VERSION")

    version = require_str(data, key="version")
    count = require_number(data, key="count", min_value=0)
    cases = require_list(data, key="cases", min_len=1)
    if count != len(cases):
        raise ContractError(
            f"manifest.count ({count}) must equal len(cases) ({len(cases)})",
            code="COUNT_MISMATCH")

    seen_ids: set[str] = set()
    for i, case in enumerate(cases):
        _validate_case_entry(case, index=i, seen_ids=seen_ids)


def _validate_case_entry(case: Any, *, index: int,
                         seen_ids: set[str]) -> None:
    if not isinstance(case, dict):
        raise ContractError.at(f"cases[{index}]",
            f"expected object, got {type(case).__name__}",
            code="TYPE_ERROR")
    path = f"cases[{index}]"

    file_rel = require_str(case, key="file", path=path)
    if not file_rel.endswith(".json"):
        raise ContractError.at(
            path,
            f"file must end with '.json', got {file_rel!r}",
            code="BAD_FILE_EXT")
    if "\\" in file_rel or file_rel.startswith("/"):
        raise ContractError.at(
            path,
            f"file must be a relative posix-style path, got {file_rel!r}",
            code="BAD_FILE_PATH")

    cid = require_str(case, key="id", path=path)
    if cid in seen_ids:
        raise ContractError.at(
            path, f"duplicate case id {cid!r}", code="DUPLICATE_ID")
    seen_ids.add(cid)

    name = require_str(case, key="name", path=path)
    if len(name) > 200:
        raise ContractError.at(
            path, f"name too long ({len(name)} chars, max 200)",
            code="NAME_TOO_LONG")

    tags = require_list(case, key="tags", path=path, min_len=1, max_len=32)
    for j, tag in enumerate(tags):
        if not isinstance(tag, str):
            raise ContractError.at(
                f"{path}.tags[{j}]",
                f"tag must be str, got {type(tag).__name__}",
                code="TYPE_ERROR")
        check_tag_shape(tag, path=f"{path}.tags[{j}]")

    case_type = require_str(case, key="type", path=path)
    if case_type not in VALID_CASE_TYPES:
        allowed_list = ", ".join(sorted(VALID_CASE_TYPES))
        raise ContractError.at(path,
            f"'type' must be one of [{allowed_list}], got '{case_type}'",
            code="ENUM_VIOLATION")

    require_str(case, key="version", path=path)
    # Per-case version is independently evolving; we accept any non-empty string.

    optional_str(case, key="description", path=path)
    optional_str(case, key="intent_space", path=path)
    optional_str(case, key="success_criteria", path=path)