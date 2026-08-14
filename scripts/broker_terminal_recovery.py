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
import re
from pathlib import Path
from typing import Any


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
            for ordinal, ((column, basis), label) in enumerate(sorted(period_cells.items())):
                value: dict[str, Any] = {"column": column, "period_basis": basis}
                if ordinal < 3:
                    value["period_index"] = ordinal
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
    required_ids = set((dictionary.get("consumption") or {}).get("required_for_primary_house") or [])
    required_ids.add("ebit")
    metrics: dict[str, dict[str, Any]] = {}
    for metric_id in sorted(required_ids):
        source = metric_by_id[metric_id]
        unit_class = str(source.get("unit_class") or "currency")
        unit_kind = "percent_decimal" if unit_class in {"percent", "percent_decimal"} else "currency"
        domain = "cash_flow" if source.get("statement_family") == "cash_flow" else "operating"
        metrics[metric_id] = {
            "definition_id": f"dict.{metric_id}",
            "label": source.get("display_label") or metric_id.replace("_", " ").title(),
            "unit_kind": unit_kind,
            "concept_id": metric_id,
            "economic_domain": domain,
            "semantic_role": "operating_forecast",
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
        "bundle_sha256": bundle_sha256,
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
        "bundle_sha256": bundle_sha256,
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
    if bundle_sha256 is not None and terminal.get("bundle_sha256") != bundle_sha256:
        errors.append("terminal quarantine is not bound to the verified bundle bytes")
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
