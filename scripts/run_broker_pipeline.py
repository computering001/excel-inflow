#!/usr/bin/env python3
"""Run and resume the complete Excel Inflow broker-evidence transaction.

The command owns sequencing and persistence.  Vision and semantic review remain
external evidence-producing acts, but their task packets are machine-authored
here and their results can only re-enter through hash-bound checkpoints.  An
internal NEEDS_* state is work for the controller, never a request to replace an
ordinary readable broker report.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from broker_terminal_recovery import (
    analyse_terminal_recovery,
    apply_terminal_review,
    automatic_negative_consumption_review,
    compile_demand_selected_crosswalk,
    compile_reference_only_crosswalk,
    degrade_all_broker_authority,
    degrade_finding_houses,
)
from broker_period_recovery import canonical_hash as period_canonical_hash, target_inventory as period_target_inventory
from pre_broker_demand import normalize_pre_broker_demand
from broker_work_graph import build_work_graph, verify_work_graph
from workflow_state import assert_state, assert_transition


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUNTIME_MANIFEST = ROOT / "assets" / "broker-runtime-members.json"
MODEL_HOST_BOUNDARY = ROOT / "assets" / "broker-model-host-response-boundary-v1.json"
VISION_ATTEMPT_LIMIT = 3

def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def prior_targeted_resolution_attempted(state: dict[str, Any]) -> bool:
    # The internal_fixed_point_defect aggregate REPLACES the targeted tasks it
    # summarises; forgetting that history un-armed the quarantine fallback at
    # the exact moment it was needed (the v57 live Astra defect).
    return any(
        task.get("task_kind") in {
            "targeted_cell_adjudication",
            "bounded_capture_adjudication",
            "internal_fixed_point_defect",
        }
        for task in state.get("tasks", [])
    )


def bounded_recovery_exhausted(state: dict[str, Any], attempts: dict[str, Any]) -> bool:
    """The finite terminal signal for ordinary evidence ambiguity.

    True once the vision attempt budget is spent or the internal fixed point
    stalled to its retry limit. From here the physical lane must CLOSE
    (degraded, evidence preserved, quarantine receipts) rather than loop or
    terminate the run.
    """
    # Once the controller has opened the dedicated bounded-capture family, its
    # own two accepted, task-bound decisions supersede the coarser full-surface
    # counter. Merely reaching the earlier vision limit must not make the newly
    # advertised two-round task impossible to execute.
    bounded_family_present = any(
        task.get("task_kind") == "bounded_capture_adjudication"
        for task in state.get("tasks", [])
    ) or any(
        node.get("node_kind") == "task"
        and node.get("task_kind") == "bounded_capture_adjudication"
        for node in (state.get("work_graph") or {}).get("nodes", [])
    )
    if bounded_family_present:
        limit = int(
            model_host_boundary()["tasks"]["bounded_capture_adjudication"][
                "attempt_limit"
            ]
        )
        return task_family_execution_count(
            attempts, state, {"bounded_capture_adjudication"}
        ) >= limit
    if int(attempts.get("vision_attempt_count", 0)) >= int(
        attempts.get("vision_attempt_limit", VISION_ATTEMPT_LIMIT)
    ):
        return True
    fixed = state.get("fixed_point", {}) or {}
    limit = int(fixed.get("unchanged_retry_limit") or 0)
    if limit and int(fixed.get("unchanged_retry_count") or 0) + 1 >= limit:
        return True
    if fixed.get("status") == "TERMINAL_DEFECT":
        return True
    if prior_targeted_resolution_attempted(state):
        return True
    return any(
        task.get("task_kind") == "internal_fixed_point_defect"
        for task in state.get("tasks", [])
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text("utf-8"))
    except Exception as error:
        raise ValueError(f"{label} is not readable JSON: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must be a JSON object.")
    return payload


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = canonical_bytes(value)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def runtime_closure() -> tuple[str, dict[str, str]]:
    manifest = read_json(RUNTIME_MANIFEST, "broker runtime-members manifest")
    if manifest.get("schema_version") != "broker-runtime-members/1.0":
        raise ValueError("The broker runtime-members manifest has the wrong schema version.")
    runtime_members = manifest.get("members")
    if not isinstance(runtime_members, list) or not runtime_members or len(runtime_members) != len(set(runtime_members)):
        raise ValueError("The broker runtime-members manifest must contain one non-empty unique member list.")
    members: dict[str, str] = {}
    for relative in runtime_members:
        if not isinstance(relative, str) or relative.startswith("/") or ".." in Path(relative).parts:
            raise ValueError(f"Invalid broker runtime member: {relative!r}")
        target = ROOT / relative
        if not target.is_file():
            raise FileNotFoundError(f"Broker runtime member is absent: {relative}")
        members[relative] = sha256_file(target)
    return sha256_bytes(canonical_bytes(members)), members


def model_host_boundary() -> dict[str, Any]:
    """Load the closed model-host response seam and bind every referenced schema.

    Python owns orchestration and validation only.  It must never manufacture a
    visual transcription or a semantic crosswalk.  The deployment model host
    authors those declared response artifacts; the controller accepts them only
    through this hash-bound seam.
    """
    value = read_json(MODEL_HOST_BOUNDARY, "broker model-host response boundary")
    if value.get("schema_version") != "broker-model-host-response-boundary/1.0":
        raise ValueError("The broker model-host response boundary has the wrong schema version.")
    if not isinstance(value.get("stall_attempt_limit"), int) or value["stall_attempt_limit"] < 1:
        raise ValueError("The broker model-host response boundary has no finite stall limit.")
    tasks = value.get("tasks")
    if not isinstance(tasks, dict) or not tasks:
        raise ValueError("The broker model-host response boundary has no task registry.")
    for task_kind, declaration in tasks.items():
        if not isinstance(declaration, dict):
            raise ValueError(f"Model-host task {task_kind!r} is not an object.")
        if not declaration.get("remedy_id") or not isinstance(declaration.get("steps"), list):
            raise ValueError(f"Model-host task {task_kind!r} has no deterministic remedy.")
        if not isinstance(declaration.get("attempt_limit"), int) or declaration["attempt_limit"] < 1:
            raise ValueError(f"Model-host task {task_kind!r} has no finite attempt limit.")
        schema_relative = declaration.get("response_schema_path")
        if schema_relative is None:
            continue
        schema_path = ROOT / str(schema_relative)
        if not schema_path.is_file():
            raise FileNotFoundError(
                f"Model-host task {task_kind!r} references an absent response schema."
            )
        declaration["response_schema_sha256"] = sha256_file(schema_path)
    value["boundary_sha256"] = sha256_file(MODEL_HOST_BOUNDARY)
    return value


def task_response_files(task: dict[str, Any]) -> list[str]:
    surface_id = str(task.get("surface_id") or "").strip()
    kind = str(task.get("task_kind") or "")
    if kind == "independent_table_transcription" and surface_id:
        return [f"{surface_id}.pass1.json", f"{surface_id}.pass2.json"]
    if kind == "targeted_cell_adjudication" and surface_id:
        return [f"{surface_id}.resolution.json"]
    if kind == "bounded_capture_adjudication" and surface_id:
        return [f"{surface_id}.bounded-capture-decision.json"]
    if kind == "period_header_adjudication":
        return ["broker-period-header-review.json"]
    if kind in {
        "semantic_crosswalk_review",
        "semantic_crosswalk_repair",
        "broker_pack_repair",
    }:
        return ["broker-crosswalk.json"]
    if kind == "terminal_materiality_recovery":
        return ["broker-terminal-materiality-review.json"]
    return []


def bounded_capture_pass_sha256s(
    responses: Path | None, surface_id: str
) -> dict[str, str] | None:
    if responses is None:
        return None
    paths = {
        "pass1": responses / f"{surface_id}.pass1.json",
        "pass2": responses / f"{surface_id}.pass2.json",
    }
    if not all(path.is_file() for path in paths.values()):
        return None
    return {name: sha256_file(path) for name, path in paths.items()}


def bounded_capture_tasks(
    tasks: list[dict[str, Any]], responses: Path | None
) -> list[dict[str, Any]]:
    """Promote exhausted full-surface work into one stable decision family."""
    output: list[dict[str, Any]] = []
    for task in tasks:
        surface_id = str(task.get("surface_id") or "")
        pass_sha256s = bounded_capture_pass_sha256s(responses, surface_id)
        if not pass_sha256s:
            raise ValueError(
                f"Bounded capture for {surface_id!r} requires both prior pass files."
            )
        output.append({
            "task_kind": "bounded_capture_adjudication",
            "document_id": task.get("document_id"),
            "surface_id": surface_id,
            "prior_task": copy.deepcopy(task),
            "prior_response_sha256s": pass_sha256s,
            "instruction": (
                "The bounded full-surface reads are exhausted. Read only the remaining "
                "physical regions. Supply genuinely replacement pass files for at most one "
                "further round, or prohibit every still-unresolved region from model use. "
                "Do not invent conflict IDs, cells or values."
            ),
        })
    return output


def validate_bounded_capture_response(
    task: dict[str, Any], response: dict[str, Any], responses: Path
) -> list[str]:
    """Validate the narrow decision without importing the vision-result schema."""
    allowed = {
        "schema_version", "task_id", "task_input_sha256", "round_index",
        "document_id", "surface_id", "source_image_sha256", "producer_id",
        "producer_fingerprint", "decision", "replacement_pass_sha256s",
        "rationale",
    }
    required = allowed - {"replacement_pass_sha256s"}
    errors: list[str] = []
    unknown = sorted(set(response) - allowed)
    missing = sorted(required - set(response))
    if unknown:
        errors.append(f"undeclared fields: {', '.join(unknown)}")
    if missing:
        errors.append(f"missing fields: {', '.join(missing)}")
    if response.get("schema_version") != "broker-bounded-capture-decision/1.0":
        errors.append("schema_version is not broker-bounded-capture-decision/1.0")
    if response.get("task_id") != task.get("task_id"):
        errors.append("task_id does not bind the open bounded-capture task")
    if response.get("task_input_sha256") != (
        task.get("progress_measure") or {}
    ).get("task_input_sha256"):
        errors.append("task_input_sha256 does not bind the open task input")
    expected_round = int((task.get("attempt_budget") or {}).get("attempts_used", 0)) + 1
    if response.get("round_index") != expected_round or expected_round not in {1, 2}:
        errors.append("round_index is not the next finite bounded-capture round")
    if response.get("document_id") != task.get("document_id"):
        errors.append("document_id does not bind the open task")
    if response.get("surface_id") != task.get("surface_id"):
        errors.append("surface_id does not bind the open task")
    prior_task = task.get("prior_task") or {}
    expected_image = prior_task.get("image_sha256") or task.get("image_sha256")
    if not expected_image or response.get("source_image_sha256") != expected_image:
        errors.append("source_image_sha256 does not bind the task's rendered source")
    for field in ("producer_id", "producer_fingerprint", "rationale"):
        if not isinstance(response.get(field), str) or not response[field].strip():
            errors.append(f"{field} must be a non-empty string")

    decision = response.get("decision")
    if decision not in {
        "retry_with_replacement_reads", "quarantine_remaining_regions"
    }:
        errors.append("decision is not a registered bounded-capture disposition")
    elif decision == "retry_with_replacement_reads":
        replacement = response.get("replacement_pass_sha256s")
        current = bounded_capture_pass_sha256s(
            responses, str(task.get("surface_id") or "")
        )
        prior = task.get("prior_response_sha256s")
        if not isinstance(replacement, dict) or set(replacement) != {"pass1", "pass2"}:
            errors.append("replacement_pass_sha256s must bind pass1 and pass2 exactly")
        elif replacement != current:
            errors.append("replacement pass hashes do not match the supplied pass files")
        elif not isinstance(prior, dict) or any(
            replacement[name] == prior.get(name) for name in ("pass1", "pass2")
        ):
            errors.append("both replacement reads must differ from the prior round")
    elif "replacement_pass_sha256s" in response:
        errors.append("a quarantine decision cannot claim replacement pass hashes")
    return errors


def bounded_capture_responses(
    prior_state: dict[str, Any], responses: Path | None
) -> tuple[list[dict[str, Any]], list[str]]:
    accepted: list[dict[str, Any]] = []
    errors: list[str] = []
    for task in prior_state.get("tasks", []):
        if task.get("task_kind") != "bounded_capture_adjudication":
            continue
        names = task_response_files(task)
        target = responses / names[0] if responses is not None and names else None
        if target is None or not target.is_file():
            errors.append(f"{task.get('task_id')}: bounded-capture decision is missing")
            continue
        try:
            response = read_json(target, "bounded-capture decision")
        except ValueError as error:
            errors.append(f"{task.get('task_id')}: {error}")
            continue
        response_errors = validate_bounded_capture_response(task, response, responses)
        if response_errors:
            errors.extend(
                f"{task.get('task_id')}: {error}" for error in response_errors
            )
            continue
        accepted.append({
            "task": task,
            "response": response,
            "sha256": sha256_file(target),
        })
    return accepted, errors


def portable_vision_task_identity(task: dict[str, Any]) -> dict[str, Any]:
    """Remove transport locations only when immutable artifact hashes replace them.

    Model-host task packets need absolute paths so the host can open the rendered
    evidence in the current run.  Those paths are transport, not evidence: a
    fresh output root must not mint a new obligation for identical source bytes.
    The omission is deliberately conditional.  A legacy or malformed task with
    no hash companion retains its path in the identity and therefore cannot gain
    portable replay merely by asserting that its bytes are unchanged.
    """
    value = copy.deepcopy(task)

    def is_sha256(candidate: Any) -> bool:
        return (
            isinstance(candidate, str)
            and len(candidate) == 64
            and all(character in "0123456789abcdef" for character in candidate)
        )

    if is_sha256(value.get("image_artifact_sha256")):
        value.pop("image_path", None)
    if is_sha256(value.get("task_artifact_sha256")):
        value.pop("task_path", None)
    crops = value.get("region_crops")
    if isinstance(crops, list):
        portable_crops = []
        for crop in crops:
            portable_crop = copy.deepcopy(crop)
            if isinstance(portable_crop, dict) and is_sha256(
                portable_crop.get("sha256")
            ):
                portable_crop.pop("path", None)
            portable_crops.append(portable_crop)
        value["region_crops"] = portable_crops
    return value


def task_identity(task: dict[str, Any], cache_key: str) -> tuple[str, str]:
    raw = {
        key: value
        for key, value in task.items()
        if key not in {
            "task_id", "user_blocking", "remedy", "attempt_budget",
            "progress_measure", "model_host_response_boundary",
            "prior_response_sha256s", "bounded_capture_round",
        }
    }
    if raw.get("task_kind") == "independent_table_transcription":
        raw = portable_vision_task_identity(raw)
    elif raw.get("task_kind") == "bounded_capture_adjudication":
        prior_task = raw.get("prior_task")
        if isinstance(prior_task, dict):
            raw["prior_task"] = portable_vision_task_identity(prior_task)
    input_sha = sha256_bytes(canonical_bytes({"cache_key": cache_key, "task": raw}))
    return f"broker-task-{input_sha[:24]}", input_sha


def fixed_point_stage(status: str, tasks: list[dict[str, Any]]) -> str:
    kinds = sorted({str(task.get("task_kind") or "unknown") for task in tasks})
    return "+".join(kinds) if kinds else status.lower()


def seal_internal_work(
    *,
    prior: dict[str, Any],
    cache_key: str,
    status: str,
    tasks: list[dict[str, Any]],
    checkpoints: list[dict[str, Any]],
    summary: dict[str, Any],
    attempts: dict[str, Any] | None = None,
) -> tuple[str, list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    """Seal one append-only, finitely executable internal-work frontier.

    Task kinds are deliberately unordered. Canonical reconciliation may
    discover a new rendered-vision task after resolution or crosswalk work;
    this appends work to the graph and is not a stage regression. Merely
    observing the same frontier never consumes an attempt.
    """
    boundary = model_host_boundary()
    prior_tasks = {
        item.get("task_id"): item
        for item in prior.get("tasks", [])
        if isinstance(item, dict) and item.get("task_id")
    }
    attempt_ledger = (attempts or {}).get("task_execution_receipts", {})
    stage = fixed_point_stage(status, tasks)
    passed_checkpoints = sum(1 for item in checkpoints if item.get("status") == "PASS")
    sealed: list[dict[str, Any]] = []
    for defect_ordinal, task in enumerate(tasks, start=1):
        packet = copy.deepcopy(task)
        task_kind = str(packet.get("task_kind") or "")
        declaration = boundary["tasks"].get(task_kind)
        if not declaration:
            raise ValueError(
                f"Internal broker task {task_kind!r} has no registered deterministic remedy."
            )
        task_id, input_sha = task_identity(packet, cache_key)
        prior_packet = prior_tasks.get(task_id, {})
        accepted_receipts = sorted(set(attempt_ledger.get(task_id, [])))
        if not accepted_receipts:
            accepted_receipts = sorted(set(
                prior_packet.get("attempt_budget", {}).get(
                    "accepted_execution_receipt_sha256", []
                )
            ))
        attempts_used = min(len(accepted_receipts), int(declaration["attempt_limit"]))
        response_files = task_response_files(packet)
        packet.update({
            "task_id": task_id,
            "user_blocking": False,
            "remedy": {
                "remedy_id": declaration["remedy_id"],
                "deterministic_steps": declaration["steps"],
                "resume_protocol": {
                    "controller": "scripts/run_broker_pipeline.py",
                    "same_cache_key_required": True,
                    "reuse_valid_checkpoints": True,
                },
            },
            "attempt_budget": {
                "attempts_used": attempts_used,
                "attempt_limit": declaration["attempt_limit"],
                "attempts_remaining": max(0, declaration["attempt_limit"] - attempts_used),
                "accepted_execution_receipt_sha256": accepted_receipts,
            },
            "progress_measure": {
                "stage": stage,
                "stage_ordinal": 0,
                "defect_ordinal": defect_ordinal,
                "defect_count": len(tasks),
                "passed_checkpoint_count": passed_checkpoints,
                "task_input_sha256": input_sha,
            },
            "model_host_response_boundary": {
                "boundary_schema_version": boundary["schema_version"],
                "boundary_sha256": boundary["boundary_sha256"],
                "producer_kind": declaration["producer_kind"],
                "response_schema_path": declaration.get("response_schema_path"),
                "response_schema_sha256": declaration.get("response_schema_sha256"),
                "expected_response_files": response_files,
                "source_and_validator_mutation_forbidden": True,
                "response_must_be_hash_bound": True,
                "python_may_not_author_response": True,
            },
        })
        if task_kind == "bounded_capture_adjudication":
            if attempts_used >= int(declaration["attempt_limit"]):
                raise ValueError("An exhausted bounded-capture task cannot be reopened.")
            packet["bounded_capture_round"] = {
                "round_index": attempts_used + 1,
                "prior_response_sha256s": copy.deepcopy(
                    packet.get("prior_response_sha256s")
                ),
            }
        sealed.append(packet)

    work_graph = build_work_graph(
        prior=prior,
        cache_key=cache_key,
        tasks=sealed,
        checkpoints=checkpoints,
        task_execution_receipts=attempt_ledger,
        closed=False,
    )
    graph_errors = verify_work_graph(work_graph)
    if graph_errors:
        raise ValueError(
            "Broker work graph failed its independent invariants: "
            + ", ".join(graph_errors)
        )
    task_set_sha = work_graph["current_frontier_sha256"]
    progress_sha = work_graph["graph_sha256"]
    progress_score = (
        len(work_graph["nodes"]) * 1_000_000
        + len(work_graph["frontier_history_sha256"]) * 10_000
        + len(work_graph["completed_node_ids"]) * 100
        - len(work_graph["open_task_ids"])
    )
    stall_limit = int(boundary["stall_attempt_limit"])
    terminal_reasons = (
        ["an upstream broker checkpoint returned BLOCKED_INTERNAL"]
        if status == "BLOCKED_INTERNAL"
        else []
    )

    fixed = {
        "schema_version": "broker-internal-fixed-point/1.0",
        "status": "TERMINAL_DEFECT" if terminal_reasons else "OPEN",
        "stage": stage,
        "stage_ordinal": 0,
        "passed_checkpoint_count": passed_checkpoints,
        "remaining_task_count": len(sealed),
        "progress_score": progress_score,
        "progress_sha256": progress_sha,
        "task_set_sha256": task_set_sha,
        "unchanged_retry_count": 0,
        "unchanged_retry_limit": stall_limit,
        "monotonic_from_prior": work_graph["monotonic_from_prior"],
        "checkpoint_reuse_required": True,
        "terminal_reasons": terminal_reasons,
        "work_graph": work_graph,
    }
    if not terminal_reasons:
        return status, sealed, fixed, summary

    defect_payload = {
        "task_kind": "internal_fixed_point_defect",
        "failed_status": status,
        "underlying_task_ids": sorted(task["task_id"] for task in sealed),
        "terminal_reasons": terminal_reasons,
        "last_progress_sha256": progress_sha,
        "last_checkpoint_states": [
            {
                "stage": item.get("stage"),
                "status": item.get("status"),
                "input_sha256": item.get("input_sha256"),
                "output_sha256": item.get("output_sha256"),
            }
            for item in checkpoints
        ],
        "instruction": (
            "Repair the earliest controller or model-host response-boundary defect. "
            "Do not ask the user to replace unchanged readable research."
        ),
    }
    task_id, input_sha = task_identity(defect_payload, cache_key)
    declaration = boundary["tasks"]["internal_fixed_point_defect"]
    aggregate = {
        **defect_payload,
        "task_id": task_id,
        "user_blocking": False,
        "remedy": {
            "remedy_id": declaration["remedy_id"],
            "deterministic_steps": declaration["steps"],
            "resume_protocol": {
                "controller": "scripts/run_broker_pipeline.py",
                "same_cache_key_required": True,
                "reuse_valid_checkpoints": True,
            },
        },
        "attempt_budget": {
            "attempts_used": 0,
            "attempt_limit": 1,
            "attempts_remaining": 1,
            "accepted_execution_receipt_sha256": [],
        },
        "progress_measure": {
            "stage": "terminal_internal_defect",
            "stage_ordinal": 0,
            "defect_ordinal": 1,
            "defect_count": 1,
            "passed_checkpoint_count": passed_checkpoints,
            "task_input_sha256": input_sha,
        },
        "model_host_response_boundary": {
            "boundary_schema_version": boundary["schema_version"],
            "boundary_sha256": boundary["boundary_sha256"],
            "producer_kind": declaration["producer_kind"],
            "response_schema_path": None,
            "response_schema_sha256": None,
            "expected_response_files": [],
            "source_and_validator_mutation_forbidden": True,
            "response_must_be_hash_bound": False,
            "python_may_not_author_response": True,
        },
    }
    terminal_summary = {
        **summary,
        "terminal_reason": "internal_fixed_point_stalled_or_regressed",
        "aggregate_internal_defect_count": 1,
        "underlying_internal_task_count": len(sealed),
    }
    return "BLOCKED_INTERNAL", [aggregate], fixed, terminal_summary


def source_hashes(request: dict[str, Any], request_dir: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for document in request.get("documents", []):
        source = Path(str(document.get("path") or ""))
        if not source.is_absolute():
            source = (request_dir / source).resolve()
        if not source.is_file():
            raise FileNotFoundError(f"Broker source is absent: {source}")
        digest = sha256_file(source)
        expected = document.get("expected_sha256")
        if expected and expected != digest:
            raise ValueError(f"Broker source hash does not match for {document.get('document_id')}.")
        hashes[str(document.get("document_id"))] = digest
    if not hashes:
        raise ValueError("The broker request contains no documents.")
    return dict(sorted(hashes.items()))


def record_task_execution_attempt(
    attempts: dict[str, Any],
    prior_state: dict[str, Any],
    response_digest: str,
    task_kinds: set[str],
) -> bool:
    """Record one accepted execution receipt against its prior task frontier.

    Replaying identical bytes or merely polling the controller is not an
    execution attempt.  The ledger is keyed by stable task id so unrelated
    lane progress cannot consume a broker task's finite remedy budget.
    """
    accepted = attempts.setdefault("execution_response_sha256", [])
    is_new = response_digest not in accepted
    if is_new:
        accepted.append(response_digest)
        ledger = attempts.setdefault("task_execution_receipts", {})
        for task in prior_state.get("tasks", []):
            if task.get("task_kind") not in task_kinds or not task.get("task_id"):
                continue
            receipts = ledger.setdefault(str(task["task_id"]), [])
            if response_digest not in receipts:
                receipts.append(response_digest)
    return is_new


def record_vision_attempt(
    attempts: dict[str, Any],
    response_digest: str,
    prior_state: dict[str, Any] | None = None,
) -> bool:
    record_task_execution_attempt(
        attempts,
        prior_state or {},
        response_digest,
        {
            "independent_table_transcription",
            "targeted_cell_adjudication",
            "period_header_adjudication",
        },
    )
    accepted = attempts.setdefault("vision_response_sha256", [])
    if response_digest not in accepted:
        accepted.append(response_digest)
    attempts["vision_attempt_count"] = len(accepted)
    return attempts["vision_attempt_count"] >= int(attempts["vision_attempt_limit"])


def task_family_execution_count(
    attempts: dict[str, Any],
    state: dict[str, Any],
    task_kinds: set[str],
) -> int:
    """Count distinct accepted responses for one append-only task family."""
    kind_by_id = {
        str(node.get("node_id")): str(node.get("task_kind") or "")
        for node in (state.get("work_graph") or {}).get("nodes", [])
        if isinstance(node, dict) and node.get("node_kind") == "task"
    }
    accepted: set[str] = set()
    for task_id, receipts in attempts.get("task_execution_receipts", {}).items():
        if kind_by_id.get(str(task_id)) in task_kinds:
            accepted.update(str(receipt) for receipt in receipts)
    return len(accepted)


def run(command: list[str], allowed: set[int]) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        command,
        cwd=HERE,
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    if completed.returncode not in allowed:
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"Command failed ({completed.returncode}): {' '.join(command)}\n{detail[-4000:]}")
    return completed


def checkpoint(
    checkpoints: list[dict[str, Any]],
    *,
    stage: str,
    status: str,
    input_digest: str,
    output: Path | None,
    reused: bool,
) -> None:
    checkpoints.append({
        "stage": stage,
        "status": status,
        "input_sha256": input_digest,
        "output_sha256": sha256_file(output) if output and output.is_file() else None,
        "reused": reused,
    })


def reusable(output: Path, sidecar: Path, input_digest: str) -> bool:
    if not output.is_file() or not sidecar.is_file():
        return False
    try:
        receipt = read_json(sidecar, "checkpoint receipt")
    except ValueError:
        return False
    return (
        receipt.get("input_sha256") == input_digest
        and receipt.get("output_sha256") == sha256_file(output)
    )


def seal_checkpoint(output: Path, sidecar: Path, input_digest: str) -> None:
    atomic_json(sidecar, {
        "schema_version": "broker-pipeline-checkpoint/1.0",
        "input_sha256": input_digest,
        "output_sha256": sha256_file(output),
    })


def seal_degraded_delivery_close(
    *,
    output_root: Path,
    run_id: str,
    cache_key: str,
    active_bundle_path: Path,
    artifacts: dict[str, Any],
    checkpoints: list[dict[str, Any]],
    summary: dict[str, Any],
) -> Path:
    """Write the one atomic receipt that makes PASS_DEGRADED consumable.

    Counts and checkpoint names are diagnostic metadata, not a receipt.  The
    parent workflow may advance only when one file binds the exact quarantined
    bundle, compiled pack, source tables, semantic report and crosswalk receipt
    and independently proves that no unresolved selected candidate survives.
    """
    required = {
        "broker_pack": artifacts.get("broker_pack"),
        "source_tables": artifacts.get("source_tables"),
        "broker_crosswalk_receipt": artifacts.get("broker_crosswalk_receipt"),
        "broker_semantic_verification": artifacts.get("broker_semantic_verification"),
    }
    missing = [name for name, raw in required.items() if not raw or not Path(str(raw)).is_file()]
    if missing:
        raise ValueError(
            "A degraded broker lane cannot close without compiled artifact(s): "
            + ", ".join(sorted(missing))
        )
    crosswalk_receipt = read_json(
        Path(str(required["broker_crosswalk_receipt"])),
        "broker crosswalk receipt for degraded close",
    )
    coverage = crosswalk_receipt.get("coverage_summary") or {}
    unresolved_selected = int(coverage.get("unresolved_selected_candidate_count") or 0)
    terminal_quarantined = int(coverage.get("terminal_quarantined_candidate_count") or 0)
    quarantined_conflicts = int(summary.get("quarantined_conflict_count") or 0)
    quarantined_surfaces = int(summary.get("quarantined_surface_count") or 0)
    if unresolved_selected != 0:
        raise ValueError(
            "A degraded broker lane still contains unresolved selected model candidates."
        )
    if quarantined_conflicts + quarantined_surfaces + terminal_quarantined < 1:
        raise ValueError(
            "PASS_DEGRADED requires at least one explicit quarantined cell, surface or candidate."
        )
    payload = {
        "schema_version": "broker-degraded-close-receipt/1.0",
        "status": "PASS",
        "run_id": run_id,
        "cache_key": cache_key,
        "bundle_sha256": sha256_file(active_bundle_path),
        "broker_pack_sha256": sha256_file(Path(str(required["broker_pack"]))),
        "source_tables_sha256": sha256_file(Path(str(required["source_tables"]))),
        "crosswalk_receipt_sha256": sha256_file(
            Path(str(required["broker_crosswalk_receipt"]))
        ),
        "semantic_report_sha256": sha256_file(
            Path(str(required["broker_semantic_verification"]))
        ),
        "checkpoint_set_sha256": sha256_bytes(canonical_bytes(checkpoints)),
        "quarantined_conflict_count": quarantined_conflicts,
        "quarantined_surface_count": quarantined_surfaces,
        "terminal_quarantined_candidate_count": terminal_quarantined,
        "unresolved_selected_candidate_count": unresolved_selected,
        "model_consumption_added": 0,
        "continuation_status": summary["continuation_status"],
    }
    receipt_path = output_root / "broker-degraded-close-receipt.json"
    atomic_json(receipt_path, payload)
    checkpoint(
        checkpoints,
        stage="degraded_delivery_close",
        status="PASS",
        input_digest=sha256_bytes(canonical_bytes(payload)),
        output=receipt_path,
        reused=False,
    )
    artifacts["degraded_close_receipt"] = str(receipt_path)
    return receipt_path


def artifact_path(bundle: dict[str, Any], document: dict[str, Any], artifact_id: str) -> Path | None:
    artifact = next((item for item in document.get("artifacts", []) if item.get("artifact_id") == artifact_id), None)
    if not artifact:
        return None
    root = Path(str(bundle.get("artifact_root") or ""))
    target = (root / str(artifact.get("path") or "")).resolve()
    return target if target.is_file() else None


def canonical_recovery_artifacts_valid(bundle_path: Path) -> bool:
    """Prove cached canonical tasks/images still match their sealed ledger."""
    try:
        bundle = read_json(bundle_path, "cached canonical broker bundle")
    except ValueError:
        return False
    for document in bundle.get("documents", []):
        artifacts = {str(item.get("artifact_id")): item for item in document.get("artifacts", [])}
        root = Path(str(bundle.get("artifact_root") or bundle_path.parent)).resolve()
        for surface in document.get("surfaces", []):
            if surface.get("lane_status", {}).get("vision") != "required":
                continue
            for kind in ("page_image", "surface_census", "vision_task"):
                artifact = next(
                    (
                        artifacts.get(str(ref))
                        for ref in surface.get("artifact_refs", [])
                        if (artifacts.get(str(ref)) or {}).get("kind") == kind
                    ),
                    None,
                )
                if artifact is None:
                    return False
                target = root / str(artifact.get("path") or "")
                if not target.is_file() or sha256_file(target) != artifact.get("sha256"):
                    return False
    return True


def vision_tasks(bundle: dict[str, Any], responses: Path | None) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for document in bundle.get("documents", []):
        artifacts = {
            str(item.get("artifact_id")): item
            for item in document.get("artifacts", [])
            if isinstance(item, dict) and item.get("artifact_id")
        }
        for surface in document.get("surfaces", []):
            if surface.get("lane_status", {}).get("vision") != "required":
                continue
            surface_id = str(surface.get("surface_id"))
            pass_paths = [
                Path(str(responses / f"{surface_id}.pass{index}.json"))
                for index in (1, 2)
            ] if responses else [None, None]
            missing_passes = [
                index
                for index, target in enumerate(pass_paths, start=1)
                if target is None or not target.is_file()
            ]
            image_id = next(
                (
                    item
                    for item in surface.get("artifact_refs", [])
                    if next((artifact for artifact in document.get("artifacts", []) if artifact.get("artifact_id") == item and artifact.get("kind") == "page_image"), None)
                ),
                None,
            )
            task_id = next(
                (
                    item
                    for item in surface.get("artifact_refs", [])
                    if next((artifact for artifact in document.get("artifacts", []) if artifact.get("artifact_id") == item and artifact.get("kind") == "vision_task"), None)
                ),
                None,
            )
            task_path = artifact_path(bundle, document, task_id) if task_id else None
            task_payload = read_json(task_path, "broker vision task") if task_path else {}
            image_artifact = artifacts.get(str(image_id or "")) or {}
            task_artifact = artifacts.get(str(task_id or "")) or {}
            source_surface_digest = sha256_bytes(canonical_bytes({
                "schema_version": "broker-source-surface/1.0",
                "document_id": document.get("document_id"),
                "raw_sha256": document.get("raw_sha256"),
                "surface_id": surface_id,
            }))
            crop_paths = []
            for crop in task_payload.get("region_crops", []):
                crop_id = str(crop.get("image_artifact_id") or "")
                crop_artifact = artifacts.get(crop_id) or {}
                crop_target = artifact_path(bundle, document, crop_id)
                if crop_target:
                    crop_paths.append({
                        "region_id": crop.get("region_id"),
                        "image_artifact_id": crop_id,
                        "sha256": crop_artifact.get("sha256"),
                        "bbox": crop.get("bbox"),
                        "dpi": crop.get("dpi"),
                        "path": str(crop_target),
                    })
            tasks.append({
                "task_kind": "independent_table_transcription",
                "document_id": document.get("document_id"),
                "house_id": document.get("house_id"),
                "surface_id": surface_id,
                "missing_passes": missing_passes,
                "image_path": str(artifact_path(bundle, document, image_id)) if image_id else None,
                "image_sha256": source_surface_digest,
                "image_artifact_id": image_id,
                "image_artifact_sha256": image_artifact.get("sha256"),
                "region_crops": crop_paths,
                "task_path": str(task_path) if task_path else None,
                "task_artifact_id": task_id,
                "task_artifact_sha256": task_artifact.get("sha256"),
                "selected_cell_contract": task_payload.get("selected_cell_contract"),
                "instruction": task_payload.get("instruction") or (
                    "Complete two independent grid-preserving table reads. Use native text, coordinates, "
                    "vector geometry, high-resolution crops and cell OCR as corroborating lanes. Do not "
                    "return a flat numeric list and do not request replacement research."
                ),
            })
    return tasks


def pending_vision_tasks(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return only surfaces that still require an independent rendered read."""
    return [task for task in tasks if task.get("missing_passes")]


