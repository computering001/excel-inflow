#!/usr/bin/env python3
"""Prove deterministic model-demand broker selection and safe degradation."""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from broker_terminal_recovery import (
    canonical_bytes,
    canonical_hash,
    compile_demand_selected_crosswalk,
)
from compile_broker_candidate_manifest import compile_manifest
from compile_broker_canonical_tables import canonicalise_bundle
from run_broker_degraded_close_tests import build_house
from verify_broker_semantics import verify


FORECAST_PERIODS = ["2027-12-31", "2028-12-31", "2029-12-31"]
ROWS = [
    ["Metric", "2027E", "2028E", "2029E"],
    ["Revenue", "100", "110", "120"],
    ["EBIT", "20", "22", "24"],
    ["Depreciation and amortisation", "5", "5.5", "6"],
    ["Effective tax rate", "20%", "21%", "22%"],
    ["Capital expenditure", "10", "11", "12"],
    ["Change in working capital", "-2", "1", "-1"],
    ["Dividends paid", "3", "3", "4"],
    ["Share buybacks", "0", "0", "1"],
]


def demand_graph(labels: list[str]) -> dict[str, Any]:
    nodes = []
    for row_index, label in enumerate(labels):
        section = "cash_flow" if label in {
            "Capital expenditure", "Change in working capital", "Dividends paid", "Share buybacks"
        } else "income_statement"
        for period_index, period_end in enumerate(FORECAST_PERIODS):
            nodes.append({
                "node_id": f"{section}.s{row_index}.fy{period_index + 1}",
                "section": section,
                "source_line_id": f"s{row_index}",
                "label": label,
                "parent_label": None,
                "period_end": period_end,
                "material": True,
                "has_historical_value": True,
                "allowed_authorities": ["selected_broker", "historical_inference"],
                "definition_signature_sha256": "b" * 64,
            })
    body = {
        "schema_version": "pre-broker-model-demand/1.0",
        "run_id": "broker_demand_selection",
        "as_of": "2026-12-31",
        "reporting_currency": "USD",
        "units": "millions",
        "forecast_periods": FORECAST_PERIODS,
        "nodes": nodes,
        "counts": {
            "source_rows": len(labels),
            "forecast_nodes": len(nodes),
            "material_nodes": len(nodes),
        },
    }
    return {**body, "graph_sha256": canonical_hash(body)}


def demand_graph_v2(labels: list[str]) -> dict[str, Any]:
    metric_by_label = {
        "Revenue": "revenue",
        "EBIT": "ebit",
        "Depreciation and amortisation": "depreciation_and_amortisation",
        "Effective tax rate": "effective_tax_rate",
        "Capital expenditure": "capex",
        "Change in working capital": "change_in_working_capital",
        "Dividends paid": "dividends",
        "Share buybacks": "share_buybacks",
    }
    nodes = []
    for row_index, label in enumerate(labels):
        metric_id = metric_by_label[label]
        section = "cash_flow" if metric_id in {
            "capex", "change_in_working_capital", "dividends", "share_buybacks"
        } else "income_statement"
        for period_index, period_end in enumerate(FORECAST_PERIODS):
            nodes.append({
                "node_id": f"model_demand.{metric_id}.fy{period_index + 1}",
                "node_kind": "model_demand",
                "section": section,
                "source_line_id": f"s{row_index}",
                "metric_id": metric_id,
                "label": label,
                "parent_label": None,
                "period_end": period_end,
                "material": True,
                "source_backed": True,
                "broker_demand_eligible": True,
                "house_requirement": "headline_anchor" if metric_id == "ebit" else "required",
                "allowed_authorities": ["selected_broker", "historical_inference"],
                "definition_signature_sha256": "c" * 64,
                "consumer_ids": [f"forecast_authority.{metric_id}.{period_end}"],
            })
    body = {
        "schema_version": "pre-broker-model-demand/2.0",
        "run_id": "broker_demand_selection_v2",
        "as_of": "2026-12-31",
        "reporting_currency": "USD",
        "units": "millions",
        "forecast_periods": FORECAST_PERIODS,
        "ontology_sha256": "d" * 64,
        "nodes": nodes,
        "counts": {
            "source_rows": len(labels),
            "filed_forecast_nodes": 0,
            "model_demand_concepts": len(labels),
            "model_demand_nodes": len(nodes),
            "material_model_demand_nodes": len(nodes),
        },
    }
    return {**body, "graph_sha256": canonical_hash(body)}


