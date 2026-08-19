#!/usr/bin/env python3
"""P4.8 -- the independent solver fixed-point oracle, and its mutations.

Invariant under test: the solver's fixed point is INDEPENDENTLY RECOMPUTED --
in a different language, from the case's own declared inputs, without importing
or shelling any production module -- and the recomputation agrees with the
solver within a declared tolerance; the same holds for the revolver draw and
repayment derived from cash need, and for the debt roll-forward derived from
typed states.

Red before the repair
---------------------
`scripts/verify/finance_proof.py` is the incumbent independent finance proof and
it does not recompute any of the three.  It READS the revolver draw
(`:626`) and repayment (`:630`) out of the workbook and checks only
`ending = opening + draw - repayment` (`:652`-`:656`); it READS
`cash_before_rcf` (`:756`) rather than deriving it, so the sweep's input is
taken on trust too; and it evaluates revolver interest and the commitment fee
at the solver's own converged balances (`:698`-`:706`) instead of iterating the
loop, so a converged wrong fixed point reads exactly like a converged right one.
No file in `scripts/verify` mentions `converged`, `iterations`, `residual` or
`convergence_tolerance` at all.  Those absences are PINNED below, so the gap
cannot reopen in silence.

Subprocess note (the review obligation in `verify/oracle_independence.py`):
this harness shells to `build_dynamic_model.mjs`, `python -m emit build` and an
inline `solveCase` driver to PRODUCE the artifacts under test.  Production code
never computes an expected answer here -- every expectation comes from
`verify/solver_fixed_point_oracle.py`, which launches nothing and imports
nothing from the production graph.

Usage:
    python3 scripts/run_solver_fixed_point_oracle_tests.py [--out DIR]
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from verify.oracle_independence import (  # noqa: E402
    imported_modules,
    production_imports,
    scan_directory,
)
from verify.solver_fixed_point_oracle import (  # noqa: E402
    ABS_TOLERANCE,
    FORBIDDEN_PRODUCTION_IMPORTS,
    ORACLE_CONVERGENCE_TOLERANCE,
    ORACLE_VERSION,
    REL_TOLERANCE,
    build_report,
    close_enough,
)

ORACLE = HERE / "verify" / "solver_fixed_point_oracle.py"
FINANCE_PROOF = HERE / "verify" / "finance_proof.py"
VERIFY_DIRECTORY = HERE / "verify"

CERTIFIED_FIXTURES = (
    "standard-maximal-v2",
    "standard-net-cash-v2",
)
# Economics archetypes: read-only fixtures that isolate one schedule or tax
# shape each.  These six are the revolver, PIK, accretion, benchmark-floor and
# minimum-cash shapes the fixed point and the roll-forward turn on.
ARCHETYPES = (
    "pik_only_debt",
    "zero_coupon_accreting_to_par",
    "revolver_fully_drawn_at_open",
    "revolver_undrawn_commitment_fee_only",
    "floating_benchmark_floor_binding",
    "minimum_cash_floor_binding",
)

# The domains the critical-invariant oracle matrix does not carry, and which
# this oracle exists to add.
REQUIRED_DOMAINS = (
    "convergence",
    "rcf_draw_repay",
    "debt_roll_forward",
    "opening_debt",
    "effective_tax_rate",
)

checks = 0
failures: list = []


def check(condition: bool, message: str) -> None:
    global checks
    if not condition:
        failures.append(message)
        raise AssertionError("SOLVER_FIXED_POINT_FAIL: " + message)
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
               completed.stdout[-3000:], completed.stderr[-3000:])
        )
    return completed.stdout


# ---------------------------------------------------------------------------
# Artifact production.  Production code PRODUCES; it never judges.
# ---------------------------------------------------------------------------

SOLVE_DRIVER = """
import fs from 'node:fs';
import { solveCase } from './scripts/lib/solver.mjs';
const modelCase = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
fs.writeFileSync(process.argv[2], JSON.stringify(solveCase(modelCase), null, 1));
"""


def build_certified(name: str, output: Path) -> tuple:
    """Plan-only build then render, exactly as the emitted-candidate gate drives it."""
    output.mkdir(parents=True, exist_ok=True)
    source = json.loads(
        (ROOT / "test-fixtures" / "cases" / ("%s.json" % name)).read_text(encoding="utf-8")
    )
    source["execution_profile"] = "reference_parity"
    source.setdefault("controls", {})["broker_case"] = "Model Consensus"
    case = output / "case.json"
    case.write_text(json.dumps(source, indent=2) + "\n", encoding="utf-8")
    workbook = output / "model.xlsx"
    run(["node", str(HERE / "build_dynamic_model.mjs"), str(case),
         "--out", str(workbook), "--plan-only"])
    run([sys.executable, "-m", "emit", "build", str(workbook) + ".plan.json",
         "--out", str(workbook)],
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(HERE)})
    return case, Path(str(workbook) + ".solution.json"), workbook


def solve_case_file(case_path: Path, output: Path) -> Path:
    solution = output / (case_path.stem + ".solution.json")
    output.mkdir(parents=True, exist_ok=True)
    run(["node", "--input-type=module", "-e", SOLVE_DRIVER,
         str(case_path), str(solution)])
    return solution


# ---------------------------------------------------------------------------
# Mutation mechanics
# ---------------------------------------------------------------------------


def block_of(document: dict) -> dict:
    return document["standalone"] if "standalone" in document else document


def mutate(source: Path, target: Path, transform) -> Path:
    document = json.loads(source.read_text(encoding="utf-8"))
    changed = transform(copy.deepcopy(document))
    check(changed != document, "mutation %s changed nothing" % target.name)
    target.write_text(json.dumps(changed, indent=1) + "\n", encoding="utf-8")
    return target


def report_for(case: Path, solution: Path, workbook: Path | None = None) -> dict:
    return build_report(case, solution, workbook)


def codes(report: dict) -> set:
    return set(report.get("findings_by_code") or {})


# ---------------------------------------------------------------------------
# 1. Independence
# ---------------------------------------------------------------------------


def test_independence(scratch: Path) -> None:
    check(bool(FORBIDDEN_PRODUCTION_IMPORTS),
          "the forbidden production-import list must be non-empty")
    scanned = scan_directory(VERIFY_DIRECTORY, FORBIDDEN_PRODUCTION_IMPORTS)
    check(ORACLE.name in scanned,
          "the new oracle must be inside the shared verify/ independence scan")
    offenders = {name: hits for name, hits in scanned.items() if hits}
    check(not offenders,
          "production imports found in scripts/verify: %r" % offenders)
    check(production_imports(ORACLE, FORBIDDEN_PRODUCTION_IMPORTS) == [],
          "the oracle must import nothing from the production graph")

    # The scan has teeth: an injected production import must be caught.
    injected = scratch / "injected_oracle.py"
    injected.write_text(
        "import solver\n" + ORACLE.read_text(encoding="utf-8"), encoding="utf-8"
    )
    check(production_imports(injected, FORBIDDEN_PRODUCTION_IMPORTS) == ["solver"],
          "the AST scan must catch an injected production import")

    # The whole import surface is enumerated, so the oracle cannot reach
    # production code by subprocess, dynamic import or any other route.  A new
    # import turns this red and forces the addition to be justified.
    allowed = {
        "__future__", "argparse", "calendar", "datetime", "hashlib", "json",
        "math", "sys", "pathlib", "typing", "openpyxl",
    }
    surface = set(imported_modules(ORACLE))
    check(surface <= allowed,
          "the oracle imports outside the standard library plus openpyxl: %r"
          % sorted(surface - allowed))
    for forbidden in ("subprocess", "os", "runpy", "importlib", "ctypes", "socket"):
        check(forbidden not in surface,
              "the oracle must not import %s -- it must not be able to launch or "
              "dynamically load anything" % forbidden)


# ---------------------------------------------------------------------------
# 2. The red proof, pinned so it cannot reopen in silence
# ---------------------------------------------------------------------------


def test_incumbent_does_not_recompute() -> None:
    proof = FINANCE_PROOF.read_text(encoding="utf-8")
    check("finance_proof" in FINANCE_PROOF.name, "the incumbent proof must still exist")
    # It READS the sweep rather than deriving it.
    check('waterfall["rcf_draw_waterfall"]' in proof,
          "the incumbent proof must still READ the revolver draw from the artifact")
    check('waterfall["rcf_repayment_waterfall"]' in proof,
          "the incumbent proof must still READ the revolver repayment from the artifact")
    check('waterfall["cash_before_rcf"]' in proof,
          "the incumbent proof must still READ cash before the revolver")
    # It has no notion of cash NEED: no minimum-cash floor, no surplus/deficit.
    check("minimum_cash" not in proof,
          "if the incumbent proof gained a minimum-cash floor it may now derive the "
          "sweep from cash need, and the two authorities must be reconciled")
    # And no oracle anywhere reads the solver's convergence report.
    unread = ("convergence_tolerance",)
    for token in unread:
        readers = [
            path.name for path in sorted(VERIFY_DIRECTORY.glob("*.py"))
            if path.name != ORACLE.name and token in path.read_text(encoding="utf-8")
        ]
        check(not readers,
              "%s is now read by %r as well; the convergence authority must be "
              "reconciled rather than duplicated" % (token, readers))


# ---------------------------------------------------------------------------
# 3. Clean runs over the corpus
# ---------------------------------------------------------------------------


def assert_clean(report: dict, label: str) -> None:
    check(report["verdict"] == "PASS",
          "%s: expected PASS, got %s with %r"
          % (label, report["verdict"], report.get("findings", [])[:4]))
    check(report["oracle"] == ORACLE_VERSION, "%s: oracle version" % label)
    check(report["comparisons"] > 100,
          "%s: only %d comparisons -- a thin oracle proves little"
          % (label, report["comparisons"]))
    for domain in REQUIRED_DOMAINS:
        check(domain in report["domains"],
              "%s: domain %s absent from the report" % (label, domain))
        if (
            domain == "debt_roll_forward"
            and report["recomputation"]["non_revolver_instrument_count"] == 0
        ):
            # A case whose only instrument IS the revolver has no debt to roll
            # forward.  The domain is reported empty rather than omitted.
            check(report["domains"][domain]["compared"] == 0,
                  "%s: no non-revolver instrument, yet the roll-forward domain "
                  "compared something" % label)
            continue
        check(report["domains"][domain]["compared"] > 0,
              "%s: domain %s compared nothing" % (label, domain))
    check(report["recomputation"]["oracle_residual"] <= ORACLE_CONVERGENCE_TOLERANCE,
          "%s: the oracle's own iteration must converge to %g"
          % (label, ORACLE_CONVERGENCE_TOLERANCE))
    check(report["recomputation"]["oracle_iterations"] >= 1,
          "%s: the oracle reported no iteration at all" % label)
    check(report["solver_convergence"]["converged"] is True,
          "%s: the solver must declare convergence" % label)
    for gap in report["declared_gaps"]:
        check(bool(gap.get("reason")) and bool(gap.get("affected_comparisons")),
              "%s: a declared gap must carry a reason and the comparisons it affects"
              % label)


# ---------------------------------------------------------------------------
# 4. Mutations
# ---------------------------------------------------------------------------


def perturb_first_period(field: str, delta: float):
    def transform(document: dict) -> dict:
        block_of(document)["forecast"][0][field] = (
            float(block_of(document)["forecast"][0][field]) + delta
        )
        return document
    return transform


def mutation_suite(case: Path, solution: Path, workbook: Path | None,
                   scratch: Path, label: str, clean: dict) -> int:
    """Every mutation must be caught, with its expected code, and must leave the
    oracle's expectation digest untouched."""
    caught = 0
    solved = json.loads(solution.read_text(encoding="utf-8"))
    block = block_of(solved)
    period = block["forecast"][0]
    has_rcf = float(period.get("rcf_capacity_native") or 0.0) > 0.0
    has_instruments = bool(period.get("instrument_results"))

    def set_field(field: str, value):
        def transform(document: dict) -> dict:
            block_of(document)["forecast"][0][field] = value
            return document
        return transform

    def break_roll_forward(document: dict) -> dict:
        entry = block_of(document)["forecast"][0]["instrument_results"][0]
        entry["ending_native"] = float(entry["ending_native"]) + 3.5
        return document

    def break_opening(document: dict) -> dict:
        entry = block_of(document)["forecast"][0]["instrument_results"][0]
        entry["opening_native"] = float(entry["opening_native"]) + 11.0
        return document

    def break_typed_state(document: dict) -> dict:
        shadow = block_of(document)["forecast"][0]["typed_states"]["rcf"]["draw"]
        shadow["value"] = float(shadow.get("value") or 0.0) + 9.0
        return document

    def illegal_typed_state(document: dict) -> dict:
        block_of(document)["forecast"][0]["typed_states"]["rcf"]["draw"]["state"] = (
            "reported_number"
        )
        return document

    def both_legs_positive(document: dict) -> dict:
        target = block_of(document)["forecast"][0]
        target["rcf_draw_native"] = 25.0
        target["rcf_repayment_native"] = 25.0
        return document

    def breach_capacity(document: dict) -> dict:
        target = block_of(document)["forecast"][0]
        target["rcf_ending_native"] = float(target["rcf_capacity_native"]) + 50.0
        return document

    def tax_on_a_loss(document: dict) -> dict:
        target = block_of(document)["forecast"][0]
        target["pre_tax_income"] = -100.0
        target["tax"] = 25.0
        return document

    cases: list = [
        # (name, transform, expected code)
        ("ending-cash-perturbed", perturb_first_period("ending_cash", 4.25),
         "SFP_FIXED_POINT_VALUE_MISMATCH"),
        ("ending-cash-perturbed-by-1e-5",
         perturb_first_period("ending_cash", 1e-5),
         "SFP_FIXED_POINT_VALUE_MISMATCH"),
        ("cash-before-rcf-perturbed",
         perturb_first_period("cash_before_rcf", -7.5),
         "SFP_FIXED_POINT_VALUE_MISMATCH"),
        ("interest-income-perturbed",
         perturb_first_period("interest_income", 0.5),
         "SFP_FIXED_POINT_VALUE_MISMATCH"),
        ("tax-charged-on-a-loss", tax_on_a_loss, "SFP_TAX_CHARGE_ON_LOSS"),
        # A revolver-less case types the leg `not_applicable`, so a value
        # planted on it is caught as a state violation rather than a value one.
        ("typed-state-value-perturbed", break_typed_state,
         ("SFP_TYPED_STATE_VALUE_MISMATCH",
          "SFP_TYPED_STATE_UNRESOLVED_WITH_A_VALUE")),
        ("typed-state-illegal", illegal_typed_state, "SFP_TYPED_STATE_ILLEGAL"),
        ("both-revolver-legs-positive", both_legs_positive,
         "SFP_RCF_DRAW_AND_REPAYMENT_BOTH_POSITIVE"),
    ]
    if has_instruments:
        cases.extend([
            ("roll-forward-ending-broken", break_roll_forward,
             "SFP_ROLL_FORWARD_BREAK"),
            ("opening-balance-broken", break_opening,
             "SFP_OPENING_BALANCE_NOT_THE_DECLARED_ONE"),
        ])
    if has_rcf:
        cases.extend([
            ("revolver-draw-contradicts-cash-need",
             perturb_first_period("rcf_draw_native", 60.0),
             "SFP_RCF_DRAW_CONTRADICTS_CASH_NEED"),
            ("revolver-repayment-contradicts-cash-surplus",
             perturb_first_period("rcf_repayment_native", 40.0),
             "SFP_RCF_REPAYMENT_CONTRADICTS_CASH_SURPLUS"),
            ("revolver-capacity-breached", breach_capacity,
             "SFP_RCF_CAPACITY_BREACHED"),
        ])

    for name, transform, expected in cases:
        mutated = mutate(solution, scratch / ("%s.%s.json" % (label, name)), transform)
        report = report_for(case, mutated, workbook)
        check(report["verdict"] == "FAIL",
              "%s/%s: the oracle passed a mutated artifact" % (label, name))
        wanted = (expected,) if isinstance(expected, str) else expected
        check(bool(set(wanted) & codes(report)),
              "%s/%s: expected one of %r, got %r"
              % (label, name, list(wanted), sorted(codes(report))))
        # THE non-self-confirmation property: the expectation set is a function
        # of the case, so mutating the artifact cannot move it.
        check(report["expectation_digest"] == clean["expectation_digest"],
              "%s/%s: the oracle's expectation digest moved with the artifact -- it is "
              "reading the answer" % (label, name))
        check(report["expectation_count"] == clean["expectation_count"],
              "%s/%s: the expectation COUNT moved with the artifact" % (label, name))
        caught += 1

    # Convergence metadata mutations.  These three fields live on the solved
    # BLOCK and no other oracle in scripts/verify reads them at all.
    for name, field, value, expected in (
        ("solver-declares-non-convergence", "converged", False, "SFP_NOT_CONVERGED"),
        ("residual-above-declared-tolerance", "residual", 1.0,
         "SFP_RESIDUAL_ABOVE_DECLARED_TOLERANCE"),
        ("iteration-count-zero", "iterations", 0,
         "SFP_ITERATION_COUNT_NOT_POSITIVE"),
    ):
        document = json.loads(solution.read_text(encoding="utf-8"))
        block_of(document)[field] = value
        mutated = scratch / ("%s.%s.json" % (label, name))
        mutated.write_text(json.dumps(document, indent=1) + "\n", encoding="utf-8")
        report = report_for(case, mutated, workbook)
        check(expected in codes(report),
              "%s/%s: expected %s, got %r"
              % (label, name, expected, sorted(codes(report))))
        check(report["expectation_digest"] == clean["expectation_digest"],
              "%s/%s: expectation digest moved" % (label, name))
        caught += 1

    # An artifact whose every solved number is scaled: the digest must still be
    # byte-identical, and the oracle must report findings rather than adapt.
    document = json.loads(solution.read_text(encoding="utf-8"))
    for entry in block_of(document)["forecast"]:
        for key, value in list(entry.items()):
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                entry[key] = float(value) * 1.01
    scaled = scratch / ("%s.every-value-scaled.json" % label)
    scaled.write_text(json.dumps(document, indent=1) + "\n", encoding="utf-8")
    report = report_for(case, scaled, workbook)
    check(report["verdict"] == "FAIL",
          "%s: a wholly rescaled artifact must fail" % label)
    check(report["expectation_digest"] == clean["expectation_digest"],
          "%s: the expectation digest survived nothing -- the oracle adapts to the "
          "artifact" % label)
    check(report["findings_total"] >= 20,
          "%s: a wholly rescaled artifact produced only %d findings"
          % (label, report["findings_total"]))
    caught += 1
    return caught


