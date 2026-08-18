#!/usr/bin/env python3
"""Portable workbook-level acquisition scenario matrix."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True

from run_acquisition_portable_workbook_tests import (
    assert_no_excel_errors,
    build,
    operating_cells,
    sha256,
    statement_row,
)


def scenario_case(source: dict, *, close_index: int, close_month: int, debt: float) -> dict:
    payload = json.loads(json.dumps(source))
    forecast_years = [
        int(str(period["date"])[:4])
        for period in payload["periods"]
        if period["status"] == "forecast"
    ]
    payload["execution_profile"] = "reference_parity"
    payload["acquisition"] = {
        "enabled": 1,
        "transaction_enterprise_value": 1000,
        "entry_ev_to_ebitda": 10,
        "acquisition_debt_amount": debt,
        "incremental_rate": 0.05,
        "close_year": forecast_years[close_index],
        "close_month": close_month,
    }
    return payload


def assert_close_cells(payload: dict, plan: dict, row_map: dict) -> dict:
    cells = operating_cells(plan)
    forecast_years = [
        int(str(period["date"])[:4])
        for period in payload["periods"]
        if period["status"] == "forecast"
    ]
    close_index = forecast_years.index(int(payload["acquisition"]["close_year"]))
    adjustment_columns = ("N", "O", "P")
    standalone_columns = ("J", "K", "L")
    pro_forma_columns = ("S", "T", "U")
    close_column = adjustment_columns[close_index]

    consideration_row = statement_row(row_map, "acquisitions_net_of_cash")
    revenue_row = statement_row(row_map, "revenue")
    ebitda_row = statement_row(row_map, "adjusted_ebitda")
    margin_row = int(row_map["rows_by_id"]["adjusted_ebitda_margin"])
    acquisition_debt_row = int(row_map["debt_summary_rows"]["acquisition_debt"])
    acquisition_interest_row = int(
        row_map["interest_summary_rows"]["acquisition_interest"]
    )
    waterfall_proceeds_row = int(row_map["waterfall_rows"]["non_rcf_debt_proceeds"])
    cash_before_rcf_row = int(row_map["waterfall_rows"]["cash_before_rcf"])

    enterprise_value = float(payload["acquisition"]["transaction_enterprise_value"])
    debt = float(payload["acquisition"]["acquisition_debt_amount"])

    for index, column in enumerate(adjustment_columns):
        consideration = float(cells[f"{column}{consideration_row}"].get("v") or 0)
        debt_proceeds = float(cells[f"{column}{waterfall_proceeds_row}"].get("v") or 0)
        acquisition_debt = float(cells[f"{column}{acquisition_debt_row}"].get("v") or 0)
        if index < close_index:
            assert consideration == 0
            assert debt_proceeds == 0
            assert acquisition_debt == 0
        elif index == close_index:
            assert consideration == -enterprise_value
            assert debt_proceeds == debt
            assert acquisition_debt == debt
        else:
            assert consideration == 0
            assert debt_proceeds == 0
            assert acquisition_debt == debt

    close_interest = float(
        cells[f"{close_column}{acquisition_interest_row}"].get("v") or 0
    )
    if debt == 0:
        assert close_interest == 0
    else:
        assert close_interest < 0
        assert "$P$8" in str(
            cells[f"{close_column}{acquisition_interest_row}"].get("f", "")
        )

    # The residual EV less acquisition debt reaches the ordinary cash/RCF
    # waterfall once; there is no second equity plug or duplicated proceeds row.
    cash_before_rcf_formula = str(
        cells[f"{close_column}{cash_before_rcf_row}"].get("f", "")
    )
    assert f"{close_column}{waterfall_proceeds_row}" in cash_before_rcf_formula
    assert "$P$5" in str(
        cells[f"{close_column}{consideration_row}"].get("f", "")
    )

    # Amount rows are additive and ratios are recomputed from pro-forma amount
    # components rather than added as standalone and adjustment percentages.
    pro_forma_column = pro_forma_columns[close_index]
    standalone_column = standalone_columns[close_index]
    for row in (consideration_row, acquisition_debt_row, acquisition_interest_row):
        formula = str(cells[f"{pro_forma_column}{row}"].get("f", ""))
        assert f"{standalone_column}{row}" in formula
        assert f"{close_column}{row}" in formula
    margin_formula = str(cells[f"{pro_forma_column}{margin_row}"].get("f", ""))
    assert f"{pro_forma_column}{ebitda_row}" in margin_formula
    assert f"{pro_forma_column}{revenue_row}" in margin_formula

    return {
        "close_year_index": close_index + 1,
        "close_month": int(payload["acquisition"]["close_month"]),
        "enterprise_value": enterprise_value,
        "acquisition_debt": debt,
        "close_year_interest": close_interest,
        "residual_cash_or_rcf_funding": enterprise_value - debt,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("case")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    source_path = Path(args.case).resolve()
    source = json.loads(source_path.read_text(encoding="utf-8"))
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)

    definitions = (
        ("all-cash-year-1", 0, 6, 0),
        ("mixed-mid-year-2", 1, 6, 400),
        ("debt-funded-year-3", 2, 12, 1000),
    )
    scenarios = []
    for name, close_index, close_month, debt in definitions:
        payload = scenario_case(
            source,
            close_index=close_index,
            close_month=close_month,
            debt=debt,
        )
        workbook_path = output / name / "model.xlsx"
        _, plan, row_map = build(payload, workbook_path)
        assert_no_excel_errors(workbook_path)
        scenarios.append(
            {
                "name": name,
                "workbook_sha256": sha256(workbook_path),
                **assert_close_cells(payload, plan, row_map),
            }
        )

    report = {
        "schema_version": "acquisition-workbook-scenarios/2.0",
        "status": "PASS",
        "source_fixture_sha256": sha256(source_path),
        "source_execution_profile": source.get("execution_profile"),
        "scenario_execution_profile": "reference_parity",
        "scenarios": scenarios,
        "formula_cache_parity": "PASS",
        "semantic_oracle": "PASS",
        "cached_excel_error_scan": "PASS",
        "native_excel": "NOT_RUN_PORTABLE_SCENARIO_SUITE",
    }
    (output / "acquisition-workbook-scenarios.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
