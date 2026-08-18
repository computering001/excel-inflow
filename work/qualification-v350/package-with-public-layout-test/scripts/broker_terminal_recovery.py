#!/usr/bin/env python3
"""Seal non-consumed broker findings without weakening selected-cell authority.

This module makes no visual judgment and authors no value. It proves the
negative-consumption fact from mappings and immutable source cells. The model
host must still explicitly review every recoverable candidate. A cell that is
actually mapped remains a hard broker-authority blocker; a merely potential
core driver may be quarantined and made unavailable so the company forecast
waterfall can select a different, evidenced authority. Global source-integrity
findings remain blockers because they are not safely localisable to one cell.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

from broker_numeric import parse_broker_number


MAPPED_DISPOSITIONS = {"mapped_metric", "mapped_guidance"}
SELECTED_MODEL_USES = {"active_input", "derived_input"}
MODEL_PERIOD_BASES = {"annual_forecast", "partial_period", "unresolved_period_header"}


def normalized_label(value: Any) -> str:
    text = str(value or "").casefold().replace("&", " and ")
    tokens = re.sub(r"[^a-z0-9]+", " ", text).split()
    source_decorations = {
        "usd", "gbp", "eur", "jpy", "chf", "usdm", "gbpm", "eurm", "jpym", "chfm",
        "usdmn", "gbpmn", "eurmn", "m", "mm", "mn", "bn",
        "million", "millions", "billion", "billions", "reported", "forecast",
    }
    while tokens and tokens[-1] in source_decorations:
        tokens.pop()
    return " ".join(tokens)


def core_driver_labels() -> set[str]:
    """Derive potential model drivers from the canonical metric dictionary.

    The dictionary tier is the authority; this module does not maintain a
    second regex vocabulary. Counter-examples are deliberately excluded, so a
    product-level sales row cannot become a blocker merely because it contains
    the word sales.
    """
    dictionary_path = Path(__file__).resolve().parent.parent / "assets" / "broker-metric-dictionary.json"
    dictionary = json.loads(dictionary_path.read_text("utf-8"))
    if dictionary.get("schema_version") != "broker-metric-dictionary/1.0":
        raise ValueError("Terminal recovery requires broker-metric-dictionary/1.0.")
    core_ids = set((dictionary.get("consumption") or {}).get("core") or [])
    labels: set[str] = set()
    for metric in dictionary.get("metrics") or []:
        if metric.get("id") not in core_ids:
            continue
        for value in [metric.get("display_label"), *(metric.get("examples") or [])]:
            label = normalized_label(value)
            if label:
                labels.add(label)
    return labels


CORE_DRIVER_LABELS = core_driver_labels()


def _metric_dictionary() -> dict[str, Any]:
    path = Path(__file__).resolve().parent.parent / "assets" / "broker-metric-dictionary.json"
    value = json.loads(path.read_text("utf-8"))
    if value.get("schema_version") != "broker-metric-dictionary/1.0":
        raise ValueError("Demand-selected broker mapping requires broker-metric-dictionary/1.0.")
    return value


def _auto_exact_aliases(dictionary: dict[str, Any]) -> dict[str, str]:
    """Return only unambiguous exact aliases for core concepts.

    This is intentionally not fuzzy semantic classification.  The immutable
    source row and a filings-derived model-demand row must independently land
    on the same exact dictionary alias before the controller may propose it.
    """
    core = set((dictionary.get("consumption") or {}).get("core") or [])
    by_alias: dict[str, set[str]] = {}
    for metric in dictionary.get("metrics") or []:
        metric_id = str(metric.get("id") or "")
        if metric_id not in core:
            continue
        counter = {
            normalized_label(value)
            for value in metric.get("counter_examples") or []
            if normalized_label(value)
        }
        for value in [metric.get("display_label"), *(metric.get("examples") or [])]:
            alias = normalized_label(value)
            if alias and alias not in counter:
                by_alias.setdefault(alias, set()).add(metric_id)
    return {
        alias: next(iter(metric_ids))
        for alias, metric_ids in by_alias.items()
        if len(metric_ids) == 1
    }


def compile_broker_demand_contract(model_context: dict[str, Any]) -> dict[str, Any]:
    """Compile the only concepts/periods broker recovery is allowed to inspect.

    This contract is deliberately a *discovery* boundary, not semantic
    authority.  Dictionary examples may be used to find a potentially useful
    row, but the later selected-cell crosswalk still has to prove the exact
    immutable row, periods, units and values independently.  Keeping this
    small contract upstream of OCR prevents the archive census from becoming
    an instruction to transcribe an entire research pack.
    """
    graph = model_context.get("model_demand_graph") if isinstance(model_context, dict) else None
    if not isinstance(graph, dict) or graph.get("schema_version") != "pre-broker-model-demand/1.0":
        raise ValueError("Broker recovery requires pre-broker-model-demand/1.0.")
    graph_body = {key: value for key, value in graph.items() if key != "graph_sha256"}
    if graph.get("graph_sha256") != canonical_hash(graph_body):
        raise ValueError("Pre-broker model-demand graph hash does not match its payload.")
    forecast_periods = list(model_context.get("forecast_periods") or [])
    if graph.get("forecast_periods") != forecast_periods or len(forecast_periods) != 3:
        raise ValueError("Broker demand contract requires the graph's three forecast periods.")

    dictionary = _metric_dictionary()
    aliases = _auto_exact_aliases(dictionary)
    demanded: dict[str, set[str]] = {}
    for node in graph.get("nodes") or []:
        if "selected_broker" not in (node.get("allowed_authorities") or []):
            continue
        label = normalized_label(node.get("label"))
        metric_id = aliases.get(label)
        if metric_id:
            demanded.setdefault(metric_id, set()).add(label)

    discovery_by_metric: dict[str, set[str]] = {metric_id: set() for metric_id in demanded}
    for alias, metric_id in aliases.items():
        if metric_id in discovery_by_metric:
            discovery_by_metric[metric_id].add(alias)
    targets = [
        {
            "metric_id": metric_id,
            "demand_labels": sorted(demanded[metric_id]),
            "discovery_aliases": sorted(discovery_by_metric[metric_id]),
            "forecast_periods": forecast_periods,
        }
        for metric_id in sorted(demanded)
    ]
    body = {
        "schema_version": "broker-selected-cell-demand/1.0",
        "model_demand_graph_sha256": graph["graph_sha256"],
        "forecast_periods": forecast_periods,
        "targets": targets,
    }
    return {**body, "contract_sha256": canonical_hash(body)}


def _period_year(label: Any, forecast_years: list[int]) -> int | None:
    text = re.sub(r"\s+", "", str(label or "").upper())
    for year in forecast_years:
        short = str(year)[-2:]
        if (
            re.search(rf"(?<!\d){year}[EFA]?(?!\d)", text)
            or re.search(rf"(?<![A-Z0-9])(?:FY|CY)'?{short}[EFA]?(?!\d)", text)
            or re.search(rf"(?<!\d)'{short}[EFA]?(?!\d)", text)
            or re.search(rf"(?:FY|CY)?(?:19|20)?\d{{2}}/{short}[EFA]?(?!\d)", text)
        ):
            return year
    return None


def _candidate_period_columns(
    candidate: dict[str, Any], forecast_periods: list[str]
) -> dict[int, int]:
    years = [int(str(value)[:4]) for value in forecast_periods]
    result: dict[int, int] = {}
    for item in candidate.get("period_indexes") or []:
        if not isinstance(item, dict) or item.get("period_kind") != "annual":
            continue
        year = _period_year(item.get("period_label"), years)
        if year not in years:
            continue
        column = int(item.get("column") or 0)
        if column > 0:
            result[years.index(year)] = column
    return result


def _unit_scale(value: Any) -> tuple[str | None, str | None]:
    text = re.sub(r"[^a-z0-9%£$€¥]+", "", str(value or "").casefold())
    currency = next((code for code in ("usd", "gbp", "eur", "jpy", "chf") if code in text), None)
    if any(token in text for token in ("billion", "billions", "bn")):
        scale = "billions"
    elif any(token in text for token in ("million", "millions", "mio", "mn", "mm")) or re.search(r"(?:usd|gbp|eur|jpy|chf|[$£€¥])m$", text):
        scale = "millions"
    elif any(token in text for token in ("thousand", "thousands")) or text.endswith("k"):
        scale = "thousands"
    elif text in {"units", "unit"}:
        scale = "units"
    else:
        scale = None
    return currency.upper() if currency else None, scale


def _unit_multiplier(
    candidate: dict[str, Any], metric: dict[str, Any], model_context: dict[str, Any]
) -> float | None:
    if metric.get("unit_class") == "percent":
        return 1.0
    source_currency, source_scale = _unit_scale(candidate.get("units"))
    target_currency = str(model_context.get("reporting_currency") or "")
    target_scale = str(model_context.get("units") or "")
    if source_currency and source_currency != target_currency:
        return None
    factors = {"units": 1.0, "thousands": 1_000.0, "millions": 1_000_000.0, "billions": 1_000_000_000.0}
    if source_scale not in factors or target_scale not in factors:
        return None
    return factors[source_scale] / factors[target_scale]


def _bundle_tables(bundle: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(table.get("canonical_table_id") or table.get("table_id") or ""): table
        for document in bundle.get("documents") or []
        for table in (document.get("canonical_tables") or document.get("tables") or [])
    }


def _cell_numeric(table: dict[str, Any], row: int, column: int) -> float | None:
    try:
        value = table["rows"][row - 1][column - 1].get("value")
    except (IndexError, KeyError, TypeError):
        return None
    return parse_broker_number(value)


def _metric_axes(metric: dict[str, Any]) -> tuple[str, str]:
    metric_id = str(metric.get("id") or "")
    if metric_id == "effective_tax_rate":
        return "tax", "tax"
    if metric.get("statement_family") == "cash_flow":
        return "cash_flow", "cash_flow_forecast"
    return "operating", "operating_forecast"


def compile_demand_selected_crosswalk(
    bundle: dict[str, Any],
    model_context: dict[str, Any],
    *,
    bundle_sha256: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Compile a conservative selected-cell crosswalk from sealed demand.

    Only an exact dictionary alias present independently in the immutable
    broker row and the filings-derived demand graph is eligible.  Ambiguous
    duplicates, units, signs or periods are not guessed; they remain sealed in
    terminal non-consumption and the normal forecast waterfall continues.
    """
    graph = model_context.get("model_demand_graph") if isinstance(model_context, dict) else None
    if not isinstance(graph, dict) or graph.get("schema_version") != "pre-broker-model-demand/1.0":
        raise ValueError("Demand-selected broker mapping requires pre-broker-model-demand/1.0.")
    graph_body = {key: value for key, value in graph.items() if key != "graph_sha256"}
    if graph.get("graph_sha256") != canonical_hash(graph_body):
        raise ValueError("Pre-broker model-demand graph hash does not match its payload.")
    forecast_periods = list(model_context.get("forecast_periods") or [])
    if graph.get("forecast_periods") != forecast_periods:
        raise ValueError("Pre-broker model demand and broker forecast periods differ.")

    demand_contract = compile_broker_demand_contract(model_context)
    dictionary = _metric_dictionary()
    metrics_by_id = {str(item.get("id")): item for item in dictionary.get("metrics") or []}
    aliases = _auto_exact_aliases(dictionary)
    demanded_metric_ids = {
        str(item["metric_id"]) for item in demand_contract.get("targets") or []
    }
    shell = compile_reference_only_crosswalk(bundle, model_context)
    candidates = candidate_index(bundle)
    tables = _bundle_tables(bundle)
    proposals: dict[tuple[str, str], list[dict[str, Any]]] = {}
    rejected: list[dict[str, Any]] = []
    for candidate_id, candidate in sorted(candidates.items()):
        metric_id = aliases.get(normalized_label(candidate.get("label")))
        if not metric_id or metric_id not in demanded_metric_ids:
            continue
        if (
            candidate.get("authority_status") != "verified"
            or candidate.get("period_basis") != "annual_forecast"
            or not candidate.get("numeric")
        ):
            rejected.append({"candidate_id": candidate_id, "reason": "candidate_not_verified_annual_numeric"})
            continue
        metric = metrics_by_id[metric_id]
        multiplier = _unit_multiplier(candidate, metric, model_context)
        if multiplier is None:
            rejected.append({"candidate_id": candidate_id, "reason": "source_units_not_model_compatible"})
            continue
        period_columns = _candidate_period_columns(candidate, forecast_periods)
        table = tables.get(str(candidate.get("table_id") or ""))
        values = {
            period_index: _cell_numeric(table, int(candidate.get("row") or 0), column)
            for period_index, column in period_columns.items()
        } if table else {}
        if not values or any(value is None for value in values.values()):
            rejected.append({"candidate_id": candidate_id, "reason": "period_cell_not_unambiguously_numeric"})
            continue
        sign_convention = "as_reported"
        if metric_id in {"capex", "dividends", "share_buybacks"}:
            nonzero_signs = {1 if float(value) > 0 else -1 for value in values.values() if abs(float(value)) > 1e-12}
            if len(nonzero_signs) > 1:
                rejected.append({"candidate_id": candidate_id, "reason": "outflow_row_has_mixed_signs"})
                continue
            if nonzero_signs == {1}:
                multiplier *= -1.0
            sign_convention = "outflow_negative"
        # Change in working capital is already defined as the published cash
        # movement, so its sign is preserved exactly as reported.  Unlike
        # capex/dividends/buybacks there is no lawful magnitude-to-outflow
        # conversion: a positive release and a negative investment are both
        # economically meaningful observations.
        normalized_values = {
            period_index: round(float(value) * multiplier, 12)
            for period_index, value in values.items()
        }
        proposals.setdefault((str(candidate.get("house_id") or ""), metric_id), []).append({
            "candidate": candidate,
            "period_columns": period_columns,
            "values": normalized_values,
            "multiplier": multiplier,
            "sign_convention": sign_convention,
        })

    selected: list[dict[str, Any]] = []
    for (_house_id, _metric_id), group in sorted(proposals.items()):
        conflict = False
        for left_index, left in enumerate(group):
            for right in group[left_index + 1:]:
                overlap = set(left["values"]) & set(right["values"])
                if any(abs(left["values"][index] - right["values"][index]) > 1e-9 for index in overlap):
                    conflict = True
        if conflict:
            rejected.extend({
                "candidate_id": item["candidate"]["candidate_id"],
                "reason": "same_house_metric_rows_conflict",
            } for item in group)
            continue
        occupied: set[int] = set()
        for item in sorted(
            group,
            key=lambda value: (-len(value["period_columns"]), str(value["candidate"]["candidate_id"])),
        ):
            available = set(item["period_columns"]) - occupied
            if not available:
                rejected.append({
                    "candidate_id": item["candidate"]["candidate_id"],
                    "reason": "exact_duplicate_candidate_not_selected",
                })
                continue
            item["selected_periods"] = sorted(available)
            selected.append(item)
            occupied.update(available)

    ledger: list[dict[str, Any]] = []
    mappings: list[dict[str, Any]] = []
    active_metric_ids: set[str] = set()
    selected_candidate_ids: set[str] = set()
    for item in selected:
        candidate = item["candidate"]
        candidate_id = str(candidate["candidate_id"])
        metric_id = aliases[normalized_label(candidate.get("label"))]
        metric = metrics_by_id[metric_id]
        domain, semantic_role = _metric_axes(metric)
        active_metric_ids.add(metric_id)
        selected_candidate_ids.add(candidate_id)
        mapping_ids = []
        for period_index in item["selected_periods"]:
            mapping_id = re.sub(
                r"[^a-z0-9_.-]+", ".",
                f"auto.{candidate.get('house_id')}.{metric_id}.{period_index}.{candidate_id[-8:]}".casefold(),
            ).strip(".")
            mapping_ids.append(mapping_id)
            mappings.append({
                "mapping_id": mapping_id,
                "house_id": candidate.get("house_id"),
                "metric_id": metric_id,
                "definition_id": f"dict.{metric_id}",
                "period_index": period_index,
                "sources": [{
                    "table_id": candidate.get("table_id"),
                    "row": int(candidate.get("row") or 0),
                    "column": int(item["period_columns"][period_index]),
                    "coefficient": float(item["multiplier"]),
                }],
                "rationale": "Exact demanded broker row and forecast-period cell selected by the bounded controller.",
                "review_status": "auto_exact",
            })
        fingerprint = {
            "concept_id": metric_id,
            "measurement_basis": "adjusted" if metric_id.startswith("adjusted_") else "reported",
            "restatement_basis": "not_applicable",
            "cash_flow_basis": "cash_flow" if domain == "cash_flow" else "not_applicable",
            "lease_basis": "not_applicable",
            "units": model_context["units"],
            "currency": model_context["reporting_currency"],
            "period_basis": "annual_forecast",
            "sign_convention": item["sign_convention"],
            "accounting_basis": "ifrs",
            "operating_scope": "continuing",
        }
        ledger.append({
            "candidate_id": candidate_id,
            "house_id": candidate.get("house_id"),
            "table_id": candidate.get("table_id"),
            "row": int(candidate.get("row") or 0),
            "label": candidate.get("label"),
            "period_basis": "annual_forecast",
            "period_indexes": sorted(item["period_columns"]),
            "source_cells": [
                {"row": int(cell.get("row") or 0), "column": int(cell.get("column") or 0)}
                for cell in candidate.get("source_cells") or []
            ],
            "parent_candidate_id": candidate.get("parent_candidate_id"),
            "economic_domain": domain,
            "definition_id": f"dict.{metric_id}",
            "concept_id": metric_id,
            "model_use": "active_input",
            "definition_fingerprint": fingerprint,
            "evidence_kind": "broker_estimate",
            "definition_evidence": (
                "Exact immutable source-row label, compatible table units and explicit annual headers "
                "match a filings-derived model-demand concept."
            ),
            "review_status": "reviewed",
            "rationale": "Controller selected only exact demanded cells; unresolved periods retain the ordinary waterfall.",
            "disposition": "mapped_metric",
            "metric_id": metric_id,
            "mapping_ids": mapping_ids,
        })
        shell["metrics"][metric_id].update({
            "economic_domain": domain,
            "semantic_role": semantic_role,
            "concept_id": metric_id,
            "evidence_kind": "broker_estimate",
            "model_use": "active_input",
            "definition_fingerprint": fingerprint,
            "sign_convention": item["sign_convention"],
        })

    shell["coverage_ledger"] = ledger
    shell["mappings"] = mappings
    unselected_ids = sorted(set(candidates) - selected_candidate_ids)
    if unselected_ids:
        synthetic = {
            "schema_version": "broker-semantic-verification-report/1.0",
            "status": "BLOCKED",
            "total_violation_count": len(unselected_ids),
            "candidate_manifest_sha256": canonical_hash(bundle.get("candidate_manifest")),
            "crosswalk_sha256": canonical_hash(shell),
            "candidate_count": len(candidates),
            "coverage_entry_count": len(ledger),
            "terminal_quarantined_candidate_count": 0,
            "unresolved_selected_candidate_count": 0,
            "findings": [{
                "code": "AUTO-EXACT-NOT-SELECTED",
                "candidate_id": candidate_id,
                "message": "Candidate is preserved but was not safe for deterministic selected-cell authority.",
            } for candidate_id in unselected_ids],
        }
        synthetic_sha = canonical_hash(synthetic)
        review = automatic_negative_consumption_review(
            bundle=bundle,
            crosswalk_sha256=canonical_hash(shell),
            semantic_report_sha256=synthetic_sha,
            semantic_report=synthetic,
            bundle_sha256=bundle_sha256,
        )
        review["producer_id"] = "broker-controller-demand-selected/1.0"
        shell, terminal_receipt = apply_terminal_review(
            bundle=bundle,
            crosswalk=shell,
            semantic_report=synthetic,
            review=review,
            bundle_sha256=bundle_sha256,
            crosswalk_sha256=canonical_hash(shell),
            semantic_report_sha256=synthetic_sha,
        )
    else:
        terminal_receipt = None
    receipt = {
        "schema_version": "broker-demand-selected-crosswalk-receipt/1.0",
        "status": "PASS",
        "model_demand_graph_sha256": graph["graph_sha256"],
        "bundle_sha256": bundle_sha256,
        "selected_crosswalk_sha256": canonical_hash(shell),
        "selected_candidate_count": len(selected_candidate_ids),
        "selected_mapping_count": len(mappings),
        "active_metric_ids": sorted(active_metric_ids),
        "rejected_candidates": sorted(rejected, key=lambda value: (value["candidate_id"], value["reason"])),
        "terminal_recovery": terminal_receipt,
    }
    return shell, receipt


