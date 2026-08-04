"""Tests for the protocol_v1 contract validator."""

from __future__ import annotations

import unittest
from datetime import datetime

from . import validate_message_v1, ContractError
from .protocol_v1 import PROTOCOL_V1


def _make_manifest_msg():
    return {
        "schema_version": PROTOCOL_V1,
        "type": "manifest",
        "app_id": "kernel-app-1",
        "ts": "2026-08-04T14:00:00Z",
        "payload": {
            "cases": [
                {"id": "c1", "file": "c1.json", "name": "Case 1", "tags": []},
                {"id": "c2", "file": "c2.json", "name": "Case 2", "tags": ["profile:open"]},
            ]
        }
    }


def _make_case_msg():
    return {
        "schema_version": PROTOCOL_V1,
        "type": "case",
        "app_id": "kernel-app-1",
        "ts": "2026-08-04T14:00:01Z",
        "payload": {
            "file": "c1.json",
            "id": "c1",
            "name": "Case 1",
            "tags": [],
            "case": {
                "schema_version": "1.0",
                "caseName": "Case 1",
                "curves": [],
                "geometry": {
                    "type": "LoftedSurface",
                    "mesh": {"vertices": [], "normals": [], "indices": []},
                    "nurbs": {"curves": [], "surfaces": []},
                    "debugMarkers": {"singularities": []},
                }
            }
        }
    }


def _make_heartbeat_msg():
    return {
        "schema_version": PROTOCOL_V1,
        "type": "heartbeat",
        "app_id": "kernel-app-1",
        "ts": "2026-08-04T14:00:02Z",
        "payload": {}
    }


def _make_close_msg():
    return {
        "schema_version": PROTOCOL_V1,
        "type": "close",
        "app_id": "kernel-app-1",
        "ts": "2026-08-04T14:00:03Z",
        "payload": {}
    }


class ProtocolV1Tests(unittest.TestCase):

    def test_accepts_canonical_manifest(self):
        validate_message_v1(_make_manifest_msg())

    def test_accepts_canonical_case(self):
        validate_message_v1(_make_case_msg())

    def test_accepts_heartbeat_and_close(self):
        validate_message_v1(_make_heartbeat_msg())
        validate_message_v1(_make_close_msg())

    def test_rejects_wrong_schema_version(self):
        m = _make_manifest_msg()
        m["schema_version"] = "2.0"
        with self.assertRaises(ContractError) as ctx:
            validate_message_v1(m)
        self.assertEqual(ctx.exception.code, "UNSUPPORTED_SCHEMA_VERSION")

    def test_rejects_unknown_type(self):
        m = _make_manifest_msg()
        m["type"] = "bogus"
        with self.assertRaises(ContractError) as ctx:
            validate_message_v1(m)
        self.assertEqual(ctx.exception.code, "ENUM_VIOLATION")

    def test_rejects_long_app_id(self):
        m = _make_manifest_msg()
        m["app_id"] = "x" * 100
        with self.assertRaises(ContractError) as ctx:
            validate_message_v1(m)
        self.assertEqual(ctx.exception.code, "APP_ID_TOO_LONG")

    def test_rejects_bad_timestamp(self):
        m = _make_manifest_msg()
        m["ts"] = "2026-08-04 14:00:00"  # missing T
        with self.assertRaises(ContractError) as ctx:
            validate_message_v1(m)
        self.assertEqual(ctx.exception.code, "BAD_TIMESTAMP")

    def test_rejects_manifest_with_duplicate_ids(self):
        m = _make_manifest_msg()
        m["payload"]["cases"].append({
            "id": "c1", "file": "dup.json", "name": "Dup", "tags": []
        })
        with self.assertRaises(ContractError) as ctx:
            validate_message_v1(m)
        self.assertEqual(ctx.exception.code, "DUPLICATE_ID")

    def test_rejects_case_with_bad_extension(self):
        m = _make_case_msg()
        m["payload"]["file"] = "no_extension"
        with self.assertRaises(ContractError) as ctx:
            validate_message_v1(m)
        self.assertEqual(ctx.exception.code, "BAD_FILE_EXT")

    def test_rejects_case_with_invalid_inner_contract(self):
        m = _make_case_msg()
        # Corrupt the inner case: mesh vertices != normals length
        m["payload"]["case"]["geometry"]["mesh"]["vertices"] = [0.0, 0.0]
        with self.assertRaises(ContractError) as ctx:
            validate_message_v1(m)
        # Inner case validator fires MESH_LENGTH_MISMATCH
        self.assertEqual(ctx.exception.code, "MESH_LENGTH_MISMATCH")

    def test_rejects_missing_app_id(self):
        m = _make_manifest_msg()
        del m["app_id"]
        with self.assertRaises(ContractError) as ctx:
            validate_message_v1(m)
        self.assertEqual(ctx.exception.code, "MISSING_KEY")


if __name__ == "__main__":
    unittest.main()