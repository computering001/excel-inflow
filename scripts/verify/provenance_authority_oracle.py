#!/usr/bin/env python3
"""P5.3 — provenance styling and provenance comments, judged against the
AUTHORITY RECORD governing the cell rather than against the emitter's own rule.

WHY THIS EXISTS.  A provenance mark is a CLAIM.  Blue font says "a human read
this number off a filed page"; green says "this number was imported from
another sheet"; a `Source: ...` comment names the document and the page.  Until
this oracle, every check of those claims took its expectation from the same
place the claim came from:

  * `scripts/build_dynamic_model.mjs` chooses the colour in `formulaColor()` —
    green if the formula text matches a sheet-qualified reference, black
    otherwise, blue if there is no formula at all;
  * `scripts/validate_dynamic_model.mjs` (`font-colour-contract`) and its port
    `scripts/verify/validate_dynamic_model.py` re-derive `expected` from THE
    SAME CELL'S FORMULA TEXT with the same rule.

Emitter and validator therefore agree by construction.  What that pairing
cannot see is a mark that is internally consistent and FALSE: a derived
subtotal shipped as a typed-in number and painted blue has no formula, so blue
is "expected", and the workbook tells the reader a computed figure was read off
a filing.  The comment channel was weaker still — `historical-provenance-comments`
asks only whether a comment is PRESENT at the address, so a comment naming a
document that does not exist passes exactly as a true one does.

WHAT THIS ORACLE DOES INSTEAD.  Observation and expectation come from different
places and neither is the emitter's rule:

  * OBSERVATION — the emitted `.xlsx` package, read through P5.4's independently
    verified reconstruction (`reconstruct_plan`): resolved font colour per cell,
    formula, cached value, and every comment's cell and text.
  * EXPECTATION — the AUTHORITY RECORDS.  For a historical period, the case's
    own declaration of the row (a calculation over other rows is DERIVED; a
    filed line is a SOURCE) and the case's `provenance` ledger entry for that
    row and period.  For a forecast period, the model IR's authority plane
    entry for that row and forecast period: `producer_type`, `method`,
    `source_kind`, `formula_operator`.
  * BINDING — `<workbook>.provenance-authority.json`, the emitter's record of
    WHICH authority record governs each marked cell and which record each
    source comment was rendered from.  The binding is a pointer, never a copy,
    and this oracle does not take it on trust: every pointer is re-derived
    independently from the row map's geometry and refused if it disagrees.

Scope note, because the incumbent's was narrow and unstated: the mechanical
sweep (a mark that contradicts the SHAPE of its own cell) runs over every cell
of every sheet, not the income-statement and cash-flow rows of one sheet.  The
authority-bound sweep runs over the statement grid, which is where authority
records exist.

Independence: standard library plus openpyxl (through P5.4's reader) and no
production import — `verify/oracle_independence.py` AST-scans this file with
the rest of `scripts/verify`.
"""

from __future__ import annotations

import argparse
import json
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

BINDING_VERSION = "provenance-authority/1"

# The provenance channel, as the emitter's own constitution states it.  These
# are the only four font colours that mean anything in this channel; anything
# else is not a provenance claim and is not judged as one.
MARKINGS = {
    "FF0000FF": "hardcode",
    "FF000000": "same_sheet_formula",
    "FF008000": "cross_sheet_link",
    "FFFFFFFF": "chrome",
}

# A sheet-qualified reference.  This is a fact about OOXML formula syntax read
# off the emitted file, not the emitter's colour rule: the question it answers
# is "does this cell's value come from another sheet", which is what green
# claims.
CROSS_SHEET = re.compile(r"(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)!")

SOURCE_COMMENT = "Source: "
FORECAST_COMMENT = "Forecast authority: "
ABSENCE_COMMENT = "Declared absence: "


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------


class Report:
    def __init__(self) -> None:
        self.findings: list = []
        self.counts: dict = {}
        self.metrics: dict = {}

    def add(self, code: str, **evidence) -> None:
        self.counts[code] = self.counts.get(code, 0) + 1
        if self.counts[code] <= FINDINGS_PER_CODE:
            self.findings.append({"code": code, **evidence})

    def payload(self, declared_gaps: list) -> dict:
        return {
            "oracle": "provenance_authority/1",
            "status": "PASS" if not self.counts else "BLOCK",
            "finding_counts": dict(sorted(self.counts.items())),
            "findings": self.findings,
            "metrics": self.metrics,
            "declared_gaps": declared_gaps,
        }


