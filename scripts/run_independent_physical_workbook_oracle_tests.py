#!/usr/bin/env python3
"""Frozen, manually authored OOXML binding oracle and mutations.

The clean workbook below is literal OOXML.  It is not emitted by Excel Inflow
and this test never reads an emitted proof graph, model IR, semantic manifest,
or row map.  The separately authored MANUAL_ORACLE binds the physical edges a
reviewer can verify directly from the worksheet XML.
"""

from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from lib.independent_ooxml_binding import verify_manual_binding


NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
MAIN_NS = {"m": NS}

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>
"""
ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
"""
WORKBOOK = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Operating Model" sheetId="1" r:id="rId1"/></sheets>
</workbook>
"""
WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>
"""
SHEET = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="B1" t="inlineStr"><is><t>Independent physical binding oracle</t></is></c></row>
    <row r="10"><c r="B10" t="inlineStr"><is><t>Alpha Notes</t></is></c><c r="I10"><v>100</v></c><c r="J10"><f>I10</f><v>100</v></c></row>
    <row r="11"><c r="B11" t="inlineStr"><is><t>Beta Loan</t></is></c><c r="I11"><v>80</v></c><c r="J11"><f>I11</f><v>80</v></c></row>
    <row r="12"><c r="B12" t="inlineStr"><is><t>RCF</t></is></c><c r="I12"><v>20</v></c><c r="J12"><f>I12+J13-J14</f><v>23</v></c></row>
    <row r="13"><c r="B13" t="inlineStr"><is><t>RCF draw</t></is></c><c r="J13"><v>5</v></c></row>
    <row r="14"><c r="B14" t="inlineStr"><is><t>RCF repayment</t></is></c><c r="J14"><v>2</v></c></row>
    <row r="15"><c r="B15" t="inlineStr"><is><t>Debt cash movement</t></is></c><c r="J15"><f>J13-J14</f><v>3</v></c></row>
    <row r="20"><c r="B20" t="inlineStr"><is><t>Reported Product Total</t></is></c><c r="G20"><f>G21+G22</f><v>100</v></c><c r="H20"><f>H21+H22</f><v>110</v></c><c r="I20"><f>I21+I22</f><v>120</v></c><c r="J20"><v>130</v></c></row>
    <row r="21"><c r="B21" t="inlineStr"><is><t>Product component one</t></is></c><c r="G21"><v>60</v></c><c r="H21"><v>66</v></c><c r="I21"><v>72</v></c></row>
    <row r="22"><c r="B22" t="inlineStr"><is><t>Product component two</t></is></c><c r="G22"><v>40</v></c><c r="H22"><v>44</v></c><c r="I22"><v>48</v></c></row>
    <row r="30"><c r="B30" t="inlineStr"><is><t>Cash from operations</t></is></c><c r="J30"><v>50</v></c></row>
    <row r="31"><c r="B31" t="inlineStr"><is><t>Capital expenditure</t></is></c><c r="J31"><v>-10</v></c></row>
    <row r="32"><c r="B32" t="inlineStr"><is><t>Acquisition cash consideration</t></is></c><c r="J32"><v>3</v></c></row>
    <row r="33"><c r="B33" t="inlineStr"><is><t>Net cash from investing</t></is></c><c r="I33"><v>-8</v></c><c r="J33"><f>SUM(J31:J32)</f><v>-7</v></c></row>
    <row r="34"><c r="B34" t="inlineStr"><is><t>Change in Debt</t></is></c><c r="J34"><f>J15</f><v>3</v></c></row>
    <row r="35"><c r="B35" t="inlineStr"><is><t>Other financing</t></is></c><c r="J35"><v>-4</v></c></row>
    <row r="36"><c r="B36" t="inlineStr"><is><t>Net cash from financing</t></is></c><c r="J36"><f>J34+J35</f><v>-1</v></c></row>
    <row r="37"><c r="B37" t="inlineStr"><is><t>Net change in cash</t></is></c><c r="J37"><f>J30+J33+J36</f><v>42</v></c></row>
    <row r="38"><c r="B38" t="inlineStr"><is><t>Cash before Financing</t></is></c><c r="I38"><v>40</v></c><c r="J38"><f>J30+J33</f><v>43</v></c></row>
    <row r="40"><c r="B40" t="inlineStr"><is><t>FX effect on cash</t></is></c><c r="J40"><v>1</v></c></row>
    <row r="50"><c r="B50" t="inlineStr"><is><t>Alpha Notes interest</t></is></c><c r="J50"><f>-AVERAGE(I10,J10)*J55</f><v>-5</v></c></row>
    <row r="51"><c r="B51" t="inlineStr"><is><t>Beta Loan interest</t></is></c><c r="J51"><f>-AVERAGE(I11,J11)*J56</f><v>-4.4</v></c></row>
    <row r="52"><c r="B52" t="inlineStr"><is><t>RCF interest</t></is></c><c r="J52"><f>-AVERAGE(I12,J12)*J57</f><v>-1.075</v></c></row>
    <row r="55"><c r="B55" t="inlineStr"><is><t>Alpha Notes rate</t></is></c><c r="J55"><v>0.05</v></c></row>
    <row r="56"><c r="B56" t="inlineStr"><is><t>Beta Loan rate</t></is></c><c r="J56"><v>0.055</v></c></row>
    <row r="57"><c r="B57" t="inlineStr"><is><t>RCF rate</t></is></c><c r="J57"><v>0.05</v></c></row>
  </sheetData>