def compile_reference_only_crosswalk(
    bundle: dict[str, Any], model_context: dict[str, Any]
) -> dict[str, Any]:
    """Compile the controller-owned no-consumption crosswalk shell.

    The function makes no semantic claim about a source row. It declares the
    canonical metric vocabulary, records each table's observed period columns,
    and leaves every candidate for the terminal zero-authority quarantine.
    """
    required_context = {"as_of", "reporting_currency", "units", "forecast_periods"}
    if not isinstance(model_context, dict) or not required_context.issubset(model_context):
        raise ValueError("Reference-only broker fallback requires complete model_context.")
    forecast_periods = list(model_context.get("forecast_periods") or [])
    if len(forecast_periods) != 3:
        raise ValueError("Reference-only broker fallback requires exactly three forecast periods.")
    forecast_years = [int(str(value)[:4]) for value in forecast_periods]

    manifest_candidates = list((bundle.get("candidate_manifest") or {}).get("candidates") or [])
    candidates_by_table: dict[str, list[dict[str, Any]]] = {}
    for candidate in manifest_candidates:
        candidates_by_table.setdefault(str(candidate.get("table_id") or ""), []).append(candidate)

    table_reviews: list[dict[str, Any]] = []
    for document in bundle.get("documents") or []:
        for table in document.get("tables") or []:
            table_id = str(table.get("canonical_table_id") or table.get("table_id") or "")
            period_cells: dict[tuple[int, str], str] = {}
            for candidate in candidates_by_table.get(table_id, []):
                basis = str(candidate.get("period_basis") or "")
                if basis not in {"annual_forecast", "partial_period"}:
                    continue
                for item in candidate.get("period_indexes") or []:
                    column = int(item.get("column") or 0)
                    if column > 0:
                        period_cells[(column, basis)] = str(item.get("period_label") or "")
            period_columns = []
            for (column, basis), label in sorted(period_cells.items()):
                year = _period_year(label, forecast_years)
                # A table review declares only columns that can participate in
                # this run's three forecast periods. Historical and terminal
                # columns remain in the immutable table but are not false
                # forecast declarations requiring an invented period_index.
                if year not in forecast_years:
                    continue
                value: dict[str, Any] = {
                    "column": column,
                    "period_basis": basis,
                    "period_index": forecast_years.index(year),
                }
                if label:
                    value["period_label"] = label
                period_columns.append(value)
            bases = {item["period_basis"] for item in period_columns}
            classification = (
                "mixed" if len(bases) > 1 else
                next(iter(bases)) if bases else
                "non_forecast"
            )
            table_reviews.append({
                "table_id": table_id,
                "house_id": document.get("house_id"),
                "review_status": "reviewed",
                "rationale": (
                    "Table preserved in the broker archive; controller selected no row or cell for model use."
                ),
                "classification": classification,
                "header_rows": [1] if period_columns else [],
                "period_columns": period_columns,
            })

    dictionary_path = Path(__file__).resolve().parent.parent / "assets" / "broker-metric-dictionary.json"
    dictionary = json.loads(dictionary_path.read_text("utf-8"))
    metric_by_id = {str(item.get("id")): item for item in dictionary.get("metrics") or []}
    # Keep the complete core vocabulary available even when the final selected
    # set is sparse.  Declaration is not consumption; mappings below are the
    # only authority edges.  This lets an exact EBITDA or buyback row be used
    # without manufacturing a second crosswalk shape.
    required_ids = set((dictionary.get("consumption") or {}).get("core") or [])
    metrics: dict[str, dict[str, Any]] = {}
    for metric_id in sorted(required_ids):
        source = metric_by_id[metric_id]
        unit_class = str(source.get("unit_class") or "currency")
        unit_kind = "percent_decimal" if unit_class in {"percent", "percent_decimal"} else "currency"
        domain, semantic_role = _metric_axes(source)
        metrics[metric_id] = {
            "definition_id": f"dict.{metric_id}",
            "label": source.get("display_label") or metric_id.replace("_", " ").title(),
            "unit_kind": unit_kind,
            "concept_id": metric_id,
            "economic_domain": domain,
            "semantic_role": semantic_role,
            "evidence_kind": "broker_estimate",
            "model_use": "reference_only",
            "definition_fingerprint": {
                "concept_id": metric_id,
                "measurement_basis": "reported",
                "restatement_basis": "not_applicable",
                "cash_flow_basis": "not_applicable",
                "lease_basis": "not_applicable",
                "units": model_context["units"],
                "currency": model_context["reporting_currency"],
                "period_basis": "annual_forecast",
                "sign_convention": "as_reported",
                "accounting_basis": "ifrs",
                "operating_scope": "continuing",
            },
        }
    return {
        "schema_version": "broker-crosswalk/1.2",
        "run_id": bundle.get("run_id"),
        "as_of": model_context["as_of"],
        "reporting_currency": model_context["reporting_currency"],
        "units": model_context["units"],
        "forecast_periods": forecast_periods,
        "metrics": metrics,
        "table_reviews": table_reviews,
        "coverage_ledger": [],
        "mappings": [],
    }


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def bundle_authority_hash(bundle: dict[str, Any]) -> str:
    """Stable broker-authority identity, excluding paths and timestamps."""
    return canonical_hash({
        "schema_version": "broker-authority-content/1.0",
        "run_id": bundle.get("run_id"),
        "candidate_manifest_sha256": canonical_hash(bundle.get("candidate_manifest")),
    })


