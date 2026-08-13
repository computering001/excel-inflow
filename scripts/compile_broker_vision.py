#!/usr/bin/env python3
"""Merge two independent image-table transcriptions into an evidence bundle."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

from compile_broker_candidate_manifest import compile_manifest
from compile_broker_canonical_tables import canonicalise_bundle


NUMERIC_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:\(?[-+]?[$€£¥]?\s*(?:\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d+)?%?\)?|[-+]?\d+(?:\.\d+)?x)(?![A-Za-z])",
)
VISION_RESULT_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "assets" / "broker-vision-result.schema.json"
INDEPENDENT_RESPONSE_BINDING_FIELDS = {
    "schema_version",
    "document_id",
    "surface_id",
    "image_sha256",
    "pass_index",
    "producer_id",
    "producer_fingerprint",
    "method",
    "surface_disposition",
    "tables",
}


def vision_schema_contract_errors(schema: dict[str, Any]) -> list[str]:
    """Prove the published response schema admits every compiler binding.

    This is intentionally a contract-closure check, not another JSON Schema
    implementation. The deployment host validates response instances against
    the published schema; the compiler validates their economic bindings. Both
    layers must agree on the independent-response identity fields.
    """
    errors: list[str] = []
    properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    missing_properties = sorted(INDEPENDENT_RESPONSE_BINDING_FIELDS - set(properties))
    if missing_properties:
        errors.append(f"schema forbids compiler binding fields: {missing_properties}")
    pass_clause = next(
        (
            item for item in schema.get("allOf", [])
            if isinstance(item, dict)
            and item.get("if", {}).get("properties", {}).get("pass_index", {}).get("enum") == [1, 2]
        ),
        None,
    )
    required = set((pass_clause or {}).get("then", {}).get("required", []))
    required_for_pass = {"tables", "producer_fingerprint", "surface_disposition"}
    if not required_for_pass.issubset(required):
        errors.append(
            "independent pass schema does not require: "
            f"{sorted(required_for_pass - required)}"
        )
    if schema.get("additionalProperties") is not False:
        errors.append("response schema must remain closed to undeclared fields")
    return errors


def assert_vision_schema_contract() -> None:
    schema = json.loads(VISION_RESULT_SCHEMA_PATH.read_text("utf-8"))
    errors = vision_schema_contract_errors(schema)
    if errors:
        raise RuntimeError("Broker vision schema/compiler contract drift: " + "; ".join(errors))


def material_uncovered_region_count(bundle: dict[str, Any]) -> int:
    """Reduce the finalized surface dispositions into the bundle total.

    The extraction-time summary is deliberately stale after vision closes a
    previously uncovered region. Ingress validates immutable per-surface
    census artifacts, so the compatibility aggregate must be recomputed from
    those same final surface dispositions rather than carried forward.
    """
    return sum(
        1
        for document in bundle.get("documents", [])
        for surface in document.get("surfaces", [])
        for region in surface.get("uncovered_numeric_regions", [])
        if region.get("material")
        and region.get("disposition") not in {
            "covered",
            "covered_by_vision",
            "verified_non_tabular",
            "quarantined_evidence_only",
        }
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bind_final_surface_census(
    *, bundle: dict[str, Any], document: dict[str, Any], surface: dict[str, Any]
) -> None:
    """Write a new immutable census after independent vision has completed.

    The extraction-time census is never overwritten. Vision can legitimately
    discover numeric content on a surface whose native lanes were empty, so the
    verified bundle must point at a successor census whose bytes bind that
    independently observed surface universe.
    """
    artifacts = {item["artifact_id"]: item for item in document.get("artifacts", [])}
    prior = artifacts.get(surface.get("surface_census_artifact_id"))
    artifact_root = Path(str(bundle.get("artifact_root") or "")).resolve()
    prior_payload: dict[str, Any] = {}
    if prior and artifact_root:
        prior_path = (artifact_root / str(prior.get("path") or "")).resolve()
        if prior_path.is_file():
            prior_payload = json.loads(prior_path.read_text("utf-8"))
    payload = {
        **prior_payload,
        "schema_version": "broker-surface-census/1.0",
        "document_id": document["document_id"],
        "surface_id": surface["surface_id"],
        "kind": surface["kind"],
        "whole_surface_numeric_token_count": surface.get(
            "whole_surface_numeric_token_count"
        ),
        "source_numeric_tokens": list(
            prior_payload.get("source_numeric_tokens", [])
            if surface.get("vision_disposition") == "verified_non_tabular"
            else surface.get("vision_source_census", {}).get(
                "source_numeric_tokens",
                surface.get("source_table_numeric_tokens", []),
            )
        ),
        "source_table_numeric_tokens": list(
            surface.get("source_table_numeric_tokens", [])
        ),
        "table_discovery_lanes": copy.deepcopy(
            surface.get("table_discovery_lanes", [])
        ),
        "uncovered_numeric_regions": copy.deepcopy(
            surface.get("uncovered_numeric_regions", [])
        ),
        "material_uncovered_region_count": sum(
            1
            for region in surface.get("uncovered_numeric_regions", [])
            if region.get("material")
            and region.get("disposition") not in {
                "covered",
                "covered_by_vision",
                "verified_non_tabular",
                "quarantined_evidence_only",
            }
        ),
    }
    relative = Path("artifacts") / document["document_id"] / "census-final" / f"{surface['surface_id']}.json"
    output = (artifact_root / relative).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    output.write_bytes(encoded)
    artifact_id = f"{document['document_id']}.census-final-{surface['surface_id']}.json"
    document.setdefault("artifacts", []).append(
        {
            "artifact_id": artifact_id,
            "kind": "surface_census",
            "path": relative.as_posix(),
            "sha256": hashlib.sha256(encoded).hexdigest(),
        }
    )
    surface["artifact_refs"] = [
        item
        for item in surface.get("artifact_refs", [])
        if item != surface.get("surface_census_artifact_id")
    ] + [artifact_id]
    surface["surface_census_artifact_id"] = artifact_id


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_hash(value: Any) -> str:
    return hashlib.sha256((canonical(value) + "\n").encode("utf-8")).hexdigest()


def normalise_scalar(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    text = str(value).strip()
    if text in {"", "-", "–", "—"}:
        return None if text == "" else text
    return re.sub(r"\s+", " ", text)


def comparable_tables(tables: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "title": normalise_scalar(table.get("title")),
            "units": normalise_scalar(table.get("units")),
            "rows": [[normalise_scalar(value) for value in row] for row in table.get("rows", [])],
        }
        for table in tables
    ]


def comparable_response(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "surface_disposition": result.get("surface_disposition"),
        "tables": comparable_tables(result.get("tables", [])),
        "footnotes": sorted(normalise_scalar(item) for item in result.get("footnotes", []) if normalise_scalar(item)),
        "surface_numeric_tokens": sorted(str(item) for item in result.get("surface_numeric_tokens", [])),
    }


def quarantine_surface_evidence_only(
    *,
    bundle: dict[str, Any],
    document: dict[str, Any],
    surface: dict[str, Any],
    findings: list[dict[str, Any]],
    reason_id: str,
    message: str,
) -> None:
    """Close one ambiguous surface as preserved, model-prohibited evidence.

    Physical preservation and model authority are different facts: the page
    render, raw fragments and census stay sealed, but the surface certifies
    no analytical table and no cell from it may enter a mapping. Used only
    under --degrade-exhausted, after the bounded attempt budget is gone.
    """
    surface["source_table_numeric_tokens"] = []
    surface["vision_disposition"] = "quarantined_evidence_only"
    surface["quarantine"] = {
        "model_use": "prohibited",
        "reason_id": reason_id,
        "scope": "surface",
    }
    surface["lane_status"]["vision"] = "complete"
    surface["vision_reason"] = None
    surface["vision_conflict_summary"] = {
        "conflict_count": 0,
        "quarantined_conflict_count": 0,
        "resolved_conflict_count": 0,
    }
    for region in surface.get("uncovered_numeric_regions", []):
        if region.get("material"):
            region["disposition"] = "quarantined_evidence_only"
    bind_final_surface_census(bundle=bundle, document=document, surface=surface)
    findings.append({
        "id": "broker_vision.surface_quarantined_after_bounded_recovery",
        "severity": "warning",
        "document_id": document["document_id"],
        "surface_id": str(surface.get("surface_id") or ""),
        "quarantine_reason_id": reason_id,
        "message": (
            f"{message} The surface is preserved as evidence-only after bounded "
            "recovery was exhausted; no cell from it is model-eligible."
        ),
    })


def classify_surface_disposition(passes: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    """Close the physical capture question independently of model use.

    Capture is complete when both reads independently preserve at least one
    analytical grid, or when both explicitly verify that the numeric surface is
    non-tabular.  A mixed answer or an empty analytical answer is unresolved.
    """
    dispositions = [item.get("surface_disposition") for item in passes]
    valid = all(
        (
            disposition == "analytical_tables"
            and bool(result.get("tables"))
        )
        or (
            disposition == "verified_non_tabular"
            and not result.get("tables")
            and bool(str(result.get("non_tabular_reason") or "").strip())
        )
        for disposition, result in zip(dispositions, passes)
    )
    if not valid:
        return None, "Each pass must carry a non-empty analytical grid or a reasoned verified_non_tabular disposition."
    if len(set(dispositions)) != 1:
        return None, "The independent passes disagree on whether the surface contains an analytical table."
    return dispositions[0], None


PERIOD_HEADER_RE = re.compile(
    r"^(?:(?:fy|cy)?\s*(?:19|20)?\d{2}(?:\s*/\s*(?:19|20)?\d{2})?[eaf]?|"
    r"(?:q[1-4]|[1-4]q|h[12]|[12]h|[369]m)\s*(?:fy|cy)?\s*(?:19|20)?\d{2}[eaf]?|"
    r"ltm|ttm|ntm)$",
    re.IGNORECASE,
)


def normalise_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def is_period_header(value: Any) -> bool:
    return bool(PERIOD_HEADER_RE.fullmatch(re.sub(r"\s+", " ", str(value or "").strip())))


def raw_table_observations(tables: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Return a layout-tolerant row-label/period/value inventory.

    This is deliberately narrower than a full-table equality test. Captions,
    footnotes, whitespace, table order and segmentation are presentation
    evidence; a displayed value for the same economic row and period is the
    conflict boundary that can affect the model.
    """
    observations: dict[str, list[dict[str, Any]]] = {}
    for table_index, table in enumerate(tables, start=1):
        rows = table.get("rows") or []
        headers: dict[int, str] = {}
        for row in rows:
            for column_index, value in enumerate(row, start=1):
                if is_period_header(value):
                    headers[column_index] = normalise_text(value)
        for row_index, row in enumerate(rows, start=1):
            label = next(
                (
                    normalise_text(value)
                    for value in row
                    if normalise_text(value)
                    and numeric_token(value) is None
                    and not is_period_header(value)
                ),
                "",
            )
            if not label:
                continue
            numeric_ordinal = 0
            for column_index, value in enumerate(row, start=1):
                token = numeric_token(value)
                if token is None:
                    continue
                numeric_ordinal += 1
                period = headers.get(column_index, f"ordinal:{numeric_ordinal}")
                key = f"{label}|{period}"
                observations.setdefault(key, []).append({
                    "table_index": table_index,
                    "row": row_index,
                    "column": column_index,
                    "raw_value": value,
                    "numeric_token": token,
                    "table_bbox": table.get("bbox"),
                    "cell_bbox": (
                        (table.get("cell_bboxes") or [])[row_index - 1][column_index - 1]
                        if row_index <= len(table.get("cell_bboxes") or [])
                        and column_index <= len((table.get("cell_bboxes") or [])[row_index - 1])
                        else None
                    ),
                })
    for values in observations.values():
        values.sort(key=lambda item: (item["table_index"], item["row"], item["column"], item["numeric_token"]))
    return observations


