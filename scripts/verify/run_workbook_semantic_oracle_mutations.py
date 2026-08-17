#!/usr/bin/env python3
"""Prove the physical semantic oracle rejects graph corruption.

This is an authoring/release-development harness, not an end-user route. It
mutates disposable copies only and exercises the graph closure itself rather
than cached values, which are covered by the independent finance mutations.
"""

from __future__ import annotations

import argparse
import copy
import json
import posixpath
import re
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from workbook_semantic_oracle import _canonical_sha256, read_workbook, verify


REL_NS = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
MAIN_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
RID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def sheet_part(workbook: Path, sheet_name: str) -> str:
    with zipfile.ZipFile(workbook, "r") as archive:
        book = ET.fromstring(archive.read("xl/workbook.xml"))
        relation_id = None
        for sheet in book.findall("m:sheets/m:sheet", MAIN_NS):
            if sheet.get("name") == sheet_name:
                relation_id = sheet.get(RID)
                break
        if not relation_id:
            raise RuntimeError("sheet %s is absent" % sheet_name)
        relationships = ET.fromstring(
            archive.read("xl/_rels/workbook.xml.rels")
        )
        target = next(
            (
                item.get("Target")
                for item in relationships.findall("r:Relationship", REL_NS)
                if item.get("Id") == relation_id
            ),
            None,
        )
        if not target:
            raise RuntimeError("sheet %s has no relationship target" % sheet_name)
        if target.startswith("/"):
            return target.lstrip("/")
        return posixpath.normpath(posixpath.join("xl", target))


def mutate_formula(
    source: Path,
    destination: Path,
    *,
    part: str,
    address: str,
    transform,
) -> None:
    cell_pattern = re.compile(
        r'(<(?:[A-Za-z_][\w.-]*:)?c\b(?=[^>]*\br="%s")[^>]*>[\s\S]*?'
        r'<(?:[A-Za-z_][\w.-]*:)?f\b[^>]*>)([\s\S]*?)'
        r'(</(?:[A-Za-z_][\w.-]*:)?f>)' % re.escape(address)
    )
    with zipfile.ZipFile(source, "r") as incoming, zipfile.ZipFile(
        destination, "w", compression=zipfile.ZIP_DEFLATED
    ) as outgoing:
        for info in incoming.infolist():
            data = incoming.read(info.filename)
            if info.filename == part:
                text = data.decode("utf-8")
                matches = list(cell_pattern.finditer(text))
                if len(matches) != 1:
                    raise RuntimeError(
                        "expected one formula cell %s, found %d"
                        % (address, len(matches))
                    )

                def changed(match: re.Match) -> str:
                    return "%s%s%s" % (
                        match.group(1),
                        transform(match.group(2)),
                        match.group(3),
                    )

                data = cell_pattern.sub(changed, text, count=1).encode("utf-8")
            outgoing.writestr(info, data)


def remove_formula(
    source: Path,
    destination: Path,
    *,
    part: str,
    address: str,
) -> None:
    """Turn one formula cell into its existing cached literal value."""

    cell_pattern = re.compile(
        r'(<(?:[A-Za-z_][\w.-]*:)?c\b(?=[^>]*\br="%s")[^>]*>[\s\S]*?'
        r'</(?:[A-Za-z_][\w.-]*:)?c>)' % re.escape(address)
    )
    formula_pattern = re.compile(
        r'<(?:[A-Za-z_][\w.-]*:)?f\b[^>]*>[\s\S]*?'
        r'</(?:[A-Za-z_][\w.-]*:)?f>'
    )
    with zipfile.ZipFile(source, "r") as incoming, zipfile.ZipFile(
        destination, "w", compression=zipfile.ZIP_DEFLATED
    ) as outgoing:
        for info in incoming.infolist():
            data = incoming.read(info.filename)
            if info.filename == part:
                text = data.decode("utf-8")
                matches = list(cell_pattern.finditer(text))
                if len(matches) != 1:
                    raise RuntimeError(
                        "expected one cell %s, found %d"
                        % (address, len(matches))
                    )
                cell_text = matches[0].group(1)
                changed_cell, count = formula_pattern.subn("", cell_text, count=1)
                if count != 1:
                    raise RuntimeError("expected %s to contain one formula" % address)
                text = (
                    text[: matches[0].start(1)]
                    + changed_cell
                    + text[matches[0].end(1) :]
                )
                data = text.encode("utf-8")
            outgoing.writestr(info, data)


