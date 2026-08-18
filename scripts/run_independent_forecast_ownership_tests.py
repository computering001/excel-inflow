#!/usr/bin/env python3
"""Mutations for the production-independent forecast-ownership walker."""

from __future__ import annotations

import ast
import copy
import json
from pathlib import Path

import lib.independent_forecast_ownership as ownership_oracle


walk_forecast_ownership = ownership_oracle.walk_forecast_ownership


def authorities(method: str, prefix: str) -> list[dict]:
    return [
        {
            "forecast_index": index,
            "method": method,
            "source_kind": "independent_test",
            "source_id": "%s-%s" % (prefix, index + 1),
        }
        for index in range(3)
    ]


def parent_owned_case() -> dict:
    return {
        "statement_structure": {
            "income_statement": [
                {
                    "row_id": "neutral_total",
                    "label": "Neutral reported total",
                    "row_type": "subtotal",
                    "aggregation_authority": "reported_parent",
                    "historical_authority": "reported_total_reconciled",
                    "source_line_ids": ["source.total"],
                    "calculation": {"operator": "sum", "refs": ["neutral_a", "neutral_b"]},
                    "forecast_period_authorities": authorities("broker_consensus", "parent"),
                },
                {
                    "row_id": "neutral_a",
                    "label": "Neutral detail A",
                    "row_type": "uncalculated",
                    "parent_row_id": "neutral_total",
                    "historical_authority": "source_input",
                    "source_line_ids": ["source.a"],
                    "forecast_capture_parent_id": "neutral_total",
                    "forecast_period_authorities": authorities("not_separately_forecast", "a"),
                },
                {
                    "row_id": "neutral_b",
                    "label": "Neutral detail B",
                    "row_type": "uncalculated",
                    "parent_row_id": "neutral_total",
                    "historical_authority": "source_input",
                    "source_line_ids": ["source.b"],
                    "forecast_capture_parent_id": "neutral_total",
                    "forecast_period_authorities": authorities("not_separately_forecast", "b"),
                },
            ],
            "cash_flow": [],
        }
    }


def children_owned_case() -> dict:
    case = parent_owned_case()
    rows = case["statement_structure"]["income_statement"]
    rows[0]["aggregation_authority"] = "derived_from_children"
    rows[0]["forecast_period_authorities"] = authorities("accounting_identity", "parent")
    for index, row in enumerate(rows[1:], start=1):
        row.pop("forecast_capture_parent_id", None)
        row["row_type"] = "input"
        row["forecast_period_authorities"] = authorities("user_assumption", "child-%s" % index)
    return case


def main() -> int:
    oracle_source = Path(ownership_oracle.__file__).read_text(encoding="utf-8")
    imported_modules = sorted(
        {
            node.module or ""
            for node in ast.walk(ast.parse(oracle_source))
            if isinstance(node, ast.ImportFrom)
        }
        | {
            alias.name
            for node in ast.walk(ast.parse(oracle_source))
            if isinstance(node, ast.Import)
            for alias in node.names
        }
    )
    forbidden_imports = [
        name
        for name in imported_modules
        if any(
            token in name
            for token in (
                "forecast_authority",
                "forecast_candidate_compiler",
                "statement_topology",
                "case_compiler",
                "row_plan",
            )
        )
    ]
    if forbidden_imports:
        raise AssertionError("independent walker imports production topology: %s" % forbidden_imports)

    parent_case = parent_owned_case()
    child_case = children_owned_case()
    parent_report = walk_forecast_ownership(parent_case)
    child_report = walk_forecast_ownership(child_case)
    if parent_report["status"] != "PASS" or child_report["status"] != "PASS":
        raise AssertionError("valid ownership mode was rejected")

    reordered = copy.deepcopy(parent_case)
    reordered["statement_structure"]["income_statement"].reverse()
    if walk_forecast_ownership(reordered)["status"] != "PASS":
        raise AssertionError("ownership walker depends on row order")

    relabelled = copy.deepcopy(parent_case)
    for index, row in enumerate(relabelled["statement_structure"]["income_statement"]):
        row["label"] = "Unfamiliar disclosure %s" % index
    if walk_forecast_ownership(relabelled)["status"] != "PASS":
        raise AssertionError("ownership walker depends on issuer labels")

    double_forecast = copy.deepcopy(parent_case)
    double_forecast["statement_structure"]["income_statement"][1][
        "forecast_period_authorities"
    ] = authorities("user_assumption", "mutated-child")
    double_report = walk_forecast_ownership(double_forecast)
    double_caught = (
        double_report["status"] == "BLOCK"
        and sum(
            item["code"] == "INDEPENDENT_PARENT_CHILD_DOUBLE_FORECAST"
            for item in double_report["findings"]
        )
        == 3
    )

    incomplete_children = copy.deepcopy(child_case)
    incomplete_children["statement_structure"]["income_statement"][2][
        "forecast_period_authorities"
    ] = authorities("not_separately_forecast", "mutated-absent-child")
    incomplete_report = walk_forecast_ownership(incomplete_children)
    incomplete_caught = (
        incomplete_report["status"] == "BLOCK"
        and sum(
            item["code"] == "INDEPENDENT_CHILDREN_OWNERSHIP_INCOMPLETE"
            for item in incomplete_report["findings"]
        )
        == 3
    )

    summary = {
        "status": "PASS" if double_caught and incomplete_caught else "BLOCK",
        "total_violations": 0 if double_caught and incomplete_caught else 1,
        "positive_modes": 2,
        "invariance_checks": 2,
        "adversarial_mutations": 2,
        "parent_child_double_forecast_caught": double_caught,
        "incomplete_children_ownership_caught": incomplete_caught,
        "oracle_imports": imported_modules,
        "production_topology_imports": forbidden_imports,
    }
    print(json.dumps(summary, sort_keys=True))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