# ---------------------------------------------------------------------------
# 5. Refusals -- the vacuous pass must be impossible
# ---------------------------------------------------------------------------


def test_refusals(case: Path, solution: Path, scratch: Path) -> None:
    swapped = report_for(solution, solution)
    check(swapped["verdict"] == "REFUSED" and
          swapped["refusal"]["code"] == "SFP_CASE_NOT_A_CASE",
          "handed a solution in place of a case the oracle must refuse, got %r"
          % swapped.get("refusal"))
    check(swapped["comparisons"] == 0, "a refusal must compare nothing")

    reversed_pair = report_for(case, case)
    check(reversed_pair["verdict"] == "REFUSED" and
          reversed_pair["refusal"]["code"] == "SFP_SOLUTION_NOT_A_SOLUTION",
          "handed a case in place of a solution the oracle must refuse, got %r"
          % reversed_pair.get("refusal"))

    stripped = json.loads(solution.read_text(encoding="utf-8"))
    block_of(stripped).pop("forecast")
    empty = scratch / "solution-without-forecast.json"
    empty.write_text(json.dumps(stripped, indent=1) + "\n", encoding="utf-8")
    report = report_for(case, empty)
    check(report["verdict"] == "REFUSED",
          "a solution with no forecast must be refused, not treated as agreement")

    waterfall = json.loads(case.read_text(encoding="utf-8"))
    waterfall.setdefault("controls", {})["broker_case"] = "Forecast Waterfall"
    routed = scratch / "case-forecast-waterfall.json"
    routed.write_text(json.dumps(waterfall, indent=1) + "\n", encoding="utf-8")
    report = report_for(routed, solution)
    check(report["verdict"] == "REFUSED" and
          report["refusal"]["code"] == "SFP_FORECAST_WATERFALL_AUTHORITY_NOT_DERIVABLE",
          "a case whose drivers come from the forecast waterfall must be refused, "
          "got %r" % report.get("refusal"))


