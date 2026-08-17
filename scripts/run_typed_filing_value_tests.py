#!/usr/bin/env python3
"""Neutral tests for filing value-state and structural-row custody."""

from __future__ import annotations

import json

from extract_filing_statements import (
    classify_value_token,
    infer_structural_roles,
    nearest_observations,
    numeric_runs,
)


failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


check(classify_value_token("0") == (0, "reported_zero"), "zero state collapsed")
check(classify_value_token("-") == (None, "reported_dash"), "dash state collapsed")
check(classify_value_token("N/A") == (None, "not_applicable"), "N/A state collapsed")
check(classify_value_token("42") == (42, "reported_number"), "number state lost")

words = [
    {"x0": 95.0, "x1": 105.0, "text": "0"},
    {"x0": 195.0, "x1": 205.0, "text": "-"},
    {"x0": 295.0, "x1": 305.0, "text": "N/A"},
]
values, states = nearest_observations(
    numeric_runs(words), [100.0, 200.0, 300.0]
)
check(values == [0, None, None], "typed observations changed source values")
check(
    states == ["reported_zero", "reported_dash", "not_applicable"],
    "typed observations lost source-visible states",
)

partial_values, partial_states = nearest_observations(
    numeric_runs(words[:1]), [100.0, 200.0, 300.0]
)
check(partial_values == [0, None, None], "partial row changed explicit zero")
check(
    partial_states == ["reported_zero", "reported_blank", "reported_blank"],
    "unprinted period cells were not preserved as reported blanks",
)

rows = [
    {
        "source_line_id": "cf.header",
        "values": [None, None, None],
        "value_states": ["unresolved", "unresolved", "unresolved"],
        "hierarchy_level": 0,
    },
    {
        "source_line_id": "cf.header_child",
        "values": [1, 2, 3],
        "value_states": ["reported_number"] * 3,
        "hierarchy_level": 1,
    },
    {
        "source_line_id": "cf.unresolved_body",
        "values": [None, None, None],
        "value_states": ["unresolved"] * 3,
        "hierarchy_level": 0,
    },
    {
        "source_line_id": "cf.dash_body",
        "values": [None, None, None],
        "value_states": ["reported_dash"] * 3,
        "hierarchy_level": 0,
    },
]
infer_structural_roles(rows)
check(rows[0]["structural_role"] == "header", "indented-child header evidence lost")
check(
    rows[0]["value_states"] == ["reported_blank"] * 3,
    "proved heading did not preserve blank presentation states",
)
check(rows[2]["structural_role"] == "body", "unresolved body became a header")
check(rows[2]["value_states"] == ["unresolved"] * 3, "unresolved state changed")
check(rows[3]["structural_role"] == "body", "dash-only body became a header")

report = {
    "kind": "typed-filing-value-tests/1.0",
    "status": "FAIL" if failures else "PASS",
    "checks": 13,
    "violations": len(failures),
    "failures": failures,
}
print(json.dumps(report, indent=2))
raise SystemExit(1 if failures else 0)