# ---------------------------------------------------------------------------
# The authority records
# ---------------------------------------------------------------------------


def case_rows(case: dict) -> dict:
    rows = {}
    structure = case.get("statement_structure") or {}
    for section in ("income_statement", "cash_flow"):
        for row in structure.get(section) or []:
            rows[row.get("row_id")] = row
    return rows


def declared_historical_authority(row: dict | None) -> str:
    """What the CASE says produces a row's reported history.

    Read off the case, which is the run's INPUT: a row the case declares as a
    calculation over other rows is derived; a row it declares as a filed line
    is a source.  `historical_authority`, where the compiler set one, is
    explicit and wins.
    """
    if row is None:
        return "unknown"
    explicit = row.get("historical_authority")
    if explicit in ("derived_formula", "reported_total_reconciled"):
        return "derived"
    if explicit == "source_input":
        return "source"
    if explicit == "not_applicable":
        return "not_applicable"
    refs = ((row.get("calculation") or {}).get("refs")) or []
    if row.get("row_type") in ("calculation", "subtotal") and refs:
        return "derived"
    return "source"


def provenance_entry(case: dict, row_id: str, period_index: int) -> dict | None:
    for entry in (case.get("provenance") or {}).get(row_id) or []:
        if int(entry.get("period_index", -1)) == int(period_index):
            return entry
    return None


def compiler_provenance_entry(row_map: dict, row_id: str, period_index: int) -> dict | None:
    """A row the COMPILER minted has no case declaration; the row map carries
    the compiler's own statement of why the row exists, and the emitter renders
    a comment from it for each historical period."""
    for definition in statement_definitions(row_map):
        if definition.get("row_id") != row_id:
            continue
        minted = definition.get("compiler_provenance")
        if minted:
            return {**minted, "period_index": int(period_index)}
    return None


def statement_definitions(row_map: dict) -> list:
    rows = (row_map.get("statement_rows") or {})
    return [
        *(rows.get("income_statement") or []),
        *(rows.get("cash_flow") or []),
    ]


def row_map_definition(definitions: list, row_id: str) -> dict | None:
    for definition in definitions:
        if definition.get("row_id") == row_id:
            return definition
    return None


def filed_observation(
    case: dict, definitions: list, row_id: str, period_index: int
) -> object:
    """The figure an authority record says was REPORTED for this period, or None.

    D23 fix.  A row's `calculation` — and, on a compiled case, its
    `historical_authority: "derived_formula"` — states the row's DERIVATION
    RULE.  Neither is a statement that no figure was reported for the
    historical periods, and the first version of this table read them as one.
    The record that says a figure WAS reported is one of these two, both
    authored by the case or the compiler and never by the emitter's colour
    rule:

      * `reported_historical_values[period]` on the compiled row — the
        compiler's explicit "these three are the reported figures";
      * for `ending_cash` under the LEGACY single-bucket cash policy, the
        case's own `cash_policy.historical_year_end_cash[period]`.  The
        emitter states the reason at `build_dynamic_model.mjs:4362`–`:4372`:
        a legacy historical closing-cash balance "is a filed observation, not
        an amount the workbook is entitled to replace with a reconstructed
        cash-flow identity", and it suppresses the historical formula for
        exactly that row (`sourcedHistoricalEndingCash`).

    Anything else derived stays refused: this is a named exception resting on a
    compiler field and a declared cash-policy shape, not a heuristic.
    """
    definition = row_map_definition(definitions, row_id) or {}
    reported = definition.get("reported_historical_values")
    if isinstance(reported, list) and period_index < len(reported):
        candidate = reported[period_index]
        if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
            return float(candidate)
    role = definition.get("semantic_role") or (case_rows(case).get(row_id) or {}).get("semantic_role")
    policy = case.get("cash_policy") or {}
    if role == "ending_cash" and not policy.get("buckets"):
        series = policy.get("historical_year_end_cash")
        if isinstance(series, list) and period_index < len(series):
            candidate = series[period_index]
            if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
                return float(candidate)
    return None