# ---------------------------------------------------------------------------
# 6. Tolerance teeth
# ---------------------------------------------------------------------------


def test_tolerance_is_not_decorative() -> None:
    check(ABS_TOLERANCE == 1e-6 and REL_TOLERANCE == 1e-9,
          "the declared tolerance changed; re-derive its justification before "
          "changing this pin")
    check(ORACLE_CONVERGENCE_TOLERANCE < 1e-8,
          "the oracle must converge tighter than the solver's declared tolerance so "
          "the comparison tolerance is dominated by the solver's own slack")
    # A break ten times the tolerance is caught.
    check(not close_enough(1000.0, 1000.0 + 1e-5),
          "a 1e-5 break at magnitude 1e3 must not be inside tolerance")
    # And the tolerance is not vacuous: a 1e-3 relative allowance would hide it.
    loose = max(1e-6, 1e-3 * 1000.0)
    check(abs(1e-5) < loose,
          "the pin is only meaningful if a 1e-3 relative tolerance WOULD hide the "
          "break the declared tolerance catches")
    # Rounding at the last representable place is not a finding.
    check(close_enough(1e4, 1e4 + 1e-11),
          "an IEEE754 last-place difference must not be reported as a break")


# ---------------------------------------------------------------------------
# 7. Workbook cross-read
# ---------------------------------------------------------------------------


