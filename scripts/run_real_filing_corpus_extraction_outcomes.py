#!/usr/bin/env python3
"""Bind real-corpus extraction outcomes without laundering classification as extraction."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
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
# classification dimensions, so extraction facts are DERIVED per document at
# run time: historical periods come from the dated headers extracted out of
# the document text, and reporting currency/units come from document-text
# regexes.  The historical hand-bound table below is demoted to a marked,
# fail-closed fallback: it is consulted only when text derivation cannot bind
# every fact (or when the derived attempt does not survive extraction), and an
# outcome it produced records ``extraction_facts_source: "legacy_table"``
# instead of laundering hand-bound data as derived evidence.
LEGACY_EXTRACTION_FACTS_BY_SHA = {
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

FACT_KEYS = ("historical_periods", "reporting_currency", "units")
MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12, "sept": 9,
}
MONTH_RE = "|".join(MONTHS)
# Dated headers: "31 March 2025", "September 30, 2025", "January 1,1989",
# "2025-09-30".
DMY_DATE_RE = re.compile(
    r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(%s)\.?,?\s+(\d{4})\b" % MONTH_RE, re.IGNORECASE)
MDY_DATE_RE = re.compile(
    r"\b(%s)\.?\s+(\d{1,2}),?\s*(\d{4})\b" % MONTH_RE, re.IGNORECASE)
ISO_DATE_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
YEAR_TOKEN_RE = re.compile(r"\b((?:19|20)\d{2})\b")
CURRENCY_PATTERNS = (
    (re.compile(r"US\$|\bUSD\b|(?<!HK)\$"), "USD"),
    (re.compile(r"£|\bGBP\b"), "GBP"),
    (re.compile(r"€|\bEUR\b"), "EUR"),
    (re.compile(r"\b(?:RMB|CNY)\b|¥"), "CNY"),
)
UNIT_WORD_RE = re.compile(r"\b(?:in|of)\s+(thousands|millions|billions)\b", re.IGNORECASE)
SYMBOL_UNIT_RE = re.compile(r"((?:US)?\$|[£€])[\s('']?(m|k|bn|b)\b")
RMB_THOUSANDS_RE = re.compile(r"(?:RMB|CNY)\s*[(’']?000", re.IGNORECASE)


def pdf_document_text(target: Path) -> str:
    """Extracted header/body text of a PDF, best effort."""
    try:
        import fitz
    except Exception:
        return ""
    try:
        with fitz.open(target) as document:
            return "\n".join(page.get_text() for page in document)
    except Exception:
        return ""


def derive_historical_periods(text: str) -> list[str] | None:
    """Bind three historical periods from dated headers in the document text."""
    dated: dict[int, dict[str, int]] = {}

    def record(year: int, month: int, day: int) -> None:
        if 1 <= month <= 12 and 1 <= day <= 31 and 1900 <= year <= 2100:
            dated.setdefault(year, {})
            key = f"{month:02d}-{day:02d}"
            dated[year][key] = dated[year].get(key, 0) + 1

    for match in DMY_DATE_RE.finditer(text):
        record(int(match.group(3)), MONTHS[match.group(2).lower()], int(match.group(1)))
    for match in MDY_DATE_RE.finditer(text):
        record(int(match.group(3)), MONTHS[match.group(1).lower()], int(match.group(2)))
    for match in ISO_DATE_RE.finditer(text):
        record(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    if not dated:
        return None
    anchor_year = max(dated)
    anchor_md = sorted(dated[anchor_year].items(), key=lambda item: (-item[1], item[0]))[0][0]
    anchor_number = int(anchor_year)
    window = {
        int(year) for year in YEAR_TOKEN_RE.findall(text)
        if anchor_number - 4 <= int(year) <= anchor_number
    }
    window.add(anchor_number)
    recent = sorted(window)[-3:]
    if len(recent) < 3:
        return None
    return [f"{year}-{anchor_md}" for year in recent]


def derive_reporting_currency(text: str) -> str | None:
    counts: dict[str, int] = {}
    for pattern, code in CURRENCY_PATTERNS:
        hits = len(pattern.findall(text))
        if hits:
            counts[code] = counts.get(code, 0) + hits
    return max(counts, key=lambda code: (counts[code], code)) if counts else None


def derive_units(text: str) -> str | None:
    magnitudes = {"m": "millions", "k": "thousands", "bn": "billions", "b": "billions"}
    counts: dict[str, int] = {}
    for word in UNIT_WORD_RE.findall(text):
        counts[word.lower()] = counts.get(word.lower(), 0) + 1
    for symbol, suffix in SYMBOL_UNIT_RE.findall(text):
        magnitude = magnitudes.get(suffix.lower())
        if magnitude:
            counts[magnitude] = counts.get(magnitude, 0) + 1
    if RMB_THOUSANDS_RE.search(text):
        counts["thousands"] = counts.get("thousands", 0) + 1
    return max(counts, key=lambda word: (counts[word], word)) if counts else None


def derive_extraction_facts(target: Path) -> dict[str, Any]:
    """Facts bound from the extracted document text alone (possibly partial)."""
    text = pdf_document_text(target)
    derived: dict[str, Any] = {}
    periods = derive_historical_periods(text)
    if periods:
        derived["historical_periods"] = periods
    currency = derive_reporting_currency(text)
    if currency:
        derived["reporting_currency"] = currency
    units = derive_units(text)
    if units:
        derived["units"] = units
    return derived


def extraction_fact_candidates(target: Path, raw_sha256: str) -> list[tuple[str, dict[str, Any]]]:
    """Ordered (source, request_facts) bindings: derived first, legacy fallback.

    A derived candidate is offered only when text derivation bound EVERY fact;
    a partial derivation would poison extraction rather than help it.  The
    legacy candidate is the historical hand-bound entry verbatim, tried as the
    marked fallback whenever derivation is incomplete or did not pass.
    """
    candidates: list[tuple[str, dict[str, Any]]] = []
    derived = derive_extraction_facts(target)
    if all(key in derived for key in FACT_KEYS):
        candidates.append(("document_text", {key: derived[key] for key in FACT_KEYS}))
    legacy = LEGACY_EXTRACTION_FACTS_BY_SHA.get(raw_sha256)
    if legacy is not None:
        candidates.append(("legacy_table", {key: legacy[key] for key in FACT_KEYS}))
    if not candidates:
        raise AssertionError(
            f"No extraction facts are derivable or bound for sha {raw_sha256}"
        )
    return candidates


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
        facts_source = None
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
            with tempfile.TemporaryDirectory(prefix="real-filing-extraction-") as temp:
                temp_root = Path(temp)
                request_path = temp_root / "request.json"
                extraction_root = temp_root / "extraction"
                receipt_path = extraction_root / "filings-native-extraction-receipt.json"
                native_receipt = None
                completed = None
                for facts_source, facts in extraction_fact_candidates(target, raw_sha):
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
                    receipt_path.unlink(missing_ok=True)
                    completed = subprocess.run(
                        [sys.executable, str(EXTRACTOR), str(request_path), "--out", str(extraction_root)],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=300,
                    )
                    if not receipt_path.is_file():
                        continue
                    native_receipt = json.loads(receipt_path.read_text("utf-8"))
                    if completed.returncode == 0 and native_receipt["status"] == "PASS":
                        break
                if native_receipt is None:
                    raise AssertionError(
                        f"Production extractor emitted no receipt for {source['candidate_id']} "
                        f"under any extraction-facts binding."
                    )
                assert completed is not None
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
            "extraction_facts_source": facts_source,
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