def candidate_index(bundle: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(candidate.get("candidate_id")): candidate
        for candidate in (bundle.get("candidate_manifest") or {}).get("candidates", [])
        if str(candidate.get("candidate_id") or "")
    }


def candidate_cells(candidate: dict[str, Any]) -> set[tuple[str, int, int]]:
    table_id = str(candidate.get("table_id") or "")
    return {
        (table_id, int(cell.get("row", 0)), int(cell.get("column", 0)))
        for cell in candidate.get("source_cells", [])
    }


def mapped_cells(crosswalk: dict[str, Any]) -> set[tuple[str, int, int]]:
    return {
        (str(source.get("table_id") or ""), int(source.get("row", 0)), int(source.get("column", 0)))
        for mapping in crosswalk.get("mappings", [])
        for source in mapping.get("sources", [])
    }


def selected_candidate_ids(bundle: dict[str, Any], crosswalk: dict[str, Any]) -> set[str]:
    """Return candidates the crosswalk actually attempts to consume.

    This is deliberately narrower than the potential-driver inventory below.
    Recovery is allowed only after the candidate is removed from every mapping
    and active ledger declaration.  Quarantining a potential Revenue/EBIT/etc.
    candidate is therefore safe: it cannot silently become model authority,
    while the forecast compiler remains free to choose company evidence,
    guidance, history or another verified broker cell.
    """
    candidates = candidate_index(bundle)
    consumed_cells = mapped_cells(crosswalk)
    selected: set[str] = set()
    for entry in crosswalk.get("coverage_ledger", []):
        candidate_id = str(entry.get("candidate_id") or "")
        if (
            entry.get("model_use") in SELECTED_MODEL_USES
            or entry.get("disposition") in MAPPED_DISPOSITIONS
            or bool(entry.get("mapping_ids"))
        ):
            selected.add(candidate_id)
    for candidate_id, candidate in candidates.items():
        if candidate_cells(candidate) & consumed_cells:
            selected.add(candidate_id)
    return selected


