#!/usr/bin/env python3
"""Independently challenge a broker crosswalk against its captured candidate universe.

This module deliberately does not import the broker-pack compiler.  It owns a
second implementation of the semantic invariants so a compiler-authored receipt
cannot certify its own classifications.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

from broker_numeric import parse_broker_number

from broker_dynamic_concepts import validate_run_scoped_concepts

DOMAIN_BY_LEGACY_ROLE = {
    "operating_forecast": "operating",
    "cash_flow_forecast": "cash_flow",
    "debt_or_liquidity": "debt_liquidity",
    "leverage_or_coverage": "leverage_coverage",
    "interest_or_finance": "interest_finance",
    "lease": "lease",
    "tax": "tax",
    "management_guidance": "guidance",
    "broker_derived_estimate": "other",
    "valuation_market_data": "valuation",
    "presentation_only": "presentation_metadata",
    "metadata": "presentation_metadata",
    "other_model_check": "other",
}
MODEL_USE_BY_DISPOSITION = {
    "mapped_metric": "active_input",
    "supplemental_check": "reference_only",
    "mapped_guidance": "reference_only",
    "broker_derived_estimate": "reference_only",
    "partial_period_evidence": "reference_only",
    "duplicate": "exact_duplicate",
    "not_model_relevant": "reference_only",
    "unusable": "unresolved",
    "quarantined_conflict": "unresolved",
}
ALLOWED_MODEL_USE = {"active_input", "reference_only", "exact_duplicate", "derived_input", "unresolved"}
ALLOWED_DOMAINS = {
    "operating", "cash_flow", "debt_liquidity", "leverage_coverage",
    "interest_finance", "lease", "tax", "guidance", "valuation",
    "presentation_metadata", "other",
}
ALLOWED_EVIDENCE = {
    "broker_estimate", "company_guidance", "broker_derived_estimate",
    "partial_period", "calculated_check", "market_data",
    "historical_observation", "non_numeric",
}
ID = re.compile(r"^[a-z0-9][a-z0-9_.-]*$")
TERMINAL_MODEL_PERIOD_BASES = {"annual_forecast", "partial_period", "unresolved_period_header"}
TERMINAL_SELECTED_MODEL_USES = {"active_input", "derived_input"}
TERMINAL_MAPPED_DISPOSITIONS = {"mapped_metric", "mapped_guidance"}


def _terminal_normalized_label(value: Any) -> str:
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


def _terminal_core_labels() -> set[str]:
    dictionary = json.loads((Path(__file__).resolve().parent.parent / "assets" / "broker-metric-dictionary.json").read_text("utf-8"))
    if dictionary.get("schema_version") != "broker-metric-dictionary/1.0":
        raise ValueError("Semantic verification requires broker-metric-dictionary/1.0.")
    core_ids = set((dictionary.get("consumption") or {}).get("core") or [])
    return {
        label
        for metric in dictionary.get("metrics") or []
        if metric.get("id") in core_ids
        for raw in [metric.get("display_label"), *(metric.get("examples") or [])]
        if (label := _terminal_normalized_label(raw))
    }


TERMINAL_CORE_LABELS = _terminal_core_labels()
MODEL_LABELS = re.compile(
    r"(?:revenue|sales|profit|ebit|ebitda|income|tax|depreciat|amortis|impair|"
    r"cash\s*(?:flow|from)|\bcfo\b|\bocf\b|\bfcf\b|\bfcfe\b|working\s*capital|"
    r"capex|capital\s*expenditure|acquisition|divest|dividend|buyback|debt|"
    r"borrow|loan|bond|lease|interest|finance|liquidity|leverage|gearing|cover|"
    r"net\s*debt|ifrs\s*16)", re.I,
)
VALUATION_LABELS = re.compile(
    r"(?:\bp/?e\b|\bev\s*/|enterprise\s+value|market\s+cap|target\s+price|"
    r"price\s*/|free\s+cash\s+flow\s+yield|\bfcf\s+yield|\bp/?bv|dividend\s+yield)", re.I,
)


def canonical_hash(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def canonical_line_hash(value: Any) -> str:
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def bundle_authority_hash(bundle: dict[str, Any]) -> str:
    """Independent stable identity for terminal broker authority."""
    return canonical_line_hash({
        "schema_version": "broker-authority-content/1.0",
        "run_id": bundle.get("run_id"),
        "candidate_manifest_sha256": canonical_line_hash(bundle.get("candidate_manifest")),
    })


def number(value: Any) -> float | None:
    return parse_broker_number(value)


def slug(label: Any) -> str:
    value = re.sub(r"[^a-z0-9]+", ".", str(label or "unknown").casefold()).strip(".")
    return value[:80] or "unknown"


def definition_cues(label: Any) -> set[str]:
    text = re.sub(r"[^a-z0-9]+", " ", str(label or "").casefold())
    cues: set[str] = set()
    for item in ("adjusted", "reported", "restated", "core", "underlying", "statutory"):
        if re.search(rf"\b{item}\b", text):
            cues.add(f"basis:{item}")
    if re.search(r"\bfcfe\b|free cash flow to equity", text):
        cues.add("cash_flow:fcfe")
    elif re.search(r"\bfcf\b|free cash flow", text):
        cues.add("cash_flow:fcf")
    if re.search(r"net debt|financial debt", text):
        if re.search(r"including|incl|ifrs\s*16|lease", text):
            cues.add("lease:including")
        elif re.search(r"excluding|excl", text):
            cues.add("lease:excluding")
    return cues


def high_risk_label_findings(label: Any, concept_id: Any, economic_domain: Any) -> list[str]:
    """Challenge only captions whose economic meaning is unusually unambiguous.

    The source label comes from the immutable candidate manifest.  Rules use
    semantic fragments rather than a closed issuer-row taxonomy, so unusual
    rows can remain custom/reference-only while core financial captions cannot
    be relabelled through coordinated crosswalk edits.
    """

    label_text = re.sub(r"[^a-z0-9]+", " ", str(label or "").casefold()).strip()
    concept_text = re.sub(r"[^a-z0-9]+", " ", str(concept_id or "").casefold()).strip()
    problems: list[str] = []

    def require_concept(*fragments: str) -> None:
        if not any(fragment in concept_text for fragment in fragments):
            problems.append(f"source label {label!r} is incompatible with concept_id {concept_id!r}")

    def require_domain(*domains: str) -> None:
        if economic_domain not in domains:
            problems.append(f"source label {label!r} is incompatible with economic_domain {economic_domain!r}")

    # Revenue/sales captions may preserve issuer-specific prefixes, but their
    # concept must still say revenue or sales and remain operating evidence.
    if re.search(r"\b(revenue|revenues|sales)\b", label_text) and not re.search(r"\b(price|multiple|yield|per share)\b", label_text):
        require_concept("revenue", "sales")
        require_domain("operating", "guidance")
    if re.search(r"\badjusted ebitda\b", label_text):
        require_concept("adjusted ebitda")
        require_domain("operating", "guidance")
    elif re.search(r"\bebitda\b", label_text) and "margin" not in label_text:
        require_concept("ebitda")
        require_domain("operating", "guidance")
    elif (re.fullmatch(r"(?:adjusted |reported |core |underlying )?ebit", label_text) or "operating profit" in label_text) and "margin" not in label_text:
        if "ebitda" in concept_text or not ("ebit" in concept_text or "operating profit" in concept_text):
            problems.append(f"source label {label!r} is incompatible with concept_id {concept_id!r}")
        require_domain("operating", "guidance")
    if re.search(r"\b(depreciation\s*(?:and|&)\s*amorti[sz]ation|d\s*&\s*a)\b", label_text):
        require_concept("depreciation", "amortisation", "amortization", "d a")
        require_domain("operating", "cash_flow")
    if re.search(r"\b(cash from operations|cash flow from operations|operating cash flow|cfo|ocf)\b", label_text):
        require_concept("cash from operations", "cash flow from operations", "operating cash flow", "cfo", "ocf")
        require_domain("cash_flow")
    if re.search(r"\b(free cash flow to equity|fcfe)\b", label_text):
        require_concept("fcfe", "free cash flow to equity")
        require_domain("cash_flow")
    elif re.search(r"\b(free cash flow|fcf)\b", label_text) and "yield" not in label_text:
        require_concept("free cash flow", "fcf")
        require_domain("cash_flow")
    if re.search(r"\b(capex|capital expenditure)\b", label_text) and "sales" not in label_text:
        require_concept("capex", "capital expenditure")
        require_domain("cash_flow")
    if "change in working capital" in label_text:
        require_concept("change in working capital", "working capital change")
        require_domain("cash_flow")
    if re.search(r"\bnet debt\b", label_text) and not re.search(r"\b(ev|enterprise value)\b", label_text):
        require_concept("net debt")
        require_domain("debt_liquidity", "leverage_coverage")
    if re.search(r"\b(gearing|leverage)\b", label_text):
        require_concept("gearing", "leverage")
        require_domain("leverage_coverage")
    if re.search(r"\b(interest|finance) (income|expense|cost|charge|result|items?)\b", label_text):
        require_concept("interest", "finance")
        require_domain("interest_finance")
    if re.search(r"\b(effective tax rate|cash tax rate)\b", label_text):
        require_concept("tax rate")
        require_domain("tax")
    return problems


def normalized_entry(entry: dict[str, Any], metric: dict[str, Any] | None) -> dict[str, Any]:
    result = dict(entry)
    result["economic_domain"] = result.get("economic_domain") or DOMAIN_BY_LEGACY_ROLE.get(result.get("semantic_role"))
    result["concept_id"] = result.get("concept_id") or result.get("metric_id") or f"custom.{slug(result.get('label'))}"
    result["model_use"] = result.get("model_use") or MODEL_USE_BY_DISPOSITION.get(result.get("disposition"))
    fingerprint = dict(result.get("definition_fingerprint") or (metric or {}).get("definition_signature") or {})
    fingerprint.setdefault("concept_id", result["concept_id"])
    fingerprint.setdefault("measurement_basis", fingerprint.pop("adjustment_basis", None) or "unspecified")
    fingerprint.setdefault("restatement_basis", "unspecified")
    fingerprint.setdefault("cash_flow_basis", "unspecified")
    fingerprint.setdefault("lease_basis", "unspecified")
    fingerprint.setdefault("accounting_basis", "unspecified")
    fingerprint.setdefault("operating_scope", fingerprint.pop("operation_scope", None) or "unspecified")
    fingerprint.setdefault("currency", None)
    fingerprint.setdefault("units", None)
    fingerprint.setdefault("period_basis", result.get("period_basis"))
    fingerprint.setdefault("sign_convention", (metric or {}).get("sign_convention") or "as_reported")
    result["definition_fingerprint"] = fingerprint
    return result


def add(findings: list[dict[str, Any]], code: str, message: str, candidate_id: str | None = None) -> None:
    finding = {"code": code, "message": message}
    if candidate_id:
        finding["candidate_id"] = candidate_id
    findings.append(finding)


def table_index(bundle: dict[str, Any]) -> dict[str, tuple[str, list[list[dict[str, Any]]]]]:
    output = {}
    for document in bundle.get("documents") or []:
        for table in document.get("tables") or []:
            output[str(table.get("table_id"))] = (str(document.get("house_id")), table.get("rows") or [])
    return output


def model_prohibited_surface_ids(bundle: dict[str, Any]) -> set[str]:
    """Independently identify surfaces that can preserve evidence but mint no authority."""
    return {
        str(surface.get("surface_id"))
        for document in bundle.get("documents") or []
        for surface in document.get("surfaces") or []
        if (
            (surface.get("quarantine") or {}).get("model_use") == "prohibited"
            and surface.get("vision_disposition") == "quarantined_evidence_only"
        ) or surface.get("vision_disposition") == "verified_non_tabular"
    }


def fully_model_prohibited_bundle(bundle: dict[str, Any]) -> bool:
    surfaces = [
        surface
        for document in bundle.get("documents") or []
        for surface in document.get("surfaces") or []
    ]
    prohibited = model_prohibited_surface_ids(bundle)
    return bool(surfaces) and all(str(surface.get("surface_id")) in prohibited for surface in surfaces)


def verify_manifest_integrity(bundle: dict[str, Any], manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Reconstruct the manifest universe directly from canonical source tables."""

    findings: list[dict[str, Any]] = []
    expected: dict[tuple[str, str, int, str], dict[str, Any]] = {}
    canonical_tables: list[dict[str, Any]] = []
    prohibited_surfaces = model_prohibited_surface_ids(bundle)
    for document in sorted(bundle.get("documents") or [], key=lambda item: str(item.get("document_id"))):
        tables = document.get("canonical_tables") or document.get("tables") or []
        for table in sorted(tables, key=lambda item: str(item.get("canonical_table_id") or item.get("table_id"))):
            canonical_tables.append(table)
            table_id = str(table.get("canonical_table_id") or table.get("table_id"))
            if str(table.get("surface_id")) in prohibited_surfaces:
                continue
            for row_number, row in enumerate(table.get("rows") or [], start=1):
                cells_by_authority: dict[str, list[dict[str, Any]]] = {}
                numeric_by_authority: dict[str, int] = {}
                for cell in row:
                    raw_text = str(cell.get("raw_text") or "").strip()
                    if not raw_text:
                        continue
                    authority = "quarantined_conflict" if cell.get("authority_status") == "quarantined_conflict" else "verified"
                    cells_by_authority.setdefault(authority, []).append({
                        "row": int(cell.get("row", row_number)),
                        "column": int(cell.get("column", 0)),
                        "source_ref": str(cell.get("source_ref") or ""),
                        "raw_text": cell.get("raw_text"),
                    })
                    if number(cell.get("value") if cell.get("value") is not None else cell.get("raw_text")) is not None:
                        numeric_by_authority[authority] = numeric_by_authority.get(authority, 0) + 1
                if not cells_by_authority:
                    continue
                label = next((str(cell.get("raw_text") or "").strip() for cell in row if str(cell.get("raw_text") or "").strip() and number(cell.get("value") if cell.get("value") is not None else cell.get("raw_text")) is None), "")
                indent = max((float(cell.get("indent") or 0) for cell in row), default=0.0)
                numeric_count = sum(numeric_by_authority.values())
                source_row_kind = "subtotal" if numeric_count and any(bool(cell.get("bold")) for cell in row) else ("header" if numeric_count == 0 and label else "detail")
                for authority, cells in cells_by_authority.items():
                    key = (str(document.get("document_id")), table_id, row_number, authority)
                    expected[key] = {
                        "house_id": document.get("house_id"),
                        "source_cells": cells,
                        "numeric": numeric_by_authority.get(authority, 0) > 0,
                        "header": numeric_count == 0 and bool(label),
                        "indent": indent,
                        "row_kind": source_row_kind,
                        "authority_status": authority,
                        "conflict_ids": sorted({
                            str(cell.get("conflict_id"))
                            for cell in row
                            if authority == "quarantined_conflict"
                            and cell.get("authority_status") == "quarantined_conflict"
                            and str(cell.get("conflict_id") or "").strip()
                        }),
                    }

    actual: dict[tuple[str, str, int, str], dict[str, Any]] = {}
    for candidate in manifest.get("candidates") or []:
        key = (str(candidate.get("document_id")), str(candidate.get("table_id")), int(candidate.get("row", 0)), str(candidate.get("authority_status")))
        if key in actual:
            add(findings, "SEM-MANIFEST-ROW-DUPLICATE", f"Manifest repeats source row {key}.", candidate.get("candidate_id"))
        actual[key] = candidate
    for key in sorted(set(expected) - set(actual)):
        add(findings, "SEM-MANIFEST-SOURCE-ROW-MISSING", f"Canonical source row {key} is absent from the candidate manifest.")
    for key in sorted(set(actual) - set(expected)):
        add(findings, "SEM-MANIFEST-SOURCE-ROW-EXTRA", f"Candidate manifest contains non-source row {key}.", actual[key].get("candidate_id"))
    for key in sorted(set(expected) & set(actual)):
        source = expected[key]
        candidate = actual[key]
        if candidate.get("house_id") != source["house_id"]:
            add(findings, "SEM-MANIFEST-SOURCE-HOUSE", "Candidate house differs from its canonical source row.", candidate.get("candidate_id"))
        candidate_cells = [
            {"row": int(item.get("row", 0)), "column": int(item.get("column", 0)), "source_ref": str(item.get("source_ref") or ""), "raw_text": item.get("raw_text")}
            for item in candidate.get("source_cells") or []
        ]
        if candidate_cells != source["source_cells"]:
            add(findings, "SEM-MANIFEST-SOURCE-CELLS", "Candidate cells do not exactly equal its canonical nonblank source cells.", candidate.get("candidate_id"))
        if bool(candidate.get("numeric")) != source["numeric"]:
            add(findings, "SEM-MANIFEST-NUMERIC", "Candidate numeric flag differs from its canonical source row.", candidate.get("candidate_id"))
        if source["row_kind"] in {"header", "subtotal"} and candidate.get("row_kind") != source["row_kind"]:
            add(findings, "SEM-MANIFEST-ROW-KIND", f"Candidate row_kind does not preserve source {source['row_kind']} evidence.", candidate.get("candidate_id"))
        if candidate.get("authority_status") != source["authority_status"]:
            add(findings, "SEM-MANIFEST-AUTHORITY", "Candidate authority status differs from its canonical source row.", candidate.get("candidate_id"))
        if sorted(candidate.get("conflict_ids") or []) != source["conflict_ids"]:
            add(findings, "SEM-MANIFEST-CONFLICT-IDS", "Candidate conflict ids differ from its canonical source row.", candidate.get("candidate_id"))

    # A bold numeric subtotal becomes a parent only when following rows are
    # visibly more indented.  This is source-geometry evidence, not a guess
    # that every bold number owns the rows beneath it.
    table_keys: dict[tuple[str, str], list[tuple[str, str, int, str]]] = {}
    for key in expected:
        table_keys.setdefault((key[0], key[1]), []).append(key)
    for keys in table_keys.values():
        # Hierarchy ownership uses the verified partition when a row is split;
        # conflict partitions are evidence siblings, never alternate parents.
        primary_keys = [
            key for key in keys
            if key[3] == "verified" or (key[0], key[1], key[2], "verified") not in expected
        ]
        ordered = sorted(primary_keys, key=lambda item: item[2])
        for position, subtotal_key in enumerate(ordered[:-1]):
            subtotal_source = expected[subtotal_key]
            if subtotal_source["row_kind"] != "subtotal":
                continue
            subtotal_candidate = actual.get(subtotal_key)
            if subtotal_candidate is None:
                continue
            base_indent = subtotal_source["indent"]
            for child_key in ordered[position + 1:]:
                child_source = expected[child_key]
                if child_source["indent"] <= base_indent:
                    break
                child_candidate = actual.get(child_key)
                if child_candidate is not None and child_candidate.get("parent_candidate_id") != subtotal_candidate.get("candidate_id"):
                    add(findings, "SEM-HIERARCHY-SUBTOTAL-PARENT", "Indented child is not owned by the preceding source-evidenced subtotal.", child_candidate.get("candidate_id"))

    expected_tables_hash = canonical_line_hash(canonical_tables)
    if manifest.get("canonical_tables_sha256") != expected_tables_hash:
        add(findings, "SEM-MANIFEST-TABLE-HASH", "canonical_tables_sha256 does not match the canonical source tables.")
    summary = manifest.get("summary") or {}
    expected_summary = {
        "candidate_count": len(actual),
        "numeric_candidate_count": sum(1 for item in actual.values() if item.get("numeric")),
        "header_candidate_count": sum(1 for item in actual.values() if item.get("row_kind") == "header"),
        "quarantined_candidate_count": sum(1 for item in actual.values() if item.get("authority_status") == "quarantined_conflict"),
        "finding_count": len(manifest.get("findings") or []),
    }
    for field, value in expected_summary.items():
        if summary.get(field) != value:
            add(findings, "SEM-MANIFEST-SUMMARY", f"Manifest summary {field}={summary.get(field)!r}; expected {value}.")
    declared_manifest_hash = manifest.get("manifest_sha256")
    unhashed = dict(manifest)
    unhashed.pop("manifest_sha256", None)
    if declared_manifest_hash != canonical_line_hash(unhashed):
        add(findings, "SEM-MANIFEST-SELF-HASH", "manifest_sha256 does not match the manifest payload.")
    return findings


