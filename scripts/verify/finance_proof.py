#!/usr/bin/env python3
"""Independent mechanical finance proof for a built debt-overlay workbook.

This verifier does not import the Node solver, renderer, formula evaluator or
the emitted ``.solution.json`` sidecar.  It reads only the frozen case, the
semantic row map and the workbook package through the standard-library OOXML
reader.  It independently recomputes instrument debt, instrument/RCF/lease/
acquisition interest, interest income, debt summaries, leverage, liquidity and
the visible RCF waterfall for standalone and pro-forma forecast blocks.

Usage:
    python3 scripts/verify/finance_proof.py CASE.json WORKBOOK.xlsx --out REPORT.json
"""

from __future__ import annotations

import argparse
import calendar
import datetime as dt
import json
import math
import os
import re
import sys
from typing import Dict, List, Optional

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    __package__ = "verify"

from .xlsx import Workbook  # noqa: E402


FORECAST_COLUMNS = ("J", "K", "L")
PRO_FORMA_COLUMNS = ("S", "T", "U")
ABS_TOLERANCE = 1e-6
REL_TOLERANCE = 1e-9


def number(value, default=0.0) -> float:
    if value is None or value == "":
        return float(default)
    return float(value)


def series3(value, default=0.0) -> List[float]:
    if isinstance(value, list) and len(value) == 3:
        return [number(item, default) for item in value]
    return [float(default)] * 3


def equal(actual, expected) -> bool:
    actual = number(actual)
    expected = number(expected)
    allowance = max(
        ABS_TOLERANCE,
        REL_TOLERANCE * max(1.0, abs(actual), abs(expected)),
    )
    return abs(actual - expected) <= allowance


def normalised_formula(value: str) -> str:
    return str(value or "").replace("$", "").replace(" ", "").upper()


def column_number(label: str) -> int:
    value = 0
    for character in label:
        value = value * 26 + ord(character) - ord("A") + 1
    return value


def formula_references_cell(formula: str, reference: str) -> bool:
    """Return true when an A1 reference is explicit or covered by a range.

    The finance proof must understand compact formulas such as
    ``SUM(J121:J123)`` without importing the renderer's formula parser.  This
    small independent A1 reader deliberately handles only unqualified cells
    and rectangular ranges, which is the closed same-sheet surface asserted by
    this verifier.
    """
    target = re.fullmatch(r"([A-Z]{1,3})([0-9]+)", normalised_formula(reference))
    if not target:
        return False
    target_column = column_number(target.group(1))
    target_row = int(target.group(2))
    for match in re.finditer(
        r"(?<![A-Z0-9_])([A-Z]{1,3})([0-9]+)(?::([A-Z]{1,3})([0-9]+))?",
        normalised_formula(formula),
    ):
        first_column = column_number(match.group(1))
        first_row = int(match.group(2))
        last_column = column_number(match.group(3) or match.group(1))
        last_row = int(match.group(4) or match.group(2))
        if (
            min(first_column, last_column) <= target_column <= max(first_column, last_column)
            and min(first_row, last_row) <= target_row <= max(first_row, last_row)
        ):
            return True
    return False


def iso_date(value: str) -> dt.date:
    return dt.date.fromisoformat(value[:10])


def one_year_earlier(value: dt.date) -> dt.date:
    day = min(value.day, calendar.monthrange(value.year - 1, value.month)[1])
    return value.replace(year=value.year - 1, day=day)


def period_bounds(case: dict, period_index: int) -> tuple:
    period_end = iso_date(case["periods"][period_index]["date"])
    if period_index > 0:
        period_start = iso_date(case["periods"][period_index - 1]["date"]) + dt.timedelta(days=1)
    else:
        period_start = one_year_earlier(period_end) + dt.timedelta(days=1)
    return period_start, period_end


def fraction_between(start: dt.date, end: dt.date,
                     period_start: dt.date, period_end: dt.date) -> float:
    start = max(start, period_start)
    end = min(end, period_end)
    if start > end:
        return 0.0
    total = (period_end - period_start).days + 1
    elapsed = (end - start).days + 1
    return max(0.0, min(1.0, elapsed / total))


def outstanding_fraction(case: dict, period_index: int, start: dt.date) -> float:
    period_start, period_end = period_bounds(case, period_index)
    return fraction_between(start, period_end, period_start, period_end)


def movement_fraction(date_value, period_start: dt.date, period_end: dt.date,
                      active_end: dt.date, fallback: float) -> float:
    if date_value in (None, ""):
        return fallback
    try:
        movement_date = iso_date(str(date_value))
    except (TypeError, ValueError):
        return fallback
    return fraction_between(movement_date, active_end, period_start, period_end)


def fx_rate(case: dict, currency: str, period_index: int, kind: str) -> float:
    if currency == case["issuer"]["reporting_currency"]:
        return 1.0
    fx = case["fx"][currency]
    key = "average_rates" if kind == "average" else "period_end_rates"
    raw = number(fx[key][period_index])
    if raw <= 0:
        raise ValueError("invalid %s FX rate for %s" % (kind, currency))
    return raw if fx.get("quote") == "reporting_per_native" else 1.0 / raw


