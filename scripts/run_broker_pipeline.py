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

from workflow_state import assert_state, assert_transition


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUNTIME_MANIFEST = ROOT / "assets" / "broker-runtime-members.json"
MODEL_HOST_BOUNDARY = ROOT / "assets" / "broker-model-host-response-boundary-v1.json"
VISION_ATTEMPT_LIMIT = 3

INTERNAL_STAGE_ORDINAL = {
    "NEEDS_VISION": 2,
    "NEEDS_RESOLUTION": 3,
    "NEEDS_CROSSWALK": 4,
    "NEEDS_CROSSWALK_REVIEW": 5,
    "BLOCKED_INTERNAL": 6,
    "PASS": 7,
}


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


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
    if kind in {"targeted_cell_adjudication", "bounded_capture_adjudication"} and surface_id:
        return [f"{surface_id}.resolution.json"]
    if kind in {
        "semantic_crosswalk_review",
        "semantic_crosswalk_repair",
        "broker_pack_repair",
    }:
        return ["broker-crosswalk.json"]
    return []


def task_identity(task: dict[str, Any], cache_key: str) -> tuple[str, str]:
    raw = {
        key: value
        for key, value in task.items()
        if key not in {
            "task_id", "user_blocking", "remedy", "attempt_budget",
            "progress_measure", "model_host_response_boundary",
        }
    }
    input_sha = sha256_bytes(canonical_bytes({"cache_key": cache_key, "task": raw}))
    return f"broker-task-{input_sha[:24]}", input_sha


def fixed_point_stage(status: str, tasks: list[dict[str, Any]]) -> tuple[int, str]:
    ordinal = INTERNAL_STAGE_ORDINAL.get(status, 0)
    kinds = sorted({str(task.get("task_kind") or "unknown") for task in tasks})
    return ordinal, "+".join(kinds) if kinds else status.lower()