def potential_driver_candidate_ids(bundle: dict[str, Any]) -> set[str]:
    """Return immutable candidates whose absence can affect the model waterfall.

    Potential-driver status is disclosure metadata, never permission to consume
    a conflicted cell and never a reason to stop the whole company model.
    """
    return {
        candidate_id
        for candidate_id, candidate in candidate_index(bundle).items()
        if bool(candidate.get("numeric"))
        and candidate.get("period_basis") in MODEL_PERIOD_BASES
        and normalized_label(candidate.get("label")) in CORE_DRIVER_LABELS
    }


def analyse_terminal_recovery(
    bundle: dict[str, Any],
    crosswalk: dict[str, Any],
    semantic_report: dict[str, Any],
) -> dict[str, Any]:
    candidates = candidate_index(bundle)
    selected = selected_candidate_ids(bundle, crosswalk)
    potential = potential_driver_candidate_ids(bundle)
    recoverable: set[str] = set()
    blocking: list[dict[str, Any]] = []
    for finding in semantic_report.get("findings", []):
        candidate_id = str(finding.get("candidate_id") or "")
        if not candidate_id or candidate_id not in candidates:
            blocking.append({
                "code": finding.get("code"),
                "candidate_id": candidate_id or None,
                "reason": "global_or_unbound_source_integrity_finding",
            })
        elif candidate_id in selected:
            blocking.append({
                "code": finding.get("code"),
                "candidate_id": candidate_id,
                "reason": "selected_model_candidate_unresolved",
            })
        else:
            recoverable.add(candidate_id)
    return {
        "schema_version": "broker-terminal-recovery-analysis/1.0",
        "recoverable_candidate_ids": sorted(recoverable),
        "blocking_findings": blocking,
        "selected_candidate_ids": sorted(selected),
        "potential_driver_candidate_ids": sorted(potential),
        "recoverable_potential_driver_candidate_ids": sorted(recoverable & potential),
        "can_recover": bool(recoverable) and not blocking,
    }