def run_oracle(workbook: Path, contract: dict, model_ir: dict) -> dict:
    return verify(read_workbook(workbook), contract, model_ir)


def finding_codes(report: dict) -> set[str]:
    return {item.get("code") for item in report.get("findings") or []}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", required=True, type=Path)
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    model_ir_path = Path(str(args.xlsx) + ".model-ir-v3.json")
    model_ir = json.loads(model_ir_path.read_text(encoding="utf-8"))
    physical = contract.get("physical_formula_graph") or {}
    baseline = run_oracle(args.xlsx, contract, model_ir)
    (args.out / "baseline.json").write_text(
        json.dumps(baseline, indent=2) + "\n", encoding="utf-8"
    )
    if baseline.get("status") != "PASS":
        raise RuntimeError("clean workbook semantic oracle did not pass")

    mutation_results = []

    corrupted_contract = copy.deepcopy(contract)
    corrupted_contract["physical_formula_graph"]["authorised_dependency_edges"][0][
        "dependency_display_id"
    ] = "mutation.unbound_dependency"
    closure_report = run_oracle(args.xlsx, corrupted_contract, model_ir)
    closure_code = "OOXML_FORMULA_GRAPH_CLOSURE_HASH_MISMATCH"
    mutation_results.append(
        {
            "id": "sealed-graph-closure",
            "expected_code": closure_code,
            "caught": closure_code in finding_codes(closure_report),
        }
    )
    (args.out / "sealed-graph-closure.json").write_text(
        json.dumps(closure_report, indent=2) + "\n", encoding="utf-8"
    )

    resealed_binding_contract = copy.deepcopy(contract)
    resealed_graph = resealed_binding_contract["physical_formula_graph"]
    resealed_graph["model_ir_sha256"] = "0" * 64
    resealed_core = {
        key: resealed_graph[key]
        for key in (
            "statement_sheet",
            "model_ir_sha256",
            "graph_nodes",
            "authorised_dependency_edges",
            "required_formula_paths",
        )
    }
    resealed_graph["closure_sha256"] = _canonical_sha256(resealed_core)
    binding_report = run_oracle(args.xlsx, resealed_binding_contract, model_ir)
    binding_code = "OOXML_FORMULA_GRAPH_MODEL_IR_MISMATCH"
    mutation_results.append(
        {
            "id": "resealed-model-ir-binding",
            "expected_code": binding_code,
            "caught": binding_code in finding_codes(binding_report),
        }
    )
    (args.out / "resealed-model-ir-binding.json").write_text(
        json.dumps(binding_report, indent=2) + "\n", encoding="utf-8"
    )

    requirements = physical.get("required_formula_paths") or []
    prior_path = next(
        item
        for item in requirements
        if item.get("period_relation") == "prior_period"
    )
    dependency_cell = prior_path["dependency_cell"]
    dependency_column, dependency_row = re.fullmatch(
        r"([A-Z]+)([0-9]+)", dependency_cell
    ).groups()
    reference_pattern = re.compile(
        r"(?<![A-Za-z0-9_])\$?%s\$?%s(?![0-9])"
        % (re.escape(dependency_column), dependency_row)
    )
    with tempfile.TemporaryDirectory(prefix="semantic-oracle-mutations-") as temp:
        protected = next(
            item
            for item in contract.get("protected_formula_identities") or []
            if item.get("concept_id") == "cash_from_investing"
        )
        protected_owner = int(protected["owner_row"])
        protected_cell = "J%s" % protected_owner
        statement_part = sheet_part(
            args.xlsx, physical.get("statement_sheet", "Operating Model")
        )

        hardcoded_identity_workbook = Path(temp) / "hardcoded-identity.xlsx"
        remove_formula(
            args.xlsx,
            hardcoded_identity_workbook,
            part=statement_part,
            address=protected_cell,
        )
        hardcoded_identity_report = run_oracle(
            hardcoded_identity_workbook, contract, model_ir
        )
        hardcoded_identity_code = "OOXML_PROTECTED_IDENTITY_FORMULA_REQUIRED"
        mutation_results.append(
            {
                "id": "hardcoded-protected-identity",
                "expected_code": hardcoded_identity_code,
                "caught": hardcoded_identity_code
                in finding_codes(hardcoded_identity_report),
            }
        )
        (args.out / "hardcoded-protected-identity.json").write_text(
            json.dumps(hardcoded_identity_report, indent=2) + "\n",
            encoding="utf-8",
        )

        prior_identity_workbook = Path(temp) / "prior-period-identity.xlsx"
        mutate_formula(
            args.xlsx,
            prior_identity_workbook,
            part=statement_part,
            address=protected_cell,
            transform=lambda _formula: "I%s" % protected_owner,
        )
        prior_identity_report = run_oracle(
            prior_identity_workbook, contract, model_ir
        )
        prior_identity_codes = {
            "OOXML_PROTECTED_IDENTITY_PRIOR_PERIOD",
            "OOXML_PROTECTED_IDENTITY_MEMBER_MISSING",
        }
        mutation_results.append(
            {
                "id": "prior-period-protected-identity",
                "expected_codes": sorted(prior_identity_codes),
                "caught": prior_identity_codes.issubset(
                    finding_codes(prior_identity_report)
                ),
            }
        )
        (args.out / "prior-period-protected-identity.json").write_text(
            json.dumps(prior_identity_report, indent=2) + "\n",
            encoding="utf-8",
        )

        missing_path_workbook = Path(temp) / "missing-path.xlsx"
        mutate_formula(
            args.xlsx,
            missing_path_workbook,
            part=sheet_part(args.xlsx, physical.get("statement_sheet", "Operating Model")),
            address=prior_path["consumer_cell"],
            transform=lambda formula: reference_pattern.sub(
                "%s%s" % (dependency_column, int(dependency_row) + 1),
                formula,
                count=1,
            ),
        )
        missing_path_report = run_oracle(missing_path_workbook, contract, model_ir)
        missing_path_code = "OOXML_FORMULA_GRAPH_PATH_MISSING"
        mutation_results.append(
            {
                "id": "required-formula-path",
                "expected_code": missing_path_code,
                "caught": missing_path_code in finding_codes(missing_path_report),
            }
        )
        (args.out / "required-formula-path.json").write_text(
            json.dumps(missing_path_report, indent=2) + "\n", encoding="utf-8"
        )

        nodes = {
            item["display_id"]: item for item in physical.get("graph_nodes") or []
        }
        adjacency = {identifier: set() for identifier in nodes}
        for edge in physical.get("authorised_dependency_edges") or []:
            adjacency[edge["consumer_display_id"]].add(
                edge["dependency_display_id"]
            )
        consumer_id = prior_path["consumer_display_id"]
        reached = set()
        pending = list(adjacency[consumer_id])
        while pending:
            candidate = pending.pop()
            if candidate in reached:
                continue
            reached.add(candidate)
            pending.extend(adjacency.get(candidate, ()))
        wrong_id = next(
            identifier
            for identifier in sorted(nodes)
            if identifier != consumer_id and identifier not in reached
        )
        consumer_column = re.fullmatch(
            r"([A-Z]+)([0-9]+)", prior_path["consumer_cell"]
        ).group(1)
        wrong_cell = "%s%s" % (consumer_column, nodes[wrong_id]["row"])
        unauthorised_workbook = Path(temp) / "unauthorised-edge.xlsx"
        mutate_formula(
            args.xlsx,
            unauthorised_workbook,
            part=sheet_part(args.xlsx, physical.get("statement_sheet", "Operating Model")),
            address=prior_path["consumer_cell"],
            transform=lambda formula: "%s+0*%s" % (formula, wrong_cell),
        )
        unauthorised_report = run_oracle(unauthorised_workbook, contract, model_ir)
        unauthorised_code = "OOXML_FORMULA_GRAPH_UNAUTHORISED_EDGE"
        mutation_results.append(
            {
                "id": "unauthorised-physical-edge",
                "expected_code": unauthorised_code,
                "caught": unauthorised_code in finding_codes(unauthorised_report),
            }
        )
        (args.out / "unauthorised-physical-edge.json").write_text(
            json.dumps(unauthorised_report, indent=2) + "\n", encoding="utf-8"
        )

        fixed = contract.get("fixed_point_formula_graph") or {}
        control_cell = str(fixed.get("circularity_control_cell") or "").replace(
            "$", ""
        )
        rcf_gate = next(
            item
            for item in fixed.get("zero_when_off_bindings") or []
            if item.get("role") == "rcf_interest"
        )
        gate_address = "J%s" % rcf_gate["rows"][0]
        gate_prefix = "IF($%s$%s=0,0," % re.fullmatch(
            r"([A-Z]+)([0-9]+)", control_cell
        ).groups()
        missing_gate_workbook = Path(temp) / "missing-circularity-gate.xlsx"

        def remove_gate(formula: str) -> str:
            if not formula.startswith(gate_prefix) or not formula.endswith(")"):
                raise RuntimeError(
                    "expected %s to start with %s" % (gate_address, gate_prefix)
                )
            return formula[len(gate_prefix) : -1]

        mutate_formula(
            args.xlsx,
            missing_gate_workbook,
            part=sheet_part(
                args.xlsx, fixed.get("statement_sheet", "Operating Model")
            ),
            address=gate_address,
            transform=remove_gate,
        )
        missing_gate_report = run_oracle(
            missing_gate_workbook, contract, model_ir
        )
        missing_gate_code = "OOXML_FIXED_POINT_GATE_MISSING"
        mutation_results.append(
            {
                "id": "missing-circularity-gate",
                "expected_code": missing_gate_code,
                "caught": missing_gate_code in finding_codes(missing_gate_report),
            }
        )
        (args.out / "missing-circularity-gate.json").write_text(
            json.dumps(missing_gate_report, indent=2) + "\n", encoding="utf-8"
        )

        # Revenue growth and EBITDA margin are display-only leaves in the
        # standard authority. Replacing both formulas with mutual references
        # creates a truly unrelated cycle without perturbing the economic SCC.
        # The physical proof must reject the extra cycle regardless of labels.
        graph_nodes_by_id = {
            item.get("display_id"): item
            for item in physical.get("graph_nodes") or []
        }
        first_leaf = "J%s" % graph_nodes_by_id["revenue_growth"]["row"]
        second_leaf = "J%s" % graph_nodes_by_id["adjusted_ebitda_margin"]["row"]
        first_cycle_workbook = Path(temp) / "unrelated-cycle-first.xlsx"
        unrelated_cycle_workbook = Path(temp) / "unrelated-cycle.xlsx"
        mutate_formula(
            args.xlsx,
            first_cycle_workbook,
            part=sheet_part(
                args.xlsx, fixed.get("statement_sheet", "Operating Model")
            ),
            address=first_leaf,
            transform=lambda _formula: second_leaf,
        )
        mutate_formula(
            first_cycle_workbook,
            unrelated_cycle_workbook,
            part=sheet_part(
                first_cycle_workbook,
                fixed.get("statement_sheet", "Operating Model"),
            ),
            address=second_leaf,
            transform=lambda _formula: first_leaf,
        )
        unrelated_cycle_report = run_oracle(
            unrelated_cycle_workbook, contract, model_ir
        )
        unrelated_cycle_code = "OOXML_FIXED_POINT_UNRELATED_CYCLE"
        mutation_results.append(
            {
                "id": "unrelated-formula-cycle",
                "expected_code": unrelated_cycle_code,
                "caught": unrelated_cycle_code
                in finding_codes(unrelated_cycle_report),
            }
        )
        (args.out / "unrelated-formula-cycle.json").write_text(
            json.dumps(unrelated_cycle_report, indent=2) + "\n",
            encoding="utf-8",
        )

    summary = {
        "schema_version": 1,
        "kind": "workbook_semantic_oracle_mutations",
        "status": (
            "PASS" if all(item["caught"] for item in mutation_results) else "BLOCK"
        ),
        "positive_checks": 1,
        "adversarial_mutations": len(mutation_results),
        "mutations": mutation_results,
    }
    (args.out / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
