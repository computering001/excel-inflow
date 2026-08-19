#!/usr/bin/env python3
"""P5.4 — plan reconstruction from the emitted .xlsx, and its mutations.

Invariant under test: a workbook's plan can be RECONSTRUCTED from the emitted
.xlsx alone -- independently of the build's own proof contract -- and the
reconstruction compared against the recorded plan; any cell, formula, format,
comment, merge, data validation, conditional format, column width, freeze pane
or calcPr setting present in the file but absent from (or contradicting) the
plan is a typed finding.

Three groups of checks:

  * INDEPENDENCE.  The reconstructor is AST-scanned with the rest of
    `scripts/verify`, its import list is confined to the standard library plus
    openpyxl, and its source is scanned for the NAME of every build-authored
    sidecar.  Then the property is tested rather than asserted: the workbook and
    its recorded plan are copied into an otherwise empty directory -- no proof
    contract, semantic manifest, model IR, row map, forecast receipt or solution
    file within reach -- and the report must come back identical.

  * WITNESS.  The gap this package closes is pinned so it cannot reopen in
    silence: the incumbent reverse verifier still takes its expectation from
    `--contract`, and the only contract any caller passes is the sidecar the
    builder itself writes.  These checks assert the incumbent's shape; they do
    not repair it.

  * MUTATIONS.  One channel at a time is corrupted -- in the .xlsx bytes, in
    the style table, in the comment part, or in the recorded plan -- and the
    expected typed finding must appear.  A mutation that produced no finding
    would mean the channel was decorative.

Subprocess note (the review obligation in `verify/oracle_independence.py`):
this harness invokes production code -- the builder and the renderer -- to
PRODUCE the artifact under test.  It never invokes production code to compute
the expected answer; the expectation is the recorded plan and nothing else.
"""

from __future__ import annotations

import argparse
import ast
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from verify.oracle_independence import production_imports, scan_directory
from verify.plan_reconstruction_oracle import (
    FINDINGS_PER_CODE,
    FORBIDDEN_PRODUCTION_IMPORTS,
    cross_read_with_openpyxl,
    reconstruct_plan,
    verify_workbook,
)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ORACLE = HERE / "verify" / "plan_reconstruction_oracle.py"
INCUMBENT = HERE / "verify" / "workbook_semantic_oracle.py"

DEFAULT_CASES = (
    ROOT / "test-fixtures" / "cases" / "standard-maximal-v2.json",
    ROOT / "test-fixtures" / "cases" / "standard-net-cash-v2.json",
)

# Every sidecar the build writes beside the workbook.  The reconstructor must
# not name any of them: the plan is the only expectation it is allowed.
BUILD_AUTHORED_SIDECARS = (
    "workbook-proof-contract",
    "semantic-manifest",
    "model-ir",
    "row-map",
    "forecast-receipt",
    "transformation-receipt",
    "source-crosswalk",
    "shadow-comparison",
    "solution.json",
    "coverage.json",
)

# The reconstructor's whole permitted import surface.
PERMITTED_ORACLE_IMPORTS = {
    "__future__", "argparse", "hashlib", "json", "re", "sys", "zipfile",
    "pathlib", "xml.etree", "xml.etree.ElementTree",
    "openpyxl", "openpyxl.styles.numbers",
}

checks = 0
failures: list = []


def check(condition: object, message: str) -> None:
    global checks
    if not condition:
        failures.append(message)
        raise AssertionError("PLAN_RECONSTRUCTION_FAIL: " + message)
    checks += 1


