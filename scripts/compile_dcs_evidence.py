#!/usr/bin/env python3
"""Compile reviewed lossless DCS evidence into a slim model projection.

This compiler never owns the source universe.  It verifies exact row/cell
disposition against the extractor's immutable candidate manifest, computes
every projected value from cell-addressed authorities, and accumulates all
findings before deciding PASS/BLOCKED.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any


DISPOSITIONS = {"model_input", "derived_model_input", "supplemental_evidence", "duplicate", "not_applicable", "unresolved"}
MODEL_INSTRUMENT_DISPOSITIONS = {"model_input", "derived_model_input"}
PRECISIONS = {"exact", "month", "year", "bucket", "non_maturing"}
EXPORT_FIELDS = {
    "instrument_id", "source_row", "description", "display_group", "instrument_type", "currency",
    "outstanding_amount", "maturity_date", "maturity_precision", "maturity_treatment", "next_call_date",
    "refinancing_intent", "is_backstop_for_paper", "benchmark_curve", "rate_type", "coupon_rate",
    "reference_rate", "margin_bps", "all_in_rate", "committed", "facility_limit", "drawn_amount",
    "undrawn_amount", "accrued_interest", "interest_settlement", "debt_classification",
    "amortisation_schedule", "issuing_entity", "security", "notes",
}
MODEL_FIELDS = (EXPORT_FIELDS - {"maturity_date", "maturity_precision", "maturity_treatment"}) | {
    "maturity", "balance_basis", "native_principal", "fx_rate",
    "commitment_fee_convention", "commitment_fee_value",
}
ASSET_ROOT = Path(__file__).resolve().parents[1] / "assets"


def schema_errors(value: Any, schema_name: str) -> list[str]:
    """Validate the JSON-Schema subset used by the DCS public contracts."""
    root = json.loads((ASSET_ROOT / schema_name).read_text("utf-8"))
    errors: list[str] = []

    def resolve(reference: str, current_root: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        if reference.startswith("#/"):
            node: Any = current_root
            for part in reference[2:].split("/"):
                node = node[part.replace("~1", "/").replace("~0", "~")]
            return node, current_root
        file_name, _, fragment = reference.partition("#")
        external = json.loads((ASSET_ROOT / file_name).read_text("utf-8"))
        node: Any = external
        if fragment.startswith("/"):
            for part in fragment[1:].split("/"):
                node = node[part.replace("~1", "/").replace("~0", "~")]
        return node, external

    def walk(item: Any, rule: dict[str, Any], current_root: dict[str, Any], path: str) -> None:
        if "$ref" in rule:
            target, target_root = resolve(rule["$ref"], current_root)
            walk(item, target, target_root, path)
            return
        if "const" in rule and item != rule["const"]:
            errors.append(f"{path}: expected const {rule['const']!r}")
        if "enum" in rule and item not in rule["enum"]:
            errors.append(f"{path}: value {item!r} is outside enum")
        expected = rule.get("type")
        expected_types = expected if isinstance(expected, list) else [expected] if expected else []
        type_ok = not expected_types or any(
            (kind == "object" and isinstance(item, dict))
            or (kind == "array" and isinstance(item, list))
            or (kind == "string" and isinstance(item, str))
            or (kind == "number" and isinstance(item, (int, float)) and not isinstance(item, bool))
            or (kind == "integer" and isinstance(item, int) and not isinstance(item, bool))
            or (kind == "boolean" and isinstance(item, bool))
            or (kind == "null" and item is None)
            for kind in expected_types
        )
        if not type_ok:
            errors.append(f"{path}: wrong type")
            return
        if isinstance(item, dict):
            properties = rule.get("properties", {})
            for name in rule.get("required", []):
                if name not in item:
                    errors.append(f"{path}: missing required property {name}")
            if rule.get("additionalProperties") is False:
                for name in set(item) - set(properties):
                    errors.append(f"{path}: unexpected property {name}")
            for name, child in properties.items():
                if name in item:
                    walk(item[name], child, current_root, f"{path}.{name}")
        elif isinstance(item, list):
            if len(item) < int(rule.get("minItems", 0)):
                errors.append(f"{path}: too few items")
            if isinstance(rule.get("items"), dict):
                for index, child in enumerate(item):
                    walk(child, rule["items"], current_root, f"{path}[{index}]")
        elif isinstance(item, str):
            if len(item) < int(rule.get("minLength", 0)):
                errors.append(f"{path}: string is too short")
            if rule.get("pattern") and not re.search(rule["pattern"], item):
                errors.append(f"{path}: string does not match pattern")
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            if "minimum" in rule and item < rule["minimum"]:
                errors.append(f"{path}: value is below minimum")

    walk(value, root, root, "$")
    return errors


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def parse_number(value: Any) -> float:
    if finite(value):
        return float(value)
    text = str(value).strip()
    negative = text.startswith("(") and text.endswith(")")
    text = re.sub(r"[$£€¥,%xX()\s]", "", text)
    number = float(text)
    return -abs(number) if negative else number


def equal(left: Any, right: Any) -> bool:
    if finite(left) or finite(right):
        try:
            left_number, right_number = parse_number(left), parse_number(right)
            return abs(left_number - right_number) <= max(1e-9, 1e-9 * max(1.0, abs(left_number), abs(right_number)))
        except (TypeError, ValueError):
            return False
    return left == right


def finding(code: str, message: str, path: str | None = None) -> dict[str, Any]:
    item = {"code": code, "message": message}
    if path:
        item["path"] = path
    return item


def valid_date(value: Any) -> bool:
    try:
        return dt.date.fromisoformat(str(value)).isoformat() == str(value)
    except (TypeError, ValueError):
        return False


def cell_index(source: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {cell["cell_id"]: cell for sheet in source.get("sheets", []) for row in sheet.get("rows", []) for cell in row.get("cells", [])}


def apply_transform(authority: dict[str, Any], cells: dict[str, dict[str, Any]], supplements: dict[str, dict[str, Any]]) -> Any:
    transform = authority.get("transform") or {"kind": "direct"}
    kind = transform.get("kind", "direct")
    source_cells = authority.get("source_cells") or []
    if authority.get("authority_kind") == "supplement":
        supplement = supplements[authority["supplement_id"]]
        return supplement.get("value")
    values = [cells[cell_id].get("display_value") for cell_id in source_cells]
    if kind == "direct":
        if len(values) != 1:
            raise ValueError("direct transform requires exactly one source cell")
        return values[0]
    if kind == "boolean":
        if len(values) != 1:
            raise ValueError("boolean transform requires exactly one source cell")
        text = str(values[0]).strip().lower()
        if text in {"true", "yes", "1"}:
            return True
        if text in {"false", "no", "0"}:
            return False
        raise ValueError("boolean transform requires true/false, yes/no or 1/0")
    if kind == "json":
        if len(values) != 1:
            raise ValueError("json transform requires exactly one source cell")
        if not isinstance(values[0], str):
            return values[0]
        return json.loads(values[0])
    numbers = [parse_number(value) for value in values]
    if kind == "linear":
        coefficients = transform.get("coefficients")
        if not isinstance(coefficients, list) or len(coefficients) != len(numbers):
            raise ValueError("linear transform needs one coefficient per source cell")
        return sum(float(coefficient) * value for coefficient, value in zip(coefficients, numbers)) + float(transform.get("constant", 0))
    if kind == "scale":
        if len(numbers) != 1:
            raise ValueError("scale transform requires exactly one source cell")
        return numbers[0] * float(transform["multiplier"])
    if kind == "fx_translate":
        if len(numbers) != 1:
            raise ValueError("fx_translate requires exactly one amount source cell")
        fx_rate = transform.get("fx_rate")
        if fx_rate is None and transform.get("fx_rate_cell"):
            fx_rate = parse_number(cells[transform["fx_rate_cell"]].get("display_value"))
        if not finite(fx_rate) or float(fx_rate) <= 0:
            raise ValueError("fx_translate requires a positive explicit FX rate or FX source cell")
        return numbers[0] * float(fx_rate) if transform.get("quote") == "reporting_per_native" else numbers[0] / float(fx_rate)
    raise ValueError("unsupported transform kind %r" % kind)


def validate_dispositions(manifest: dict[str, Any], crosswalk: dict[str, Any], findings: list[dict[str, Any]]) -> None:
    for category, manifest_key, crosswalk_key, id_key in [
        ("row", "rows", "row_dispositions", "row_id"),
        ("cell", "cells", "cell_dispositions", "cell_id"),
    ]:
        expected = {item[id_key] for item in manifest.get(manifest_key, [])}
        counts: dict[str, int] = {}
        for index, item in enumerate(crosswalk.get(crosswalk_key, [])):
            identifier = item.get(id_key)
            counts[identifier] = counts.get(identifier, 0) + 1
            if item.get("disposition") not in DISPOSITIONS:
                findings.append(finding("DCS-DISPOSITION-INVALID", "%s %r has invalid disposition" % (category, identifier), "%s[%d]" % (crosswalk_key, index)))
            if not str(item.get("rationale", "")).strip():
                findings.append(finding("DCS-DISPOSITION-RATIONALE", "%s %r has no rationale" % (category, identifier), "%s[%d]" % (crosswalk_key, index)))
        for identifier in sorted(expected):
            if counts.get(identifier, 0) == 0:
                findings.append(finding("DCS-UNOWNED-%s" % category.upper(), "%s %s has no disposition" % (category, identifier)))
            elif counts[identifier] > 1:
                findings.append(finding("DCS-DOUBLE-OWNED-%s" % category.upper(), "%s %s has %d dispositions" % (category, identifier, counts[identifier])))
        for identifier in sorted(set(counts) - expected, key=str):
            findings.append(finding("DCS-UNKNOWN-%s" % category.upper(), "%s disposition references unknown id %r" % (category, identifier)))
        for item in crosswalk.get(crosswalk_key, []):
            if item.get("disposition") == "duplicate":
                target = item.get("duplicate_of")
                if not target or target == item.get(id_key) or target not in expected:
                    findings.append(finding("DCS-DUPLICATE-TARGET", "%s %r has invalid duplicate target %r" % (category, item.get(id_key), target)))


def required_fields(instrument: dict[str, Any]) -> list[str]:
    fields = ["description", "instrument_type", "currency", "balance_basis", "outstanding_amount", "rate_type", "maturity"]
    rate_type = instrument.get("rate_type")
    if rate_type == "fixed":
        fields.append("coupon_rate")
    elif rate_type == "floating":
        fields += ["reference_rate", "margin_bps"]
    elif rate_type == "manual_all_in":
        fields.append("all_in_rate")
    if instrument.get("instrument_type") == "rcf":
        fields += ["facility_limit", "drawn_amount", "committed", "commitment_fee_convention", "commitment_fee_value"]
    if instrument.get("balance_basis") == "native_principal" and instrument.get("currency") != instrument.get("reporting_currency"):
        fields += ["native_principal", "fx_rate"]
    return fields


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_tables")
    parser.add_argument("candidate_manifest")
    parser.add_argument("crosswalk")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    source_path, manifest_path, crosswalk_path = map(lambda value: Path(value).resolve(), [args.source_tables, args.candidate_manifest, args.crosswalk])
    source = json.loads(source_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    crosswalk = json.loads(crosswalk_path.read_text(encoding="utf-8"))
    findings: list[dict[str, Any]] = []
    for value, schema_name, label in [
        (source, "dcs-source-tables-v1.schema.json", "source_tables"),
        (manifest, "dcs-candidate-manifest-v1.schema.json", "candidate_manifest"),
        (crosswalk, "dcs-crosswalk-v1.schema.json", "crosswalk"),
    ]:
        for error in schema_errors(value, schema_name):
            findings.append(
                finding("DCS-SCHEMA-CONTRACT", f"{label} fails {schema_name}: {error}")
            )
    if source.get("schema_version") != "dcs-source-tables/1.0":
        findings.append(finding("DCS-SOURCE-SCHEMA", "source_tables must be dcs-source-tables/1.0"))
    if manifest.get("schema_version") != "dcs-candidate-manifest/1.0":
        findings.append(finding("DCS-MANIFEST-SCHEMA", "candidate_manifest must be dcs-candidate-manifest/1.0"))
    if crosswalk.get("schema_version") != "dcs-crosswalk/1.0":
        findings.append(finding("DCS-CROSSWALK-SCHEMA", "crosswalk must be dcs-crosswalk/1.0"))
    if manifest.get("source_sha256") != source.get("source", {}).get("sha256"):
        findings.append(finding("DCS-SOURCE-HASH", "candidate manifest source hash does not match source tables"))
    if manifest.get("source_tables_sha256") != digest(source):
        findings.append(finding("DCS-TABLES-HASH", "candidate manifest is not bound to the exact source tables"))
    if crosswalk.get("source_tables_sha256") != digest(source) or crosswalk.get("candidate_manifest_sha256") != digest(manifest):
        findings.append(finding("DCS-CROSSWALK-HASH", "crosswalk is not bound to the exact source tables and candidate manifest"))
    validate_dispositions(manifest, crosswalk, findings)
    cells = cell_index(source)
    disposition_by_cell = {item.get("cell_id"): item for item in crosswalk.get("cell_dispositions", [])}
    supplements = {item.get("supplement_id"): item for item in crosswalk.get("supplements", [])}
    for item in crosswalk.get("supplements", []):
        if item.get("source_kind") not in {"company_document", "user_answer"}:
            findings.append(finding("DCS-SUPPLEMENT-SOURCE", "supplement %r lacks a permitted source kind" % item.get("supplement_id")))
        if not item.get("source_reference"):
            findings.append(finding("DCS-SUPPLEMENT-REFERENCE", "supplement %r lacks a source reference" % item.get("supplement_id")))

    authorities: list[dict[str, Any]] = []
    projected_instruments: list[dict[str, Any]] = []
    supplemental_fields: list[dict[str, Any]] = []
    seen_instrument_ids: set[str] = set()
    metadata = crosswalk.get("export_metadata") or {}
    reporting_currency = metadata.get("reporting_currency")
    candidate_ids: set[str] = set()
    known_rows = {item.get("row_id") for item in manifest.get("rows", [])}
    model_row_owners: dict[str, list[str]] = {}
    for candidate in crosswalk.get("instruments", []):
        candidate_id = candidate.get("candidate_id")
        if not candidate_id:
            findings.append(finding("DCS-CANDIDATE-ID", "instrument candidate has no candidate_id"))
        elif candidate_id in candidate_ids:
            findings.append(finding("DCS-CANDIDATE-DUPLICATE", "candidate_id %s is duplicated" % candidate_id))
        candidate_ids.add(candidate_id)
        for row_id in candidate.get("row_ids", []):
            if row_id not in known_rows:
                findings.append(finding("DCS-CANDIDATE-UNKNOWN-ROW", "candidate %r references unknown row %r" % (candidate_id, row_id)))
            if candidate.get("disposition") in MODEL_INSTRUMENT_DISPOSITIONS:
                model_row_owners.setdefault(row_id, []).append(candidate.get("instrument_id"))
    for candidate in crosswalk.get("instruments", []):
        if candidate.get("disposition") == "duplicate":
            target = candidate.get("duplicate_of")
            if not target or target == candidate.get("candidate_id") or target not in candidate_ids:
                findings.append(finding("DCS-DUPLICATE-INSTRUMENT-TARGET", "candidate %r has invalid duplicate target %r" % (candidate.get("candidate_id"), target)))
    for row_id, owners in sorted(model_row_owners.items()):
        if len(owners) != 1:
            findings.append(finding("DCS-CANDIDATE-ROW-OWNERSHIP", "model row %s is owned by %d instrument candidates" % (row_id, len(owners))))
    for index, candidate in enumerate(crosswalk.get("instruments", [])):
        candidate_id = candidate.get("candidate_id")
        disposition = candidate.get("disposition")
        if disposition not in DISPOSITIONS:
            findings.append(finding("DCS-INSTRUMENT-DISPOSITION", "instrument candidate %r has invalid disposition" % candidate_id))
            continue
        if not str(candidate.get("rationale", "")).strip():
            findings.append(finding("DCS-INSTRUMENT-RATIONALE", "instrument candidate %r has no rationale" % candidate_id))
        instrument_id = candidate.get("instrument_id")
        if disposition in MODEL_INSTRUMENT_DISPOSITIONS:
            if not instrument_id:
                findings.append(finding("DCS-INSTRUMENT-ID", "model instrument candidate %r has no instrument_id" % candidate_id))
                continue
            if instrument_id in seen_instrument_ids:
                findings.append(finding("DCS-INSTRUMENT-DUPLICATE-ID", "instrument_id %s is duplicated" % instrument_id))
            seen_instrument_ids.add(instrument_id)
        field_values: dict[str, Any] = {"instrument_id": instrument_id, "reporting_currency": reporting_currency}
        instrument_authorities: list[dict[str, Any]] = []
        seen_fields: set[str] = set()
        for auth_index, authority in enumerate(candidate.get("term_authorities", [])):
            model_field = authority.get("model_field")
            if disposition in MODEL_INSTRUMENT_DISPOSITIONS and model_field not in MODEL_FIELDS:
                findings.append(finding("DCS-UNKNOWN-MODEL-FIELD", "%s.%s is not a supported model field; preserve it as supplemental evidence" % (instrument_id, model_field)))
            if disposition in MODEL_INSTRUMENT_DISPOSITIONS and model_field in seen_fields:
                findings.append(finding("DCS-DUPLICATE-TERM-AUTHORITY", "%s.%s has more than one writer" % (instrument_id, model_field)))
            seen_fields.add(model_field)
            source_cells = authority.get("source_cells") or []
            unknown = [cell_id for cell_id in source_cells if cell_id not in cells]
            if unknown:
                findings.append(finding("DCS-AUTHORITY-UNKNOWN-CELL", "%s.%s references unknown source cells %s" % (instrument_id, model_field, unknown)))
                continue
            for cell_id in source_cells:
                cell_disposition = disposition_by_cell.get(cell_id) or {}
                if disposition in MODEL_INSTRUMENT_DISPOSITIONS:
                    if cell_disposition.get("disposition") not in MODEL_INSTRUMENT_DISPOSITIONS or cell_disposition.get("owner_id") != instrument_id:
                        findings.append(finding("DCS-AUTHORITY-CELL-DISPOSITION", "%s.%s uses cell %s that is not model evidence owned by that instrument" % (instrument_id, model_field, cell_id)))
                elif disposition == "supplemental_evidence" and cell_disposition.get("disposition") != "supplemental_evidence":
                    findings.append(finding("DCS-SUPPLEMENTAL-CELL-DISPOSITION", "%s.%s uses cell %s that is not supplemental evidence" % (instrument_id, model_field, cell_id)))
            if authority.get("authority_kind") == "supplement" and authority.get("supplement_id") not in supplements:
                findings.append(finding("DCS-AUTHORITY-UNKNOWN-SUPPLEMENT", "%s.%s references an unknown supplement" % (instrument_id, model_field)))
                continue
            try:
                computed = apply_transform(authority, cells, supplements)
            except (KeyError, TypeError, ValueError) as error:
                findings.append(finding("DCS-AUTHORITY-TRANSFORM", "%s.%s: %s" % (instrument_id, model_field, error)))
                continue
            declared = authority.get("output_value")
            if not equal(computed, declared):
                findings.append(finding("DCS-AUTHORITY-VALUE", "%s.%s declares %r but its authority computes %r" % (instrument_id, model_field, declared, computed)))
            precision = authority.get("precision", "exact")
            if precision not in PRECISIONS:
                findings.append(finding("DCS-AUTHORITY-PRECISION", "%s.%s has invalid precision %r" % (instrument_id, model_field, precision)))
            if model_field == "maturity":
                value = str(declared) if declared is not None else None
                valid = (precision == "exact" and valid_date(value)) or (precision == "month" and value is not None and re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2])", value)) or (precision == "year" and value is not None and re.fullmatch(r"\d{4}", value)) or (precision == "bucket" and bool(value)) or (precision == "non_maturing" and declared is None)
                if not valid:
                    findings.append(finding("DCS-MATURITY-PRECISION", "%s maturity value %r does not match precision %s" % (instrument_id, declared, precision)))
                if precision != "exact" and value is not None and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                    findings.append(finding("DCS-SYNTHETIC-MATURITY-DATE", "%s carries an exact date under %s precision" % (instrument_id, precision)))
            record = {
                "instrument_id": instrument_id,
                "model_field": model_field,
                "output_value": declared,
                "source_cells": source_cells,
                "transform": authority.get("transform") or {"kind": "direct"},
                "authority_kind": authority.get("authority_kind", "source_cell"),
                "precision": precision,
            }
            if authority.get("supplement_id"):
                record["supplement_id"] = authority["supplement_id"]
            if authority.get("basis"):
                record["basis"] = authority["basis"]
            if disposition in MODEL_INSTRUMENT_DISPOSITIONS:
                authorities.append(record)
            instrument_authorities.append(record)
            field_values[model_field] = declared

        if disposition == "supplemental_evidence":
            supplemental_fields.append({"candidate_id": candidate_id, "instrument_id": instrument_id, "term_authorities": instrument_authorities})
            continue
        if disposition not in MODEL_INSTRUMENT_DISPOSITIONS:
            continue
        for field in required_fields(field_values):
            if field == "maturity":
                if field not in field_values:
                    findings.append(finding("DCS-REQUIRED-TERM", "%s is missing required maturity evidence" % instrument_id))
                continue
            if field not in field_values or field_values[field] is None or field_values[field] == "":
                findings.append(finding("DCS-REQUIRED-TERM", "%s is missing required model field %s" % (instrument_id, field)))
        balance_basis = field_values.get("balance_basis")
        if balance_basis not in {"native_principal", "reporting_currency_carrying_value"}:
            findings.append(finding("DCS-BALANCE-BASIS", "%s has invalid balance basis %r" % (instrument_id, balance_basis)))
        outstanding_auth = next((item for item in instrument_authorities if item["model_field"] == "outstanding_amount"), None)
        if balance_basis == "reporting_currency_carrying_value" and outstanding_auth and outstanding_auth.get("transform", {}).get("kind") == "fx_translate":
            findings.append(finding("DCS-CARRYING-VALUE-RETRANSLATED", "%s reporting-currency carrying value must not be FX translated" % instrument_id))
        if balance_basis == "native_principal" and field_values.get("currency") != reporting_currency:
            native_auth = next((item for item in instrument_authorities if item["model_field"] == "native_principal"), None)
            fx_auth = next((item for item in instrument_authorities if item["model_field"] == "fx_rate"), None)
            if not outstanding_auth or outstanding_auth.get("transform", {}).get("kind") != "fx_translate":
                findings.append(finding("DCS-NATIVE-PRINCIPAL-FX", "%s foreign native principal must produce reporting-currency outstanding through an explicit FX transform" % instrument_id))
            elif not native_auth or not fx_auth:
                findings.append(finding("DCS-NATIVE-PRINCIPAL-AUTHORITY", "%s FX translation lacks native-principal or FX-rate authority" % instrument_id))
            else:
                transform = outstanding_auth.get("transform", {})
                if set(outstanding_auth.get("source_cells", [])) != set(native_auth.get("source_cells", [])):
                    findings.append(finding("DCS-NATIVE-PRINCIPAL-SOURCE", "%s outstanding FX transform does not consume its native-principal source cells" % instrument_id))
                fx_cell = transform.get("fx_rate_cell")
                if fx_cell and fx_cell not in fx_auth.get("source_cells", []):
                    findings.append(finding("DCS-FX-RATE-SOURCE", "%s outstanding FX transform does not consume its FX-rate authority cell" % instrument_id))
        if field_values.get("instrument_type") == "rcf":
            convention = field_values.get("commitment_fee_convention")
            fee_value = field_values.get("commitment_fee_value")
            if convention not in {"none", "bps_on_undrawn"}:
                findings.append(finding("DCS-RCF-FEE-CONVENTION", "%s has invalid commitment fee convention %r" % (instrument_id, convention)))
            if convention == "bps_on_undrawn" and (not finite(fee_value) or float(fee_value) <= 0):
                findings.append(finding("DCS-RCF-FEE-VALUE", "%s needs a positive bps commitment fee value" % instrument_id))
            if convention == "none" and finite(fee_value) and float(fee_value) != 0:
                findings.append(finding("DCS-RCF-FEE-VALUE", "%s declares no commitment fee but a non-zero value" % instrument_id))
        if "interest_settlement" in field_values and field_values.get("interest_settlement") not in {"cash", "non_cash"}:
            findings.append(finding("DCS-INTEREST-SETTLEMENT", "%s has invalid interest settlement %r" % (instrument_id, field_values.get("interest_settlement"))))
        if "debt_classification" in field_values:
            classification = field_values.get("debt_classification")
            if not isinstance(classification, dict) or any(key not in {"include_in_gross_debt", "include_in_net_debt"} or not isinstance(value, bool) for key, value in (classification or {}).items()):
                findings.append(finding("DCS-DEBT-CLASSIFICATION", "%s has malformed debt classification" % instrument_id))
        if "amortisation_schedule" in field_values:
            schedule = field_values.get("amortisation_schedule")
            valid_schedule = isinstance(schedule, list) and all(isinstance(item, dict) and valid_date(item.get("date")) and finite(item.get("amount")) and float(item["amount"]) >= 0 for item in schedule)
            if not valid_schedule:
                findings.append(finding("DCS-AMORTISATION-SCHEDULE", "%s has malformed amortisation schedule" % instrument_id))
        if "refinancing_intent" in field_values and field_values.get("refinancing_intent") not in {"refinanced", "repaid"}:
            findings.append(finding("DCS-REFINANCING-INTENT", "%s has invalid refinancing intent" % instrument_id))
        if "is_backstop_for_paper" in field_values and not isinstance(field_values.get("is_backstop_for_paper"), bool):
            findings.append(finding("DCS-BACKSTOP-TYPE", "%s backstop indicator is not boolean" % instrument_id))
        if "next_call_date" in field_values and not valid_date(field_values.get("next_call_date")):
            findings.append(finding("DCS-CALL-DATE", "%s has invalid next call date" % instrument_id))
        if field_values.get("maturity") is not None:
            maturity_auth = next((item for item in instrument_authorities if item["model_field"] == "maturity"), None)
            if maturity_auth and maturity_auth["precision"] != "exact":
                findings.append(finding("DCS-MATURITY-NOT-MODEL-READY", "%s maturity is only %s precision; no exact date will be invented" % (instrument_id, maturity_auth["precision"])))
        export_instrument = {key: value for key, value in field_values.items() if key in EXPORT_FIELDS and value is not None}
        maturity_auth = next((item for item in instrument_authorities if item["model_field"] == "maturity"), None)
        if maturity_auth:
            if maturity_auth["precision"] == "exact":
                export_instrument["maturity_date"] = maturity_auth["output_value"]
                export_instrument["maturity_precision"] = "day"
            elif maturity_auth["precision"] == "non_maturing":
                export_instrument["maturity_date"] = None
                export_instrument["maturity_treatment"] = "non_maturing_within_forecast"
        projected_instruments.append(export_instrument)

    valid_owners = {item.get("instrument_id") for item in crosswalk.get("instruments", []) if item.get("disposition") in MODEL_INSTRUMENT_DISPOSITIONS}
    cell_rows = {item.get("cell_id"): item.get("row_id") for item in manifest.get("cells", [])}
    for lane in ["row_dispositions", "cell_dispositions"]:
        for item in crosswalk.get(lane, []):
            if item.get("disposition") in MODEL_INSTRUMENT_DISPOSITIONS and item.get("owner_id") not in valid_owners:
                findings.append(finding("DCS-ORPHAN-MODEL-EVIDENCE", "%s item %r names missing model instrument owner %r" % (lane, item.get("row_id") or item.get("cell_id"), item.get("owner_id"))))
            if item.get("disposition") in MODEL_INSTRUMENT_DISPOSITIONS:
                row_id = item.get("row_id") if lane == "row_dispositions" else cell_rows.get(item.get("cell_id"))
                if item.get("owner_id") not in model_row_owners.get(row_id, []):
                    findings.append(finding("DCS-MODEL-EVIDENCE-ROW-OWNER", "%s item %r is owned by %r but that instrument does not own source row %r" % (lane, item.get("row_id") or item.get("cell_id"), item.get("owner_id"), row_id)))

    unresolved = [item for item in crosswalk.get("row_dispositions", []) + crosswalk.get("cell_dispositions", []) if item.get("disposition") == "unresolved"]
    unresolved += [item for item in crosswalk.get("instruments", []) if item.get("disposition") == "unresolved"]
    if unresolved:
        findings.append(finding("DCS-UNRESOLVED", "%d candidate dispositions remain unresolved" % len(unresolved)))

    dcs_export = {
        "schema_version": "dcs-export/1.0",
        "export_kind": "debt_instrument_detail",
        "as_of": metadata.get("as_of"),
        "source": metadata.get("source"),
        "entity": metadata.get("entity"),
        "reporting_currency": reporting_currency,
        "units": metadata.get("units"),
        "columns": metadata.get("columns"),
        "instruments": projected_instruments,
    }
    projection = {
        "schema_version": "dcs-projection/1.0",
        "source_sha256": source.get("source", {}).get("sha256"),
        "source_tables_sha256": digest(source),
        "candidate_manifest_sha256": digest(manifest),
        "crosswalk_sha256": digest(crosswalk),
        "instrument_authority_contract_version": "dcs_evidence_v1",
        "term_authorities": authorities,
        "supplemental_fields": supplemental_fields,
        "dcs_export": dcs_export,
    }
    for error in schema_errors(projection, "dcs-projection-v1.schema.json"):
        findings.append(
            finding(
                "DCS-SCHEMA-CONTRACT",
                f"projection fails dcs-projection-v1.schema.json: {error}",
            )
        )
    for error in schema_errors(dcs_export, "dcs-export.schema.json"):
        findings.append(
            finding(
                "DCS-SCHEMA-CONTRACT",
                f"dcs_export fails dcs-export.schema.json: {error}",
            )
        )
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    status = "PASS" if not findings and projected_instruments else "BLOCKED"
    if not projected_instruments:
        findings.append(finding("DCS-ZERO-MODEL-INSTRUMENTS", "No model-input instruments were projected"))
        status = "BLOCKED"
    (out / "dcs-projection.json").write_bytes(canonical(projection))
    if status == "PASS":
        (out / "dcs-export.json").write_bytes(canonical(dcs_export))
    receipt = {
        "schema_version": "dcs-evidence-receipt/1.0",
        "status": status,
        "source_sha256": source.get("source", {}).get("sha256"),
        "source_tables_sha256": digest(source),
        "candidate_manifest_sha256": digest(manifest),
        "crosswalk_sha256": digest(crosswalk),
        "projection_sha256": digest(projection),
        "counts": {
            "source_rows": len(manifest.get("rows", [])),
            "source_cells": len(manifest.get("cells", [])),
            "model_instruments": len(projected_instruments),
            "term_authorities": len(authorities),
            "unowned_cells": sum(1 for item in findings if item["code"] == "DCS-UNOWNED-CELL"),
            "double_owned_cells": sum(1 for item in findings if item["code"] == "DCS-DOUBLE-OWNED-CELL"),
            "violations": len(findings),
        },
        "violations": findings,
    }
    receipt_contract_errors = schema_errors(
        receipt, "dcs-evidence-receipt-v1.schema.json"
    )
    if receipt_contract_errors:
        for error in receipt_contract_errors:
            findings.append(
                finding(
                    "DCS-SCHEMA-CONTRACT",
                    f"receipt fails dcs-evidence-receipt-v1.schema.json: {error}",
                )
            )
        status = "BLOCKED"
        receipt["status"] = status
        receipt["counts"]["violations"] = len(findings)
        receipt["violations"] = findings
    (out / "dcs-evidence-receipt.json").write_bytes(canonical(receipt))
    print(json.dumps(receipt, indent=2))
    return 0 if status == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
