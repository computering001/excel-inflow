#!/usr/bin/env python3
"""Align the runtime-trace schema with append-only parent/child spans."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "assets" / "user-visible-runtime-trace-v1.schema.json"
value = json.loads(path.read_text("utf-8"))
required = value.setdefault("required", [])
for field in [
    "attributed_span_duration_ms",
    "unattributed_duration_ms",
    "attribution_coverage",
]:
    if field not in required:
        required.append(field)
properties = value.setdefault("properties", {})
properties["attributed_span_duration_ms"] = {"type": "number", "minimum": 0}
properties["unattributed_duration_ms"] = {"type": ["number", "null"], "minimum": 0}
properties["attribution_coverage"] = {
    "type": ["number", "null"],
    "minimum": 0,
    "maximum": 1,
}
properties["spans"] = {
    "type": "array",
    "minItems": 1,
    "items": {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "span_id",
            "parent_span_id",
            "name",
            "started_at",
            "completed_at",
            "duration_ms",
            "owner",
            "process_id",
        ],
        "properties": {
            "span_id": {"type": "string", "minLength": 1},
            "parent_span_id": {"type": ["string", "null"]},
            "name": {"type": "string", "minLength": 1},
            "started_at": {"type": "string", "format": "date-time"},
            "completed_at": {"type": ["string", "null"], "format": "date-time"},
            "duration_ms": {"type": ["number", "null"], "minimum": 0},
            "owner": {"const": "excel_inflow_process"},
            "process_id": {"type": "integer", "minimum": 1},
        },
    },
}
path.write_text(json.dumps(value, indent=2) + "\n", "utf-8")
print({"status": "PASS", "schema": str(path.relative_to(ROOT))})
