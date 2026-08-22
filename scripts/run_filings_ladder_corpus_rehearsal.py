#!/usr/bin/env python3
"""Record and verify the eight-document sanitized filings-ladder rehearsal.

This is a development evidence writer, not a production filing controller.  It
materialises only repository-owned synthetic fixtures, executes two documents
through each maintained route, records measured wall time, and generates the
route-claim sections in README.md, RELEASE_NOTES.md and KNOWN_LIMITATIONS.md.

Modes:
  --record     execute the corpus, write the evidence and regenerate docs
  --check      read-only binding, claim-alignment and generated-doc drift check
  --rehearse   execute into a transient report without touching the source tree
"""
from __future__ import annotations

import argparse
import base64
import copy
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "assets/filings-ladder-rehearsal-corpus-v1.json"
DEFAULT_EVIDENCE = ROOT / "assets/filings-ladder-corpus-rehearsal-v1.json"
OPTIONAL_ARCHIVE_PROOF = "assets/filings-ladder-archive-route-proof-v1.json"
CLASSIFICATION = "SANITIZED_SYNTHETIC_ROUTE_REHEARSAL_NOT_REAL_FILING_EVIDENCE"
SCHEMA_VERSION = "filings-ladder-corpus-rehearsal/1.0"
MANIFEST_SCHEMA = "filings-ladder-rehearsal-corpus/1.0"

ROUTE_ORDER = ("inline_xbrl", "pdf_geometry", "plain_html_tables", "ocr_raster")
ROUTES: dict[str, dict[str, Any]] = {
    "inline_xbrl": {
        "label": "Inline XBRL",
        "worker": "scripts/extract_inline_xbrl.py",
        "runtime_members": ["scripts/extract_inline_xbrl.py"],
        "archive_positive_tokens": ["actual-archive inline-XBRL controller"],
        "archive_mutation_tokens": ["packaged-inline-xbrl-worker-missing"],
    },
    "pdf_geometry": {
        "label": "PDF geometry",
        "worker": "scripts/extract_filing_statements.py",
        "runtime_members": ["scripts/extract_filing_statements.py"],
        "archive_positive_tokens": ["actual-archive raw-input canary did not deliver"],
        "archive_mutation_tokens": ["relocated-extractor"],
    },
    "plain_html_tables": {
        "label": "plain HTML tables",
        "worker": "scripts/extract_html_tables.py",
        "runtime_members": ["scripts/extract_html_tables.py"],
        "archive_positive_tokens": ["packaged html-tables route"],
        "archive_mutation_tokens": ["packaged-html-tables-worker-missing"],
    },
    "ocr_raster": {
        "label": "OCR raster",
        "worker": "scripts/extract_ocr_tables.py",
        "runtime_members": [
            "scripts/extract_ocr_tables.py",
            "scripts/normalize_pdf.py",
            "assets/ocr-engine-registry-v1.json",
        ],
        "archive_positive_tokens": ["packaged ocr", "ocr_engine_unavailable"],
        "archive_mutation_tokens": ["packaged-ocr-raster-worker-missing"],
    },
}

SOURCE_BINDING_PATHS = (
    "assets/filings-ladder-rehearsal-corpus-v1.json",
    "assets/installed-inline-xbrl-capability-probe-v1.json",
    "assets/installed-filings-capability-probe-v1.json",
    "assets/ocr-engine-registry-v1.json",
    "assets/filings-runtime-members.json",
    "scripts/run_filings_pipeline.mjs",
    "scripts/run_installed_filings_capability_tests.mjs",
    "scripts/extract_inline_xbrl.py",
    "scripts/extract_filing_statements.py",
    "scripts/extract_html_tables.py",
    "scripts/extract_ocr_tables.py",
    "scripts/normalize_pdf.py",
    "scripts/broker_numeric.py",
    "scripts/run_filings_ladder_corpus_rehearsal.py",
    "test-fixtures/html-tables/clean_income_statement.html",
    "test-fixtures/html-tables/footnote_superscripts.html",
)

