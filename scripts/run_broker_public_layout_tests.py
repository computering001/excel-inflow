#!/usr/bin/env python3
"""Exercise broker ingestion against an external corpus of public real layouts.

The corpus and PDFs deliberately live outside the skill tree. This test proves
that ordinary readable research never becomes a user-blocking input failure,
that every page enters the immutable evidence inventory, and that any remaining
vision work is expressed as resumable internal tasks with high-resolution
region crops. It does not treat public research as model authority and does not
require a reviewed semantic crosswalk.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text("utf-8"))
    if not isinstance(value, dict):
        raise AssertionError(f"Expected one JSON object at {path}.")
    return value


def pdf_page_count(path: Path) -> int:
    import fitz  # type: ignore

    with fitz.open(path) as document:
        return document.page_count


def invoke(request_path: Path, output_root: Path) -> tuple[int, dict[str, Any]]:
    completed = subprocess.run(
        [sys.executable, str(HERE / "run_broker_pipeline.py"), str(request_path), "--out", str(output_root)],
        cwd=HERE,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode not in {0, 2}:
        raise AssertionError(completed.stderr or completed.stdout)
    state_path = output_root / "broker-run-state.json"
    if not state_path.is_file():
        raise AssertionError("The broker controller did not emit broker-run-state.json.")
    return completed.returncode, read_json(state_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", required=True, help="External public-layout corpus manifest")
    parser.add_argument("--out", required=True, help="Disposable evidence output directory")
    args = parser.parse_args()

    corpus_path = Path(args.corpus).resolve()
    output_root = Path(args.out).resolve()
    if output_root.exists():
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True)

    corpus = read_json(corpus_path)
    assert corpus.get("schema_version") == "public-broker-layout-corpus/1.0"
    documents = corpus.get("documents")
    assert isinstance(documents, list) and 5 <= len(documents) <= 10
    required_house_count = int(corpus.get("required_distinct_house_count", 5))
    assert 2 <= required_house_count <= 10
    assert len({item["house_id"] for item in documents}) >= required_house_count

    request_documents: list[dict[str, Any]] = []
    corpus_checks: list[dict[str, Any]] = []
    for item in documents:
        source = (corpus_path.parent / item["path"]).resolve()
        assert source.is_file(), f"Corpus source is absent: {source}"
        actual_hash = sha256_file(source)
        actual_pages = pdf_page_count(source)
        assert actual_hash == item["expected_sha256"], item["document_id"]
        assert actual_pages == item["expected_pages"], item["document_id"]
        request_documents.append({
            "document_id": item["document_id"],
            "house_id": item["house_id"],
            "house_name": item["house_name"],
            "source_id": f"public_test.{item['document_id']}",
            "path": str(source),
            "media_type": "application/pdf",
            "published_date": item["published_date"],
            "expected_sha256": actual_hash,
        })
        corpus_checks.append({
            "document_id": item["document_id"],
            "house_id": item["house_id"],
            "issuer": item["issuer"],
            "pages": actual_pages,
            "sha256": actual_hash,
            "layout_archetypes": item["layout_archetypes"],
        })

    request = {
        "schema_version": "broker-extraction-request/1.0",
        "run_id": "public_broker_layout_corpus_20260812",
        "documents": request_documents,
    }
    request_path = output_root / "broker-extraction-request.json"
    request_path.write_text(json.dumps(request, indent=2, sort_keys=True) + "\n", "utf-8")

    first_code, first_state = invoke(request_path, output_root / "controller")
    assert first_code == 2
    assert first_state["pipeline_status"] in {"NEEDS_VISION", "NEEDS_CROSSWALK"}
    assert first_state["user_blocking"] is False

    extraction_path = Path(first_state["artifacts"]["extraction_bundle"])
    bundle = read_json(extraction_path)
    assert bundle["gate_status"] in {"NEEDS_VISION", "PASS"}
    assert len(bundle["documents"]) == len(documents)
    by_document = {item["document_id"]: item for item in bundle["documents"]}

    extraction_checks: list[dict[str, Any]] = []
    total_pages = 0
    total_vision_surfaces = 0
    total_region_crops = 0
    total_native_evidence_only_surfaces = 0
    for expected in documents:
        extracted = by_document[expected["document_id"]]
        surfaces = extracted["surfaces"]
        assert len(surfaces) == expected["expected_pages"]
        assert extracted["raw_sha256"] == expected["expected_sha256"]
        assert extracted["numeric_ledger"]["recall"] >= 0
        assert all(surface["surface_id"] and surface["ordinal"] >= 1 for surface in surfaces)

        vision_surfaces = [surface for surface in surfaces if surface.get("lane_status", {}).get("vision") == "required"]
        crop_artifacts = [artifact for artifact in extracted.get("artifacts", []) if artifact.get("kind") == "table_crop"]
        source_tokens = extracted["numeric_ledger"]["source_tokens"]
        if not source_tokens:
            # A public PDF may be entirely scanned or contain a legacy text
            # layer that cannot support the native numeric ledger. That is a
            # valid hard layout only when no material page disappears into a
            # false native PASS. Narrative-only native pages can be retained as
            # evidence without inventing a table or paying for a vision pass.
            native_evidence_only = [
                surface for surface in surfaces
                if surface not in vision_surfaces
                and int(surface.get("native_text_chars") or 0) > 0
                and not any(
                    region.get("material")
                    for region in surface.get("uncovered_numeric_regions", [])
                )
            ]
            assert len(vision_surfaces) + len(native_evidence_only) == len(surfaces), expected["document_id"]
            total_native_evidence_only_surfaces += len(native_evidence_only)
        if vision_surfaces:
            assert crop_artifacts, f"No high-resolution crops for {expected['document_id']}"
        total_pages += len(surfaces)
        total_vision_surfaces += len(vision_surfaces)
        total_region_crops += len(crop_artifacts)
        extraction_checks.append({
            "document_id": expected["document_id"],
            "extraction_status": extracted["extraction_status"],
            "pages": len(surfaces),
            "tables": len(extracted.get("tables", [])),
            "source_numeric_tokens": len(source_tokens),
            "missing_numeric_tokens": len(extracted["numeric_ledger"]["missing_tokens"]),
            "vision_surfaces": len(vision_surfaces),
            "region_crops": len(crop_artifacts),
        })

    if first_state["pipeline_status"] == "NEEDS_VISION":
        assert first_state["tasks"]
        assert all(task["task_kind"] == "independent_table_transcription" for task in first_state["tasks"])
        assert all(task["region_crops"] for task in first_state["tasks"])
        assert all(crop["dpi"] >= 300 for task in first_state["tasks"] for crop in task["region_crops"])

    second_code, second_state = invoke(request_path, output_root / "controller")
    assert second_code == 2
    assert second_state["pipeline_status"] == first_state["pipeline_status"]
    extract_checkpoint = next(item for item in second_state["checkpoints"] if item["stage"] == "extract")
    census_checkpoint = next(item for item in second_state["checkpoints"] if item["stage"] == "surface_census")
    assert extract_checkpoint["reused"] is True
    assert census_checkpoint["reused"] is True

    report = {
        "schema_version": "broker-public-layout-test-report/1.0",
        "status": "PASS",
        "corpus_sha256": sha256_file(corpus_path),
        "document_count": len(documents),
        "house_count": len({item["house_id"] for item in documents}),
        "issuer_count": len({item["issuer"] for item in documents}),
        "page_count": total_pages,
        "vision_surface_count": total_vision_surfaces,
        "region_crop_count": total_region_crops,
        "native_evidence_only_surface_count": total_native_evidence_only_surfaces,
        "terminal_internal_status": first_state["pipeline_status"],
        "user_blocking": first_state["user_blocking"],
        "restart_reused_extract": extract_checkpoint["reused"],
        "restart_reused_census": census_checkpoint["reused"],
        "corpus": corpus_checks,
        "extraction": extraction_checks,
    }
    report_path = output_root / "broker-public-layout-test-report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({
        "status": report["status"],
        "documents": report["document_count"],
        "houses": report["house_count"],
        "pages": report["page_count"],
        "vision_surfaces": report["vision_surface_count"],
        "region_crops": report["region_crop_count"],
        "terminal_internal_status": report["terminal_internal_status"],
        "user_blocking": report["user_blocking"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
