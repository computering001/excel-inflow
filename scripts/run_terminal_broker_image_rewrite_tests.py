#!/usr/bin/env python3
"""Regression proof for the LibreOffice -> N12 Bxx screenshot rewrite seam."""

from __future__ import annotations

import base64
import json
import tempfile
import zipfile
from pathlib import Path

from emit.patch import PackageError, apply, audit_package, read_package


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUB"
    "AScY42YAAAAASUVORK5CYII="
)


def write_package(path: Path) -> None:
    members = {
        "[Content_Types].xml": b'''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>''',
        "_rels/.rels": b'''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>''',
        "xl/workbook.xml": b'''<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="B01 House A" sheetId="1" r:id="rId1"/></sheets>
<calcPr calcId="191029" calcMode="auto"/>
</workbook>''',
        "xl/_rels/workbook.xml.rels": b'''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>''',
        "xl/worksheets/sheet1.xml": b'''<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetData/><drawing r:id="rId1"/>
</worksheet>''',
        "xl/worksheets/_rels/sheet1.xml.rels": b'''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>''',
        "xl/drawings/drawing1.xml": b'''<?xml version="1.0" encoding="UTF-8"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>''',
        "xl/drawings/_rels/drawing1.xml.rels": b'''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>''',
        "xl/media/image1.png": PNG,
        "docProps/core.xml": b'''<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/"><dcterms:created>2026-01-01T00:00:00Z</dcterms:created><dcterms:modified>2026-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>''',
        "docProps/app.xml": b'''<?xml version="1.0" encoding="UTF-8"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>LibreOffice</Application></Properties>''',
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, payload in members.items():
            archive.writestr(name, payload)


def check(condition: bool, message: str, checks: list[str]) -> None:
    if not condition:
        raise AssertionError(message)
    checks.append(message)


def main() -> int:
    checks: list[str] = []
    with tempfile.TemporaryDirectory(prefix="terminal-broker-image-test-") as directory:
        root = Path(directory)
        workbook = root / "model.xlsx"
        image = root / "page.png"
        write_package(workbook)
        image.write_bytes(PNG)
        import hashlib

        plan = {
            "generator": {"generated_at": "2026-01-01T00:00:00.000Z"},
            "workbook": {
                "comment_author": "Test",
                "calc_properties": {
                    "calc_id": "191029",
                    "calc_mode": "auto",
                    "full_calc_on_load": True,
                    "force_full_calc": True,
                },
                "sheets": [
                    {
                        "name": "B01 House A",
                        "cells": [],
                        "comments": [],
                        "images": [
                            {
                                "path": str(image),
                                "sha256": hashlib.sha256(PNG).hexdigest(),
                                "anchor": "A1",
                                "width_pixels": 1,
                                "height_pixels": 1,
                                "page_number": 1,
                            }
                        ],
                    }
                ],
            },
        }

        report = apply(plan, workbook, asset_root=root)
        members = read_package(workbook)
        check(report["sheets"]["B01 House A"]["replaced_drawings"] == 1,
              "the prior LibreOffice drawing was discovered", checks)
        check(report["sheets"]["B01 House A"]["replaced_media"] == 1,
              "the prior LibreOffice media part was removed", checks)
        check("xl/media/image1.png" not in members,
              "the renamed LibreOffice image is not left orphaned", checks)
        check("xl/media/brokerPage1.png" in members,
              "the canonical broker screenshot was installed", checks)
        check(b"../media/brokerPage1.png" in members["xl/drawings/_rels/drawing1.xml.rels"],
              "the canonical drawing points at the canonical screenshot", checks)
        check(report["package_audit"]["relationships"] > 0,
              "the terminal in-memory package audit visited relationships", checks)
        check(audit_package(members)["parts"] > 0,
              "the written package independently passes the strict audit", checks)

        mutated = dict(members)
        mutated["xl/drawings/_rels/drawing1.xml.rels"] = mutated[
            "xl/drawings/_rels/drawing1.xml.rels"
        ].replace(b"../media/brokerPage1.png", b"../media/missing.png")
        try:
            audit_package(mutated)
        except PackageError:
            checks.append("a dangling screenshot relationship is rejected")
        else:
            raise AssertionError("package audit mutation survived")

    print(json.dumps({"status": "PASS", "checks": len(checks), "proof": checks}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
