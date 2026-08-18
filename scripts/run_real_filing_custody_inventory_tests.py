#!/usr/bin/env python3
"""Validate the redacted, hash-only real-filing custody assessment."""

from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
INVENTORY = ROOT / "test-fixtures" / "real-filings-custody-v1" / "candidate-inventory.json"
RECEIPT = ROOT / "test-fixtures" / "real-filings-custody-v1" / "corpus-classification-receipt.json"
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
REQUIRED_MATRIX = {
    "accounting_framework": {"ifrs", "us_gaap"},
    "issuer_region": {"uk", "eu", "us", "ireland"},
    "reporting_period": {"annual", "interim"},
    "document_format": {"html", "native_pdf", "scanned_pdf"},
    "statement_structure": {
        "multi_page_cash_flow",
        "repeated_headers",
        "parent_first_subtotals",
        "parent_last_subtotals",
        "different_units",
        "dashes_blanks_zeroes",
        "footnote_references",
        "long_captions",
        "unfamiliar_adjusted_profit_terms",
    },
}


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


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


def validate_corpus_matrix(matrix: dict, known_candidate_ids: set[str]) -> list[str]:
    errors: list[str] = []
    if set(matrix) != {
        "schema_version", "matrix_status", "classification_contract", "dimensions",
    }:
        errors.append("matrix fields are not exact")
    if matrix.get("schema_version") != "real-filing-corpus-design-matrix/1.0":
        errors.append("wrong matrix schema version")
    if not isinstance(matrix.get("classification_contract"), str) or not matrix["classification_contract"]:
        errors.append("matrix omits its classification contract")
    dimensions = matrix.get("dimensions")
    if not isinstance(dimensions, dict) or set(dimensions) != set(REQUIRED_MATRIX):
        return [*errors, "matrix dimensions are not exact"]
    unavailable_count = 0
    for dimension, required_categories in REQUIRED_MATRIX.items():
        entries = dimensions.get(dimension)
        if not isinstance(entries, list):
            errors.append(f"{dimension} is not a category list")
            continue
        category_ids = [entry.get("category_id") for entry in entries if isinstance(entry, dict)]
        if len(category_ids) != len(set(category_ids)) or set(category_ids) != required_categories:
            errors.append(f"{dimension} categories are not exact")
        for entry in entries:
            if not isinstance(entry, dict):
                errors.append(f"{dimension} contains a non-object category")
                continue
            category = f"{dimension}.{entry.get('category_id')}"
            if set(entry) != {
                "category_id", "status", "candidate_ids",
                "classification_receipt_sha256", "blocker_code",
            }:
                errors.append(f"{category} fields are not exact")
                continue
            candidate_ids = entry["candidate_ids"]
            if not isinstance(candidate_ids, list) or len(candidate_ids) != len(set(candidate_ids)):
                errors.append(f"{category} candidate_ids are not a unique list")
                continue
            if any(candidate_id not in known_candidate_ids for candidate_id in candidate_ids):
                errors.append(f"{category} cites an unknown candidate")
            if entry["status"] == "HASH_BOUND_VERIFIED":
                if not candidate_ids or not SHA256_RE.fullmatch(
                    str(entry["classification_receipt_sha256"] or "")
                ) or entry["blocker_code"] is not None:
                    errors.append(f"{category} verified status lacks hash-bound evidence")
            elif entry["status"] == "UNAVAILABLE_EXTERNAL_EVIDENCE":
                unavailable_count += 1
                if (
                    candidate_ids
                    or entry["classification_receipt_sha256"] is not None
                    or not isinstance(entry["blocker_code"], str)
                    or not entry["blocker_code"]
                ):
                    errors.append(f"{category} unavailable status fabricates or omits evidence")
            else:
                errors.append(f"{category} has an unknown status")
    expected_status = (
        "INCOMPLETE_EXTERNAL_EVIDENCE"
        if unavailable_count
        else "COMPLETE_HASH_BOUND_COVERAGE"
    )
    if matrix.get("matrix_status") != expected_status:
        errors.append("matrix status does not match category evidence")
    return errors


