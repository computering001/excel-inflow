#!/usr/bin/env python3
"""Non-vacuous mutations for broker physical-capture reconciliation."""

from __future__ import annotations

import copy
import json

from compile_broker_canonical_tables import canonicalise_bundle


def cell(row: int, column: int, value: str) -> dict:
    return {
        "row": row,
        "column": column,
        "raw_text": value,
        "value": value,
        "source_ref": f"fixture:r{row}c{column}",
    }


def table(identifier: str, method: str, rows: list[list[str]], bbox=None) -> dict:
    return {
        "table_id": identifier,
        "surface_id": "doc.p1",
        "source_location": "page 1",
        "title": "Forecasts",
        "units": "USDm",
        "bbox": bbox or [10, 10, 300, 180],
        "extraction_method": method,
        "confidence": 1.0,
        "rows": [
            [cell(row_index, column_index, value) for column_index, value in enumerate(row, 1)]
            for row_index, row in enumerate(rows, 1)
        ],
    }


def bundle(tables: list[dict], source_tokens: list[str], **surface_extra) -> dict:
    surface = {
        "surface_id": "doc.p1",
        "kind": "pdf_page",
        "ordinal": 1,
        "source_table_numeric_tokens": source_tokens,
        "lane_status": {"vision": "not_required"},
        **surface_extra,
    }
    return {
        "schema_version": "broker-extraction-bundle/1.0",
        "run_id": "physical_capture_test",
        "documents": [{
            "document_id": "doc",
            "house_id": "house",
            "house_name": "House",
            "surfaces": [surface],
            "tables": tables,
            "numeric_ledger": {
                "source_tokens": source_tokens,
                "captured_tokens": source_tokens,
                "missing_tokens": [],
                "duplicate_tokens": [],
                "recall": 1.0,
            },
            "extraction_status": "complete",
        }],
        "summary": {},
        "gate_status": "PASS",
        "findings": [],
    }


rows = [["Metric", "2025E", "2026E"], ["Revenue", "100", "110"]]
native = table("native", "native_pdf_lines", rows)
rendered = table("rendered", "vision_pass_consensus", rows)

# A complete dual-read grid survives a noisy native token census. Physical
# preservation passes; semantic model use explicitly remains pending.
resolved, findings = canonicalise_bundle(bundle(
    [native, rendered], ["2025", "2026", "100", "110", "999"]
))
receipt = resolved["physical_capture_receipt"]
assert receipt["status"] == "PASS"
assert receipt["analytical_surface_count"] == 1
assert receipt["model_linked_accuracy_status"] == "PENDING_SEMANTIC_CROSSWALK"
assert any(item["id"] == "broker_canonical.native_lane_disagreement_resolved" for item in findings)
assert not any(item.get("severity") == "blocker" for item in findings)

# The same mismatch with only native authority is recoverable internal work,
# not terminal failure and not a request for a replacement report.
native_pending, pending_findings = canonicalise_bundle(bundle(
    [native], ["2025", "2026", "100", "110", "999"]
))
assert native_pending["physical_capture_receipt"]["status"] == "NEEDS_VISION"
assert native_pending["documents"][0]["surfaces"][0]["lane_status"]["vision"] == "required"
assert any(item.get("remedy") == "independent_rendered_grid" for item in pending_findings)
assert not any(item.get("severity") == "blocker" for item in pending_findings)

# Two rendered economic reads that disagree still require bounded targeted
# adjudication; the physical gate cannot silently pick one.
conflicting = copy.deepcopy(rendered)
conflicting["table_id"] = "rendered-conflict"
conflicting["rows"][1][2]["raw_text"] = "111"
conflicting["rows"][1][2]["value"] = "111"
conflicted, conflict_findings = canonicalise_bundle(bundle(
    [rendered, conflicting], ["2025", "2026", "100", "110"]
))
assert conflicted["physical_capture_receipt"]["status"] == "NEEDS_RESOLUTION"
assert any(item.get("severity") == "needs_resolution" for item in conflict_findings)

# A surface independently certified as non-tabular remains hash-bound evidence
# but contributes no fake analytical table.
evidence_only, evidence_findings = canonicalise_bundle(bundle(
    [], [], vision_disposition="verified_non_tabular",
))
assert evidence_only["physical_capture_receipt"]["status"] == "PASS"
assert evidence_only["physical_capture_receipt"]["evidence_only_surface_count"] == 1
assert evidence_only["documents"][0]["canonical_tables"] == []
assert not evidence_findings

print(json.dumps({
    "status": "PASS",
    "positive_archetypes": 2,
    "adversarial_mutations_caught": 2,
    "rendered_disagreement_status": conflicted["physical_capture_receipt"]["status"],
    "native_recovery_status": native_pending["physical_capture_receipt"]["status"],
}, sort_keys=True))
