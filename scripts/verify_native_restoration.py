#!/usr/bin/env python3
"""Verify native-Excel control restoration from five saved workbook states.

The workbook states must be saved by Microsoft Excel after the sequence
1 -> 0 -> 1 -> 0 -> 1.  This verifier is deliberately stdlib-only and reads
the calculation caches and formulas from OOXML rather than asking the model
builder to judge its own output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import re
import stat
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple
from xml.etree import ElementTree as ET


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
REL_OFFICE_DOCUMENT = f"{DOC_REL_NS}/officeDocument"
REL_WORKSHEET = f"{DOC_REL_NS}/worksheet"

NATIVE_SCHEMA = "native-excel-restoration-evidence/3.1"
POLICY_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "assets",
    "economic-solve-policy.v1.json",
)
with open(POLICY_PATH, "rb") as _policy_handle:
    _economic_policy_bytes = _policy_handle.read()
ECONOMIC_SOLVE_POLICY = json.loads(_economic_policy_bytes)
_native = ECONOMIC_SOLVE_POLICY["native_tolerances"]
TOLERANCE_POLICY = {
    "currency_abs": float(_native["currency"]),
    "ratio_abs": float(_native["ratio"]),
    "percentage_abs": float(_native["percentage"]),
    "control_abs": float(_native["control"]),
    "default_abs": float(_native["default"]),
    "relative": float(_native["relative"]),
}
ECONOMIC_SOLVE_POLICY_SHA256 = hashlib.sha256(_economic_policy_bytes).hexdigest()
RATIO_ROW_HINT = re.compile(
    r"(?:margin|growth|leverage|coverage|multiple|to_adjusted_ebitda|conversion_pct)",
    re.I,
)
PERCENTAGE_ROW_HINT = re.compile(
    r"(?:rate|yield|spread|coupon|percentage|fraction|tax_rate)",
    re.I,
)


def qname(namespace: str, local: str) -> str:
    return f"{{{namespace}}}{local}"


def resolve_part(source: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(source), target))


def relationship_part(source: str) -> str:
    return posixpath.join(
        posixpath.dirname(source),
        "_rels",
        f"{posixpath.basename(source)}.rels",
    )


def relationships(package: zipfile.ZipFile, source: str) -> Dict[str, Tuple[str, str]]:
    part = "_rels/.rels" if source == "" else relationship_part(source)
    root = ET.fromstring(package.read(part))
    return {
        item.attrib["Id"]: (item.attrib["Type"], item.attrib["Target"])
        for item in root.findall(qname(PKG_REL_NS, "Relationship"))
    }


def office_document_part(package: zipfile.ZipFile) -> str:
    for rel_type, target in relationships(package, "").values():
        if rel_type == REL_OFFICE_DOCUMENT:
            return target.lstrip("/")
    raise ValueError("package has no officeDocument relationship")


@dataclass
class Snapshot:
    path: str
    sha256: str
    values: Dict[str, float]
    formulas: Dict[str, str]
    sheet_names: List[str]
    calculation_settings: Dict[str, str]
    formula_signature: str
    numeric_signature: str
    structure_signature: str


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def hash_json(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def column_number(letters: str) -> int:
    value = 0
    for letter in letters:
        value = value * 26 + ord(letter) - 64
    return value


def column_letters(number: int) -> str:
    output = ""
    while number > 0:
        number, remainder = divmod(number - 1, 26)
        output = chr(65 + remainder) + output
    return output


def shift_shared_formula(text: str, base: str, target: str) -> str:
    base_match = re.match(r"^([A-Z]+)(\d+)$", base)
    target_match = re.match(r"^([A-Z]+)(\d+)$", target)
    if not base_match or not target_match:
        return text
    column_delta = column_number(target_match.group(1)) - column_number(base_match.group(1))
    row_delta = int(target_match.group(2)) - int(base_match.group(2))

    def shift_segment(segment: str) -> str:
        def replacement(match: re.Match[str]) -> str:
            absolute_column, column, absolute_row, row = match.groups()
            shifted_column = column if absolute_column else column_letters(column_number(column) + column_delta)
            shifted_row = int(row) if absolute_row else int(row) + row_delta
            if not shifted_column or shifted_row < 1:
                return match.group(0)
            return "%s%s%s%s" % (absolute_column, shifted_column, absolute_row, shifted_row)

        return re.sub(
            r"(?<![A-Za-z0-9_.!])(\$?)([A-Z]{1,3})(\$?)(\d+)",
            replacement,
            segment,
        )

    # Do not rewrite A1-looking text inside quoted string literals.
    segments = re.split(r'("(?:[^"]|"")*")', text)
    return "".join(segment if index % 2 else shift_segment(segment) for index, segment in enumerate(segments))


def canonical_element(element: ET.Element) -> object:
    return {
        "tag": element.tag,
        "attributes": dict(sorted(element.attrib.items())),
        "text": (element.text or "").strip(),
        "children": [canonical_element(child) for child in list(element)],
    }


def snapshot(path: str) -> Snapshot:
    with open(path, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    with zipfile.ZipFile(path) as package:
        workbook_part = office_document_part(package)
        workbook_root = ET.fromstring(package.read(workbook_part))
        workbook_relationships = relationships(package, workbook_part)
        sheets = []
        for sheet in workbook_root.find(qname(MAIN_NS, "sheets")):
            relationship_id = sheet.attrib.get(qname(DOC_REL_NS, "id"))
            rel_type, target = workbook_relationships.get(
                relationship_id, (None, None)
            )
            if rel_type != REL_WORKSHEET or target is None:
                raise ValueError(
                    f"worksheet {sheet.attrib.get('name')} has no worksheet relationship"
                )
            sheets.append(
                (
                    sheet.attrib["name"],
                    resolve_part(workbook_part, target),
                )
            )
        if not sheets:
            raise ValueError("relationship traversal resolved zero worksheets")

        values: Dict[str, float] = {}
        formulas: Dict[str, str] = {}
        structure_parts: List[object] = []
        for sheet_name, part in sheets:
            root = ET.fromstring(package.read(part))
            shared_masters: Dict[str, Tuple[str, str]] = {}
            pending_shared: List[Tuple[str, str]] = []
            for cell in root.iter(qname(MAIN_NS, "c")):
                address = cell.attrib.get("r")
                if not address:
                    continue
                key = f"{sheet_name}!{address}"
                formula = cell.find(qname(MAIN_NS, "f"))
                if formula is not None:
                    formula_type = formula.attrib.get("t")
                    shared_index = formula.attrib.get("si")
                    if formula_type == "shared" and shared_index is not None:
                        if formula.text:
                            shared_masters[shared_index] = (address, formula.text)
                            formulas[key] = formula.text
                        else:
                            pending_shared.append((key, shared_index))
                    else:
                        formulas[key] = formula.text or ""
                cell_type = cell.attrib.get("t")
                value = cell.find(qname(MAIN_NS, "v"))
                if (
                    value is not None
                    and value.text not in (None, "")
                    and cell_type not in {"s", "inlineStr", "str", "e"}
                ):
                    try:
                        values[key] = float(value.text)
                    except ValueError:
                        pass
            for key, shared_index in pending_shared:
                if shared_index not in shared_masters:
                    formulas[key] = "__UNRESOLVED_SHARED_FORMULA__:%s" % shared_index
                    continue
                base_address, base_formula = shared_masters[shared_index]
                formulas[key] = shift_shared_formula(base_formula, base_address, key.rsplit("!", 1)[1])
            for tag_name in ("conditionalFormatting", "dataValidations"):
                for item in root.findall(qname(MAIN_NS, tag_name)):
                    structure_parts.append({
                        "sheet": sheet_name,
                        "kind": tag_name,
                        "xml": canonical_element(item),
                    })

        styles_target = next(
            (
                target
                for rel_type, target in workbook_relationships.values()
                if rel_type == f"{DOC_REL_NS}/styles"
            ),
            None,
        )
        if styles_target:
            styles_root = ET.fromstring(
                package.read(resolve_part(workbook_part, styles_target))
            )
            differential_styles = styles_root.find(qname(MAIN_NS, "dxfs"))
            if differential_styles is not None:
                structure_parts.append({
                    "sheet": None,
                    "kind": "dxfs",
                    "xml": canonical_element(differential_styles),
                })

        calc_properties = workbook_root.find(qname(MAIN_NS, "calcPr"))
        calculation_settings = (
            {
                key: calc_properties.attrib[key]
                for key in ("calcMode", "iterate", "iterateCount", "iterateDelta")
                if key in calc_properties.attrib
            }
            if calc_properties is not None else {}
        )

    sheet_names = [name for name, _part in sheets]
    return Snapshot(
        path=path,
        sha256=digest,
        values=values,
        formulas=formulas,
        sheet_names=sheet_names,
        calculation_settings=calculation_settings,
        formula_signature=hash_json(formulas),
        numeric_signature=hash_json(values),
        structure_signature=hash_json(structure_parts),
    )


def metric_class(key: str, row_map: dict, control_key: Optional[str]) -> str:
    if key == control_key:
        return "control"
    match = re.match(r"^Operating Model![A-Z]+(\d+)$", key)
    if match:
        row_number = int(match.group(1))
        row_ids = [
            row_id
            for row_id, declared_row in (row_map.get("rows_by_id") or {}).items()
            if int(declared_row) == row_number
        ]
        joined = " ".join(row_ids)
        if PERCENTAGE_ROW_HINT.search(joined):
            return "percentage"
        if RATIO_ROW_HINT.search(joined):
            return "ratio"
        return "currency"
    return "default"


def compare_values(
    left: Snapshot,
    right: Snapshot,
    row_map: dict,
    tolerance_policy: dict,
    control_key: Optional[str] = None,
    exclude: Iterable[str] = (),
) -> dict:
    excluded = set(exclude)
    keys = set(left.values) | set(right.values)
    differences = []
    max_abs_by_class = {name: 0.0 for name in ("currency", "ratio", "percentage", "control", "default")}
    max_rel_by_class = dict(max_abs_by_class)
    for key in sorted(keys):
        if key in excluded:
            continue
        a = left.values.get(key)
        b = right.values.get(key)
        if a is None or b is None:
            differences.append(key)
            continue
        cls = metric_class(key, row_map, control_key)
        absolute = abs(a - b)
        relative = absolute / max(abs(a), abs(b), 1.0)
        max_abs_by_class[cls] = max(max_abs_by_class[cls], absolute)
        max_rel_by_class[cls] = max(max_rel_by_class[cls], relative)
        allowed = max(
            float(tolerance_policy[f"{cls}_abs"]),
            max(abs(a), abs(b)) * float(tolerance_policy["relative"]),
        )
        if absolute > allowed:
            differences.append(key)
    return {
        "differences": differences,
        "max_abs_by_class": max_abs_by_class,
        "max_rel_by_class": max_rel_by_class,
    }


def merge_drift(comparisons: Iterable[dict]) -> dict:
    classes = ("currency", "ratio", "percentage", "control", "default")
    return {
        "max_abs_by_class": {
            cls: max((item["max_abs_by_class"][cls] for item in comparisons), default=0.0)
            for cls in classes
        },
        "max_rel_by_class": {
            cls: max((item["max_rel_by_class"][cls] for item in comparisons), default=0.0)
            for cls in classes
        },
    }


def semantic_cells(
    row_map: dict,
    row_ids: Iterable[str],
    columns: Iterable[str],
) -> List[str]:
    rows = row_map["rows_by_id"]
    return [
        f"Operating Model!{column}{rows[row_id]}"
        for row_id in row_ids
        if row_id in rows
        for column in columns
    ]


def verify_sequence(
    identifier: str,
    files: List[str],
    control_cell: str,
    row_map: dict,
    effect_cells: List[str],
    zero_when_off: List[str],
    tolerance_policy: dict,
    *,
    control_id: Optional[str] = None,
    candidate: Optional[Snapshot] = None,
    evidence_root: Optional[str] = None,
) -> dict:
    semantic_control_id = control_id or identifier
    expected = list(
        ECONOMIC_SOLVE_POLICY.get("controls", {})
        .get(semantic_control_id, {})
        .get("native_sequence", [1, 0, 1, 0, 1])
    )
    if len(files) != len(expected):
        raise ValueError("A native restoration sequence requires exactly five state files.")
    canonical_root = os.path.realpath(evidence_root) if evidence_root else None
    safe_files = []
    for filename in files:
        absolute = os.path.abspath(filename)
        resolved = os.path.realpath(absolute)
        if canonical_root:
            relative = os.path.relpath(resolved, canonical_root)
            if relative == ".." or relative.startswith("..%s" % os.sep) or os.path.isabs(relative):
                raise ValueError("Native state file escapes the evidence root: %s" % filename)
            if os.path.islink(absolute):
                raise ValueError("Native state file may not be a symlink: %s" % filename)
        mode = os.stat(resolved, follow_symlinks=False).st_mode
        if not stat.S_ISREG(mode):
            raise ValueError("Native state is not a regular file: %s" % filename)
        safe_files.append(resolved)
    states = [snapshot(path) for path in safe_files]
    failures = []
    control_key = f"Operating Model!{control_cell}"

    actual_controls = [
        int(value) if value in (0.0, 1.0) else value
        for value in (state.values.get(control_key) for state in states)
    ]
    if actual_controls != expected:
        failures.append(
            f"control sequence is {actual_controls}, expected {expected}"
        )

    reference_formulas = states[0].formulas
    reference_structure = states[0].structure_signature
    for index, state in enumerate(states[1:], start=2):
        if state.formulas != reference_formulas:
            failures.append(f"state {index} formula map differs from state 1")
        if state.sheet_names != states[0].sheet_names:
            failures.append(f"state {index} sheet order differs from state 1")
        if state.calculation_settings != states[0].calculation_settings:
            failures.append(f"state {index} calculation settings differ from state 1")
        if state.structure_signature != reference_structure:
            failures.append(
                f"state {index} conditional-format/data-validation structure differs"
            )

    on_indices = [0, 2, 4]
    off_indices = [1, 3]
    on_comparisons = [
        compare_values(states[on_indices[0]], states[index], row_map, tolerance_policy, control_key)
        for index in on_indices[1:]
    ]
    off_comparisons = [
        compare_values(states[off_indices[0]], states[index], row_map, tolerance_policy, control_key)
        for index in off_indices[1:]
    ]
    for index, comparison in zip(on_indices[1:], on_comparisons):
        differences = comparison["differences"]
        if differences:
            failures.append(
                f"ON state {index + 1} failed restoration in "
                f"{len(differences)} numeric cells"
            )
    for index, comparison in zip(off_indices[1:], off_comparisons):
        differences = comparison["differences"]
        if differences:
            failures.append(
                f"OFF state {index + 1} failed restoration in "
                f"{len(differences)} numeric cells"
            )

    on_off_comparison = compare_values(
        states[0], states[1], row_map, tolerance_policy, control_key,
        exclude=[control_key],
    )
    on_off_differences = on_off_comparison["differences"]
    effect_differences = [
        key
        for key in effect_cells
        if key in on_off_differences
    ]
    declared_effect_cells_present = [
        key for key in effect_cells
        if key in states[0].values or key in states[0].formulas
    ]
    if not declared_effect_cells_present:
        failures.append("no declared effect cell exists in the workbook")
    if not effect_differences:
        failures.append("ON and OFF do not differ in any declared effect cell")

    nonzero_on = [
        key
        for key in zero_when_off
        if abs(states[0].values.get(key, 0.0)) > tolerance_policy["default_abs"]
    ]
    bad_off = [
        key
        for key in zero_when_off
        if abs(states[1].values.get(key, 0.0)) > tolerance_policy["default_abs"]
        or abs(states[3].values.get(key, 0.0)) > tolerance_policy["default_abs"]
    ]
    if zero_when_off and not nonzero_on:
        failures.append("declared kill-switch cells are all zero in the ON state")
    if bad_off:
        failures.append(
            f"{len(bad_off)} declared kill-switch cells remain non-zero when OFF"
        )

    candidate_binding = {
        "status": "NOT_RUN",
        "candidate_workbook_sha256": None,
        "state_1_sha256": states[0].sha256,
        "formula_signature_match": None,
        "structure_signature_match": None,
        "sheet_order_match": None,
        "calculation_settings_match": None,
        "numeric_difference_count": None,
        "candidate_control_value": None,
        "state_1_control_value": actual_controls[0],
        "failures": [],
    }
    if candidate is not None:
        binding_failures = []
        candidate_comparison = compare_values(
            candidate, states[0], row_map, tolerance_policy, control_key
        )
        numeric_differences = candidate_comparison["differences"]
        formula_match = candidate.formulas == states[0].formulas
        structure_match = candidate.structure_signature == states[0].structure_signature
        sheet_match = candidate.sheet_names == states[0].sheet_names
        calculation_match = candidate.calculation_settings == states[0].calculation_settings
        raw_candidate_control = candidate.values.get(control_key)
        candidate_control = (
            int(raw_candidate_control)
            if raw_candidate_control in (0.0, 1.0)
            else raw_candidate_control
        )
        if not formula_match:
            binding_failures.append("state 1 formula map differs from the current candidate")
        if not structure_match:
            binding_failures.append("state 1 conditional-format/data-validation structure differs from the current candidate")
        if not sheet_match:
            binding_failures.append("state 1 sheet order differs from the current candidate")
        if not calculation_match:
            binding_failures.append("state 1 calculation settings differ from the current candidate")
        if numeric_differences:
            binding_failures.append(
                "state 1 differs from the current candidate in %d numeric cells" % len(numeric_differences)
            )
        if candidate_control != 1.0:
            binding_failures.append("current candidate control is not ON")
        if actual_controls[0] != 1:
            binding_failures.append("state 1 control is not ON")
        candidate_binding = {
            "status": "PASS" if not binding_failures else "FAIL",
            "candidate_workbook_sha256": candidate.sha256,
            "state_1_sha256": states[0].sha256,
            "candidate_formula_signature": candidate.formula_signature,
            "state_1_formula_signature": states[0].formula_signature,
            "candidate_structure_signature": candidate.structure_signature,
            "state_1_structure_signature": states[0].structure_signature,
            "formula_signature_match": formula_match,
            "structure_signature_match": structure_match,
            "sheet_order_match": sheet_match,
            "calculation_settings_match": calculation_match,
            "numeric_difference_count": len(numeric_differences),
            "max_observed_drift": merge_drift([candidate_comparison]),
            "candidate_control_value": candidate_control,
            "state_1_control_value": actual_controls[0],
            "failures": binding_failures,
        }
        failures.extend("candidate binding: %s" % item for item in binding_failures)

    formula_cells_compared = len(reference_formulas)
    numeric_cells_compared = len(states[0].values)
    if formula_cells_compared <= 0:
        failures.append("formula comparison visited zero cells")
    if numeric_cells_compared <= 0:
        failures.append("numeric comparison visited zero cells")

    return {
        "id": identifier,
        "control_id": control_id or identifier,
        "economic_solve_policy_sha256": ECONOMIC_SOLVE_POLICY_SHA256,
        "status": "PASS" if not failures else "FAIL",
        "control_cell": control_key,
        "expected_sequence": expected,
        "actual_sequence": actual_controls,
        "tolerance_policy": tolerance_policy,
        "max_observed_drift": merge_drift(
            [*on_comparisons, *off_comparisons, on_off_comparison]
        ),
        "files": [
            {
                "path": os.path.relpath(state.path, canonical_root).replace(os.sep, "/")
                if canonical_root else os.path.basename(state.path),
                "sha256": state.sha256,
            }
            for state in states
        ],
        "formula_cells_compared": formula_cells_compared,
        "numeric_cells_compared": numeric_cells_compared,
        "on_restoration_difference_counts": [len(item["differences"]) for item in on_comparisons],
        "off_restoration_difference_counts": [len(item["differences"]) for item in off_comparisons],
        "on_off_difference_count_excluding_control": len(on_off_differences),
        "declared_effect_cells": len(effect_cells),
        "declared_effect_cells_present": len(declared_effect_cells_present),
        "declared_effect_cells_changed": len(effect_differences),
        "declared_kill_switch_cells": len(zero_when_off),
        "declared_kill_switch_nonzero_on": len(nonzero_on),
        "declared_kill_switch_bad_off": len(bad_off),
        "candidate_binding": candidate_binding,
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--acquisition-row-map", required=True)
    parser.add_argument("--stress-row-map", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--acquisition-workbook",
        required=True,
        help="Exact shipping-path acquisition workbook from which the Excel states were made.",
    )
    parser.add_argument(
        "--stress-workbook",
        required=True,
        help="Exact shipping-path stressed workbook from which the Excel states were made.",
    )
    parser.add_argument(
        "--application",
        required=True,
        choices=["Microsoft Excel for Mac", "Microsoft Excel for Windows"],
    )
    parser.add_argument(
        "--certified-closure-sha256",
        required=True,
        help="Exact final release-closure hash this native evidence certifies.",
    )
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{64}", args.certified_closure_sha256):
        parser.error("--certified-closure-sha256 must be a lowercase SHA-256 digest")

    with open(args.acquisition_row_map, encoding="utf-8") as handle:
        acquisition_map = json.load(handle)
    with open(args.stress_row_map, encoding="utf-8") as handle:
        stress_map = json.load(handle)

    root = os.path.abspath(args.root)
    acquisition_candidate = snapshot(os.path.abspath(args.acquisition_workbook))
    stress_candidate = snapshot(os.path.abspath(args.stress_workbook))
    paths = lambda stem: [
        os.path.join(
            root,
            f"{stem}-{index}-{'on' if value else 'off'}.xlsx",
        )
        for index, value in enumerate([1, 0, 1, 0, 1], start=1)
    ]
    forecast_and_pf = ["J", "K", "L", "S", "T", "U"]
    adjustment_and_pf = ["N", "O", "P", "S", "T", "U"]

    tests = [
        verify_sequence(
            "native-excel-circularity-restoration-acquisition-case",
            paths("circ"),
            "C5",
            acquisition_map,
            semantic_cells(
                acquisition_map,
                [
                    "instrument_interest",
                    "acquisition_interest",
                    "interest_income_schedule",
                    "ending_cash",
                    "ending_rcf",
                ],
                forecast_and_pf,
            ),
            semantic_cells(
                acquisition_map,
                [
                    "instrument_interest",
                    "acquisition_interest",
                    "interest_income_schedule",
                ],
                forecast_and_pf,
            ),
            TOLERANCE_POLICY,
            control_id="circularity",
            candidate=acquisition_candidate,
            evidence_root=root,
        ),
        verify_sequence(
            "native-excel-circularity-restoration-stressed-case",
            paths("stress-circ"),
            "C5",
            stress_map,
            semantic_cells(
                stress_map,
                [
                    "instrument_interest",
                    "acquisition_interest",
                    "interest_income_schedule",
                    "ending_cash",
                    "ending_rcf",
                ],
                forecast_and_pf,
            ),
            semantic_cells(
                stress_map,
                [
                    "instrument_interest",
                    "acquisition_interest",
                    "interest_income_schedule",
                ],
                forecast_and_pf,
            ),
            TOLERANCE_POLICY,
            control_id="circularity",
            candidate=stress_candidate,
            evidence_root=root,
        ),
        verify_sequence(
            "native-excel-maturity-restoration",
            paths("maturity"),
            "C6",
            stress_map,
            semantic_cells(
                stress_map,
                [
                    row_id
                    for row_id in stress_map["rows_by_id"]
                    if row_id.startswith("debt.")
                ]
                + ["ending_cash", "ending_rcf", "gross_debt_excluding_leases"],
                ["J", "K", "L"],
            ),
            [],
            TOLERANCE_POLICY,
            control_id="debt_maturities_roll",
            candidate=stress_candidate,
            evidence_root=root,
        ),
        verify_sequence(
            "native-excel-acquisition-restoration",
            paths("acq"),
            "P4",
            acquisition_map,
            semantic_cells(
                acquisition_map,
                [
                    "acquisition_debt",
                    "total_acquisition_debt",
                    "acquisition_interest",
                    "ending_cash",
                    "ending_rcf",
                ],
                adjustment_and_pf,
            ),
            semantic_cells(
                acquisition_map,
                [
                    "acquisition_debt",
                    "total_acquisition_debt",
                    "acquisition_interest",
                ],
                ["N", "O", "P"],
            ),
            TOLERANCE_POLICY,
            control_id="acquisition",
            candidate=acquisition_candidate,
            evidence_root=root,
        ),
    ]

    method = (
        "Each state was created from the named candidate in native Microsoft Excel, "
        "set to the declared control value, recalculated, and saved as XLSX. The "
        "verifier independently reads OOXML caches and expanded formulas, binds "
        "state 1 back to the exact candidate, and requires repeated ON and OFF "
        "states to restore across every numeric cell without changing formulas, "
        "calculation settings, conditional formatting or data validation."
    )

    def candidate_record(
        profile: str,
        workbook_path: str,
        row_map_path: str,
        selected_tests: List[dict],
        candidate_snapshot: Snapshot,
    ) -> dict:
        solution_path = f"{workbook_path}.solution.json"
        manifest_path = f"{workbook_path}.semantic-manifest.json"
        with open(solution_path, encoding="utf-8") as handle:
            solution = json.load(handle)
        with open(manifest_path, "rb") as handle:
            manifest_bytes = handle.read()
        semantic_manifest = json.loads(manifest_bytes)
        with open(workbook_path, "rb") as handle:
            workbook_bytes = handle.read()
        with open(row_map_path, "rb") as handle:
            row_map_bytes = handle.read()
        return {
            "profile": profile,
            "case_id": solution["case_id"],
            "case_sha256": semantic_manifest["case_sha256"],
            "workbook_sha256": hashlib.sha256(workbook_bytes).hexdigest(),
            "semantic_manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "row_map_sha256": hashlib.sha256(row_map_bytes).hexdigest(),
            "candidate_snapshot": {
                "sheet_names": candidate_snapshot.sheet_names,
                "calculation_settings": candidate_snapshot.calculation_settings,
                "formula_signature": candidate_snapshot.formula_signature,
                "numeric_signature": candidate_snapshot.numeric_signature,
                "structure_signature": candidate_snapshot.structure_signature,
            },
            "tests": selected_tests,
        }

    required_test_ids = [
        "native-excel-circularity-restoration-acquisition-case",
        "native-excel-acquisition-restoration",
        "native-excel-circularity-restoration-stressed-case",
        "native-excel-maturity-restoration",
    ]
    candidates = [
        candidate_record(
            "acquisition",
            os.path.abspath(args.acquisition_workbook),
            os.path.abspath(args.acquisition_row_map),
            [tests[0], tests[3]],
            acquisition_candidate,
        ),
        candidate_record(
            "stressed_liquidity",
            os.path.abspath(args.stress_workbook),
            os.path.abspath(args.stress_row_map),
            [tests[1], tests[2]],
            stress_candidate,
        ),
    ]
    actual_test_ids = [
        test["id"] for candidate in candidates for test in candidate["tests"]
    ]
    matrix_clean = (
        sorted(actual_test_ids) == sorted(required_test_ids)
        and len(actual_test_ids) == len(set(actual_test_ids))
        and all(test["status"] == "PASS" and not test["failures"] for test in tests)
    )
    total_violations = sum(max(1, len(test["failures"])) for test in tests if test["status"] != "PASS")
    report = {
        "schema_version": NATIVE_SCHEMA,
        "status": "PASS" if matrix_clean and total_violations == 0 else "FAIL",
        "diagnostic_only": False,
        "application": args.application,
        "method": method,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_violations": total_violations,
        "certified_closure_sha256": args.certified_closure_sha256,
        "tolerance_policy": TOLERANCE_POLICY,
        "economic_solve_policy_sha256": ECONOMIC_SOLVE_POLICY_SHA256,
        "release_matrix": {
            "status": "PASS" if matrix_clean else "FAIL",
            "required_test_ids": required_test_ids,
            "actual_test_ids": actual_test_ids,
            "candidate_profiles": [candidate["profile"] for candidate in candidates],
        },
        "candidates": candidates,
    }
    report["evidence_sha256"] = hash_json(report)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")
    print(
        f"STATUS={report['status']} tests={len(tests)} "
        f"failures={sum(len(test['failures']) for test in tests)}"
    )
    print(os.path.abspath(args.out))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