def instrument_balance_currency(case: dict, instrument: dict) -> str:
    """Return the currency basis of the instrument amounts in the case.

    ``currency`` is always the instrument's legal denomination.  It is not
    necessarily the currency of ``opening_balance`` or the forecast principal
    movements: a debt export can supply a foreign-denominated instrument's
    carrying value already translated into the issuer's reporting currency.
    The independent proof must therefore resolve amount basis independently of
    legal denomination, just as the production solver and renderer do.
    """
    if instrument.get("balance_basis") == "reporting_currency_carrying_value":
        return case["issuer"]["reporting_currency"]
    return instrument["currency"]


def all_in_rate(instrument: dict, forecast_index: int) -> float:
    if instrument.get("rate_type") != "floating":
        return series3(instrument.get("coupon_or_all_in_rate"))[forecast_index]
    benchmark = series3(instrument.get("benchmark_rate"))[forecast_index]
    floor = series3(instrument.get("benchmark_floor"))[forecast_index]
    benchmark = max(floor, benchmark)
    return benchmark + number(instrument.get("spread_bps")) / 10000.0


def non_cash_components(instrument: dict, forecast_index: int) -> tuple:
    components = instrument.get("non_cash_movement_components")
    if isinstance(components, dict):
        return (
            series3(components.get("fair_value"))[forecast_index],
            series3(components.get("other"))[forecast_index],
        )
    return (0.0, series3(instrument.get("other_non_cash_movement"))[forecast_index])


def solved_pik(weighted_base: float, rate: float, active_fraction: float) -> float:
    if rate <= 0:
        return 0.0
    denominator = 1.0 - rate * active_fraction / 2.0
    if denominator <= 0:
        raise ValueError("PIK rate must be below 200%")
    return max(0.0, weighted_base * rate / denominator)


def instrument_timing(case: dict, period_index: int, forecast_index: int,
                      instrument: dict, opening: float, issuance: float,
                      fair_value: float, other_non_cash: float,
                      amortisation: float) -> dict:
    start, end = period_bounds(case, period_index)
    maturity = iso_date(instrument["maturity_date"]) if instrument.get("maturity_date") else None
    matures = bool(
        number(case["controls"].get("debt_maturities_roll")) == 1
        and maturity is not None and maturity <= end
    )
    active_end = min(maturity, end) if matures else end
    active_fraction = fraction_between(start, active_end, start, end)
    fallback = active_fraction / 2.0
    issuance_dates = instrument.get("new_issuance_dates") or [None, None, None]
    amortisation_dates = instrument.get("scheduled_amortisation_dates") or [None, None, None]
    issuance_fraction = movement_fraction(
        issuance_dates[forecast_index], start, end, active_end, fallback
    )
    amortisation_fraction = movement_fraction(
        amortisation_dates[forecast_index], start, end, active_end, fallback
    )
    weighted_base = max(
        0.0,
        opening * active_fraction
        + issuance * issuance_fraction
        + (fair_value + other_non_cash) * fallback
        - amortisation * amortisation_fraction,
    )
    return {
        "active_fraction": active_fraction,
        "weighted_base": weighted_base,
        "matures": matures,
    }


def acquisition_close_index(case: dict) -> int:
    acquisition = case.get("acquisition") or {}
    if number(acquisition.get("enabled")) != 1:
        return -1
    close = dt.date(
        int(acquisition["close_year"]),
        int(acquisition["close_month"]),
        1,
    )
    for index, period in enumerate(case["periods"][3:]):
        start, end = period_bounds(case, index + 3)
        if start <= close <= end:
            return index
    return -1


def lease_opening(case: dict) -> float:
    policy = case.get("lease_policy") or {}
    historical = policy.get("historical_liabilities")
    if isinstance(historical, list) and len(historical) == 3:
        return number(historical[2])
    return number(policy.get("opening_liability"))


