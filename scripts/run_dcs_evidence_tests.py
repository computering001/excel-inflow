#!/usr/bin/env python3
"""Standalone positive, losslessness and compound-mutation DCS tests.

The fixtures are generated at runtime. No issuer export or workbook is stored
in the universal skill. The suite proves the lossless source-cell ledger,
field-level authorities and independent oracle before the slim model
projection is allowed downstream.
"""

from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
EXTRACT = ROOT / "scripts" / "extract_dcs_evidence.py"
COMPILE = ROOT / "scripts" / "compile_dcs_evidence.py"
ORACLE = ROOT / "scripts" / "verify" / "dcs_evidence_oracle.py"


def canon(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def hash_obj(value: Any) -> str:
    return hashlib.sha256(canon(value)).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.write_bytes(canon(value))


def run(command: list[str], expected: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, capture_output=True)
    if result.returncode != expected:
        raise AssertionError("command returned %d, expected %d\n%s\n%s" % (result.returncode, expected, result.stdout, result.stderr))
    return result


def build_csv(path: Path) -> None:
    rows = [
        ["Instrument", "Type", "Currency", "Outstanding", "Maturity", "Rate Type", "Coupon", "Reference Rate", "Margin Bps", "All In Rate", "Facility Limit", "Drawn", "Committed", "Native Principal", "FX Rate", "Balance Basis", "Fee Convention", "Fee Value", "Interest Settlement", "Debt Classification", "Amortisation Schedule", "Refinancing Intent", "Next Call Date", "Backstop For Paper", "Issue Date", "Price", "YTW", "OAS"],
        ["Commercial Paper", "commercial_paper", "USD", 0, "2027-06-30", "", "", "", "", "", "", "", "", "", "", "reporting_currency_carrying_value", "", "", "cash", json.dumps({"include_in_gross_debt": True, "include_in_net_debt": True}), "[]", "repaid", "", "", "2026-01-02", 100, 0.04, 55],
        ["Committed RCF", "rcf", "USD", 0, "2029-12-31", "floating", "", "SOFR 3M", 100, "", 1000, 0, "true", "", "", "reporting_currency_carrying_value", "bps_on_undrawn", 25, "cash", json.dumps({"include_in_gross_debt": True, "include_in_net_debt": True}), "[]", "refinanced", "", "true", "2024-05-01", 100, 0.03, 75],
        ["EUR Senior Notes", "fixed_bond", "EUR", "", "2030-09", "fixed", 0.05, "", "", "", "", "", "", 400, 1.25, "native_principal", "", "", "cash", json.dumps({"include_in_gross_debt": True, "include_in_net_debt": True}), json.dumps([{"date": "2028-12-31", "amount": 50}]), "repaid", "2029-09-15", "", "2025-09-15", 98.5, 0.052, 120],
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerows(rows)


def build_xlsx(path: Path) -> None:
    content = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Instrument</t></is></c><c r="B1" t="inlineStr"><is><t>Outstanding</t></is></c><c r="C1" t="inlineStr"><is><t>Maturity</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Zero RCF</t></is></c><c r="B2"><v>0</v></c><c r="C2" s="1"><v>1</v></c></row>
</sheetData></worksheet>"""
    workbook = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Debt" sheetId="1" r:id="rId1"/></sheets></workbook>"""
    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"""
    types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"""
    styles = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", types)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", rels)
        archive.writestr("xl/worksheets/sheet1.xml", content)
        archive.writestr("xl/styles.xml", styles)


def authority(field: str, cell: str | None, value: Any, *, kind: str = "direct", precision: str = "exact", transform: dict[str, Any] | None = None, supplement_id: str | None = None, basis: dict[str, Any] | None = None) -> dict[str, Any]:
    item = {"model_field": field, "output_value": value, "source_cells": [] if cell is None else [cell], "transform": transform or {"kind": kind}, "authority_kind": "supplement" if supplement_id else "derived_source_cells" if kind != "direct" else "source_cell", "precision": precision}
    if supplement_id:
        item["supplement_id"] = supplement_id
    if basis:
        item["basis"] = basis
    return item


def build_crosswalk(source: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    instrument_rows = {2: "cp", 3: "rcf", 4: "bond"}
    row_dispositions, cell_dispositions = [], []
    cells = {cell["cell_id"]: cell for sheet in source["sheets"] for row in sheet["rows"] for cell in row["cells"]}
    for row in manifest["rows"]:
        owner = instrument_rows.get(row["row"])
        row_dispositions.append({"row_id": row["row_id"], "disposition": "model_input" if owner else "not_applicable", "rationale": "Instrument evidence" if owner else "Header row", "owner_id": owner})
        for cell_id in row["cell_ids"]:
            column = cells[cell_id]["column"]
            disposition = "supplemental_evidence" if owner and column >= 25 else "model_input" if owner else "not_applicable"
            cell_dispositions.append({"cell_id": cell_id, "disposition": disposition, "rationale": "Audit-only debt evidence" if disposition == "supplemental_evidence" else "Instrument model evidence" if owner else "Header label", "owner_id": owner})

    def common(row: int) -> list[dict[str, Any]]:
        return [
            authority("description", f"s001!A{row}", {2: "Commercial Paper", 3: "Committed RCF", 4: "EUR Senior Notes"}[row]),
            authority("instrument_type", f"s001!B{row}", {2: "commercial_paper", 3: "rcf", 4: "fixed_bond"}[row]),
            authority("currency", f"s001!C{row}", {2: "USD", 3: "USD", 4: "EUR"}[row]),
            authority("maturity", f"s001!E{row}", {2: "2027-06-30", 3: "2029-12-31", 4: "2030-09"}[row], precision="month" if row == 4 else "exact"),
            authority("rate_type", f"s001!F{row}", {2: "manual_all_in", 3: "floating", 4: "fixed"}[row]),
            authority("balance_basis", f"s001!P{row}", {2: "reporting_currency_carrying_value", 3: "reporting_currency_carrying_value", 4: "native_principal"}[row]),
            authority("interest_settlement", f"s001!S{row}", "cash"),
            authority("debt_classification", f"s001!T{row}", {"include_in_gross_debt": True, "include_in_net_debt": True}, kind="json"),
            authority("amortisation_schedule", f"s001!U{row}", [] if row != 4 else [{"date": "2028-12-31", "amount": 50}], kind="json"),
            authority("refinancing_intent", f"s001!V{row}", "refinanced" if row == 3 else "repaid"),
        ]

    cp = [item for item in common(2) if item["model_field"] != "rate_type"] + [authority("outstanding_amount", "s001!D2", 0)]
    rcf = common(3) + [
        authority("outstanding_amount", "s001!D3", 0), authority("reference_rate", "s001!H3", "SOFR 3M"), authority("margin_bps", "s001!I3", 100),
        authority("facility_limit", "s001!K3", 1000), authority("drawn_amount", "s001!L3", 0), authority("committed", "s001!M3", True, kind="boolean"),
        authority("commitment_fee_convention", "s001!Q3", "bps_on_undrawn"), authority("commitment_fee_value", "s001!R3", 25), authority("is_backstop_for_paper", "s001!X3", True, kind="boolean"),
        authority("benchmark_curve", None, {"resolved": [0.04, 0.035, 0.03]}, supplement_id="rcf-curve"),
    ]
    bond = common(4) + [
        authority("native_principal", "s001!N4", 400, basis={"currency": "EUR", "units": "millions"}),
        authority("fx_rate", "s001!O4", 1.25, basis={"quote": "reporting_per_native", "as_of": "2025-12-31"}),
        authority("outstanding_amount", "s001!N4", 500, kind="fx_translate", transform={"kind": "fx_translate", "fx_rate_cell": "s001!O4", "quote": "reporting_per_native"}, basis={"balance_basis": "native_principal", "output_currency": "USD"}),
        authority("coupon_rate", "s001!G4", 0.05), authority("next_call_date", "s001!W4", "2029-09-15"),
    ]
    supplemental = []
    for row, instrument_id in instrument_rows.items():
        supplemental.append({"candidate_id": f"supplemental-{instrument_id}", "instrument_id": instrument_id, "disposition": "supplemental_evidence", "rationale": "Preserve audit-only issue date, price, YTW and OAS outside the model projection", "row_ids": [f"s001!row:{row}"], "term_authorities": [
            authority("issue_date", f"s001!Y{row}", {2: "2026-01-02", 3: "2024-05-01", 4: "2025-09-15"}[row]), authority("price", f"s001!Z{row}", {2: 100, 3: 100, 4: 98.5}[row]),
            authority("yield_to_worst", f"s001!AA{row}", {2: 0.04, 3: 0.03, 4: 0.052}[row]), authority("oas", f"s001!AB{row}", {2: 55, 3: 75, 4: 120}[row]),
        ]})
    return {"schema_version": "dcs-crosswalk/1.0", "source_tables_sha256": hash_obj(source), "candidate_manifest_sha256": hash_obj(manifest), "export_metadata": {"as_of": "2025-12-31", "source": {"system": "Controlled DCS fixture", "date_basis": "last_fiscal_year_end"}, "entity": {"name": "Controlled Issuer"}, "reporting_currency": "USD", "units": "millions", "columns": [{"field": "outstanding_amount", "currency": "USD", "units": "millions"}, {"field": "facility_limit", "currency": "USD", "units": "millions"}, {"field": "drawn_amount", "currency": "USD", "units": "millions"}]}, "row_dispositions": row_dispositions, "cell_dispositions": cell_dispositions, "instruments": [
        {"candidate_id": "cp-row", "instrument_id": "cp", "disposition": "model_input", "rationale": "Zero drawn commercial paper remains a valid instrument", "row_ids": ["s001!row:2"], "pricing_treatment": "residual_interest_plug", "pricing_treatment_reason": "Source contains no programme pricing; preserve exposure and use the visible residual-interest bridge.", "term_authorities": cp},
        {"candidate_id": "rcf-row", "instrument_id": "rcf", "disposition": "model_input", "rationale": "Zero drawn RCF remains model relevant for capacity", "row_ids": ["s001!row:3"], "term_authorities": rcf},
        {"candidate_id": "bond-row", "instrument_id": "bond", "disposition": "derived_model_input", "rationale": "Native principal translated through sourced FX", "row_ids": ["s001!row:4"], "term_authorities": bond},
        *supplemental,
    ], "supplements": [{"supplement_id": "rcf-curve", "instrument_id": "rcf", "model_field": "benchmark_curve", "value": {"resolved": [0.04, 0.035, 0.03]}, "source_kind": "user_answer", "source_reference": "Controlled fixture answer"}]}


def compile_case(root: Path, source: dict[str, Any], manifest: dict[str, Any], crosswalk: dict[str, Any], name: str, expected: int) -> tuple[Path, dict[str, Any]]:
    folder = root / name
    folder.mkdir(parents=True)
    for filename, value in [("source.json", source), ("manifest.json", manifest), ("crosswalk.json", crosswalk)]:
        write_json(folder / filename, value)
    run([sys.executable, str(COMPILE), str(folder / "source.json"), str(folder / "manifest.json"), str(folder / "crosswalk.json"), "--out", str(folder / "compiled")], expected)
    return folder, json.loads((folder / "compiled" / "dcs-evidence-receipt.json").read_text())


def codes(receipt: dict[str, Any]) -> set[str]:
    return {item["code"] for item in receipt.get("violations", [])}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    root = Path(args.out).resolve()
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    csv_path = root / "controlled.csv"
    build_csv(csv_path)
    request = root / "request.json"
    write_json(request, {"schema_version": "dcs-extraction-request/1.0", "source_path": str(csv_path)})
    extract = root / "extract"
    run([sys.executable, str(EXTRACT), str(request), "--out", str(extract)])
    source = json.loads((extract / "dcs-source-tables.json").read_text())
    manifest = json.loads((extract / "dcs-candidate-manifest.json").read_text())
    crosswalk = build_crosswalk(source, manifest)
    base, receipt = compile_case(root, source, manifest, crosswalk, "baseline", 0)
    assert receipt["status"] == "PASS" and receipt["counts"]["unowned_cells"] == 0 and receipt["counts"]["double_owned_cells"] == 0
    projection = json.loads((base / "compiled" / "dcs-projection.json").read_text())
    exported = {item["instrument_id"]: item for item in projection["dcs_export"]["instruments"]}
    assert exported["cp"]["outstanding_amount"] == 0 and exported["rcf"]["outstanding_amount"] == 0 and exported["bond"]["outstanding_amount"] == 500
    assert exported["cp"]["rate_type"] == "unpriced" and exported["cp"]["pricing_treatment"] == "residual_interest_plug"
    assert exported["bond"]["maturity_date"] == "2030-09-30" and exported["bond"]["maturity_precision"] == "month"
    assert len(projection["supplemental_fields"]) == 3
    oracle = base / "oracle.json"
    run([sys.executable, str(ORACLE), "--source", str(base / "source.json"), "--manifest", str(base / "manifest.json"), "--crosswalk", str(base / "crosswalk.json"), "--projection", str(base / "compiled" / "dcs-projection.json"), "--receipt", str(base / "compiled" / "dcs-evidence-receipt.json"), "--out", str(oracle)])
    assert json.loads(oracle.read_text())["status"] == "PASS"

    mutations: dict[str, set[str]] = {}
    changed = copy.deepcopy(crosswalk); changed["unexpected_field"] = True
    _, bad = compile_case(root, source, manifest, changed, "schema-extra", 2); assert "DCS-SCHEMA-CONTRACT" in codes(bad); mutations["schema-extra"] = codes(bad)
    changed = copy.deepcopy(crosswalk); changed["instruments"] = [item for item in changed["instruments"] if item.get("instrument_id") != "cp"]
    _, bad = compile_case(root, source, manifest, changed, "drop-zero-cp", 2); assert "DCS-ORPHAN-MODEL-EVIDENCE" in codes(bad); mutations["drop-zero-cp"] = codes(bad)
    changed = copy.deepcopy(crosswalk); changed["instruments"] = [item for item in changed["instruments"] if item.get("instrument_id") != "rcf"]
    _, bad = compile_case(root, source, manifest, changed, "drop-zero-rcf", 2); assert "DCS-ORPHAN-MODEL-EVIDENCE" in codes(bad); mutations["drop-zero-rcf"] = codes(bad)
    changed = copy.deepcopy(crosswalk)
    coupon = next(item for item in next(row for row in changed["instruments"] if row.get("candidate_id") == "bond-row")["term_authorities"] if item["model_field"] == "coupon_rate")
    coupon["source_cells"] = ["s001!Z4"]
    _, bad = compile_case(root, source, manifest, changed, "wrong-cell", 2); assert "DCS-AUTHORITY-VALUE" in codes(bad); mutations["wrong-cell"] = codes(bad)

    tampered_root = root / "oracle-tamper"
    shutil.copytree(base, tampered_root)
    projection_path, receipt_path = tampered_root / "compiled" / "dcs-projection.json", tampered_root / "compiled" / "dcs-evidence-receipt.json"
    tampered = json.loads(projection_path.read_text())
    by_id = {item["instrument_id"]: item for item in tampered["dcs_export"]["instruments"]}
    by_id["bond"]["coupon_rate"] = 0.08; by_id["bond"]["maturity_date"] = "2031-12-31"; by_id["rcf"]["facility_limit"] = 1200
    write_json(projection_path, tampered)
    tampered_receipt = json.loads(receipt_path.read_text()); tampered_receipt["projection_sha256"] = hash_obj(tampered); write_json(receipt_path, tampered_receipt)
    report_path = tampered_root / "oracle-mutated.json"
    run([sys.executable, str(ORACLE), "--source", str(tampered_root / "source.json"), "--manifest", str(tampered_root / "manifest.json"), "--crosswalk", str(tampered_root / "crosswalk.json"), "--projection", str(projection_path), "--receipt", str(receipt_path), "--out", str(report_path)], 2)
    oracle_codes = {item["code"] for item in json.loads(report_path.read_text())["violations"]}; assert "DCS-ORACLE-PROJECTION-VALUE" in oracle_codes; mutations["economic-tamper"] = oracle_codes

    xlsx = root / "controlled.xlsx"; build_xlsx(xlsx); xlsx_request = root / "xlsx-request.json"; write_json(xlsx_request, {"schema_version": "dcs-extraction-request/1.0", "source_path": str(xlsx)})
    run([sys.executable, str(EXTRACT), str(xlsx_request), "--out", str(root / "xlsx-extract")])
    xlsx_source = json.loads((root / "xlsx-extract" / "dcs-source-tables.json").read_text())
    date_cell = next(cell for sheet in xlsx_source["sheets"] for row in sheet["rows"] for cell in row["cells"] if cell["cell_id"] == "s001!C2")
    assert date_cell["raw_value"] == "1" and date_cell["display_value"] == "1900-01-01" and date_cell["value_type"] == "date"
    assert any(cell["display_value"] == 0 for sheet in xlsx_source["sheets"] for row in sheet["rows"] for cell in row["cells"])

    summary = {"schema_version": "dcs-evidence-tests/1.0", "status": "PASS", "positive_checks": 11, "adversarial_mutations_caught": len(mutations), "mutations": {key: sorted(value) for key, value in mutations.items()}}
    write_json(root / "dcs-evidence-tests.json", summary)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
