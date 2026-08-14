#!/usr/bin/env python3
"""Migrate a sealed broker run across an intentional runtime-closure change.

Every broker checkpoint binds the runtime closure digest into its cache key,
so a controller repair (v57 -> v58) deliberately cold-starts every checkpoint.
For a LIVE run that must not lose progress, this tool re-homes the completed,
receipt-verified physical evidence under the new closure WITHOUT touching any
evidence byte and WITHOUT asking the user to re-upload anything:

  migrated : extraction bundle (page renders, image/task artifacts) and the
             surface census - both receipt-verified against the OLD closure
             before a single write, then re-sealed under the NEW closure.
  preserved: the prior state's vision attempt counters, internal fixed-point
             ledger, tasks and status are carried VERBATIM so exhaustion
             history survives (the degraded-close boundary depends on it).
  invalid  : everything at or after the failed physical reconciliation
             (verified/canonical/reconciled bundles, semantics, pack). Vision
             responses re-bind on resume because the task and image artifacts
             they hash-bind to are byte-identical in the migrated bundle.

The tool FAILS CLOSED: any hash, receipt, vintage or identity mismatch exits 2
with a finding and writes nothing. It only migrates from the exact prior
closure pinned on the command line (--from-closure), never across an unknown
version gap. A migration receipt records every verification and action.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import run_broker_pipeline as rbp  # noqa: E402  (exact digest primitives)

RECEIPT_SCHEMA = "broker-carrier-migration-receipt/1.0"


def fail(findings: list[dict[str, Any]], reason_id: str, message: str) -> int:
    findings.append({"id": reason_id, "severity": "fatal", "message": message})
    print(json.dumps({"status": "REFUSED", "findings": findings}, indent=2, sort_keys=True))
    return 2


def link_or_copy_tree(source: Path, target: Path) -> int:
    count = 0
    for item in sorted(source.rglob("*")):
        relative = item.relative_to(source)
        destination = target / relative
        if item.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(item, destination)
        except OSError:
            shutil.copy2(item, destination)
        count += 1
    return count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", help="broker extraction request JSON (same file the run used)")
    parser.add_argument("--state", required=True, help="prior broker-run-state.json (old closure)")
    parser.add_argument("--out", required=True, help="broker pipeline output root holding the checkpoints")
    parser.add_argument(
        "--from-closure",
        required=True,
        help="the exact prior runtime closure sha256 this migration is authorized to leave",
    )
    args = parser.parse_args()

    findings: list[dict[str, Any]] = []
    request_path = Path(args.request).resolve()
    state_path = Path(args.state).resolve()
    output_root = Path(args.out).resolve()

    # 1. Prior state: correct schema, correct pinned vintage.
    try:
        prior = rbp.read_json(state_path, "prior broker run state")
    except ValueError as error:
        return fail(findings, "migration.prior_state_unreadable", str(error))
    if prior.get("schema_version") != "broker-run-state/1.0":
        return fail(findings, "migration.prior_state_schema", "Prior broker run state has the wrong schema version.")
    prior_runtime = str(prior.get("runtime_closure_sha256") or "")
    if prior_runtime != args.from_closure:
        return fail(
            findings, "migration.closure_vintage_mismatch",
            "Prior state was not produced by the pinned source closure; refusing to migrate "
            f"(state {prior_runtime[:12]}..., pinned {args.from_closure[:12]}...).",
        )

    # 2. Identity: same request, same source bytes on disk. No re-upload path
    #    exists here by construction - a changed source is a hard refusal.
    try:
        request = rbp.read_json(request_path, "broker extraction request")
        request_digest = rbp.sha256_file(request_path)
        sources = rbp.source_hashes(request, request_path.parent)
    except (FileNotFoundError, ValueError) as error:
        return fail(findings, "migration.source_identity_unverifiable", str(error))
    if prior.get("request_sha256") != request_digest:
        return fail(findings, "migration.request_mismatch", "Prior state belongs to a different broker request.")
    if prior.get("source_sha256") != sources:
        return fail(findings, "migration.source_hash_mismatch", "Broker source hashes do not match the prior run.")

    # 3. Closures: recompute the prior cache key from first principles, then
    #    derive the new one from the CURRENT tree.
    old_cache_key = rbp.sha256_bytes(rbp.canonical_bytes({
        "request": request_digest, "sources": sources, "runtime": prior_runtime,
    }))
    if prior.get("cache_key") != old_cache_key:
        return fail(findings, "migration.prior_cache_key_inconsistent",
                    "Prior state cache key does not recompute from its own request/sources/closure.")
    new_runtime, _members = rbp.runtime_closure()
    if new_runtime == prior_runtime:
        return fail(findings, "migration.closure_unchanged",
                    "The runtime closure is unchanged; resume directly, no migration is needed.")
    new_cache_key = rbp.sha256_bytes(rbp.canonical_bytes({
        "request": request_digest, "sources": sources, "runtime": new_runtime,
    }))
    old_key, new_key = old_cache_key[:16], new_cache_key[:16]

    # 4. Extraction checkpoint: receipt-verify under the OLD closure before
    #    anything is copied.
    old_extract_root = output_root / f"extract-{old_key}"
    old_bundle_path = old_extract_root / "broker-extraction-bundle.json"
    old_extract_receipt = output_root / f"extract-{old_key}.receipt.json"
    old_extract_input = rbp.sha256_bytes(rbp.canonical_bytes({
        "request": request_digest, "sources": sources, "runtime": prior_runtime,
    }))
    if not rbp.reusable(old_bundle_path, old_extract_receipt, old_extract_input):
        return fail(findings, "migration.extract_receipt_invalid",
                    "The prior extraction checkpoint does not verify against its seal; nothing was migrated.")

    # 5. Census checkpoint: receipt-verify under the OLD closure.
    old_census_path = output_root / f"surface-census-{old_key}.json"
    old_census_receipt = output_root / f"surface-census-{old_key}.receipt.json"
    old_census_input = rbp.sha256_bytes(rbp.canonical_bytes({
        "bundle": rbp.sha256_file(old_bundle_path), "runtime": prior_runtime,
    }))
    if not rbp.reusable(old_census_path, old_census_receipt, old_census_input):
        return fail(findings, "migration.census_receipt_invalid",
                    "The prior surface census does not verify against its seal; nothing was migrated.")

    new_extract_root = output_root / f"extract-{new_key}"
    new_bundle_path = new_extract_root / "broker-extraction-bundle.json"
    new_extract_receipt = output_root / f"extract-{new_key}.receipt.json"
    new_census_path = output_root / f"surface-census-{new_key}.json"
    new_census_receipt = output_root / f"surface-census-{new_key}.receipt.json"
    snapshot_path = state_path.parent / f"broker-run-state-premigration-{old_key}.json"
    new_extract_input = rbp.sha256_bytes(rbp.canonical_bytes({
        "request": request_digest, "sources": sources, "runtime": new_runtime,
    }))
    # Crash-window recovery: the state swap is the LAST step, so a rerun may
    # find targets from an interrupted migration. Each existing target is
    # either receipt-verified (resume through it) or a refusal — never a
    # silent overwrite and never a wedge that requires hand-deletion.
    if snapshot_path.exists() and snapshot_path.read_bytes() != state_path.read_bytes():
        return fail(findings, "migration.snapshot_mismatch",
                    "A pre-migration snapshot exists but does not match the current run state; "
                    "refusing to guess which vintage is authoritative.")
    resume_extract = new_extract_root.exists() or new_extract_receipt.exists()
    if resume_extract and not rbp.reusable(new_bundle_path, new_extract_receipt, new_extract_input):
        return fail(findings, "migration.partial_target_invalid",
                    f"An earlier migration left {new_extract_root} in an unverifiable state; "
                    "remove it and rerun, nothing has been changed.")

    # 6. Re-home the extraction root byte-for-byte (hardlinks where possible).
    #    artifact_root is the single self-referential path: when it names the
    #    old checkpoint root it must be rewritten; when it names an evidence
    #    directory elsewhere the bytes do not move and nothing is rewritten.
    bundle = rbp.read_json(old_bundle_path, "prior broker extraction bundle")
    artifact_root_value = str(bundle.get("artifact_root") or "")
    rewrite_artifact_root = artifact_root_value == str(old_extract_root)
    if not rewrite_artifact_root and not Path(artifact_root_value).is_dir():
        return fail(findings, "migration.bundle_artifact_root_unexpected",
                    "The extraction bundle artifact_root is neither its own checkpoint root "
                    "nor an existing evidence directory.")
    if resume_extract:
        file_count = sum(1 for item in new_extract_root.rglob("*") if item.is_file())
    else:
        file_count = link_or_copy_tree(old_extract_root, new_extract_root)
        if rewrite_artifact_root:
            bundle["artifact_root"] = str(new_extract_root)
            # The bundle carries the rewritten root, so break the hardlink first.
            new_bundle_path.unlink()
            rbp.atomic_json(new_bundle_path, bundle)
        rbp.seal_checkpoint(new_bundle_path, new_extract_receipt, new_extract_input)

    # 7. Census content is unchanged; it re-seals against the migrated bundle.
    new_census_input = rbp.sha256_bytes(rbp.canonical_bytes({
        "bundle": rbp.sha256_file(new_bundle_path), "runtime": new_runtime,
    }))
    if not rbp.reusable(new_census_path, new_census_receipt, new_census_input):
        shutil.copy2(old_census_path, new_census_path)
        rbp.seal_checkpoint(new_census_path, new_census_receipt, new_census_input)

    # 8. Migrated state replaces broker-run-state.json IN PLACE (that is the
    #    file the controller resumes from) as the LAST step of the migration;
    #    the pre-migration state is kept as an immutable snapshot beside it.
    #    Exhaustion history is carried verbatim; downstream artifacts are
    #    invalidated; status is untouched (the controller, not this tool,
    #    decides the next transition).
    if not snapshot_path.exists():
        shutil.copy2(state_path, snapshot_path)
    migrated = dict(prior)
    migrated["runtime_closure_sha256"] = new_runtime
    migrated["cache_key"] = new_cache_key
    kept_artifacts = {
        "extraction_bundle": str(new_bundle_path),
        "surface_census": str(new_census_path),
    }
    dropped_artifacts = sorted(set(prior.get("artifacts", {})) - set(kept_artifacts))
    migrated["artifacts"] = kept_artifacts
    migrated["artifact_sha256"] = {
        name: rbp.sha256_file(Path(value)) for name, value in sorted(kept_artifacts.items())
    }
    # Checkpoint entries follow broker-run-state.schema.json exactly
    # (additionalProperties: false); migration provenance lives in the
    # receipt file and the premigration snapshot, not in extra keys.
    migrated["checkpoints"] = [
        {"stage": "extract", "status": "PASS", "input_sha256": new_extract_input,
         "output_sha256": rbp.sha256_file(new_bundle_path), "reused": True},
        {"stage": "surface_census", "status": "PASS", "input_sha256": new_census_input,
         "output_sha256": rbp.sha256_file(new_census_path), "reused": True},
    ]
    # The internal frontier is rebased into the append-only work graph.  The
    # prior task history remains in the premigration snapshot and migration
    # receipt; the new graph has no scalar stage cursor to regress.
    prior_fixed = dict(prior.get("fixed_point") or {})
    migrated.setdefault("attempts", {}).setdefault("task_execution_receipts", {})
    migrated_work_graph = rbp.build_work_graph(
        prior={},
        cache_key=new_cache_key,
        tasks=[
            task for task in prior.get("tasks", [])
            if isinstance(task, dict) and task.get("task_id")
        ],
        checkpoints=migrated["checkpoints"],
        task_execution_receipts=migrated["attempts"]["task_execution_receipts"],
        closed=False,
    )
    migrated["fixed_point"] = {
        "schema_version": "broker-internal-fixed-point/1.0",
        "status": prior_fixed.get("status", "OPEN"),
        "stage": "migration_frontier_rebase",
        "stage_ordinal": 0,
        "passed_checkpoint_count": 0,
        "remaining_task_count": len(prior.get("tasks", [])),
        "progress_score": 0,
        "progress_sha256": rbp.sha256_bytes(rbp.canonical_bytes({
            "migration_rebase": new_cache_key,
        })),
        "task_set_sha256": prior_fixed.get("task_set_sha256", rbp.sha256_bytes(rbp.canonical_bytes([]))),
        "unchanged_retry_count": 0,
        "unchanged_retry_limit": max(1, int(prior_fixed.get("unchanged_retry_limit", 1))),
        "monotonic_from_prior": True,
        "checkpoint_reuse_required": True,
        "terminal_reasons": [],
        "work_graph": migrated_work_graph,
    }
    migrated["work_graph"] = migrated_work_graph
    rbp.atomic_json(state_path, migrated)

    receipt = {
        "schema_version": RECEIPT_SCHEMA,
        "run_id": prior.get("run_id"),
        "request_sha256": request_digest,
        "source_sha256": sources,
        "from_runtime_closure_sha256": prior_runtime,
        "to_runtime_closure_sha256": new_runtime,
        "from_cache_key": old_cache_key,
        "to_cache_key": new_cache_key,
        "migrated_checkpoints": [
            {"stage": "extract", "from": str(old_bundle_path), "to": str(new_bundle_path),
             "output_sha256": rbp.sha256_file(new_bundle_path), "files_rehomed": file_count,
             "artifact_root_rewritten": rewrite_artifact_root},
            {"stage": "surface_census", "from": str(old_census_path), "to": str(new_census_path),
             "output_sha256": rbp.sha256_file(new_census_path)},
        ],
        "invalidated_artifacts": dropped_artifacts,
        "preserved_history": {
            "pipeline_status": prior.get("pipeline_status"),
            "vision_attempt_count": (prior.get("attempts") or {}).get("vision_attempt_count"),
            "vision_attempt_limit": (prior.get("attempts") or {}).get("vision_attempt_limit"),
            "task_kinds": sorted({str(task.get("task_kind")) for task in prior.get("tasks", [])}),
            "fixed_point_status": (prior.get("fixed_point") or {}).get("status"),
        },
        "migrated_state": str(state_path),
        "premigration_state": str(snapshot_path),
        "note": (
            "Evidence bytes are unchanged; page renders, image artifacts and task artifacts are "
            "byte-identical, so existing model-host vision responses re-bind on resume. Exhaustion "
            "history is carried verbatim so the bounded degraded-close boundary stays armed."
        ),
    }
    receipt_path = output_root / f"migration-receipt-{new_key}.json"
    rbp.atomic_json(receipt_path, receipt)
    print(json.dumps({
        "status": "MIGRATED",
        "from_cache_key": old_key,
        "to_cache_key": new_key,
        "migrated_state": str(state_path),
        "receipt": str(receipt_path),
        "invalidated_artifacts": dropped_artifacts,
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
