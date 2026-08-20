#!/usr/bin/env python3
"""Independent emitted-workbook proof for forecast-ownership Preflight C.

The compiler supplies the expected family/period writer contract in the row
map.  This oracle uses only JSON, ZIP and OOXML to bind that contract to the
solver sidecar and the physical cells that will be published.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import posixpath
import sys
import zipfile
from collections import Counter
from decimal import Decimal
from pathlib import Path
from xml.etree import ElementTree as ET

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def read_json(target: Path) -> dict:
    value = json.loads(target.read_text("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{target} must contain one JSON object")
    return value


def _ecmascript_number(value: float) -> str:
    """Serialize one finite IEEE-754 value as JSON.stringify does.

    Python and ECMAScript use the same shortest-round-trip digits but choose
    different display bands: Python switches to exponent notation below 1e-4,
    while ECMAScript keeps fixed notation down to 1e-6.  Solver convergence
    receipts contain values in that gap, so post-processing only the exponent's
    leading zero is insufficient and makes a valid Node-authored binding look
    stale to this independent Python oracle.
    """
    if not math.isfinite(value):
        return "null"
    if value == 0:
        return "0"
    magnitude = abs(value)
    text = repr(value).lower()
    if 1e-6 <= magnitude < 1e21:
        if "e" in text:
            return format(Decimal(text), "f")
        if text.endswith(".0"):
            return text[:-2]
        return text
    if "e" not in text:
        text = format(value, ".17e")
    mantissa, exponent = text.split("e", 1)
    if mantissa.endswith(".0"):
        mantissa = mantissa[:-2]
    exponent_value = int(exponent)
    exponent_text = f"+{exponent_value}" if exponent_value >= 0 else str(exponent_value)
    return f"{mantissa}e{exponent_text}"


def _ecmascript_canonical_json(value: object, level: int = 0) -> str:
    """Match canonicalise + JSON.stringify(value, null, 2) from run_store.mjs."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _ecmascript_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        if not value:
            return "[]"
        child_indent = "  " * (level + 1)
        close_indent = "  " * level
        children = [
            f"{child_indent}{_ecmascript_canonical_json(child, level + 1)}"
            for child in value
        ]
        return "[\n" + ",\n".join(children) + f"\n{close_indent}]"
    if isinstance(value, dict):
        if not value:
            return "{}"
        child_indent = "  " * (level + 1)
        close_indent = "  " * level
        # Array.prototype.sort compares UTF-16 code units.  All current keys
        # are ASCII, but retaining that ordering rule keeps the hash contract
        # correct if a future issuer-owned key contains supplementary Unicode.
        keys = sorted(
            value,
            key=lambda key: str(key).encode("utf-16-be", errors="surrogatepass"),
        )
        children = []
        for key in keys:
            encoded_key = json.dumps(str(key), ensure_ascii=False, separators=(",", ":"))
            encoded_value = _ecmascript_canonical_json(value[key], level + 1)
            children.append(f"{child_indent}{encoded_key}: {encoded_value}")
        return "{\n" + ",\n".join(children) + f"\n{close_indent}}}"
    raise TypeError(f"Unsupported canonical JSON value: {type(value).__name__}")


def canonical_sha256(value: object) -> str:
    """Match scripts/lib/run_store.mjs hashValue exactly."""
    payload = _ecmascript_canonical_json(value)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def file_sha256(target: Path) -> str:
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def model_sheet_xml(archive: zipfile.ZipFile) -> bytes:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    relationship_id = None
    for sheet in workbook.findall(f".//{{{MAIN_NS}}}sheet"):
        if sheet.attrib.get("name") in {"Operating Model", "Model"}:
            relationship_id = sheet.attrib.get(f"{{{DOC_REL_NS}}}id")
            break
    if not relationship_id:
        raise ValueError("WORKBOOK_MODEL_SHEET_MISSING")
    relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    target = None
    for relationship in relationships.findall(f"{{{PKG_REL_NS}}}Relationship"):
        if relationship.attrib.get("Id") == relationship_id:
            target = relationship.attrib.get("Target")
            break
    if not target:
        raise ValueError("WORKBOOK_MODEL_RELATIONSHIP_MISSING")
    part = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
    return archive.read(part)


def physical_cells(workbook: Path) -> tuple[Counter, dict[str, str]]:
    with zipfile.ZipFile(workbook) as archive:
        root = ET.fromstring(model_sheet_xml(archive))
    counts: Counter = Counter()
    writers: dict[str, str] = {}
    for cell in root.findall(f".//{{{MAIN_NS}}}c"):
        address = cell.attrib.get("r")
        if not address:
            continue
        counts[address] += 1
        formula = cell.find(f"{{{MAIN_NS}}}f")
        value = cell.find(f"{{{MAIN_NS}}}v")
        inline = cell.find(f"{{{MAIN_NS}}}is")
        if formula is not None:
            writers[address] = "formula"
        elif value is not None or inline is not None:
            writers[address] = "literal"
        else:
            writers.setdefault(address, "blank")
    return counts, writers


