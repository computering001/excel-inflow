#!/usr/bin/env python3
"""P5.5 — authority and capture proven against CELLS, not against receipts.

The GAP this suite closes, stated as the harness proves it rather than as an
assertion:

  * the incumbent `forecast_ownership` mutation appends a duplicate entry to
    `<workbook>.forecast-receipt.json`; its inspector opens that receipt and
    never opens the workbook;
  * the incumbent `rcf_financing_cash` mutation deletes the `RCF draw` entry
    from the build's proof contract; its capture check reads the contract's own
    list back and compares it with a literal set of labels.

Group 1 below is the RED PROOF, kept permanently: it gives the captured child
row a live formula in the emitted `.xlsx`, shows both incumbent inspectors
returning ZERO findings on that file, shows the SAME claim mutated in the JSON
being caught, and only then shows the physical oracle catching the cell.  If
the incumbents are ever repaired the red proof fails loudly and this suite must
be reconciled with them — the blind spot cannot close in silence, and it cannot
reopen in silence either.

Production code is invoked to PRODUCE the artifacts (the builder and the
renderer) and never to judge them; the judgement is
`verify/physical_authority_mutation_oracle.py`, which reads the workbook
through P5.4's independently verified reconstruction and imports no production
module.

Every mutated address is DERIVED — from the emitted label column, from the
declared forecast columns, and from the protected identity whose member rows
contain the capture's parent row.  Group 5 asserts that no A1 address is
written down anywhere in this file's mutation machinery.
"""

from __future__ import annotations

import argparse
import ast
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.cell.cell import ERROR_CODES as OPENPYXL_ERROR_CODES

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from verify.emitted_candidate_artifact_oracle import (  # noqa: E402
    inspect_forecast_ownership,
    inspect_protected_cash_and_rcf,
)
from verify.oracle_independence import (  # noqa: E402
    production_imports,
    scan_directory,
)
from verify.physical_authority_mutation_oracle import (  # noqa: E402
    ERROR_VALUES,
    FORBIDDEN_PRODUCTION_IMPORTS,
    GREEN,
    column_number,
    judge,
    label_rows,
    sheet_named,
)
from verify.plan_reconstruction_oracle import reconstruct_plan  # noqa: E402

ORACLE = HERE / "verify" / "physical_authority_mutation_oracle.py"
READER = HERE / "verify" / "plan_reconstruction_oracle.py"
INCUMBENT = HERE / "run_emitted_candidate_independent_oracle_tests.py"

# The oracle judges; it must not acquire a reader of its own.  P5.4 already
# proved one faithful and this module reuses it verbatim.
PERMITTED_ORACLE_IMPORTS = {
    "__future__", "re", "sys", "pathlib", "verify.plan_reconstruction_oracle",
}

CHECKS = 0
FAILURES: list[str] = []


def check(condition: object, message: str) -> bool:
    global CHECKS
    CHECKS += 1
    if not condition:
        FAILURES.append(message)
    return bool(condition)


def run(command: list[str], *, env: dict | None = None, timeout: int = 900) -> str:
    completed = subprocess.run(
        command, cwd=ROOT, text=True, capture_output=True, timeout=timeout,
        env=env, check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(
            "command failed (%s): %s\n%s\n%s"
            % (completed.returncode, " ".join(command),
               completed.stdout[-4000:], completed.stderr[-4000:])
        )
    return completed.stdout


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# Artifact production — identical recipe to the emitted-candidate gate
# ---------------------------------------------------------------------------


def build_workbook(case_path: Path, output: Path) -> Path:
    output.mkdir(parents=True, exist_ok=True)
    source = json.loads(case_path.read_text(encoding="utf-8"))
    source["execution_profile"] = "reference_parity"
    source.setdefault("controls", {})["broker_case"] = "Model Consensus"
    case = output / "case.json"
    case.write_text(json.dumps(source, indent=2) + "\n", encoding="utf-8")
    workbook = output / "model.xlsx"
    run(["node", str(HERE / "build_dynamic_model.mjs"), str(case),
         "--out", str(workbook), "--plan-only"])
    run([sys.executable, "-m", "emit", "build", f"{workbook}.plan.json",
         "--out", str(workbook)],
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(HERE)})
    return workbook


