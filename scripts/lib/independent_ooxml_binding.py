"""Independent physical-workbook binding checks for a manually authored oracle.

This module is deliberately standard-library only.  It reads raw OOXML and a
manually authored test contract; it does not consume a row map, model IR,
semantic manifest, proof graph, renderer object, or production compiler code.
"""

from __future__ import annotations

import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


MAIN_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
RID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
CELL_RE = re.compile(r"^([A-Z]+)([0-9]+)$")
REF_RE = re.compile(
    r"(?<![A-Za-z0-9_])"
    r"(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_ .-]+))!)?"
    r"(\$?[A-Z]{1,3}\$?[0-9]+)(?::(\$?[A-Z]{1,3}\$?[0-9]+))?"
)


def _column_number(name: str) -> int:
    value = 0
    for char in name:
        value = value * 26 + ord(char) - 64
    return value


def _column_name(number: int) -> str:
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _split_cell(address: str) -> tuple[str, int]:
    match = CELL_RE.fullmatch(address.replace("$", ""))
    if not match:
        raise ValueError("invalid A1 cell %s" % address)
    return match.group(1), int(match.group(2))


def _normalise_label(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def _sheet_part(archive: zipfile.ZipFile, sheet_name: str) -> str:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    relation_id = next(
        (
            sheet.get(RID)
            for sheet in workbook.findall("m:sheets/m:sheet", MAIN_NS)
            if sheet.get("name") == sheet_name
        ),
        None,
    )
    if not relation_id:
        raise KeyError("sheet %s is absent" % sheet_name)
    target = next(
        (
            item.get("Target")
            for item in relationships.findall("r:Relationship", REL_NS)
            if item.get("Id") == relation_id
        ),
        None,
    )
    if not target:
        raise KeyError("sheet %s has no relationship target" % sheet_name)
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join("xl", target))


def read_sheet(workbook_path: Path, sheet_name: str) -> dict[str, dict]:
    with zipfile.ZipFile(workbook_path, "r") as archive:
        root = ET.fromstring(archive.read(_sheet_part(archive, sheet_name)))
    cells = {}
    for node in root.findall(".//m:sheetData/m:row/m:c", MAIN_NS):
        address = node.get("r")
        formula_node = node.find("m:f", MAIN_NS)
        value_node = node.find("m:v", MAIN_NS)
        inline_node = node.find("m:is", MAIN_NS)
        if node.get("t") == "inlineStr" and inline_node is not None:
            value = "".join(
                item.text or ""
                for item in inline_node.iter()
                if item.tag.rsplit("}", 1)[-1] == "t"
            )
        else:
            value = value_node.text if value_node is not None else None
        cells[address] = {
            "formula": formula_node.text if formula_node is not None else None,
            "value": value,
        }
    return cells


def formula_references(formula: str | None, current_sheet: str) -> set[tuple[str, str]]:
    if not formula:
        return set()
    references = set()
    for match in REF_RE.finditer(formula):
        quoted, plain, first, last = match.groups()
        sheet = (quoted or plain or current_sheet).replace("''", "'").strip()
        first_column, first_row = _split_cell(first)
        last_column, last_row = _split_cell(last or first)
        for column in range(_column_number(first_column), _column_number(last_column) + 1):
            for row in range(first_row, last_row + 1):
                references.add((sheet, "%s%s" % (_column_name(column), row)))
    return references


def _path_exists(
    cells: dict[str, dict], sheet_name: str, start: str, target: str
) -> bool:
    pending = [start]
    visited = set()
    while pending:
        address = pending.pop()
        if address in visited:
            continue
        visited.add(address)
        for reference_sheet, reference in formula_references(
            (cells.get(address) or {}).get("formula"), sheet_name
        ):
            if reference_sheet != sheet_name:
                continue
            if reference == target:
                return True
            if reference not in visited:
                pending.append(reference)
    return False


