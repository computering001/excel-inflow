#!/usr/bin/env python3
"""P5.5 — authority and capture claims judged against the EMITTED CELLS.

WHY THIS EXISTS.  Two of the fifteen critical-invariant domains were proven by
editing a JSON document the build had just written, never the workbook:

  * `forecast_ownership` ("single-parent-or-child-writer") was mutated by
    appending a duplicate entry to `<workbook>.forecast-receipt.json`, and the
    incumbent inspector opens that receipt and nothing else.
  * `rcf_financing_cash` ("rcf-enters-financing-once") was mutated by deleting
    the `RCF draw` entry from `semantic_scope_captures` in the build's proof
    contract; the inspector reads the contract's own list back and compares it
    with a literal set of labels.

A receipt and the workbook are two outputs of the same build.  Agreement
between the receipt and a mutated copy of the receipt says nothing about the
FILE the reader opens.  The concrete blind spot, reproduced by the harness
before this module existed: give the captured `RCF draw` row a live formula in
the emitted `.xlsx` and both incumbent inspectors return zero findings, while
the same claim mutated in the JSON is caught immediately.

WHAT THIS MODULE DOES INSTEAD.  Observation is the emitted package; expectation
is the authority record.

  * OBSERVATION — the `.xlsx` bytes, read through P5.4's independently verified
    reconstruction (`verify.plan_reconstruction_oracle.reconstruct_plan`).  No
    second reader is introduced: this module parses no XML of its own, it
    judges the reconstruction P5.4 already proves faithful.
  * EXPECTATION — the authority records: the forecast authority ledger
    (`authority`, `method`, `source_kind`, `captured_by` per display id and
    forecast index) and the declared semantic-scope captures.  Those documents
    supply the CLAIM; every one of them is then checked against a CELL, so a
    claim that survives only because the file was never opened cannot pass.
  * ADDRESSES ARE DERIVED, NEVER WRITTEN DOWN.  A row is located by matching
    the authority record's label against the emitted label column and is used
    only when that match is UNIQUE; a column is the declared forecast column
    for the record's forecast index; the identity that must absorb a captured
    scope is the one whose member rows contain the capture's parent row.  A
    literal address in a mutation is an address that silently stops pointing at
    the cell it means when a row moves; there are none here, and the harness
    asserts that the derivation actually resolved (`_ROWS_UNRESOLVABLE`,
    `_RULE_VACUOUS`) rather than quietly checking nothing.

This module VALIDATES.  It never rewrites a cell, never fills in a missing
authority record and never downgrades a finding to a warning.

Independence: standard library only, plus P5.4's reader; no production import.
`verify/oracle_independence.py` AST-scans this file with the rest of
`scripts/verify`.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

if __package__ in (None, ""):  # direct `python scripts/verify/…` invocation
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from verify.plan_reconstruction_oracle import reconstruct_plan

FORBIDDEN_PRODUCTION_IMPORTS: list[str] = [
    "build_dynamic_model",
    "case_compiler",
    "emit",
    "forecast_candidate_compiler",
    "generated",
    "render",
    "row_plan",
    "scripts.lib",
    "solver",
]

FINDINGS_PER_CODE = 20

# The provenance channel's own colours, as the emitted package spells them.
GREEN = "FF008000"

# A sheet-qualified reference.  This is a fact about OOXML formula syntax read
# off the emitted file — "does this number come from another sheet" — not the
# emitter's colour rule.
CROSS_SHEET = re.compile(r"(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)!")
QUALIFIED_REF = re.compile(
    r"(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)!\$?[A-Z]{1,3}\$?[0-9]+"
    r"(?::\$?[A-Z]{1,3}\$?[0-9]+)?"
)
RANGE_REF = re.compile(r"\$?([A-Z]{1,3})\$?([0-9]+):\$?([A-Z]{1,3})\$?([0-9]+)")
SINGLE_REF = re.compile(r"\$?([A-Z]{1,3})\$?([0-9]+)")

# Which physical shape each authority record demands of its cell.  Read as:
# the ledger says where this number came from, so the file must show it.
CAPTURED_AUTHORITY = "CapturedBy"
BROKER_AUTHORITY = "BrokerInput"
FORMULA_AUTHORITIES = ("Derived", "ScheduleLink")


class Report:
    """Typed findings, capped per code so one bad table cannot bury the rest.

    The COUNT is never capped — only the listing is — so a wide failure stays
    visible as a number.
    """

    def __init__(self) -> None:
        self.findings: list[dict] = []
        self.counts: dict[str, int] = {}
        self.metrics: dict[str, object] = {}

    def add(self, code: str, **evidence: object) -> None:
        self.counts[code] = self.counts.get(code, 0) + 1
        if self.counts[code] <= FINDINGS_PER_CODE:
            self.findings.append({"code": code, **evidence})

    @property
    def codes(self) -> set:
        return set(self.counts)

    def verdict(self) -> str:
        return "FAIL" if self.counts else "PASS"


# ---------------------------------------------------------------------------
# Reading the reconstruction
# ---------------------------------------------------------------------------


def column_number(letters: str) -> int:
    total = 0
    for character in letters:
        total = total * 26 + (ord(character) - 64)
    return total


def sheet_named(reconstruction: dict, name: str) -> dict | None:
    for sheet in (reconstruction.get("workbook") or {}).get("sheets") or []:
        if sheet.get("name") == name:
            return sheet
    return None


def label_rows(sheet: dict, label_column: str) -> dict:
    """Every label in the label column, mapped to the rows carrying it.

    A label on more than one row resolves to more than one row and is then
    refused as an address rather than guessed at.
    """
    index: dict = {}
    for address, record in (sheet.get("cells") or {}).items():
        match = SINGLE_REF.fullmatch(address)
        if not match or match.group(1) != label_column:
            continue
        value = record.get("value")
        if not isinstance(value, str) or not value.strip():
            continue
        index.setdefault(value.strip(), []).append(int(match.group(2)))
    return {label: sorted(rows) for label, rows in index.items()}


def cell_of(sheet: dict, address: str) -> dict:
    return (sheet.get("cells") or {}).get(address) or {}


def has_formula(record: dict) -> bool:
    return "formula" in record


def is_live(record: dict) -> bool:
    """The cell carries a number, a text, or a formula — a writer wrote here."""
    if has_formula(record):
        return True
    if "value" not in record:
        return False
    value = record.get("value")
    if isinstance(value, str):
        return value.strip() != ""
    return value is not None


def font_colour(record: dict) -> object:
    return ((record.get("style") or {}).get("font") or {}).get("color")


def same_sheet_refs(formula: str) -> set:
    """Addresses this formula reads on its OWN sheet, with ranges expanded."""
    text = QUALIFIED_REF.sub(" ", formula or "")
    refs: set = set()
    for match in RANGE_REF.finditer(text):
        first_column = column_number(match.group(1))
        last_column = column_number(match.group(3))
        first_row = int(match.group(2))
        last_row = int(match.group(4))
        for column in range(min(first_column, last_column), max(first_column, last_column) + 1):
            letters = ""
            remaining = column
            while remaining:
                remaining, position = divmod(remaining - 1, 26)
                letters = chr(65 + position) + letters
            for row in range(min(first_row, last_row), max(first_row, last_row) + 1):
                refs.add(f"{letters}{row}")
    text = RANGE_REF.sub(" ", text)
    for match in SINGLE_REF.finditer(text):
        refs.add(f"{match.group(1)}{match.group(2)}")
    return refs


# ---------------------------------------------------------------------------
# Capture: the parent covers the scope and the children are physically silent
# ---------------------------------------------------------------------------


def inspect_physical_capture(reconstruction: dict, contract: dict, report: Report) -> dict:
    if not isinstance(contract, dict) or not contract.get("statement_sheet") \
            or not contract.get("label_column") or not contract.get("forecast_columns"):
        # Handed something that is not the capture declaration, refuse rather
        # than pass vacuously on a document with no captures in it.
        report.add("CAPTURE_CONTRACT_NOT_A_CONTRACT", kind=type(contract).__name__)
        return {"captures_checked": 0, "capture_cells_checked": 0}
    sheet_name = contract.get("statement_sheet")
    label_column = contract.get("label_column")
    sheet = sheet_named(reconstruction, sheet_name)
    if sheet is None:
        report.add("CAPTURE_SHEET_ABSENT", sheet=sheet_name)
        return {"captures_checked": 0, "capture_cells_checked": 0}
    captures = contract.get("semantic_scope_captures") or []
    if not captures:
        report.add("CAPTURE_NO_CAPTURES_DECLARED")
        return {"captures_checked": 0, "capture_cells_checked": 0}

    identities = contract.get("protected_formula_identities") or []
    cells_checked = 0
    financing_checked = 0
    for entry in captures:
        parent_row = entry.get("parent_row")
        child_row = entry.get("child_row")
        columns = entry.get("columns") or []
        # The declared rows must physically CARRY the declared labels, or the
        # capture record points at rows that have moved underneath it.
        for row, expected in ((parent_row, entry.get("parent_label")),
                              (child_row, entry.get("child_label"))):
            observed = cell_of(sheet, f"{label_column}{row}").get("value")
            if observed != expected:
                report.add(
                    "CAPTURE_ROW_LABEL_MISMATCH",
                    row=row, expected=expected, observed=observed,
                )
        for column in columns:
            child = cell_of(sheet, f"{column}{child_row}")
            if is_live(child):
                report.add(
                    "CAPTURE_CHILD_HAS_LIVE_WRITER",
                    cell=f"{column}{child_row}",
                    child_label=entry.get("child_label"),
                    parent_label=entry.get("parent_label"),
                    formula=child.get("formula"),
                    value=child.get("value"),
                )
            parent = cell_of(sheet, f"{column}{parent_row}")
            if not has_formula(parent):
                report.add(
                    "CAPTURE_PARENT_NOT_WRITTEN",
                    cell=f"{column}{parent_row}",
                    parent_label=entry.get("parent_label"),
                )
            cells_checked += 2

        # The captured scope has to REACH the statement.  The identity that
        # must absorb it is derived: it is the protected identity whose member
        # rows contain this capture's parent row.
        owners = [
            identity for identity in identities
            if parent_row in (identity.get("member_rows") or [])
        ]
        for identity in owners:
            for column in identity.get("columns") or []:
                owner = cell_of(sheet, f"{column}{identity['owner_row']}")
                if f"{column}{parent_row}" not in same_sheet_refs(owner.get("formula") or ""):
                    report.add(
                        "CAPTURE_SCOPE_NOT_IN_FINANCING",
                        cell=f"{column}{identity['owner_row']}",
                        concept=identity.get("concept_id"),
                        missing=f"{column}{parent_row}",
                    )
                financing_checked += 1
        if not owners:
            report.add(
                "CAPTURE_SCOPE_NOT_IN_FINANCING",
                parent_row=parent_row,
                concept=None,
                missing="no protected identity claims the capture parent row",
            )
    return {
        "captures_checked": len(captures),
        "capture_cells_checked": cells_checked,
        "capture_absorption_cells_checked": financing_checked,
    }


# ---------------------------------------------------------------------------
# Authority: every ledger entry answered by the cell it governs
# ---------------------------------------------------------------------------


def inspect_physical_authority(
    reconstruction: dict, contract: dict, ledger: list, report: Report
) -> dict:
    if not isinstance(ledger, list) or not ledger or not all(
        isinstance(entry, dict) and "label" in entry and "authority" in entry
        and "forecast_index" in entry for entry in ledger
    ):
        # An empty or wrongly-shaped ledger would make every rule below check
        # nothing and report PASS.  Refuse instead.
        report.add(
            "AUTHORITY_LEDGER_NOT_A_LEDGER",
            kind=type(ledger).__name__,
            entries=len(ledger) if isinstance(ledger, list) else None,
        )
        return {"authority_entries_checked": 0}
    if not isinstance(contract, dict):
        report.add("AUTHORITY_SHEET_ABSENT", sheet=None)
        return {"authority_entries_checked": 0}
    sheet_name = contract.get("statement_sheet")
    label_column = contract.get("label_column")
    columns = contract.get("forecast_columns") or []
    sheet = sheet_named(reconstruction, sheet_name)
    if sheet is None or not label_column or not columns:
        report.add("AUTHORITY_SHEET_ABSENT", sheet=sheet_name)
        return {"authority_entries_checked": 0}

    rows_for_label = label_rows(sheet, label_column)
    resolved = 0
    unresolvable: list = []
    exercised: dict = {}
    for entry in ledger:
        label = entry.get("label")
        index = entry.get("forecast_index")
        rows = rows_for_label.get(label or "", [])
        if len(rows) != 1 or not isinstance(index, int) or index >= len(columns):
            unresolvable.append({"label": label, "forecast_index": index, "rows": rows})
            continue
        resolved += 1
        address = f"{columns[index]}{rows[0]}"
        record = cell_of(sheet, address)
        authority = entry.get("authority")
        exercised[authority] = exercised.get(authority, 0) + 1
        live = is_live(record)

        if authority == CAPTURED_AUTHORITY:
            # The ledger says a parent row owns this scope, so the child cell
            # holds nothing.  A number here is a second writer.
            if live:
                report.add(
                    "AUTHORITY_CAPTURED_ROW_HAS_LIVE_CELL",
                    cell=address, label=label, captured_by=entry.get("captured_by"),
                    formula=record.get("formula"), value=record.get("value"),
                )
            continue

        if not live:
            report.add(
                "AUTHORITY_LIVE_ROW_EMPTY_CELL",
                cell=address, label=label, authority=authority,
                method=entry.get("method"),
            )
            continue

        formula = record.get("formula") or ""
        if authority in FORMULA_AUTHORITIES and not has_formula(record):
            # The ledger says this number was COMPUTED; a bare literal in the
            # cell means the workbook ships a typed-in figure under a derived
            # authority.
            report.add(
                "AUTHORITY_DERIVED_CELL_NOT_A_FORMULA",
                cell=address, label=label, authority=authority,
                value=record.get("value"),
            )
        if authority == BROKER_AUTHORITY:
            if not CROSS_SHEET.search(formula):
                report.add(
                    "AUTHORITY_BROKER_CELL_NOT_LINKED",
                    cell=address, label=label, formula=formula,
                )
            elif font_colour(record) != GREEN:
                # Green is the claim "imported from another sheet"; the ledger
                # says exactly that, so a repainted cell contradicts its record.
                report.add(
                    "AUTHORITY_MARKING_CONTRADICTS_RECORD",
                    cell=address, label=label,
                    expected_colour=GREEN, observed_colour=font_colour(record),
                )

    declared = {}
    for entry in ledger:
        declared[entry.get("authority")] = declared.get(entry.get("authority"), 0) + 1
    for authority, count in sorted(declared.items()):
        if count and not exercised.get(authority):
            report.add("AUTHORITY_RULE_VACUOUS", authority=authority, declared=count)
    if ledger and resolved * 2 < len(ledger):
        report.add(
            "AUTHORITY_ROWS_UNRESOLVABLE",
            resolved=resolved, declared=len(ledger),
        )
    return {
        "authority_entries_checked": resolved,
        "authority_entries_declared": len(ledger),
        "authority_entries_unresolvable": len(unresolvable),
        "authority_rules_exercised": dict(sorted(exercised.items())),
    }


# ---------------------------------------------------------------------------
# Error scan: EVERY cell of EVERY sheet, out of the file's own bytes
# ---------------------------------------------------------------------------

# The spreadsheet error values, as OOXML spells them in a `t="e"` cell.
ERROR_VALUES = {
    "#DIV/0!", "#N/A", "#NAME?", "#NULL!", "#NUM!", "#REF!", "#VALUE!", "#SPILL!",
    "#CALC!", "#GETTING_DATA",
}


def inspect_physical_error_scan(reconstruction: dict, report: Report) -> dict:
    """No emitted cell may carry an error, anywhere in the package.

    The scan is over the reconstruction of the whole workbook, so a cell far
    outside the statement grid — a remote corner of any sheet — is read exactly
    like a cell in the middle of it.
    """
    scanned = 0
    sheets = (reconstruction.get("workbook") or {}).get("sheets") or []
    for sheet in sheets:
        for address, record in sorted((sheet.get("cells") or {}).items()):
            scanned += 1
            value = record.get("value")
            if record.get("type") == "e":
                report.add(
                    "WORKBOOK_ERROR_VALUE",
                    sheet=sheet.get("name"), cell=address, value=value,
                )
            elif isinstance(value, str) and value.strip() in ERROR_VALUES:
                # A cell that merely READS as an error is one too: a reader
                # cannot tell the spelling from the type.
                report.add(
                    "WORKBOOK_ERROR_TEXT",
                    sheet=sheet.get("name"), cell=address, value=value,
                )
    if not scanned:
        report.add("WORKBOOK_ERROR_SCAN_EMPTY", sheets=len(sheets))
    return {"error_scan_sheets": len(sheets), "error_scan_cells": scanned}


# ---------------------------------------------------------------------------
# The verdict
# ---------------------------------------------------------------------------


def judge(workbook_path: Path, contract: dict, ledger: list) -> dict:
    """Read the workbook once; judge every claim against its cells."""
    reconstruction = reconstruct_plan(Path(workbook_path))
    report = Report()
    metrics = {}
    metrics.update(inspect_physical_capture(reconstruction, contract, report))
    metrics.update(inspect_physical_authority(reconstruction, contract, ledger, report))
    metrics.update(inspect_physical_error_scan(reconstruction, report))
    return {
        "schema_version": "physical-authority-mutation-oracle/1.0",
        "status": report.verdict(),
        "workbook": str(workbook_path),
        "workbook_sha256": (reconstruction.get("reconstructed_from") or {}).get("xlsx_sha256"),
        "findings": report.findings,
        "finding_counts": dict(sorted(report.counts.items())),
        "metrics": metrics,
        "reader": "verify.plan_reconstruction_oracle.reconstruct_plan",
        "total_violations": sum(report.counts.values()),
    }
