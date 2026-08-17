#!/usr/bin/env python3
"""Carrier-migration regression: a stalled broker run crosses a closure change.

Matrix items 12/13/14. A live run that terminated at the broker frontier under
the PRIOR runtime closure is migrated to the CURRENT closure by
`migrate_broker_run_state.py`, then the REAL controller resumes it as a
subprocess. The proof obligations:

  * migration only leaves the exact pinned prior closure - a wrong pin, a
    mutated source PDF (matrix 14) or a tampered sealed checkpoint each REFUSE
    with a named finding and write nothing;
  * the receipted extraction and census checkpoints are reused (no
    re-extraction, no re-upload, no model-host re-transcription);
  * exhaustion history survives, so the very first resume closes the
    physical lane DEGRADED instead of restarting the attempt budget;
  * the resumed run reaches PASS_DEGRADED with quarantine receipts and never
    re-enters BLOCKED_INTERNAL.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import run_broker_pipeline as broker  # noqa: E402
import run_broker_degraded_close_tests as fx  # noqa: E402

FAKE_PRIOR_CLOSURE = "5" * 64


def run_migrator(request_path: Path, state_path: Path, output_root: Path, pin: str) -> tuple[int, dict[str, Any]]:
    completed = subprocess.run(
        [
            sys.executable, str(HERE / "migrate_broker_run_state.py"), str(request_path),
            "--state", str(state_path), "--out", str(output_root), "--from-closure", pin,
        ],
        cwd=HERE, text=True, capture_output=True, check=False,
    )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        raise AssertionError(f"migrator emitted no JSON: {completed.stdout[-500:]} {completed.stderr[-1500:]}")
    return completed.returncode, payload


def main() -> int:
    checks = 0
    grid_a = [["Metric", "2027E", "2028E"], ["Alpha series", "100", "110"], ["Beta series", "20", "22"]]
    grid_b = [["Metric", "2027E", "2028E"], ["Alpha series", "100", "110"], ["Beta series", "21", "22"]]

    with tempfile.TemporaryDirectory(prefix="excel-inflow-migration-") as temporary:
        root = Path(temporary)
        artifact_root = root / "artifacts"
        artifact_root.mkdir(parents=True)

        documents = [
            fx.build_house(
                document_id="jpm", house_id="jpm", house_name="J.P. Morgan",
                artifact_root=artifact_root, vision_required=False,
                clean_rows=[["Metric", "2027E", "2028E"], ["Alpha series", "101", "111"], ["Beta series", "19", "21"]],
            ),
            fx.build_house(
                document_id="kepler", house_id="kepler", house_name="Kepler Cheuvreux",
                artifact_root=artifact_root, vision_required=True,
            ),
            fx.build_house(
                document_id="berenberg", house_id="berenberg", house_name="Berenberg",
                artifact_root=artifact_root, vision_required=True,
            ),
            fx.build_house(
                document_id="bnp", house_id="bnp", house_name="BNP Paribas",
                artifact_root=artifact_root, vision_required=False,
                clean_rows=[["Metric", "2027E", "2028E"], ["Alpha series", "99", "108"], ["Beta series", "18", "20"]],
            ),
            fx.build_house(
                document_id="jefferies", house_id="jefferies", house_name="Jefferies",
                artifact_root=artifact_root, vision_required=False,
                clean_rows=[["Metric", "2027E", "2028E"], ["Alpha series", "102", "112"], ["Beta series", "20", "23"]],
            ),
        ]

        source_dir = root / "sources"
        source_dir.mkdir()
        request_documents = []
        for document in documents:
            source = source_dir / f"{document['document_id']}.pdf"
            source.write_bytes(b"%PDF-fixture " + document["document_id"].encode("utf-8"))
            request_documents.append({
                "document_id": document["document_id"],
                "house_id": document["house_id"],
                "house_name": document["house_name"],
                "source_id": f"fixture.{document['document_id']}",
                "path": str(source),
                "media_type": "application/pdf",
                "published_date": "2026-06-30",
                "expected_sha256": broker.sha256_file(source),
            })
        request = {
            "schema_version": "broker-extraction-request/1.0",
            "run_id": "migration_regression",
            "documents": request_documents,
        }
        request_path = root / "broker-extraction-request.json"
        fx.write_json(request_path, request)

        output_root = root / "controller"
        output_root.mkdir()
        request_digest = broker.sha256_file(request_path)
        sources = broker.source_hashes(request, request_path.parent)

        # ---- the OLD world: checkpoints sealed under the PRIOR closure ----
        old_cache_key = broker.sha256_bytes(fx.canonical_bytes({
            "request": request_digest, "sources": sources, "runtime": FAKE_PRIOR_CLOSURE,
        }))
        old_key = old_cache_key[:16]
        bundle = {
            "schema_version": "broker-extraction-bundle/1.0",
            "run_id": request["run_id"],
            "artifact_root": str(artifact_root),
            "documents": documents,
            "summary": {},
            "gate_status": "NEEDS_VISION",
            "findings": [],
        }
        old_extract_root = output_root / f"extract-{old_key}"
        old_bundle_path = old_extract_root / "broker-extraction-bundle.json"
        fx.write_json(old_bundle_path, bundle)
        old_extract_input = broker.sha256_bytes(fx.canonical_bytes({
            "request": request_digest, "sources": sources, "runtime": FAKE_PRIOR_CLOSURE,
        }))
        broker.seal_checkpoint(old_bundle_path, output_root / f"extract-{old_key}.receipt.json", old_extract_input)

        old_census_path = output_root / f"surface-census-{old_key}.json"
        census_run = subprocess.run(
            [sys.executable, str(HERE / "compile_broker_surface_census.py"), str(old_bundle_path), "--out", str(old_census_path)],
            cwd=HERE, text=True, capture_output=True, check=False,
        )
        fx.check(old_census_path.is_file(), f"census fixture failed: {census_run.stderr[-800:]}")
        old_census_input = broker.sha256_bytes(fx.canonical_bytes({
            "bundle": broker.sha256_file(old_bundle_path), "runtime": FAKE_PRIOR_CLOSURE,
        }))
        broker.seal_checkpoint(old_census_path, output_root / f"surface-census-{old_key}.receipt.json", old_census_input)

        # The stalled terminal state the live failure left behind: attempt
        # budget spent, aggregate internal defect task, terminal fixed point.
        prior_state = {
            "schema_version": "broker-run-state/1.0",
            "run_id": request["run_id"],
            "pipeline_status": "BLOCKED_INTERNAL",
            "user_blocking": False,
            "blocker_class": "INTERNAL_WORK",
            "request_sha256": request_digest,
            "source_sha256": sources,
            "runtime_closure_sha256": FAKE_PRIOR_CLOSURE,
            "cache_key": old_cache_key,
            "checkpoints": [
                {"stage": "extract", "status": "PASS", "input_sha256": old_extract_input,
                 "output": str(old_bundle_path), "reused": True},
                {"stage": "surface_census", "status": "PASS", "input_sha256": old_census_input,
                 "output": str(old_census_path), "reused": True},
            ],
            "artifacts": {
                "extraction_bundle": str(old_bundle_path),
                "surface_census": str(old_census_path),
                "verified_bundle": str(output_root / f"verified-{old_key}-stale.json"),
            },
            "artifact_sha256": {},
            "tasks": [{
                "task_kind": "internal_fixed_point_defect",
                "task_id": "fixture-defect-task",
                "failed_status": "NEEDS_RESOLUTION",
                "terminal_reasons": ["internal progress frontier was unchanged for 2 retries"],
                "user_blocking": False,
            }],
            "fixed_point": {
                "schema_version": "broker-internal-fixed-point/1.0",
                "status": "TERMINAL_DEFECT",
                "stage": "internal_fixed_point_defect",
                "stage_ordinal": 6,
                "passed_checkpoint_count": 2,
                "remaining_task_count": 1,
                "progress_score": 60199,
                "progress_sha256": "6" * 64,
                "task_set_sha256": "7" * 64,
                "unchanged_retry_count": 2,
                "unchanged_retry_limit": 2,
                "monotonic_from_prior": False,
                "checkpoint_reuse_required": True,
                "terminal_reasons": ["internal progress frontier was unchanged for 2 retries"],
            },
            "attempts": {
                "vision_response_sha256": ["1" * 64, "2" * 64, "3" * 64],
                "vision_attempt_count": broker.VISION_ATTEMPT_LIMIT,
                "vision_attempt_limit": broker.VISION_ATTEMPT_LIMIT,
            },
            "summary": {"terminal_reason": "internal_fixed_point_stalled_or_regressed"},
        }
        state_path = output_root / "broker-run-state.json"
        fx.write_json(state_path, prior_state)
        prior_state_bytes = state_path.read_bytes()

        # ---- refusal: wrong pinned source closure ----
        code, payload = run_migrator(request_path, state_path, output_root, "a" * 64)
        fx.check(code == 2 and payload.get("status") == "REFUSED", "a wrong closure pin was not refused")
        fx.check(
            any(f.get("id") == "migration.closure_vintage_mismatch" for f in payload.get("findings", [])),
            "the wrong-pin refusal is unnamed",
        )
        fx.check(state_path.read_bytes() == prior_state_bytes, "a refused migration mutated the run state")
        checks += 3

        # ---- refusal: mutated source bytes (matrix 14) ----
        victim = source_dir / "kepler.pdf"
        original = victim.read_bytes()
        victim.write_bytes(original + b"\x00")
        code, payload = run_migrator(request_path, state_path, output_root, FAKE_PRIOR_CLOSURE)
        fx.check(code == 2 and payload.get("status") == "REFUSED", "a mutated broker source was not refused")
        fx.check(
            any("source" in str(f.get("id")) for f in payload.get("findings", [])),
            "the source-mutation refusal is unnamed",
        )
        victim.write_bytes(original)
        checks += 2

        # ---- refusal: tampered sealed checkpoint ----
        sealed_bytes = old_bundle_path.read_bytes()
        old_bundle_path.write_bytes(sealed_bytes + b"\n")
        code, payload = run_migrator(request_path, state_path, output_root, FAKE_PRIOR_CLOSURE)
        fx.check(code == 2 and payload.get("status") == "REFUSED", "a tampered sealed checkpoint was not refused")
        fx.check(
            any(f.get("id") == "migration.extract_receipt_invalid" for f in payload.get("findings", [])),
            "the tampered-checkpoint refusal is unnamed",
        )
        old_bundle_path.write_bytes(sealed_bytes)
        checks += 2

        # ---- the authorized migration ----
        code, payload = run_migrator(request_path, state_path, output_root, FAKE_PRIOR_CLOSURE)
        fx.check(code == 0 and payload.get("status") == "MIGRATED", f"migration failed: {json.dumps(payload)[:600]}")
        new_runtime, _members = broker.runtime_closure()
        new_cache_key = broker.sha256_bytes(fx.canonical_bytes({
            "request": request_digest, "sources": sources, "runtime": new_runtime,
        }))
        new_key = new_cache_key[:16]
        migrated = json.loads(state_path.read_text("utf-8"))
        fx.check(migrated["cache_key"] == new_cache_key, "the migrated state does not carry the new cache key")
        fx.check(
            migrated["attempts"]["vision_attempt_count"] == broker.VISION_ATTEMPT_LIMIT,
            "exhaustion history was lost in migration",
        )
        fx.check(
            any(t.get("task_kind") == "internal_fixed_point_defect" for t in migrated.get("tasks", [])),
            "the defect-task history was lost in migration",
        )
        fx.check(migrated["fixed_point"]["stage_ordinal"] == 0, "the fixed-point frontier was not rebased")
        snapshot = output_root / f"broker-run-state-premigration-{old_key}.json"
        fx.check(snapshot.is_file() and snapshot.read_bytes() == prior_state_bytes,
                 "the pre-migration state snapshot is missing or altered")
        receipt_path = output_root / f"migration-receipt-{new_key}.json"
        fx.check(receipt_path.is_file(), "no migration receipt was written")
        receipt = json.loads(receipt_path.read_text("utf-8"))
        fx.check(
            receipt["from_runtime_closure_sha256"] == FAKE_PRIOR_CLOSURE
            and receipt["to_runtime_closure_sha256"] == new_runtime,
            "the migration receipt does not bind both closures",
        )
        fx.check("verified_bundle" in receipt.get("invalidated_artifacts", []),
                 "the failed frontier artifact was not declared invalidated")
        new_bundle_path = output_root / f"extract-{new_key}" / "broker-extraction-bundle.json"
        new_extract_input = broker.sha256_bytes(fx.canonical_bytes({
            "request": request_digest, "sources": sources, "runtime": new_runtime,
        }))
        fx.check(
            broker.reusable(new_bundle_path, output_root / f"extract-{new_key}.receipt.json", new_extract_input),
            "the migrated extraction checkpoint does not verify under the new closure",
        )
        checks += 8

        # ---- resume with the REAL controller: no re-extraction, first pass
        #      closes the physical lane degraded, run reaches PASS_DEGRADED ----
        responses = root / "responses"
        responses.mkdir()
        kepler_image_sha = next(a["sha256"] for a in documents[1]["artifacts"] if a["kind"] == "page_image")
        berenberg_image_sha = next(a["sha256"] for a in documents[2]["artifacts"] if a["kind"] == "page_image")
        fx.write_json(responses / "kepler.p4.pass1.json", fx.vision_pass(
            document_id="kepler", surface_id="kepler.p4", image_sha256=kepler_image_sha,
            pass_index=1, producer="alpha", disposition="analytical_tables", rows=grid_a,
        ))
        fx.write_json(responses / "kepler.p4.pass2.json", fx.vision_pass(
            document_id="kepler", surface_id="kepler.p4", image_sha256=kepler_image_sha,
            pass_index=2, producer="beta", disposition="analytical_tables", rows=grid_b,
        ))
        fx.write_json(responses / "berenberg.p4.pass1.json", fx.vision_pass(
            document_id="berenberg", surface_id="berenberg.p4", image_sha256=berenberg_image_sha,
            pass_index=1, producer="alpha", disposition="analytical_tables", rows=grid_a,
        ))
        fx.write_json(responses / "berenberg.p4.pass2.json", fx.vision_pass(
            document_id="berenberg", surface_id="berenberg.p4", image_sha256=berenberg_image_sha,
            pass_index=2, producer="beta", disposition="verified_non_tabular",
        ))

        statuses: list[str] = []
        crosswalk_path: Path | None = None
        final_state: dict[str, Any] = {}
        for _attempt in range(6):
            final_state = fx.invoke(request_path, output_root, responses, crosswalk_path)
            status = final_state["pipeline_status"]
            statuses.append(status)
            fx.check(status != "BLOCKED_INTERNAL",
                     "the migrated run re-terminated: " + json.dumps(final_state.get("summary", {}))[:400])
            fx.check(final_state["user_blocking"] is False, f"{status} leaked as a user ask")
            if status == "NEEDS_CROSSWALK":
                verified = json.loads(Path(final_state["artifacts"]["verified_bundle"]).read_text("utf-8"))
                crosswalk_path = root / "crosswalk.json"
                fx.write_json(crosswalk_path, fx.reference_only_crosswalk(verified))
            if status in {"PASS", "PASS_DEGRADED"}:
                break
        fx.check(
            final_state.get("pipeline_status") == "PASS_DEGRADED",
            f"terminal status was {final_state.get('pipeline_status')} after {statuses}",
        )
        fx.check(
            statuses[0] == "NEEDS_CROSSWALK",
            f"the first resume did not close the physical lane from carried exhaustion: {statuses}",
        )
        extract_checkpoints = [
            item for item in final_state.get("checkpoints", []) if item.get("stage") == "extract"
        ]
        fx.check(
            extract_checkpoints and all(item.get("reused") for item in extract_checkpoints),
            "the resumed controller re-ran extraction instead of reusing the migrated checkpoint",
        )
        summary = final_state.get("summary", {})
        fx.check(summary.get("degraded") is True, "the resumed terminal summary does not disclose degradation")
        fx.check(int(summary.get("quarantined_surface_count", 0)) >= 1, "surface quarantine was lost across migration")
        fx.check(int(summary.get("quarantined_conflict_count", 0)) >= 1, "cell quarantine was lost across migration")
        checks += 6 + 2 * len(statuses)

    print(json.dumps({"checks": checks, "status": "PASS", "statuses": statuses}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