KNOWN_BEGIN = "<!-- filings-ladder-rehearsal:generated/1.0 begin -->"
KNOWN_END = "<!-- filings-ladder-rehearsal:generated/1.0 end -->"
CLAIM_BEGIN = "<!-- filings-ladder-claims:generated/1.0 begin -->"
CLAIM_END = "<!-- filings-ladder-claims:generated/1.0 end -->"


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text("utf-8"))
    if not isinstance(value, dict):
        raise AssertionError(f"{path} must contain a JSON object")
    return value


def validate_manifest(manifest: dict[str, Any], root: Path) -> None:
    if manifest.get("schema_version") != MANIFEST_SCHEMA:
        raise AssertionError(f"manifest schema must be {MANIFEST_SCHEMA}")
    if manifest.get("classification") != CLASSIFICATION:
        raise AssertionError("the rehearsal corpus must remain explicitly sanitized and synthetic")
    documents = manifest.get("documents")
    if not isinstance(documents, list) or len(documents) != 8:
        raise AssertionError("the maintained rehearsal corpus must contain exactly eight documents")
    ids = [item.get("document_id") for item in documents]
    if len(set(ids)) != 8 or not all(isinstance(item, str) and item for item in ids):
        raise AssertionError("the eight rehearsal document ids must be unique and non-empty")
    counts = {route: 0 for route in ROUTE_ORDER}
    for item in documents:
        route = item.get("route_id")
        if route not in counts:
            raise AssertionError(f"unknown route_id {route!r}")
        counts[route] += 1
        source = root / str(item.get("source_fixture", ""))
        if not source.is_file():
            raise AssertionError(f"repository-owned source fixture is missing: {source}")
    if counts != {route: 2 for route in ROUTE_ORDER}:
        raise AssertionError(f"the corpus must force exactly two documents per route, got {counts}")


def source_bindings(root: Path) -> dict[str, str]:
    bindings: dict[str, str] = {}
    for relative in SOURCE_BINDING_PATHS:
        target = root / relative
        if not target.is_file():
            raise AssertionError(f"source binding is missing: {relative}")
        bindings[relative] = sha256_file(target)
    optional_proof = root / OPTIONAL_ARCHIVE_PROOF
    if optional_proof.is_file():
        bindings[OPTIONAL_ARCHIVE_PROOF] = sha256_file(optional_proof)
    return bindings


def materialize(document: dict[str, Any], target: Path, root: Path) -> None:
    fixture_path = root / document["source_fixture"]
    materializer = document["materializer"]
    variant = document["variant"]
    if materializer == "repository_file":
        target.write_bytes(fixture_path.read_bytes())
        return
    fixture = load_json(fixture_path)
    if materializer == "embedded_inline_xbrl":
        html = str(fixture["html"])
        if variant == "entity_alias":
            html = html.replace(">probe</xbrli:identifier>", ">probe-alias</xbrli:identifier>")
        elif variant != "original":
            raise AssertionError(f"unsupported Inline XBRL variant {variant}")
        target.write_text(html, "utf-8")
        return
    pdf_bytes = base64.b64decode(str(fixture["pdf_base64"]))
    if sha256_bytes(pdf_bytes) != fixture["pdf_sha256"]:
        raise AssertionError("the embedded PDF fixture does not match its declared SHA-256")
    if materializer == "embedded_pdf_geometry" and variant == "original":
        target.write_bytes(pdf_bytes)
        return
    try:
        import fitz  # type: ignore
    except Exception as error:  # pragma: no cover - the route reports this as a hard failure
        raise AssertionError(f"PyMuPDF is required to materialize sanitized PDF fixtures: {error}") from error
    source_pdf = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        if materializer == "embedded_pdf_geometry" and variant == "metadata_resave":
            metadata = dict(source_pdf.metadata or {})
            metadata["producer"] = "Excel Inflow sanitized route rehearsal"
            source_pdf.set_metadata(metadata)
            target.write_bytes(source_pdf.tobytes(garbage=4, deflate=True, clean=True))
            return
        if materializer == "rasterized_probe_page":
            page_index = {"page_1": 0, "page_2": 1}.get(variant)
            if page_index is None or page_index >= source_pdf.page_count:
                raise AssertionError(f"unsupported rasterized probe variant {variant}")
            page = source_pdf.load_page(page_index)
            pixmap = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), alpha=False)
            image_pdf = fitz.open()
            try:
                output_page = image_pdf.new_page(width=page.rect.width, height=page.rect.height)
                output_page.insert_image(output_page.rect, stream=pixmap.tobytes("png"))
                image_pdf.set_metadata({
                    "title": document["document_id"],
                    "producer": "Excel Inflow sanitized route rehearsal",
                })
                target.write_bytes(image_pdf.tobytes(garbage=4, deflate=True, clean=True))
            finally:
                image_pdf.close()
            return
    finally:
        source_pdf.close()
    raise AssertionError(f"unsupported materializer/variant: {materializer}/{variant}")


