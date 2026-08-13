#!/usr/bin/env python3
"""Focused period-header recovery and local-quarantine mutations."""

from __future__ import annotations

import copy
import hashlib
import json
import tempfile
from pathlib import Path

from broker_period_recovery import canonical_hash, recover_period_headers, target_inventory
from compile_broker_canonical_tables import canonicalise_bundle
from compile_broker_candidate_manifest import compile_manifest
import run_broker_pipeline as broker
from run_broker_degraded_close_tests import build_house, invoke, reference_only_crosswalk, write_json


def cell(row: int, column: int, value: str) -> dict:
    return {
        "row": row, "column": column, "raw_text": value, "value": value,
        "value_kind": "number" if value.lstrip("-").isdigit() else "text",
        "source_ref": f"fixture:r{row}c{column}",
        "authority_status": "verified_dual_read",
        "authority_basis": "two_pass_visual_consensus",
    }


def table(identifier: str, surface: str, rows: list[list[str]], title: str = "Forecasts") -> dict:
    return {
        "table_id": identifier, "surface_id": surface, "source_location": surface,
        "title": title, "units": "USDm", "bbox": [10, 10, 500, 700],
        "extraction_method": "vision_pass_consensus", "authority_role": "rendered_authority",
        "confidence": 1.0,
        "rows": [[cell(r, c, value) for c, value in enumerate(row, 1)] for r, row in enumerate(rows, 1)],
    }


def fixture(tables: list[dict]) -> dict:
    surfaces = sorted({item["surface_id"] for item in tables})
    bundle = {
        "schema_version": "broker-extraction-bundle/1.0", "run_id": "period_recovery",
        "documents": [{
            "document_id": "doc", "house_id": "house", "house_name": "House",
            "surfaces": [{
                "surface_id": surface, "kind": "pdf_page", "ordinal": int(surface.rsplit("p", 1)[-1]),
                "source_table_numeric_tokens": [], "lane_status": {"vision": "complete"},
            } for surface in surfaces],
            "tables": tables, "numeric_ledger": {"source_tokens": [], "captured_tokens": [], "missing_tokens": [], "duplicate_tokens": [], "recall": 1.0},
            "extraction_status": "complete",
        }],
        "summary": {}, "gate_status": "PASS", "findings": [],
    }
    canonical, _ = canonicalise_bundle(bundle)
    canonical["documents"][0]["tables"] = copy.deepcopy(canonical["documents"][0]["canonical_tables"])
    canonical["candidate_manifest"] = compile_manifest(canonical, source_bundle_sha256="a" * 64)
    return canonical


base = fixture([table(
    "truncated", "doc.p4",
    [["Metric", "202", "203"], ["Revenue", "100", "110"], ["EBIT", "20", "22"]],
)])
assert len(target_inventory(base)) == 1
target = target_inventory(base)[0]
bundle_sha = "b" * 64
review = {
    "schema_version": "broker-period-header-review/1.0", "run_id": base["run_id"],
    "bundle_sha256": bundle_sha, "canonical_tables_sha256": base["canonical_tables_sha256"],
    "candidate_manifest_sha256": canonical_hash(base["candidate_manifest"]),
    "producer_id": "rogo-rendered-header-reader/1.0", "producer_fingerprint": "run-a",
    "reviewed_at": None,
    "decisions": [{
        "document_id": "doc", "surface_id": "doc.p4", "table_id": target["table_id"],
        "headers": [{"column": 2, "period_label": "2027E"}, {"column": 3, "period_label": "2028E"}],
        "rationale": "Both complete annual labels are visibly legible in the rendered grid.",
    }],
}
resolved, receipt = recover_period_headers(base, bundle_sha256=bundle_sha, review=review)
assert receipt["status"] == "PASS" and receipt["resolved_header_count"] == 2
assert target_inventory(resolved) == []
assert resolved["documents"][0]["tables"][0]["rows"][0][1]["raw_text"] == "202"
assert resolved["candidate_manifest"]["summary"]["unresolved_period_header_count"] == 0
assert any(
    candidate["label"] == "Revenue" and candidate["period_basis"] == "annual_forecast"
    for candidate in resolved["candidate_manifest"]["candidates"]
)

# A stale/tampered review cannot enter authority.
bad = copy.deepcopy(review)
bad["candidate_manifest_sha256"] = "0" * 64
try:
    recover_period_headers(base, bundle_sha256=bundle_sha, review=bad)
except ValueError as error:
    assert "candidate_manifest_sha256" in str(error)
else:
    raise AssertionError("stale period review was accepted")

# One readable period remains usable while the unresolved sibling column is
# source-quarantined. No guessed year enters the ledger.
partial = copy.deepcopy(review)
partial["decisions"][0]["headers"] = [{"column": 2, "period_label": "2027E"}]
degraded, degraded_receipt = recover_period_headers(
    base, bundle_sha256=bundle_sha, review=partial, quarantine_unresolved=True,
)
assert degraded_receipt["status"] == "PASS"
assert degraded_receipt["resolved_header_count"] == 1
assert degraded_receipt["quarantined_column_count"] == 1
assert degraded["summary"]["degraded"] is True
assert any(
    candidate["authority_status"] == "verified" and candidate["period_basis"] == "annual_forecast"
    for candidate in degraded["candidate_manifest"]["candidates"]
)
assert any(
    candidate["authority_status"] == "quarantined_conflict"
    for candidate in degraded["candidate_manifest"]["candidates"]
)