def declared_historical_value(
    case: dict, definitions: list, row_id: str, period_index: int
) -> object:
    """The reported figure a blue historical cell must be STATING, if the case
    supplies one at all: the filed observation where one is declared, otherwise
    the row's own `values` series."""
    filed = filed_observation(case, definitions, row_id, period_index)
    if filed is not None:
        return filed
    for source in (
        (case_rows(case).get(row_id) or {}).get("values"),
        (row_map_definition(definitions, row_id) or {}).get("values"),
    ):
        if isinstance(source, list) and period_index < len(source):
            candidate = source[period_index]
            if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
                return float(candidate)
    return None


def forecast_authority(model_ir: dict, row_id: str, forecast_index: int) -> dict | None:
    for record in ((model_ir.get("planes") or {}).get("authority") or []):
        if record.get("display_id") == row_id and int(record.get("forecast_index", -1)) == int(forecast_index):
            return record
    return None


# ---------------------------------------------------------------------------
# What each authority record permits the mark to say
# ---------------------------------------------------------------------------


def permitted_markings(
    kind: str, authority: dict | None, declaration: str, filed: object = None
) -> tuple:
    """The marks a governing authority record permits, and why.

    Hand-authored here from what each authority MEANS, not from what the
    emitter did.  Returned as (permitted set, requirement note); an empty
    permitted set means the cell must carry no content at all.
    """
    if kind == "historical":
        if declaration == "derived":
            if filed is not None:
                return (
                    {"hardcode", "same_sheet_formula", "cross_sheet_link"},
                    "the row is derived, but an authority record declares a FILED "
                    "OBSERVATION for this period which the workbook is not entitled "
                    "to replace with a reconstructed identity",
                )
            return (
                {"same_sheet_formula", "cross_sheet_link"},
                "the case declares this row as computed from other rows and declares no "
                "filed observation for the period, so the workbook may not claim the "
                "number was read off a filed page",
            )
        if declaration == "not_applicable":
            return (
                {"hardcode", "same_sheet_formula", "cross_sheet_link"},
                "the case declares the line absent from the filing",
            )
        return (
            {"hardcode", "same_sheet_formula", "cross_sheet_link"},
            "a filed figure may be entered here or staged elsewhere and linked",
        )
    producer = (authority or {}).get("producer_type")
    if producer == "CapturedBy":
        return (set(), "the forecast is captured by a parent row, so this cell holds nothing")
    if producer == "BrokerInput":
        return (
            {"cross_sheet_link"},
            "the authority is a broker feed, which reaches the statement as a link to the Brokers sheet",
        )
    if producer in ("Derived", "ScheduleLink"):
        return (
            {"same_sheet_formula", "cross_sheet_link"},
            "the authority produces this value by calculation or by a link to a schedule",
        )
    if producer == "UserInput":
        if (authority or {}).get("formula_operator"):
            return (
                {"same_sheet_formula", "cross_sheet_link"},
                "the authority declares a formula operator, so the value is produced by a formula",
            )
        return (
            {"hardcode", "cross_sheet_link"},
            "a user assumption is entered here or staged in the assumptions block and linked",
        )
    return (set(), "no producer type on the governing authority record")


# ---------------------------------------------------------------------------
# Rendering a provenance comment from the authority record
# ---------------------------------------------------------------------------


def render_source_comment(entry: dict) -> str:
    """The comment the authority record entails, re-rendered here.

    An independent re-implementation of the shipped format, from the record's
    fields.  A comment that does not equal this is asserting something the
    authority does not say.
    """
    if entry.get("declared_absence"):
        return "\n".join([
            'Declared absence: the filing prints no "%s" line.' % entry.get("label"),
            "The compiler minted this canonical row with zero history so the",
            "statement identity stays complete; there is no page to cite.",
        ])
    parts = [
        "Source: %s" % entry.get("document"),
        "Published: %s" % entry.get("publication_date"),
        "Page / note: %s" % entry.get("page_or_note"),
        "Source label: %s" % entry.get("source_label"),
        "Units: %s" % entry.get("units"),
    ]
    if entry.get("transformation"):
        parts.append("Transformation: %s" % entry.get("transformation"))
    return "\n".join(parts)