def execute(command: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> tuple[subprocess.CompletedProcess[str], float]:
    started = time.perf_counter_ns()
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=300,
    )
    duration_ms = max(0.001, round((time.perf_counter_ns() - started) / 1_000_000, 3))
    return completed, duration_ms


def last_json_line(text: str) -> dict[str, Any] | None:
    for line in reversed(text.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def execute_route(document: dict[str, Any], source: Path, work: Path, root: Path, python: str) -> dict[str, Any]:
    route = document["route_id"]
    output = work / "route-output.json"
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "EXCEL_INFLOW_PYTHON": python, "PYTHON": python}
    detail: dict[str, Any] = {}
    if route == "inline_xbrl":
        command = [python, str(root / ROUTES[route]["worker"]), str(source), "--out", str(output)]
        completed, duration_ms = execute(command, cwd=root, env=env)
        payload = load_json(output) if output.is_file() else None
        passed = completed.returncode == 0 and payload is not None and payload.get("schema_version") == "inline-xbrl-facts/1.0" and int(payload.get("fact_count", 0)) > 0
        detail = {"fact_count": payload.get("fact_count") if payload else None}
        result = "EXTRACTION_PASS" if passed else "FAIL"
        observed_route = "inline_xbrl" if payload and payload.get("schema_version") == "inline-xbrl-facts/1.0" else None
    elif route == "plain_html_tables":
        command = [python, str(root / ROUTES[route]["worker"]), str(source), "--out", str(output)]
        completed, duration_ms = execute(command, cwd=root, env=env)
        payload = load_json(output) if output.is_file() else None
        passed = completed.returncode == 0 and payload is not None and payload.get("schema_version") == "html-table-facts/1.0" and int(payload.get("fact_count", 0)) > 0
        detail = {"fact_count": payload.get("fact_count") if payload else None, "table_count": payload.get("table_count") if payload else None}
        result = "EXTRACTION_PASS" if passed else "FAIL"
        observed_route = "plain_html_tables" if payload and payload.get("schema_version") == "html-table-facts/1.0" else None
    elif route == "pdf_geometry":
        fixture = load_json(root / document["source_fixture"])
        request = {
            "schema_version": "filings-extraction-request/1.0",
            "run_id": document["document_id"].replace("-", "_"),
            "documents": [{
                "document_id": document["document_id"],
                "attachment_id": document["document_id"],
                "source_id": document["document_id"],
                "path": str(source),
                "media_type": "application/pdf",
                "expected_sha256": sha256_file(source),
            }],
            "filing_facts": {
                "entity_name": "Sanitized Route Rehearsal plc",
                "reporting_currency": "GBP",
                "units": fixture["expected"]["units"],
                "fiscal_calendar_kind": "fixed_date",
                "historical_periods": fixture["expected"]["periods"],
                "forecast_periods": ["2026-12-31", "2027-12-31", "2028-12-31"],
                "reported_gross_debt": 1,
                "reported_cash": 1,
            },
        }
        request_path = work / "filings-request.json"
        request_path.write_text(json.dumps(request, indent=2) + "\n", "utf-8")
        out_root = work / "geometry-out"
        command = [python, str(root / ROUTES[route]["worker"]), str(request_path), "--out", str(out_root)]
        completed, duration_ms = execute(command, cwd=root, env=env)
        receipt_path = out_root / "filings-native-extraction-receipt.json"
        payload = load_json(receipt_path) if receipt_path.is_file() else None
        passed = completed.returncode == 0 and payload is not None and payload.get("status") == "PASS" and payload.get("document_count") == 1 and payload.get("findings") == []
        detail = {"document_count": payload.get("document_count") if payload else None, "finding_count": len(payload.get("findings", [])) if payload else None}
        output = receipt_path
        result = "EXTRACTION_PASS" if passed else "FAIL"
        observed_route = "pdf_geometry" if payload and payload.get("schema_version") == "filings-native-extraction-receipt/1.0" else None
    elif route == "ocr_raster":
        command = [python, str(root / ROUTES[route]["worker"]), str(source), "--out", str(output), "--pages", "all"]
        completed, duration_ms = execute(command, cwd=root, env=env)
        payload = load_json(output) if output.is_file() else last_json_line(completed.stdout)
        if completed.returncode == 0 and payload and payload.get("schema_version") == "ocr-raster-facts/1.0" and int(payload.get("fact_count", 0)) > 0:
            passed = True
            result = "EXTRACTION_PASS"
            detail = {"fact_count": payload.get("fact_count"), "engine": payload.get("engine", "tesseract")}
            observed_route = "ocr_raster"
        elif completed.returncode == 3 and payload and payload.get("status") == "ocr_engine_unavailable":
            passed = True
            result = "OCR_UNAVAILABLE_TYPED_REFUSAL"
            detail = {"typed_status": payload.get("status"), "probed": payload.get("probed", [])}
            observed_route = "ocr_raster"
        else:
            passed = False
            result = "FAIL"
            detail = {"typed_status": payload.get("status") if payload else None}
            observed_route = None
    else:  # pragma: no cover - manifest validation owns this
        raise AssertionError(f"unknown route {route}")
    output_digest = sha256_file(output) if output.is_file() else sha256_bytes((completed.stdout + completed.stderr).encode("utf-8"))
    return {
        "observed_route": observed_route,
        "route_result": result,
        "route_obligation_satisfied": passed,
        "duration_ms": duration_ms,
        "exit_code": completed.returncode,
        "output_sha256": output_digest,
        "detail": detail,
        "stderr_sha256": sha256_bytes(completed.stderr.encode("utf-8")),
    }


