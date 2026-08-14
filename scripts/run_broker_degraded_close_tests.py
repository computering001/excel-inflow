#!/usr/bin/env python3
"""End-to-end proof that exhausted ORDINARY broker ambiguity closes DEGRADED.

This regression begins BEFORE physical reconciliation and drives the real
controller (`run_broker_pipeline.py`) as a subprocess through:

    raw request -> seeded extraction -> vision responses that NEVER reconcile
    -> bounded attempt budget exhausted -> degraded close (quarantine)
    -> semantic crosswalk -> pack compilation -> terminal PASS_DEGRADED

with the delivery-blocker constitution enforced at every step: broker
uncertainty may reduce broker authority, it may never terminate delivery.
BLOCKED_INTERNAL must never appear for ordinary evidence ambiguity.

Matrix coverage in this file:
- mandatory positive (persistent conflicts -> exhaustion -> quarantine ->
  degraded close -> crosswalk -> pack -> PASS_DEGRADED, evidence preserved);
- one conflicted cell, rest of the house clean (Kepler);
- disposition disagreement quarantines the whole surface (Berenberg);
- terminal aggregate replaces targeted task, quarantine still re-arms;
- a mapping that touches a quarantined cell is refused (SEM guard);
- unresolved broker cells remain visible and formula-prohibited;
- broker uncertainty cannot emit a delivery block (constitution);
- degraded close without its quarantine receipt is an invalid closure.
- a native-pass page promoted only after canonical reconciliation may close
  evidence-only without an extraction-time vision-task artifact, but only when
  its image is hash-valid and every promotion finding is explicitly
  non-model-linked;
- model-linked or image-integrity mutations of that same page remain blocked.
"""

from __future__ import annotations

import json
import argparse
import subprocess
import sys
import tempfile
from contextlib import nullcontext
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import run_attachment_evidence_pipeline as attachment  # noqa: E402
import run_broker_pipeline as broker  # noqa: E402
from workflow_state import assert_delivery_blocker, assert_state  # noqa: E402
from verify_broker_semantics import normalized_manifest_period  # noqa: E402
from compile_broker_candidate_manifest import compile_manifest  # noqa: E402
from broker_terminal_recovery import (  # noqa: E402
    compile_reference_only_crosswalk,
    degrade_all_broker_authority,
)


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", "utf-8")


def cells(rows: list[list[str]]) -> list[list[dict[str, Any]]]:
    return [
        [
            {
                "row": row_index,
                "column": column_index,
                "raw_text": value,
                "value": value,
                "value_kind": (
                    "number"
                    if value and value.replace(".", "", 1).replace("-", "", 1).isdigit()
                    else "text" if value else "blank"
                ),
                "source_ref": f"fixture:r{row_index}c{column_index}",
            }
            for column_index, value in enumerate(row, 1)
        ]
        for row_index, row in enumerate(rows, 1)
    ]


def native_table(identifier: str, surface_id: str, rows: list[list[str]], title: str) -> dict[str, Any]:
    return {
        "table_id": identifier,
        "surface_id": surface_id,
        "source_location": f"page {surface_id.rsplit('p', 1)[-1]}",
        "title": title,
        "units": "USDm",
        "bbox": [10, 10, 300, 180],
        "extraction_method": "native_pdf_lines",
        "confidence": 1.0,
        "rows": cells(rows),
    }


def numeric_tokens(rows: list[list[str]]) -> list[str]:
    return [
        value
        for row in rows
        for value in row
        if value and any(character.isdigit() for character in value) and not value.endswith("E")
    ]


def vision_pass(
    *,
    document_id: str,
    surface_id: str,
    image_sha256: str,
    pass_index: int,
    producer: str,
    disposition: str,
    rows: list[list[str]] | None = None,
    grid: bool = True,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "schema_version": "broker-vision-result/1.0",
        "document_id": document_id,
        "surface_id": surface_id,
        "image_sha256": image_sha256,
        "pass_index": pass_index,
        "producer_id": f"{producer}-pass{pass_index}",
        "producer_fingerprint": f"{producer}-fingerprint-{pass_index}",
        "method": "vision_model" if pass_index == 1 else "ocr_geometry",
        "surface_disposition": disposition,
    }
    if disposition == "verified_non_tabular":
        result["non_tabular_reason"] = "narrative page"
        result["tables"] = []
    else:
        result["tables"] = [{
            "title": "Forecast table",
            "units": "USDm",
            "bbox": [10, 10, 300, 180],
            "rows": rows or [],
            "transcription_structure": {
                "is_grid": grid,
                "row_labels": grid,
                "period_headers": 2 if grid else 0,
            },
        }]
    return result


