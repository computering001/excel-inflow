#!/usr/bin/env python3
"""Bind real-corpus extraction outcomes without laundering classification as extraction."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CLASSIFICATION = ROOT / "test-fixtures/real-filings-custody-v1/corpus-classification-receipt.json"
FROZEN = ROOT / "test-fixtures/real-filings-custody-v1/corpus-extraction-outcomes.json"
EXTRACTOR = ROOT / "scripts/extract_filing_statements.py"

# Source-declared reporting facts needed by the production extractor.  The
# corpus manifest binds the raw bytes but intentionally contains only
# classification dimensions, so extraction facts are bound here by raw hash.
EXTRACTION_FACTS_BY_SHA = {
    "596d7443051fef134c502bb0fc9a2895245cdce9de8b1a982345da91eb57f158": {
        "historical_periods": ["2023-12-31", "2024-12-31", "2025-12-31"],
        "reporting_currency": "USD", "units": "millions",
    },
    "9dd5e1a8cf1e79fbbcec4c9df93b55c70adbe8e44dd96d7441e131ea309dbbc9": {
        "historical_periods": ["2023-03-31", "2024-03-31", "2025-03-31"],
        "reporting_currency": "GBP", "units": "millions",
    },
    "393bfa60adfd86ca63ce0c09600326b7b5adddc0840eba323ac12a94b4549b32": {
        "historical_periods": ["2023-09-30", "2024-09-30", "2025-09-30"],
        "reporting_currency": "EUR", "units": "millions",
    },
    "1c2e4fdb9bcafa25f871394031e92a71e5399b7ceaa96cb1d4f6d2593f61efd1": {
        "historical_periods": ["2023-03-31", "2024-03-31", "2025-03-31"],
        "reporting_currency": "EUR", "units": "millions",
    },
    "ca2ec7b1273c61498a6881ed3109419c99ef83031b1707232114c5c77230d126": {
        "historical_periods": ["1988-12-31", "1989-12-31", "1990-12-31"],
        "reporting_currency": "USD", "units": "millions",
    },
    "a74d2221373b5f27392c92025aee7956bee5619e0a31fc51f10824766e0a1ccd": {
        "historical_periods": ["2023-12-31", "2024-12-31", "2025-12-31"],
        "reporting_currency": "CNY", "units": "thousands",
    },
}


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def validate(receipt: dict[str, Any], classification: dict[str, Any]) -> None:
    assert receipt["schema_version"] == "real-filing-corpus-extraction-outcomes/1.0"
    assert receipt["classification_receipt_sha256"] == digest_bytes(CLASSIFICATION.read_bytes())
    expected = {item["candidate_id"]: item for item in classification["documents"]}
    actual = {item["candidate_id"]: item for item in receipt["documents"]}
    assert len(actual) == len(receipt["documents"]) == len(expected) == 8
    assert set(actual) == set(expected)
    for candidate_id, outcome in actual.items():
        source = expected[candidate_id]
        assert outcome["raw_sha256"] == source["raw_sha256"]
        assert outcome["media_kind"] == source["media_kind"]
        assert outcome["terminal_status"] in {
            "EXTRACTION_PASS", "NEEDS_EXTRACTION_REVIEW",
            "BLOCKED_RAW_BYTES_NOT_RETAINED", "BLOCKED_HTML_NATIVE_EXTRACTOR_UNSUPPORTED",
            "BLOCKED_SCANNED_PDF_OCR_REQUIRED", "BLOCKED_EXTRACTION_REQUEST_METADATA_ABSENT",
        }
        if outcome["terminal_status"] == "EXTRACTION_PASS":
            assert outcome["attempted"] is True
            assert outcome["receipt_sha256"] is not None
        else:
            assert outcome["reason"]
        if outcome["attempted"]:
            assert outcome["receipt_sha256"] is not None
    extraction_passes = sum(item["terminal_status"] == "EXTRACTION_PASS" for item in actual.values())
    blockers = sum(item["terminal_status"].startswith("BLOCKED_") for item in actual.values())
    assert receipt["extraction_pass_count"] == extraction_passes
    assert receipt["blocked_document_count"] == blockers
    assert receipt["status"] == ("PASS" if extraction_passes == 8 else "BLOCKED")
    # A category-classification PASS can never promote the extraction receipt.
    if classification["status"] == "PASS" and extraction_passes < 8:
        assert receipt["status"] == "BLOCKED"


def compile_live(manifest_path: Path, classification: dict[str, Any]) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text("utf-8"))
    documents_by_sha = {item["raw_sha256"]: item for item in classification["documents"]}
    outcomes = []
    for declaration in manifest["documents"]:
        target = Path(declaration["path"]).resolve(strict=True)
        raw = target.read_bytes()
        raw_sha = digest_bytes(raw)
        assert raw_sha == declaration["expected_sha256"]
        source = documents_by_sha[raw_sha]
        media = source["media_kind"]
        attempted = False
        if media == "html":
            # The structured lane: Inline XBRL facts ARE the machine-readable
            # half of an HTML filing. The document is attempted, not waved
            # away — a fact table with bound contexts is an extraction pass
            # for the structured source; face-statement projection consumes
            # it downstream.
            attempted = True
            with tempfile.TemporaryDirectory(prefix="inline-xbrl-outcome-") as temp:
                facts_path = Path(temp) / "facts.json"
                completed = subprocess.run(
                    [sys.executable, str(Path(__file__).resolve().parent / "extract_inline_xbrl.py"),
                     str(target), "--out", str(facts_path)],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=300,
                )
                if completed.returncode == 0 and facts_path.is_file():
                    fact_table = json.loads(facts_path.read_text("utf-8"))
                    receipt_sha = digest_bytes(facts_path.read_bytes())
                    terminal = "EXTRACTION_PASS"
                    reason = (
                        "The Inline XBRL structured lane extracted "
                        f"{fact_table['fact_count']} facts across {fact_table['context_count']} contexts."
                    )
                else:
                    terminal = "NEEDS_EXTRACTION_REVIEW"
                    receipt_sha = None
                    reason = (
                        "The Inline XBRL structured lane could not produce a fact table: "
                        f"{(completed.stderr or b'').decode()[-200:]}"
                    )
        else:
            attempted = True
            facts = EXTRACTION_FACTS_BY_SHA.get(raw_sha)
            assert facts is not None, f"No extraction facts are bound for {source['candidate_id']}"
            with tempfile.TemporaryDirectory(prefix="real-filing-extraction-") as temp:
                temp_root = Path(temp)
                request_path = temp_root / "request.json"
                extraction_root = temp_root / "extraction"
                request = {
                    "schema_version": "filings-extraction-request/1.0",
                    "run_id": f"real-corpus-{source['candidate_id']}",
                    "documents": [{
                        "document_id": declaration["document_id"],
                        "attachment_id": declaration["document_id"],
                        "source_id": declaration["document_id"],
                        "path": str(target),
                    }],
                    "filing_facts": facts,
                }
                request_path.write_bytes(canonical(request))
                completed = subprocess.run(
                    [sys.executable, str(EXTRACTOR), str(request_path), "--out", str(extraction_root)],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=300,
                )
                receipt_path = extraction_root / "filings-native-extraction-receipt.json"
                if not receipt_path.is_file():
                    raise AssertionError(
                        f"Production extractor emitted no receipt for {source['candidate_id']} "
                        f"(exit {completed.returncode})."
                    )
                native_receipt = json.loads(receipt_path.read_text("utf-8"))
                receipt_sha = digest_bytes(receipt_path.read_bytes())
                if completed.returncode == 0 and native_receipt["status"] == "PASS":
                    terminal = "EXTRACTION_PASS"
                    reason = "The production filing extractor completed with no findings."
                else:
                    terminal = "NEEDS_EXTRACTION_REVIEW"
                    finding_codes = sorted({item["code"] for item in native_receipt.get("findings", [])})
                    reason = (
                        "The production filing extractor ran and returned NEEDS_REVIEW with "
                        f"{len(native_receipt.get('findings', []))} findings: "
                        f"{', '.join(finding_codes) or 'unclassified extractor failure'}."
                    )
        outcomes.append({
            "candidate_id": source["candidate_id"],
            "raw_sha256": raw_sha,
            "media_kind": media,
            "attempted": attempted,
            "terminal_status": terminal,
            "receipt_sha256": receipt_sha if attempted else None,
            "reason": reason,
        })
    extraction_pass_count = sum(item["terminal_status"] == "EXTRACTION_PASS" for item in outcomes)
    body = {
        "schema_version": "real-filing-corpus-extraction-outcomes/1.0",
        "classification_receipt_sha256": digest_bytes(CLASSIFICATION.read_bytes()),
        "manifest_sha256": digest_bytes(manifest_path.read_bytes()),
        "status": "PASS" if extraction_pass_count == len(outcomes) else "BLOCKED",
        "extraction_pass_count": extraction_pass_count,
        "blocked_document_count": sum(item["terminal_status"].startswith("BLOCKED_") for item in outcomes),
        "documents": sorted(outcomes, key=lambda item: item["candidate_id"]),
        "interpretation": "Classification coverage is not extraction proof; each document retains its actual terminal outcome.",
    }
    return body


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest")
    parser.add_argument("--out")
    args = parser.parse_args()
    classification = json.loads(CLASSIFICATION.read_text("utf-8"))
    if args.manifest:
        assert args.out
        receipt = compile_live(Path(args.manifest).resolve(), classification)
        Path(args.out).write_bytes(canonical(receipt))
        validate(receipt, classification)
        print(json.dumps({"status": receipt["status"], "documents": 8, "extraction_passes": receipt["extraction_pass_count"], "blocked": receipt["blocked_document_count"]}, sort_keys=True))
        return 0
    receipt = json.loads(FROZEN.read_text("utf-8"))
    validate(receipt, classification)
    # The launder mutation must stay adversarial at ANY honest frontier:
    # demote one genuinely passing document while leaving the aggregate
    # claiming its old counts — a receipt that keeps summing to PASS while a
    # member no longer passes is exactly the laundering validate() must catch.
    classificationLaunder = json.loads(json.dumps(receipt))
    demoted = next(
        item for item in classificationLaunder["documents"]
        if item["terminal_status"] == "EXTRACTION_PASS"
    )
    demoted["terminal_status"] = "NEEDS_EXTRACTION_REVIEW"
    demoted["reason"] = "mutation: demoted without recount"
    try:
        validate(classificationLaunder, classification)
    except AssertionError:
        pass
    else:
        raise AssertionError("classification-only evidence was laundered into extraction PASS")
    missing = json.loads(json.dumps(receipt))
    missing["documents"].pop()
    try:
        validate(missing, classification)
    except AssertionError:
        pass
    else:
        raise AssertionError("a missing real-corpus document escaped the outcome contract")
    print(json.dumps({
        "status": "PASS",
        "documents": 8,
        "extraction_passes": receipt["extraction_pass_count"],
        "blocked": receipt["blocked_document_count"],
        "needs_review": sum(
            item["terminal_status"] == "NEEDS_EXTRACTION_REVIEW"
            for item in receipt["documents"]
        ),
        "mutations_caught": 2,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
