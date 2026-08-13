#!/usr/bin/env python3
"""Compile the immutable broker row universe from canonical source tables."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any


PERIOD_PATTERNS = [
    ("annual", re.compile(r"^(?:fy|cy)?\s*(?:19|20)\d{2}[eaf]?$", re.I)),
    ("annual", re.compile(r"^(?:fy|cy)\s*\d{2}[eaf]?$", re.I)),
    ("annual", re.compile(r"^(?:fy|cy)?\s*(?:(?:19|20)\d{2}|\d{2})\s*/\s*(?:(?:19|20)\d{2}|\d{2})[eaf]?$", re.I)),
    ("quarter", re.compile(r"^(?:q[1-4]|[1-4]q)\s*(?:fy|cy)?\s*(?:19|20)?\d{2}[eaf]?$", re.I)),
    ("quarter_span", re.compile(r"^(?:q[1-4]\s*[-–—/&]\s*q?[1-4]|[1-4]q\s*[-–—/&]\s*[1-4]q)\s*(?:fy|cy)?\s*(?:19|20)?\d{2}[eaf]?$", re.I)),
    ("quarter_span", re.compile(r"^(?:3|6|9)m\s*(?:fy|cy)?\s*(?:19|20)?\d{2}[eaf]?$", re.I)),
    ("half_year", re.compile(r"^(?:h[12]|[12]h)\s*(?:fy|cy)?\s*(?:19|20)?\d{2}[eaf]?$", re.I)),
    ("half_year_span", re.compile(r"^(?:h[12]\s*[-–—/&]\s*h?[12]|[12]h\s*[-–—/&]\s*[12]h)\s*(?:fy|cy)?\s*(?:19|20)?\d{2}[eaf]?$", re.I)),
    ("ltm", re.compile(r"^(?:ltm|ttm)(?:\s+(?:to|ending|ended)\s+.+)?$", re.I)),
    ("ntm", re.compile(r"^ntm(?:\s+(?:to|ending|ended)\s+.+)?$", re.I)),
    ("event_date", re.compile(r"^(?:\d{1,2}[\-/ ])?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\-/ ,]*(?:19|20)\d{2}$", re.I)),
]
PERIOD_LIKE = re.compile(
    # Fail closed only for cells shaped like period headers. Narrative cells
    # that merely mention a year (for example "higher in FY2026") are row
    # content, not unresolved headers.
    r"^(?:(?:fy|cy)\s*\d|(?:q[1-4]|[1-4]q|h[12]|[12]h)\b|(?:ltm|ntm|ttm)\b|"
    r"(?:3|6|9)m\s*(?:fy|cy)?\s*\d|(?:19|20)\d{2}\s*/\s*\d{2})",
    re.I,
)


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def period_kind(label: str) -> str | None:
    candidate = text(label)
    for kind, pattern in PERIOD_PATTERNS:
        if pattern.fullmatch(candidate):
            return kind
    if PERIOD_LIKE.search(candidate):
        return "unresolved_period_header"
    return None


def is_numeric_cell(cell: dict[str, Any]) -> bool:
    if cell.get("value_kind") == "number":
        return True
    raw = text(cell.get("raw_text"))
    return bool(re.fullmatch(r"\(?[-+]?[$€£¥]?\s*(?:\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d+)?[%x]?\)?", raw, re.I))


def row_label(row: list[dict[str, Any]]) -> str:
    for cell in row:
        value = text(cell.get("raw_text"))
        if value and not is_numeric_cell(cell) and not period_kind(value):
            return value
    return next((text(cell.get("raw_text")) for cell in row if text(cell.get("raw_text"))), "")


def label_cell(row: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return the presentation cell that owns the row label."""
    for cell in row:
        value = text(cell.get("raw_text"))
        if value and not is_numeric_cell(cell) and not period_kind(value):
            return cell
    return next((cell for cell in row if text(cell.get("raw_text"))), None)


def classify_row(row: list[dict[str, Any]], label: str, numeric_count: int) -> str:
    lower = label.casefold()
    if numeric_count == 0:
        return "header" if label else "blank"
    if any(token in lower for token in ("margin", "yield", "rate", "cover", "multiple", "gearing", "return on")):
        return "ratio"
    if any(bool(cell.get("bold")) for cell in row) and numeric_count:
        return "subtotal"
    if any(float(cell.get("indent") or 0) > 0 for cell in row):
        return "detail"
    return "detail"