</worksheet>
"""

MANUAL_ORACLE = {
    "schema_version": "independent-physical-binding-oracle/1.0",
    "sheet": "Operating Model",
    "label_column": "B",
    "instrument_order": ["Alpha Notes", "Beta Loan", "RCF"],
    "instrument_bindings": [
        {
            "instrument_label": "Alpha Notes",
            "debt_row": 10,
            "balance_cells": ["I10", "J10"],
            "interest_label": "Alpha Notes interest",
            "interest_row": 50,
            "interest_cell": "J50",
        },
        {
            "instrument_label": "Beta Loan",
            "debt_row": 11,
            "balance_cells": ["I11", "J11"],
            "interest_label": "Beta Loan interest",
            "interest_row": 51,
            "interest_cell": "J51",
        },
        {
            "instrument_label": "RCF",
            "debt_row": 12,
            "balance_cells": ["I12", "J12"],
            "interest_label": "RCF interest",
            "interest_row": 52,
            "interest_cell": "J52",
        },
    ],
    "reconciled_parents": [
        {"owner_row": 20, "member_rows": [21, 22], "columns": ["G", "H", "I"]}
    ],
    "protected_cash_identities": [
        {"owner_row": 33, "member_rows": [31, 32], "columns": ["J"]},
        {"owner_row": 38, "member_rows": [30, 33], "columns": ["J"]}
    ],
    "required_formula_paths": [
        {"path_id": "rcf_draw_to_financing_cash", "from_cell": "J36", "to_cell": "J13"},
        {"path_id": "rcf_repayment_to_financing_cash", "from_cell": "J36", "to_cell": "J14"},
    ],
    "forbidden_formula_paths": [
        {"path_id": "acquisition_cash_must_not_link_to_fx", "from_cell": "J32", "to_cell": "J40"},
    ],
}
FROZEN_MANUAL_OOXML_SHA256 = "750347600ec54bb3190edd6fb515046f275b20ff8ee259a7b816c132bee28ae1"
FROZEN_MANUAL_ORACLE_SHA256 = "faeefd8e55e77b83b9c9b2bedcc68826a508775a56cd408a5a6af9732f01c555"


def write_manual_workbook(target: Path) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", ROOT_RELS)
        archive.writestr("xl/workbook.xml", WORKBOOK)
        archive.writestr("xl/_rels/workbook.xml.rels", WORKBOOK_RELS)
        archive.writestr("xl/worksheets/sheet1.xml", SHEET)


def mutate_workbook(source: Path, target: Path, mutate) -> None:
    with zipfile.ZipFile(source, "r") as incoming, zipfile.ZipFile(
        target, "w", compression=zipfile.ZIP_DEFLATED
    ) as outgoing:
        for item in incoming.infolist():
            data = incoming.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                root = ET.fromstring(data)
                mutate(root)
                data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            outgoing.writestr(item, data)


def cell(root: ET.Element, address: str) -> ET.Element:
    result = root.find(".//m:c[@r='%s']" % address, MAIN_NS)
    if result is None:
        raise RuntimeError("manual OOXML lacks %s" % address)
    return result


def set_formula(root: ET.Element, address: str, formula: str) -> None:
    formula_node = cell(root, address).find("m:f", MAIN_NS)
    if formula_node is None:
        raise RuntimeError("manual OOXML lacks formula at %s" % address)
    formula_node.text = formula


def remove_formula(root: ET.Element, address: str) -> None:
    target = cell(root, address)
    formula_node = target.find("m:f", MAIN_NS)
    if formula_node is None:
        raise RuntimeError("manual OOXML lacks formula at %s" % address)
    target.remove(formula_node)


def add_formula(root: ET.Element, address: str, formula: str) -> None:
    target = cell(root, address)
    formula_node = target.find("m:f", MAIN_NS)
    if formula_node is None:
        formula_node = ET.SubElement(target, "{%s}f" % NS)
    formula_node.text = formula


def swap_rows(root: ET.Element, first_number: int, second_number: int) -> None:
    first = root.find(".//m:row[@r='%s']" % first_number, MAIN_NS)
    second = root.find(".//m:row[@r='%s']" % second_number, MAIN_NS)
    if first is None or second is None:
        raise RuntimeError("manual OOXML lacks instrument rows")
    first_children = [copy.deepcopy(item) for item in list(first)]
    second_children = [copy.deepcopy(item) for item in list(second)]
    first[:] = second_children
    second[:] = first_children
    for row, prior_number, next_number in (
        (first, second_number, first_number),
        (second, first_number, second_number),
    ):
        for item in list(row):
            address = item.get("r")
            if address and address.endswith(str(prior_number)):
                item.set("r", address[: -len(str(prior_number))] + str(next_number))


def codes(report: dict) -> set[str]:
    return {item["code"] for item in report["findings"]}


def main() -> int:
    manual_ooxml_sha256 = hashlib.sha256(SHEET.encode("utf-8")).hexdigest()
    manual_oracle_sha256 = hashlib.sha256(
        json.dumps(MANUAL_ORACLE, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if manual_ooxml_sha256 != FROZEN_MANUAL_OOXML_SHA256:
        raise AssertionError("manually authored OOXML changed outside its frozen oracle epoch")
    if manual_oracle_sha256 != FROZEN_MANUAL_ORACLE_SHA256:
        raise AssertionError("manually authored binding contract changed outside its frozen oracle epoch")
    mutations = [
        (
            "swapped-instrument-rows",
            lambda root: swap_rows(root, 10, 11),
            "INDEPENDENT_INSTRUMENT_ORDER_MISMATCH",
        ),
        (
            "prior-period-protected-cash",
            lambda root: set_formula(root, "J33", "I33"),
            "INDEPENDENT_PROTECTED_CASH_IDENTITY",
        ),
        (
            "prior-period-cash-before-financing",
            lambda root: set_formula(root, "J38", "I38"),
            "INDEPENDENT_PROTECTED_CASH_IDENTITY",
        ),
        (
            "removed-investing-child",
            lambda root: set_formula(root, "J33", "J31"),
            "INDEPENDENT_PROTECTED_CASH_IDENTITY",
        ),
        (
            "acquisition-cash-linked-to-fx",
            lambda root: add_formula(root, "J32", "J40"),
            "INDEPENDENT_FORBIDDEN_FORMULA_PATH",
        ),
        (
            "wrong-interest-edge",
            lambda root: set_formula(root, "J50", "-AVERAGE(I11,J11)*J55"),
            "INDEPENDENT_INTEREST_EDGE_MISMATCH",
        ),
        (
            "reported-parent-hardcode",
            lambda root: remove_formula(root, "H20"),
            "INDEPENDENT_RECONCILED_PARENT_HARDCODE",
        ),
        (
            "dropped-rcf-draw-link",
            lambda root: set_formula(root, "J15", "-J14"),
            "INDEPENDENT_REQUIRED_FORMULA_PATH_MISSING",
        ),
        (
            "dropped-rcf-repayment-link",
            lambda root: set_formula(root, "J15", "J13"),
            "INDEPENDENT_REQUIRED_FORMULA_PATH_MISSING",
        ),
        (
            "dropped-rcf-financing-link",
            lambda root: set_formula(root, "J36", "J35"),
            "INDEPENDENT_REQUIRED_FORMULA_PATH_MISSING",
        ),
    ]
    results = []
    with tempfile.TemporaryDirectory(prefix="independent-ooxml-oracle-") as temporary:
        root = Path(temporary)
        clean = root / "manual-oracle.xlsx"
        write_manual_workbook(clean)
        baseline = verify_manual_binding(clean, MANUAL_ORACLE)
        if baseline["status"] != "PASS" or baseline["total_violations"] != 0:
            raise AssertionError("manual OOXML baseline failed: %s" % json.dumps(baseline))
        for mutation_id, mutate, expected_code in mutations:
            target = root / (mutation_id + ".xlsx")
            mutate_workbook(clean, target, mutate)
            report = verify_manual_binding(target, MANUAL_ORACLE)
            results.append(
                {
                    "id": mutation_id,
                    "expected_code": expected_code,
                    "caught": report["status"] == "BLOCK" and expected_code in codes(report),
                }
            )

    summary = {
        "status": "PASS" if all(item["caught"] for item in results) else "BLOCK",
        "positive_checks": baseline["checks"],
        "total_violations": 0 if all(item["caught"] for item in results) else 1,
        "adversarial_mutations": len(results),
        "mutations": results,
        "artifact_origin": "frozen_manually_authored_ooxml",
        "manual_oracle_sha256": manual_oracle_sha256,
        "manual_ooxml_sha256": manual_ooxml_sha256,
        "emitted_proof_artifacts_consumed": [],
    }
    print(json.dumps(summary, sort_keys=True))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
