#!/usr/bin/env python3
"""Independent OOXML workbook-semantic acceptance oracle.

This module is intentionally standard-library only and imports no compiler,
renderer, row-map or semantic-manifest code.  It accepts a hand-authored proof
contract and reconstructs workbook facts directly from the XLSX package.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
RID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
CELL_RE = re.compile(r"^([A-Z]+)([0-9]+)$")
REF_RE = re.compile(
    r"(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_ .-]+))!)?"
    r"(\$?[A-Z]{1,3}\$?[0-9]+)(?::(\$?[A-Z]{1,3}\$?[0-9]+))?"
)


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def column_number(name: str) -> int:
    value = 0
    for char in name:
        value = value * 26 + ord(char) - 64
    return value


def column_name(number: int) -> str:
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def split_cell(address: str) -> tuple[str, int]:
    match = CELL_RE.match(address.replace("$", ""))
    if not match:
        raise ValueError(f"Invalid A1 reference {address}")
    return match.group(1), int(match.group(2))


def normalise_label(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


@dataclass(frozen=True)
class Cell:
    address: str
    value: object
    formula: str | None
    style_id: int
    data_type: str | None


@dataclass
class Sheet:
    name: str
    cells: dict[str, Cell]
    outline_levels: dict[int, int]

    def labels(self, column: str = "B") -> dict[str, list[int]]:
        result: dict[str, list[int]] = {}
        for address, cell in self.cells.items():
            cell_column, row = split_cell(address)
            if cell_column != column or not isinstance(cell.value, str):
                continue
            result.setdefault(normalise_label(cell.value), []).append(row)
        return result


@dataclass
class WorkbookFacts:
    sheets: dict[str, Sheet]
    styles: list[dict]
    defined_names: dict[str, str]


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    return ["".join(node.text or "" for node in item.iter() if local(node.tag) == "t") for item in root]


def _styles(archive: zipfile.ZipFile) -> list[dict]:
    if "xl/styles.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/styles.xml"))
    fills_node = root.find("m:fills", NS)
    fonts_node = root.find("m:fonts", NS)
    xfs_node = root.find("m:cellXfs", NS)
    fills = []
    for fill in list(fills_node) if fills_node is not None else []:
        pattern = fill.find("m:patternFill", NS)
        foreground = pattern.find("m:fgColor", NS) if pattern is not None else None
        fills.append({
            "pattern": pattern.get("patternType") if pattern is not None else None,
            "fg": dict(foreground.attrib) if foreground is not None else {},
        })
    fonts = []
    for font in list(fonts_node) if fonts_node is not None else []:
        colour = font.find("m:color", NS)
        fonts.append({"color": dict(colour.attrib) if colour is not None else {}})
    styles = []
    for xf in list(xfs_node) if xfs_node is not None else []:
        alignment = xf.find("m:alignment", NS)
        alignment_attributes = alignment.attrib if alignment is not None else {}
        fill_id = int(xf.get("fillId", "0"))
        font_id = int(xf.get("fontId", "0"))
        styles.append({
            "fill_id": fill_id,
            "font_id": font_id,
            "fill": fills[fill_id] if fill_id < len(fills) else {},
            "font": fonts[font_id] if font_id < len(fonts) else {},
            "indent": int(alignment_attributes.get("indent", "0")),
            "horizontal": alignment_attributes.get("horizontal"),
        })
    return styles


def read_workbook(path: Path) -> WorkbookFacts:
    with zipfile.ZipFile(path) as archive:
        shared = _shared_strings(archive)
        styles = _styles(archive)
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {node.get("Id"): node.get("Target") for node in relationships}
        sheets: dict[str, Sheet] = {}
        sheets_node = workbook.find("m:sheets", NS)
        for node in list(sheets_node) if sheets_node is not None else []:
            name = node.get("name")
            target = targets[node.get(RID)]
            if target.startswith("/"):
                target = target.lstrip("/")
            else:
                target = f"xl/{target}" if not target.startswith("xl/") else target
            target = target.replace("xl/../", "")
            root = ET.fromstring(archive.read(target))
            cells: dict[str, Cell] = {}
            outline: dict[int, int] = {}
            for row_node in root.findall(".//m:sheetData/m:row", NS):
                row_number = int(row_node.get("r"))
                outline[row_number] = int(row_node.get("outlineLevel", "0"))
                for cell_node in row_node.findall("m:c", NS):
                    address = cell_node.get("r")
                    data_type = cell_node.get("t")
                    style_id = int(cell_node.get("s", "0"))
                    formula_node = cell_node.find("m:f", NS)
                    value_node = cell_node.find("m:v", NS)
                    inline = cell_node.find("m:is", NS)
                    raw = value_node.text if value_node is not None else None
                    if data_type == "s" and raw is not None:
                        value: object = shared[int(raw)]
                    elif data_type == "inlineStr" and inline is not None:
                        value = "".join(
                            item.text or "" for item in inline.iter() if local(item.tag) == "t"
                        )
                    elif data_type == "str":
                        value = raw or ""
                    elif raw is None:
                        value = None
                    else:
                        try:
                            value = float(raw)
                        except ValueError:
                            value = raw
                    cells[address] = Cell(
                        address=address,
                        value=value,
                        formula=formula_node.text if formula_node is not None else None,
                        style_id=style_id,
                        data_type=data_type,
                    )
            sheets[name] = Sheet(name=name, cells=cells, outline_levels=outline)
        defined_names = {}
        names_node = workbook.find("m:definedNames", NS)
        for item in list(names_node or []):
            defined_names[item.get("name")] = item.text or ""
        return WorkbookFacts(sheets=sheets, styles=styles, defined_names=defined_names)


def expand_formula_references(formula: str | None, current_sheet: str) -> set[tuple[str, str]]:
    if not formula:
        return set()
    references: set[tuple[str, str]] = set()
    for match in REF_RE.finditer(formula):
        quoted, plain, first, last = match.groups()
        sheet = (quoted or plain or current_sheet).replace("''", "'").strip()
        first_col, first_row = split_cell(first)
        last_col, last_row = split_cell(last or first)
        for column in range(column_number(first_col), column_number(last_col) + 1):
            for row in range(first_row, last_row + 1):
                references.add((sheet, f"{column_name(column)}{row}"))
    return references


def is_independent_writer(cell: Cell | None) -> bool:
    return cell is not None and cell.formula is None and cell.value not in (None, "")


def _find_rows(sheet: Sheet, labels: list[str], column: str) -> list[int]:
    index = sheet.labels(column)
    rows = []
    for label in labels:
        rows.extend(index.get(normalise_label(label), []))
    return sorted(set(rows))


def _cell(sheet: Sheet, column: str, row: int) -> Cell | None:
    return sheet.cells.get(f"{column}{row}")


def _rule_rows(sheet: Sheet, rule: dict, role: str, label_column: str) -> list[int]:
    explicit = rule.get(f"{role}_row")
    if isinstance(explicit, int) and explicit > 0:
        return [explicit]
    return _find_rows(sheet, [rule[f"{role}_label"]], label_column)


def verify(facts: WorkbookFacts, contract: dict) -> dict:
    findings = []

    def block(code: str, message: str, **detail) -> None:
        findings.append({"severity": "BLOCK", "code": code, "message": message, **detail})

    sheet_name = contract.get("statement_sheet", "Operating Model")
    label_column = contract.get("label_column", "B")
    forecast_columns = contract.get("forecast_columns", ["J", "K", "L"])
    sheet = facts.sheets.get(sheet_name)
    if sheet is None:
        block("ORACLE_SHEET_MISSING", f"Required sheet {sheet_name} is absent.")
        return {"status": "BLOCK", "findings": findings, "metrics": {"sheets": len(facts.sheets)}}

    for rule in contract.get("unique_answers", []):
        rows = _find_rows(sheet, rule["labels"], label_column)
        maximum = int(rule.get("max_visible", 1))
        if len(rows) > maximum:
            block(
                "OOXML_DUPLICATE_ANSWER_OWNER",
                f"{rule['concept_id']} appears on {len(rows)} visible rows; maximum is {maximum}.",
                rows=rows,
            )

    for rule in contract.get("single_writer_groups", []):
        rows = [int(row) for row in rule.get("rows", []) if isinstance(row, int)]
        if not rows:
            rows = _find_rows(sheet, rule["labels"], label_column)
        for column in rule.get("columns", forecast_columns):
            writers = [row for row in rows if is_independent_writer(_cell(sheet, column, row))]
            maximum = int(rule.get("max_independent_writers", 1))
            if len(writers) > maximum:
                block(
                    "OOXML_MULTIPLE_INDEPENDENT_WRITERS",
                    f"{rule['concept_id']} has {len(writers)} independent writers in {column}.",
                    rows=writers,
                    column=column,
                )

    for rule in contract.get("capture_memberships", []):
        parents = _rule_rows(sheet, rule, "parent", label_column)
        children = _rule_rows(sheet, rule, "child", label_column)
        if len(parents) != 1 or len(children) != 1:
            block(
                "OOXML_CAPTURE_LABEL_UNRESOLVED",
                f"Capture labels do not resolve uniquely: {rule}.",
            )
            continue
        parent_row, child_row = parents[0], children[0]
        for column in rule.get("columns", forecast_columns):
            parent_cell = _cell(sheet, column, parent_row)
            expected = (sheet_name, f"{column}{child_row}")
            refs = expand_formula_references(parent_cell.formula if parent_cell else None, sheet_name)
            if expected not in refs:
                block(
                    "OOXML_CAPTURE_MEMBERSHIP_MISSING",
                    f"{rule['child_label']} is not a member of {rule['parent_label']} in {column}.",
                    parent_cell=f"{column}{parent_row}",
                    child_cell=f"{column}{child_row}",
                )

    for rule in contract.get("hierarchies", []):
        parents = _rule_rows(sheet, rule, "parent", label_column)
        children = _rule_rows(sheet, rule, "child", label_column)
        if len(parents) != 1 or len(children) != 1:
            block("OOXML_HIERARCHY_LABEL_UNRESOLVED", f"Hierarchy labels do not resolve uniquely: {rule}.")
            continue
        parent_row, child_row = parents[0], children[0]
        if child_row <= parent_row:
            block(
                "OOXML_CHILD_BEFORE_PARENT",
                f"{rule['child_label']} is not displayed after {rule['parent_label']}.",
                parent_row=parent_row,
                child_row=child_row,
            )
        parent_cell = _cell(sheet, label_column, parent_row)
        child_cell = _cell(sheet, label_column, child_row)
        parent_indent = facts.styles[parent_cell.style_id]["indent"] if parent_cell and parent_cell.style_id < len(facts.styles) else 0
        child_indent = facts.styles[child_cell.style_id]["indent"] if child_cell and child_cell.style_id < len(facts.styles) else 0
        if child_indent <= parent_indent:
            block(
                "OOXML_HIERARCHY_INDENT_INVALID",
                f"{rule['child_label']} is not indented beneath {rule['parent_label']}.",
                parent_indent=parent_indent,
                child_indent=child_indent,
            )

    for rule in contract.get("schedule_links", []):
        statement_sheet = facts.sheets.get(rule.get("statement_sheet", sheet_name))
        schedule_sheet_name = rule.get("schedule_sheet", sheet_name)
        schedule_sheet = facts.sheets.get(schedule_sheet_name)
        if statement_sheet is None or schedule_sheet is None:
            block("OOXML_LINK_SHEET_MISSING", f"Schedule-link sheet is absent: {rule}.")
            continue
        statement_rows = _rule_rows(statement_sheet, rule, "statement", label_column)
        schedule_rows = _rule_rows(schedule_sheet, rule, "schedule", label_column)
        if len(statement_rows) != 1 or len(schedule_rows) != 1:
            block("OOXML_LINK_LABEL_UNRESOLVED", f"Schedule-link labels do not resolve uniquely: {rule}.")
            continue
        for column in rule.get("columns", forecast_columns):
            statement_cell = _cell(statement_sheet, column, statement_rows[0])
            schedule_cell = _cell(schedule_sheet, column, schedule_rows[0])
            expected = (schedule_sheet_name, f"{column}{schedule_rows[0]}")
            statement_refs = expand_formula_references(
                statement_cell.formula if statement_cell else None,
                statement_sheet.name,
            )
            reverse = (statement_sheet.name, f"{column}{statement_rows[0]}") in expand_formula_references(
                schedule_cell.formula if schedule_cell else None,
                schedule_sheet.name,
            )
            if expected not in statement_refs or reverse:
                block(
                    "OOXML_SCHEDULE_LINK_REVERSED",
                    f"{rule['statement_label']} does not consume {rule['schedule_label']} in {column}.",
                    column=column,
                )

    formula_cells = []
    for candidate_sheet in facts.sheets.values():
        for cell in candidate_sheet.cells.values():
            if cell.data_type == "e" or (isinstance(cell.value, str) and cell.value.startswith("#")):
                block("OOXML_EXCEL_ERROR", f"Excel error at {candidate_sheet.name}!{cell.address}.")
            if not cell.formula:
                continue
            refs = expand_formula_references(cell.formula, candidate_sheet.name)
            formula_cells.append((candidate_sheet.name, cell, refs))
            if len(cell.formula) > int(contract.get("max_formula_characters", 8192)):
                block("OOXML_FORMULA_TOO_LONG", f"Formula at {candidate_sheet.name}!{cell.address} exceeds the length budget.")

    return {
        "schema_version": 1,
        "kind": "independent_workbook_semantic_oracle",
        "status": "PASS" if not findings else "BLOCK",
        "findings": findings,
        "metrics": {
            "sheets": len(facts.sheets),
            "cells": sum(len(item.cells) for item in facts.sheets.values()),
            "formula_cells": len(formula_cells),
            "defined_names": len(facts.defined_names),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", required=True, type=Path)
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    facts = read_workbook(args.xlsx)
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    report = verify(facts, contract)
    payload = json.dumps(report, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(payload, encoding="utf-8")
    sys.stdout.write(json.dumps({"status": report["status"], **report["metrics"]}) + "\n")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
