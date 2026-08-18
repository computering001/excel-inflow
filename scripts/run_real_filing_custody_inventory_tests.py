#!/usr/bin/env python3
"""Validate the redacted, hash-only real-filing custody assessment."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
INVENTORY = ROOT / "test-fixtures" / "real-filings-custody-v1" / "candidate-inventory.json"
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
FORBIDDEN_KEYS = {
    "company",
    "entity",
    "issuer",
    "path",
    "quote",
    "source_text",
    "source_value",
    "text",
    "url",
    "values",
}
FORBIDDEN_STRING_FRAGMENTS = ("/Users/", ".pdf", "http://", "https://")


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def walk(value: Any, trail: tuple[str, ...] = ()) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key.lower() in FORBIDDEN_KEYS:
                raise AssertionError(f"forbidden custody key at {'.'.join((*trail, key))}")
            walk(child, (*trail, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            walk(child, (*trail, str(index)))
    elif isinstance(value, str):
        if any(fragment in value for fragment in FORBIDDEN_STRING_FRAGMENTS):
            raise AssertionError(f"unredacted locator at {'.'.join(trail)}")


inventory = json.loads(INVENTORY.read_text("utf-8"))
assert inventory["schema_version"] == "real-filing-custody-inventory/1.0"
walk(inventory)

candidates = inventory["candidates"]
assert len(candidates) == inventory["candidate_count"]
assert len({candidate["candidate_id"] for candidate in candidates}) == len(candidates)

raw_hashes = []
for candidate in candidates:
    raw_hash = candidate["raw_sha256"]
    assert SHA256_RE.fullmatch(raw_hash)
    assert candidate["candidate_id"] == sha256(f"real-filing-candidate:{raw_hash}")[:16]
    raw_hashes.append(raw_hash)
    candidate_eligible = all(candidate["qualifications"].values())
    assert bool(candidate["blocker_codes"]) is (not candidate_eligible)
    for witness_group in ("document_metric_witnesses", "statement_heading_witnesses"):
        for witness in candidate.get(witness_group, []):
            assert set(witness) in (
                {"metric_kind", "page_ordinal", "line_sha256"},
                {"statement_kind", "page_ordinal", "line_sha256"},
            )
            assert isinstance(witness["page_ordinal"], int) and witness["page_ordinal"] > 0
            assert SHA256_RE.fullmatch(witness["line_sha256"])

candidate_set_hash = sha256("\n".join(sorted(raw_hashes)) + "\n")
assert candidate_set_hash == inventory["candidate_set_sha256"]

required = inventory["eligibility_contract"]["required_boolean_fields"]
eligible = []
for candidate in candidates:
    qualifications = candidate["qualifications"]
    assert set(qualifications) == set(required)
    assert all(isinstance(qualifications[field], bool) for field in required)
    if all(qualifications[field] for field in required):
        eligible.append(candidate["candidate_id"])

assert len(eligible) == inventory["eligible_candidate_count"] == 1
assert inventory["assessment_status"] == "HASH_BOUND_CUSTODY_ESTABLISHED_EXACT_CONTRACT_PASS"

selected = next(
    candidate
    for candidate in candidates
    if candidate["candidate_id"] == inventory["selected_custody_candidate_id"]
)
assert selected["custody_class"] == "official_public_external"
assert selected["qualifications"]["request_expectations_pair"] is True
assert selected["qualifications"]["three_period_face_statements_selected"] is True
assert selected["qualifications"]["selected_authority_has_pure_da_or_ebitda"] is True
assert selected["qualifications"]["separate_interest_authorities_available"] is True
assert selected["qualifications"]["explicit_fx_or_source_proven_zero_available"] is True
assert selected["qualifications"]["real_raw_canary_pass"] is True
assert selected["proof"]["native_pipeline_status"] == "PASS"
assert selected["proof"]["real_raw_canary_status"] == "PASS"
assert all(
    SHA256_RE.fullmatch(value)
    for key, value in selected["proof"].items()
    if key.endswith("_sha256")
)

print(json.dumps({
    "schema_version": "real-filing-custody-inventory-tests/1.0",
    "status": "PASS",
    "candidate_count": len(candidates),
    "eligible_candidate_count": len(eligible),
    "hash_bound_custody_established": True,
    "licensed_or_public_document_bytes_in_repository": False,
    "violations": 0,
}, sort_keys=True))
