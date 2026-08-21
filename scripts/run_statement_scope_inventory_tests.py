#!/usr/bin/env python3
"""Out-of-scope statement inventory and unit-label reconciliation contract.

P2.1: every row the extraction lane drops as out-of-model-scope (OCI, EPS,
dividend-per-share, attribution supplements, note captions) must be RECORDED
in a typed out-of-scope inventory on the manifest — never silently deleted —
whole balance-sheet/equity statements must be recorded at document level, and
printed unit labels must be reconciled against the declared units with a
material mismatch recorded as a fail-closed finding.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import extract_filing_statements as extractor


PERIODS = ["2023-12-31", "2024-12-31", "2025-12-31"]
COLUMNS = [100.0, 200.0, 300.0]

failures: list[str] = []
checks = 0
mutations_caught: list[str] = []
mutated_inventory_cases: list[tuple[str, list, str]] = []


def check(condition: bool, message: str) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(message)


def text_line(page: int, y: float, text: str, x0: float = 10.0) -> dict:
    return {
        "page": page,
        "x0": x0,
        "x1": x0 + 180.0,
        "y0": y,
        "text": text,
        "words": [{"x0": x0, "x1": x0 + 180.0, "text": text}],
    }


def year_line(page: int, y: float) -> dict:
    words = [
        {"x0": centre - 8.0, "x1": centre + 8.0, "text": year}
        for centre, year in zip(COLUMNS, ["2023", "2024", "2025"])
    ]
    return {
        "page": page,
        "x0": words[0]["x0"],
        "x1": words[-1]["x1"],
        "y0": y,
        "text": "2023 2024 2025",
        "words": words,
    }


def value_line(page: int, y: float, label: str, tokens: list[str], indent: float = 10.0) -> dict:
    words = [{"x0": indent, "x1": indent + 70.0, "text": label}]
    words.extend(
        {"x0": centre - 5.0, "x1": centre + 5.0, "text": token}
        for centre, token in zip(COLUMNS, tokens)
    )
    return {
        "page": page,
        "x0": indent,
        "x1": words[-1]["x1"],
        "y0": y,
        "text": " ".join([label, *tokens]),
        "words": words,
    }


def inventory_pairs(manifest: dict | None) -> list[tuple[str, str]]:
    return [
        (record.get("raw_label"), record.get("reason_code"))
        for record in (manifest or {}).get("out_of_scope_inventory", [])
    ]


# --- Scenario A: combined IFRS statement of comprehensive income -------------
combined_lines = [
    text_line(1, 10.0, "Consolidated statement of comprehensive income"),
    text_line(1, 20.0, "USD millions"),
    year_line(1, 30.0),
    value_line(1, 40.0, "Revenue", ["100", "110", "120"]),
    value_line(1, 50.0, "Operating profit", ["20", "22", "24"]),
    value_line(1, 60.0, "Profit for the year", ["15", "16", "17"]),
    text_line(1, 65.0, "All activities were in respect of continuing operations"),
    text_line(1, 70.0, "Profit attributable to"),
    value_line(1, 80.0, "Owners of the parent", ["14", "15", "16"], 22.0),
    value_line(1, 90.0, "Non-controlling interests", ["1", "1", "1"], 22.0),
    text_line(1, 100.0, "Other comprehensive income"),
    value_line(1, 110.0, "Currency translation differences", ["2", "3", "4"], 22.0),
    value_line(1, 120.0, "Total comprehensive income", ["17", "19", "21"]),
    text_line(1, 130.0, "Total comprehensive income attributable to"),
]
combined_manifest, combined_findings = extractor.extract_statement(
    combined_lines, "income_statement", "annual_report", "a" * 64,
    PERIODS, set(), "USD", "millions",
)
check(combined_manifest is not None, "combined statement was not selected")
check(not combined_findings, f"clean combined statement emitted findings: {combined_findings}")
kept_labels = [row["raw_label"] for row in (combined_manifest or {}).get("rows", [])]
check(
    kept_labels == [
        "Revenue", "Operating profit", "Profit for the year",
        "Owners of the parent", "Non-controlling interests",
    ],
    f"operating-statement projection changed: {kept_labels}",
)
# THE GAP: today the scope-dropped rows leave NO trace in the response.
check(
    combined_manifest is not None and "out_of_scope_inventory" in combined_manifest,
    "scope-dropped rows left no out-of-scope inventory on the manifest (silently deleted)",
)
combined_pairs = inventory_pairs(combined_manifest)
check(
    ("Other comprehensive income", "oci_section_heading") in combined_pairs,
    f"dropped OCI section heading was not recorded: {combined_pairs}",
)
check(
    ("Currency translation differences", "oci_row") in combined_pairs,
    "dropped OCI body row was not recorded with reason oci_row",
)
check(
    ("Total comprehensive income", "oci_row") in combined_pairs,
    "dropped total-comprehensive-income row was not recorded",
)
check(
    ("Profit attributable to", "profit_attribution_heading") in combined_pairs,
    "consumed profit-attribution heading was not recorded",
)
check(
    ("Total comprehensive income attributable to", "comprehensive_income_attribution") in combined_pairs,
    "dropped comprehensive-income attribution boundary was not recorded",
)
check(
    (
        "All activities were in respect of continuing operations",
        "continuing_operations_note",
    ) in combined_pairs,
    "dropped continuing-operations note was not recorded",
)
combined_inventory = (combined_manifest or {}).get("out_of_scope_inventory", [])
check(
    bool(combined_inventory) and all(
        record.get("statement") == "income_statement"
        and str(record.get("source_line_id") or "")
        and str(record.get("raw_label") or "")
        and str(record.get("reason_code") or "")
        and str(record.get("page_or_note") or "").startswith("page")
        for record in combined_inventory
    ),
    "an out-of-scope record omitted statement kind, label, reason code, or provenance",
)
kept_ids = {row["source_line_id"] for row in (combined_manifest or {}).get("rows", [])}
dropped_ids = {record.get("source_line_id") for record in combined_inventory}
check(
    bool(combined_inventory) and not (kept_ids & dropped_ids),
    "a retained row also appeared in the out-of-scope inventory",
)
check(
    [row["ordinal"] for row in (combined_manifest or {}).get("rows", [])]
    == list(range(1, len(kept_labels) + 1)),
    "retained-row ordinals are not contiguous after scope projection",
)

# --- Scenario B: US-style operations statement with EPS/dividend supplements -
supplement_lines = [
    text_line(1, 10.0, "Consolidated statements of operations"),
    text_line(1, 20.0, "USD millions"),
    year_line(1, 30.0),
    value_line(1, 40.0, "Revenue", ["500", "520", "540"]),
    value_line(1, 50.0, "Cost of sales", ["(300)", "(310)", "(320)"]),
    value_line(1, 60.0, "Gross margin", ["200", "210", "220"]),
    value_line(1, 70.0, "Operating income", ["90", "95", "100"]),
    value_line(1, 80.0, "Net income", ["60", "63", "66"]),
    value_line(1, 90.0, "Basic earnings per share", ["1.40", "1.47", "1.54"]),
    value_line(1, 100.0, "Weighted average number of shares outstanding", ["43", "43", "43"]),
    value_line(1, 110.0, "Dividends declared per share", ["0.50", "0.55", "0.60"]),
]
supplement_manifest, supplement_findings = extractor.extract_statement(
    supplement_lines, "income_statement", "form_10k", "b" * 64,
    PERIODS, set(), "USD", "millions",
)
check(supplement_manifest is not None, "operations statement was not selected")
supplement_kept = [row["raw_label"] for row in (supplement_manifest or {}).get("rows", [])]
check(
    supplement_kept == ["Revenue", "Cost of sales", "Gross margin", "Operating income", "Net income"],
    f"per-share supplements leaked into the operating rows: {supplement_kept}",
)
supplement_pairs = inventory_pairs(supplement_manifest)
check(
    ("Basic earnings per share", "per_share_supplement_row") in supplement_pairs,
    f"dropped EPS row left no trace in the response: {supplement_pairs}",
)
check(
    ("Weighted average number of shares outstanding", "per_share_supplement_row") in supplement_pairs,
    "dropped weighted-average share row left no trace in the response",
)
check(
    ("Dividends declared per share", "dividend_declaration_row") in supplement_pairs,
    "dropped dividend-per-share row left no trace in the response",
)

# --- Scenario C: cash flow with a valueless Notes caption ---------------------
cash_flow_lines = [
    text_line(1, 10.0, "Consolidated statement of cash flows"),
    text_line(1, 20.0, "USD millions"),
    year_line(1, 30.0),
    text_line(1, 35.0, "Notes"),
    value_line(1, 40.0, "Profit before tax", ["10", "11", "12"]),
    value_line(1, 50.0, "Depreciation", ["2", "3", "4"], 22.0),
    value_line(1, 60.0, "Tax paid", ["(1)", "(2)", "(3)"], 22.0),
    value_line(1, 70.0, "Cash from operations", ["11", "12", "13"]),
    value_line(1, 80.0, "Closing cash", ["20", "22", "24"]),
]
cash_manifest, cash_findings = extractor.extract_statement(
    cash_flow_lines, "cash_flow", "annual_report", "c" * 64,
    PERIODS, set(), "USD", "millions",
)
check(cash_manifest is not None and not cash_findings, "clean cash-flow statement was refused")
cash_pairs = inventory_pairs(cash_manifest)
check(
    ("Notes", "notes_column_caption") in cash_pairs,
    f"dropped Notes column caption left no trace on the cash-flow manifest: {cash_pairs}",
)
check(
    all(record.get("statement") == "cash_flow" for record in (cash_manifest or {}).get("out_of_scope_inventory", [])),
    "cash-flow out-of-scope record does not carry its statement kind",
)

# --- Unit-label reconciliation -------------------------------------------------
matched_reconciliation = (cash_manifest or {}).get("unit_label_reconciliation")
check(
    matched_reconciliation == [{
        "raw_label": "USD millions",
        "printed_units": "millions",
        "declared_units": "millions",
        "status": "match",
    }],
    f"printed unit label was not reconciled against declared units: {matched_reconciliation}",
)

mismatch_lines = [
    text_line(1, 10.0, "Consolidated statement of cash flows"),
    text_line(1, 20.0, "USD thousands"),
    year_line(1, 30.0),
    value_line(1, 40.0, "Profit before tax", ["10", "11", "12"]),
    value_line(1, 50.0, "Depreciation", ["2", "3", "4"], 22.0),
    value_line(1, 60.0, "Tax paid", ["(1)", "(2)", "(3)"], 22.0),
    value_line(1, 70.0, "Cash from operations", ["11", "12", "13"]),
    value_line(1, 80.0, "Closing cash", ["20", "22", "24"]),
]
mismatch_manifest, mismatch_findings = extractor.extract_statement(
    mismatch_lines, "cash_flow", "annual_report", "d" * 64,
    PERIODS, set(), "USD", "millions",
)
check(
    any(item.get("code") == "UNIT_LABEL_MISMATCH" for item in mismatch_findings),
    "a printed thousands label against declared millions raised no fail-closed finding",
)
check(
    mismatch_manifest is not None
    and any(
        record.get("status") == "mismatch"
        and record.get("printed_units") == "thousands"
        and record.get("declared_units") == "millions"
        for record in mismatch_manifest.get("unit_label_reconciliation", [])
    ),
    "the unit-label mismatch was not recorded on the manifest reconciliation",
)

reconcile = getattr(extractor, "reconcile_unit_labels", None)
if reconcile is None:
    check(False, "reconcile_unit_labels does not exist: printed labels are never reconciled")
    check(False, "reconcile_unit_labels does not exist: billions mismatch is undetectable")
    check(False, "reconcile_unit_labels does not exist: missing declaration is untyped")
else:
    records, unit_findings = reconcile(["Amounts in billions"], "millions")
    check(
        records and records[0]["printed_units"] == "billions"
        and records[0]["status"] == "mismatch"
        and any(item.get("code") == "UNIT_LABEL_MISMATCH" and item.get("material") is True for item in unit_findings),
        f"a billions label against declared millions was not a material mismatch: {records} {unit_findings}",
    )
    records, unit_findings = reconcile(["$ in millions"], "millions")
    check(
        records and records[0]["status"] == "match" and not unit_findings,
        f"a matching symbolised label was misreported: {records} {unit_findings}",
    )
    records, unit_findings = reconcile(["in millions"], None)
    check(
        records and records[0]["status"] == "no_declared_units"
        and records[0]["declared_units"] is None and not unit_findings,
        "an undeclared unit basis was not typed as no_declared_units (and must never be invented)",
    )

# --- Document-level out-of-scope statements ------------------------------------
statement_scan = getattr(extractor, "out_of_scope_statement_inventory", None)
if statement_scan is None:
    check(False, "out_of_scope_statement_inventory does not exist: balance-sheet/equity statements leave no record")
    check(False, "out_of_scope_statement_inventory does not exist: prose mentions cannot be distinguished")
else:
    document_lines = [
        text_line(1, 10.0, "Consolidated balance sheets"),
        value_line(1, 20.0, "Total assets", ["900", "950", "1000"]),
        text_line(2, 10.0, "Consolidated statement of changes in equity"),
        value_line(2, 20.0, "Opening equity", ["400", "420", "440"]),
        text_line(3, 10.0, "Total assets on the balance sheet increased during the year"),
    ]
    records = statement_scan(document_lines)
    check(
        records == [
            {
                "statement_kind": "balance_sheet",
                "raw_label": "Consolidated balance sheets",
                "reason_code": "statement_out_of_model_scope",
                "pages": [1],
            },
            {
                "statement_kind": "statement_of_changes_in_equity",
                "raw_label": "Consolidated statement of changes in equity",
                "reason_code": "statement_out_of_model_scope",
                "pages": [2],
            },
        ],
        f"balance-sheet/equity statements were not typed into the document inventory: {records}",
    )
    check(
        not statement_scan([text_line(1, 10.0, "Total assets on the balance sheet increased during the year")]),
        "a prose mention of the balance sheet minted a false statement record",
    )

# --- Mutation: a scope-dropped row missing from the inventory is caught ---------
scope = extractor.model_statement_scope
validator = getattr(extractor, "statement_scope_inventory_errors", None)
raw_rows = [
    {"source_line_id": "is.revenue", "ordinal": 1, "raw_label": "Revenue",
     "values": [100, 110, 120], "page_or_note": "page 1"},
    {"source_line_id": "is.net_income", "ordinal": 2, "raw_label": "Net income",
     "values": [60, 63, 66], "page_or_note": "page 1"},
    {"source_line_id": "is.basic_eps", "ordinal": 3, "raw_label": "Basic earnings per share",
     "values": [1.4, 1.47, 1.54], "page_or_note": "page 1"},
    {"source_line_id": "is.dividends", "ordinal": 4, "raw_label": "Dividends declared per share",
     "values": [0.5, 0.55, 0.6], "page_or_note": "page 1"},
]
scope_result = scope(copy.deepcopy(raw_rows), "income_statement")
if not (isinstance(scope_result, tuple) and len(scope_result) == 2):
    check(False, "model_statement_scope still deletes rows without returning an inventory")
    check(False, "statement_scope_inventory_errors cannot run: no inventory exists")
    check(False, "an incomplete inventory cannot be caught: no validator exists")
else:
    scoped_rows, inventory = scope_result
    check(
        [row["source_line_id"] for row in scoped_rows] == ["is.revenue", "is.net_income"]
        and {record["source_line_id"] for record in inventory} == {"is.basic_eps", "is.dividends"},
        "scope projection or its inventory changed the row partition",
    )
    if validator is None:
        check(False, "statement_scope_inventory_errors does not exist: conservation is unverifiable")
        check(False, "an incomplete inventory cannot be caught: no validator exists")
    else:
        check(
            validator(raw_rows, scoped_rows, inventory) == [],
            "a complete scope inventory was rejected by its own validator",
        )
        # Measured mutation adequacy (P7.5 discipline): each entry below is a
        # real defective projection/inventory applied to fresh copies; the
        # validator must REJECT it before it may be counted. A surviving
        # mutant is recorded as a failure, never silently dropped, and no
        # count below is written as a literal.
        mutated_inventory_cases = [
            (
                "scope-dropped-row-omitted-from-inventory",
                [record for record in inventory if record["source_line_id"] != "is.dividends"],
                "is.dividends",
            ),
            (
                "retained-row-also-recorded-out-of-scope",
                [*copy.deepcopy(inventory), dict(inventory[0], source_line_id="is.revenue")],
                "is.revenue",
            ),
            (
                "inventory-record-invented-without-source-row",
                [*copy.deepcopy(inventory), dict(inventory[0], source_line_id="is.ghost_row")],
                "is.ghost_row",
            ),
            (
                "record-strips-provenance-fields",
                [
                    dict(record, reason_code="", page_or_note="")
                    if record["source_line_id"] == "is.dividends"
                    else record
                    for record in copy.deepcopy(inventory)
                ],
                "omits statement",
            ),
        ]
        for name, tampered, fragment in mutated_inventory_cases:
            errors = validator(raw_rows, scoped_rows, tampered)
            if any(fragment in error for error in errors):
                mutations_caught.append(name)
            else:
                check(False, f"surviving mutation {name}: defective inventory escaped detection")

report = {"status": "FAIL" if failures else "PASS", "checks": checks}
report["mutations_total"] = len(mutated_inventory_cases) if validator is not None and isinstance(scope_result, tuple) and len(scope_result) == 2 else 0
report["mutations_caught"] = len(mutations_caught)
if failures:
    report["violations"] = len(failures)
    report["failures"] = failures
print(json.dumps(report))
raise SystemExit(1 if failures else 0)
