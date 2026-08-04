"""Case contract v1.0.

A case file describes one gallery output: the input curves/surfaces
that produced it, the expected metrics, and the resulting geometry
(mesh + NURBS + debug markers).

Required shape (top-level):
{
  "schema_version": "1.0",
  "caseName": str,
  "curves": [curve, ...],             # input section/spine/guide curves
  "surfaces": [surface, ...],         # optional input surfaces
  "support_surfaces": [surface, ...],
  "constraint_visualizations": [...],  # optional
  "expected_metrics": {...},
  "geometry": {
    "type": "LoftedSurface",
    "mesh": {"vertices": [...], "normals": [...], "indices": [...]},
    "nurbs": {
      "curves": [...], "surfaces": [...], "support_surfaces": [...],
      "constraint_visualizations": [...]
    },
    "debugMarkers": {"singularities": [...]}
  }
}

The validator checks structural integrity; it does NOT semantically
verify the geometry (no continuity check, no closure check). That is
the kernel's responsibility. The contract guarantees the data shape
that the viewer's parser (`GeometryParser.js`) can rely on.
"""

from __future__ import annotations

from typing import Any

from ._errors import ContractError
from ._helpers import (
    require, require_str, require_list, require_number,
    optional_dict, optional_list,
)


CASE_V1 = "1.0"

VALID_GEOMETRY_TYPES = frozenset({
    "LoftedSurface",
})

VALID_CURVE_TYPES = frozenset({
    "section",
    "spine",
    "guide",
    "section_target",
})

_REQUIRED_CURVE_FIELDS = {
    "section":        ("control_points", "knots", "p", "t_min", "t_max", "is_periodic"),
    "spine":          ("control_points", "knots", "p", "t_min", "t_max", "is_periodic"),
    "guide":          ("control_points", "knots", "p", "t_min", "t_max", "is_periodic"),
    "section_target": ("control_points", "knots", "p", "t_min", "t_max", "is_periodic"),
}

_OPTIONAL_CURVE_FIELDS = {"label", "u_param"}


def validate_case_v1(data: Any) -> None:
    """Raise ContractError on any violation. Returns None on success."""

    schema_version = require_str(data, key="schema_version")
    if schema_version != CASE_V1:
        raise ContractError(
            f"case.schema_version must be {CASE_V1!r}, got {schema_version!r}",
            code="UNSUPPORTED_SCHEMA_VERSION")

    case_name = require_str(data, key="caseName")
    if len(case_name) > 256:
        raise ContractError("caseName too long (>256 chars)",
                            code="NAME_TOO_LONG")

    curves = require_list(data, key="curves", min_len=0)
    for i, c in enumerate(curves):
        _validate_curve(c, path=f"curves[{i}]")

    if "surfaces" in data:
        for i, s in enumerate(require_list(data, key="surfaces")):
            _validate_surface(s, path=f"surfaces[{i}]")

    if "support_surfaces" in data:
        for i, s in enumerate(require_list(data, key="support_surfaces")):
            _validate_surface(s, path=f"support_surfaces[{i}]",
                              kind="support_surface")

    if "constraint_visualizations" in data:
        for i, cv in enumerate(require_list(data, key="constraint_visualizations")):
            _validate_constraint_visualization(cv, path=f"constraint_visualizations[{i}]")

    if "expected_metrics" in data:
        em = require(data, key="expected_metrics")
        if not isinstance(em, dict):
            raise ContractError.at("expected_metrics",
                "must be object, got " + type(em).__name__,
                code="TYPE_ERROR")
        if "tolerance" in em:
            tol = require_number(em, key="tolerance", min_value=0.0)
            if tol > 1.0:
                raise ContractError(
                    "expected_metrics.tolerance must be in [0,1]",
                    code="VALUE_OUT_OF_RANGE")

    geometry = require(data, key="geometry")
    if not isinstance(geometry, dict):
        raise ContractError.at("geometry",
            "must be object, got " + type(geometry).__name__,
            code="TYPE_ERROR")
    geo_type = require_str(geometry, key="type")
    if geo_type not in VALID_GEOMETRY_TYPES:
        allowed_list = ", ".join(sorted(VALID_GEOMETRY_TYPES))
        raise ContractError.at("geometry",
            f"'type' must be one of [{allowed_list}], got '{geo_type}'",
            code="ENUM_VIOLATION")

    _validate_mesh(geometry)
    _validate_nurbs(geometry)
    _validate_debug_markers(geometry)