def resolution_tasks(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for manifest in bundle.get("vision_conflict_manifests", []):
        targeted = [
            conflict
            for conflict in manifest.get("conflicts", [])
            if conflict.get("requires_targeted_adjudication", True)
        ]
        if not targeted:
            continue
        document = next(
            (item for item in bundle.get("documents", []) if item.get("document_id") == manifest.get("document_id")),
            None,
        )
        surface = next(
            (item for item in (document or {}).get("surfaces", []) if item.get("surface_id") == manifest.get("surface_id")),
            None,
        )
        task_id = next(
            (
                ref for ref in (surface or {}).get("artifact_refs", [])
                if next(
                    (artifact for artifact in (document or {}).get("artifacts", []) if artifact.get("artifact_id") == ref and artifact.get("kind") == "vision_task"),
                    None,
                )
            ),
            None,
        )
        task_path = artifact_path(bundle, document, task_id) if document and task_id else None
        vision_task = read_json(task_path, "broker vision task") if task_path else {}
        tasks.append({
            "task_kind": "targeted_cell_adjudication",
            "document_id": manifest.get("document_id"),
            "surface_id": manifest.get("surface_id"),
            "conflict_manifest_sha256": manifest.get("manifest_sha256"),
            "conflicts": targeted,
            "region_crops": vision_task.get("region_crops", []),
            "instruction": (
                "Read only each disputed cell with its row label, period header, unit and adjacent cells. "
                "Resolve it to pass1, pass2, native or a targeted value; otherwise quarantine that cell. "
                "Do not replace the surface tables and do not ask for a replacement report."
            ),
        })
    return tasks


def physical_reconciliation_tasks(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    """Describe bounded internal capture work without blaming readable input."""
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for finding in bundle.get("canonical_findings", []):
        if finding.get("severity") not in {"needs_vision", "needs_resolution"}:
            continue
        key = (str(finding.get("document_id") or ""), str(finding.get("surface_id") or ""))
        grouped.setdefault(key, []).append(finding)
    tasks = []
    for (document_id, surface_id), findings in sorted(grouped.items()):
        severity = (
            "needs_resolution"
            if any(item.get("severity") == "needs_resolution" for item in findings)
            else "needs_vision"
        )
        tasks.append({
            "task_kind": (
                "targeted_cell_adjudication"
                if severity == "needs_resolution"
                else "independent_table_transcription"
            ),
            "document_id": document_id,
            "surface_id": surface_id,
            "findings": findings,
            "remedy_sequence": [
                "native_text_and_coordinates",
                "vector_table_geometry",
                "cell_ocr",
                "two_pass_rendered_grid",
                "targeted_conflict_adjudication",
            ],
            "instruction": (
                "Reconcile this readable surface internally. Preserve each visible table as a hardcoded grid, "
                "or certify it as verified_non_tabular after two independent reads. Do not ask for replacement "
                "research merely because extraction lanes disagree."
            ),
        })
    return tasks


def rebase_crosswalk_table_reviews(
    bundle: dict[str, Any],
    crosswalk: dict[str, Any],
    model_context: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Rebase derived table inventory without changing selected-cell decisions.

    Native extraction may legitimately repartition unselected archive tables
    across runtime/process versions. A reviewed crosswalk's mappings are the
    preserved user/model-host decision; its all-table review inventory is a
    derived descendant and must be rebuilt against the active canonical
    bundle. Reviews for mapped tables are retained when the table identity is
    still present. No mapping, metric or coverage decision is authored here.
    """
    shell = compile_reference_only_crosswalk(bundle, model_context)
    active_reviews = {
        str(item.get("table_id") or ""): item
        for item in shell.get("table_reviews") or []
    }
    reviewed = {
        str(item.get("table_id") or ""): item
        for item in crosswalk.get("table_reviews") or []
    }
    mapped_table_ids = {
        str(source.get("table_id") or "")
        for mapping in crosswalk.get("mappings") or []
        for source in mapping.get("sources") or []
    }
    rebased_reviews = []
    for table_id, generated in sorted(active_reviews.items()):
        rebased_reviews.append(
            copy.deepcopy(reviewed[table_id])
            if table_id in mapped_table_ids and table_id in reviewed
            else copy.deepcopy(generated)
        )
    rebased = copy.deepcopy(crosswalk)
    rebased["table_reviews"] = rebased_reviews
    receipt = {
        "schema_version": "broker-crosswalk-table-rebase-receipt/1.0",
        "status": "PASS",
        "preserved_mapping_count": len(rebased.get("mappings") or []),
        "preserved_mapped_table_review_count": sum(
            1 for table_id in mapped_table_ids if table_id in active_reviews and table_id in reviewed
        ),
        "dropped_stale_table_review_count": len(set(reviewed) - set(active_reviews)),
        "active_table_review_count": len(rebased_reviews),
        "missing_mapped_table_ids": sorted(mapped_table_ids - set(active_reviews)),
    }
    return rebased, receipt


def period_header_tasks(bundle: dict[str, Any], bundle_path: Path) -> list[dict[str, Any]]:
    """Create one aggregate rendered-header task for every unresolved table.

    The model host reads already-sealed page images/crops and supplies only the
    complete visible period labels. It cannot edit table values, source cells,
    schemas or mappings at this boundary.
    """
    targets = []
    documents = {str(item.get("document_id")): item for item in bundle.get("documents", [])}
    for item in period_target_inventory(bundle):
        document = documents.get(str(item.get("document_id"))) or {}
        artifact_by_id = {str(artifact.get("artifact_id")): artifact for artifact in document.get("artifacts", [])}
        rendered_artifacts = []
        for artifact_id in item.get("image_artifact_ids", []):
            artifact = artifact_by_id.get(str(artifact_id))
            target = artifact_path(bundle, document, str(artifact_id)) if artifact else None
            if target:
                rendered_artifacts.append({
                    "artifact_id": artifact_id,
                    "kind": artifact.get("kind"),
                    "path": str(target),
                    "sha256": artifact.get("sha256"),
                })
        targets.append({**item, "rendered_artifacts": rendered_artifacts})
    if not targets:
        return []
    return [{
        "task_kind": "period_header_adjudication",
        "bundle_sha256": sha256_file(bundle_path),
        "canonical_tables_sha256": bundle.get("canonical_tables_sha256"),
        "candidate_manifest_sha256": period_canonical_hash(bundle.get("candidate_manifest")),
        "targets": targets,
        "instruction": (
            "Read the complete annual labels from the already-rendered grids and write only those "
            "visible labels into broker-period-header-review.json. Never infer a missing digit from "
            "sequence alone. If a label remains unreadable, omit that column: the controller will "
            "quarantine only that column and continue the model through the forecast waterfall."
        ),
    }]


def write_state(
    state_path: Path,
    *,
    run_id: str,
    status: str,
    request_digest: str,
    sources: dict[str, str],
    runtime_digest: str,
    cache_key: str,
    checkpoints: list[dict[str, Any]],
    artifacts: dict[str, Any],
    tasks: list[dict[str, Any]],
    summary: dict[str, Any],
    user_blocking: bool = False,
    blocker_class: str | None = None,
    attempts: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if status in {
        "NEEDS_VISION", "NEEDS_RESOLUTION", "NEEDS_CROSSWALK",
        "NEEDS_CROSSWALK_REVIEW", "BLOCKED_INTERNAL",
    } and (user_blocking is not False or blocker_class != "INTERNAL_WORK"):
        raise ValueError(
            f"Internal broker state {status} must remain controller-owned and non-user-blocking."
        )
    prior: dict[str, Any] = {}
    if state_path.is_file():
        try:
            prior = read_json(state_path, "prior broker run state")
        except ValueError:
            prior = {}
    fixed_point: dict[str, Any]
    if status in {
        "NEEDS_VISION", "NEEDS_RESOLUTION", "NEEDS_CROSSWALK",
        "NEEDS_CROSSWALK_REVIEW", "BLOCKED_INTERNAL",
    }:
        status, tasks, fixed_point, summary = seal_internal_work(
            prior=prior,
            cache_key=cache_key,
            status=status,
            tasks=tasks,
            checkpoints=checkpoints,
            summary=summary,
            attempts=attempts,
        )
        blocker_class = "INTERNAL_WORK"
        user_blocking = False
    elif status in {"PASS", "PASS_DEGRADED"}:
        closed_work_graph = build_work_graph(
            prior=prior,
            cache_key=cache_key,
            tasks=[],
            checkpoints=checkpoints,
            task_execution_receipts=(attempts or {}).get(
                "task_execution_receipts", {}
            ),
            closed=True,
        )
        graph_errors = verify_work_graph(closed_work_graph)
        if graph_errors:
            raise ValueError(
                "Closed broker work graph failed its independent invariants: "
                + ", ".join(graph_errors)
            )
        fixed_point = {
            "schema_version": "broker-internal-fixed-point/1.0",
            "status": "CLOSED",
            "stage": "pass",
            "stage_ordinal": 0,
            "passed_checkpoint_count": sum(
                1 for item in checkpoints if item.get("status") == "PASS"
            ),
            "remaining_task_count": 0,
            "progress_score": len(closed_work_graph["nodes"]) * 1_000_000,
            "progress_sha256": closed_work_graph["graph_sha256"],
            "task_set_sha256": closed_work_graph["current_frontier_sha256"],
            "unchanged_retry_count": 0,
            "unchanged_retry_limit": model_host_boundary()["stall_attempt_limit"],
            "monotonic_from_prior": True,
            "checkpoint_reuse_required": True,
            "terminal_reasons": [],
            "work_graph": closed_work_graph,
        }
    else:
        not_applicable_work_graph = build_work_graph(
            prior=prior,
            cache_key=cache_key,
            tasks=[],
            checkpoints=checkpoints,
            task_execution_receipts=(attempts or {}).get(
                "task_execution_receipts", {}
            ),
            closed=True,
        )
        fixed_point = {
            "schema_version": "broker-internal-fixed-point/1.0",
            "status": "NOT_APPLICABLE",
            "stage": "user_owned_source_boundary",
            "stage_ordinal": 0,
            "passed_checkpoint_count": sum(
                1 for item in checkpoints if item.get("status") == "PASS"
            ),
            "remaining_task_count": 0,
            "progress_score": 0,
            "progress_sha256": sha256_bytes(canonical_bytes({
                "cache_key": cache_key, "status": status,
            })),
            "task_set_sha256": sha256_bytes(canonical_bytes([])),
            "unchanged_retry_count": 0,
            "unchanged_retry_limit": model_host_boundary()["stall_attempt_limit"],
            "monotonic_from_prior": True,
            "checkpoint_reuse_required": True,
            "terminal_reasons": [],
            "work_graph": not_applicable_work_graph,
        }
    assert_state("broker", status, blocker_class, user_blocking)
    assert_transition(
        "broker",
        prior.get("pipeline_status"),
        status,
        reset=prior.get("cache_key") != cache_key,
    )
    state = {
        "schema_version": "broker-run-state/1.0",
        "run_id": run_id,
        "pipeline_status": status,
        "user_blocking": user_blocking,
        "blocker_class": blocker_class,
        "request_sha256": request_digest,
        "source_sha256": sources,
        "runtime_closure_sha256": runtime_digest,
        "cache_key": cache_key,
        "checkpoints": checkpoints,
        "artifacts": artifacts,
        "artifact_sha256": {
            name: sha256_file(Path(value))
            for name, value in sorted(artifacts.items())
            if isinstance(value, str) and Path(value).is_file()
        },
        "tasks": tasks,
        "fixed_point": fixed_point,
        "work_graph": fixed_point["work_graph"],
        "attempts": attempts or {
            "execution_response_sha256": [],
            "vision_response_sha256": [],
            "vision_attempt_count": 0,
            "vision_attempt_limit": VISION_ATTEMPT_LIMIT,
            "task_execution_receipts": {},
        },
        "summary": summary,
    }
    atomic_json(state_path, state)
    print(json.dumps({
        "status": status,
        "user_blocking": user_blocking,
        "blocker_class": blocker_class,
        "task_count": len(tasks),
        **summary,
        "state": str(state_path),
    }, sort_keys=True))
    return state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request")
    parser.add_argument("--out", required=True)
    parser.add_argument("--responses")
    parser.add_argument("--crosswalk")
    parser.add_argument("--native-preflight", help="Demand-independent native extraction bundle to reuse when source hashes match")
    parser.add_argument(
        "--close-optional",
        action="store_true",
        help="Preserve unresolved broker surfaces as evidence-only and continue with zero broker authority.",
    )
    args = parser.parse_args()

    request_path = Path(args.request).resolve()
    output_root = Path(args.out).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    state_path = output_root / "broker-run-state.json"
    checkpoints: list[dict[str, Any]] = []
    artifacts: dict[str, Any] = {}
    prior_state: dict[str, Any] = {}
    if state_path.is_file():
        try:
            prior_state = read_json(state_path, "prior broker run state")
        except ValueError:
            prior_state = {}
    request = read_json(request_path, "broker extraction request")
    if request.get("schema_version") != "broker-extraction-request/1.0":
        raise ValueError("The broker extraction request has the wrong schema version.")
    model_context = request.get("model_context")
    if isinstance(model_context, dict):
        demand_graph = model_context.get("model_demand_graph")
        if not isinstance(demand_graph, dict):
            raise ValueError("Broker model_context lacks the pre-broker model-demand graph.")
        normalized_demand = normalize_pre_broker_demand(demand_graph)
        if normalized_demand["forecast_periods"] != model_context.get("forecast_periods"):
            raise ValueError("Broker model_context period basis differs from its demand graph.")
    run_id = str(request.get("run_id") or "")
    request_digest = sha256_file(request_path)
    runtime_digest, _runtime_members = runtime_closure()
    try:
        sources = source_hashes(request, request_path.parent)
    except (FileNotFoundError, ValueError) as error:
        cache_key = sha256_bytes(canonical_bytes({
            "request": request_digest,
            "source_error": str(error),
            "runtime": runtime_digest,
        }))
        write_state(
            state_path, run_id=run_id, status="BLOCKED_INPUT",
            request_digest=request_digest, sources={}, runtime_digest=runtime_digest,
            cache_key=cache_key, checkpoints=checkpoints, artifacts=artifacts,
            tasks=[], summary={"terminal_reason": "fatal_source", "message": str(error)},
            user_blocking=True, blocker_class="FATAL_SOURCE",
        )
        return 2
    cache_key = sha256_bytes(canonical_bytes({
        "request": request_digest,
        "sources": sources,
        "runtime": runtime_digest,
    }))
    prior_attempts = (
        prior_state.get("attempts", {}).get("vision_response_sha256", [])
        if prior_state.get("cache_key") == cache_key
        else []
    )
    prior_execution_responses = (
        prior_state.get("attempts", {}).get("execution_response_sha256", [])
        if prior_state.get("cache_key") == cache_key
        else []
    )
    prior_attempt_count = (
        prior_state.get("attempts", {}).get(
            "vision_attempt_count",
            len(prior_attempts),
        )
        if prior_state.get("cache_key") == cache_key
        else 0
    )
    prior_task_execution_receipts = (
        prior_state.get("attempts", {}).get("task_execution_receipts", {})
        if prior_state.get("cache_key") == cache_key
        else {}
    )
    attempts = {
        "execution_response_sha256": list(dict.fromkeys(prior_execution_responses)),
        "vision_response_sha256": list(dict.fromkeys(prior_attempts)),
        "vision_attempt_count": prior_attempt_count,
        "vision_attempt_limit": VISION_ATTEMPT_LIMIT,
        "task_execution_receipts": {
            str(task_id): list(dict.fromkeys(receipts))
            for task_id, receipts in prior_task_execution_receipts.items()
            if isinstance(receipts, list)
        },
    }
    key = cache_key[:16]

    extraction_root = output_root / f"extract-{key}"
    bundle_path = extraction_root / "broker-extraction-bundle.json"
    extract_receipt = output_root / f"extract-{key}.receipt.json"
    extract_input = sha256_bytes(canonical_bytes({"request": request_digest, "sources": sources, "runtime": runtime_digest}))
    extract_reused = reusable(bundle_path, extract_receipt, extract_input)
    if not extract_reused and args.native_preflight:
        try:
            preflight = Path(args.native_preflight).resolve()
            run([sys.executable, str(HERE / "rebind_broker_native_preflight.py"), str(preflight), str(request_path), "--out", str(bundle_path)], {0})
            seal_checkpoint(bundle_path, extract_receipt, extract_input)
            extract_reused = True
        except Exception:
            # Optimization is never allowed to reduce liveness or evidence quality.
            extract_reused = False
            if bundle_path.exists():
                bundle_path.unlink()
    if not extract_reused:
        run([sys.executable, str(HERE / "extract_broker_evidence.py"), str(request_path), "--out", str(extraction_root)], {0, 2})
        if not bundle_path.is_file():
            raise RuntimeError("Broker extraction did not write its evidence bundle.")
        seal_checkpoint(bundle_path, extract_receipt, extract_input)
    bundle = read_json(bundle_path, "broker extraction bundle")
    checkpoint(checkpoints, stage="extract", status="PASS" if bundle.get("gate_status") != "BLOCKED" else "BLOCKED", input_digest=extract_input, output=bundle_path, reused=extract_reused)
    artifacts["extraction_bundle"] = str(bundle_path)
    if bundle.get("gate_status") == "BLOCKED":
        write_state(
            state_path,
            run_id=run_id,
            status="BLOCKED_INTERNAL",
            request_digest=request_digest,
            sources=sources,
            runtime_digest=runtime_digest,
            cache_key=cache_key,
            checkpoints=checkpoints,
            artifacts=artifacts,
            tasks=[],
            summary={
                "terminal_reason": "broker_extractor_requires_internal_repair",
                "finding_count": len(bundle.get("findings", [])),
                "findings": bundle.get("findings", []),
            },
            user_blocking=False,
            blocker_class="INTERNAL_WORK",
            attempts=attempts,
        )
        return 2

    census_path = output_root / f"surface-census-{key}.json"
    census_receipt = output_root / f"surface-census-{key}.receipt.json"
    census_input = sha256_bytes(canonical_bytes({"bundle": sha256_file(bundle_path), "runtime": runtime_digest}))
    census_reused = reusable(census_path, census_receipt, census_input)
    if not census_reused:
        run([sys.executable, str(HERE / "compile_broker_surface_census.py"), str(bundle_path), "--out", str(census_path)], {0, 2})
        seal_checkpoint(census_path, census_receipt, census_input)
    census = read_json(census_path, "broker surface census")
    checkpoint(checkpoints, stage="surface_census", status="PASS" if census.get("gate_status") != "BLOCKED" else "BLOCKED", input_digest=census_input, output=census_path, reused=census_reused)
    artifacts["surface_census"] = str(census_path)
    if census.get("gate_status") == "BLOCKED":
        write_state(
            state_path, run_id=run_id, status="BLOCKED_INTERNAL", request_digest=request_digest,
            sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
            checkpoints=checkpoints, artifacts=artifacts, tasks=[],
            summary=census.get("summary", {}),
            blocker_class="INTERNAL_WORK", attempts=attempts,
        )
        return 2

    responses = Path(args.responses).resolve() if args.responses else None
    if args.close_optional:
        # The operator has explicitly selected the fail-closed route.  Keep any
        # valid pass files available for physical reconciliation, but exhaust
        # the optional retry budget even when that response directory exists.
        # Stale task-bound decisions remain rejected by the normal validator.
        if responses is None or not responses.is_dir():
            responses = output_root / "optional-close-empty-responses"
            responses.mkdir(parents=True, exist_ok=True)
        attempts["vision_attempt_count"] = attempts["vision_attempt_limit"]
    bounded_decisions, bounded_response_errors = bounded_capture_responses(
        prior_state, responses
    )
    for accepted_decision in bounded_decisions:
        record_task_execution_attempt(
            attempts,
            prior_state,
            accepted_decision["sha256"],
            {"bounded_capture_adjudication"},
        )
    bounded_capture_executed = bool(bounded_decisions)
    bounded_quarantine_requested = any(
        item["response"].get("decision") == "quarantine_remaining_regions"
        for item in bounded_decisions
    )
    active_bundle_path = bundle_path
    active_bundle = bundle
    if bundle.get("gate_status") == "NEEDS_VISION":
        tasks = vision_tasks(bundle, responses)
        if (
            (not responses or any(task.get("missing_passes") for task in tasks))
            and not args.close_optional
        ):
            checkpoint(checkpoints, stage="vision", status="NEEDS_WORK", input_digest=sha256_file(bundle_path), output=None, reused=False)
            write_state(
                state_path, run_id=run_id, status="NEEDS_VISION", request_digest=request_digest,
                sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
                checkpoints=checkpoints, artifacts=artifacts, tasks=pending_vision_tasks(tasks),
                summary={"unresolved_surface_count": len(pending_vision_tasks(tasks))},
                blocker_class="INTERNAL_WORK", attempts=attempts,
            )
            return 2
        responses_digest = sha256_bytes(canonical_bytes({
            target.name: sha256_file(target)
            for target in sorted(responses.glob("*.json"))
            if target.is_file()
        }))
        response_seen_before = responses_digest in attempts["vision_response_sha256"]
        attempt_exhausted = record_vision_attempt(
            attempts, responses_digest, prior_state
        )
        verified_path = output_root / f"verified-{key}-{responses_digest[:12]}.json"
        vision_receipt = output_root / f"verified-{key}-{responses_digest[:12]}.receipt.json"
        vision_input = sha256_bytes(canonical_bytes({
            "bundle": sha256_file(bundle_path),
            "responses": responses_digest,
            "runtime": runtime_digest,
            "quarantine_unresolved": prior_targeted_resolution_attempted(prior_state),
        }))
        vision_reused = reusable(verified_path, vision_receipt, vision_input)
        if not vision_reused:
            vision_command = [
                sys.executable,
                str(HERE / "compile_broker_vision.py"),
                str(bundle_path),
                "--responses",
                str(responses),
            ]
            if prior_targeted_resolution_attempted(prior_state):
                vision_command.append("--quarantine-unresolved")
            vision_command.extend(["--out", str(verified_path)])
            run(vision_command, {0, 2})
            seal_checkpoint(verified_path, vision_receipt, vision_input)
        active_bundle_path = verified_path
        active_bundle = read_json(verified_path, "verified broker bundle")
        artifacts["verified_bundle"] = str(verified_path)
        checkpoint(checkpoints, stage="vision", status="PASS" if active_bundle.get("gate_status") == "PASS" else "NEEDS_WORK", input_digest=vision_input, output=verified_path, reused=vision_reused)
        capture_adjudication_required = False
        if active_bundle.get("gate_status") == "NEEDS_RESOLUTION":
            tasks = resolution_tasks(active_bundle)
            if tasks:
                write_state(
                    state_path, run_id=run_id, status="NEEDS_RESOLUTION", request_digest=request_digest,
                    sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
                    checkpoints=checkpoints, artifacts=artifacts, tasks=tasks,
                    summary={"targeted_conflict_count": sum(len(task.get("conflicts", [])) for task in tasks)},
                    blocker_class="INTERNAL_WORK", attempts=attempts,
                )
                return 2
            # Canonical physical-overlap findings are task-bound surface work,
            # not cell-conflict manifests. They enter the dedicated bounded
            # decision contract and must never be forced into a fabricated
            # bvc-* conflict identity.
            capture_adjudication_required = True
        if active_bundle.get("gate_status") != "PASS":
            tasks = vision_tasks(active_bundle, responses)
            for task in tasks:
                task["missing_passes"] = [1, 2]
                task["instruction"] = (
                    "Replace both pass files for this surface with a new independent read. "
                    "Preserve the visible grid or explicitly classify the surface as verified_non_tabular."
                )
            # Replaying the same already-evaluated full-surface read is not a
            # new attempt. It is evidence that this remedy tier is exhausted,
            # so move to targeted adjudication rather than polling forever.
            exhausted = (
                attempt_exhausted
                or response_seen_before
                or bounded_capture_executed
                or capture_adjudication_required
            )
            fully_exhausted = exhausted and (
                args.close_optional
                or bounded_quarantine_requested
                or bounded_recovery_exhausted(prior_state, attempts)
            )
            if not fully_exhausted:
                if exhausted:
                    tasks = bounded_capture_tasks(tasks, responses)
                write_state(
                    state_path, run_id=run_id,
                    status="NEEDS_RESOLUTION" if exhausted else "NEEDS_VISION",
                    request_digest=request_digest,
                    sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
                    checkpoints=checkpoints, artifacts=artifacts, tasks=tasks,
                    summary={
                        "unresolved_surface_count": len(tasks),
                        "vision_attempt_count": attempts["vision_attempt_count"],
                        "terminal_reason": (
                            "bounded_vision_retry_escalated_to_targeted_adjudication"
                            if exhausted else None
                        ),
                        "findings": active_bundle.get("findings", []),
                        "bounded_capture_response_errors": bounded_response_errors,
                    },
                    blocker_class="INTERNAL_WORK", attempts=attempts,
                )
                return 2
            # Both the full-surface read budget and the retry frontier are
            # spent: close the lane DEGRADED here — quarantine the smallest
            # defensible regions, preserve every report verbatim — instead of
            # queueing unwinnable internal work.
            degraded_path = output_root / f"verified-{key}-degraded.json"
            degraded_receipt = output_root / f"verified-{key}-degraded.receipt.json"
            degraded_input = sha256_bytes(canonical_bytes({
                "bundle": sha256_file(bundle_path),
                "responses": responses_digest,
                "runtime": runtime_digest,
                "degrade_exhausted": True,
            }))
            degraded_reused = reusable(degraded_path, degraded_receipt, degraded_input)
            if not degraded_reused:
                run([
                    sys.executable,
                    str(HERE / "compile_broker_vision.py"),
                    str(bundle_path),
                    "--responses",
                    str(responses),
                    "--degrade-exhausted",
                    "--out",
                    str(degraded_path),
                ], {0, 2})
                if not degraded_path.is_file():
                    # The degraded close itself failed to emit — genuine
                    # controller corruption, reported as a named terminal
                    # state instead of an unhandled crash with no state.
                    write_state(
                        state_path, run_id=run_id, status="BLOCKED_INTERNAL",
                        request_digest=request_digest, sources=sources,
                        runtime_digest=runtime_digest, cache_key=cache_key,
                        checkpoints=checkpoints, artifacts=artifacts, tasks=[],
                        summary={
                            "terminal_reason": "degraded_close_emitted_no_bundle",
                            "message": "compile_broker_vision --degrade-exhausted produced no output bundle.",
                        },
                        blocker_class="INTERNAL_WORK", attempts=attempts,
                    )
                    return 2
                seal_checkpoint(degraded_path, degraded_receipt, degraded_input)
            degraded_bundle = read_json(degraded_path, "degraded broker bundle")
            checkpoint(
                checkpoints,
                stage="physical_degraded_close",
                status="PASS" if (degraded_bundle.get("physical_capture_receipt") or {}).get("status") == "PASS" else "NEEDS_WORK",
                input_digest=degraded_input,
                output=degraded_path,
                reused=degraded_reused,
            )
            if (degraded_bundle.get("physical_capture_receipt") or {}).get("status") == "PASS":
                active_bundle_path = degraded_path
                active_bundle = degraded_bundle
                artifacts["verified_bundle"] = str(degraded_path)
                artifacts["degraded_close_bundle"] = str(degraded_path)

    # Canonical physical reconciliation is an explicit stage even when native
    # extraction appeared complete. It owns lane overlap and numeric ownership;
    # the semantic crosswalk later owns whether a captured cell may drive the
    # model. The two gates must never be collapsed.
    if active_bundle.get("physical_capture_receipt") is None:
        canonical_path = output_root / f"canonical-{key}-{sha256_file(active_bundle_path)[:12]}.json"
        canonical_receipt = output_root / f"canonical-{key}-{sha256_file(active_bundle_path)[:12]}.receipt.json"
        canonical_input = sha256_bytes(canonical_bytes({
            "bundle": sha256_file(active_bundle_path), "runtime": runtime_digest,
        }))
        canonical_reused = (
            reusable(canonical_path, canonical_receipt, canonical_input)
            and canonical_recovery_artifacts_valid(canonical_path)
        )
        if not canonical_reused:
            run([
                sys.executable,
                str(HERE / "compile_broker_canonical_tables.py"),
                str(active_bundle_path),
                "--out",
                str(canonical_path),
            ], {0, 2})
            seal_checkpoint(canonical_path, canonical_receipt, canonical_input)
        active_bundle_path = canonical_path
        active_bundle = read_json(canonical_path, "canonical broker bundle")
        artifacts["canonical_bundle"] = str(canonical_path)
        checkpoint(
            checkpoints,
            stage="physical_reconciliation",
            status="PASS" if active_bundle.get("gate_status") == "PASS" else "NEEDS_WORK",
            input_digest=canonical_input,
            output=canonical_path,
            reused=canonical_reused,
        )

    physical_status = (active_bundle.get("physical_capture_receipt") or {}).get("status")
    if physical_status in {"NEEDS_VISION", "NEEDS_RESOLUTION"}:
        tasks = vision_tasks(active_bundle, responses)
        responses_ready = bool(responses) and bool(tasks) and not any(
            task.get("missing_passes") for task in tasks
        )
        if responses_ready:
            responses_digest = sha256_bytes(canonical_bytes({
                target.name: sha256_file(target)
                for target in sorted(responses.glob("*.json"))
                if target.is_file()
            }))
            response_seen_before = responses_digest in attempts["vision_response_sha256"]
            attempt_exhausted = record_vision_attempt(
                attempts, responses_digest, prior_state
            )
            reconciled_path = output_root / f"reconciled-{key}-{responses_digest[:12]}.json"
            reconciled_receipt = output_root / f"reconciled-{key}-{responses_digest[:12]}.receipt.json"
            reconciled_input = sha256_bytes(canonical_bytes({
                "bundle": sha256_file(active_bundle_path),
                "responses": responses_digest,
                "runtime": runtime_digest,
                "quarantine_unresolved": prior_targeted_resolution_attempted(prior_state),
            }))
            reconciled_reused = reusable(
                reconciled_path, reconciled_receipt, reconciled_input
            )
            if not reconciled_reused:
                vision_command = [
                    sys.executable,
                    str(HERE / "compile_broker_vision.py"),
                    str(active_bundle_path),
                    "--responses",
                    str(responses),
                ]
                if prior_targeted_resolution_attempted(prior_state):
                    vision_command.append("--quarantine-unresolved")
                vision_command.extend(["--out", str(reconciled_path)])
                run(vision_command, {0, 2})
                seal_checkpoint(
                    reconciled_path, reconciled_receipt, reconciled_input
                )
            active_bundle_path = reconciled_path
            active_bundle = read_json(
                reconciled_path, "render-reconciled broker bundle"
            )
            artifacts["reconciled_bundle"] = str(reconciled_path)
            checkpoint(
                checkpoints,
                stage="physical_render_reconciliation",
                status=(
                    "PASS" if active_bundle.get("gate_status") == "PASS"
                    else "NEEDS_WORK"
                ),
                input_digest=reconciled_input,
                output=reconciled_path,
                reused=reconciled_reused,
            )
            physical_status = (
                active_bundle.get("physical_capture_receipt") or {}
            ).get("status")
            if physical_status != "PASS" and (
                attempt_exhausted
                or response_seen_before
                or bounded_capture_executed
            ):
                physical_status = "NEEDS_RESOLUTION"

    lane_degraded = bool((active_bundle.get("summary") or {}).get("degraded"))
    if (
        physical_status in {"NEEDS_VISION", "NEEDS_RESOLUTION"}
        and (
            args.close_optional
            or bounded_quarantine_requested
            or bounded_recovery_exhausted(prior_state, attempts)
        )
    ):
        # The bounded budget is spent on ORDINARY evidence ambiguity. The
        # delivery constitution forbids terminating here: close the physical
        # lane DEGRADED — quarantine the smallest defensible regions, preserve
        # every report verbatim, and continue into semantic work with only
        # clean cells eligible. BLOCKED_INTERNAL below remains reachable only
        # if even this full-degradation close cannot produce a sealed receipt,
        # which is genuine controller corruption rather than evidence doubt.
        degraded_path = output_root / f"reconciled-{key}-degraded.json"
        degraded_receipt = output_root / f"reconciled-{key}-degraded.receipt.json"
        degraded_input = sha256_bytes(canonical_bytes({
            "bundle": sha256_file(active_bundle_path),
            "runtime": runtime_digest,
            "degrade_exhausted": True,
        }))
        degraded_reused = reusable(degraded_path, degraded_receipt, degraded_input)
        if not degraded_reused:
            # --responses is REQUIRED by the vision compiler; without it
            # argparse exits 2, which sits inside the allowed exit set and
            # would silently skip the mandated close. An exhausted resume with
            # no responses on disk degrades against an empty directory: every
            # unresolved surface closes quarantined-evidence-only.
            if responses is not None and responses.is_dir():
                degrade_responses = responses
            else:
                degrade_responses = output_root / "degrade-empty-responses"
                degrade_responses.mkdir(parents=True, exist_ok=True)
            degrade_command = [
                sys.executable,
                str(HERE / "compile_broker_vision.py"),
                str(active_bundle_path),
                "--degrade-exhausted",
                "--responses",
                str(degrade_responses),
                "--out",
                str(degraded_path),
            ]
            run(degrade_command, {0, 2})
            if degraded_path.is_file():
                seal_checkpoint(degraded_path, degraded_receipt, degraded_input)
        if degraded_path.is_file():
            candidate_bundle = read_json(degraded_path, "degraded broker bundle")
            candidate_status = (
                candidate_bundle.get("physical_capture_receipt") or {}
            ).get("status")
            checkpoint(
                checkpoints,
                stage="physical_degraded_close",
                status="PASS" if candidate_status == "PASS" else "NEEDS_WORK",
                input_digest=degraded_input,
                output=degraded_path,
                reused=degraded_reused,
            )
            if candidate_status == "PASS":
                active_bundle_path = degraded_path
                active_bundle = candidate_bundle
                artifacts["reconciled_bundle"] = str(degraded_path)
                artifacts["degraded_close_bundle"] = str(degraded_path)
                # Downstream evidence compilation must consume the bundle that
                # CARRIES the quarantine dispositions, never a rawer one.
                artifacts["verified_bundle"] = str(degraded_path)
                physical_status = "PASS"
                lane_degraded = True

    if physical_status in {"NEEDS_VISION", "NEEDS_RESOLUTION"}:
        transcription_tasks = vision_tasks(active_bundle, responses)
        # A canonical overlap may be labelled NEEDS_RESOLUTION before the two
        # independent rendered reads exist. Transcription is still the first
        # remedy; targeted cell adjudication is valid only after the vision
        # compiler has emitted a conflict manifest from those reads.
        if (
            bounded_capture_executed
            and not bounded_quarantine_requested
            and not bounded_recovery_exhausted(prior_state, attempts)
        ):
            tasks = bounded_capture_tasks(transcription_tasks, responses)
        elif any(task.get("missing_passes") for task in transcription_tasks):
            tasks = pending_vision_tasks(transcription_tasks)
        elif physical_status == "NEEDS_RESOLUTION":
            conflict_tasks = resolution_tasks(active_bundle)
            tasks = conflict_tasks or (
                bounded_capture_tasks(transcription_tasks, responses)
                if transcription_tasks
                else physical_reconciliation_tasks(active_bundle)
            )
        else:
            tasks = transcription_tasks
        if not tasks:
            tasks = physical_reconciliation_tasks(active_bundle)
        write_state(
            state_path,
            run_id=run_id,
            status=physical_status,
            request_digest=request_digest,
            sources=sources,
            runtime_digest=runtime_digest,
            cache_key=cache_key,
            checkpoints=checkpoints,
            artifacts=artifacts,
            tasks=tasks,
            summary={
                **(active_bundle.get("physical_capture_receipt") or {}),
                "terminal_reason": None,
                "bounded_capture_response_errors": bounded_response_errors,
            },
            blocker_class="INTERNAL_WORK",
            attempts=attempts,
        )
        return 2
    if physical_status != "PASS":
        raise RuntimeError(
            f"Canonical physical reconciliation returned invalid status {physical_status!r}."
        )

    # Every closed state and downstream ingress declaration refers to the
    # actual physical-authority bundle, even when no vision/degraded filename
    # was needed. Avoid making clean-native and degraded paths expose different
    # artifact interfaces.
    artifacts["verified_bundle"] = str(active_bundle_path)

    # Physical preservation can be complete while a rendered period label is
    # still truncated in the PDF text lane. Resolve that late boundary here,
    # before a semantic crosswalk can consume it. One model-host read is
    # allowed; an omitted/unreadable column then degrades locally rather than
    # stopping the broker lane or the company model.
    unresolved_period_targets = period_target_inventory(active_bundle)
    if unresolved_period_targets:
        period_review_path = responses / "broker-period-header-review.json" if responses else None
        prior_period_task = any(
            task.get("task_kind") == "period_header_adjudication"
            for task in prior_state.get("tasks", [])
        )
        if not period_review_path or not period_review_path.is_file():
            if not prior_period_task and not bounded_recovery_exhausted(prior_state, attempts):
                checkpoint(
                    checkpoints, stage="period_header_recovery", status="NEEDS_WORK",
                    input_digest=sha256_file(active_bundle_path), output=None, reused=False,
                )
                write_state(
                    state_path, run_id=run_id, status="NEEDS_RESOLUTION",
                    request_digest=request_digest, sources=sources,
                    runtime_digest=runtime_digest, cache_key=cache_key,
                    checkpoints=checkpoints, artifacts=artifacts,
                    tasks=period_header_tasks(active_bundle, active_bundle_path),
                    summary={
                        "unresolved_period_table_count": len(unresolved_period_targets),
                        "terminal_reason": None,
                    },
                    blocker_class="INTERNAL_WORK", attempts=attempts,
                )
                return 2
        period_input = sha256_bytes(canonical_bytes({
            "bundle": sha256_file(active_bundle_path),
            "review": sha256_file(period_review_path) if period_review_path and period_review_path.is_file() else None,
            "quarantine_unresolved": True,
            "runtime": runtime_digest,
        }))
        period_path = output_root / f"period-resolved-{key}-{period_input[:12]}.json"
        period_receipt_path = output_root / f"period-resolved-{key}-{period_input[:12]}.receipt.json"
        period_checkpoint_receipt = output_root / f"period-resolved-{key}-{period_input[:12]}.checkpoint.json"
        period_reused = reusable(period_path, period_checkpoint_receipt, period_input)
        if not period_reused:
            command = [
                sys.executable, str(HERE / "broker_period_recovery.py"),
                str(active_bundle_path), "--quarantine-unresolved",
                "--out", str(period_path), "--receipt", str(period_receipt_path),
            ]
            if period_review_path and period_review_path.is_file():
                command.extend(["--review", str(period_review_path)])
            completed_period = run(command, {0, 1, 2})
            if completed_period.returncode != 0 or not period_path.is_file():
                # A malformed response never becomes authority. Once the
                # bounded task has been attempted, close without it by local
                # column quarantine rather than surfacing another stop.
                command = [
                    sys.executable, str(HERE / "broker_period_recovery.py"),
                    str(active_bundle_path), "--quarantine-unresolved",
                    "--out", str(period_path), "--receipt", str(period_receipt_path),
                ]
                run(command, {0})
            seal_checkpoint(period_path, period_checkpoint_receipt, period_input)
        recovered_period_bundle = read_json(period_path, "period-resolved broker bundle")
        period_receipt = read_json(period_receipt_path, "period-header recovery receipt")
        if period_receipt.get("status") != "PASS":
            raise RuntimeError("Period-header recovery did not reach its bounded terminal state.")
        active_bundle_path = period_path
        active_bundle = recovered_period_bundle
        artifacts["verified_bundle"] = str(period_path)
        artifacts["period_header_recovery_receipt"] = str(period_receipt_path)
        lane_degraded = bool(lane_degraded or period_receipt.get("quarantined_column_count"))
        checkpoint(
            checkpoints, stage="period_header_recovery", status="PASS",
            input_digest=period_input, output=period_path, reused=period_reused,
        )

    crosswalk = Path(args.crosswalk).resolve() if args.crosswalk else None
    if not crosswalk or not crosswalk.is_file():
        if isinstance(request.get("model_context"), dict):
            bundle_digest = sha256_file(active_bundle_path)
            selected_crosswalk, selection_receipt = compile_demand_selected_crosswalk(
                active_bundle,
                request["model_context"],
                bundle_sha256=bundle_digest,
            )
            shell_hash = sha256_bytes(canonical_bytes(selected_crosswalk))
            if selected_crosswalk.get("mappings"):
                crosswalk = output_root / f"demand-selected-crosswalk-{key}-{shell_hash[:12]}.json"
                selection_receipt_path = output_root / f"demand-selected-crosswalk-{key}-{shell_hash[:12]}.receipt.json"
                atomic_json(crosswalk, selected_crosswalk)
                atomic_json(selection_receipt_path, selection_receipt)
                artifacts["crosswalk"] = str(crosswalk)
                artifacts["demand_selected_crosswalk_receipt"] = str(selection_receipt_path)
                if (selected_crosswalk.get("terminal_recovery") or {}).get("quarantined_candidates"):
                    artifacts["terminal_recovery_receipt"] = str(selection_receipt_path)
                    lane_degraded = True
            else:
                zero_crosswalk, zero_receipt, zero_semantic = degrade_all_broker_authority(
                    bundle=active_bundle,
                    crosswalk=selected_crosswalk,
                    bundle_sha256=bundle_digest,
                    source_crosswalk_sha256=shell_hash,
                    reason=(
                        "No source row met the exact demand, period and unit contract; preserve all "
                        "broker evidence and continue with zero broker model authority."
                    ),
                )
                crosswalk = output_root / f"zero-authority-crosswalk-{key}-{shell_hash[:12]}.json"
                zero_receipt_path = output_root / f"zero-authority-crosswalk-{key}-{shell_hash[:12]}.receipt.json"
                zero_semantic_path = output_root / f"zero-authority-terminal-semantic-{key}-{shell_hash[:12]}.json"
                atomic_json(crosswalk, zero_crosswalk)
                atomic_json(zero_receipt_path, zero_receipt)
                atomic_json(zero_semantic_path, zero_semantic)
                artifacts["crosswalk"] = str(crosswalk)
                artifacts["zero_authority_receipt"] = str(zero_receipt_path)
                artifacts["terminal_recovery_receipt"] = str(zero_receipt_path)
                lane_degraded = True
            checkpoint(
                checkpoints, stage="semantic_crosswalk", status="PASS",
                input_digest=sha256_file(active_bundle_path), output=crosswalk, reused=False,
            )
        else:
            checkpoint(checkpoints, stage="semantic_crosswalk", status="NEEDS_WORK", input_digest=sha256_file(active_bundle_path), output=None, reused=False)
            write_state(
                state_path, run_id=run_id, status="NEEDS_CROSSWALK", request_digest=request_digest,
                sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
                checkpoints=checkpoints, artifacts=artifacts,
                tasks=[{
                    "task_kind": "semantic_crosswalk_review",
                    "verified_bundle": str(active_bundle_path),
                    "candidate_manifest_sha256": sha256_bytes(canonical_bytes(active_bundle.get("candidate_manifest"))),
                    "model_demand_graph": request.get("model_context", {}).get("model_demand_graph"),
                    "instruction": "Author a selected-cell crosswalk only for model-demand nodes. Unselected rows remain preserved evidence and never block delivery.",
                }],
                summary={"candidate_count": len(active_bundle.get("candidate_manifest", {}).get("candidates", []))},
                blocker_class="INTERNAL_WORK", attempts=attempts,
            )
            return 2

    if isinstance(request.get("model_context"), dict):
        supplied_crosswalk = read_json(crosswalk, "broker crosswalk")
        rebased_crosswalk, rebase_receipt = rebase_crosswalk_table_reviews(
            active_bundle,
            supplied_crosswalk,
            request["model_context"],
        )
        if rebase_receipt["missing_mapped_table_ids"]:
            # Preserve the decision artifact unchanged so the independent
            # semantic/pack gates can name the selected-cell defect. Rebase is
            # never allowed to make a missing selected source appear valid.
            rebased_crosswalk = supplied_crosswalk
        elif rebased_crosswalk != supplied_crosswalk:
            source_crosswalk_digest = sha256_file(crosswalk)
            rebased_path = output_root / f"rebased-crosswalk-{key}-{source_crosswalk_digest[:12]}.json"
            rebase_receipt_path = output_root / f"rebased-crosswalk-{key}-{source_crosswalk_digest[:12]}.receipt.json"
            atomic_json(rebased_path, rebased_crosswalk)
            atomic_json(rebase_receipt_path, {
                **rebase_receipt,
                "source_crosswalk_sha256": source_crosswalk_digest,
                "rebased_crosswalk_sha256": sha256_file(rebased_path),
            })
            crosswalk = rebased_path
            artifacts["crosswalk"] = str(crosswalk)
            artifacts["crosswalk_table_rebase_receipt"] = str(rebase_receipt_path)
            checkpoint(
                checkpoints,
                stage="crosswalk_table_rebase",
                status="PASS",
                input_digest=source_crosswalk_digest,
                output=rebased_path,
                reused=False,
            )

    crosswalk_digest = sha256_file(crosswalk)
    record_task_execution_attempt(
        attempts,
        prior_state,
        crosswalk_digest,
        {
            "semantic_crosswalk_review",
            "semantic_crosswalk_repair",
            "broker_pack_repair",
        },
    )
    artifacts["crosswalk"] = str(crosswalk)
    semantic_path = output_root / f"semantic-{key}-{crosswalk_digest[:12]}.json"
    semantic_input = sha256_bytes(canonical_bytes({
        "bundle": sha256_file(active_bundle_path), "crosswalk": crosswalk_digest, "runtime": runtime_digest,
    }))
    semantic_receipt = output_root / f"semantic-{key}-{crosswalk_digest[:12]}.receipt.json"
    semantic_reused = reusable(semantic_path, semantic_receipt, semantic_input)
    if not semantic_reused:
        completed_semantic = run([sys.executable, str(HERE / "verify_broker_semantics.py"), str(active_bundle_path), str(crosswalk), "--out", str(semantic_path)], {0, 1})
        if not semantic_path.is_file():
            # The reviewer-supplied crosswalk broke the independent verifier
            # before it could report. That is a defective REVIEW ARTIFACT, not
            # a controller crash: name it and ask for a corrected review.
            checkpoint(checkpoints, stage="semantic_verification", status="NEEDS_WORK", input_digest=semantic_input, output=None, reused=False)
            write_state(
                state_path, run_id=run_id, status="NEEDS_CROSSWALK_REVIEW", request_digest=request_digest,
                sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
                checkpoints=checkpoints, artifacts=artifacts,
                tasks=[{
                    "task_kind": "semantic_crosswalk_repair",
                    "crosswalk_sha256": crosswalk_digest,
                    "verifier_diagnostic": (completed_semantic.stderr or completed_semantic.stdout).strip()[-2000:],
                    "instruction": (
                        "The supplied crosswalk is structurally invalid (the independent "
                        "verifier could not evaluate it). Correct the review artifact; do "
                        "not alter source evidence or the verifier."
                    ),
                }],
                summary={"terminal_reason": None, "crosswalk_invalid": True},
                blocker_class="INTERNAL_WORK", attempts=attempts,
            )
            return 2
        seal_checkpoint(semantic_path, semantic_receipt, semantic_input)
    semantic = read_json(semantic_path, "broker semantic report")
    artifacts["semantic_report"] = str(semantic_path)
    checkpoint(checkpoints, stage="semantic_verification", status="PASS" if semantic.get("status") == "PASS" else "NEEDS_WORK", input_digest=semantic_input, output=semantic_path, reused=semantic_reused)
    if semantic.get("status") != "PASS":
        source_crosswalk = read_json(crosswalk, "broker crosswalk")
        recovery_analysis = analyse_terminal_recovery(active_bundle, source_crosswalk, semantic)
        # Findings confined to candidates that are neither selected nor
        # potential model drivers require no further semantic authorship. The
        # controller can seal their negative-consumption disposition now,
        # bound to this run's candidate manifest, and preserve every selected
        # mapping. Deferring this safe close previously let a fresh external
        # crosswalk fall through to the global zero-authority breaker merely
        # because native archive candidates varied across processes.
        if recovery_analysis["can_recover"]:
            terminal_review = automatic_negative_consumption_review(
                bundle=active_bundle,
                crosswalk_sha256=crosswalk_digest,
                semantic_report_sha256=sha256_file(semantic_path),
                semantic_report=semantic,
                bundle_sha256=sha256_file(active_bundle_path),
            )
            recovered_crosswalk, recovery_receipt = apply_terminal_review(
                bundle=active_bundle,
                crosswalk=source_crosswalk,
                semantic_report=semantic,
                review=terminal_review,
                bundle_sha256=sha256_file(active_bundle_path),
                crosswalk_sha256=crosswalk_digest,
                semantic_report_sha256=sha256_file(semantic_path),
            )
            recovered_path = output_root / f"terminal-crosswalk-{key}-{crosswalk_digest[:12]}.json"
            recovery_receipt_path = output_root / f"terminal-crosswalk-{key}-{crosswalk_digest[:12]}.receipt.json"
            atomic_json(recovered_path, recovered_crosswalk)
            atomic_json(recovery_receipt_path, recovery_receipt)
            crosswalk = recovered_path
            crosswalk_digest = sha256_file(crosswalk)
            artifacts["crosswalk"] = str(crosswalk)
            artifacts["terminal_recovery_receipt"] = str(recovery_receipt_path)
            semantic_path = output_root / f"semantic-{key}-{crosswalk_digest[:12]}.json"
            semantic_input = sha256_bytes(canonical_bytes({
                "bundle": sha256_file(active_bundle_path),
                "crosswalk": crosswalk_digest,
                "runtime": runtime_digest,
            }))
            run([
                sys.executable, str(HERE / "verify_broker_semantics.py"),
                str(active_bundle_path), str(crosswalk), "--out", str(semantic_path),
            ], {0, 1})
            semantic = read_json(semantic_path, "terminally recovered broker semantic report")
            artifacts["semantic_report"] = str(semantic_path)
            checkpoint(
                checkpoints,
                stage="terminal_materiality_recovery",
                status="PASS" if semantic.get("status") == "PASS" else "NEEDS_WORK",
                input_digest=semantic_input,
                output=semantic_path,
                reused=False,
            )
            lane_degraded = True
            recovery_analysis = analyse_terminal_recovery(
                active_bundle, recovered_crosswalk, semantic
            )
        # A candidate-local semantic failure may already touch a selected
        # mapping. The old recovery correctly refused to call that cell
        # "unconsumed" but had no transition to make it unconsumed. Exclude
        # only the finding-owned house now, preserve all its evidence, and
        # independently re-run semantics before any pack can compile.
        if recovery_analysis["blocking_findings"] and all(
            item.get("reason") == "selected_model_candidate_unresolved"
            for item in recovery_analysis["blocking_findings"]
        ):
            try:
                recovered_crosswalk, exclusion_receipt, terminal_semantic = degrade_finding_houses(
                    bundle=active_bundle,
                    crosswalk=source_crosswalk,
                    semantic_report=semantic,
                    bundle_sha256=sha256_file(active_bundle_path),
                    source_crosswalk_sha256=crosswalk_digest,
                )
            except ValueError:
                pass
            else:
                recovered_path = output_root / f"house-excluded-crosswalk-{key}-{crosswalk_digest[:12]}.json"
                exclusion_receipt_path = output_root / f"house-excluded-crosswalk-{key}-{crosswalk_digest[:12]}.receipt.json"
                terminal_semantic_path = output_root / f"house-excluded-terminal-semantic-{key}-{crosswalk_digest[:12]}.json"
                atomic_json(recovered_path, recovered_crosswalk)
                atomic_json(exclusion_receipt_path, exclusion_receipt)
                atomic_json(terminal_semantic_path, terminal_semantic)
                crosswalk = recovered_path
                crosswalk_digest = sha256_file(crosswalk)
                artifacts["crosswalk"] = str(crosswalk)
                artifacts["house_exclusion_receipt"] = str(exclusion_receipt_path)
                artifacts["terminal_recovery_receipt"] = str(exclusion_receipt_path)
                semantic_path = output_root / f"semantic-{key}-{crosswalk_digest[:12]}.json"
                semantic_input = sha256_bytes(canonical_bytes({
                    "bundle": sha256_file(active_bundle_path), "crosswalk": crosswalk_digest,
                    "runtime": runtime_digest,
                }))
                run([
                    sys.executable, str(HERE / "verify_broker_semantics.py"),
                    str(active_bundle_path), str(crosswalk), "--out", str(semantic_path),
                ], {0, 1})
                semantic = read_json(semantic_path, "house-excluded broker semantic report")
                artifacts["semantic_report"] = str(semantic_path)
                checkpoint(
                    checkpoints, stage="house_local_authority_fallback",
                    status="PASS" if semantic.get("status") == "PASS" else "NEEDS_WORK",
                    input_digest=semantic_input, output=semantic_path, reused=False,
                )
                lane_degraded = True
                recovery_analysis = analyse_terminal_recovery(active_bundle, recovered_crosswalk, semantic)
        if semantic.get("status") != "PASS":
            # Broker evidence is optional to model delivery. Once a supplied
            # crosswalk has failed the independent semantic oracle, remove the
            # entire broker authority edge set, preserve every immutable
            # candidate in terminal quarantine, and rerun the oracle. This is
            # the finite circuit breaker for global/unbound findings and for a
            # house-local repair that still cannot close.
            try:
                zero_crosswalk, zero_receipt, zero_semantic = degrade_all_broker_authority(
                    bundle=active_bundle,
                    crosswalk=read_json(crosswalk, "active broker crosswalk"),
                    bundle_sha256=sha256_file(active_bundle_path),
                    source_crosswalk_sha256=crosswalk_digest,
                    reason=(
                        "The supplied broker semantic mapping did not pass the independent "
                        "oracle; preserve all reports and continue with zero broker model authority."
                    ),
                )
            except ValueError:
                pass
            else:
                zero_path = output_root / f"zero-authority-crosswalk-{key}-{crosswalk_digest[:12]}.json"
                zero_receipt_path = output_root / f"zero-authority-crosswalk-{key}-{crosswalk_digest[:12]}.receipt.json"
                zero_semantic_path = output_root / f"zero-authority-terminal-semantic-{key}-{crosswalk_digest[:12]}.json"
                atomic_json(zero_path, zero_crosswalk)
                atomic_json(zero_receipt_path, zero_receipt)
                atomic_json(zero_semantic_path, zero_semantic)
                crosswalk = zero_path
                crosswalk_digest = sha256_file(crosswalk)
                artifacts["crosswalk"] = str(crosswalk)
                artifacts["zero_authority_receipt"] = str(zero_receipt_path)
                artifacts["terminal_recovery_receipt"] = str(zero_receipt_path)
                semantic_path = output_root / f"semantic-{key}-{crosswalk_digest[:12]}.json"
                semantic_input = sha256_bytes(canonical_bytes({
                    "bundle": sha256_file(active_bundle_path), "crosswalk": crosswalk_digest,
                    "runtime": runtime_digest,
                }))
                run([
                    sys.executable, str(HERE / "verify_broker_semantics.py"),
                    str(active_bundle_path), str(crosswalk), "--out", str(semantic_path),
                ], {0, 1})
                semantic = read_json(semantic_path, "zero-authority broker semantic report")
                artifacts["semantic_report"] = str(semantic_path)
                checkpoint(
                    checkpoints, stage="zero_broker_authority_fallback",
                    status="PASS" if semantic.get("status") == "PASS" else "NEEDS_WORK",
                    input_digest=semantic_input, output=semantic_path, reused=False,
                )
                lane_degraded = True
                recovery_analysis = analyse_terminal_recovery(
                    active_bundle, zero_crosswalk, semantic
                )
        terminal_review_path = responses / "broker-terminal-materiality-review.json" if responses else None
        prior_terminal = any(
            task.get("task_kind") == "terminal_materiality_recovery"
            for task in prior_state.get("tasks", [])
        )
        prior_semantic_near_exhaustion = any(
            task.get("task_kind") == "semantic_crosswalk_repair"
            and int(task.get("attempt_budget", {}).get("attempts_remaining", 99)) <= 1
            for task in prior_state.get("tasks", [])
        )
        semantic_attempt_limit = int(
            model_host_boundary()["tasks"]["semantic_crosswalk_repair"][
                "attempt_limit"
            ]
        )
        prior_semantic_near_exhaustion = bool(
            prior_semantic_near_exhaustion
            or task_family_execution_count(
                attempts,
                prior_state,
                {
                    "semantic_crosswalk_review",
                    "semantic_crosswalk_repair",
                    "broker_pack_repair",
                },
            )
            >= max(1, semantic_attempt_limit - 1)
        )
        automatic_terminal = recovery_analysis["can_recover"] and (
            prior_semantic_near_exhaustion or prior_terminal
        )
        if (
            automatic_terminal
        ):
            if terminal_review_path and terminal_review_path.is_file():
                record_task_execution_attempt(
                    attempts,
                    prior_state,
                    sha256_file(terminal_review_path),
                    {"terminal_materiality_recovery"},
                )
                terminal_review = read_json(
                    terminal_review_path, "terminal broker materiality review"
                )
            else:
                terminal_review = automatic_negative_consumption_review(
                    bundle=active_bundle,
                    crosswalk_sha256=crosswalk_digest,
                    semantic_report_sha256=sha256_file(semantic_path),
                    semantic_report=semantic,
                    bundle_sha256=sha256_file(active_bundle_path),
                )
            try:
                recovered_crosswalk, recovery_receipt = apply_terminal_review(
                    bundle=active_bundle,
                    crosswalk=source_crosswalk,
                    semantic_report=semantic,
                    review=terminal_review,
                    bundle_sha256=sha256_file(active_bundle_path),
                    crosswalk_sha256=crosswalk_digest,
                    semantic_report_sha256=sha256_file(semantic_path),
                )
            except ValueError as error:
                recovery_analysis = {
                    **recovery_analysis,
                    "review_validation_error": str(error),
                }
            else:
                recovered_path = output_root / f"terminal-crosswalk-{key}-{crosswalk_digest[:12]}.json"
                recovery_receipt_path = output_root / f"terminal-crosswalk-{key}-{crosswalk_digest[:12]}.receipt.json"
                atomic_json(recovered_path, recovered_crosswalk)
                atomic_json(recovery_receipt_path, recovery_receipt)
                crosswalk = recovered_path
                crosswalk_digest = sha256_file(crosswalk)
                artifacts["crosswalk"] = str(crosswalk)
                artifacts["terminal_recovery_receipt"] = str(recovery_receipt_path)
                semantic_path = output_root / f"semantic-{key}-{crosswalk_digest[:12]}.json"
                semantic_input = sha256_bytes(canonical_bytes({
                    "bundle": sha256_file(active_bundle_path), "crosswalk": crosswalk_digest,
                    "runtime": runtime_digest,
                }))
                run([
                    sys.executable, str(HERE / "verify_broker_semantics.py"),
                    str(active_bundle_path), str(crosswalk), "--out", str(semantic_path),
                ], {0, 1})
                semantic = read_json(semantic_path, "terminally recovered broker semantic report")
                artifacts["semantic_report"] = str(semantic_path)
                checkpoint(
                    checkpoints, stage="terminal_materiality_recovery",
                    status="PASS" if semantic.get("status") == "PASS" else "NEEDS_WORK",
                    input_digest=semantic_input, output=semantic_path, reused=False,
                )
                if semantic.get("status") != "PASS":
                    write_state(
                        state_path, run_id=run_id, status="BLOCKED_INTERNAL", request_digest=request_digest,
                        sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
                        checkpoints=checkpoints, artifacts=artifacts,
                        tasks=[{
                            "task_kind": "internal_fixed_point_defect",
                            "failed_status": "NEEDS_CROSSWALK_REVIEW",
                            "instruction": "The independently sealed terminal recovery did not satisfy the semantic verifier; repair the controller boundary, never the source evidence.",
                        }],
                        summary={"terminal_reason": "terminal_recovery_verification_defect"},
                        blocker_class="INTERNAL_WORK", attempts=attempts,
                    )
                    return 2

        if semantic.get("status") != "PASS":
            use_terminal_lane = recovery_analysis["can_recover"] and (
                prior_semantic_near_exhaustion or prior_terminal
            )
            task = {
                "task_kind": "terminal_materiality_recovery" if use_terminal_lane else "semantic_crosswalk_repair",
                "crosswalk": str(crosswalk),
                "semantic_report": str(semantic_path),
                "findings": semantic.get("findings", []),
                "terminal_recovery_analysis": recovery_analysis,
                "run_id": run_id,
                "bundle_sha256": sha256_file(active_bundle_path),
                "candidate_manifest_sha256": sha256_bytes(canonical_bytes(active_bundle.get("candidate_manifest"))),
                "source_crosswalk_sha256": crosswalk_digest,
                "semantic_report_sha256": sha256_file(semantic_path),
                "instruction": (
                    "Review every and only listed non-consumed candidate and preserve it in evidence quarantine; do not invent a value or select it for model use."
                    if use_terminal_lane else
                    "Repair all crosswalk declarations together. Do not alter source evidence, schemas, dictionaries or validators."
                ),
            }
            write_state(
                state_path, run_id=run_id, status="NEEDS_CROSSWALK_REVIEW", request_digest=request_digest,
                sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
                checkpoints=checkpoints, artifacts=artifacts, tasks=[task],
                summary={
                    "total_violation_count": semantic.get("total_violation_count"),
                    "recoverable_nonconsumed_candidate_count": len(recovery_analysis["recoverable_candidate_ids"]),
                    "blocking_selected_or_global_finding_count": len(recovery_analysis["blocking_findings"]),
                    "terminal_materiality_lane": use_terminal_lane,
                },
                blocker_class="INTERNAL_WORK", attempts=attempts,
            )
            return 2

    compiled_root = output_root / f"compiled-{key}-{crosswalk_digest[:12]}"
    pack_path = compiled_root / "broker-pack.json"
    pack_receipt = output_root / f"compiled-{key}-{crosswalk_digest[:12]}.receipt.json"
    pack_input = sha256_bytes(canonical_bytes({
        "bundle": sha256_file(active_bundle_path), "crosswalk": crosswalk_digest,
        "semantic": sha256_file(semantic_path), "runtime": runtime_digest,
    }))
    pack_reused = reusable(pack_path, pack_receipt, pack_input)
    if not pack_reused:
        completed = run([sys.executable, str(HERE / "compile_broker_pack.py"), str(active_bundle_path), str(crosswalk), "--out", str(compiled_root)], {0, 1})
        if completed.returncode != 0 or not pack_path.is_file():
            write_state(
                state_path, run_id=run_id, status="NEEDS_CROSSWALK_REVIEW", request_digest=request_digest,
                sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
                checkpoints=checkpoints, artifacts=artifacts,
                tasks=[{
                    "task_kind": "broker_pack_repair",
                    "crosswalk": str(crosswalk),
                    "message": (completed.stderr or completed.stdout).strip()[-4000:],
                }],
                summary={"total_violation_count": 1},
                blocker_class="INTERNAL_WORK", attempts=attempts,
            )
            return 2
        seal_checkpoint(pack_path, pack_receipt, pack_input)
    pack = read_json(pack_path, "compiled broker pack")
    artifacts.update({
        "broker_pack": str(pack_path),
        "source_tables": str(compiled_root / "broker-source-tables.json"),
        "broker_source_tables": str(compiled_root / "broker-source-tables.json"),
        "broker_crosswalk_receipt": str(compiled_root / "broker-crosswalk-receipt.json"),
        "broker_semantic_verification": str(compiled_root / "broker-semantic-verification-report.json"),
    })
    checkpoint(checkpoints, stage="pack_compilation", status="PASS", input_digest=pack_input, output=pack_path, reused=pack_reused)
    eligibility = pack.get("eligibility_summary", {})
    summary = {
        "document_count": len(active_bundle.get("documents", [])),
        "surface_count": active_bundle.get("summary", {}).get("surface_count", 0),
        "table_count": active_bundle.get("summary", {}).get("table_count", 0),
        "cell_count": active_bundle.get("summary", {}).get("cell_count", 0),
        "quarantined_conflict_count": active_bundle.get("summary", {}).get("quarantined_conflict_count", 0),
        "primary_eligible_house_count": eligibility.get("primary_eligible_house_count", 0),
        "supplemental_eligible_house_count": eligibility.get("supplemental_eligible_house_count", 0),
        "recommended_primary_house_id": pack.get("recommended_primary_house_id"),
        "model_demand_graph_sha256": (
            (request.get("model_context") or {}).get("model_demand_graph") or {}
        ).get("graph_sha256"),
        "continuation_status": (
            "PRIMARY_AUTHORITY_AVAILABLE"
            if eligibility.get("run_can_continue_without_broker_question")
            else "DEFER_TO_FORECAST_WATERFALL"
        ),
    }
    summary["degraded"] = bool(
        lane_degraded
        or active_bundle.get("summary", {}).get("degraded")
        or summary.get("quarantined_conflict_count")
    )
    summary["quarantined_surface_count"] = active_bundle.get("summary", {}).get(
        "quarantined_surface_count", 0
    )
    summary["excluded_house_count"] = 0
    if artifacts.get("house_exclusion_receipt"):
        exclusion_summary = read_json(
            Path(artifacts["house_exclusion_receipt"]), "broker house-exclusion receipt"
        )
        summary["excluded_house_count"] = len(exclusion_summary.get("excluded_house_ids", []))
        # The excluded candidates are preserved in terminal quarantine inside
        # the recovered crosswalk, not by mutating source cells in the bundle.
        # Surface that receipted degradation explicitly so PASS can never hide
        # a house-local authority fallback.
        summary["quarantined_conflict_count"] = max(
            int(summary.get("quarantined_conflict_count") or 0),
            int(exclusion_summary.get("preserved_candidate_count") or 0),
        )
        summary["degraded"] = True
    if summary["degraded"]:
        seal_degraded_delivery_close(
            output_root=output_root,
            run_id=run_id,
            cache_key=cache_key,
            active_bundle_path=active_bundle_path,
            artifacts=artifacts,
            checkpoints=checkpoints,
            summary=summary,
        )
    write_state(
        state_path, run_id=run_id,
        status="PASS_DEGRADED" if summary["degraded"] else "PASS",
        request_digest=request_digest,
        sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
        checkpoints=checkpoints, artifacts=artifacts, tasks=[], summary=summary,
        blocker_class=None, attempts=attempts,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