def automatic_negative_consumption_review(
    *,
    bundle: dict[str, Any],
    crosswalk_sha256: str,
    semantic_report_sha256: str,
    semantic_report: dict[str, Any],
    bundle_sha256: str,
) -> dict[str, Any]:
    """Author the controller-owned terminal *non-consumption* decision.

    This is not OCR, semantic mapping or value authorship.  It is the finite
    fallback after the model host has exhausted its bounded attempts: every
    still-local candidate is preserved, prohibited from model use, and handed
    to the ordinary forecast waterfall as unavailable broker evidence.
    """
    candidate_ids = sorted({
        str(finding.get("candidate_id") or "")
        for finding in semantic_report.get("findings", [])
        if str(finding.get("candidate_id") or "")
    })
    return {
        "schema_version": "broker-terminal-materiality-review/1.0",
        "run_id": bundle.get("run_id"),
        "bundle_sha256": bundle_authority_hash(bundle),
        "candidate_manifest_sha256": canonical_hash(bundle.get("candidate_manifest")),
        "source_crosswalk_sha256": crosswalk_sha256,
        "semantic_report_sha256": semantic_report_sha256,
        "producer_id": "broker-controller-negative-consumption/1.0",
        "reviewed_at": None,
        "reviews": [
            {
                "candidate_id": candidate_id,
                "disposition": "preserve_unconsumed_quarantine",
                "model_consumption": "prohibited",
                "rationale": (
                    "Bounded internal recovery exhausted; preserve the raw candidate, "
                    "prohibit model consumption, and continue through the forecast waterfall."
                ),
            }
            for candidate_id in candidate_ids
        ],
    }


