#!/usr/bin/env python3
"""Create a lossless, hash-bound cell census for a DCS CSV/XLSX/JSON file.

The output is deliberately upstream of any instrument classification.  It owns
the source universe; later reviewers may disposition cells and rows but may not
create or remove them.

The census never blocks on export-quality questions it only observes.  A JSON
source claiming dcs-export identity that drifts from the contract, or whose
``as_of`` effective date misses the case period end (``--case-period-end``) by
more than one fiscal year, is recorded as typed DEGRADE telemetry in
``dcs-degrades.json`` — never as a receipt violation, which would block the
lane on evidence the census itself can still read losslessly.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

# The drift validator is shared, not duplicated: one implementation of the
# dcs-export contract serves both lanes so they cannot silently diverge.
from compile_dcs_evidence import schema_errors


VERSION = "dcs-lossless-extractor/1.1"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def col_name(index: int) -> str:
    out = ""
    while index:
        index, rem = divmod(index - 1, 26)
        out = chr(65 + rem) + out
    return out


def split_ref(address: str) -> tuple[int, int]:
    match = re.fullmatch(r"([A-Z]+)([0-9]+)", address.upper())
    if not match:
        raise ValueError("invalid cell address: %s" % address)
    column = 0
    for char in match.group(1):
        column = column * 26 + ord(char) - 64
    return int(match.group(2)), column


def scalar(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def make_cell(sheet_id: str, row: int, column: int, raw: Any, display: Any,
              value_type: str, formula: str | None = None, *,
              style_index: int | None = None, number_format: str | None = None,
              date_system: str | None = None) -> dict[str, Any]:
    address = "%s%d" % (col_name(column), row)
    cell = {
        "cell_id": "%s!%s" % (sheet_id, address),
        "address": address,
        "row": row,
        "column": column,
        "raw_value": scalar(raw),
        "display_value": scalar(display),
        "value_type": value_type,
        "formula": formula,
        **({"style_index": style_index} if style_index is not None else {}),
        **({"number_format": number_format} if number_format is not None else {}),
        **({"date_system": date_system} if date_system is not None else {}),
    }
    cell["cell_sha256"] = digest(canonical(cell))
    return cell


def sheet_record(sheet_id: str, name: str, index: int, row_map: dict[int, list[dict[str, Any]]]) -> dict[str, Any]:
    max_row = max(row_map, default=0)
    max_col = max((cell["column"] for cells in row_map.values() for cell in cells), default=0)
    rows = []
    for row_index in range(1, max_row + 1):
        cells = sorted(row_map.get(row_index, []), key=lambda item: item["column"])
        row_record = {
            "row_id": "%s!row:%d" % (sheet_id, row_index),
            "row": row_index,
            "cells": cells,
        }
        row_record["row_sha256"] = digest(canonical(row_record))
        rows.append(row_record)
    sheet = {
        "sheet_id": sheet_id,
        "name": name,
        "index": index,
        "max_row": max_row,
        "max_column": max_col,
        "rows": rows,
    }
    sheet["sheet_sha256"] = digest(canonical(sheet))
    return sheet


def csv_sheets(path: Path) -> list[dict[str, Any]]:
    raw = path.read_bytes()
    text = raw.decode("utf-8-sig")
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=",\t;|") if text.strip() else csv.excel
    except csv.Error:
        dialect = csv.excel
    row_map: dict[int, list[dict[str, Any]]] = {}
    for row_index, row in enumerate(csv.reader(text.splitlines(), dialect), 1):
        row_map[row_index] = [
            make_cell("s001", row_index, column, value, value, "text")
            for column, value in enumerate(row, 1) if value != ""
        ]
    return [sheet_record("s001", path.stem or "CSV", 1, row_map)]


def json_sheets(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    leaves: list[tuple[str, Any]] = []

    def walk(value: Any, pointer: str) -> None:
        if isinstance(value, dict):
            if not value:
                leaves.append((pointer or "/", {}))
            for key in sorted(value):
                token = str(key).replace("~", "~0").replace("/", "~1")
                walk(value[key], "%s/%s" % (pointer, token))
        elif isinstance(value, list):
            if not value:
                leaves.append((pointer or "/", []))
            for index, item in enumerate(value):
                walk(item, "%s/%d" % (pointer, index))
        else:
            leaves.append((pointer or "/", value))

    walk(payload, "")
    row_map: dict[int, list[dict[str, Any]]] = {
        1: [make_cell("s001", 1, 1, "json_pointer", "json_pointer", "text"),
            make_cell("s001", 1, 2, "value", "value", "text")]
    }
    for index, (pointer, value) in enumerate(leaves, 2):
        kind = "boolean" if isinstance(value, bool) else "number" if isinstance(value, (int, float)) else "null" if value is None else "text"
        row_map[index] = [
            make_cell("s001", index, 1, pointer, pointer, "text"),
            make_cell("s001", index, 2, value, value, kind),
        ]
    return [sheet_record("s001", "JSON", 1, row_map)]


def xlsx_sheets(path: Path) -> list[dict[str, Any]]:
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall(NS + "si"):
                shared.append("".join(node.text or "" for node in item.iter(NS + "t")))

        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        workbook_properties = workbook.find(NS + "workbookPr")
        date_system = (
            "1904"
            if workbook_properties is not None
            and workbook_properties.attrib.get("date1904", "0").lower()
            in {"1", "true"}
            else "1900"
        )
        builtin_date_formats = {
            14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy",
            18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
            22: "m/d/yy h:mm", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0",
        }
        style_formats: list[str | None] = []
        if "xl/styles.xml" in names:
            styles = ET.fromstring(archive.read("xl/styles.xml"))
            formats = dict(builtin_date_formats)
            num_formats = styles.find(NS + "numFmts")
            if num_formats is not None:
                for item in num_formats.findall(NS + "numFmt"):
                    formats[int(item.attrib["numFmtId"])] = item.attrib.get("formatCode", "")
            cell_xfs = styles.find(NS + "cellXfs")
            if cell_xfs is not None:
                style_formats = [
                    formats.get(int(item.attrib.get("numFmtId", "0")))
                    for item in cell_xfs.findall(NS + "xf")
                ]

        def is_date_format(code: str | None) -> bool:
            if not code:
                return False
            cleaned = re.sub(r'"[^"]*"|\\.|\[[^\]]*\]', "", code).lower()
            return bool(re.search(r"(?:^|[^a-z])[ymdhis]+(?:[^a-z]|$)", cleaned))

        def serial_date(value: float) -> str:
            whole = int(value)
            if date_system == "1904":
                result = dt.date(1904, 1, 1) + dt.timedelta(days=whole)
            else:
                # Excel's 1900 system contains the fictitious 29-Feb-1900 at
                # serial 60. Preserve Excel's visible dates on either side.
                base = dt.date(1899, 12, 31) if whole < 60 else dt.date(1899, 12, 30)
                result = base + dt.timedelta(days=whole)
            return result.isoformat()
        rel_root = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rel_root.findall(PKG_REL_NS + "Relationship")}
        output = []
        for index, sheet in enumerate(workbook.find(NS + "sheets") or [], 1):
            relation = sheet.attrib.get(REL_NS + "id")
            target = targets.get(relation, "worksheets/sheet%d.xml" % index)
            member = target.lstrip("/") if target.startswith("/xl/") else posixpath.normpath(posixpath.join("xl", target))
            root = ET.fromstring(archive.read(member))
            sheet_id = "s%03d" % index
            row_map: dict[int, list[dict[str, Any]]] = {}
            data = root.find(NS + "sheetData")
            for row in [] if data is None else data.findall(NS + "row"):
                row_index = int(row.attrib.get("r", "0"))
                row_map.setdefault(row_index, [])
                for cell in row.findall(NS + "c"):
                    address = cell.attrib.get("r")
                    if not address:
                        continue
                    actual_row, column = split_ref(address)
                    typ = cell.attrib.get("t", "n")
                    style_index = int(cell.attrib.get("s", "0"))
                    number_format = (
                        style_formats[style_index]
                        if style_index < len(style_formats)
                        else None
                    )
                    formula_node = cell.find(NS + "f")
                    formula = None if formula_node is None else (formula_node.text or "")
                    value_node = cell.find(NS + "v")
                    inline = cell.find(NS + "is")
                    raw_value = None if value_node is None else value_node.text
                    if typ == "inlineStr" and inline is not None:
                        display = "".join(node.text or "" for node in inline.iter(NS + "t"))
                        raw_value = display
                    elif typ == "s" and raw_value not in (None, ""):
                        display = shared[int(raw_value)]
                    elif typ == "b":
                        display = raw_value == "1"
                    elif typ in {"str", "e"}:
                        display = raw_value
                    elif raw_value not in (None, ""):
                        try:
                            number = float(raw_value)
                            display = (
                                serial_date(number)
                                if is_date_format(number_format)
                                else int(number) if number.is_integer() else number
                            )
                        except ValueError:
                            display = raw_value
                    else:
                        display = None
                    if formula is None and raw_value is None and display is None:
                        continue
                    value_type = "formula" if formula is not None else "date" if is_date_format(number_format) and raw_value not in (None, "") else "number" if isinstance(display, (int, float)) and not isinstance(display, bool) else "boolean" if isinstance(display, bool) else "error" if typ == "e" else "text"
                    row_map.setdefault(actual_row, []).append(
                        make_cell(
                            sheet_id,
                            actual_row,
                            column,
                            raw_value,
                            display,
                            value_type,
                            formula,
                            style_index=style_index,
                            number_format=number_format,
                            date_system=date_system if is_date_format(number_format) else None,
                        )
                    )
            output.append(sheet_record(sheet_id, sheet.attrib.get("name", "Sheet%d" % index), index, row_map))
        return output


def degrade(code: str, message: str, **context: Any) -> dict[str, Any]:
    """A typed, non-blocking DEGRADE entry for the DCS lane sidecar."""
    return {"code": code, "kind": "DEGRADE", "message": message, **context}


def export_drift_degrades(payload: Any) -> list[dict[str, Any]]:
    """Typed schema-drift findings naming every drifted field.

    Only payloads that CLAIM dcs-export identity (a ``dcs-export*`` schema
    version or an ``export_kind`` marker) are validated; an unrelated JSON
    document is nobody's debt export and is not held to its contract.  Drift
    degrades the lane — the lossless census itself stays intact and PASS.
    """
    if not isinstance(payload, dict):
        return []
    schema_version = payload.get("schema_version")
    claims_export_identity = (
        isinstance(schema_version, str) and schema_version.startswith("dcs-export")
    ) or "export_kind" in payload
    if not claims_export_identity:
        return []
    errors = schema_errors(payload, "dcs-export.schema.json")
    if not errors:
        return []
    return [
        degrade(
            "dcs_export_drift",
            "The incoming debt export claims dcs-export identity but drifts from dcs-export.schema.json; every drifted field is named.",
            drifted_fields=errors,
            drifted_field_count=len(errors),
        )
    ]


def stale_export_degrade(export_date_text: Any, case_period_end_text: Any) -> dict[str, Any] | None:
    """DEGRADE when the export's effective date misses the case period end by more than one fiscal year."""
    if not export_date_text or not case_period_end_text:
        return None
    try:
        export_date = dt.date.fromisoformat(str(export_date_text))
        period_end = dt.date.fromisoformat(str(case_period_end_text))
    except ValueError:
        print(
            "warning: could not parse export date %r or case period end %r as ISO dates; staleness was not evaluated"
            % (export_date_text, case_period_end_text),
            file=sys.stderr,
        )
        return None
    gap_days = (period_end - export_date).days
    if abs(gap_days) <= 366:
        return None
    direction = "older than" if gap_days > 0 else "newer than"
    return degrade(
        "dcs_export_stale",
        "The export's effective date %s is %d days %s the case period end %s — more than one fiscal year apart."
        % (export_date.isoformat(), abs(gap_days), direction, period_end.isoformat()),
        export_date=export_date.isoformat(),
        case_period_end=period_end.isoformat(),
        gap_days=gap_days,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("request")
    parser.add_argument(
        "--case-period-end",
        help=(
            "Optional ISO date of the case period end. When the gap to the "
            "export's effective date exceeds one fiscal year, a typed "
            "dcs_export_stale DEGRADE is emitted."
        ),
    )
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    request_path = Path(args.request).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if request.get("schema_version") != "dcs-extraction-request/1.0":
        raise SystemExit("request schema_version must be dcs-extraction-request/1.0")
    source_path = Path(request["source_path"])
    if not source_path.is_absolute():
        source_path = (request_path.parent / source_path).resolve()
    degrades: list[dict[str, Any]] = []
    suffix = source_path.suffix.lower()
    if suffix == ".csv":
        media_type, sheets = "text/csv", csv_sheets(source_path)
    elif suffix in {".xlsx", ".xlsm"}:
        media_type, sheets = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsx_sheets(source_path)
    elif suffix == ".json":
        media_type, sheets = "application/json", json_sheets(source_path)
        # json_sheets already parsed this file successfully, so this re-read
        # cannot fail; the payload is inspected only for export-quality
        # telemetry and is never allowed to alter the census.
        payload = json.loads(source_path.read_text(encoding="utf-8"))
        degrades.extend(export_drift_degrades(payload))
        if isinstance(payload, dict):
            stale = stale_export_degrade(payload.get("as_of"), args.case_period_end)
            if stale:
                degrades.append(stale)
    else:
        raise SystemExit("supported DCS source types are CSV, XLSX/XLSM and JSON")

    source = {
        "filename": source_path.name,
        "media_type": media_type,
        "sha256": file_digest(source_path),
        "byte_size": source_path.stat().st_size,
    }
    cell_ids = [cell["cell_id"] for sheet in sheets for row in sheet["rows"] for cell in row["cells"]]
    row_ids = [row["row_id"] for sheet in sheets for row in sheet["rows"]]
    tables = {
        "schema_version": "dcs-source-tables/1.0",
        "extractor_version": VERSION,
        "source": source,
        "sheets": sheets,
        "counts": {"sheets": len(sheets), "rows": len(row_ids), "nonblank_cells": len(cell_ids)},
    }
    manifest = {
        "schema_version": "dcs-candidate-manifest/1.0",
        "source_sha256": source["sha256"],
        "source_tables_sha256": digest(canonical(tables)),
        "rows": [{"row_id": row["row_id"], "sheet_id": sheet["sheet_id"], "row": row["row"], "row_sha256": row["row_sha256"], "cell_ids": [cell["cell_id"] for cell in row["cells"]]}
                 for sheet in sheets for row in sheet["rows"]],
        "cells": [{"cell_id": cell["cell_id"], "row_id": row["row_id"], "address": cell["address"], "value_type": cell["value_type"], "cell_sha256": cell["cell_sha256"]}
                  for sheet in sheets for row in sheet["rows"] for cell in row["cells"]],
        "counts": {"rows": len(row_ids), "nonblank_cells": len(cell_ids)},
    }
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "dcs-source-tables.json").write_bytes(canonical(tables))
    (out / "dcs-candidate-manifest.json").write_bytes(canonical(manifest))
    receipt = {
        "schema_version": "dcs-extraction-receipt/1.0",
        "status": "PASS" if sheets and cell_ids else "BLOCKED",
        "source_sha256": source["sha256"],
        "source_tables_sha256": digest(canonical(tables)),
        "candidate_manifest_sha256": digest(canonical(manifest)),
        "counts": tables["counts"],
        "violations": [] if sheets and cell_ids else [{"code": "DCS-EXTRACT-EMPTY", "message": "The source produced no nonblank cells."}],
    }
    (out / "dcs-extraction-receipt.json").write_bytes(canonical(receipt))
    printed: Any = receipt
    if degrades:
        # Degrades are lane telemetry, not contract violations: persisted in
        # the sidecar (mirroring the compiler), echoed on stdout, never folded
        # into the receipt — a DEGRADE code in receipt violations would flip
        # the pipeline's classify_extract_receipt toward BLOCKED_INTERNAL.
        (out / "dcs-degrades.json").write_bytes(canonical({
            "schema_version": "dcs-lane-degrades/1.0",
            "stage": "extract_dcs_evidence",
            "degrades": degrades,
        }))
        printed = {**receipt, "degrades": degrades}
    print(json.dumps(printed, indent=2))
    return 0 if receipt["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
