"""Tests for the contract validators.

Run: python -m unittest discover -s contracts
or:  python -m contracts validate tests/good/manifest.json (CLI smoke).
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from . import validate_manifest_v1, validate_case_v1, ContractError
from .manifest_v1 import MANIFEST_V1
from .case_v1 import CASE_V1


# ---------- Test fixtures -------------------------------------------------

def _make_manifest():
    return {
        "schema_version": MANIFEST_V1,
        "version": "1.0",
        "count": 1,
        "cases": [
            {
                "file": "gallery_outputs/case_xyz.json",
                "id": "case_xyz",
                "name": "Sample Case",
                "tags": ["profile:open", "scheme:analytic-cp"],
                "type": "LoftedSurface",
                "version": "1.0",
            }
        ],
    }


def _make_case():
    return {
        "schema_version": CASE_V1,
        "caseName": "Sample Case",
        "curves": [
            {
                "control_points": [
                    {"x": 0.0, "y": 0.0, "z": 0.0},
                    {"x": 1.0, "y": 0.0, "z": 0.0},
                    {"x": 1.0, "y": 1.0, "z": 0.0},
                    {"x": 0.0, "y": 1.0, "z": 0.0},
                ],
                "is_periodic": False,
                "knots": [0.0, 0.0, 0.0, 1.0, 1.0, 1.0],
                "label": "section_0",
                "p": 2,
                "t_max": 1.0,
                "t_min": 0.0,
                "type": "section",
            }
        ],
        "geometry": {
            "type": "LoftedSurface",
            "mesh": {
                "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
                "normals":  [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                "indices":  [0, 1, 2],
            },
            "nurbs": {
                "curves": [],
                "surfaces": [],
                "support_surfaces": [],
                "constraint_visualizations": [],
            },
            "debugMarkers": {"singularities": []},
        },
    }


# ---------- Manifest tests ------------------------------------------------

class ManifestV1Tests(unittest.TestCase):

    def test_accepts_canonical(self):
        validate_manifest_v1(_make_manifest())  # no raise

    def test_rejects_wrong_schema_version(self):
        m = _make_manifest()
        m["schema_version"] = "2.0"
        with self.assertRaises(ContractError) as ctx:
            validate_manifest_v1(m)
        self.assertEqual(ctx.exception.code, "UNSUPPORTED_SCHEMA_VERSION")

    def test_rejects_missing_schema_version(self):
        m = _make_manifest()
        del m["schema_version"]
        with self.assertRaises(ContractError) as ctx:
            validate_manifest_v1(m)
        self.assertEqual(ctx.exception.code, "MISSING_KEY")

    def test_rejects_count_mismatch(self):
        m = _make_manifest()
        m["count"] = 99
        with self.assertRaises(ContractError) as ctx:
            validate_manifest_v1(m)
        self.assertEqual(ctx.exception.code, "COUNT_MISMATCH")

    def test_rejects_empty_cases(self):
        m = _make_manifest()
        m["cases"] = []
        m["count"] = 0
        with self.assertRaises(ContractError) as ctx:
            validate_manifest_v1(m)
        self.assertEqual(ctx.exception.code, "LIST_TOO_SHORT")

    def test_rejects_duplicate_ids(self):
        m = _make_manifest()
        m["cases"].append(dict(m["cases"][0]))
        m["count"] = 2
        with self.assertRaises(ContractError) as ctx:
            validate_manifest_v1(m)
        self.assertEqual(ctx.exception.code, "DUPLICATE_ID")

    def test_rejects_non_json_extension(self):
        m = _make_manifest()
        m["cases"][0]["file"] = "no_extension"
        with self.assertRaises(ContractError) as ctx:
            validate_manifest_v1(m)
        self.assertEqual(ctx.exception.code, "BAD_FILE_EXT")

    def test_rejects_absolute_path(self):
        m = _make_manifest()
        m["cases"][0]["file"] = "/abs/path.json"
        with self.assertRaises(ContractError) as ctx:
            validate_manifest_v1(m)
        self.assertEqual(ctx.exception.code, "BAD_FILE_PATH")

    def test_rejects_undeclared_tag_prefix(self):
        m = _make_manifest()
        m["cases"][0]["tags"].append("garbage:tag")
        with self.assertRaises(ContractError) as ctx:
            validate_manifest_v1(m)
        self.assertEqual(ctx.exception.code, "TAG_PREFIX_UNKNOWN")

    def test_rejects_invalid_case_type(self):
        m = _make_manifest()
        m["cases"][0]["type"] = "MysteryMesh"
        with self.assertRaises(ContractError) as ctx:
            validate_manifest_v1(m)
        self.assertEqual(ctx.exception.code, "ENUM_VIOLATION")


# ---------- Case tests ---------------------------------------------------

class CaseV1Tests(unittest.TestCase):

    def test_accepts_canonical(self):
        validate_case_v1(_make_case())

    def test_rejects_wrong_schema_version(self):
        c = _make_case()
        c["schema_version"] = "9.9"
        with self.assertRaises(ContractError) as ctx:
            validate_case_v1(c)
        self.assertEqual(ctx.exception.code, "UNSUPPORTED_SCHEMA_VERSION")

    def test_rejects_mesh_length_mismatch(self):
        c = _make_case()
        c["geometry"]["mesh"]["vertices"] = [0.0, 0.0, 0.0]  # only 1 vertex
        with self.assertRaises(ContractError) as ctx:
            validate_case_v1(c)
        # normals has 3, mismatch -> MESH_LENGTH_MISMATCH (or LENGTH_INVALID)
        self.assertIn(ctx.exception.code,
                      ("MESH_LENGTH_MISMATCH", "MESH_LENGTH_INVALID"))

    def test_rejects_knots_too_short(self):
        c = _make_case()
        c["curves"][0]["knots"] = [0.0, 0.0]  # way short
        with self.assertRaises(ContractError) as ctx:
            validate_case_v1(c)
        self.assertEqual(ctx.exception.code, "KNOTS_TOO_SHORT")

    def test_rejects_t_range_inverted(self):
        c = _make_case()
        c["curves"][0]["t_min"] = 1.0
        c["curves"][0]["t_max"] = 0.0
        with self.assertRaises(ContractError) as ctx:
            validate_case_v1(c)
        self.assertEqual(ctx.exception.code, "T_RANGE_INVALID")

    def test_rejects_point3_missing_component(self):
        c = _make_case()
        del c["curves"][0]["control_points"][0]["z"]
        with self.assertRaises(ContractError) as ctx:
            validate_case_v1(c)
        self.assertEqual(ctx.exception.code, "MISSING_KEY")


if __name__ == "__main__":
    unittest.main()