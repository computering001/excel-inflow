#!/usr/bin/env python3
"""Seal non-consumed broker findings without weakening selected-cell authority.

This module makes no visual judgment and authors no value. It proves the
negative consumption fact from mappings and immutable source cells, then uses
the canonical dictionary's core tier plus immutable label/period context as an
independent potential-driver oracle. The model host must still explicitly
review every recoverable candidate. Selected cells, potential core drivers and
global source-integrity findings are terminal blockers and cannot enter this
lane even when a defective crosswalk calls them reference-only.
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
    """Return both selected and independently potential model-driver candidates.

    Crosswalk declarations alone are not authority for the negative fact.  An
    immutable numeric forecast row whose source-owned label is a canonical
    model driver remains selected-for-safety even if a bad crosswalk calls it
    reference-only.  This prevents terminal recovery becoming a semantic
    misclassification laundering route.
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
        if (
            bool(candidate.get("numeric"))
            and candidate.get("period_basis") in MODEL_PERIOD_BASES
            and normalized_label(candidate.get("label")) in CORE_DRIVER_LABELS
        ):
            selected.add(candidate_id)
    return selected


def analyse_terminal_recovery(
    bundle: dict[str, Any],
    crosswalk: dict[str, Any],
    semantic_report: dict[str, Any],
) -> dict[str, Any]:
    candidates = candidate_index(bundle)
    selected = selected_candidate_ids(bundle, crosswalk)
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
        "can_recover": bool(recoverable) and not blocking,
    }


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
        raise ValueError("Selected model cells or global source-integrity findings cannot be terminally quarantined.")
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
