#!/usr/bin/env python3
"""Positive and mutation tests for the internal evidence fixed-point seam."""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path

import run_attachment_evidence_pipeline as attachment
import run_broker_pipeline as broker
from workflow_state import assert_transition


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

    previous = prior_state(cache_key, tasks1, fixed1)
    for expected_retry in (1, 2):
        status, tasks, fixed, _ = broker.seal_internal_work(
            prior=previous, cache_key=cache_key, status="NEEDS_VISION",
            tasks=[vision_task], checkpoints=checkpoints, summary={},
        )
        check(status == "NEEDS_VISION", "frontier terminated before its finite retry budget")
        check(fixed["unchanged_retry_count"] == expected_retry, "unchanged retry count is not monotonic")
        previous = prior_state(cache_key, tasks, fixed)
    status4, tasks4, fixed4, summary4 = broker.seal_internal_work(
        prior=previous, cache_key=cache_key, status="NEEDS_VISION",
        tasks=[vision_task], checkpoints=checkpoints, summary={},
    )
    check(status4 == "BLOCKED_INTERNAL", "exhausted fixed point did not terminate internally")
    check(len(tasks4) == 1 and tasks4[0]["task_kind"] == "internal_fixed_point_defect", "stall did not collapse to one aggregate defect")
    check(tasks4[0]["user_blocking"] is False, "aggregate internal defect became user blocking")
    check(fixed4["status"] == "TERMINAL_DEFECT" and summary4["aggregate_internal_defect_count"] == 1, "terminal fixed-point receipt is incomplete")
    checks += 6

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
    check(regressed_status == "BLOCKED_INTERNAL", "stage regression was accepted")
    check(len(regressed_tasks) == 1 and not regressed_fixed["monotonic_from_prior"], "stage regression did not become one defect")
    try:
        assert_transition("broker", "NEEDS_RESOLUTION", "NEEDS_VISION")
    except ValueError:
        pass
    else:
        raise AssertionError("workflow constitution admitted a resolution-to-vision regression")
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
    aggregate, attachment_terminal = attachment.task_frontier(
        terminal_lanes, status="BLOCKED_INTERNAL", transaction_hash="f" * 64,
    )
    check(len(aggregate) == 1 and aggregate[0]["task_kind"] == "internal_fixed_point_defect", "attachment did not aggregate terminal lane defects")
    check(aggregate[0]["user_blocking"] is False, "attachment aggregate became a user blocker")
    check(attachment_terminal["aggregate_terminal_defect_count"] == 1, "attachment emitted more than one terminal defect")
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
        for expected_status in (
            "NEEDS_VISION", "NEEDS_VISION", "NEEDS_VISION", "BLOCKED_INTERNAL",
        ):
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
        persisted = json.loads(state_path.read_text("utf-8"))
        check("fixed_point" in persisted and len(persisted["tasks"]) == 1, "persisted broker state omitted its aggregate fixed point")
    checks += 7

    print(json.dumps({
        "status": "PASS",
        "checks": checks,
        "positive_checks": checks - 4,
        "mutation_checks": 4,
        "total_violation_count": 0,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
