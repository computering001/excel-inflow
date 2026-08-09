#!/usr/bin/env python3
"""Independent stdlib oracle for the lossless DCS evidence lane.

It deliberately does not import the extractor, compiler, model solver or their
helpers.  It reconstructs source ownership and term values from the sealed
artifacts and returns every finding in one report.
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


ALLOWED = {"model_input", "derived_model_input", "supplemental_evidence", "duplicate", "not_applicable", "unresolved"}
MODEL_FIELDS = {
    "instrument_id", "source_row", "description", "display_group", "instrument_type", "currency", "outstanding_amount",
    "maturity", "next_call_date", "refinancing_intent", "is_backstop_for_paper", "benchmark_curve", "rate_type",
    "coupon_rate", "reference_rate", "margin_bps", "all_in_rate", "committed", "facility_limit", "drawn_amount",
    "undrawn_amount", "accrued_interest", "interest_settlement", "debt_classification", "amortisation_schedule",
    "issuing_entity", "security", "notes", "balance_basis", "native_principal", "fx_rate",
    "commitment_fee_convention", "commitment_fee_value",
}
ASSET_ROOT = Path(__file__).resolve().parents[2] / "assets"


def contract_errors(value: Any, schema_name: str) -> list[str]:
    """Independent validator for the schema vocabulary used by DCS artifacts."""
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
            errors.append(f"{path}: const mismatch")
        if "enum" in rule and item not in rule["enum"]:
            errors.append(f"{path}: enum mismatch")
        expected = rule.get("type")
        types = expected if isinstance(expected, list) else [expected] if expected else []
        ok = not types or any(
            (kind == "object" and isinstance(item, dict))
            or (kind == "array" and isinstance(item, list))
            or (kind == "string" and isinstance(item, str))
            or (kind == "number" and isinstance(item, (int, float)) and not isinstance(item, bool))
            or (kind == "integer" and isinstance(item, int) and not isinstance(item, bool))
            or (kind == "boolean" and isinstance(item, bool))
            or (kind == "null" and item is None)
            for kind in types
        )
        if not ok:
            errors.append(f"{path}: wrong type")
            return
        if isinstance(item, dict):
            properties = rule.get("properties", {})
            for name in rule.get("required", []):
                if name not in item:
                    errors.append(f"{path}: missing {name}")
            if rule.get("additionalProperties") is False:
                for name in set(item) - set(properties):
                    errors.append(f"{path}: unexpected {name}")
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
                errors.append(f"{path}: too short")
            if rule.get("pattern") and not re.search(rule["pattern"], item):
                errors.append(f"{path}: pattern mismatch")
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            if "minimum" in rule and item < rule["minimum"]:
                errors.append(f"{path}: below minimum")

    walk(value, root, root, "$")
    return errors


def canon(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def hash_object(value: Any) -> str:
    return hashlib.sha256(canon(value)).hexdigest()


def hash_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def numeric(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    text = str(value).strip()
    negative = text.startswith("(") and text.endswith(")")
    cleaned = re.sub(r"[$£€¥,%xX()\s]", "", text)
    result = float(cleaned)
    return -abs(result) if negative else result


def same(left: Any, right: Any) -> bool:
    numeric_scalar = lambda value: isinstance(value, (int, float)) and not isinstance(value, bool)
    if numeric_scalar(left) or numeric_scalar(right):
        try:
            left_number, right_number = numeric(left), numeric(right)
            return abs(left_number - right_number) <= max(1e-9, 1e-9 * max(1.0, abs(left_number), abs(right_number)))
        except (TypeError, ValueError):
            return False
    return left == right


def violation(items: list[dict[str, Any]], code: str, message: str) -> None:
    items.append({"code": code, "message": message})


def valid_date(value: Any) -> bool:
    try:
        return dt.date.fromisoformat(str(value)).isoformat() == str(value)
    except (TypeError, ValueError):
        return False


def independently_required_fields(declared: dict[str, dict[str, Any]], reporting_currency: Any) -> set[str]:
    """Reconstruct model readiness without importing or trusting the compiler."""
    output = {
        "description", "instrument_type", "currency", "balance_basis",
        "outstanding_amount", "maturity", "rate_type",
    }
    value = lambda field: (declared.get(field) or {}).get("output_value")
    rate_type = value("rate_type")
    if rate_type == "fixed":
        output.add("coupon_rate")
    elif rate_type == "floating":
        output.update({"reference_rate", "margin_bps"})
    elif rate_type == "manual_all_in":
        output.add("all_in_rate")
    if value("instrument_type") == "rcf":
        output.update({
            "facility_limit", "drawn_amount", "committed",
            "commitment_fee_convention", "commitment_fee_value",
        })
    if value("balance_basis") == "native_principal" and value("currency") != reporting_currency:
        output.update({"native_principal", "fx_rate"})
    return output


def compute(authority: dict[str, Any], cells: dict[str, dict[str, Any]], supplements: dict[str, dict[str, Any]]) -> Any:
    if authority.get("authority_kind") == "supplement":
        return supplements[authority["supplement_id"]]["value"]
    source_ids = authority.get("source_cells") or []
    values = [cells[item]["display_value"] for item in source_ids]
    transform = authority.get("transform") or {"kind": "direct"}
    kind = transform.get("kind", "direct")
    if kind == "direct":
        if len(values) != 1:
            raise ValueError("direct needs one cell")
        return values[0]
    if kind == "boolean":
        if len(values) != 1:
            raise ValueError("boolean needs one cell")
        text = str(values[0]).strip().lower()
        if text in {"true", "yes", "1"}:
            return True
        if text in {"false", "no", "0"}:
            return False
        raise ValueError("invalid boolean")
    if kind == "json":
        if len(values) != 1:
            raise ValueError("json needs one cell")
        return json.loads(values[0]) if isinstance(values[0], str) else values[0]
    numbers = [numeric(value) for value in values]
    if kind == "linear":
        coefficients = transform.get("coefficients")
        if not isinstance(coefficients, list) or len(coefficients) != len(numbers):
            raise ValueError("linear coefficient count")
        return sum(float(coefficient) * value for coefficient, value in zip(coefficients, numbers)) + float(transform.get("constant", 0))
    if kind == "scale":
        if len(numbers) != 1:
            raise ValueError("scale needs one cell")
        return numbers[0] * float(transform["multiplier"])
    if kind == "fx_translate":
        if len(numbers) != 1:
            raise ValueError("fx_translate needs one amount cell")
        rate = transform.get("fx_rate")
        if rate is None:
            rate = numeric(cells[transform["fx_rate_cell"]]["display_value"])
        if float(rate) <= 0:
            raise ValueError("non-positive FX")
        return numbers[0] * float(rate) if transform.get("quote") == "reporting_per_native" else numbers[0] / float(rate)
    raise ValueError("unknown transform")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--crosswalk", required=True)
    parser.add_argument("--projection", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    paths = {key: Path(getattr(args, key)).resolve() for key in ["source", "manifest", "crosswalk", "projection", "receipt"]}
    values = {key: json.loads(path.read_text(encoding="utf-8")) for key, path in paths.items()}
    source, manifest, crosswalk, projection, receipt = [values[key] for key in ["source", "manifest", "crosswalk", "projection", "receipt"]]
    failures: list[dict[str, Any]] = []

    for key, schema_name in {
        "source": "dcs-source-tables-v1.schema.json",
        "manifest": "dcs-candidate-manifest-v1.schema.json",
        "crosswalk": "dcs-crosswalk-v1.schema.json",
        "projection": "dcs-projection-v1.schema.json",
        "receipt": "dcs-evidence-receipt-v1.schema.json",
    }.items():
        for error in contract_errors(values[key], schema_name):
            violation(
                failures,
                "DCS-ORACLE-SCHEMA-CONTRACT",
                f"{key} fails {schema_name}: {error}",
            )
    for error in contract_errors(projection.get("dcs_export"), "dcs-export.schema.json"):
        violation(
            failures,
            "DCS-ORACLE-SCHEMA-CONTRACT",
            f"projection.dcs_export fails dcs-export.schema.json: {error}",
        )

    expected_versions = {
        "source": "dcs-source-tables/1.0", "manifest": "dcs-candidate-manifest/1.0",
        "crosswalk": "dcs-crosswalk/1.0", "projection": "dcs-projection/1.0",
        "receipt": "dcs-evidence-receipt/1.0",
    }
    for key, version in expected_versions.items():
        if values[key].get("schema_version") != version:
            violation(failures, "DCS-ORACLE-SCHEMA", "%s has wrong schema_version" % key)

    source_hash = source.get("source", {}).get("sha256")
    if manifest.get("source_sha256") != source_hash or projection.get("source_sha256") != source_hash or receipt.get("source_sha256") != source_hash:
        violation(failures, "DCS-ORACLE-RAW-HASH", "raw source hashes do not agree")
    bindings = {
        "source_tables_sha256": hash_object(source),
        "candidate_manifest_sha256": hash_object(manifest),
        "crosswalk_sha256": hash_object(crosswalk),
        "projection_sha256": hash_object(projection),
    }
    for key, expected in bindings.items():
        carriers = [receipt]
        if key == "source_tables_sha256": carriers += [manifest, crosswalk, projection]
        elif key == "candidate_manifest_sha256": carriers += [crosswalk, projection]
        elif key == "crosswalk_sha256": carriers += [projection]
        for carrier in carriers:
            if carrier.get(key) != expected:
                violation(failures, "DCS-ORACLE-ARTIFACT-HASH", "%s binding is wrong or stale" % key)

    cells = {cell["cell_id"]: cell for sheet in source.get("sheets", []) for row in sheet.get("rows", []) for cell in row.get("cells", [])}
    rows = {row["row_id"] for sheet in source.get("sheets", []) for row in sheet.get("rows", [])}
    for sheet in source.get("sheets", []):
        sheet_core = dict(sheet); sheet_core.pop("sheet_sha256", None)
        if sheet.get("sheet_sha256") != hash_object(sheet_core):
            violation(failures, "DCS-ORACLE-SHEET-HASH", "sheet %s content hash is wrong" % sheet.get("sheet_id"))
        for row in sheet.get("rows", []):
            row_core = dict(row); row_core.pop("row_sha256", None)
            if row.get("row_sha256") != hash_object(row_core):
                violation(failures, "DCS-ORACLE-ROW-HASH", "row %s content hash is wrong" % row.get("row_id"))
            for cell in row.get("cells", []):
                cell_core = dict(cell); cell_core.pop("cell_sha256", None)
                if cell.get("cell_sha256") != hash_object(cell_core):
                    violation(failures, "DCS-ORACLE-CELL-HASH", "cell %s content hash is wrong" % cell.get("cell_id"))
    manifest_cells = {item.get("cell_id") for item in manifest.get("cells", [])}
    manifest_rows = {item.get("row_id") for item in manifest.get("rows", [])}
    if set(cells) != manifest_cells:
        violation(failures, "DCS-ORACLE-MANIFEST-CELLS", "candidate manifest cell universe differs from source tables")
    if rows != manifest_rows:
        violation(failures, "DCS-ORACLE-MANIFEST-ROWS", "candidate manifest row universe differs from source tables")
    manifest_cell_records = {item.get("cell_id"): item for item in manifest.get("cells", [])}
    manifest_row_records = {item.get("row_id"): item for item in manifest.get("rows", [])}
    for cell_id, cell in cells.items():
        if manifest_cell_records.get(cell_id, {}).get("cell_sha256") != cell.get("cell_sha256"):
            violation(failures, "DCS-ORACLE-MANIFEST-CELL-HASH", "manifest hash for %s differs from source tables" % cell_id)
    for sheet in source.get("sheets", []):
        for row in sheet.get("rows", []):
            if manifest_row_records.get(row.get("row_id"), {}).get("row_sha256") != row.get("row_sha256"):
                violation(failures, "DCS-ORACLE-MANIFEST-ROW-HASH", "manifest hash for %s differs from source tables" % row.get("row_id"))
    for key, expected, id_key in [("cell_dispositions", set(cells), "cell_id"), ("row_dispositions", rows, "row_id")]:
        counts: dict[str, int] = {}
        for item in crosswalk.get(key, []):
            identifier = item.get(id_key)
            counts[identifier] = counts.get(identifier, 0) + 1
            if item.get("disposition") not in ALLOWED:
                violation(failures, "DCS-ORACLE-DISPOSITION", "%s has invalid disposition" % identifier)
        missing = sorted(expected - set(counts))
        doubled = sorted(item for item, count in counts.items() if count != 1)
        unknown = sorted(set(counts) - expected)
        if missing:
            violation(failures, "DCS-ORACLE-UNOWNED", "%s missing dispositions: %s" % (id_key, missing))
        if doubled:
            violation(failures, "DCS-ORACLE-DOUBLE-OWNED", "%s has non-unique dispositions: %s" % (id_key, doubled))
        if unknown:
            violation(failures, "DCS-ORACLE-UNKNOWN", "%s references unknown ids: %s" % (id_key, unknown))
        for item in crosswalk.get(key, []):
            if item.get("disposition") == "duplicate" and (not item.get("duplicate_of") or item.get("duplicate_of") == item.get(id_key) or item.get("duplicate_of") not in expected):
                violation(failures, "DCS-ORACLE-DUPLICATE-TARGET", "%s %r has invalid duplicate target" % (id_key, item.get(id_key)))

    valid_owners = {item.get("instrument_id") for item in crosswalk.get("instruments", []) if item.get("disposition") in {"model_input", "derived_model_input"}}
    model_rows: dict[str, set[str]] = {}
    for candidate in crosswalk.get("instruments", []):
        if candidate.get("disposition") in {"model_input", "derived_model_input"}:
            for row_id in candidate.get("row_ids", []):
                model_rows.setdefault(row_id, set()).add(candidate.get("instrument_id"))
    cell_rows = {item.get("cell_id"): item.get("row_id") for item in manifest.get("cells", [])}
    for lane in ["cell_dispositions", "row_dispositions"]:
        for item in crosswalk.get(lane, []):
            if item.get("disposition") in {"model_input", "derived_model_input"} and item.get("owner_id") not in valid_owners:
                violation(failures, "DCS-ORACLE-ORPHAN-EVIDENCE", "%s item %r has missing model owner %r" % (lane, item.get("cell_id") or item.get("row_id"), item.get("owner_id")))
            if item.get("disposition") in {"model_input", "derived_model_input"}:
                row_id = item.get("row_id") if lane == "row_dispositions" else cell_rows.get(item.get("cell_id"))
                if item.get("owner_id") not in model_rows.get(row_id, set()):
                    violation(failures, "DCS-ORACLE-ROW-OWNER", "%s item %r does not belong to owner %r's candidate row" % (lane, item.get("cell_id") or item.get("row_id"), item.get("owner_id")))

    supplements = {item.get("supplement_id"): item for item in crosswalk.get("supplements", [])}
    disposition_by_cell = {item.get("cell_id"): item for item in crosswalk.get("cell_dispositions", [])}
    candidate_ids: set[str] = set()
    for candidate in crosswalk.get("instruments", []):
        candidate_id = candidate.get("candidate_id")
        if candidate_id in candidate_ids:
            violation(failures, "DCS-ORACLE-DUPLICATE-CANDIDATE", "candidate_id %r is duplicated" % candidate_id)
        candidate_ids.add(candidate_id)
        unknown_rows = set(candidate.get("row_ids") or []) - rows
        if unknown_rows:
            violation(failures, "DCS-ORACLE-CANDIDATE-ROW", "candidate %r uses unknown rows %s" % (candidate_id, sorted(unknown_rows)))
    for candidate in crosswalk.get("instruments", []):
        if candidate.get("disposition") == "duplicate" and (not candidate.get("duplicate_of") or candidate.get("duplicate_of") == candidate.get("candidate_id") or candidate.get("duplicate_of") not in candidate_ids):
            violation(failures, "DCS-ORACLE-DUPLICATE-CANDIDATE-TARGET", "candidate %r has invalid duplicate target" % candidate.get("candidate_id"))
    authority_keys: set[tuple[str, str]] = set()
    projection_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for item in projection.get("term_authorities", []):
        key = (item.get("instrument_id"), item.get("model_field"))
        if key in projection_by_key:
            violation(failures, "DCS-ORACLE-DUPLICATE-AUTHORITY", "authority %r is duplicated" % (key,))
        projection_by_key[key] = item
        unknown = set(item.get("source_cells") or []) - set(cells)
        if unknown:
            violation(failures, "DCS-ORACLE-AUTHORITY-CELL", "authority %r uses unknown cells %s" % (key, sorted(unknown)))
            continue
        try:
            result = compute(item, cells, supplements)
        except (KeyError, TypeError, ValueError) as error:
            violation(failures, "DCS-ORACLE-TRANSFORM", "authority %r cannot be recomputed: %s" % (key, error))
            continue
        if not same(result, item.get("output_value")):
            violation(failures, "DCS-ORACLE-VALUE", "authority %r outputs %r but source computes %r" % (key, item.get("output_value"), result))
        if item.get("model_field") == "maturity":
            precision, output = item.get("precision"), item.get("output_value")
            exact_text = isinstance(output, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", output)
            if precision != "exact" and exact_text:
                violation(failures, "DCS-ORACLE-SYNTHETIC-DATE", "%s has exact maturity under %s precision" % (key[0], precision))
        authority_keys.add(key)

    for candidate in crosswalk.get("instruments", []):
        if candidate.get("disposition") not in {"model_input", "derived_model_input"}:
            continue
        instrument_id = candidate.get("instrument_id")
        declared = {item.get("model_field"): item for item in candidate.get("term_authorities", [])}
        balance_basis = (declared.get("balance_basis") or {}).get("output_value")
        currency = (declared.get("currency") or {}).get("output_value")
        reporting_currency = crosswalk.get("export_metadata", {}).get("reporting_currency")
        missing_required = independently_required_fields(declared, reporting_currency) - set(declared)
        if missing_required:
            violation(
                failures,
                "DCS-ORACLE-REQUIRED-TERM",
                "%s lacks independently required fields %s" %
                (instrument_id, sorted(missing_required)),
            )
        outstanding = declared.get("outstanding_amount") or {}
        if balance_basis not in {"native_principal", "reporting_currency_carrying_value"}:
            violation(failures, "DCS-ORACLE-BALANCE-BASIS", "%s has invalid balance basis" % instrument_id)
        if balance_basis == "reporting_currency_carrying_value" and outstanding.get("transform", {}).get("kind") == "fx_translate":
            violation(failures, "DCS-ORACLE-CARRYING-FX", "%s reporting-currency carrying value is retranslated" % instrument_id)
        if balance_basis == "native_principal" and currency != reporting_currency:
            if outstanding.get("transform", {}).get("kind") != "fx_translate" or "native_principal" not in declared or "fx_rate" not in declared:
                violation(failures, "DCS-ORACLE-NATIVE-FX", "%s foreign native principal lacks explicit FX authority" % instrument_id)
        if (declared.get("instrument_type") or {}).get("output_value") == "rcf":
            convention = (declared.get("commitment_fee_convention") or {}).get("output_value")
            fee_value = (declared.get("commitment_fee_value") or {}).get("output_value")
            if convention not in {"none", "bps_on_undrawn"}:
                violation(failures, "DCS-ORACLE-RCF-FEE", "%s has invalid commitment fee convention" % instrument_id)
            if convention == "bps_on_undrawn" and not (isinstance(fee_value, (int, float)) and not isinstance(fee_value, bool) and fee_value > 0):
                violation(failures, "DCS-ORACLE-RCF-FEE", "%s has invalid commitment fee value" % instrument_id)
        optional_values = {key: item.get("output_value") for key, item in declared.items()}
        if "interest_settlement" in optional_values and optional_values["interest_settlement"] not in {"cash", "non_cash"}:
            violation(failures, "DCS-ORACLE-INTEREST-SETTLEMENT", "%s has invalid interest settlement" % instrument_id)
        if "debt_classification" in optional_values:
            classification = optional_values["debt_classification"]
            if not isinstance(classification, dict) or any(key not in {"include_in_gross_debt", "include_in_net_debt"} or not isinstance(value, bool) for key, value in (classification or {}).items()):
                violation(failures, "DCS-ORACLE-DEBT-CLASSIFICATION", "%s has malformed debt classification" % instrument_id)
        if "amortisation_schedule" in optional_values:
            schedule = optional_values["amortisation_schedule"]
            if not (isinstance(schedule, list) and all(isinstance(item, dict) and valid_date(item.get("date")) and isinstance(item.get("amount"), (int, float)) and not isinstance(item.get("amount"), bool) and item["amount"] >= 0 for item in schedule)):
                violation(failures, "DCS-ORACLE-AMORTISATION", "%s has malformed amortisation schedule" % instrument_id)
        if "refinancing_intent" in optional_values and optional_values["refinancing_intent"] not in {"refinanced", "repaid"}:
            violation(failures, "DCS-ORACLE-REFINANCING", "%s has invalid refinancing intent" % instrument_id)
        if "is_backstop_for_paper" in optional_values and not isinstance(optional_values["is_backstop_for_paper"], bool):
            violation(failures, "DCS-ORACLE-BACKSTOP", "%s has invalid backstop indicator" % instrument_id)
        if "next_call_date" in optional_values and not valid_date(optional_values["next_call_date"]):
            violation(failures, "DCS-ORACLE-CALL-DATE", "%s has invalid next call date" % instrument_id)
        for authority in candidate.get("term_authorities", []):
            key = (instrument_id, authority.get("model_field"))
            if authority.get("model_field") not in MODEL_FIELDS:
                violation(failures, "DCS-ORACLE-UNKNOWN-MODEL-FIELD", "authority %r is not a supported model field" % (key,))
            for cell_id in authority.get("source_cells") or []:
                cell_disposition = disposition_by_cell.get(cell_id) or {}
                if cell_disposition.get("disposition") not in {"model_input", "derived_model_input"} or cell_disposition.get("owner_id") != instrument_id:
                    violation(failures, "DCS-ORACLE-AUTHORITY-DISPOSITION", "authority %r uses cell %s outside its model evidence" % (key, cell_id))
            sealed = projection_by_key.get(key)
            if sealed is None:
                violation(failures, "DCS-ORACLE-MISSING-AUTHORITY", "crosswalk authority %r is absent from projection" % (key,))
            elif not same(sealed.get("output_value"), authority.get("output_value")) or sealed.get("source_cells") != authority.get("source_cells"):
                violation(failures, "DCS-ORACLE-AUTHORITY-MISMATCH", "projection changed crosswalk authority %r" % (key,))

    expected_supplemental = []
    for candidate in crosswalk.get("instruments", []):
        if candidate.get("disposition") != "supplemental_evidence":
            continue
        instrument_id = candidate.get("instrument_id")
        expected_supplemental.append({
            "candidate_id": candidate.get("candidate_id"),
            "instrument_id": instrument_id,
            "term_authorities": [
                {
                    **item,
                    "instrument_id": instrument_id,
                    "transform": item.get("transform") or {"kind": "direct"},
                    "authority_kind": item.get("authority_kind", "source_cell"),
                    "precision": item.get("precision", "exact"),
                }
                for item in candidate.get("term_authorities", [])
            ],
        })
    actual_supplemental = projection.get("supplemental_fields", [])
    if canon(expected_supplemental) != canon(actual_supplemental):
        violation(
            failures,
            "DCS-ORACLE-SUPPLEMENTAL-SET",
            "projection supplemental evidence is not the exact crosswalk-authored set",
        )

    for supplemental in actual_supplemental:
        for item in supplemental.get("term_authorities", []):
            for cell_id in item.get("source_cells") or []:
                if (disposition_by_cell.get(cell_id) or {}).get("disposition") != "supplemental_evidence":
                    violation(failures, "DCS-ORACLE-SUPPLEMENTAL-DISPOSITION", "supplemental field %s uses non-supplemental cell %s" % (item.get("model_field"), cell_id))
            try:
                result = compute(item, cells, supplements)
            except (KeyError, TypeError, ValueError) as error:
                violation(failures, "DCS-ORACLE-SUPPLEMENTAL-TRANSFORM", "supplemental evidence cannot be recomputed: %s" % error)
                continue
            if not same(result, item.get("output_value")):
                violation(failures, "DCS-ORACLE-SUPPLEMENTAL-VALUE", "supplemental field %s differs from source" % item.get("model_field"))

    for instrument in projection.get("dcs_export", {}).get("instruments", []):
        instrument_id = instrument.get("instrument_id")
        for field, value in instrument.items():
            authority_field = "maturity" if field == "maturity_date" else field
            if field in {"instrument_id", "maturity_precision", "maturity_treatment"}:
                continue
            authority = projection_by_key.get((instrument_id, authority_field))
            if authority is None:
                violation(failures, "DCS-ORACLE-PROJECTION-WITHOUT-AUTHORITY", "%s.%s has no term authority" % (instrument_id, field))
            elif not same(value, authority.get("output_value")):
                violation(failures, "DCS-ORACLE-PROJECTION-VALUE", "%s.%s differs from its authority" % (instrument_id, field))

    for supplement_id, supplement in supplements.items():
        used = [item for item in projection.get("term_authorities", []) if item.get("supplement_id") == supplement_id]
        for item in used:
            if not same(item.get("output_value"), supplement.get("value")):
                violation(failures, "DCS-ORACLE-SUPPLEMENT-MISMATCH", "supplement %s differs from projected value" % supplement_id)

    receipt_status = receipt.get("status")
    if receipt_status != "PASS":
        violation(failures, "DCS-ORACLE-NONPASS-RECEIPT", "compiler receipt status is %r" % receipt_status)
    if receipt.get("counts", {}).get("unowned_cells") != 0 or receipt.get("counts", {}).get("double_owned_cells") != 0:
        violation(failures, "DCS-ORACLE-OWNERSHIP-RECEIPT", "receipt does not state zero unowned and double-owned cells")
    if receipt.get("counts", {}).get("violations") != 0:
        violation(failures, "DCS-ORACLE-COMPILER-VIOLATIONS", "compiler receipt carries violations")

    report = {
        "schema_version": "dcs-independent-verification/1.0",
        "status": "PASS" if not failures else "BLOCKED",
        "source_sha256": source_hash,
        "artifact_hashes": {key: hash_file(path) for key, path in paths.items()},
        "counts": {"source_rows": len(rows), "source_cells": len(cells), "term_authorities": len(authority_keys), "violations": len(failures)},
        "violations": failures,
    }
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(canon(report))
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