def declared_absence_entry(case_row: dict | None, period_index: int) -> dict | None:
    """The absence statement is only true if the CASE declares the absence."""
    if not case_row:
        return None
    if case_row.get("historical_authority") != "not_applicable":
        return None
    values = (case_row.get("values") or [])[:3]
    if not all(value is None or float(value) == 0 for value in values):
        return None
    return {
        "declared_absence": True,
        "label": case_row.get("label") or case_row.get("row_id"),
        "period_index": int(period_index),
    }


# ---------------------------------------------------------------------------
# The workbook as observed
# ---------------------------------------------------------------------------


def observe(xlsx: Path) -> dict:
    reconstruction = reconstruct_plan(xlsx)
    sheets = {}
    for sheet in reconstruction["workbook"]["sheets"]:
        cells = {}
        for address, record in (sheet.get("cells") or {}).items():
            colour = ((record.get("style") or {}).get("font") or {}).get("color")
            formula = record.get("formula")
            value = record.get("value")
            cells[address] = {
                "colour": colour if isinstance(colour, str) else None,
                "marking": MARKINGS.get(colour if isinstance(colour, str) else ""),
                "formula": formula,
                "cross_sheet": bool(formula) and bool(CROSS_SHEET.search(formula)),
                "populated": formula is not None or (value is not None and value != ""),
                "value": value,
            }
        sheets[sheet["name"]] = {
            "cells": cells,
            "comments": {entry["cell"]: entry["text"] for entry in (sheet.get("comments") or [])},
        }
    return {"sheets": sheets, "xlsx_sha256": reconstruction["reconstructed_from"]["xlsx_sha256"]}


# ---------------------------------------------------------------------------
# The verdict
# ---------------------------------------------------------------------------


DECLARED_GAPS = [
    "Rows the COMPILER minted have no case declaration; their historical authority is "
    "resolved through the row map's `compiler_provenance`, which the build authored. The "
    "case-declared rows — the ones a reader would sue over — resolve against the case.",
    "The debt schedule, the Brokers sheet and Forward Curves are covered by the MECHANICAL "
    "sweep (a mark that contradicts its own cell) and by the comment-truth sweep, but carry "
    "no per-cell authority record to bind a colour to; binding them is not in this package.",
    "Cached VALUES are not judged here. This oracle asks whether the provenance claim about a "
    "number is true, not whether the number is right.",
    "Adjustment (N:P), pro-forma reference (R) and pro-forma (S:U) columns mirror a standalone "
    "period rather than carrying an authority record of their own, so they are swept "
    "mechanically and for comment truth but not bound.",
]