def verify(*, workbook: Path, row_map: Path, solution: Path, model_case: Path) -> dict:
    violations: list[str] = []
    rows = read_json(row_map)
    solved = read_json(solution)
    case = read_json(model_case)
    receipt = rows.get("forecast_ownership_preflight") or {}
    stored_receipt_hash = receipt.get("receipt_sha256")
    receipt_body = {key: value for key, value in receipt.items() if key != "receipt_sha256"}
    if stored_receipt_hash != canonical_sha256(receipt_body):
        violations.append("C_RECEIPT_STALE")
    if receipt.get("checkpoint") != "C_PHYSICAL" or receipt.get("status") != "PASS":
        violations.append("C_RECEIPT_NOT_PASS")
    destinations = receipt.get("destinations") or []
    if receipt.get("ownership_writer_contract_sha256") != canonical_sha256(destinations):
        violations.append("WRITER_CONTRACT_STALE")
    selected = (case.get("forecast_ownership_preflights") or {}).get("selected") or {}
    if receipt.get("selected_receipt_sha256") != selected.get("receipt_sha256"):
        violations.append("SELECTED_RECEIPT_BINDING_MISMATCH")
    census = case.get("ownership_census") or {}
    if receipt.get("census_sha256") != census.get("census_sha256"):
        violations.append("OWNERSHIP_CENSUS_BINDING_MISMATCH")
    solver_binding = receipt.get("solver_binding") or {}
    standalone = solved.get("standalone")
    pro_forma = solved.get("pro_forma")
    if solver_binding.get("standalone_solution_sha256") != canonical_sha256(standalone):
        violations.append("STANDALONE_SOLVER_BINDING_MISMATCH")
    if solver_binding.get("pro_forma_solution_sha256") != canonical_sha256(pro_forma):
        violations.append("PRO_FORMA_SOLVER_BINDING_MISMATCH")
    if len((standalone or {}).get("forecast") or []) != 3:
        violations.append("STANDALONE_SOLVER_PERIOD_MISMATCH")
    if len((pro_forma or {}).get("forecast") or []) != 3:
        violations.append("PRO_FORMA_SOLVER_PERIOD_MISMATCH")

    try:
        counts, writers = physical_cells(workbook)
    except Exception as error:
        violations.append(str(error))
        counts, writers = Counter(), {}
    checked: set[str] = set()
    columns = ("J", "K", "L")
    for destination in destinations:
        forecast_index = destination.get("forecast_index")
        if forecast_index not in (0, 1, 2):
            violations.append("DESTINATION_FORECAST_INDEX_INVALID")
            continue
        column = columns[forecast_index]
        bindings = [
            (
                destination.get("parent_row_id"),
                destination.get("parent_destination_row"),
                destination.get("parent_owner_class"),
            ),
            *[
                (child.get("row_id"), child.get("row"), child.get("owner_class"))
                for child in destination.get("child_destination_rows") or []
            ],
        ]
        for row_id, row_number, owner_class in bindings:
            if not isinstance(row_number, int) or row_number < 1:
                violations.append(f"PHYSICAL_DESTINATION_MISSING:{row_id}:fy{forecast_index + 1}")
                continue
            address = f"{column}{row_number}"
            key = f"{row_id}\0{forecast_index}"
            if key in checked:
                continue
            checked.add(key)
            if counts[address] > 1:
                violations.append(f"DUPLICATE_PHYSICAL_WRITER:{address}")
            writer = writers.get(address, "blank")
            if owner_class == "absent":
                if writer != "blank":
                    violations.append(f"CAPTURED_CELL_HAS_WRITER:{row_id}:{address}:{writer}")
            elif owner_class == "identity":
                if writer != "formula":
                    violations.append(f"IDENTITY_FORMULA_MISSING:{row_id}:{address}:{writer}")
            elif writer == "blank":
                violations.append(f"PHYSICAL_WRITER_MISSING:{row_id}:{address}")

    body = {
        "schema_version": "forecast-ownership-physical-proof/1.0",
        "checkpoint": "C_EMITTED",
        "status": "PASS" if not violations else "BLOCK",
        "workbook_sha256": file_sha256(workbook),
        "row_map_sha256": file_sha256(row_map),
        "solution_sha256": file_sha256(solution),
        "model_case_sha256": file_sha256(model_case),
        "expected_c_receipt_sha256": stored_receipt_hash,
        "checked_writer_bindings": len(checked),
        "violations": sorted(set(violations)),
    }
    return {**body, "receipt_sha256": canonical_sha256(body)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", required=True, type=Path)
    parser.add_argument("--row-map", required=True, type=Path)
    parser.add_argument("--solution", required=True, type=Path)
    parser.add_argument("--model-case", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    report = verify(
        workbook=args.xlsx,
        row_map=args.row_map,
        solution=args.solution,
        model_case=args.model_case,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({
        "status": report["status"],
        "checked_writer_bindings": report["checked_writer_bindings"],
        "violations": report["violations"],
    }, sort_keys=True))
    return 0 if report["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
