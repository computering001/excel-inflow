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


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUNTIME_MANIFEST = ROOT / "assets" / "dcs-runtime-members.json"
BLOCKER_CLASSES = {"INTERNAL_WORK", "USER_EVIDENCE", "USER_DECISION", "FATAL_SOURCE"}


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
    if blocker_class not in {None, *BLOCKER_CLASSES}:
        raise ValueError(f"Unknown blocker class: {blocker_class}")
    if user_blocking != (blocker_class in {"USER_EVIDENCE", "USER_DECISION", "FATAL_SOURCE"}):
        raise ValueError("user_blocking disagrees with blocker ownership")
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
        completed = run([
            sys.executable, str(HERE / "extract_dcs_evidence.py"),
            str(request_path), "--out", str(extract_root),
        ], {0, 2})
        if completed.returncode != 0 or not all(path.is_file() for path in (source_tables, candidate_manifest, extraction_receipt)):
            write_state(
                state_path, run_id=run_id, status="BLOCKED_INPUT", user_blocking=True,
                blocker_class="FATAL_SOURCE", request_digest=request_digest,
                source_digest=source_digest, runtime_digest=runtime_digest,
                cache_key=cache_key, checkpoints=checkpoints, artifacts=artifacts,
                tasks=[], summary={"message": (completed.stderr or completed.stdout).strip()[-4000:]},
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
        write_state(
            state_path, run_id=run_id, status="BLOCKED_INPUT", user_blocking=True,
            blocker_class="FATAL_SOURCE", request_digest=request_digest,
            source_digest=source_digest, runtime_digest=runtime_digest,
            cache_key=cache_key, checkpoints=checkpoints, artifacts=artifacts,
            tasks=[], summary={"violations": extract_report.get("violations", [])},
        )
        return 2

    crosswalk = Path(args.crosswalk).resolve() if args.crosswalk else None
    if not crosswalk or not crosswalk.is_file():
        add_checkpoint(checkpoints, "crosswalk", "NEEDS_WORK", sha256_file(candidate_manifest), None, False)
        write_state(
            state_path, run_id=run_id, status="NEEDS_CROSSWALK", user_blocking=False,
            blocker_class="INTERNAL_WORK", request_digest=request_digest,
            source_digest=source_digest, runtime_digest=runtime_digest,
            cache_key=cache_key, checkpoints=checkpoints, artifacts=artifacts,
            tasks=[{
                "task_kind": "dcs_crosswalk_review",
                "source_tables": str(source_tables),
                "candidate_manifest": str(candidate_manifest),
                "instruction": (
                    "Disposition every captured row and cell exactly once; declare each model instrument, "
                    "field-level term authority, maturity precision and any reviewed supplement."
                ),
            }],
            summary={
                "source_rows": extract_report.get("counts", {}).get("rows", 0),
                "source_cells": extract_report.get("counts", {}).get("nonblank_cells", 0),
            },
        )
        return 2

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