def verify(xlsx: Path, case: dict, model_ir: dict, row_map: dict, binding: dict) -> dict:
    report = Report()
    observed = observe(xlsx)

    if binding.get("version") != BINDING_VERSION:
        report.add(
            "PROV_BINDING_VERSION",
            expected=BINDING_VERSION,
            actual=binding.get("version"),
        )
        return report.payload(DECLARED_GAPS)

    rows_by_id = case_rows(case)
    definitions = statement_definitions(row_map)
    columns = row_map.get("columns") or {}
    historical_columns = columns.get("historical") or ["G", "H", "I"]
    forecast_columns = columns.get("forecast") or ["J", "K", "L"]

    # The address book, re-derived here so a binding pointer can be checked
    # rather than believed: address -> the authority coordinates the geometry
    # says govern it.
    expected_pointer = {}
    for definition in definitions:
        if definition.get("row_type") == "header":
            continue
        row = definition.get("row")
        if not isinstance(row, int):
            continue
        for index, column in enumerate(historical_columns):
            expected_pointer["%s%d" % (column, row)] = ("historical", definition["row_id"], index, None)
        for index, column in enumerate(forecast_columns):
            expected_pointer["%s%d" % (column, row)] = ("forecast", definition["row_id"], index + 3, index)

    # ---------------------------------------------------------------- mechanical
    mechanical_visited = 0
    for sheet_name, sheet in observed["sheets"].items():
        for address, cell in sorted(sheet["cells"].items()):
            if not cell["populated"] or cell["marking"] is None:
                continue
            mechanical_visited += 1
            marking = cell["marking"]
            formula = cell["formula"]
            if marking == "hardcode" and formula is not None:
                report.add(
                    "PROV_MARK_CONTRADICTS_FORMULA", sheet=sheet_name, cell=address,
                    marking=marking, formula=formula,
                    message="blue claims a hand-entered number, but the cell holds a formula",
                )
            elif formula is not None and cell["cross_sheet"] and marking not in ("cross_sheet_link", "chrome"):
                report.add(
                    "PROV_MARK_CONTRADICTS_FORMULA", sheet=sheet_name, cell=address,
                    marking=marking, formula=formula,
                    message="the formula imports from another sheet and the mark does not say so",
                )
            elif formula is not None and not cell["cross_sheet"] and marking == "cross_sheet_link":
                report.add(
                    "PROV_MARK_CONTRADICTS_FORMULA", sheet=sheet_name, cell=address,
                    marking=marking, formula=formula,
                    message="green claims a cross-sheet link over a same-sheet formula",
                )

    # ------------------------------------------------------------ cell bindings
    bound = {}
    for record in binding.get("cells") or []:
        bound[(record.get("sheet"), record.get("cell"))] = record

    operating = observed["sheets"].get("Operating Model") or {"cells": {}, "comments": {}}
    grid_visited = 0
    authority_visited = 0
    for address, pointer in sorted(expected_pointer.items()):
        cell = operating["cells"].get(address)
        record = bound.get(("Operating Model", address))
        if cell is None or not cell["populated"]:
            continue
        grid_visited += 1
        if cell["marking"] is None:
            continue
        if record is None:
            report.add(
                "PROV_BINDING_ABSENT", sheet="Operating Model", cell=address,
                marking=cell["marking"],
                message="a provenance-marked statement cell with no authority record bound to it",
            )
            continue
        authority_pointer = record.get("authority") or {}
        kind, row_id, period_index, forecast_index = pointer
        if (
            authority_pointer.get("kind") != kind
            or authority_pointer.get("row_id") != row_id
            or int(authority_pointer.get("period_index", -1)) != period_index
        ):
            report.add(
                "PROV_BINDING_GEOMETRY_MISMATCH", sheet="Operating Model", cell=address,
                bound=authority_pointer, derived={"kind": kind, "row_id": row_id, "period_index": period_index},
                message="the bound authority is not the one this address belongs to",
            )
            continue
        if record.get("font_color") != cell["colour"]:
            report.add(
                "PROV_BINDING_MARK_DRIFT", sheet="Operating Model", cell=address,
                bound=record.get("font_color"), emitted=cell["colour"],
                message="the binding records a colour the emitted file does not carry",
            )

        case_row = rows_by_id.get(row_id)
        if kind == "historical":
            declaration = declared_historical_authority(case_row)
            authority = None
            if declaration == "unknown":
                # A compiler-minted row has no case declaration.  It is not
                # silently excused: the COMPILER's own account of the row must
                # exist — either the historical authority it stamped on the row
                # map definition, or the `compiler_provenance` it minted for the
                # reader.  A row with neither is a cell nothing governs.
                declaration = declared_historical_authority(
                    row_map_definition(definitions, row_id)
                )
                if declaration == "unknown" or not (
                    row_map_definition(definitions, row_id) or {}
                ).get("historical_authority"):
                    if not compiler_provenance_entry(row_map, row_id, period_index):
                        report.add(
                            "PROV_BINDING_UNRESOLVED", sheet="Operating Model", cell=address,
                            row_id=row_id, period_index=period_index,
                            message="no authority record governs this cell in the case or the row map",
                        )
                        continue
                    declaration = "source"
        else:
            authority = forecast_authority(model_ir, row_id, forecast_index)
            if authority is None:
                report.add(
                    "PROV_BINDING_UNRESOLVED", sheet="Operating Model", cell=address,
                    row_id=row_id, forecast_index=forecast_index,
                    message="the model IR's authority plane holds no record for this row and forecast period",
                )
                continue
            declaration = "forecast"

        authority_visited += 1
        filed = (
            filed_observation(case, definitions, row_id, period_index)
            if kind == "historical" else None
        )
        permitted, why = permitted_markings(kind, authority, declaration, filed)
        if cell["marking"] not in permitted:
            report.add(
                "PROV_MARK_CONTRADICTS_AUTHORITY", sheet="Operating Model", cell=address,
                row_id=row_id, period_index=period_index, marking=cell["marking"],
                authority={
                    "kind": kind,
                    "declaration": declaration,
                    "producer_type": (authority or {}).get("producer_type"),
                    "method": (authority or {}).get("method"),
                },
                permitted=sorted(permitted), why=why,
            )
            continue

        # A blue statement hardcode is the strongest claim in the workbook — it
        # says a person read this number off a page.  Three things must hold, and
        # the second and third are D23's new teeth: it must CITE a page, an
        # authority RECORD for that page must exist, and the cell must be
        # STATING the figure the case reports for that period rather than a
        # number of its own.
        if kind == "historical" and cell["marking"] == "hardcode":
            if address not in operating["comments"]:
                report.add(
                    "PROV_HARDCODE_WITHOUT_SOURCE", sheet="Operating Model", cell=address,
                    row_id=row_id, period_index=period_index,
                    message="a blue historical hardcode claims a filed source and cites no page",
                )
            elif not (
                provenance_entry(case, row_id, period_index)
                or compiler_provenance_entry(row_map, row_id, period_index)
                or declared_absence_entry(case_row, period_index)
            ):
                report.add(
                    "PROV_HARDCODE_WITHOUT_SOURCE", sheet="Operating Model", cell=address,
                    row_id=row_id, period_index=period_index,
                    message="a blue historical hardcode claims a filed source that no "
                            "authority record declares",
                )
            reported = declared_historical_value(case, definitions, row_id, period_index)
            stated = cell["value"]
            if (
                reported is not None
                and isinstance(stated, (int, float))
                and not isinstance(stated, bool)
                and abs(float(stated) - reported) > 1e-6 * max(1.0, abs(reported))
            ):
                report.add(
                    "PROV_HARDCODE_VALUE_NOT_FILED", sheet="Operating Model", cell=address,
                    row_id=row_id, period_index=period_index,
                    stated=stated, authority_reports=reported,
                    message="a blue hardcode cites a filed page but does not state the "
                            "figure the authority record reports",
                )

    # ------------------------------------------------------------ comment truth
    bound_comments = {}
    for record in binding.get("comments") or []:
        bound_comments[(record.get("sheet"), record.get("cell"))] = record.get("authority") or {}

    comments_visited = 0
    claims_checked = 0
    for sheet_name, sheet in observed["sheets"].items():
        for address, text in sorted(sheet["comments"].items()):
            comments_visited += 1
            asserts_source = text.startswith(SOURCE_COMMENT) or text.startswith(ABSENCE_COMMENT)
            pointer = bound_comments.get((sheet_name, address))
            if asserts_source and pointer is None:
                report.add(
                    "PROV_COMMENT_UNBOUND", sheet=sheet_name, cell=address,
                    text=text.splitlines()[0],
                    message="a comment asserting a source with no authority record bound to it",
                )
                continue
            if pointer is None:
                continue
            claims_checked += 1
            row_id = pointer.get("row_id")
            period_index = int(pointer.get("period_index", -1))
            case_row = rows_by_id.get(row_id)
            entry = (
                provenance_entry(case, row_id, period_index)
                or compiler_provenance_entry(row_map, row_id, period_index)
                or declared_absence_entry(case_row, period_index)
            )
            if pointer.get("kind") == "forecast_authority" and entry is None:
                authority = forecast_authority(model_ir, row_id, pointer.get("forecast_index"))
                if authority is None:
                    report.add(
                        "PROV_COMMENT_UNRESOLVED", sheet=sheet_name, cell=address,
                        row_id=row_id, forecast_index=pointer.get("forecast_index"),
                        message="the comment names a forecast authority no authority record declares",
                    )
                    continue
                if not text.startswith(FORECAST_COMMENT):
                    report.add(
                        "PROV_COMMENT_CLAIM_FALSE", sheet=sheet_name, cell=address,
                        row_id=row_id,
                        message="a forecast-authority comment that does not state its authority",
                        emitted=text.splitlines()[0],
                    )
                    continue
                claimed = text.splitlines()[0][len(FORECAST_COMMENT):].strip()
                if claimed != str(authority.get("method")):
                    report.add(
                        "PROV_COMMENT_CLAIM_FALSE", sheet=sheet_name, cell=address,
                        row_id=row_id, claimed=claimed, authority_method=authority.get("method"),
                        message="the comment names a method the authority record does not",
                    )
                    continue
                for line in text.splitlines()[1:]:
                    if not line.startswith("Source kind: "):
                        continue
                    kind_claim = line[len("Source kind: "):].strip()
                    entails = authority.get("source_kind") or "not declared"
                    if kind_claim != str(entails):
                        report.add(
                            "PROV_COMMENT_CLAIM_FALSE", sheet=sheet_name, cell=address,
                            row_id=row_id, claimed=kind_claim, authority_source_kind=entails,
                            message="the comment names a source kind the authority record does not",
                        )
                continue
            if entry is None:
                report.add(
                    "PROV_COMMENT_UNRESOLVED", sheet=sheet_name, cell=address,
                    row_id=row_id, period_index=period_index,
                    message="the comment cites a source no authority record declares",
                )
                continue
            expected = render_source_comment(entry)
            if text != expected:
                report.add(
                    "PROV_COMMENT_CLAIM_FALSE", sheet=sheet_name, cell=address,
                    row_id=row_id, period_index=period_index,
                    emitted=text[:400], authority_entails=expected[:400],
                    message="the comment asserts something the authority record does not say",
                )
                continue
            # A source comment on a cell the case declares DERIVED is a false
            # claim even when every field of it is faithfully rendered.
            derived_cell = (
                sheet_name == "Operating Model"
                and expected_pointer.get(address, (None,))[0] == "historical"
                and declared_historical_authority(rows_by_id.get(expected_pointer[address][1])) == "derived"
            )
            if derived_cell and not entry.get("declared_absence"):
                report.add(
                    "PROV_SOURCE_COMMENT_ON_DERIVED_CELL", sheet=sheet_name, cell=address,
                    row_id=expected_pointer[address][1],
                    message="a filed-source citation on a cell the case declares computed",
                )

    for (sheet_name, address) in sorted(bound_comments):
        sheet = observed["sheets"].get(sheet_name)
        if sheet is None or address not in sheet["comments"]:
            report.add(
                "PROV_COMMENT_ABSENT_FROM_FILE", sheet=sheet_name, cell=address,
                message="an authority record was bound to a comment the file does not carry",
            )

    # ------------------------------------------------------------------ vacuity
    if mechanical_visited == 0:
        report.add("PROV_EMPTY_VISIT", channel="mechanical")
    if grid_visited == 0:
        report.add("PROV_EMPTY_VISIT", channel="statement_grid")
    if authority_visited == 0:
        report.add("PROV_EMPTY_VISIT", channel="authority_bound")
    if claims_checked == 0:
        report.add("PROV_EMPTY_VISIT", channel="comment_claims")

    report.metrics = {
        "xlsx_sha256": observed["xlsx_sha256"],
        "sheets": len(observed["sheets"]),
        "marked_cells_swept": mechanical_visited,
        "statement_grid_cells": grid_visited,
        "authority_bound_cells": authority_visited,
        "comments_read": comments_visited,
        "comment_claims_checked": claims_checked,
        "bound_cells": len(bound),
        "bound_comments": len(bound_comments),
    }
    return report.payload(DECLARED_GAPS)


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", required=True, type=Path)
    parser.add_argument("--case", required=True, type=Path)
    parser.add_argument("--binding", type=Path)
    parser.add_argument("--row-map", type=Path)
    parser.add_argument("--model-ir", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    binding = args.binding or Path(str(args.xlsx) + ".provenance-authority.json")
    row_map = args.row_map or Path(str(args.xlsx) + ".row-map.json")
    model_ir = args.model_ir or Path(str(args.xlsx) + ".model-ir-v3.json")
    report = verify(
        args.xlsx, load(args.case), load(model_ir), load(row_map), load(binding),
    )
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    sys.stdout.write(json.dumps({"status": report["status"], **report["metrics"]}) + "\n")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