def run(command: list, *, env: dict | None = None, timeout: int = 900) -> str:
    completed = subprocess.run(
        command, cwd=str(ROOT), text=True, capture_output=True, timeout=timeout,
        env=env, check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(
            "command failed (%s): %s\n%s\n%s"
            % (completed.returncode, " ".join(command),
               completed.stdout[-4000:], completed.stderr[-4000:])
        )
    return completed.stdout


# ---------------------------------------------------------------------------
# Artifact production
# ---------------------------------------------------------------------------


def build_workbook(case_path: Path, output: Path) -> tuple:
    """Plan-only build, then render.  Production code PRODUCES; it never judges."""
    output.mkdir(parents=True, exist_ok=True)
    source = json.loads(case_path.read_text(encoding="utf-8"))
    # The certified fixtures enter the builder under the reference-parity
    # profile, exactly as the emitted-candidate gate drives them.
    source["execution_profile"] = "reference_parity"
    source.setdefault("controls", {})["broker_case"] = "Model Consensus"
    case = output / "case.json"
    case.write_text(json.dumps(source, indent=2) + "\n", encoding="utf-8")
    workbook = output / "model.xlsx"
    run(["node", str(HERE / "build_dynamic_model.mjs"), str(case),
         "--out", str(workbook), "--plan-only"])
    plan = Path(str(workbook) + ".plan.json")
    run([sys.executable, "-m", "emit", "build", str(plan), "--out", str(workbook)],
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(HERE)})
    return workbook, plan


# ---------------------------------------------------------------------------
# Mutation mechanics: rewrite one part of the package, byte for byte otherwise
# ---------------------------------------------------------------------------


def rewrite_part(source: Path, target: Path, part: str, transform) -> Path:
    changed = False
    with zipfile.ZipFile(source) as incoming:
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as outgoing:
            for info in incoming.infolist():
                data = incoming.read(info.filename)
                if info.filename == part:
                    text = data.decode("utf-8")
                    replacement = transform(text)
                    if replacement != text:
                        changed = True
                    data = replacement.encode("utf-8")
                outgoing.writestr(info, data)
    if not changed:
        raise AssertionError("mutation of %s in %s changed nothing" % (part, source.name))
    return target


def sheet_part(workbook: Path, index: int = 1) -> str:
    return "xl/worksheets/sheet%d.xml" % index


def comment_part(workbook: Path) -> str:
    with zipfile.ZipFile(workbook) as package:
        for name in package.namelist():
            if name.startswith("xl/comments/"):
                return name
    raise AssertionError("no comment part in %s" % workbook.name)


def dominant_custom_number_format(workbook: Path) -> str:
    """The custom format code referenced by the most `cellXfs` entries.

    Mutating an unreferenced format code would change no cell and prove
    nothing, so the target is chosen from what the cells actually use.
    """
    with zipfile.ZipFile(workbook) as package:
        styles = package.read("xl/styles.xml").decode("utf-8")
    codes = dict(re.findall(r'<numFmt numFmtId="(\d+)" formatCode="([^"]*)"/>', styles))
    usage: dict = {}
    for identifier in re.findall(r'<xf numFmtId="(\d+)"', styles):
        if identifier in codes:
            usage[identifier] = usage.get(identifier, 0) + 1
    if not usage:
        raise AssertionError("no custom number format is referenced by any cell style")
    winner = max(sorted(usage), key=lambda key: usage[key])
    return codes[winner]


def report_for(workbook: Path, plan: Path) -> dict:
    return verify_workbook(workbook, plan)


def codes_of(report: dict) -> set:
    return set((report.get("finding_counts") or {}).keys())


# ---------------------------------------------------------------------------
# Group 1 — independence
# ---------------------------------------------------------------------------