def build_house(
    *,
    document_id: str,
    house_id: str,
    house_name: str,
    artifact_root: Path,
    vision_required: bool,
    clean_rows: list[list[str]] | None = None,
) -> dict[str, Any]:
    """One house document. Native-clean, or one vision-required image page."""
    if not vision_required:
        rows = clean_rows or []
        tokens = numeric_tokens(rows)
        census_payload = {
            "schema_version": "broker-surface-census/1.0",
            "document_id": document_id,
            "surface_id": f"{document_id}.p1",
            "kind": "pdf_page",
            "source_numeric_tokens": tokens,
            "source_table_numeric_tokens": tokens,
            "whole_surface_numeric_token_count": len(tokens),
            "nonblank_cell_count": sum(1 for row in rows for value in row if value),
            "table_discovery_lanes": [
                {"lane_id": "native_pdf_lines", "status": "pass", "candidate_count": 1},
            ],
            "uncovered_numeric_regions": [],
            "material_uncovered_region_count": 0,
        }
        census_path = artifact_root / document_id / "p1.census.json"
        write_json(census_path, census_payload)
        surface = {
            "surface_id": f"{document_id}.p1",
            "kind": "pdf_page",
            "ordinal": 1,
            "width": 612,
            "height": 792,
            "source_table_numeric_tokens": tokens,
            "whole_surface_numeric_token_count": len(tokens),
            "native_text_chars": 420,
            "native_word_count": 80,
            "numeric_token_count": len(tokens),
            "table_count": 1,
            "image_count": 0,
            "table_discovery_lanes": [
                {"lane_id": "native_pdf_lines", "status": "pass", "candidate_count": 1},
            ],
            "uncovered_numeric_regions": [],
            "artifact_refs": [f"{document_id}-census"],
            "lane_status": {
                "native_text": "pass",
                "geometry": "pass",
                "tables": "pass",
                "images": "none",
                "vision": "not_required",
            },
            "surface_census_artifact_id": f"{document_id}-census",
        }
        return {
            "document_id": document_id,
            "house_id": house_id,
            "house_name": house_name,
            "file_name": f"{document_id}.pdf",
            "published_date": "2026-06-30",
            "media_type": "application/pdf",
            "source_id": f"fixture.{document_id}",
            "raw_sha256": "0" * 64,
            "surfaces": [surface],
            "tables": [native_table(f"{document_id}-t1", surface["surface_id"], rows, "Forecasts")],
            "artifacts": [{
                "artifact_id": f"{document_id}-census",
                "kind": "surface_census",
                "path": str(census_path.relative_to(artifact_root)),
                "sha256": broker.sha256_file(census_path),
            }],
            "numeric_ledger": {
                "source_tokens": numeric_tokens(rows),
                "captured_tokens": numeric_tokens(rows),
                "missing_tokens": [],
                "duplicate_tokens": [],
                "recall": 1.0,
            },
            "extraction_status": "complete",
        }

    surface_id = f"{document_id}.p4"
    image_path = artifact_root / document_id / "page4.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(b"\x89PNG\r\n\x1a\n" + document_id.encode("utf-8"))
    task_payload = {
        "schema_version": "broker-vision-task/1.0",
        "document_id": document_id,
        "surface_id": surface_id,
        "region_crops": [],
        "instruction": "Read the complete grid twice, independently.",
    }
    task_path = artifact_root / document_id / "page4.task.json"
    write_json(task_path, task_payload)
    census_path = artifact_root / document_id / "p4.census.json"
    write_json(census_path, {
        "schema_version": "broker-surface-census/1.0",
        "document_id": document_id,
        "surface_id": surface_id,
        "kind": "image_page",
        "source_numeric_tokens": [],
        "source_table_numeric_tokens": [],
        "whole_surface_numeric_token_count": 0,
        "nonblank_cell_count": 0,
        "table_discovery_lanes": [
            {"lane_id": "image_render", "status": "empty", "candidate_count": 0},
        ],
        "uncovered_numeric_regions": [{
            "region_id": f"{document_id}.p4.r1",
            "bbox": [10, 10, 300, 180],
            "material": True,
            "disposition": "requires_vision",
        }],
        "material_uncovered_region_count": 1,
    })
    return {
        "document_id": document_id,
        "house_id": house_id,
        "house_name": house_name,
        "file_name": f"{document_id}.pdf",
        "published_date": "2026-06-30",
        "media_type": "application/pdf",
        "source_id": f"fixture.{document_id}",
        "raw_sha256": "0" * 64,
        "surfaces": [{
            "surface_id": surface_id,
            "kind": "image_page",
            "ordinal": 4,
            "width": 612,
            "height": 792,
            "source_table_numeric_tokens": [],
            "whole_surface_numeric_token_count": 0,
            "table_count": 0,
            "native_text_chars": 0,
            "native_word_count": 0,
            "numeric_token_count": 0,
            "image_count": 1,
            "table_discovery_lanes": [
                {"lane_id": "image_render", "status": "empty", "candidate_count": 0},
            ],
            "uncovered_numeric_regions": [{
                "region_id": f"{document_id}.p4.r1",
                "bbox": [10, 10, 300, 180],
                "material": True,
                "disposition": "requires_vision",
            }],
            "lane_status": {
                "native_text": "empty",
                "geometry": "pass",
                "tables": "none",
                "images": "pass",
                "vision": "required",
            },
            "surface_census_artifact_id": f"{document_id}-census",
            "artifact_refs": [f"{document_id}-image", f"{document_id}-task"],
        }],
        "tables": [],
        "artifacts": [
            {
                "artifact_id": f"{document_id}-census",
                "kind": "surface_census",
                "path": str(census_path.relative_to(artifact_root)),
                "sha256": broker.sha256_file(census_path),
            },
            {
                "artifact_id": f"{document_id}-image",
                "kind": "page_image",
                "path": str(image_path.relative_to(artifact_root)),
                "sha256": broker.sha256_file(image_path),
            },
            {
                "artifact_id": f"{document_id}-task",
                "kind": "vision_task",
                "path": str(task_path.relative_to(artifact_root)),
                "sha256": broker.sha256_file(task_path),
            },
        ],
        "numeric_ledger": {
            "source_tokens": [],
            "captured_tokens": [],
            "missing_tokens": [],
            "duplicate_tokens": [],
            "recall": 1.0,
        },
        "extraction_status": "needs_vision",
    }


def invoke(request_path: Path, output_root: Path, responses: Path, crosswalk: Path | None) -> dict[str, Any]:
    command = [
        sys.executable,
        str(HERE / "run_broker_pipeline.py"),
        str(request_path),
        "--out",
        str(output_root),
        "--responses",
        str(responses),
    ]
    if crosswalk is not None:
        command.extend(["--crosswalk", str(crosswalk)])
    completed = subprocess.run(command, cwd=HERE, text=True, capture_output=True, check=False)
    state_path = output_root / "broker-run-state.json"
    check(state_path.is_file(), f"controller emitted no state: {completed.stderr[-2000:]}")
    return json.loads(state_path.read_text("utf-8"))


def invoke_vision(
    bundle_path: Path,
    responses: Path,
    output_path: Path,
    *,
    degrade_exhausted: bool,
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        str(HERE / "compile_broker_vision.py"),
        str(bundle_path),
        "--responses",
        str(responses),
        "--out",
        str(output_path),
    ]
    if degrade_exhausted:
        command.append("--degrade-exhausted")
    return subprocess.run(command, cwd=HERE, text=True, capture_output=True, check=False)


def invoke_canonical(bundle_path: Path, output_path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(HERE / "compile_broker_canonical_tables.py"),
            str(bundle_path),
            "--out",
            str(output_path),
        ],
        cwd=HERE,
        text=True,
        capture_output=True,
        check=False,
    )


def reference_only_crosswalk(bundle: dict[str, Any]) -> dict[str, Any]:
    """The degenerate valid review: preserve everything, consume nothing."""
    manifest = bundle.get("candidate_manifest") or {}
    table_reviews = []
    for document in bundle.get("documents", []):
        for table in document.get("tables", []):
            header = table.get("rows", [[]])[0] if table.get("rows") else []
            period_columns = []
            effective_headers = {
                int(item.get("column")): str(item.get("period_label") or "")
                for item in table.get("effective_period_headers", [])
                if item.get("column")
            }
            for cell_entry in header:
                column = int(cell_entry.get("column"))
                text = effective_headers.get(column, str(cell_entry.get("raw_text") or ""))
                if "2027" in text:
                    period_columns.append({"column": column, "period_basis": "annual_forecast", "period_index": 0})
                elif "2028" in text:
                    period_columns.append({"column": column, "period_basis": "annual_forecast", "period_index": 1})
            table_reviews.append({
                "table_id": table.get("canonical_table_id") or table.get("table_id"),
                "house_id": document.get("house_id"),
                "review_status": "reviewed",
                "rationale": "Fixture forecast grid reviewed; every candidate retained as reference-only evidence.",
                "classification": "annual_forecast",
                "header_rows": [1],
                "period_columns": period_columns,
            })
    ledger = []
    shell = {"forecast_periods": ["2027-12-31", "2028-12-31", "2029-12-31"]}
    for candidate in manifest.get("candidates", []):
        quarantined = candidate.get("authority_status") == "quarantined_conflict"
        period_basis, period_ordinals = normalized_manifest_period(candidate, shell)
        ledger.append({
            "candidate_id": candidate["candidate_id"],
            "house_id": candidate.get("house_id"),
            "table_id": candidate.get("table_id"),
            "row": candidate.get("row"),
            "label": candidate.get("label"),
            "period_basis": period_basis,
            "period_indexes": period_ordinals,
            "source_cells": [
                {"row": int(cell.get("row")), "column": int(cell.get("column"))}
                for cell in (candidate.get("source_cells") or [])
                if cell.get("row") and cell.get("column")
            ],
            "parent_candidate_id": candidate.get("parent_candidate_id"),
            "economic_domain": "operating",
            "definition_id": "dict.custom.fixture_reference",
            "concept_id": "custom.fixture_reference",
            "model_use": "unresolved" if quarantined else "reference_only",
            "definition_fingerprint": {
                "concept_id": "custom.fixture_reference",
                "measurement_basis": "reported",
                "restatement_basis": "not_applicable",
                "cash_flow_basis": "not_applicable",
                "lease_basis": "not_applicable",
                "units": "millions",
                "currency": "USD",
                "period_basis": candidate.get("period_basis"),
                "sign_convention": "as_reported",
                "accounting_basis": "ifrs",
                "operating_scope": "continuing",
            },
            "evidence_kind": "broker_estimate",
            "definition_evidence": "Fixture table caption and units row preserved verbatim from the rendered page.",
            "review_status": "reviewed",
            "rationale": "Fixture candidate retained as evidence only; nothing in this regression consumes broker values.",
            "disposition": "quarantined_conflict" if quarantined else "not_model_relevant",
        })
    def metric(concept: str, domain: str) -> dict[str, Any]:
        return {
            "definition_id": f"dict.{concept}",
            "label": concept.replace("_", " ").title(),
            "unit_kind": "currency",
            "concept_id": concept,
            "economic_domain": domain,
            "semantic_role": "operating_forecast",
            "evidence_kind": "broker_estimate",
            "model_use": "reference_only",
            "definition_fingerprint": {
                "concept_id": concept,
                "measurement_basis": "reported",
                "restatement_basis": "not_applicable",
                "cash_flow_basis": "not_applicable",
                "lease_basis": "not_applicable",
                "units": "millions",
                "currency": "USD",
                "period_basis": "annual_forecast",
                "sign_convention": "as_reported",
                "accounting_basis": "ifrs",
                "operating_scope": "continuing",
            },
        }

    return {
        "schema_version": "broker-crosswalk/1.2",
        "run_id": bundle.get("run_id") or "degraded_close_regression",
        "as_of": "2026-06-30",
        "reporting_currency": "USD",
        "units": "millions",
        "forecast_periods": ["2027-12-31", "2028-12-31", "2029-12-31"],
        "metrics": {
            "revenue": metric("revenue", "operating"),
            "ebit": metric("ebit", "operating"),
            "depreciation_and_amortisation": metric("depreciation_and_amortisation", "operating"),
            "effective_tax_rate": metric("effective_tax_rate", "operating"),
            "capex": metric("capex", "cash_flow"),
            "change_in_working_capital": metric("change_in_working_capital", "cash_flow"),
            "dividends": metric("dividends", "cash_flow"),
        },
        "table_reviews": table_reviews,
        "coverage_ledger": ledger,
        "mappings": [],
    }