def compile_manifest(bundle: dict[str, Any], *, source_bundle_sha256: str | None = None) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    tables_for_hash: list[dict[str, Any]] = []
    for document in sorted(bundle.get("documents", []), key=lambda item: str(item.get("document_id"))):
        tables = document.get("canonical_tables") or document.get("tables") or []
        for table in sorted(tables, key=lambda item: str(item.get("canonical_table_id") or item.get("table_id"))):
            table_id = str(table.get("canonical_table_id") or table.get("table_id"))
            tables_for_hash.append(table)
            header_periods: dict[int, dict[str, Any]] = {
                int(item["column"]): {
                    "column": int(item["column"]),
                    "period_label": str(item["period_label"]),
                    "period_kind": period_kind(str(item["period_label"])),
                    "authority": item.get("authority", "source_cell"),
                    "source_table_id": item.get("source_table_id", table_id),
                    "source_surface_id": item.get("source_surface_id", table.get("surface_id")),
                }
                for item in table.get("effective_period_headers", [])
                if period_kind(str(item.get("period_label") or ""))
            }
            header_parent_id: str | None = None
            subtotal_parent: tuple[str, float] | None = None
            for row_number, row in enumerate(table.get("rows", []), start=1):
                nonblank = [cell for cell in row if text(cell.get("raw_text"))]
                if not nonblank:
                    continue
                for cell in nonblank:
                    label_value = text(cell.get("raw_text"))
                    kind = period_kind(label_value)
                    if kind:
                        inherited = header_periods.get(int(cell.get("column", 0)))
                        if (
                            kind == "unresolved_period_header"
                            and inherited
                            and inherited.get("authority") == "continuation_certificate"
                        ):
                            # Preserve the truncated raw fragment in source
                            # cells while using only the sealed predecessor
                            # certificate as period authority.
                            continue
                        header_periods[int(cell.get("column", 0))] = {
                            "column": int(cell.get("column", 0)),
                            "period_label": label_value,
                            "period_kind": kind,
                            "authority": "source_cell",
                            "source_table_id": table_id,
                            "source_surface_id": table.get("surface_id"),
                        }
                        if kind == "unresolved_period_header":
                            findings.append({
                                "id": "broker_candidates.unresolved_period_header",
                                "severity": "warning",
                                "document_id": document.get("document_id"),
                                "table_id": table_id,
                                "row": row_number,
                                "column": int(cell.get("column", 0)),
                                "label": label_value,
                                "message": "A period-like label is preserved for semantic review; it blocks only if a model-relevant mapping needs it as a period.",
                            })
                label = row_label(row)
                owner_cell = label_cell(row) or {}
                label_indent = float(owner_cell.get("indent") or 0)
                label_bold = bool(owner_cell.get("bold"))
                numeric_count = sum(1 for cell in row if is_numeric_cell(cell))
                row_kind = classify_row(row, label, numeric_count)
                if subtotal_parent and label_indent <= subtotal_parent[1]:
                    subtotal_parent = None
                parent_id = (
                    subtotal_parent[0]
                    if subtotal_parent and label_indent > subtotal_parent[1]
                    else header_parent_id
                )
                # Preserve authority at cell/period grain. A single unresolved
                # figure must not quarantine the other verified periods on the
                # same visible row. We split only mixed-authority rows, keeping
                # ordinary rows compact and source faithful.
                partitions: dict[str, list[dict[str, Any]]] = {}
                for cell in nonblank:
                    authority = (
                        "quarantined_conflict"
                        if cell.get("authority_status") == "quarantined_conflict"
                        else "verified"
                    )
                    partitions.setdefault(authority, []).append(cell)
                created_ids: list[tuple[str, str]] = []
                for authority_status in ("verified", "quarantined_conflict"):
                    partition = partitions.get(authority_status) or []
                    if not partition:
                        continue
                    source_cells = [
                        {
                            "row": int(cell.get("row", row_number)),
                            "column": int(cell.get("column", 0)),
                            "source_ref": str(cell.get("source_ref") or ""),
                            "raw_text": cell.get("raw_text"),
                        }
                        for cell in partition
                    ]
                    conflict_ids = sorted({
                        str(cell.get("conflict_id"))
                        for cell in partition
                        if cell.get("authority_status") == "quarantined_conflict"
                        and str(cell.get("conflict_id") or "").strip()
                    })
                    identity = {
                        "document_id": document.get("document_id"),
                        "table_id": table_id,
                        "row": row_number,
                        "source_cells": source_cells,
                    }
                    candidate_id = "bc-" + hashlib.sha256(canonical_bytes(identity)).hexdigest()[:24]
                    period_indexes = [
                        dict(header_periods[column])
                        for column in sorted(header_periods)
                        if any(int(cell.get("column", 0)) == column and is_numeric_cell(cell) for cell in partition)
                    ]
                    kinds = sorted({item["period_kind"] for item in period_indexes})
                    if "unresolved_period_header" in kinds:
                        period_basis = "unresolved_period_header"
                    elif kinds == ["annual"]:
                        period_basis = "annual_forecast"
                    elif kinds and set(kinds).issubset({"quarter", "quarter_span", "half_year", "half_year_span", "ltm", "ntm"}):
                        period_basis = "partial_period"
                    elif kinds:
                        period_basis = "unresolved_period_header"
                        findings.append({
                            "id": "broker_candidates.mixed_period_header",
                            "severity": "warning",
                            "document_id": document.get("document_id"),
                            "table_id": table_id,
                            "row": row_number,
                            "period_kinds": kinds,
                            "message": "Mixed period labels are preserved for semantic review and do not block evidence-only tables.",
                        })
                    else:
                        period_basis = "non_periodic"
                    partition_numeric_count = sum(1 for cell in partition if is_numeric_cell(cell))
                    candidates.append({
                        "candidate_id": candidate_id,
                        "document_id": document.get("document_id"),
                        "house_id": document.get("house_id"),
                        "table_id": table_id,
                        "row": row_number,
                        "label": label,
                        "row_kind": row_kind,
                        "parent_candidate_id": parent_id,
                        "period_basis": period_basis,
                        "period_indexes": period_indexes,
                        "source_cells": source_cells,
                        "numeric": partition_numeric_count > 0,
                        "numeric_cell_count": partition_numeric_count,
                        "header_context": [item["period_label"] for item in period_indexes],
                        "units": table.get("units"),
                        "definition_hints": [{
                            "kind": "presentation_hierarchy",
                            "label_indent": label_indent,
                            "label_bold": label_bold,
                        }],
                        "authority_status": authority_status,
                        "conflict_ids": conflict_ids,
                    })
                    created_ids.append((authority_status, candidate_id))
                structural_candidate_id = next(
                    (candidate_id for authority, candidate_id in created_ids if authority == "verified"),
                    created_ids[0][1],
                )
                if row_kind == "header":
                    header_parent_id = structural_candidate_id
                    subtotal_parent = None
                elif row_kind == "subtotal":
                    # A numeric subtotal becomes a parent only for following
                    # rows that are visibly more indented. Same-level rows end
                    # the scope, preventing a bold total from swallowing the
                    # rest of the statement.
                    subtotal_parent = (structural_candidate_id, label_indent)
            if not table.get("rows"):
                findings.append({
                    "id": "broker_candidates.empty_table",
                    "severity": "blocker",
                    "document_id": document.get("document_id"),
                    "table_id": table_id,
                    "message": "A canonical table has no rows.",
                })

    candidate_ids = [item["candidate_id"] for item in candidates]
    if len(candidate_ids) != len(set(candidate_ids)):
        findings.append({"id": "broker_candidates.duplicate_id", "severity": "blocker", "message": "Candidate IDs are not unique."})
    canonical_tables_sha256 = hashlib.sha256(canonical_bytes(tables_for_hash)).hexdigest()
    manifest = {
        "schema_version": "broker-candidate-manifest/1.0",
        "manifest_version": "broker-candidate-manifest/1.0",
        "run_id": bundle.get("run_id"),
        "source_bundle_sha256": source_bundle_sha256 or bundle.get("source_bundle_sha256") or hashlib.sha256(canonical_bytes({
            "run_id": bundle.get("run_id"),
            "documents": [{"document_id": item.get("document_id"), "raw_sha256": item.get("raw_sha256")} for item in bundle.get("documents", [])],
        })).hexdigest(),
        "canonical_tables_sha256": canonical_tables_sha256,
        "candidates": candidates,
        "findings": findings,
        "gate_status": "BLOCKED" if any(item.get("severity") == "blocker" for item in findings) else "PASS",
        "summary": {
            "candidate_count": len(candidates),
            "numeric_candidate_count": sum(1 for item in candidates if item["numeric"]),
            "header_candidate_count": sum(1 for item in candidates if item["row_kind"] == "header"),
            "unresolved_period_header_count": sum(1 for item in candidates if item["period_basis"] == "unresolved_period_header"),
            "quarantined_candidate_count": sum(1 for item in candidates if item["authority_status"] == "quarantined_conflict"),
            "finding_count": len(findings),
        },
    }
    manifest["manifest_sha256"] = hashlib.sha256(canonical_bytes(manifest)).hexdigest()
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    input_path = Path(args.bundle).resolve()
    output_path = Path(args.out).resolve()
    bundle = json.loads(input_path.read_text("utf-8"))
    manifest = compile_manifest(bundle, source_bundle_sha256=hashlib.sha256(input_path.read_bytes()).hexdigest())
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(canonical_bytes(manifest))
    print(json.dumps({"status": manifest["gate_status"], **manifest["summary"], "manifest_sha256": manifest["manifest_sha256"]}, sort_keys=True))
    return 0 if manifest["gate_status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