def test_workbook_cross_read(case: Path, solution: Path, workbook: Path,
                             scratch: Path, clean: dict) -> None:
    check(clean["workbook"]["read"] is True,
          "the workbook cross-read did not run")
    check(clean["workbook"]["cells_compared"] >= 8,
          "the workbook cross-read compared only %d cells"
          % clean["workbook"]["cells_compared"])
    check("workbook_cross_read" in clean["domains"],
          "the workbook cross-read domain is absent from the report")

    row_map = json.loads(
        Path(str(workbook) + ".row-map.json").read_text(encoding="utf-8")
    )
    column = row_map["columns"]["forecast"][0]
    row = row_map["waterfall_rows"]["rcf_draw_waterfall"]
    address = "%s%d" % (column, int(row))
    tampered = scratch / "workbook-tampered.xlsx"
    rewrite_cached_value(workbook, tampered, address)
    # The row map supplies addresses only; it travels with the package.
    shutil.copyfile(str(workbook) + ".row-map.json", str(tampered) + ".row-map.json")
    report = report_for(case, solution, tampered)
    check("SFP_WORKBOOK_VALUE_MISMATCH" in codes(report),
          "a tampered cached value in the workbook must be caught, got %r"
          % sorted(codes(report)))
    check(report["expectation_digest"] == clean["expectation_digest"],
          "the expectation digest moved when the workbook changed")