def empty_evidence_only_crosswalk(bundle: dict[str, Any]) -> dict[str, Any]:
    """A zero-consumption review for a bundle whose every surface is prohibited."""
    shell = reference_only_crosswalk(bundle)
    shell["table_reviews"] = [
        {
            "table_id": table.get("canonical_table_id") or table.get("table_id"),
            "house_id": document.get("house_id"),
            "review_status": "reviewed",
            "rationale": "The extraction-owned surface disposition prohibits model use; the preserved table is evidence only.",
            "classification": "non_forecast",
            "header_rows": [],
            "period_columns": [],
        }
        for document in bundle.get("documents", [])
        for table in document.get("tables", [])
    ]
    shell["coverage_ledger"] = []
    shell["mappings"] = []
    return shell


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", help="Optional persistent artifact directory for downstream integration tests.")
    args = parser.parse_args()
    checks = 0
    grid_a = [["Metric", "2027E", "2028E"], ["Alpha series", "100", "110"], ["Beta series", "20", "22"]]
    grid_b = [["Metric", "2027E", "2028E"], ["Alpha series", "100", "110"], ["Beta series", "21", "22"]]  # one persistent cell conflict

    context = (
        nullcontext(str(Path(args.out).resolve()))
        if args.out
        else tempfile.TemporaryDirectory(prefix="excel-inflow-degraded-close-")
    )
    with context as temporary:
        root = Path(temporary)
        root.mkdir(parents=True, exist_ok=True)
        artifact_root = root / "artifacts"
        artifact_root.mkdir(parents=True)

        # --- five same-issuer houses: one clean native, two irreconcilable ---
        documents = [
            build_house(
                document_id="jpm", house_id="jpm", house_name="J.P. Morgan",
                artifact_root=artifact_root, vision_required=False,
                clean_rows=[["Metric", "2027E", "2028E"], ["Alpha series", "101", "111"], ["Beta series", "19", "21"]],
            ),
            build_house(
                document_id="kepler", house_id="kepler", house_name="Kepler Cheuvreux",
                artifact_root=artifact_root, vision_required=True,
            ),
            build_house(
                document_id="berenberg", house_id="berenberg", house_name="Berenberg",
                artifact_root=artifact_root, vision_required=True,
            ),
            build_house(
                document_id="bnp", house_id="bnp", house_name="BNP Paribas",
                artifact_root=artifact_root, vision_required=False,
                clean_rows=[["Metric", "2027E", "2028E"], ["Alpha series", "99", "108"], ["Beta series", "18", "20"]],
            ),
            build_house(
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
            document["raw_sha256"] = broker.sha256_file(source)
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
            "run_id": "degraded_close_regression",
            "documents": request_documents,
        }
        request_path = root / "broker-extraction-request.json"
        write_json(request_path, request)

        # --- seed the extraction checkpoint so the REAL controller loop runs
        #     from before physical reconciliation without needing real PDFs ---
        output_root = root / "controller"
        output_root.mkdir()
        request_digest = broker.sha256_file(request_path)
        runtime_digest, _members = broker.runtime_closure()
        sources = broker.source_hashes(request, request_path.parent)
        cache_key = broker.sha256_bytes(canonical_bytes({
            "request": request_digest,
            "sources": sources,
            "runtime": runtime_digest,
        }))
        key = cache_key[:16]
        for document in documents:
            document["byte_length"] = (source_dir / f"{document['document_id']}.pdf").stat().st_size
        bundle = {
            "schema_version": "broker-extraction-bundle/1.0",
            "run_id": request["run_id"],
            "created_at": "2026-08-13T00:00:00Z",
            "extractor_version": "fixture/1.0",
            "artifact_root": str(artifact_root),
            "documents": documents,
            "summary": {},
            "gate_status": "NEEDS_VISION",
            "findings": [],
        }
        extraction_root = output_root / f"extract-{key}"
        bundle_path = extraction_root / "broker-extraction-bundle.json"
        write_json(bundle_path, bundle)
        extract_input = broker.sha256_bytes(canonical_bytes({
            "request": request_digest, "sources": sources, "runtime": runtime_digest,
        }))
        broker.seal_checkpoint(bundle_path, output_root / f"extract-{key}.receipt.json", extract_input)

        responses = root / "responses"
        responses.mkdir()

        # Production-accurate late promotion: extraction passed natively and
        # wrote no task. Canonical token reconciliation must mint one complete,
        # deterministic task before the controller asks the model host to read
        # the rendered page. This is the primary repair; the taskless degraded
        # close below remains only for old carriers and integrity-safe recovery.
        minted_root = root / "canonical-late-promotion"
        minted_artifacts = minted_root / "artifacts"
        minted_artifacts.mkdir(parents=True)
        minted_rows = [["Metric", "FY26E", "FY27E"], ["Revenue", "100", "110"]]
        minted_document = build_house(
            document_id="minted",
            house_id="minted",
            house_name="Minted Task House",
            artifact_root=minted_artifacts,
            vision_required=False,
            clean_rows=minted_rows,
        )
        minted_surface = minted_document["surfaces"][0]
        minted_image_path = minted_artifacts / "minted" / "page1.png"
        minted_image_path.write_bytes(b"\x89PNG\r\n\x1a\ncanonical-late-promotion")
        minted_document["artifacts"].append({
            "artifact_id": "minted-image",
            "kind": "page_image",
            "path": str(minted_image_path.relative_to(minted_artifacts)),
            "sha256": broker.sha256_file(minted_image_path),
        })
        minted_surface["artifact_refs"].append("minted-image")
        minted_surface["image_count"] = 1
        # A fragmented native token is present in the whole-surface/table
        # census but absent from the structured table. This is the exact class
        # that promoted Kepler p4 and Berenberg p7 only after extraction.
        minted_surface["source_table_numeric_tokens"] = [
            *minted_surface["source_table_numeric_tokens"],
            "999",
        ]
        minted_input = {
            "schema_version": "broker-extraction-bundle/1.0",
            "run_id": "canonical-late-promotion-regression",
            "created_at": "2026-08-14T00:00:00Z",
            "extractor_version": "fixture/1.0",
            "artifact_root": str(minted_artifacts),
            "documents": [minted_document],
            "summary": {},
            "gate_status": "PASS",
            "findings": [],
        }
        minted_input_path = minted_root / "input.json"
        minted_output = minted_root / "canonical.json"
        minted_output_repeat = minted_root / "canonical-repeat.json"
        write_json(minted_input_path, minted_input)
        minted_run = invoke_canonical(minted_input_path, minted_output)
        check(minted_run.returncode == 2 and minted_output.is_file(), f"canonical late promotion did not request recovery: {minted_run.stderr[-1200:]}")
        minted_bundle = json.loads(minted_output.read_text("utf-8"))
        minted_closed_surface = minted_bundle["documents"][0]["surfaces"][0]
        minted_tasks = [
            artifact
            for artifact in minted_bundle["documents"][0]["artifacts"]
            if artifact.get("kind") == "vision_task"
            and artifact.get("artifact_id") in minted_closed_surface.get("artifact_refs", [])
        ]
        check(minted_bundle["physical_capture_receipt"]["status"] == "NEEDS_VISION", "late token mismatch did not promote the surface")
        check(minted_closed_surface["lane_status"]["vision"] == "required", "late promotion was not projected to the surface")
        check(len(minted_tasks) == 1, "late promotion did not mint exactly one task")
        minted_task_path = minted_artifacts / minted_tasks[0]["path"]
        check(minted_task_path.is_file() and broker.sha256_file(minted_task_path) == minted_tasks[0]["sha256"], "minted task is absent or unsealed")
        minted_task_payload = json.loads(minted_task_path.read_text("utf-8"))
        check(minted_task_payload.get("reason") == "late canonical physical-capture promotion", "minted task does not name its authority")
        check(minted_task_payload.get("canonical_finding_ids") == ["broker_canonical.physical_capture_reconciliation_required"], "minted task is not finding-bound")
        repeat_run = invoke_canonical(minted_input_path, minted_output_repeat)
        repeat_bundle = json.loads(minted_output_repeat.read_text("utf-8"))
        repeat_task = next(
            artifact
            for artifact in repeat_bundle["documents"][0]["artifacts"]
            if artifact.get("kind") == "vision_task"
        )
        check(repeat_run.returncode == 2 and repeat_task == minted_tasks[0], "late task is not deterministic across rebuilds")
        check(broker.canonical_recovery_artifacts_valid(minted_output), "valid canonical recovery closure was rejected")
        minted_task_bytes = minted_task_path.read_bytes()
        minted_task_path.unlink()
        check(not broker.canonical_recovery_artifacts_valid(minted_output), "missing referenced task did not invalidate cached canonical output")
        repaired_run = invoke_canonical(minted_input_path, minted_output)
        check(repaired_run.returncode == 2 and minted_task_path.read_bytes() == minted_task_bytes, "derived late task did not regenerate byte-identically")
        checks += 10

        # Canonical overlap is labelled NEEDS_RESOLUTION, but it still needs
        # two independent reads before any targeted cell adjudication exists.
        # The controller must therefore expose a real transcription task, not
        # an empty/targeted task set that can never generate a conflict ledger.
        overlap_input = json.loads(json.dumps(minted_input))
        overlap_input["documents"][0]["tables"][0]["extraction_method"] = "vision_pass1"
        overlap_table = json.loads(json.dumps(overlap_input["documents"][0]["tables"][0]))
        overlap_table["table_id"] = "minted-rendered-conflict"
        overlap_table["extraction_method"] = "vision_pass2"
        overlap_table["rows"][1][1]["raw_text"] = "101"
        overlap_table["rows"][1][1]["value"] = "101"
        overlap_input["documents"][0]["tables"].append(overlap_table)
        overlap_input_path = minted_root / "overlap-input.json"
        overlap_output = minted_root / "overlap-canonical.json"
        write_json(overlap_input_path, overlap_input)
        overlap_run = invoke_canonical(overlap_input_path, overlap_output)
        overlap_bundle = json.loads(overlap_output.read_text("utf-8"))
        overlap_tasks = broker.vision_tasks(overlap_bundle, minted_root / "empty-responses")
        check(overlap_run.returncode == 2 and overlap_bundle["physical_capture_receipt"]["status"] == "NEEDS_RESOLUTION", "rendered overlap did not enter the resolution state")
        check(overlap_bundle["physical_capture_receipt"]["pending_surface_ids"] == ["minted.p1"], "overlap surface disappeared from the pending ledger")
        check(len(overlap_tasks) == 1 and overlap_tasks[0]["task_path"], "overlap state has no concrete task artifact")
        check(overlap_tasks[0]["missing_passes"] == [1, 2], "overlap skipped required independent transcription")
        checks += 4

        # Exact live ordering: one extraction-time surface is read first; only
        # that compiler run discovers a second native-pass surface needs
        # canonical recovery. The second task must already exist in the output
        # state—this was the v60 Astra lifecycle break.
        live_root = root / "late-after-initial-vision"
        live_artifacts = live_root / "artifacts"
        live_artifacts.mkdir(parents=True)
        initial_document = build_house(
            document_id="initial",
            house_id="initial",
            house_name="Initial Vision House",
            artifact_root=live_artifacts,
            vision_required=True,
        )
        promoted_document = build_house(
            document_id="promoted",
            house_id="promoted",
            house_name="Promoted House",
            artifact_root=live_artifacts,
            vision_required=False,
            clean_rows=minted_rows,
        )
        promoted_surface = promoted_document["surfaces"][0]
        promoted_image_path = live_artifacts / "promoted" / "page1.png"
        promoted_image_path.write_bytes(b"\x89PNG\r\n\x1a\nlive-late-promotion")
        promoted_document["artifacts"].append({
            "artifact_id": "promoted-image",
            "kind": "page_image",
            "path": str(promoted_image_path.relative_to(live_artifacts)),
            "sha256": broker.sha256_file(promoted_image_path),
        })
        promoted_surface["artifact_refs"].append("promoted-image")
        promoted_surface["image_count"] = 1
        promoted_surface["source_table_numeric_tokens"] = [
            *promoted_surface["source_table_numeric_tokens"],
            "999",
        ]
        live_bundle_path = live_root / "input.json"
        write_json(live_bundle_path, {
            "schema_version": "broker-extraction-bundle/1.0",
            "run_id": "late-after-initial-vision-regression",
            "created_at": "2026-08-14T00:00:00Z",
            "extractor_version": "fixture/1.0",
            "artifact_root": str(live_artifacts),
            "documents": [initial_document, promoted_document],
            "summary": {},
            "gate_status": "NEEDS_VISION",
            "findings": [],
        })
        live_responses = live_root / "responses"
        live_responses.mkdir()
        initial_surface = initial_document["surfaces"][0]
        initial_image = next(item for item in initial_document["artifacts"] if item["kind"] == "page_image")
        for pass_index, producer in ((1, "live-alpha"), (2, "live-beta")):
            write_json(
                live_responses / f"{initial_surface['surface_id']}.pass{pass_index}.json",
                vision_pass(
                    document_id="initial",
                    surface_id=initial_surface["surface_id"],
                    image_sha256=initial_image["sha256"],
                    pass_index=pass_index,
                    producer=producer,
                    disposition="verified_non_tabular",
                ),
            )
        live_output = live_root / "after-initial.json"
        live_run = invoke_vision(live_bundle_path, live_responses, live_output, degrade_exhausted=False)
        check(live_run.returncode == 2 and live_output.is_file(), f"initial vision did not expose late promotion: {live_run.stderr[-1200:]}")
        live_bundle = json.loads(live_output.read_text("utf-8"))
        live_promoted = next(item for item in live_bundle["documents"] if item["document_id"] == "promoted")
        live_promoted_surface = live_promoted["surfaces"][0]
        live_task = next(
            (
                artifact for artifact in live_promoted["artifacts"]
                if artifact.get("kind") == "vision_task"
                and artifact.get("artifact_id") in live_promoted_surface.get("artifact_refs", [])
            ),
            None,
        )
        check(live_bundle.get("gate_status") == "NEEDS_VISION", "late promotion after initial vision did not remain resumable")
        check(live_promoted_surface["lane_status"]["vision"] == "required", "live late surface was not activated")
        check(live_task is not None, "live late surface repeated the v60 task_path:null defect")
        check(
            live_task is not None
            and (live_artifacts / live_task["path"]).is_file()
            and broker.sha256_file(live_artifacts / live_task["path"]) == live_task["sha256"],
            "live late task is not byte-bound",
        )
        checks += 5

        # Exact production seam: a page passed native extraction, so extraction
        # emitted no vision_task. Canonical token reconciliation later promoted
        # it to vision-required. A valid rendered page and an explicitly
        # non-model-linked canonical finding are enough to close it as
        # model-prohibited evidence after the bounded budget; the impossible
        # extraction-time task must not stop the entire company model.
        late_root = root / "late-promotion"
        late_artifacts = late_root / "artifacts"
        late_artifacts.mkdir(parents=True)
        late_document = build_house(
            document_id="late",
            house_id="late",
            house_name="Late Promotion House",
            artifact_root=late_artifacts,
            vision_required=True,
        )
        late_surface = late_document["surfaces"][0]
        late_document["artifacts"] = [
            item for item in late_document["artifacts"] if item["kind"] != "vision_task"
        ]
        late_surface["artifact_refs"] = [
            item for item in late_surface["artifact_refs"] if not item.endswith("-task")
        ]
        late_bundle = {
            "schema_version": "broker-extraction-bundle/1.0",
            "run_id": "late-promotion-regression",
            "created_at": "2026-08-14T00:00:00Z",
            "extractor_version": "fixture/1.0",
            "artifact_root": str(late_artifacts),
            "documents": [late_document],
            "summary": {},
            "gate_status": "NEEDS_VISION",
            "findings": [],
            "canonical_findings": [{
                "id": "broker_canonical.physical_capture_reconciliation_required",
                "severity": "needs_vision",
                "scope": "physical_capture",
                "model_linked": False,
                "document_id": "late",
                "surface_id": late_surface["surface_id"],
                "message": "Native token multiplicity requires a rendered recovery pass.",
            }],
        }
        late_bundle_path = late_root / "late-bundle.json"
        late_responses = late_root / "responses"
        late_responses.mkdir()
        write_json(late_bundle_path, late_bundle)
        late_image = next(item for item in late_document["artifacts"] if item["kind"] == "page_image")
        for pass_index, producer in ((1, "late-alpha"), (2, "late-beta")):
            write_json(
                late_responses / f"{late_surface['surface_id']}.pass{pass_index}.json",
                vision_pass(
                    document_id="late",
                    surface_id=late_surface["surface_id"],
                    image_sha256=late_image["sha256"],
                    pass_index=pass_index,
                    producer=producer,
                    disposition="verified_non_tabular",
                ),
            )
        late_output = late_root / "late-closed.json"
        late_run = invoke_vision(
            late_bundle_path,
            late_responses,
            late_output,
            degrade_exhausted=True,
        )
        check(late_run.returncode == 0 and late_output.is_file(), f"taskless late promotion did not close: {late_run.stderr[-1200:]}")
        late_closed = json.loads(late_output.read_text("utf-8"))
        late_closed_surface = late_closed["documents"][0]["surfaces"][0]
        late_quarantine = late_closed_surface.get("quarantine") or {}
        check(late_closed.get("gate_status") == "PASS", "taskless late promotion did not reach PASS")
        check(late_closed_surface.get("vision_disposition") == "quarantined_evidence_only", "taskless late promotion was not quarantined evidence-only")
        check(late_quarantine.get("model_use") == "prohibited", "taskless late promotion remained model-eligible")
        check(late_quarantine.get("task_artifact_status") == "late_promotion_absent", "taskless closure did not name its late-promotion basis")
        check(late_quarantine.get("page_image_sha256") == late_image["sha256"], "taskless closure was not image-bound")
        check(late_quarantine.get("finding_ids") == ["broker_canonical.physical_capture_reconciliation_required"], "taskless closure was not finding-bound")
        check(len(late_quarantine.get("response_sha256s") or []) == 2, "taskless closure did not preserve both response hashes")
        checks += 7

        # Negative mutation: the identical page may not degrade when the
        # canonical finding says it is model-linked.
        linked_bundle = json.loads(json.dumps(late_bundle))
        linked_bundle["canonical_findings"][0]["model_linked"] = True
        linked_bundle_path = late_root / "late-model-linked.json"
        linked_output = late_root / "late-model-linked-output.json"
        write_json(linked_bundle_path, linked_bundle)
        linked_run = invoke_vision(
            linked_bundle_path,
            late_responses,
            linked_output,
            degrade_exhausted=True,
        )
        linked_result = json.loads(linked_output.read_text("utf-8"))
        check(linked_run.returncode != 0 and linked_result.get("gate_status") == "BLOCKED", "model-linked late promotion was degraded")
        check(
            any(item.get("id") == "broker_vision.task_missing" for item in linked_result.get("findings", [])),
            "model-linked mutation did not fail at the taskless safety boundary",
        )
        checks += 2

        # Integrity mutation: even a non-model-linked page may not degrade if
        # its preserved page image is gone or changed.
        late_image_path = late_artifacts / late_image["path"]
        late_image_bytes = late_image_path.read_bytes()
        late_image_path.unlink()
        missing_image_output = late_root / "late-missing-image-output.json"
        missing_image_run = invoke_vision(
            late_bundle_path,
            late_responses,
            missing_image_output,
            degrade_exhausted=True,
        )
        missing_image_result = json.loads(missing_image_output.read_text("utf-8"))
        check(missing_image_run.returncode != 0 and missing_image_result.get("gate_status") == "BLOCKED", "missing page image was degraded")
        check(
            any(item.get("id") == "broker_vision.page_image_hash_mismatch" for item in missing_image_result.get("findings", [])),
            "missing-image mutation did not fail at image integrity",
        )
        late_image_path.write_bytes(late_image_bytes)
        checks += 2

        # First contact: the controller must ask for vision work, not block.
        state = invoke(request_path, output_root, responses, None)
        check(state["pipeline_status"] == "NEEDS_VISION", f"expected NEEDS_VISION, got {state['pipeline_status']}")
        check(state["user_blocking"] is False, "vision work leaked as a user ask")
        checks += 2

        # Supply PERSISTENTLY irreconcilable responses:
        # - kepler: two structurally-agreed grids with one conflicting EBIT cell
        #   and no valid resolution, ever (one conflicted cell, rest clean);
        # - berenberg: the passes disagree tabular-vs-non (whole-surface doubt).
        kepler_image_sha = next(
            artifact["sha256"] for artifact in documents[1]["artifacts"] if artifact["kind"] == "page_image"
        )
        berenberg_image_sha = next(
            artifact["sha256"] for artifact in documents[2]["artifacts"] if artifact["kind"] == "page_image"
        )
        write_json(responses / "kepler.p4.pass1.json", vision_pass(
            document_id="kepler", surface_id="kepler.p4", image_sha256=kepler_image_sha,
            pass_index=1, producer="alpha", disposition="analytical_tables", rows=grid_a,
        ))
        write_json(responses / "kepler.p4.pass2.json", vision_pass(
            document_id="kepler", surface_id="kepler.p4", image_sha256=kepler_image_sha,
            pass_index=2, producer="beta", disposition="analytical_tables", rows=grid_b,
        ))
        write_json(responses / "berenberg.p4.pass1.json", vision_pass(
            document_id="berenberg", surface_id="berenberg.p4", image_sha256=berenberg_image_sha,
            pass_index=1, producer="alpha", disposition="analytical_tables", rows=grid_a,
        ))
        write_json(responses / "berenberg.p4.pass2.json", vision_pass(
            document_id="berenberg", surface_id="berenberg.p4", image_sha256=berenberg_image_sha,
            pass_index=2, producer="beta", disposition="verified_non_tabular",
        ))

        statuses = []
        crosswalk_path: Path | None = None
        final_state: dict[str, Any] = {}
        for attempt in range(1, 12):
            final_state = invoke(request_path, output_root, responses, crosswalk_path)
            status = final_state["pipeline_status"]
            statuses.append(status)
            check(status != "BLOCKED_INTERNAL", (
                "ordinary evidence ambiguity terminated the lane: "
                + json.dumps(final_state.get("summary", {}))[:400]
            ))
            check(final_state["user_blocking"] is False, f"{status} leaked as a user ask")
            if status == "NEEDS_CROSSWALK":
                verified = json.loads(Path(final_state["artifacts"]["verified_bundle"]).read_text("utf-8"))
                crosswalk_path = root / "crosswalk.json"
                write_json(crosswalk_path, reference_only_crosswalk(verified))
            if status in {"PASS", "PASS_DEGRADED"}:
                break
        check(final_state["pipeline_status"] == "PASS_DEGRADED", f"terminal status was {final_state['pipeline_status']} after {statuses}")
        checks += 3

        summary = final_state.get("summary", {})
        check(summary.get("degraded") is True, "terminal summary does not disclose degradation")
        check(
            int(summary.get("quarantined_surface_count", 0)) >= 1,
            "whole-surface quarantine was not recorded",
        )
        check(
            int(summary.get("quarantined_conflict_count", 0)) >= 1,
            "cell quarantine was not recorded",
        )
        checks += 3

        # Evidence preservation and authority separation.
        degraded_bundle = json.loads(Path(final_state["artifacts"]["verified_bundle"]).read_text("utf-8"))
        by_document = {item["document_id"]: item for item in degraded_bundle["documents"]}
        berenberg_surface = by_document["berenberg"]["surfaces"][0]
        check(
            berenberg_surface.get("vision_disposition") == "quarantined_evidence_only",
            "the irreconcilable surface was not quarantined",
        )
        check(
            (berenberg_surface.get("quarantine") or {}).get("model_use") == "prohibited",
            "the quarantined surface does not prohibit model use",
        )
        kepler_cells = [
            cell
            for table in by_document["kepler"].get("tables", [])
            for row in table.get("rows", [])
            for cell in row
        ]
        check(
            any(cell.get("authority_status") == "quarantined_conflict" for cell in kepler_cells),
            "the persistently conflicted cell was not quarantined",
        )
        check(
            any(cell.get("authority_status") != "quarantined_conflict" for cell in kepler_cells),
            "clean sibling cells did not survive the cell quarantine",
        )
        manifest = degraded_bundle.get("candidate_manifest") or {}
        quarantined_candidates = [
            candidate for candidate in manifest.get("candidates", [])
            if candidate.get("authority_status") == "quarantined_conflict"
        ]
        berenberg_candidates = [
            candidate for candidate in manifest.get("candidates", [])
            if candidate.get("house_id") == "berenberg"
        ]
        check(not berenberg_candidates, "a quarantined surface manufactured candidates")
        checks += 5

        # A future pack may have no usable broker candidate at all. That is a
        # lawful all-evidence-only lane, not a reason to prevent the company
        # forecast waterfall from building a model. Prove the exact semantic
        # and pack chain, then prove a fabricated active mapping is rejected.
        empty_root = root / "all-evidence-only"
        empty_root.mkdir()
        empty_bundle = json.loads(json.dumps(degraded_bundle))
        for document in empty_bundle.get("documents", []):
            for surface in document.get("surfaces", []):
                surface["vision_disposition"] = "quarantined_evidence_only"
                surface["quarantine"] = {
                    "model_use": "prohibited",
                    "reason_id": "all_surface_regression",
                    "scope": "surface",
                }
        empty_bundle["candidate_manifest"] = compile_manifest(empty_bundle)
        check(empty_bundle["candidate_manifest"]["candidates"] == [], "all-evidence-only manifest was not empty")
        empty_bundle["canonical_tables_sha256"] = empty_bundle["candidate_manifest"]["canonical_tables_sha256"]
        empty_bundle_path = empty_root / "verified-bundle.json"
        write_json(empty_bundle_path, empty_bundle)
        empty_crosswalk = empty_evidence_only_crosswalk(empty_bundle)
        empty_crosswalk_path = empty_root / "crosswalk.json"
        write_json(empty_crosswalk_path, empty_crosswalk)
        semantic_path = empty_root / "semantic.json"
        semantic_run = subprocess.run([
            sys.executable, str(HERE / "verify_broker_semantics.py"),
            str(empty_bundle_path), str(empty_crosswalk_path), "--out", str(semantic_path),
        ], cwd=HERE, text=True, capture_output=True, check=False)
        empty_semantic = json.loads(semantic_path.read_text("utf-8"))
        check(semantic_run.returncode == 0 and empty_semantic.get("status") == "PASS", f"empty semantic lane blocked: {empty_semantic}")
        empty_pack_root = empty_root / "compiled"
        pack_run = subprocess.run([
            sys.executable, str(HERE / "compile_broker_pack.py"),
            str(empty_bundle_path), str(empty_crosswalk_path), "--out", str(empty_pack_root),
        ], cwd=HERE, text=True, capture_output=True, check=False)
        check(pack_run.returncode == 0, f"empty pack compilation blocked: {pack_run.stderr[-1200:]}")
        empty_pack = json.loads((empty_pack_root / "broker-pack.json").read_text("utf-8"))
        empty_receipt = json.loads((empty_pack_root / "broker-crosswalk-receipt.json").read_text("utf-8"))
        check(empty_receipt.get("mapping_count") == 0 and empty_receipt.get("coverage_ledger") == [], "empty pack invented authority")
        check(all(house.get("eligibility") == "reference_only" for house in empty_pack.get("houses", [])), "empty pack made a house eligible")
        check(empty_pack.get("eligibility_summary", {}).get("run_can_continue_without_broker_question") is True, "empty pack did not defer safely to the forecast waterfall")

        hostile_empty = json.loads(json.dumps(empty_crosswalk))
        hostile_empty["mappings"] = [{
            "mapping_id": "hostile.empty.mapping",
            "house_id": empty_bundle["documents"][0]["house_id"],
            "metric_id": "revenue",
            "definition_id": "dict.revenue",
            "period_index": 0,
            "sources": [{"table_id": empty_bundle["documents"][0]["tables"][0]["table_id"], "row": 2, "column": 2, "coefficient": 1}],
            "constant": 0,
            "multiplier": 1,
            "rationale": "Hostile attempt to reactivate an evidence-only surface.",
            "review_status": "reviewed",
        }]
        hostile_empty_path = empty_root / "hostile-crosswalk.json"
        write_json(hostile_empty_path, hostile_empty)
        hostile_semantic_path = empty_root / "hostile-semantic.json"
        hostile_semantic_run = subprocess.run([
            sys.executable, str(HERE / "verify_broker_semantics.py"),
            str(empty_bundle_path), str(hostile_empty_path), "--out", str(hostile_semantic_path),
        ], cwd=HERE, text=True, capture_output=True, check=False)
        hostile_semantic = json.loads(hostile_semantic_path.read_text("utf-8"))
        check(hostile_semantic_run.returncode != 0 and any(item.get("code") == "SEM-EMPTY-AUTHORITY-ACTIVE" for item in hostile_semantic.get("findings", [])), "hostile empty mapping was not rejected")
        checks += 7

        # A crosswalk that tries to ACTIVATE a quarantined candidate is refused.
        if quarantined_candidates:
            hostile = reference_only_crosswalk(degraded_bundle)
            for entry in hostile["coverage_ledger"]:
                if entry["disposition"] == "quarantined_conflict":
                    entry["disposition"] = "mapped"
                    entry["model_use"] = "selected_value"
            hostile_path = root / "hostile-crosswalk.json"
            write_json(hostile_path, hostile)
            semantic_out = root / "hostile-semantic.json"
            subprocess.run(
                [
                    sys.executable, str(HERE / "verify_broker_semantics.py"),
                    str(final_state["artifacts"]["verified_bundle"]), str(hostile_path),
                    "--out", str(semantic_out),
                ],
                cwd=HERE, text=True, capture_output=True, check=False,
            )
            hostile_report = json.loads(semantic_out.read_text("utf-8"))
            check(hostile_report.get("status") != "PASS", "a quarantined cell was allowed into a model mapping")
            check(
                any("SEM-QUARANTINED-CANDIDATE-ACTIVE" == item.get("finding_id") or "SEM-QUARANTINED" in str(item)
                    for item in hostile_report.get("findings", [])),
                "quarantine activation was not named",
            )
            checks += 2

        # Workflow contract: PASS_DEGRADED is a legal, closed, non-blocking state.
        assert_state("broker", "PASS_DEGRADED", None, False)
        checks += 1

        # Attachment layer: a degraded broker lane is CLOSED...
        lanes = {"broker": dict(final_state)}
        status, blocker, user_blocking = attachment.classify(lanes)
        check(status == "PASS" and blocker is None and user_blocking is False, "attachment did not accept the degraded closed lane")
        checks += 1

        # --- the REAL JS ingress gate (compileBrokerEvidence), the segment a
        #     degraded close crosses next on the way to case compilation. The
        #     lawful close must be ACCEPTED and a receipt-stripped close must
        #     be REFUSED by the production gate itself, not by a re-derived
        #     boolean. ---
        artifacts_map = final_state["artifacts"]
        source_tables_json = json.loads(Path(artifacts_map["source_tables"]).read_text("utf-8"))
        pack_json = json.loads(Path(artifacts_map["broker_pack"]).read_text("utf-8"))
        pack_house_by_id = {h["house_id"]: h for h in pack_json.get("houses", [])}
        source_inventory = []
        attachments = {}
        for house in source_tables_json.get("houses", []):
            pack_house = pack_house_by_id.get(house.get("house_id"), {})
            source_inventory.append({
                "source_id": house.get("source_id"),
                "kind": "user_broker_research",
                "status": "used",
                "text_extractable": (pack_house.get("document") or {}).get("text_extractable"),
            })
            attachments[house.get("source_id")] = {
                "raw_sha256": house.get("content_sha256"),
                "file_name": house.get("file_name"),
            }
        driver = root / "ingress-driver.mjs"
        driver.write_text(
            'import { compileBrokerEvidence } from '
            + json.dumps((HERE / "lib" / "attachment_ingress.mjs").as_uri())
            + ';\n'
            'import fs from "node:fs/promises";\n'
            'const config = JSON.parse(await fs.readFile(process.argv[2], "utf8"));\n'
            'const evidence = {\n'
            '  broker_pack: JSON.parse(await fs.readFile(config.broker_pack_path, "utf8")),\n'
            '  source_inventory: config.source_inventory,\n'
            '  case_evidence: { lanes: {} },\n'
            '};\n'
            'const sourceAttachment = new Map(Object.entries(config.attachments));\n'
            'try {\n'
            '  await compileBrokerEvidence({\n'
            '    declaration: config.declaration,\n'
            '    specDir: config.spec_dir,\n'
            '    evidence,\n'
            '    sourceAttachment,\n'
            '  });\n'
            '  const lane = evidence.case_evidence.lanes.broker_pack ?? {};\n'
            '  console.log(JSON.stringify({\n'
            '    ok: true,\n'
            '    raw_table_house_count: (lane.raw_tables ?? []).length,\n'
            '    mapping_count: (lane.source_mappings ?? []).length,\n'
            '    controller_status: evidence.case_evidence.lanes.broker_evidence?.controller_state?.pipeline_status ?? null,\n'
            '  }));\n'
            '} catch (error) {\n'
            '  console.log(JSON.stringify({ ok: false, message: String(error.message) }));\n'
            '  process.exitCode = 1;\n'
            '}\n',
            "utf-8",
        )

        def run_ingress(state_file: Path) -> dict[str, Any]:
            config_path = root / f"ingress-config-{state_file.stem}.json"
            write_json(config_path, {
                "broker_pack_path": artifacts_map["broker_pack"],
                "source_inventory": source_inventory,
                "attachments": attachments,
                "spec_dir": str(root),
                "declaration": {
                    "run_state_path": str(state_file),
                    "extraction_bundle_path": artifacts_map["verified_bundle"],
                    "source_tables_path": artifacts_map["source_tables"],
                    "crosswalk_path": artifacts_map["crosswalk"],
                    "crosswalk_receipt_path": artifacts_map["broker_crosswalk_receipt"],
                    "semantic_verification_path": artifacts_map["semantic_report"],
                },
            })
            completed = subprocess.run(
                ["node", str(driver), str(config_path)],
                cwd=HERE, text=True, capture_output=True, check=False,
            )
            check(completed.stdout.strip() != "", f"ingress driver emitted nothing: {completed.stderr[-1500:]}")
            return json.loads(completed.stdout)

        accepted = run_ingress(output_root / "broker-run-state.json")
        check(accepted.get("ok") is True, f"the JS ingress refused the lawful degraded close: {accepted.get('message')}")
        check(accepted.get("controller_status") == "PASS_DEGRADED", "the degraded controller state was not projected into case evidence")
        check(int(accepted.get("raw_table_house_count", 0)) == 5, "ingress did not preserve every house in raw_tables")
        checks += 3

        # ...and only WITH its quarantine receipts (closure integrity, enforced
        # by the production gate).
        stripped = json.loads(Path(output_root / "broker-run-state.json").read_text("utf-8"))
        stripped["artifacts"].pop("degraded_close_receipt", None)
        stripped["artifact_sha256"].pop("degraded_close_receipt", None)
        stripped_path = output_root / "broker-run-state-stripped.json"
        write_json(stripped_path, stripped)
        refused = run_ingress(stripped_path)
        check(refused.get("ok") is False, "a receipt-stripped degraded close was accepted by the JS ingress")
        check(
            "degraded_close_receipt" in str(refused.get("message")),
            f"the stripped-closure refusal is unnamed: {refused.get('message')}",
        )
        checks += 2

        tampered_receipt = Path(artifacts_map["degraded_close_receipt"])
        original_receipt_bytes = tampered_receipt.read_bytes()
        tampered_payload = json.loads(original_receipt_bytes)
        tampered_payload["model_consumption_added"] = 1
        write_json(tampered_receipt, tampered_payload)
        refused_receipt = run_ingress(output_root / "broker-run-state.json")
        check(
            refused_receipt.get("ok") is False,
            "a byte-tampered degraded-close receipt was accepted by JS ingress",
        )
        check(
            "hash-owned" in str(refused_receipt.get("message")),
            f"the degraded-close receipt hash mutation was unnamed: {refused_receipt.get('message')}",
        )
        tampered_receipt.write_bytes(original_receipt_bytes)
        checks += 2

        tampered_graph = json.loads(
            Path(output_root / "broker-run-state.json").read_text("utf-8")
        )
        tampered_graph["work_graph"]["graph_sha256"] = "0" * 64
        tampered_graph_path = output_root / "broker-run-state-graph-tampered.json"
        write_json(tampered_graph_path, tampered_graph)
        refused_graph = run_ingress(tampered_graph_path)
        check(
            refused_graph.get("ok") is False,
            "a degraded close with a tampered work graph was accepted by JS ingress",
        )
        check(
            "work graph hash" in str(refused_graph.get("message")),
            f"the graph-tamper refusal is unnamed: {refused_graph.get('message')}",
        )
        checks += 2

        # The re-arm defect itself: an aggregate terminal task must count as
        # prior targeted resolution so the quarantine fallback stays armed.
        check(
            broker.prior_targeted_resolution_attempted({
                "tasks": [{"task_kind": "internal_fixed_point_defect"}],
            }),
            "the aggregate defect no longer re-arms the quarantine fallback",
        )
        check(
            broker.bounded_recovery_exhausted(
                {"tasks": [{"task_kind": "internal_fixed_point_defect"}]},
                {"vision_attempt_count": 0, "vision_attempt_limit": 3},
            ),
            "an aggregate terminal task did not register as exhaustion",
        )
        checks += 2

        # Constitution: broker uncertainty can NEVER be a delivery blocker.
        for domain in ("broker_capture", "broker_table_reconciliation", "broker_semantics", "broker_coverage"):
            try:
                assert_delivery_blocker(True, "workbook_delivery_failed", domain=domain)
            except ValueError:
                pass
            else:
                raise AssertionError(f"{domain} was accepted as a delivery blocker")
        checks += 1

        # Universal circuit breaker: even a globally unusable semantic review
        # preserves the complete archive, selects zero values, and passes both
        # the independent semantic oracle and the real pack compiler.
        zero_bundle_path = Path(final_state["artifacts"]["verified_bundle"])
        zero_source_crosswalk_path = Path(final_state["artifacts"]["crosswalk"])
        zero_bundle = json.loads(zero_bundle_path.read_text("utf-8"))
        zero_source_crosswalk = json.loads(zero_source_crosswalk_path.read_text("utf-8"))
        reference_shell = compile_reference_only_crosswalk(zero_bundle, {
            "as_of": "2026-06-30",
            "reporting_currency": "USD",
            "units": "millions",
            "forecast_periods": ["2027-12-31", "2028-12-31", "2029-12-31"],
        })
        check(reference_shell.get("mappings") == [], "reference-only shell invented a mapping")
        check(
            all(item.get("model_use") == "reference_only" for item in reference_shell.get("metrics", {}).values()),
            "reference-only shell promoted a metric",
        )
        zero_crosswalk, zero_receipt, _ = degrade_all_broker_authority(
            bundle=zero_bundle,
            crosswalk=reference_shell,
            bundle_sha256=broker.sha256_file(zero_bundle_path),
            source_crosswalk_sha256=broker.sha256_bytes(canonical_bytes(reference_shell)),
            reason="Regression-forced global semantic failure.",
        )
        zero_crosswalk_path = root / "zero-authority-crosswalk.json"
        write_json(zero_crosswalk_path, zero_crosswalk)
        zero_semantic_path = root / "zero-authority-semantic.json"
        zero_verify = subprocess.run(
            [
                sys.executable,
                str(HERE / "verify_broker_semantics.py"),
                str(zero_bundle_path),
                str(zero_crosswalk_path),
                "--out",
                str(zero_semantic_path),
            ],
            cwd=HERE,
            text=True,
            capture_output=True,
            check=False,
        )
        check(zero_verify.returncode == 0, zero_verify.stderr or zero_verify.stdout)
        zero_semantic = json.loads(zero_semantic_path.read_text("utf-8"))
        check(zero_semantic.get("status") == "PASS", "zero-authority semantic oracle did not pass")
        check(zero_crosswalk.get("mappings") == [], "zero-authority fallback retained a mapping")
        check(
            len((zero_crosswalk.get("terminal_recovery") or {}).get("quarantined_candidates", []))
            == len((zero_bundle.get("candidate_manifest") or {}).get("candidates", [])),
            "zero-authority fallback did not preserve every immutable candidate",
        )
        check(zero_receipt.get("model_consumption_added") == 0, "zero-authority fallback added model use")
        zero_pack_root = root / "zero-authority-pack"
        zero_compile = subprocess.run(
            [
                sys.executable,
                str(HERE / "compile_broker_pack.py"),
                str(zero_bundle_path),
                str(zero_crosswalk_path),
                "--out",
                str(zero_pack_root),
            ],
            cwd=HERE,
            text=True,
            capture_output=True,
            check=False,
        )
        check(zero_compile.returncode == 0, zero_compile.stderr or zero_compile.stdout)
        check((zero_pack_root / "broker-pack.json").is_file(), "zero-authority pack was not emitted")
        checks += 8

        if args.out:
            write_json(root / "degraded-close-test-output.json", {
                "schema_version": "broker-degraded-close-test-output/1.0",
                "status": "PASS",
                "controller_state_path": str((output_root / "broker-run-state.json").resolve()),
                "degraded_artifacts": {
                    "extraction_bundle_path": str(Path(final_state["artifacts"]["verified_bundle"]).resolve()),
                    "crosswalk_path": str(Path(final_state["artifacts"]["crosswalk"]).resolve()),
                    "semantic_report_path": str(Path(final_state["artifacts"]["semantic_report"]).resolve()),
                    "broker_pack_path": str(Path(final_state["artifacts"]["broker_pack"]).resolve()),
                    "source_tables_path": str(Path(final_state["artifacts"]["source_tables"]).resolve()),
                    "crosswalk_receipt_path": str(Path(final_state["artifacts"]["broker_crosswalk_receipt"]).resolve()),
                },
                "all_evidence_only": {
                    "extraction_bundle_path": str(empty_bundle_path.resolve()),
                    "crosswalk_path": str(empty_crosswalk_path.resolve()),
                    "semantic_report_path": str(semantic_path.resolve()),
                    "broker_pack_path": str((empty_pack_root / "broker-pack.json").resolve()),
                    "source_tables_path": str((empty_pack_root / "broker-source-tables.json").resolve()),
                    "crosswalk_receipt_path": str((empty_pack_root / "broker-crosswalk-receipt.json").resolve()),
                },
            })

    print(json.dumps({"status": "PASS", "checks": checks, "statuses": statuses}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