def verify_manual_binding(workbook_path: Path, oracle: dict) -> dict:
    findings = []

    def block(code: str, message: str, **details) -> None:
        findings.append({"severity": "BLOCK", "code": code, "message": message, **details})

    sheet_name = str(oracle["sheet"])
    try:
        cells = read_sheet(workbook_path, sheet_name)
    except (KeyError, OSError, ValueError, zipfile.BadZipFile, ET.ParseError) as error:
        block("INDEPENDENT_OOXML_UNREADABLE", str(error))
        return {
            "status": "BLOCK",
            "total_violations": len(findings),
            "checks": 0,
            "findings": findings,
        }

    checks = 0
    label_column = str(oracle.get("label_column", "B"))

    instrument_rows = [int(item["debt_row"]) for item in oracle["instrument_bindings"]]
    observed_order = [
        _normalise_label((cells.get("%s%s" % (label_column, row)) or {}).get("value"))
        for row in instrument_rows
    ]
    expected_order = [_normalise_label(item) for item in oracle["instrument_order"]]
    checks += 1
    if observed_order != expected_order:
        block(
            "INDEPENDENT_INSTRUMENT_ORDER_MISMATCH",
            "Instrument rows no longer preserve the frozen independently authored order.",
            expected=expected_order,
            actual=observed_order,
        )

    all_balance_cells = {
        cell
        for binding in oracle["instrument_bindings"]
        for cell in binding["balance_cells"]
    }
    for binding in oracle["instrument_bindings"]:
        checks += 1
        debt_label = (cells.get("%s%s" % (label_column, binding["debt_row"])) or {}).get("value")
        interest_label = (cells.get("%s%s" % (label_column, binding["interest_row"])) or {}).get("value")
        if (
            _normalise_label(debt_label) != _normalise_label(binding["instrument_label"])
            or _normalise_label(interest_label) != _normalise_label(binding["interest_label"])
        ):
            block(
                "INDEPENDENT_INSTRUMENT_BINDING_LABEL_MISMATCH",
                "A debt/interest binding no longer resolves to its manually authored identities.",
                instrument=binding["instrument_label"],
            )
            continue
        formula = (cells.get(binding["interest_cell"]) or {}).get("formula")
        observed = {
            address
            for reference_sheet, address in formula_references(formula, sheet_name)
            if reference_sheet == sheet_name and address in all_balance_cells
        }
        expected = set(binding["balance_cells"])
        if observed != expected:
            block(
                "INDEPENDENT_INTEREST_EDGE_MISMATCH",
                "An instrument interest row consumes the wrong balance edge.",
                instrument=binding["instrument_label"],
                expected=sorted(expected),
                actual=sorted(observed),
            )

    for rule in oracle["reconciled_parents"]:
        for column in rule["columns"]:
            checks += 1
            owner = "%s%s" % (column, rule["owner_row"])
            formula = (cells.get(owner) or {}).get("formula")
            expected = {
                (sheet_name, "%s%s" % (column, row)) for row in rule["member_rows"]
            }
            observed = formula_references(formula, sheet_name)
            if not formula:
                block(
                    "INDEPENDENT_RECONCILED_PARENT_HARDCODE",
                    "A reconciled reported parent became a hardcode.",
                    cell=owner,
                )
            elif observed != expected:
                block(
                    "INDEPENDENT_RECONCILED_PARENT_MEMBERSHIP",
                    "A reconciled reported parent no longer sums its exact same-period children.",
                    cell=owner,
                )

    for rule in oracle["protected_cash_identities"]:
        for column in rule["columns"]:
            checks += 1
            owner = "%s%s" % (column, rule["owner_row"])
            formula = (cells.get(owner) or {}).get("formula")
            expected = {
                (sheet_name, "%s%s" % (column, row)) for row in rule["member_rows"]
            }
            observed = formula_references(formula, sheet_name)
            if not formula or observed != expected:
                block(
                    "INDEPENDENT_PROTECTED_CASH_IDENTITY",
                    "A protected cash identity is not the exact same-period member sum.",
                    cell=owner,
                    expected=sorted(address for _, address in expected),
                    actual=sorted(address for sheet, address in observed if sheet == sheet_name),
                )

    for rule in oracle["required_formula_paths"]:
        checks += 1
        if not _path_exists(cells, sheet_name, rule["from_cell"], rule["to_cell"]):
            block(
                "INDEPENDENT_REQUIRED_FORMULA_PATH_MISSING",
                "A manually authored physical formula path is absent.",
                path_id=rule["path_id"],
                from_cell=rule["from_cell"],
                to_cell=rule["to_cell"],
            )

    return {
        "status": "PASS" if not findings else "BLOCK",
        "total_violations": len(findings),
        "checks": checks,
        "findings": findings,
    }
