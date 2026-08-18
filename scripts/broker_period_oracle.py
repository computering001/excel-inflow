#!/usr/bin/env python3
"""Independent expected-period oracle for rendered broker evidence.

This module deliberately does not import broker_period_recovery or any other
production period decision helper. Source-frozen expected headers are closed
over rendered artifact bytes and compared independently with both model-host
review and recovered output.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any


FULL_YEAR = re.compile(r"^(?:19|20)\d{2}(?:A|E)?$")


def canonical_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normal_headers(value: Any) -> list[dict[str, Any]]:
    return sorted(
        [
            {
                "column": int(item.get("column", 0)),
                "period_label": re.sub(r"\s+", " ", str(item.get("period_label") or "").strip()),
            }
            for item in (value or [])
        ],
        key=lambda item: item["column"],
    )


def verify_period_expectations(
    bundle: dict[str, Any],
    review: dict[str, Any],
    recovered: dict[str, Any],
    expectation_contract: dict[str, Any],
    *,
    evidence_root: Path,
) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []

    def fail(code: str, message: str, **context: Any) -> None:
        findings.append({"code": code, "message": message, **context})

    if expectation_contract.get("schema_version") != "broker-period-expectation/1.0":
        fail("BROKER_PERIOD_EXPECTATION_SCHEMA", "Expected-period contract has the wrong schema version.")
    expectation_core = {
        "run_id": expectation_contract.get("run_id"),
        "expectations": expectation_contract.get("expectations"),
    }
    expected_closure = canonical_hash(expectation_core)
    if expectation_contract.get("expectations_sha256") != expected_closure:
        fail("BROKER_PERIOD_EXPECTATION_CLOSURE", "Expected-period contract closure hash does not match its body.")
    if expectation_contract.get("run_id") != bundle.get("run_id"):
        fail("BROKER_PERIOD_EXPECTATION_RUN", "Expected-period contract is bound to a different run.")
    if review.get("run_id") != bundle.get("run_id"):
        fail("BROKER_PERIOD_REVIEW_RUN", "Period review is bound to a different run.")

    documents = {str(item.get("document_id")): item for item in bundle.get("documents", [])}
    recovered_documents = {str(item.get("document_id")): item for item in recovered.get("documents", [])}
    review_decisions: dict[tuple[str, str], dict[str, Any]] = {}
    for decision in review.get("decisions") or []:
        key = (str(decision.get("document_id") or ""), str(decision.get("table_id") or ""))
        if key in review_decisions:
            fail("BROKER_PERIOD_REVIEW_DUPLICATE", "Period review repeats a table target.")
        review_decisions[key] = decision

    expected_targets: set[tuple[str, str]] = set()
    for expected in expectation_contract.get("expectations") or []:
        document_id = str(expected.get("document_id") or "")
        surface_id = str(expected.get("surface_id") or "")
        table_id = str(expected.get("table_id") or "")
        target = (document_id, table_id)
        if target in expected_targets:
            fail("BROKER_PERIOD_EXPECTATION_DUPLICATE", "Expected-period contract repeats a table target.", document_id=document_id, table_id=table_id)
            continue
        expected_targets.add(target)
        document = documents.get(document_id)
        recovered_document = recovered_documents.get(document_id)
        if document is None or recovered_document is None:
            fail("BROKER_PERIOD_EXPECTATION_DOCUMENT", "Expected-period target document is absent.", document_id=document_id)
            continue
        surfaces = {str(item.get("surface_id")): item for item in document.get("surfaces", [])}
        surface = surfaces.get(surface_id)
        if surface is None:
            fail("BROKER_PERIOD_EXPECTATION_SURFACE", "Expected-period rendered surface is absent.", document_id=document_id, surface_id=surface_id)
            continue
        artifacts = {str(item.get("artifact_id")): item for item in document.get("artifacts", [])}
        surface_refs = {str(item) for item in surface.get("artifact_refs", [])}
        for evidence in expected.get("rendered_evidence") or []:
            artifact_id = str(evidence.get("artifact_id") or "")
            artifact = artifacts.get(artifact_id)
            if artifact is None or artifact_id not in surface_refs:
                fail("BROKER_PERIOD_RENDERED_EVIDENCE_MISSING", "Expected rendered evidence is absent from the target surface.", document_id=document_id, surface_id=surface_id, artifact_id=artifact_id)
                continue
            expected_sha = str(evidence.get("sha256") or "")
            if artifact.get("sha256") != expected_sha:
                fail("BROKER_PERIOD_RENDERED_EVIDENCE_BINDING", "Bundle artifact hash differs from the frozen rendered-evidence hash.", artifact_id=artifact_id)
            artifact_path = Path(str(artifact.get("path") or ""))
            if not artifact_path.is_absolute():
                artifact_path = evidence_root / artifact_path
            try:
                if artifact_path.is_symlink() or not artifact_path.is_file():
                    raise OSError("not a regular rendered artifact")
                actual_sha = sha256_file(artifact_path)
            except OSError:
                fail("BROKER_PERIOD_RENDERED_EVIDENCE_FILE", "Rendered-evidence artifact is not a readable regular file.", artifact_id=artifact_id)
            else:
                if actual_sha != expected_sha:
                    fail("BROKER_PERIOD_RENDERED_EVIDENCE_HASH", "Rendered-evidence bytes differ from the frozen hash.", artifact_id=artifact_id)

        expected_headers = normal_headers(expected.get("headers"))
        if not expected_headers or any(
            item["column"] < 1 or not FULL_YEAR.fullmatch(item["period_label"])
            for item in expected_headers
        ):
            fail("BROKER_PERIOD_EXPECTED_LABEL_INVALID", "Expected-period contract does not contain complete annual labels.", document_id=document_id, table_id=table_id)
        review_decision = review_decisions.get(target)
        if review_decision is None or str(review_decision.get("surface_id") or "") != surface_id:
            fail("BROKER_PERIOD_REVIEW_TARGET", "Review does not disposition the frozen rendered target.", document_id=document_id, table_id=table_id)
        elif normal_headers(review_decision.get("headers")) != expected_headers:
            fail("BROKER_PERIOD_EXPECTED_LABEL_MISMATCH", "Review labels differ from the source-frozen rendered-period expectation.", document_id=document_id, surface_id=surface_id, table_id=table_id)

        recovered_tables = {
            str(item.get("canonical_table_id") or item.get("table_id") or ""): item
            for item in (recovered_document.get("canonical_tables") or recovered_document.get("tables") or [])
        }
        recovered_table = recovered_tables.get(table_id)
        if recovered_table is None:
            fail("BROKER_PERIOD_RECOVERED_TABLE", "Recovered output omits the frozen expected table.", document_id=document_id, table_id=table_id)
        else:
            recovered_headers = normal_headers(recovered_table.get("effective_period_headers"))
            recovered_headers = [
                item for item in recovered_headers
                if item["column"] in {header["column"] for header in expected_headers}
            ]
            if recovered_headers != expected_headers:
                fail("BROKER_PERIOD_RECOVERED_LABEL_MISMATCH", "Recovered headers differ from the source-frozen rendered-period expectation.", document_id=document_id, table_id=table_id)

    unexpected_review_targets = sorted(set(review_decisions) - expected_targets)
    if unexpected_review_targets:
        fail("BROKER_PERIOD_REVIEW_UNEXPECTED_TARGET", "Review contains targets absent from the frozen expected-period contract.", count=len(unexpected_review_targets))

    return {
        "schema_version": "broker-period-oracle-report/1.0",
        "status": "PASS" if not findings else "FAIL",
        "expectations_sha256": expectation_contract.get("expectations_sha256"),
        "rendered_target_count": len(expected_targets),
        "review_sha256": canonical_hash(review),
        "recovered_sha256": canonical_hash(recovered),
        "findings": findings,
    }
