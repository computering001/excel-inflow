#!/usr/bin/env python3
"""Run broker and DCS evidence as one resumable production transaction.

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


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUNTIME_MANIFEST = ROOT / "assets" / "attachment-evidence-runtime-members.json"
BLOCKER_CLASSES = {"INTERNAL_WORK", "USER_EVIDENCE", "USER_DECISION", "FATAL_SOURCE"}
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
    completed = run(command)
    if state_path.is_file():
        return read_json(state_path, f"{kind} run state")
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


def classify(lanes: dict[str, dict[str, Any]]) -> tuple[str, str | None, bool]:
    blockers = [state.get("blocker_class") for state in lanes.values() if state.get("pipeline_status") != "PASS"]
    if not blockers:
        return "PASS", None, False
    if any(blocker in USER_BLOCKERS for blocker in blockers):
        selected = next(blocker for blocker in blockers if blocker in USER_BLOCKERS)
        return "BLOCKED_INPUT", selected, True
    if any(state.get("pipeline_status") == "BLOCKED_INTERNAL" for state in lanes.values()):
        return "BLOCKED_INTERNAL", "INTERNAL_WORK", False
    return "NEEDS_INTERNAL_WORK", "INTERNAL_WORK", False


def write_state(
    target: Path, *, spec: dict[str, Any], spec_hash: str, runtime_hash: str,
    status: str, blocker: str | None, user_blocking: bool,
    lanes: dict[str, dict[str, Any]], checkpoints: list[dict[str, Any]],
    artifacts: dict[str, str], tasks: list[dict[str, Any]], summary: dict[str, Any],
) -> None:
    if blocker not in {None, *BLOCKER_CLASSES} or user_blocking != (blocker in USER_BLOCKERS):
        raise ValueError("Attachment evidence blocker ownership is inconsistent")
    value = {
        "schema_version": "attachment-evidence-run-state/1.0",
        "run_id": spec["run_id"],
        "pipeline_status": status,
        "user_blocking": user_blocking,
        "blocker_class": blocker,
        "controller_spec_sha256": spec_hash,
        "runtime_closure_sha256": runtime_hash,
        "lane_states": lanes,
        "checkpoints": checkpoints,
        "artifacts": artifacts,
        "artifact_sha256": {
            name: sha256_file(Path(path))
            for name, path in sorted(artifacts.items())
            if Path(path).is_file()
        },
        "tasks": tasks,
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
    if not any(spec.get(lane) for lane in ("broker", "dcs")):
        raise ValueError("Attachment evidence controller spec declares no evidence lane")
    spec_hash = sha256_file(spec_path)
    runtime_hash = runtime_closure()
    lanes: dict[str, dict[str, Any]] = {}
    state_paths: dict[str, Path] = {}
    checkpoints: list[dict[str, Any]] = []
    for kind in ("broker", "dcs"):
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
                "lane_statuses": {kind: "PASS" for kind in lanes},
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
