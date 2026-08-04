"""Protocol contract v1.0.

Defines the message schema for the WebSocket-based push protocol.
Producers (kernel-app, any other app) push data to the viewer server,
which broadcasts to all browser viewer clients.

Message envelope:
{
  "schema_version": "1.0",
  "type": "manifest" | "case" | "heartbeat" | "close",
  "app_id": str,                # producer identifier (unique per app)
  "ts": str,                    # RFC3339 timestamp
  "payload": { ... }            # type-specific
}

Passing validate_message_v1(data) == satisfying the protocol contract.
"""

from __future__ import annotations

from typing import Any

from ._errors import ContractError
from ._helpers import (
    require, require_str, require_list, require_dict,
)


PROTOCOL_V1 = "1.0"

# Recognised message types. The validator dispatches by `type`.
VALID_TYPES = frozenset({"manifest", "case", "heartbeat", "close"})

# Heartbeat payload: a beacon, no fields required.
# Manifest payload: {'cases': [...]} — same shape as manifest_v1 cases.
# Case payload: {'file': str, 'id': str, 'name': str, 'tags': [...], 'case': {...}}
#                     The 'case' field carries the full case JSON (v1 contract).
# Close payload: optional {'reason': str}.


def validate_message_v1(data: Any) -> None:
    """Raise ContractError on any violation. Returns None on success."""
    schema_version = require_str(data, key="schema_version")
    if schema_version != PROTOCOL_V1:
        raise ContractError(
            f"protocol.schema_version must be {PROTOCOL_V1!r}, "
            f"got {schema_version!r}",
            code="UNSUPPORTED_SCHEMA_VERSION")

    msg_type = require_str(data, key="type")
    if msg_type not in VALID_TYPES:
        allowed = ", ".join(sorted(VALID_TYPES))
        raise ContractError(
            f"protocol.type must be one of [{allowed}], got '{msg_type}'",
            code="ENUM_VIOLATION")

    app_id = require_str(data, key="app_id")
    if len(app_id) > 64:
        raise ContractError(
            f"protocol.app_id too long ({len(app_id)} chars, max 64)",
            code="APP_ID_TOO_LONG")

    ts = require_str(data, key="ts")
    _validate_rfc3339(ts)

    payload = require_dict(data, key="payload")

    if msg_type == "manifest":
        _validate_manifest_payload(payload)
    elif msg_type == "case":
        _validate_case_payload(payload)
    elif msg_type == "heartbeat":
        _validate_heartbeat_payload(payload)
    elif msg_type == "close":
        _validate_close_payload(payload)


def _validate_rfc3339(ts: str) -> None:
    """Lightweight RFC3339 check: YYYY-MM-DDTHH:MM:SS[.fff][Z|+HH:MM].

    We don't reject other valid ISO 8601 forms; we only catch the
    common "missing the T separator" and "missing the timezone" errors.
    """
    if len(ts) < 20 or "T" not in ts:
        raise ContractError(
            f"protocol.ts must be RFC3339 (got {ts!r})",
            code="BAD_TIMESTAMP")
    # Tail must be Z or ±HH:MM
    tail = ts[-6:] if ts.endswith("Z") is False else "Z"
    if ts.endswith("Z"):
        pass
    elif ts[-6] in "+-" and ts[-5:].isdigit() is False:
        raise ContractError(
            f"protocol.ts timezone offset malformed (got {ts!r})",
            code="BAD_TIMESTAMP")


def _validate_manifest_payload(payload: dict) -> None:
    cases = require_list(payload, key="cases", min_len=1)
    seen_ids: set[str] = set()
    for i, c in enumerate(cases):
        path = f"manifest.cases[{i}]"
        if not isinstance(c, dict):
            raise ContractError.at(path, "must be object",
                                  code="TYPE_ERROR")
        cid = require_str(c, key="id", path=path)
        if cid in seen_ids:
            raise ContractError.at(path, f"duplicate id {cid!r}",
                                  code="DUPLICATE_ID")
        seen_ids.add(cid)
        file_rel = require_str(c, key="file", path=path)
        if not file_rel.endswith(".json"):
            raise ContractError.at(path,
                f"file must end with '.json', got {file_rel!r}",
                code="BAD_FILE_EXT")
        require_str(c, key="name", path=path)
        require_list(c, key="tags", path=path, min_len=0, max_len=32)


def _validate_case_payload(payload: dict) -> None:
    file_rel = require_str(payload, key="file")
    if not file_rel.endswith(".json"):
        raise ContractError(
            f"case.file must end with '.json', got {file_rel!r}",
            code="BAD_FILE_EXT")
    require_str(payload, key="id")
    require_str(payload, key="name")
    require_list(payload, key="tags", min_len=0, max_len=32)
    case = require_dict(payload, key="case")
    # The 'case' field carries the full case JSON. We re-validate it
    # against the case_v1 contract to enforce the same schema.
    from .case_v1 import validate_case_v1
    validate_case_v1(case)


def _validate_heartbeat_payload(payload: dict) -> None:
    # Heartbeat is empty-or-has-flexible-fields. Currently no fields
    # are required. The validator still requires the payload to be a
    # dict (which the caller already ensured).
    pass


def _validate_close_payload(payload: dict) -> None:
    # Close is optional-{reason: str}. No other fields required.
    if "reason" in payload:
        from ._helpers import require_str
        require_str(payload, key="reason")