def route_force_proof(route: str, source: Path) -> dict[str, Any]:
    if route in {"inline_xbrl", "plain_html_tables"}:
        lowered = source.read_bytes().lower()
        has_marker = any(marker in lowered for marker in (b"<ix:nonfraction", b"<ix:nonnumeric"))
        has_table = b"<table" in lowered
        return {"inline_xbrl_marker": has_marker, "html_table": has_table}
    try:
        import fitz  # type: ignore
    except Exception as error:  # pragma: no cover
        raise AssertionError(f"PyMuPDF is required for route-forcing proof: {error}") from error
    document = fitz.open(source)
    try:
        characters = [len(page.get_text("text")) for page in document]
    finally:
        document.close()
    overall = "scanned" if characters and all(count < 50 for count in characters) else "text"
    return {"pdf_classification": overall, "native_text_characters_by_page": characters}


def compute_route_claims(root: Path) -> dict[str, Any]:
    members = load_json(root / "assets/filings-runtime-members.json").get("members", [])
    member_set = set(members if isinstance(members, list) else [])
    pipeline = (root / "scripts/run_filings_pipeline.mjs").read_text("utf-8")
    archive_suite = (root / "scripts/run_installed_filings_capability_tests.mjs").read_text("utf-8")
    archive_proof_path = root / OPTIONAL_ARCHIVE_PROOF
    archive_proof = load_json(archive_proof_path) if archive_proof_path.is_file() else None
    externally_proved_routes = {
        item.get("route_id")
        for item in (archive_proof or {}).get("routes", [])
        if isinstance(item, dict) and item.get("status") == "PASS"
    } if (archive_proof or {}).get("status") == "PASS" else set()
    routes: list[dict[str, Any]] = []
    for route_id in ROUTE_ORDER:
        declaration = ROUTES[route_id]
        worker = root / declaration["worker"]
        pipeline_wired = worker.name in pipeline
        runtime_members_declared = all(relative in member_set for relative in declaration["runtime_members"])
        archive_positive = all(token in archive_suite for token in declaration["archive_positive_tokens"])
        archive_mutation = all(token in archive_suite for token in declaration["archive_mutation_tokens"])
        archive_proof_assertions_declared = archive_positive and archive_mutation
        archive_route_proved = route_id in externally_proved_routes
        packaged_route_wired = worker.is_file() and pipeline_wired and runtime_members_declared
        routes.append({
            "route_id": route_id,
            "label": declaration["label"],
            "worker": declaration["worker"],
            "worker_present": worker.is_file(),
            "pipeline_wired": pipeline_wired,
            "runtime_members_declared": runtime_members_declared,
            "archive_positive_proof_declared": archive_positive,
            "archive_delete_or_refusal_mutation_declared": archive_mutation,
            "archive_proof_assertions_declared": archive_proof_assertions_declared,
            "archive_route_proved": archive_route_proved,
            "claim_status": "PACKAGED_PIPELINE_WIRED" if packaged_route_wired else "SOURCE_ONLY_NOT_PACKAGED",
        })
    wired = [route["route_id"] for route in routes if route["claim_status"] == "PACKAGED_PIPELINE_WIRED"]
    source_only = [route["route_id"] for route in routes if route["claim_status"] != "PACKAGED_PIPELINE_WIRED"]
    return {
        "routes": routes,
        "wired_route_ids": wired,
        "source_only_route_ids": source_only,
        "archive_proof_artifact": OPTIONAL_ARCHIVE_PROOF if archive_proof is not None else None,
        "b2_all_route_archive_proof_green": (
            archive_proof is not None and
            archive_proof.get("status") == "PASS" and
            externally_proved_routes == set(ROUTE_ORDER)
        ),
    }


