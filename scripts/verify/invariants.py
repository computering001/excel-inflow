"""Python port of scripts/lib/validation_invariants.mjs.

Only the functions validate_dynamic_model.mjs actually imports are ported:
`embeddedRateLiterals`, `parseCsv`, `sha256`, `validateFiscalPeriods`,
`validateNativeEvidence` and `validateSemanticArtifacts`.  Error records keep
the Node field names verbatim so the two reports diff cleanly.

The Node module is pure arithmetic and rules -- no legacy workbook library -- so this is a
transliteration, not a redesign.  The one deliberate difference is that the
Node module is *also* used by files owned by other agents; this copy is
standalone so nothing here can perturb them.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Dict, List, Optional

APPROVED_MAPPING_METHODS = {
    "exact",
    "renamed",
    "aggregate",
    "split",
    "derived",
    "not_applicable",
}


def canonical(value: Any) -> Any:
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value.keys())}
    return value


def canonical_json(value: Any) -> str:
    """Matches `JSON.stringify(canonical(value))` byte-for-byte for the JSON
    subset these artefacts use (no NaN/Infinity, no undefined)."""
    return json.dumps(canonical(value), separators=(",", ":"), ensure_ascii=False)


def sha256(value) -> str:
    if isinstance(value, (bytes, bytearray)):
        return hashlib.sha256(value).hexdigest()
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def build_native_evidence_bindings(
    *,
    case_id: Any,
    case_sha256: Any,
    workbook_bytes: bytes,
    semantic_manifest_bytes: bytes,
    row_map_bytes: bytes,
) -> Dict[str, Any]:
    return {
        "case_id": case_id,
        "case_sha256": case_sha256,
        "workbook_sha256": sha256(workbook_bytes),
        "semantic_manifest_sha256": sha256(semantic_manifest_bytes),
        "row_map_sha256": sha256(row_map_bytes),
    }


def parse_csv(text: Optional[str]) -> List[Dict[str, str]]:
    rows: List[List[str]] = []
    row: List[str] = []
    cell = ""
    quoted = False
    source = str(text or "")
    if source.startswith("﻿"):
        source = source[1:]
    index = 0
    length = len(source)
    while index < length:
        character = source[index]
        if quoted:
            if character == '"' and index + 1 < length and source[index + 1] == '"':
                cell += '"'
                index += 1
            elif character == '"':
                quoted = False
            else:
                cell += character
        elif character == '"':
            quoted = True
        elif character == ",":
            row.append(cell)
            cell = ""
        elif character == "\n":
            row.append(cell[:-1] if cell.endswith("\r") else cell)
            rows.append(row)
            row = []
            cell = ""
        else:
            cell += character
        index += 1
    if cell or row:
        row.append(cell[:-1] if cell.endswith("\r") else cell)
        rows.append(row)
    non_blank = [item for item in rows if any(value != "" for value in item)]
    if not non_blank:
        return []
    headers = non_blank[0]
    result = []
    for values in non_blank[1:]:
        result.append(
            {
                header: (values[position] if position < len(values) else "")
                for position, header in enumerate(headers)
            }
        )
    return result


def validate_fiscal_periods(model_case: Dict[str, Any]) -> List[Dict[str, Any]]:
    errors: List[Dict[str, Any]] = []
    fiscal_year_end = str((model_case.get("issuer") or {}).get("fiscal_year_end") or "")
    match = re.match(r"^(\d{2})-(\d{2})$", fiscal_year_end)
    if not match:
        return [
            {
                "id": "periods.invalid_fiscal_year_end",
                "message": "issuer.fiscal_year_end must use MM-DD.",
            }
        ]
    expected = "%s-%s" % (match.group(1), match.group(2))
    for index, period in enumerate(model_case.get("periods") or []):
        if str(period.get("date") or "")[5:] != expected:
            errors.append(
                {
                    "id": "periods.fiscal_year_end_mismatch",
                    "period_index": index,
                    "period_date": period.get("date"),
                    "expected_month_day": expected,
                }
            )
    return errors


def validate_semantic_artifacts(manifest, crosswalk_rows) -> List[Dict[str, Any]]:
    errors: List[Dict[str, Any]] = []
    manifest = manifest or {}
    nodes = manifest.get("nodes") or []
    edges = manifest.get("edges") or []
    sources = manifest.get("source_inventory") or []
    node_ids = set()
    semantic_ids = set()
    for node in nodes:
        node_id = node.get("node_id")
        if not node_id or node_id in node_ids:
            errors.append(
                {
                    "id": "manifest.node_id",
                    "node_id": node_id,
                    "message": "Manifest node IDs must be present and unique.",
                }
            )
        node_ids.add(node_id)
        if node.get("node_kind") == "statement_row":
            semantic_id = node.get("semantic_id")
            if not semantic_id or semantic_id in semantic_ids:
                errors.append(
                    {
                        "id": "manifest.semantic_id",
                        "node_id": node_id,
                        "semantic_id": semantic_id,
                        "message": "Statement semantic IDs must be present and unique.",
                    }
                )
            semantic_ids.add(semantic_id)
            if (
                node.get("row_type") in ("calculation", "subtotal")
                and node.get("formula_authority") == "declared_dependency"
                and len(node.get("dependencies") or []) == 0
            ):
                errors.append(
                    {
                        "id": "manifest.calculation_dependencies",
                        "node_id": node_id,
                        "message": "Declared calculation nodes require semantic dependencies.",
                    }
                )
            if node.get("row_type") != "header":
                authorities = node.get("forecast_authorities")
                if not isinstance(authorities, list) or len(authorities) != 3:
                    errors.append(
                        {
                            "id": "manifest.forecast_authorities",
                            "node_id": node_id,
                            "message": "Every non-header statement node requires three period forecast authorities.",
                        }
                    )
                else:
                    for forecast_index, authority in enumerate(authorities):
                        mechanism = authority.get("mechanism") if isinstance(authority, dict) else None
                        method = authority.get("method") if isinstance(authority, dict) else None
                        expected_mechanism = {
                            "schedule_link": "formula",
                            "accounting_identity": "formula",
                            "driver_formula": "formula",
                            "roll_forward": "formula",
                            "broker_consensus": "broker",
                            "actual_plus_remainder": "hardcode",
                            "contractual_commitment": "hardcode",
                            "company_guidance": "hardcode",
                            "company_indication": "hardcode",
                            "user_assumption": "hardcode",
                            "seasonal_run_rate": "hardcode",
                            "historical_average": "hardcode",
                            "historical_trend": "hardcode",
                            "carry_forward": "hardcode",
                            "explicit_zero": "zero",
                            "not_separately_forecast": "uncalculated",
                            "not_applicable": "uncalculated",
                        }.get(method)
                        if (
                            not isinstance(authority, dict)
                            or authority.get("forecast_index") != forecast_index
                            or not authority.get("method")
                            or mechanism not in ("formula", "broker", "hardcode", "zero", "uncalculated")
                        ):
                            errors.append(
                                {
                                    "id": "manifest.forecast_authority_shape",
                                    "node_id": node_id,
                                    "forecast_index": forecast_index,
                                    "authority": authority,
                                }
                            )
                        if expected_mechanism and mechanism != expected_mechanism:
                            errors.append(
                                {
                                    "id": "manifest.forecast_authority_mechanism",
                                    "node_id": node_id,
                                    "forecast_index": forecast_index,
                                    "method": method,
                                    "expected_mechanism": expected_mechanism,
                                    "actual_mechanism": mechanism,
                                }
                            )
                        if isinstance(authority, dict) and method == "unresolved":
                            errors.append(
                                {
                                    "id": "manifest.forecast_authority_unresolved",
                                    "node_id": node_id,
                                    "forecast_index": forecast_index,
                                }
                            )
                        if (
                            isinstance(authority, dict)
                            and authority.get("inferred") is not True
                            and method
                            in (
                                "actual_plus_remainder",
                                "contractual_commitment",
                                "company_guidance",
                                "company_indication",
                            )
                            and (not authority.get("source_id") or not authority.get("as_of_date"))
                        ):
                            errors.append(
                                {
                                    "id": "manifest.forecast_authority_provenance",
                                    "node_id": node_id,
                                    "forecast_index": forecast_index,
                                }
                            )
                        if isinstance(authority, dict) and method == "actual_plus_remainder":
                            partial = authority.get("partial_period") or {}
                            try:
                                reported = float(partial.get("reported_to_date"))
                                remainder = float(partial.get("forecast_remainder"))
                                value = float(authority.get("value"))
                                partial_valid = (
                                    bool(partial.get("reported_through"))
                                    and abs(value - (reported + remainder)) <= 1e-9
                                )
                            except (TypeError, ValueError):
                                partial_valid = False
                            if not partial_valid:
                                errors.append(
                                    {
                                        "id": "manifest.forecast_authority_partial_period",
                                        "node_id": node_id,
                                        "forecast_index": forecast_index,
                                    }
                                )
                        if (
                            isinstance(authority, dict)
                            and method in ("explicit_zero", "not_separately_forecast", "not_applicable")
                            and authority.get("inferred") is not True
                            and not authority.get("note")
                        ):
                            errors.append(
                                {
                                    "id": "manifest.forecast_authority_rationale",
                                    "node_id": node_id,
                                    "forecast_index": forecast_index,
                                    }
                                )
                        if (
                            isinstance(authority, dict)
                            and (
                                node.get("row_type") == "uncalculated"
                                or node.get("formula_authority") == "intentionally_blank"
                            )
                            and mechanism != "uncalculated"
                        ):
                            errors.append(
                                {
                                    "id": "manifest.structural_absence_conflict",
                                    "node_id": node_id,
                                    "forecast_index": forecast_index,
                                    "formula_authority": node.get("formula_authority"),
                                    "row_type": node.get("row_type"),
                                    "actual_mechanism": mechanism,
                                    "message": "A structurally absent forecast row cannot retain a live or zero period authority.",
                                }
                            )
            if (
                node.get("forecast_capture_parent_id")
                and node.get("forecast_capture_parent_id") == node.get("row_id")
            ):
                errors.append(
                    {
                        "id": "manifest.forecast_capture_self_reference",
                        "node_id": node_id,
                    }
                )
        if (
            node.get("movement_type") == "non_cash_debt_movement"
            and node.get("waterfall_stage") != "excluded"
        ):
            errors.append(
                {
                    "id": "manifest.non_cash_debt_in_waterfall",
                    "node_id": node_id,
                    "waterfall_stage": node.get("waterfall_stage"),
                }
            )
        if (
            node.get("movement_type") in ("rcf_draw", "rcf_repayment")
            and node.get("waterfall_stage") != "rcf_balance"
        ):
            errors.append(
                {
                    "id": "manifest.rcf_stage",
                    "node_id": node_id,
                    "waterfall_stage": node.get("waterfall_stage"),
                }
            )
    for edge in [item for item in edges if item.get("edge_type") == "depends_on"]:
        if edge.get("from") not in node_ids or edge.get("to") not in node_ids:
            errors.append(
                {
                    "id": "manifest.unresolved_dependency",
                    "from": edge.get("from"),
                    "to": edge.get("to"),
                }
            )
    source_ids = set()
    crosswalk_by_source: Dict[Any, List[Dict[str, str]]] = {}
    for row in crosswalk_rows or []:
        crosswalk_by_source.setdefault(row.get("source_line_id"), []).append(row)
        if row.get("mapping_method") not in APPROVED_MAPPING_METHODS:
            errors.append(
                {
                    "id": "crosswalk.mapping_method",
                    "source_line_id": row.get("source_line_id"),
                    "mapping_method": row.get("mapping_method"),
                }
            )
    for source in sources:
        source_line_id = source.get("source_line_id")
        if not source_line_id or source_line_id in source_ids:
            errors.append(
                {"id": "manifest.source_id", "source_line_id": source_line_id}
            )
        source_ids.add(source_line_id)
        rows = crosswalk_by_source.get(source_line_id, [])
        resolved = any(row.get("mapping_status") == "resolved" for row in rows)
        documented_exclusion = any(
            row.get("mapping_status") == "documented_exclusion"
            and row.get("mapping_method") == "not_applicable"
            and len(str(row.get("reason") or "").strip()) > 0
            for row in rows
        )
        if source.get("material") and not resolved and not documented_exclusion:
            errors.append(
                {
                    "id": "crosswalk.orphan_material_source",
                    "source_line_id": source_line_id,
                }
            )
        for destination in source.get("mapped_row_ids") or []:
            if not any(
                row.get("destination_row_id") == destination
                and row.get("mapping_status") == "resolved"
                for row in rows
            ):
                errors.append(
                    {
                        "id": "crosswalk.missing_destination",
                        "source_line_id": source_line_id,
                        "destination_row_id": destination,
                    }
                )
    for source_line_id in crosswalk_by_source:
        if source_line_id not in source_ids:
            errors.append(
                {"id": "crosswalk.unknown_source", "source_line_id": source_line_id}
            )
    return errors


_RATE_LITERAL = re.compile(
    r"(?:\*|/|\+|-)\s*\(?\s*(-?(?:\d+(?:\.\d+)?|\.\d+))(?![A-Za-z0-9_])"
)
_MECHANICAL_CONSTANTS = {0.0, 1.0, 2.0, 12.0, 360.0, 365.0, 10000.0}


def embedded_rate_literals(formula) -> List[Dict[str, Any]]:
    text = str(formula or "")
    if text.startswith("="):
        text = text[1:]
    matches = []
    for match in _RATE_LITERAL.finditer(text):
        value = float(match.group(1))
        if abs(value) not in _MECHANICAL_CONSTANTS:
            matches.append({"literal": match.group(1), "index": match.start()})
    return matches


_NATIVE_SCHEMA = "native-excel-restoration-evidence/3.1"
_NATIVE_SEQUENCE = [1, 0, 1, 0, 1]
_NATIVE_TOLERANCE_POLICY = {
    "currency_abs": 1e-6,
    "ratio_abs": 1e-9,
    "percentage_abs": 1e-10,
    "control_abs": 0,
    "default_abs": 1e-9,
    "relative": 1e-12,
}
_NATIVE_DRIFT_CLASSES = ("currency", "ratio", "percentage", "control", "default")
_NATIVE_PROFILE_TESTS = {
    "acquisition": {
        "native-excel-circularity-restoration-acquisition-case": "circularity",
        "native-excel-acquisition-restoration": "acquisition",
    },
    "stressed_liquidity": {
        "native-excel-circularity-restoration-stressed-case": "circularity",
        "native-excel-maturity-restoration": "debt_maturities_roll",
    },
}
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SAFE_STATE_PATH = re.compile(r"^[^/\\]+(?:/[^/\\]+)*$")


def _native_error(errors: List[Dict[str, Any]], identifier: str, **details: Any) -> None:
    errors.append({"id": identifier, **details})


def _valid_hash(value: Any) -> bool:
    return bool(_SHA256.fullmatch(str(value or "")))


def _safe_state_path(value: Any) -> bool:
    text = str(value or "")
    return bool(
        text
        and _SAFE_STATE_PATH.fullmatch(text)
        and not text.startswith("/")
        and all(part not in ("", ".", "..") for part in text.split("/"))
    )


def _exact_int_list(value: Any, expected: List[int]) -> bool:
    return isinstance(value, list) and len(value) == len(expected) and all(
        type(actual) is int and actual == wanted
        for actual, wanted in zip(value, expected)
    )


def _valid_native_drift(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    for channel in ("max_abs_by_class", "max_rel_by_class"):
        classes = value.get(channel)
        if not isinstance(classes, dict):
            return False
        for name in _NATIVE_DRIFT_CLASSES:
            number = classes.get(name)
            if not isinstance(number, (int, float)) or isinstance(number, bool) or number < 0:
                return False
    return True


def validate_native_evidence(evidence, expected) -> List[Dict[str, Any]]:
    """Validate aggregate, hash-bound native-Excel evidence.

    This is intentionally fail-closed.  A PASS label or top-level workbook hash
    is not evidence: both required candidates, all four tests, every repeated
    state, non-vacuous effects, restoration counts and candidate binding must
    be present and internally coherent.
    """

    errors: List[Dict[str, Any]] = []
    evidence = evidence if isinstance(evidence, dict) else {}
    expected = expected if isinstance(expected, dict) else {}

    if evidence.get("schema_version") != _NATIVE_SCHEMA:
        _native_error(
            errors,
            "native.schema_version",
            expected=_NATIVE_SCHEMA,
            actual=evidence.get("schema_version"),
        )
    if evidence.get("status") != "PASS":
        _native_error(errors, "native.status", message="Native evidence must be PASS.")
    if evidence.get("diagnostic_only") is not False:
        _native_error(errors, "native.diagnostic_only")
    if evidence.get("application") not in (
        "Microsoft Excel for Mac",
        "Microsoft Excel for Windows",
    ):
        _native_error(errors, "native.application", actual=evidence.get("application"))
    if not str(evidence.get("method") or "").strip():
        _native_error(errors, "native.method")
    if not re.match(
        r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$",
        str(evidence.get("generated_at") or ""),
    ):
        _native_error(errors, "native.generated_at", actual=evidence.get("generated_at"))
    if type(evidence.get("total_violations")) is not int or evidence.get("total_violations") != 0:
        _native_error(
            errors,
            "native.total_violations",
            actual=evidence.get("total_violations"),
        )
    if not _valid_hash(evidence.get("certified_closure_sha256")):
        _native_error(
            errors,
            "native.certified_closure_sha256",
            actual=evidence.get("certified_closure_sha256"),
        )
    if evidence.get("tolerance_policy") != _NATIVE_TOLERANCE_POLICY:
        _native_error(
            errors,
            "native.tolerance_policy",
            expected=_NATIVE_TOLERANCE_POLICY,
            actual=evidence.get("tolerance_policy"),
        )

    evidence_hash = evidence.get("evidence_sha256")
    hash_body = dict(evidence)
    hash_body.pop("evidence_sha256", None)
    calculated_hash = sha256(canonical_json(hash_body))
    if not _valid_hash(evidence_hash) or evidence_hash != calculated_hash:
        _native_error(
            errors,
            "native.evidence_sha256",
            expected=calculated_hash,
            actual=evidence_hash,
        )

    required_ids = [
        test_id
        for tests in _NATIVE_PROFILE_TESTS.values()
        for test_id in tests
    ]
    matrix = evidence.get("release_matrix")
    if not isinstance(matrix, dict):
        _native_error(errors, "native.release_matrix")
        matrix = {}
    if matrix.get("status") != "PASS":
        _native_error(errors, "native.release_matrix.status")
    if matrix.get("required_test_ids") != required_ids:
        _native_error(
            errors,
            "native.release_matrix.required_test_ids",
            expected=required_ids,
            actual=matrix.get("required_test_ids"),
        )
    if matrix.get("candidate_profiles") != list(_NATIVE_PROFILE_TESTS):
        _native_error(
            errors,
            "native.release_matrix.candidate_profiles",
            expected=list(_NATIVE_PROFILE_TESTS),
            actual=matrix.get("candidate_profiles"),
        )

    candidates = evidence.get("candidates")
    if not isinstance(candidates, list):
        _native_error(errors, "native.candidates")
        candidates = []
    profiles = [candidate.get("profile") for candidate in candidates if isinstance(candidate, dict)]
    if len(candidates) != 2 or profiles != list(_NATIVE_PROFILE_TESTS) or len(set(profiles)) != len(profiles):
        _native_error(
            errors,
            "native.candidate_profiles",
            expected=list(_NATIVE_PROFILE_TESTS),
            actual=profiles,
        )

    all_test_ids: List[Any] = []
    matching_candidates = []
    binding_keys = (
        "case_id",
        "case_sha256",
        "workbook_sha256",
        "semantic_manifest_sha256",
        "row_map_sha256",
    )
    for candidate_index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            _native_error(errors, "native.candidate", candidate_index=candidate_index)
            continue
        profile = candidate.get("profile")
        prefix = "native.candidate.%s" % (profile or candidate_index)
        profile_tests = _NATIVE_PROFILE_TESTS.get(profile)
        if profile_tests is None:
            _native_error(errors, "%s.profile" % prefix, actual=profile)
            profile_tests = {}

        for key in binding_keys:
            value = candidate.get(key)
            valid = bool(str(value or "").strip()) if key == "case_id" else _valid_hash(value)
            if not valid:
                _native_error(errors, "%s.%s" % (prefix, key), actual=value)

        snapshot_record = candidate.get("candidate_snapshot")
        if not isinstance(snapshot_record, dict):
            _native_error(errors, "%s.candidate_snapshot" % prefix)
            snapshot_record = {}
        if not isinstance(snapshot_record.get("sheet_names"), list) or not snapshot_record.get("sheet_names"):
            _native_error(errors, "%s.candidate_snapshot.sheet_names" % prefix)
        if not isinstance(snapshot_record.get("calculation_settings"), dict):
            _native_error(errors, "%s.candidate_snapshot.calculation_settings" % prefix)
        for signature in ("formula_signature", "numeric_signature", "structure_signature"):
            if not _valid_hash(snapshot_record.get(signature)):
                _native_error(errors, "%s.candidate_snapshot.%s" % (prefix, signature))

        tests = candidate.get("tests")
        if not isinstance(tests, list):
            _native_error(errors, "%s.tests" % prefix)
            tests = []
        test_ids = [test.get("id") for test in tests if isinstance(test, dict)]
        all_test_ids.extend(test_ids)
        if len(tests) != len(profile_tests) or test_ids != list(profile_tests):
            _native_error(
                errors,
                "%s.test_ids" % prefix,
                expected=list(profile_tests),
                actual=test_ids,
            )

        for test_index, test in enumerate(tests):
            if not isinstance(test, dict):
                _native_error(errors, "%s.test" % prefix, test_index=test_index)
                continue
            test_id = test.get("id")
            test_prefix = "%s.test.%s" % (prefix, test_id or test_index)
            expected_control = profile_tests.get(test_id)
            if expected_control is None:
                _native_error(errors, "%s.id" % test_prefix, actual=test_id)
            if test.get("control_id") != expected_control:
                _native_error(
                    errors,
                    "%s.control_id" % test_prefix,
                    expected=expected_control,
                    actual=test.get("control_id"),
                )
            if test.get("status") != "PASS":
                _native_error(errors, "%s.status" % test_prefix)
            if test.get("failures") != []:
                _native_error(errors, "%s.failures" % test_prefix, actual=test.get("failures"))
            if not _exact_int_list(test.get("expected_sequence"), _NATIVE_SEQUENCE):
                _native_error(errors, "%s.expected_sequence" % test_prefix)
            if not _exact_int_list(test.get("actual_sequence"), _NATIVE_SEQUENCE):
                _native_error(errors, "%s.actual_sequence" % test_prefix)
            if not str(test.get("control_cell") or "").startswith("Operating Model!"):
                _native_error(errors, "%s.control_cell" % test_prefix)
            if test.get("tolerance_policy") != _NATIVE_TOLERANCE_POLICY:
                _native_error(errors, "%s.tolerance_policy" % test_prefix)
            if not _valid_native_drift(test.get("max_observed_drift")):
                _native_error(errors, "%s.max_observed_drift" % test_prefix)

            files = test.get("files")
            if not isinstance(files, list) or len(files) != 5:
                _native_error(errors, "%s.files" % test_prefix)
                files = []
            paths = []
            hashes = []
            for state_index, state in enumerate(files):
                if not isinstance(state, dict):
                    _native_error(errors, "%s.file" % test_prefix, state_index=state_index)
                    continue
                state_path = state.get("path")
                state_hash = state.get("sha256")
                paths.append(state_path)
                hashes.append(state_hash)
                if not _safe_state_path(state_path):
                    _native_error(errors, "%s.file.path" % test_prefix, actual=state_path)
                if not _valid_hash(state_hash):
                    _native_error(errors, "%s.file.sha256" % test_prefix, actual=state_hash)
            if len(paths) != len(set(paths)):
                _native_error(errors, "%s.file.duplicate_path" % test_prefix)
            if len(set(hashes)) < 2:
                _native_error(errors, "%s.file.insufficient_distinct_sha256" % test_prefix)

            for field in ("formula_cells_compared", "numeric_cells_compared"):
                if type(test.get(field)) is not int or test.get(field) <= 0:
                    _native_error(errors, "%s.%s" % (test_prefix, field), actual=test.get(field))
            for field, expected_counts in (
                ("on_restoration_difference_counts", [0, 0]),
                ("off_restoration_difference_counts", [0]),
            ):
                if not _exact_int_list(test.get(field), expected_counts):
                    _native_error(errors, "%s.%s" % (test_prefix, field), actual=test.get(field))
            for field in ("declared_effect_cells_present", "declared_effect_cells_changed"):
                if type(test.get(field)) is not int or test.get(field) <= 0:
                    _native_error(errors, "%s.%s" % (test_prefix, field), actual=test.get(field))
            declared_effects = test.get("declared_effect_cells")
            effects_present = test.get("declared_effect_cells_present")
            effects_changed = test.get("declared_effect_cells_changed")
            if (
                type(declared_effects) is not int
                or declared_effects <= 0
                or type(effects_present) is not int
                or type(effects_changed) is not int
                or not (0 < effects_changed <= effects_present <= declared_effects)
            ):
                _native_error(errors, "%s.declared_effect_count_consistency" % test_prefix)
            if type(test.get("on_off_difference_count_excluding_control")) is not int or test.get("on_off_difference_count_excluding_control") <= 0:
                _native_error(errors, "%s.on_off_difference_count_excluding_control" % test_prefix)
            elif type(effects_changed) is int and test.get("on_off_difference_count_excluding_control") < effects_changed:
                _native_error(errors, "%s.on_off_difference_count_consistency" % test_prefix)

            if expected_control in ("circularity", "acquisition"):
                if type(test.get("declared_kill_switch_cells")) is not int or test.get("declared_kill_switch_cells") <= 0:
                    _native_error(errors, "%s.declared_kill_switch_cells" % test_prefix)
                if type(test.get("declared_kill_switch_nonzero_on")) is not int or test.get("declared_kill_switch_nonzero_on") <= 0:
                    _native_error(errors, "%s.declared_kill_switch_nonzero_on" % test_prefix)
                elif test.get("declared_kill_switch_nonzero_on") > test.get("declared_kill_switch_cells"):
                    _native_error(errors, "%s.declared_kill_switch_count_consistency" % test_prefix)
            if test.get("declared_kill_switch_bad_off") != 0:
                _native_error(errors, "%s.declared_kill_switch_bad_off" % test_prefix)

            binding = test.get("candidate_binding")
            if not isinstance(binding, dict):
                _native_error(errors, "%s.candidate_binding" % test_prefix)
                binding = {}
            if binding.get("status") != "PASS" or binding.get("failures") != []:
                _native_error(errors, "%s.candidate_binding.status" % test_prefix)
            for field in (
                "formula_signature_match",
                "structure_signature_match",
                "sheet_order_match",
                "calculation_settings_match",
            ):
                if binding.get(field) is not True:
                    _native_error(errors, "%s.candidate_binding.%s" % (test_prefix, field))
            if binding.get("numeric_difference_count") != 0:
                _native_error(errors, "%s.candidate_binding.numeric_difference_count" % test_prefix)
            if not _valid_native_drift(binding.get("max_observed_drift")):
                _native_error(errors, "%s.candidate_binding.max_observed_drift" % test_prefix)
            if binding.get("candidate_control_value") != 1 or binding.get("state_1_control_value") != 1:
                _native_error(errors, "%s.candidate_binding.control_values" % test_prefix)
            if binding.get("candidate_workbook_sha256") != candidate.get("workbook_sha256"):
                _native_error(errors, "%s.candidate_binding.workbook_sha256" % test_prefix)
            for binding_field, snapshot_field in (
                ("candidate_formula_signature", "formula_signature"),
                ("candidate_structure_signature", "structure_signature"),
            ):
                if (
                    not _valid_hash(binding.get(binding_field))
                    or binding.get(binding_field) != snapshot_record.get(snapshot_field)
                ):
                    _native_error(
                        errors,
                        "%s.candidate_binding.%s" % (test_prefix, binding_field),
                    )
            for binding_field in (
                "state_1_formula_signature",
                "state_1_structure_signature",
            ):
                if not _valid_hash(binding.get(binding_field)):
                    _native_error(
                        errors,
                        "%s.candidate_binding.%s" % (test_prefix, binding_field),
                    )
            if binding.get("state_1_formula_signature") != binding.get("candidate_formula_signature"):
                _native_error(errors, "%s.candidate_binding.formula_signature_consistency" % test_prefix)
            if binding.get("state_1_structure_signature") != binding.get("candidate_structure_signature"):
                _native_error(errors, "%s.candidate_binding.structure_signature_consistency" % test_prefix)
            state_one_hash = files[0].get("sha256") if files and isinstance(files[0], dict) else None
            if binding.get("state_1_sha256") != state_one_hash:
                _native_error(errors, "%s.candidate_binding.state_1_sha256" % test_prefix)

        if all(
            expected.get(key) and candidate.get(key) == expected.get(key)
            for key in binding_keys
        ):
            matching_candidates.append(candidate)

    actual_ids = matrix.get("actual_test_ids")
    if actual_ids != all_test_ids or all_test_ids != required_ids or len(set(all_test_ids)) != len(all_test_ids):
        _native_error(
            errors,
            "native.release_matrix.actual_test_ids",
            expected=required_ids,
            actual=actual_ids,
            candidate_tests=all_test_ids,
        )

    missing_expected = [key for key in binding_keys if not expected.get(key)]
    if missing_expected:
        _native_error(errors, "native.expected_bindings", missing=missing_expected)
    if len(matching_candidates) != 1:
        _native_error(
            errors,
            "native.binding.candidate",
            expected={key: expected.get(key) for key in binding_keys},
            matches=len(matching_candidates),
        )
    return errors
