#!/usr/bin/env python3
"""Canonical producer for a schema-complete zero-broker authority state.

The attachment controller is the only production writer of this artifact.
Explicit skip and every optional-broker fault path call the same functions so
their economic projection cannot drift while raw archive custody remains
separate.
"""

from __future__ import annotations

import re
from copy import deepcopy
from typing import Any


DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CURRENCY = re.compile(r"^[A-Z]{3}$")
UNITS = {"units", "thousands", "millions"}


def _required_context(evidence: dict[str, Any]) -> tuple[list[str], str, str, str]:
    filings = evidence.get("filings") or {}
    previous = evidence.get("broker_pack") or {}
    lanes = ((evidence.get("case_evidence") or {}).get("lanes") or {})
    period_lane = lanes.get("periods") or []
    lane_forecasts = [
        item.get("date")
        for item in period_lane
        if isinstance(item, dict) and item.get("status") == "forecast"
    ]
    forecast_periods = list(
        previous.get("forecast_periods")
        or filings.get("forecast_periods")
        or lane_forecasts
    )
    historical_periods = list(filings.get("historical_periods") or [])
    as_of = str(previous.get("as_of") or (historical_periods[-1] if historical_periods else ""))
    reporting_currency = str(
        previous.get("reporting_currency")
        or filings.get("reporting_currency")
        or ((evidence.get("case_source") or {}).get("identity") or {}).get("reporting_currency")
        or ""
    )
    units = str(
        previous.get("units")
        or filings.get("units")
        or ((evidence.get("case_source") or {}).get("identity") or {}).get("units")
        or ""
    )
    return forecast_periods, as_of, reporting_currency, units


def validate_zero_broker_pack(pack: dict[str, Any]) -> None:
    required = {
        "schema_version",
        "pack_kind",
        "as_of",
        "reporting_currency",
        "units",
        "forecast_periods",
        "freshness_policy",
        "metrics",
        "houses",
    }
    missing = sorted(required - set(pack))
    if missing:
        raise ValueError(
            "Canonical zero-broker pack omits required field(s): " + ", ".join(missing)
        )
    if pack.get("schema_version") != "broker-pack/1.0":
        raise ValueError("Canonical zero-broker pack has the wrong schema version")
    if pack.get("pack_kind") != "broker_forecast_set":
        raise ValueError("Canonical zero-broker pack has the wrong pack kind")
    if not DATE.fullmatch(str(pack.get("as_of") or "")):
        raise ValueError("Canonical zero-broker pack requires a filings-derived as-of date")
    if not CURRENCY.fullmatch(str(pack.get("reporting_currency") or "")):
        raise ValueError("Canonical zero-broker pack requires an ISO reporting currency")
    if pack.get("units") not in UNITS:
        raise ValueError("Canonical zero-broker pack requires declared units")
    periods = pack.get("forecast_periods")
    if (
        not isinstance(periods, list)
        or len(periods) != 3
        or any(not DATE.fullmatch(str(period or "")) for period in periods)
    ):
        raise ValueError("Canonical zero-broker pack requires exactly three forecast dates")
    if pack.get("metrics") != {} or pack.get("houses") != []:
        raise ValueError("Canonical zero-broker pack must carry zero metrics and zero houses")
    if pack.get("freshness_policy") != {
        "as_of": pack.get("as_of"),
        "max_age_days": 180,
        "stale_house_count": 0,
    }:
        raise ValueError("Canonical zero-broker pack requires the exact empty freshness policy")
    summary = pack.get("eligibility_summary")
    expected_summary = {
        "primary_eligible_house_count": 0,
        "supplemental_eligible_house_count": 0,
        "reference_only_house_count": 0,
        "run_can_continue_without_broker_question": True,
    }
    if summary != expected_summary:
        raise ValueError("Canonical zero-broker eligibility summary is not the exact zero state")
    if pack.get("recommended_primary_house_id") is not None:
        raise ValueError("Canonical zero-broker pack cannot recommend a house")


def build_zero_broker_pack(
    evidence: dict[str, Any],
    *,
    source_label: str,
    notes: str,
) -> dict[str, Any]:
    forecast_periods, as_of, reporting_currency, units = _required_context(evidence)
    pack = {
        "schema_version": "broker-pack/1.0",
        "pack_kind": "broker_forecast_set",
        "as_of": as_of,
        "source_label": source_label,
        "reporting_currency": reporting_currency,
        "units": units,
        "forecast_periods": forecast_periods,
        "freshness_policy": {
            "as_of": as_of,
            "max_age_days": 180,
            "stale_house_count": 0,
        },
        "metrics": {},
        "houses": [],
        "recommended_primary_house_id": None,
        "eligibility_summary": {
            "primary_eligible_house_count": 0,
            "supplemental_eligible_house_count": 0,
            "reference_only_house_count": 0,
            "run_can_continue_without_broker_question": True,
        },
        "notes": notes,
    }
    validate_zero_broker_pack(pack)
    return pack


def project_zero_broker_case_lane(pack: dict[str, Any]) -> dict[str, Any]:
    validate_zero_broker_pack(pack)
    return {
        "source_label": str(pack.get("source_label") or "Forecast Waterfall"),
        "forecast_periods": deepcopy(pack["forecast_periods"]),
        "metrics": {},
        "house_metadata": {},
        "source_mappings": [],
        "house_digests": {},
    }


def apply_zero_broker_authority(
    evidence: dict[str, Any],
    *,
    source_label: str,
    notes: str,
) -> dict[str, Any]:
    pack = build_zero_broker_pack(evidence, source_label=source_label, notes=notes)
    lanes = evidence.setdefault("case_evidence", {}).setdefault("lanes", {})
    evidence["broker_pack"] = pack
    lanes["broker_pack"] = project_zero_broker_case_lane(pack)
    lanes.setdefault("controls", {})["broker_case"] = "Forecast Waterfall"
    return pack


__all__ = [
    "apply_zero_broker_authority",
    "build_zero_broker_pack",
    "project_zero_broker_case_lane",
    "validate_zero_broker_pack",
]