def tool_output(command: list[str]) -> str | None:
    try:
        completed = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    text = completed.stdout.strip().splitlines()
    return text[0][:240] if completed.returncode == 0 and text else None


def toolchain(python: str) -> dict[str, Any]:
    try:
        import fitz  # type: ignore
        fitz_version = str(getattr(fitz, "VersionBind", "unknown"))
    except Exception:
        fitz_version = None
    tesseract = shutil.which("tesseract")
    pdftoppm = shutil.which("pdftoppm")
    return {
        "python": tool_output([python, "--version"]),
        "pymupdf": fitz_version,
        "tesseract": tool_output([tesseract, "--version"]) if tesseract else None,
        "pdftoppm": tool_output([pdftoppm, "-v"]) if pdftoppm else None,
        "ocr_engine_available": tesseract is not None,
        "rasterizer_available": pdftoppm is not None,
    }


def rehearse(manifest: dict[str, Any], root: Path, python: str) -> list[dict[str, Any]]:
    validate_manifest(manifest, root)
    results: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="filings-ladder-rehearsal-") as temp_text:
        temp = Path(temp_text)
        for document in manifest["documents"]:
            work = temp / document["document_id"]
            work.mkdir(parents=True)
            suffix = ".html" if document["route_id"] in {"inline_xbrl", "plain_html_tables"} else ".pdf"
            source = work / f"source{suffix}"
            materialize(document, source, root)
            forcing = route_force_proof(document["route_id"], source)
            outcome = execute_route(document, source, work, root, python)
            results.append({
                "document_id": document["document_id"],
                "intended_route": document["route_id"],
                "source_fixture": document["source_fixture"],
                "source_fixture_sha256": sha256_file(root / document["source_fixture"]),
                "materialized_sha256": sha256_file(source),
                "route_force_proof": forcing,
                **outcome,
            })
    return results


def build_evidence(manifest: dict[str, Any], results: list[dict[str, Any]], root: Path, python: str) -> dict[str, Any]:
    route_claims = compute_route_claims(root)
    extraction_passes = sum(row["route_result"] == "EXTRACTION_PASS" for row in results)
    typed_refusals = sum(row["route_result"] == "OCR_UNAVAILABLE_TYPED_REFUSAL" for row in results)
    body: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "status": "PASS" if len(results) == 8 and all(row["route_obligation_satisfied"] for row in results) else "FAIL",
        "classification": CLASSIFICATION,
        "corpus_id": manifest["corpus_id"],
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "manifest_sha256": sha256_bytes(canonical_bytes(manifest)),
        "source_bindings": source_bindings(root),
        "toolchain": toolchain(python),
        "summary": {
            "document_count": len(results),
            "route_obligations_satisfied": sum(bool(row["route_obligation_satisfied"]) for row in results),
            "extraction_pass_count": extraction_passes,
            "typed_ocr_unavailable_count": typed_refusals,
            "route_counts": {route: sum(row["intended_route"] == route for row in results) for route in ROUTE_ORDER},
            "interpretation": "Eight of eight sanitized route obligations were executed. Typed OCR engine unavailability satisfies only the OCR refusal obligation; it is not an extraction pass.",
        },
        "route_claims": route_claims,
        "documents": results,
    }
    body["route_claims"]["production_ladder_phrase_permitted"] = (
        body["status"] == "PASS" and body["route_claims"]["b2_all_route_archive_proof_green"]
    )
    body["record_sha256"] = sha256_bytes(canonical_bytes(body))
    return body


