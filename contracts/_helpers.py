"""Shared helpers for contract validators.

All helpers raise `ContractError` on violation; they never return a
silent-default. Validators compose these helpers; they do not call into
each other directly.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from ._errors import ContractError


# ----- Type-shape helpers -------------------------------------------------

def require(data: Any, *, key: str, path: str = "") -> Any:
    """Return `data[key]` or raise ContractError."""
    if not isinstance(data, Mapping):
        raise ContractError.at(path, f"expected object, got {type(data).__name__}",
                              code="TYPE_ERROR")
    if key not in data:
        raise ContractError.at(path, f"missing required key '{key}'",
                              code="MISSING_KEY")
    return data[key]


def require_type(value: Any, *types: type, path: str = "", key: str = "") -> Any:
    label = f"'{key}'" if key else "value"
    if not isinstance(value, types):
        names = " | ".join(t.__name__ for t in types)
        got = type(value).__name__
        raise ContractError.at(path, f"{label} must be {names}, got {got}",
                              code="TYPE_ERROR")
    return value


def require_str(data: Any, *, key: str, path: str = "") -> str:
    """Extract `data[key]` and verify it is a non-empty string."""
    value = require(data, key=key, path=path)
    if not isinstance(value, str):
        raise ContractError.at(path,
            f"'{key}' must be str, got {type(value).__name__}",
            code="TYPE_ERROR")
    if not value:
        raise ContractError.at(path, f"'{key}' must be non-empty string",
                              code="EMPTY_STRING")
    return value


def require_list(data: Any, *, key: str, path: str = "",
                 min_len: int = 0, max_len: int | None = None) -> list:
    """Extract `data[key]` and verify it is a list with optional length bounds."""
    value = require(data, key=key, path=path)
    if not isinstance(value, list):
        raise ContractError.at(path,
            f"'{key}' must be list, got {type(value).__name__}",
            code="TYPE_ERROR")
    if len(value) < min_len:
        raise ContractError.at(
            path, f"'{key}' must have at least {min_len} items, got {len(value)}",
            code="LIST_TOO_SHORT")
    if max_len is not None and len(value) > max_len:
        raise ContractError.at(
            path, f"'{key}' must have at most {max_len} items, got {len(value)}",
            code="LIST_TOO_LONG")
    return value


def require_number(data: Any, *, key: str, path: str = "",
                   min_value: float | None = None,
                   max_value: float | None = None) -> float | int:
    """Extract `data[key]` and verify it is a number with optional range."""
    value = require(data, key=key, path=path)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ContractError.at(path,
            f"'{key}' must be number, got {type(value).__name__}",
            code="TYPE_ERROR")
    if min_value is not None and value < min_value:
        raise ContractError.at(path,
            f"'{key}' must be >= {min_value}, got {value}",
            code="VALUE_OUT_OF_RANGE")
    if max_value is not None and value > max_value:
        raise ContractError.at(path,
            f"'{key}' must be <= {max_value}, got {value}",
            code="VALUE_OUT_OF_RANGE")
    return value


def require_enum(data: Any, allowed: Iterable[str], *,
                 key: str, path: str = "") -> str:
    """Extract `data[key]` and verify it is one of `allowed`."""
    value = require(data, key=key, path=path)
    if not isinstance(value, str):
        raise ContractError.at(path,
            f"'{key}' must be str, got {type(value).__name__}",
            code="TYPE_ERROR")
    allowed_set = set(allowed)
    if value not in allowed_set:
        allowed_list = ", ".join(sorted(allowed_set))
        raise ContractError.at(path,
            f"'{key}' must be one of [{allowed_list}], got '{value}'",
            code="ENUM_VIOLATION")
    return value


def optional_str(data: Any, *, key: str, path: str = "") -> str | None:
    """Return data[key] if present and a string; else None."""
    if key not in data:
        return None
    return require_str(data, key=key, path=path)


def require_dict(data: Any, *, key: str, path: str = "") -> dict:
    """Extract data[key] and verify it is a Mapping (object)."""
    value = require(data, key=key, path=path)
    if not isinstance(value, Mapping):
        raise ContractError.at(path,
            f"'{key}' must be object, got {type(value).__name__}",
            code="TYPE_ERROR")
    return value


def optional_dict(data: Any, *, key: str, path: str = "") -> dict | None:
    if key not in data:
        return None
    value = data[key]
    if not isinstance(value, Mapping):
        raise ContractError.at(path,
            f"'{key}' must be object, got {type(value).__name__}",
            code="TYPE_ERROR")
    return value


def optional_list(data: Any, *, key: str, path: str = "") -> list | None:
    if key not in data:
        return None
    value = data[key]
    if not isinstance(value, list):
        raise ContractError.at(path,
            f"'{key}' must be list, got {type(value).__name__}",
            code="TYPE_ERROR")
    return value


# ----- Domain-specific tag set -------------------------------------------

# Tag prefixes used by kernel-app Gallery outputs (TAG_SCHEMA.md).
# Validators DO NOT enforce tag content; they only enforce shape.
VALID_TAG_PREFIXES = frozenset({
    "profile",     # profile:open | profile:closed
    "guide",       # guide:none | guide:single | guide:multi | guide:triple
    "feature",     # feature:curve-driven | feature:support-surface
    "scheme",      # scheme:analytic-cp | scheme:variational-fairing
    "compatibility",  # compatibility:ready | compatibility:experimental
    "topology",    # topology:open | topology:closed
    "shape",       # shape:cylinder | shape:wing | shape:saddle
})


def check_tag_shape(tag: str, *, path: str = "") -> str:
    """Validate a single tag string against the documented prefix set.

    Format: `<prefix>:<value>` where prefix is from VALID_TAG_PREFIXES.
    Tags without a colon are tolerated as legacy/freeform.
    """
    if ":" not in tag:
        return tag
    prefix = tag.split(":", 1)[0]
    if prefix not in VALID_TAG_PREFIXES:
        raise ContractError.at(
            path,
            f"tag '{tag}' uses undeclared prefix '{prefix}'. "
            f"Valid prefixes: {', '.join(sorted(VALID_TAG_PREFIXES))}",
            code="TAG_PREFIX_UNKNOWN")
    return tag