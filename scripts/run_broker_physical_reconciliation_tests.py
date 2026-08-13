#!/usr/bin/env python3
"""Non-vacuous mutations for broker physical-capture reconciliation."""

from __future__ import annotations

import copy
import json

from compile_broker_canonical_tables import canonicalise_bundle
from compile_broker_candidate_manifest import compile_manifest


def cell(row: int, column: int, value: str) -> dict:
    return {
        "row": row,
        "column": column,
        "raw_text": value,
        "value": value,
        "source_ref": f"fixture:r{row}c{column}",
    }


def table(identifier: str, method: str, rows: list[list[str]], bbox=None, surface_id="doc.p1", title="Forecasts", units="USDm") -> dict:
    return {
        "table_id": identifier,
        "surface_id": surface_id,
        "source_location": f"page {surface_id.rsplit('p', 1)[-1]}",
        "title": title,
        "units": units,
        "bbox": bbox or [10, 10, 300, 180],
        "extraction_method": method,
        "confidence": 1.0,
        "rows": [
            [cell(row_index, column_index, value) for column_index, value in enumerate(row, 1)]
            for row_index, row in enumerate(rows, 1)
        ],
    }


def bundle(tables: list[dict], source_tokens: list[str], **surface_extra) -> dict:
    surface_ids = sorted({str(item["surface_id"]) for item in tables} or {"doc.p1"})
    surfaces = [{
        "surface_id": surface_id,
        "kind": "pdf_page",
        "ordinal": int(surface_id.rsplit("p", 1)[-1]),
        "source_table_numeric_tokens": (
            source_tokens if len(surface_ids) == 1 else [
                token
                for item in tables if item["surface_id"] == surface_id
                for token in [
                    raw
                    for row in item["rows"] for cell_value in row
                    for raw in [cell_value.get("raw_text")]
                    if raw and any(character.isdigit() for character in str(raw))
                ]
            ]
        ),
        "lane_status": {"vision": "not_required"},
        **surface_extra,
    } for surface_id in surface_ids]
    return {
        "schema_version": "broker-extraction-bundle/1.0",
        "run_id": "physical_capture_test",
        "documents": [{
            "document_id": "doc",
            "house_id": "house",
            "house_name": "House",
            "surfaces": surfaces,
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

# A rendered full grid owns the surface even when a PDF text extractor emits a
# smaller, differently bounded table with truncated year fragments.  Those
# fragments are preserved in the immutable source bundle, but may not survive
# as competing analytical period headers in the candidate manifest.
truncated_native = table(
    "native-truncated-header",
    "native_pdf_lines",
    [["Metric", "FY20", "FY2"], ["Revenue", "100", "110"]],
    bbox=[10, 10, 300, 42],
)
complete_rendered = table(
    "rendered-complete-header",
    "vision_pass_consensus",
    rows,
    bbox=[10, 10, 300, 180],
)
header_resolved, header_findings = canonicalise_bundle(bundle(
    [truncated_native, complete_rendered], ["20", "2", "100", "110"]
))
header_manifest = compile_manifest(header_resolved, source_bundle_sha256="a" * 64)
assert header_resolved["physical_capture_receipt"]["status"] == "PASS"
assert {
    item.get("extraction_method")
    for item in header_resolved["documents"][0]["canonical_tables"]
} == {"vision_pass_consensus"}
assert set(
    header_resolved["documents"][0]["canonical_tables"][0]["source_table_ids"]
) == {"native-truncated-header", "rendered-complete-header"}
assert header_manifest["summary"]["unresolved_period_header_count"] == 0
assert any(
    item.get("id") == "broker_canonical.native_tables_superseded_by_rendered_surface"
    for item in header_findings
)

# A genuinely separate native table on the same page must survive.  The
# rendered authority is table-specific, not permission to erase a page.
disjoint_native = table(
    "native-disjoint-table",
    "native_pdf_lines",
    [["Metric", "2025E", "2026E"], ["Net debt", "50", "60"]],
    bbox=[10, 220, 300, 350],
)
separate_tables, _ = canonicalise_bundle(bundle(
    [complete_rendered, disjoint_native], ["2025", "2026", "100", "110", "50", "60"]
))
assert len(separate_tables["documents"][0]["canonical_tables"]) == 2

# Do not turn the safeguard into a blanket header repair.  If the independently
# rendered authority itself contains a truncated period, it remains unresolved
# for the semantic/model-use layer to reject when selected.
bad_rendered = table(
    "rendered-truncated-header",
    "vision_pass_consensus",
    [["Metric", "FY20", "FY2"], ["Revenue", "100", "110"]],
)
bad_header_bundle, _ = canonicalise_bundle(bundle(
    [bad_rendered], ["20", "2", "100", "110"]
))
bad_header_manifest = compile_manifest(bad_header_bundle, source_bundle_sha256="b" * 64)
assert bad_header_manifest["summary"]["unresolved_period_header_count"] > 0

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

# Multi-page tables retain separate source tables but share a sealed period
# authority graph. Page 2 can omit headers completely; page 3 can carry broken
# native fragments. Neither case rewrites raw cells, and both compile annual
# candidates from the page-1 source header.
page1 = table(
    "page1-full-header", "vision_pass_consensus",
    [["Metric", "2025E", "2026E"], ["Revenue", "100", "110"]],
    surface_id="doc.p1",
)
page2 = table(
    "page2-no-header", "vision_pass_consensus",
    [["EBIT", "20", "22"], ["D&A", "5", "6"]],
    surface_id="doc.p2",
)
page3 = table(
    "page3-truncated-header", "vision_pass_consensus",
    [["Metric", "FY20", "FY2"], ["Capex", "-8", "-9"]],
    surface_id="doc.p3",
)
# A common continuation page omits the title as well as the period header.
page2["title"] = ""
continued, continued_findings = canonicalise_bundle(bundle(
    [page1, page2, page3], ["2025", "2026", "100", "110", "20", "22", "5", "6", "20", "2", "-8", "-9"]
))
continued_tables = sorted(
    continued["documents"][0]["canonical_tables"],
    key=lambda item: int(str(item["surface_id"]).rsplit("p", 1)[-1]),
)
continuation_bases = [item["continuation_certificate"]["basis"] if item["continuation_certificate"] else None for item in continued_tables]
assert continuation_bases == [
    None, "omitted_header", "truncated_header",
], continuation_bases
assert continued_tables[1]["continuation_certificate"]["title_continuation"] is True
assert continued_tables[1]["rows"][0][0]["raw_text"] == "EBIT"
assert continued_tables[2]["rows"][0][1]["raw_text"] == "FY20"
continued_manifest = compile_manifest(continued, source_bundle_sha256="c" * 64)
assert continued_manifest["summary"]["unresolved_period_header_count"] == 0
assert all(
    candidate["period_basis"] == "annual_forecast"
    for candidate in continued_manifest["candidates"]
    if candidate["numeric"] and candidate["label"] in {"Revenue", "EBIT", "D&A", "Capex"}
)
assert not any(item.get("severity") == "blocker" for item in continued_findings)

# Adjacent tables with a different title or units cannot borrow headers.
unrelated_page2 = table(
    "page2-other-table", "vision_pass_consensus",
    [["Net debt", "50", "60"]], surface_id="doc.p2", title="Valuation", units="x",
)
not_continued, _ = canonicalise_bundle(bundle(
    [page1, unrelated_page2], ["2025", "2026", "100", "110", "50", "60"]
))
unrelated = next(
    item for item in not_continued["documents"][0]["canonical_tables"]
    if item["surface_id"] == "doc.p2"
)
assert unrelated["continuation_of"] is None
assert unrelated["effective_period_headers"] == []

print(json.dumps({
    "status": "PASS",
    "positive_archetypes": 4,
    "adversarial_mutations_caught": 5,
    "rendered_disagreement_status": conflicted["physical_capture_receipt"]["status"],
    "native_recovery_status": native_pending["physical_capture_receipt"]["status"],
}, sort_keys=True))
