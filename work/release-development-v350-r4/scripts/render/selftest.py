#!/usr/bin/env python3
"""Prove that each render check fires on a defect and stays silent on a clean page.

    python3 -m scripts.render.selftest <reference.xlsx> --fixtures <dir>

Uses `synth.py` to lay out a PDF with known geometry from a real workbook, then
injects one fault at a time and asserts that exactly the corresponding check
reports it.  This does not need LibreOffice, so the checks can be validated even
where LibreOffice is unavailable -- but passing this self-test proves only that
the CHECKS work, never that any workbook renders correctly.  That still requires
a real conversion.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, List, Optional, Sequence

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    __package__ = "scripts.render"

from . import baseline as baseline_mod  # noqa: E402
from . import calibrate, cfeval, checks, pdfdoc, rowmap, synth  # noqa: E402
from . import xlsx_model as xm  # noqa: E402


def _setup(workbook_path: str, sheet_name: str):
    workbook = xm.load_workbook(workbook_path)
    sheet = workbook.sheet_by_name(sheet_name)
    row_map = rowmap.load_for_workbook(workbook_path)
    numeric = [xm.col_letters_to_index(c) for c in row_map.numeric_column_letters()]
    label_col = xm.col_letters_to_index(row_map.label_column())
    first_col, last_col = 1, max(numeric + [label_col, sheet.max_col])
    first_row, last_row = 1, row_map.visible_end_row or sheet.max_row
    return workbook, sheet, row_map, first_col, last_col, first_row, last_row, numeric, label_col


def _analyse(pdf_path, workbook, sheet, row_map, first_col, last_col, first_row, last_row,
             numeric, label_col, *, expected_fonts=None):
    rendered = pdfdoc.open_pdf(pdf_path)
    findings: List[checks.Finding] = []
    findings.extend(checks.check_font_set(rendered, expected_fonts))
    grid = calibrate.build_grid(rendered, sheet, workbook, first_col, last_col,
                                first_row, last_row, numeric, label_col)
    assigned = checks.assign_words(grid, rendered, workbook, sheet)
    assigned.pop((-1, -1), None)
    row_ids = {row: rid for rid, row in row_map.rows_by_id.items()}
    metrics = checks.fit_text_metrics(rendered)
    sampler = checks.Sampler(rendered, dpi=150)
    findings.extend(checks.check_presence(workbook, sheet, grid, assigned, row_ids))
    findings.extend(checks.check_clipping(workbook, sheet, grid, assigned, metrics, row_ids))
    findings.extend(checks.check_overlap(grid, assigned, row_ids))
    findings.extend(checks.check_alignment(grid, assigned, numeric, sheet, workbook))
    findings.extend(checks.check_structure(workbook, sheet, grid, assigned, sampler, row_map))
    findings.extend(checks.check_conditional_formatting(workbook, sheet, grid, assigned, sampler))
    result = {"grid": grid, "findings": findings, "rendered": rendered}
    return result


def _bad(findings, check: str) -> List[checks.Finding]:
    return [f for f in findings if f.check == check and f.severity in (checks.DEFECT, checks.BLOCKED)]


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workbook")
    parser.add_argument("--sheet", default="Operating Model")
    parser.add_argument("--fixtures", required=True)
    args = parser.parse_args(argv)

    os.makedirs(args.fixtures, exist_ok=True)
    setup = _setup(args.workbook, args.sheet)
    workbook, sheet, row_map, first_col, last_col, first_row, last_row, numeric, label_col = setup

    label_row = row_map.row("revenue") if row_map.maybe_row("revenue") else first_row + 20
    numeric_col = numeric[3] if len(numeric) > 3 else numeric[0]

    # A clipping fixture needs a TEXT cell whose right-hand neighbour is
    # occupied; overflow into an empty neighbour is legal and must not fire.
    clip_target = None
    for row in range(first_row, last_row + 1):
        for col in range(first_col, last_col):
            cell, neighbour = sheet.cell(row, col), sheet.cell(row, col + 1)
            if cell is None or neighbour is None or cell.is_empty or neighbour.is_empty:
                continue
            if xm.cell_is_numeric(cell):
                continue
            clip_target = (row, col)
            break
        if clip_target:
            break

    # An overlap fixture needs two ADJACENT numeric cells in the same row.
    overlap_target = None
    for row in range(first_row, last_row + 1):
        for left, right in zip(numeric, numeric[1:]):
            if right != left + 1:
                continue
            a, b = sheet.cell(row, left), sheet.cell(row, right)
            if a is None or b is None or a.is_empty or b.is_empty:
                continue
            if xm.cell_is_numeric(a) and xm.cell_is_numeric(b):
                overlap_target = (row, right)
                break
        if overlap_target:
            break

    # A structure fixture needs a cell the row plan calls a navy section band.
    band_target = None
    section_rows = sorted(row_map.section_header_rows.values())
    if section_rows:
        band_target = (section_rows[0], label_col)

    cf_target = None
    for rule in sheet.cf_rules:
        outcome = cfeval.evaluate_rule(workbook, sheet, rule)
        if outcome.fires:
            cf_target = xm.split_ref(outcome.fires[0])
            break

    scenarios = [
        ("clean", [], None),
        ("missing_text", [synth.Fault("missing_text", label_row, label_col)], "presence"),
        ("misaligned_column", [synth.Fault("misalign", label_row, numeric_col, {"pt": 4.0})], "alignment"),
    ]
    if clip_target:
        scenarios.append((
            "clipped_label",
            [synth.Fault("widen_label", clip_target[0], clip_target[1], {"factor": 1.4})],
            "clipping",
        ))
    if overlap_target:
        scenarios.append((
            "overlapping_text",
            [synth.Fault("overlap_left", overlap_target[0], overlap_target[1], {"pt": 4.0})],
            "overlap",
        ))
    if band_target:
        scenarios.append((
            "band_split",
            [synth.Fault("wrong_fill", band_target[0], band_target[1], {"rgb": "FFFFFF"})],
            "structure",
        ))
    if cf_target:
        scenarios.append(("cf_not_fired",
                          [synth.Fault("cf_not_fired", cf_target[0], cf_target[1])],
                          "conditional_formatting"))

    report: Dict[str, dict] = {}
    failures: List[str] = []
    clean_signatures: set = set()
    report["_targets"] = {
        "clip": clip_target, "overlap": overlap_target, "band": band_target,
        "cf": cf_target, "label_row": label_row, "numeric_col": numeric_col,
    }
    for name, target in (("clip", clip_target), ("overlap", overlap_target),
                         ("band", band_target), ("cf", cf_target)):
        if target is None:
            failures.append("no %s fixture target found in %s -- that check is UNPROVEN"
                            % (name, args.workbook))

    for name, faults, expected_check in scenarios:
        pdf_path = os.path.join(args.fixtures, "%s.pdf" % name)
        plan = synth.render(workbook, sheet, pdf_path,
                            first_col=first_col, last_col=last_col,
                            first_row=first_row, last_row=last_row, faults=faults)
        analysis = _analyse(pdf_path, workbook, sheet, row_map, first_col, last_col,
                            first_row, last_row, numeric, label_col,
                            expected_fonts={"Helvetica"})
        findings = analysis["findings"]
        grid = analysis["grid"]

        entry = {
            "pdf": pdf_path,
            "synth_scale": round(plan.scale, 6),
            "recovered_scale": round(grid.horizontal.scale, 6),
            "scale_error": round(abs(plan.scale - grid.horizontal.scale) / plan.scale, 6),
            "synth_pages": [list(p) for p in plan.pages],
            "recovered_pages": [[f.first_row, f.last_row] for f in grid.pages],
            # Named, not blended in: a page too thin to regress a row grid
            # against has its grid inherited from the page before it and then
            # verified against the rows it does carry.  Reporting that as an
            # ordinary fit would overstate what was measured.
            "page_grid_source": [f.grid_source for f in grid.pages],
            "inherited_pages": grid.vertical.get("inherited_pages") or [],
            "defects": {c: len(_bad(findings, c)) for c in
                        ("font_set", "presence", "clipping", "overlap", "alignment",
                         "structure", "conditional_formatting")},
            "expected_check": expected_check,
        }
        entry["defects_total"] = sum(entry["defects"].values())
        report[name] = entry

        signatures = {(f.check, f.row, f.column, f.message)
                      for f in findings if f.severity in (checks.DEFECT, checks.BLOCKED)}

        if name == "clean":
            clean_signatures = signatures
            if entry["scale_error"] > 0.005:
                failures.append("clean: calibration recovered scale %.4f vs synthesised %.4f"
                                % (grid.horizontal.scale, plan.scale))
            if entry["recovered_pages"] != entry["synth_pages"]:
                failures.append("clean: pagination recovered %s vs synthesised %s"
                                % (entry["recovered_pages"], entry["synth_pages"]))
            entry["residual_defects"] = [f.as_dict() for f in findings
                                         if f.severity in (checks.DEFECT, checks.BLOCKED)]
            entry["residual_note"] = (
                "The synthetic renderer draws with Helvetica, which is wider than "
                "Carlito for many strings, so residual clipping findings here are "
                "artefacts of the fixture and say nothing about the real models. "
                "Each fault below is judged DIFFERENTIALLY against this set."
            )
        else:
            # Differential: the fault must produce a finding of the expected check
            # that the clean render did not already produce.
            new = [f for f in findings
                   if f.check == expected_check
                   and f.severity in (checks.DEFECT, checks.BLOCKED)
                   and (f.check, f.row, f.column, f.message) not in clean_signatures]
            if not new:
                failures.append("%s: check %r produced no NEW finding" % (name, expected_check))
            entry["new_findings"] = [f.as_dict() for f in new[:3]]

        analysis["rendered"].close()

    # A negative control for the font check: the same clean PDF must be BLOCKED
    # when Carlito is expected, because Helvetica is not metric-compatible.
    rendered = pdfdoc.open_pdf(os.path.join(args.fixtures, "clean.pdf"))
    font_findings = checks.check_font_set(rendered, {"Carlito"})
    rendered.close()
    blocked = [f for f in font_findings if f.severity == checks.BLOCKED]
    report["font_substitution"] = {
        "expected": ["Carlito"],
        "observed": font_findings[0].detail["observed"],
        "blocked": bool(blocked),
    }
    if not blocked:
        failures.append("font_substitution: an unexpected font family did not BLOCK")

    # ---- visual regression baseline -------------------------------------
    # Create a baseline from the clean render, then diff a faulted render
    # against it: an unattributed pixel change must be reported, and the same
    # change must clear once it is attributed.
    baseline_dir = os.path.join(args.fixtures, "baselines")
    work = os.path.join(args.fixtures, "baseline-work")
    clean = pdfdoc.open_pdf(os.path.join(args.fixtures, "clean.pdf"))
    # Creating a baseline is an EXPLICIT act, here as everywhere: the self-test
    # says so with --update-baseline's in-process equivalent and a stated reason.
    # It writes into its own synthetic fixtures tree, never the shipping
    # baselines under render-fixtures/baselines/.
    created = baseline_mod.compare(
        clean, "selftest", baseline_dir, work, dpi=72, update=True,
        attribution={"reason": "self-test fixture baseline, laid out by synth.py "
                               "from a PDF of known geometry"},
    )
    same = baseline_mod.compare(clean, "selftest", baseline_dir, work, dpi=72)
    faulted_pdf = os.path.join(args.fixtures, "band_split.pdf")
    changed = None
    attributed = None
    if os.path.exists(faulted_pdf):
        faulted = pdfdoc.open_pdf(faulted_pdf)
        changed = baseline_mod.compare(faulted, "selftest", baseline_dir, work, dpi=72)
        attributed = baseline_mod.compare(
            faulted, "selftest", baseline_dir, work, dpi=72,
            attribution={"reason": "deliberate band-fill change",
                         "pages": [d.page for d in changed.unattributed_changes]},
        )
        faulted.close()

    # A comparison run against a case with NO baseline must BLOCK and must not
    # author the picture it was about to compare against.  Proved here, not
    # asserted: the directory is listed before and after.
    absent_case = "selftest-no-such-baseline"
    absent_dir = os.path.join(baseline_dir, absent_case)
    before = os.path.isdir(absent_dir)
    missing = baseline_mod.compare(clean, absent_case, baseline_dir, work, dpi=72)
    after = os.path.isdir(absent_dir)
    refused_without_reason = None
    try:
        baseline_mod.compare(clean, "selftest", baseline_dir, work, dpi=72, update=True)
        refused_without_reason = False
    except baseline_mod.BaselineWriteRefused:
        refused_without_reason = True

    # A pixel baseline is also bound to its raster producer. MuPDF and Poppler
    # can paint the same valid PDF differently, so cross-backend comparison
    # must BLOCK rather than manufacture a visual regression. The synthetic
    # tree gains a temporary production-style manifest only for this probe.
    manifest_path = os.path.join(baseline_dir, "BASELINES.json")
    mismatched_backend = "poppler" if clean.raster_backend == "pymupdf" else "pymupdf"
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump({"schema": "render-baselines/selftest", "raster_backend": mismatched_backend}, handle)
        handle.write("\n")
    backend_mismatch = baseline_mod.compare(
        clean, "selftest", baseline_dir, work, dpi=72)
    os.remove(manifest_path)
    clean.close()

    report["visual_regression"] = {
        "created_pages": len(created.page_diffs),
        "identical_rerun_unattributed": [d.page for d in same.unattributed_changes],
        "faulted_unattributed": [d.page for d in changed.unattributed_changes] if changed else None,
        "faulted_after_attribution": [d.page for d in attributed.unattributed_changes] if attributed else None,
        "missing_baseline_mode": missing.mode,
        "missing_baseline_blocked": missing.blocked,
        "missing_baseline_dir_existed_before": before,
        "missing_baseline_dir_exists_after": after,
        "update_without_reason_refused": refused_without_reason,
        "raster_backend": clean.raster_backend,
        "mismatched_backend": mismatched_backend,
        "backend_mismatch_blocked": backend_mismatch.blocked,
    }
    if same.unattributed_changes:
        failures.append("baseline: an identical re-render reported a pixel change")
    if changed is not None and not changed.unattributed_changes:
        failures.append("baseline: a changed render reported no unattributed pixel change")
    if attributed is not None and attributed.unattributed_changes:
        failures.append("baseline: an attributed change was still reported as unattributed")
    if not missing.blocked:
        failures.append("baseline: a comparison against a missing baseline did not BLOCK")
    if after:
        failures.append(
            "baseline: a comparison run CREATED %s -- the gate authored its own "
            "expected output" % absent_dir)
    if not refused_without_reason:
        failures.append("baseline: an update with no attribution reason was not refused")
    if not backend_mismatch.blocked:
        failures.append("baseline: a cross-raster-backend comparison did not BLOCK")

    report["_verdict"] = "PASS" if not failures else "FAIL"
    report["_failures"] = failures
    report["_note"] = (
        "Passing proves the CHECKS fire correctly against a layout of known "
        "geometry. It does NOT prove any workbook renders correctly -- that "
        "requires a real LibreOffice conversion."
    )

    out = os.path.join(args.fixtures, "selftest-report.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")

    # Reporting is driven by what each entry IS, not by excluding the names that
    # happen to be known.  The previous version printed everything that did not
    # start with "_" as a scenario and crashed with KeyError: 'scale_error' the
    # moment a non-scenario entry (`visual_regression`) was added -- after every
    # check had already run and passed.  A summariser that cannot survive a new
    # entry hides its own results.
    scenario_names = [name for name, _faults, _check in scenarios]
    for name in scenario_names:
        entry = report[name]
        print("%-20s scale_err=%.5f pages=%s grid=%s defects=%s"
              % (name, entry["scale_error"], entry["recovered_pages"] == entry["synth_pages"],
                 ",".join(s[0] for s in entry["page_grid_source"]), entry["defects"]))
    font = report["font_substitution"]
    print("%-20s blocked=%s observed=%s" % ("font_substitution", font["blocked"], font["observed"]))
    visual = report["visual_regression"]
    print("%-20s baseline_pages=%s rerun_unattributed=%s faulted_unattributed=%s "
          "after_attribution=%s missing_baseline=%s created_on_compare=%s "
          "update_without_reason_refused=%s backend_mismatch_blocked=%s"
          % ("visual_regression", visual["created_pages"],
             visual["identical_rerun_unattributed"], visual["faulted_unattributed"],
             visual["faulted_after_attribution"], visual["missing_baseline_mode"],
             visual["missing_baseline_dir_exists_after"],
             visual["update_without_reason_refused"],
             visual["backend_mismatch_blocked"]))
    unreported = [k for k in report
                  if not k.startswith("_") and k not in scenario_names
                  and k not in ("font_substitution", "visual_regression")]
    if unreported:
        print("%-20s %s" % ("(unsummarised)", ", ".join(sorted(unreported))))
    print("\n%s  (%s)" % (report["_verdict"], out))
    for failure in failures:
        print("  FAILURE: %s" % failure)
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
