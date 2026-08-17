#!/usr/bin/env python3
"""Resolve rendered broker period headers or quarantine only unresolved columns.

This module never derives a year from a truncated token. A model-host review
may supply the full period text it can visibly read from the hash-bound rendered
surface. If bounded review is exhausted, the raw cells remain untouched while
the unresolved header columns alone become source-quarantined and unavailable
to model mappings.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
from pathlib import Path
from typing import Any

from compile_broker_candidate_manifest import compile_manifest, period_kind
from compile_broker_canonical_tables import canonical_bytes, table_unresolved_period_columns


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def target_inventory(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    targets: list[dict[str, Any]] = []
    for document in bundle.get("documents", []):
        surfaces = {
            str(surface.get("surface_id")): surface
            for surface in document.get("surfaces", [])
        }
        for table in document.get("canonical_tables") or document.get("tables") or []:
            nonblank_by_column: dict[int, list[dict[str, Any]]] = {}
            for row in table.get("rows", []):
                for cell in row:
                    if str(cell.get("raw_text") or "").strip():
                        nonblank_by_column.setdefault(int(cell.get("column", 0)), []).append(cell)
            quarantined_columns = {
                column for column, cells in nonblank_by_column.items()
                if cells and all(cell.get("authority_status") == "quarantined_conflict" for cell in cells)
            }
            resolved_effective_columns = {
                int(item.get("column", 0))
                for item in table.get("effective_period_headers", [])
                if period_kind(str(item.get("period_label") or "")) not in {None, "unresolved_period_header"}
                and item.get("authority") in {
                    "source_cell", "continuation_certificate", "rendered_header_review",
                }
            }
            columns = sorted(
                table_unresolved_period_columns(table)
                - resolved_effective_columns
                - quarantined_columns
            )
            if not columns:
                continue
            fragments = {
                column: sorted({
                    re.sub(r"\s+", " ", str(cell.get("raw_text") or "").strip())
                    for row in table.get("rows", []) for cell in row
                    if int(cell.get("column", 0)) == column
                    and str(cell.get("raw_text") or "").strip()
                    and period_kind(str(cell.get("raw_text") or "")) == "unresolved_period_header"
                })
                for column in columns
            }
            surface_id = str(table.get("surface_id") or "")
            surface = surfaces.get(surface_id) or {}
            targets.append({
                "document_id": document.get("document_id"),
                "house_id": document.get("house_id"),
                "surface_id": surface_id,
                "table_id": table.get("canonical_table_id") or table.get("table_id"),
                "columns": columns,
                "raw_fragments": fragments,
                "continuation_of": table.get("continuation_of"),
                "image_artifact_ids": [
                    ref for ref in surface.get("artifact_refs", [])
                    if next((item for item in document.get("artifacts", []) if item.get("artifact_id") == ref and item.get("kind") in {"page_image", "table_crop", "region_crop"}), None)
                ],
            })
    return sorted(targets, key=lambda item: (str(item["document_id"]), str(item["surface_id"]), str(item["table_id"])))


def validate_review(
    bundle: dict[str, Any], review: dict[str, Any], *, bundle_sha256: str
) -> dict[tuple[str, str], dict[int, str]]:
    expected = {
        "schema_version": "broker-period-header-review/1.0",
        "run_id": bundle.get("run_id"),
        "bundle_sha256": bundle_sha256,
        "canonical_tables_sha256": bundle.get("canonical_tables_sha256"),
        "candidate_manifest_sha256": canonical_hash(bundle.get("candidate_manifest")),
    }
    for field, value in expected.items():
        if review.get(field) != value:
            raise ValueError(f"Period-header review does not bind {field}.")
    if not str(review.get("producer_id") or "").strip() or not str(review.get("producer_fingerprint") or "").strip():
        raise ValueError("Period-header review lacks producer identity.")
    inventory = {(str(item["document_id"]), str(item["table_id"])): item for item in target_inventory(bundle)}
    decisions: dict[tuple[str, str], dict[int, str]] = {}
    for index, decision in enumerate(review.get("decisions") or []):
        key = (str(decision.get("document_id") or ""), str(decision.get("table_id") or ""))
        target = inventory.get(key)
        if target is None or key in decisions:
            raise ValueError(f"Period-header review decision {index} names an absent or duplicate target.")
        if decision.get("surface_id") != target["surface_id"]:
            raise ValueError(f"Period-header review decision {index} changes surface identity.")
        if len(str(decision.get("rationale") or "").strip()) < 12:
            raise ValueError(f"Period-header review decision {index} lacks rationale.")
        resolved: dict[int, str] = {}
        for header in decision.get("headers") or []:
            column = int(header.get("column", 0))
            label = re.sub(r"\s+", " ", str(header.get("period_label") or "").strip())
            if column not in target["columns"] or column in resolved:
                raise ValueError(f"Period-header review decision {index} changes the unresolved column universe.")
            kind = period_kind(label)
            if kind in {None, "unresolved_period_header"}:
                raise ValueError(f"Period-header review decision {index} supplies an invalid period label {label!r}.")
            resolved[column] = label
        decisions[key] = resolved
    if set(decisions) != set(inventory):
        raise ValueError("Period-header review must disposition every and only the unresolved table target.")
    return decisions


def recover_period_headers(
    bundle: dict[str, Any], *, bundle_sha256: str, review: dict[str, Any] | None = None,
    quarantine_unresolved: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]]:
    output = copy.deepcopy(bundle)
    targets = target_inventory(output)
    if not targets:
        return output, {
            "schema_version": "broker-period-header-recovery-receipt/1.0",
            "status": "PASS", "resolved_header_count": 0,
            "quarantined_column_count": 0, "target_count": 0,
        }
    decisions = validate_review(output, review, bundle_sha256=bundle_sha256) if review else {}
    resolved_count = 0
    quarantined_count = 0
    findings: list[dict[str, Any]] = []
    review_sha = canonical_hash(review) if review else None
    for document in output.get("documents", []):
        canonical_tables = document.get("canonical_tables") or []
        for table in canonical_tables:
            key = (str(document.get("document_id") or ""), str(table.get("canonical_table_id") or table.get("table_id") or ""))
            unresolved = sorted(table_unresolved_period_columns(table))
            if not unresolved:
                continue
            headers = decisions.get(key, {})
            existing = {
                int(item.get("column", 0)): item
                for item in table.get("effective_period_headers", [])
                if int(item.get("column", 0)) > 0
            }
            for column, label in sorted(headers.items()):
                existing[column] = {
                    "column": column,
                    "period_label": label,
                    "authority": "rendered_header_review",
                    "source_table_id": table.get("canonical_table_id") or table.get("table_id"),
                    "source_surface_id": table.get("surface_id"),
                    "review_sha256": review_sha,
                }
                resolved_count += 1
            remaining = [column for column in unresolved if column not in headers]
            if remaining and not quarantine_unresolved:
                continue
            table["effective_period_headers"] = [existing[column] for column in sorted(existing)]
            for column in remaining:
                conflict_id = "bvc-" + hashlib.sha256(canonical_bytes({
                    "document_id": document.get("document_id"),
                    "table_id": key[1], "column": column,
                    "reason": "unresolved_period_header_after_bounded_review",
                })).hexdigest()[:24]
                for row in table.get("rows", []):
                    for cell in row:
                        if int(cell.get("column", 0)) == column and str(cell.get("raw_text") or "").strip():
                            cell["authority_status"] = "quarantined_conflict"
                            cell["authority_basis"] = "bounded_period_header_quarantine"
                            cell["conflict_id"] = conflict_id
                quarantined_count += 1
                findings.append({
                    "id": "broker_period.unresolved_column_quarantined",
                    "severity": "warning",
                    "document_id": document.get("document_id"),
                    "surface_id": table.get("surface_id"),
                    "table_id": key[1], "column": column,
                    "conflict_id": conflict_id,
                    "message": "The unresolved rendered period column is preserved but prohibited from model use; sibling columns remain independently eligible.",
                })
        # The compatibility table projection must equal canonical tables.
        document["tables"] = copy.deepcopy(canonical_tables)
    canonical_tables = [
        table for document in sorted(output.get("documents", []), key=lambda item: str(item.get("document_id")))
        for table in sorted(document.get("canonical_tables", []), key=lambda item: str(item.get("canonical_table_id") or item.get("table_id")))
    ]
    output["canonical_tables_sha256"] = canonical_hash(canonical_tables)
    output["candidate_manifest"] = compile_manifest(output)
    output.setdefault("findings", []).extend(findings)
    output.setdefault("summary", {})["quarantined_conflict_count"] = sum(
        1 for document in output.get("documents", []) for table in document.get("tables", [])
        for row in table.get("rows", []) for cell in row
        if cell.get("authority_status") == "quarantined_conflict"
    )
    output["summary"]["degraded"] = bool(output["summary"]["quarantined_conflict_count"])
    output["period_header_recovery_receipt"] = {
        "schema_version": "broker-period-header-recovery-receipt/1.0",
        "status": "PASS" if not target_inventory(output) or quarantine_unresolved else "NEEDS_REVIEW",
        "source_bundle_sha256": bundle_sha256,
        "review_sha256": review_sha,
        "resolved_header_count": resolved_count,
        "quarantined_column_count": quarantined_count,
        "target_count": len(targets),
        "remaining_target_count": len(target_inventory(output)),
    }
    return output, output["period_header_recovery_receipt"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    parser.add_argument("--review")
    parser.add_argument("--quarantine-unresolved", action="store_true")
    parser.add_argument("--out", required=True)
    parser.add_argument("--receipt")
    args = parser.parse_args()
    bundle_path = Path(args.bundle).resolve()
    bundle = json.loads(bundle_path.read_text("utf-8"))
    review = json.loads(Path(args.review).read_text("utf-8")) if args.review else None
    recovered, receipt = recover_period_headers(
        bundle, bundle_sha256=sha256_file(bundle_path), review=review,
        quarantine_unresolved=args.quarantine_unresolved,
    )
    Path(args.out).write_bytes(canonical_bytes(recovered))
    if args.receipt:
        Path(args.receipt).write_bytes(canonical_bytes(receipt))
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
