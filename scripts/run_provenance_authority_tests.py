#!/usr/bin/env python3
"""P5.3 — provenance styling and comment truth bound to the authority record.

Invariant under test: a cell's provenance styling is bound to the AUTHORITY
RECORD governing that cell, and the provenance comment's CONTENT is checked for
truth against that same record -- not asserted by a rule the emitter and the
validator share.

Four groups of checks:

  * INDEPENDENCE.  The new oracle is AST-scanned with the rest of
    `scripts/verify` against a non-empty forbidden list, its import surface is
    confined to the standard library and sibling oracles, and the property is
    TESTED rather than asserted: the workbook, the case and the three records
    the oracle names are copied into an otherwise empty directory -- proof
    contract, semantic manifest, solution, coverage, forecast receipt,
    transformation receipt, source crosswalk and shadow comparison all out of
    reach -- and the verdict must come back identical.

  * WITNESS.  The self-reference this package closes is pinned so it cannot
    reopen in silence: the emitter still chooses the colour from the shape of
    the formula it just wrote, both shipped validators still re-derive their
    expectation from that same cell's formula text, the shipped comment check
    still tests only PRESENCE, and the incumbent semantic oracle still reads no
    comments at all.  These assert the incumbents' shape; they repair nothing.

  * BASELINE.  Both certified fixtures verify clean, with non-vacuous metrics,
    and the emitted workbook is byte-identical to the recorded certified hash --
    the binding travels beside the package, not inside it.

  * MUTATIONS.  One channel at a time is corrupted -- in the rendered workbook,
    in the recorded binding, or in an authority record -- and the expected typed
    finding must appear, alone.  Three of them are the package's charter: a cell
    coloured against its authority record, a comment whose claim contradicts the
    authority, and a marked cell with no authority record at all.

Subprocess note (the review obligation in `verify/oracle_independence.py`):
this harness invokes production code -- the builder and the renderer -- to
PRODUCE the artifacts under test.  It never invokes production code to compute
the expected answer; the expectation is the case, the model IR's authority
plane and the recorded binding.
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
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from verify.oracle_independence import production_imports, scan_directory  # noqa: E402
from verify.provenance_authority_oracle import (  # noqa: E402
    FORBIDDEN_PRODUCTION_IMPORTS,
    verify,
)

FIXTURES = ("standard-maximal-v2", "standard-net-cash-v2")
CERTIFIED_XLSX = {
    "standard-maximal-v2": "ce89b6db014c989cc679cdc2325f7d8da0af0eb5528413f07bea5b87833e7b6d",
    "standard-net-cash-v2": "3605f07a860d84a4cd9b275c617117c95b4dbbf472d6df18e771d9989d4aed93",
}

checks = 0
failures: list = []


def check(condition: bool, message: str) -> None:
    global checks
    if not condition:
        failures.append(message)
        raise AssertionError("PROVENANCE_AUTHORITY_FAIL: " + message)
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


def build(case_path: Path, output: Path) -> dict:
    """Plan-only build, then render.  Production code PRODUCES; it never judges."""
    output.mkdir(parents=True, exist_ok=True)
    source = json.loads(case_path.read_text(encoding="utf-8"))
    source["execution_profile"] = "reference_parity"
    source.setdefault("controls", {})["broker_case"] = "Model Consensus"
    case = output / "case.json"
    case.write_text(json.dumps(source, indent=2) + "\n", encoding="utf-8")
    workbook = output / "model.xlsx"
    run(["node", str(HERE / "build_dynamic_model.mjs"), str(case),
         "--out", str(workbook), "--plan-only"])
    render(output)
    return {
        "case": case,
        "xlsx": workbook,
        "plan": Path(str(workbook) + ".plan.json"),
        "binding": Path(str(workbook) + ".provenance-authority.json"),
        "row_map": Path(str(workbook) + ".row-map.json"),
        "model_ir": Path(str(workbook) + ".model-ir-v3.json"),
    }


def render(output: Path) -> None:
    workbook = output / "model.xlsx"
    run([sys.executable, "-m", "emit", "build", str(workbook) + ".plan.json",
         "--out", str(workbook)],
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(HERE)})


def judge(paths: dict) -> dict:
    return verify(
        paths["xlsx"],
        json.loads(paths["case"].read_text(encoding="utf-8")),
        json.loads(paths["model_ir"].read_text(encoding="utf-8")),
        json.loads(paths["row_map"].read_text(encoding="utf-8")),
        json.loads(paths["binding"].read_text(encoding="utf-8")),
    )


# ---------------------------------------------------------------------------
# Mutation mechanics
# ---------------------------------------------------------------------------


def stage(base: Path, name: str, root: Path) -> dict:
    target = root / name
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    for entry in base.iterdir():
        if entry.is_file():
            shutil.copy2(entry, target / entry.name)
    workbook = target / "model.xlsx"
    return {
        "dir": target,
        "case": target / "case.json",
        "xlsx": workbook,
        "plan": Path(str(workbook) + ".plan.json"),
        "binding": Path(str(workbook) + ".provenance-authority.json"),
        "row_map": Path(str(workbook) + ".row-map.json"),
        "model_ir": Path(str(workbook) + ".model-ir-v3.json"),
    }


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write(path: Path, payload: dict, *, indent: int = 2) -> None:
    path.write_text(json.dumps(payload, indent=indent) + "\n", encoding="utf-8")


def sheet_of(plan: dict, name: str) -> dict:
    return [entry for entry in plan["workbook"]["sheets"] if entry["name"] == name][0]


def recolour(plan: dict, base_index: int, colour: str) -> int:
    styles = plan["workbook"]["styles"]
    candidate = copy.deepcopy(styles[base_index])
    candidate.setdefault("font", {})["color"] = colour
    for index, existing in enumerate(styles):
        if existing == candidate:
            return index
    styles.append(candidate)
    return len(styles) - 1


def statement_rows(row_map: dict) -> list:
    rows = row_map.get("statement_rows") or {}
    return [*(rows.get("income_statement") or []), *(rows.get("cash_flow") or [])]


def derived_historical_cell(paths: dict) -> str:
    """A historical cell on a row the CASE declares computed from other rows."""
    case = read(paths["case"])
    declared = {}
    for section in ("income_statement", "cash_flow"):
        for row in (case.get("statement_structure") or {}).get(section) or []:
            declared[row["row_id"]] = row
    plan = read(paths["plan"])
    cells = sheet_of(plan, "Operating Model")["cells"]
    for definition in statement_rows(read(paths["row_map"])):
        row = declared.get(definition["row_id"])
        refs = ((row or {}).get("calculation") or {}).get("refs") or []
        if not row or not refs:
            continue
        address = "G%d" % definition["row"]
        cell = cells.get(address) or {}
        # A numeric cached value: stripping the formula off a cell whose cached
        # value is an empty string would leave an EMPTY cell, which makes no
        # provenance claim and would test nothing.
        if "f" in cell and isinstance(cell.get("v"), (int, float)) and not isinstance(cell.get("v"), bool):
            return address
    raise AssertionError("no derived historical cell in the fixture")


def blue_historical_cell(paths: dict) -> str:
    plan = read(paths["plan"])
    for record in read(paths["binding"])["cells"]:
        if record["authority"]["kind"] == "historical" and record["font_color"] == "FF0000FF":
            return record["cell"]
    raise AssertionError("no blue historical cell in the fixture")


def expect(report: dict, expected: dict, label: str) -> None:
    check(
        report["finding_counts"] == expected,
        "%s: expected %s, got %s (%s)"
        % (label, expected, report["finding_counts"],
           json.dumps(report["findings"][:3])),
    )
    check(report["status"] == "BLOCK", "%s: mutated artifact must BLOCK" % label)


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


def mutate_derived_cell_painted_blue(paths: dict) -> dict:
    """THE CHARTER MUTATION.  A derived subtotal shipped as a typed-in number
    and painted blue: internally consistent (no formula, therefore blue) and a
    lie about where the number came from."""
    address = derived_historical_cell(paths)
    plan = read(paths["plan"])
    cell = sheet_of(plan, "Operating Model")["cells"][address]
    cell.pop("f")
    cell["t"] = "n"
    cell["s"] = recolour(plan, cell["s"], "FF0000FF")
    write(paths["plan"], plan, indent=1)
    render(paths["dir"])
    return {"PROV_MARK_CONTRADICTS_AUTHORITY": 1, "PROV_BINDING_MARK_DRIFT": 1}


def mutate_broker_cell_painted_blue(paths: dict) -> dict:
    """A broker-authority forecast cell with its link cut and the number baked
    in.  The authority record says the figure came from the broker feed."""
    binding = read(paths["binding"])
    address = next(
        record["cell"] for record in binding["cells"]
        if record["authority"]["kind"] == "forecast" and record["cross_sheet_formula"]
    )
    plan = read(paths["plan"])
    cell = sheet_of(plan, "Operating Model")["cells"][address]
    cell.pop("f")
    cell["t"] = "n"
    cell["s"] = recolour(plan, cell["s"], "FF0000FF")
    write(paths["plan"], plan, indent=1)
    render(paths["dir"])
    return {"PROV_MARK_CONTRADICTS_AUTHORITY": 1, "PROV_BINDING_MARK_DRIFT": 1}


def mutate_comment_claim(paths: dict) -> dict:
    """THE CHARTER MUTATION.  The comment stays present and well-formed; only
    its CLAIM changes."""
    address = blue_historical_cell(paths)
    plan = read(paths["plan"])
    for entry in sheet_of(plan, "Operating Model")["comments"]:
        if entry["cell"] == address:
            entry["text"] = (
                "Source: Fabricated Filing That Does Not Exist\n"
                "Published: 1999-01-01\n"
                'Page / note: page 404, note "invented"\n'
                "Source label: Not this line\n"
                "Units: bananas"
            )
            break
    else:
        raise AssertionError("no comment on %s" % address)
    write(paths["plan"], plan, indent=1)
    render(paths["dir"])
    return {"PROV_COMMENT_CLAIM_FALSE": 1}


def mutate_forecast_authority_claim(paths: dict) -> dict:
    binding = read(paths["binding"])
    target = next(
        record for record in binding["comments"]
        if record["authority"]["kind"] == "forecast_authority"
    )
    plan = read(paths["plan"])
    for entry in sheet_of(plan, target["sheet"])["comments"]:
        if entry["cell"] == target["cell"]:
            entry["text"] = entry["text"].replace(
                entry["text"].splitlines()[0],
                "Forecast authority: broker_consensus",
            )
            break
    else:
        raise AssertionError("no comment on %s" % target["cell"])
    write(paths["plan"], plan, indent=1)
    render(paths["dir"])
    return {"PROV_COMMENT_CLAIM_FALSE": 1}


def mutate_comment_removed(paths: dict) -> dict:
    address = blue_historical_cell(paths)
    plan = read(paths["plan"])
    sheet = sheet_of(plan, "Operating Model")
    sheet["comments"] = [entry for entry in sheet["comments"] if entry["cell"] != address]
    write(paths["plan"], plan, indent=1)
    render(paths["dir"])
    return {"PROV_COMMENT_ABSENT_FROM_FILE": 1, "PROV_HARDCODE_WITHOUT_SOURCE": 1}


def mutate_source_comment_onto_derived_cell(paths: dict) -> dict:
    source = blue_historical_cell(paths)
    target = derived_historical_cell(paths)
    plan = read(paths["plan"])
    sheet = sheet_of(plan, "Operating Model")
    text = next(entry["text"] for entry in sheet["comments"] if entry["cell"] == source)
    sheet["comments"] = [entry for entry in sheet["comments"] if entry["cell"] != source]
    sheet["comments"].append({"cell": target, "text": text})
    write(paths["plan"], plan, indent=1)
    binding = read(paths["binding"])
    for record in binding["comments"]:
        if record["sheet"] == "Operating Model" and record["cell"] == source:
            record["cell"] = target
    write(paths["binding"], binding)
    render(paths["dir"])
    return {
        "PROV_SOURCE_COMMENT_ON_DERIVED_CELL": 1,
        "PROV_HARDCODE_WITHOUT_SOURCE": 1,
    }


def mutate_unbound_source_comment(paths: dict) -> dict:
    plan = read(paths["plan"])
    sheet = sheet_of(plan, "Forward Curves")
    sheet["comments"].append({
        "cell": "B2",
        "text": "Source: A page nobody bound\nPublished: 2020-01-01\n"
                "Page / note: nowhere\nSource label: none\nUnits: none",
    })
    write(paths["plan"], plan, indent=1)
    render(paths["dir"])
    return {"PROV_COMMENT_UNBOUND": 1}


def mutate_cross_sheet_link_repainted(paths: dict) -> dict:
    """OFF the income-statement and cash-flow rows the shipped colour check
    scans -- on the Brokers sheet, which it never visits at all."""
    plan = read(paths["plan"])
    styles = plan["workbook"]["styles"]
    sheet = sheet_of(plan, "Brokers")
    for address, cell in sorted(sheet["cells"].items()):
        colour = ((styles[cell["s"]].get("font") or {}).get("color")) if "s" in cell else None
        if colour == "FF008000" and "f" in cell:
            cell["s"] = recolour(plan, cell["s"], "FF000000")
            break
    else:
        raise AssertionError("no green cross-sheet link on the Brokers sheet")
    write(paths["plan"], plan, indent=1)
    render(paths["dir"])
    return {"PROV_MARK_CONTRADICTS_FORMULA": 1}


def mutate_blue_cell_given_a_formula(paths: dict) -> dict:
    address = blue_historical_cell(paths)
    plan = read(paths["plan"])
    cell = sheet_of(plan, "Operating Model")["cells"][address]
    cell["f"] = "1*%s" % address.replace("G", "I")
    write(paths["plan"], plan, indent=1)
    render(paths["dir"])
    return {"PROV_MARK_CONTRADICTS_FORMULA": 1}


def mutate_binding_removed(paths: dict) -> dict:
    """THE CHARTER MUTATION.  A marked cell with no authority record at all."""
    binding = read(paths["binding"])
    address = blue_historical_cell(paths)
    binding["cells"] = [
        record for record in binding["cells"]
        if not (record["sheet"] == "Operating Model" and record["cell"] == address)
    ]
    write(paths["binding"], binding)
    return {"PROV_BINDING_ABSENT": 1}


def mutate_binding_repointed(paths: dict) -> dict:
    binding = read(paths["binding"])
    address = blue_historical_cell(paths)
    for record in binding["cells"]:
        if record["sheet"] == "Operating Model" and record["cell"] == address:
            record["authority"]["row_id"] = "a_row_that_is_somewhere_else"
            break
    write(paths["binding"], binding)
    return {"PROV_BINDING_GEOMETRY_MISMATCH": 1}


def mutate_binding_colour(paths: dict) -> dict:
    binding = read(paths["binding"])
    address = blue_historical_cell(paths)
    for record in binding["cells"]:
        if record["sheet"] == "Operating Model" and record["cell"] == address:
            record["font_color"] = "FF008000"
            break
    write(paths["binding"], binding)
    return {"PROV_BINDING_MARK_DRIFT": 1}


def mutate_binding_version(paths: dict) -> dict:
    binding = read(paths["binding"])
    binding["version"] = "provenance-authority/0"
    write(paths["binding"], binding)
    return {"PROV_BINDING_VERSION": 1}


def mutate_authority_record_removed(paths: dict) -> dict:
    """The authority plane loses one row's forecast records: three marked cells
    whose governing record has vanished."""
    binding = read(paths["binding"])
    row_id = next(
        record["authority"]["row_id"] for record in binding["cells"]
        if record["authority"]["kind"] == "forecast" and record["has_content"]
    )
    model_ir = read(paths["model_ir"])
    model_ir["planes"]["authority"] = [
        record for record in model_ir["planes"]["authority"]
        if record.get("display_id") != row_id
    ]
    write(paths["model_ir"], model_ir)
    present = sum(
        1 for record in binding["cells"]
        if record["authority"]["kind"] == "forecast"
        and record["authority"]["row_id"] == row_id
        and record["has_content"]
    )
    return {"PROV_BINDING_UNRESOLVED": present}


MUTATIONS = [
    ("derived cell painted blue", mutate_derived_cell_painted_blue),
    ("broker-authority cell painted blue", mutate_broker_cell_painted_blue),
    ("provenance comment claim replaced", mutate_comment_claim),
    ("forecast-authority claim replaced", mutate_forecast_authority_claim),
    ("provenance comment removed", mutate_comment_removed),
    ("source comment moved onto a derived cell", mutate_source_comment_onto_derived_cell),
    ("unbound source comment injected", mutate_unbound_source_comment),
    ("cross-sheet link repainted black off-statement", mutate_cross_sheet_link_repainted),
    ("blue cell given a formula", mutate_blue_cell_given_a_formula),
    ("binding removed", mutate_binding_removed),
    ("binding repointed", mutate_binding_repointed),
    ("binding colour altered", mutate_binding_colour),
    ("binding version unknown", mutate_binding_version),
    ("authority record removed", mutate_authority_record_removed),
]


# ---------------------------------------------------------------------------
# Independence and witness
# ---------------------------------------------------------------------------


ORACLE = HERE / "verify" / "provenance_authority_oracle.py"


def independence_checks() -> None:
    scan = scan_directory(HERE / "verify", FORBIDDEN_PRODUCTION_IMPORTS)
    check(
        "provenance_authority_oracle.py" in scan,
        "the new oracle is not inside the scripts/verify independence scan",
    )
    for name, violations in sorted(scan.items()):
        check(not violations, "%s imports production code: %s" % (name, violations))
    check(
        not production_imports(ORACLE, FORBIDDEN_PRODUCTION_IMPORTS),
        "the oracle imports production code",
    )
    check(
        len(FORBIDDEN_PRODUCTION_IMPORTS) >= 9,
        "the forbidden-import list has been shortened",
    )


def isolation_check(paths: dict, baseline: dict, root: Path) -> None:
    """The property, tested rather than asserted: only the workbook, the case
    and the three records the oracle names are within reach."""
    with tempfile.TemporaryDirectory(dir=str(root)) as isolated:
        island = Path(isolated)
        for key in ("xlsx", "case", "binding", "row_map", "model_ir"):
            shutil.copy2(paths[key], island / paths[key].name)
        moved = {
            key: island / paths[key].name
            for key in ("xlsx", "case", "binding", "row_map", "model_ir")
        }
        report = judge(moved)
        check(
            report["status"] == baseline["status"]
            and report["finding_counts"] == baseline["finding_counts"]
            and {k: v for k, v in report["metrics"].items() if k != "xlsx_sha256"}
            == {k: v for k, v in baseline["metrics"].items() if k != "xlsx_sha256"},
            "the verdict changed when the build's other sidecars were out of reach",
        )
        for forbidden in (
            ".workbook-proof-contract.json", ".semantic-manifest.json",
            ".solution.json", ".coverage.json", ".forecast-receipt.json",
            ".transformation-receipt.json", ".shadow-comparison.json",
            ".source-crosswalk.csv", ".plan.json",
        ):
            check(
                not list(island.glob("*" + forbidden)),
                "%s was within reach during the isolation run" % forbidden,
            )


def witness_checks() -> None:
    """The gap this package closes, pinned so it cannot reopen in silence."""
    builder = (HERE / "build_dynamic_model.mjs").read_text(encoding="utf-8")
    check(
        "function formulaColor(formula)" in builder
        and "return /'[^']+'!/.test(formula) ? COLORS.green : COLORS.black;" in builder,
        "the emitter no longer derives the provenance colour from the formula text; "
        "this witness must be reconciled with the new binding rather than deleted",
    )
    validator = (HERE / "validate_dynamic_model.mjs").read_text(encoding="utf-8")
    check(
        "font-colour-contract" in validator
        and "/(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)!/.test(cellFormula)" in validator,
        "the shipped validator no longer re-derives the expected colour from the cell's "
        "own formula; the self-reference witness must be updated deliberately",
    )
    check(
        "historical-provenance-comments" in validator
        and "if (!commentRefs.has(address)) missingComments.push(address);" in validator,
        "the shipped comment check no longer tests presence alone; update this witness",
    )
    port = (HERE / "verify" / "validate_dynamic_model.py").read_text(encoding="utf-8")
    check(
        'r"(?:\'[^\']+\'|[A-Za-z_][A-Za-z0-9_.]*)!"' in port,
        "the Python validator port no longer carries the same formula-derived expectation",
    )
    semantic = (HERE / "verify" / "workbook_semantic_oracle.py").read_text(encoding="utf-8")
    check(
        "comment" not in semantic.lower(),
        "the incumbent semantic oracle now reads comments; this witness is stale",
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--fixture", action="append")
    args = parser.parse_args()
    root = args.out.resolve()
    root.mkdir(parents=True, exist_ok=True)

    independence_checks()
    witness_checks()

    for fixture in (args.fixture or FIXTURES):
        base = root / fixture
        paths = build(ROOT / "test-fixtures" / "cases" / (fixture + ".json"), base)
        baseline = judge(paths)
        check(
            baseline["status"] == "PASS",
            "%s: clean build must verify clean, got %s"
            % (fixture, json.dumps(baseline["finding_counts"])),
        )
        check(
            baseline["metrics"]["xlsx_sha256"] == CERTIFIED_XLSX[fixture],
            "%s: emitted workbook is no longer byte-identical to the certified hash (%s)"
            % (fixture, baseline["metrics"]["xlsx_sha256"]),
        )
        for metric in (
            "marked_cells_swept", "statement_grid_cells", "authority_bound_cells",
            "comments_read", "comment_claims_checked", "bound_cells", "bound_comments",
        ):
            check(
                baseline["metrics"][metric] > 0,
                "%s: %s visited nothing and cannot pass vacuously" % (fixture, metric),
            )
        check(
            baseline["metrics"]["sheets"] >= 3
            and baseline["metrics"]["marked_cells_swept"]
            > baseline["metrics"]["statement_grid_cells"],
            "%s: the sweep did not reach past the statement grid" % fixture,
        )
        isolation_check(paths, baseline, root)

        for label, mutation in MUTATIONS:
            staged = stage(base, "mutation-%s" % label.replace(" ", "-"), root)
            expected = mutation(staged)
            expect(judge(staged), expected, "%s / %s" % (fixture, label))
            shutil.rmtree(staged["dir"])

    sys.stdout.write(json.dumps({"status": "PASS", "checks": checks}) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as error:
        sys.stdout.write(
            json.dumps({"status": "FAIL", "checks": checks, "error": str(error)}) + "\n"
        )
        raise SystemExit(1)
