#!/usr/bin/env python3
"""Independent source-economic oracle and adversarial mutation proof.

This verifier intentionally uses only the Python standard library. Its source
facts, expected economic meanings, and known-good observations are manually
authored below; none is compiled from product output or a product schema.
"""

from __future__ import annotations

import ast
import copy
import hashlib
import json
from decimal import Decimal
from pathlib import Path
from typing import Any


SOURCE_FACTS = {
    "typed_values": [
        {
            "source_line_id": "source.cash.unreported_component",
            "source_description": "Unreported cash-flow component",
            "source_value": None,
            "source_value_state": "reported_blank",
        },
        {
            "source_line_id": "source.cash.reported_zero_component",
            "source_description": "Reported zero cash-flow component",
            "source_value": 0,
            "source_value_state": "reported_zero",
        },
    ],
    "debt_descriptions": [
        {
            "source_line_id": "source.debt.senior_notes",
            "source_description": "5.25% senior notes due 2031",
        },
        {
            "source_line_id": "source.debt.revolving_facility",
            "source_description": "Committed revolving credit facility",
        },
        {
            "source_line_id": "source.debt.other_borrowings",
            "source_description": "Other borrowings and overdrafts",
        },
    ],
    "ebitda_facts": [
        {
            "source_line_id": "source.income.operating_profit",
            "source_description": "Operating profit",
            "value": "100",
        },
        {
            "source_line_id": "source.income.depreciation_amortisation",
            "source_description": "Depreciation and amortisation",
            "value": "20",
        },
        {
            "source_line_id": "source.income.impairment",
            "source_description": "Impairment charge",
            "value": "7",
        },
    ],
}


EXPECTED_OUTCOMES = {
    "typed_values": [
        {
            "source_line_id": "source.cash.unreported_component",
            "model_value": None,
            "model_value_state": "reported_blank",
        },
        {
            "source_line_id": "source.cash.reported_zero_component",
            "model_value": 0,
            "model_value_state": "reported_zero",
        },
    ],
    "debt_classes": [
        {
            "source_line_id": "source.debt.senior_notes",
            "expected_debt_class": "bond_fixed",
        },
        {
            "source_line_id": "source.debt.revolving_facility",
            "expected_debt_class": "rcf",
        },
        {
            "source_line_id": "source.debt.other_borrowings",
            "expected_debt_class": "other_explicit",
        },
    ],
    "ebitda": {
        "expected_value": "120",
        "included_source_line_ids": [
            "source.income.operating_profit",
            "source.income.depreciation_amortisation",
        ],
        "excluded_source_line_ids": ["source.income.impairment"],
    },
}


KNOWN_GOOD_OBSERVATION = {
    "typed_values": [
        {
            "source_line_id": "source.cash.unreported_component",
            "model_value": None,
            "model_value_state": "reported_blank",
        },
        {
            "source_line_id": "source.cash.reported_zero_component",
            "model_value": 0,
            "model_value_state": "reported_zero",
        },
    ],
    "debt_classes": [
        {
            "source_line_id": "source.debt.senior_notes",
            "observed_debt_class": "bond_fixed",
        },
        {
            "source_line_id": "source.debt.revolving_facility",
            "observed_debt_class": "rcf",
        },
        {
            "source_line_id": "source.debt.other_borrowings",
            "observed_debt_class": "other_explicit",
        },
    ],
    "ebitda": {
        "observed_value": "120",
        "included_source_line_ids": [
            "source.income.operating_profit",
            "source.income.depreciation_amortisation",
        ],
    },
}


FROZEN_AUTHORITY_SHA256 = "1782f5603e0c0153d369081c1b499619422a5e33e0c78793d6d3e8a832fc398f"


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def by_id(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(row["source_line_id"]): row for row in rows}


def finding(code: str, source_line_id: str, message: str) -> dict[str, str]:
    return {
        "code": code,
        "source_line_id": source_line_id,
        "message": message,
    }


def verify_oracle_independence() -> dict[str, Any]:
    tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
    allowed_roots = {
        "__future__",
        "ast",
        "copy",
        "decimal",
        "hashlib",
        "json",
        "pathlib",
        "typing",
    }
    imported_roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported_roots.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported_roots.add((node.module or "").split(".", 1)[0])
    unexpected = sorted(imported_roots - allowed_roots)
    assert unexpected == [], f"Oracle imported non-standard dependencies: {unexpected}"
    float_constants = [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, float)
    ]
    assert float_constants == [], "Oracle introduced floating-point tolerance constants."
    return {
        "import_roots": sorted(imported_roots),
        "nonstandard_imports": 0,
        "floating_tolerance_constants": 0,
    }


