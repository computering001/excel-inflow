#!/usr/bin/env python3
"""Run and resume the complete lossless DCS evidence transaction."""

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
RUNTIME_MANIFEST = ROOT / "assets" / "dcs-runtime-members.json"

# A non-PASS extraction receipt is not automatically evidence that the user's
# source is defective.  The extractor is an internal adapter, and new layouts
# or violated receipt invariants belong to INTERNAL_WORK.  Only findings that
# prove the source contains no usable evidence may cross the user boundary.
FATAL_EXTRACT_VIOLATION_CODES = frozenset({
    "DCS-EXTRACT-EMPTY",
})


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
        value = json.loads(path.read_text("utf-8"))
    except Exception as error:
        raise ValueError(f"{label} is not readable JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def classify_extract_receipt(report: dict[str, Any]) -> tuple[str, bool, str]:
    """Return workflow status, user-blocking flag and blocker owner.

    Unknown or mixed violation codes fail toward internal ownership.  This is
    deliberate: an adapter that cannot explain why it failed has not proved
    that replacing an otherwise readable export would help.
    """
    violations = report.get("violations")
    codes = {
        str(item.get("code") or "")
        for item in violations if isinstance(item, dict)
    } if isinstance(violations, list) else set()
    fatal = bool(codes) and codes.issubset(FATAL_EXTRACT_VIOLATION_CODES)
    if fatal:
        return "BLOCKED_INPUT", True, "FATAL_SOURCE"
    return "BLOCKED_INTERNAL", False, "INTERNAL_WORK"


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(canonical_bytes(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def runtime_closure() -> str:
    manifest = read_json(RUNTIME_MANIFEST, "DCS runtime-members manifest")
    if manifest.get("schema_version") != "dcs-runtime-members/1.0":
        raise ValueError("DCS runtime-members manifest has the wrong schema version")
    members = manifest.get("members")
    if not isinstance(members, list) or not members or len(members) != len(set(members)):
        raise ValueError("DCS runtime-members manifest must contain one non-empty unique list")
    hashes: dict[str, str] = {}
    for relative in members:
        if not isinstance(relative, str) or relative.startswith("/") or ".." in Path(relative).parts:
            raise ValueError(f"Invalid DCS runtime member: {relative!r}")
        target = ROOT / relative
        if not target.is_file():
            raise FileNotFoundError(f"DCS runtime member is absent: {relative}")
        hashes[relative] = sha256_file(target)
    return sha256_bytes(canonical_bytes(hashes))


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


def reusable(output: Path, receipt: Path, input_digest: str) -> bool:
    if not output.is_file() or not receipt.is_file():
        return False
    try:
        value = read_json(receipt, "DCS checkpoint receipt")
    except ValueError:
        return False
    return value.get("input_sha256") == input_digest and value.get("output_sha256") == sha256_file(output)


def seal(output: Path, receipt: Path, input_digest: str) -> None:
    atomic_json(receipt, {
        "schema_version": "dcs-pipeline-checkpoint/1.0",
        "input_sha256": input_digest,
        "output_sha256": sha256_file(output),
    })


def add_checkpoint(
    checkpoints: list[dict[str, Any]], stage: str, status: str,
    input_digest: str, output: Path | None, reused: bool,
) -> None:
    checkpoints.append({
        "stage": stage,
        "status": status,
        "input_sha256": input_digest,
        "output_sha256": sha256_file(output) if output and output.is_file() else None,
        "reused": reused,
    })


def write_state(
    path: Path, *, run_id: str, status: str, user_blocking: bool,
    blocker_class: str | None, request_digest: str, source_digest: str,
    runtime_digest: str, cache_key: str, checkpoints: list[dict[str, Any]],
    artifacts: dict[str, str], tasks: list[dict[str, Any]], summary: dict[str, Any],
) -> None:
    assert_state("dcs", status, blocker_class, user_blocking)
    prior: dict[str, Any] = {}
    if path.is_file():
        try:
            prior = read_json(path, "prior DCS run state")
        except ValueError:
            prior = {}
    assert_transition(
        "dcs",
        prior.get("pipeline_status"),
        status,
        reset=prior.get("cache_key") != cache_key,
    )
    value = {
        "schema_version": "dcs-run-state/1.0",
        "run_id": run_id,
        "pipeline_status": status,
        "user_blocking": user_blocking,
        "blocker_class": blocker_class,
        "request_sha256": request_digest,
        "source_sha256": source_digest,
        "runtime_closure_sha256": runtime_digest,
        "cache_key": cache_key,
        "checkpoints": checkpoints,
        "artifacts": artifacts,
        "artifact_sha256": {
            name: sha256_file(Path(target))
            for name, target in sorted(artifacts.items())
            if Path(target).is_file()
        },
        "tasks": tasks,
        "summary": summary,
    }
    atomic_json(path, value)
    print(json.dumps({
        "status": status,
        "user_blocking": user_blocking,
        "blocker_class": blocker_class,
        "task_count": len(tasks),
        **summary,
        "state": str(path),
    }, sort_keys=True))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request")
    parser.add_argument("--out", required=True)
    parser.add_argument("--crosswalk")
    args = parser.parse_args()

    request_path = Path(args.request).resolve()
    output_root = Path(args.out).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    state_path = output_root / "dcs-run-state.json"
    request = read_json(request_path, "DCS extraction request")
    if request.get("schema_version") != "dcs-extraction-request/1.0":
        raise ValueError("DCS extraction request has the wrong schema version")
    request_digest = sha256_file(request_path)
    runtime_digest = runtime_closure()
    source = Path(str(request.get("source_path") or ""))
    if not source.is_absolute():
        source = (request_path.parent / source).resolve()
    source_digest = sha256_file(source) if source.is_file() else "0" * 64
    cache_key = sha256_bytes(canonical_bytes({
        "request": request_digest,
        "source": source_digest,
        "runtime": runtime_digest,
    }))
    run_id = str(request.get("run_id") or f"dcs-{cache_key[:12]}")
    if not source.is_file() or (
        request.get("expected_sha256")
        and request["expected_sha256"] != source_digest
    ):
        message = (
            f"DCS source is absent: {source}"
            if not source.is_file()
            else "DCS source hash does not match expected_sha256"
        )
        write_state(
            state_path, run_id=run_id, status="BLOCKED_INPUT", user_blocking=True,
            blocker_class="FATAL_SOURCE", request_digest=request_digest,
            source_digest=source_digest, runtime_digest=runtime_digest,
            cache_key=cache_key, checkpoints=[], artifacts={}, tasks=[],
            summary={"terminal_reason": "fatal_source", "message": message},
        )
        return 2
    key = cache_key[:16]
    checkpoints: list[dict[str, Any]] = []
    artifacts: dict[str, str] = {}

    extract_root = output_root / f"extract-{key}"
    source_tables = extract_root / "dcs-source-tables.json"
    candidate_manifest = extract_root / "dcs-candidate-manifest.json"
    extraction_receipt = extract_root / "dcs-extraction-receipt.json"
    checkpoint_receipt = output_root / f"extract-{key}.receipt.json"
    extract_input = sha256_bytes(canonical_bytes({
        "request": request_digest,
        "source": source_digest,
        "runtime": runtime_digest,
    }))
    extract_reused = all(path.is_file() for path in (source_tables, candidate_manifest, extraction_receipt)) and reusable(
        source_tables, checkpoint_receipt, extract_input
    )
    if not extract_reused:
        # rc 1 is a CRASH class (corrupt zip, malformed JSON, unsupported
        # extension) that must reach the source-fault classifier below rather
        # than raising with no typed state; rc 2 WITH a complete receipt is a
        # typed refusal that must reach classify_extract_receipt, not the
        # crash heuristics.
        completed = run([
            sys.executable, str(HERE / "extract_dcs_evidence.py"),
            str(request_path), "--out", str(extract_root),
        ], {0, 1, 2})
        if (
            not all(path.is_file() for path in (source_tables, candidate_manifest, extraction_receipt))
            or completed.returncode not in {0, 2}
        ):
            detail = (completed.stderr or completed.stdout).strip()[-4000:]
            source_fault = (
                source.stat().st_size == 0
                or source.suffix.lower() not in {".csv", ".xlsx", ".xlsm", ".json"}
                or any(token in detail.lower() for token in (
                    "file is not a zip file",
                    "supported dcs source types",
                    "not a valid json",
                    "jsondecodeerror",
                ))
            )
            write_state(
                state_path, run_id=run_id,
                status="BLOCKED_INPUT" if source_fault else "BLOCKED_INTERNAL",
                user_blocking=source_fault,
                blocker_class="FATAL_SOURCE" if source_fault else "INTERNAL_WORK",
                request_digest=request_digest,
                source_digest=source_digest, runtime_digest=runtime_digest,
                cache_key=cache_key, checkpoints=checkpoints, artifacts=artifacts,
                tasks=[], summary={
                    "terminal_reason": (
                        "fatal_source" if source_fault else "dcs_extractor_requires_internal_repair"
                    ),
                    "message": detail,
                },
            )
            return 2
        seal(source_tables, checkpoint_receipt, extract_input)
    extract_report = read_json(extraction_receipt, "DCS extraction receipt")
    artifacts.update({
        "source_tables": str(source_tables),
        "candidate_manifest": str(candidate_manifest),
        "extraction_receipt": str(extraction_receipt),
    })
    add_checkpoint(
        checkpoints, "extract", "PASS" if extract_report.get("status") == "PASS" else "BLOCKED",
        extract_input, source_tables, extract_reused,
    )
    if extract_report.get("status") != "PASS":
        extract_status, extract_user_blocking, extract_owner = classify_extract_receipt(
            extract_report
        )
        write_state(
            state_path, run_id=run_id, status=extract_status,
            user_blocking=extract_user_blocking,
            blocker_class=extract_owner, request_digest=request_digest,
            source_digest=source_digest, runtime_digest=runtime_digest,
            cache_key=cache_key, checkpoints=checkpoints, artifacts=artifacts,
            tasks=[] if extract_user_blocking else [{
                "task_kind": "dcs_extractor_repair",
                "violations": extract_report.get("violations", []),
                "instruction": (
                    "Repair the lossless DCS adapter against these exact source bytes; "
                    "do not ask the user to replace an unchanged readable export."
                ),
            }],
            summary={
                "terminal_reason": (
                    "fatal_source" if extract_user_blocking
                    else "dcs_extractor_requires_internal_repair"
                ),
                "violations": extract_report.get("violations", []),
            },
        )
        return 2

    crosswalk = Path(args.crosswalk).resolve() if args.crosswalk else None
    if not crosswalk or not crosswalk.is_file():
        if not request.get("adapter_metadata"):
            write_state(
                state_path, run_id=run_id, status="BLOCKED_INPUT", user_blocking=True,
                blocker_class="USER_EVIDENCE", request_digest=request_digest,
                source_digest=source_digest, runtime_digest=runtime_digest,
                cache_key=cache_key, checkpoints=checkpoints, artifacts=artifacts,
                tasks=[{
                    "task_kind": "dcs_adapter_metadata",
                    "required_fields": ["as_of", "entity_name", "reporting_currency", "units"],
                    "instruction": "Provide the export basis once; the controller will author and verify the cell-level crosswalk internally.",
                }],
                summary={"terminal_reason": "missing_export_basis"},
            )
            return 2
        proposed = output_root / f"proposed-crosswalk-{key}.json"
        proposal_receipt = output_root / f"proposed-crosswalk-{key}.receipt.json"
        proposal_input = sha256_bytes(canonical_bytes({
            "source_tables": sha256_file(source_tables),
            "candidate_manifest": sha256_file(candidate_manifest),
            "adapter_metadata": request.get("adapter_metadata"),
            "runtime": runtime_digest,
        }))
        proposal_reused = reusable(proposed, proposal_receipt, proposal_input)
        if not proposal_reused:
            completed = run([
                sys.executable, str(HERE / "propose_dcs_crosswalk.py"),
                str(source_tables), str(candidate_manifest),
                "--metadata", str(request_path), "--out", str(proposed),
            ], {0, 2})
            if not proposed.is_file():
                raise RuntimeError("DCS adapter did not emit a crosswalk proposal")
            proposal_status_path = proposed.with_name("dcs-crosswalk-proposal-receipt.json")
            proposal = read_json(proposal_status_path, "DCS proposal receipt")
            artifacts["crosswalk_proposal_receipt"] = str(proposal_status_path)
            if completed.returncode != 0:
                unresolved = proposal.get("unresolved", [])
                status = "BLOCKED_INPUT" if unresolved else "BLOCKED_INTERNAL"
                blocker_class = "USER_EVIDENCE" if unresolved else "INTERNAL_WORK"
                write_state(
                    state_path, run_id=run_id, status=status,
                    user_blocking=bool(unresolved), blocker_class=blocker_class,
                    request_digest=request_digest, source_digest=source_digest,
                    runtime_digest=runtime_digest, cache_key=cache_key,
                    checkpoints=checkpoints, artifacts=artifacts,
                    tasks=[{
                        "task_kind": "dcs_required_term_evidence" if unresolved else "dcs_adapter_repair",
                        "unresolved": unresolved,
                        "instruction": "Supply only the named missing factual terms; no debt row or captured cell was discarded."
                            if unresolved else "Repair the structured-header adapter internally.",
                    }],
                    summary={"terminal_reason": "unresolved_required_terms" if unresolved else "unrecognized_dcs_layout"},
                )
                return 2
            # Seal ONLY a successful proposal. Sealing before the status check
            # made a failed proposal reusable: every resume skipped the failure
            # branch and fed the incomplete crosswalk to the compiler.
            seal(proposed, proposal_receipt, proposal_input)
        add_checkpoint(checkpoints, "crosswalk_proposal", "PASS", proposal_input, proposed, proposal_reused)
        crosswalk = proposed

    crosswalk_digest = sha256_file(crosswalk)
    artifacts["crosswalk"] = str(crosswalk)
    compiled_root = output_root / f"compiled-{key}-{crosswalk_digest[:12]}"
    projection = compiled_root / "dcs-projection.json"
    compiler_receipt = compiled_root / "dcs-evidence-receipt.json"
    dcs_export = compiled_root / "dcs-export.json"
    compile_checkpoint = output_root / f"compiled-{key}-{crosswalk_digest[:12]}.receipt.json"
    compile_input = sha256_bytes(canonical_bytes({
        "source_tables": sha256_file(source_tables),
        "candidate_manifest": sha256_file(candidate_manifest),
        "crosswalk": crosswalk_digest,
        "runtime": runtime_digest,
    }))
    compile_reused = projection.is_file() and compiler_receipt.is_file() and reusable(
        projection, compile_checkpoint, compile_input
    )
    if not compile_reused:
        run([
            sys.executable, str(HERE / "compile_dcs_evidence.py"),
            str(source_tables), str(candidate_manifest), str(crosswalk),
            "--out", str(compiled_root),
        ], {0, 2})
        if not projection.is_file() or not compiler_receipt.is_file():
            raise RuntimeError("DCS compiler did not write its projection and receipt")
        seal(projection, compile_checkpoint, compile_input)
    compiler = read_json(compiler_receipt, "DCS compiler receipt")
    artifacts.update({
        "projection": str(projection),
        "compiler_receipt": str(compiler_receipt),
    })
    if dcs_export.is_file():
        artifacts["dcs_export"] = str(dcs_export)
    add_checkpoint(
        checkpoints, "compile", "PASS" if compiler.get("status") == "PASS" else "NEEDS_WORK",
        compile_input, projection, compile_reused,
    )
    if compiler.get("status") != "PASS":
        write_state(
            state_path, run_id=run_id, status="NEEDS_CROSSWALK_REVIEW", user_blocking=False,
            blocker_class="INTERNAL_WORK", request_digest=request_digest,
            source_digest=source_digest, runtime_digest=runtime_digest,
            cache_key=cache_key, checkpoints=checkpoints, artifacts=artifacts,
            tasks=[{
                "task_kind": "dcs_crosswalk_repair",
                "crosswalk": str(crosswalk),
                "violations": compiler.get("violations", []),
                "instruction": "Repair the crosswalk declarations only; do not alter extracted source evidence or validators.",
            }],
            summary={"total_violation_count": compiler.get("counts", {}).get("violations")},
        )
        return 2

    oracle = output_root / f"oracle-{key}-{crosswalk_digest[:12]}.json"
    oracle_checkpoint = output_root / f"oracle-{key}-{crosswalk_digest[:12]}.receipt.json"
    oracle_input = sha256_bytes(canonical_bytes({
        "source_tables": sha256_file(source_tables),
        "candidate_manifest": sha256_file(candidate_manifest),
        "crosswalk": crosswalk_digest,
        "projection": sha256_file(projection),
        "compiler_receipt": sha256_file(compiler_receipt),
        "runtime": runtime_digest,
    }))
    oracle_reused = reusable(oracle, oracle_checkpoint, oracle_input)
    if not oracle_reused:
        run([
            sys.executable, str(HERE / "verify" / "dcs_evidence_oracle.py"),
            "--source", str(source_tables), "--manifest", str(candidate_manifest),
            "--crosswalk", str(crosswalk), "--projection", str(projection),
            "--receipt", str(compiler_receipt), "--out", str(oracle),
        ], {0, 2})
        if not oracle.is_file():
            raise RuntimeError("DCS independent oracle did not write its report")
        seal(oracle, oracle_checkpoint, oracle_input)
    independent = read_json(oracle, "DCS independent verification")
    artifacts["independent_verification"] = str(oracle)
    add_checkpoint(
        checkpoints, "independent_oracle",
        "PASS" if independent.get("status") == "PASS" else "BLOCKED",
        oracle_input, oracle, oracle_reused,
    )
    if independent.get("status") != "PASS":
        write_state(
            state_path, run_id=run_id, status="BLOCKED_INTERNAL", user_blocking=False,
            blocker_class="INTERNAL_WORK", request_digest=request_digest,
            source_digest=source_digest, runtime_digest=runtime_digest,
            cache_key=cache_key, checkpoints=checkpoints, artifacts=artifacts,
            tasks=[], summary={
                "terminal_reason": "independent_oracle_disagrees",
                "total_violation_count": independent.get("counts", {}).get("violations"),
                "violations": independent.get("violations", []),
            },
        )
        return 2

    projection_value = read_json(projection, "DCS projection")
    write_state(
        state_path, run_id=run_id, status="PASS", user_blocking=False,
        blocker_class=None, request_digest=request_digest,
        source_digest=source_digest, runtime_digest=runtime_digest,
        cache_key=cache_key, checkpoints=checkpoints, artifacts=artifacts,
        tasks=[], summary={
            "source_rows": compiler.get("counts", {}).get("source_rows", 0),
            "source_cells": compiler.get("counts", {}).get("source_cells", 0),
            "instrument_count": compiler.get("counts", {}).get("model_instruments", 0),
            "term_authority_count": len(projection_value.get("term_authorities", [])),
            "total_violation_count": 0,
        },
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