def captured_table_observations(tables: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    raw_tables = [
        {
            "rows": [
                [cell.get("raw_text") for cell in row]
                for row in table.get("rows", [])
            ]
        }
        for table in tables
    ]
    return raw_table_observations(raw_tables)


def observation_tokens(observations: dict[str, list[dict[str, Any]]], key: str) -> list[str]:
    return sorted(item["numeric_token"] for item in observations.get(key, []))


def observation_raw_values(observations: dict[str, list[dict[str, Any]]], key: str) -> list[Any]:
    return [item["raw_value"] for item in observations.get(key, [])]


def observation_bbox(observations: list[dict[str, Any]]) -> list[float] | None:
    boxes = [
        item.get("cell_bbox") or item.get("table_bbox")
        for item in observations
        if item.get("cell_bbox") or item.get("table_bbox")
    ]
    if not boxes:
        return None
    return [
        min(float(box[0]) for box in boxes),
        min(float(box[1]) for box in boxes),
        max(float(box[2]) for box in boxes),
        max(float(box[3]) for box in boxes),
    ]


def build_conflict_manifest(
    *,
    document: dict[str, Any],
    surface: dict[str, Any],
    passes: list[dict[str, Any]],
) -> dict[str, Any]:
    first = raw_table_observations(passes[0].get("tables", []))
    second = raw_table_observations(passes[1].get("tables", []))
    native = captured_table_observations([
        table
        for table in document.get("tables", [])
        if table.get("surface_id") == surface.get("surface_id")
        and table.get("authority_role") != "discovery_only"
    ])
    conflicts = []
    for key in sorted(set(first) | set(second)):
        left = observation_tokens(first, key)
        right = observation_tokens(second, key)
        if left == right:
            continue
        native_values = observation_tokens(native, key)
        auto_source = None
        if native_values and native_values == left and native_values != right:
            auto_source = "pass1_native_corroborated"
        elif native_values and native_values == right and native_values != left:
            auto_source = "pass2_native_corroborated"
        conflict_id = "bvc-" + hashlib.sha256(
            f"{document['document_id']}|{surface['surface_id']}|{key}".encode("utf-8")
        ).hexdigest()[:24]
        conflicts.append({
            "conflict_id": conflict_id,
            "observation_key": key,
            "pass1_values": left,
            "pass2_values": right,
            "native_values": native_values,
            "pass1_raw_values": observation_raw_values(first, key),
            "pass2_raw_values": observation_raw_values(second, key),
            "native_raw_values": observation_raw_values(native, key),
            "auto_resolution_source": auto_source,
            "requires_targeted_adjudication": auto_source is None,
            "target_bbox": observation_bbox([*first.get(key, []), *second.get(key, [])]),
        })
    payload = {
        "schema_version": "broker-vision-conflict-manifest/1.0",
        "document_id": document["document_id"],
        "surface_id": surface["surface_id"],
        "pass1_sha256": canonical_hash(passes[0]),
        "pass2_sha256": canonical_hash(passes[1]),
        "structural_disagreement": canonical(comparable_response(passes[0])) != canonical(comparable_response(passes[1])),
        "conflicts": conflicts,
    }
    payload["manifest_sha256"] = canonical_hash(payload)
    return payload


def response_richness(result: dict[str, Any]) -> tuple[int, int, int, str]:
    observations = raw_table_observations(result.get("tables", []))
    nonblank = sum(
        1
        for table in result.get("tables", [])
        for row in table.get("rows", [])
        for value in row
        if str(value or "").strip()
    )
    bboxes = sum(1 for table in result.get("tables", []) if table.get("bbox"))
    return (len(observations), nonblank, bboxes, canonical_hash(result))


def validate_resolution(
    resolution: dict[str, Any],
    manifest: dict[str, Any],
) -> tuple[bool, dict[str, dict[str, Any]], str | None]:
    if resolution.get("conflict_manifest_sha256") != manifest.get("manifest_sha256"):
        return False, {}, "The reviewed resolution is not bound to the exact conflict manifest."
    decisions = resolution.get("conflict_decisions")
    if not isinstance(decisions, list):
        return False, {}, "The reviewed resolution has no conflict_decisions ledger."
    by_id: dict[str, dict[str, Any]] = {}
    for item in decisions:
        conflict_id = item.get("conflict_id")
        if not isinstance(conflict_id, str) or conflict_id in by_id:
            return False, {}, "The reviewed resolution contains an absent or duplicate conflict_id."
        if item.get("status") not in {"resolved", "quarantined"}:
            return False, {}, f"Conflict {conflict_id} has no terminal decision."
        if item.get("status") == "resolved" and item.get("chosen_source") not in {
            "pass1", "pass2", "native", "targeted_adjudication"
        }:
            return False, {}, f"Conflict {conflict_id} has no permitted chosen_source."
        if not str(item.get("rationale") or "").strip():
            return False, {}, f"Conflict {conflict_id} has no adjudication rationale."
        by_id[conflict_id] = item
    expected = {
        item["conflict_id"]
        for item in manifest.get("conflicts", [])
        if item.get("requires_targeted_adjudication", True)
    }
    if set(by_id) != expected:
        return False, {}, "The reviewed resolution does not disposition every targeted conflict exactly once."
    conflicts = {item["conflict_id"]: item for item in manifest.get("conflicts", [])}
    for conflict_id, item in by_id.items():
        if item.get("status") == "resolved":
            chosen = item.get("chosen_source")
            if chosen == "targeted_adjudication":
                values = item.get("resolved_values")
            else:
                values = conflicts[conflict_id].get(f"{chosen}_raw_values")
            if not isinstance(values, list) or not values:
                return False, {}, f"Conflict {conflict_id} has no resolved economic value."
            item["resolved_values"] = values
    return True, by_id, None


def automatic_conflict_decisions(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    decisions: dict[str, dict[str, Any]] = {}
    for conflict in manifest.get("conflicts", []):
        source = conflict.get("auto_resolution_source")
        if not source:
            continue
        chosen = "pass1" if source.startswith("pass1") else "pass2"
        decisions[conflict["conflict_id"]] = {
            "conflict_id": conflict["conflict_id"],
            "status": "resolved",
            "chosen_source": chosen,
            "resolved_values": list(conflict.get(f"{chosen}_raw_values") or []),
            "rationale": "The native extraction independently corroborates this visual read.",
        }
    return decisions


def bounded_quarantine_decisions(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Terminally preserve only conflicts that lack independent corroboration."""
    return {
        item["conflict_id"]: {
            "conflict_id": item["conflict_id"],
            "status": "quarantined",
            "rationale": (
                "Bounded targeted reconciliation was exhausted; preserve the "
                "disputed source cell and prohibit model consumption."
            ),
        }
        for item in manifest.get("conflicts", [])
        if item.get("requires_targeted_adjudication", True)
    }


def numeric_token(value: Any) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not NUMERIC_RE.fullmatch(text):
        return None
    negative = text.startswith("(") and text.endswith(")")
    suffix = "%" if "%" in text else ("x" if text.lower().endswith("x") else "")
    cleaned = re.sub(r"[$€£¥,%xX() ]", "", text)
    try:
        number = float(cleaned)
    except ValueError:
        return text
    if negative:
        number = -abs(number)
    base = str(int(number)) if number.is_integer() else format(number, ".15g")
    return base + suffix


def make_cell(
    value: Any,
    row: int,
    column: int,
    source_ref: str,
    bbox: Any = None,
    *,
    authority_status: str | None = None,
    authority_basis: str | None = None,
    conflict_id: str | None = None,
) -> dict[str, Any]:
    if value is None:
        kind = "blank"
    elif isinstance(value, bool):
        kind = "boolean"
    elif isinstance(value, (int, float)):
        kind = "number"
    else:
        kind = "text"
    return {
        "row": row,
        "column": column,
        "raw_text": None if value is None else str(value),
        "value": value,
        "value_kind": kind,
        "number_format": None,
        "formula": None,
        "bbox": bbox,
        "source_ref": source_ref,
        "confidence": 1.0,
        **({"authority_status": authority_status} if authority_status else {}),
        **({"authority_basis": authority_basis} if authority_basis else {}),
        **({"conflict_id": conflict_id} if conflict_id else {}),
    }


def accepted_tables(
    result: dict[str, Any],
    surface_id: str,
    source_name: str,
    *,
    default_authority_status: str,
    default_authority_basis: str,
    conflict_manifest: dict[str, Any] | None = None,
    conflict_decisions: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    resolution_observations = raw_table_observations(result.get("tables", []))
    conflict_by_position: dict[tuple[int, int, int], tuple[str, dict[str, Any]]] = {}
    if conflict_manifest and conflict_decisions:
        for conflict in conflict_manifest.get("conflicts", []):
            conflict_id = conflict["conflict_id"]
            decision = conflict_decisions[conflict_id]
            positions = resolution_observations.get(conflict["observation_key"], [])
            for ordinal, item in enumerate(positions):
                decision_for_position = dict(decision)
                if decision.get("status") == "resolved":
                    values = decision.get("resolved_values") or []
                    if ordinal < len(values):
                        decision_for_position["resolved_value"] = values[ordinal]
                conflict_by_position[(item["table_index"], item["row"], item["column"])] = (
                    conflict_id,
                    decision_for_position,
                )
    compiled = []
    for table_index, raw_table in enumerate(result.get("tables", []), start=1):
        table_id = f"{surface_id}.vision-t{table_index}"
        rows = []
        cell_bboxes = raw_table.get("cell_bboxes") or []
        for row_index, raw_row in enumerate(raw_table.get("rows", []), start=1):
            cells = []
            for column_index, value in enumerate(raw_row, start=1):
                conflict = conflict_by_position.get((table_index, row_index, column_index))
                if conflict:
                    conflict_id, decision = conflict
                    status = (
                        "quarantined_conflict"
                        if decision["status"] == "quarantined"
                        else "verified_adjudicated"
                    )
                    basis = decision.get("chosen_source") or "unresolved_after_targeted_adjudication"
                    if decision["status"] == "resolved" and "resolved_value" in decision:
                        value = decision["resolved_value"]
                else:
                    conflict_id = None
                    status = default_authority_status
                    basis = default_authority_basis
                cells.append(make_cell(
                    value,
                    row_index,
                    column_index,
                    f"{source_name}#{surface_id};vision-table={table_index};r={row_index};c={column_index}",
                    cell_bboxes[row_index - 1][column_index - 1]
                    if row_index <= len(cell_bboxes) and column_index <= len(cell_bboxes[row_index - 1]) else None,
                    authority_status=status,
                    authority_basis=basis,
                    conflict_id=conflict_id,
                ))
            rows.append(cells)
        structure = transcription_structure({"rows": rows})
        compiled.append({
            "table_id": table_id,
            "surface_id": surface_id,
            "source_location": f"{surface_id}, vision table {table_index}",
            "title": raw_table.get("title"),
            "units": raw_table.get("units"),
            "transcription_structure": structure,
            # A structureless transcription is retained as evidence and can
            # never be an analytical table: it must not reach the analyst
            # workbook, and a mapped cell on an evidence_only table is already
            # a blocker downstream.
            "workbook_presentation_hint": "analytical_table" if structure["is_grid"] else "evidence_only",
            "footnotes": sorted({
                str(note).strip()
                for note in [*raw_table.get("footnotes", []), *result.get("footnotes", [])]
                if str(note).strip()
            }),
            "bbox": raw_table.get("bbox"),
            "extraction_method": "manual_verified" if result.get("pass_index") == "resolution" else "vision_pass_consensus",
            "authority_role": "rendered_authority",
            "confidence": 1.0,
            "rows": rows,
        })
    return compiled


def transcription_structure(table: dict[str, Any]) -> dict[str, Any]:
    """Report whether a transcribed table is a GRID or merely a bag of numbers.

    Numeric recall cannot certify structure. A single row listing every value
    on a page contains 100% of that page's numbers, and two independent passes
    produce it identically, so every completeness and consensus test we had
    passed a transcription with no row labels and no period headings — which is
    analytically worthless and, worse, indistinguishable in the artifact from a
    real table. Structure is therefore measured directly: a grid has row labels
    down its first populated column and period headings across a row.
    """
    rows = table.get("rows") or []
    labelled_rows = 0
    for row in rows:
        for cell in row:
            text = str((cell.get("raw_text") if isinstance(cell, dict) else cell) or "").strip()
            if not text:
                continue
            if numeric_token(text) is None and not is_period_header(text):
                labelled_rows += 1
            break
    # Deliberately STRICTER than is_period_header, which is permissive by
    # design so it can recognise a heading in a position already known to be a
    # header. Applied to a bag of numbers it produces false positives: the
    # values 44 and 20 both satisfy the bare two-digit year branch, so the very
    # dump this function exists to reject scored as a grid on its first test.
    # A structural claim has to rest on unambiguous evidence, so only a
    # genuinely period-shaped token counts here.
    strict_period = re.compile(
        r"^(?:"
        r"(?:fy|cy)\s*(?:19|20)?\d{2}[eaf]?"
        r"|(?:19|20)\d{2}(?:\s*/\s*\d{2,4})?[eaf]?"
        r"|(?:q[1-4]|[1-4]q|h[12]|[12]h)\s*(?:fy|cy)?\s*(?:19|20)?\d{2}[eaf]?"
        r"|\d{1,2}\s*/\s*\d{2}[eaf]?"
        r"|[a-z]{3,9}[-\s]\d{2,4}[eaf]?"
        r"|ltm|ttm|ntm"
        r")$",
        re.IGNORECASE,
    )
    period_headers = sum(
        1
        for row in rows
        for cell in row
        if strict_period.fullmatch(
            re.sub(r"\s+", " ", str((cell.get("raw_text") if isinstance(cell, dict) else cell) or "").strip())
        )
    )
    max_columns = max((len(row) for row in rows), default=0)
    return {
        "row_labels": labelled_rows,
        "period_headers": period_headers,
        "row_count": len(rows),
        "max_columns": max_columns,
        # A grid needs a header row AND a data row, labels down the side, and
        # unambiguous period headings across the top. A single row can never be
        # a grid however many values it holds. Everything else is retained
        # evidence: never an analytical table, never mappable.
        "is_grid": (
            len(rows) >= 2
            and labelled_rows >= 1
            and period_headers >= 1
            and max_columns >= 2
        ),
    }


def table_numeric_tokens(tables: list[dict[str, Any]]) -> list[str]:
    tokens = []
    for table in tables:
        for row in table["rows"]:
            for cell in row:
                token = numeric_token(cell.get("raw_text"))
                if token is not None:
                    tokens.append(token)
    return tokens


def add_vision_tokens(document: dict[str, Any], tables: list[dict[str, Any]], *, independent_source_tokens: list[str] | None = None,
                      replace_source: bool = False) -> None:
    tokens = table_numeric_tokens(tables)
    if independent_source_tokens is not None:
        if replace_source:
            document["numeric_ledger"]["source_tokens"] = list(independent_source_tokens)
        else:
            document["numeric_ledger"]["source_tokens"].extend(independent_source_tokens)
    document["numeric_ledger"]["captured_tokens"].extend(tokens)
    source = Counter(document["numeric_ledger"]["source_tokens"])
    captured = Counter(document["numeric_ledger"]["captured_tokens"])
    missing = source - captured
    duplicate = captured - source
    document["numeric_ledger"]["missing_tokens"] = sorted(k for k, n in missing.items() for _ in range(n))
    document["numeric_ledger"]["duplicate_tokens"] = sorted(k for k, n in duplicate.items() for _ in range(n))
    count = sum(source.values())
    document["numeric_ledger"]["recall"] = 1.0 if count == 0 else (count - sum(missing.values())) / count


def recompute_ledger(document: dict[str, Any]) -> None:
    document["numeric_ledger"]["source_tokens"] = [
        token
        for surface in document.get("surfaces", [])
        for token in surface.get("source_table_numeric_tokens", [])
    ]
    document["numeric_ledger"]["captured_tokens"] = table_numeric_tokens(document.get("tables", []))
    source = Counter(document["numeric_ledger"].get("source_tokens", []))
    captured = Counter(document["numeric_ledger"]["captured_tokens"])
    missing = source - captured
    duplicate = captured - source
    document["numeric_ledger"]["missing_tokens"] = sorted(token for token, count in missing.items() for _ in range(count))
    document["numeric_ledger"]["duplicate_tokens"] = sorted(token for token, count in duplicate.items() for _ in range(count))
    count = sum(source.values())
    document["numeric_ledger"]["recall"] = 1.0 if count == 0 else (count - sum(missing.values())) / count


def main() -> int:
    assert_vision_schema_contract()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    parser.add_argument("--responses", required=True)
    parser.add_argument(
        "--quarantine-unresolved",
        action="store_true",
        help=(
            "After a prior bounded targeted-resolution attempt, preserve each "
            "still-disputed cell as unavailable evidence instead of returning "
            "another NEEDS_RESOLUTION state."
        ),
    )
    parser.add_argument(
        "--degrade-exhausted",
        action="store_true",
        help=(
            "The bounded attempt budget is exhausted: close the physical lane "
            "DEGRADED. Implies --quarantine-unresolved for disputed cells and "
            "additionally quarantines whole ambiguous surfaces (missing or "
            "disagreeing reads, structureless or empty transcriptions, invalid "
            "resolutions) as preserved evidence with model_use=prohibited. "
            "Integrity failures (missing/hash-mismatched artifacts, non-independent "
            "passes, broken bindings) are never degradable."
        ),
    )
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.degrade_exhausted:
        args.quarantine_unresolved = True
    bundle_path = Path(args.bundle).resolve()
    response_root = Path(args.responses).resolve()
    output_path = Path(args.out).resolve()
    bundle = copy.deepcopy(json.loads(bundle_path.read_text("utf-8")))
    artifact_by_id = {
        artifact["artifact_id"]: (document, artifact)
        for document in bundle["documents"]
        for artifact in document["artifacts"]
    }
    findings = [item for item in bundle.get("findings", []) if item.get("id") != "broker_extraction.vision_required"]
    unresolved = 0
    conflict_manifests: list[dict[str, Any]] = []
    for document in bundle["documents"]:
        for surface in document["surfaces"]:
            if surface["lane_status"]["vision"] != "required":
                continue
            surface_id = surface["surface_id"]
            task_artifact = next(
                (artifact for artifact in document["artifacts"] if artifact["kind"] == "vision_task" and artifact["artifact_id"] in surface["artifact_refs"]),
                None,
            )
            image_artifact = next(
                (artifact for artifact in document["artifacts"] if artifact["kind"] == "page_image" and artifact["artifact_id"] in surface["artifact_refs"]),
                None,
            )
            if not task_artifact or not image_artifact:
                unresolved += 1
                findings.append({"id": "broker_vision.task_or_image_missing", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "The required hash-bound vision task or page image is missing."})
                continue
            artifact_root = Path(str(bundle.get("artifact_root") or bundle_path.parent)).resolve()
            image_path = artifact_root / image_artifact["path"]
            task_path = artifact_root / task_artifact["path"]
            if (
                not image_path.is_file()
                or sha256_file(image_path) != image_artifact["sha256"]
                or not task_path.is_file()
                or sha256_file(task_path) != task_artifact["sha256"]
            ):
                unresolved += 1
                findings.append({"id": "broker_vision.task_or_image_hash_mismatch", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "The vision task or page image is missing or does not match the extraction bundle."})
                continue
            task = json.loads(task_path.read_text("utf-8"))
            if task.get("document_id") != document["document_id"] or task.get("surface_id") != surface_id:
                unresolved += 1
                findings.append({"id": "broker_vision.task_binding_invalid", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "The vision task does not bind the document and surface."})
                continue
            response_base = response_root / surface_id
            pass_paths = [Path(str(response_base) + ".pass1.json"), Path(str(response_base) + ".pass2.json")]
            resolution_path = Path(str(response_base) + ".resolution.json")
            if not all(path.is_file() for path in pass_paths):
                if args.degrade_exhausted:
                    quarantine_surface_evidence_only(
                        bundle=bundle, document=document, surface=surface, findings=findings,
                        reason_id="response_missing_after_exhaustion",
                        message="Two independent vision responses never became available within the bounded budget.",
                    )
                    continue
                unresolved += 1
                findings.append({"id": "broker_vision.response_missing", "severity": "warning", "document_id": document["document_id"], "surface_id": surface_id, "message": "Two independent vision responses are required."})
                continue
            passes = [json.loads(path.read_text("utf-8")) for path in pass_paths]
            valid_binding = all(
                result.get("schema_version") == "broker-vision-result/1.0"
                and result.get("document_id") == document["document_id"]
                and result.get("surface_id") == surface_id
                and result.get("image_sha256") == image_artifact["sha256"]
                and result.get("pass_index") == index
                and str(result.get("producer_id") or "").strip()
                and str(result.get("producer_fingerprint") or "").strip()
                and result.get("method") in {"ocr_geometry", "vision_model", "manual_transcription"}
                for index, result in enumerate(passes, start=1)
            )
            if not valid_binding:
                unresolved += 1
                findings.append({"id": "broker_vision.response_binding_invalid", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "A vision response is not bound to the source image, surface and pass number."})
                continue
            if (
                passes[0]["producer_id"] == passes[1]["producer_id"]
                or passes[0]["producer_fingerprint"] == passes[1]["producer_fingerprint"]
            ):
                unresolved += 1
                findings.append({"id": "broker_vision.passes_not_independent", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "Pass 1 and pass 2 must have distinct producer IDs and execution fingerprints; renaming one producer is not independence."})
                continue
            disposition, disposition_error = classify_surface_disposition(passes)
            if disposition_error and args.degrade_exhausted:
                quarantine_surface_evidence_only(
                    bundle=bundle, document=document, surface=surface, findings=findings,
                    reason_id="surface_disposition_unresolved_after_exhaustion",
                    message="Independent reads never agreed whether the surface is tabular.",
                )
                continue
            if disposition_error:
                unresolved += 1
                findings.append({
                    "id": "broker_vision.surface_disposition_unresolved",
                    "severity": "blocker",
                    "document_id": document["document_id"],
                    "surface_id": surface_id,
                    "message": (
                        "The two reads do not agree on whether this surface contains an analytical table. "
                        "Repeat only this surface once with an explicit analytical_tables or verified_non_tabular disposition."
                    ),
                })
                continue
            if disposition == "verified_non_tabular":
                surface["source_table_numeric_tokens"] = []
                surface["vision_disposition"] = "verified_non_tabular"
                surface["vision_non_tabular_reasons"] = [
                    str(result.get("non_tabular_reason")).strip()
                    for result in passes
                ]
                surface["lane_status"]["vision"] = "complete"
                surface["vision_reason"] = None
                surface["vision_conflict_summary"] = {
                    "conflict_count": 0,
                    "quarantined_conflict_count": 0,
                    "resolved_conflict_count": 0,
                }
                for region in surface.get("uncovered_numeric_regions", []):
                    if region.get("material"):
                        region["disposition"] = "verified_non_tabular"
                bind_final_surface_census(
                    bundle=bundle,
                    document=document,
                    surface=surface,
                )
                findings.append({
                    "id": "broker_vision.verified_non_tabular",
                    "severity": "warning",
                    "document_id": document["document_id"],
                    "surface_id": surface_id,
                    "message": (
                        "Two independent reads classified the material numeric surface as non-tabular. "
                        "Its whole-surface census remains sealed as evidence and contributes no model-eligible table."
                    ),
                })
                continue
            conflict_manifest = None
            conflict_decisions = None
            if canonical(comparable_response(passes[0])) == canonical(comparable_response(passes[1])):
                accepted = passes[0]
                default_authority_status = "verified_dual_read"
                default_authority_basis = "two_pass_visual_consensus"
            else:
                conflict_manifest = build_conflict_manifest(
                    document=document,
                    surface=surface,
                    passes=passes,
                )
                # Whole-response equality is intentionally not the economic
                # boundary. If the displayed row/period/value observations are
                # identical, deterministically retain the richer transcription
                # and record the structural difference as non-blocking.
                if not conflict_manifest["conflicts"]:
                    accepted = max(passes, key=response_richness)
                    default_authority_status = "verified_dual_read"
                    default_authority_basis = "economic_consensus_structural_difference"
                    findings.append({
                        "id": "broker_vision.structural_disagreement_resolved",
                        "severity": "warning",
                        "document_id": document["document_id"],
                        "surface_id": surface_id,
                        "message": "Independent reads differed only in layout, caption, footnote or segmentation; displayed economic observations agree.",
                    })
                else:
                    automatic_decisions = automatic_conflict_decisions(conflict_manifest)
                    targeted_conflicts = [
                        item for item in conflict_manifest["conflicts"]
                        if item.get("requires_targeted_adjudication", True)
                    ]
                    if not targeted_conflicts:
                        accepted = max(passes, key=response_richness)
                        conflict_decisions = automatic_decisions
                        default_authority_status = "verified_adjudicated"
                        default_authority_basis = "native_corroborated_visual_read"
                        conflict_manifests.append(conflict_manifest)
                    elif resolution_path.is_file():
                        resolution = json.loads(resolution_path.read_text("utf-8"))
                        valid_resolution = (
                            resolution.get("schema_version") in {"broker-vision-result/1.0", "broker-vision-result/1.1"}
                            and resolution.get("document_id") == document["document_id"]
                            and resolution.get("surface_id") == surface_id
                            and resolution.get("image_sha256") == image_artifact["sha256"]
                            and resolution.get("pass_index") == "resolution"
                            and str(resolution.get("producer_id") or "").strip()
                            and resolution.get("method") == "reviewed_resolution"
                            and str(resolution.get("review_note") or "").strip()
                        )
                        decisions_ok, reviewed_decisions, decision_error = validate_resolution(
                            resolution,
                            conflict_manifest,
                        )
                        if (not valid_resolution or not decisions_ok) and args.degrade_exhausted:
                            accepted = max(passes, key=response_richness)
                            conflict_decisions = {
                                **automatic_decisions,
                                **bounded_quarantine_decisions(conflict_manifest),
                            }
                            default_authority_status = "verified_adjudicated"
                            default_authority_basis = "bounded_conflict_quarantine"
                            conflict_manifests.append(conflict_manifest)
                            findings.append({
                                "id": "broker_vision.conflict_quarantined_after_bounded_recovery",
                                "severity": "warning",
                                "document_id": document["document_id"],
                                "surface_id": surface_id,
                                "message": (
                                    "The supplied discrepancy resolution was invalid after the bounded "
                                    "budget; the disputed cells are preserved as unavailable evidence."
                                ),
                            })
                        elif not valid_resolution or not decisions_ok:
                            unresolved += 1
                            findings.append({
                                "id": "broker_vision.resolution_invalid",
                                "severity": "blocker",
                                "document_id": document["document_id"],
                                "surface_id": surface_id,
                                "message": decision_error or "The discrepancy resolution is missing its image binding or review note.",
                            })
                            continue
                        else:
                            accepted = max(passes, key=response_richness)
                            conflict_decisions = {**automatic_decisions, **reviewed_decisions}
                            default_authority_status = "verified_adjudicated"
                            default_authority_basis = "targeted_conflict_adjudication"
                            conflict_manifests.append(conflict_manifest)
                    elif args.quarantine_unresolved:
                        accepted = max(passes, key=response_richness)
                        conflict_decisions = {
                            **automatic_decisions,
                            **bounded_quarantine_decisions(conflict_manifest),
                        }
                        default_authority_status = "verified_adjudicated"
                        default_authority_basis = "bounded_conflict_quarantine"
                        conflict_manifests.append(conflict_manifest)
                        findings.append({
                            "id": "broker_vision.conflict_quarantined_after_bounded_recovery",
                            "severity": "warning",
                            "document_id": document["document_id"],
                            "surface_id": surface_id,
                            "message": (
                                f"{len(targeted_conflicts)} unresolved displayed cell(s) were "
                                "preserved as unavailable evidence after bounded recovery. All "
                                "other verified cells and tables remain eligible."
                            ),
                        })
                    else:
                        unresolved += 1
                        conflict_manifests.append(conflict_manifest)
                        findings.append({
                            "id": "broker_vision.pass_disagreement",
                            "severity": "blocker",
                            "document_id": document["document_id"],
                            "surface_id": surface_id,
                            "message": (
                                f"{len(targeted_conflicts)} displayed economic conflict(s) require one bounded targeted adjudication. "
                                "This is an internal NEEDS_RESOLUTION state, not a request for replacement source files."
                            ),
                        })
                        continue
            new_tables = accepted_tables(
                accepted,
                surface_id,
                document["file_name"],
                default_authority_status=default_authority_status,
                default_authority_basis=default_authority_basis,
                conflict_manifest=conflict_manifest,
                conflict_decisions=conflict_decisions,
            )
            material_surface = surface.get("kind") == "image_page" or any(
                region.get("material") for region in surface.get("uncovered_numeric_regions", [])
            )
            if material_surface and not new_tables:
                if args.degrade_exhausted:
                    quarantine_surface_evidence_only(
                        bundle=bundle, document=document, surface=surface, findings=findings,
                        reason_id="vacuous_consensus_after_exhaustion",
                        message="Both transcriptions stayed empty for a material surface.",
                    )
                    continue
                unresolved += 1
                findings.append({"id": "broker_vision.vacuous_consensus", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "Two empty transcriptions cannot certify a material image or uncovered numeric region."})
                continue
            if any(not table.get("rows") or not any(any(str(cell.get("raw_text") or "").strip() for cell in row) for row in table["rows"]) for table in new_tables):
                if args.degrade_exhausted:
                    quarantine_surface_evidence_only(
                        bundle=bundle, document=document, surface=surface, findings=findings,
                        reason_id="empty_table_after_exhaustion",
                        message="A transcribed table stayed empty across the bounded budget.",
                    )
                    continue
                unresolved += 1
                findings.append({"id": "broker_vision.empty_table", "severity": "blocker", "document_id": document["document_id"], "surface_id": surface_id, "message": "A vision table is empty and cannot certify source coverage."})
                continue
            # A page whose ONLY output is structureless is an extraction
            # failure wearing a transcription's clothes: the numbers are all
            # present and none of them means anything. Say so by name, at the
            # surface, so the receipt can never present it as broker evidence.
            structureless = [
                table for table in new_tables
                if not (table.get("transcription_structure") or {}).get("is_grid")
            ]
            if structureless and len(structureless) == len(new_tables) and args.degrade_exhausted:
                quarantine_surface_evidence_only(
                    bundle=bundle, document=document, surface=surface, findings=findings,
                    reason_id="structureless_transcription_after_exhaustion",
                    message="Every transcription for this surface lacked row labels or period headings.",
                )
                continue
            if structureless and len(structureless) == len(new_tables):
                unresolved += 1
                findings.append({
                    "id": "broker_vision.structureless_transcription",
                    "severity": "blocker",
                    "document_id": document["document_id"],
                    "surface_id": surface_id,
                    "message": (
                        f"Every transcription for this surface lacks row labels or period headings "
                        f"({len(structureless)} table(s)). The values are retained as evidence but the "
                        "surface yielded no analytical table. Re-read this surface with its row labels "
                        "and period headings, or independently classify it as verified_non_tabular."
                    ),
                })
                continue
            document["tables"].extend(new_tables)
            vision_tokens = table_numeric_tokens(new_tables)
            # A two-pass consensus or hash-bound reviewed resolution is the
            # accepted physical-table denominator. Both original pass digests
            # and every discrepancy remain sealed in the conflict manifest.
            independent_tokens = list(vision_tokens)
            surface["source_table_numeric_tokens"] = list(vision_tokens)
            surface["whole_surface_numeric_token_count"] = len(vision_tokens)
            surface["vision_source_census"] = {
                "source": default_authority_basis,
                "producer_id": accepted["producer_id"],
                "producer_fingerprint": accepted.get("producer_fingerprint") or accepted["producer_id"],
                "image_sha256": image_artifact["sha256"],
                "source_numeric_tokens": list(vision_tokens),
                "newly_owned_numeric_tokens": list(independent_tokens),
                "denominator_scope": "physical_tables_only",
                **({"conflict_manifest_sha256": conflict_manifest["manifest_sha256"]} if conflict_manifest and conflict_manifest["conflicts"] else {}),
            }
            add_vision_tokens(
                document,
                new_tables,
                independent_source_tokens=None,
            )
            surface["table_count"] += len(new_tables)
            surface["lane_status"]["vision"] = "complete"
            surface["vision_disposition"] = "analytical_tables"
            surface["vision_reason"] = None
            surface["vision_conflict_summary"] = {
                "conflict_count": len((conflict_manifest or {}).get("conflicts", [])),
                "quarantined_conflict_count": sum(
                    1
                    for item in (conflict_decisions or {}).values()
                    if item.get("status") == "quarantined"
                ),
                "resolved_conflict_count": sum(
                    1
                    for item in (conflict_decisions or {}).values()
                    if item.get("status") == "resolved"
                ),
            }
            for region in surface.get("uncovered_numeric_regions", []):
                if region.get("material"):
                    region["disposition"] = "covered_by_vision"
            bind_final_surface_census(
                bundle=bundle,
                document=document,
                surface=surface,
            )

        states = {surface["lane_status"]["vision"] for surface in document["surfaces"]}
        document["extraction_status"] = "complete" if "required" not in states and "error" not in states else "needs_vision"

    bundle, canonical_findings = canonicalise_bundle(bundle)
    findings.extend(canonical_findings)
    # The verified bundle is the compatibility boundary consumed by the
    # existing pack compiler.  Expose only reconciled tables there while
    # retaining every contributor in source_table_ids / extraction_methods.
    for document in bundle["documents"]:
        document["tables"] = copy.deepcopy(document.get("canonical_tables", []))
        recompute_ledger(document)
    bundle["candidate_manifest"] = compile_manifest(
        bundle,
        source_bundle_sha256=hashlib.sha256(bundle_path.read_bytes()).hexdigest(),
    )
    findings.extend(bundle["candidate_manifest"].get("findings", []))
    table_count = sum(len(document.get("canonical_tables") or document["tables"]) for document in bundle["documents"])
    cell_count = sum(len(row) for document in bundle["documents"] for table in document["tables"] for row in table["rows"])
    source_count = sum(len(document["numeric_ledger"]["source_tokens"]) for document in bundle["documents"])
    missing_count = sum(len(document["numeric_ledger"]["missing_tokens"]) for document in bundle["documents"])
    duplicate_count = sum(len(document["numeric_ledger"]["duplicate_tokens"]) for document in bundle["documents"])
    bundle["summary"]["document_count"] = len(bundle["documents"])
    bundle["summary"]["surface_count"] = sum(
        len(document.get("surfaces", [])) for document in bundle["documents"]
    )
    bundle["summary"]["table_count"] = table_count
    bundle["summary"]["cell_count"] = cell_count
    bundle["summary"]["numeric_token_count"] = source_count
    bundle["summary"]["native_numeric_recall"] = 1.0 if source_count == 0 else (source_count - missing_count) / source_count
    bundle["summary"]["unresolved_surface_count"] = unresolved
    bundle["summary"]["material_uncovered_region_count"] = material_uncovered_region_count(bundle)
    bundle["summary"]["duplicate_cell_count"] = duplicate_count
    bundle["summary"]["vision_conflict_count"] = sum(
        len(item.get("conflicts", [])) for item in conflict_manifests
    )
    bundle["summary"]["quarantined_conflict_count"] = sum(
        1
        for document in bundle["documents"]
        for table in document.get("tables", [])
        for row in table.get("rows", [])
        for cell in row
        if cell.get("authority_status") == "quarantined_conflict"
    )
    bundle["summary"]["quarantined_surface_count"] = sum(
        1
        for document in bundle["documents"]
        for surface in document.get("surfaces", [])
        if surface.get("vision_disposition") == "quarantined_evidence_only"
    )
    bundle["summary"]["degraded"] = bool(
        bundle["summary"]["quarantined_conflict_count"]
        or bundle["summary"]["quarantined_surface_count"]
    )
    bundle["vision_conflict_manifests"] = conflict_manifests
    bundle["findings"] = findings
    blockers = [item for item in findings if item["severity"] == "blocker"]
    resolution_findings = [
        item for item in findings if item.get("severity") == "needs_resolution"
    ]
    vision_findings = [
        item for item in findings if item.get("severity") == "needs_vision"
    ]
    only_pending_adjudication = bool(blockers) and all(
        item.get("id") == "broker_vision.pass_disagreement" for item in blockers
    )
    bundle["gate_status"] = (
        "NEEDS_RESOLUTION"
        if only_pending_adjudication or resolution_findings
        else "BLOCKED"
        if blockers
        else "NEEDS_VISION"
        if unresolved or vision_findings
        else "PASS"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(bundle, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(json.dumps({"status": bundle["gate_status"], "unresolved_surfaces": unresolved, "tables": table_count, "cells": cell_count}, sort_keys=True))
    return 0 if bundle["gate_status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
