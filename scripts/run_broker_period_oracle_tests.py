#!/usr/bin/env python3
"""Independent rendered-period expectation and wrong-year mutations."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

from broker_period_oracle import canonical_hash as oracle_hash, verify_period_expectations
from broker_period_recovery import canonical_hash as production_hash, recover_period_headers
from compile_broker_candidate_manifest import compile_manifest


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = ROOT / "test-fixtures" / "broker-period-oracle"
EXPECTED = json.loads((FIXTURE_ROOT / "expected-periods.json").read_text("utf-8"))
RENDERED = FIXTURE_ROOT / "rendered-period-grid.svg"
RENDERED_SHA256 = hashlib.sha256(RENDERED.read_bytes()).hexdigest()


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


rows = [
    [cell(1, 1, "Metric"), cell(1, 2, "202"), cell(1, 3, "203")],
    [cell(2, 1, "Revenue"), cell(2, 2, "100"), cell(2, 3, "110")],
    [cell(3, 1, "EBIT"), cell(3, 2, "20"), cell(3, 3, "22")],
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
    "effective_period_headers": [],
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
        "path": "rendered-period-grid.svg",
        "sha256": RENDERED_SHA256,
    }],
    "canonical_tables": [table],
    "tables": copy.deepcopy([table]),
    "numeric_ledger": {"source_tokens": [], "captured_tokens": [], "missing_tokens": [], "duplicate_tokens": [], "recall": 1.0},
    "extraction_status": "complete",
}
base = {
    "schema_version": "broker-extraction-bundle/1.0",
    "run_id": "period_oracle",
    "documents": [document],
    "summary": {},
    "gate_status": "PASS",
    "findings": [],
}
base["canonical_tables_sha256"] = production_hash([table])
base["candidate_manifest"] = compile_manifest(base, source_bundle_sha256="a" * 64)
bundle_sha256 = production_hash(base)
review = {
    "schema_version": "broker-period-header-review/1.0",
    "run_id": base["run_id"],
    "bundle_sha256": bundle_sha256,
    "canonical_tables_sha256": base["canonical_tables_sha256"],
    "candidate_manifest_sha256": production_hash(base["candidate_manifest"]),
    "producer_id": "independent-rendered-header-reader/1.0",
    "producer_fingerprint": "period-oracle-fixture",
    "reviewed_at": None,
    "decisions": [{
        "document_id": "document-1",
        "surface_id": "document-1.p1",
        "table_id": "period-table-1",
        "headers": copy.deepcopy(EXPECTED["expectations"][0]["headers"]),
        "rationale": "Complete annual labels are visibly frozen in the rendered evidence crop.",
    }],
}

resolved, receipt = recover_period_headers(base, bundle_sha256=bundle_sha256, review=review)
assert receipt["status"] == "PASS"
positive = verify_period_expectations(base, review, resolved, EXPECTED, evidence_root=FIXTURE_ROOT)
assert positive["status"] == "PASS", positive["findings"]

# Production recovery accepts a syntactically plausible 2037E and emits a
# review hash that is internally consistent. The separately frozen oracle must
# still reject it because the rendered evidence visibly says 2027E.
wrong_year_review = copy.deepcopy(review)
wrong_year_review["decisions"][0]["headers"][0]["period_label"] = "2037E"
wrong_year_resolved, wrong_year_receipt = recover_period_headers(
    base, bundle_sha256=bundle_sha256, review=wrong_year_review
)
assert wrong_year_receipt["status"] == "PASS"
assert wrong_year_receipt["review_sha256"] == production_hash(wrong_year_review)
assert wrong_year_resolved["documents"][0]["canonical_tables"][0]["effective_period_headers"][0]["period_label"] == "2037E"
wrong_year = verify_period_expectations(
    base, wrong_year_review, wrong_year_resolved, EXPECTED, evidence_root=FIXTURE_ROOT
)
assert wrong_year["status"] == "FAIL"
assert "BROKER_PERIOD_EXPECTED_LABEL_MISMATCH" in {item["code"] for item in wrong_year["findings"]}

closure_mutation = copy.deepcopy(EXPECTED)
closure_mutation["expectations"][0]["headers"][0]["period_label"] = "2037E"
closure_report = verify_period_expectations(base, review, resolved, closure_mutation, evidence_root=FIXTURE_ROOT)
assert "BROKER_PERIOD_EXPECTATION_CLOSURE" in {item["code"] for item in closure_report["findings"]}

rendered_binding_mutation = copy.deepcopy(EXPECTED)
rendered_binding_mutation["expectations"][0]["rendered_evidence"][0]["sha256"] = "f" * 64
rendered_binding_mutation["expectations_sha256"] = oracle_hash({
    "run_id": rendered_binding_mutation["run_id"],
    "expectations": rendered_binding_mutation["expectations"],
})
rendered_report = verify_period_expectations(base, review, resolved, rendered_binding_mutation, evidence_root=FIXTURE_ROOT)
assert {"BROKER_PERIOD_RENDERED_EVIDENCE_BINDING", "BROKER_PERIOD_RENDERED_EVIDENCE_HASH"}.issubset(
    {item["code"] for item in rendered_report["findings"]}
)

recovered_mutation = copy.deepcopy(resolved)
recovered_mutation["documents"][0]["canonical_tables"][0]["effective_period_headers"][0]["period_label"] = "2037E"
recovered_report = verify_period_expectations(base, review, recovered_mutation, EXPECTED, evidence_root=FIXTURE_ROOT)
assert "BROKER_PERIOD_RECOVERED_LABEL_MISMATCH" in {item["code"] for item in recovered_report["findings"]}

print(json.dumps({
    "status": "PASS",
    "checks": 15,
    "mutations_caught": 4,
    "expectations_sha256": EXPECTED["expectations_sha256"],
    "rendered_evidence_sha256": RENDERED_SHA256,
    "wrong_year_review_sha256": wrong_year_receipt["review_sha256"],
}, sort_keys=True))