def degrade_finding_houses(
    *,
    bundle: dict[str, Any],
    crosswalk: dict[str, Any],
    semantic_report: dict[str, Any],
    bundle_sha256: str,
    source_crosswalk_sha256: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Remove only finding-owned houses from consumption, then seal evidence.

    This is the executable counterpart to "exclude Kepler/Berenberg".  It is
    intentionally negative-only: no mapping is created or rewritten, no value
    is changed, and no other house is touched.  A global/unbound finding cannot
    use this path because its impact cannot be localised safely.
    """
    candidates = candidate_index(bundle)
    findings = list(semantic_report.get("findings") or [])
    finding_candidate_ids = {
        str(item.get("candidate_id") or "") for item in findings
        if str(item.get("candidate_id") or "")
    }
    if not findings or any(
        not str(item.get("candidate_id") or "")
        or str(item.get("candidate_id") or "") not in candidates
        for item in findings
    ):
        raise ValueError("House-local fallback requires every semantic finding to bind one immutable candidate.")
    excluded_houses = sorted({
        str(candidates[candidate_id].get("house_id") or "")
        for candidate_id in finding_candidate_ids
    })
    if not excluded_houses or any(not house_id for house_id in excluded_houses):
        raise ValueError("House-local fallback could not resolve finding-owned houses.")
    excluded = set(excluded_houses)
    target_ids = sorted(
        candidate_id for candidate_id, candidate in candidates.items()
        if str(candidate.get("house_id") or "") in excluded
    )
    pruned = copy.deepcopy(crosswalk)
    removed_mapping_ids = {
        str(mapping.get("mapping_id") or "")
        for mapping in pruned.get("mappings", [])
        if str(mapping.get("house_id") or "") in excluded
    }
    pruned["mappings"] = [
        mapping for mapping in pruned.get("mappings", [])
        if str(mapping.get("house_id") or "") not in excluded
    ]
    pruned["coverage_ledger"] = [
        entry for entry in pruned.get("coverage_ledger", [])
        if str(entry.get("house_id") or "") not in excluded
    ]
    if "derived_mappings" in pruned:
        pruned["derived_mappings"] = [
            item for item in pruned.get("derived_mappings", [])
            if str(item.get("house_id") or "") not in excluded
            and str(item.get("mapping_id") or "") not in removed_mapping_ids
        ]
    if "flex_elections" in pruned:
        pruned["flex_elections"] = [
            item for item in pruned.get("flex_elections", [])
            if str(item.get("source_house_id") or "") not in excluded
        ]
    # A caller-authored pooled series cannot prove which house values remain
    # after exclusion. Remove the optional cache and let the pack compiler
    # recompute only from retained mappings.
    pruned.pop("provider_consensus", None)

    synthetic_report = {
        "schema_version": "broker-semantic-verification-report/1.0",
        "status": "BLOCKED",
        "total_violation_count": len(target_ids),
        "candidate_manifest_sha256": canonical_hash(bundle.get("candidate_manifest")),
        "crosswalk_sha256": canonical_hash(pruned),
        "candidate_count": len(candidates),
        "coverage_entry_count": len(pruned.get("coverage_ledger", [])),
        "terminal_quarantined_candidate_count": 0,
        "unresolved_selected_candidate_count": 0,
        "findings": [
            {
                "code": "TERMINAL-HOUSE-EXCLUSION",
                "candidate_id": candidate_id,
                "message": "The finding-owned house is preserved as evidence and removed from model authority.",
            }
            for candidate_id in target_ids
        ],
    }
    synthetic_sha = canonical_hash(synthetic_report)
    review = automatic_negative_consumption_review(
        bundle=bundle,
        crosswalk_sha256=canonical_hash(pruned),
        semantic_report_sha256=synthetic_sha,
        semantic_report=synthetic_report,
        bundle_sha256=bundle_sha256,
    )
    review["producer_id"] = "broker-controller-house-exclusion/1.0"
    recovered, terminal_receipt = apply_terminal_review(
        bundle=bundle,
        crosswalk=pruned,
        semantic_report=synthetic_report,
        review=review,
        bundle_sha256=bundle_sha256,
        crosswalk_sha256=canonical_hash(pruned),
        semantic_report_sha256=synthetic_sha,
    )
    exclusion_receipt = {
        "schema_version": "broker-house-exclusion-receipt/1.0",
        "status": "PASS",
        "source_crosswalk_sha256": source_crosswalk_sha256,
        "recovered_crosswalk_sha256": canonical_hash(recovered),
        "source_semantic_report_sha256": canonical_hash(semantic_report),
        "terminal_semantic_report_sha256": synthetic_sha,
        "excluded_house_ids": excluded_houses,
        "removed_mapping_ids": sorted(item for item in removed_mapping_ids if item),
        "preserved_candidate_count": len(target_ids),
        "remaining_mapping_count": len(recovered.get("mappings", [])),
        "model_consumption_added": 0,
    }
    return recovered, exclusion_receipt, synthetic_report


def degrade_all_broker_authority(
    *,
    bundle: dict[str, Any],
    crosswalk: dict[str, Any],
    bundle_sha256: str,
    source_crosswalk_sha256: str,
    reason: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Preserve the whole broker archive while selecting no broker value.

    This is the universal optional-lane circuit breaker. It is deliberately
    negative-only: every mapping and flex election is removed, every immutable
    candidate is sealed in terminal quarantine, and metric declarations remain
    present only as reference-only vocabulary. The ordinary company forecast
    waterfall must then resolve every model state without broker authority.
    """
    candidates = candidate_index(bundle)
    if not candidates:
        raise ValueError("Zero-broker fallback requires an immutable candidate manifest.")
    pruned = copy.deepcopy(crosswalk)
    removed_mapping_ids = sorted(
        str(item.get("mapping_id") or "")
        for item in pruned.get("mappings", [])
        if str(item.get("mapping_id") or "")
    )
    pruned["mappings"] = []
    pruned["coverage_ledger"] = []
    pruned.pop("provider_consensus", None)
    pruned.pop("derived_mappings", None)
    pruned.pop("flex_elections", None)
    for declaration in (pruned.get("metrics") or {}).values():
        if isinstance(declaration, dict):
            declaration["model_use"] = "reference_only"

    synthetic_report = {
        "schema_version": "broker-semantic-verification-report/1.0",
        "status": "BLOCKED",
        "total_violation_count": len(candidates),
        "candidate_manifest_sha256": canonical_hash(bundle.get("candidate_manifest")),
        "crosswalk_sha256": canonical_hash(pruned),
        "candidate_count": len(candidates),
        "coverage_entry_count": 0,
        "terminal_quarantined_candidate_count": 0,
        "unresolved_selected_candidate_count": 0,
        "findings": [
            {
                "code": "TERMINAL-ZERO-BROKER-AUTHORITY",
                "candidate_id": candidate_id,
                "message": reason,
            }
            for candidate_id in sorted(candidates)
        ],
    }
    synthetic_sha = canonical_hash(synthetic_report)
    review = automatic_negative_consumption_review(
        bundle=bundle,
        crosswalk_sha256=canonical_hash(pruned),
        semantic_report_sha256=synthetic_sha,
        semantic_report=synthetic_report,
        bundle_sha256=bundle_sha256,
    )
    review["producer_id"] = "broker-controller-zero-authority/1.0"
    recovered, terminal_receipt = apply_terminal_review(
        bundle=bundle,
        crosswalk=pruned,
        semantic_report=synthetic_report,
        review=review,
        bundle_sha256=bundle_sha256,
        crosswalk_sha256=canonical_hash(pruned),
        semantic_report_sha256=synthetic_sha,
    )
    receipt = {
        "schema_version": "broker-zero-authority-receipt/1.0",
        "status": "PASS",
        "source_crosswalk_sha256": source_crosswalk_sha256,
        "recovered_crosswalk_sha256": canonical_hash(recovered),
        "terminal_semantic_report_sha256": synthetic_sha,
        "removed_mapping_ids": removed_mapping_ids,
        "preserved_candidate_count": len(candidates),
        "remaining_mapping_count": 0,
        "model_consumption_added": 0,
        "reason": reason,
        "terminal_recovery": terminal_receipt,
    }
    return recovered, receipt, synthetic_report


def apply_terminal_review(
    *,
    bundle: dict[str, Any],
    crosswalk: dict[str, Any],
    semantic_report: dict[str, Any],
    review: dict[str, Any],
    bundle_sha256: str,
    crosswalk_sha256: str,
    semantic_report_sha256: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    analysis = analyse_terminal_recovery(bundle, crosswalk, semantic_report)
    if analysis["blocking_findings"]:
        raise ValueError("Actually mapped model cells or global source-integrity findings cannot be terminally quarantined.")
    if review.get("schema_version") != "broker-terminal-materiality-review/1.0":
        raise ValueError("Terminal materiality review has the wrong schema version.")
    allowed_review_fields = {
        "schema_version", "run_id", "bundle_sha256", "candidate_manifest_sha256",
        "source_crosswalk_sha256", "semantic_report_sha256", "producer_id",
        "reviewed_at", "reviews",
    }
    extra_review_fields = sorted(set(review) - allowed_review_fields)
    if extra_review_fields:
        raise ValueError("Terminal materiality review has undeclared fields: " + ", ".join(extra_review_fields))
    if not str(review.get("producer_id") or "").strip():
        raise ValueError("Terminal materiality review has no producer_id.")
    if review.get("reviewed_at") is not None and not isinstance(review.get("reviewed_at"), str):
        raise ValueError("Terminal materiality review reviewed_at must be a string or null.")
    expected_bindings = {
        "run_id": bundle.get("run_id"),
        "bundle_sha256": bundle_authority_hash(bundle),
        "candidate_manifest_sha256": canonical_hash(bundle.get("candidate_manifest")),
        "source_crosswalk_sha256": crosswalk_sha256,
        "semantic_report_sha256": semantic_report_sha256,
    }
    for field, expected in expected_bindings.items():
        if review.get(field) != expected:
            raise ValueError(f"Terminal materiality review does not bind {field}.")
    raw_reviews = review.get("reviews")
    if not isinstance(raw_reviews, list) or not raw_reviews:
        raise ValueError("Terminal materiality review has no candidate reviews.")
    by_id: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(raw_reviews):
        extra_item_fields = sorted(set(item) - {"candidate_id", "disposition", "model_consumption", "rationale"})
        if extra_item_fields:
            raise ValueError(f"Terminal review entry {index} has undeclared fields: {', '.join(extra_item_fields)}")
        candidate_id = str(item.get("candidate_id") or "")
        if not candidate_id or candidate_id in by_id:
            raise ValueError(f"Terminal review entry {index} has an absent or duplicate candidate_id.")
        if item.get("disposition") != "preserve_unconsumed_quarantine":
            raise ValueError(f"Terminal review entry {candidate_id!r} has an unsupported disposition.")
        if item.get("model_consumption") != "prohibited":
            raise ValueError(f"Terminal review entry {candidate_id!r} does not prohibit model consumption.")
        if len(str(item.get("rationale") or "").strip()) < 12:
            raise ValueError(f"Terminal review entry {candidate_id!r} lacks a substantive rationale.")
        by_id[candidate_id] = item
    expected_ids = analysis["recoverable_candidate_ids"]
    if sorted(by_id) != expected_ids:
        raise ValueError(
            "Terminal review must disposition every and only the recoverable non-consumed candidate."
        )

    candidates = candidate_index(bundle)
    retained_ledger = [
        copy.deepcopy(entry)
        for entry in crosswalk.get("coverage_ledger", [])
        if str(entry.get("candidate_id") or "") not in by_id
    ]
    quarantined = []
    finding_codes_by_candidate: dict[str, set[str]] = {}
    for finding in semantic_report.get("findings", []):
        candidate_id = str(finding.get("candidate_id") or "")
        if candidate_id in by_id:
            code = str(finding.get("code") or "").strip()
            if code:
                finding_codes_by_candidate.setdefault(candidate_id, set()).add(code)
    for candidate_id in expected_ids:
        candidate = candidates[candidate_id]
        quarantined.append({
            "candidate_id": candidate_id,
            "document_id": candidate.get("document_id"),
            "house_id": candidate.get("house_id"),
            "table_id": candidate.get("table_id"),
            "row": candidate.get("row"),
            "source_cells": [
                {"row": int(cell.get("row", 0)), "column": int(cell.get("column", 0))}
                for cell in candidate.get("source_cells", [])
            ],
            "source_authority_status": candidate.get("authority_status"),
            "disposition": "preserve_unconsumed_quarantine",
            "model_consumption": "prohibited",
            "finding_codes": sorted(finding_codes_by_candidate.get(candidate_id, set())),
            "rationale": str(by_id[candidate_id]["rationale"]).strip(),
            "review_status": "reviewed",
        })

    recovered = copy.deepcopy(crosswalk)
    recovered["coverage_ledger"] = retained_ledger
    recovered["terminal_recovery"] = {
        "schema_version": "broker-terminal-recovery/1.0",
        **expected_bindings,
        "producer_id": review.get("producer_id"),
        "reviewed_at": review.get("reviewed_at"),
        "bounded_review_status": "exhausted",
        "quarantined_candidates": quarantined,
    }
    receipt = {
        "schema_version": "broker-terminal-recovery-receipt/1.0",
        "status": "PASS",
        "quarantined_candidate_count": len(quarantined),
        "selected_candidate_count": len(analysis["selected_candidate_ids"]),
        "unresolved_selected_candidate_count": 0,
        "recovered_crosswalk_sha256": canonical_hash(recovered),
        "source_crosswalk_sha256": crosswalk_sha256,
        "semantic_report_sha256": semantic_report_sha256,
    }
    return recovered, receipt


def validate_terminal_recovery_independently(
    bundle: dict[str, Any], crosswalk: dict[str, Any], *, bundle_sha256: str | None = None
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Compiler-side negative-consumption proof, independent of the verifier."""
    terminal = crosswalk.get("terminal_recovery")
    if not terminal:
        return {}, []
    errors: list[str] = []
    candidates = candidate_index(bundle)
    selected = selected_candidate_ids(bundle, crosswalk)
    if terminal.get("schema_version") != "broker-terminal-recovery/1.0":
        errors.append("terminal quarantine has an unsupported schema version")
    if terminal.get("run_id") != bundle.get("run_id"):
        errors.append("terminal quarantine is not bound to the bundle run_id")
    if terminal.get("bundle_sha256") != bundle_authority_hash(bundle):
        errors.append("terminal quarantine is not bound to stable broker authority content")
    if terminal.get("candidate_manifest_sha256") != canonical_hash(bundle.get("candidate_manifest")):
        errors.append("terminal quarantine is not bound to the immutable candidate manifest")
    if terminal.get("bounded_review_status") != "exhausted":
        errors.append("terminal quarantine was not created after bounded review exhaustion")
    ordinary_ids = {
        str(item.get("candidate_id") or "") for item in crosswalk.get("coverage_ledger", [])
    }
    entries: dict[str, dict[str, Any]] = {}
    raw_entries = terminal.get("quarantined_candidates")
    if not isinstance(raw_entries, list) or not raw_entries:
        errors.append("terminal quarantine has no reviewed candidates")
        raw_entries = []
    for item in raw_entries:
        candidate_id = str(item.get("candidate_id") or "")
        candidate = candidates.get(candidate_id)
        if not candidate or candidate_id in entries:
            errors.append(f"terminal quarantine has absent or duplicate candidate {candidate_id!r}")
            continue
        if candidate_id in ordinary_ids:
            errors.append(f"terminal quarantine candidate {candidate_id!r} also appears in the ordinary ledger")
        for field in ("document_id", "house_id", "table_id", "row"):
            if item.get(field) != candidate.get(field):
                errors.append(f"terminal quarantine candidate {candidate_id!r} changed {field}")
        if item.get("source_authority_status") != candidate.get("authority_status"):
            errors.append(f"terminal quarantine candidate {candidate_id!r} changed source authority")
        expected_cells = sorted(
            (int(cell.get("row", 0)), int(cell.get("column", 0)))
            for cell in candidate.get("source_cells", [])
        )
        actual_cells = sorted(
            (int(cell.get("row", 0)), int(cell.get("column", 0)))
            for cell in item.get("source_cells", [])
        )
        if expected_cells != actual_cells:
            errors.append(f"terminal quarantine candidate {candidate_id!r} changed its source cells")
        if candidate_id in selected:
            errors.append(f"terminal quarantine candidate {candidate_id!r} is model-selected")
        if item.get("model_consumption") != "prohibited":
            errors.append(f"terminal quarantine candidate {candidate_id!r} permits model consumption")
        if item.get("disposition") != "preserve_unconsumed_quarantine":
            errors.append(f"terminal quarantine candidate {candidate_id!r} has an active disposition")
        if item.get("review_status") != "reviewed" or len(str(item.get("rationale") or "").strip()) < 12:
            errors.append(f"terminal quarantine candidate {candidate_id!r} lacks reviewed rationale")
        entries[candidate_id] = item
    return entries, errors