def audit(observation: dict[str, Any]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    source_values = by_id(SOURCE_FACTS["typed_values"])
    expected_values = by_id(EXPECTED_OUTCOMES["typed_values"])
    observed_values = by_id(observation.get("typed_values", []))

    for source_line_id, source in source_values.items():
        expected = expected_values[source_line_id]
        observed = observed_values.get(source_line_id)
        if observed is None:
            findings.append(finding(
                "SOURCE_VALUE_MISSING",
                source_line_id,
                "The typed source observation is absent from the model output.",
            ))
            continue
        if source["source_value"] is None and observed.get("model_value") == 0:
            findings.append(finding(
                "SOURCE_VALUE_NULL_COERCED_TO_ZERO",
                source_line_id,
                "A reported blank was converted to a numeric zero.",
            ))
        if (
            observed.get("model_value") != expected["model_value"]
            or observed.get("model_value_state") != expected["model_value_state"]
        ):
            findings.append(finding(
                "SOURCE_VALUE_TYPED_STATE_MISMATCH",
                source_line_id,
                "The output value or typed state differs from manual source authority.",
            ))

    source_debt = by_id(SOURCE_FACTS["debt_descriptions"])
    expected_debt = by_id(EXPECTED_OUTCOMES["debt_classes"])
    observed_debt = by_id(observation.get("debt_classes", []))
    for source_line_id in source_debt:
        expected = expected_debt[source_line_id]["expected_debt_class"]
        observed = observed_debt.get(source_line_id)
        if observed is None or observed.get("observed_debt_class") != expected:
            findings.append(finding(
                "SOURCE_DEBT_CLASS_MISMATCH",
                source_line_id,
                "The observed debt class contradicts the manually adjudicated source description.",
            ))

    source_ebitda = by_id(SOURCE_FACTS["ebitda_facts"])
    expected_ebitda = EXPECTED_OUTCOMES["ebitda"]
    observed_ebitda = observation.get("ebitda") or {}
    expected_included = expected_ebitda["included_source_line_ids"]
    observed_included = observed_ebitda.get("included_source_line_ids") or []
    impairment_ids = set(expected_ebitda["excluded_source_line_ids"])
    if impairment_ids.intersection(observed_included):
        findings.append(finding(
            "SOURCE_EBITDA_IMPAIRMENT_INCLUDED",
            "source.income.impairment",
            "Impairment entered the reported EBITDA definition.",
        ))
    if observed_included != expected_included:
        findings.append(finding(
            "SOURCE_EBITDA_COMPONENT_SET_MISMATCH",
            "source.income.operating_profit",
            "The reported EBITDA component set differs from manual source authority.",
        ))
    recomputed = sum(
        Decimal(str(source_ebitda[source_line_id]["value"]))
        for source_line_id in expected_included
    )
    expected_value = Decimal(expected_ebitda["expected_value"])
    observed_value = Decimal(str(observed_ebitda.get("observed_value")))
    if recomputed != expected_value or observed_value != expected_value:
        findings.append(finding(
            "SOURCE_EBITDA_VALUE_MISMATCH",
            "source.income.operating_profit",
            "Reported EBITDA does not equal the exact manually authorised component sum.",
        ))
    return findings


def main() -> int:
    independence = verify_oracle_independence()
    frozen_authority = {
        "source_facts": SOURCE_FACTS,
        "expected_outcomes": EXPECTED_OUTCOMES,
        "known_good_observation": KNOWN_GOOD_OBSERVATION,
    }
    actual_sha256 = canonical_sha256(frozen_authority)
    if actual_sha256 != FROZEN_AUTHORITY_SHA256:
        raise AssertionError(
            "Manually authored source-economic authority changed without resealing: "
            f"{actual_sha256}"
        )

    clean_findings = audit(KNOWN_GOOD_OBSERVATION)
    assert clean_findings == [], clean_findings

    mutations: list[dict[str, Any]] = []

    null_to_zero = copy.deepcopy(KNOWN_GOOD_OBSERVATION)
    null_row = by_id(null_to_zero["typed_values"])["source.cash.unreported_component"]
    null_row["model_value"] = 0
    null_row["model_value_state"] = "reported_zero"
    null_codes = {item["code"] for item in audit(null_to_zero)}
    assert "SOURCE_VALUE_NULL_COERCED_TO_ZERO" in null_codes
    mutations.append({"id": "typed-null-to-zero", "caught": True, "codes": sorted(null_codes)})

    bond_to_other = copy.deepcopy(KNOWN_GOOD_OBSERVATION)
    bond_row = by_id(bond_to_other["debt_classes"])["source.debt.senior_notes"]
    bond_row["observed_debt_class"] = "other_explicit"
    debt_codes = {item["code"] for item in audit(bond_to_other)}
    assert "SOURCE_DEBT_CLASS_MISMATCH" in debt_codes
    mutations.append({"id": "bond-to-other-debt", "caught": True, "codes": sorted(debt_codes)})

    impairment_included = copy.deepcopy(KNOWN_GOOD_OBSERVATION)
    impairment_included["ebitda"]["included_source_line_ids"].append(
        "source.income.impairment"
    )
    impairment_included["ebitda"]["observed_value"] = "127"
    ebitda_codes = {item["code"] for item in audit(impairment_included)}
    assert "SOURCE_EBITDA_IMPAIRMENT_INCLUDED" in ebitda_codes
    assert "SOURCE_EBITDA_VALUE_MISMATCH" in ebitda_codes
    mutations.append({"id": "impairment-in-ebitda", "caught": True, "codes": sorted(ebitda_codes)})

    print(json.dumps({
        "status": "PASS",
        "oracle": "independent-source-economic-oracle/1.0",
        "frozen_authority_sha256": actual_sha256,
        "positive_checks": 3,
        "mutations_caught": len(mutations),
        "mutations": mutations,
        "independence": independence,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
