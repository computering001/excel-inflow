#!/usr/bin/env python3
"""Mutation tests for the native-restoration all-worksheet error scan."""

from __future__ import annotations

import os
import tempfile
import zipfile

from verify_native_restoration import snapshot


CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"""
ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""
WORKBOOK = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Operating Model" sheetId="1" r:id="rId1"/><sheet name="Forward Curves" sheetId="2" r:id="rId2"/></sheets>
  <calcPr calcMode="auto"/>
</workbook>"""
WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>"""
SHEET_ONE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>"""


def write_fixture(path: str, *, error_code: str | None = None) -> None:
    tail = (
        f'<c r="XFD1048576" t="e"><f>1/0</f><v>{error_code}</v></c>'
        if error_code is not None
        else '<c r="C3"><f>1+1</f><v>2</v></c>'
    )
    sheet_two = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData><row r="{1048576 if error_code is not None else 3}">{tail}</row></sheetData></worksheet>'
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for name, payload in {
            "[Content_Types].xml": CONTENT_TYPES,
            "_rels/.rels": ROOT_RELS,
            "xl/workbook.xml": WORKBOOK,
            "xl/_rels/workbook.xml.rels": WORKBOOK_RELS,
            "xl/worksheets/sheet1.xml": SHEET_ONE,
            "xl/worksheets/sheet2.xml": sheet_two,
        }.items():
            package.writestr(name, payload)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="native-excel-error-scan-") as root:
        clean_path = os.path.join(root, "clean.xlsx")
        ref_error_path = os.path.join(root, "ref-error.xlsx")
        value_error_path = os.path.join(root, "value-error.xlsx")
        write_fixture(clean_path)
        write_fixture(ref_error_path, error_code="#REF!")
        write_fixture(value_error_path, error_code="#VALUE!")
        clean = snapshot(clean_path)
        ref_corrupted = snapshot(ref_error_path)
        value_corrupted = snapshot(value_error_path)
        assert clean.sheet_names == ["Operating Model", "Forward Curves"]
        assert clean.used_cells_scanned == 2
        assert clean.excel_error_cells == {}
        assert ref_corrupted.sheet_names == ["Operating Model", "Forward Curves"]
        assert ref_corrupted.used_cells_scanned == 2
        assert ref_corrupted.excel_error_cells == {"Forward Curves!XFD1048576": "#REF!"}
        assert value_corrupted.sheet_names == ["Operating Model", "Forward Curves"]
        assert value_corrupted.used_cells_scanned == 2
        assert value_corrupted.excel_error_cells == {"Forward Curves!XFD1048576": "#VALUE!"}
    print('{"status":"PASS","checks":9,"mutations_caught":2,"scope":"all_serialized_cells_all_worksheets"}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