def rewrite_cached_value(source: Path, target: Path, address: str) -> None:
    """Replace one cell's cached value in the sheet part, byte-identical otherwise."""
    changed = False
    with zipfile.ZipFile(source) as incoming:
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as outgoing:
            for info in incoming.infolist():
                data = incoming.read(info.filename)
                if info.filename == "xl/worksheets/sheet1.xml":
                    text = data.decode("utf-8")
                    needle = '<c r="%s"' % address
                    start = text.find(needle)
                    if start >= 0:
                        end = text.find("</c>", start)
                        cell = text[start:end]
                        value_start = cell.find("<v>")
                        if value_start >= 0:
                            value_end = cell.find("</v>", value_start)
                            replacement = (
                                cell[:value_start + 3] + "987654.321" + cell[value_end:]
                            )
                            text = text[:start] + replacement + text[end:]
                            changed = True
                    data = text.encode("utf-8")
                outgoing.writestr(info, data)
    if not changed:
        raise AssertionError("no cached value at %s to tamper with" % address)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=None, help="scratch directory")
    arguments = parser.parse_args(argv)

    temporary = None
    if arguments.out:
        scratch = Path(arguments.out)
        scratch.mkdir(parents=True, exist_ok=True)
    else:
        temporary = tempfile.mkdtemp(prefix="solver-fixed-point-oracle-")
        scratch = Path(temporary)

    try:
        test_independence(scratch)
        test_incumbent_does_not_recompute()
        test_tolerance_is_not_decorative()

        mutations = 0
        iteration_counts: list = []
        for name in CERTIFIED_FIXTURES:
            case, solution, workbook = build_certified(name, scratch / name)
            clean = report_for(case, solution, workbook)
            assert_clean(clean, name)
            iteration_counts.append(clean["recomputation"]["oracle_iterations"])
            check(clean["case_id"] is not None, "%s: the report must name the case" % name)
            test_workbook_cross_read(case, solution, workbook, scratch / name, clean)
            mutations += mutation_suite(
                case, solution, workbook, scratch / name, name, clean
            )
            test_refusals(case, solution, scratch / name)

        for name in ARCHETYPES:
            case = ROOT / "test-fixtures" / "archetypes" / "economics" / ("%s.json" % name)
            output = scratch / name
            solution = solve_case_file(case, output)
            clean = report_for(case, solution)
            assert_clean(clean, name)
            iteration_counts.append(clean["recomputation"]["oracle_iterations"])
            mutations += mutation_suite(case, solution, None, output, name, clean)

        # 123 mutations are rejected across the corpus as delivered.
        check(mutations >= 120,
              "only %d mutations were rejected across the corpus" % mutations)
        # The iteration machinery must actually be exercised somewhere.  One
        # corpus member (standard-net-cash-v2) is an exact fixed point at its own
        # seed and converges in a single pass -- so the pin is corpus-wide, not
        # per case, and it is recorded here rather than pretended away.
        check(max(iteration_counts) >= 3,
              "no case in the corpus needed more than %d passes to converge; the "
              "circularity is not being exercised" % max(iteration_counts))
    except AssertionError as failure:
        sys.stdout.write(json.dumps({
            "status": "FAIL",
            "checks": checks,
            "failure": str(failure)[:1200],
        }) + "\n")
        return 1
    finally:
        if temporary and not arguments.out:
            shutil.rmtree(temporary, ignore_errors=True)

    sys.stdout.write(json.dumps({"status": "PASS", "checks": checks}) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