# A certified adjacent-page continuation is already resolved and must not
# create another adjudication task.
continued = fixture([
    table("p1", "doc.p1", [["Metric", "2027E", "2028E"], ["Revenue", "100", "110"]]),
    table("p2", "doc.p2", [["EBIT", "20", "22"]], title=""),
])
assert target_inventory(continued) == []

# Controller integration: a saved run must ask for the rendered header exactly
# once, accept the hash-bound review, reuse extraction, proceed through the
# semantic crosswalk and close without re-upload or a terminal internal stop.
with tempfile.TemporaryDirectory(prefix="broker-period-controller-") as temporary:
    root = Path(temporary)
    artifact_root = root / "artifacts"
    artifact_root.mkdir()
    documents = []
    rows_by_house = {
        "kepler": [["Metric", "202", "203"], ["Alpha series", "100", "110"]],
        "jpm": [["Metric", "2027E", "2028E"], ["Alpha series", "101", "111"]],
        "jefferies": [["Metric", "2027E", "2028E"], ["Alpha series", "102", "112"]],
    }
    source_dir = root / "sources"
    source_dir.mkdir()
    request_documents = []
    for house_id, rows in rows_by_house.items():
        document = build_house(
            document_id=house_id, house_id=house_id, house_name=house_id.title(),
            artifact_root=artifact_root, vision_required=False, clean_rows=rows,
        )
        source = source_dir / f"{house_id}.pdf"
        source.write_bytes(b"%PDF-period-controller " + house_id.encode())
        document["raw_sha256"] = broker.sha256_file(source)
        document["byte_length"] = source.stat().st_size
        documents.append(document)
        request_documents.append({
            "document_id": house_id, "house_id": house_id,
            "house_name": house_id.title(), "source_id": f"fixture.{house_id}",
            "path": str(source), "media_type": "application/pdf",
            "published_date": "2026-06-30", "expected_sha256": broker.sha256_file(source),
        })
    request = {
        "schema_version": "broker-extraction-request/1.0",
        "run_id": "period_controller", "documents": request_documents,
    }
    request_path = root / "request.json"
    write_json(request_path, request)
    output_root = root / "controller"
    output_root.mkdir()
    request_digest = broker.sha256_file(request_path)
    runtime_digest, _ = broker.runtime_closure()
    sources = broker.source_hashes(request, request_path.parent)
    cache_key = broker.sha256_bytes(broker.canonical_bytes({
        "request": request_digest, "sources": sources, "runtime": runtime_digest,
    }))
    key = cache_key[:16]
    seeded = {
        "schema_version": "broker-extraction-bundle/1.0", "run_id": request["run_id"],
        "created_at": "2026-08-13T00:00:00Z", "extractor_version": "fixture/1.0",
        "artifact_root": str(artifact_root), "documents": documents,
        "summary": {}, "gate_status": "PASS", "findings": [],
    }
    bundle_path = output_root / f"extract-{key}" / "broker-extraction-bundle.json"
    write_json(bundle_path, seeded)
    extract_input = broker.sha256_bytes(broker.canonical_bytes({
        "request": request_digest, "sources": sources, "runtime": runtime_digest,
    }))
    broker.seal_checkpoint(bundle_path, output_root / f"extract-{key}.receipt.json", extract_input)
    responses = root / "responses"
    responses.mkdir()
    state = invoke(request_path, output_root, responses, None)
    assert state["pipeline_status"] == "NEEDS_RESOLUTION", state
    assert state["user_blocking"] is False
    assert state["tasks"][0]["task_kind"] == "period_header_adjudication"
    active_path = Path(
        state["artifacts"].get("verified_bundle")
        or state["artifacts"]["canonical_bundle"]
    )
    active = json.loads(active_path.read_text("utf-8"))
    active_target = target_inventory(active)[0]
    write_json(responses / "broker-period-header-review.json", {
        "schema_version": "broker-period-header-review/1.0",
        "run_id": active["run_id"], "bundle_sha256": broker.sha256_file(active_path),
        "canonical_tables_sha256": active["canonical_tables_sha256"],
        "candidate_manifest_sha256": canonical_hash(active["candidate_manifest"]),
        "producer_id": "rogo-rendered-header-reader/1.0",
        "producer_fingerprint": "controller-integration-pass",
        "reviewed_at": None,
        "decisions": [{
            "document_id": active_target["document_id"],
            "surface_id": active_target["surface_id"],
            "table_id": active_target["table_id"],
            "headers": [
                {"column": 2, "period_label": "2027E"},
                {"column": 3, "period_label": "2028E"},
            ],
            "rationale": "The complete annual headers are visibly readable in the preserved rendered grid.",
        }],
    })
    state = invoke(request_path, output_root, responses, None)
    assert state["pipeline_status"] == "NEEDS_CROSSWALK", state
    verified_path = Path(state["artifacts"]["verified_bundle"])
    verified = json.loads(verified_path.read_text("utf-8"))
    assert target_inventory(verified) == []
    crosswalk_path = root / "crosswalk.json"
    controller_crosswalk = reference_only_crosswalk(verified)
    write_json(crosswalk_path, controller_crosswalk)
    state = invoke(request_path, output_root, responses, crosswalk_path)
    assert state["pipeline_status"] in {"PASS", "PASS_DEGRADED"}, state
    assert state["user_blocking"] is False
    integration_statuses = ["NEEDS_RESOLUTION", "NEEDS_CROSSWALK", state["pipeline_status"]]

print(json.dumps({
    "status": "PASS", "positive_checks": 14, "mutations_caught": 2,
    "resolved_headers": receipt["resolved_header_count"],
    "locally_quarantined_columns": degraded_receipt["quarantined_column_count"],
    "controller_statuses": integration_statuses,
}, sort_keys=True))