class Proof:
    def __init__(self, case_path: str, workbook_path: str) -> None:
        with open(case_path, "r", encoding="utf-8") as handle:
            self.case = json.load(handle)
        with open(workbook_path + ".row-map.json", "r", encoding="utf-8") as handle:
            self.rows = json.load(handle)
        self.workbook = Workbook.open(workbook_path)
        self.sheet = self.workbook.sheet("Operating Model")
        self.case_path = os.path.abspath(case_path)
        self.workbook_path = os.path.abspath(workbook_path)
        self.findings: List[dict] = []
        self.comparisons = 0

    def value(self, column: str, row: Optional[int]):
        if row is None:
            return None
        return self.sheet.value("%s%d" % (column, int(row)))

    def compare(self, check: str, block: str, period: int, metric: str,
                actual, expected, **context) -> None:
        self.comparisons += 1
        if equal(actual, expected):
            return
        self.findings.append(
            {
                "check": check,
                "block": block,
                "forecast_period": period + 1,
                "metric": metric,
                "actual": actual,
                "expected": expected,
                "difference": abs(number(actual) - number(expected)),
                **context,
            }
        )

    def require(self, check: str, block: str, period: int, metric: str,
                condition: bool, actual=None, expected=None, **context) -> None:
        self.comparisons += 1
        if condition:
            return
        self.findings.append(
            {
                "check": check,
                "block": block,
                "forecast_period": period + 1,
                "metric": metric,
                "actual": actual,
                "expected": expected,
                **context,
            }
        )

    def run(self) -> dict:
        case = self.case
        row_map = self.rows
        controls = row_map["controls"]
        debt_rows = row_map["debt_summary_rows"]
        interest_rows = row_map["interest_summary_rows"]
        waterfall = row_map["waterfall_rows"]
        rows_by_id = row_map["rows_by_id"]
        # The cash-flow spine, addressed by semantic role rather than issuer
        # row id, so the proof can re-derive ending cash from the statement's
        # own flows. Reading ending cash from the workbook alone proves the
        # sweep self-consistent, not economically right: a collapsed CFO
        # produces a maxed revolver and a deeply negative ending cash that a
        # read-back "proof" happily confirms.
        cash_flow_spine = {}
        for statement_row in (row_map.get("statement_rows") or {}).get("cash_flow") or []:
            role = statement_row.get("semantic_role")
            if role and role not in cash_flow_spine:
                cash_flow_spine[role] = statement_row.get("row")
        instrument_plans = {
            item["instrument_id"]: item for item in row_map["instruments"]
        }
        cash_bucket_plans = row_map.get("cash_buckets") or []
        cash_bucket_definitions = {
            item["bucket_id"]: item
            for item in ((case.get("cash_policy") or {}).get("buckets") or [])
        }
        explicit_cash_buckets = bool(cash_bucket_plans)
        instruments = sorted(
            case["instruments"],
            key=lambda item: (number(item.get("display_order")), item["instrument_id"]),
        )
        balancing_rcf_id = (case.get("rcf_policy") or {}).get("instrument_id")
        non_rcf = [
            item
            for item in instruments
            if item.get("instrument_id") != balancing_rcf_id
            and item.get("class") != "lease"
        ]
        rcf = next(
            (
                item
                for item in instruments
                if item.get("instrument_id") == balancing_rcf_id
            ),
            None,
        )
        native_balances: Dict[str, float] = {
            item["instrument_id"]: number(item.get("opening_balance")) for item in non_rcf
        }
        lease_balance = lease_opening(case)
        lease_policy = case.get("lease_policy") or {}
        lease_interest_basis = lease_policy.get("interest_basis")
        if not lease_interest_basis:
            lease_interest_basis = (
                "none"
                if lease_policy.get("mode") == "exclude"
                else "total_liability"
            )
        historical_interest_bearing_lease = series3(
            lease_policy.get("historical_interest_bearing_liabilities")
        )
        lease_interest_balance = (
            historical_interest_bearing_lease[2]
            if lease_interest_basis == "separately_supplied"
            else lease_balance
        )
        close_index = acquisition_close_index(case)
        acquisition = case.get("acquisition") or {}
        acquisition_amount = (
            number(acquisition.get("acquisition_debt_amount"))
            if number(acquisition.get("enabled")) == 1 else 0.0
        )
        circularity = int(number(case["controls"].get("circularity")))
        maturity_roll = int(number(case["controls"].get("debt_maturities_roll")))

        self.compare("controls", "shared", 0, "circularity", self.value("C", controls["circularity"]), circularity)
        self.compare("controls", "shared", 0, "debt_maturities_roll", self.value("C", controls["debt_maturities_roll"]), maturity_roll)
        self.compare("controls", "shared", 0, "acquisition_enabled", self.value("P", controls["adjustments_enabled"]), number(acquisition.get("enabled")))

        # Instrument mechanics are independent of the acquisition overlay. One
        # basis-currency roll-forward is therefore proved against both visible
        # blocks. Legal denomination is presentation metadata and must not force
        # a second FX translation of a reporting-currency carrying value.
        period_instruments: List[dict] = []
        for index in range(3):
            period_index = index + 3
            period_end = iso_date(case["periods"][period_index]["date"])
            instrument_interest = 0.0
            gross_debt = 0.0
            net_debt = 0.0
            leverage_debt = 0.0
            commercial_paper = 0.0
            debt_fx_translation = 0.0
            entries = []
            for instrument in non_rcf:
                instrument_id = instrument["instrument_id"]
                balance_currency = instrument_balance_currency(case, instrument)
                opening_native = native_balances[instrument_id]
                issuance = series3(instrument.get("new_issuance"))[index]
                fair_value, other_non_cash = non_cash_components(instrument, index)
                available = max(0.0, opening_native + issuance + fair_value + other_non_cash)
                amortisation = min(
                    available,
                    max(0.0, series3(instrument.get("scheduled_amortisation"))[index]),
                )
                base_ending = max(0.0, available - amortisation)
                timing = instrument_timing(
                    case,
                    period_index,
                    index,
                    instrument,
                    opening_native,
                    issuance,
                    fair_value,
                    other_non_cash,
                    amortisation,
                )
                matures = timing["matures"]
                pik = (
                    solved_pik(
                        timing["weighted_base"],
                        series3(instrument.get("pik_rate"))[index],
                        timing["active_fraction"],
                    )
                    if circularity == 1
                    else 0.0
                )
                pre_maturity = max(0.0, base_ending + pik)
                maturity_repayment = pre_maturity if matures else 0.0
                ending_native = pre_maturity - maturity_repayment
                ending_fx = fx_rate(case, balance_currency, period_index, "period_end")
                average_fx = fx_rate(case, balance_currency, period_index, "average")
                ending_reporting = ending_native * ending_fx
                opening_reporting = opening_native * fx_rate(
                    case, balance_currency, period_index - 1, "period_end"
                )
                opening_fx = fx_rate(
                    case, balance_currency, period_index - 1, "period_end"
                )
                weighted_principal = (
                    timing["weighted_base"]
                    + pik * timing["active_fraction"] / 2.0
                )
                cash_coupon_interest = (
                    weighted_principal
                    * all_in_rate(instrument, index)
                    * average_fx
                )
                if circularity != 1:
                    cash_coupon_interest = 0.0
                pik_interest = pik * average_fx
                interest = cash_coupon_interest + pik_interest
                plan = instrument_plans[instrument_id]
                for block_name, columns in (("standalone", FORECAST_COLUMNS), ("pro_forma", PRO_FORMA_COLUMNS)):
                    self.compare("instrument-debt", block_name, index, instrument_id, self.value(columns[index], plan["debt_row"]), ending_reporting)
                    sourced_balances = instrument.get("forecast_ending_balances")
                    if sourced_balances is not None:
                        self.compare(
                            "instrument-source",
                            block_name,
                            index,
                            instrument_id,
                            self.value(columns[index], plan["debt_row"]),
                            number(sourced_balances[index]) * ending_fx,
                        )
                    if plan.get("interest_row"):
                        self.compare("instrument-interest", block_name, index, instrument_id, self.value(columns[index], plan["interest_row"]), -cash_coupon_interest)
                    if plan.get("pik_interest_row"):
                        self.compare("instrument-interest", block_name, index, instrument_id + ".pik", self.value(columns[index], plan["pik_interest_row"]), -pik_interest)
                    if plan.get("pik_row"):
                        self.compare("instrument-debt", block_name, index, instrument_id + ".pik", self.value(columns[index], plan["pik_row"]), pik)
                instrument_interest += interest
                if instrument.get("include_in_gross_debt") is not False:
                    gross_debt += ending_reporting
                if instrument.get("include_in_net_debt") is not False:
                    net_debt += ending_reporting
                if instrument.get("include_in_leverage", instrument.get("include_in_net_debt", True)) is not False:
                    leverage_debt += ending_reporting
                if instrument.get("class") == "commercial_paper":
                    commercial_paper += ending_reporting
                if balance_currency != case["issuer"]["reporting_currency"]:
                    issuance_reporting = issuance * average_fx
                    repayment_reporting = (
                        amortisation + maturity_repayment
                    ) * average_fx
                    non_cash_balance_reporting = (
                        fair_value + other_non_cash + pik
                    ) * ending_fx
                    debt_fx_translation += (
                        ending_reporting
                        - opening_reporting
                        - issuance_reporting
                        + repayment_reporting
                        - non_cash_balance_reporting
                    )
                entries.append({"instrument_id": instrument_id, "ending_reporting": ending_reporting, "interest": interest})
                native_balances[instrument_id] = ending_native

            mode = lease_policy.get("mode")
            principal = 0.0 if mode == "exclude" else series3(lease_policy.get("principal_repayment"))[index]
            additions = (
                principal if mode == "flat_replacement"
                else series3(lease_policy.get("additions"))[index] if mode == "simple_roll_forward"
                else 0.0
            )
            ending_lease = (
                0.0
                if mode == "exclude"
                else number(lease_policy.get("forecast_liabilities")[index])
                if mode == "sourced_balance"
                else max(0.0, lease_balance + additions - principal)
            )
            ending_interest_bearing_lease = (
                0.0
                if lease_interest_basis == "none"
                else number(
                    lease_policy.get("forecast_interest_bearing_liabilities")[index]
                )
                if lease_interest_basis == "separately_supplied"
                else ending_lease
            )
            lease_interest = (
                0.0
                if lease_interest_basis == "none"
                else (
                    (lease_interest_balance + ending_interest_bearing_lease)
                    / 2.0
                )
                * series3(lease_policy.get("effective_rate"))[index]
            )
            if circularity != 1:
                lease_interest = 0.0
            period_instruments.append(
                {
                    "instrument_interest": instrument_interest,
                    "gross_debt": gross_debt,
                    "net_debt": net_debt,
                    "leverage_debt": leverage_debt,
                    "commercial_paper": commercial_paper,
                    "debt_fx_translation": debt_fx_translation,
                    "lease": ending_lease,
                    "lease_interest": lease_interest,
                    "entries": entries,
                }
            )
            lease_balance = ending_lease
            lease_interest_balance = ending_interest_bearing_lease

        for block_name, columns, acquisition_on in (
            ("standalone", FORECAST_COLUMNS, False),
            ("pro_forma", PRO_FORMA_COLUMNS, number(acquisition.get("enabled")) == 1),
        ):
            acquisition_balance = 0.0
            for index, column in enumerate(columns):
                mechanics = period_instruments[index]
                opening_rcf = number(self.value(column, waterfall["opening_rcf"]))
                draw = number(self.value(column, waterfall["rcf_draw_waterfall"]))
                # The RCF waterfall presents draw and repayment as two positive
                # control legs; the debt schedule/statement may sign repayment
                # as an outflow, but this row is intentionally unsigned.
                repayment = number(self.value(column, waterfall["rcf_repayment_waterfall"]))
                ending_rcf = number(self.value(column, waterfall["ending_rcf"]))
                capacity = number((case.get("rcf_policy") or {}).get("capacity") or (rcf or {}).get("facility_capacity"))
                foreign_rcf = bool(
                    rcf
                    and rcf.get("currency") != case["issuer"]["reporting_currency"]
                )
                opening_fx = (
                    fx_rate(case, rcf["currency"], index + 2, "period_end")
                    if foreign_rcf else 1.0
                )
                average_fx = (
                    fx_rate(case, rcf["currency"], index + 3, "average")
                    if foreign_rcf else 1.0
                )
                ending_fx = (
                    fx_rate(case, rcf["currency"], index + 3, "period_end")
                    if foreign_rcf else 1.0
                )
                opening_rcf_native = opening_rcf / opening_fx
                draw_native = draw / average_fx
                repayment_native = repayment / average_fx
                ending_rcf_native = (
                    opening_rcf_native + draw_native - repayment_native
                )
                expected_ending_rcf = ending_rcf_native * ending_fx
                self.compare("rcf-waterfall", block_name, index, "ending_rcf", ending_rcf, expected_ending_rcf)
                self.require("rcf-waterfall", block_name, index, "capacity", -ABS_TOLERANCE <= ending_rcf_native <= capacity + ABS_TOLERANCE, ending_rcf_native, "native 0..%s" % capacity)
                self.require("rcf-waterfall", block_name, index, "draw_repayment_exclusive", not (draw > ABS_TOLERANCE and repayment > ABS_TOLERANCE), {"draw": draw, "repayment": repayment}, "at most one positive leg")
                if index == 0:
                    expected_opening_rcf = number(
                        (case.get("rcf_policy") or {}).get("opening_draw")
                        or (rcf or {}).get("opening_balance")
                    ) * opening_fx
                    self.compare("rcf-waterfall", block_name, index, "opening_rcf", opening_rcf, expected_opening_rcf)
                else:
                    self.compare("rcf-waterfall", block_name, index, "opening_rcf", opening_rcf, number(self.value(columns[index - 1], waterfall["ending_rcf"])))

                plan = instrument_plans.get((case.get("rcf_policy") or {}).get("instrument_id"))
                if plan:
                    self.compare("rcf-waterfall", block_name, index, "rcf_debt_row", self.value(column, plan["debt_row"]), ending_rcf)

                acquisition_expected = 0.0
                acquisition_interest = 0.0
                if acquisition_on and close_index >= 0 and index >= close_index:
                    if index == close_index:
                        acquisition_balance += acquisition_amount
                    acquisition_expected = acquisition_balance
                    timing = 1.0
                    if index == close_index:
                        timing = outstanding_fraction(
                            case,
                            index + 3,
                            dt.date(int(acquisition["close_year"]), int(acquisition["close_month"]), 1),
                        )
                    acquisition_interest = acquisition_expected * number(acquisition.get("incremental_rate")) * timing
                    if circularity != 1:
                        acquisition_interest = 0.0
                self.compare("acquisition", block_name, index, "acquisition_debt", self.value(column, debt_rows["acquisition_debt"]), acquisition_expected)
                self.compare("acquisition", block_name, index, "acquisition_interest", self.value(column, interest_rows["acquisition_interest"]), -acquisition_interest)

                self.compare("lease", block_name, index, "lease_liability", self.value(column, debt_rows["lease_liability"]), mechanics["lease"])
                self.compare("lease", block_name, index, "lease_interest", self.value(column, interest_rows["lease_interest"]), -mechanics["lease_interest"])
                self.compare("interest", block_name, index, "instrument_interest", self.value(column, interest_rows["instrument_interest"]), -mechanics["instrument_interest"])

                rcf_interest = 0.0
                commitment_fee = 0.0
                if rcf and circularity == 1:
                    rcf_interest = (
                        (opening_rcf_native + ending_rcf_native) / 2.0
                    ) * all_in_rate(rcf, index) * average_fx
                    if (case.get("rcf_policy") or {}).get("commitment_fee_convention") == "bps_on_undrawn":
                        average_undrawn = max(
                            0.0,
                            capacity - (opening_rcf_native + ending_rcf_native) / 2.0,
                        )
                        commitment_fee = average_undrawn * number((case.get("rcf_policy") or {}).get("commitment_fee_value")) / 10000.0 * average_fx
                self.compare("interest", block_name, index, "rcf_interest", self.value(column, interest_rows["rcf_interest"]), -rcf_interest)
                self.compare("interest", block_name, index, "rcf_commitment_fee", self.value(column, interest_rows["rcf_commitment_fee"]), -commitment_fee)
                self.compare("interest", block_name, index, "rcf_total_fees", self.value(column, interest_rows["rcf_total_fees"]), -(rcf_interest + commitment_fee))

                opening_cash = number(self.value(column, rows_by_id["opening_cash"]))
                ending_cash = number(self.value(column, rows_by_id["ending_cash"]))
                spine_roles = (
                    "cash_from_operations",
                    "cash_from_investing",
                    "cash_from_financing",
                )
                missing_spine = [
                    role for role in spine_roles if cash_flow_spine.get(role) is None
                ]
                self.require(
                    "cash",
                    block_name,
                    index,
                    "cash_flow_spine_present",
                    not missing_spine,
                    actual=missing_spine,
                    expected=[],
                )
                if not missing_spine:
                    statement_flows = sum(
                        number(self.value(column, cash_flow_spine[role]))
                        for role in spine_roles
                    )
                    if explicit_cash_buckets:
                        non_balancing_row = cash_flow_spine.get(
                            "non_balancing_cash_bucket_movement"
                        )
                        if non_balancing_row is not None:
                            statement_flows += number(
                                self.value(column, non_balancing_row)
                            )
                    fx_row = cash_flow_spine.get("fx_effect_on_cash")
                    fx_effect = (
                        number(self.value(column, fx_row)) if fx_row is not None else 0.0
                    )
                    self.compare(
                        "cash",
                        block_name,
                        index,
                        "ending_cash_from_statement_flows",
                        ending_cash,
                        opening_cash + statement_flows + fx_effect,
                    )
                balancing_ending_cash = (
                    number(self.value(column, waterfall["cash_before_rcf"]))
                    + draw
                    - repayment
                )
                reported_cash = ending_cash
                liquidity_cash = ending_cash
                if explicit_cash_buckets:
                    interest_income = 0.0
                    reported_cash = 0.0
                    liquidity_cash = 0.0
                    eligible_cash = 0.0
                    interest_eligible_cash = 0.0
                    for bucket_plan in cash_bucket_plans:
                        bucket_id = bucket_plan["bucket_id"]
                        definition = cash_bucket_definitions[bucket_id]
                        current_balance = number(self.value(column, bucket_plan["balance_row"]))
                        if index == 0:
                            opening_column = "I" if block_name == "standalone" else "R"
                        else:
                            opening_column = columns[index - 1]
                        opening_balance = number(self.value(opening_column, bucket_plan["balance_row"]))
                        treatment = definition["forecast_treatment"]
                        if treatment == "balancing":
                            expected_balance = balancing_ending_cash
                        elif treatment == "hardcode":
                            expected_balance = series3(definition.get("forecast_values"))[index]
                        elif treatment == "linked_debt_addback":
                            linked_ids = definition.get("linked_instrument_ids") or []
                            linked_entry_by_id = {
                                entry["instrument_id"]: entry
                                for entry in mechanics["entries"]
                            }
                            missing_linked_ids = [
                                instrument_id
                                for instrument_id in linked_ids
                                if instrument_id not in linked_entry_by_id
                            ]
                            self.require(
                                "cash-buckets",
                                block_name,
                                index,
                                bucket_id + ".linked_instruments_present",
                                not missing_linked_ids,
                                actual=missing_linked_ids,
                                expected=[],
                            )
                            # This bucket is the gross-cash add-back for debt
                            # that the issuer presents net in cash.  It follows
                            # the CURRENT period's independently recomputed
                            # instrument endings; carrying the opening bucket
                            # would leave stale cash after a linked overdraft
                            # amortises or matures.
                            expected_balance = sum(
                                number(linked_entry_by_id[instrument_id]["ending_reporting"])
                                for instrument_id in linked_ids
                                if instrument_id in linked_entry_by_id
                            )
                        else:
                            expected_balance = opening_balance
                        self.compare(
                            "cash-buckets", block_name, index,
                            bucket_id + ".balance", current_balance, expected_balance,
                        )
                        balance_formula = normalised_formula(
                            self.sheet.formula("%s%s" % (column, bucket_plan["balance_row"]))
                        )
                        if treatment == "hardcode" and block_name == "standalone":
                            self.require(
                                "cash-bucket-formulas", block_name, index,
                                bucket_id + ".hardcode_is_input",
                                balance_formula == "", balance_formula, "no formula",
                            )
                        else:
                            if treatment == "balancing":
                                # The cash-flow statement owns reported ending
                                # cash.  The balancing liquidity bucket consumes
                                # that answer net of every non-balancing bucket;
                                # it must not push the RCF waterfall back up into
                                # the statement and create a second cash owner.
                                expected_references = [
                                    "%s%s" % (column, rows_by_id["ending_cash"]),
                                ] + [
                                    "%s%s" % (column, plan["balance_row"])
                                    for plan in cash_bucket_plans
                                    if cash_bucket_definitions[plan["bucket_id"]].get(
                                        "forecast_treatment"
                                    ) != "balancing"
                                    and cash_bucket_definitions[plan["bucket_id"]].get(
                                        "included_in_cash_flow_cash", True
                                    ) is not False
                                ]
                            elif treatment == "linked_debt_addback":
                                expected_references = [
                                    "%s%s"
                                    % (
                                        column,
                                        instrument_plans[instrument_id]["debt_row"],
                                    )
                                    for instrument_id in (
                                        definition.get("linked_instrument_ids") or []
                                    )
                                    if instrument_id in instrument_plans
                                ]
                            elif block_name == "pro_forma":
                                expected_references = [
                                    "%s%s" % (FORECAST_COLUMNS[index], bucket_plan["balance_row"]),
                                    "%s%s" % (("N", "O", "P")[index], bucket_plan["balance_row"]),
                                ]
                            else:
                                expected_references = [
                                    "%s%s" % (opening_column, bucket_plan["balance_row"])
                                ]
                            self.require(
                                "cash-bucket-formulas", block_name, index,
                                bucket_id + ".balance_reference",
                                all(
                                    formula_references_cell(balance_formula, reference)
                                    for reference in expected_references
                                ),
                                balance_formula, expected_references,
                            )
                        net_percentage = number(definition.get("net_debt_eligible_percentage"))
                        interest_percentage = number(definition.get("interest_eligible_percentage"))
                        bucket_interest = (
                            ((opening_balance + current_balance) / 2.0)
                            * interest_percentage
                            * series3(definition.get("cash_yield"))[index]
                            if circularity == 1 else 0.0
                        )
                        self.compare(
                            "cash-buckets", block_name, index,
                            bucket_id + ".interest",
                            self.value(column, bucket_plan["interest_row"]),
                            bucket_interest,
                        )
                        bucket_interest_formula = normalised_formula(
                            self.sheet.formula("%s%s" % (column, bucket_plan["interest_row"]))
                        )
                        required_interest_references = (
                            "C%s" % controls["circularity"],
                            "%s%s" % (column, bucket_plan["balance_row"]),
                            "%s%s" % (column, bucket_plan["rate_row"]),
                            "D%s" % bucket_plan["interest_row"],
                        )
                        self.require(
                            "cash-bucket-formulas", block_name, index,
                            bucket_id + ".interest_references",
                            all(
                                reference in bucket_interest_formula
                                for reference in required_interest_references
                            ),
                            bucket_interest_formula,
                            list(required_interest_references),
                        )
                        interest_income += bucket_interest
                        reported_cash += current_balance
                        if definition.get("available_for_liquidity"):
                            liquidity_cash += current_balance
                        eligible_cash += current_balance * net_percentage
                        interest_eligible_cash += current_balance * interest_percentage
                    self.compare(
                        "cash-buckets", block_name, index, "reported_cash",
                        self.value(column, debt_rows["reported_cash"]), reported_cash,
                    )
                    self.compare(
                        "cash-buckets", block_name, index, "liquidity_cash",
                        self.value(column, debt_rows["liquidity_cash"]), liquidity_cash,
                    )
                    self.compare(
                        "cash-buckets", block_name, index, "interest_bearing_cash",
                        self.value(column, debt_rows["interest_bearing_cash"]),
                        interest_eligible_cash,
                    )
                    self.compare(
                        "cash-buckets", block_name, index, "cash_for_net_debt",
                        self.value(column, debt_rows["cash_for_net_debt"]),
                        -eligible_cash,
                    )
                    summary_formula_requirements = {
                        "reported_cash": [
                            "%s%s" % (column, plan["balance_row"])
                            for plan in cash_bucket_plans
                        ],
                        "liquidity_cash": [
                            "%s%s" % (column, plan["balance_row"])
                            for plan in cash_bucket_plans
                            if cash_bucket_definitions[plan["bucket_id"]].get(
                                "available_for_liquidity"
                            )
                        ],
                        "interest_bearing_cash": [
                            "%s%s" % (column, plan["balance_row"])
                            for plan in cash_bucket_plans
                        ] + ["E%s" % plan["balance_row"] for plan in cash_bucket_plans],
                        "cash_for_net_debt": [
                            "%s%s" % (column, plan["balance_row"])
                            for plan in cash_bucket_plans
                        ] + ["D%s" % plan["balance_row"] for plan in cash_bucket_plans],
                        "interest_income_schedule": [
                            "%s%s" % (column, plan["interest_row"])
                            for plan in cash_bucket_plans
                        ] + ["C%s" % controls["circularity"]],
                    }
                    for metric, references in summary_formula_requirements.items():
                        row = (
                            interest_rows[metric]
                            if metric == "interest_income_schedule"
                            else debt_rows[metric]
                        )
                        formula_text = normalised_formula(
                            self.sheet.formula("%s%s" % (column, row))
                        )
                        self.require(
                            "cash-bucket-formulas", block_name, index,
                            metric + ".references",
                            all(
                                formula_references_cell(formula_text, reference)
                                for reference in references
                            ),
                            formula_text, references,
                        )
                else:
                    cash_yield = series3((case.get("cash_policy") or {}).get("cash_yield"))[index]
                    eligible_percentage = number((case.get("cash_policy") or {}).get("eligible_cash_percentage"), 1.0)
                    interest_income = ((opening_cash + ending_cash) / 2.0) * eligible_percentage * cash_yield if circularity == 1 else 0.0
                    eligible_cash = ending_cash * eligible_percentage
                self.compare("interest", block_name, index, "interest_income", self.value(column, interest_rows["interest_income_schedule"]), interest_income)

                other_interest = series3(case.get("other_interest"))[index] if circularity == 1 else 0.0
                non_cash_interest = series3(case.get("non_cash_interest"))[index] if circularity == 1 else 0.0
                gross_interest = mechanics["instrument_interest"] + rcf_interest + commitment_fee + mechanics["lease_interest"] + acquisition_interest + other_interest + non_cash_interest
                self.compare("interest", block_name, index, "gross_interest", self.value(column, interest_rows["gross_interest_expense"]), -gross_interest)
                self.compare("interest", block_name, index, "net_interest", self.value(column, interest_rows["net_interest_expense"]), -(gross_interest - interest_income))

                gross_ex_leases = mechanics["gross_debt"] + ending_rcf + acquisition_expected
                debt_for_net = mechanics["net_debt"] + ending_rcf + acquisition_expected
                debt_for_leverage = mechanics["leverage_debt"] + ending_rcf + acquisition_expected
                net_ex_leases = debt_for_net - eligible_cash
                visible_lease = mechanics["lease"] if mode != "exclude" else 0.0
                lease_in_leverage = mechanics["lease"] if lease_policy.get("include_in_leverage") and mode != "exclude" else 0.0
                self.compare("debt-summary", block_name, index, "gross_debt_excluding_leases", self.value(column, debt_rows["gross_debt_excluding_leases"]), gross_ex_leases)
                self.compare("debt-summary", block_name, index, "gross_debt_including_leases", self.value(column, debt_rows["gross_debt_including_leases"]), gross_ex_leases + visible_lease)
                self.compare("debt-summary", block_name, index, "net_debt_excluding_leases", self.value(column, debt_rows["net_debt_excluding_leases"]), net_ex_leases)
                # Lease-excluded / compact topologies intentionally omit the
                # separate net-debt-including-leases row. Prove it when the row
                # exists; do not turn a valid optional topology into a verifier
                # crash. Gross debt including leases and the selected headline
                # leverage remain independently checked in either topology.
                if "net_debt_including_leases" in debt_rows:
                    self.compare("debt-summary", block_name, index, "net_debt_including_leases", self.value(column, debt_rows["net_debt_including_leases"]), net_ex_leases + visible_lease)

                ebitda = number(self.value(column, rows_by_id["adjusted_ebitda"]))
                expected_leverage = None if abs(ebitda) <= ABS_TOLERANCE else (debt_for_leverage + lease_in_leverage - eligible_cash) / ebitda
                if expected_leverage is not None:
                    self.compare("leverage", block_name, index, "net_debt_to_adjusted_ebitda", self.value(column, debt_rows["net_debt_to_adjusted_ebitda"]), expected_leverage)

                undrawn = max(0.0, capacity - ending_rcf_native) * ending_fx
                liquidity = liquidity_cash + undrawn - mechanics["commercial_paper"]
                self.compare("liquidity", block_name, index, "undrawn_rcf", self.value(column, debt_rows["undrawn_rcf"]), undrawn)
                # Commercial paper is displayed as a deduction inside the
                # liquidity bridge even though its economic balance is positive.
                self.compare("liquidity", block_name, index, "drawn_commercial_paper", self.value(column, debt_rows["drawn_commercial_paper"]), -mechanics["commercial_paper"])
                self.compare("liquidity", block_name, index, "total_liquidity", self.value(column, debt_rows["total_liquidity"]), liquidity)

                if debt_rows.get("debt_fx_translation") is not None:
                    rcf_fx_residual = (
                        ending_rcf - opening_rcf - draw + repayment
                        if foreign_rcf else 0.0
                    )
                    self.compare(
                        "debt-fx", block_name, index, "debt_fx_translation",
                        self.value(column, debt_rows["debt_fx_translation"]),
                        mechanics["debt_fx_translation"] + rcf_fx_residual,
                    )

        checks = []
        for check in sorted({finding["check"] for finding in self.findings} | {
            "controls", "instrument-debt", "instrument-interest", "rcf-waterfall",
            "acquisition", "lease", "interest", "debt-summary", "leverage", "liquidity",
            "cash-buckets", "debt-fx",
        }):
            findings = [item for item in self.findings if item["check"] == check]
            checks.append({"id": check, "status": "PASS" if not findings else "FAIL", "violations": len(findings)})
        return {
            "schema_version": 1,
            "kind": "independent_finance_proof",
            "status": "PASS" if not self.findings else "FAIL",
            "case": self.case_path,
            "workbook": self.workbook_path,
            "method": "standard-library OOXML reader plus independent mechanical recomputation; no solver, renderer, formula evaluator or solution sidecar imported",
            "tolerance": {"absolute": ABS_TOLERANCE, "relative": REL_TOLERANCE},
            "summary": {"comparisons": self.comparisons, "violations": len(self.findings)},
            "checks": checks,
            "findings": self.findings,
        }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("case")
    parser.add_argument("workbook")
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    report = Proof(args.case, args.workbook).run()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(
        "STATUS=%s comparisons=%d violations=%d\n%s"
        % (
            report["status"],
            report["summary"]["comparisons"],
            report["summary"]["violations"],
            os.path.abspath(args.out),
        )
    )
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
