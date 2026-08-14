#!/usr/bin/env python3
"""Focused positive and mutation tests for broker/DCS evidence controllers."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vision = load("excel_inflow_compile_broker_vision", HERE / "compile_broker_vision.py")
broker = load("excel_inflow_run_broker_pipeline", HERE / "run_broker_pipeline.py")
attachment = load(
    "excel_inflow_run_attachment_evidence_pipeline",
    HERE / "run_attachment_evidence_pipeline.py",
)


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    checks = 0
    table_passes = [
        {
            "surface_disposition": "analytical_tables",
            "tables": [{"title": "Forecasts", "units": "GBP m", "rows": [["", "2026E"], ["EBIT", "100"]]}],
        },
        {
            "surface_disposition": "analytical_tables",
            "tables": [{"title": "Forecasts", "units": "GBP m", "rows": [["", "2026E"], ["EBIT", "100"]]}],
        },
    ]
    disposition, error = vision.classify_surface_disposition(table_passes)
    assert_true(disposition == "analytical_tables" and error is None, "analytical table consensus did not close")
    checks += 1

    attempts = {
        "vision_response_sha256": [],
        "vision_attempt_count": 0,
        "vision_attempt_limit": 3,
    }
    assert_true(broker.record_vision_attempt(attempts, "a" * 64) is False, "first vision attempt exhausted early")
    assert_true(broker.record_vision_attempt(attempts, "a" * 64) is False, "duplicate response consumed an attempt")
    assert_true(broker.record_vision_attempt(attempts, "b" * 64) is False, "second unique vision execution exhausted early")
    assert_true(broker.record_vision_attempt(attempts, "c" * 64) is True, "three distinct vision executions did not exhaust the bounded remedy")
    assert_true(len(attempts["vision_response_sha256"]) == 3, "vision audit ledger did not retain one entry per unique execution")
    checks += 1

    internal = {"broker": {"pipeline_status": "NEEDS_VISION", "blocker_class": "INTERNAL_WORK"}}
    assert_true(
        attachment.classify(internal) == ("NEEDS_INTERNAL_WORK", "INTERNAL_WORK", False),
        "top-level controller turned internal broker work into a user stop",
    )
    fatal = {"dcs": {"pipeline_status": "BLOCKED_INPUT", "blocker_class": "FATAL_SOURCE"}}
    assert_true(
        attachment.classify(fatal) == ("BLOCKED_INPUT", "FATAL_SOURCE", True),
        "top-level controller did not preserve a genuine fatal source blocker",
    )
    passed = {
        "broker": {"pipeline_status": "PASS", "blocker_class": None},
        "dcs": {"pipeline_status": "PASS", "blocker_class": None},
    }
    assert_true(attachment.classify(passed) == ("PASS", None, False), "two passed lanes did not close")
    checks += 3

    with tempfile.TemporaryDirectory(prefix="excel-inflow-attachment-controller-") as temporary:
        root = Path(temporary)
        missing_request = attachment.run_lane(
            "broker",
            {"request_path": "internal-request.json"},
            root,
            root / "run",
        )
        assert_true(
            missing_request["blocker_class"] == "INTERNAL_WORK"
            and missing_request["user_blocking"] is False,
            "a missing internal controller declaration became a user re-upload request",
        )
        checks += 1
    with tempfile.TemporaryDirectory(prefix="excel-inflow-optional-broker-supervisor-") as temporary:
        root = Path(temporary)
        request = root / "broker-request.json"
        request.write_text("{}\n", "utf-8")
        output = root / "run"
        calls: list[list[str]] = []
        original_run = attachment.run

        def fake_run(command: list[str]) -> subprocess.CompletedProcess[str]:
            calls.append(command)
            state_path = output / "broker" / "broker-run-state.json"
            state_path.parent.mkdir(parents=True, exist_ok=True)
            closed = "--close-optional" in command
            state_path.write_text(json.dumps({
                "schema_version": "broker-run-state/1.0",
                "pipeline_status": "PASS_DEGRADED" if closed else "NEEDS_VISION",
                "user_blocking": False,
                "blocker_class": None if closed else "INTERNAL_WORK",
                "tasks": [] if closed else [{"task_kind": "independent_table_transcription"}],
                "artifacts": {},
                "artifact_sha256": {},
                "summary": {"degraded": closed},
            }), "utf-8")
            return subprocess.CompletedProcess(command, 0 if closed else 2, "", "")

        attachment.run = fake_run
        try:
            closed_state = attachment.run_lane(
                "broker",
                {"request_path": str(request)},
                root,
                output,
            )
        finally:
            attachment.run = original_run
        assert_true(
            closed_state["pipeline_status"] == "PASS_DEGRADED",
            "top attachment supervisor did not contain optional broker work",
        )
        assert_true(
            len(calls) == 2 and "--close-optional" in calls[1],
            "top attachment supervisor did not execute one normal pass then its circuit breaker",
        )
        checks += 2
    with tempfile.TemporaryDirectory(prefix="excel-inflow-broker-context-") as temporary:
        root = Path(temporary)
        broker_request = root / "broker-request.json"
        broker_request.write_text(json.dumps({
            "schema_version": "broker-extraction-request/1.0",
            "run_id": "broker-context-test",
            "documents": [],
        }), "utf-8")
        evidence = root / "evidence.json"
        evidence.write_text(json.dumps({"filings": {}}), "utf-8")
        ingress = root / "ingress.json"
        ingress.write_text(json.dumps({"evidence_run_path": str(evidence)}), "utf-8")
        filings_bundle = root / "filings-bundle.json"
        filings_bundle.write_text(json.dumps({
            "filings": {
                "historical_periods": ["2023-12-31", "2024-12-31", "2025-12-31"],
                "forecast_periods": ["2026-12-31", "2027-12-31", "2028-12-31"],
                "reporting_currency": "GBP",
                "units": "millions",
            },
        }), "utf-8")
        spec_path = root / "spec.json"
        spec = {
            "attachment_ingress_path": str(ingress),
            "broker": {"request_path": str(broker_request)},
        }
        spec_path.write_text(json.dumps(spec), "utf-8")
        declaration = attachment.broker_declaration_with_model_context(
            spec=spec,
            spec_path=spec_path,
            output_root=root / "run",
            filings_state={"artifacts": {"filings_bundle": str(filings_bundle)}},
        )
        derived = json.loads(Path(declaration["request_path"]).read_text("utf-8"))
        assert_true(
            derived["model_context"] == {
                "as_of": "2025-12-31",
                "reporting_currency": "GBP",
                "units": "millions",
                "forecast_periods": ["2026-12-31", "2027-12-31", "2028-12-31"],
            },
            "broker optional-close request did not inherit the sealed filings basis",
        )
        checks += 1
    assert_true(vision.transcription_structure(table_passes[0]["tables"][0])["is_grid"], "labelled period grid was not recognized")
    checks += 1

    non_tabular_passes = [
        {"surface_disposition": "verified_non_tabular", "tables": [], "non_tabular_reason": "Narrative paragraph with valuation multiples."},
        {"surface_disposition": "verified_non_tabular", "tables": [], "non_tabular_reason": "Narrative text, no row/period grid."},
    ]
    disposition, error = vision.classify_surface_disposition(non_tabular_passes)
    assert_true(disposition == "verified_non_tabular" and error is None, "verified non-tabular consensus did not close")
    checks += 1

    mixed = [table_passes[0], non_tabular_passes[1]]
    disposition, error = vision.classify_surface_disposition(mixed)
    assert_true(disposition is None and error, "mixed physical dispositions did not remain unresolved")
    checks += 1

    conflict_manifest = {
        "conflicts": [
            {
                "conflict_id": "bvc-" + "1" * 24,
                "requires_targeted_adjudication": True,
            },
            {
                "conflict_id": "bvc-" + "2" * 24,
                "requires_targeted_adjudication": False,
                "auto_resolution_source": "pass1_native_corroborated",
            },
        ],
    }
    quarantined = vision.bounded_quarantine_decisions(conflict_manifest)
    assert_true(
        list(quarantined) == ["bvc-" + "1" * 24]
        and quarantined["bvc-" + "1" * 24]["status"] == "quarantined",
        "bounded visual fallback did not quarantine every and only unresolved cells",
    )
    assert_true(
        broker.prior_targeted_resolution_attempted({
            "tasks": [{"task_kind": "targeted_cell_adjudication"}],
        })
        and not broker.prior_targeted_resolution_attempted({
            "tasks": [{"task_kind": "independent_table_transcription"}],
        }),
        "controller did not distinguish first visual read from exhausted targeted recovery",
    )
    checks += 2

    try:
        broker.write_state(
            Path("unused.json"), run_id="test", status="NEEDS_VISION",
            request_digest="0" * 64, sources={"doc": "1" * 64},
            runtime_digest="2" * 64, cache_key="3" * 64,
            checkpoints=[], artifacts={}, tasks=[], summary={},
            user_blocking=True, blocker_class="INTERNAL_WORK",
        )
    except ValueError:
        pass
    else:
        raise AssertionError("internal broker work was allowed to become user-blocking")
    checks += 1

    with tempfile.TemporaryDirectory(prefix="excel-inflow-dcs-controller-") as temporary:
        root = Path(temporary)
        source = root / "dcs.csv"
        source.write_text("Description,Amount,Maturity\nBond A,100,2028-12-31\n", "utf-8")
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        request = root / "request.json"
        request.write_text(json.dumps({
            "schema_version": "dcs-extraction-request/1.0",
            "run_id": "dcs-controller-test",
            "source_path": str(source),
            "expected_sha256": source_hash,
        }), "utf-8")
        output = root / "run"
        command = [sys.executable, str(HERE / "run_dcs_pipeline.py"), str(request), "--out", str(output)]
        first = subprocess.run(command, text=True, capture_output=True, check=False)
        assert_true(first.returncode == 2, first.stderr or first.stdout)
        state = json.loads((output / "dcs-run-state.json").read_text("utf-8"))
        assert_true(state["pipeline_status"] == "BLOCKED_INPUT", "DCS controller did not stop at the missing export-basis boundary")
        assert_true(state["blocker_class"] == "USER_EVIDENCE" and state["user_blocking"] is True, "Missing DCS export basis was not owned as precise user evidence")
        assert_true(
            state["tasks"] == [{
                "task_kind": "dcs_adapter_metadata",
                "instruction": "Provide the export basis once; the controller will author and verify the cell-level crosswalk internally.",
                "required_fields": ["as_of", "entity_name", "reporting_currency", "units"],
            }],
            "DCS controller exposed an internal crosswalk task instead of one finite export-basis request",
        )
        checks += 3
        second = subprocess.run(command, text=True, capture_output=True, check=False)
        assert_true(second.returncode == 2, second.stderr or second.stdout)
        resumed = json.loads((output / "dcs-run-state.json").read_text("utf-8"))
        extract = next(item for item in resumed["checkpoints"] if item["stage"] == "extract")
        assert_true(extract["reused"] is True, "DCS extraction checkpoint was not reused")
        checks += 1

        source.write_text("Description,Amount,Maturity\nBond A,101,2028-12-31\n", "utf-8")
        mutated = subprocess.run(command, text=True, capture_output=True, check=False)
        assert_true(mutated.returncode != 0 and "expected_sha256" in (mutated.stderr + mutated.stdout), "raw-source mutation escaped the DCS hash gate")
        checks += 1

    print(json.dumps({"status": "PASS", "checks": checks, "total_violation_count": 0}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