def validate_classification_receipt(receipt: dict) -> list[str]:
    errors: list[str] = []
    if set(receipt) != {
        "schema_version", "status", "corpus_id_sha256", "document_count",
        "candidate_set_sha256", "documents", "category_count",
        "verified_category_count", "categories", "coverage_sha256",
        "licensed_or_public_document_bytes_in_repository", "source_text_in_receipt",
        "violations",
    }:
        errors.append("receipt fields are not exact")
    if receipt.get("schema_version") != "real-filing-corpus-classification-receipt/1.0":
        errors.append("wrong receipt schema version")
    if receipt.get("status") != "PASS" or receipt.get("violations") != 0:
        errors.append("receipt does not pass")
    if receipt.get("licensed_or_public_document_bytes_in_repository") is not False:
        errors.append("receipt permits source document bytes in the repository")
    if receipt.get("source_text_in_receipt") is not False:
        errors.append("receipt permits source text")
    if not SHA256_RE.fullmatch(str(receipt.get("corpus_id_sha256", ""))):
        errors.append("receipt corpus id hash is invalid")

    documents = receipt.get("documents")
    if not isinstance(documents, list):
        return [*errors, "receipt documents are not a list"]
    if receipt.get("document_count") != len(documents) or not documents:
        errors.append("receipt document count is wrong")
    raw_hashes: list[str] = []
    receipt_candidate_ids: set[str] = set()
    for document in documents:
        if not isinstance(document, dict) or set(document) != {
            "document_id_sha256", "candidate_id", "raw_sha256", "raw_byte_count",
            "source_host", "source_locator_sha256", "media_kind", "media_metrics",
        }:
            errors.append("receipt document fields are not exact")
            continue
        raw_hash = str(document["raw_sha256"])
        if not SHA256_RE.fullmatch(raw_hash):
            errors.append("receipt document hash is invalid")
            continue
        expected_candidate_id = sha256(f"real-filing-candidate:{raw_hash}")[:16]
        if document["candidate_id"] != expected_candidate_id:
            errors.append("receipt candidate id is not bound to its raw hash")
        if document["candidate_id"] in receipt_candidate_ids:
            errors.append("receipt candidate id is duplicated")
        receipt_candidate_ids.add(document["candidate_id"])
        raw_hashes.append(raw_hash)
        if not SHA256_RE.fullmatch(str(document["document_id_sha256"])):
            errors.append("receipt document id hash is invalid")
        if not SHA256_RE.fullmatch(str(document["source_locator_sha256"])):
            errors.append("receipt source locator hash is invalid")
        if not isinstance(document["raw_byte_count"], int) or document["raw_byte_count"] <= 0:
            errors.append("receipt byte count is invalid")
        if document["media_kind"] not in {"html", "pdf"}:
            errors.append("receipt media kind is invalid")
        if not isinstance(document["media_metrics"], dict) or not document["media_metrics"]:
            errors.append("receipt media metrics are absent")
        host = document["source_host"]
        if not isinstance(host, str) or not host or any(token in host for token in ("/", ":", " ")):
            errors.append("receipt source host is invalid")
    expected_candidate_set = sha256("\n".join(sorted(raw_hashes)) + "\n")
    if receipt.get("candidate_set_sha256") != expected_candidate_set:
        errors.append("receipt candidate set hash is wrong")

    categories = receipt.get("categories")
    if not isinstance(categories, list):
        return [*errors, "receipt categories are not a list"]
    expected_pairs = {
        (dimension, category)
        for dimension, category_ids in REQUIRED_MATRIX.items()
        for category in category_ids
    }
    actual_pairs: list[tuple[str, str]] = []
    for category in categories:
        if not isinstance(category, dict) or set(category) != {
            "dimension", "category_id", "status", "candidate_ids", "proof_kind",
            "proof_sha256", "witness_count", "witnesses_sha256",
        }:
            errors.append("receipt category fields are not exact")
            continue
        pair = (category["dimension"], category["category_id"])
        actual_pairs.append(pair)
        if category["status"] != "HASH_BOUND_VERIFIED":
            errors.append("receipt category is not verified")
        candidate_ids = category["candidate_ids"]
        if (
            not isinstance(candidate_ids, list)
            or not candidate_ids
            or len(candidate_ids) != len(set(candidate_ids))
            or any(candidate_id not in receipt_candidate_ids for candidate_id in candidate_ids)
        ):
            errors.append("receipt category candidates are invalid")
        if not isinstance(category["proof_kind"], str) or not category["proof_kind"]:
            errors.append("receipt proof kind is absent")
        if not SHA256_RE.fullmatch(str(category["proof_sha256"])):
            errors.append("receipt proof hash is invalid")
        if not SHA256_RE.fullmatch(str(category["witnesses_sha256"])):
            errors.append("receipt witness hash is invalid")
        if not isinstance(category["witness_count"], int) or category["witness_count"] <= 0:
            errors.append("receipt witness count is invalid")
    if len(actual_pairs) != len(set(actual_pairs)) or set(actual_pairs) != expected_pairs:
        errors.append("receipt category coverage is not exact")
    if receipt.get("category_count") != len(categories):
        errors.append("receipt category count is wrong")
    if receipt.get("verified_category_count") != len(categories):
        errors.append("receipt verified category count is wrong")
    if receipt.get("coverage_sha256") != sha256(canonical_json(categories)):
        errors.append("receipt coverage hash is wrong")
    return errors


