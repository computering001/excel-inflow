#!/usr/bin/env python3
"""Neutral mutation tests for workbook protected-identity proof rules."""

from __future__ import annotations

import json

from workbook_semantic_oracle import Cell, Sheet, WorkbookFacts, verify


def cell(address: str, *, value=None, formula=None) -> Cell:
    return Cell(
        address=address,
        value=value,
        formula=formula,
        style_id=0,
        data_type=None,
    )


def facts(owner: Cell) -> WorkbookFacts:
    cells = {
        "B10": cell("B10", value="Investing total"),
        "B11": cell("B11", value="Asset purchases"),
        "B12": cell("B12", value="Investment receipts"),
        "J10": owner,
        "J11": cell("J11", value=-12.0),
        "J12": cell("J12", value=3.0),
        "I10": cell("I10", value=-8.0),
    }
    return WorkbookFacts(
        sheets={"Operating Model": Sheet("Operating Model", cells, {})},
        styles=[{}],
        defined_names={},
        media_sha256=[],
    )


CONTRACT = {
    "statement_sheet": "Operating Model",
    "forecast_columns": ["J"],
    "protected_formula_identities": [
        {
            "concept_id": "neutral_investing_total",
            "owner_row": 10,
            "member_rows": [11, 12],
            "columns": ["J"],
            "period_relation": "same_period",
        }
    ],
}


def protected_codes(owner: Cell) -> set[str]:
    report = verify(facts(owner), CONTRACT)
    return {
        finding["code"]
        for finding in report["findings"]
        if finding["code"].startswith("OOXML_PROTECTED_IDENTITY_")
    }


checks = [
    {
        "id": "correct-same-period-members",
        "actual": protected_codes(cell("J10", formula="J11+J12")),
        "expected": set(),
    },
    {
        "id": "hardcoded-protected-total",
        "actual": protected_codes(cell("J10", value=-9.0)),
        "expected": {"OOXML_PROTECTED_IDENTITY_FORMULA_REQUIRED"},
    },
    {
        "id": "prior-period-carry",
        "actual": protected_codes(cell("J10", formula="I10")),
        "expected": {
            "OOXML_PROTECTED_IDENTITY_PRIOR_PERIOD",
            "OOXML_PROTECTED_IDENTITY_MEMBER_MISSING",
        },
    },
    {
        "id": "current-period-member-omitted",
        "actual": protected_codes(cell("J10", formula="J11")),
        "expected": {"OOXML_PROTECTED_IDENTITY_MEMBER_MISSING"},
    },
]
failures = [
    {
        "id": check["id"],
        "expected": sorted(check["expected"]),
        "actual": sorted(check["actual"]),
    }
    for check in checks
    if check["actual"] != check["expected"]
]
report = {
    "kind": "protected-identity-oracle-tests/1.0",
    "status": "FAIL" if failures else "PASS",
    "checks": len(checks),
    "violations": len(failures),
    "failures": failures,
}
print(json.dumps(report, indent=2))
raise SystemExit(1 if failures else 0)