def independence_checks() -> None:
    scanned = scan_directory(HERE / "verify", FORBIDDEN_PRODUCTION_IMPORTS)
    check(ORACLE.name in scanned,
          "the reconstructor is not covered by the shared verify independence scan")
    check(scanned[ORACLE.name] == [],
          "the reconstructor imports production modules: %s" % scanned[ORACLE.name])
    check(all(violations == [] for violations in scanned.values()),
          "the verify layer has production imports: %s"
          % {name: value for name, value in scanned.items() if value})
    check(production_imports(ORACLE, FORBIDDEN_PRODUCTION_IMPORTS) == [],
          "direct scan of the reconstructor found production imports")

    tree = ast.parse(ORACLE.read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
    check(imported <= PERMITTED_ORACLE_IMPORTS,
          "the reconstructor imports outside stdlib+openpyxl: %s"
          % sorted(imported - PERMITTED_ORACLE_IMPORTS))

    source = ORACLE.read_text(encoding="utf-8")
    body = source.split('"""', 2)[-1] if source.count('"""') >= 2 else source
    named = [name for name in BUILD_AUTHORED_SIDECARS if name in body]
    check(not named,
          "the reconstructor names build-authored sidecars outside its docstring: %s" % named)


def witness_checks() -> None:
    """Pin the gap this package closes.  These assert the incumbent, not a fix."""
    incumbent = INCUMBENT.read_text(encoding="utf-8")
    check('parser.add_argument("--contract", required=True' in incumbent,
          "the incumbent reverse verifier no longer takes a required --contract; "
          "the witness for this package's gap must be re-stated, not deleted")
    check(incumbent.count("contract.get(") >= 10,
          "the incumbent reverse verifier no longer keys its checks off the supplied contract")

    builder = (HERE / "build_dynamic_model.mjs").read_text(encoding="utf-8")
    check("`${outputPath}.workbook-proof-contract.json`" in builder,
          "the builder no longer writes the proof contract the incumbent consumes")
    check("workbookSemanticProofContract(" in builder,
          "the builder no longer derives the proof contract from production code")

    # Scoped to callers that actually drive the reverse verifier -- other
    # scripts spell `--contract` for the design contract, a different document.
    # File-level, because a caller may put the flag and its value on separate
    # lines (`run_acquisition_portable_workbook_tests.py` does).
    passers = []
    unproven = []
    for path in sorted(HERE.glob("**/*.mjs")) + sorted(HERE.glob("**/*.py")):
        if path in (ORACLE, INCUMBENT) or path.name == Path(__file__).name:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "workbook_semantic_oracle" not in text:
            continue
        if not any("--contract" in line and "add_argument" not in line
                   for line in text.splitlines()):
            continue
        passers.append(path.name)
        if "workbook-proof-contract.json" not in text:
            unproven.append(path.name)
    check(passers,
          "no caller drives the reverse verifier with --contract; the witness "
          "cannot be evaluated")
    check(not unproven,
          "a reverse-verifier caller now supplies something other than the "
          "build-authored proof contract: %s" % unproven)

    check(not (HERE / "extract_plan.mjs").exists(),
          "scripts/extract_plan.mjs now exists; the reconstruction authority must be "
          "reconciled with it rather than duplicated")


# ---------------------------------------------------------------------------
# Group 2 — the clean reconstruction, per fixture
# ---------------------------------------------------------------------------

# Floors, not equalities: a fixture may grow.  A floor that a fixture cannot
# clear means the reconstruction stopped reading a channel.
METRIC_FLOORS = {
    "sheets_compared": 3,
    "cells_compared": 5000,
    "formula_cells": 1200,
    "conditional_format_ranges": 90,
    "data_validations": 8,
    "comments": 90,
    "columns": 30,
    "rows": 150,
}


def clean_checks(workbook: Path, plan: Path, label: str) -> dict:
    report = report_for(workbook, plan)
    check(report["status"] == "PASS",
          "%s: the reconstruction disagrees with the recorded plan: %s"
          % (label, json.dumps(report.get("finding_counts"))))
    for key, floor in sorted(METRIC_FLOORS.items()):
        check(report["metrics"][key] >= floor,
              "%s: %s is %s, below the floor %s -- a channel stopped being read"
              % (label, key, report["metrics"][key], floor))
    check(report["metrics"]["merges"] == 0,
          "%s: this fixture is expected to carry no merges; the merge channel is "
          "exercised by mutation in both directions" % label)
    check(len(report["declared_gaps"]) >= 5,
          "%s: the declared coverage gaps were emptied rather than closed" % label)
    check(report["unrecordable_surfaces"],
          "%s: not one unrecordable surface was reported; silence about content the "
          "plan cannot record is the failure this oracle exists to prevent" % label)

    again = report_for(workbook, plan)
    check(json.dumps(again, sort_keys=True, default=str)
          == json.dumps(report, sort_keys=True, default=str),
          "%s: the reconstruction is not deterministic" % label)
    return report


def sidecar_blindness_check(workbook: Path, plan: Path, scratch: Path,
                            baseline: dict, label: str) -> None:
    """The verdict must not move when every build-authored sidecar is removed."""
    isolated = scratch / "isolated"
    if isolated.exists():
        shutil.rmtree(isolated)
    isolated.mkdir(parents=True)
    shutil.copy2(workbook, isolated / workbook.name)
    shutil.copy2(plan, isolated / plan.name)
    present = sorted(item.name for item in isolated.iterdir())
    check(present == sorted([workbook.name, plan.name]),
          "%s: the isolated directory is not isolated: %s" % (label, present))
    siblings = [item.name for item in plan.parent.iterdir()]
    check(any(any(token in name for token in BUILD_AUTHORED_SIDECARS) for name in siblings),
          "%s: the build wrote no sidecars, so their absence proves nothing" % label)
    report = report_for(isolated / workbook.name, isolated / plan.name)
    check(report["finding_counts"] == baseline["finding_counts"]
          and report["metrics"] == baseline["metrics"]
          and report["status"] == baseline["status"],
          "%s: the verdict changed when the build's sidecars were removed -- the "
          "reconstruction is reading something other than the .xlsx and the plan" % label)


def self_confirmation_negatives(workbook: Path, plan: Path, scratch: Path, label: str) -> None:
    """Handed the build's forward expectation instead of the plan, refuse.

    An oracle that quietly passed when fed the proof contract would be keyed to
    the build's own account of the workbook -- the self-confirmation trap this
    package exists to escape.
    """
    for sidecar, name in (
        (Path(str(workbook) + ".workbook-proof-contract.json"), "proof contract"),
        (Path(str(workbook) + ".model-ir-v3.json"), "model IR"),
        (Path(str(workbook) + ".semantic-manifest.json"), "semantic manifest"),
    ):
        check(sidecar.exists(), "%s: the build did not write the %s" % (label, name))
        report = report_for(workbook, sidecar)
        check(report["status"] != "PASS",
              "%s: the oracle PASSED when handed the %s in place of the plan" % (label, name))
        check("RECON_PLAN_NOT_A_PLAN" in codes_of(report),
              "%s: the %s was not refused as a non-plan; findings were %s"
              % (label, name, sorted(codes_of(report))))

    # A plan stripped of its workbook is refused too, rather than treated as an
    # empty workbook that trivially agrees with nothing.
    hollow = scratch / "hollow-plan.json"
    document = json.loads(plan.read_text(encoding="utf-8"))
    document.pop("workbook", None)
    hollow.write_text(json.dumps(document), encoding="utf-8")
    report = report_for(workbook, hollow)
    check(report["status"] != "PASS", "%s: a plan with no workbook PASSED" % label)


# ---------------------------------------------------------------------------
# Group 3 — mutations
# ---------------------------------------------------------------------------


def _first_formula(text: str) -> str:
    return re.sub(r"<f>([^<]+)</f>", lambda m: "<f>1+%s</f>" % m.group(1), text, count=1)


def _first_cached_number(text: str) -> str:
    def bump(match):
        return "<v>%r</v>" % (float(match.group(1)) + 1.0)
    return re.sub(r"<v>(-?\d+\.\d+)</v>", bump, text, count=1)


def _inject_merge(text: str) -> str:
    return text.replace(
        "</sheetData>",
        '</sheetData><mergeCells count="1"><mergeCell ref="B171:C171"/></mergeCells>',
        1,
    )


def _drop_freeze(text: str) -> str:
    return re.sub(r"<pane [^>]*/>", "", text, count=1)


def _drop_first_validation(text: str) -> str:
    return re.sub(r"<dataValidation .*?</dataValidation>", "", text, count=1, flags=re.S)


def _shrink_first_column(text: str) -> str:
    def shrink(match):
        return '<col width="%s"' % (float(match.group(1)) + 3.0)
    return re.sub(r'<col width="([\d.]+)"', shrink, text, count=1)


def _drop_first_comment(text: str) -> str:
    return re.sub(r"<comment .*?</comment>", "", text, count=1, flags=re.S)


def _tamper_comment_text(text: str) -> str:
    return re.sub(r"<text><t>([^<]*)</t></text>",
                  lambda m: "<text><t>TAMPERED %s</t></text>" % m.group(1),
                  text, count=1)


def _inject_unmapped_element(text: str) -> str:
    return text.replace("</sheetData>", '</sheetData><sheetProtection sheet="1"/>', 1)


def _inject_unmapped_attribute(text: str) -> str:
    return text.replace("<sheetView ", '<sheetView showFormulas="1" ', 1)


def mutation_checks(workbook: Path, plan: Path, scratch: Path, label: str) -> list:
    sheet = sheet_part(workbook)
    comments = comment_part(workbook)
    target_format = dominant_custom_number_format(workbook)
    escaped = re.escape(target_format)

    def alter_number_format(text: str) -> str:
        return re.sub(
            r'(<numFmt numFmtId="\d+" formatCode=")%s("/>)' % escaped,
            # The captured code is still XML-escaped; the injected section must
            # be too, or the mutation would produce an unparseable package and
            # prove a parser error instead of a detection.
            lambda m: m.group(1) + target_format + ";&quot;WRONG&quot;" + m.group(2),
            text, count=1,
        )

    def recolour_first_dxf(text: str) -> str:
        return re.sub(r'(<dxf>.*?<bgColor rgb=")([0-9A-Fa-f]{8})(")',
                      lambda m: m.group(1) + "FF010203" + m.group(3),
                      text, count=1, flags=re.S)

    def alter_calc_iteration(text: str) -> str:
        return re.sub(r'iterateCount="(\d+)"',
                      lambda m: 'iterateCount="%d"' % (int(m.group(1)) + 7),
                      text, count=1)

    file_mutations = [
        ("formula-tampered", sheet, _first_formula, "RECON_FORMULA_MISMATCH"),
        ("cached-value-tampered", sheet, _first_cached_number, "RECON_VALUE_MISMATCH"),
        ("number-format-altered", "xl/styles.xml", alter_number_format,
         "RECON_NUMBER_FORMAT_MISMATCH"),
        ("merge-injected", sheet, _inject_merge, "RECON_MERGE_ABSENT_FROM_PLAN"),
        ("freeze-pane-dropped", sheet, _drop_freeze, "RECON_FREEZE_PANE_MISMATCH"),
        ("data-validation-dropped", sheet, _drop_first_validation,
         "RECON_DATA_VALIDATION_ABSENT_FROM_FILE"),
        ("column-width-altered", sheet, _shrink_first_column, "RECON_COLUMN_MISMATCH"),
        ("conditional-format-dxf-recoloured", "xl/styles.xml", recolour_first_dxf,
         "RECON_CONDITIONAL_FORMAT_RULE_MISMATCH"),
        ("comment-dropped", comments, _drop_first_comment,
         "RECON_COMMENT_ABSENT_FROM_FILE"),
        ("comment-text-tampered", comments, _tamper_comment_text,
         "RECON_COMMENT_TEXT_MISMATCH"),
        ("calc-iteration-altered", "xl/workbook.xml", alter_calc_iteration,
         "RECON_CALC_PROPERTY_MISMATCH"),
        ("unmapped-element-injected", sheet, _inject_unmapped_element,
         "RECON_UNMAPPED_XML_ELEMENT"),
        ("unmapped-attribute-injected", sheet, _inject_unmapped_attribute,
         "RECON_UNMAPPED_XML_ATTRIBUTE"),
    ]

    results = []
    for name, part, transform, expected in file_mutations:
        mutated = scratch / ("mutation-%s.xlsx" % name)
        rewrite_part(workbook, mutated, part, transform)
        report = report_for(mutated, plan)
        caught = expected in codes_of(report)
        results.append({"id": name, "expected_code": expected, "caught": caught,
                        "codes": sorted(codes_of(report))})
        check(caught, "%s: mutation %s was not caught; expected %s, got %s"
              % (label, name, expected, sorted(codes_of(report))))
        check(report["status"] == "FAIL",
              "%s: mutation %s left the report PASSing" % (label, name))

    # The other direction: the plan records something the file does not carry.
    # These fixtures carry no merges, so a "dropped merge" can only be staged by
    # recording one -- which is exactly the plan-side half of the invariant.
    document = json.loads(plan.read_text(encoding="utf-8"))
    plan_mutations = [
        ("merge-dropped-from-file", "RECON_MERGE_ABSENT_FROM_FILE",
         lambda plan_document: plan_document["workbook"]["sheets"][0]
         .__setitem__("merges", ["B171:C171"])),
        ("plan-formula-rewritten", "RECON_FORMULA_MISMATCH", _rewrite_plan_formula),
        ("plan-comment-added", "RECON_COMMENT_ABSENT_FROM_FILE",
         lambda plan_document: plan_document["workbook"]["sheets"][0]["comments"]
         .append({"cell": "B171", "text": "a comment the workbook does not carry"})),
        ("plan-style-recoloured", "RECON_FONT_MISMATCH", _recolour_plan_style),
        ("plan-column-widened", "RECON_COLUMN_MISMATCH", _widen_plan_column),
        ("plan-calc-iteration-altered", "RECON_CALC_PROPERTY_MISMATCH",
         lambda plan_document: plan_document["workbook"]["calc_properties"]
         .__setitem__("iterate_count", 3)),
        ("plan-data-validation-added", "RECON_DATA_VALIDATION_ABSENT_FROM_FILE",
         _add_plan_validation),
    ]
    for name, expected, mutate in plan_mutations:
        mutated_plan = scratch / ("mutation-%s.plan.json" % name)
        candidate = copy.deepcopy(document)
        mutate(candidate)
        check(candidate != document, "%s: plan mutation %s changed nothing" % (label, name))
        mutated_plan.write_text(json.dumps(candidate), encoding="utf-8")
        report = report_for(workbook, mutated_plan)
        caught = expected in codes_of(report)
        results.append({"id": name, "expected_code": expected, "caught": caught,
                        "codes": sorted(codes_of(report))})
        check(caught, "%s: plan mutation %s was not caught; expected %s, got %s"
              % (label, name, expected, sorted(codes_of(report))))

    # A reader bug in the reconstructor itself must not read as a clean workbook:
    # openpyxl cross-reads the same cells and disagreement is a typed finding.
    reconstruction = reconstruct_plan(workbook)
    check(cross_read_with_openpyxl(workbook, reconstruction) == [],
          "%s: the second reader disagrees with the clean reconstruction" % label)
    injured = copy.deepcopy(reconstruction)
    cells = injured["workbook"]["sheets"][0]["cells"]
    victim = sorted(address for address, record in cells.items() if record.get("formula"))[0]
    cells[victim]["formula"] = "1+1"
    disagreements = cross_read_with_openpyxl(workbook, injured)
    check(any(item["code"] == "RECON_READER_DISAGREEMENT" for item in disagreements),
          "%s: a misread formula was not caught by the second reader" % label)
    results.append({"id": "reader-disagreement", "expected_code": "RECON_READER_DISAGREEMENT",
                    "caught": True, "codes": ["RECON_READER_DISAGREEMENT"]})

    # The findings LIST is capped per code; the COUNT never is.  A validator that
    # under-reported its own volume would be weaker than it claims.
    many = scratch / "mutation-many-formulas.xlsx"
    wanted = FINDINGS_PER_CODE + 5
    rewrite_part(workbook, many, sheet, lambda text: re.sub(
        r"<f>([^<]+)</f>", lambda m: "<f>1+%s</f>" % m.group(1), text, count=wanted))
    report = report_for(many, plan)
    check(report["finding_counts"]["RECON_FORMULA_MISMATCH"] == wanted,
          "%s: %d tampered formulas were counted as %s"
          % (label, wanted, report["finding_counts"].get("RECON_FORMULA_MISMATCH")))
    listed = [item for item in report["findings"] if item["code"] == "RECON_FORMULA_MISMATCH"]
    check(len(listed) == FINDINGS_PER_CODE,
          "%s: the per-code findings cap is not honoured (%d listed)" % (label, len(listed)))
    return results


def _rewrite_plan_formula(document: dict) -> None:
    cells = document["workbook"]["sheets"][0]["cells"]
    for address in sorted(cells):
        if cells[address].get("f"):
            cells[address]["f"] = "1+1"
            return
    raise AssertionError("the recorded plan has no formula to rewrite")


def _recolour_plan_style(document: dict) -> None:
    for style in document["workbook"]["styles"]:
        font = style.get("font") or {}
        if font.get("color"):
            font["color"] = "FF010203"
            return
    raise AssertionError("the recorded plan has no coloured font to recolour")


def _widen_plan_column(document: dict) -> None:
    columns = document["workbook"]["sheets"][0]["columns"]
    columns[0] = dict(columns[0])
    columns[0]["width"] = float(columns[0].get("width") or 8) + 5.0


def _add_plan_validation(document: dict) -> None:
    document["workbook"]["sheets"][0]["data_validations"].append({
        "sqref": "B171", "type": "whole", "operator": "between",
        "formula1": "0", "formula2": "1",
        "show_error_message": False, "show_input_message": False,
    })


# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("cases", nargs="*", type=Path, default=list(DEFAULT_CASES))
    parser.add_argument("--out", type=Path,
                        help="scratch directory for built workbooks, mutated copies "
                             "and the receipt (default: a fresh temporary directory)")
    parser.add_argument("--reuse", action="store_true",
                        help="reuse an already-built workbook under --out")
    args = parser.parse_args()
    cases = [Path(case) for case in (args.cases or DEFAULT_CASES)]
    args.out = args.out or Path(tempfile.mkdtemp(prefix="plan-reconstruction-"))
    args.out.mkdir(parents=True, exist_ok=True)

    independence_checks()
    witness_checks()

    receipt = {"fixtures": [], "checks": 0}
    for case in cases:
        label = case.stem
        scratch = args.out / label
        workbook = scratch / "model.xlsx"
        plan = Path(str(workbook) + ".plan.json")
        if not (args.reuse and workbook.exists() and plan.exists()):
            workbook, plan = build_workbook(case, scratch)
        baseline = clean_checks(workbook, plan, label)
        sidecar_blindness_check(workbook, plan, scratch, baseline, label)
        self_confirmation_negatives(workbook, plan, scratch, label)
        mutations = mutation_checks(workbook, plan, scratch, label)
        receipt["fixtures"].append({
            "case": str(case),
            "xlsx_sha256": baseline["xlsx_sha256"],
            "plan_sha256": baseline["plan_sha256"],
            "metrics": baseline["metrics"],
            "reconstructed_aspects": baseline["reconstructed_aspects"],
            "declared_gaps": baseline["declared_gaps"],
            "unrecordable_surfaces": sorted(
                {item["surface"] for item in baseline["unrecordable_surfaces"]}),
            "mutations": mutations,
        })

    receipt["checks"] = checks
    (args.out / "plan-reconstruction-receipt.json").write_text(
        json.dumps(receipt, indent=2, default=str) + "\n", encoding="utf-8")
    sys.stdout.write(json.dumps({"status": "PASS", "checks": checks}) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as error:
        sys.stdout.write(json.dumps({"status": "FAIL", "checks": checks,
                                     "reason": str(error)}) + "\n")
        raise SystemExit(1)