inventory = json.loads(INVENTORY.read_text("utf-8"))
receipt = json.loads(RECEIPT.read_text("utf-8"))
assert inventory["schema_version"] == "real-filing-custody-inventory/1.1"
walk(inventory)
walk(receipt)
assert not validate_classification_receipt(receipt)

candidates = inventory["candidates"]
assert len(candidates) == inventory["candidate_count"]
assert len({candidate["candidate_id"] for candidate in candidates}) == len(candidates)
candidate_ids = {candidate["candidate_id"] for candidate in candidates}
receipt_candidate_ids = {document["candidate_id"] for document in receipt["documents"]}

matrix = inventory["corpus_design_matrix"]
assert not validate_corpus_matrix(matrix, receipt_candidate_ids)
unavailable_categories = sorted(
    f"{dimension}.{entry['category_id']}"
    for dimension, entries in matrix["dimensions"].items()
    for entry in entries
    if entry["status"] == "UNAVAILABLE_EXTERNAL_EVIDENCE"
)
assert unavailable_categories == []
assert matrix["matrix_status"] == "COMPLETE_HASH_BOUND_COVERAGE"

receipt_categories = {
    (entry["dimension"], entry["category_id"]): entry
    for entry in receipt["categories"]
}
for dimension, entries in matrix["dimensions"].items():
    for entry in entries:
        receipt_entry = receipt_categories[(dimension, entry["category_id"])]
        assert entry["candidate_ids"] == receipt_entry["candidate_ids"]
        assert entry["classification_receipt_sha256"] == receipt_entry["proof_sha256"]

