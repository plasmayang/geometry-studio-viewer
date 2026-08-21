"""Case contract v1.0 / v1.1.

A case file describes one gallery output: the input curves/surfaces
that produced it, the expected metrics, and the resulting geometry
(mesh + NURBS + debug markers).

Required shape (top-level, v1.0):
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

v1.1 EXTENSIONS (backward-compatible optional fields, added 2026-08-21):

  "process_audit": {                  # Phase 0/8 attachment + bounds reports
    "profile_attachment": [...],      # per-profile max_distance (sorted v)
    "guide_attachment": [...],        # per-guide max_distance
    "surface_bounds": {...},          # z_min/z_max/out_of_bounds_cps
    "psi_kronecker_residual": number,  # max Kronecker residual over all bases
    "psi_identity_residual": number   # max S_norm(u, v_m) vs profile_m(u) dist
  }

  "intermediate_products": {          # cp-propagation Phase 2-5 intermediates
    "u_global_pre": [...],            # per-profile pre-alignment u-knot vectors
    "u_global_post": [...],           # U_global post-alignment knot vector
    "v_knots": [...],                 # final v-knot vector after Oslo algorithm
    "v_stations": [...],              # profile v-station parameters
    "psi_basis": {                    # sampled Ψ_m^{(d)}(v) curves
        "v_grid": [...],               # sampling grid on v
        "samples": [                   # one entry per (anchor, derivative)
          {"anchor": int, "d": int, "values": [...]},
          ...
        ]
    },
    "s_norm_cp": {                    # 2D nominal manifold control points
        "p_u": int, "p_v": int,
        "knots_u": [...], "knots_v": [...],
        "control_points": [...]        # flat [x,y,z,w, x,y,z,w, ...]
    },
    "chord_frames": [...],            # per v_station chord frame (origin, T, N, B)
    "real_frames": [...],             # per v_station real frame (Wang-Jüttler RMF)
    "tangent_residuals": [...]        # per profile CP: orthogonal rejection from spine tangent
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
SUPPORTED_CASE_VERSIONS = frozenset({"1.0", "1.1"})

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
    if schema_version not in SUPPORTED_CASE_VERSIONS:
        allowed = ", ".join(sorted(SUPPORTED_CASE_VERSIONS))
        raise ContractError(
            f"case.schema_version must be one of [{allowed}], "
            f"got {schema_version!r}",
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

    # v1.1 extensions (optional, backward-compatible).
    if "process_audit" in data:
        _validate_process_audit(data["process_audit"])
    if "intermediate_products" in data:
        _validate_intermediate_products(data["intermediate_products"])


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


# ===========================================================================
# v1.1 extension validators
# ===========================================================================

def _validate_process_audit(pa: Any) -> None:
    """Validate the process_audit block. All keys are optional; values
    follow the report POD schema used by kernel-algo's diagnostics
    layer (ProfileAdhesionReport / GuideAttachmentReport /
    SurfaceBoundsReport)."""
    if not isinstance(pa, dict):
        raise ContractError.at("process_audit",
            "must be object, got " + type(pa).__name__,
            code="TYPE_ERROR")
    if "profile_attachment" in pa:
        for i, p in enumerate(require_list(pa, key="profile_attachment")):
            _validate_adhesion_report(p, path=f"process_audit.profile_attachment[{i}]")
    if "guide_attachment" in pa:
        for i, g in enumerate(require_list(pa, key="guide_attachment")):
            _validate_adhesion_report(g, path=f"process_audit.guide_attachment[{i}]")
    if "surface_bounds" in pa:
        _validate_surface_bounds(pa["surface_bounds"], path="process_audit.surface_bounds")
    for key in ("psi_kronecker_residual", "psi_identity_residual"):
        if key in pa:
            v = pa[key]
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                raise ContractError.at(f"process_audit.{key}",
                    f"must be number, got {type(v).__name__}",
                    code="TYPE_ERROR")
            if v < 0:
                raise ContractError.at(f"process_audit.{key}",
                    f"must be non-negative, got {v}",
                    code="VALUE_OUT_OF_RANGE")


def _validate_adhesion_report(r: Any, *, path: str) -> None:
    if not isinstance(r, dict):
        raise ContractError.at(path,
            f"expected object, got {type(r).__name__}",
            code="TYPE_ERROR")
    for k in ("profile_index", "guide_index"):
        if k in r:
            v = r[k]
            if not isinstance(v, int) or isinstance(v, bool):
                raise ContractError.at(f"{path}.{k}",
                    f"must be integer, got {type(v).__name__}",
                    code="TYPE_ERROR")
    for k in ("v_param", "max_distance", "mean_distance", "t_at_max", "u_at_max"):
        if k in r:
            v = r[k]
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                raise ContractError.at(f"{path}.{k}",
                    f"must be number, got {type(v).__name__}",
                    code="TYPE_ERROR")
    if "per_sample_distances" in r:
        v = r["per_sample_distances"]
        if not isinstance(v, list):
            raise ContractError.at(f"{path}.per_sample_distances",
                f"must be list, got {type(v).__name__}",
                code="TYPE_ERROR")


def _validate_surface_bounds(b: Any, *, path: str) -> None:
    if not isinstance(b, dict):
        raise ContractError.at(path,
            f"expected object, got {type(b).__name__}",
            code="TYPE_ERROR")
    for k in ("z_min", "z_max", "expected_z_lo", "expected_z_hi"):
        if k in b:
            v = b[k]
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                raise ContractError.at(f"{path}.{k}",
                    f"must be number, got {type(v).__name__}",
                    code="TYPE_ERROR")
    if "out_of_bounds_cps" in b:
        v = b["out_of_bounds_cps"]
        if not isinstance(v, int) or isinstance(v, bool):
            raise ContractError.at(f"{path}.out_of_bounds_cps",
                f"must be integer, got {type(v).__name__}",
                code="TYPE_ERROR")


def _validate_intermediate_products(ip: Any) -> None:
    """Validate the intermediate_products block. All keys are optional;
    each value is a flat array of numbers or a structured nested
    object per the kernel-side dump layout."""
    if not isinstance(ip, dict):
        raise ContractError.at("intermediate_products",
            "must be object, got " + type(ip).__name__,
            code="TYPE_ERROR")
    for arr_key in ("u_global_post", "v_knots",
                    "v_stations", "tangent_residuals"):
        if arr_key in ip:
            _validate_number_array(ip[arr_key],
                                   path=f"intermediate_products.{arr_key}")
    if "u_global_pre" in ip:
        _validate_knot_vector_list(ip["u_global_pre"],
                                   path="intermediate_products.u_global_pre")
    if "psi_basis" in ip:
        _validate_psi_basis(ip["psi_basis"])
    if "s_norm_cp" in ip:
        _validate_s_norm_cp(ip["s_norm_cp"])
    for frame_key in ("chord_frames", "real_frames"):
        if frame_key in ip:
            _validate_frame_list(ip[frame_key],
                                 path=f"intermediate_products.{frame_key}")


def _validate_number_array(arr: Any, *, path: str) -> None:
    if not isinstance(arr, list):
        raise ContractError.at(path,
            f"must be list, got {type(arr).__name__}",
            code="TYPE_ERROR")
    for j, v in enumerate(arr):
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            raise ContractError.at(f"{path}[{j}]",
                f"must be number, got {type(v).__name__}",
                code="TYPE_ERROR")


def _validate_knot_vector_list(arr: Any, *, path: str) -> None:
    if not isinstance(arr, list):
        raise ContractError.at(path,
            f"must be list, got {type(arr).__name__}",
            code="TYPE_ERROR")
    for i, vec in enumerate(arr):
        if not isinstance(vec, list):
            raise ContractError.at(f"{path}[{i}]",
                f"must be list of numbers, got {type(vec).__name__}",
                code="TYPE_ERROR")
        for j, v in enumerate(vec):
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                raise ContractError.at(f"{path}[{i}][{j}]",
                    f"must be number, got {type(v).__name__}",
                    code="TYPE_ERROR")


def _validate_psi_basis(pb: Any) -> None:
    if not isinstance(pb, dict):
        raise ContractError.at("intermediate_products.psi_basis",
            "must be object, got " + type(pb).__name__,
            code="TYPE_ERROR")
    if "v_grid" in pb:
        _validate_number_array(pb["v_grid"],
                               path="intermediate_products.psi_basis.v_grid")
    if "samples" in pb:
        samples = pb["samples"]
        if not isinstance(samples, list):
            raise ContractError.at("intermediate_products.psi_basis.samples",
                f"must be list, got {type(samples).__name__}",
                code="TYPE_ERROR")
        for i, s in enumerate(samples):
            if not isinstance(s, dict):
                raise ContractError.at(
                    f"intermediate_products.psi_basis.samples[{i}]",
                    f"must be object, got {type(s).__name__}",
                    code="TYPE_ERROR")
            for k in ("anchor", "d"):
                if k in s and (not isinstance(s[k], int) or isinstance(s[k], bool)):
                    raise ContractError.at(
                        f"intermediate_products.psi_basis.samples[{i}].{k}",
                        f"must be integer, got {type(s[k]).__name__}",
                        code="TYPE_ERROR")
            if "values" in s:
                _validate_number_array(
                    s["values"],
                    path=f"intermediate_products.psi_basis.samples[{i}].values")


def _validate_s_norm_cp(s: Any) -> None:
    if not isinstance(s, dict):
        raise ContractError.at("intermediate_products.s_norm_cp",
            "must be object, got " + type(s).__name__,
            code="TYPE_ERROR")
    for k in ("p_u", "p_v"):
        if k in s and (not isinstance(s[k], int) or isinstance(s[k], bool)):
            raise ContractError.at(f"intermediate_products.s_norm_cp.{k}",
                f"must be integer, got {type(s[k]).__name__}",
                code="TYPE_ERROR")
    for k in ("knots_u", "knots_v"):
        if k in s:
            _validate_number_array(s[k],
                                   path=f"intermediate_products.s_norm_cp.{k}")
    if "control_points" in s:
        _validate_number_array(s["control_points"],
                               path="intermediate_products.s_norm_cp.control_points")


def _validate_frame_list(frames: Any, *, path: str) -> None:
    if not isinstance(frames, list):
        raise ContractError.at(path,
            f"must be list, got {type(frames).__name__}",
            code="TYPE_ERROR")
    for i, f in enumerate(frames):
        if not isinstance(f, dict):
            raise ContractError.at(f"{path}[{i}]",
                f"must be object, got {type(f).__name__}",
                code="TYPE_ERROR")
        for k in ("v_param", "origin", "tangent", "normal", "binormal"):
            if k in f:
                v = f[k]
                if k == "v_param":
                    if not isinstance(v, (int, float)) or isinstance(v, bool):
                        raise ContractError.at(f"{path}[{i}].{k}",
                            f"must be number, got {type(v).__name__}",
                            code="TYPE_ERROR")
                else:
                    _validate_number_array(v, path=f"{path}[{i}].{k}")