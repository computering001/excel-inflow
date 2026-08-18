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


# A source-visible two-line caption may vertically centre its period values
# between the caption lines. The production grouping must attach those values
# to the first caption line without reaching the next normal statement row.
wrapped_words = [
    (10.0, 100.0, 40.0, 107.5, "Effect", 0, 0, 0),
    (42.0, 100.0, 90.0, 107.5, "of exchange", 0, 0, 1),
    (100.0, 104.5, 110.0, 112.0, "1", 0, 1, 0),
    (200.0, 104.5, 210.0, 112.0, "2", 0, 2, 0),
    (300.0, 104.5, 310.0, 112.0, "3", 0, 3, 0),
    (10.0, 109.0, 70.0, 116.5, "including cash", 0, 4, 0),
    (10.0, 121.0, 80.0, 128.5, "Next row", 0, 5, 0),
]
grouped_wrapped = extractor._group_page_words(wrapped_words, 7)
check(
    len(grouped_wrapped) == 3
    and [run["value"] for run in extractor.numeric_runs(grouped_wrapped[0]["words"])] == [1.0, 2.0, 3.0]
    and grouped_wrapped[-1]["text"] == "Next row",
    "vertically centred values were not joined to their wrapped caption, or crossed into the next row",
)
mutated_values = [
    (word[0], word[1] + 1.0, word[2], word[3] + 1.0, *word[4:])
    if word[4] in {"1", "2", "3"} else word
    for word in wrapped_words
]
check(
    not extractor.numeric_runs(extractor._group_page_words(mutated_values, 7)[0]["words"]),
    "a value row beyond the five-point source-geometry boundary was still joined to the caption",
)

dated_period_header = value_line(
    1, 20.0, "For the years ended December", ["2023", "2024", "2025"], page_one_columns,
)
check(
    extractor._is_period_header(dated_period_header, PERIODS),
    "a month-ended three-period header entered the economic row surface",
)
dated_period_header_mutation = copy.deepcopy(dated_period_header)
dated_period_header_mutation["text"] += " Revenue"
dated_period_header_mutation["words"].append(
    {"x0": 82.0, "x1": 96.0, "text": "Revenue"}
)
check(
    not extractor._is_period_header(dated_period_header_mutation, PERIODS),
    "an economic line was discarded merely because it carried three year tokens",
)

wrapped_caption = [
    text_line(1, 40.0, "Income before tax and income from equity"),
    value_line(1, 50.0, "method investments", ["10", "11", "12"], page_one_columns),
]
joined_caption = extractor._merge_wrapped_caption_lines(
    wrapped_caption, {1: page_one_columns},
)
check(
    len(joined_caption) == 1
    and joined_caption[0]["text"].startswith(
        "Income before tax and income from equity method investments"
    )
    and [run["value"] for run in extractor.numeric_runs(joined_caption[0]["words"])]
    == [10.0, 11.0, 12.0],
    "a lower-case wrapped caption did not retain the period values on one economic row",
)
wrapped_caption_mutation = copy.deepcopy(wrapped_caption)
wrapped_caption_mutation[1]["text"] = wrapped_caption_mutation[1]["text"].replace(
    "method", "Method", 1,
)
wrapped_caption_mutation[1]["words"][0]["text"] = "Method investments"
check(
    len(extractor._merge_wrapped_caption_lines(
        wrapped_caption_mutation, {1: page_one_columns},
    )) == 2,
    "a capitalized independent row was merged as a caption continuation",
)

flat_partial_total = [
    {"source_line_id": "cf.start", "hierarchy_level": 0, "is_subtotal": True, "values": [10, 11, 12], "value_states": ["reported_number"] * 3, "value_precisions": [0, 0, 0]},
    {"source_line_id": "cf.header", "hierarchy_level": 0, "is_subtotal": False, "values": [None, None, None], "value_states": ["reported_blank"] * 3, "value_precisions": [None, None, None]},
    {"source_line_id": "cf.adjustment", "hierarchy_level": 0, "is_subtotal": False, "values": [2, 3, 4], "value_states": ["reported_number"] * 3, "value_precisions": [0, 0, 0]},
    {"source_line_id": "cf.partial", "hierarchy_level": 0, "is_subtotal": False, "values": [None, 1, 2], "value_states": ["reported_dash", "reported_number", "reported_number"], "value_precisions": [None, 0, 0]},
    {"source_line_id": "cf.total", "hierarchy_level": 0, "is_subtotal": True, "values": [12, 15, 18], "value_states": ["reported_number"] * 3, "value_precisions": [0, 0, 0]},
]
extractor.infer_source_arithmetic_links(flat_partial_total)
check(
    [row.get("parent_source_line_id") for row in flat_partial_total[:4]]
    == ["cf.total", None, "cf.total", "cf.total"],
    "a flat, two-period-proved subtotal did not recover its numeric source members",
)
flat_partial_mutation = copy.deepcopy(flat_partial_total)
for row in flat_partial_mutation:
    row.pop("parent_source_line_id", None)
flat_partial_mutation[-1]["values"][-1] = 19
extractor.infer_source_arithmetic_links(flat_partial_mutation)
check(
    all(not row.get("parent_source_line_id") for row in flat_partial_mutation[:-1]),
    "a subtotal with only one complete matching period survived the arithmetic mutation",
)
flat_income_mutation = copy.deepcopy(flat_partial_total)
for row in flat_income_mutation:
    row["source_line_id"] = row["source_line_id"].replace("cf.", "is.")
    row.pop("parent_source_line_id", None)
flat_income_mutation[2]["is_subtotal"] = True
extractor.infer_source_arithmetic_links(flat_income_mutation)
check(
    all(not row.get("parent_source_line_id") for row in flat_income_mutation[:-1]),
    "a flat income-statement coincidence was promoted to a source hierarchy",
)
bridge_coincidence = [
    {"source_line_id": "is.ebitda", "hierarchy_level": 1, "is_subtotal": True, "values": [200, 200, 200], "value_states": ["reported_number"] * 3, "value_precisions": [0, 0, 0]},
    {"source_line_id": "is.da", "hierarchy_level": 1, "is_subtotal": False, "values": [-50, -50, -50], "value_states": ["reported_number"] * 3, "value_precisions": [0, 0, 0]},
    {"source_line_id": "is.operating_profit", "hierarchy_level": 1, "is_subtotal": True, "values": [150, 150, 150], "value_states": ["reported_number"] * 3, "value_precisions": [0, 0, 0]},
    {"source_line_id": "is.finance", "hierarchy_level": 1, "is_subtotal": False, "values": [0, 0, 0], "value_states": ["reported_zero"] * 3, "value_precisions": [0, 0, 0]},
    {"source_line_id": "is.pbt", "hierarchy_level": 0, "is_subtotal": True, "values": [150, 150, 150], "value_states": ["reported_number"] * 3, "value_precisions": [0, 0, 0]},
]
extractor.infer_parent_links(bridge_coincidence)
check(
    [row.get("parent_source_line_id") for row in bridge_coincidence[:-1]]
    == ["is.operating_profit", "is.operating_profit", "is.pbt", "is.pbt"],
    "caption fallback expanded a proved pre-tax family across an EBITDA bridge",
)


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
    "checks": 28,
    "mutations_rejected": mutations_rejected,
    "mutations_total": 8,
    "violations": len(failures),
    "failures": failures,
}
print(json.dumps(report, indent=2))
raise SystemExit(1 if failures else 0)
