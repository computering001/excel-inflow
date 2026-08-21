#!/usr/bin/env python3
"""Independent expected-period oracle for rendered broker evidence.

This module deliberately does not import broker_period_recovery or any other
production period decision helper.  Source-frozen expected headers are closed
over rendered artifact bytes and compared independently with both model-host
review and recovered output.

Period labels are accepted in the widened surface grammar real rendered
headers use (``FY25``, ``FY2025``, ``2025/26``, ``25/26``, ``FY25/26``,
``CY2025``, plus the canonical ``YYYY``/``YYYYA``/``YYYYE``) and normalised to
canonical annual labels before any comparison.  Normalisation is declared, not
guessed: a label that resolves only by assumption (a bare split year such as
``25/26``) always raises ``BROKER_PERIOD_LABEL_AMBIGUOUS`` so the frozen
contract is re-stated unambiguously.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any


# Canonical annual labels: a four-digit year with an optional A(actual)/E(estimate)
# suffix.  Every widened surface spelling below normalises into this shape.
FULL_YEAR = re.compile(r"^(?:19|20)\d{2}(?:A|E)?$")

# Widened surface grammar for real rendered broker headers.  The oracle stays
# independent of production recovery code: it normalises labels itself and
# never guesses silently — an uncenturied split year is resolvable under the
# declared conventions but is always reported as an assumption via
# BROKER_PERIOD_LABEL_AMBIGUOUS so the frozen contract gets re-stated
# unambiguously.
#
#   2025, 2025A, 2025E  -> identity (existing grammar)
#   FY2025, fy 2025     -> 2025            explicit-century fiscal prefix
#   FY25                -> 2025            bare pair under the 00-49/50-99 pivot
#   CY2025              -> 2025            calendar-year prefix
#   2025/26             -> 2026            UK split, END year; second pair must
#                                          be start+1 (1999/00 -> 2000)
#   FY25/26             -> 2026            fiscal-prefixed split
#   25/26               -> 2026 (AMBIGUOUS) no century and no convention prefix:
#                                          resolvable, but never silently blessed
PERIOD_LABEL = re.compile(
    r"^(FY|CY)?\s*((?:19|20)\d{2}|\d{2})(?:\s*/\s*(\d{2}))?\s*([AE])?$",
    re.IGNORECASE,
)


def _pivot_year(pair: str) -> int:
    """Resolve a bare two-digit year under the declared 00-49/50-99 pivot."""
    value = int(pair)
    return 2000 + value if value <= 49 else 1900 + value


def canonical_period_label(value: Any) -> tuple[str | None, bool]:
    """Normalise one rendered period label to a canonical annual label.

    Returns ``(canonical_label, ambiguous)``.  ``canonical_label`` is ``None``
    when the label is outside the grammar entirely; ``ambiguous`` is True only
    for labels the conventions resolve only by assumption (a bare two-digit
    split year such as ``25/26``), which callers must surface as a finding
    rather than accept silently.
    """
    text = re.sub(r"\s+", " ", str(value or "").strip())
    match = PERIOD_LABEL.fullmatch(text)
    if not match:
        return None, False
    prefix, first, second, suffix = match.groups()
    prefix = (prefix or "").upper()
    suffix = (suffix or "").upper()
    if len(first) == 4:
        start = int(first)
        ambiguous = False
    else:
        # A bare pair is only accepted when some convention anchors it: a
        # FY/CY prefix or an explicit split.  A naked "25" stays invalid.
        if not prefix and not second:
            return None, False
        start = _pivot_year(first)
        ambiguous = not prefix and bool(second)
    if second:
        end = start + 1
        if end % 100 != int(second):
            return None, False
        return f"{end:04d}{suffix}", ambiguous
    return f"{start:04d}{suffix}", ambiguous


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


def canonical_headers(value: Any) -> list[dict[str, Any]]:
    """Headers mapped into canonical annual-label space.

    A label outside the grammar keeps its raw text so downstream comparisons
    fail loudly rather than crash; ambiguity is surfaced separately by the
    verification pass.
    """
    resolved: list[dict[str, Any]] = []
    for item in normal_headers(value):
        canonical, _ = canonical_period_label(item["period_label"])
        resolved.append({"column": item["column"], "period_label": canonical or item["period_label"]})
    return resolved


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
            item["column"] < 1 or canonical_period_label(item["period_label"])[0] is None
            for item in expected_headers
        ):
            fail("BROKER_PERIOD_EXPECTED_LABEL_INVALID", "Expected-period contract does not contain a recognised complete annual label.", document_id=document_id, table_id=table_id)
        for item in expected_headers:
            resolved_label, ambiguous = canonical_period_label(item["period_label"])
            if ambiguous:
                fail(
                    "BROKER_PERIOD_LABEL_AMBIGUOUS",
                    "Period label %r carries no century anchor; it resolves to %r only under the declared split-year conventions and must be re-stated unambiguously in the frozen contract." % (item["period_label"], resolved_label),
                    document_id=document_id,
                    table_id=table_id,
                    column=item["column"],
                )
        expected_canonical = canonical_headers(expected.get("headers"))
        review_decision = review_decisions.get(target)
        if review_decision is None or str(review_decision.get("surface_id") or "") != surface_id:
            fail("BROKER_PERIOD_REVIEW_TARGET", "Review does not disposition the frozen rendered target.", document_id=document_id, table_id=table_id)
        elif canonical_headers(review_decision.get("headers")) != expected_canonical:
            fail("BROKER_PERIOD_EXPECTED_LABEL_MISMATCH", "Review labels differ from the source-frozen rendered-period expectation.", document_id=document_id, surface_id=surface_id, table_id=table_id)

        recovered_tables = {
            str(item.get("canonical_table_id") or item.get("table_id") or ""): item
            for item in (recovered_document.get("canonical_tables") or recovered_document.get("tables") or [])
        }
        recovered_table = recovered_tables.get(table_id)
        if recovered_table is None:
            fail("BROKER_PERIOD_RECOVERED_TABLE", "Recovered output omits the frozen expected table.", document_id=document_id, table_id=table_id)
        else:
            recovered_headers = [
                item for item in canonical_headers(recovered_table.get("effective_period_headers"))
                if item["column"] in {header["column"] for header in expected_canonical}
            ]
            if recovered_headers != expected_canonical:
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
