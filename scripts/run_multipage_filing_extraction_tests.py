#!/usr/bin/env python3
"""Forced two-page filing extraction and mutation contract."""

from __future__ import annotations

import copy
import json
import subprocess
from pathlib import Path

import extract_filing_statements as extractor


PERIODS = ["2023-12-31", "2024-12-31", "2025-12-31"]
ROOT = Path(__file__).resolve().parent.parent


def text_line(page: int, y: float, text: str, x0: float = 10.0) -> dict:
    return {
        "page": page,
        "x0": x0,
        "x1": x0 + 180.0,
        "y0": y,
        "text": text,
        "words": [{"x0": x0, "x1": x0 + 180.0, "text": text}],
    }


def year_line(page: int, y: float, columns: list[float]) -> dict:
    words = [
        {"x0": centre - 8.0, "x1": centre + 8.0, "text": year}
        for centre, year in zip(columns, ["2023", "2024", "2025"])
    ]
    return {
        "page": page,
        "x0": words[0]["x0"],
        "x1": words[-1]["x1"],
        "y0": y,
        "text": "2023 2024 2025",
        "words": words,
    }


def value_line(
    page: int, y: float, label: str, tokens: list[str], columns: list[float], indent: float = 10.0,
) -> dict:
    words = [{"x0": indent, "x1": indent + 70.0, "text": label}]
    words.extend(
        {"x0": centre - 5.0, "x1": centre + 5.0, "text": token}
        for centre, token in zip(columns, tokens)
    )
    return {
        "page": page,
        "x0": indent,
        "x1": words[-1]["x1"],
        "y0": y,
        "text": " ".join([label, *tokens]),
        "words": words,
    }


page_one_columns = [100.0, 200.0, 300.0]
page_two_columns = [120.0, 220.0, 320.0]
lines = [
    text_line(1, 10.0, "Cash flow statement"),
    text_line(1, 20.0, "USD millions"),
    year_line(1, 30.0, page_one_columns),
    value_line(1, 40.0, "Profit before tax", ["10", "11", "12"], page_one_columns),
    value_line(1, 50.0, "Depreciation", ["2", "3", "4"], page_one_columns, 22.0),
    value_line(1, 60.0, "Working capital", ["0", "-", "N/A"], page_one_columns, 22.0),
    value_line(1, 70.0, "Tax paid", ["(1)", "(2)", "(3)"], page_one_columns, 22.0),
    value_line(1, 80.0, "Cash from operations", ["11", "12", "13"], page_one_columns),
    text_line(2, 10.0, "Cash flow statement (continued)"),
    text_line(2, 20.0, "USD millions"),
    year_line(2, 30.0, page_two_columns),
    value_line(2, 40.0, "Capital expenditure", ["(4)", "(5)", "(6)"], page_two_columns),
    value_line(2, 50.0, "Acquisitions", ["(2)", "(1)", "0"], page_two_columns),
    value_line(2, 60.0, "Dividends paid", ["(3)", "(4)", "(5)"], page_two_columns),
    value_line(2, 70.0, "Closing cash", ["20", "22", "24"], page_two_columns),
    text_line(3, 10.0, "Notes to the financial statements"),
    value_line(3, 20.0, "Unrelated note table", ["90", "91", "92"], page_two_columns),
]

manifest, findings = extractor.extract_statement(
    lines,
    "cash_flow",
    "annual_report",
    "a" * 64,
    PERIODS,
    set(),
    "USD",
    "millions",
)

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


check(
    extractor.STRICT_HEADINGS["income_statement"].fullmatch(
        "CONSOLIDATED STATEMENTS OF OPERATIONS"
    ) is not None,
    "canonical plural US-GAAP income-statement heading was rejected",
)
check(
    extractor.STRICT_HEADINGS["cash_flow"].fullmatch(
        "CONSOLIDATED STATEMENTS OF CASH FLOWS"
    ) is not None,
    "canonical plural US-GAAP cash-flow heading was rejected",
)

misaligned_subtotal_rows = [
    {
        "source_line_id": "is.component_a",
        "hierarchy_level": 1,
        "is_subtotal": False,
        "values": [2, 3, 4],
        "value_states": ["reported_number"] * 3,
    },
    {
        "source_line_id": "is.component_b",
        "hierarchy_level": 1,
        "is_subtotal": False,
        "values": [3, 4, 5],
        "value_states": ["reported_number"] * 3,
    },
    {
        "source_line_id": "is.nearer_total",
        "hierarchy_level": 3,
        "is_subtotal": True,
        "values": [5, 7, 9],
        "value_states": ["reported_number"] * 3,
    },
    {
        "source_line_id": "is.later_outer_total",
        "hierarchy_level": 0,
        "is_subtotal": True,
        "values": [20, 21, 22],
        "value_states": ["reported_number"] * 3,
    },
]
extractor.infer_parent_links(misaligned_subtotal_rows)
check(
    all(not row.get("parent_source_line_id") for row in misaligned_subtotal_rows[:2]),
    "a later outer subtotal reached across a nearer misaligned subtotal boundary",
)

