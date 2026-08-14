#!/usr/bin/env python3
"""Positive and mutation tests for the internal evidence fixed-point seam."""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path

import run_attachment_evidence_pipeline as attachment
import run_broker_pipeline as broker
from compile_broker_candidate_manifest import compile_manifest
from compile_broker_pack import validate_coverage
from broker_terminal_recovery import (
    analyse_terminal_recovery,
    apply_terminal_review,
    automatic_negative_consumption_review,
    canonical_hash,
    validate_terminal_recovery_independently,
)
from workflow_state import assert_transition
from verify_broker_semantics import (
    verifier_selected_candidate_ids,
    verify_manifest_integrity,
    verify_terminal_recovery_independently,
)


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def prior_state(
    cache_key: str,
    tasks: list[dict],
    fixed_point: dict,
) -> dict:
    return {
        "cache_key": cache_key,
        "tasks": tasks,
        "fixed_point": fixed_point,
    }


def main() -> int:
    checks = 0
    cache_key = "a" * 64
    checkpoints = [{
        "stage": "extract",
        "status": "PASS",
        "input_sha256": "b" * 64,
        "output_sha256": "c" * 64,
        "reused": False,
    }]
    vision_task = {
        "task_kind": "independent_table_transcription",
        "document_id": "broker-a",
        "surface_id": "page-1",
        "image_path": "/run/page-1.png",
        "region_crops": [],
        "instruction": "Read the complete grid twice.",
    }

    boundary = broker.model_host_boundary()
    check(boundary["schema_version"] == "broker-model-host-response-boundary/1.0", "boundary did not load")
    for task_kind, declaration in boundary["tasks"].items():
        check(declaration["attempt_limit"] >= 1, f"{task_kind} has no finite budget")
        check(bool(declaration["steps"]), f"{task_kind} has no deterministic remedy")
        if declaration.get("response_schema_path"):
            check(len(declaration.get("response_schema_sha256", "")) == 64, f"{task_kind} schema is not hash-bound")
    checks += 1

    terminal_status, terminal_packets, terminal_fixed, _ = broker.seal_internal_work(
        prior={}, cache_key=cache_key, status="NEEDS_CROSSWALK_REVIEW",
        tasks=[{
            "task_kind": "terminal_materiality_recovery", "run_id": "ordinary-pack",
            "bundle_sha256": "6" * 64, "candidate_manifest_sha256": "7" * 64,
            "source_crosswalk_sha256": "8" * 64, "semantic_report_sha256": "9" * 64,
            "terminal_recovery_analysis": {"recoverable_candidate_ids": ["bc-" + "1" * 24]},
        }], checkpoints=checkpoints, summary={},
    )
    terminal_packet = terminal_packets[0]
    check(terminal_status == "NEEDS_CROSSWALK_REVIEW" and terminal_fixed["status"] == "OPEN", "terminal materiality response lane did not remain resumable")
    check(terminal_packet["model_host_response_boundary"]["expected_response_files"] == ["broker-terminal-materiality-review.json"], "terminal materiality response filename is not deterministic")
    check(terminal_packet["attempt_budget"]["attempts_remaining"] == 2, "terminal materiality response has no independent finite budget")
    checks += 3

    status1, tasks1, fixed1, _ = broker.seal_internal_work(
        prior={}, cache_key=cache_key, status="NEEDS_VISION",
        tasks=[vision_task], checkpoints=checkpoints, summary={},
    )
    check(status1 == "NEEDS_VISION" and fixed1["status"] == "OPEN", "first frontier did not remain internal and open")
    packet = tasks1[0]
    check(packet["user_blocking"] is False, "internal packet became user blocking")
    check(packet["attempt_budget"]["attempts_used"] == 0, "initial task consumed an attempt")
    check(packet["model_host_response_boundary"]["expected_response_files"] == ["page-1.pass1.json", "page-1.pass2.json"], "vision response filenames are not exact")
    check(packet["model_host_response_boundary"]["python_may_not_author_response"] is True, "Python authorship boundary is absent")
    checks += 4

    # One conflicted period in a visible row must no longer quarantine its
    # clean sibling periods. The immutable manifest partitions only the mixed
    # row, and the independent integrity verifier reconstructs that partition.
    conflict_id = "bvc-" + "a" * 24
    table = {
        "table_id": "mixed-table", "canonical_table_id": "mixed-table", "units": "millions",
        "rows": [
            [
                {"row": 1, "column": 1, "raw_text": "Metric", "source_ref": "s1"},
                {"row": 1, "column": 2, "raw_text": "2027E", "source_ref": "s2"},
                {"row": 1, "column": 3, "raw_text": "2028E", "source_ref": "s3"},
            ],
            [
                {"row": 2, "column": 1, "raw_text": "Revenue", "source_ref": "s4"},
                {"row": 2, "column": 2, "raw_text": "100", "value": 100, "value_kind": "number", "source_ref": "s5"},
                {"row": 2, "column": 3, "raw_text": "110", "value": 110, "value_kind": "number", "source_ref": "s6", "authority_status": "quarantined_conflict", "conflict_id": conflict_id},
            ],
        ],
    }
    mixed_bundle = {
        "run_id": "mixed-authority", "documents": [{
            "document_id": "mixed-doc", "house_id": "mixed-house",
            "canonical_tables": [table], "tables": [table],
        }],
    }
    mixed_manifest = compile_manifest(mixed_bundle, source_bundle_sha256="9" * 64)
    row_candidates = [item for item in mixed_manifest["candidates"] if item["row"] == 2]
    clean = next(item for item in row_candidates if item["authority_status"] == "verified")
    dirty = next(item for item in row_candidates if item["authority_status"] == "quarantined_conflict")
    check(len(row_candidates) == 2, "mixed-authority row was not partitioned at cell/period grain")
    check({cell["column"] for cell in clean["source_cells"]} == {1, 2} and {cell["column"] for cell in dirty["source_cells"]} == {3}, "conflicted period contaminated clean candidate cells")
    check(clean["period_indexes"][0]["period_label"] == "2027E" and dirty["period_indexes"][0]["period_label"] == "2028E", "period authority did not remain cell-addressed")
    check(not verify_manifest_integrity(mixed_bundle, mixed_manifest), "independent manifest verifier rejected cell-granular authority")
    checks += 4

    # Ordinary evidence which remains unused after bounded semantic review must
    # finish as a sealed, non-consumable quarantine instead of exhausting into
    # BLOCKED_INTERNAL.  This is the positive case that used to be missing.
    candidate_a = "bc-" + "1" * 24
    candidate_b = "bc-" + "2" * 24
    manifest = {
        "manifest_version": "broker-candidate-manifest/1.0", "run_id": "ordinary-pack", "gate_status": "PASS",
        "candidates": [
            {"candidate_id": candidate_a, "document_id": "doc-a", "house_id": "house-a", "table_id": "table-a", "row": 2, "label": "Valuation note", "period_basis": "non_periodic", "numeric": True, "source_cells": [{"row": 2, "column": 2}], "authority_status": "verified"},
            {"candidate_id": candidate_b, "document_id": "doc-b", "house_id": "house-b", "table_id": "table-b", "row": 3, "label": "Scenario reference", "period_basis": "non_periodic", "numeric": True, "source_cells": [{"row": 3, "column": 4}], "authority_status": "verified"},
        ],
    }
    bundle = {"run_id": "ordinary-pack", "candidate_manifest": manifest}
    fingerprint = {
        "concept_id": "custom.valuation_note", "measurement_basis": "unspecified",
        "restatement_basis": "not_applicable", "cash_flow_basis": "not_applicable",
        "lease_basis": "not_applicable", "units": "millions", "currency": "USD",
        "period_basis": "non_periodic", "sign_convention": "as_reported",
        "accounting_basis": "unspecified", "operating_scope": "unspecified",
    }
    crosswalk = {
        "schema_version": "broker-crosswalk/1.2", "run_id": "ordinary-pack",
        "as_of": "2026-08-12", "reporting_currency": "USD", "units": "millions",
        "forecast_periods": ["2027-12-31", "2028-12-31", "2029-12-31"],
        "metrics": {}, "mappings": [],
        "table_reviews": [{
            "house_id": "house-a", "table_id": "table-a", "classification": "non_forecast",
            "header_rows": [], "period_columns": [], "review_status": "reviewed",
            "rationale": "Evidence-only scenario material with no forecast columns.",
        }],
        "coverage_ledger": [
            {
                "candidate_id": candidate_a, "house_id": "house-a", "table_id": "table-a", "row": 2,
                "label": "Valuation note", "period_basis": "non_periodic", "period_indexes": [],
                "source_cells": [{"row": 2, "column": 2}], "parent_candidate_id": None,
                "semantic_role": "valuation_market_data", "economic_domain": "valuation",
                "concept_id": "custom.valuation_note", "model_use": "reference_only",
                "evidence_kind": "market_data", "definition_id": "custom.valuation_note",
                "definition_fingerprint": fingerprint, "definition_evidence": "Source label is valuation-only evidence.",
                "disposition": "not_model_relevant", "mapping_ids": [], "review_status": "reviewed",
                "rationale": "Preserved as valuation evidence and not selected as a forecast model driver.",
            },
            {
                "candidate_id": candidate_b, "house_id": "house-b", "table_id": "table-b", "row": 3,
                "model_use": "reference_only", "disposition": "not_model_relevant", "mapping_ids": [],
            },
        ],
    }
    semantic = {"findings": [{"code": "SEM-DEFINITION-EVIDENCE", "candidate_id": candidate_b}]}
    bindings = {
        "bundle_sha256": "6" * 64,
        "source_crosswalk_sha256": "7" * 64,
        "semantic_report_sha256": "8" * 64,
    }
    review = {
        "schema_version": "broker-terminal-materiality-review/1.0", "run_id": "ordinary-pack",
        **bindings, "candidate_manifest_sha256": canonical_hash(manifest),
        "producer_id": "model-host-test", "reviewed_at": None,
        "reviews": [{
            "candidate_id": candidate_b, "disposition": "preserve_unconsumed_quarantine",
            "model_consumption": "prohibited", "rationale": "Unused evidence is preserved exactly and prohibited from model consumption.",
        }],
    }
    analysis = analyse_terminal_recovery(bundle, crosswalk, semantic)
    check(analysis["can_recover"] and analysis["recoverable_candidate_ids"] == [candidate_b], "ordinary unused evidence did not enter terminal recovery")
    automatic_review = automatic_negative_consumption_review(
        bundle=bundle,
        crosswalk_sha256=bindings["source_crosswalk_sha256"],
        semantic_report_sha256=bindings["semantic_report_sha256"],
        semantic_report=semantic,
        bundle_sha256=bindings["bundle_sha256"],
    )
    automatically_recovered, automatic_receipt = apply_terminal_review(
        bundle=bundle, crosswalk=crosswalk, semantic_report=semantic,
        review=automatic_review, bundle_sha256=bindings["bundle_sha256"],
        crosswalk_sha256=bindings["source_crosswalk_sha256"],
        semantic_report_sha256=bindings["semantic_report_sha256"],
    )
    check(
        automatic_receipt["status"] == "PASS"
        and automatically_recovered["terminal_recovery"]["producer_id"]
        == "broker-controller-negative-consumption/1.0",
        "controller-owned exhausted-recovery fallback did not close without a model-host response",
    )
    recovered, recovery_receipt = apply_terminal_review(
        bundle=bundle, crosswalk=crosswalk, semantic_report=semantic, review=review,
        bundle_sha256=bindings["bundle_sha256"], crosswalk_sha256=bindings["source_crosswalk_sha256"],
        semantic_report_sha256=bindings["semantic_report_sha256"],
    )
    terminal_entries, terminal_errors = validate_terminal_recovery_independently(bundle, recovered)
    check(recovery_receipt["status"] == "PASS" and recovery_receipt["unresolved_selected_candidate_count"] == 0, "ordinary pack recovery did not seal PASS")
    check(set(terminal_entries) == {candidate_b} and not terminal_errors, "ordinary evidence quarantine is not independently valid")
    verifier_entries, verifier_errors = verify_terminal_recovery_independently(
        bundle, recovered, bundle_sha256=bindings["bundle_sha256"]
    )
    check(set(verifier_entries) == {candidate_b} and not verifier_errors, "independent semantic oracle rejected the terminal recovery contract")
    check(candidate_b not in {x["candidate_id"] for x in recovered["coverage_ledger"]}, "terminal candidate remained in the active semantic ledger")
    coverage_bundle = json.loads(json.dumps(bundle))
    coverage_bundle["documents"] = [{
        "document_id": "doc-a", "house_id": "house-a", "tables": [{
            "table_id": "table-a", "rows": [
                [{"source_ref": "table-a!R1C1", "value": None}, {"source_ref": "table-a!R1C2", "value": None}],
                [{"source_ref": "table-a!R2C1", "value": None}, {"source_ref": "table-a!R2C2", "value": "Valuation note"}],
            ],
        }],
    }]
    # Candidate B is terminal evidence from another captured table; include its
    # source owner so the compiler can independently validate the manifest.
    coverage_bundle["documents"].append({
        "document_id": "doc-b", "house_id": "house-b", "tables": [{
            "table_id": "table-b", "rows": [[], [], [
                {"source_ref": "table-b!R3C1", "value": None},
                {"source_ref": "table-b!R3C2", "value": None},
                {"source_ref": "table-b!R3C3", "value": None},
                {"source_ref": "table-b!R3C4", "value": "Scenario reference"},
            ]],
        }],
    })
    recovered["table_reviews"].append({
        "house_id": "house-b", "table_id": "table-b", "classification": "non_forecast",
        "header_rows": [], "period_columns": [], "review_status": "reviewed",
        "rationale": "Evidence-only scenario material with no forecast columns.",
    })
    documents_by_house = {item["house_id"]: item for item in coverage_bundle["documents"]}
    tables = {
        table["table_id"]: (document, table)
        for document in coverage_bundle["documents"] for table in document["tables"]
    }
    resolved_coverage, coverage_summary, _ = validate_coverage(
        recovered, documents_by_house, tables, [], candidate_manifest=manifest,
        semantic_violation_count=0, bundle=coverage_bundle, bundle_sha256="6" * 64,
    )
    check(coverage_summary["terminal_quarantined_candidate_count"] == 1 and coverage_summary["unresolved_selected_candidate_count"] == 0, "ordinary-pack compiler did not close the terminal evidence lane")
    check(any(item.get("disposition") == "preserve_unconsumed_quarantine" for item in resolved_coverage), "compiled coverage receipt lost terminal evidence")
    checks += 7

    # Actually selected cells and global-integrity findings still fail closed.
    # Potential core drivers that are not selected degrade to unavailable
    # evidence so the company forecast waterfall can continue.
    selected = json.loads(json.dumps(crosswalk))
    selected["coverage_ledger"][1].update({"model_use": "active_input", "disposition": "mapped_metric", "mapping_ids": ["map-b"]})
    selected_analysis = analyse_terminal_recovery(bundle, selected, semantic)
    check(not selected_analysis["can_recover"] and selected_analysis["blocking_findings"][0]["reason"] == "selected_model_candidate_unresolved", "selected candidate entered terminal recovery")
    misclassified = json.loads(json.dumps(crosswalk))
    misclassified_bundle = json.loads(json.dumps(bundle))
    misclassified_bundle["candidate_manifest"]["candidates"][1].update({
        "label": "Revenue", "period_basis": "annual_forecast", "numeric": True,
    })
    misclassified_analysis = analyse_terminal_recovery(misclassified_bundle, misclassified, semantic)
    check(misclassified_analysis["can_recover"], "unselected Revenue did not degrade to evidence quarantine")
    check(candidate_b in misclassified_analysis["recoverable_potential_driver_candidate_ids"], "Revenue was not disclosed as a degraded potential model driver")
    check(candidate_b not in verifier_selected_candidate_ids(misclassified_bundle, misclassified), "semantic oracle incorrectly treated unselected Revenue as consumed")
    decorated_bundle = json.loads(json.dumps(bundle))
    decorated_bundle["candidate_manifest"]["candidates"][1].update({
        "label": "Adjusted EBITDA (USDm)", "period_basis": "annual_forecast", "numeric": True,
    })
    decorated_analysis = analyse_terminal_recovery(decorated_bundle, crosswalk, semantic)
    check(decorated_analysis["can_recover"], "decorated unselected core driver did not degrade safely")
    check(candidate_b in decorated_analysis["recoverable_potential_driver_candidate_ids"], "decorated core driver was not disclosed in degraded authority inventory")
    check(candidate_b not in verifier_selected_candidate_ids(decorated_bundle, crosswalk), "semantic oracle incorrectly consumed decorated core driver")
    component_bundle = json.loads(json.dumps(bundle))
    component_bundle["candidate_manifest"]["candidates"][1].update({
        "label": "Product Sales", "period_basis": "annual_forecast", "numeric": True,
    })
    check(analyse_terminal_recovery(component_bundle, crosswalk, semantic)["can_recover"], "reference-only revenue component was over-classified as a core model driver")
    check(candidate_b not in verifier_selected_candidate_ids(component_bundle, crosswalk), "semantic oracle over-classified reference-only revenue component")
    global_analysis = analyse_terminal_recovery(bundle, crosswalk, {"findings": [{"code": "SEM-SOURCE-INTEGRITY"}]})
    check(not global_analysis["can_recover"] and global_analysis["blocking_findings"][0]["reason"] == "global_or_unbound_source_integrity_finding", "global integrity defect entered terminal recovery")
    mutated = json.loads(json.dumps(recovered))
    mutated["mappings"] = [{"sources": [{"table_id": "table-b", "row": 3, "column": 4}]}]
    _terminal_entries, mutation_errors = validate_terminal_recovery_independently(bundle, mutated)
    check(any("model-selected" in error for error in mutation_errors), "post-seal selected-cell mutation was not rejected")
    _entries, bundle_binding_errors = validate_terminal_recovery_independently(
        bundle, recovered, bundle_sha256="0" * 64
    )
    check(any("bundle bytes" in error for error in bundle_binding_errors), "terminal recovery accepted different verified bundle bytes")
    extra_field_review = json.loads(json.dumps(review))
    extra_field_review["invented_value"] = 123
    try:
        apply_terminal_review(
            bundle=bundle, crosswalk=crosswalk, semantic_report=semantic,
            review=extra_field_review, bundle_sha256=bindings["bundle_sha256"],
            crosswalk_sha256=bindings["source_crosswalk_sha256"],
            semantic_report_sha256=bindings["semantic_report_sha256"],
        )
    except ValueError as error:
        check("undeclared fields" in str(error), "terminal response seam rejected extra value for the wrong reason")
    else:
        raise AssertionError("terminal response seam accepted an undeclared invented value")
    checks += 11

    # CONTRACT (delivery-blocker constitution, v58): seal_internal_work's
    # BLOCKED_INTERNAL aggregation is the backstop for genuine controller
    # corruption/stall ONLY. Exhausted ORDINARY evidence ambiguity never
    # reaches this seal at the physical frontier any more — the controller
    # closes that lane PASS_DEGRADED with quarantine receipts first, proven
    # end to end by run_broker_degraded_close_tests.py.
    blocked_status, tasks4, fixed4, summary4 = broker.seal_internal_work(
        prior={}, cache_key=cache_key, status="BLOCKED_INTERNAL",
        tasks=[{"task_kind": "internal_fixed_point_defect", "instruction": "Repair selected-cell authority conflict."}],
        checkpoints=checkpoints, summary={},
    )
    check(blocked_status == "BLOCKED_INTERNAL" and len(tasks4) == 1, "selected/global terminal blocker was not aggregated")
    checks += 1

    crosswalk_task = {
        "task_kind": "semantic_crosswalk_review",
        "verified_bundle": "/run/verified.json",
        "candidate_manifest_sha256": "d" * 64,
        "instruction": "Review the manifest.",
    }
    _, crosswalk_packets, crosswalk_fixed, _ = broker.seal_internal_work(
        prior={}, cache_key=cache_key, status="NEEDS_CROSSWALK",
        tasks=[crosswalk_task], checkpoints=checkpoints, summary={},
    )
    regressed_status, regressed_tasks, regressed_fixed, _ = broker.seal_internal_work(
        prior=prior_state(cache_key, crosswalk_packets, crosswalk_fixed),
        cache_key=cache_key, status="NEEDS_VISION", tasks=[vision_task],
        checkpoints=checkpoints, summary={},
    )
    check(regressed_status == "NEEDS_VISION", "late-discovered vision work was terminalised")
    check(
        len(regressed_tasks) == 1
        and regressed_fixed["monotonic_from_prior"]
        and regressed_fixed["work_graph"]["schema_version"] == "broker-work-graph/1.0",
        "late task discovery did not append to the work graph",
    )
    assert_transition("broker", "NEEDS_RESOLUTION", "NEEDS_VISION")
    checks += 3

    try:
        broker.seal_internal_work(
            prior={}, cache_key=cache_key, status="NEEDS_VISION",
            tasks=[{"task_kind": "invented_unregistered_remedy"}],
            checkpoints=checkpoints, summary={},
        )
    except ValueError as error:
        check("registered deterministic remedy" in str(error), "unknown remedy failed for the wrong reason")
    else:
        raise AssertionError("unregistered internal remedy was accepted")
    checks += 1

    user_task = {"task_kind": "dcs_adapter_metadata", "instruction": "Provide export basis."}
    lanes = {
        "broker": {
            "pipeline_status": "NEEDS_VISION", "blocker_class": "INTERNAL_WORK",
            "user_blocking": False, "tasks": tasks1, "fixed_point": fixed1,
        },
        "dcs": {
            "pipeline_status": "BLOCKED_INPUT", "blocker_class": "USER_EVIDENCE",
            "user_blocking": True, "tasks": [user_task],
        },
    }
    projected, attachment_fixed = attachment.task_frontier(
        lanes, status="BLOCKED_INPUT", transaction_hash="e" * 64,
    )
    check(projected == [{"lane": "dcs", **user_task}], "internal broker task leaked beside a user evidence request")
    check(attachment_fixed["status"] == "USER_BOUNDARY", "typed user boundary was not preserved")
    checks += 2

    terminal_lanes = {
        "broker": {
            "pipeline_status": "BLOCKED_INTERNAL", "blocker_class": "INTERNAL_WORK",
            "user_blocking": False, "tasks": tasks4, "fixed_point": fixed4,
        },
        "filings": {
            "pipeline_status": "BLOCKED_INTERNAL", "blocker_class": "INTERNAL_WORK",
            "user_blocking": False,
            "tasks": [{"task_kind": "internal_fixed_point_defect", "task_id": "filings-defect"}],
        },
    }
    # Same contract at the attachment layer: this aggregation path is for
    # lanes that are GENUINELY internally defective. A broker lane that closed
    # PASS_DEGRADED is accepted by classify() as a closed lane and never
    # reaches this frontier (run_broker_degraded_close_tests.py).
    aggregate, attachment_terminal = attachment.task_frontier(
        terminal_lanes, status="BLOCKED_INTERNAL", transaction_hash="f" * 64,
    )
    check(len(aggregate) == 1 and aggregate[0]["task_kind"] == "internal_fixed_point_defect", "attachment did not aggregate terminal lane defects")
    check(aggregate[0]["user_blocking"] is False, "attachment aggregate became a user blocker")
    check(attachment_terminal["aggregate_terminal_defect_count"] == 1, "attachment emitted more than one terminal defect")
    checks += 3

    semantic_attempts = {
        "execution_response_sha256": [],
        "vision_response_sha256": [],
        "vision_attempt_count": 0,
        "vision_attempt_limit": 3,
        "task_execution_receipts": {},
    }
    semantic_status, semantic_tasks, semantic_fixed, _ = broker.seal_internal_work(
        prior={},
        cache_key=cache_key,
        status="NEEDS_CROSSWALK_REVIEW",
        tasks=[{
            "task_kind": "semantic_crosswalk_repair",
            "candidate_manifest_sha256": "9" * 64,
        }],
        checkpoints=checkpoints,
        summary={},
        attempts=semantic_attempts,
    )
    semantic_prior = {
        "cache_key": cache_key,
        "pipeline_status": semantic_status,
        "tasks": semantic_tasks,
        "fixed_point": semantic_fixed,
        "work_graph": semantic_fixed["work_graph"],
    }
    broker.record_task_execution_attempt(
        semantic_attempts,
        semantic_prior,
        "7" * 64,
        {"semantic_crosswalk_repair"},
    )
    broker.record_task_execution_attempt(
        semantic_attempts,
        semantic_prior,
        "7" * 64,
        {"semantic_crosswalk_repair"},
    )
    check(
        broker.task_family_execution_count(
            semantic_attempts,
            semantic_prior,
            {"semantic_crosswalk_repair"},
        ) == 1,
        "duplicate semantic response consumed two executions",
    )
    broker.record_task_execution_attempt(
        semantic_attempts,
        semantic_prior,
        "8" * 64,
        {"semantic_crosswalk_repair"},
    )
    check(
        broker.task_family_execution_count(
            semantic_attempts,
            semantic_prior,
            {"semantic_crosswalk_repair"},
        ) == 2,
        "distinct semantic responses did not advance the task-family budget",
    )
    check(
        semantic_attempts["vision_attempt_count"] == 0,
        "semantic repair incorrectly consumed the physical-vision budget",
    )
    checks += 3

    with tempfile.TemporaryDirectory(prefix="excel-inflow-fixed-point-") as temporary:
        root = Path(temporary)
        output = root / "output.json"
        receipt = root / "receipt.json"
        output.write_text(json.dumps({"status": "PASS"}), "utf-8")
        input_digest = "1" * 64
        broker.seal_checkpoint(output, receipt, input_digest)
        check(broker.reusable(output, receipt, input_digest), "valid checkpoint was not reusable")
        output.write_text(json.dumps({"status": "MUTATED"}), "utf-8")
        check(not broker.reusable(output, receipt, input_digest), "mutated checkpoint was reused")
        state_path = root / "broker-run-state.json"
        graph_hashes = []
        graph_revisions = []
        for expected_status in ("NEEDS_VISION", "NEEDS_VISION", "NEEDS_VISION"):
            state = broker.write_state(
                state_path,
                run_id="fixed-point-test",
                status="NEEDS_VISION",
                request_digest="2" * 64,
                sources={"broker-a": "3" * 64},
                runtime_digest="4" * 64,
                cache_key=cache_key,
                checkpoints=checkpoints,
                artifacts={},
                tasks=[vision_task],
                summary={},
                user_blocking=False,
                blocker_class="INTERNAL_WORK",
            )
            check(state["pipeline_status"] == expected_status, "persisted fixed point did not obey its finite retry sequence")
            check(
                state["tasks"][0]["attempt_budget"]["attempts_used"] == 0,
                "polling consumed a task execution attempt",
            )
            graph_hashes.append(state["work_graph"]["graph_sha256"])
            graph_revisions.append(state["work_graph"]["revision"])
        persisted = json.loads(state_path.read_text("utf-8"))
        check("fixed_point" in persisted and len(persisted["tasks"]) == 1, "persisted broker state omitted its aggregate fixed point")
        check(len(set(graph_hashes)) == 1 and len(set(graph_revisions)) == 1, "unchanged polling mutated the work graph")
    checks += 8

    print(json.dumps({
        "status": "PASS",
        "checks": checks,
        "positive_checks": checks - 10,
        "mutation_checks": 10,
        "total_violation_count": 0,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
