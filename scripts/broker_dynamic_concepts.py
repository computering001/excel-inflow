from __future__ import annotations

import hashlib
import json
import re
from typing import Any


METRIC_ID = re.compile(r"^run\.[a-z0-9][a-z0-9_.-]*$")
SECTIONS = {"income_statement", "cash_flow"}
UNIT_KINDS = {"currency", "ratio", "percent_decimal"}
SIGNS = {"positive", "negative", "source_signed"}
BEHAVIORS = {"independent_input", "driver", "carry_forward", "reference_only"}
ANCHOR_RELATIONS = {"before", "after", "child_of"}
ROW_MODES = {"existing_company_row", "new_company_specific_row"}


def canonical_hash(value: Any) -> str:
    payload = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8") + b"\n"
    return hashlib.sha256(payload).hexdigest()


def validate_run_scoped_concepts(
    concepts: Any, *, run_id: str
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    if concepts is None:
        return {}, []
    if not isinstance(concepts, list):
        return {}, ["run_scoped_concepts must be an array"]
    indexed: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    allowed_keys = {
        "schema_version", "run_id", "metric_id", "section", "definition",
        "unit_kind", "sign_convention", "parent_row_id", "placement_anchor",
        "materiality", "forecast_behavior", "additive", "double_count_proof",
        "row_relation", "review_status", "contract_sha256",
    }
    for index, concept in enumerate(concepts):
        label = f"run_scoped_concepts[{index}]"
        if not isinstance(concept, dict):
            errors.append(f"{label} must be an object")
            continue
        extra = sorted(set(concept) - allowed_keys)
        if extra:
            errors.append(f"{label} has unknown fields: {', '.join(extra)}")
        metric_id = concept.get("metric_id")
        if not isinstance(metric_id, str) or not METRIC_ID.fullmatch(metric_id):
            errors.append(f"{label}.metric_id must use the run.* namespace")
            continue
        if metric_id in indexed:
            errors.append(f"{label} duplicates metric_id {metric_id}")
        if concept.get("schema_version") != "run-scoped-broker-concept/1.0":
            errors.append(f"{label} has the wrong schema_version")
        if concept.get("run_id") != run_id:
            errors.append(f"{label} belongs to another run")
        if concept.get("section") not in SECTIONS:
            errors.append(f"{label}.section is unsupported")
        if len(str(concept.get("definition") or "").strip()) < 12:
            errors.append(f"{label}.definition is not specific enough")
        if concept.get("unit_kind") not in UNIT_KINDS:
            errors.append(f"{label}.unit_kind is unsupported")
        if concept.get("sign_convention") not in SIGNS:
            errors.append(f"{label}.sign_convention is unsupported")
        if not str(concept.get("parent_row_id") or "").strip():
            errors.append(f"{label}.parent_row_id is required")
        anchor = concept.get("placement_anchor") or {}
        if (
            anchor.get("relation") not in ANCHOR_RELATIONS
            or not str(anchor.get("row_id") or "").strip()
        ):
            errors.append(f"{label}.placement_anchor is invalid")
        materiality = concept.get("materiality") or {}
        if not isinstance(materiality.get("is_material"), bool):
            errors.append(f"{label}.materiality.is_material must be boolean")
        if materiality.get("basis") not in {
            "headline_anchor", "revenue", "absolute_currency"
        }:
            errors.append(f"{label}.materiality.basis is unsupported")
        for field in ("threshold", "observed_value"):
            value = materiality.get(field)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                errors.append(f"{label}.materiality.{field} must be numeric")
        if concept.get("forecast_behavior") not in BEHAVIORS:
            errors.append(f"{label}.forecast_behavior is unsupported")
        if not isinstance(concept.get("additive"), bool):
            errors.append(f"{label}.additive must be boolean")
        proof = concept.get("double_count_proof") or {}
        if (
            proof.get("status") != "no_overlap"
            or not isinstance(proof.get("compared_metric_ids"), list)
            or not proof.get("compared_metric_ids")
            or len(set(proof.get("compared_metric_ids") or []))
            != len(proof.get("compared_metric_ids") or [])
            or len(str(proof.get("rationale") or "").strip()) < 12
        ):
            errors.append(f"{label}.double_count_proof is incomplete")
        row_relation = concept.get("row_relation") or {}
        if (
            row_relation.get("mode") not in ROW_MODES
            or not str(row_relation.get("row_id") or "").strip()
        ):
            errors.append(f"{label}.row_relation is invalid")
        if row_relation.get("mode") == "new_company_specific_row" and (
            concept.get("additive") is not False
            or concept.get("forecast_behavior") != "reference_only"
        ):
            errors.append(
                f"{label} may create a new company row only as non-additive reference evidence"
            )
        if concept.get("review_status") != "reviewed":
            errors.append(f"{label}.review_status must be reviewed")
        body = {key: value for key, value in concept.items() if key != "contract_sha256"}
        if concept.get("contract_sha256") != canonical_hash(body):
            errors.append(f"{label}.contract_sha256 is stale")
        indexed[metric_id] = concept
    return indexed, errors