def _validate_curve(c: Any, *, path: str) -> None:
    if not isinstance(c, dict):
        raise ContractError.at(path,
            f"expected object, got {type(c).__name__}",
            code="TYPE_ERROR")
    ctype = require_str(c, key="type", path=path)
    if ctype not in VALID_CURVE_TYPES:
        allowed_list = ", ".join(sorted(VALID_CURVE_TYPES))
        raise ContractError.at(path,
            f"'type' must be one of [{allowed_list}], got '{ctype}'",
            code="ENUM_VIOLATION")
    required = _REQUIRED_CURVE_FIELDS.get(ctype, ())
    for k in required:
        require(c, key=k, path=path)
    cps = require(c, key="control_points", path=path)
    if not isinstance(cps, list):
        raise ContractError.at(f"{path}.control_points",
            "must be list, got " + type(cps).__name__,
            code="TYPE_ERROR")
    if not cps:
        raise ContractError.at(path, "control_points must be non-empty",
                              code="EMPTY_LIST")
    for j, pt in enumerate(cps):
        _validate_point3(pt, path=f"{path}.control_points[{j}]")
    knots = require(c, key="knots", path=path)
    if not isinstance(knots, list):
        raise ContractError.at(f"{path}.knots",
            "must be list, got " + type(knots).__name__,
            code="TYPE_ERROR")
    if not knots:
        raise ContractError.at(path, "knots must be non-empty",
                              code="EMPTY_LIST")
    p = require_number(c, key="p", min_value=1)
    is_periodic_raw = require(c, key="is_periodic", path=path)
    if not isinstance(is_periodic_raw, bool):
        raise ContractError.at(path,
            f"'is_periodic' must be bool, got {type(is_periodic_raw).__name__}",
            code="TYPE_ERROR")
    expected_knots_min = 2 * p + 2 if not is_periodic_raw else 2 * p + 1
    if len(knots) < expected_knots_min:
        raise ContractError.at(
            path,
            f"knots length ({len(knots)}) below minimum ({expected_knots_min}) "
            f"for p={p}{' periodic' if is_periodic_raw else ''}",
            code="KNOTS_TOO_SHORT")
    t_min = require_number(c, key="t_min")
    t_max = require_number(c, key="t_max")
    if t_max <= t_min:
        raise ContractError.at(path,
            f"t_max ({t_max}) must be > t_min ({t_min})",
            code="T_RANGE_INVALID")


def _validate_surface(s: Any, *, path: str, kind: str = "surface") -> None:
    if not isinstance(s, dict):
        raise ContractError.at(path,
            f"expected object, got {type(s).__name__}",
            code="TYPE_ERROR")
    cps = require(s, key="control_points", path=path)
    if not isinstance(cps, list):
        raise ContractError.at(f"{path}.control_points",
            "must be list, got " + type(cps).__name__,
            code="TYPE_ERROR")
    for j, pt in enumerate(cps):
        _validate_point3(pt, path=f"{path}.control_points[{j}]")
    require(s, key="knots_u", path=path)
    require(s, key="knots_v", path=path)
    p_u = require_number(s, key="p_u", min_value=1)
    p_v = require_number(s, key="p_v", min_value=1)


def _validate_constraint_visualization(cv: Any, *, path: str) -> None:
    if not isinstance(cv, dict):
        raise ContractError.at(path,
            f"expected object, got {type(cv).__name__}",
            code="TYPE_ERROR")
    if "kind" in cv:
        kind = cv["kind"]
        if not isinstance(kind, str):
            raise ContractError.at(f"{path}.kind",
                "must be str, got " + type(kind).__name__,
                code="TYPE_ERROR")


def _validate_point3(pt: Any, *, path: str) -> None:
    if not isinstance(pt, dict):
        raise ContractError.at(path,
            f"expected object, got {type(pt).__name__}",
            code="TYPE_ERROR")
    for k in ("x", "y", "z"):
        if k not in pt:
            raise ContractError.at(path, f"missing '{k}'", code="MISSING_KEY")
        v = pt[k]
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            raise ContractError.at(path,
                f"'{k}' must be number, got {type(v).__name__}",
                code="TYPE_ERROR")


def _validate_mesh(geometry: dict) -> None:
    mesh = require(geometry, key="mesh")
    if not isinstance(mesh, dict):
        raise ContractError.at("geometry.mesh",
            "must be object, got " + type(mesh).__name__,
            code="TYPE_ERROR")
    for k in ("vertices", "normals", "indices"):
        v = require(mesh, key=k)
        if not isinstance(v, list):
            raise ContractError.at(f"geometry.mesh.{k}",
                "must be list, got " + type(v).__name__,
                code="TYPE_ERROR")
        for j, x in enumerate(v):
            if not isinstance(x, (int, float)) or isinstance(x, bool):
                raise ContractError.at(f"geometry.mesh.{k}[{j}]",
                    "must be number, got " + type(x).__name__,
                    code="TYPE_ERROR")
    v_n = len(mesh["vertices"])
    n_n = len(mesh["normals"])
    if v_n != n_n:
        raise ContractError(
            f"geometry.mesh.vertices ({v_n}) and normals ({n_n}) "
            f"must have equal length (3 floats per vertex)",
            code="MESH_LENGTH_MISMATCH")
    if v_n % 3 != 0:
        raise ContractError(
            f"geometry.mesh.vertices length ({v_n}) must be a multiple of 3",
            code="MESH_LENGTH_INVALID")
    if len(mesh["indices"]) % 3 != 0:
        raise ContractError(
            f"geometry.mesh.indices length must be a multiple of 3",
            code="MESH_LENGTH_INVALID")


def _validate_nurbs(geometry: dict) -> None:
    nurbs = require(geometry, key="nurbs")
    if not isinstance(nurbs, dict):
        raise ContractError.at("geometry.nurbs",
            "must be object, got " + type(nurbs).__name__,
            code="TYPE_ERROR")
    for k in ("curves", "surfaces", "support_surfaces", "constraint_visualizations"):
        if k in nurbs:
            v = nurbs[k]
            if not isinstance(v, list):
                raise ContractError.at(f"geometry.nurbs.{k}",
                    "must be list, got " + type(v).__name__,
                    code="TYPE_ERROR")


def _validate_debug_markers(geometry: dict) -> None:
    dbg = require(geometry, key="debugMarkers")
    if not isinstance(dbg, dict):
        raise ContractError.at("geometry.debugMarkers",
            "must be object, got " + type(dbg).__name__,
            code="TYPE_ERROR")
    if "singularities" in dbg:
        v = dbg["singularities"]
        if not isinstance(v, list):
            raise ContractError.at("geometry.debugMarkers.singularities",
                "must be list, got " + type(v).__name__,
                code="TYPE_ERROR")