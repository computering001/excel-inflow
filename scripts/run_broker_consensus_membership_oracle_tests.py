#!/usr/bin/env python3
"""Mutation suite for the independent broker-consensus membership oracle."""

from __future__ import annotations

import ast
import copy
import json
from pathlib import Path

from verify.broker_consensus_membership_oracle import digest, inspect_model_case


SIGNATURE = {
    "metric_id": "adjusted_ebitda",
    "accounting_basis": "IFRS",
    "operation_scope": "continuing",
    "adjustment_basis": "adjusted",
    "currency": "GBP",
    "units": "millions",
    "fiscal_calendar": "fixed_date",
    "cash_flow_basis": None,
    "lease_basis": "including_leases",
}


def fixture() -> dict:
    contributors = [
        {
            "house_name": name,
            "status": "included",
            "reasons": [],
            "definition_signature": copy.deepcopy(SIGNATURE),
            "period_status": ["included", "included", "included"],
            "period_reasons": [[], [], []],
        }
        for name in ("House A", "House B", "House C")
    ]
    body = {
        "schema_version": "broker-consensus-membership/1.0",
        "metric_id": "adjusted_ebitda",
        "contributors": contributors,
    }
    membership = {**body, "membership_sha256": digest(body)}
    return {
        "issuer": {
            "accounting_basis": "IFRS",
            "reporting_currency": "GBP",
            "units": "millions",
            "fiscal_calendar": "fixed_date",
        },
        "broker_pack": {
            "metrics": {
                "adjusted_ebitda": {
                    "label": "Adjusted EBITDA",
                    "definition_signature": copy.deepcopy(SIGNATURE),
                    "brokers": {
                        "House A": [100, 110, 120],
                        "House B": [102, 112, 122],
                        "House C": [104, 114, 124],
                    },
                    "provider_consensus": [99, 116, 125],
                    "provider_consensus_source": {
                        "source_note": "Neutral provider consensus note",
                        "period_lineage": ["page 1 / D4", "page 1 / E4", "page 1 / F4"],
                    },
                    "consensus_membership": membership,
                }
            }
        },
    }


def reseal(case: dict) -> None:
    membership = case["broker_pack"]["metrics"]["adjusted_ebitda"]["consensus_membership"]
    body = {key: value for key, value in membership.items() if key != "membership_sha256"}
    membership["membership_sha256"] = digest(body)


def report(case: dict) -> dict:
    return inspect_model_case(case)


base = fixture()
base_report = report(base)
assert base_report["status"] == "PASS"
periods = base_report["metrics"][0]["periods"]
assert [entry["contributor_count"] for entry in periods] == [3, 3, 3]
assert [entry["model_consensus"] for entry in periods] == [102.0, 112.0, 122.0]

# Provider consensus is a separate source series and cannot change the model
# average or its membership.
provider_changed = copy.deepcopy(base)
provider_changed["broker_pack"]["metrics"]["adjusted_ebitda"]["provider_consensus"] = [1, 2, 3]
assert report(provider_changed)["metrics"][0]["periods"] == periods

blank = copy.deepcopy(base)
blank["broker_pack"]["metrics"]["adjusted_ebitda"]["brokers"]["House C"][1] = None
blank_periods = report(blank)["metrics"][0]["periods"]
assert [entry["contributor_count"] for entry in blank_periods] == [3, 2, 3]
assert blank_periods[1]["model_consensus"] == 111.0

mutations_caught = 0
for status, reason in (
    ("rejected", "evidence quality rejected"),
    ("quarantined", "source cell quarantined"),
    ("stale", "outside freshness policy"),
):
    candidate = copy.deepcopy(base)
    member = candidate["broker_pack"]["metrics"]["adjusted_ebitda"]["consensus_membership"]["contributors"][1]
    member["status"] = status
    member["reasons"] = [reason]
    reseal(candidate)
    result = report(candidate)
    assert result["status"] == "PASS"
    assert all(period["contributor_count"] == 2 and period["excluded_count"] == 1 for period in result["metrics"][0]["periods"])
    mutations_caught += 1

for dimension, value in (
    ("currency", "USD"),
    ("units", "thousands"),
    ("adjustment_basis", "statutory"),
    ("accounting_basis", "US_GAAP"),
):
    candidate = copy.deepcopy(base)
    member = candidate["broker_pack"]["metrics"]["adjusted_ebitda"]["consensus_membership"]["contributors"][2]
    member["definition_signature"][dimension] = value
    reseal(candidate)
    result = report(candidate)
    assert all(period["contributor_count"] == 2 and period["excluded_count"] == 1 for period in result["metrics"][0]["periods"])
    mutations_caught += 1

wrong_period = copy.deepcopy(base)
member = wrong_period["broker_pack"]["metrics"]["adjusted_ebitda"]["consensus_membership"]["contributors"][0]
member["period_status"][1] = "wrong_period"
member["period_reasons"][1] = ["source period is FY29, not FY28"]
reseal(wrong_period)
wrong_periods = report(wrong_period)["metrics"][0]["periods"]
assert [entry["contributor_count"] for entry in wrong_periods] == [3, 2, 3]
mutations_caught += 1

for candidate in (copy.deepcopy(base), copy.deepcopy(base)):
    if mutations_caught == 8:
        candidate["broker_pack"]["metrics"]["adjusted_ebitda"]["consensus_membership"]["contributors"][0]["status"] = "rejected"
    else:
        candidate["broker_pack"]["metrics"]["adjusted_ebitda"]["consensus_membership"]["contributors"].pop()
        reseal(candidate)
    assert report(candidate)["status"] == "BLOCK"
    mutations_caught += 1

oracle_path = Path(__file__).with_name("verify") / "broker_consensus_membership_oracle.py"
tree = ast.parse(oracle_path.read_text(encoding="utf-8"))
imports = sorted({
    node.module or ""
    for node in ast.walk(tree)
    if isinstance(node, ast.ImportFrom)
} | {
    alias.name
    for node in ast.walk(tree)
    if isinstance(node, ast.Import)
    for alias in node.names
})
forbidden = (
    "case_compiler", "forecast_candidate_compiler", "forecast_authority",
    "row_plan", "solver", "emit", "build_dynamic_model",
)
assert not [name for name in imports if any(token in name for token in forbidden)]

print(json.dumps({
    "status": "PASS",
    "positive_metrics": 1,
    "positive_periods": 3,
    "mutations_caught": mutations_caught,
    "provider_separation_proved": True,
    "production_imports": [],
    "total_violations": 0,
}, sort_keys=True))
