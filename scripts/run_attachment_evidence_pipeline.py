#!/usr/bin/env python3
"""Run filings, broker and DCS evidence as one resumable production transaction.

The component controllers remain the only owners of their respective evidence
lanes.  This controller aggregates their typed states, materialises a resolved
attachment-ingress spec only after every declared lane passes, and invokes the
immutable ingress compiler once.  Internal preparation work never becomes a
request for the user to re-upload unchanged evidence.
"""

from __future__ import annotations

import argparse
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
RUNTIME_MANIFEST = ROOT / "assets" / "attachment-evidence-runtime-members.json"
USER_BLOCKERS = {"USER_EVIDENCE", "USER_DECISION", "FATAL_SOURCE"}


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def sha256_file(target: Path) -> str:
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_value(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def read_json(target: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(target.read_text("utf-8"))
    except Exception as error:
        raise ValueError(f"{label} is not readable JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def atomic_json(target: Path, value: Any) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(canonical_bytes(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def resolve(base: Path, value: str | None) -> Path | None:
    if not value:
        return None
    target = Path(value)
    return target.resolve() if target.is_absolute() else (base / target).resolve()


def runtime_closure() -> str:
    manifest = read_json(RUNTIME_MANIFEST, "attachment evidence runtime manifest")
    members = manifest.get("members")
    if (
        manifest.get("schema_version") != "attachment-evidence-runtime-members/1.0"
        or not isinstance(members, list)
        or not members
        or len(members) != len(set(members))
    ):
        raise ValueError("Attachment evidence runtime manifest is malformed")
    hashes: dict[str, str] = {}
    for relative in members:
        if not isinstance(relative, str) or relative.startswith("/") or ".." in Path(relative).parts:
            raise ValueError(f"Invalid attachment evidence runtime member: {relative!r}")
        target = ROOT / relative
        if not target.is_file():
            raise FileNotFoundError(f"Attachment evidence runtime member is absent: {relative}")
        hashes[relative] = sha256_file(target)
    nested_manifests = manifest.get("runtime_manifests", [])
    if not isinstance(nested_manifests, list) or len(nested_manifests) != len(set(nested_manifests)):
        raise ValueError("Attachment evidence nested runtime manifest list is malformed")
    for manifest_relative in nested_manifests:
        if (
            not isinstance(manifest_relative, str)
            or manifest_relative.startswith("/")
            or ".." in Path(manifest_relative).parts
        ):
            raise ValueError(f"Invalid nested runtime manifest: {manifest_relative!r}")
        nested_path = ROOT / manifest_relative
        nested = read_json(nested_path, f"nested runtime manifest {manifest_relative}")
        nested_members = nested.get("members")
        if not isinstance(nested_members, list) or not nested_members:
            raise ValueError(f"Nested runtime manifest {manifest_relative} has no members")
        hashes[manifest_relative] = sha256_file(nested_path)
        for relative in nested_members:
            if not isinstance(relative, str) or relative.startswith("/") or ".." in Path(relative).parts:
                raise ValueError(f"Invalid nested runtime member: {relative!r}")
            target = ROOT / relative
            if not target.is_file():
                raise FileNotFoundError(f"Nested runtime member is absent: {relative}")
            hashes[relative] = sha256_file(target)
    return sha256_value(hashes)


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=HERE,
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def lane_command(kind: str, declaration: dict[str, Any], base: Path, output_root: Path) -> list[str]:
    request = resolve(base, declaration.get("request_path"))
    if kind == "filings":
        command = [
            "node",
            str(HERE / "run_filings_pipeline.mjs"),
            str(request),
            "--out",
            str(output_root / kind),
        ]
        response = resolve(base, declaration.get("responses_path"))
        if response is not None:
            command.extend(["--responses", str(response)])
        return command
    command = [
        sys.executable,
        str(HERE / ("run_broker_pipeline.py" if kind == "broker" else "run_dcs_pipeline.py")),
        str(request),
        "--out",
        str(output_root / kind),
    ]
    for field, option in (("responses_path", "--responses"), ("crosswalk_path", "--crosswalk")):
        target = resolve(base, declaration.get(field))
        if target is not None and (kind == "broker" or field != "responses_path"):
            command.extend([option, str(target)])
    return command


def run_lane(kind: str, declaration: dict[str, Any], base: Path, output_root: Path) -> dict[str, Any]:
    state_path = output_root / kind / f"{kind}-run-state.json"
    command = lane_command(kind, declaration, base, output_root)
    request_path = Path(command[2])
    if not request_path.is_file():
        return {
            "schema_version": f"{kind}-run-state/1.0",
            "pipeline_status": "BLOCKED_INTERNAL",
            "user_blocking": False,
            "blocker_class": "INTERNAL_WORK",
            "tasks": [],
            "artifacts": {},
            "artifact_sha256": {},
            "summary": {"message": f"Internal {kind} request declaration is absent: {request_path}"},
        }
    state_before = None
    if state_path.is_file():
        try:
            state_before = state_path.read_bytes()
        except OSError:
            state_before = None
    completed = run(command)
    # A lane state is trusted only when THIS invocation stands behind it: the
    # controller exited cleanly (0 = closed, 2 = typed non-terminal state), or
    # it rewrote the state file during this run. A crash that left yesterday's
    # bytes untouched must fall through to the no-state classification below,
    # never resume a previous transaction's verdict.
    state_is_current = completed.returncode in {0, 2} or (
        state_path.is_file()
        and (state_before is None or state_path.read_bytes() != state_before)
    )
    if state_path.is_file() and state_is_current:
        try:
            state = read_json(state_path, f"{kind} run state")
            if not isinstance(state.get("user_blocking"), bool):
                raise ValueError(f"{kind} lane state omits a boolean user_blocking field")
            assert_state(
                kind,
                str(state.get("pipeline_status") or ""),
                state.get("blocker_class"),
                state.get("user_blocking") is True,
            )
        except (ValueError, OSError) as error:
            return {
                "schema_version": f"{kind}-run-state/1.0",
                "pipeline_status": "BLOCKED_INTERNAL",
                "user_blocking": False,
                "blocker_class": "INTERNAL_WORK",
                "tasks": [],
                "artifacts": {},
                "artifact_sha256": {},
                "summary": {
                    "terminal_reason": "invalid_lane_state",
                    "message": str(error),
                },
            }
        return state
    detail = (completed.stderr or completed.stdout).strip()[-4000:]
    # An absent/corrupt caller-supplied raw file is the one no-state failure
    # that genuinely belongs to the user.  Missing internal declarations and
    # controller defects stay internal so the host cannot turn them into a
    # spurious re-upload loop.
    source_failure = any(token in detail.lower() for token in (
        "source is absent", "source hash does not match",
    ))
    blocker = "FATAL_SOURCE" if source_failure else "INTERNAL_WORK"
    return {
        "schema_version": f"{kind}-run-state/1.0",
        "pipeline_status": "BLOCKED_INPUT" if source_failure else "BLOCKED_INTERNAL",
        "user_blocking": source_failure,
        "blocker_class": blocker,
        "tasks": [],
        "artifacts": {},
        "artifact_sha256": {},
        "summary": {"message": detail or f"{kind} controller exited without a state"},
    }


def ingress_lane_declarations(lanes: dict[str, dict[str, Any]], state_paths: dict[str, Path]) -> dict[str, Any]:
    declarations: dict[str, Any] = {}
    broker = lanes.get("broker")
    if broker:
        artifacts = broker.get("artifacts", {})
        extraction = artifacts.get("verified_bundle") or artifacts.get("extraction_bundle")
        declarations["broker_evidence"] = {
            "run_state_path": str(state_paths["broker"]),
            "extraction_bundle_path": extraction,
            "source_tables_path": artifacts.get("source_tables") or artifacts.get("broker_source_tables"),
            "crosswalk_path": artifacts.get("crosswalk"),
            "crosswalk_receipt_path": artifacts.get("broker_crosswalk_receipt"),
            "semantic_verification_path": artifacts.get("semantic_report") or artifacts.get("broker_semantic_verification"),
        }
    dcs = lanes.get("dcs")
    if dcs:
        artifacts = dcs.get("artifacts", {})
        declarations["dcs_evidence"] = {
            "run_state_path": str(state_paths["dcs"]),
            "source_tables_path": artifacts.get("source_tables"),
            "candidate_manifest_path": artifacts.get("candidate_manifest"),
            "crosswalk_path": artifacts.get("crosswalk"),
            "projection_path": artifacts.get("projection"),
            "evidence_receipt_path": artifacts.get("compiler_receipt"),
            "independent_verification_path": artifacts.get("independent_verification"),
        }
    for lane, declaration in declarations.items():
        missing = sorted(field for field, value in declaration.items() if not value)
        if missing:
            raise ValueError(f"PASS {lane} state omits owned artifacts: {', '.join(missing)}")
    return declarations


def apply_filings_lane(
    *,
    resolved_ingress: dict[str, Any],
    ingress_base: Path,
    filings_state: dict[str, Any],
    output_root: Path,
) -> tuple[dict[str, Any], dict[str, str]]:
    artifacts = filings_state.get("artifacts", {})
    bundle_path = Path(str(artifacts.get("filings_bundle") or ""))
    registry_path = Path(str(artifacts.get("document_extraction_registry") or ""))
    if not bundle_path.is_file() or not registry_path.is_file():
        raise ValueError("PASS filings lane omits its bundle or extraction registry")
    bundle = read_json(bundle_path, "filings evidence bundle")
    registry = read_json(registry_path, "document extraction registry")
    acquisition_registry_path = Path(str(artifacts.get("filings_source_registry") or ""))
    acquisition_registry = (
        read_json(acquisition_registry_path, "filings source registry")
        if acquisition_registry_path.is_file()
        else None
    )
    if acquisition_registry is not None:
        if acquisition_registry.get("schema_version") != "filings-source-registry/1.0":
            raise ValueError("Filings source registry has the wrong schema version")
        registry_body = {
            key: value for key, value in acquisition_registry.items()
            if key != "registry_sha256"
        }
        if acquisition_registry.get("registry_sha256") != sha256_value(registry_body):
            raise ValueError("Filings source registry hash does not bind its complete payload")
    if bundle.get("schema_version") != "filings-evidence-bundle/1.0":
        raise ValueError("Filings bundle has the wrong schema version")
    calculated_bundle_hash = sha256_value({
        key: value for key, value in bundle.items() if key != "bundle_sha256"
    })
    if bundle.get("bundle_sha256") != calculated_bundle_hash:
        raise ValueError("Filings bundle hash does not bind its complete payload")
    evidence_path = resolve(ingress_base, resolved_ingress.get("evidence_run_path"))
    if not evidence_path or not evidence_path.is_file():
        raise FileNotFoundError("Attachment-ingress template evidence_run_path is absent")
    evidence = read_json(evidence_path, "base evidence-run template")
    if evidence.get("mode") == "first_run" and "model_case" in evidence:
        raise ValueError("A first-run evidence template may not carry caller-authored model_case")
    evidence["filings"] = bundle.get("filings")
    evidence.setdefault("case_evidence", {})["face_statement_manifests"] = bundle.get("filings", {}).get(
        "face_statement_manifests", {}
    )
    evidence["case_source"] = {}
    evidence.pop("model_case", None)
    resolved_evidence_path = output_root / "resolved-evidence-template.json"
    atomic_json(resolved_evidence_path, evidence)
    resolved_ingress["evidence_run_path"] = str(resolved_evidence_path)
    registry_documents = registry.get("documents", {})
    used: set[str] = set()
    for descriptor in resolved_ingress.get("attachments", []):
        if descriptor.get("adapter", {}).get("domain") != "document_extraction":
            continue
        attachment_id = str(descriptor.get("attachment_id") or "")
        if acquisition_registry is not None:
            source_entry = acquisition_registry.get("documents", {}).get(attachment_id)
            if not isinstance(source_entry, dict):
                raise ValueError(f"Filings acquisition registry has no source for attachment {attachment_id}")
            acquired_path = Path(str(source_entry.get("path") or ""))
            if not acquired_path.is_file():
                raise ValueError(f"Acquired filing object is absent for attachment {attachment_id}")
            if sha256_file(acquired_path) != source_entry.get("raw_sha256"):
                raise ValueError(f"Acquired filing object hash does not match for attachment {attachment_id}")
            descriptor["path"] = str(acquired_path)
        registry_entry = registry_documents.get(attachment_id)
        extraction_path = Path(str((registry_entry or {}).get("path") or ""))
        if not extraction_path.is_file():
            raise ValueError(f"Filings lane has no extraction for attachment {attachment_id}")
        if sha256_file(extraction_path) != registry_entry.get("sha256"):
            raise ValueError(f"Filings extraction hash does not match for attachment {attachment_id}")
        descriptor["adapter"]["extraction_path"] = str(extraction_path)
        used.add(attachment_id)
    unused = sorted(set(registry_documents) - used)
    if unused:
        raise ValueError(f"Filings registry contains unbound attachment(s): {', '.join(unused)}")
    returned_artifacts = {
        "filings_bundle": str(bundle_path),
        "document_extraction_registry": str(registry_path),
        "resolved_evidence_template": str(resolved_evidence_path),
    }
    if acquisition_registry_path.is_file():
        returned_artifacts["filings_source_registry"] = str(acquisition_registry_path)
    return resolved_ingress, returned_artifacts


CLOSED_LANE_STATUSES = {"PASS", "PASS_DEGRADED"}


def classify(lanes: dict[str, dict[str, Any]]) -> tuple[str, str | None, bool]:
    # PASS_DEGRADED is a CLOSED broker lane: evidence preserved, irreconcilable
    # regions quarantined model_use=prohibited. The delivery constitution makes
    # broker uncertainty a degradation domain, never a delivery blocker.
    blockers = [
        state.get("blocker_class")
        for state in lanes.values()
        if state.get("pipeline_status") not in CLOSED_LANE_STATUSES
    ]
    if not blockers:
        return "PASS", None, False
    if any(blocker in USER_BLOCKERS for blocker in blockers):
        selected = next(blocker for blocker in blockers if blocker in USER_BLOCKERS)
        return "BLOCKED_INPUT", selected, True
    if any(state.get("pipeline_status") == "BLOCKED_INTERNAL" for state in lanes.values()):
        return "BLOCKED_INTERNAL", "INTERNAL_WORK", False
    return "NEEDS_INTERNAL_WORK", "INTERNAL_WORK", False


def task_frontier(
    lanes: dict[str, dict[str, Any]],
    *,
    status: str,
    transaction_hash: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Project one typed task frontier without leaking internal work as a user ask."""
    lane_progress = {
        kind: {
            "pipeline_status": state.get("pipeline_status"),
            "blocker_class": state.get("blocker_class"),
            "user_blocking": state.get("user_blocking"),
            "progress_sha256": state.get("fixed_point", {}).get("progress_sha256"),
            "fixed_point_status": state.get("fixed_point", {}).get("status"),
        }
        for kind, state in sorted(lanes.items())
    }
    progress_sha = sha256_value({
        "transaction": transaction_hash,
        "lane_progress": lane_progress,
    })
    if status == "PASS":
        return [], {
            "schema_version": "attachment-internal-fixed-point/1.0",
            "status": "CLOSED",
            "progress_sha256": progress_sha,
            "lane_progress": lane_progress,
            "remaining_task_count": 0,
            "aggregate_terminal_defect_count": 0,
        }
    if status == "BLOCKED_INPUT":
        tasks = [
            {"lane": kind, **task}
            for kind, state in lanes.items()
            if state.get("user_blocking") is True
            for task in state.get("tasks", [])
        ]
        return tasks, {
            "schema_version": "attachment-internal-fixed-point/1.0",
            "status": "USER_BOUNDARY",
            "progress_sha256": progress_sha,
            "lane_progress": lane_progress,
            "remaining_task_count": len(tasks),
            "aggregate_terminal_defect_count": 0,
        }

    internal_tasks = [
        {"lane": kind, **task}
        for kind, state in lanes.items()
        if state.get("user_blocking") is False
        for task in state.get("tasks", [])
    ]
    if status != "BLOCKED_INTERNAL":
        return internal_tasks, {
            "schema_version": "attachment-internal-fixed-point/1.0",
            "status": "OPEN",
            "progress_sha256": progress_sha,
            "lane_progress": lane_progress,
            "remaining_task_count": len(internal_tasks),
            "aggregate_terminal_defect_count": 0,
        }

    underlying = [
        {
            "lane": task.get("lane"),
            "task_id": task.get("task_id"),
            "task_kind": task.get("task_kind"),
            "terminal_reasons": task.get("terminal_reasons", []),
        }
        for task in internal_tasks
    ]
    task_input_sha = sha256_value({
        "transaction": transaction_hash,
        "underlying": underlying,
        "lane_progress": lane_progress,
    })
    aggregate = {
        "lane": "attachment",
        "task_kind": "internal_fixed_point_defect",
        "task_id": f"attachment-task-{task_input_sha[:24]}",
        "user_blocking": False,
        "underlying_lane_defects": underlying,
        "remedy": {
            "remedy_id": "repair_earliest_lane_or_response_boundary",
            "deterministic_steps": [
                "Inspect each hash-bound lane state named by this aggregate defect.",
                "Repair the earliest controller or model-host boundary that exhausted or regressed.",
                "Do not alter source evidence, schemas or validators to clear the defect.",
                "Resume the same attachment transaction and require unchanged checkpoints to be reused."
            ],
            "resume_protocol": {
                "controller": "scripts/run_attachment_evidence_pipeline.py",
                "same_transaction_required": True,
                "reuse_valid_checkpoints": True,
            },
        },
        "attempt_budget": {
            "attempts_used": 0,
            "attempt_limit": 1,
            "attempts_remaining": 1,
        },
        "progress_measure": {
            "progress_sha256": progress_sha,
            "task_input_sha256": task_input_sha,
            "lane_count": len(lanes),
            "underlying_defect_count": len(underlying),
        },
        "model_host_response_boundary": {
            "producer_kind": "controller_maintainer",
            "expected_response_files": [],
            "source_and_validator_mutation_forbidden": True,
            "python_may_not_author_visual_or_semantic_response": True,
        },
    }
    return [aggregate], {
        "schema_version": "attachment-internal-fixed-point/1.0",
        "status": "TERMINAL_DEFECT",
        "progress_sha256": progress_sha,
        "lane_progress": lane_progress,
        "remaining_task_count": 1,
        "aggregate_terminal_defect_count": 1,
    }


def write_state(
    target: Path, *, spec: dict[str, Any], spec_hash: str, runtime_hash: str,
    status: str, blocker: str | None, user_blocking: bool,
    lanes: dict[str, dict[str, Any]], checkpoints: list[dict[str, Any]],
    artifacts: dict[str, str], tasks: list[dict[str, Any]], summary: dict[str, Any],
) -> None:
    assert_state("attachment", status, blocker, user_blocking)
    transaction_hash = sha256_value({
        "spec": spec_hash,
        "runtime": runtime_hash,
        "lanes": {
            kind: state.get("cache_key") or state.get("source_sha256") or state.get("request_sha256")
            for kind, state in sorted(lanes.items())
        },
    })
    prior: dict[str, Any] = {}
    if target.is_file():
        try:
            prior = read_json(target, "prior attachment evidence run state")
        except ValueError:
            prior = {}
    assert_transition(
        "attachment",
        prior.get("pipeline_status"),
        status,
        reset=prior.get("workflow_transaction_sha256") != transaction_hash,
    )
    projected_tasks, fixed_point = task_frontier(
        lanes,
        status=status,
        transaction_hash=transaction_hash,
    )
    # The caller passes lane tasks for compatibility, but typed ownership and
    # aggregation are authoritative here. This prevents an internal lane packet
    # from appearing beside a genuine user-owned evidence request.
    tasks = projected_tasks
    value = {
        "schema_version": "attachment-evidence-run-state/1.0",
        "run_id": spec["run_id"],
        "pipeline_status": status,
        "user_blocking": user_blocking,
        "blocker_class": blocker,
        "controller_spec_sha256": spec_hash,
        "runtime_closure_sha256": runtime_hash,
        "workflow_transaction_sha256": transaction_hash,
        "lane_states": lanes,
        "checkpoints": checkpoints,
        "artifacts": artifacts,
        "artifact_sha256": {
            name: sha256_file(Path(path))
            for name, path in sorted(artifacts.items())
            if Path(path).is_file()
        },
        "tasks": tasks,
        "fixed_point": fixed_point,
        "summary": summary,
    }
    atomic_json(target, value)
    print(json.dumps({
        "status": status, "blocker_class": blocker, "user_blocking": user_blocking,
        "task_count": len(tasks), "state": str(target), **summary,
    }, sort_keys=True))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    spec_path = Path(args.spec).resolve()
    output_root = Path(args.out).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    state_path = output_root / "attachment-evidence-run-state.json"
    spec = read_json(spec_path, "attachment evidence controller spec")
    if spec.get("schema_version") != "attachment-evidence-controller/1.0":
        raise ValueError("Attachment evidence controller spec has the wrong schema version")
    if (
        not spec.get("run_id")
        or not spec.get("attachment_ingress_path")
        or not spec.get("case_source_declarations_path")
    ):
        raise ValueError(
            "Attachment evidence controller spec lacks run_id, attachment_ingress_path "
            "or case_source_declarations_path"
        )
    if not any(spec.get(lane) for lane in ("filings", "broker", "dcs")):
        raise ValueError("Attachment evidence controller spec declares no evidence lane")
    spec_hash = sha256_file(spec_path)
    runtime_hash = runtime_closure()
    lanes: dict[str, dict[str, Any]] = {}
    state_paths: dict[str, Path] = {}
    checkpoints: list[dict[str, Any]] = []
    for kind in ("filings", "broker", "dcs"):
        if not spec.get(kind):
            continue
        lanes[kind] = run_lane(kind, spec[kind], spec_path.parent, output_root)
        state_paths[kind] = output_root / kind / f"{kind}-run-state.json"
        checkpoints.append({
            "stage": kind,
            "status": lanes[kind].get("pipeline_status"),
            "state_sha256": sha256_file(state_paths[kind]) if state_paths[kind].is_file() else None,
        })
    status, blocker, user_blocking = classify(lanes)
    broker_lane = lanes.get("broker") or {}
    if broker_lane.get("pipeline_status") == "PASS_DEGRADED":
        broker_summary = broker_lane.get("summary") or {}
        degraded_receipt_raw = (broker_lane.get("artifacts") or {}).get(
            "degraded_close_receipt"
        )
        degraded_receipt_path = (
            Path(str(degraded_receipt_raw)) if degraded_receipt_raw else None
        )
        degraded_receipt_owned = bool(
            degraded_receipt_path
            and degraded_receipt_path.is_file()
            and (broker_lane.get("artifact_sha256") or {}).get(
                "degraded_close_receipt"
            ) == sha256_file(degraded_receipt_path)
        )
        quarantine_disclosed = bool(broker_summary.get("degraded")) and (
            "quarantined_conflict_count" in broker_summary
            or "quarantined_surface_count" in broker_summary
        ) and degraded_receipt_owned
        if not quarantine_disclosed:
            # A degraded close without its quarantine receipt is an invalid
            # artifact closure, not an acceptable lane.
            broker_lane["pipeline_status"] = "BLOCKED_INTERNAL"
            broker_lane["blocker_class"] = "INTERNAL_WORK"
            broker_lane["user_blocking"] = False
            broker_lane.setdefault("summary", {})["terminal_reason"] = (
                "degraded_close_missing_quarantine_receipt"
            )
            status, blocker, user_blocking = classify(lanes)
    tasks = [
        {"lane": kind, **task}
        for kind, state in lanes.items()
        for task in state.get("tasks", [])
    ]
    if status != "PASS":
        write_state(
            state_path, spec=spec, spec_hash=spec_hash, runtime_hash=runtime_hash,
            status=status, blocker=blocker, user_blocking=user_blocking,
            lanes=lanes, checkpoints=checkpoints, artifacts={}, tasks=tasks,
            summary={"lane_statuses": {kind: state.get("pipeline_status") for kind, state in lanes.items()}},
        )
        return 2

    try:
        base_ingress_path = resolve(spec_path.parent, spec["attachment_ingress_path"])
        if not base_ingress_path or not base_ingress_path.is_file():
            raise FileNotFoundError("The internal attachment-ingress template is absent")
        resolved_ingress = read_json(base_ingress_path, "attachment-ingress template")
        resolved_ingress.update(ingress_lane_declarations(lanes, state_paths))
        filings_artifacts: dict[str, str] = {}
        if "filings" in lanes:
            resolved_ingress, filings_artifacts = apply_filings_lane(
                resolved_ingress=resolved_ingress,
                ingress_base=base_ingress_path.parent,
                filings_state=lanes["filings"],
                output_root=output_root,
            )
        else:
            base_evidence_path = resolve(
                base_ingress_path.parent,
                resolved_ingress.get("evidence_run_path"),
            )
            base_evidence = read_json(base_evidence_path, "base evidence-run template") if base_evidence_path else {}
            if base_evidence.get("mode") == "first_run" and any(
                descriptor.get("adapter", {}).get("domain") == "document_extraction"
                for descriptor in resolved_ingress.get("attachments", [])
            ):
                raise ValueError(
                    "First-run raw filing attachments require the controller-owned filings lane"
                )
        resolved_path = output_root / "resolved-attachment-ingress.json"
        atomic_json(resolved_path, resolved_ingress)
        declarations_path = resolve(
            spec_path.parent,
            spec["case_source_declarations_path"],
        )
        if not declarations_path or not declarations_path.is_file():
            raise FileNotFoundError("The internal case-source declarations file is absent")
        compiled_root = output_root / "compiled-evidence"
        completed = run([
            "node", str(HERE / "compile_declared_evidence_run.mjs"), str(resolved_path),
            "--declarations", str(declarations_path), "--out", str(compiled_root),
        ])
        if completed.returncode != 0:
            raise RuntimeError((completed.stderr or completed.stdout).strip()[-4000:])
        artifacts = {
            "resolved_attachment_ingress": str(resolved_path),
            "case_source": str(compiled_root / "case-source.json"),
            "attachment_manifest": str(compiled_root / "attachment-manifest.json"),
            "evidence_run": str(compiled_root / "evidence-run.json"),
            "validation": str(compiled_root / "validation.json"),
            **filings_artifacts,
        }
        checkpoints.append({
            "stage": "case_source_proposal",
            "status": "PASS",
            "state_sha256": sha256_file(Path(artifacts["case_source"])),
        })
        checkpoints.append({
            "stage": "attachment_ingress",
            "status": "PASS",
            "state_sha256": sha256_file(Path(artifacts["evidence_run"])),
        })
        write_state(
            state_path, spec=spec, spec_hash=spec_hash, runtime_hash=runtime_hash,
            status="PASS", blocker=None, user_blocking=False, lanes=lanes,
            checkpoints=checkpoints, artifacts=artifacts, tasks=[],
            summary={
                "lane_statuses": {
                    kind: state.get("pipeline_status") for kind, state in lanes.items()
                },
                "degraded_lanes": sorted(
                    kind for kind, state in lanes.items()
                    if state.get("pipeline_status") == "PASS_DEGRADED"
                ),
                "evidence_run_sha256": sha256_file(Path(artifacts["evidence_run"])),
            },
        )
        return 0
    except Exception as error:
        write_state(
            state_path, spec=spec, spec_hash=spec_hash, runtime_hash=runtime_hash,
            status="BLOCKED_INTERNAL", blocker="INTERNAL_WORK", user_blocking=False,
            lanes=lanes, checkpoints=checkpoints, artifacts={}, tasks=[],
            summary={"terminal_reason": "attachment_ingress_failed", "message": str(error)},
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