other_income_surface = [
    text_line(2, 10.0, "Consolidated statements of comprehensive income"),
    text_line(2, 20.0, "USD millions"),
    year_line(2, 30.0, page_two_columns),
    value_line(2, 40.0, "Net income", ["10", "11", "12"], page_two_columns),
    value_line(2, 50.0, "Comprehensive income", ["9", "10", "11"], page_two_columns),
]
continued, _ = extractor._continuation_page(
    [
        text_line(1, 10.0, "Consolidated statements of operations"),
        text_line(1, 20.0, "USD millions"),
        year_line(1, 30.0, page_one_columns),
    ],
    other_income_surface,
    "income_statement",
    PERIODS,
    page_one_columns,
)
check(
    continued is False,
    "a distinct comprehensive-income statement was joined to the operations face",
)


expected_labels = [
    "Profit before tax",
    "Depreciation",
    "Working capital",
    "Tax paid",
    "Cash from operations",
    "Capital expenditure",
    "Acquisitions",
    "Dividends paid",
    "Closing cash",
]


def production_errors(candidate: dict) -> list[str]:
    """Call the exact validator imported by run_filings_pipeline.mjs."""
    payload = {
        "manifest": candidate,
        "document": {
            "document_id": "annual-report",
            "source_id": "annual_report",
            "raw_sha256": "a" * 64,
        },
        "section": "cash_flow",
        "filingFacts": {"reporting_currency": "USD", "units": "millions"},
    }
    program = """
import fs from 'node:fs';
import { filingManifestCustodyErrors } from './scripts/lib/face_statement_manifest.mjs';
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const errors = filingManifestCustodyErrors({
  ...payload,
  globalLineIds: new Set(),
});
process.stdout.write(JSON.stringify(errors));
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "--eval", program],
        cwd=ROOT,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        return [f"production validator invocation failed: {completed.stderr.strip()}"]
    return json.loads(completed.stdout)

check(not findings, f"clean two-page statement emitted findings: {findings}")
check(manifest is not None, "two-page statement was not selected")
if manifest is not None:
    labels = [row["raw_label"] for row in manifest["rows"]]
    check(labels == expected_labels, "multi-page source order was not preserved")
    check(manifest["source_pages"] == [1, 2], "adjacent statement pages were not bound in order")
    check(manifest["page_or_note"] == "pages 1-2", "manifest page span is not exact")
    check(manifest["reporting_currency"] == "USD", "reporting currency was not retained")
    check(manifest["units"] == "millions", "normalized units were not retained")
    check(manifest["source_unit_labels"] == ["USD millions"], "printed unit header was not retained")
    check(
        manifest["rows"][2]["value_states"]
        == ["reported_zero", "reported_dash", "not_applicable"],
        "typed page-one value states were collapsed",
    )
    check(
        manifest["rows"][6]["value_states"][-1] == "reported_zero",
        "typed continuation-page zero was collapsed",
    )
    check(
        all(
            not extractor._is_statement_header_line(
                {"text": label, "words": [{"text": label}]}, PERIODS
            )
            for label in labels
        ),
        "a repeated title, year, or unit header entered the economic row inventory",
    )
    check(
        all("page 3" not in row["page_or_note"] for row in manifest["rows"]),
        "the continuation window leaked into the following notes page",
    )
    check(not production_errors(manifest), "clean manifest failed production custody validation")


mutations_rejected = 0
if manifest is not None:
    mutations: list[tuple[str, dict, str]] = []
    for field, expected_error in [
        ("source_pages", "omits source_pages"),
        ("reporting_currency", "omits reporting_currency"),
        ("units", "omits units"),
        ("source_unit_labels", "omits source_unit_labels"),
    ]:
        missing_field = copy.deepcopy(manifest)
        missing_field.pop(field, None)
        mutations.append((f"missing_{field}", missing_field, expected_error))
    truncated = copy.deepcopy(manifest)
    truncated["rows"] = truncated["rows"][:5]
    mutations.append(("continuation_removal", truncated, "source page with no retained economic row"))
    reordered = copy.deepcopy(manifest)
    reordered["rows"][5], reordered["rows"][6] = reordered["rows"][6], reordered["rows"][5]
    mutations.append(("source_reorder", reordered, "ordinal is not contiguous"))
    wrong_units = copy.deepcopy(manifest)
    wrong_units["units"] = "thousands"
    mutations.append(("unit_change", wrong_units, "units differ from filing_facts"))
    state_collapsed = copy.deepcopy(manifest)
    state_collapsed["rows"][2]["value_states"][1] = "reported_blank"
    mutations.append(("typed_state_change", state_collapsed, "rows_sha256 does not bind"))
    for mutation_name, mutation, expected_error in mutations:
        errors = production_errors(mutation)
        if any(expected_error in error for error in errors):
            mutations_rejected += 1
        else:
            failures.append(
                f"{mutation_name} was not rejected by production custody validation: {errors}"
            )
    check(mutations_rejected == len(mutations), "one or more custody mutations escaped detection")

report = {
    "kind": "multipage-filing-extraction-tests/1.0",
    "status": "FAIL" if failures else "PASS",
    "checks": 18,
    "mutations_rejected": mutations_rejected,
    "mutations_total": 8,
    "violations": len(failures),
    "failures": failures,
}
print(json.dumps(report, indent=2))
raise SystemExit(1 if failures else 0)
