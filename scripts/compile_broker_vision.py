#!/usr/bin/env python3
"""Merge two independent image-table transcriptions into an evidence bundle."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


NUMERIC_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:\(?[-+]?[$€£¥]?\s*(?:\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d+)?%?\)?|[-+]?\d+(?:\.\d+)?x)(?![A-Za-z])",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def normalise_scalar(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    text = str(value).strip()
    if text in {"", "-", "–", "—"}:
        return None if text == "" else text
    return re.sub(r"\s+", " ", text)


def comparable_tables(tables: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "title": normalise_scalar(table.get("title")),
            "units": normalise_scalar(table.get("units")),
            "rows": [[normalise_scalar(value) for value in row] for row in table.get("rows", [])],
        }
        for table in tables
    ]


def numeric_token(value: Any) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not NUMERIC_RE.fullmatch(text):
        return None
    negative = text.startswith("(") and text.endswith(")")
    suffix = "%" if "%" in text else ("x" if text.lower().endswith("x") else "")
    cleaned = re.sub(r"[$€£¥,%xX() ]", "", text)
    try:
        number = float(cleaned)
    except ValueError:
        return text
    if negative:
        number = -abs(number)
    base = str(int(number)) if number.is_integer() else format(number, ".15g")
    return base + suffix


def make_cell(value: Any, row: int, column: int, source_ref: str) -> dict[str, Any]:
    if value is None:
        kind = "blank"
    elif isinstance(value, bool):
        kind = "boolean"
    elif isinstance(value, (int, float)):
        kind = "number"
    else:
        kind = "text"
    return {
        "row": row,
        "column": column,
        "raw_text": None if value is None else str(value),
        "value": value,
        "value_kind": kind,
        "number_format": None,
        "formula": None,
        "bbox": None,
        "source_ref": source_ref,
        "confidence": 1.0,
    }


def accepted_tables(result: dict[str, Any], surface_id: str, source_name: str) -> list[dict[str, Any]]:
    compiled = []
    for table_index, raw_table in enumerate(result.get("tables", []), start=1):
        table_id = f"{surface_id}.vision-t{table_index}"
        rows = []
        for row_index, raw_row in enumerate(raw_table.get("rows", []), start=1):
            rows.append([
                make_cell(value, row_index, column_index, f"{source_name}#{surface_id};vision-table={table_index};r={row_index};c={column_index}")
                for column_index, value in enumerate(raw_row, start=1)
            ])
        compiled.append({
            "table_id": table_id,
            "surface_id": surface_id,
            "source_location": f"{surface_id}, vision table {table_index}",
            "title": raw_table.get("title"),
            "units": raw_table.get("units"),
            "bbox": raw_table.get("bbox"),
            "extraction_method": "manual_verified" if result.get("pass_index") == "resolution" else "vision_pass_consensus",
            "confidence": 1.0,
            "rows": rows,
        })
    return compiled


def add_vision_tokens(document: dict[str, Any], tables: list[dict[str, Any]]) -> None:
    tokens = []
    for table in tables:
        for row in table["rows"]:
            for cell in row:
                token = numeric_token(cell.get("raw_text"))
                if token is not None:
                    tokens.append(token)
    document["numeric_ledger"]["source_tokens"].extend(tokens)
    document["numeric_ledger"]["captured_tokens"].extend(tokens)
    source = Counter(document["numeric_ledger"]["source_tokens"])
    captured = Counter(document["numeric_ledger"]["captured_tokens"])
    missing = source - captured
    duplicate = captured - source
    document["numeric_ledger"]["missing_tokens"] = sorted(k for k, n in missing.items() for _ in range(n))
    document["numeric_ledger"]["duplicate_tokens"] = sorted(k for k, n in duplicate.items() for _ in range(n))
    count = sum(source.values())
    document["numeric_ledger"]["recall"] = 1.0 if count == 0 else (count - sum(missing.values())) / count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    parser.add_argument("--responses", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    bundle_path = Path(args.bundle).resolve()
    response_root = Path(args.responses).resolve()
    output_path = Path(args.out).resolve()
    bundle = copy.deepcopy(json.loads(bundle_path.read_text("utf-8")))
    artifact_by_id = {
        artifact["artifact_id"]: (document, artifact)
        for document in bundle["documents"]
        for artifact in document["artifacts"]
    }
    findings = [item for item in bundle.get("findings", []) if item.get("id") != "broker_extraction.vision_required"]
    unresolved = 0
    for document in bundle["documents"]:
        for surface in document["surfaces"]:
            if surface["lane_status"]["vision"] != "required":
                continue
            surface_id = surface["surface_id"]
            task_artifact = next(
                (artifact for artifact in document["artifacts"] if artifact["kind"] == "vision_task" and artifact["artifact_id"] in surface["artifact_refs"]),
                None,
            )
            image_artifact = next(
                (artifact for artifact in document["artifacts"] if artifact["kind"] == "page_image" and artifact["artifact_id"] in surface["artifact_refs"]),
                None,
            )
            if not task_artifact or not image_artifact:
                unresolved += 1
                findings.append({"id": "broker_vision.task_or_image_missing", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "The required hash-bound vision task or page image is missing."})
                continue
            image_path = bundle_path.parent / image_artifact["path"]
            task_path = bundle_path.parent / task_artifact["path"]
            if (
                not image_path.is_file()
                or sha256_file(image_path) != image_artifact["sha256"]
                or not task_path.is_file()
                or sha256_file(task_path) != task_artifact["sha256"]
            ):
                unresolved += 1
                findings.append({"id": "broker_vision.task_or_image_hash_mismatch", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "The vision task or page image is missing or does not match the extraction bundle."})
                continue
            task = json.loads(task_path.read_text("utf-8"))
            if task.get("document_id") != document["document_id"] or task.get("surface_id") != surface_id:
                unresolved += 1
                findings.append({"id": "broker_vision.task_binding_invalid", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "The vision task does not bind the document and surface."})
                continue
            response_base = response_root / surface_id
            pass_paths = [Path(str(response_base) + ".pass1.json"), Path(str(response_base) + ".pass2.json")]
            resolution_path = Path(str(response_base) + ".resolution.json")
            if not all(path.is_file() for path in pass_paths):
                unresolved += 1
                findings.append({"id": "broker_vision.response_missing", "severity": "warning", "document_id": document["document_id"], "surface_id": surface_id, "message": "Two independent vision responses are required."})
                continue
            passes = [json.loads(path.read_text("utf-8")) for path in pass_paths]
            valid_binding = all(
                result.get("schema_version") == "broker-vision-result/1.0"
                and result.get("document_id") == document["document_id"]
                and result.get("surface_id") == surface_id
                and result.get("image_sha256") == image_artifact["sha256"]
                and result.get("pass_index") == index
                and str(result.get("producer_id") or "").strip()
                and result.get("method") in {"ocr_geometry", "vision_model", "manual_transcription"}
                for index, result in enumerate(passes, start=1)
            )
            if not valid_binding:
                unresolved += 1
                findings.append({"id": "broker_vision.response_binding_invalid", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "A vision response is not bound to the source image, surface and pass number."})
                continue
            if passes[0]["producer_id"] == passes[1]["producer_id"]:
                unresolved += 1
                findings.append({"id": "broker_vision.passes_not_independent", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "Pass 1 and pass 2 declare the same producer_id; independent runs are required."})
                continue
            if canonical(comparable_tables(passes[0]["tables"])) == canonical(comparable_tables(passes[1]["tables"])):
                accepted = passes[0]
            elif resolution_path.is_file():
                resolution = json.loads(resolution_path.read_text("utf-8"))
                if not (
                    resolution.get("schema_version") == "broker-vision-result/1.0"
                    and resolution.get("document_id") == document["document_id"]
                    and resolution.get("surface_id") == surface_id
                    and resolution.get("image_sha256") == image_artifact["sha256"]
                    and resolution.get("pass_index") == "resolution"
                    and str(resolution.get("producer_id") or "").strip()
                    and resolution.get("method") == "reviewed_resolution"
                    and str(resolution.get("review_note") or "").strip()
                ):
                    unresolved += 1
                    findings.append({"id": "broker_vision.resolution_invalid", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "The discrepancy resolution is missing its image binding or review note."})
                    continue
                accepted = resolution
            else:
                unresolved += 1
                findings.append({"id": "broker_vision.pass_disagreement", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "Independent image-table transcriptions disagree; a reviewed resolution is required."})
                continue
            new_tables = accepted_tables(accepted, surface_id, document["file_name"])
            document["tables"].extend(new_tables)
            add_vision_tokens(document, new_tables)
            surface["table_count"] += len(new_tables)
            surface["lane_status"]["vision"] = "complete"
            surface["vision_reason"] = None

        states = {surface["lane_status"]["vision"] for surface in document["surfaces"]}
        document["extraction_status"] = "complete" if "required" not in states and "error" not in states else "needs_vision"

    table_count = sum(len(document["tables"]) for document in bundle["documents"])
    cell_count = sum(len(row) for document in bundle["documents"] for table in document["tables"] for row in table["rows"])
    source_count = sum(len(document["numeric_ledger"]["source_tokens"]) for document in bundle["documents"])
    missing_count = sum(len(document["numeric_ledger"]["missing_tokens"]) for document in bundle["documents"])
    duplicate_count = sum(len(document["numeric_ledger"]["duplicate_tokens"]) for document in bundle["documents"])
    bundle["summary"]["table_count"] = table_count
    bundle["summary"]["cell_count"] = cell_count
    bundle["summary"]["numeric_token_count"] = source_count
    bundle["summary"]["native_numeric_recall"] = 1.0 if source_count == 0 else (source_count - missing_count) / source_count
    bundle["summary"]["unresolved_surface_count"] = unresolved
    bundle["summary"]["duplicate_cell_count"] = duplicate_count
    bundle["findings"] = findings
    bundle["gate_status"] = "BLOCKED" if any(item["severity"] == "blocker" for item in findings) else ("NEEDS_VISION" if unresolved else "PASS")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(bundle, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(json.dumps({"status": bundle["gate_status"], "unresolved_surfaces": unresolved, "tables": table_count, "cells": cell_count}, sort_keys=True))
    return 0 if bundle["gate_status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