def seal_internal_work(
    *,
    prior: dict[str, Any],
    cache_key: str,
    status: str,
    tasks: list[dict[str, Any]],
    checkpoints: list[dict[str, Any]],
    summary: dict[str, Any],
) -> tuple[str, list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    """Seal one monotonic, finitely retryable internal-work frontier.

    The function deliberately does not answer a task.  It binds the visual or
    semantic work to an external model-host response contract, counts unchanged
    retries, proves stage monotonicity and collapses any exhausted/regressed
    frontier into one controller-owned terminal defect.
    """
    boundary = model_host_boundary()
    prior_fixed = prior.get("fixed_point", {}) if prior.get("cache_key") == cache_key else {}
    prior_tasks = {
        item.get("task_id"): item
        for item in prior.get("tasks", [])
        if isinstance(item, dict) and item.get("task_id")
    }
    ordinal, stage = fixed_point_stage(status, tasks)
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
        attempts_used = min(
            int(prior_packet.get("attempt_budget", {}).get("attempts_used", -1)) + 1,
            int(declaration["attempt_limit"]),
        )
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
            },
            "progress_measure": {
                "stage": stage,
                "stage_ordinal": ordinal,
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
        sealed.append(packet)

    task_set_sha = sha256_bytes(canonical_bytes([
        {"task_id": task["task_id"], "input": task["progress_measure"]["task_input_sha256"]}
        for task in sealed
    ]))
    progress_score = ordinal * 10000 + passed_checkpoints * 100 - len(sealed)
    progress_sha = sha256_bytes(canonical_bytes({
        "stage_ordinal": ordinal,
        "passed_checkpoint_count": passed_checkpoints,
        "task_set_sha256": task_set_sha,
    }))
    same_transaction = prior.get("cache_key") == cache_key
    prior_ordinal = int(prior_fixed.get("stage_ordinal", -1)) if same_transaction else -1
    prior_passed = int(prior_fixed.get("passed_checkpoint_count", -1)) if same_transaction else -1
    prior_progress_sha = prior_fixed.get("progress_sha256") if same_transaction else None
    regression_reasons: list[str] = []
    if same_transaction and prior_ordinal > ordinal:
        regression_reasons.append(
            f"internal stage regressed from ordinal {prior_ordinal} to {ordinal}"
        )
    if same_transaction and prior_ordinal == ordinal and prior_passed > passed_checkpoints:
        regression_reasons.append(
            f"passed checkpoint count regressed from {prior_passed} to {passed_checkpoints}"
        )
    stall_count = (
        int(prior_fixed.get("unchanged_retry_count", 0)) + 1
        if prior_progress_sha == progress_sha and same_transaction
        else 0
    )
    exhausted_tasks = [
        task["task_id"]
        for task in sealed
        if task["attempt_budget"]["attempts_remaining"] == 0
    ]
    stall_limit = int(boundary["stall_attempt_limit"])
    terminal_reasons = list(regression_reasons)
    if status == "BLOCKED_INTERNAL":
        terminal_reasons.append("an upstream broker checkpoint returned BLOCKED_INTERNAL")
    if stall_count >= stall_limit:
        terminal_reasons.append(
            f"internal progress frontier was unchanged for {stall_count} retries"
        )
    if exhausted_tasks:
        terminal_reasons.append(
            f"task attempt budget exhausted: {', '.join(sorted(exhausted_tasks))}"
        )

    fixed = {
        "schema_version": "broker-internal-fixed-point/1.0",
        "status": "TERMINAL_DEFECT" if terminal_reasons else "OPEN",
        "stage": stage,
        "stage_ordinal": ordinal,
        "passed_checkpoint_count": passed_checkpoints,
        "remaining_task_count": len(sealed),
        "progress_score": progress_score,
        "progress_sha256": progress_sha,
        "task_set_sha256": task_set_sha,
        "unchanged_retry_count": stall_count,
        "unchanged_retry_limit": stall_limit,
        "monotonic_from_prior": not regression_reasons,
        "checkpoint_reuse_required": True,
        "terminal_reasons": terminal_reasons,
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
        },
        "progress_measure": {
            "stage": "terminal_internal_defect",
            "stage_ordinal": INTERNAL_STAGE_ORDINAL["BLOCKED_INTERNAL"],
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


def record_vision_attempt(attempts: dict[str, Any], response_digest: str) -> bool:
    """Record an invocation, even when the host resubmits identical bad bytes.

    Unique response hashes remain useful audit evidence, but they are not an
    attempt counter: otherwise the same unchanged invalid response can keep a
    run in NEEDS_VISION forever.  The returned boolean is the finite terminal
    signal for this cache key.
    """
    if response_digest not in attempts["vision_response_sha256"]:
        attempts["vision_response_sha256"].append(response_digest)
    attempts["vision_attempt_count"] = int(attempts.get("vision_attempt_count", 0)) + 1
    return attempts["vision_attempt_count"] >= int(attempts["vision_attempt_limit"])


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


def artifact_path(bundle: dict[str, Any], document: dict[str, Any], artifact_id: str) -> Path | None:
    artifact = next((item for item in document.get("artifacts", []) if item.get("artifact_id") == artifact_id), None)
    if not artifact:
        return None
    root = Path(str(bundle.get("artifact_root") or ""))
    target = (root / str(artifact.get("path") or "")).resolve()
    return target if target.is_file() else None


def vision_tasks(bundle: dict[str, Any], responses: Path | None) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for document in bundle.get("documents", []):
        for surface in document.get("surfaces", []):
            if surface.get("lane_status", {}).get("vision") != "required":
                continue
            surface_id = str(surface.get("surface_id"))
            pass_paths = [Path(str(responses / f"{surface_id}.pass{index}.json")) for index in (1, 2)] if responses else []
            missing_passes = [index for index, target in enumerate(pass_paths, start=1) if not target.is_file()]
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
            crop_paths = []
            for crop in task_payload.get("region_crops", []):
                crop_target = artifact_path(bundle, document, str(crop.get("image_artifact_id") or ""))
                if crop_target:
                    crop_paths.append({
                        "region_id": crop.get("region_id"),
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
                "region_crops": crop_paths,
                "task_path": str(task_path) if task_path else None,
                "instruction": (
                    "Complete two independent grid-preserving table reads. Use native text, coordinates, "
                    "vector geometry, high-resolution crops and cell OCR as corroborating lanes. Do not "
                    "return a flat numeric list and do not request replacement research."
                ),
            })
    return tasks


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
        )
        blocker_class = "INTERNAL_WORK"
        user_blocking = False
    elif status == "PASS":
        fixed_point = {
            "schema_version": "broker-internal-fixed-point/1.0",
            "status": "CLOSED",
            "stage": "pass",
            "stage_ordinal": INTERNAL_STAGE_ORDINAL["PASS"],
            "passed_checkpoint_count": sum(
                1 for item in checkpoints if item.get("status") == "PASS"
            ),
            "remaining_task_count": 0,
            "progress_score": INTERNAL_STAGE_ORDINAL["PASS"] * 10000,
            "progress_sha256": sha256_bytes(canonical_bytes({
                "cache_key": cache_key, "status": "PASS",
            })),
            "task_set_sha256": sha256_bytes(canonical_bytes([])),
            "unchanged_retry_count": 0,
            "unchanged_retry_limit": model_host_boundary()["stall_attempt_limit"],
            "monotonic_from_prior": True,
            "checkpoint_reuse_required": True,
            "terminal_reasons": [],
        }
    else:
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
        "attempts": attempts or {
            "vision_response_sha256": [],
            "vision_attempt_count": 0,
            "vision_attempt_limit": VISION_ATTEMPT_LIMIT,
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
    prior_attempt_count = (
        prior_state.get("attempts", {}).get(
            "vision_attempt_count",
            len(prior_attempts),
        )
        if prior_state.get("cache_key") == cache_key
        else 0
    )
    attempts = {
        "vision_response_sha256": list(dict.fromkeys(prior_attempts)),
        "vision_attempt_count": prior_attempt_count,
        "vision_attempt_limit": VISION_ATTEMPT_LIMIT,
    }
    key = cache_key[:16]

    extraction_root = output_root / f"extract-{key}"
    bundle_path = extraction_root / "broker-extraction-bundle.json"
    extract_receipt = output_root / f"extract-{key}.receipt.json"
    extract_input = sha256_bytes(canonical_bytes({"request": request_digest, "sources": sources, "runtime": runtime_digest}))
    extract_reused = reusable(bundle_path, extract_receipt, extract_input)
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
    active_bundle_path = bundle_path
    active_bundle = bundle
    if bundle.get("gate_status") == "NEEDS_VISION":
        tasks = vision_tasks(bundle, responses)
        if not responses or any(task.get("missing_passes") for task in tasks):
            checkpoint(checkpoints, stage="vision", status="NEEDS_WORK", input_digest=sha256_file(bundle_path), output=None, reused=False)
            write_state(
                state_path, run_id=run_id, status="NEEDS_VISION", request_digest=request_digest,
                sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
                checkpoints=checkpoints, artifacts=artifacts, tasks=tasks,
                summary={"unresolved_surface_count": len(tasks)},
                blocker_class="INTERNAL_WORK", attempts=attempts,
            )
            return 2
        responses_digest = sha256_bytes(canonical_bytes({
            target.name: sha256_file(target)
            for target in sorted(responses.glob("*.json"))
            if target.is_file()
        }))
        attempt_exhausted = record_vision_attempt(attempts, responses_digest)
        verified_path = output_root / f"verified-{key}-{responses_digest[:12]}.json"
        vision_receipt = output_root / f"verified-{key}-{responses_digest[:12]}.receipt.json"
        vision_input = sha256_bytes(canonical_bytes({
            "bundle": sha256_file(bundle_path), "responses": responses_digest, "runtime": runtime_digest,
        }))
        vision_reused = reusable(verified_path, vision_receipt, vision_input)
        if not vision_reused:
            run([sys.executable, str(HERE / "compile_broker_vision.py"), str(bundle_path), "--responses", str(responses), "--out", str(verified_path)], {0, 2})
            seal_checkpoint(verified_path, vision_receipt, vision_input)
        active_bundle_path = verified_path
        active_bundle = read_json(verified_path, "verified broker bundle")
        artifacts["verified_bundle"] = str(verified_path)
        checkpoint(checkpoints, stage="vision", status="PASS" if active_bundle.get("gate_status") == "PASS" else "NEEDS_WORK", input_digest=vision_input, output=verified_path, reused=vision_reused)
        if active_bundle.get("gate_status") == "NEEDS_RESOLUTION":
            tasks = resolution_tasks(active_bundle)
            write_state(
                state_path, run_id=run_id, status="NEEDS_RESOLUTION", request_digest=request_digest,
                sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
                checkpoints=checkpoints, artifacts=artifacts, tasks=tasks,
                summary={"targeted_conflict_count": sum(len(task.get("conflicts", [])) for task in tasks)},
                blocker_class="INTERNAL_WORK", attempts=attempts,
            )
            return 2
        if active_bundle.get("gate_status") != "PASS":
            tasks = vision_tasks(active_bundle, responses)
            for task in tasks:
                task["missing_passes"] = [1, 2]
                task["instruction"] = (
                    "Replace both pass files for this surface with a new independent read. "
                    "Preserve the visible grid or explicitly classify the surface as verified_non_tabular."
                )
            exhausted = attempt_exhausted
            if exhausted:
                tasks = [{
                    "task_kind": "bounded_capture_adjudication",
                    "document_id": task.get("document_id"),
                    "surface_id": task.get("surface_id"),
                    "prior_task": task,
                    "instruction": (
                        "The bounded full-surface reads are exhausted. Adjudicate only the remaining physical "
                        "regions/cells, or certify verified_non_tabular where independently supported. This is "
                        "internal work and is not a request for replacement readable research."
                    ),
                } for task in tasks]
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
                },
                blocker_class="INTERNAL_WORK", attempts=attempts,
            )
            return 2

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
        canonical_reused = reusable(canonical_path, canonical_receipt, canonical_input)
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
    if physical_status == "NEEDS_VISION":
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
            attempt_exhausted = record_vision_attempt(attempts, responses_digest)
            reconciled_path = output_root / f"reconciled-{key}-{responses_digest[:12]}.json"
            reconciled_receipt = output_root / f"reconciled-{key}-{responses_digest[:12]}.receipt.json"
            reconciled_input = sha256_bytes(canonical_bytes({
                "bundle": sha256_file(active_bundle_path),
                "responses": responses_digest,
                "runtime": runtime_digest,
            }))
            reconciled_reused = reusable(
                reconciled_path, reconciled_receipt, reconciled_input
            )
            if not reconciled_reused:
                run([
                    sys.executable,
                    str(HERE / "compile_broker_vision.py"),
                    str(active_bundle_path),
                    "--responses",
                    str(responses),
                    "--out",
                    str(reconciled_path),
                ], {0, 2})
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
            if physical_status != "PASS" and attempt_exhausted:
                physical_status = "NEEDS_RESOLUTION"

    if physical_status in {"NEEDS_VISION", "NEEDS_RESOLUTION"}:
        tasks = (
            vision_tasks(active_bundle, responses)
            if physical_status == "NEEDS_VISION"
            else resolution_tasks(active_bundle)
        )
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
            },
            blocker_class="INTERNAL_WORK",
            attempts=attempts,
        )
        return 2
    if physical_status != "PASS":
        raise RuntimeError(
            f"Canonical physical reconciliation returned invalid status {physical_status!r}."
        )

    crosswalk = Path(args.crosswalk).resolve() if args.crosswalk else None
    if not crosswalk or not crosswalk.is_file():
        checkpoint(checkpoints, stage="semantic_crosswalk", status="NEEDS_WORK", input_digest=sha256_file(active_bundle_path), output=None, reused=False)
        write_state(
            state_path, run_id=run_id, status="NEEDS_CROSSWALK", request_digest=request_digest,
            sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
            checkpoints=checkpoints, artifacts=artifacts,
            tasks=[{
                "task_kind": "semantic_crosswalk_review",
                "verified_bundle": str(active_bundle_path),
                "candidate_manifest_sha256": sha256_bytes(canonical_bytes(active_bundle.get("candidate_manifest"))),
                "instruction": "Review every analytical table and disposition every annual and partial-period candidate. Map broadly, consume narrowly, and never map a quarantined cell.",
            }],
            summary={"candidate_count": len(active_bundle.get("candidate_manifest", {}).get("candidates", []))},
            blocker_class="INTERNAL_WORK", attempts=attempts,
        )
        return 2

    crosswalk_digest = sha256_file(crosswalk)
    artifacts["crosswalk"] = str(crosswalk)
    semantic_path = output_root / f"semantic-{key}-{crosswalk_digest[:12]}.json"
    semantic_input = sha256_bytes(canonical_bytes({
        "bundle": sha256_file(active_bundle_path), "crosswalk": crosswalk_digest, "runtime": runtime_digest,
    }))
    semantic_receipt = output_root / f"semantic-{key}-{crosswalk_digest[:12]}.receipt.json"
    semantic_reused = reusable(semantic_path, semantic_receipt, semantic_input)
    if not semantic_reused:
        run([sys.executable, str(HERE / "verify_broker_semantics.py"), str(active_bundle_path), str(crosswalk), "--out", str(semantic_path)], {0, 1})
        seal_checkpoint(semantic_path, semantic_receipt, semantic_input)
    semantic = read_json(semantic_path, "broker semantic report")
    artifacts["semantic_report"] = str(semantic_path)
    checkpoint(checkpoints, stage="semantic_verification", status="PASS" if semantic.get("status") == "PASS" else "NEEDS_WORK", input_digest=semantic_input, output=semantic_path, reused=semantic_reused)
    if semantic.get("status") != "PASS":
        write_state(
            state_path, run_id=run_id, status="NEEDS_CROSSWALK_REVIEW", request_digest=request_digest,
            sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
            checkpoints=checkpoints, artifacts=artifacts,
            tasks=[{
                "task_kind": "semantic_crosswalk_repair",
                "crosswalk": str(crosswalk),
                "semantic_report": str(semantic_path),
                "findings": semantic.get("findings", []),
                "instruction": "Repair the crosswalk declarations only. Do not alter source evidence, schemas, dictionaries or validators.",
            }],
            summary={"total_violation_count": semantic.get("total_violation_count")},
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
        "continuation_status": (
            "PRIMARY_AUTHORITY_AVAILABLE"
            if eligibility.get("run_can_continue_without_broker_question")
            else "DEFER_TO_FORECAST_WATERFALL"
        ),
    }
    write_state(
        state_path, run_id=run_id, status="PASS", request_digest=request_digest,
        sources=sources, runtime_digest=runtime_digest, cache_key=cache_key,
        checkpoints=checkpoints, artifacts=artifacts, tasks=[], summary=summary,
        blocker_class=None, attempts=attempts,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
