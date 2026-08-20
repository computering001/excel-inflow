"""Independent formula-lineage checks for instrument interest rows."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from .xlsx import same_sheet_references


FORECAST_COLUMNS = ["J", "K", "L"]
PRO_FORMA_COLUMNS = ["S", "T", "U"]
MOVEMENT_KEYS = (
    "issuance_row",
    "amortisation_row",
    "fair_value_row",
    "other_non_cash_row",
    "pik_row",
)
PROTECTED_KEYS = (
    "debt_row",
    *MOVEMENT_KEYS,
    "repayment_row",
    "interest_row",
    "pik_interest_row",
)


def _row(reference: str) -> Optional[int]:
    match = re.match(r"^[A-Z]+(\d+)$", str(reference or ""))
    return int(match.group(1)) if match else None


def interest_lineage_findings(
    *,
    formula: str,
    address: str,
    plan: Dict[str, Any],
    all_plans: List[Dict[str, Any]],
    row_plan: Dict[str, Any],
    rate_type: str,
    period_index: int,
    block: str,
    state: Dict[str, Any],
    reporting_currency: str,
    maturity_value: Any,
) -> List[Dict[str, Any]]:
    """Return semantic formula defects without evaluating producer caches."""

    findings: List[Dict[str, Any]] = []
    instrument_id = plan.get("instrument_id")
    text = str(formula or "")
    compact = re.sub(r"\s+", "", text).replace("$", "")
    references = set(same_sheet_references(text))

    def fail(issue: str, **detail: Any) -> None:
        findings.append(
            {
                "address": address,
                "instrument_id": instrument_id,
                "issue": issue,
                "formula": text,
                **detail,
            }
        )

    if not text.startswith("="):
        return [
            {
                "address": address,
                "instrument_id": instrument_id,
                "issue": "interest_formula_missing",
                "formula": text,
            }
        ]

    controls = row_plan.get("controls") or {}
    circularity = "C%d" % int(controls.get("circularity") or 0)
    if circularity not in references or not re.search(
        r"%s=0" % re.escape(circularity), compact, re.I
    ):
        fail("circularity_gate_missing", expected_control=circularity)

    normalized_rate_type = str(rate_type or "").strip().upper()
    residual_priced = normalized_rate_type == "RESIDUAL"
    if not residual_priced and ",0,-" not in compact and not compact.startswith("=-"):
        fail("interest_expense_sign_missing")

    prior_columns = FORECAST_COLUMNS if block == "standalone" else PRO_FORMA_COLUMNS
    expected_opening = (
        "D%d" % int(plan["debt_row"])
        if period_index == 0
        else "%s%d" % (prior_columns[period_index - 1], int(plan["debt_row"]))
    )
    if expected_opening not in references:
        fail("same_instrument_opening_balance_missing", expected=expected_opening)

    movement_column = FORECAST_COLUMNS[period_index]
    for key in MOVEMENT_KEYS:
        row = plan.get(key)
        if isinstance(row, int):
            expected = "%s%d" % (movement_column, row)
            if expected not in references:
                fail("same_instrument_movement_missing", role=key, expected=expected)

    protected_owners: Dict[int, str] = {}
    for candidate in all_plans:
        for key in PROTECTED_KEYS:
            row = candidate.get(key)
            if isinstance(row, int):
                protected_owners[row] = str(candidate.get("instrument_id"))
    cross_instrument = sorted(
        reference
        for reference in references
        if _row(reference) in protected_owners
        and protected_owners[_row(reference)] != instrument_id
    )
    if cross_instrument:
        fail("cross_instrument_reference", references=cross_instrument)

    if normalized_rate_type in {"FIXED", "FLOATING", "ALL-IN"}:
        expected_rate = "D%d" % int(plan["interest_row"])
        if expected_rate not in references:
            fail("own_rate_or_spread_missing", expected=expected_rate)

    current_column = (
        FORECAST_COLUMNS[period_index]
        if block == "standalone"
        else PRO_FORMA_COLUMNS[period_index]
    )
    if normalized_rate_type == "FLOATING":
        curve_key = (row_plan.get("benchmark_curve_keys") or {}).get(instrument_id)
        benchmark_row = (row_plan.get("benchmark_rows") or {}).get(curve_key)
        expected_benchmark = (
            "%s%d" % (current_column, benchmark_row)
            if isinstance(benchmark_row, int)
            else None
        )
        if not expected_benchmark or expected_benchmark not in references:
            fail("own_benchmark_missing", expected=expected_benchmark, curve_key=curve_key)
        floor_row = (row_plan.get("benchmark_floor_rows") or {}).get(instrument_id)
        if isinstance(floor_row, int):
            expected_floor = "%s%d" % (current_column, floor_row)
            if expected_floor not in references:
                fail("own_benchmark_floor_missing", expected=expected_floor)

    movement_rows_present = any(isinstance(plan.get(key), int) for key in MOVEMENT_KEYS)
    maturity_present = maturity_value not in (None, "")
    if movement_rows_present or maturity_present:
        period_row = int(row_plan.get("period_row") or 0)
        if not any(_row(reference) == period_row for reference in references):
            fail("instrument_timing_reference_missing", expected_row=period_row)
    if maturity_present and plan.get("maturity_treatment") != "non_maturing_within_forecast":
        maturity_reference = "E%d" % int(plan["debt_row"])
        roll_reference = "C%d" % int(controls.get("debt_maturities_roll") or 0)
        if maturity_reference not in references:
            fail("contractual_maturity_missing", expected=maturity_reference)
        if roll_reference not in references:
            fail("maturity_roll_control_missing", expected=roll_reference)

    foreign_native_balance = (
        state.get("balance_basis") == "native_principal"
        and str(state.get("currency") or "") != str(reporting_currency or "")
    )
    has_forward_curve = bool(
        re.search(r"(?:'Forward Curves'|Forward_Curves|Forward Curves)!", text, re.I)
    )
    if foreign_native_balance and not has_forward_curve:
        fail("average_fx_reference_missing")
    if state.get("balance_basis") == "reporting_currency_carrying_value" and has_forward_curve:
        fail("reporting_carrying_value_double_fx")

    return findings
