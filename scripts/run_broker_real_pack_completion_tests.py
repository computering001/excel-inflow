#!/usr/bin/env python3
"""Prove a real same-issuer multi-house broker pack reaches terminal authority.

This is deliberately stricter than ``run_broker_public_layout_tests.py``.  The
layout cohort proves that difficult pages enter the internal work queue.  This
gate proves that a separately reviewed, external five-to-ten-house fixture
actually exits that queue, compiles a sealed pack, and supplies at least one
coherent-house forecast authority which the model may consume while absent
concept-periods retain the ordinary waterfall.

The fixture, PDFs, model-host responses and reviewed crosswalk remain external
test custody.  No source values or reports enter the skill package.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from broker_work_graph import verify_work_graph


HERE = Path(__file__).resolve().parent
REQUIRED_CORE = {
    "revenue",
    "depreciation_and_amortisation",
    "effective_tax_rate",
    "capex",
    "change_in_working_capital",
    "dividends",
}
HEADLINE_ALTERNATIVES = {"ebit", "adjusted_ebitda"}
REQUIRED_CHECKPOINTS = {
    "extract",
    "surface_census",
    "pack_compilation",
}
INTERNAL_PROGRESS_STATES = {
    "NEEDS_VISION",
    "NEEDS_RESOLUTION",
    "NEEDS_CROSSWALK",
    "NEEDS_CROSSWALK_REVIEW",
}
MAX_CONTROLLER_ATTEMPTS = 8


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text("utf-8"))
    except Exception as error:
        raise AssertionError(f"{label} is not readable JSON: {error}") from error
    check(isinstance(value, dict), f"{label} must be one JSON object.")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pdf_page_count(path: Path) -> int:
    import fitz  # type: ignore

    with fitz.open(path) as document:
        return document.page_count


def resolve(base: Path, value: Any, label: str) -> Path:
    check(isinstance(value, str) and value.strip(), f"{label} is absent.")
    target = (base / value).resolve()
    check(target.is_file() or target.is_dir(), f"{label} is absent: {target}")
    return target


def invoke_controller(
    request_path: Path,
    output_root: Path,
    responses: Path,
    crosswalk: Path,
) -> tuple[int, dict[str, Any], str]:
    completed = subprocess.run(
        [
            sys.executable,
            str(HERE / "run_broker_pipeline.py"),
            str(request_path),
            "--out",
            str(output_root),
            "--responses",
            str(responses),
            "--crosswalk",
            str(crosswalk),
        ],
        cwd=HERE,
        text=True,
        capture_output=True,
        check=False,
    )
    state_path = output_root / "broker-run-state.json"
    check(state_path.is_file(), "Broker controller emitted no broker-run-state.json.")
    state = read_json(state_path, "broker run state")
    return completed.returncode, state, (completed.stderr or completed.stdout).strip()


def invoke_controller_to_terminal(
    request_path: Path,
    output_root: Path,
    responses: Path,
    crosswalk: Path,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    attempts: list[dict[str, Any]] = []
    prior_graph_revision: int | None = None
    prior_node_ids: set[str] = set()
    for attempt_number in range(1, MAX_CONTROLLER_ATTEMPTS + 1):
        code, state, diagnostic = invoke_controller(
            request_path,
            output_root,
            responses,
            crosswalk,
        )
        status = str(state.get("pipeline_status") or "")
        fixed = state.get("fixed_point") or {}
        graph = state.get("work_graph") or {}
        graph_errors = verify_work_graph(graph)
        check(not graph_errors, f"Broker work graph is invalid: {', '.join(graph_errors)}")
        graph_revision = int(graph.get("revision", -1))
        graph_node_ids = {
            str(node.get("node_id"))
            for node in graph.get("nodes") or []
            if isinstance(node, dict) and node.get("node_id")
        }
        attempts.append({
            "attempt": attempt_number,
            "exit_code": code,
            "pipeline_status": status,
            "state_sha256": sha256_file(output_root / "broker-run-state.json"),
            "work_graph_revision": graph_revision,
            "work_graph_node_count": len(graph_node_ids),
            "work_graph_completed_count": len(graph.get("completed_node_ids") or []),
            "remaining_task_count": len(graph.get("open_task_ids") or []),
        })
        if code == 0 and status in {"PASS", "PASS_DEGRADED"}:
            return state, attempts
        check(
            code in {1, 2} and status in INTERNAL_PROGRESS_STATES,
            "Broker controller reached a non-progress terminal state: "
            f"{status or 'UNKNOWN'} ({diagnostic or 'no diagnostic'}).",
        )
        check(
            fixed.get("status") == "OPEN",
            f"Broker controller fixed point is not open at {status}.",
        )
        check(
            fixed.get("monotonic_from_prior") is True,
            f"Broker controller reports a non-monotonic transition at {status}.",
        )
        check(
            int(fixed.get("unchanged_retry_count", 0))
            < int(fixed.get("unchanged_retry_limit", 0)),
            f"Broker controller exhausted its unchanged-frontier budget at {status}.",
        )
        if prior_graph_revision is not None:
            check(
                graph_revision >= prior_graph_revision,
                f"Broker work graph revision regressed at {status}.",
            )
            check(
                prior_node_ids.issubset(graph_node_ids),
                f"Broker work graph lost prior nodes at {status}.",
            )
        prior_graph_revision = graph_revision
        prior_node_ids = graph_node_ids
    raise AssertionError(
        "Broker controller did not reach terminal PASS or PASS_DEGRADED "
        f"within {MAX_CONTROLLER_ATTEMPTS} attempts."
    )


def require_owned_artifact(state: dict[str, Any], key: str) -> Path:
    raw_path = (state.get("artifacts") or {}).get(key)
    check(isinstance(raw_path, str) and raw_path, f"Terminal state owns no {key} artifact.")
    path = Path(raw_path).resolve()
    check(path.is_file(), f"Terminal {key} artifact is absent: {path}")
    expected = (state.get("artifact_sha256") or {}).get(key)
    check(expected == sha256_file(path), f"Terminal state has a stale {key} hash.")
    return path


def validate_checkpoint_closure(state: dict[str, Any]) -> None:
    checkpoints = state.get("checkpoints") or []
    by_stage: dict[str, dict[str, Any]] = {}
    for checkpoint in checkpoints:
        stage = str(checkpoint.get("stage") or "")
        check(stage and stage not in by_stage, f"Controller repeats checkpoint {stage!r}.")
        by_stage[stage] = checkpoint
    missing = sorted(REQUIRED_CHECKPOINTS - set(by_stage))
    check(not missing, f"Terminal state lacks required checkpoints: {', '.join(missing)}")
    for stage in REQUIRED_CHECKPOINTS:
        checkpoint = by_stage[stage]
        check(checkpoint.get("status") == "PASS", f"Checkpoint {stage!r} is not PASS.")
        check(
            isinstance(checkpoint.get("output_sha256"), str),
            f"Checkpoint {stage!r} has no output hash.",
        )
    semantic = by_stage.get("semantic_verification")
    recovered = by_stage.get("terminal_materiality_recovery")
    check(semantic is not None, "Terminal state has no semantic verification checkpoint.")
    semantic_pass = semantic.get("status") == "PASS"
    recovery_pass = recovered is not None and recovered.get("status") == "PASS"
    check(
        semantic_pass or recovery_pass,
        "Neither ordinary semantic verification nor terminal materiality recovery reached PASS.",
    )
    authority = semantic if semantic_pass else recovered
    check(
        isinstance(authority.get("output_sha256"), str),
        "Terminal semantic authority checkpoint has no output hash.",
    )


def validate_terminal_state(state: dict[str, Any]) -> dict[str, Path]:
    check(state.get("schema_version") == "broker-run-state/1.0", "Wrong broker state version.")
    status = state.get("pipeline_status")
    check(
        status in {"PASS", "PASS_DEGRADED"},
        "Real pack did not reach controller terminal PASS or PASS_DEGRADED.",
    )
    check(state.get("user_blocking") is False, f"Terminal broker {status} is user-blocking.")
    check(state.get("blocker_class") is None, f"Terminal broker {status} retains a blocker class.")
    check(state.get("tasks") == [], f"Terminal broker {status} retains internal tasks.")
    fixed = state.get("fixed_point") or {}
    check(fixed.get("status") == "CLOSED", "Terminal broker fixed point is not CLOSED.")
    check(int(fixed.get("remaining_task_count", -1)) == 0, "Terminal broker fixed point retains work.")
    graph = state.get("work_graph") or {}
    graph_errors = verify_work_graph(graph)
    check(not graph_errors, f"Terminal broker work graph is invalid: {', '.join(graph_errors)}")
    check(graph.get("status") == "CLOSED", "Terminal broker work graph is not CLOSED.")
    check(graph.get("open_task_ids") == [], "Terminal broker work graph retains open tasks.")
    check(
        fixed.get("work_graph") == graph,
        "Terminal fixed-point receipt is not bound to the top-level work graph.",
    )
    validate_checkpoint_closure(state)
    artifacts = {
        key: require_owned_artifact(state, key)
        for key in (
            "broker_pack",
            "source_tables",
            "broker_crosswalk_receipt",
            "semantic_report",
            "broker_semantic_verification",
            "crosswalk",
        )
    }
    active_bundle_key = (
        "verified_bundle"
        if (state.get("artifacts") or {}).get("verified_bundle")
        else "extraction_bundle"
    )
    artifacts[active_bundle_key] = require_owned_artifact(state, active_bundle_key)
    if (state.get("artifacts") or {}).get("terminal_recovery_receipt"):
        artifacts["terminal_recovery_receipt"] = require_owned_artifact(
            state, "terminal_recovery_receipt"
        )
    return artifacts


def prove_non_terminal_states_block(state: dict[str, Any]) -> list[str]:
    caught: list[str] = []
    for status in (
        "NEEDS_VISION",
        "NEEDS_RESOLUTION",
        "NEEDS_CROSSWALK",
        "NEEDS_CROSSWALK_REVIEW",
        "BLOCKED_INTERNAL",
    ):
        candidate = copy.deepcopy(state)
        candidate["pipeline_status"] = status
        try:
            validate_terminal_state(candidate)
        except AssertionError:
            caught.append(status)
        else:
            raise AssertionError(f"Non-terminal broker state {status} was accepted as PASS.")
    return caught


def validate_pack(
    pack: dict[str, Any],
    source_tables: dict[str, Any],
    receipt: dict[str, Any],
    expected_house_ids: set[str],
) -> dict[str, Any]:
    check(pack.get("schema_version") == "broker-pack/1.0", "Compiled broker pack has wrong version.")
    periods = pack.get("forecast_periods") or []
    check(len(periods) == 3 and len(set(periods)) == 3, "Pack does not carry exactly three forecast periods.")
    houses = pack.get("houses") or []
    house_ids = {str(item.get("house_id")) for item in houses}
    check(house_ids == expected_house_ids, "Compiled pack house set differs from the external fixture.")
    check(5 <= len(house_ids) <= 10, "Compiled pack does not retain five-to-ten distinct houses.")
    metric_ids = set(pack.get("metrics") or {})
    missing = sorted(REQUIRED_CORE - metric_ids)
    check(not missing, f"Pack is missing core forecast metrics: {', '.join(missing)}")
    check(metric_ids & HEADLINE_ALTERNATIVES, "Pack has neither EBIT nor adjusted EBITDA authority.")
    eligibility = pack.get("eligibility_summary") or {}
    check(
        int(eligibility.get("primary_eligible_house_count", 0))
        + int(eligibility.get("supplemental_eligible_house_count", 0)) >= 1,
        "No house has any coherent model-usable forecast authority.",
    )
    check(
        eligibility.get("run_can_continue_without_broker_question") is True,
        "Compiled pack cannot continue without an unnecessary broker question.",
    )
    authority_houses = []
    for house in houses:
        estimates = house.get("estimates") or {}
        complete_metrics = {
            metric_id for metric_id, values in estimates.items()
            if isinstance(values, list) and len(values) == 3
            and all(value is not None for value in values)
        }
        if complete_metrics:
            authority_houses.append((house, complete_metrics))
    check(len(authority_houses) == 1, "Model authority is not confined to one coherent house.")
    selected_house, complete_metrics = authority_houses[0]
    check(
        bool(complete_metrics & HEADLINE_ALTERNATIVES),
        "Selected coherent house lacks a complete headline forecast anchor.",
    )
    check(
        len(complete_metrics & metric_ids) >= 2,
        "Selected coherent house does not supply a non-vacuous forecast surface.",
    )
    recommended = pack.get("recommended_primary_house_id") or selected_house.get("house_id")
    check(recommended in house_ids, "Selected coherent house is absent from the pack.")
    check(
        source_tables.get("schema_version") == "broker-source-tables/1.0",
        "Broker source-table artifact has wrong version.",
    )
    source_houses = {str(item.get("house_id")) for item in source_tables.get("houses") or []}
    check(source_houses == expected_house_ids, "Source-table house set differs from the compiled pack.")
    check(receipt.get("status") == "PASS", "Broker crosswalk receipt is not PASS.")
    check(int(receipt.get("mapping_count", 0)) > 0, "Broker crosswalk receipt is vacuous.")
    summary = receipt.get("coverage_summary") or {}
    check(
        int(summary.get("unresolved_candidate_count", 0)) == 0,
        "Broker crosswalk receipt retains unresolved candidates.",
    )
    return {
        "house_count": len(house_ids),
        "forecast_periods": periods,
        "metric_count": len(metric_ids),
        "mapping_count": int(receipt.get("mapping_count", 0)),
        "recommended_primary_house_id": recommended,
    }


def mapping_cells(receipt: dict[str, Any]) -> list[tuple[str, int, int]]:
    return [
        (str(component.get("table_id")), int(component.get("row", 0)), int(component.get("column", 0)))
        for mapping in receipt.get("mappings") or []
        for component in mapping.get("components") or []
    ]


def source_cell_index(source_tables: dict[str, Any]) -> dict[tuple[str, int, int], dict[str, Any]]:
    output: dict[tuple[str, int, int], dict[str, Any]] = {}
    for house in source_tables.get("houses") or []:
        for table in house.get("tables") or []:
            table_id = str(table.get("table_id"))
            authorities = {
                (int(item.get("row", 0)), int(item.get("column", 0))): item
                for item in table.get("cell_authorities") or []
            }
            for row_index, row in enumerate(table.get("rows") or [], start=1):
                for column_index, value in enumerate(row, start=1):
                    output[(table_id, row_index, column_index)] = {
                        "value": value,
                        "workbook_presentation": table.get("workbook_presentation"),
                        "authority": authorities.get((row_index, column_index), {}),
                    }
    return output


def selected_cell_errors(source_tables: dict[str, Any], receipt: dict[str, Any]) -> list[str]:
    index = source_cell_index(source_tables)
    errors: list[str] = []
    selected = mapping_cells(receipt)
    if not selected:
        return ["crosswalk receipt cites zero selected source cells"]
    for key in selected:
        cell = index.get(key)
        if cell is None:
            errors.append(f"selected source cell {key} is absent")
            continue
        if cell.get("workbook_presentation") != "analytical_table":
            errors.append(f"selected source cell {key} belongs to evidence-only material")
        authority = cell.get("authority") or {}
        if authority.get("status") == "quarantined_conflict":
            errors.append(f"selected source cell {key} is quarantined")
    return errors


def mutate_selected_cell(source_tables: dict[str, Any], receipt: dict[str, Any]) -> dict[str, Any]:
    selected = mapping_cells(receipt)
    check(selected, "Cannot run selected-cell mutation because no mapping cell exists.")
    target = selected[0]
    mutated = copy.deepcopy(source_tables)
    for house in mutated.get("houses") or []:
        for table in house.get("tables") or []:
            if str(table.get("table_id")) != target[0]:
                continue
            authorities = table.setdefault("cell_authorities", [])
            existing = next(
                (
                    item for item in authorities
                    if int(item.get("row", 0)) == target[1]
                    and int(item.get("column", 0)) == target[2]
                ),
                None,
            )
            if existing is None:
                existing = {"row": target[1], "column": target[2]}
                authorities.append(existing)
            existing.update({
                "status": "quarantined_conflict",
                "conflict_id": "mutation-selected-cell-conflict",
                "basis": "adversarial_test_only",
            })
            return mutated
    raise AssertionError(f"Selected mutation cell {target} is absent from source tables.")


def mutate_selected_bundle_cell(
    bundle: dict[str, Any], receipt: dict[str, Any]
) -> tuple[dict[str, Any], tuple[str, int, int]]:
    from compile_broker_candidate_manifest import compile_manifest

    selected = mapping_cells(receipt)
    check(selected, "Cannot run selected-cell mutation because no mapping cell exists.")
    target = selected[0]
    mutated = copy.deepcopy(bundle)
    candidate = next(
        (
            item
            for item in (mutated.get("candidate_manifest") or {}).get("candidates") or []
            if str(item.get("table_id") or "") == target[0]
            and any(
                int(cell.get("row", 0)) == target[1]
                and int(cell.get("column", 0)) == target[2]
                for cell in item.get("source_cells") or []
            )
        ),
        None,
    )
    check(candidate is not None, f"Selected mutation cell {target} has no immutable candidate.")
    candidate_cells = {
        (int(cell.get("row", 0)), int(cell.get("column", 0)))
        for cell in candidate.get("source_cells") or []
    }
    check(candidate_cells, f"Selected mutation candidate for {target} has no source cells.")
    found_cells: set[tuple[int, int]] = set()
    for document in mutated.get("documents") or []:
        for table_collection in ("tables", "canonical_tables"):
            for table in document.get(table_collection) or []:
                table_id = str(table.get("table_id") or table.get("canonical_table_id") or "")
                if table_id != target[0]:
                    continue
                for row, column in candidate_cells:
                    try:
                        cell = table["rows"][row - 1][column - 1]
                    except (IndexError, KeyError, TypeError):
                        continue
                    cell.update({
                        "authority_status": "quarantined_conflict",
                        "conflict_id": "mutation-selected-cell-conflict",
                        "authority_basis": "adversarial_test_only",
                    })
                    found_cells.add((row, column))
    check(
        candidate_cells <= found_cells,
        f"Selected mutation candidate for {target} is incomplete in the active extraction bundle.",
    )
    mutated["candidate_manifest"] = compile_manifest(mutated)
    mutated["canonical_tables_sha256"] = mutated["candidate_manifest"]["canonical_tables_sha256"]
    return mutated, target


def run_selected_cell_compiler_mutation(
    bundle_path: Path,
    crosswalk_path: Path,
    receipt: dict[str, Any],
    output_root: Path,
) -> dict[str, Any]:
    bundle = read_json(bundle_path, "active broker extraction bundle")
    mutated, target = mutate_selected_bundle_cell(bundle, receipt)
    mutation_root = output_root / "selected-cell-conflict-mutation"
    mutation_root.mkdir(parents=True, exist_ok=True)
    mutated_path = mutation_root / "broker-extraction-bundle.json"
    mutated_path.write_text(json.dumps(mutated, indent=2, sort_keys=True) + "\n", "utf-8")

    semantic_path = mutation_root / "broker-semantic-verification-report.json"
    semantic = subprocess.run(
        [
            sys.executable,
            str(HERE / "verify_broker_semantics.py"),
            str(mutated_path),
            str(crosswalk_path),
            "--out",
            str(semantic_path),
        ],
        cwd=HERE,
        text=True,
        capture_output=True,
        check=False,
    )
    check(semantic.returncode != 0, "Independent semantic verifier accepted a selected quarantined cell.")
    semantic_report = read_json(semantic_path, "selected-cell mutation semantic report")
    semantic_codes = sorted({str(item.get("code")) for item in semantic_report.get("findings") or []})
    check(
        "SEM-QUARANTINED-CANDIDATE-ACTIVE" in semantic_codes,
        "Selected-cell mutation blocked, but not through the selected quarantined authority invariant.",
    )

    compiled_root = mutation_root / "compiled"
    compiled = subprocess.run(
        [
            sys.executable,
            str(HERE / "compile_broker_pack.py"),
            str(mutated_path),
            str(crosswalk_path),
            "--out",
            str(compiled_root),
        ],
        cwd=HERE,
        text=True,
        capture_output=True,
        check=False,
    )
    check(compiled.returncode != 0, "Broker pack compiler accepted a selected quarantined cell.")
    check(not (compiled_root / "broker-pack.json").exists(), "Blocked mutation still emitted broker-pack.json.")
    return {
        "status": "PASS",
        "selected_cell": {"table_id": target[0], "row": target[1], "column": target[2]},
        "semantic_codes": semantic_codes,
        "semantic_report": str(semantic_path),
        "semantic_report_sha256": sha256_file(semantic_path),
        "compiler_exit_code": compiled.returncode,
        "pack_emitted": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, help="External real-pack fixture manifest")
    parser.add_argument("--out", required=True, help="New disposable output directory")
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    output_root = Path(args.out).resolve()
    check(manifest_path.is_file(), f"Fixture manifest is absent: {manifest_path}")
    check(not output_root.exists() or not any(output_root.iterdir()), "Output directory must be new or empty.")
    output_root.mkdir(parents=True, exist_ok=True)

    manifest = read_json(manifest_path, "real-pack manifest")
    check(
        manifest.get("schema_version") == "broker-real-pack-completion-fixture/1.0",
        "Real-pack fixture has wrong schema version.",
    )
    issuer = str(manifest.get("issuer") or "").strip()
    check(issuer, "Real-pack fixture has no issuer.")
    documents = manifest.get("documents") or []
    check(isinstance(documents, list) and 5 <= len(documents) <= 10, "Fixture requires five-to-ten PDFs.")
    document_ids = {str(item.get("document_id") or "") for item in documents}
    house_ids = {str(item.get("house_id") or "") for item in documents}
    check(
        "" not in document_ids and len(document_ids) == len(documents),
        "Every fixture PDF must have a distinct document id.",
    )
    check("" not in house_ids and len(house_ids) == len(documents), "Every PDF must have a distinct house.")
    check(
        all(str(item.get("issuer") or "").strip() == issuer for item in documents),
        "All fixture documents must cover the same issuer.",
    )

    base = manifest_path.parent
    request_documents: list[dict[str, Any]] = []
    source_evidence: list[dict[str, Any]] = []
    source_hashes: set[str] = set()
    for item in documents:
        check(str(item.get("house_name") or "").strip(), f"House name is absent for {item.get('document_id')}.")
        check(str(item.get("published_date") or "").strip(), f"Published date is absent for {item.get('document_id')}.")
        source = resolve(base, item.get("path"), f"document {item.get('document_id')} path")
        check(source.suffix.lower() == ".pdf", f"Real-pack source is not PDF: {source}")
        actual_hash = sha256_file(source)
        actual_pages = pdf_page_count(source)
        check(actual_hash == item.get("expected_sha256"), f"Hash mismatch for {item.get('document_id')}.")
        check(actual_pages == int(item.get("expected_pages", -1)), f"Page-count mismatch for {item.get('document_id')}.")
        check(actual_hash not in source_hashes, "Fixture reuses one PDF under multiple broker houses.")
        source_hashes.add(actual_hash)
        request_documents.append({
            "document_id": item["document_id"],
            "house_id": item["house_id"],
            "house_name": item["house_name"],
            "source_id": item.get("source_id") or f"real_pack.{item['document_id']}",
            "path": str(source),
            "media_type": "application/pdf",
            "published_date": item["published_date"],
            "expected_sha256": actual_hash,
        })
        source_evidence.append({
            "document_id": item["document_id"],
            "house_id": item["house_id"],
            "sha256": actual_hash,
            "pages": actual_pages,
        })

    responses = resolve(base, manifest.get("responses"), "responses")
    check(responses.is_dir(), "responses must be a directory.")
    crosswalk = resolve(base, manifest.get("crosswalk"), "crosswalk")
    check(crosswalk.is_file(), "crosswalk must be a JSON file.")
    model_context_path = resolve(base, manifest.get("model_context"), "model_context")
    check(model_context_path.is_file(), "model_context must be a JSON file.")
    model_context = read_json(model_context_path, "model context")
    demand_graph = model_context.get("model_demand_graph") or {}
    check(
        demand_graph.get("schema_version") == "pre-broker-model-demand/1.0",
        "Real-pack model context must carry pre-broker-model-demand/1.0.",
    )
    request = {
        "schema_version": "broker-extraction-request/1.0",
        "run_id": str(manifest.get("run_id") or "real_same_issuer_multi_house_completion"),
        "model_context": model_context,
        "documents": request_documents,
    }
    request_path = output_root / "broker-extraction-request.json"
    request_path.write_text(json.dumps(request, indent=2, sort_keys=True) + "\n", "utf-8")

    controller_root = output_root / "controller"
    state, controller_attempts = invoke_controller_to_terminal(
        request_path,
        controller_root,
        responses,
        crosswalk,
    )
    artifacts = validate_terminal_state(state)
    non_terminal_mutations = prove_non_terminal_states_block(state)
    pack = read_json(artifacts["broker_pack"], "compiled broker pack")
    source_tables = read_json(artifacts["source_tables"], "broker source tables")
    receipt = read_json(artifacts["broker_crosswalk_receipt"], "broker crosswalk receipt")
    semantic = read_json(artifacts["semantic_report"], "broker semantic report")
    compiled_semantic = read_json(
        artifacts["broker_semantic_verification"],
        "pack compiler semantic report",
    )
    check(semantic.get("status") == "PASS", "Terminal controller owns a non-PASS semantic report.")
    check(int(semantic.get("total_violation_count", -1)) == 0, "Semantic PASS has non-zero violations.")
    check(compiled_semantic.get("status") == "PASS", "Pack compiler owns a non-PASS semantic report.")
    check(
        int(compiled_semantic.get("total_violation_count", -1)) == 0,
        "Pack compiler semantic PASS has non-zero violations.",
    )
    active_bundle_path = artifacts.get("verified_bundle") or artifacts["extraction_bundle"]
    check(
        receipt.get("bundle_sha256") == sha256_file(active_bundle_path),
        "Broker crosswalk receipt is not bound to the terminal active bundle.",
    )
    check(
        receipt.get("crosswalk_sha256") == sha256_file(artifacts["crosswalk"]),
        "Broker crosswalk receipt is not bound to the terminal crosswalk.",
    )
    check(
        receipt.get("independent_semantic_report_sha256")
        == sha256_file(artifacts["broker_semantic_verification"]),
        "Broker crosswalk receipt is not bound to the pack compiler semantic report.",
    )
    pack_metrics = validate_pack(pack, source_tables, receipt, house_ids)
    selected_errors = selected_cell_errors(source_tables, receipt)
    check(not selected_errors, selected_errors[0] if selected_errors else "Selected-cell proof failed.")

    mutated_sources = mutate_selected_cell(source_tables, receipt)
    mutation_errors = selected_cell_errors(mutated_sources, receipt)
    check(
        any("quarantined" in error for error in mutation_errors),
        "Selected-cell conflict mutation was not caught.",
    )
    compiler_mutation = run_selected_cell_compiler_mutation(
        active_bundle_path,
        artifacts["crosswalk"],
        receipt,
        output_root,
    )

    report = {
        "schema_version": "broker-real-pack-completion-report/1.0",
        "status": "PASS",
        "issuer": issuer,
        "manifest_sha256": sha256_file(manifest_path),
        "controller_state_sha256": sha256_file(controller_root / "broker-run-state.json"),
        "controller_status": state["pipeline_status"],
        "controller_attempts": controller_attempts,
        "fixed_point_status": state["fixed_point"]["status"],
        "source_documents": source_evidence,
        "pack": pack_metrics,
        "artifacts": {
            key: {"path": str(path), "sha256": sha256_file(path)}
            for key, path in artifacts.items()
        },
        "selected_cell_positive_count": len(mapping_cells(receipt)),
        "selected_cell_conflict_mutation": {
            **compiler_mutation,
            "caught_findings": mutation_errors,
        },
        "non_terminal_state_mutations_caught": non_terminal_mutations,
        "total_violation_count": 0,
    }
    report_path = output_root / "broker-real-pack-completion-report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({
        "status": report["status"],
        "issuer": issuer,
        "houses": pack_metrics["house_count"],
        "mappings": pack_metrics["mapping_count"],
        "selected_cells": report["selected_cell_positive_count"],
        "conflict_mutation": "CAUGHT",
        "non_terminal_states_caught": len(non_terminal_mutations),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
