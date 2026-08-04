"""CLI entry point for contract validators.

Usage:
    python -m contracts validate <file>
        Detect schema_version, dispatch to the matching validator.
        Exit 0 on success, non-zero on ContractError.

    python -m contracts validate-dir <manifest-file>
        Validate manifest, then validate every referenced case file.
        Print summary; exit 0 only if all pass.

    python -m contracts schema-version
        Print the package version (1.0).

The CLI is the integration point for kernel-app CI: each Gallery output
JSON must pass this gate before it is published.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from ._errors import ContractError
from .manifest_v1 import validate_manifest_v1, MANIFEST_V1
from .case_v1 import validate_case_v1, CASE_V1
from . import PACKAGE_VERSION


def _read_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise ContractError(f"invalid JSON: {e}",
                            code="JSON_PARSE_ERROR", path=str(path))


def cmd_validate(path: str) -> int:
    p = Path(path)
    data = _read_json(p)
    sv = data.get("schema_version")
    if sv == MANIFEST_V1:
        validator = validate_manifest_v1
        label = "manifest"
    elif sv == CASE_V1:
        validator = validate_case_v1
        label = "case"
    else:
        print(f"FAIL: {path}: unsupported schema_version={sv!r}; "
              f"this package implements v{PACKAGE_VERSION}", file=sys.stderr)
        return 2
    try:
        validator(data)
    except ContractError as e:
        print(f"FAIL: {e}", file=sys.stderr)
        return 1
    print(f"OK:   {path} ({label} v{sv})")
    return 0


def cmd_validate_dir(manifest_path: str) -> int:
    p = Path(manifest_path)
    data = _read_json(p)
    try:
        validate_manifest_v1(data)
    except ContractError as e:
        print(f"FAIL: manifest {p}: {e}", file=sys.stderr)
        return 1
    cases = data.get("cases", [])
    base = p.parent
    failed = 0
    passed = 0
    for c in cases:
        file_rel = c["file"]
        case_path = base / file_rel
        if not case_path.exists():
            print(f"FAIL: case file not found: {case_path}",
                  file=sys.stderr)
            failed += 1
            continue
        cdata = _read_json(case_path)
        try:
            validate_case_v1(cdata)
        except ContractError as e:
            print(f"FAIL: {case_path}: {e}", file=sys.stderr)
            failed += 1
            continue
        print(f"OK:   {case_path}")
        passed += 1
    print(f"\nSummary: {passed} passed, {failed} failed "
          f"({len(cases)} total)")
    return 0 if failed == 0 else 1


def cmd_schema_version() -> int:
    print(f"contracts package v{PACKAGE_VERSION}")
    print(f"  manifest_v1 = {MANIFEST_V1}")
    print(f"  case_v1     = {CASE_V1}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="contracts",
        description="geometry-studio-viewer data contract validators")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_validate = sub.add_parser("validate", help="validate a single file")
    p_validate.add_argument("path")

    p_validate_dir = sub.add_parser("validate-dir",
                                    help="validate manifest + all cases")
    p_validate_dir.add_argument("manifest")

    p_version = sub.add_parser("schema-version", help="print package version")

    args = parser.parse_args(argv)
    if args.cmd == "validate":
        return cmd_validate(args.path)
    if args.cmd == "validate-dir":
        return cmd_validate_dir(args.manifest)
    if args.cmd == "schema-version":
        return cmd_schema_version()
    return 2


if __name__ == "__main__":
    sys.exit(main())