def context(labels: list[str]) -> dict[str, Any]:
    return {
        "as_of": "2026-12-31",
        "reporting_currency": "USD",
        "units": "millions",
        "forecast_periods": FORECAST_PERIODS,
        "model_demand_graph": demand_graph(labels),
    }


def context_v2(labels: list[str]) -> dict[str, Any]:
    return {
        "as_of": "2026-12-31",
        "reporting_currency": "USD",
        "units": "millions",
        "forecast_periods": FORECAST_PERIODS,
        "model_demand_graph": demand_graph_v2(labels),
    }


def bundle(root: Path, *, conflicting_house: bool = False) -> dict[str, Any]:
    artifacts = root / "artifacts"
    artifacts.mkdir(parents=True)
    documents = []
    for house_id in ("alpha", "bravo", "charlie"):
        rows = copy.deepcopy(ROWS)
        if conflicting_house and house_id == "bravo":
            rows.append(["Revenue", "999", "999", "999"])
        document = build_house(
            document_id=house_id,
            house_id=house_id,
            house_name=house_id.title(),
            artifact_root=artifacts,
            vision_required=False,
            clean_rows=rows,
        )
        # Keep this deterministic selection fixture exactly on the production
        # freshness boundary: 180 days before the 2026-12-31 model as-of date.
        document["published_date"] = "2026-07-04"
        documents.append(document)
    result = {
        "schema_version": "broker-extraction-bundle/1.0",
        "run_id": "broker_demand_selection",
        "documents": documents,
        "summary": {},
        "gate_status": "PASS",
        "findings": [],
    }
    result, _ = canonicalise_bundle(result)
    for document in result["documents"]:
        document["tables"] = copy.deepcopy(document["canonical_tables"])
    result["candidate_manifest"] = compile_manifest(result, source_bundle_sha256="a" * 64)
    return result


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    checks = 0
    labels = [row[0] for row in ROWS[1:]]
    with tempfile.TemporaryDirectory(prefix="broker-demand-selection-") as temporary:
        root = Path(temporary)
        source = bundle(root)
        source_sha = canonical_hash(source)
        crosswalk, receipt = compile_demand_selected_crosswalk(
            source, context(labels), bundle_sha256=source_sha,
        )
        check(receipt["status"] == "PASS", "selection receipt did not pass"); checks += 1
        check(receipt["selected_mapping_count"] == 72, "three houses x eight metrics x three periods were not selected"); checks += 1
        check(set(receipt["active_metric_ids"]) == {
            "revenue", "ebit", "depreciation_and_amortisation", "effective_tax_rate",
            "capex", "change_in_working_capital", "dividends", "share_buybacks",
        }, "active metric inventory differs"); checks += 1
        report = verify(source, crosswalk, bundle_sha256=source_sha)
        check(report["status"] == "PASS" and report["total_violation_count"] == 0, "independent semantic verifier rejected selection"); checks += 1
        capex = [item for item in crosswalk["mappings"] if item["metric_id"] == "capex"]
        check(capex and all(item["sources"][0]["coefficient"] == -1 for item in capex), "positive capex magnitude was not normalized to model outflow sign"); checks += 1
        wc = [item for item in crosswalk["mappings"] if item["metric_id"] == "change_in_working_capital"]
        check(wc and all(item["sources"][0]["coefficient"] == 1 for item in wc), "working-capital cash signs were not preserved"); checks += 1

        bundle_path = root / "bundle.json"
        crosswalk_path = root / "crosswalk.json"
        bundle_path.write_bytes(canonical_bytes(source))
        crosswalk_path.write_bytes(canonical_bytes(crosswalk))
        compiled = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("compile_broker_pack.py")),
             str(bundle_path), str(crosswalk_path), "--out", str(root / "pack")],
            text=True, capture_output=True, check=False,
        )
        check(compiled.returncode == 0, f"real broker pack compiler rejected selection: {compiled.stderr or compiled.stdout}"); checks += 1
        pack = json.loads((root / "pack" / "broker-pack.json").read_text("utf-8"))
        check(pack["recommended_primary_house_id"] == "alpha", "deterministic primary house was not selected"); checks += 1

        v2_crosswalk, v2_receipt = compile_demand_selected_crosswalk(
            source, context_v2(labels), bundle_sha256=source_sha,
        )
        check(v2_receipt["status"] == "PASS", "fresh v2 demand did not reach selected broker authority"); checks += 1
        check(len(v2_crosswalk["mappings"]) == 72, "v2 demand selected a different broker surface from v1"); checks += 1

        limited, limited_receipt = compile_demand_selected_crosswalk(
            source, context([label for label in labels if label != "Share buybacks"]),
            bundle_sha256=source_sha,
        )
        check("share_buybacks" not in limited_receipt["active_metric_ids"], "undemanded broker concept became active"); checks += 1
        terminal_ids = {
            item["candidate_id"]
            for item in limited["terminal_recovery"]["quarantined_candidates"]
        }
        buyback_ids = {
            item["candidate_id"]
            for item in source["candidate_manifest"]["candidates"]
            if item["label"] == "Share buybacks"
        }
        check(buyback_ids <= terminal_ids, "undemanded source rows were not preserved in terminal evidence"); checks += 1

        conflict_root = root / "conflict"
        conflict_source = bundle(conflict_root, conflicting_house=True)
        conflict_crosswalk, conflict_receipt = compile_demand_selected_crosswalk(
            conflict_source, context(labels), bundle_sha256=canonical_hash(conflict_source),
        )
        check(
            not any(item["house_id"] == "bravo" and item["metric_id"] == "revenue" for item in conflict_crosswalk["mappings"]),
            "conflicting same-house revenue rows were consumed",
        ); checks += 1
        check(
            any(item["reason"] == "same_house_metric_rows_conflict" for item in conflict_receipt["rejected_candidates"]),
            "conflicting duplicate did not produce a bounded rejection reason",
        ); checks += 1
        conflict_report = verify(conflict_source, conflict_crosswalk, bundle_sha256=canonical_hash(conflict_source))
        check(conflict_report["status"] == "PASS", "cell-local duplicate fallback broke semantic closure"); checks += 1

        no_units = copy.deepcopy(source)
        for candidate in no_units["candidate_manifest"]["candidates"]:
            candidate["units"] = None
        # Re-seal the intentionally modified manifest so this is an authority
        # scenario, not a manifest-tamper mutation.
        no_units["candidate_manifest"].pop("manifest_sha256", None)
        no_units["candidate_manifest"]["manifest_sha256"] = canonical_hash(no_units["candidate_manifest"])
        no_units_crosswalk, no_units_receipt = compile_demand_selected_crosswalk(
            no_units, context(labels), bundle_sha256=canonical_hash(no_units),
        )
        check(no_units_receipt["active_metric_ids"] == ["effective_tax_rate"], "missing currency units did not contain authority to percent-only values"); checks += 1
        check(len(no_units_crosswalk["mappings"]) == 9, "percent-only fallback has wrong mapping count"); checks += 1

        bad_context = context(labels)
        bad_context["model_demand_graph"]["graph_sha256"] = "0" * 64
        try:
            compile_demand_selected_crosswalk(source, bad_context, bundle_sha256=source_sha)
        except ValueError as error:
            check("graph hash" in str(error), "tampered demand graph failed at the wrong contract"); checks += 1
        else:
            raise AssertionError("tampered demand graph was accepted")

    print(json.dumps({"status": "PASS", "checks": checks, "violations": 0}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
