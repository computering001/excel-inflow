#!/usr/bin/env python3
"""Prove that a filing-sparse demand graph still requests the core broker surface."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "broker_extractor", HERE / "extract_broker_evidence.py"
)
assert SPEC and SPEC.loader
broker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(broker)

periods = ["2026-12-31", "2027-12-31", "2028-12-31"]
labels = [("revenue", "Revenue"), ("ebit", "EBIT"), ("dividends", "Dividends")]
nodes = [
    {
        "node_id": f"{metric}.fy{index + 1}",
        "section": "cash_flow" if metric == "dividends" else "income_statement",
        "source_line_id": f"source.{metric}",
        "label": label,
        "parent_label": None,
        "period_end": period,
        "material": True,
        "has_historical_value": True,
        "allowed_authorities": ["selected_broker", "historical_inference"],
        "definition_signature_sha256": hashlib.sha256(metric.encode()).hexdigest(),
    }
    for metric, label in labels
    for index, period in enumerate(periods)
]
body = {
    "schema_version": "pre-broker-model-demand/1.0",
    "run_id": "tier1_demand_test",
    "as_of": "2025-12-31",
    "reporting_currency": "USD",
    "units": "millions",
    "forecast_periods": periods,
    "nodes": nodes,
    "counts": {
        "source_rows": len(labels),
        "forecast_nodes": len(nodes),
        "material_nodes": len(nodes),
    },
}
body["graph_sha256"] = hashlib.sha256(
    (json.dumps({k: v for k, v in body.items() if k != "graph_sha256"}, sort_keys=True, separators=(",", ":")) + "\n").encode()
).hexdigest()
context = {
    "as_of": body["as_of"],
    "reporting_currency": body["reporting_currency"],
    "units": body["units"],
    "forecast_periods": periods,
    "model_demand_graph": body,
}
compiled = broker.compile_broker_demand_contract(context)
closed = broker.ensure_core_broker_demand_contract(compiled)
metric_ids = {
    str(target.get("metric_id") or target.get("concept_id") or "")
    for target in closed.get("targets", [])
}
required = {
    "revenue",
    "ebit",
    "adjusted_ebitda",
    "depreciation_and_amortisation",
    "effective_tax_rate",
    "capex",
    "change_in_working_capital",
    "dividends",
}
assert required <= metric_ids, sorted(required - metric_ids)
assert len(closed["targets"]) == len({
    str(target.get("metric_id") or target.get("concept_id") or target)
    for target in closed["targets"]
})
source = (HERE / "extract_broker_evidence.py").read_text("utf-8")
assert "ensure_core_broker_demand_contract(" in source
assert "compile_broker_demand_contract(request.get(\"model_context\") or {})" in source
print({"status": "PASS", "required_metrics": sorted(required)})