def validate_evidence(evidence: dict[str, Any], manifest: dict[str, Any], root: Path, *, check_sources: bool = True) -> None:
    if evidence.get("schema_version") != SCHEMA_VERSION:
        raise AssertionError(f"evidence schema must be {SCHEMA_VERSION}")
    if evidence.get("classification") != CLASSIFICATION:
        raise AssertionError("evidence lost the synthetic/non-production classification")
    sealed = copy.deepcopy(evidence)
    declared_digest = sealed.pop("record_sha256", None)
    if declared_digest != sha256_bytes(canonical_bytes(sealed)):
        raise AssertionError("record_sha256 does not bind the rehearsal evidence")
    validate_manifest(manifest, root)
    if evidence.get("manifest_sha256") != sha256_bytes(canonical_bytes(manifest)):
        raise AssertionError("rehearsal evidence is stale against the corpus manifest")
    if check_sources:
        expected_bindings = source_bindings(root)
        if evidence.get("source_bindings") != expected_bindings:
            raise AssertionError("rehearsal evidence is stale against its source/worker bindings; run --record")
    documents = evidence.get("documents")
    if not isinstance(documents, list) or len(documents) != 8:
        raise AssertionError("rehearsal evidence must retain exactly eight document outcomes")
    expected_ids = [item["document_id"] for item in manifest["documents"]]
    if [item.get("document_id") for item in documents] != expected_ids:
        raise AssertionError("rehearsal document membership/order drifted from the maintained corpus")
    if len({item.get("materialized_sha256") for item in documents}) != 8:
        raise AssertionError("all eight materialized rehearsal documents must have distinct bytes")
    for item in documents:
        if item.get("intended_route") not in ROUTE_ORDER or item.get("observed_route") != item.get("intended_route"):
            raise AssertionError(f"route mismatch for {item.get('document_id')}")
        forcing = item.get("route_force_proof", {})
        if item["intended_route"] == "inline_xbrl" and not (forcing.get("inline_xbrl_marker") is True and forcing.get("html_table") is True):
            raise AssertionError(f"Inline XBRL route was not forced by source bytes for {item.get('document_id')}")
        if item["intended_route"] == "plain_html_tables" and not (forcing.get("inline_xbrl_marker") is False and forcing.get("html_table") is True):
            raise AssertionError(f"plain-HTML route was not forced by source bytes for {item.get('document_id')}")
        if item["intended_route"] == "pdf_geometry" and forcing.get("pdf_classification") != "text":
            raise AssertionError(f"PDF geometry route was not forced by text-bearing PDF bytes for {item.get('document_id')}")
        if item["intended_route"] == "ocr_raster" and forcing.get("pdf_classification") != "scanned":
            raise AssertionError(f"OCR route was not forced by image-only PDF bytes for {item.get('document_id')}")
        if not item.get("route_obligation_satisfied"):
            raise AssertionError(f"route obligation failed for {item.get('document_id')}")
        if not isinstance(item.get("duration_ms"), (int, float)) or item["duration_ms"] <= 0:
            raise AssertionError(f"measured timing missing for {item.get('document_id')}")
        allowed = {"EXTRACTION_PASS"}
        if item["intended_route"] == "ocr_raster":
            allowed.add("OCR_UNAVAILABLE_TYPED_REFUSAL")
        if item.get("route_result") not in allowed:
            raise AssertionError(f"unlawful route result for {item.get('document_id')}: {item.get('route_result')}")
    expected_counts = {route: 2 for route in ROUTE_ORDER}
    summary = evidence.get("summary", {})
    if summary.get("route_counts") != expected_counts or summary.get("document_count") != 8 or summary.get("route_obligations_satisfied") != 8:
        raise AssertionError("summary does not prove two documents per route and 8/8 obligations")
    if evidence.get("status") != "PASS":
        raise AssertionError("rehearsal evidence is not PASS")
    current_claims = compute_route_claims(root)
    claims = copy.deepcopy(evidence.get("route_claims", {}))
    phrase_permitted = claims.pop("production_ladder_phrase_permitted", None)
    if claims != current_claims:
        raise AssertionError("documented route claims drifted from runtime members, pipeline wiring, or archive proof")
    expected_permission = current_claims["b2_all_route_archive_proof_green"] and evidence["status"] == "PASS"
    if phrase_permitted is not expected_permission:
        raise AssertionError("the production-ladder phrase gate does not equal B2 archive proof AND B3 corpus proof")


