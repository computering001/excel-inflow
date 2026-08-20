#!/usr/bin/env python3
"""P5.8 -- pair every style/geometry mutation to a visual detector, or say there isn't one.

INVARIANT
---------
A style or geometry mutation that a reader would SEE is provably detected, and
the mutation half and the visual half are PAIRED: neither can pass while the
other is blind.

Before this suite the two halves were disjoint.  The mutation half
(``scripts/run_standardised_design_contract_mutations.mjs``) mutated a contract
JSON and had no caller at all; the visual half (``scripts/render/check_render.py``)
rendered workbooks and was never fed a mutant.  Nothing anywhere said which
visual check catches which style defect, so both halves could have been blind at
once and every gate would still have been green.

WHAT IS PROVEN, AND HOW
-----------------------
The suite builds a real workbook from a real case, renders it through
LibreOffice to author a per-page pixel baseline, then applies one adversarial
OOXML mutation at a time to the emitted ``.xlsx`` BYTES -- never to a receipt --
and records, for each mutation, two independent observations:

  FILE half    P5.4's ``verify/plan_reconstruction_oracle.py`` reconstructs the
               plan back out of the .xlsx and reports typed findings; for the
               provenance-colour mutation P5.3's
               ``verify/provenance_authority_oracle.py`` is read as well.  Both
               are reused, not re-implemented.

  VISUAL half  ``scripts/render/check_render.py`` converts the mutant through
               LibreOffice and reports clipping / presence / overlap defects and
               a per-page pixel diff against the baseline.

The matrix asset's ``rendered_geometry_scope`` block DECLARES, per mutation,
which detector on each side is expected to fire.  This suite then checks the
declaration against the observations in BOTH directions:

  * a mutation declared PAIRED must actually fire its declared visual signal;
  * a mutation declared NO_VISUAL_DETECTOR must produce a render that is
    provably blind -- verdict PASS **and zero changed pixels on every page**.
    "No check happened to complain" is not accepted as evidence of blindness.

A NEGATIVE CONTROL runs first: the unmutated workbook must be clean on both
halves.  Without it, a detector that fires on everything would look perfect.

GOVERNANCE MUTATIONS mutate the DECLARATION rather than the workbook and assert
the evaluator rejects each one, so the pairing table cannot lie in either
direction -- neither by claiming a detector that does not fire, nor by
disclaiming one that does.

FAIL-CLOSED
-----------
This suite needs LibreOffice and an interpreter that has openpyxl and PyMuPDF.
On a host without them it exits BLOCKED (non-zero).  There is deliberately no
path that turns a missing render into a green tick; a visual gate that degrades
to a pass when it cannot see is worse than no visual gate at all.

HONEST LIMIT
------------
LibreOffice/Carlito is the renderer of record here.  Two of the six mutations
are proven to have NO print-render detector at all -- freeze panes and screen
gridlines have no printed representation, so the paginated render is blind to
them by construction, not by omission.  Those carry audit class
``visual_manual``: only a human (or a native-host check) looking at the live
workbook can see them.  That is what gives ``visual_manual`` a referent.

    python scripts/run_visual_mutation_pairing_tests.py [--soffice PATH]
        [--case test-fixtures/cases/standard-maximal-v2.json] [--work DIR]
"""

from __future__ import annotations

import argparse
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

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
MATRIX_PATH = ROOT / "assets" / "critical-invariant-oracle-matrix-v1.json"
REGISTRY_PATH = ROOT / "assets" / "development-test-registry.json"
DEFAULT_CASE = ROOT / "test-fixtures" / "cases" / "standard-maximal-v2.json"
SHEET = "Operating Model"
BASELINE_CASE = "p58-rendered-geometry-reference"

sys.path.insert(0, str(SCRIPTS))

CHECKS = 0


def check(condition, message: str) -> None:
    global CHECKS
    if not condition:
        raise AssertionError(f"VISUAL_PAIRING_FAIL: {message}")
    CHECKS += 1


class Blocked(Exception):
    """A required input for the render lane is absent on this host."""


