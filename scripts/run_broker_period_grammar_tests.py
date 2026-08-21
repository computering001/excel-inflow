#!/usr/bin/env python3
"""Unit tests for the widened broker period-label grammar.

Covers the surface spellings real rendered broker headers use (``FY25``,
``FY2025``, ``2025/26``, ``25/26``, ``FY25/26``, ``CY2025``), the canonical
``YYYY``/``YYYYA``/``YYYYE`` identity, the century pivot, the UK split-year
END convention, ambiguity reporting, and the oracle's behaviour when frozen
expectations, model-host review and recovered output spell the same year
differently.

Run standalone:  python3 scripts/run_broker_period_grammar_tests.py [--out DIR]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from broker_period_oracle import (
    FULL_YEAR,
    canonical_hash as oracle_hash,
    canonical_headers,
    canonical_period_label,
    verify_period_expectations,
)


CHECKS = 0


def check(condition: bool, message: str) -> None:
    global CHECKS
    CHECKS += 1
    if not condition:
        raise AssertionError(message)


# ---------------------------------------------------------------------------
# 1. Pure normalisation table
# ---------------------------------------------------------------------------

EXPECTED_NORMALISATIONS = [
    # (surface label, canonical, ambiguous)
    ("2025", "2025", False),
    ("2025A", "2025A", False),
    ("2025E", "2025E", False),
    (" 2027E ", "2027E", False),
    ("FY2025", "2025", False),
    ("fy 2025", "2025", False),
    ("FY25", "2025", False),
    ("FY25E", "2025E", False),
    ("CY2025", "2025", False),
    ("cy2026", "2026", False),
    ("2025/26", "2026", False),
    ("2024 / 25", "2025", False),
    ("1999/00", "2000", False),
    ("FY25/26", "2026", False),
    ("2025/26E", "2026E", False),
    # Bare split: resolvable under the declared conventions, never silent.
    ("25/26", "2026", True),
    ("99/00", "2000", True),
    # Century pivot windows.
    ("FY49", "2049", False),
    ("FY50", "1950", False),
    ("FY00", "2000", False),
    ("FY99", "1999", False),
]

for surface, canonical, ambiguous in EXPECTED_NORMALISATIONS:
    resolved, flagged = canonical_period_label(surface)
    check(resolved == canonical, f"{surface!r}: canonical {resolved!r} != {canonical!r}")
    check(flagged is ambiguous, f"{surface!r}: ambiguity {flagged} != {ambiguous}")
    if not ambiguous:
        check(resolved is not None, f"{surface!r}: canonical unexpectedly None")
        check(bool(FULL_YEAR.fullmatch(resolved)), f"{surface!r}: canonical {resolved!r} violates the canonical grammar")

REJECTED_LABELS = [
    "", "202", "25", "25A", "2037X", "H1 25", "Q1-25", "2025/27", "26/25",
    "2025/2026", "2025-26", "FY 2O25", "FY", "202/", "/26",
]
for surface in REJECTED_LABELS:
    resolved, flagged = canonical_period_label(surface)
    check(resolved is None and not flagged, f"{surface!r}: unexpectedly resolved to {resolved!r}")

check(canonical_period_label(None)[0] is None, "None label must not resolve")
check(canonical_period_label(2025)[0] == "2025", "numeric labels coerce through str()")


# ---------------------------------------------------------------------------
# 2. Oracle behaviour under widened labels
# ---------------------------------------------------------------------------

def cell(row: int, column: int, value: str) -> dict:
    return {
        "row": row,
        "column": column,
        "raw_text": value,
        "value": value,
        "value_kind": "number" if value.lstrip("-").isdigit() else "text",
        "source_ref": f"fixture:r{row}c{column}",
        "authority_status": "verified_dual_read",
        "authority_basis": "two_pass_visual_consensus",
    }


def build_world(
    root: Path,
    expected_labels: list[str],
    review_labels: list[str],
    recovered_labels: list[str],
) -> tuple[dict, dict, dict]:
    """Minimal independent bundle/review/expectation triple for one table."""
    artifact_path = root / "rendered-period-grid.svg"
    artifact_path.write_text("<svg/>", encoding="utf-8")
    artifact_sha = hashlib.sha256(artifact_path.read_bytes()).hexdigest()

    def header_cells(labels: list[str]) -> list[dict]:
        return [cell(1, index + 2, label) for index, label in enumerate(labels)]

    rows = [
        [*header_cells(expected_labels)],
        [cell(2, 1, "Revenue"), cell(2, 2, "100"), cell(2, 3, "110")],
    ]
    table = {
        "table_id": "period-table-1",
        "canonical_table_id": "period-table-1",
        "surface_id": "document-1.p1",
        "source_location": "document-1.p1",
        "title": "Forecasts",
        "units": "USDm",
        "bbox": [10, 10, 500, 700],
        "extraction_method": "vision_pass_consensus",
        "authority_role": "rendered_authority",
        "confidence": 1.0,
        "rows": rows,
        "effective_period_headers": [
            {"column": index + 2, "period_label": label}
            for index, label in enumerate(recovered_labels)
        ],
    }
    document = {
        "document_id": "document-1",
        "house_id": "house-1",
        "house_name": "House 1",
        "surfaces": [{
            "surface_id": "document-1.p1",
            "kind": "pdf_page",
            "ordinal": 1,
            "artifact_refs": ["period-grid-crop"],
            "source_table_numeric_tokens": [],
            "lane_status": {"vision": "complete"},
        }],
        "artifacts": [{
            "artifact_id": "period-grid-crop",
            "kind": "table_crop",
            "path": artifact_path.name,
            "sha256": artifact_sha,
        }],
        "canonical_tables": [table],
        "tables": [table],
        "numeric_ledger": {"source_tokens": [], "captured_tokens": [], "missing_tokens": [], "duplicate_tokens": [], "recall": 1.0},
        "extraction_status": "complete",
    }
    bundle = {
        "schema_version": "broker-extraction-bundle/1.0",
        "run_id": "grammar_test_run",
        "documents": [document],
        "summary": {},
        "gate_status": "PASS",
        "findings": [],
    }
    review = {
        "schema_version": "broker-period-header-review/1.0",
        "run_id": "grammar_test_run",
        "bundle_sha256": "b" * 64,
        "decisions": [{
            "document_id": "document-1",
            "surface_id": "document-1.p1",
            "table_id": "period-table-1",
            "headers": [
                {"column": index + 2, "period_label": label}
                for index, label in enumerate(review_labels)
            ],
            "rationale": "Rendered headers read directly from the crop.",
        }],
    }
    expectations = {
        "schema_version": "broker-period-expectation/1.0",
        "run_id": "grammar_test_run",
        "expectations": [{
            "document_id": "document-1",
            "surface_id": "document-1.p1",
            "table_id": "period-table-1",
            "rendered_evidence": [{"artifact_id": "period-grid-crop", "sha256": artifact_sha}],
            "headers": [
                {"column": index + 2, "period_label": label}
                for index, label in enumerate(expected_labels)
            ],
        }],
    }
    expectations["expectations_sha256"] = oracle_hash({
        "run_id": expectations["run_id"],
        "expectations": expectations["expectations"],
    })
    return bundle, review, expectations


def run_case(
    root: Path,
    expected_labels: list[str],
    review_labels: list[str],
    recovered_labels: list[str],
) -> dict:
    bundle, review, expectations = build_world(root, expected_labels, review_labels, recovered_labels)
    return verify_period_expectations(bundle, review, bundle, expectations, evidence_root=root)


def codes(report: dict) -> set[str]:
    return {item["code"] for item in report["findings"]}


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)

    # Every required spelling verifies cleanly and cross-spelling agreement
    # (frozen contract vs review vs recovered) reconciles in canonical space.
    report = run_case(root, ["FY25", "2026/27"], ["2025", "FY2027"], ["FY2025", "2027"])
    check(report["status"] == "PASS", f"widened labels should PASS: {report['findings']}")

    report = run_case(root, ["CY2025", "FY25/26"], ["2025", "2026"], ["CY2025", "FY26"])
    check(report["status"] == "PASS", f"prefix/split mix should PASS: {report['findings']}")

    # Canonical identity labels keep their historical behaviour.
    report = run_case(root, ["2025A", "2026E"], ["2025A", "2026E"], ["2025A", "2026E"])
    check(report["status"] == "PASS", "canonical identity case should PASS")

    # Ambiguous bare split: resolvable, but reported, never silently blessed.
    report = run_case(root, ["25/26", "2026/27"], ["2025", "2026"], ["2025", "2026"])
    check(report["status"] == "FAIL", "ambiguous bare split must fail the report")
    check("BROKER_PERIOD_LABEL_AMBIGUOUS" in codes(report), f"ambiguity finding missing: {report['findings']}")
    check("BROKER_PERIOD_EXPECTED_LABEL_INVALID" not in codes(report), "ambiguous label must not read as invalid")
    ambiguous_finding = next(item for item in report["findings"] if item["code"] == "BROKER_PERIOD_LABEL_AMBIGUOUS")
    check("2026" in ambiguous_finding["message"], "ambiguity finding must name the resolved year")

    # Out-of-grammar labels stay invalid.
    report = run_case(root, ["H1 25", "2026"], ["2025", "2026"], ["2025", "2026"])
    check("BROKER_PERIOD_EXPECTED_LABEL_INVALID" in codes(report), "out-of-grammar expectation must stay invalid")
    report = run_case(root, ["25", "2026"], ["2025", "2026"], ["2025", "2026"])
    check("BROKER_PERIOD_EXPECTED_LABEL_INVALID" in codes(report), "naked two-digit year stays invalid")
    report = run_case(root, ["2025/27", "2026"], ["2025", "2026"], ["2025", "2026"])
    check("BROKER_PERIOD_EXPECTED_LABEL_INVALID" in codes(report), "non-consecutive split stays invalid")

    # Wrong-year mutations are still caught after normalisation.
    report = run_case(root, ["FY25", "2026/27"], ["FY25", "2026/27"], ["2024", "2027"])
    check("BROKER_PERIOD_RECOVERED_LABEL_MISMATCH" in codes(report), "recovered wrong-year must be caught")
    report = run_case(root, ["FY25", "2026/27"], ["FY24", "2026/27"], ["2025", "2027"])
    check("BROKER_PERIOD_EXPECTED_LABEL_MISMATCH" in codes(report), "review wrong-year must be caught")
    report = run_case(root, ["FY25", "2026/27"], ["FY25", "2026/27"], ["garbage!!", "2027"])
    check("BROKER_PERIOD_RECOVERED_LABEL_MISMATCH" in codes(report), "unparseable recovered label must mismatch, not crash")

    # Canonical-space comparison helper agrees with the verification results.
    check(
        canonical_headers([{"column": 2, "period_label": "25/26"}])
        == [{"column": 2, "period_label": "2026"}],
        "canonical_headers maps bare splits",
    )

summary = {
    "schema_version": "broker-period-grammar-tests/1.0",
    "status": "PASS",
    "normalisation_cases": len(EXPECTED_NORMALISATIONS),
    "rejected_labels": len(REJECTED_LABELS),
    "oracle_scenarios": 10,
    "checks": CHECKS,
}
print(json.dumps(summary, sort_keys=True))