# ---------------------------------------------------------------------------
# Mutation mechanics — the CELL is what changes
# ---------------------------------------------------------------------------


def mutate_cells(source: Path, target: Path, edits: list) -> Path:
    """Apply cell edits to a COPY.  The certified artifact is never touched."""
    workbook = load_workbook(source, data_only=False)
    for edit in edits:
        sheet = workbook[edit["sheet"]]
        cell = sheet[edit["address"]]
        if edit["operation"] == "set":
            cell.value = edit["value"]
        elif edit["operation"] == "clear":
            cell.value = None
        elif edit["operation"] == "repaint":
            cell.font = copy.copy(sheet[edit["donor"]].font)
        else:  # pragma: no cover - guarded by the caller's table
            raise AssertionError("unknown cell operation %r" % edit["operation"])
    workbook.save(target)
    return target


# ---------------------------------------------------------------------------
# Target derivation — no address is written down
# ---------------------------------------------------------------------------


def derive_targets(reconstruction: dict, contract: dict, ledger: list) -> dict:
    sheet_name = contract["statement_sheet"]
    label_column = contract["label_column"]
    columns = contract["forecast_columns"]
    sheet = sheet_named(reconstruction, sheet_name)
    rows = label_rows(sheet, label_column)

    captures = contract["semantic_scope_captures"]
    capture_parents = {entry["parent_row"] for entry in captures}
    capture_children = {entry["child_row"] for entry in captures}
    identities = contract.get("protected_formula_identities") or []
    absorbers = [
        identity for identity in identities
        if any(parent in (identity.get("member_rows") or []) for parent in capture_parents)
    ]
    if len(absorbers) != 1:
        raise AssertionError(
            "the capture parents are absorbed by %d protected identities; the "
            "derivation expects exactly one" % len(absorbers)
        )
    # Rows a mutation must stay away from unless it is aiming at them: the
    # capture geometry itself, and every row an identity formula watches.
    reserved = capture_parents | capture_children | {
        identity["owner_row"] for identity in identities
    }

    cells = sheet.get("cells") or {}
    resolved = []
    for entry in ledger:
        candidates = rows.get(entry.get("label") or "", [])
        index = entry.get("forecast_index")
        if len(candidates) != 1 or not isinstance(index, int) or index >= len(columns):
            continue
        address = "%s%d" % (columns[index], candidates[0])
        record = cells.get(address) or {}
        resolved.append({
            "entry": entry,
            "row": candidates[0],
            "column": columns[index],
            "address": address,
            "colour": ((record.get("style") or {}).get("font") or {}).get("color"),
        })
    resolved.sort(key=lambda item: (item["row"], item["column"]))

    def first(predicate, what: str):
        for item in resolved:
            if predicate(item):
                return item
        raise AssertionError("no resolved ledger entry is %s" % what)

    def free(item) -> bool:
        return item["row"] not in reserved

    derived_cell = first(
        lambda item: free(item) and item["entry"].get("authority") == "Derived"
        and item["entry"].get("method") == "accounting_identity",
        "a free derived accounting identity")
    broker_cell = first(
        lambda item: free(item) and item["entry"].get("authority") == "BrokerInput",
        "a free broker-authority cell")
    schedule_cell = first(
        lambda item: free(item) and item["entry"].get("authority") == "ScheduleLink",
        "a free schedule-link cell")
    black_donor = first(
        lambda item: item["colour"] is not None and item["colour"] != GREEN,
        "a cell whose font is not the cross-sheet colour")

    # The remotest populated cell of each sheet: the largest (row, column) that
    # currently holds a number.  The toy version of this domain compared three
    # hand-written dictionary entries; this reaches the real far corner.
    remote_cells: dict = {}
    for candidate in (reconstruction.get("workbook") or {}).get("sheets") or []:
        best = None
        for address, record in (candidate.get("cells") or {}).items():
            if record.get("type") != "n":
                continue
            match = re.fullmatch(r"([A-Z]{1,3})([0-9]+)", address)
            if not match:
                continue
            key = (int(match.group(2)), column_number(match.group(1)))
            if best is None or key > best[0]:
                best = (key, address)
        if best is not None:
            remote_cells[candidate["name"]] = best[1]

    return {
        "sheet": sheet_name,
        "remote_cells": remote_cells,
        "error_value": sorted(set(ERROR_VALUES) & set(OPENPYXL_ERROR_CODES))[0],
        "label_cell_for_error_text": "%s%d" % (label_column, derived_cell["row"]),
        "label_column": label_column,
        "columns": columns,
        "captures": captures,
        "absorber": absorbers[0],
        "derived_cell": derived_cell,
        "broker_cell": broker_cell,
        "schedule_cell": schedule_cell,
        "black_donor": black_donor,
        "resolved": resolved,
    }