# Each fail-closed rule must reject independently after the surrounding matrix
# remains structurally valid; none may rely on the production inventory being
# incomplete for a different reason.
matrix_mutations: list[tuple[str, dict, str]] = []
known_candidate = sorted(receipt_candidate_ids)[0]
missing_category = deepcopy(matrix)
missing_category["dimensions"]["document_format"].pop()
matrix_mutations.append(("missing_category", missing_category, "categories are not exact"))
fake_verified = deepcopy(matrix)
fake_verified["dimensions"]["accounting_framework"][0].update({
    "status": "HASH_BOUND_VERIFIED", "candidate_ids": [known_candidate],
    "classification_receipt_sha256": None, "blocker_code": None,
})
matrix_mutations.append(("verified_without_receipt", fake_verified, "lacks hash-bound evidence"))
fabricated_unavailable = deepcopy(matrix)
fabricated_unavailable["dimensions"]["reporting_period"][0].update({
    "status": "UNAVAILABLE_EXTERNAL_EVIDENCE", "candidate_ids": [known_candidate],
    "classification_receipt_sha256": None, "blocker_code": "TEST_BLOCKER",
})
matrix_mutations.append(("unavailable_with_candidate", fabricated_unavailable, "fabricates or omits evidence"))
unknown_candidate = deepcopy(matrix)
unknown_entry = unknown_candidate["dimensions"]["document_format"][0]
unknown_entry.update({
    "status": "HASH_BOUND_VERIFIED", "candidate_ids": ["unknown-candidate"],
    "classification_receipt_sha256": "a" * 64, "blocker_code": None,
})
matrix_mutations.append(("unknown_candidate", unknown_candidate, "cites an unknown candidate"))
for mutation_name, mutation, expected_error in matrix_mutations:
    mutation_errors = validate_corpus_matrix(mutation, receipt_candidate_ids)
    assert any(expected_error in error for error in mutation_errors), (
        mutation_name, mutation_errors
    )

# The frozen receipt must reject independent hash, coverage, and redaction
# mutations without needing access to the external source documents.
receipt_mutations: list[tuple[str, dict, str]] = []
changed_raw_hash = deepcopy(receipt)
changed_raw_hash["documents"][0]["raw_sha256"] = "0" * 64
receipt_mutations.append(("changed_raw_hash", changed_raw_hash, "candidate id is not bound"))
changed_proof_hash = deepcopy(receipt)
changed_proof_hash["categories"][0]["proof_sha256"] = "0" * 64
receipt_mutations.append(("changed_proof_hash", changed_proof_hash, "coverage hash is wrong"))
missing_receipt_category = deepcopy(receipt)
missing_receipt_category["categories"].pop()
missing_receipt_category["category_count"] -= 1
missing_receipt_category["verified_category_count"] -= 1
receipt_mutations.append(("missing_receipt_category", missing_receipt_category, "coverage is not exact"))
changed_candidate_set = deepcopy(receipt)
changed_candidate_set["candidate_set_sha256"] = "0" * 64
receipt_mutations.append(("changed_candidate_set", changed_candidate_set, "candidate set hash is wrong"))
changed_coverage = deepcopy(receipt)
changed_coverage["coverage_sha256"] = "0" * 64
receipt_mutations.append(("changed_coverage", changed_coverage, "coverage hash is wrong"))
for mutation_name, mutation, expected_error in receipt_mutations:
    mutation_errors = validate_classification_receipt(mutation)
    assert any(expected_error in error for error in mutation_errors), (
        mutation_name, mutation_errors
    )

redaction_mutations = []
path_mutation = deepcopy(receipt)
path_mutation["documents"][0]["path"] = "/forbidden/source.pdf"
redaction_mutations.append(("path", path_mutation))
url_mutation = deepcopy(receipt)
url_mutation["documents"][0]["url"] = "https://forbidden.invalid/source"
redaction_mutations.append(("url", url_mutation))
source_text_mutation = deepcopy(receipt)
source_text_mutation["categories"][0]["source_text"] = "forbidden witness text"
redaction_mutations.append(("source_text", source_text_mutation))
for mutation_name, mutation in redaction_mutations:
    try:
        walk(mutation)
    except AssertionError:
        pass
    else:
        raise AssertionError(f"{mutation_name} redaction mutation was accepted")

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
    "corpus_matrix_status": matrix["matrix_status"],
    "corpus_receipt_status": receipt["status"],
    "verified_external_evidence_categories": receipt["verified_category_count"],
    "unavailable_external_evidence_categories": unavailable_categories,
    "matrix_mutations_rejected": len(matrix_mutations),
    "receipt_mutations_rejected": len(receipt_mutations) + len(redaction_mutations),
    "licensed_or_public_document_bytes_in_repository": False,
    "violations": 0,
}, sort_keys=True))
