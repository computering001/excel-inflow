#!/usr/bin/env python3
"""Propose a lossless DCS crosswalk from recognizable structured exports.

This is a deterministic adapter, not a debt modeller. It maps header aliases
to the existing field-authority contract, preserves every nonblank cell and
emits explicit unresolved findings rather than inventing dates, rates or FX.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any


def canon(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canon(value)).hexdigest()


def norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


ALIASES = {
    "description": {"instrument", "instrument name", "security description", "description", "issue name", "security name", "debt instrument"},
    "instrument_type": {"type", "instrument type", "security type", "debt type", "asset type"},
    "currency": {"currency", "ccy", "denomination currency", "issue currency"},
    "outstanding_amount": {"outstanding", "outstanding amount", "amount outstanding", "current amount outstanding", "principal outstanding", "par amount", "debt outstanding", "balance"},
    "maturity": {"maturity", "maturity date", "due date", "final maturity", "redemption date"},
    "rate_type": {"rate type", "coupon type", "interest type", "fixed floating"},
    "coupon_rate": {"coupon", "coupon rate", "interest rate", "fixed rate"},
    "reference_rate": {"reference rate", "benchmark", "base rate", "index"},
    "margin_bps": {"margin bps", "spread bps", "margin", "spread"},
    "all_in_rate": {"all in rate", "all in coupon", "effective rate"},
    "facility_limit": {"facility limit", "facility size", "commitment", "committed amount", "total commitment", "capacity"},
    "drawn_amount": {"drawn", "drawn amount", "amount drawn", "current draw"},
    "committed": {"committed", "is committed"},
    "native_principal": {"native principal", "native amount", "original currency amount", "principal native"},
    "fx_rate": {"fx rate", "exchange rate", "reporting per native"},
    "balance_basis": {"balance basis", "amount basis", "currency basis"},
    "commitment_fee_convention": {"fee convention", "commitment fee convention"},
    "commitment_fee_value": {"fee value", "commitment fee", "commitment fee bps"},
    "interest_settlement": {"interest settlement", "settlement", "cash non cash"},
    "debt_classification": {"debt classification", "classification flags", "model classification"},
    "amortisation_schedule": {"amortisation schedule", "amortization schedule", "principal schedule"},
    "refinancing_intent": {"refinancing intent", "refinance repay", "refi intent"},
    "next_call_date": {"next call date", "call date", "first call date"},
    "is_backstop_for_paper": {"backstop for paper", "commercial paper backstop", "cp backstop"},
    "issue_date": {"issue date", "dated date"},
    "price": {"price", "clean price", "dirty price"},
    "yield_to_worst": {"ytw", "yield to worst"},
    "oas": {"oas", "option adjusted spread"},
}

AUDIT_ONLY = {"issue_date", "price", "yield_to_worst", "oas"}
STRUCTURED_OPTIONAL = {"interest_settlement", "debt_classification", "amortisation_schedule", "refinancing_intent", "next_call_date", "is_backstop_for_paper"}

DEBT_CLASS_ONTOLOGY = json.loads(
    (Path(__file__).resolve().parents[1] / "assets" / "debt-class-ontology-v1.json").read_text("utf-8")
)
CANONICAL_DEBT_CLASSES = frozenset(DEBT_CLASS_ONTOLOGY["canonical_classes"])


def classify_type(value: Any, description: str, rate_hint: str = "") -> str | None:
    text = (norm(value) + " " + norm(description)).strip()
    if not text:
        return None
    if "revolv" in text or re.search(r"\brcf\b", text):
        return "rcf"
    if "commercial paper" in text or re.search(r"\bcp\b", text):
        return "commercial_paper"
    if "securiti" in text:
        return "securitisation"
    if "overdraft" in text:
        return "overdraft"
    if "lease liabil" in text or "finance lease" in text:
        return "lease_liability"
    security_note = bool(re.search(
        r"\b(?:senior|secured|unsecured|subordinated|convertible|floating rate|fixed rate|medium term) notes?\b|\bnotes? due\b",
        text,
    ))
    is_bond = any(token in text for token in ("bond", "debenture")) or security_note
    is_term_loan = any(token in text for token in ("term loan", "term facility", "bank loan"))
    floating = "floating" in text or rate_hint == "floating"
    fixed = "fixed" in text or rate_hint == "fixed"
    if is_bond and floating:
        return "bond_floating"
    if is_bond and fixed:
        return "bond_fixed"
    if is_term_loan and floating:
        return "term_loan_floating"
    if is_term_loan and fixed:
        return "term_loan_fixed"
    if any(token in text for token in ("other debt", "other borrow", "miscellaneous borrow", "finance obligation")):
        return "other_explicit"
    # Unknown is a real class with a review obligation. It is never silently
    # promoted to Other Debt.
    return "unclassified"


def parse_number(value: Any) -> float | int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool): return value
    text = str(value or "").strip().replace(",", "")
    if not text: return None
    negative = text.startswith("(") and text.endswith(")")
    text = text.strip("()$£€% ")
    try:
        number = float(text)
    except ValueError:
        return None
    number = -number if negative else number
    return int(number) if number.is_integer() else number


def parse_bool(value: Any) -> bool | None:
    if isinstance(value, bool): return value
    text = norm(value)
    if text in {"true", "yes", "y", "1", "committed"}: return True
    if text in {"false", "no", "n", "0", "uncommitted"}: return False
    return None


def maturity_value(value: Any) -> tuple[Any, str] | None:
    text = str(value or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text): return text, "exact"
    if re.fullmatch(r"\d{4}-\d{2}", text): return text, "month"
    if re.fullmatch(r"\d{4}", text): return text, "year"
    if norm(text) in {"perpetual", "non maturing", "evergreen"}: return None, "non_maturing"
    return None


def direct(field: str, cell: dict[str, Any], value: Any, *, precision: str = "exact", kind: str = "direct", basis: dict[str, Any] | None = None) -> dict[str, Any]:
    transform = {"kind": "classified_constant", "value": value} if kind == "classified_constant" else {"kind": kind}
    record = {"model_field": field, "output_value": value, "source_cells": [cell["cell_id"]], "transform": transform, "authority_kind": "source_cell" if kind == "direct" else "derived_source_cells", "precision": precision}
    if basis: record["basis"] = basis
    return record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_tables")
    parser.add_argument("candidate_manifest")
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    source = json.loads(Path(args.source_tables).read_text("utf-8"))
    manifest = json.loads(Path(args.candidate_manifest).read_text("utf-8"))
    metadata = json.loads(Path(args.metadata).read_text("utf-8"))
    cells = {cell["cell_id"]: cell for sheet in source["sheets"] for row in sheet["rows"] for cell in row["cells"]}
    rows = {row["row_id"]: row for sheet in source["sheets"] for row in sheet["rows"]}
    row_dispositions, cell_dispositions, instruments, unresolved = [], [], [], []
    owned_cells: set[str] = set()
    model_columns: set[str] = set()

    for sheet in source["sheets"]:
        populated = [row for row in sheet["rows"] if row["cells"]]
        if not populated: continue
        best: tuple[int, dict[str, Any], dict[str, dict[str, Any]]] | None = None
        for candidate in populated[:20]:
            mapping: dict[str, dict[str, Any]] = {}
            for cell in candidate["cells"]:
                label = norm(cell["display_value"])
                field = next((key for key, aliases in ALIASES.items() if label in aliases), None)
                if field and field not in mapping: mapping[field] = cell
            score = len(set(mapping) & {"description", "currency", "outstanding_amount", "maturity", "instrument_type"})
            if best is None or score > best[0]: best = (score, candidate, mapping)
        if not best or best[0] < 2: continue
        _, header, mapping = best
        for cell in header["cells"]: owned_cells.add(cell["cell_id"])
        row_dispositions.append({"row_id": header["row_id"], "disposition": "not_applicable", "rationale": "Recognized structured DCS header row", "owner_id": None})
        for cell in header["cells"]: cell_dispositions.append({"cell_id": cell["cell_id"], "disposition": "not_applicable", "rationale": "Structured DCS header label", "owner_id": None})
        for row in populated:
            if row["row"] <= header["row"]: continue
            by_column = {cell["column"]: cell for cell in row["cells"]}
            value_for = lambda field: by_column.get(mapping[field]["column"]) if field in mapping else None
            desc_cell = value_for("description")
            description = str(desc_cell["display_value"] if desc_cell else "").strip()
            if not description: continue
            rate_hint_cell = value_for("rate_type")
            coupon_hint = value_for("coupon_rate")
            reference_hint = value_for("reference_rate")
            margin_hint = value_for("margin_bps")
            declared_rate_hint = (
                norm(rate_hint_cell["display_value"]).replace(" ", "_")
                if rate_hint_cell
                else ""
            )
            rate_hint = (
                declared_rate_hint
                if declared_rate_hint in {"fixed", "floating"}
                else "floating"
                if reference_hint and margin_hint and parse_number(margin_hint["display_value"]) is not None
                else "fixed"
                if coupon_hint and parse_number(coupon_hint["display_value"]) is not None
                else ""
            )
            instrument_type = classify_type(
                value_for("instrument_type")["display_value"] if value_for("instrument_type") else None,
                description,
                rate_hint,
            )
            instrument_id = re.sub(r"[^a-z0-9]+", "_", description.lower()).strip("_")[:48] or f"instrument_{row['row']}"
            instrument_id = f"{instrument_id}_{sheet['index']}_{row['row']}"
            authorities: list[dict[str, Any]] = [direct("description", desc_cell, description)]
            owner_disposition = "model_input"
            missing: list[str] = []
            if instrument_type:
                if instrument_type not in CANONICAL_DEBT_CLASSES:
                    raise RuntimeError(f"Classifier emitted non-canonical debt class {instrument_type!r}")
                type_cell = value_for("instrument_type")
                type_authority = direct(
                    "instrument_type",
                    type_cell or desc_cell,
                    instrument_type,
                    kind="classified_constant",
                )
                for evidence_cell in (
                    desc_cell,
                    rate_hint_cell,
                    coupon_hint,
                    reference_hint,
                    margin_hint,
                ):
                    if evidence_cell and evidence_cell["cell_id"] not in type_authority["source_cells"]:
                        type_authority["source_cells"].append(evidence_cell["cell_id"])
                authorities.append(type_authority)
                if instrument_type == "unclassified":
                    missing.append("instrument_type_review")
            else: missing.append("instrument_type")
            currency_cell = value_for("currency")
            currency = str(currency_cell["display_value"]).upper().strip() if currency_cell else ""
            if re.fullmatch(r"[A-Z]{3}", currency): authorities.append(direct("currency", currency_cell, currency))
            else: missing.append("currency")
            outstanding_cell = value_for("outstanding_amount")
            outstanding = parse_number(outstanding_cell["display_value"]) if outstanding_cell else None
            basis_cell = value_for("balance_basis")
            basis = norm(basis_cell["display_value"]).replace(" ", "_") if basis_cell else "reporting_currency_carrying_value"
            if basis not in {"native_principal", "reporting_currency_carrying_value"}: basis = "reporting_currency_carrying_value"
            authorities.append(direct("balance_basis", basis_cell or outstanding_cell or desc_cell, basis, kind="direct" if basis_cell else "classified_constant"))
            native_cell, fx_cell = value_for("native_principal"), value_for("fx_rate")
            native, fx = parse_number(native_cell["display_value"]) if native_cell else None, parse_number(fx_cell["display_value"]) if fx_cell else None
            if outstanding is not None and outstanding >= 0:
                authorities.append(direct("outstanding_amount", outstanding_cell, outstanding))
            elif basis == "native_principal" and native is not None and native >= 0 and fx is not None and fx > 0:
                authorities += [
                    direct("native_principal", native_cell, native, basis={"currency": currency, "units": metadata["adapter_metadata"]["units"]}),
                    direct("fx_rate", fx_cell, fx, basis={"quote": "reporting_per_native", "as_of": metadata["adapter_metadata"]["as_of"]}),
                    {"model_field": "outstanding_amount", "output_value": native * fx, "source_cells": [native_cell["cell_id"]], "transform": {"kind": "fx_translate", "fx_rate_cell": fx_cell["cell_id"], "quote": "reporting_per_native"}, "authority_kind": "derived_source_cells", "precision": "exact", "basis": {"balance_basis": "native_principal", "output_currency": metadata["adapter_metadata"]["reporting_currency"]}},
                ]
            else: missing.append("outstanding_amount")
            maturity_cell = value_for("maturity")
            maturity = maturity_value(maturity_cell["display_value"]) if maturity_cell else None
            if maturity: authorities.append(direct("maturity", maturity_cell, maturity[0], precision=maturity[1]))
            elif instrument_type == "rcf" and not maturity_cell: missing.append("maturity")
            else: missing.append("maturity")

            rate_type_cell = value_for("rate_type")
            rate_type = norm(rate_type_cell["display_value"]).replace(" ", "_") if rate_type_cell else ""
            coupon_cell, reference_cell, margin_cell, allin_cell = (value_for(name) for name in ("coupon_rate", "reference_rate", "margin_bps", "all_in_rate"))
            coupon, margin, allin = parse_number(coupon_cell["display_value"]) if coupon_cell else None, parse_number(margin_cell["display_value"]) if margin_cell else None, parse_number(allin_cell["display_value"]) if allin_cell else None
            if rate_type not in {"fixed", "floating", "manual_all_in"}:
                rate_type = "fixed" if coupon is not None else "floating" if reference_cell and margin is not None else "manual_all_in" if allin is not None else ""
            pricing = "source_terms" if rate_type else "residual_interest_plug"
            if rate_type:
                authorities.append(direct("rate_type", rate_type_cell or coupon_cell or reference_cell or allin_cell, rate_type, kind="direct" if rate_type_cell else "classified_constant"))
                if rate_type == "fixed" and coupon is not None: authorities.append(direct("coupon_rate", coupon_cell, coupon))
                elif rate_type == "floating" and reference_cell and margin is not None:
                    authorities += [direct("reference_rate", reference_cell, str(reference_cell["display_value"])), direct("margin_bps", margin_cell, margin)]
                elif rate_type == "manual_all_in" and allin is not None: authorities.append(direct("all_in_rate", allin_cell, allin))
                else: missing.append("pricing_terms")

            if instrument_type == "rcf":
                for field in ("facility_limit", "drawn_amount"):
                    cell = value_for(field); number = parse_number(cell["display_value"]) if cell else None
                    if number is None or number < 0: missing.append(field)
                    else: authorities.append(direct(field, cell, number))
                committed_cell = value_for("committed"); committed = parse_bool(committed_cell["display_value"]) if committed_cell else True
                authorities.append(direct("committed", committed_cell or desc_cell, committed, kind="boolean" if committed_cell else "classified_constant"))
                if pricing == "source_terms":
                    conv_cell, fee_cell = value_for("commitment_fee_convention"), value_for("commitment_fee_value")
                    fee = parse_number(fee_cell["display_value"]) if fee_cell else None
                    if conv_cell and fee is not None:
                        authorities += [direct("commitment_fee_convention", conv_cell, norm(conv_cell["display_value"]).replace(" ", "_")), direct("commitment_fee_value", fee_cell, fee)]
                    else: missing.append("commitment_fee_terms")

            for field in sorted(STRUCTURED_OPTIONAL):
                cell = value_for(field)
                if not cell: continue
                value: Any = cell["display_value"]
                kind = "direct"
                if field == "is_backstop_for_paper": value, kind = parse_bool(value), "boolean"
                elif field in {"debt_classification", "amortisation_schedule"}:
                    try: value, kind = json.loads(str(value)), "json"
                    except (TypeError, ValueError): continue
                if value is not None and value != "": authorities.append(direct(field, cell, value, kind=kind))

            for item in authorities:
                owned_cells.update(item["source_cells"])
            row_cells = [cell["cell_id"] for cell in row["cells"]]
            if missing:
                unresolved.append({"instrument_id": instrument_id, "description": description, "missing_fields": sorted(set(missing)), "row_id": row["row_id"]})
            row_dispositions.append({"row_id": row["row_id"], "disposition": owner_disposition, "rationale": "Recognized DCS instrument row" if not missing else "Recognized instrument row; required-term deficiency is retained in the proposal receipt", "owner_id": instrument_id})
            instruments.append({"candidate_id": f"candidate:{row['row_id']}", "instrument_id": instrument_id, "disposition": owner_disposition, "rationale": "Source-owned structured debt instrument" if not missing else "Source-owned instrument with unresolved required term(s): " + ", ".join(sorted(set(missing))), "row_ids": [row["row_id"]], "pricing_treatment": pricing, "pricing_treatment_reason": "Instrument pricing is source-backed." if pricing == "source_terms" else "No complete pricing terms in DCS; preserve exposure and require the visible residual-interest authority.", "term_authorities": authorities})
            for cell in row["cells"]:
                field = next((name for name, head in mapping.items() if head["column"] == cell["column"]), None)
                disposition = "supplemental_evidence" if field in AUDIT_ONLY else owner_disposition if cell["cell_id"] in owned_cells else "supplemental_evidence"
                cell_dispositions.append({"cell_id": cell["cell_id"], "disposition": disposition, "rationale": "Model-driving source cell" if disposition in {"model_input", "derived_model_input"} else "Preserved audit-only or unresolved source evidence", "owner_id": instrument_id})
                owned_cells.add(cell["cell_id"])
            model_columns.update({field for field in ("outstanding_amount", "facility_limit", "drawn_amount") if field in mapping})

    for row in manifest["rows"]:
        if any(item["row_id"] == row["row_id"] for item in row_dispositions): continue
        row_dispositions.append({"row_id": row["row_id"], "disposition": "not_applicable", "rationale": "Outside a recognized DCS instrument table", "owner_id": None})
        for cell_id in row["cell_ids"]:
            cell_dispositions.append({"cell_id": cell_id, "disposition": "not_applicable", "rationale": "Outside a recognized DCS instrument table", "owner_id": None})

    meta = metadata["adapter_metadata"]
    crosswalk = {"schema_version": "dcs-crosswalk/1.0", "source_tables_sha256": digest(source), "candidate_manifest_sha256": digest(manifest), "export_metadata": {"as_of": meta["as_of"], "source": {"system": meta.get("system", "Structured DCS adapter"), "date_basis": meta.get("date_basis", "last_fiscal_year_end")}, "entity": {"name": meta["entity_name"]}, "reporting_currency": meta["reporting_currency"], "units": meta["units"], "columns": [{"field": field, "currency": meta["reporting_currency"], "units": meta["units"]} for field in sorted(model_columns or {"outstanding_amount"})]}, "row_dispositions": row_dispositions, "cell_dispositions": cell_dispositions, "instruments": instruments, "supplements": []}
    output = Path(args.out); output.parent.mkdir(parents=True, exist_ok=True); output.write_bytes(canon(crosswalk))
    receipt = {"schema_version": "dcs-crosswalk-proposal-receipt/1.0", "status": "PASS" if instruments and not unresolved else "NEEDS_EVIDENCE" if unresolved else "UNRECOGNIZED", "instrument_count": len(instruments), "unresolved": unresolved, "crosswalk_sha256": digest(crosswalk)}
    receipt_path = output.with_name("dcs-crosswalk-proposal-receipt.json"); receipt_path.write_bytes(canon(receipt))
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