def route_label(route_id: str) -> str:
    return ROUTES[route_id]["label"]


def claim_summary(evidence: dict[str, Any]) -> tuple[str, str]:
    wired = evidence["route_claims"]["wired_route_ids"]
    source_only = evidence["route_claims"]["source_only_route_ids"]
    wired_text = ", ".join(route_label(route) for route in wired) if wired else "none"
    source_text = ", ".join(route_label(route) for route in source_only) if source_only else "none"
    return wired_text, source_text


def render_claim_block(evidence: dict[str, Any]) -> str:
    wired, source_only = claim_summary(evidence)
    summary = evidence["summary"]
    return "\n".join([
        CLAIM_BEGIN,
        "## Filing extraction route status",
        "",
        "This section is generated by `python3 scripts/run_filings_ladder_corpus_rehearsal.py --record`; hand edits fail the drift gate.",
        "",
        f"- Packaged and pipeline-wired routes: **{wired}**. Their archive-suite assertions are declared in source; a separate all-route PASS artifact is still required before any stronger claim.",
        f"- Maintained source routes not yet proved from the unpacked package: **{source_only}**.",
        f"- Sanitized rehearsal: **{summary['route_obligations_satisfied']}/{summary['document_count']} route obligations satisfied** ({summary['extraction_pass_count']} extraction passes; {summary['typed_ocr_unavailable_count']} typed OCR-unavailable refusals).",
        "- Scope: repository-owned synthetic fixtures only. This is neither real-filing evidence nor installed-host certification.",
        "",
        f"Evidence: `assets/filings-ladder-corpus-rehearsal-v1.json` (`{evidence['record_sha256'][:16]}…`).",
        CLAIM_END,
    ])


def render_known_block(evidence: dict[str, Any]) -> str:
    wired, source_only = claim_summary(evidence)
    lines = [
        KNOWN_BEGIN,
        "## Generated eight-document extraction-route rehearsal",
        "",
        "The sanctioned writer executed a maintained, sanitized corpus made only from repository-owned fixtures. It is intentionally separate from the hash-only real-filing custody receipt and from unpacked-package proof.",
        "",
        f"- Packaged and pipeline-wired: **{wired}**. Archive-suite assertions exist, but no separate all-route PASS artifact is recorded for this head.",
        f"- Maintained source-only / not yet archive-proved: **{source_only}**.",
        "- An `OCR_UNAVAILABLE_TYPED_REFUSAL` is a successful refusal rehearsal, not an extracted document.",
        "",
        "| Document | Observed route | Result | Measured wall time |",
        "|---|---|---:|---:|",
    ]
    for row in evidence["documents"]:
        lines.append(
            f"| `{row['document_id']}` | {route_label(row['observed_route'])} | `{row['route_result']}` | {row['duration_ms']:.3f} ms |"
        )
    lines.extend([
        "",
        f"Evidence record: `assets/filings-ladder-corpus-rehearsal-v1.json` (`record_sha256={evidence['record_sha256']}`).",
        KNOWN_END,
    ])
    return "\n".join(lines)


def replace_block(text: str, begin: str, end: str, replacement: str) -> str:
    pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.DOTALL)
    matches = list(pattern.finditer(text))
    if len(matches) > 1:
        raise AssertionError(f"generated block {begin} appears more than once")
    if matches:
        result = pattern.sub(replacement, text)
    else:
        result = text.rstrip() + "\n\n" + replacement + "\n"
    return result.rstrip() + "\n"