# ---------------------------------------------------------------------------
# Host fitness.  Declared, never assumed.
# ---------------------------------------------------------------------------
def resolve_soffice(explicit: str | None) -> str:
    candidates = [
        explicit,
        os.environ.get("EXCEL_INFLOW_SOFFICE"),
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        shutil.which("soffice"),
        shutil.which("libreoffice"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(candidate)
    raise Blocked(
        "no LibreOffice binary found (--soffice, EXCEL_INFLOW_SOFFICE, "
        "/Applications/LibreOffice.app/Contents/MacOS/soffice, PATH). The visual "
        "half of this pairing cannot run without a real conversion."
    )


def require_render_modules() -> dict:
    versions = {}
    for module, distribution in (("openpyxl", "openpyxl"), ("fitz", "PyMuPDF")):
        try:
            imported = __import__(module)
        except ImportError as error:  # pragma: no cover - host dependent
            raise Blocked(
                f"this interpreter ({sys.executable}) cannot import {module} "
                f"({distribution}), which the render lane requires: {error}"
            ) from error
        versions[distribution] = getattr(imported, "__version__", "unknown")
    return versions


# ---------------------------------------------------------------------------
# OOXML mutations.  Applied to the emitted bytes, never to a receipt.
# ---------------------------------------------------------------------------
SHEET_PART = "xl/worksheets/sheet1.xml"
STYLES_PART = "xl/styles.xml"


def _label_column_narrowed(xml: str) -> str:
    match = re.search(r'<col width="(\d+(?:\.\d+)?)" ([^>]*?)min="2" max="2"/>', xml)
    if match is None:
        raise AssertionError("no <col min=2 max=2> element to narrow")
    if float(match.group(1)) <= 8:
        raise AssertionError("the label column is already narrow; the mutation is vacuous")
    return xml.replace(match.group(0), f'<col width="6" {match.group(2)}min="2" max="2"/>', 1)


def _first_labelled_row_hidden(xml: str) -> str:
    # A labelled BODY row -- below the frozen header split, so this is a
    # statement line an analyst reads rather than the sheet's own title. Hiding
    # the title row would break the renderer's sheet-identity preflight and the
    # run would be BLOCKED on the wrong question.
    split = re.search(r'<pane [^/]*ySplit="(\d+)"', xml)
    first_body_row = int(split.group(1)) + 1 if split else 1
    for match in re.finditer(r'<row r="(\d+)"([^>]*)>(.*?)</row>', xml, re.S):
        row, attributes, body = match.group(1), match.group(2), match.group(3)
        if "hidden" in attributes or int(row) <= first_body_row:
            continue
        if f'<c r="B{row}" ' in body and "<is><t>" in body:
            return xml.replace(
                f'<row r="{row}"{attributes}>', f'<row r="{row}"{attributes} hidden="1">', 1
            )
    raise AssertionError("no visible labelled body row to hide")


def _darkest_solid_fill_recoloured(xml: str) -> str:
    colours = set(re.findall(r'<fgColor rgb="(FF[0-9A-F]{6})"/>', xml))
    if not colours:
        raise AssertionError("no solid fgColor fills in the style table")
    darkest = min(colours, key=lambda rgb: sum(int(rgb[i:i + 2], 16) for i in (2, 4, 6)))
    return xml.replace(f'<fgColor rgb="{darkest}"/>', '<fgColor rgb="FF0B7A3A"/>')


def _source_blue_font_blackened(xml: str) -> str:
    # The non-bold, non-italic blue font IS the source-input provenance colour.
    pattern = r'<font><name val="Calibri"/><color rgb="FF0000FF"/><sz val="([\d.]+)"/></font>'
    matches = re.findall(pattern, xml)
    if len(matches) != 1:
        raise AssertionError(
            f"expected exactly one plain blue provenance font, found {len(matches)}"
        )
    return re.sub(
        pattern,
        lambda m: f'<font><name val="Calibri"/><color rgb="FF000000"/><sz val="{m.group(1)}"/></font>',
        xml,
        count=1,
    )


def _freeze_pane_removed(xml: str) -> str:
    if "<pane " not in xml:
        raise AssertionError("no frozen pane to remove")
    return re.sub(r"<pane [^/]*/>", "", xml, count=1)


def _gridlines_shown(xml: str) -> str:
    if 'showGridLines="0"' not in xml:
        raise AssertionError("gridlines are not suppressed; the mutation is vacuous")
    return xml.replace('showGridLines="0"', 'showGridLines="1"', 1)


MUTATORS = {
    "column_width_collapse": (SHEET_PART, _label_column_narrowed),
    "model_row_hidden": (SHEET_PART, _first_labelled_row_hidden),
    "section_band_fill_recoloured": (STYLES_PART, _darkest_solid_fill_recoloured),
    "source_font_colour_black": (STYLES_PART, _source_blue_font_blackened),
    "freeze_pane_removed": (SHEET_PART, _freeze_pane_removed),
    "gridlines_shown": (SHEET_PART, _gridlines_shown),
}


def apply_mutation(source: Path, target: Path, mutation_id: str) -> None:
    part, mutate = MUTATORS[mutation_id]
    changed = False
    with zipfile.ZipFile(source) as archive_in:
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive_out:
            for item in archive_in.infolist():
                payload = archive_in.read(item.filename)
                if item.filename == part:
                    text = payload.decode("utf-8")
                    mutated = mutate(text)
                    changed = mutated != text
                    payload = mutated.encode("utf-8")
                archive_out.writestr(item, payload)
    check(changed, f"mutation {mutation_id} left {part} byte-identical -- it is vacuous")
    for sidecar in (".row-map.json", ".plan.json", ".provenance-authority.json", ".model-ir-v3.json"):
        origin = Path(str(source) + sidecar)
        if origin.exists():
            shutil.copyfile(origin, Path(str(target) + sidecar))


# ---------------------------------------------------------------------------
# The two halves.
# ---------------------------------------------------------------------------
def read_file_half(xlsx: Path, plan: Path) -> dict:
    from verify.plan_reconstruction_oracle import verify_workbook

    report = verify_workbook(xlsx, plan)
    return {"status": report["status"], "finding_counts": report["finding_counts"]}


def read_style_authority_half(xlsx: Path, case: Path) -> str:
    completed = subprocess.run(
        [sys.executable, str(SCRIPTS / "verify" / "provenance_authority_oracle.py"),
         "--xlsx", str(xlsx), "--case", str(case)],
        cwd=ROOT, text=True, capture_output=True,
        env={**os.environ, "PYTHONPATH": str(SCRIPTS)}, timeout=600, check=False,
    )
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if not lines:
        raise AssertionError(f"provenance authority oracle produced no report: {completed.stderr[-2000:]}")
    return json.loads(lines[-1])["status"]


def read_visual_half(xlsx: Path, out: Path, baselines: Path, soffice: str,
                     *, update_baseline: bool = False, attribution: Path | None = None) -> dict:
    command = [
        sys.executable, "-m", "scripts.render.check_render", str(xlsx),
        "--out", str(out), "--sheet", SHEET, "--soffice", soffice,
        "--baselines", str(baselines), "--baseline-case", BASELINE_CASE,
    ]
    if update_baseline:
        command += ["--update-baseline", "--attribution", str(attribution)]
    completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True,
                               timeout=1800, check=False)
    evidence_path = out / f"{xlsx.stem}.render-evidence.json"
    if not evidence_path.exists():
        raise AssertionError(
            f"check_render wrote no evidence for {xlsx.name} "
            f"(exit {completed.returncode}):\n{completed.stdout[-3000:]}\n{completed.stderr[-3000:]}"
        )
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    block = evidence["sheets"][0]
    summary = block.get("summary") or {}
    regression = block.get("visual_regression") or {}
    pages = regression.get("pages") or []
    return {
        "verdict": evidence["verdict"],
        "sheet_verdict": block["verdict"],
        "checks_run": sorted(block.get("checks_run") or []),
        "page_count": block.get("page_count"),
        "defects": {name: counts.get("defect", 0)
                    for name, counts in summary.items() if counts.get("defect")},
        "page_count_mismatch": bool(regression.get("page_count_mismatch")),
        "unattributed_pages": list(regression.get("unattributed_pages") or []),
        "changed_pixels_total": sum(int(page.get("changed_pixels") or 0) for page in pages),
        "pages_compared": len(pages),
        "missing_baseline_pages": list(regression.get("missing_baseline_pages") or []),
    }


# ---------------------------------------------------------------------------
# The declaration is judged against the observations, in both directions.
# ---------------------------------------------------------------------------
VISUAL_SIGNALS = {
    "clipping_defects": lambda seen: seen["defects"].get("clipping", 0) > 0,
    "overlap_defects": lambda seen: seen["defects"].get("overlap", 0) > 0,
    "presence_defects": lambda seen: seen["defects"].get("presence", 0) > 0,
    "page_count_mismatch": lambda seen: seen["page_count_mismatch"],
    "pixel_regression_unattributed": lambda seen: bool(seen["unattributed_pages"]),
}


def evaluate(block: dict, observations: dict) -> list:
    """Judge one declared pairing table against one set of observations.

    Raises AssertionError on any disagreement.  Pure, so the governance
    mutations below can re-run it against the SAME observations.
    """
    verdicts = []
    declared_ids = [pairing["mutation_id"] for pairing in block["pairings"]]
    if sorted(declared_ids) != sorted(observations):
        raise AssertionError(
            f"declared pairings {sorted(declared_ids)} do not match the executed "
            f"mutations {sorted(observations)}"
        )
    if len(set(declared_ids)) != len(declared_ids):
        raise AssertionError("duplicate mutation_id in the pairing table")
    for pairing in block["pairings"]:
        mutation_id = pairing["mutation_id"]
        seen = observations[mutation_id]

        # FILE half: the declared finding code must be the one that actually fired.
        if seen["file"]["status"] == "PASS":
            raise AssertionError(f"{mutation_id}: the file geometry reader did not see the mutation at all")
        code = pairing["file_detector"]["finding_code"]
        if not seen["file"]["finding_counts"].get(code):
            raise AssertionError(
                f"{mutation_id}: declared file finding {code} did not fire; "
                f"observed {sorted(seen['file']['finding_counts'])}"
            )
        expected_authority = pairing["file_detector"].get("style_authority_status")
        if expected_authority is not None:
            if seen.get("style_authority") != expected_authority:
                raise AssertionError(
                    f"{mutation_id}: provenance authority oracle reported "
                    f"{seen.get('style_authority')}, declaration says {expected_authority}"
                )

        # VISUAL half.
        status = pairing["pairing_status"]
        detector = pairing.get("visual_detector")
        if status == "PAIRED":
            if detector is None:
                raise AssertionError(f"{mutation_id}: declared PAIRED with no visual detector")
            signal = detector["signal"]
            if signal not in VISUAL_SIGNALS:
                raise AssertionError(f"{mutation_id}: unknown visual signal {signal}")
            if not VISUAL_SIGNALS[signal](seen["visual"]):
                raise AssertionError(
                    f"{mutation_id}: declared visual signal {signal} did NOT fire "
                    f"(verdict {seen['visual']['verdict']}, defects {seen['visual']['defects']}, "
                    f"unattributed pages {seen['visual']['unattributed_pages']})"
                )
            if seen["visual"]["verdict"] == "PASS":
                raise AssertionError(f"{mutation_id}: declared PAIRED yet the render verdict is PASS")
        elif status == "NO_VISUAL_DETECTOR":
            if detector is not None:
                raise AssertionError(f"{mutation_id}: declared NO_VISUAL_DETECTOR yet names a detector")
            if not pairing.get("unpaired_reason"):
                raise AssertionError(f"{mutation_id}: an unpaired mutation must state why")
            if pairing.get("audit_class") != "visual_manual":
                raise AssertionError(
                    f"{mutation_id}: an unpaired reader-visible mutation must carry audit_class visual_manual"
                )
            # Blindness is PROVEN, not inferred from silence: the render must be
            # pixel-identical to the baseline.
            if seen["visual"]["changed_pixels_total"] != 0:
                raise AssertionError(
                    f"{mutation_id}: declared invisible to the render, yet the pixel diff "
                    f"changed {seen['visual']['changed_pixels_total']} pixels -- a detector DOES exist"
                )
            if seen["visual"]["verdict"] != "PASS":
                raise AssertionError(
                    f"{mutation_id}: declared invisible to the render, yet the render verdict is "
                    f"{seen['visual']['verdict']}"
                )
            if seen["visual"]["defects"]:
                raise AssertionError(
                    f"{mutation_id}: declared invisible to the render, yet defects fired: "
                    f"{seen['visual']['defects']}"
                )
        else:
            raise AssertionError(f"{mutation_id}: unknown pairing_status {status}")
        verdicts.append({
            "mutation_id": mutation_id,
            "pairing_status": status,
            "file_finding_code": code,
            "file_findings": seen["file"]["finding_counts"].get(code),
            "style_authority_status": seen.get("style_authority"),
            "visual_signal": (detector or {}).get("signal"),
            "visual_verdict": seen["visual"]["verdict"],
            "visual_defects": seen["visual"]["defects"],
            "visual_changed_pixels": seen["visual"]["changed_pixels_total"],
            "audit_class": pairing.get("audit_class"),
        })
    if not any(item["pairing_status"] == "PAIRED" for item in verdicts):
        raise AssertionError("no mutation is PAIRED -- the table would be vacuous")
    return verdicts


# ---------------------------------------------------------------------------
def build_workbook(case_path: Path, work: Path) -> tuple[Path, Path]:
    source = json.loads(case_path.read_text(encoding="utf-8"))
    source["execution_profile"] = "reference_parity"
    source.setdefault("controls", {})["broker_case"] = "Model Consensus"
    case = work / "case.json"
    case.write_text(json.dumps(source, indent=2) + "\n", encoding="utf-8")
    workbook = work / "candidate.xlsx"
    for command, env in (
        (["node", str(SCRIPTS / "build_dynamic_model.mjs"), str(case),
          "--out", str(workbook), "--plan-only"], None),
        ([sys.executable, "-m", "emit", "build", f"{workbook}.plan.json", "--out", str(workbook)],
         {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(SCRIPTS)}),
    ):
        completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True,
                                   env=env, timeout=1800, check=False)
        if completed.returncode != 0:
            raise AssertionError(
                f"workbook build failed: {' '.join(command[:3])}\n"
                f"{completed.stdout[-3000:]}\n{completed.stderr[-3000:]}"
            )
    return workbook, case


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--soffice", default=None)
    parser.add_argument("--case", type=Path, default=DEFAULT_CASE)
    parser.add_argument("--work", type=Path, default=None,
                        help="keep the built workbook, renders and diffs here")
    args = parser.parse_args()

    matrix = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))

    # ---- 1. The scope is DECLARED, and the declaration is well formed. ----
    block = matrix.get("rendered_geometry_scope")
    check(block is not None,
          "assets/critical-invariant-oracle-matrix-v1.json declares no rendered_geometry_scope: "
          "geometry is absent from the oracle matrix as a domain")
    check(block["scope"] == "rendered_geometry", "the scope must be named rendered_geometry")
    check(bool(block.get("why_not_a_domains_entry")),
          "a scope declared outside `domains` must say why, or it reads as an evasion")
    check(block.get("pairing_oracle") == "scripts/run_visual_mutation_pairing_tests.py",
          "the scope must name the oracle that proves it")
    check(Path(ROOT / block["pairing_oracle"]).resolve() == Path(__file__).resolve(),
          "the scope's named pairing oracle is not this file")

    # The declared audit class must be one the registry actually allows: this is
    # what stops `visual_manual` from being a word nothing refers to.
    allowed = registry["metadata_contract"]["allowed_audit_classes"]
    check(block.get("audit_class") in allowed,
          f"rendered_geometry audit class {block.get('audit_class')!r} is not in the registry's "
          f"allowed_audit_classes {allowed}")
    check(block["audit_class"] == "visual_manual",
          "rendered_geometry must carry the visual_manual audit class -- that class is what the "
          "print-render-blind half of this scope IS")

    # Every reader the scope names must exist on disk.
    for role, reader in block["readers"].items():
        check((ROOT / reader["path"]).exists(), f"declared reader {role} is missing: {reader['path']}")

    # `rendered_geometry` is not smuggled into the pinned `domains` list, and the
    # five NOT_INDEPENDENTLY_PROVEN flags P7.6a set are still there.
    domain_names = {entry["domain"] for entry in matrix["domains"]}
    check("rendered_geometry" not in domain_names,
          "rendered_geometry must not be added to `domains`: that array is pinned element-for-element "
          "by run_critical_invariant_oracle_matrix_tests.py and admits only two evidence scopes")
    # P7.6a marked five domains NOT_INDEPENDENTLY_PROVEN because they had no
    # production-touching detector. That flag may leave a domain only when a real
    # detector arrives WITH a record of what replaced it -- never by being quietly
    # dropped. A later package may legitimately promote one (P5.5 promoted
    # workbook_error_scan to emitted_workbook_cell); silence is still refused.
    P7_6A_FLAGGED = {"broker_period", "ebitda_basis", "instrument_identity",
                     "typed_unresolved_state", "workbook_error_scan"}
    by_domain = {entry["domain"]: entry for entry in matrix["domains"]}
    for domain in sorted(P7_6A_FLAGGED):
        entry = by_domain.get(domain)
        check(entry is not None, f"P7.6a-flagged domain {domain} vanished from the matrix")
        if entry.get("independence") == "NOT_INDEPENDENTLY_PROVEN":
            check(entry.get("evidence_scope") == "synthetic_unit_only",
                  f"{domain} is flagged NOT_INDEPENDENTLY_PROVEN but no longer synthetic_unit_only")
            continue
        check(entry.get("evidence_scope") not in (None, "synthetic_unit_only"),
              f"{domain} lost its NOT_INDEPENDENTLY_PROVEN flag while still synthetic_unit_only")
        check(bool(entry.get("promoted_from")),
              f"{domain} lost its NOT_INDEPENDENTLY_PROVEN flag with no `promoted_from` record "
              "saying what detector replaced the synthetic unit fact")
    for entry in matrix["domains"]:
        if entry.get("evidence_scope") == "synthetic_unit_only":
            check(entry.get("independence") == "NOT_INDEPENDENTLY_PROVEN",
                  f"{entry['domain']} is synthetic_unit_only and claims independence")

    # ---- 2. Host fitness, declared and fail-closed. ----
    soffice = resolve_soffice(args.soffice)
    versions = require_render_modules()

    work_context = None
    if args.work:
        args.work.mkdir(parents=True, exist_ok=True)
        work = args.work
    else:
        work_context = tempfile.TemporaryDirectory(prefix="p58-visual-pairing-")
        work = Path(work_context.name)

    try:
        workbook, case = build_workbook(args.case, work)
        plan = Path(f"{workbook}.plan.json")
        check(plan.exists(), "the build produced no plan sidecar to reconstruct against")
        baselines = work / "baselines"
        attribution = work / "attribution.json"
        attribution.write_text(json.dumps({
            "reason": "P5.8 authors the pixel baseline from the UNMUTATED build of this run, in this "
                      "run's own scratch directory, purely so the mutants below have something to be "
                      "diffed against. It is never compared against a later build and never shipped.",
        }, indent=2) + "\n", encoding="utf-8")

        # ---- 3. Negative control. A detector that fires on everything is not a detector. ----
        clean_file = read_file_half(workbook, plan)
        check(clean_file["status"] == "PASS",
              f"negative control: the unmutated workbook already fails the file reader: {clean_file}")
        check(clean_file["finding_counts"] == {},
              "negative control: the unmutated workbook already carries reconstruction findings")
        clean_authority = read_style_authority_half(workbook, case)
        check(clean_authority == "PASS",
              f"negative control: provenance authority already {clean_authority} before any mutation")
        clean_visual = read_visual_half(workbook, work / "render-baseline", baselines, soffice,
                                        update_baseline=True, attribution=attribution)
        clean_compare = read_visual_half(workbook, work / "render-control", baselines, soffice)
        check(clean_compare["verdict"] == "PASS",
              f"negative control: the unmutated workbook does not render clean: {clean_compare}")
        check(clean_compare["changed_pixels_total"] == 0,
              "negative control: the unmutated workbook differs from its own baseline")
        check(clean_compare["defects"] == {},
              f"negative control: the unmutated render already reports defects {clean_compare['defects']}")
        check(clean_compare["pages_compared"] > 0 and not clean_compare["missing_baseline_pages"],
              "negative control: no page was actually compared -- the visual half is vacuous")
        check(set(clean_compare["checks_run"]) >= {"clipping", "presence", "overlap", "structure"},
              f"the visual half did not run the geometry checks: {clean_compare['checks_run']}")

        # ---- 4. Observe every declared mutation on both halves. ----
        declared = [pairing["mutation_id"] for pairing in block["pairings"]]
        check(sorted(declared) == sorted(MUTATORS),
              f"the declared pairings {sorted(declared)} and the implemented mutations "
              f"{sorted(MUTATORS)} disagree")
        observations = {}
        for mutation_id in declared:
            mutant = work / f"mutant-{mutation_id}.xlsx"
            apply_mutation(workbook, mutant, mutation_id)
            observations[mutation_id] = {
                "file": read_file_half(mutant, plan),
                "visual": read_visual_half(mutant, work / f"render-{mutation_id}", baselines, soffice),
            }
            if any(pairing["mutation_id"] == mutation_id
                   and pairing["file_detector"].get("style_authority_status") is not None
                   for pairing in block["pairings"]):
                observations[mutation_id]["style_authority"] = read_style_authority_half(mutant, case)

        # ---- 5. Judge the declaration against the observations. ----
        verdicts = evaluate(block, observations)
        for verdict in verdicts:
            check(True, f"pairing {verdict['mutation_id']} agrees with its declaration")

        # ---- 6. Governance mutations: the table cannot lie in either direction. ----
        governance = {}

        def governance_mutation(name, mutate):
            candidate = copy.deepcopy(block)
            mutate(candidate)
            try:
                evaluate(candidate, observations)
            except AssertionError:
                governance[name] = True
            else:
                raise AssertionError(f"pairing-table governance mutation escaped: {name}")

        paired = next(p for p in block["pairings"] if p["pairing_status"] == "PAIRED")
        unpaired = next(p for p in block["pairings"] if p["pairing_status"] == "NO_VISUAL_DETECTOR")

        def claim_detector_for_blind_mutation(candidate):
            for pairing in candidate["pairings"]:
                if pairing["mutation_id"] == unpaired["mutation_id"]:
                    pairing["pairing_status"] = "PAIRED"
                    pairing["visual_detector"] = {
                        "oracle": "scripts/render/check_render.py",
                        "signal": "pixel_regression_unattributed",
                    }

        def disclaim_a_detector_that_fires(candidate):
            for pairing in candidate["pairings"]:
                if pairing["mutation_id"] == paired["mutation_id"]:
                    pairing["pairing_status"] = "NO_VISUAL_DETECTOR"
                    pairing["visual_detector"] = None
                    pairing["unpaired_reason"] = "claimed invisible"
                    pairing["audit_class"] = "visual_manual"

        def wrong_file_finding_code(candidate):
            candidate["pairings"][0]["file_detector"]["finding_code"] = "RECON_NOT_A_REAL_CODE"

        def drop_a_mutation(candidate):
            candidate["pairings"] = candidate["pairings"][:-1]

        def unpaired_without_a_reason(candidate):
            for pairing in candidate["pairings"]:
                if pairing["mutation_id"] == unpaired["mutation_id"]:
                    pairing["unpaired_reason"] = ""

        def unpaired_without_the_manual_class(candidate):
            for pairing in candidate["pairings"]:
                if pairing["mutation_id"] == unpaired["mutation_id"]:
                    pairing["audit_class"] = "unit"

        def wrong_style_authority_status(candidate):
            for pairing in candidate["pairings"]:
                if pairing["file_detector"].get("style_authority_status") is not None:
                    pairing["file_detector"]["style_authority_status"] = "PASS"

        def all_unpaired(candidate):
            for pairing in candidate["pairings"]:
                pairing["pairing_status"] = "NO_VISUAL_DETECTOR"
                pairing["visual_detector"] = None
                pairing["unpaired_reason"] = "claimed invisible"
                pairing["audit_class"] = "visual_manual"

        for name, mutate in (
            ("claim_detector_for_blind_mutation", claim_detector_for_blind_mutation),
            ("disclaim_a_detector_that_fires", disclaim_a_detector_that_fires),
            ("wrong_file_finding_code", wrong_file_finding_code),
            ("drop_a_mutation", drop_a_mutation),
            ("unpaired_without_a_reason", unpaired_without_a_reason),
            ("unpaired_without_the_manual_class", unpaired_without_the_manual_class),
            ("wrong_style_authority_status", wrong_style_authority_status),
            ("all_unpaired", all_unpaired),
        ):
            governance_mutation(name, mutate)
            check(governance[name], f"governance mutation {name} was caught")

        # ---- 7. Adopt the design-contract harness: it is no longer an orphan. ----
        harness = block["readers"]["design_contract_mutation_harness"]
        completed = subprocess.run(["node", str(ROOT / harness["path"])], cwd=ROOT,
                                   text=True, capture_output=True, timeout=600, check=False)
        check(completed.returncode == 0,
              f"the adopted design-contract mutation harness failed: {completed.stderr[-2000:]}")
        harness_report = json.loads(completed.stdout)
        check(harness_report["status"] == "PASS", "the design-contract mutation harness is not green")
        check(harness_report["caught"] == harness_report["total"] and harness_report["total"] >= 15,
              f"the design-contract harness killed {harness_report['caught']}/{harness_report['total']}")
        check(harness_report["vacuous"] == 0,
              "a design-contract mutation visited zero checks -- the harness would be decorative")
        # Its own style/geometry mutations must be the ones the scope names.
        killed = {result["mutation"] for result in harness_report["results"] if result["caught"]}
        for mutation_id in harness["style_geometry_mutations"]:
            check(mutation_id in killed,
                  f"design-contract style/geometry mutation {mutation_id} was not killed")
        validator = subprocess.run(
            ["node", str(ROOT / "scripts" / "validate_standardised_design_contract.mjs")],
            cwd=ROOT, text=True, capture_output=True, timeout=600, check=False)
        check(validator.returncode == 0,
              f"the design contract itself does not validate: {validator.stdout[-2000:]}")
        validator_report = json.loads(validator.stdout.strip().splitlines()[-1])
        check(validator_report["status"] == "PASS" and validator_report["visited"] > 0,
              "the design-contract validator is not green, or visited nothing")

        report = {
            "schema_version": "visual-mutation-pairing-report/1.0",
            "status": "PASS",
            "checks": CHECKS,
            "scope": "rendered_geometry",
            "audit_class": block["audit_class"],
            "artifact_origin": "real_workbook_emission_rendered_through_libreoffice",
            "host": {
                "soffice": soffice,
                "interpreter": sys.executable,
                "modules": versions,
                "render_lane_available": True,
            },
            "negative_control": {
                "file": clean_file["status"],
                "style_authority": clean_authority,
                "render_verdict": clean_compare["verdict"],
                "baseline_pages": clean_visual["pages_compared"] or clean_compare["pages_compared"],
                "changed_pixels": clean_compare["changed_pixels_total"],
            },
            "pairings": verdicts,
            "paired": sum(1 for item in verdicts if item["pairing_status"] == "PAIRED"),
            "no_visual_detector": sorted(item["mutation_id"] for item in verdicts
                                         if item["pairing_status"] == "NO_VISUAL_DETECTOR"),
            "governance_mutations_caught": len(governance),
            "design_contract_harness": {
                "path": harness["path"],
                "caught": harness_report["caught"],
                "total": harness_report["total"],
                "vacuous": harness_report["vacuous"],
                "validator_checks_visited": validator_report["visited"],
                "verdict": "ADOPTED_AS_SUBORDINATE_ORACLE",
            },
            "total_violations": 0,
        }
        print(json.dumps(report, sort_keys=True))
        return 0
    finally:
        if work_context is not None:
            work_context.cleanup()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Blocked as blocked:
        print(json.dumps({
            "schema_version": "visual-mutation-pairing-report/1.0",
            "status": "BLOCKED",
            "checks": CHECKS,
            "reason": str(blocked),
            "render_lane_available": False,
            "needed": [
                "a LibreOffice binary (soffice) able to convert .xlsx to PDF",
                "one interpreter that imports openpyxl AND fitz (PyMuPDF) together",
            ],
            "note": "BLOCKED is not PASS. The visual half cannot be faked; a host that "
                    "cannot render must not report a pairing it never observed.",
        }, sort_keys=True))
        raise SystemExit(1)
