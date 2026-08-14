#!/usr/bin/env python3
"""Compile verified broker evidence and a semantic crosswalk into model inputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from broker_terminal_recovery import validate_terminal_recovery_independently


NUMBER = re.compile(r"^\s*(\()?\s*[-+]?[$€£¥]?\s*(\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.(\d+))?\s*(%)?\s*\)?\s*$")
# ------------------------------------------------------- the metric vocabulary
#
# Every consumable id, every electable concept and every banned total comes from
# assets/broker-metric-dictionary.json. It used to be written out here, again in
# scripts/lib/coverage.mjs and again in scripts/build_dynamic_model.mjs - three
# copies of one rule, agreeing only because someone remembered to edit all
# three. The digest pin below is the cross-language identity check: the JavaScript
# loader pins the same bytes, so a dictionary edited for one side and not the
# other refuses on both rather than quietly disagreeing.
#
# The dictionary is model-facing prompt material as well as data: its definitions
# are what the runtime reads when deciding that a broker's row means `capex`. A
# new digest here is a behaviour change that owes a certification run.
BROKER_METRIC_DICTIONARY_SHA256 = (
    "a53439ffda8259f55b5ff820073c1a553afb4107419cb24e5ee45291ab0da2bb"
)
DICTIONARY_PATH = Path(__file__).resolve().parent.parent / "assets" / "broker-metric-dictionary.json"


def _load_metric_dictionary() -> dict:
    raw = DICTIONARY_PATH.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != BROKER_METRIC_DICTIONARY_SHA256:
        raise ValueError(
            f"Broker metric dictionary digest drift: expected {BROKER_METRIC_DICTIONARY_SHA256}, "
            f"got {digest}. The dictionary is model-facing prompt material; update the pin "
            "deliberately and re-run certification."
        )
    dictionary = json.loads(raw.decode("utf-8"))
    if dictionary.get("schema_version") != "broker-metric-dictionary/1.0":
        raise ValueError(
            f"Unsupported broker metric dictionary {dictionary.get('schema_version')!r}."
        )
    return dictionary


METRIC_DICTIONARY = _load_metric_dictionary()
METRIC_BY_ID = {metric["id"]: metric for metric in METRIC_DICTIONARY["metrics"]}
KNOWN_METRIC_IDS = set(METRIC_BY_ID)
CORE_METRIC_IDS = set(METRIC_DICTIONARY["consumption"]["core"])
REQUIRED_METRICS = set(METRIC_DICTIONARY["consumption"]["required_for_primary_house"])
HEADLINE_ANCHOR_IDS = set(METRIC_DICTIONARY["consumption"]["headline_anchors"])
FLEX_ELIGIBLE_IDS = set(METRIC_DICTIONARY["flex"]["eligible_concepts"])
BANNED_TOTAL_IDS = set(METRIC_DICTIONARY["banned_totals"])
MAPPED_DISPOSITIONS = {"mapped_metric", "supplemental_check"}
NON_FORECAST_TABLE_CLASSES = {"historical_only", "ratings_or_valuation", "non_forecast"}
PERIOD_BASES = {"annual_forecast", "partial_period"}
NOT_MODEL_RELEVANT_ROLES = {"valuation_market_data", "presentation_only", "metadata"}
SEMANTIC_ROLES = {
    "operating_forecast", "cash_flow_forecast", "debt_or_liquidity",
    "leverage_or_coverage", "interest_or_finance", "lease", "tax",
    "management_guidance", "broker_derived_estimate", "valuation_market_data",
    "presentation_only", "metadata", "other_model_check",
}
EVIDENCE_KINDS = {
    "broker_estimate", "company_guidance", "broker_derived_estimate",
    "partial_period", "calculated_check", "market_data",
    "historical_observation", "non_numeric",
}
DISPOSITIONS = {
    "mapped_metric", "mapped_guidance", "broker_derived_estimate",
    "partial_period_evidence", "supplemental_check", "duplicate",
    "not_model_relevant", "unusable", "quarantined_conflict",
}
MODEL_RELEVANT_LABEL = re.compile(
    r"(?:revenue|sales|profit|ebit|ebitda|income|tax|depreciat|amortis|impair|"
    r"cash\s*(?:flow|from)|working\s*capital|capex|capital\s*expenditure|acquisition|"
    r"divest|dividend|buyback|debt|borrow|loan|bond|lease|interest|finance|"
    r"liquidity|leverage|cover|net\s*debt|ifrs\s*16)",
    re.IGNORECASE,
)
VALUATION_LABEL = re.compile(
    r"(?:\bp/?e\b|\bev\s*/|enterprise\s+value|market\s+cap|target\s+price|"
    r"price\s*/|free\s+cash\s+flow\s+yield|\bfcf\s+yield|\bp/?bv|net\s+yield)",
    re.IGNORECASE,
)
ECONOMIC_DOMAINS = {
    "operating", "cash_flow", "debt_liquidity", "leverage_coverage",
    "interest_finance", "lease", "tax", "guidance", "valuation",
    "presentation_metadata", "other",
}
DOMAIN_BY_LEGACY_ROLE = {
    "operating_forecast": "operating", "cash_flow_forecast": "cash_flow",
    "debt_or_liquidity": "debt_liquidity", "leverage_or_coverage": "leverage_coverage",
    "interest_or_finance": "interest_finance", "lease": "lease", "tax": "tax",
    "management_guidance": "guidance", "broker_derived_estimate": "other",
    "valuation_market_data": "valuation", "presentation_only": "presentation_metadata",
    "metadata": "presentation_metadata", "other_model_check": "other",
}
MODEL_USES = {"active_input", "reference_only", "exact_duplicate", "derived_input", "unresolved"}
MODEL_USE_BY_DISPOSITION = {
    "mapped_metric": "active_input", "supplemental_check": "reference_only",
    "mapped_guidance": "reference_only", "broker_derived_estimate": "reference_only",
    "partial_period_evidence": "reference_only", "duplicate": "exact_duplicate",
    "not_model_relevant": "reference_only", "unusable": "unresolved",
    "quarantined_conflict": "unresolved",
}


def semantic_slug(value: Any) -> str:
    slug = re.sub(r"[^a-z0-9]+", ".", str(value or "unknown").casefold()).strip(".")
    return slug[:80] or "unknown"


def normalize_semantic_entry(
    entry: dict[str, Any],
    metric: dict[str, Any] | None,
    schema_version: str,
) -> dict[str, Any]:
    """Return split semantic axes; legacy input is accepted only via explicit fail-closed derivation."""

    resolved = dict(entry)
    resolved["economic_domain"] = resolved.get("economic_domain") or DOMAIN_BY_LEGACY_ROLE.get(resolved.get("semantic_role"))
    resolved["concept_id"] = resolved.get("concept_id") or resolved.get("metric_id") or f"custom.{semantic_slug(resolved.get('label'))}"
    resolved["model_use"] = resolved.get("model_use") or MODEL_USE_BY_DISPOSITION.get(resolved.get("disposition"))
    fingerprint = dict(resolved.get("definition_fingerprint") or (metric or {}).get("definition_signature") or {})
    fingerprint.setdefault("concept_id", resolved["concept_id"])
    fingerprint.setdefault("measurement_basis", fingerprint.pop("adjustment_basis", None) or "unspecified")
    fingerprint.setdefault("restatement_basis", "unspecified")
    fingerprint.setdefault("cash_flow_basis", "unspecified")
    fingerprint.setdefault("lease_basis", "unspecified")
    fingerprint.setdefault("units", None)
    fingerprint.setdefault("currency", None)
    fingerprint.setdefault("period_basis", resolved.get("period_basis"))
    fingerprint.setdefault("sign_convention", (metric or {}).get("sign_convention") or "as_reported")
    fingerprint.setdefault("accounting_basis", "unspecified")
    fingerprint.setdefault("operating_scope", fingerprint.pop("operation_scope", None) or "unspecified")
    resolved["definition_fingerprint"] = fingerprint
    if schema_version == "broker-crosswalk/1.2":
        missing = [
            field for field in ("economic_domain", "concept_id", "model_use", "definition_fingerprint", "definition_evidence")
            if field not in entry
        ]
        if missing:
            raise ValueError(f"Candidate {entry.get('candidate_id')!r} lacks required split semantic fields: {', '.join(missing)}.")
    return resolved


def fingerprint_hash(value: dict[str, Any]) -> str:
    return hash_json(value)


def hash_json(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def nonblank(cell: dict[str, Any]) -> bool:
    value = cell.get("value")
    if value is None:
        return bool(str(cell.get("raw_text") or "").strip())
    return not (isinstance(value, str) and value.strip() == "")


def cell_at(table: dict[str, Any], row: int, column: int, label: str) -> dict[str, Any]:
    try:
        cell = table["rows"][row - 1][column - 1]
    except (IndexError, TypeError):
        raise ValueError(f"{label} cell R{row}C{column} does not exist.")
    if int(cell.get("row", row)) != row or int(cell.get("column", column)) != column:
        raise ValueError(f"{label} cell coordinates disagree with their table position at R{row}C{column}.")
    return cell


def header_year(value: Any, forecast_years: list[int]) -> int | None:
    text = str(value or "").upper().replace(" ", "")
    if not text:
        return None
    for year in forecast_years:
        short = str(year)[-2:]
        patterns = (
            rf"(?<!\d){year}(?:E|F|EST|FORECAST)?(?!\d)",
            rf"FY'?{short}(?:E|F|EST)?(?!\d)",
            rf"(?:DEC|MAR|JUN|SEP)[-']?{short}(?:E|F)?(?!\d)",
        )
        if any(re.search(pattern, text) for pattern in patterns):
            return year
    return None


def is_partial_header(value: Any) -> bool:
    text = str(value or "").upper().replace(" ", "")
    return bool(re.search(r"(?:^|[^A-Z0-9])(?:Q[1-4]|H[12]|[1-4]Q|[12]H)(?:[^A-Z0-9]|$)", text))


def row_label(table: dict[str, Any], row: int, first_period_column: int) -> str:
    labels = []
    for column in range(1, first_period_column):
        cell = cell_at(table, row, column, table["table_id"])
        value = cell.get("value")
        if value is None or str(value).strip() in {"", "-"}:
            continue
        try:
            parse_number(value, "row label probe")
        except ValueError:
            labels.append(str(value).strip())
    return labels[-1] if labels else f"Row {row}"


def has_numeric_signal(value: Any) -> bool:
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, (int, float)):
        return math.isfinite(float(value))
    return bool(re.search(r"\d", str(value)))


def normalized_evidence_value(value: Any) -> tuple[str, Any]:
    try:
        return ("number", round(parse_number(value, "duplicate evidence"), 12))
    except ValueError:
        text = re.sub(r"\s+", " ", str(value or "").strip()).casefold()
        return ("text", text)


def candidate_value_signature(entry: dict[str, Any]) -> tuple[Any, ...]:
    cells = sorted(entry.get("source_cells") or [], key=lambda item: (int(item["row"]), int(item["column"])))
    values = []
    for item in cells:
        normalized = normalized_evidence_value(item.get("raw_value"))
        if normalized[0] == "number":
            values.append(normalized)
    return tuple(values)


def label_definition_signature(label: str) -> tuple[str, ...]:
    """Independent high-risk definition cues; intentionally not a full taxonomy."""

    text = re.sub(r"[^a-z0-9]+", " ", str(label or "").casefold()).strip()
    flags: set[str] = set()
    for token in ("adjusted", "reported", "restated", "core", "underlying", "statutory"):
        if re.search(rf"\b{token}\b", text):
            flags.add(f"basis:{token}")
    if re.search(r"\bfcfe\b|free cash flow to equity", text):
        flags.add("cash_flow:fcfe")
    elif re.search(r"\bfcf\b|free cash flow", text):
        flags.add("cash_flow:fcf")
    if re.search(r"capex|capital expenditure|purchase of", text):
        if re.search(r"intangible", text):
            flags.add("capex:intangibles")
        elif re.search(r"ppe|property plant|tangible", text):
            flags.add("capex:ppe")
        else:
            flags.add("capex:aggregate_or_unspecified")
    if re.search(r"net debt|financial debt", text):
        if re.search(r"including|incl|ifrs\s*16|lease", text):
            flags.add("debt_basis:including_leases")
        elif re.search(r"excluding|excl", text):
            flags.add("debt_basis:excluding_leases")
        else:
            flags.add("debt_basis:unspecified")
    return tuple(sorted(flags))


def validate_coverage(
    crosswalk: dict[str, Any],
    documents_by_house: dict[str, dict[str, Any]],
    tables: dict[str, tuple[dict[str, Any], dict[str, Any]]],
    mapping_receipts: list[dict[str, Any]],
    candidate_manifest: dict[str, Any] | None = None,
    semantic_violation_count: int = 0,
    bundle: dict[str, Any] | None = None,
    bundle_sha256: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
    """Prove every declared future-period table row has one reviewed disposition."""

    reviews = crosswalk.get("table_reviews")
    ledger = crosswalk.get("coverage_ledger")
    if not isinstance(reviews, list):
        raise ValueError("The broker crosswalk requires a table_reviews array.")
    if not isinstance(ledger, list):
        raise ValueError("The broker crosswalk requires a coverage_ledger array.")
    terminal_by_id: dict[str, dict[str, Any]] = {}
    if crosswalk.get("terminal_recovery"):
        if bundle is None:
            raise ValueError("Terminal broker quarantine requires the immutable verified bundle.")
        terminal_by_id, terminal_errors = validate_terminal_recovery_independently(
            bundle, crosswalk, bundle_sha256=bundle_sha256
        )
        if terminal_errors:
            raise ValueError("Invalid terminal broker quarantine: " + "; ".join(terminal_errors))
    forecast_years = [int(str(period)[:4]) for period in crosswalk["forecast_periods"]]
    review_by_table: dict[str, dict[str, Any]] = {}
    expected: dict[tuple[str, int, str], dict[str, Any]] = {}
    expected_by_candidate_id: dict[str, dict[str, Any]] = {}
    prohibited_surface_ids = {
        str(surface.get("surface_id"))
        for document in (bundle or {}).get("documents", [])
        for surface in document.get("surfaces", [])
        if (
            (surface.get("quarantine") or {}).get("model_use") == "prohibited"
            and surface.get("vision_disposition") == "quarantined_evidence_only"
        ) or surface.get("vision_disposition") == "verified_non_tabular"
    }
    all_surfaces = [
        surface
        for document in (bundle or {}).get("documents", [])
        for surface in document.get("surfaces", [])
    ]
    fully_model_prohibited = bool(all_surfaces) and all(
        str(surface.get("surface_id")) in prohibited_surface_ids for surface in all_surfaces
    )
    if not reviews and not fully_model_prohibited:
        raise ValueError("An empty table_reviews ledger is lawful only when every broker surface is model-prohibited.")
    if candidate_manifest is not None:
        if candidate_manifest.get("manifest_version") != "broker-candidate-manifest/1.0":
            raise ValueError("The deterministic candidate manifest has an unsupported version.")
        if candidate_manifest.get("run_id") != crosswalk.get("run_id") or candidate_manifest.get("gate_status") != "PASS":
            raise ValueError("The deterministic candidate manifest must be PASS and bound to the crosswalk run_id.")
        for index, candidate in enumerate(candidate_manifest.get("candidates") or []):
            candidate_id = candidate.get("candidate_id")
            if not isinstance(candidate_id, str) or not candidate_id or candidate_id in expected_by_candidate_id:
                raise ValueError(f"candidate_manifest.candidates[{index}] has an absent or duplicate candidate_id.")
            table_id = candidate.get("table_id")
            if table_id not in tables:
                raise ValueError(f"Candidate {candidate_id!r} names unknown table {table_id!r}.")
            document, _table = tables[table_id]
            if document.get("house_id") != candidate.get("house_id"):
                raise ValueError(f"Candidate {candidate_id!r} reaches across houses.")
            cells = [
                {"row": int(item.get("row", 0)), "column": int(item.get("column", 0))}
                for item in candidate.get("source_cells") or []
            ]
            if not cells:
                raise ValueError(f"Candidate {candidate_id!r} has no immutable source cells.")
            period_indexes = []
            period_columns_by_index: dict[int, int] = {}
            declared_period_kinds: set[str] = set()
            for item in candidate.get("period_indexes") or []:
                if isinstance(item, int):
                    period_indexes.append(item)
                    continue
                if isinstance(item, dict):
                    declared_period_kinds.add(str(item.get("period_kind") or ""))
                    detected = header_year(item.get("period_label"), forecast_years)
                    if detected in forecast_years:
                        resolved_period_index = forecast_years.index(detected)
                        period_indexes.append(resolved_period_index)
                        period_columns_by_index[resolved_period_index] = int(item.get("column", 0))
            manifest_basis = candidate.get("period_basis")
            if period_indexes:
                normalized_basis = "annual_forecast"
            elif manifest_basis in {"quarter", "half_year", "partial_period"} or declared_period_kinds & {"quarter", "half_year"}:
                normalized_basis = "partial_period"
            elif manifest_basis in {"event_date", "non_periodic"} or "event_date" in declared_period_kinds:
                normalized_basis = "non_periodic"
            elif manifest_basis in {"annual", "historical"}:
                normalized_basis = "historical"
            else:
                normalized_basis = "non_periodic"
            expected_by_candidate_id[candidate_id] = {
                **candidate,
                "period_basis": normalized_basis,
                "source_cells": sorted(cells, key=lambda item: (item["row"], item["column"])),
                "period_indexes": sorted(set(period_indexes)),
                "period_columns_by_index": period_columns_by_index,
            }
        if not expected_by_candidate_id and not fully_model_prohibited:
            raise ValueError("The deterministic candidate manifest cannot be empty unless every preserved surface is model-prohibited.")
        if not expected_by_candidate_id and (ledger or mapping_receipts or crosswalk.get("derived_mappings")):
            raise ValueError("A fully evidence-only zero-candidate broker lane cannot carry dispositions, mappings or derivations.")

    for index, review in enumerate(reviews):
        table_id = review.get("table_id")
        house_id = review.get("house_id")
        if table_id not in tables:
            raise ValueError(f"table_reviews[{index}] names unknown table {table_id!r}.")
        if table_id in review_by_table:
            raise ValueError(f"Table {table_id!r} has more than one semantic review.")
        document, table = tables[table_id]
        table_model_prohibited = str(table.get("surface_id")) in prohibited_surface_ids
        if document["house_id"] != house_id:
            raise ValueError(f"table_reviews[{index}] reaches across houses from {house_id!r} to {document['house_id']!r}.")
        if review.get("review_status") != "reviewed" or not str(review.get("rationale") or "").strip():
            raise ValueError(f"table_reviews[{index}] is not a reasoned reviewed disposition.")
        classification = review.get("classification")
        header_rows = {int(value) for value in review.get("header_rows") or []}
        for row in header_rows:
            if row < 1 or row > len(table["rows"]):
                raise ValueError(f"table_reviews[{index}] header row {row} is outside {table_id!r}.")
        period_columns = review.get("period_columns") or []
        if table_model_prohibited and (classification not in NON_FORECAST_TABLE_CLASSES or period_columns):
            raise ValueError(f"Model-prohibited table {table_id!r} must be reviewed as non-forecast evidence with no period columns.")
        if classification == "annual_forecast" and not any(item.get("period_basis") == "annual_forecast" for item in period_columns):
            raise ValueError(f"Annual forecast table {table_id!r} declares no annual forecast columns.")
        if classification == "partial_period" and not any(item.get("period_basis") == "partial_period" for item in period_columns):
            raise ValueError(f"Partial-period table {table_id!r} declares no partial-period columns.")
        if classification in NON_FORECAST_TABLE_CLASSES and period_columns:
            raise ValueError(f"Non-forecast table {table_id!r} must not declare forecast period columns.")
        declared_columns: set[tuple[int, str]] = set()
        annual_indexes: set[int] = set()
        for column_index, declaration in enumerate(period_columns):
            column = int(declaration.get("column", 0))
            basis = declaration.get("period_basis")
            if basis not in PERIOD_BASES or column < 1:
                raise ValueError(f"table_reviews[{index}].period_columns[{column_index}] is invalid.")
            key = (column, basis)
            if key in declared_columns:
                raise ValueError(f"Table {table_id!r} repeats column {column} for {basis}.")
            declared_columns.add(key)
            header_values = [
                cell_at(table, row, column, table_id).get("value")
                for row in sorted(header_rows)
            ]
            detected_years = {year for year in (header_year(value, forecast_years) for value in header_values) if year is not None}
            if basis == "annual_forecast":
                period_index = declaration.get("period_index")
                if period_index not in {0, 1, 2}:
                    raise ValueError(f"Annual column {table_id!r}!C{column} requires period_index 0, 1 or 2.")
                if period_index in annual_indexes:
                    raise ValueError(f"Table {table_id!r} repeats annual forecast period_index {period_index}.")
                annual_indexes.add(period_index)
                expected_year = forecast_years[period_index]
                if detected_years and detected_years != {expected_year}:
                    raise ValueError(
                        f"Annual column {table_id!r}!C{column} is declared for {expected_year} but its reviewed header identifies {sorted(detected_years)}."
                    )
            elif not str(declaration.get("period_label") or "").strip():
                raise ValueError(f"Partial-period column {table_id!r}!C{column} requires period_label.")

        # A reviewed non-forecast classification cannot suppress an obvious
        # multi-year forecast header. This independent contradiction check is
        # intentionally conservative: it fires only when one row identifies
        # at least two of the model's three forecast years.
        if classification in NON_FORECAST_TABLE_CLASSES and not table_model_prohibited:
            for row in table["rows"][: min(10, len(table["rows"]))]:
                years = {
                    year
                    for year in (header_year(cell.get("value"), forecast_years) for cell in row)
                    if year is not None
                }
                if len(years) >= 2:
                    raise ValueError(
                        f"Table {table_id!r} is classified {classification} but contains an apparent forecast header for {sorted(years)}."
                    )

        if table_model_prohibited:
            review_by_table[table_id] = review
            continue
        for basis in PERIOD_BASES:
            columns = [item for item in period_columns if item.get("period_basis") == basis]
            if not columns:
                continue
            first_column = min(int(item["column"]) for item in columns)
            for row_number in range(1, len(table["rows"]) + 1):
                if row_number in header_rows:
                    continue
                source_cells = []
                period_indexes = []
                for item in columns:
                    column = int(item["column"])
                    cell = cell_at(table, row_number, column, table_id)
                    if not nonblank(cell):
                        continue
                    source_cells.append({"row": row_number, "column": column})
                    if basis == "annual_forecast":
                        period_indexes.append(int(item["period_index"]))
                if source_cells:
                    expected[(table_id, row_number, basis)] = {
                        "house_id": house_id,
                        "table_id": table_id,
                        "row": row_number,
                        "period_basis": basis,
                        "source_cells": sorted(source_cells, key=lambda item: (item["row"], item["column"])),
                        "period_indexes": sorted(set(period_indexes)),
                        "label": row_label(table, row_number, first_column),
                    }
        review_by_table[table_id] = review

    missing_reviews = sorted(set(tables) - set(review_by_table))
    if missing_reviews:
        raise ValueError(f"Every extracted table requires one review; missing: {', '.join(missing_reviews)}.")

    mapping_by_id: dict[str, dict[str, Any]] = {}
    mapping_cells: dict[str, set[tuple[str, int, int]]] = {}
    derived_mapping_ids = {
        item.get("mapping_id")
        for item in (crosswalk.get("derived_mappings") or [])
        if isinstance(item.get("mapping_id"), str)
    }
    for mapping in mapping_receipts:
        mapping_id = mapping["mapping_id"]
        if mapping_id in mapping_by_id:
            raise ValueError(f"Duplicate mapping_id {mapping_id!r}.")
        if any(float(component.get("coefficient", 0)) == 0 for component in mapping["components"]):
            raise ValueError(
                f"Mapping {mapping_id!r} contains a zero-coefficient source cell; "
                "a cell that contributes nothing is not valid provenance."
            )
        mapping_by_id[mapping_id] = mapping
        mapping_cells[mapping_id] = {
            (component["table_id"], int(component["row"]), int(component["column"]))
            for component in mapping["components"]
        }

    by_candidate_id: dict[str, dict[str, Any]] = {}
    by_expected_key: dict[tuple[str, int, str], dict[str, Any]] = {}
    resolved_ledger = []
    referenced_mappings: set[str] = set()
    for index, entry in enumerate(ledger):
        candidate_id = entry.get("candidate_id")
        if not isinstance(candidate_id, str) or not candidate_id:
            raise ValueError(f"coverage_ledger[{index}] has no candidate_id.")
        if candidate_id in by_candidate_id:
            raise ValueError(f"Duplicate coverage candidate_id {candidate_id!r}.")
        table_id = entry.get("table_id")
        house_id = entry.get("house_id")
        row = int(entry.get("row", 0))
        basis = entry.get("period_basis")
        if table_id not in tables:
            raise ValueError(f"coverage_ledger[{index}] names unknown table {table_id!r}.")
        document, table = tables[table_id]
        if document["house_id"] != house_id:
            raise ValueError(f"coverage_ledger[{index}] reaches across houses.")
        key = (table_id, row, basis)
        expected_entry = expected_by_candidate_id.get(candidate_id) if candidate_manifest is not None else expected.get(key)
        if candidate_manifest is not None:
            if expected_entry is None:
                raise ValueError(f"coverage_ledger[{index}] candidate_id is outside the immutable candidate manifest.")
            for field in ("house_id", "table_id", "row", "period_basis"):
                if expected_entry.get(field) != entry.get(field):
                    raise ValueError(f"coverage_ledger[{index}] disagrees with the immutable candidate manifest on {field}.")
            expected_cells = {(int(item["row"]), int(item["column"])) for item in expected_entry["source_cells"]}
            actual_cells = {(int(item.get("row", 0)), int(item.get("column", 0))) for item in entry.get("source_cells") or []}
            if actual_cells != expected_cells:
                raise ValueError(f"coverage_ledger[{index}] source cells do not equal the immutable candidate cells.")
            if expected_entry.get("period_indexes") and sorted(entry.get("period_indexes") or []) != expected_entry["period_indexes"]:
                raise ValueError(f"coverage_ledger[{index}] period indexes do not equal the immutable candidate periods.")
            if expected_entry.get("parent_candidate_id") != entry.get("parent_candidate_id"):
                raise ValueError(f"coverage_ledger[{index}] parent relationship differs from the immutable candidate manifest.")
        elif basis in PERIOD_BASES:
            if expected_entry is None:
                raise ValueError(f"coverage_ledger[{index}] does not match a declared nonblank {basis} row.")
            if key in by_expected_key:
                raise ValueError(f"Forecast candidate {table_id}!R{row} ({basis}) is dispositioned more than once.")
            by_expected_key[key] = entry
            expected_cells = {(item["row"], item["column"]) for item in expected_entry["source_cells"]}
            actual_cells = {(int(item.get("row", 0)), int(item.get("column", 0))) for item in entry.get("source_cells") or []}
            if actual_cells != expected_cells:
                raise ValueError(
                    f"coverage_ledger[{index}] source cells do not equal the nonblank declared period cells for {table_id}!R{row}."
                )
            if basis == "annual_forecast" and sorted(entry.get("period_indexes") or []) != expected_entry["period_indexes"]:
                raise ValueError(f"coverage_ledger[{index}] annual period_indexes are incomplete or shifted.")
            declared_label = re.sub(r"\s+", " ", str(entry.get("label") or "").strip()).casefold()
            extracted_label = re.sub(r"\s+", " ", str(expected_entry["label"]).strip()).casefold()
            if declared_label and declared_label != extracted_label:
                raise ValueError(f"coverage_ledger[{index}] label does not match the extracted source row.")
        elif basis not in {"guidance", "non_periodic"}:
            raise ValueError(f"coverage_ledger[{index}] has unsupported period_basis {basis!r}.")

        resolved_cells = []
        for cell_ref in entry.get("source_cells") or []:
            cell = cell_at(table, int(cell_ref.get("row", 0)), int(cell_ref.get("column", 0)), table_id)
            if not nonblank(cell):
                raise ValueError(f"coverage_ledger[{index}] cites blank cell {table_id}!R{cell_ref.get('row')}C{cell_ref.get('column')}.")
            resolved_cells.append({
                "row": int(cell_ref["row"]),
                "column": int(cell_ref["column"]),
                "source_ref": cell["source_ref"],
                "raw_value": cell.get("value"),
            })
        disposition = entry.get("disposition")
        metric_id = entry.get("metric_id")
        normalized_entry = normalize_semantic_entry(
            entry,
            (crosswalk.get("metrics") or {}).get(metric_id),
            crosswalk.get("schema_version", "broker-crosswalk/1.1"),
        )
        semantic_role = entry.get("semantic_role")
        economic_domain = normalized_entry.get("economic_domain")
        concept_id = normalized_entry.get("concept_id")
        model_use = normalized_entry.get("model_use")
        evidence_kind = entry.get("evidence_kind")
        definition_id = entry.get("definition_id")
        if crosswalk.get("schema_version") == "broker-crosswalk/1.1" and semantic_role not in SEMANTIC_ROLES:
            raise ValueError(f"coverage_ledger[{index}] has unsupported semantic_role {semantic_role!r}.")
        if economic_domain not in ECONOMIC_DOMAINS:
            raise ValueError(f"coverage_ledger[{index}] has unsupported economic_domain {economic_domain!r}.")
        if not isinstance(concept_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", concept_id):
            raise ValueError(f"coverage_ledger[{index}] has invalid concept_id {concept_id!r}.")
        if model_use not in MODEL_USES:
            raise ValueError(f"coverage_ledger[{index}] has unsupported model_use {model_use!r}.")
        if evidence_kind not in EVIDENCE_KINDS:
            raise ValueError(f"coverage_ledger[{index}] has unsupported evidence_kind {evidence_kind!r}.")
        if not isinstance(definition_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", definition_id):
            raise ValueError(f"coverage_ledger[{index}] has no valid definition_id.")
        if disposition not in DISPOSITIONS:
            raise ValueError(f"coverage_ledger[{index}] has unsupported disposition {disposition!r}.")
        mapping_ids = entry.get("mapping_ids") or []
        if disposition in MAPPED_DISPOSITIONS:
            if metric_id not in (crosswalk.get("metrics") or {}):
                raise ValueError(f"coverage_ledger[{index}] maps undeclared metric_id {metric_id!r}.")
            metric = crosswalk["metrics"][metric_id]
            if metric.get("definition_id") != definition_id:
                raise ValueError(f"coverage_ledger[{index}] definition_id does not match metric {metric_id!r}.")
            metric_domain = metric.get("economic_domain") or DOMAIN_BY_LEGACY_ROLE.get(metric.get("semantic_role"))
            metric_concept = metric.get("concept_id") or metric_id
            if metric_domain != economic_domain or metric_concept != concept_id:
                raise ValueError(f"coverage_ledger[{index}] semantic axes do not match metric {metric_id!r}.")
            if crosswalk.get("schema_version") == "broker-crosswalk/1.1" and metric.get("semantic_role") != semantic_role:
                raise ValueError(f"coverage_ledger[{index}] semantic_role does not match metric {metric_id!r}.")
            if not str(entry.get("definition_evidence") or "").strip():
                raise ValueError(f"coverage_ledger[{index}] mapped evidence lacks definition_evidence.")
            if evidence_kind not in {"broker_estimate", "calculated_check"}:
                raise ValueError(f"coverage_ledger[{index}] disposition {disposition} has incompatible evidence_kind {evidence_kind!r}.")
            if not mapping_ids:
                raise ValueError(f"coverage_ledger[{index}] disposition {disposition} requires mapping_ids.")
            candidate_cells = {(table_id, item["row"], item["column"]) for item in resolved_cells}
            for mapping_id in mapping_ids:
                mapping = mapping_by_id.get(mapping_id)
                if mapping is None:
                    raise ValueError(f"coverage_ledger[{index}] names unknown mapping_id {mapping_id!r}.")
                if mapping["house_id"] != house_id or mapping["metric_id"] != metric_id:
                    raise ValueError(f"coverage_ledger[{index}] mapping {mapping_id!r} has a different house or metric.")
                if mapping.get("definition_id") != definition_id:
                    raise ValueError(f"coverage_ledger[{index}] mapping {mapping_id!r} has a different definition_id.")
                component_cells = mapping_cells[mapping_id]
                if not (component_cells & candidate_cells):
                    raise ValueError(f"coverage_ledger[{index}] mapping {mapping_id!r} does not consume one of the candidate's source cells.")
                if mapping_id not in derived_mapping_ids and not component_cells <= candidate_cells:
                    raise ValueError(
                        f"coverage_ledger[{index}] direct mapping {mapping_id!r} contains source cells "
                        "outside its immutable candidate; multi-candidate arithmetic requires a declared derived_mapping."
                    )
                if mapping_id not in derived_mapping_ids and candidate_manifest is not None and basis == "annual_forecast":
                    period_index = int(mapping.get("period_index", -1))
                    period_columns = expected_entry.get("period_columns_by_index") or {}
                    if period_index not in period_columns:
                        raise ValueError(
                            f"coverage_ledger[{index}] direct mapping {mapping_id!r} has no immutable candidate period at index {period_index}."
                        )
                    period_column = int(period_columns[period_index])
                    period_cells = {(table_id, row, period_column)}
                    if not component_cells <= period_cells:
                        raise ValueError(
                            f"coverage_ledger[{index}] direct mapping {mapping_id!r} contains a source cell "
                            "from another forecast period; each direct mapping must cite only its own immutable period cell."
                        )
                referenced_mappings.add(mapping_id)
            if disposition == "supplemental_check" and (crosswalk["metrics"][metric_id].get("model_disposition") != "reference_only"):
                raise ValueError(f"Supplemental metric {metric_id!r} must declare model_disposition=reference_only.")
        elif mapping_ids:
            raise ValueError(f"coverage_ledger[{index}] carries mapping_ids but disposition {disposition!r} is not mapped.")
        if disposition in {"mapped_guidance", "broker_derived_estimate", "partial_period_evidence"} and not isinstance(metric_id, str):
            raise ValueError(f"coverage_ledger[{index}] disposition {disposition} requires metric_id.")
        if isinstance(metric_id, str) and disposition in {"mapped_guidance", "broker_derived_estimate", "partial_period_evidence"}:
            metric = (crosswalk.get("metrics") or {}).get(metric_id)
            if metric is None:
                raise ValueError(f"coverage_ledger[{index}] names undeclared metric_id {metric_id!r}.")
            if disposition == "partial_period_evidence" and (
                metric.get("definition_id") != definition_id or metric.get("semantic_role") != semantic_role
            ):
                raise ValueError(f"coverage_ledger[{index}] definition or semantic role disagrees with metric {metric_id!r}.")
        if disposition == "partial_period_evidence" and basis != "partial_period":
            raise ValueError(f"coverage_ledger[{index}] partial-period evidence has basis {basis!r}.")
        if disposition == "partial_period_evidence" and evidence_kind != "partial_period":
            raise ValueError(f"coverage_ledger[{index}] partial-period evidence has evidence_kind {evidence_kind!r}.")
        if disposition == "mapped_guidance" and basis not in {"guidance", "non_periodic"}:
            raise ValueError(f"coverage_ledger[{index}] mapped guidance has basis {basis!r}.")
        if disposition == "mapped_guidance" and evidence_kind != "company_guidance":
            raise ValueError(f"coverage_ledger[{index}] mapped guidance is not company_guidance evidence.")
        if disposition == "mapped_guidance" and semantic_role != "management_guidance":
            raise ValueError(f"coverage_ledger[{index}] mapped guidance lacks the management_guidance semantic role.")
        if disposition == "broker_derived_estimate" and evidence_kind != "broker_derived_estimate":
            raise ValueError(f"coverage_ledger[{index}] broker-derived estimate has evidence_kind {evidence_kind!r}.")
        if disposition == "broker_derived_estimate" and semantic_role != "broker_derived_estimate":
            raise ValueError(f"coverage_ledger[{index}] broker-derived estimate lacks its semantic role.")
        if disposition == "not_model_relevant":
            label = str(entry.get("label") or (expected_entry or {}).get("label") or "")
            if model_use != "reference_only":
                raise ValueError(f"coverage_ledger[{index}] excluded evidence must remain reference_only.")
            if semantic_role is not None and semantic_role not in NOT_MODEL_RELEVANT_ROLES:
                raise ValueError(f"coverage_ledger[{index}] excludes model-relevant semantic role {semantic_role!r}.")
            if MODEL_RELEVANT_LABEL.search(label) and not (
                semantic_role == "valuation_market_data" and VALUATION_LABEL.search(label)
            ):
                raise ValueError(f"coverage_ledger[{index}] excludes an apparently model-relevant row {label!r}.")
            if semantic_role == "valuation_market_data" and evidence_kind != "market_data":
                raise ValueError(f"coverage_ledger[{index}] valuation row is not marked market_data.")
        if disposition == "unusable":
            if evidence_kind != "non_numeric":
                raise ValueError(f"coverage_ledger[{index}] unusable evidence must be non_numeric.")
            if any(has_numeric_signal(item.get("raw_value")) for item in resolved_cells):
                raise ValueError(f"coverage_ledger[{index}] marks numeric evidence unusable.")
        candidate_authority = (expected_entry or {}).get("authority_status", "verified")
        if candidate_authority == "quarantined_conflict":
            if disposition != "quarantined_conflict" or model_use != "unresolved" or mapping_ids:
                raise ValueError(
                    f"coverage_ledger[{index}] is source-quarantined and must remain unmapped with model_use=unresolved."
                )
        elif disposition == "quarantined_conflict":
            raise ValueError(
                f"coverage_ledger[{index}] quarantines a source-verified candidate without conflict evidence."
            )
        duplicate_of = entry.get("duplicate_of")
        if disposition == "duplicate" and not duplicate_of:
            raise ValueError(f"coverage_ledger[{index}] duplicate has no duplicate_of target.")
        if disposition != "duplicate" and duplicate_of:
            raise ValueError(f"coverage_ledger[{index}] has duplicate_of without duplicate disposition.")
        if entry.get("review_status") != "reviewed" or not str(entry.get("rationale") or "").strip():
            raise ValueError(f"coverage_ledger[{index}] lacks a reviewed rationale.")
        if (
            any(has_numeric_signal(item.get("raw_value")) for item in resolved_cells)
            and concept_id.startswith("custom.")
            and model_use != "reference_only"
            and disposition != "quarantined_conflict"
        ):
            raise ValueError(f"coverage_ledger[{index}] unknown numeric concept must be custom.* reference_only.")
        resolved = normalized_entry
        resolved["source_cells"] = resolved_cells
        resolved.setdefault("label", expected_entry["label"] if expected_entry else row_label(table, row, min(item["column"] for item in resolved_cells)))
        resolved_ledger.append(resolved)
        by_candidate_id[candidate_id] = resolved

    if candidate_manifest is not None:
        overlap = sorted(set(by_candidate_id) & set(terminal_by_id))
        if overlap:
            raise ValueError("Terminal broker quarantine overlaps the ordinary coverage ledger: " + ", ".join(overlap[:8]))
        extra_terminal = sorted(set(terminal_by_id) - set(expected_by_candidate_id))
        if extra_terminal:
            raise ValueError("Terminal broker quarantine names candidates outside the immutable manifest: " + ", ".join(extra_terminal[:8]))
        missing_candidate_ids = sorted(set(expected_by_candidate_id) - set(by_candidate_id) - set(terminal_by_id))
        if missing_candidate_ids:
            raise ValueError(
                f"Broker candidate-manifest coverage is incomplete; {len(missing_candidate_ids)} candidates have no disposition: "
                + ", ".join(missing_candidate_ids[:8])
            )
        missing_candidates = []
    else:
        missing_candidates = sorted(set(expected) - set(by_expected_key))
    if missing_candidates:
        preview = ", ".join(f"{table}!R{row}:{basis}" for table, row, basis in missing_candidates[:8])
        raise ValueError(f"Broker forecast coverage is incomplete; {len(missing_candidates)} candidate rows have no disposition: {preview}.")
    for candidate_id, terminal in sorted(terminal_by_id.items()):
        candidate = expected_by_candidate_id[candidate_id]
        table_id = str(candidate["table_id"])
        _document, table = tables[table_id]
        source_cells = []
        for cell in candidate["source_cells"]:
            row = int(cell["row"])
            column = int(cell["column"])
            source_cells.append({
                "row": row,
                "column": column,
                "raw_value": table["rows"][row - 1][column - 1].get("raw_value"),
                "authority_status": candidate.get("authority_status"),
            })
        resolved = {
            "candidate_id": candidate_id,
            "document_id": candidate.get("document_id"),
            "house_id": candidate.get("house_id"),
            "table_id": table_id,
            "row": candidate.get("row"),
            "label": candidate.get("label"),
            "period_basis": candidate.get("period_basis"),
            "period_indexes": candidate.get("period_indexes", []),
            "source_cells": source_cells,
            "disposition": "preserve_unconsumed_quarantine",
            "model_use": "unresolved",
            "model_consumption": "prohibited",
            "finding_codes": terminal.get("finding_codes", []),
            "rationale": terminal.get("rationale"),
            "review_status": "reviewed",
        }
        resolved_ledger.append(resolved)
        by_candidate_id[candidate_id] = resolved
    for candidate_id, entry in by_candidate_id.items():
        if entry.get("disposition") != "duplicate":
            continue
        target = by_candidate_id.get(entry.get("duplicate_of"))
        if target is None or target["candidate_id"] == candidate_id:
            raise ValueError(f"Duplicate candidate {candidate_id!r} has an absent or self-referential target.")
        if target["house_id"] != entry["house_id"]:
            raise ValueError(f"Duplicate candidate {candidate_id!r} points across houses.")
        if target.get("disposition") == "duplicate":
            raise ValueError(f"Duplicate candidate {candidate_id!r} points to another duplicate instead of a canonical candidate.")
        for field in ("period_basis", "period_indexes", "definition_id", "economic_domain", "concept_id", "evidence_kind", "definition_fingerprint"):
            if target.get(field) != entry.get(field):
                raise ValueError(f"Duplicate candidate {candidate_id!r} disagrees with its target on {field}.")
        if candidate_value_signature(target) != candidate_value_signature(entry):
            raise ValueError(f"Duplicate candidate {candidate_id!r} does not exactly match its target values.")
        if not str(entry.get("definition_evidence") or "").strip():
            raise ValueError(f"Duplicate candidate {candidate_id!r} lacks definition_evidence.")

    mapped_by_metric: dict[str, list[dict[str, Any]]] = {}
    for entry in resolved_ledger:
        if entry.get("disposition") in MAPPED_DISPOSITIONS:
            mapped_by_metric.setdefault(entry["metric_id"], []).append(entry)
    for metric_id, entries in mapped_by_metric.items():
        signatures = {fingerprint_hash(entry.get("definition_fingerprint") or {}) for entry in entries}
        if len(signatures) > 1:
            rendered = ", ".join(entry["candidate_id"] for entry in entries)
            raise ValueError(f"Metric {metric_id!r} combines incompatible structured definition fingerprints: {rendered}.")

    resolved_derivations = []
    derivation_ids: set[str] = set()
    for index, derivation in enumerate(crosswalk.get("derived_mappings") or []):
        derivation_id = derivation.get("derivation_id")
        if not isinstance(derivation_id, str) or not derivation_id or derivation_id in derivation_ids:
            raise ValueError(f"derived_mappings[{index}] has an absent or duplicate derivation_id.")
        derivation_ids.add(derivation_id)
        mapping_id = derivation.get("mapping_id")
        mapping = mapping_by_id.get(mapping_id)
        if mapping is None:
            raise ValueError(f"derived_mappings[{index}] names unknown mapping_id {mapping_id!r}.")
        for field in ("house_id", "metric_id", "definition_id", "period_index"):
            if mapping.get(field) != derivation.get(field):
                raise ValueError(f"derived_mappings[{index}] disagrees with mapping {mapping_id!r} on {field}.")
        metric = (crosswalk.get("metrics") or {}).get(derivation.get("metric_id"))
        if metric is None or metric.get("definition_id") != derivation.get("definition_id"):
            raise ValueError(f"derived_mappings[{index}] targets an undeclared or incompatible metric definition.")
        input_ids = derivation.get("input_candidate_ids") or []
        if len(set(input_ids)) < 2:
            raise ValueError(f"derived_mappings[{index}] requires at least two distinct input candidates.")
        input_entries = []
        for candidate_id in input_ids:
            candidate = by_candidate_id.get(candidate_id)
            if candidate is None:
                raise ValueError(f"derived_mappings[{index}] names unknown input candidate {candidate_id!r}.")
            if candidate["house_id"] != derivation.get("house_id"):
                raise ValueError(f"derived_mappings[{index}] reaches across houses.")
            if candidate.get("disposition") in {"unusable", "not_model_relevant", "duplicate"}:
                raise ValueError(f"derived_mappings[{index}] consumes ineligible candidate {candidate_id!r}.")
            input_entries.append(candidate)
        component_cells = mapping_cells[mapping_id]
        for candidate in input_entries:
            candidate_cells = {
                (candidate["table_id"], int(item["row"]), int(item["column"]))
                for item in candidate.get("source_cells") or []
            }
            if not (component_cells & candidate_cells):
                raise ValueError(f"derived_mappings[{index}] does not consume candidate {candidate['candidate_id']!r}.")
        if not str(derivation.get("expression") or "").strip() or not str(derivation.get("rationale") or "").strip() or derivation.get("review_status") != "reviewed":
            raise ValueError(f"derived_mappings[{index}] lacks reviewed expression evidence.")
        referenced_mappings.add(mapping_id)
        resolved_derivations.append(dict(derivation))

    unreferenced_mappings = sorted(set(mapping_by_id) - referenced_mappings)
    if unreferenced_mappings:
        raise ValueError(f"Every compiled mapping must be owned by the coverage ledger; unreferenced: {', '.join(unreferenced_mappings[:8])}.")
    disposition_counts: dict[str, int] = {}
    for entry in resolved_ledger:
        disposition_counts[entry["disposition"]] = disposition_counts.get(entry["disposition"], 0) + 1
    summary = {
        "table_count": len(tables),
        "table_review_count": len(review_by_table),
        "detected_forecast_candidate_count": len(expected_by_candidate_id) if candidate_manifest is not None else len(expected),
        "coverage_entry_count": len(resolved_ledger),
        "unresolved_candidate_count": 0,
        "terminal_quarantined_candidate_count": len(terminal_by_id),
        "unresolved_selected_candidate_count": 0,
        "semantic_quality_violation_count": int(semantic_violation_count),
        "candidate_manifest_count": len(expected_by_candidate_id),
        "candidate_authority": "deterministic_manifest" if candidate_manifest is not None else "legacy_reviewer_columns_fail_closed",
        "mapping_count": len(mapping_by_id),
        "derived_mapping_count": len(resolved_derivations),
        "disposition_counts": dict(sorted(disposition_counts.items())),
    }
    return resolved_ledger, summary, resolved_derivations


def parse_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or value is None:
        raise ValueError(f"{label} is not numeric.")
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip()
        match = NUMBER.fullmatch(text)
        if not match:
            raise ValueError(f"{label}={value!r} is not an unambiguous numeric cell.")
        negative = bool(match.group(1)) or text.startswith("-")
        cleaned = re.sub(r"[$€£¥,%() ]", "", text)
        number = float(cleaned)
        if negative:
            number = -abs(number)
        if match.group(4):
            number /= 100.0
    if not math.isfinite(number):
        raise ValueError(f"{label} is not finite.")
    return number


def scalar_rows(table: dict[str, Any]) -> list[list[Any]]:
    return [[cell.get("value") for cell in row] for row in table["rows"]]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    parser.add_argument("crosswalk")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    bundle = json.loads(Path(args.bundle).read_text("utf-8"))
    crosswalk = json.loads(Path(args.crosswalk).read_text("utf-8"))
    output_root = Path(args.out).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    # The pack accepts BOTH closed physical shapes: the extraction bundle
    # (early-vision-zone closure) and the canonical-tables bundle (canonical
    # reconciliation closure). Requiring only the extraction schema silently
    # terminated every run that traversed the canonical stage.
    if (
        bundle.get("schema_version") not in {"broker-extraction-bundle/1.0", "broker-canonical-tables/1.0"}
        or bundle.get("gate_status") != "PASS"
    ):
        raise ValueError(
            "Broker evidence must be a PASS broker-extraction-bundle/1.0 or "
            "broker-canonical-tables/1.0 before semantic mapping."
        )
    if crosswalk.get("schema_version") not in {"broker-crosswalk/1.1", "broker-crosswalk/1.2"}:
        raise ValueError("Unsupported broker crosswalk schema.")
    if crosswalk.get("run_id") != bundle.get("run_id"):
        raise ValueError("The crosswalk run_id is not bound to the extraction bundle.")
    bundle_sha256 = hashlib.sha256(Path(args.bundle).read_bytes()).hexdigest()

    documents_by_house: dict[str, dict[str, Any]] = {}
    tables: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    for document in bundle["documents"]:
        house_id = document["house_id"]
        if house_id in documents_by_house:
            raise ValueError(f"More than one document is assigned to house_id {house_id!r}; consolidate the evidence deliberately before compilation.")
        documents_by_house[house_id] = document
        for table in document["tables"]:
            table_id = table["table_id"]
            if table_id in tables:
                raise ValueError(f"Duplicate table_id {table_id!r}.")
            tables[table_id] = (document, table)

    semantic_report = None
    candidate_manifest = bundle.get("candidate_manifest")
    if candidate_manifest is not None or crosswalk.get("schema_version") == "broker-crosswalk/1.2":
        report_path = output_root / "broker-semantic-verification-report.json"
        verifier = Path(__file__).with_name("verify_broker_semantics.py")
        process = subprocess.run(
            [sys.executable, str(verifier), str(Path(args.bundle).resolve()), str(Path(args.crosswalk).resolve()), "--out", str(report_path)],
            text=True,
            capture_output=True,
            check=False,
        )
        if not report_path.exists():
            raise ValueError(f"Independent broker semantic verifier produced no report: {process.stderr or process.stdout}")
        semantic_report = json.loads(report_path.read_text("utf-8"))
        if semantic_report.get("crosswalk_sha256") != hash_json(crosswalk):
            raise ValueError("Independent semantic report is not bound to the canonical crosswalk payload.")
        if process.returncode != 0 or semantic_report.get("status") != "PASS":
            total = int(semantic_report.get("total_violation_count", -1))
            print(json.dumps({"status": "BLOCKED", "total_violation_count": total}, sort_keys=True))
            return 2

    if not 3 <= len(documents_by_house) <= 10:
        raise ValueError("A production broker pack requires 3-10 distinct houses.")
    metrics = crosswalk.get("metrics") or {}

    # ---------------------------------------------- the vocabulary is closed
    #
    # Deciding that a row means `capex` is a judgment only a reader can make, and
    # the dictionary's definitions exist to inform it. What is not negotiable is
    # the name that judgment is recorded under: an id invented at runtime cannot
    # be compared across houses, cannot be checked for double-counting, and
    # cannot be rendered in a standardised digest. So every id resolves to a
    # dictionary concept or the pack refuses.
    #
    # One concept can legitimately occur several times in one house - two
    # reported segments, three separate impairment lines - so an id may carry an
    # instance qualifier after `__`. The concept before the qualifier is what
    # must be known. Core drivers may not be instanced: `capex__maintenance` is
    # not capex, it is a component, and consuming it as the driver is precisely
    # the granularity error the tiers exist to prevent.
    for metric_id in sorted(metrics):
        concept, _, qualifier = str(metric_id).partition("__")
        if concept not in KNOWN_METRIC_IDS:
            raise ValueError(
                f"Metric {metric_id!r} resolves to concept {concept!r}, which is not in the broker "
                "metric dictionary. Map it to an existing concept, or extend "
                "assets/broker-metric-dictionary.json under review; ids may not be invented at runtime."
            )
        if qualifier and concept in CORE_METRIC_IDS:
            raise ValueError(
                f"Metric {metric_id!r} instances the core driver {concept!r}. A core driver is "
                "consumed once, in aggregate; publish the parts under a component concept instead."
            )
        if qualifier and not re.fullmatch(r"[a-z0-9_]+", qualifier):
            raise ValueError(
                f"Metric {metric_id!r} has a malformed instance qualifier {qualifier!r}."
            )

    missing_metrics = sorted(REQUIRED_METRICS - set(metrics))
    if missing_metrics:
        raise ValueError(f"The crosswalk is missing required metrics: {', '.join(missing_metrics)}.")
    if not ({"ebit", "adjusted_ebitda"} & set(metrics)):
        raise ValueError("The crosswalk requires at least one headline metric: EBIT or Adjusted EBITDA.")
    if len(crosswalk.get("forecast_periods") or []) != 3:
        raise ValueError("The broker crosswalk must declare exactly three forecast periods.")
    for metric_id, declaration in metrics.items():
        definition_id = declaration.get("definition_id")
        semantic_role = declaration.get("semantic_role")
        economic_domain = declaration.get("economic_domain") or DOMAIN_BY_LEGACY_ROLE.get(semantic_role)
        concept_id = declaration.get("concept_id") or metric_id
        if not isinstance(definition_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", definition_id):
            raise ValueError(f"Metric {metric_id!r} requires a valid definition_id.")
        if crosswalk.get("schema_version") == "broker-crosswalk/1.1" and semantic_role not in SEMANTIC_ROLES:
            raise ValueError(f"Metric {metric_id!r} requires a supported semantic_role.")
        if economic_domain not in ECONOMIC_DOMAINS:
            raise ValueError(f"Metric {metric_id!r} requires a supported economic_domain.")
        if not isinstance(concept_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", concept_id):
            raise ValueError(f"Metric {metric_id!r} requires a valid concept_id.")
        if crosswalk.get("schema_version") == "broker-crosswalk/1.2":
            if declaration.get("evidence_kind") not in EVIDENCE_KINDS:
                raise ValueError(f"Metric {metric_id!r} requires a supported evidence_kind.")
            if declaration.get("model_use") not in MODEL_USES:
                raise ValueError(f"Metric {metric_id!r} requires a supported model_use.")
            if not isinstance(declaration.get("definition_fingerprint"), dict):
                raise ValueError(f"Metric {metric_id!r} requires a structured definition_fingerprint.")
        disposition = declaration.get("model_disposition")
        reason = declaration.get("model_disposition_reason")
        if bool(disposition) != bool(isinstance(reason, str) and reason.strip()):
            raise ValueError(
                f"Metric {metric_id!r} must supply model_disposition and model_disposition_reason together."
            )

    estimates: dict[str, dict[str, list[float | None]]] = {
        house_id: {metric_id: [None, None, None] for metric_id in metrics}
        for house_id in documents_by_house
    }
    mapping_receipts = []
    occupied: set[tuple[str, str, int]] = set()
    mapping_ids: set[str] = set()
    for index, mapping in enumerate(crosswalk.get("mappings") or []):
        mapping_id = mapping.get("mapping_id")
        house_id = mapping.get("house_id")
        metric_id = mapping.get("metric_id")
        definition_id = mapping.get("definition_id")
        period_index = mapping.get("period_index")
        key = (house_id, metric_id, period_index)
        if house_id not in documents_by_house:
            raise ValueError(f"mappings[{index}] names unknown house_id {house_id!r}.")
        if metric_id not in metrics:
            raise ValueError(f"mappings[{index}] names undeclared metric_id {metric_id!r}.")
        if definition_id != metrics[metric_id].get("definition_id"):
            raise ValueError(f"mappings[{index}] definition_id does not match metric {metric_id!r}.")
        if period_index not in {0, 1, 2}:
            raise ValueError(f"mappings[{index}] has invalid period_index.")
        if key in occupied:
            raise ValueError(f"Duplicate broker mapping for {key}.")
        if not isinstance(mapping_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", mapping_id):
            raise ValueError(f"mappings[{index}] has invalid mapping_id.")
        if mapping_id in mapping_ids:
            raise ValueError(f"Duplicate mapping_id {mapping_id!r}.")
        mapping_ids.add(mapping_id)
        occupied.add(key)
        components = []
        total = float(mapping.get("constant", 0.0))
        for component_index, component in enumerate(mapping.get("sources") or []):
            table_id = component.get("table_id")
            if table_id not in tables:
                raise ValueError(f"mappings[{index}].sources[{component_index}] names unknown table {table_id!r}.")
            document, table = tables[table_id]
            if document["house_id"] != house_id:
                raise ValueError(f"mappings[{index}] reaches across houses from {house_id!r} to {document['house_id']!r}.")
            row = int(component.get("row", 0))
            column = int(component.get("column", 0))
            try:
                cell = table["rows"][row - 1][column - 1]
            except (IndexError, TypeError):
                raise ValueError(f"mappings[{index}] cell {table_id}!R{row}C{column} does not exist.")
            if cell.get("authority_status") == "quarantined_conflict":
                raise ValueError(
                    f"mappings[{index}] attempts to consume quarantined broker cell {table_id}!R{row}C{column}."
                )
            coefficient = float(component.get("coefficient", 0.0))
            raw_value = parse_number(cell.get("value"), f"{table_id}!R{row}C{column}")
            contribution = raw_value * coefficient
            total += contribution
            components.append({
                "table_id": table_id,
                "row": row,
                "column": column,
                "source_ref": cell["source_ref"],
                "raw_value": raw_value,
                "coefficient": coefficient,
                "contribution": contribution,
            })
        multiplier = float(mapping.get("multiplier", 1.0))
        total *= multiplier
        estimates[house_id][metric_id][period_index] = total
        mapping_receipts.append({
            "mapping_id": mapping_id,
            "house_id": house_id,
            "metric_id": metric_id,
            "definition_id": definition_id,
            "period_index": period_index,
            "components": components,
            "constant": float(mapping.get("constant", 0.0)),
            "multiplier": multiplier,
            "value": total,
            "rationale": mapping.get("rationale"),
            "review_status": mapping.get("review_status", "reviewed"),
        })

    # ------------------------------------------------ broker consumption tiers
    #
    # The model consumes a deliberately narrow slice of what the houses
    # published. Tier 1 is the fixed core the debt overlay runs on and is
    # always admissible. Any other ACTIVE metric is Tier 2 flex and needs all
    # of: an explicit election recorded in the crosswalk, and at least three
    # houses supplying it under the single declared definition - the same
    # "three is the minimum for a meaningful consensus" bar the intake screen
    # states for the pack itself. Everything else is Tier 3 evidence: it stays
    # lossless in the source tables and may ride along as reference_only, but
    # it never becomes an active model input. This is what stops a run from
    # projecting hundreds of broker line items into the workbook - an evidence
    # dump wearing a model's clothes.
    # Tier 2 is no longer a list of blessed concept names. It is a SHAPE: an
    # individual cash-flow line item. A concept whitelist needed maintaining
    # every time a sector printed something new, and it still admitted the wrong
    # things - a revenue split is not a cash flow, and `share_buybacks` sat on it
    # for want of a core slot it has now been given. The shape rule generalises:
    # if several houses print a distinct cash movement separately and it does not
    # duplicate a driver the model already has, it can ride; anything else stays
    # evidence, visible on the house tabs, out of the forecast.
    TIER1_METRIC_IDS = set(CORE_METRIC_IDS)
    MAX_FLEX_ELECTIONS = 10
    flex_elections = crosswalk.get("flex_elections") or []
    if len(flex_elections) > MAX_FLEX_ELECTIONS:
        raise ValueError(
            f"{len(flex_elections)} flex elections exceed the {MAX_FLEX_ELECTIONS}-concept ceiling; "
            "a forecast surface this wide is an evidence dump, not a model."
        )
    core_overlap_groups = {
        METRIC_BY_ID[metric_id].get("overlap_group")
        for metric_id in TIER1_METRIC_IDS
        if METRIC_BY_ID.get(metric_id, {}).get("overlap_group")
    }
    elected_by_metric = {}
    for index, election in enumerate(flex_elections):
        metric_id = election.get("metric_id")
        concept = election.get("concept")
        rationale = election.get("rationale")
        if metric_id not in metrics:
            raise ValueError(f"flex_elections[{index}] names undeclared metric_id {metric_id!r}.")
        if metric_id in TIER1_METRIC_IDS:
            raise ValueError(f"flex_elections[{index}]: {metric_id!r} is Tier 1 and needs no election.")
        entry = METRIC_BY_ID.get(concept)
        if entry is None:
            raise ValueError(
                f"flex_elections[{index}] concept {concept!r} is not in the broker metric dictionary."
            )
        if concept in BANNED_TOTAL_IDS:
            raise ValueError(
                f"flex_elections[{index}] elects {concept!r}, a statement subtotal the model derives "
                "itself. Elect the individual flows beneath it or leave it as evidence."
            )
        if entry["statement_family"] != "cash_flow":
            raise ValueError(
                f"flex_elections[{index}] elects {concept!r} from the {entry['statement_family']} "
                "statement; only cash-flow line items are electable, because the overlay is a cash "
                "model and an election lands as one more flow."
            )
        if entry["leaf"] is not True:
            raise ValueError(
                f"flex_elections[{index}] elects {concept!r}, which the dictionary marks a subtotal; "
                "only individual line items are electable."
            )
        if concept not in FLEX_ELIGIBLE_IDS:
            raise ValueError(
                f"flex_elections[{index}] concept {concept!r} is not offered for election "
                f"({', '.join(sorted(FLEX_ELIGIBLE_IDS))})."
            )
        overlap = entry.get("overlap_group")
        if overlap and overlap in core_overlap_groups:
            raise ValueError(
                f"flex_elections[{index}] elects {concept!r}, which shares the {overlap!r} overlap "
                "group with a core driver. Consuming both spends the same cash twice."
            )
        if not isinstance(rationale, str) or not rationale.strip():
            raise ValueError(f"flex_elections[{index}] requires a rationale.")
        if metric_id in elected_by_metric:
            raise ValueError(f"flex_elections[{index}] repeats metric_id {metric_id!r}.")
        # Two admission routes. Consensus (three or more houses) pools the
        # market's view; attributed (one or two) consumes a NAMED house's own
        # series and renders wearing that name, because the danger of a single
        # source was never that one analyst might be right - it was averaging
        # one voice into consensus clothing. Attribution un-launders it, and
        # the inclusion is the user's recorded call, never the run's.
        basis = election.get("basis") or "consensus"
        if basis not in {"consensus", "attributed"}:
            raise ValueError(f"flex_elections[{index}] has unsupported basis {basis!r}.")
        if basis == "attributed":
            source_house_id = election.get("source_house_id")
            if source_house_id not in documents_by_house:
                raise ValueError(
                    f"flex_elections[{index}] attributes {metric_id!r} to unknown house "
                    f"{source_house_id!r}."
                )
            if election.get("confirmed_by_user") is not True:
                raise ValueError(
                    f"flex_elections[{index}]: an attributed inclusion is the user's call; "
                    "record confirmed_by_user: true from the consolidated Stage-2 answer."
                )
            house_series = estimates[source_house_id].get(metric_id, [None, None, None])
            if not all(
                value is not None and math.isfinite(float(value)) for value in house_series
            ):
                raise ValueError(
                    f"flex_elections[{index}]: house {source_house_id!r} does not supply "
                    f"{metric_id!r} in all three forecast periods; an attributed row has no "
                    "pool to substitute from."
                )
        elected_by_metric[metric_id] = election
    for metric_id, declaration in metrics.items():
        if metric_id in TIER1_METRIC_IDS:
            continue
        # model_use is a crosswalk/1.2 field. Earlier schema generations have
        # no consumption vocabulary at all, so the tier rule cannot be read
        # into them retroactively; the case-level coverage gate still holds
        # the model side regardless of pack generation.
        model_use = declaration.get("model_use")
        if model_use is None:
            continue
        if model_use not in {"active_input", "derived_input"}:
            continue
        election = elected_by_metric.get(metric_id)
        if election is None:
            raise ValueError(
                f"Metric {metric_id!r} is active but is neither Tier 1 core nor elected flex. "
                "Either record a flex election with a whitelisted concept, or reclassify it "
                "reference_only so it remains evidence."
            )
        supporting_houses = sum(
            1 for house_id in documents_by_house
            if all(
                value is not None and math.isfinite(float(value))
                for value in estimates[house_id].get(metric_id, [None, None, None])
            )
        )
        if (election.get("basis") or "consensus") == "attributed":
            if supporting_houses >= 3:
                raise ValueError(
                    f"Flex metric {metric_id!r} is supported by {supporting_houses} houses; a "
                    "genuine consensus exists, so elect it as consensus rather than narrowing "
                    "it to one house's series."
                )
            continue
        if supporting_houses < 3:
            raise ValueError(
                f"Flex metric {metric_id!r} ({election.get('concept')}) is supported by only "
                f"{supporting_houses} house(s) across all three forecast periods; three compatible "
                "houses are the minimum for a consumable consensus. Elect it as an attributed "
                "single-house line with the user's recorded confirmation, or it stays evidence."
            )

    # ---------------------------------------------------------- election gauge
    #
    # Nothing important is silently dropped and nothing is silently adopted:
    # every cash-flow leaf concept any house printed is weighed here, on the
    # record. Three or more houses -> a consensus election exists (or should).
    # One or two houses and material against the headline anchor -> a candidate
    # for the user's single consolidated Stage-2 question, entering only as an
    # attributed named-house line if confirmed. Small or structurally
    # inadmissible -> parked, visibly, on the house tabs. The gauge is data in
    # the pack, so the workbook can print the weighing and the attestation can
    # hold it.
    anchor_series = []
    for anchor_id in ("adjusted_ebitda", "ebit"):
        if anchor_id in metrics:
            for period_index in range(3):
                pooled = [
                    estimates[house_id][anchor_id][period_index]
                    for house_id in documents_by_house
                    if estimates[house_id].get(anchor_id)
                    and estimates[house_id][anchor_id][period_index] is not None
                ]
                if pooled:
                    anchor_series.append(sum(pooled) / len(pooled))
            if anchor_series:
                break
    anchor_scale = max((abs(value) for value in anchor_series), default=None)
    MATERIALITY_FLOOR = 0.05
    election_gauge = []
    for metric_id in sorted(metrics):
        election = elected_by_metric.get(metric_id)
        # An elected metric is weighed under the concept its election declared -
        # the shape gate already proved that concept legal - while an unelected
        # metric is weighed under its own dictionary concept.
        concept = (
            election["concept"] if election is not None
            else str(metric_id).partition("__")[0]
        )
        entry_meta = METRIC_BY_ID.get(concept) or {}
        if concept in TIER1_METRIC_IDS or metric_id in TIER1_METRIC_IDS:
            continue
        if entry_meta.get("statement_family") != "cash_flow" or entry_meta.get("leaf") is not True:
            continue
        if concept in BANNED_TOTAL_IDS:
            continue
        supporting = [
            house_id for house_id in documents_by_house
            if all(
                value is not None and math.isfinite(float(value))
                for value in estimates[house_id].get(metric_id, [None, None, None])
            )
        ]
        if not supporting:
            continue
        peak = max(
            abs(float(value))
            for house_id in supporting
            for value in estimates[house_id][metric_id]
        )
        materiality = (peak / anchor_scale) if anchor_scale else None
        overlap = entry_meta.get("overlap_group")
        overlap_blocked = bool(overlap and overlap in core_overlap_groups)
        electable = concept in FLEX_ELIGIBLE_IDS and not overlap_blocked
        if election is not None:
            bin_name = (
                "elected_consensus"
                if (election.get("basis") or "consensus") == "consensus"
                else "included_attributed"
            )
        elif not electable:
            bin_name = "parked_inadmissible"
        elif len(supporting) >= 3:
            bin_name = "eligible_consensus_unelected"
        elif materiality is not None and materiality >= MATERIALITY_FLOOR:
            bin_name = "candidate_attributed"
        else:
            bin_name = "parked_below_materiality"
        election_gauge.append({
            "metric_id": metric_id,
            "concept": concept,
            "display_label": entry_meta.get("display_label", metric_id),
            "supporting_house_ids": sorted(supporting),
            "supporting_house_count": len(supporting),
            "peak_abs_value": peak,
            "materiality_vs_anchor": materiality,
            "materiality_floor": MATERIALITY_FLOOR,
            **({"overlap_group": overlap} if overlap else {}),
            "bin": bin_name,
        })

    resolved_coverage, coverage_summary, resolved_derivations = validate_coverage(
        crosswalk,
        documents_by_house,
        tables,
        mapping_receipts,
        candidate_manifest=candidate_manifest,
        semantic_violation_count=int((semantic_report or {}).get("total_violation_count", 0)),
        bundle=bundle,
        bundle_sha256=bundle_sha256,
    )
    review_by_table = {
        review["table_id"]: review
        for review in crosswalk["table_reviews"]
    }
    mapped_table_ids = {
        component["table_id"]
        for mapping in mapping_receipts
        for component in mapping["components"]
    }
    prohibited_surface_ids = {
        str(surface.get("surface_id"))
        for document in bundle.get("documents", [])
        for surface in document.get("surfaces", [])
        if (
            (surface.get("quarantine") or {}).get("model_use") == "prohibited"
            and surface.get("vision_disposition") == "quarantined_evidence_only"
        ) or surface.get("vision_disposition") == "verified_non_tabular"
    }

    source_label = crosswalk.get("source_label") or (
        f"{len(documents_by_house)}-house broker pack extracted and cell-crosswalked from hash-bound source documents"
    )
    houses = []
    headline_metrics = [metric_id for metric_id in ("ebit", "adjusted_ebitda") if metric_id in metrics]
    required_house_metrics = sorted(REQUIRED_METRICS)
    for house_id, document in documents_by_house.items():
        has_native = any(
            int(surface.get("native_text_chars", 0)) > 0
            or surface.get("kind") == "workbook_sheet"
            for surface in document.get("surfaces", [])
        )
        has_verified_image = any(
            table.get("extraction_method") in {"vision_pass_consensus", "manual_verified"}
            for table in document.get("tables", [])
        )
        surfaces = document.get("surfaces", [])
        all_evidence_only = bool(surfaces) and all(
            surface.get("vision_disposition") in {"quarantined_evidence_only", "verified_non_tabular"}
            for surface in surfaces
        )
        if not has_native and not has_verified_image and not all_evidence_only:
            raise ValueError(
                f"{document.get('file_name') or document.get('document_id')} has neither native "
                "evidence nor a verified image transcription."
            )
        # A house whose every surface closed as preserved evidence (quarantined
        # after bounded recovery, or verified non-tabular) is a legitimate
        # evidence-only participant: it renders on its Bxx tab and supplies
        # zero model-eligible cells. Deleting it would hide reviewed evidence.
        extraction_method = (
            "evidence_only_quarantine" if not has_native and not has_verified_image
            else "mixed_verified" if has_native and has_verified_image
            else "verified_image_transcription" if has_verified_image
            else "native"
        )
        metric_coverage = {
            metric_id: sum(
                1 for value in estimates[house_id].get(metric_id, [])
                if value is not None and math.isfinite(float(value))
            )
            for metric_id in metrics
        }
        complete_core = all(metric_coverage.get(metric_id, 0) == 3 for metric_id in required_house_metrics)
        complete_headline = any(metric_coverage.get(metric_id, 0) == 3 for metric_id in headline_metrics)
        active_value_count = sum(metric_coverage.values())
        eligibility = (
            "primary_eligible"
            if complete_core and complete_headline
            else "supplemental_eligible"
            if active_value_count > 0
            else "reference_only"
        )
        houses.append({
            "house_id": house_id,
            "house_name": document["house_name"],
            "published_date": document["published_date"],
            "analyst": None,
            "document": {
                "file_name": document["file_name"],
                "media_type": document["media_type"],
                "text_extractable": has_native,
                "extraction_method": extraction_method,
                "extraction_evidence_sha256": bundle_sha256,
                "page_reference": "See broker-source-tables.json and broker-crosswalk-receipt.json",
            },
            "estimates": estimates[house_id],
            "eligibility": eligibility,
            "verified_forecast_cell_count": active_value_count,
            "missing_primary_metrics": sorted([
                metric_id
                for metric_id in [*required_house_metrics, "ebit_or_adjusted_ebitda"]
                if (
                    metric_coverage.get(metric_id, 0) < 3
                    if metric_id != "ebit_or_adjusted_ebitda"
                    else not complete_headline
                )
            ]),
        })
    ranked_primary = sorted(
        (house for house in houses if house["eligibility"] == "primary_eligible"),
        key=lambda house: (
            -int(house["verified_forecast_cell_count"]),
            str(house["published_date"]),
            str(house["house_id"]),
        ),
    )
    # ------------------------------------------------------- per-house digest
    #
    # The standardised face of everything a house published: every mapped
    # metric, in dictionary order, with the broker's own row caption verbatim,
    # the value per forecast period, the verification grade of the cells the
    # value came from, and where on the page it lives. This is the auditability
    # surface - a reader of a Bxx tab starts here and descends into the raw
    # tables below it - so it is derived entirely from mapping receipts the
    # verifiers already proved, and carries no number the pack cannot trace.
    dictionary_rank = {
        metric["id"]: index for index, metric in enumerate(METRIC_DICTIONARY["metrics"])
    }
    GRADE_RANK = {"native": 0, "dual_read": 1, "adjudicated": 2, "derived": 3}
    derived_mapping_ids = {
        mapping_id
        for derivation in resolved_derivations
        for mapping_id in derivation.get("mapping_ids", [])
    } | {
        derivation.get("mapping_id")
        for derivation in resolved_derivations
        if derivation.get("mapping_id")
    }

    def digest_order_key(metric_id: str) -> tuple:
        concept, _, qualifier = str(metric_id).partition("__")
        return (dictionary_rank.get(concept, len(dictionary_rank)), qualifier, metric_id)

    def cell_grade(status: str | None) -> str:
        text = str(status or "verified_native")
        return {
            "verified_native": "native",
            "verified_dual_read": "dual_read",
            "verified_adjudicated": "adjudicated",
        }.get(text, "adjudicated")

    def verbatim_row_label(table: dict, row_number: int) -> str | None:
        try:
            row = table["rows"][row_number - 1]
        except (IndexError, TypeError):
            return None
        for cell in row:
            value = cell.get("value")
            if isinstance(value, str) and value.strip() and not NUMBER.match(value):
                return value.strip()
        return None

    consumed_metric_ids = TIER1_METRIC_IDS | set(elected_by_metric)
    house_digest_entries: dict[str, dict[str, dict]] = {house_id: {} for house_id in documents_by_house}
    for receipt_entry in mapping_receipts:
        house_id = receipt_entry["house_id"]
        metric_id = receipt_entry["metric_id"]
        entry = house_digest_entries[house_id].get(metric_id)
        if entry is None:
            concept = str(metric_id).partition("__")[0]
            declaration = metrics.get(metric_id) or {}
            entry = {
                "metric_id": metric_id,
                "concept": concept,
                "display_label": METRIC_BY_ID.get(concept, {}).get(
                    "display_label", declaration.get("label") or metric_id
                ),
                "verbatim_labels": [],
                "unit_kind": declaration.get("unit_kind"),
                "definition_id": declaration.get("definition_id"),
                "consumed": concept in consumed_metric_ids or metric_id in consumed_metric_ids,
                "values": [None, None, None],
                "grades": [None, None, None],
                "source_locations": [],
            }
            house_digest_entries[house_id][metric_id] = entry
        period_index = int(receipt_entry["period_index"])
        entry["values"][period_index] = receipt_entry["value"]
        worst = "derived" if receipt_entry["mapping_id"] in derived_mapping_ids else "native"
        for component in receipt_entry["components"]:
            _, table = tables[component["table_id"]]
            row_number = int(component["row"])
            column_number = int(component["column"])
            try:
                cited = table["rows"][row_number - 1][column_number - 1]
            except (IndexError, TypeError):
                cited = {}
            grade = cell_grade(cited.get("authority_status"))
            if GRADE_RANK[grade] > GRADE_RANK[worst]:
                worst = grade
            label = verbatim_row_label(table, row_number)
            if label and label not in entry["verbatim_labels"]:
                entry["verbatim_labels"].append(label)
            location = str(component.get("source_ref") or table.get("source_location") or "")
            if location and location not in entry["source_locations"]:
                entry["source_locations"].append(location)
        entry["grades"][period_index] = worst
    house_digests = {
        house_id: [
            entries[metric_id]
            for metric_id in sorted(entries, key=digest_order_key)
        ]
        for house_id, entries in house_digest_entries.items()
    }
    for house in houses:
        digest = house_digests.get(house["house_id"], [])
        house["digest"] = digest
        house["digest_coverage"] = {
            "mapped_concepts": len({item["concept"] for item in digest}),
            "dictionary_concepts": len(dictionary_rank),
            "grade_counts": {
                grade: sum(
                    1
                    for item in digest
                    for cell in item["grades"]
                    if cell == grade
                )
                for grade in GRADE_RANK
            },
        }

    broker_pack = {
        "schema_version": "broker-pack/1.0",
        "pack_kind": "broker_forecast_set",
        "as_of": crosswalk["as_of"],
        "source_label": source_label,
        "reporting_currency": crosswalk["reporting_currency"],
        "units": crosswalk["units"],
        "forecast_periods": crosswalk["forecast_periods"],
        "metrics": metrics,
        "flex_elections": flex_elections,
        "election_gauge": election_gauge,
        "houses": houses,
        "recommended_primary_house_id": ranked_primary[0]["house_id"] if ranked_primary else None,
        "eligibility_summary": {
            "primary_eligible_house_count": sum(house["eligibility"] == "primary_eligible" for house in houses),
            "supplemental_eligible_house_count": sum(house["eligibility"] == "supplemental_eligible" for house in houses),
            "reference_only_house_count": sum(house["eligibility"] == "reference_only" for house in houses),
            # Broker sufficiency selects broker authority; it does not decide
            # whether the company model may continue. With no eligible house,
            # the sealed preview selects the ordinary forecast waterfall.
            "run_can_continue_without_broker_question": True,
        },
        **({"provider_consensus": crosswalk["provider_consensus"]} if crosswalk.get("provider_consensus") else {}),
    }
    def workbook_pages(document: dict[str, Any]) -> list[dict[str, Any]]:
        artifacts = {
            item["artifact_id"]: item
            for item in document.get("artifacts", [])
            if item.get("kind") == "page_image"
        }
        # Compatibility for sealed pre-image fixtures. Fresh extraction always
        # emits one page_image per PDF surface; once any page image is present,
        # the document must be complete and gap-free.
        if not artifacts:
            return []
        pages: list[dict[str, Any]] = []
        for surface in sorted(
            (item for item in document.get("surfaces", []) if item.get("kind") == "pdf_page"),
            key=lambda item: int(item.get("ordinal", 0)),
        ):
            page_artifacts = [
                artifacts[artifact_id]
                for artifact_id in surface.get("artifact_refs", [])
                if artifact_id in artifacts
            ]
            if len(page_artifacts) != 1:
                raise ValueError(
                    f"Broker PDF page {surface.get('surface_id')} must own exactly one page image; found {len(page_artifacts)}."
                )
            artifact = page_artifacts[0]
            pages.append({
                "page_number": int(surface["ordinal"]),
                "surface_id": surface["surface_id"],
                "width_points": float(surface["width"]),
                "height_points": float(surface["height"]),
                "artifact_path": artifact["path"],
                "artifact_sha256": artifact["sha256"],
            })
        return pages

    broker_sources = {
        "schema_version": "broker-source-tables/1.0",
        "run_id": bundle["run_id"],
        "houses": [
            {
                "house_id": document["house_id"],
                "house_name": document["house_name"],
                "source_id": document["source_id"],
                "content_sha256": document["raw_sha256"],
                "published_date": document["published_date"],
                "file_name": document["file_name"],
                "pages": workbook_pages(document),
                "tables": [
                    {
                        "table_id": table["table_id"],
                        "title": table.get("title"),
                        "source_location": table["source_location"],
                        "units": table.get("units"),
                        "extraction_method": table["extraction_method"],
                        # A transcription with no row labels and no period
                        # headings is not a model-consumable analytical table
                        # however the reviewer classified it. It still renders
                        # as a values-only evidence block; because a mapped
                        # cell on an evidence_only table is a blocker, it
                        # cannot feed the model.
                        "workbook_presentation": (
                            "evidence_only"
                            if str(table.get("surface_id")) in prohibited_surface_ids
                            or table.get("workbook_presentation_hint") == "evidence_only"
                            else "analytical_table"
                            if review_by_table[table["table_id"]]["classification"] != "non_forecast"
                            or table["table_id"] in mapped_table_ids
                            else "evidence_only"
                        ),
                        "workbook_presentation_reason": (
                            "The source surface is independently model-prohibited after bounded review; the table remains visible evidence only."
                            if str(table.get("surface_id")) in prohibited_surface_ids
                            else "Transcription carries no row labels or period headings, so it renders as "
                            "evidence only and is prohibited from model formulas."
                            if table.get("workbook_presentation_hint") == "evidence_only"
                            else "Reviewed analytical/financial table retained on the values-only broker evidence sheet."
                            if review_by_table[table["table_id"]]["classification"] != "non_forecast"
                            or table["table_id"] in mapped_table_ids
                            else "Reviewed non-forecast table rendered as evidence only and prohibited from model formulas."
                        ),
                        "rows": scalar_rows(table),
                        "cell_authorities": [
                            {
                                "row": int(cell.get("row", row_index)),
                                "column": int(cell.get("column", column_index)),
                                "status": cell.get("authority_status", "verified_native"),
                                **({"conflict_id": cell["conflict_id"]} if cell.get("conflict_id") else {}),
                                **({"basis": cell["authority_basis"]} if cell.get("authority_basis") else {}),
                            }
                            for row_index, row in enumerate(table.get("rows", []), start=1)
                            for column_index, cell in enumerate(row, start=1)
                            if cell.get("authority_status") or cell.get("conflict_id")
                        ],
                    }
                    for table in document["tables"]
                ],
            }
            for document in bundle["documents"]
        ],
    }
    receipt = {
        "schema_version": "broker-crosswalk-receipt/1.2" if crosswalk.get("schema_version") == "broker-crosswalk/1.2" else "broker-crosswalk-receipt/1.1",
        "run_id": bundle["run_id"],
        "bundle_sha256": bundle_sha256,
        "crosswalk_sha256": hashlib.sha256(Path(args.crosswalk).read_bytes()).hexdigest(),
        "mapping_count": len(mapping_receipts),
        "mappings": mapping_receipts,
        "table_reviews_sha256": hash_json(crosswalk["table_reviews"]),
        "coverage_ledger_sha256": hash_json(crosswalk["coverage_ledger"]),
        **({"terminal_recovery_sha256": hash_json(crosswalk["terminal_recovery"])} if crosswalk.get("terminal_recovery") else {}),
        "coverage_summary": coverage_summary,
        "coverage_ledger": resolved_coverage,
        "derived_mappings": resolved_derivations,
        **({
            "candidate_manifest_sha256": semantic_report["candidate_manifest_sha256"],
            "crosswalk_canonical_sha256": semantic_report["crosswalk_sha256"],
            "independent_semantic_report_sha256": hashlib.sha256((output_root / "broker-semantic-verification-report.json").read_bytes()).hexdigest(),
        } if semantic_report else {}),
        "status": "PASS",
    }
    (output_root / "broker-pack.json").write_text(json.dumps(broker_pack, indent=2, ensure_ascii=False) + "\n", "utf-8")
    (output_root / "broker-source-tables.json").write_text(json.dumps(broker_sources, indent=2, ensure_ascii=False) + "\n", "utf-8")
    (output_root / "broker-crosswalk-receipt.json").write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(json.dumps({
        "status": "PASS",
        "houses": len(houses),
        "mappings": len(mapping_receipts),
        "metrics": len(metrics),
        "coverage_entries": len(resolved_coverage),
        "unresolved_candidates": coverage_summary["unresolved_candidate_count"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