def candidate_values(entry: dict[str, Any], tables: dict[str, tuple[str, list[list[dict[str, Any]]]]]) -> tuple[Any, ...]:
    table_id = str(entry.get("table_id"))
    table = tables.get(table_id)
    if not table:
        return ()
    values = []
    for ref in sorted(entry.get("source_cells") or [], key=lambda item: (int(item.get("row", 0)), int(item.get("column", 0)))):
        try:
            raw = table[1][int(ref["row"]) - 1][int(ref["column"]) - 1].get("value")
        except (IndexError, KeyError, TypeError, ValueError):
            values.append(("missing", None))
            continue
        parsed = number(raw)
        if parsed is not None:
            values.append(("number", round(parsed, 12)))
    return tuple(values)


def manifest_candidates(bundle: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    findings: list[dict[str, Any]] = []
    manifest = bundle.get("candidate_manifest")
    if manifest is None:
        add(findings, "SEM-MANIFEST-MISSING", "A deterministic candidate manifest is required for semantic trust-boundary verification.")
        return {}, findings
    if manifest.get("manifest_version") != "broker-candidate-manifest/1.0" or manifest.get("gate_status") != "PASS":
        add(findings, "SEM-MANIFEST-NOT-PASS", "The candidate manifest is absent, unsupported, or not PASS.")
    if manifest.get("run_id") != bundle.get("run_id"):
        add(findings, "SEM-MANIFEST-RUN", "The candidate manifest run_id does not match the bundle.")
    result: dict[str, dict[str, Any]] = {}
    for index, candidate in enumerate(manifest.get("candidates") or []):
        cid = candidate.get("candidate_id")
        if not isinstance(cid, str) or not cid:
            add(findings, "SEM-MANIFEST-ID", f"Manifest candidate {index} has no candidate_id.")
        elif cid in result:
            add(findings, "SEM-MANIFEST-DUPLICATE-ID", f"Manifest repeats candidate_id {cid!r}.", cid)
        else:
            result[cid] = candidate
    if not result and not fully_model_prohibited_bundle(bundle):
        add(findings, "SEM-MANIFEST-EMPTY", "The deterministic candidate manifest contains no candidates.")
    return result, findings


def normalized_manifest_period(candidate: dict[str, Any], crosswalk: dict[str, Any]) -> tuple[str, list[int]]:
    years = [int(str(value)[:4]) for value in crosswalk.get("forecast_periods") or []]
    matched: list[int] = []
    kinds: set[str] = set()
    for item in candidate.get("period_indexes") or []:
        if not isinstance(item, dict):
            continue
        kinds.add(str(item.get("period_kind") or ""))
        label = re.sub(r"\s+", "", str(item.get("period_label") or "").upper())
        for index, year in enumerate(years):
            short = str(year)[-2:]
            if (
                re.search(rf"(?<!\d){year}[EF]?(?!\d)", label)
                or re.search(rf"(?<![A-Z0-9])FY'?{short}[EF]?(?!\d)", label)
                or re.search(rf"(?<!\d)'{short}[EF]?(?!\d)", label)
            ):
                matched.append(index)
    if matched:
        return "annual_forecast", sorted(set(matched))
    raw = candidate.get("period_basis")
    if raw in {"quarter", "half_year", "partial_period"} or kinds & {"quarter", "half_year"}:
        return "partial_period", []
    if raw in {"event_date", "non_periodic"} or "event_date" in kinds:
        return "non_periodic", []
    if raw in {"annual", "historical"}:
        return "historical", []
    return "non_periodic", []


def verifier_selected_candidate_ids(bundle: dict[str, Any], crosswalk: dict[str, Any]) -> set[str]:
    """Independent reconstruction of candidates actually selected for use.

    Potential model drivers are not selected merely because of their label.
    If their source cell cannot be resolved, terminal recovery must quarantine
    it and the company forecast waterfall must choose another authority.  This
    oracle still independently proves that no quarantined cell overlaps a real
    mapping or an active crosswalk declaration.
    """
    candidates = {
        str(item.get("candidate_id")): item
        for item in (bundle.get("candidate_manifest") or {}).get("candidates") or []
    }
    selected = {
        str(item.get("candidate_id"))
        for item in crosswalk.get("coverage_ledger") or []
        if item.get("model_use") in TERMINAL_SELECTED_MODEL_USES
        or item.get("disposition") in TERMINAL_MAPPED_DISPOSITIONS
        or bool(item.get("mapping_ids"))
    }
    mapped_cells = {
        (str(source.get("table_id") or ""), int(source.get("row", 0)), int(source.get("column", 0)))
        for mapping in crosswalk.get("mappings") or []
        for source in mapping.get("sources") or []
    }
    for candidate_id, candidate in candidates.items():
        source_cells = {
            (str(candidate.get("table_id") or ""), int(item.get("row", 0)), int(item.get("column", 0)))
            for item in candidate.get("source_cells") or []
        }
        if source_cells & mapped_cells:
            selected.add(candidate_id)
    return selected


def verify_terminal_recovery_independently(
    bundle: dict[str, Any], crosswalk: dict[str, Any], *, bundle_sha256: str | None
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Second implementation of terminal authority, independent of compiler."""
    terminal = crosswalk.get("terminal_recovery")
    if not terminal:
        return {}, []
    errors: list[str] = []
    candidates = {
        str(item.get("candidate_id")): item
        for item in (bundle.get("candidate_manifest") or {}).get("candidates") or []
    }
    selected = verifier_selected_candidate_ids(bundle, crosswalk)
    if terminal.get("schema_version") != "broker-terminal-recovery/1.0":
        errors.append("terminal quarantine has an unsupported schema version")
    if terminal.get("run_id") != bundle.get("run_id"):
        errors.append("terminal quarantine is not bound to the bundle run_id")
    if terminal.get("bundle_sha256") != bundle_authority_hash(bundle):
        errors.append("terminal quarantine is not bound to stable broker authority content")
    if terminal.get("candidate_manifest_sha256") != canonical_line_hash(bundle.get("candidate_manifest")):
        errors.append("terminal quarantine is not bound to the immutable candidate manifest")
    if terminal.get("bounded_review_status") != "exhausted":
        errors.append("terminal quarantine was not created after bounded review exhaustion")
    ordinary = {
        str(item.get("candidate_id") or "") for item in crosswalk.get("coverage_ledger") or []
    }
    raw_entries = terminal.get("quarantined_candidates")
    if not isinstance(raw_entries, list) or not raw_entries:
        errors.append("terminal quarantine has no reviewed candidates")
        raw_entries = []
    entries: dict[str, dict[str, Any]] = {}
    for item in raw_entries:
        candidate_id = str(item.get("candidate_id") or "")
        candidate = candidates.get(candidate_id)
        if candidate is None or candidate_id in entries:
            errors.append(f"terminal quarantine has absent or duplicate candidate {candidate_id!r}")
            continue
        if candidate_id in ordinary:
            errors.append(f"terminal quarantine candidate {candidate_id!r} also appears in the ordinary ledger")
        for field in ("document_id", "house_id", "table_id", "row"):
            if item.get(field) != candidate.get(field):
                errors.append(f"terminal quarantine candidate {candidate_id!r} changed {field}")
        if item.get("source_authority_status") != candidate.get("authority_status"):
            errors.append(f"terminal quarantine candidate {candidate_id!r} changed source authority")
        expected_cells = sorted(
            (int(cell.get("row", 0)), int(cell.get("column", 0)))
            for cell in candidate.get("source_cells") or []
        )
        actual_cells = sorted(
            (int(cell.get("row", 0)), int(cell.get("column", 0)))
            for cell in item.get("source_cells") or []
        )
        if actual_cells != expected_cells:
            errors.append(f"terminal quarantine candidate {candidate_id!r} changed its source cells")
        if candidate_id in selected:
            errors.append(f"terminal quarantine candidate {candidate_id!r} is model-selected")
        if item.get("disposition") != "preserve_unconsumed_quarantine" or item.get("model_consumption") != "prohibited":
            errors.append(f"terminal quarantine candidate {candidate_id!r} permits model consumption")
        if item.get("review_status") != "reviewed" or len(str(item.get("rationale") or "").strip()) < 12:
            errors.append(f"terminal quarantine candidate {candidate_id!r} lacks reviewed rationale")
        entries[candidate_id] = item
    return entries, errors


def verify(bundle: dict[str, Any], crosswalk: dict[str, Any], *, bundle_sha256: str | None = None) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    run_scoped_concepts, run_scoped_errors = validate_run_scoped_concepts(
        crosswalk.get("run_scoped_concepts"), run_id=bundle.get("run_id")
    )
    for message in run_scoped_errors:
        add(findings, "SEM-RUN-SCOPED-CONTRACT", message)
    tables = table_index(bundle)
    manifest, manifest_findings = manifest_candidates(bundle)
    findings.extend(manifest_findings)
    if bundle.get("candidate_manifest") is not None:
        findings.extend(verify_manifest_integrity(bundle, bundle["candidate_manifest"]))
    metrics = crosswalk.get("metrics") or {}
    raw_ledger = crosswalk.get("coverage_ledger") or []
    empty_evidence_only = fully_model_prohibited_bundle(bundle) and not manifest
    if not manifest and not empty_evidence_only:
        add(findings, "SEM-EMPTY-AUTHORITY-UNPROVEN", "A zero-candidate broker lane is lawful only when every preserved surface is independently model-prohibited.")
    if empty_evidence_only and (raw_ledger or crosswalk.get("mappings") or crosswalk.get("derived_mappings")):
        add(findings, "SEM-EMPTY-AUTHORITY-ACTIVE", "A fully evidence-only broker lane cannot carry candidate dispositions, mappings or derivations.")
    terminal_ledger, terminal_errors = verify_terminal_recovery_independently(
        bundle, crosswalk, bundle_sha256=bundle_sha256
    )
    for message in terminal_errors:
        add(findings, "SEM-TERMINAL-RECOVERY", message)
    ledger: dict[str, dict[str, Any]] = {}
    normalized: dict[str, dict[str, Any]] = {}

    for index, raw in enumerate(raw_ledger):
        cid = raw.get("candidate_id")
        if not isinstance(cid, str) or not cid:
            add(findings, "SEM-LEDGER-ID", f"Coverage entry {index} has no candidate_id.")
            continue
        if cid in ledger:
            add(findings, "SEM-LEDGER-DUPLICATE-ID", f"Coverage ledger repeats candidate_id {cid!r}.", cid)
            continue
        if cid in terminal_ledger:
            add(findings, "SEM-TERMINAL-DUPLICATE", "Candidate appears in both ordinary and terminal quarantine ledgers.", cid)
            continue
        ledger[cid] = raw
        entry = normalized_entry(raw, metrics.get(raw.get("metric_id")))
        normalized[cid] = entry
        if crosswalk.get("schema_version") == "broker-crosswalk/1.2":
            missing_axes = [
                field for field in ("economic_domain", "concept_id", "model_use", "definition_fingerprint")
                if field not in raw
            ]
            if missing_axes:
                add(findings, "SEM-AXES-MISSING", f"Version 1.2 candidate lacks explicit {', '.join(missing_axes)}.", cid)
        candidate = manifest.get(cid)
        if candidate is None:
            add(findings, "SEM-LEDGER-EXTRA", "Reviewer ledger contains a candidate outside the immutable manifest.", cid)
        else:
            expected_basis, expected_periods = normalized_manifest_period(candidate, crosswalk)
            for field in ("house_id", "table_id", "row"):
                if candidate.get(field) != raw.get(field):
                    add(findings, "SEM-MANIFEST-MISMATCH", f"Ledger disagrees with manifest on {field}.", cid)
            if expected_basis != raw.get("period_basis"):
                add(findings, "SEM-MANIFEST-MISMATCH", "Ledger disagrees with normalized manifest period_basis.", cid)
            manifest_cells = {(int(x.get("row", 0)), int(x.get("column", 0))) for x in candidate.get("source_cells") or []}
            ledger_cells = {(int(x.get("row", 0)), int(x.get("column", 0))) for x in raw.get("source_cells") or []}
            if manifest_cells != ledger_cells:
                add(findings, "SEM-CELL-UNIVERSE", "Reviewer source_cells do not equal the immutable candidate cells.", cid)
            if expected_periods and sorted(raw.get("period_indexes") or []) != expected_periods:
                add(findings, "SEM-PERIOD-UNIVERSE", "Reviewer period indexes do not equal the immutable candidate periods.", cid)
            if candidate.get("parent_candidate_id") != raw.get("parent_candidate_id"):
                add(findings, "SEM-HIERARCHY-DRIFT", "Reviewer parent relationship differs from the immutable manifest.", cid)
            if candidate.get("authority_status") == "quarantined_conflict" and raw.get("disposition") != "quarantined_conflict":
                add(findings, "SEM-QUARANTINED-CANDIDATE-ACTIVE", "A quarantined source candidate must remain quarantined and cannot become a model input.", cid)
            if candidate.get("authority_status") != "quarantined_conflict" and raw.get("disposition") == "quarantined_conflict":
                add(findings, "SEM-VERIFIED-CANDIDATE-QUARANTINED", "A verified source candidate cannot be quarantined without source conflict evidence.", cid)

        domain = entry.get("economic_domain")
        concept = entry.get("concept_id")
        model_use = entry.get("model_use")
        evidence = entry.get("evidence_kind")
        if domain not in ALLOWED_DOMAINS:
            add(findings, "SEM-DOMAIN", f"Unsupported economic_domain {domain!r}.", cid)
        if not isinstance(concept, str) or not ID.fullmatch(concept):
            add(findings, "SEM-CONCEPT", f"Invalid concept_id {concept!r}.", cid)
        if model_use not in ALLOWED_MODEL_USE:
            add(findings, "SEM-MODEL-USE", f"Unsupported model_use {model_use!r}.", cid)
        if evidence not in ALLOWED_EVIDENCE:
            add(findings, "SEM-EVIDENCE-KIND", f"Unsupported evidence_kind {evidence!r}.", cid)

        is_numeric = bool((candidate or {}).get("numeric")) or any(v[0] == "number" for v in candidate_values(raw, tables))
        if is_numeric and model_use not in ALLOWED_MODEL_USE:
            add(findings, "SEM-NUMERIC-UNOWNED", "Numeric candidate has no safe model use.", cid)
        if is_numeric and raw.get("disposition") == "unusable":
            add(findings, "SEM-NUMERIC-UNUSABLE", "Numeric evidence cannot be discarded as unusable.", cid)
        if raw.get("disposition") == "quarantined_conflict" and model_use != "unresolved":
            add(findings, "SEM-QUARANTINE-MODEL-USE", "Quarantined evidence must use model_use=unresolved.", cid)
        if (
            is_numeric
            and concept.startswith("custom.")
            and model_use != "reference_only"
            and raw.get("disposition") != "quarantined_conflict"
        ):
            add(findings, "SEM-CUSTOM-NOT-REFERENCE", "Unknown numeric concepts must be retained as custom.* reference-only evidence.", cid)
        if (
            is_numeric
            and raw.get("metric_id")
            and raw.get("metric_id") not in run_scoped_concepts
            and str(raw.get("metric_id")).startswith("run.")
            and model_use in TERMINAL_SELECTED_MODEL_USES
        ):
            add(findings, "SEM-RUN-SCOPED-UNCONTRACTED", "A run.* metric cannot become selected model authority without a valid run-scoped insertion contract.", cid)
        # Semantic contradictions are tested against the extraction-owned
        # label, never the reviewer-owned copy, so coordinated crosswalk edits
        # cannot rewrite both sides of the assertion.
        label = str((candidate or {}).get("label") or raw.get("label") or "")
        for message in high_risk_label_findings(label, concept, domain):
            add(findings, "SEM-LABEL-CONCEPT", message, cid)
        if is_numeric and model_use == "reference_only" and domain == "presentation_metadata" and MODEL_LABELS.search(label):
            add(findings, "SEM-RELEVANCE-CONTRADICTION", "Model-relevant label is misclassified as presentation metadata.", cid)
        if domain == "valuation" and evidence != "market_data":
            add(findings, "SEM-VALUATION-EVIDENCE", "Valuation-domain evidence must be market_data.", cid)
        if evidence == "market_data" and MODEL_LABELS.search(label) and not VALUATION_LABELS.search(label):
            add(findings, "SEM-MARKET-DATA-CONTRADICTION", "Operating, cash-flow, leverage or debt evidence is misclassified as market data.", cid)
        if evidence == "company_guidance" and raw.get("disposition") == "broker_derived_estimate":
            add(findings, "SEM-GUIDANCE-DERIVED", "Broker-derived evidence cannot be company guidance.", cid)
        if evidence == "broker_derived_estimate" and raw.get("disposition") == "mapped_guidance":
            add(findings, "SEM-DERIVED-GUIDANCE", "Broker-derived evidence cannot be mapped as company guidance.", cid)

        metric = metrics.get(raw.get("metric_id")) if raw.get("metric_id") else None
        if metric is not None and model_use in {"active_input", "derived_input"}:
            metric_domain = metric.get("economic_domain") or DOMAIN_BY_LEGACY_ROLE.get(metric.get("semantic_role"))
            metric_concept = metric.get("concept_id") or raw.get("metric_id")
            metric_fp = metric.get("definition_fingerprint") or metric.get("definition_signature")
            if metric_domain != domain or metric_concept != concept:
                add(findings, "SEM-METRIC-AXIS-MISMATCH", "Active candidate semantic axes disagree with its metric declaration.", cid)
            if metric_fp is not None and canonical_hash(metric_fp) != canonical_hash(entry.get("definition_fingerprint")):
                add(findings, "SEM-METRIC-FINGERPRINT-MISMATCH", "Active candidate fingerprint disagrees with its metric declaration.", cid)

        fp = entry.get("definition_fingerprint") or {}
        required_fp = {
            "concept_id", "measurement_basis", "restatement_basis", "cash_flow_basis",
            "lease_basis", "units", "currency", "period_basis", "sign_convention",
            "accounting_basis", "operating_scope",
        }
        missing = sorted(required_fp - set(fp))
        if missing:
            add(findings, "SEM-FINGERPRINT-INCOMPLETE", f"Definition fingerprint lacks {', '.join(missing)}.", cid)
        if crosswalk.get("schema_version") == "broker-crosswalk/1.2":
            definition_evidence = str(raw.get("definition_evidence") or "").strip()
            if len(definition_evidence) < 12 or re.fullmatch(r"(?:n/?a|none|unknown|tbd|assumed|not known)[.!]?", definition_evidence, re.I):
                add(findings, "SEM-DEFINITION-EVIDENCE", "Version 1.2 candidate lacks substantive definition_evidence.", cid)
            raw_fp = raw.get("definition_fingerprint")
            raw_missing = sorted(required_fp - set(raw_fp or {}))
            if raw_missing:
                add(findings, "SEM-FINGERPRINT-NOT-EXPLICIT", f"Version 1.2 fingerprint does not explicitly declare {', '.join(raw_missing)}.", cid)
        if fp.get("concept_id") != concept or fp.get("period_basis") != raw.get("period_basis"):
            add(findings, "SEM-FINGERPRINT-IDENTITY", "Definition fingerprint disagrees with concept or period basis.", cid)
        cues = definition_cues(label)
        if "cash_flow:fcfe" in cues and fp.get("cash_flow_basis") != "fcfe":
            add(findings, "SEM-FCFE-BASIS", "FCFE label conflicts with definition fingerprint.", cid)
        if "cash_flow:fcf" in cues and fp.get("cash_flow_basis") != "fcf":
            add(findings, "SEM-FCF-BASIS", "FCF label conflicts with definition fingerprint.", cid)
        if "lease:including" in cues and fp.get("lease_basis") != "including_leases":
            add(findings, "SEM-LEASE-BASIS", "Lease-inclusive label conflicts with definition fingerprint.", cid)
        if "lease:excluding" in cues and fp.get("lease_basis") != "excluding_leases":
            add(findings, "SEM-LEASE-BASIS", "Lease-exclusive label conflicts with definition fingerprint.", cid)
        for basis in ("adjusted", "reported", "core", "underlying", "statutory"):
            if f"basis:{basis}" in cues and fp.get("measurement_basis") != basis:
                add(findings, "SEM-MEASUREMENT-BASIS", f"{basis.title()} label conflicts with definition fingerprint.", cid)
        if "basis:restated" in cues and fp.get("restatement_basis") != "restated":
            add(findings, "SEM-RESTATEMENT-BASIS", "Restated label conflicts with definition fingerprint.", cid)

    for cid, candidate in manifest.items():
        if cid not in ledger and cid not in terminal_ledger:
            add(findings, "SEM-CANDIDATE-UNDISPOSITIONED", "Immutable manifest candidate has no semantic disposition.", cid)
        parent = candidate.get("parent_candidate_id")
        if parent:
            target = manifest.get(parent)
            if target is None:
                add(findings, "SEM-PARENT-MISSING", f"Parent candidate {parent!r} is absent.", cid)
            elif target.get("house_id") != candidate.get("house_id") or target.get("table_id") != candidate.get("table_id"):
                add(findings, "SEM-PARENT-CROSS-BOUNDARY", "Parent relationship crosses house or table boundaries.", cid)
            elif int(target.get("row", 0)) >= int(candidate.get("row", 0)):
                add(findings, "SEM-PARENT-ORDER", "Parent must precede its child.", cid)

    for cid, entry in normalized.items():
        if entry.get("model_use") != "exact_duplicate":
            continue
        target_id = entry.get("duplicate_of")
        target = normalized.get(target_id)
        if target is None or target_id == cid:
            add(findings, "SEM-DUPLICATE-TARGET", "Exact duplicate has an absent or self-referential target.", cid)
            continue
        if target.get("model_use") == "exact_duplicate":
            add(findings, "SEM-DUPLICATE-CHAIN", "Exact duplicate points to another duplicate.", cid)
        for field in ("house_id", "period_basis", "period_indexes", "economic_domain", "concept_id", "evidence_kind", "definition_id", "definition_fingerprint"):
            if entry.get(field) != target.get(field):
                add(findings, "SEM-DUPLICATE-EQUIVALENCE", f"Exact duplicate disagrees with target on {field}.", cid)
        if candidate_values(entry, tables) != candidate_values(target, tables):
            add(findings, "SEM-DUPLICATE-VALUE", "Exact duplicate values do not match its target.", cid)

    active_by_metric: dict[str, list[dict[str, Any]]] = {}
    for entry in normalized.values():
        if entry.get("model_use") in {"active_input", "derived_input"} and entry.get("metric_id"):
            active_by_metric.setdefault(entry["metric_id"], []).append(entry)
    for metric_id, entries in active_by_metric.items():
        fingerprints = {canonical_hash(entry.get("definition_fingerprint")) for entry in entries}
        if len(fingerprints) > 1:
            add(findings, "SEM-DEFINITION-COLLISION", f"Metric {metric_id!r} combines incompatible structured definition fingerprints.")
        evidence = {entry.get("evidence_kind") for entry in entries}
        if "company_guidance" in evidence and "broker_derived_estimate" in evidence:
            add(findings, "SEM-GUIDANCE-COLLISION", f"Metric {metric_id!r} collapses company guidance and broker-derived estimates.")

    status = "PASS" if not findings else "BLOCKED"
    independently_selected = verifier_selected_candidate_ids(bundle, crosswalk)
    unresolved_selected = {
        str(finding.get("candidate_id"))
        for finding in findings
        if str(finding.get("candidate_id") or "") in independently_selected
    }
    return {
        "schema_version": "broker-semantic-verification-report/1.0",
        "status": status,
        "total_violation_count": len(findings),
        "candidate_manifest_sha256": canonical_hash(bundle.get("candidate_manifest")),
        "crosswalk_sha256": canonical_hash(crosswalk),
        "candidate_count": len(manifest),
        "coverage_entry_count": len(ledger),
        "terminal_quarantined_candidate_count": len(terminal_ledger),
        "unresolved_selected_candidate_count": len(unresolved_selected),
        "findings": findings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    parser.add_argument("crosswalk")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    bundle = json.loads(Path(args.bundle).read_text("utf-8"))
    crosswalk = json.loads(Path(args.crosswalk).read_text("utf-8"))
    report = verify(bundle, crosswalk, bundle_sha256=hashlib.sha256(Path(args.bundle).read_bytes()).hexdigest())
    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(json.dumps({"status": report["status"], "total_violation_count": report["total_violation_count"]}, sort_keys=True))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
