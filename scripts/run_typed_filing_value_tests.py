#!/usr/bin/env python3
"""Neutral tests for filing value-state and structural-row custody."""

from __future__ import annotations

import json

import extract_filing_statements as extractor

from extract_filing_statements import (
    classify_value_token,
    infer_structural_roles,
    nearest_observations,
    numeric_runs,
    source_provenance_note,
    split_source_reference_tokens,
)


failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


check(classify_value_token("0") == (0, "reported_zero"), "zero state collapsed")
check(classify_value_token("-") == (None, "reported_dash"), "dash state collapsed")
check(classify_value_token("N/A") == (None, "not_applicable"), "N/A state collapsed")
check(classify_value_token("42") == (42, "reported_number"), "number state lost")
check(
    split_source_reference_tokens("F-5") == ("", ["F-5"]),
    "standalone source reference became an economic label",
)
check(
    split_source_reference_tokens("Change in working capital F-5")
    == ("Change in working capital", ["F-5"]),
    "inline source reference contaminated the economic label",
)
check(
    split_source_reference_tokens("IFRS 16 lease expense")
    == ("IFRS 16 lease expense", []),
    "accounting-standard label was mistaken for a source reference",
)
check(
    source_provenance_note(27, ["F-5"]) == "page 27; source reference F-5",
    "source reference was not retained in provenance",
)

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

# Exercise the actual extraction branch: a printed source marker may sit on
# its own line between economic rows, and may even align with numeric columns.
# It must disappear from the row inventory while surviving in provenance.
synthetic_lines = [
    {
        "page": 27,
        "x0": 10.0,
        "x1": 180.0,
        "y0": 10.0,
        "text": "Cash flow statement",
        "words": [{"x0": 10.0, "x1": 180.0, "text": "Cash flow statement"}],
    },
    {
        "page": 27,
        "x0": 10.0,
        "x1": 305.0,
        "y0": 20.0,
        "text": "Change in working capital 1 2 3",
        "words": [
            {"x0": 10.0, "x1": 70.0, "text": "Change in working capital"},
            {"x0": 95.0, "x1": 105.0, "text": "1"},
            {"x0": 195.0, "x1": 205.0, "text": "2"},
            {"x0": 295.0, "x1": 305.0, "text": "3"},
        ],
    },
    {
        "page": 27,
        "x0": 10.0,
        "x1": 32.0,
        "y0": 30.0,
        "text": "F-5",
        "words": [{"x0": 10.0, "x1": 32.0, "text": "F-5"}],
    },
    {
        "page": 27,
        "x0": 10.0,
        "x1": 305.0,
        "y0": 40.0,
        "text": "Net cash from operating activities 4 5 6",
        "words": [
            {"x0": 10.0, "x1": 70.0, "text": "Net cash from operating activities"},
            {"x0": 95.0, "x1": 105.0, "text": "4"},
            {"x0": 195.0, "x1": 205.0, "text": "5"},
            {"x0": 295.0, "x1": 305.0, "text": "6"},
        ],
    },
]
original_statement_window = extractor.statement_window
original_year_columns = extractor.year_columns
try:
    extractor.statement_window = lambda lines, section, periods: (0, len(lines))
    extractor.year_columns = lambda window, periods: [100.0, 200.0, 300.0]
    manifest, extraction_findings = extractor.extract_statement(
        synthetic_lines,
        "cash_flow",
        "filing-1",
        "a" * 64,
        ["2023", "2024", "2025"],
        set(),
        "USD",
        "millions",
    )
finally:
    extractor.statement_window = original_statement_window
    extractor.year_columns = original_year_columns
check(manifest is not None and len(manifest["rows"]) == 2, "source marker minted an economic row")
check(
    manifest is not None and all(row["raw_label"] != "F-5" for row in manifest["rows"]),
    "source marker remained on the visible row surface",
)
check(
    manifest is not None and "source reference F-5" in manifest["rows"][0]["page_or_note"],
    "standalone source marker was not attached to adjacent provenance",
)
check(
    manifest is not None and manifest["schema_version"] == "face-statement-manifest/1.3",
    "current extraction did not emit the complete per-cell custody contract",
)
required_cell_fields = {
    "raw_text", "source_page", "source_coordinates", "confidence",
    "typed_state", "currency", "units", "period", "normalized_value",
}
check(
    manifest is not None
    and all(
        len(row.get("cells", [])) == 3
        and all(set(cell) == required_cell_fields for cell in row["cells"])
        for row in manifest["rows"]
    ),
    "an extracted cell omitted exact text, bbox, confidence, typed or normalized custody",
)
check(not extraction_findings, "clean source-marker extraction emitted findings")

report = {
    "kind": "typed-filing-value-tests/1.0",
    "status": "FAIL" if failures else "PASS",
    "checks": 23,
    "violations": len(failures),
    "failures": failures,
}
print(json.dumps(report, indent=2))
raise SystemExit(1 if failures else 0)