# ---------------------------------------------------------------------------
# The suite
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("representative", nargs="?",
                        default=str(ROOT / "test-fixtures" / "cases" / "standard-maximal-v2.json"))
    parser.add_argument("--out")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="physical-authority-") as fallback:
        output = Path(args.out).resolve() if args.out else Path(fallback)
        output.mkdir(parents=True, exist_ok=True)
        return run_suite(Path(args.representative).resolve(), output)


def run_suite(representative: Path, output: Path) -> int:
    workbook = build_workbook(representative, output / "build")
    contract_path = Path(f"{workbook}.workbook-proof-contract.json")
    ledger_path = Path(f"{workbook}.forecast-receipt.json")
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    certified_sha = sha256(workbook)

    reconstruction = reconstruct_plan(workbook)
    targets = derive_targets(reconstruction, contract, ledger)

    # -- Group 0: the oracle passes the certified artifact, and not vacuously
    baseline = judge(workbook, contract, ledger)
    check(baseline["status"] == "PASS",
          "the certified workbook does not satisfy its own authority records: %s"
          % json.dumps(baseline["finding_counts"]))
    metrics = baseline["metrics"]
    check(metrics["captures_checked"] >= 1,
          "no semantic-scope capture was checked")
    check(metrics["capture_cells_checked"] >= 2 * metrics["captures_checked"],
          "fewer capture CELLS were read than there are captures")
    check(metrics["capture_absorption_cells_checked"] >= 1,
          "the captured scope's absorption into the statement was never read")
    check(metrics["authority_entries_checked"] >= 1,
          "no authority ledger entry was answered by a cell")
    check(metrics["authority_entries_checked"] * 2 >= metrics["authority_entries_declared"],
          "fewer than half the ledger entries resolved to a unique row: %s" % metrics)
    for authority in ("CapturedBy", "BrokerInput", "Derived", "ScheduleLink", "UserInput"):
        check(metrics["authority_rules_exercised"].get(authority, 0) >= 1,
              "the %s rule was never exercised, so its mutations prove nothing" % authority)

    # An openpyxl round trip is the mutation vehicle; the UNMUTATED round trip
    # must stay clean or a mutation's findings could be the vehicle's.
    control = mutate_cells(workbook, output / "control-roundtrip.xlsx", [])
    control_report = judge(control, contract, ledger)
    check(control_report["status"] == "PASS",
          "the unmutated round trip is already dirty: %s"
          % json.dumps(control_report["finding_counts"]))

    # -- Group 1: THE RED PROOF -------------------------------------------
    capture = max(targets["captures"], key=lambda entry: (entry["parent_row"], entry["child_row"]))
    child_address = "%s%d" % (capture["columns"][0], capture["child_row"])
    parent_address = "%s%d" % (capture["columns"][0], capture["parent_row"])
    red_cell = mutate_cells(
        workbook, output / "red-proof-cell.xlsx",
        [{"sheet": targets["sheet"], "address": child_address,
          "operation": "set", "value": "=%s" % parent_address}],
    )
    check(sha256(red_cell) != certified_sha, "the red-proof mutation changed no bytes")

    incumbent_capture: list = []
    inspect_protected_cash_and_rcf(red_cell, contract_path, incumbent_capture)
    check(incumbent_capture == [],
          "the incumbent capture inspector now sees the mutated CELL; the red "
          "proof is stale and this suite must be reconciled with it")
    incumbent_authority: list = []
    inspect_forecast_ownership(ledger_path, incumbent_authority)
    check(incumbent_authority == [],
          "the incumbent ownership inspector now sees the mutated CELL; the red "
          "proof is stale and this suite must be reconciled with it")

    receipt_capture_mutation = output / "red-proof-contract.json"
    receipt_contract = copy.deepcopy(contract)
    receipt_contract["semantic_scope_captures"] = [
        entry for entry in receipt_contract["semantic_scope_captures"]
        if entry.get("child_label") != capture["child_label"]
    ]
    receipt_capture_mutation.write_text(
        json.dumps(receipt_contract, indent=2) + "\n", encoding="utf-8")
    caught_in_receipt: list = []
    inspect_protected_cash_and_rcf(workbook, receipt_capture_mutation, caught_in_receipt)
    check(any(item.get("code") == "RCF_CAPTURE_CONTRACT" for item in caught_in_receipt),
          "the RECEIPT capture mutation is not caught either; the incumbent "
          "proves nothing at all")

    receipt_authority_mutation = output / "red-proof-receipt.json"
    duplicated = copy.deepcopy(ledger)
    duplicated.append(copy.deepcopy(duplicated[0]))
    receipt_authority_mutation.write_text(
        json.dumps(duplicated, indent=2) + "\n", encoding="utf-8")
    caught_in_ledger: list = []
    inspect_forecast_ownership(receipt_authority_mutation, caught_in_ledger)
    check(any(item.get("code") == "FORECAST_OWNERSHIP_DUPLICATE_WRITER"
              for item in caught_in_ledger),
          "the RECEIPT ownership mutation is not caught either")

    red_report = judge(red_cell, contract, ledger)
    check(red_report["status"] == "FAIL"
          and "CAPTURE_CHILD_HAS_LIVE_WRITER" in red_report["finding_counts"],
          "the physical oracle does not catch the cell the receipts cannot see: %s"
          % json.dumps(red_report["finding_counts"]))

    # -- Groups 2 and 3: the physical mutations ---------------------------
    mutations: list[dict] = []

    def apply_mutation(domain: str, mutation_id: str, expected: set, edits: list,
                       target: str) -> None:
        mutant = mutate_cells(
            workbook, output / ("mutation-%s-%s.xlsx" % (mutation_id, target.replace("!", "-"))),
            edits,
        )
        report = judge(mutant, contract, ledger)
        observed = set(report["finding_counts"])
        record = {
            "domain": domain,
            "mutation_id": mutation_id,
            "target": target,
            "mutation_scope": "emitted_workbook_cell",
            "address_derivation": "derived",
            "expected_codes": sorted(expected),
            "observed_codes": sorted(observed),
            "caught": observed == expected and report["status"] == "FAIL",
        }
        mutations.append(record)
        check(record["caught"],
              "%s at %s: expected %s, observed %s"
              % (mutation_id, target, sorted(expected), sorted(observed)))

    sheet = targets["sheet"]

    # Capture, exhaustively: EVERY declared capture child, in every declared
    # column, must be caught when it regains a writer.
    for entry in sorted(targets["captures"], key=lambda item: (item["parent_row"], item["child_row"])):
        for column in entry["columns"]:
            address = "%s%d" % (column, entry["child_row"])
            parent = "%s%d" % (column, entry["parent_row"])
            apply_mutation(
                "rcf_financing_cash", "capture-child-regains-live-writer",
                {"CAPTURE_CHILD_HAS_LIVE_WRITER", "AUTHORITY_CAPTURED_ROW_HAS_LIVE_CELL"},
                [{"sheet": sheet, "address": address, "operation": "set",
                  "value": "=%s" % parent}],
                "%s!%s" % (sheet, address),
            )

    first_capture = min(targets["captures"], key=lambda item: (item["parent_row"], item["child_row"]))
    capture_column = first_capture["columns"][0]
    capture_parent = "%s%d" % (capture_column, first_capture["parent_row"])
    apply_mutation(
        "rcf_financing_cash", "capture-parent-cell-blanked",
        {"CAPTURE_PARENT_NOT_WRITTEN", "AUTHORITY_LIVE_ROW_EMPTY_CELL"},
        [{"sheet": sheet, "address": capture_parent, "operation": "clear"}],
        "%s!%s" % (sheet, capture_parent),
    )

    absorber = targets["absorber"]
    absorber_column = absorber["columns"][0]
    absorber_cell = "%s%d" % (absorber_column, absorber["owner_row"])
    surviving = [
        "%s%d" % (absorber_column, row)
        for row in absorber["member_rows"] if row != first_capture["parent_row"]
    ]
    apply_mutation(
        "rcf_financing_cash", "capture-scope-dropped-from-absorbing-identity",
        {"CAPTURE_SCOPE_NOT_IN_FINANCING"},
        [{"sheet": sheet, "address": absorber_cell, "operation": "set",
          "value": "=%s" % "+".join(surviving)}],
        "%s!%s" % (sheet, absorber_cell),
    )

    relabelled = "%s%d" % (targets["label_column"], first_capture["child_row"])
    apply_mutation(
        "rcf_financing_cash", "capture-child-row-relabelled",
        {"CAPTURE_ROW_LABEL_MISMATCH"},
        [{"sheet": sheet, "address": relabelled, "operation": "set",
          "value": "%s (renamed)" % first_capture["child_label"]}],
        "%s!%s" % (sheet, relabelled),
    )

    derived = targets["derived_cell"]
    apply_mutation(
        "forecast_ownership", "derived-authority-cell-hardcoded",
        {"AUTHORITY_DERIVED_CELL_NOT_A_FORMULA"},
        [{"sheet": sheet, "address": derived["address"], "operation": "set",
          "value": 1.0}],
        "%s!%s" % (sheet, derived["address"]),
    )

    broker = targets["broker_cell"]
    apply_mutation(
        "forecast_ownership", "broker-authority-cell-loses-its-link",
        {"AUTHORITY_BROKER_CELL_NOT_LINKED"},
        [{"sheet": sheet, "address": broker["address"], "operation": "set",
          "value": "=%s" % targets["derived_cell"]["address"]}],
        "%s!%s" % (sheet, broker["address"]),
    )

    apply_mutation(
        "forecast_ownership", "broker-authority-cell-marking-repainted",
        {"AUTHORITY_MARKING_CONTRADICTS_RECORD"},
        [{"sheet": sheet, "address": broker["address"], "operation": "repaint",
          "donor": targets["black_donor"]["address"]}],
        "%s!%s" % (sheet, broker["address"]),
    )

    schedule = targets["schedule_cell"]
    apply_mutation(
        "forecast_ownership", "live-authority-cell-blanked",
        {"AUTHORITY_LIVE_ROW_EMPTY_CELL"},
        [{"sheet": sheet, "address": schedule["address"], "operation": "clear"}],
        "%s!%s" % (sheet, schedule["address"]),
    )

    # The error scan is workbook-wide, so it is mutated workbook-wide: the
    # REMOTEST populated cell of every sheet, derived by taking the largest
    # (row, column) that currently holds a number.
    for name, address in sorted(targets["remote_cells"].items()):
        apply_mutation(
            "workbook_error_scan", "remote-cell-carries-an-error",
            {"WORKBOOK_ERROR_VALUE"},
            [{"sheet": name, "address": address, "operation": "set",
              "value": targets["error_value"]}],
            "%s!%s" % (name, address),
        )
    apply_mutation(
        "workbook_error_scan", "cell-reads-as-an-error-without-the-error-type",
        {"WORKBOOK_ERROR_TEXT"},
        [{"sheet": sheet, "address": targets["label_cell_for_error_text"],
          "operation": "set", "value": " %s " % targets["error_value"]}],
        "%s!%s" % (sheet, targets["label_cell_for_error_text"]),
    )

    # -- Group 4: the oracle refuses to pass vacuously --------------------
    for label, bad_ledger in (
        ("empty ledger", []),
        ("proof contract in place of the ledger", contract),
        ("row map in place of the ledger", [{"row": 1}]),
    ):
        vacuous = judge(workbook, contract, bad_ledger)
        check("AUTHORITY_LEDGER_NOT_A_LEDGER" in vacuous["finding_counts"],
              "handed a %s the oracle passed instead of refusing" % label)
    for label, bad_contract in (
        ("forecast ledger in place of the contract", ledger),
        ("empty contract", {}),
    ):
        vacuous = judge(workbook, bad_contract, ledger)
        check("CAPTURE_CONTRACT_NOT_A_CONTRACT" in vacuous["finding_counts"],
              "handed a %s the oracle passed instead of refusing" % label)
    stripped = copy.deepcopy(contract)
    stripped["semantic_scope_captures"] = []
    vacuous = judge(workbook, stripped, ledger)
    check("CAPTURE_NO_CAPTURES_DECLARED" in vacuous["finding_counts"],
          "a contract declaring no captures passed as a workbook with none")

    # -- Group 5: the addresses are derived, and stay pointed --------------
    source = Path(__file__).read_text(encoding="utf-8")
    body = source.split('"""', 2)[-1]
    literal_addresses = sorted({
        literal.value for literal in ast.walk(ast.parse(body))
        if isinstance(literal, ast.Constant) and isinstance(literal.value, str)
        and re.fullmatch(r"\$?[A-Z]{1,3}\$?[0-9]+", literal.value)
    })
    check(literal_addresses == [],
          "this harness writes A1 addresses down: %s" % literal_addresses)
    check(all(record["address_derivation"] == "derived" for record in mutations),
          "a mutation was applied to an address that was not derived")
    derivation = {
        "row": "unique match of the authority record's label in the emitted label column",
        "column": "the declared forecast column for the record's forecast index",
        "capture_rows": "the capture record's parent_row/child_row, verified against the emitted labels",
        "absorbing_identity": "the protected identity whose member_rows contain the capture parent row",
    }

    # The incumbent's own hardcoded literals cannot be repaired from here (its
    # file is outside this package), so they are PINNED: the moment one stops
    # pointing at the cell it means, this suite goes red and forces the repair.
    incumbent_source = INCUMBENT.read_text(encoding="utf-8")
    statement = sheet_named(reconstruction, targets["sheet"])
    address_pattern = r"([A-Z]{1,3})([0-9]+)"
    hardcoded = re.search(
        r'\[%s\]\["%s"\][^\n]*?\.replace\(\s*"\$%s"'
        % (re.escape(json.dumps(targets["sheet"])), address_pattern, address_pattern),
        incumbent_source,
    )
    incumbent_pin: dict = {"state": "DEHARDCODED_OR_ABSENT"}
    if hardcoded:
        mutated_column, mutated_row, balance_column, balance_row = hardcoded.groups()
        mutated_cell = "%s%s" % (mutated_column, mutated_row)
        formula = ((statement.get("cells") or {}).get(mutated_cell) or {}).get("formula") or ""
        check("$%s%s" % (balance_column, balance_row) in formula,
              "the incumbent's hardcoded %s no longer reads $%s%s, so its "
              "interest-lineage mutation silently points at nothing"
              % (mutated_cell, balance_column, balance_row))
        label_of = lambda row: ((statement.get("cells") or {}).get(  # noqa: E731
            "%s%s" % (targets["label_column"], row)) or {}).get("value")
        check(label_of(mutated_row) is not None and label_of(mutated_row) == label_of(balance_row),
              "the incumbent's hardcoded interest row %s and balance row %s no "
              "longer describe the same instrument" % (mutated_row, balance_row))
        incumbent_pin = {
            "state": "PINNED",
            "mutated_cell": mutated_cell,
            "balance_reference": "$%s%s" % (balance_column, balance_row),
            "instrument": label_of(mutated_row),
        }
    else:
        check(True, "the incumbent's interest-lineage mutation no longer hardcodes an address")

    # -- Group 6: the certified artifact is untouched -----------------------
    check(sha256(workbook) == certified_sha,
          "the suite mutated the certified workbook in place")
    second = build_workbook(representative, output / "rebuild")
    check(sha256(second) == certified_sha,
          "the emission is not byte-identical across two builds of the same case")

    # -- Group 7: independence ---------------------------------------------
    scanned = scan_directory(HERE / "verify", FORBIDDEN_PRODUCTION_IMPORTS)
    check(ORACLE.name in scanned, "the physical oracle is outside the verify independence scan")
    check(scanned.get(ORACLE.name) == [],
          "the physical oracle imports production modules: %s" % scanned.get(ORACLE.name))
    check(all(hits == [] for hits in scanned.values()),
          "the verify layer has production imports: %s"
          % {name: hits for name, hits in scanned.items() if hits})
    check(production_imports(ORACLE, FORBIDDEN_PRODUCTION_IMPORTS) == [],
          "direct scan of the physical oracle found production imports")
    imported = set()
    for node in ast.walk(ast.parse(ORACLE.read_text(encoding="utf-8"))):
        if isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
    check(imported <= PERMITTED_ORACLE_IMPORTS,
          "the physical oracle imports outside stdlib + P5.4's reader: %s"
          % sorted(imported - PERMITTED_ORACLE_IMPORTS))
    check("reconstruct_plan" in ORACLE.read_text(encoding="utf-8")
          and "zipfile" not in ORACLE.read_text(encoding="utf-8"),
          "the physical oracle grew a reader of its own instead of reusing P5.4's")
    check(READER.is_file(), "P5.4's reconstruction reader is gone")

    report = {
        "schema_version": "physical-authority-mutation-report/1.0",
        "status": "FAIL" if FAILURES else "PASS",
        "checks": CHECKS,
        "failures": FAILURES,
        "certified_workbook_sha256": certified_sha,
        "baseline": baseline["metrics"],
        "red_proof": {
            "mutated_cell": "%s!%s" % (targets["sheet"], child_address),
            "incumbent_capture_findings_on_mutated_cell": incumbent_capture,
            "incumbent_authority_findings_on_mutated_cell": incumbent_authority,
            "incumbent_capture_findings_on_mutated_receipt":
                sorted({item["code"] for item in caught_in_receipt}),
            "incumbent_authority_findings_on_mutated_receipt":
                sorted({item["code"] for item in caught_in_ledger}),
            "physical_oracle_findings_on_mutated_cell":
                sorted(red_report["finding_counts"]),
        },
        "address_derivation": derivation,
        "incumbent_hardcoded_address_pin": incumbent_pin,
        "mutations": mutations,
        "mutations_caught": sum(1 for record in mutations if record["caught"]),
        "mutations_total": len(mutations),
        "domains": sorted({record["domain"] for record in mutations}),
        "production_imports": [],
        "total_violations": len(FAILURES),
    }
    (output / "physical-authority-mutation-report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if FAILURES:
        print(json.dumps({"status": "FAIL", "checks": CHECKS, "failures": FAILURES},
                         sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps({"status": "PASS", "checks": CHECKS}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
