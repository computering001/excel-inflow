#!/usr/bin/env python3
"""Portable Off/On/Off/On acquisition workbook and cache-parity regression."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from openpyxl import load_workbook


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def run(command: list[str], *, env: dict[str, str] | None = None) -> None:
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=600,
        check=False,
        env=env,
    )
    if completed.returncode != 0:
        raise AssertionError(
            f"Command failed ({completed.returncode}): {' '.join(command)}\n"
            f"{completed.stdout[-8000:]}\n{completed.stderr[-8000:]}"
        )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(case_payload: dict, target: Path) -> tuple[Path, dict, dict]:
    target.parent.mkdir(parents=True, exist_ok=True)
    case_path = target.parent / "case.json"
    case_path.write_text(json.dumps(case_payload, indent=2) + "\n", encoding="utf-8")
    run(
        [
            "node",
            str(HERE / "build_dynamic_model.mjs"),
            str(case_path),
            "--out",
            str(target),
            "--plan-only",
        ]
    )
    plan_path = Path(f"{target}.plan.json")
    run(
        [sys.executable, "-m", "emit", "build", str(plan_path), "--out", str(target)],
        env={**os.environ, "PYTHONPATH": str(HERE)},
    )
    run(["node", str(HERE / "validate_cache_parity.mjs"), str(target)])
    oracle_path = Path(f"{target}.semantic-oracle.json")
    run(
        [
            sys.executable,
            str(HERE / "verify" / "workbook_semantic_oracle.py"),
            "--xlsx",
            str(target),
            "--contract",
            f"{target}.workbook-proof-contract.json",
            "--out",
            str(oracle_path),
        ]
    )
    return (
        plan_path,
        json.loads(plan_path.read_text(encoding="utf-8")),
        json.loads(Path(f"{target}.row-map.json").read_text(encoding="utf-8")),
    )


def operating_cells(plan: dict) -> dict:
    return next(
        sheet["cells"]
        for sheet in plan["workbook"]["sheets"]
        if sheet["name"] == "Operating Model"
    )


def statement_row(row_map: dict, role: str) -> int:
    for section in row_map["statement_rows"].values():
        for definition in section:
            if definition.get("semantic_role") == role:
                return int(definition["row"])
    raise AssertionError(f"Missing statement role {role}")


def assert_no_excel_errors(workbook_path: Path) -> None:
    workbook = load_workbook(workbook_path, data_only=True, read_only=True)
    errors: list[str] = []
    for sheet in workbook.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                if cell.data_type == "e" or (
                    isinstance(cell.value, str) and cell.value.startswith("#")
                ):
                    errors.append(f"{sheet.title}!{cell.coordinate}={cell.value}")
    assert not errors, f"Cached Excel errors remain: {errors[:20]}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("case")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    source = json.loads(Path(args.case).resolve().read_text(encoding="utf-8"))
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)

    states = []
    for sequence, enabled in enumerate((0, 1, 0, 1), start=1):
        payload = json.loads(json.dumps(source))
        payload.setdefault("acquisition", {})["enabled"] = enabled
        workbook_path = output / f"state-{sequence}" / "model.xlsx"
        plan_path, plan, row_map = build(payload, workbook_path)
        assert_no_excel_errors(workbook_path)
        states.append((enabled, workbook_path, plan_path, plan, row_map))

    for first, repeated in ((states[0], states[2]), (states[1], states[3])):
        assert first[0] == repeated[0]
        assert sha256(first[2]) == sha256(repeated[2]), (
            f"Acquisition state {first[0]} did not restore deterministically"
        )

    off_cells = operating_cells(states[0][3])
    on_cells = operating_cells(states[1][3])
    row_map = states[1][4]
    controls = row_map["controls"]
    consideration_row = statement_row(row_map, "acquisitions_net_of_cash")
    change_in_debt_row = statement_row(row_map, "change_in_debt")
    pre_tax_income_row = statement_row(row_map, "pre_tax_income")
    tax_expense_row = statement_row(row_map, "tax_expense")
    debt_total_row = int(row_map["debt_summary_rows"]["total_change_in_debt"])
    waterfall_proceeds_row = int(row_map["waterfall_rows"]["non_rcf_debt_proceeds"])
    cash_before_rcf_row = int(row_map["waterfall_rows"]["cash_before_rcf"])

    close_year = int(source["acquisition"]["close_year"])
    forecast_years = [
        int(str(period["date"])[:4])
        for period in source["periods"]
        if period["status"] == "forecast"
    ]
    close_index = forecast_years.index(close_year)
    adjustment_column = ("N", "O", "P")[close_index]
    pro_forma_column = ("S", "T", "U")[close_index]

    assert off_cells[f"{adjustment_column}{consideration_row}"].get("v") == 0
    assert on_cells[f"{adjustment_column}{consideration_row}"].get("v") == -float(
        source["acquisition"]["transaction_enterprise_value"]
    )
    assert off_cells[f"{adjustment_column}{change_in_debt_row}"].get("v") == 0
    assert on_cells[f"{adjustment_column}{change_in_debt_row}"].get("v") == float(
        source["acquisition"]["acquisition_debt_amount"]
    )
    assert f"{adjustment_column}{debt_total_row}" in on_cells[
        f"{adjustment_column}{change_in_debt_row}"
    ].get("f", "")
    assert "$P$8" in on_cells[f"{adjustment_column}{waterfall_proceeds_row}"].get(
        "f", ""
    )
    assert f"{adjustment_column}{waterfall_proceeds_row}" in on_cells[
        f"{adjustment_column}{cash_before_rcf_row}"
    ].get("f", "")
    assert on_cells[f"{pro_forma_column}{change_in_debt_row}"].get("v") == float(
        source["acquisition"]["acquisition_debt_amount"]
    )

    amount_basis = (
        f"({source['issuer']['reporting_currency']}, {source['issuer']['units']})"
    )
    for control_id in (
        "transaction_enterprise_value",
        "target_ebitda",
        "acquisition_debt_amount",
    ):
        label = str(on_cells[f"N{controls[control_id]}"].get("v", ""))
        assert label.endswith(amount_basis), (
            f"Acquisition amount control {control_id} does not state currency and units: {label}"
        )

    target_formula = str(on_cells[f"P{controls['target_ebitda']}"].get("f", ""))
    expected_target_formula = (
        f"IFERROR(P{controls['transaction_enterprise_value']}/"
        f"P{controls['entry_ev_to_ebitda']},0)"
    )
    assert target_formula == expected_target_formula
    assert "MAX(" not in target_formula

    for column in ("N", "O", "P"):
        tax_formula = str(on_cells[f"{column}{tax_expense_row}"].get("f", ""))
        assert "MAX(" not in tax_formula, (
            f"Acquisition tax formula still floors negative PBT: {tax_formula}"
        )
        assert f"-{column}{pre_tax_income_row}*" in tax_formula, (
            f"Acquisition tax does not consume signed target PBT: {tax_formula}"
        )

    report = {
        "schema_version": "acquisition-portable-workbook-test/1.0",
        "status": "PASS",
        "states": [state[0] for state in states],
        "checks": 25,
        "close_year": close_year,
        "change_in_debt_row_id": "change_in_debt",
        "portable_formula_cache_parity": "PASS",
        "semantic_oracle": "PASS",
        "native_excel": "NOT_AVAILABLE_IN_PORTABLE_TEST",
    }
    (output / "acquisition-portable-workbook-test.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
