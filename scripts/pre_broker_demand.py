#!/usr/bin/env python3
"""Version-aware pre-broker demand reader with one canonical node form."""

from __future__ import annotations

import hashlib
import json
from typing import Any


CANONICAL_PRE_BROKER_DEMAND_VERSION = "canonical-pre-broker-demand/1.0"
SUPPORTED_SOURCE_VERSIONS = {
    "pre-broker-model-demand/1.0",
    "pre-broker-model-demand/2.0",
}

LEGACY_METRIC_ALIASES = {
    "revenue": "revenue", "revenues": "revenue", "turnover": "revenue",
    "ebit": "ebit", "adjusted ebitda": "adjusted_ebitda", "ebitda": "adjusted_ebitda",
    "depreciation and amortisation": "depreciation_and_amortisation",
    "depreciation and amortization": "depreciation_and_amortisation",
    "effective tax rate": "effective_tax_rate", "capex": "capex",
    "capital expenditure": "capex", "change in working capital": "change_in_working_capital",
    "dividends": "dividends", "dividends paid": "dividends",
    "share buybacks": "share_buybacks", "share repurchases": "share_buybacks",
}


def _legacy_metric_id(node: dict[str, Any]) -> str | None:
    label = " ".join(str(node.get("label") or "").lower().replace("_", " ").split())
    if label in LEGACY_METRIC_ALIASES:
        return LEGACY_METRIC_ALIASES[label]
    prefix = str(node.get("node_id") or "").split(".", 1)[0]
    return LEGACY_METRIC_ALIASES.get(prefix.replace("_", " "))


def canonical_hash(value: Any) -> str:
    encoded = (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def normalize_pre_broker_demand(graph: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(graph, dict):
        raise ValueError("Pre-broker demand graph is absent.")
    source_version = graph.get("schema_version")
    if source_version not in SUPPORTED_SOURCE_VERSIONS:
        raise ValueError(f"Unsupported pre-broker demand version {source_version or '<missing>'}.")
    body = {key: value for key, value in graph.items() if key != "graph_sha256"}
    if graph.get("graph_sha256") != canonical_hash(body):
        raise ValueError("Pre-broker demand has a stale canonical graph hash.")
    forecast_periods = list(graph.get("forecast_periods") or [])
    if len(forecast_periods) != 3:
        raise ValueError("Pre-broker demand requires exactly three forecast periods.")
    v2 = source_version == "pre-broker-model-demand/2.0"
    nodes: list[dict[str, Any]] = []
    for node in graph.get("nodes") or []:
        source_line_id = node.get("source_line_id")
        allowed_authorities = list(node.get("allowed_authorities") or [])
        nodes.append({
            "node_id": str(node.get("node_id") or ""),
            "node_kind": str(node.get("node_kind") or "model_demand") if v2 else "model_demand",
            "section": str(node.get("section") or ""),
            "source_line_ids": [str(source_line_id)] if source_line_id else [],
            "metric_id": str(node.get("metric_id")) if v2 and node.get("metric_id") else _legacy_metric_id(node),
            "label": str(node.get("label") or ""),
            "period_end": str(node.get("period_end") or ""),
            "material": node.get("material") is not False,
            "broker_demand_eligible": (
                node.get("broker_demand_eligible") is True
                if v2
                else "selected_broker" in allowed_authorities
            ),
            "allowed_authorities": allowed_authorities,
            "definition_signature_sha256": str(node.get("definition_signature_sha256") or ""),
            "consumer_ids": sorted(str(value) for value in (node.get("consumer_ids") or [])) if v2 else [str(node.get("node_id") or "")],
        })
    nodes.sort(key=lambda item: item["node_id"])
    return {
        "schema_version": CANONICAL_PRE_BROKER_DEMAND_VERSION,
        "source_schema_version": source_version,
        "effective_schema_version": "pre-broker-model-demand/2.0",
        "migration_status": "native_v2" if v2 else "migrated_v1_to_v2",
        "source_graph_sha256": graph["graph_sha256"],
        "run_id": str(graph.get("run_id") or ""),
        "forecast_periods": forecast_periods,
        "reporting_currency": str(graph.get("reporting_currency") or ""),
        "units": str(graph.get("units") or ""),
        "nodes": nodes,
    }