def expected_documents(evidence: dict[str, Any], root: Path) -> dict[Path, str]:
    claim = render_claim_block(evidence)
    known = render_known_block(evidence)
    readme = root / "README.md"
    readme_text = readme.read_text("utf-8") if readme.is_file() else "# Excel Inflow\n\nDevelopment candidate; release and installed-host claims remain evidence-bound.\n"
    release = root / "RELEASE_NOTES.md"
    known_path = root / "KNOWN_LIMITATIONS.md"
    return {
        readme: replace_block(readme_text, CLAIM_BEGIN, CLAIM_END, claim),
        release: replace_block(release.read_text("utf-8"), CLAIM_BEGIN, CLAIM_END, claim),
        known_path: replace_block(known_path.read_text("utf-8"), KNOWN_BEGIN, KNOWN_END, known),
    }


def write_documents(evidence: dict[str, Any], root: Path) -> None:
    for path, text in expected_documents(evidence, root).items():
        path.write_text(text, "utf-8")


def validate_documents(evidence: dict[str, Any], root: Path) -> None:
    expected = expected_documents(evidence, root)
    for path, expected_text in expected.items():
        if not path.is_file() or path.read_text("utf-8") != expected_text:
            raise AssertionError(f"generated route claim drifted in {path.relative_to(root)}; run --record")
    docs = [root / "README.md", root / "RELEASE_NOTES.md", root / "KNOWN_LIMITATIONS.md"]
    combined = "\n".join(path.read_text("utf-8") for path in docs)
    if not evidence["route_claims"]["production_ladder_phrase_permitted"] and re.search(r"\bproduction ladder\b", combined, re.IGNORECASE):
        raise AssertionError("the phrase 'production ladder' is forbidden until B2 archive proof and B3 corpus proof are both green")
    if "ocr_raster" in evidence["route_claims"]["source_only_route_ids"]:
        outside = re.sub(re.escape(CLAIM_BEGIN) + r".*?" + re.escape(CLAIM_END), "", combined, flags=re.DOTALL)
        outside = re.sub(re.escape(KNOWN_BEGIN) + r".*?" + re.escape(KNOWN_END), "", outside, flags=re.DOTALL)
        conflict = re.search(r"(?:OCR.{0,100}(?:packaged|pipeline-wired|installed)|(?:packaged|pipeline-wired|installed).{0,100}OCR)", outside, re.IGNORECASE | re.DOTALL)
        if conflict:
            raise AssertionError("a hand-written document claims packaged OCR while the mechanical route claim is source-only")


def write_evidence(path: Path, evidence: dict[str, Any]) -> None:
    path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", "utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--record", action="store_true")
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--rehearse", action="store_true")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--evidence", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--out", type=Path, default=None, help="transient --rehearse output")
    parser.add_argument("--python", default=sys.executable)
    args = parser.parse_args()
    mode = "record" if args.record else "rehearse" if args.rehearse else "check"
    try:
        manifest = load_json(args.manifest.resolve())
        if mode in {"record", "rehearse"}:
            results = rehearse(manifest, ROOT, args.python)
            evidence = build_evidence(manifest, results, ROOT, args.python)
            validate_evidence(evidence, manifest, ROOT)
            if mode == "record":
                write_evidence(args.evidence.resolve(), evidence)
                write_documents(evidence, ROOT)
                validate_documents(evidence, ROOT)
            elif args.out:
                write_evidence(args.out.resolve(), evidence)
            else:
                print(json.dumps(evidence, sort_keys=True))
        else:
            evidence = load_json(args.evidence.resolve())
            validate_evidence(evidence, manifest, ROOT)
            validate_documents(evidence, ROOT)
        print(json.dumps({
            "status": "PASS",
            "mode": mode,
            "documents": evidence["summary"]["document_count"],
            "route_obligations_satisfied": evidence["summary"]["route_obligations_satisfied"],
            "extraction_pass_count": evidence["summary"]["extraction_pass_count"],
            "typed_ocr_unavailable_count": evidence["summary"]["typed_ocr_unavailable_count"],
            "wired_route_ids": evidence["route_claims"]["wired_route_ids"],
            "source_only_route_ids": evidence["route_claims"]["source_only_route_ids"],
            "record_sha256": evidence["record_sha256"],
        }, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({"status": "FAIL", "mode": mode, "reason": str(error)}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
