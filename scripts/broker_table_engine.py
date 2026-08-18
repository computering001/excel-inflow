#!/usr/bin/env python3
"""Probe optional broker table engines and normalize their sealed outputs.

Rogo vision remains the portable required provider. Surya and Docling are
optional host capabilities: their packages and model weights are never bundled
in the universal skill. Regardless of provider, normalized output re-enters the
existing two-read/conflict/semantic gates and gains no independent model-use
authority from the tool name.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "assets" / "broker-table-engine-registry-v1.json"


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def probe() -> dict[str, Any]:
    registry = json.loads(REGISTRY.read_text("utf-8"))
    providers = {}
    for provider_id, declaration in registry["providers"].items():
        module = declaration.get("module")
        available = True if declaration["provision"] == "model_host" else importlib.util.find_spec(str(module)) is not None
        providers[provider_id] = {
            "available": available,
            "provision": declaration["provision"],
            "required": declaration["required"],
            "capability": declaration["capability"],
        }
    return {
        "schema_version": "broker-table-engine-capability-report/1.0",
        "status": "PASS" if providers["rogo_vision"]["available"] else "BLOCKED",
        "providers": providers,
        "fallback_order": registry["policy"]["fallback_order"],
        "optional_provider_absence_is_blocking": False,
    }


def validate_engine_result(value: dict[str, Any]) -> None:
    allowed = {
        "schema_version", "provider", "document_id", "surface_id", "image_sha256",
        "execution_fingerprint", "tables", "footnotes",
    }
    extra = sorted(set(value) - allowed)
    if extra:
        raise ValueError("Table-engine result has undeclared fields: " + ", ".join(extra))
    if value.get("schema_version") != "broker-table-engine-result/1.0":
        raise ValueError("Table-engine result has the wrong schema version.")
    if value.get("provider") not in {"rogo_vision", "surya_layout", "docling"}:
        raise ValueError("Table-engine result names an unregistered provider.")
    for field in ("document_id", "surface_id", "execution_fingerprint"):
        if not str(value.get(field) or "").strip():
            raise ValueError(f"Table-engine result lacks {field}.")
    image_hash = str(value.get("image_sha256") or "")
    if len(image_hash) != 64 or any(character not in "0123456789abcdef" for character in image_hash):
        raise ValueError("Table-engine result has an invalid image_sha256.")
    tables = value.get("tables")
    if not isinstance(tables, list):
        raise ValueError("Table-engine result tables must be an array.")
    for table_index, table in enumerate(tables):
        if set(table) - {"title", "units", "bbox", "cell_bboxes", "rows"}:
            raise ValueError(f"Table-engine table {table_index} has undeclared fields.")
        rows = table.get("rows")
        if not isinstance(rows, list) or not rows or any(not isinstance(row, list) or not row for row in rows):
            raise ValueError(f"Table-engine table {table_index} is not a nonempty grid.")


def normalize(value: dict[str, Any], *, pass_index: int) -> dict[str, Any]:
    validate_engine_result(value)
    return {
        "schema_version": "broker-vision-result/1.1",
        "document_id": value["document_id"],
        "surface_id": value["surface_id"],
        "image_sha256": value["image_sha256"],
        "pass_index": pass_index,
        "producer_id": f"broker-table-engine:{value['provider']}",
        "producer_fingerprint": value["execution_fingerprint"],
        "method": "vision_model" if value["provider"] == "rogo_vision" else "ocr_geometry",
        "surface_disposition": "analytical_tables" if value["tables"] else "verified_non_tabular",
        **({"non_tabular_reason": "The registered engine found no analytical table on the rendered surface."} if not value["tables"] else {}),
        "tables": value["tables"],
        "footnotes": value.get("footnotes") or [],
        "review_note": (
            f"Normalized from registered provider {value['provider']}; this output still requires "
            "an independent second read and all ordinary semantic gates."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--pass-index", type=int, choices=[1, 2])
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.probe == bool(args.input):
        parser.error("Choose exactly one of --probe or --input.")
    if args.probe:
        output = probe()
    else:
        if args.pass_index not in {1, 2}:
            parser.error("--pass-index is required with --input.")
        output = normalize(json.loads(Path(args.input).read_text("utf-8")), pass_index=args.pass_index)
    Path(args.out).write_bytes(canonical_bytes(output))
    print(json.dumps({"status": "PASS", "out": str(Path(args.out).resolve())}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
