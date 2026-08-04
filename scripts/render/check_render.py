#!/usr/bin/env python3
"""G1 node N14 -- rendered-geometry checks for an emitted workbook.

    python3 -m scripts.render.check_render <workbook.xlsx> [more.xlsx ...] \
        --out <folder> [--baselines <folder>] [--update-baseline]
        [--attribution <file.json>] [--baseline-row-model excel-compat|declared]
        [--sheet "Operating Model"]
        [--soffice /path/to/soffice] [--expect-pages N] [--probe]

Writes `<out>/<case>.render-evidence.json` plus the page PNGs, and prints a
verdict per case and per sheet.  Exit status is 0 only if every case is PASS.

EVERY VISIBLE SHEET, NOT JUST THE OPERATING MODEL
-------------------------------------------------
`--sheet` now restricts; it no longer defaults.  Until it did, this gate
rendered the Operating Model and nothing else, and the Brokers sheet's 450
conditional-format rules across the eight shipping cases produced not one
finding.  That is precisely where, on 2026-07-26, a broker-case toggle was
found invisible on 5 of 6 cases -- a rule that existed in the XML and never
fired -- and it was found by accident, not by this gate.  A check that does not
examine a thing reports nothing about it, and that reads as silence rather than
absence.

Staging is per sheet, because pagination is per sheet: print area, the
fit-to-width decision, page count and pixel baselines all belong to one sheet's
layout.

COVERAGE IS PER SHEET AND IS NOT UNIFORM
-----------------------------------------
The Operating Model has a row-map sidecar, so it gets the full cell-geometry and
structure suite. Support sheets have no row identities and their sparse,
repeating labels do not support a trustworthy inferred grid. They therefore get
font-family checking, declared conditional-format checking and an exact
full-page pixel regression. Presence, clipping, overlap, alignment and sampled
conditional-format geometry are reported UNAVAILABLE there rather than run
against an invented grid. The approved pixel baseline is the visual oracle for
those sheets; without it the sheet is BLOCKED.

FAIL-CLOSED
-----------
PASS requires ALL of: conversion exited 0, page count matched expectation, every
planned cell located, zero clips, zero overlaps, font set exactly {Carlito}, and
the pixel diff empty or wholly attributed.  Conversion failure, timeout,
zero-byte PDF, missing PyMuPDF, an unlocatable cell, an unexpected font, a
MISSING BASELINE, or a producer whose row model does not match the baselines'
all return BLOCKED.

There is deliberately NO code path that turns any of those into a warning.  A
render stage that degrades to "warning" on a failed conversion is worse than no
render stage at all, because it converts a hard failure into a green tick: the
build goes green precisely when the evidence is missing.

THE GATE NEVER AUTHORS ITS OWN EXPECTED OUTPUT
----------------------------------------------
A comparison run cannot create or extend a baseline -- not on first run, not for
a page the baseline lacks.  Writing one requires `--update-baseline`, which
requires `--attribution` carrying a reason.  A missing baseline is BLOCKED; a
changed page count is a defect (FAIL) and is never resolved by extending the
baseline to fit.  See `baseline.py` for why.

HONEST LIMIT
------------
This proves LibreOffice rendering with Carlito.  It is authoritative for visual
regression and for clipping.  It is NOT authoritative for how the workbook looks
to an analyst in Microsoft Excel with Calibri -- that remains the human Excel
certification checklist (ARCHITECTURE §10).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

if __package__ in (None, ""):  # allow `python3 scripts/render/check_render.py`
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    __package__ = "scripts.render"

from . import baseline as baseline_mod  # noqa: E402
from . import calibrate, checks, pdfdoc, rowmap, soffice  # noqa: E402
from . import xlsx_model as xm  # noqa: E402

PASS = "PASS"
BLOCKED = "BLOCKED"
FAIL = "FAIL"

DEFAULT_SHEET = "Operating Model"

# The fail-closed set from ARCHITECTURE §11.
FAIL_CLOSED_CHECKS = ("font_set", "presence", "clipping", "overlap")


def case_name(workbook_path: str) -> str:
    return os.path.splitext(os.path.basename(workbook_path))[0]


def _file_evidence(path: str) -> dict:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "path": os.path.abspath(path),
        "sha256": digest.hexdigest(),
        "bytes": os.path.getsize(path),
    }


def _print_area(sheet: xm.Sheet, row_map: rowmap.RowMap):
    from . import xlsx_model as model

    numeric = [model.col_letters_to_index(c) for c in row_map.numeric_column_letters()]
    label = model.col_letters_to_index(row_map.label_column())
    first_col = 1
    last_col = max(numeric + [label, sheet.max_col])
    first_row = 1
    last_row = row_map.visible_end_row or sheet.max_row
    return first_col, last_col, first_row, last_row, numeric, label


def _derived_print_area(sheet: xm.Sheet):
    """Print range for a sheet the `.row-map.json` sidecar does not describe.

    The sidecar carries no sheet dimension at all -- its `rows_by_id`,
    `section_headers`, `controls` and `columns` are Operating Model rows and
    columns and nothing else -- so for any other sheet the range is measured
    from the sheet's own populated cells.

    This is deliberately a MEASUREMENT, not an identity.  Nothing here invents
    a row id: the columns are classified by what they actually contain, and
    every finding on such a sheet is addressed by physical row and column.  The
    checks that need real row identity are refused on these sheets rather than
    handed a fabricated one (see `SheetScope.unavailable_checks`).
    """
    populated = [c for c in sheet.cells.values() if not c.is_empty]
    if not populated:
        raise RuntimeError(
            "sheet %r has no populated cells, so no print range can be measured; "
            "BLOCKED rather than rendered as a blank page that would then 'pass'"
            % sheet.name
        )
    last_row = max(c.row for c in populated)
    last_col = max(c.col for c in populated)

    text_counts: Dict[int, int] = {}
    numeric_counts: Dict[int, int] = {}
    for cell in populated:
        if xm.cell_is_numeric(cell):
            numeric_counts[cell.col] = numeric_counts.get(cell.col, 0) + 1
        else:
            text_counts[cell.col] = text_counts.get(cell.col, 0) + 1

    if not text_counts:
        raise RuntimeError(
            "sheet %r carries no text column, so no label column can be measured "
            "and the row grid cannot be calibrated against one" % sheet.name
        )
    # The label column is the one carrying the most text: it is what the
    # vertical calibration matches rows against.
    label_col = max(sorted(text_counts), key=lambda c: text_counts[c])
    # A numeric column is one carrying enough numbers to regress a right edge
    # through.  check_alignment excludes non-numeric and non-right-aligned
    # cells itself and reports INFO when too few remain, so a generous
    # candidate set cannot manufacture an alignment defect.
    numeric_cols = sorted(c for c, n in numeric_counts.items() if n >= 3 and c != label_col)
    return 1, last_col, 1, last_row, numeric_cols, label_col


# The checks that need the `.row-map.json` sidecar's row identities, and so can
# only run on the sheet the sidecar describes.
ROW_IDENTITY_CHECKS = ("structure",)


@dataclass
class SheetScope:
    """One visible sheet, and an explicit statement of what can be asked of it.

    Coverage is per sheet and is named rather than implied.  A sheet the
    row-map does not describe still gets rendered, and still gets every check
    that is answerable from the workbook and the render alone -- but the checks
    that need row identity are listed as UNAVAILABLE with the reason, not
    quietly omitted and not fed a made-up identity.
    """

    name: str
    primary: bool
    first_col: int
    last_col: int
    first_row: int
    last_row: int
    numeric_cols: List[int]
    label_col: int
    fit_to_page: bool
    row_map: Optional[rowmap.RowMap]
    baseline_key: str
    geometry_addressing: str

    @property
    def unavailable_checks(self) -> Dict[str, str]:
        if self.primary:
            return {}
        return {
            name: (
                "the .row-map.json sidecar has no entry for sheet %r -- it carries a "
                "single unqualified set of Operating Model rows and columns "
                "(rows_by_id, section_headers, controls, columns) with no sheet "
                "dimension. This check is defined in terms of those identities, so "
                "it cannot be run here. It is reported unavailable rather than "
                "given invented identities, which would make it appear to cover a "
                "sheet it does not." % self.name
            )
            for name in ROW_IDENTITY_CHECKS
        }

    def as_dict(self) -> dict:
        return {
            "sheet": self.name,
            "primary": self.primary,
            "print_range": "%s%d:%s%d" % (
                xm.col_index_to_letters(self.first_col), self.first_row,
                xm.col_index_to_letters(self.last_col), self.last_row),
            "label_column": xm.col_index_to_letters(self.label_col),
            "numeric_columns": [xm.col_index_to_letters(c) for c in self.numeric_cols],
            "fit_to_width": self.fit_to_page,
            "baseline_key": self.baseline_key,
            "geometry_addressing": self.geometry_addressing,
            "row_map_covers_this_sheet": self.primary,
            "unavailable_checks": self.unavailable_checks,
        }


def sheet_scopes(
    workbook: xm.Workbook,
    row_map: rowmap.RowMap,
    case: str,
    *,
    primary_sheet: str = DEFAULT_SHEET,
    only: Optional[str] = None,
) -> List[SheetScope]:
    """Every visible sheet, with its measured print range and check scope.

    A check that visited nothing has not passed, and for the whole life of this
    gate the Brokers and Forward Curves sheets were never visited: `--sheet`
    defaulted to the Operating Model and nothing else was ever rendered.  The
    450 conditional-format rules on Brokers -- the sheet where a rule that
    existed in the XML and never fired was found BY ACCIDENT on 2026-07-26 --
    produced no findings at all, which read as silence rather than absence.
    """
    wanted = workbook.visible_sheets()
    if only is not None:
        wanted = [s for s in wanted if s.name == only]
        if not wanted:
            raise KeyError(
                "sheet %r is not a visible sheet of this workbook (visible: %s)"
                % (only, [s.name for s in workbook.visible_sheets()]))

    scopes: List[SheetScope] = []
    for sheet in wanted:
        primary = sheet.name == primary_sheet
        if primary:
            fc, lc, fr, lr, numeric, label = _print_area(sheet, row_map)
            addressing = (
                "row identity via .row-map.json; findings carry row_id")
        else:
            fc, lc, fr, lr, numeric, label = _derived_print_area(sheet)
            addressing = (
                "physical row and column measured from the sheet's own populated "
                "cells; findings carry no row_id because no row identity exists "
                "for this sheet")
        scopes.append(SheetScope(
            name=sheet.name,
            primary=primary,
            first_col=fc, last_col=lc, first_row=fr, last_row=lr,
            numeric_cols=list(numeric), label_col=label,
            fit_to_page=xm.needs_fit_to_width(sheet, fc, lc),
            row_map=row_map if primary else None,
            baseline_key=case if primary else "%s/%s" % (case, _slug(sheet.name)),
            geometry_addressing=addressing,
        ))
    if not scopes:
        raise RuntimeError(
            "no visible sheet to render; a gate that visited nothing has not passed")
    return scopes


def _slug(name: str) -> str:
    out = "".join(ch.lower() if ch.isalnum() else "-" for ch in name)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def _run_sheet(
    workbook_path: str,
    workbook: xm.Workbook,
    scope: SheetScope,
    case: str,
    case_out: str,
    *,
    baselines_dir: Optional[str] = None,
    structural_only: bool = False,
    update_baseline: bool = False,
    attribution: Optional[dict] = None,
    baseline_row_model: str = baseline_mod.BASELINE_ROW_MODEL,
    soffice_path: Optional[str] = None,
    expect_pages: Optional[int] = None,
    keep_pdf: bool = True,
    dpi: int = baseline_mod.BASELINE_DPI,
    timeout_s: float = 300.0,
) -> dict:
    """Render ONE visible sheet and check it.

    Staging is per sheet because pagination is per sheet: the print area, the
    fit-to-width decision, the page count and the pixel baselines all belong to
    a single sheet's layout and cannot be shared across a workbook.
    """
    sheet_name = scope.name
    evidence: dict = {
        "sheet": sheet_name,
        "primary": scope.primary,
        "verdict": BLOCKED,
        "scope": scope.as_dict(),
        "findings": [],
        "blocked_reason": None,
    }

    # Held outside the try so that anything already established survives a later
    # failure.  A sheet BLOCKED at calibration has still had its fonts and its
    # conditional-formatting declarations examined, and throwing those away
    # would report the sheet as unexamined when it was partly examined.
    findings: List[checks.Finding] = []

    workspace = tempfile.mkdtemp(prefix=".render-", dir=case_out)
    try:
        sheet = workbook.sheet_by_name(sheet_name)
        if sheet is None:
            raise KeyError("sheet %r not in %s" % (sheet_name, workbook_path))
        row_map = scope.row_map

        first_col, last_col = scope.first_col, scope.last_col
        first_row, last_row = scope.first_row, scope.last_row
        numeric_cols, label_col = scope.numeric_cols, scope.label_col

        evidence["print_range"] = {
            "first_col": xm.col_index_to_letters(first_col),
            "last_col": xm.col_index_to_letters(last_col),
            "first_row": first_row,
            "last_row": last_row,
            "label_column": xm.col_index_to_letters(label_col),
            "numeric_columns": [xm.col_index_to_letters(c) for c in numeric_cols],
            "gutter_columns": row_map.gutter_column_letters(
                xm.col_index_to_letters(first_col), xm.col_index_to_letters(last_col))
            if row_map is not None else None,
        }
        evidence["workbook_page_setup"] = {
            "had_page_setup": sheet.has_page_setup,
            "had_fit_to_page": sheet.fit_to_page,
            "had_print_area": any(k == "_xlnm.Print_Area" for k in workbook.defined_names),
            "page_setup_attrs": sheet.page_setup_attrs,
        }

        plan = xm.PageSetupPlan(
            sheet_name=sheet_name,
            first_col=first_col, last_col=last_col,
            first_row=first_row, last_row=last_row,
            fit_to_page=scope.fit_to_page,
        )
        staged = os.path.join(workspace, os.path.basename(workbook_path))
        evidence["page_setup_applied_by_renderer"] = xm.apply_page_setup(workbook_path, staged, plan)
        evidence["page_setup_note"] = (
            "The delivered workbook carries no print area or fit-to-width, so the "
            "renderer applies both to a throwaway copy before converting. Explicit "
            "page scaling does NOT survive LibreOffice (85%% became 100%%); "
            "fit-to-width does. Without deliberate pagination every clipping "
            "finding would be a pagination artefact. The delivered workbook is "
            "never modified and never sent back through LibreOffice. "
            "Fit-to-width is applied only where the print range is genuinely "
            "wider than the page (%s here at %.0fpt against %.0fpt printable): it "
            "magnifies as readily as it shrinks, and applying it to a narrow "
            "sheet paginates it into uncalibratable fragments. The staged copy "
            "also points the workbook's activeTab at this sheet, because "
            "LibreOffice will not hide the active sheet and would otherwise "
            "render a different sheet than the one asked for."
            % (scope.fit_to_page,
               xm.column_edges_pt(sheet, first_col, last_col)[-1],
               xm.PRINTABLE_WIDTH_PT)
        )

        conversion = soffice.convert_to_pdf(
            staged, workspace, soffice_path=soffice_path, timeout_s=timeout_s
        )
        evidence["conversion"] = {
            "soffice": conversion.soffice_path,
            "returncode": conversion.returncode,
            "duration_s": round(conversion.duration_s, 2),
            "pdf_bytes": conversion.pdf_bytes,
            "stderr_tail": conversion.stderr[-800:] or None,
        }

        rendered = pdfdoc.open_pdf(conversion.pdf_path)
        evidence["page_count"] = rendered.page_count
        evidence["page_size_pt"] = [
            [round(p.width, 1), round(p.height, 1)] for p in rendered.pages[:1]
        ]

        # The staged copy hides every other sheet, so the PDF must be this sheet
        # and nothing else.  Asserted rather than assumed: rendering the wrong
        # sheet is exactly the failure that hid Brokers for this gate's whole
        # life, and it presents as a clean exit code with a plausible PDF.
        _assert_rendered_sheet(rendered, workbook, sheet, evidence)

        if expect_pages is not None and scope.primary and rendered.page_count != expect_pages:
            raise RuntimeError(
                "page count %d != expected %d; pagination changed, so every geometry "
                "assertion below would be measured against a different layout"
                % (rendered.page_count, expect_pages)
            )

        findings.extend(checks.check_font_set(rendered))

        # The conditional-formatting analysis that needs no geometry runs HERE,
        # before calibration can fail.  This is the specific defect class with a
        # history on this workbook, and the sheet it lives on -- Brokers --
        # cannot always be calibrated: its rows repeat `Broker Alpha /
        # Consensus / High / Low` once per metric block, so a thin final page
        # may carry no uniquely-labelled row to fit a grid against.  Running it
        # after calibration meant 4 of 8 cases reported ZERO CF findings on that
        # sheet, which is the same silence this gate was extended to end.
        #
        # A calibration failure still BLOCKS the sheet.  It no longer decides
        # whether the rules were looked at.
        findings.extend(checks.check_conditional_formatting_declared(workbook, sheet))
        evidence["conditional_formatting_rules_declared"] = len(sheet.cf_rules)

        # The pixel baseline is compared HERE, before calibration, because it
        # does not depend on it: it is a raster diff of the rendered pages
        # against the pages approved last time. Running it after the grid meant
        # a sheet whose grid would not calibrate got no visual-regression
        # statement at all -- the sheets least covered by geometry were also
        # the ones left with no pixel evidence.
        if structural_only:
            evidence["visual_regression"] = {
                "mode": "structural_only",
                "blocked": False,
                "baseline_key": scope.baseline_key,
                "authority_baselines": os.path.abspath(baselines_dir)
                    if baselines_dir else None,
                "note": (
                    "Exact authority pixels are a release-certification gate, not "
                    "a per-company content comparison. This run renders the actual "
                    "company workbook and enforces every geometry check available "
                    "for its sheet; native Excel visual review remains manual."
                ),
                "producer_application": workbook.generator_application,
                "producer_row_model": baseline_mod.row_model_for_application(
                    workbook.generator_application),
            }
        elif baselines_dir:
            # The producer's row model is recorded either way, so a mismatch is
            # visible in the evidence rather than folklore -- and a producer whose
            # <Application> string implies a DIFFERENT row model is refused
            # outright, because diffing it against another producer's baselines
            # reports the row model as a regression and the obvious way to make
            # that go away is to rewrite the baseline.
            application = workbook.generator_application
            refusal = baseline_mod.producer_row_model_refusal(
                application, baseline_row_model)
            if refusal:
                evidence["visual_regression"] = {
                    "mode": "blocked",
                    "blocked": True,
                    "blocked_reason": refusal,
                    "producer_application": application,
                    "producer_row_model":
                        baseline_mod.row_model_for_application(application),
                    "expected_row_model": baseline_row_model,
                    "baseline_dir": os.path.join(baselines_dir, scope.baseline_key),
                }
            else:
                # Baselines are per SHEET, because pages are per sheet.  The
                # primary sheet keeps the flat `<case>/page-NN.png` layout it
                # has always had, so the 26 existing Operating Model pages are
                # compared against exactly the files they were written to;
                # every other sheet gets `<case>/<sheet-slug>/page-NN.png`.
                result = baseline_mod.compare(
                    rendered, scope.baseline_key, baselines_dir,
                    os.path.join(case_out, _slug(sheet_name)) if not scope.primary else case_out,
                    dpi=dpi, update=update_baseline, attribution=attribution,
                    producer_application=application,
                    expected_row_model=baseline_row_model,
                )
                evidence["visual_regression"] = result.as_dict()
                evidence["rendered_pages"] = [
                    _file_evidence(page) for page in result.current_pngs
                ]
        else:
            evidence["visual_regression"] = {
                "mode": "blocked",
                "blocked": True,
                "blocked_reason": (
                    "visual regression requires --baselines; no baseline "
                    "comparison ran"
                ),
                "producer_application": workbook.generator_application,
                "producer_row_model": baseline_mod.row_model_for_application(
                    workbook.generator_application),
            }

        if not scope.primary:
            # Support sheets do not have row-map identities, and deriving a
            # physical grid from their sparse or repeating labels produced
            # wrong rectangles that then reported real cells as missing. Their
            # full rendered pages are instead covered by the exact pixel
            # regression, while the workbook reader independently proves the
            # expected font family and the presence of declared CF rules.
            support_reason = (
                "support sheet has no row-map identities and no trustworthy "
                "calibratable cell grid; covered instead by exact full-page "
                "pixel regression plus font-family and declared-rule checks"
                if not structural_only else
                "support sheet has no row-map identities and no trustworthy "
                "calibratable cell grid; this company run proves render identity, "
                "page production, font family and declared rules, while the exact "
                "reusable-profile pixel replay remains a release gate"
            )
            unavailable = dict(scope.unavailable_checks)
            for name in (
                "presence",
                "clipping",
                "overlap",
                "alignment",
                "conditional_formatting_rendered_geometry",
            ):
                unavailable[name] = support_reason
            evidence["checks_run"] = [
                "conditional_formatting_declared",
                "font_set",
                "visual_regression" if not structural_only else "render_identity",
            ]
            evidence["checks_unavailable"] = unavailable
            evidence["geometry_model"] = {
                "mode": "unavailable",
                "reason": support_reason,
            }
            for finding in findings:
                finding.sheet = sheet_name
            evidence["findings"] = [f.as_dict() for f in findings]
            evidence["summary"] = _summarise(findings)
            if keep_pdf:
                kept = os.path.join(
                    case_out, case + ".%s.pdf" % _slug(sheet_name))
                shutil.copy2(conversion.pdf_path, kept)
                evidence["pdf"] = kept
                evidence["pdf_evidence"] = _file_evidence(kept)
            rendered.close()
            evidence["verdict"] = _verdict(evidence)
            return evidence


        grid = calibrate.build_grid(
            rendered, sheet, workbook, first_col, last_col, first_row, last_row,
            numeric_cols, label_col,
        )
        used_excel_rows = grid.vertical.get("excel_row_height_compat_used")
        evidence["geometry_model"] = {
            "column_width_unit_pt": round(sheet.max_digit_width_pt, 5),
            "column_width_unit_source": sheet.max_digit_width_source,
            "column_width_rule": "width_pt = width_chars * column_width_unit_pt "
                                 "(LibreOffice: no +5px padding, no pixel rounding)",
            "generator_application": workbook.generator_application,
            "excel_row_height_compat_predicted":
                grid.vertical.get("excel_row_height_compat_predicted"),
            "excel_row_height_compat_used": used_excel_rows,
            "row_height_rule": (
                "rendered_pt = floor(declared_pt / 0.75) * 0.75 -- LibreOffice's "
                "Excel compatibility path truncates row height to whole 96dpi pixels"
                if used_excel_rows else
                "rendered_pt = declared_pt -- off the Excel compatibility path "
                "LibreOffice honours the declared row height"
            ),
            "row_model_attempts": grid.vertical.get("row_model_attempts"),
            "row_model_prediction_disagreed":
                grid.vertical.get("row_model_prediction_disagreed"),
            "measured_against": "column- and row-sweep probes, and an <Application> "
                                "sweep, rendered through this soffice and read back "
                                "from the PDF",
        }
        evidence["calibration"] = {
            "scale": round(grid.horizontal.scale, 6),
            "vertical_scale": round(grid.vertical.get("vertical_scale", 0.0), 6),
            "axis_scale_ratio": round(grid.vertical.get("axis_scale_ratio", 0.0), 6),
            "unique_labels_available": grid.vertical.get("unique_labels_available"),
            "page_start_rows": grid.vertical.get("page_start_rows"),
            "page_break_residual_pt": grid.vertical.get("page_break_residual_pt"),
            # A page too thin to regress a row grid against has its grid carried
            # forward from the page before it and then tested against the rows it
            # does carry.  That is a weaker statement than a fitted grid, so it is
            # named here rather than blending into the numbers above.
            "page_grid_source": grid.vertical.get("page_grid_source"),
            "inherited_pages": grid.vertical.get("inherited_pages"),
            "inheritance_note": grid.vertical.get("inheritance_note"),
            "page_capacity_pt": grid.vertical.get("page_capacity_pt"),
            "offset_pt": round(grid.horizontal.offset_pt, 3),
            "inlier_columns": grid.horizontal.inliers,
            "candidate_columns": grid.horizontal.candidates,
            "residual_max_pt": round(grid.horizontal.residual_max_pt, 4),
            "residual_rms_pt": round(grid.horizontal.residual_rms_pt, 4),
            "right_edge_pad_pt": round(grid.horizontal.right_edge_pad_pt, 3),
            "pages": [
                {"page": f.page + 1, "first_row": f.first_row, "last_row": f.last_row,
                 "matched_labels": f.matched_labels, "label_bands": f.considered_labels,
                 "grid_source": f.grid_source,
                 "inherited_from_page": None if f.inherited_from_page is None
                                        else f.inherited_from_page + 1,
                 "verified_labels": f.verified_labels,
                 "offset_pt": round(f.offset_pt, 3),
                 "residual_max_pt": round(f.residual_max_pt, 3)}
                for f in grid.pages
            ],
        }

        assigned = checks.assign_words(grid, rendered, workbook, sheet)
        orphans = assigned.pop((-1, -1), None)
        if orphans is not None and orphans.words:
            findings.append(
                checks.Finding(
                    "presence", checks.DEFECT,
                    "%d rendered words fall outside every cell of the print grid"
                    % len(orphans.words),
                    detail={"sample": [w.as_dict() for w in orphans.words[:10]]},
                )
            )

        # Row identities exist only for the sheet the sidecar describes.  On any
        # other sheet this is empty and findings carry no row_id -- they are
        # addressed by physical row and column instead.  Nothing is invented to
        # fill the gap.
        row_ids = ({row: rid for rid, row in row_map.rows_by_id.items()}
                   if row_map is not None else {})
        metrics = checks.fit_text_metrics(rendered)
        if metrics is not None:
            evidence["text_metrics"] = {
                "samples": metrics.samples,
                "glyphs": len(metrics.char_width_pt),
                "space_width_pt": round(metrics.space_width_pt, 3),
                "model_rms_error_pt": round(metrics.rms_error_pt, 4),
            }

        sampler = checks.Sampler(rendered, dpi=max(150, dpi))

        ran: List[str] = ["font_set", "presence", "clipping", "overlap",
                          "alignment", "conditional_formatting"]
        findings.extend(checks.check_presence(workbook, sheet, grid, assigned, row_ids))
        findings.extend(checks.check_clipping(workbook, sheet, grid, assigned, metrics, row_ids))
        findings.extend(checks.check_overlap(grid, assigned, row_ids))
        findings.extend(checks.check_alignment(grid, assigned, numeric_cols, sheet, workbook))
        if row_map is not None:
            findings.extend(
                checks.check_structure(workbook, sheet, grid, assigned, sampler, row_map))
            ran.append("structure")
        # The sampled half of the CF check: the declaration half already ran
        # above, before calibration.
        findings.extend(
            checks.check_conditional_formatting_rendered(
                workbook, sheet, grid, assigned, sampler)
        )

        for finding in findings:
            finding.sheet = sheet_name
        evidence["checks_run"] = sorted(ran)
        evidence["checks_unavailable"] = scope.unavailable_checks
        evidence["findings"] = [f.as_dict() for f in findings]
        evidence["summary"] = _summarise(findings)

        if keep_pdf:
            kept = os.path.join(
                case_out,
                case + (".pdf" if scope.primary else ".%s.pdf" % _slug(sheet_name)))
            shutil.copy2(conversion.pdf_path, kept)
            evidence["pdf"] = kept
            evidence["pdf_evidence"] = _file_evidence(kept)

        rendered.close()
        evidence["verdict"] = _verdict(evidence)

    except (soffice.ConversionError, pdfdoc.PyMuPdfMissing, calibrate.CalibrationError) as exc:
        evidence["verdict"] = BLOCKED
        evidence["blocked_reason"] = str(exc)
        evidence["blocked_kind"] = getattr(exc, "kind", type(exc).__name__)
        _record_partial(evidence, findings, sheet_name, scope)
    except Exception as exc:  # noqa: BLE001 -- everything unexpected is BLOCKED, never a warning
        evidence["verdict"] = BLOCKED
        evidence["blocked_reason"] = "%s: %s" % (type(exc).__name__, exc)
        evidence["blocked_traceback"] = traceback.format_exc()[-4000:]
        _record_partial(evidence, findings, sheet_name, scope)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)

    return evidence


def _record_partial(evidence: dict, findings: List[checks.Finding],
                    sheet_name: str, scope: "SheetScope") -> None:
    """Keep the findings a BLOCKED sheet did establish before it failed.

    The verdict stays BLOCKED -- these findings are emphatically not a pass, and
    `checks_run` names only what actually ran.  But a sheet whose grid would not
    calibrate has still had its conditional-formatting rules read, and reporting
    nothing for it would be the same silence this gate was extended to end.
    """
    if not findings:
        return
    for finding in findings:
        finding.sheet = sheet_name
    evidence["findings"] = [f.as_dict() for f in findings]
    evidence["summary"] = _summarise(findings)
    evidence["checks_run"] = sorted({f.check for f in findings})
    evidence["checks_unavailable"] = dict(
        scope.unavailable_checks,
        **{name: "not reached: the sheet was BLOCKED before this check ran"
           for name in ("presence", "clipping", "overlap", "alignment")},
    )
    evidence["partial"] = (
        "BLOCKED before every check ran. The findings below are the ones "
        "established before the failure and are not a pass; `checks_run` names "
        "what actually ran."
    )


def _assert_rendered_sheet(rendered, workbook: xm.Workbook, sheet: xm.Sheet,
                           evidence: dict) -> None:
    """Refuse a PDF that is not the sheet we asked for.

    LibreOffice will not hide the sheet named by the workbook's `activeTab`.
    Before that was handled, staging `Brokers` produced a PDF whose first nine
    pages were the Operating Model -- exit code 0, a well-formed PDF, and a
    page count that looked plausible.  A gate that renders the wrong sheet and
    reports PASS is worse than one that does not look at all, so the identity
    of the render is asserted rather than assumed.

    The test is the sheet's own first line of text: each sheet here opens with
    a distinct title cell.  Where no such anchor exists the check says so and
    the sheet is BLOCKED, never quietly waved through.
    """
    anchor = None
    for row in range(sheet.max_row + 1):
        cell = sheet.cell(row, xm.col_letters_to_index("B"))
        if cell is not None and not cell.is_empty:
            text = xm.cell_text(workbook, cell)
            if text and len(text.strip()) >= 8:
                anchor = text.strip()
                break
    evidence["render_identity"] = {"anchor": anchor}
    if anchor is None:
        raise RuntimeError(
            "sheet %r has no title-cell anchor, so the rendered PDF cannot be "
            "confirmed to be this sheet rather than another; BLOCKED"
            % sheet.name)

    first_page_text = " ".join(run.text for run in rendered.pages[0].runs[:40])
    head = anchor[:24]
    if head not in first_page_text:
        raise RuntimeError(
            "the rendered PDF does not begin with sheet %r: expected its title "
            "%r on page 1, found %r. The conversion produced a different sheet "
            "than the one staged, so every finding below would be about the "
            "wrong sheet."
            % (sheet.name, head, first_page_text[:120]))
    evidence["render_identity"]["confirmed_on_page_1"] = True


def run_case(
    workbook_path: str,
    out_dir: str,
    *,
    sheet_name: Optional[str] = None,
    baselines_dir: Optional[str] = None,
    baseline_case: Optional[str] = None,
    structural_only: bool = False,
    update_baseline: bool = False,
    attribution: Optional[dict] = None,
    baseline_row_model: str = baseline_mod.BASELINE_ROW_MODEL,
    soffice_path: Optional[str] = None,
    expect_pages: Optional[int] = None,
    keep_pdf: bool = True,
    dpi: int = baseline_mod.BASELINE_DPI,
    timeout_s: float = 300.0,
    certified_closure_sha256: Optional[str] = None,
) -> dict:
    """Render and check EVERY visible sheet of one workbook.

    `sheet_name` restricts the run to a single sheet; the default is every
    visible sheet, because a check that does not examine a thing reports
    nothing about it and that reads as silence rather than absence.
    """
    started = time.time()
    case = case_name(workbook_path)
    comparison_case = baseline_case or case
    case_out = os.path.join(out_dir, case)
    os.makedirs(case_out, exist_ok=True)

    evidence: dict = {
        "schema": "render-evidence/2",
        "generated_by": "scripts/render/check_render.py",
        "case": case,
        "baseline_case": comparison_case,
        "comparison_scope": "structural_company_run" if structural_only else "exact_authority_replay",
        "workbook": os.path.abspath(workbook_path),
        "workbook_sha256": _file_evidence(workbook_path)["sha256"],
        "certified_closure_sha256": certified_closure_sha256,
        "verdict": BLOCKED,
        "closes_gate": "--visual-reviewed",
        "attested_by": "assertion",
        "honest_limit": (
            "Proves LibreOffice rendering with the Carlito metric-compatible "
            "substitute for Calibri. Authoritative for visual regression and for "
            "clipping; NOT authoritative for how the workbook looks in Microsoft "
            "Excel with Calibri (see ARCHITECTURE §10). Coverage is per sheet and "
            "is not uniform: the Operating Model gets the full geometry and "
            "structure suite. Support sheets get font and declared-rule checks "
            "plus exact full-page pixel regression because no row-map identities "
            "exist for them. Each sheet states which checks ran and which could not."
        ),
        "environment": soffice.probe(),
        "findings": [],
        "blocked_reason": None,
    }

    try:
        workbook = xm.load_workbook(workbook_path)
        row_map = rowmap.load_for_workbook(workbook_path)
        scopes = sheet_scopes(workbook, row_map, comparison_case, only=sheet_name)

        evidence["declared_fonts"] = workbook.declared_font_names()
        evidence["default_font"] = (
            {"name": workbook.default_font.name, "size": workbook.default_font.size}
            if workbook.default_font else None
        )
        evidence["visible_sheets"] = [s.name for s in workbook.visible_sheets()]
        evidence["hidden_sheets"] = [
            s.name for s in workbook.sheets if s.state != "visible"]
        evidence["sheets_examined"] = [s.name for s in scopes]
        evidence["row_map_coverage"] = {
            "sidecar": rowmap.sidecar_for(workbook_path),
            "covers": [s.name for s in scopes if s.primary],
            "does_not_cover": [s.name for s in scopes if not s.primary],
            "note": (
                "The sidecar has no sheet dimension: rows_by_id, section_headers, "
                "controls and columns are a single unqualified set of Operating "
                "Model rows and columns. Row identity therefore exists for the "
                "Operating Model alone, and the checks defined in terms of it are "
                "reported unavailable on the other sheets rather than being fed "
                "invented identities."
            ),
        }

        blocks = [
            _run_sheet(
                workbook_path, workbook, scope, case, case_out,
                baselines_dir=baselines_dir, update_baseline=update_baseline,
                structural_only=structural_only,
                attribution=attribution, baseline_row_model=baseline_row_model,
                soffice_path=soffice_path, expect_pages=expect_pages,
                keep_pdf=keep_pdf, dpi=dpi, timeout_s=timeout_s,
            )
            for scope in scopes
        ]
        evidence["sheets"] = blocks

        primary = next((b for b in blocks if b["primary"]), blocks[0])
        # Kept at the top level for the fields the orchestrator reads.  These
        # describe the PRIMARY sheet; the per-sheet blocks carry the rest.
        evidence["sheet"] = primary["sheet"]
        evidence["page_count"] = primary.get("page_count")
        evidence["page_count_by_sheet"] = {
            b["sheet"]: b.get("page_count") for b in blocks}
        evidence["page_count_total"] = sum(
            b.get("page_count") or 0 for b in blocks)
        for key in ("print_range", "geometry_model", "calibration", "conversion",
                    "text_metrics", "page_size_pt", "workbook_page_setup",
                    "page_setup_applied_by_renderer", "page_setup_note", "pdf",
                    "visual_regression"):
            if key in primary:
                evidence[key] = primary[key]

        # Every sheet's findings, each stamped with the sheet it is about.
        evidence["findings"] = [f for b in blocks for f in b.get("findings", [])]
        evidence["summary"] = {}
        for block in blocks:
            for check_name, counts in (block.get("summary") or {}).items():
                bucket = evidence["summary"].setdefault(check_name, {})
                for severity, n in counts.items():
                    bucket[severity] = bucket.get(severity, 0) + n
        evidence["summary_by_sheet"] = {
            b["sheet"]: b.get("summary") or {} for b in blocks}
        evidence["verdict_by_sheet"] = {b["sheet"]: b["verdict"] for b in blocks}

        # Worst verdict wins.  A sheet that is BLOCKED has not been checked, and
        # the case cannot pass on the strength of the sheets that were.
        verdicts = [b["verdict"] for b in blocks]
        if BLOCKED in verdicts:
            evidence["verdict"] = BLOCKED
            evidence["blocked_reason"] = next(
                "sheet %r: %s" % (b["sheet"], b.get("blocked_reason"))
                for b in blocks if b["verdict"] == BLOCKED)
        elif FAIL in verdicts:
            evidence["verdict"] = FAIL
        else:
            evidence["verdict"] = PASS

    except Exception as exc:  # noqa: BLE001 -- everything unexpected is BLOCKED, never a warning
        evidence["verdict"] = BLOCKED
        evidence["blocked_reason"] = "%s: %s" % (type(exc).__name__, exc)
        evidence["blocked_traceback"] = traceback.format_exc()[-4000:]

    evidence["duration_s"] = round(time.time() - started, 2)
    path = os.path.join(out_dir, case + ".render-evidence.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, indent=2, sort_keys=False)
        handle.write("\n")
    evidence["evidence_path"] = path
    return evidence


def static_preflight(workbook_path: str, sheet_name: str = DEFAULT_SHEET) -> dict:
    """The subset of N14 that can be answered from the workbook alone.

    Emphatically NOT a render check and never a PASS.  It exists so that, where
    LibreOffice is unavailable, the report can state precisely what IS known
    rather than claiming a pass it cannot support.  Clipping, overlap, presence,
    font substitution and the pixel baseline are all absent here by nature:
    they only exist at render time.
    """
    from . import cfeval, textfit

    workbook = xm.load_workbook(workbook_path)
    sheet = workbook.sheet_by_name(sheet_name)
    if sheet is None:
        raise KeyError("sheet %r not in %s" % (sheet_name, workbook_path))
    row_map = rowmap.load_for_workbook(workbook_path)
    first_col, last_col, first_row, last_row, numeric_cols, label_col = _print_area(sheet, row_map)

    used_font_ids = {
        (workbook.style(c.style_id).font_id if workbook.style(c.style_id) else 0)
        for c in sheet.cells.values()
    }
    used_fonts = sorted({
        workbook.fonts[i].name for i in used_font_ids
        if 0 <= i < len(workbook.fonts) and workbook.fonts[i].name
    })

    rules = []
    for rule in sheet.cf_rules:
        outcome = cfeval.evaluate_rule(workbook, sheet, rule)
        dxf = workbook.dxfs[rule.dxf_id] if rule.dxf_id is not None and rule.dxf_id < len(workbook.dxfs) else None
        delta = None
        static_fill = None
        if dxf and dxf.fill_rgb and outcome.fires:
            row, col = xm.split_ref(outcome.fires[0])
            cell = sheet.cell(row, col)
            static_fill = workbook.cell_fill_rgb(cell.style_id) if cell else None
            a, b = checks.hex_to_rgb(static_fill), checks.hex_to_rgb(dxf.fill_rgb)
            if a and b:
                delta = checks.colour_distance(a, b)
        rules.append({
            "sqref": rule.sqref,
            "type": rule.rule_type,
            "priority": rule.priority,
            "formula": outcome.formula,
            "dxf_fill": dxf.fill_rgb if dxf else None,
            "dxf_font_colour": dxf.font_color_rgb if dxf else None,
            "fires": len(outcome.fires),
            "quiet": len(outcome.quiet),
            "undetermined": len(outcome.undetermined),
            "undetermined_reason": outcome.reason,
            "first_firing_cell": outcome.fires[0] if outcome.fires else None,
            "static_fill_under_first_firing_cell": static_fill,
            "fill_channel_delta_vs_static": delta,
        })

    clipping: dict
    try:
        fonts = textfit.load_font_set()
        # Excel pads a cell more than LibreOffice does, so it clips sooner.
        # Predict against the WIDER (Excel) margin to get the superset, then mark
        # the subset that also fails under LibreOffice's measured margin: those
        # are the ones a real render will confirm.  The rest are Excel-only risks
        # that the render cannot settle either way -- and saying so is the point,
        # since Excel is exactly what this stage is not authoritative for.
        predictions = textfit.predict_clipping(
            workbook, sheet, fonts, first_col, last_col, first_row, last_row,
            margin_pt=textfit.EXCEL_CELL_TEXT_MARGIN_PT,
        )
        confirmed_by_render = {
            p.ref for p in textfit.predict_clipping(
                workbook, sheet, fonts, first_col, last_col, first_row, last_row,
                margin_pt=textfit.LIBREOFFICE_CELL_TEXT_MARGIN_PT,
            )
        }
        detail = []
        for p in sorted(predictions, key=lambda p: -p.overflow_ratio)[:60]:
            entry = p.as_dict()
            entry["confidence"] = (
                "certain" if p.ref in confirmed_by_render else "excel_margin_only")
            detail.append(entry)
        clipping = {
            "measured_with": os.path.basename(fonts.regular_path),
            "certain": sum(1 for e in detail if e["confidence"] == "certain"),
            "excel_margin_only": sum(1 for e in detail if e["confidence"] == "excel_margin_only"),
            "metric_equivalence": (
                "Carlito is metric-compatible with Calibri, so either font gives "
                "the advance widths the LibreOffice render will use. This holds "
                "for Calibri/Carlito only -- not for Aptos/DejaVu Sans."
            ),
            "cell_text_margin_pt": {
                "libreoffice_measured": textfit.LIBREOFFICE_CELL_TEXT_MARGIN_PT,
                "excel": textfit.EXCEL_CELL_TEXT_MARGIN_PT,
            },
            "predicted_clipped_cells": len(predictions),
            "detail": detail,
        }
    except Exception as exc:  # noqa: BLE001
        clipping = {"error": "%s: %s" % (type(exc).__name__, exc),
                    "note": "clipping could not be predicted; it remains UNKNOWN, not passing"}

    return {
        "schema": "render-static-preflight/2",
        "verdict": "NOT_RENDERED",
        "note": (
            "Workbook-derivable subset only. Clipping, overlap, presence, font "
            "substitution and the visual baseline CANNOT be answered without an "
            "actual LibreOffice conversion and are absent here, not passing."
        ),
        "case": case_name(workbook_path),
        "workbook": os.path.abspath(workbook_path),
        "sheet": sheet_name,
        "declared_fonts": workbook.declared_font_names(),
        "fonts_referenced_by_cells": used_fonts,
        "default_font": ({"name": workbook.default_font.name, "size": workbook.default_font.size}
                         if workbook.default_font else None),
        "page_setup": {
            "has_page_setup": sheet.has_page_setup,
            "fit_to_page": sheet.fit_to_page,
            "has_print_area": any(k == "_xlnm.Print_Area" for k in workbook.defined_names),
            "attrs": sheet.page_setup_attrs,
        },
        "calc_pr": workbook.calc_pr,
        "print_range": {
            "columns": "%s:%s" % (xm.col_index_to_letters(first_col), xm.col_index_to_letters(last_col)),
            "rows": [first_row, last_row],
            "label_column": xm.col_index_to_letters(label_col),
            "numeric_columns": [xm.col_index_to_letters(c) for c in numeric_cols],
            "gutter_columns": row_map.gutter_column_letters(
                xm.col_index_to_letters(first_col), xm.col_index_to_letters(last_col)),
        },
        "grid": {
            "content_width_pt": round(xm.column_edges_pt(sheet, first_col, last_col)[-1], 2),
            "content_height_pt": round(xm.row_edges_pt(sheet, first_row, last_row)[-1], 2),
            "rows": last_row - first_row + 1,
            "columns": last_col - first_col + 1,
            "non_empty_cells": sum(1 for c in sheet.cells.values() if not c.is_empty),
        },
        "clipping_prediction": clipping,
        "conditional_formatting": {
            "rules": len(sheet.cf_rules),
            "firing_here": sum(1 for r in rules if r["fires"]),
            "inert_here": sum(1 for r in rules if not r["fires"] and not r["undetermined"]),
            "undetermined": sum(1 for r in rules if r["undetermined"] and not r["fires"]),
            "detail": rules,
        },
    }


def _summarise(findings: Sequence[checks.Finding]) -> dict:
    counts: Dict[str, Dict[str, int]] = {}
    for finding in findings:
        bucket = counts.setdefault(finding.check, {})
        bucket[finding.severity] = bucket.get(finding.severity, 0) + 1
    return counts


def _verdict(evidence: dict) -> str:
    findings = evidence.get("findings", [])
    if any(f["severity"] == checks.BLOCKED for f in findings):
        evidence["blocked_reason"] = next(
            f["message"] for f in findings if f["severity"] == checks.BLOCKED
        )
        return BLOCKED
    regression = evidence.get("visual_regression") or {}
    # A missing baseline, or a producer that cannot legitimately be diffed
    # against these baselines, is BLOCKED: the gate did not make a regression
    # statement, and a check that visited nothing has not passed.
    if regression.get("blocked"):
        evidence["blocked_reason"] = regression.get("blocked_reason")
        return BLOCKED
    if any(f["severity"] == checks.DEFECT for f in findings):
        return FAIL
    # unattributed_pages covers pixel changes, a page the baseline does not have,
    # and a changed page count -- each of which is a defect in its own right.
    if regression.get("unattributed_pages"):
        return FAIL
    return PASS


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workbooks", nargs="*", help=".xlsx files to check")
    parser.add_argument("--out", default="render-out")
    parser.add_argument("--sheet", default=None,
                        help="restrict the run to ONE visible sheet. The default "
                             "is every visible sheet: a check that does not "
                             "examine a sheet reports nothing about it, which "
                             "reads as silence rather than absence.")
    parser.add_argument("--baselines", default=None,
                        help="directory holding the per-case PNG regression baselines")
    parser.add_argument("--baseline-case", default=None,
                        help="approved reusable authority profile to compare against; "
                             "keeps company/workbook names out of the baseline key")
    parser.add_argument("--structural-only", action="store_true",
                        help="render the actual company workbook and enforce structural "
                             "geometry without comparing its company-specific text and "
                             "numbers to reusable authority pixels")
    parser.add_argument("--update-baseline", action="store_true",
                        help="rewrite the baselines instead of comparing (requires a reason)")
    parser.add_argument("--attribution", default=None,
                        help="JSON file attributing expected pixel changes")
    parser.add_argument("--baseline-row-model",
                        choices=[baseline_mod.ROW_MODEL_EXCEL,
                                 baseline_mod.ROW_MODEL_DECLARED],
                        default=baseline_mod.BASELINE_ROW_MODEL,
                        help="the LibreOffice row model the --baselines tree was "
                             "produced under. Default %s, the shipping "
                             "(plan-rendered) path. A workbook whose "
                             "docProps/app.xml <Application> implies the other "
                             "model is refused rather than diffed."
                             % baseline_mod.BASELINE_ROW_MODEL)
    parser.add_argument("--soffice", default=None)
    parser.add_argument("--expect-pages", type=int, default=None)
    parser.add_argument("--dpi", type=int, default=baseline_mod.BASELINE_DPI)
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument(
        "--certified-closure-sha256",
        default=None,
        help="bind this render evidence to the exact certified release closure",
    )
    parser.add_argument("--probe", action="store_true",
                        help="report dependency availability and exit")
    parser.add_argument("--static", action="store_true",
                        help="workbook-derivable preflight only; never returns PASS")
    args = parser.parse_args(argv)

    if args.probe:
        print(json.dumps(soffice.probe(), indent=2))
        return 0

    if not args.workbooks:
        parser.error("no workbooks given")

    if args.static:
        os.makedirs(args.out, exist_ok=True)
        for workbook_path in args.workbooks:
            report = static_preflight(workbook_path, args.sheet or DEFAULT_SHEET)
            path = os.path.join(args.out, report["case"] + ".render-static.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(report, handle, indent=2)
                handle.write("\n")
            cf = report["conditional_formatting"]
            clip = report["clipping_prediction"]
            print("%-30s fonts=%-9s cells=%-5d cf(fire/inert/undet)=%d/%d/%d "
                  "page_setup=%-5s predicted_clips=%s"
                  % (report["case"], ",".join(report["fonts_referenced_by_cells"]),
                     report["grid"]["non_empty_cells"],
                     cf["firing_here"], cf["inert_here"], cf["undetermined"],
                     report["page_setup"]["has_page_setup"],
                     clip.get("predicted_clipped_cells", clip.get("error"))))
        print("\nNOT_RENDERED: this is the workbook-derivable subset only. "
              "Clipping, overlap, presence, font substitution and the visual "
              "baseline require a real LibreOffice conversion.")
        return 3

    os.makedirs(args.out, exist_ok=True)
    attribution = baseline_mod.load_attribution(args.attribution)
    if args.update_baseline and not attribution.get("reason"):
        print("REFUSED: --update-baseline requires --attribution with a 'reason'. "
              "A baseline rewritten without a stated reason silently launders an "
              "unintended visual change into the new expectation.", file=sys.stderr)
        return 2
    if args.update_baseline and not args.baselines:
        print("REFUSED: --update-baseline without --baselines has nothing to write. "
              "Say which baselines tree you mean.", file=sys.stderr)
        return 2

    results = []
    for workbook_path in args.workbooks:
        evidence = run_case(
            workbook_path, args.out,
            sheet_name=args.sheet,
            baselines_dir=args.baselines,
            baseline_case=args.baseline_case,
            structural_only=args.structural_only,
            update_baseline=args.update_baseline,
            attribution=attribution,
            baseline_row_model=args.baseline_row_model,
            soffice_path=args.soffice,
            expect_pages=args.expect_pages,
            dpi=args.dpi,
            timeout_s=args.timeout,
            certified_closure_sha256=args.certified_closure_sha256,
        )
        results.append(evidence)
        summary = evidence.get("summary") or {}
        defects = sum(v.get("defect", 0) for v in summary.values())
        print("%-8s %-34s pages=%-3s sheets=%-3d defects=%-3d %s" % (
            evidence["verdict"],
            evidence["case"],
            evidence.get("page_count_total", evidence.get("page_count", "-")),
            len(evidence.get("sheets") or []),
            defects,
            evidence.get("blocked_reason") or "",
        ))
        # Per sheet, so a sheet that was examined and found clean is visibly
        # distinct from a sheet that was never visited.
        for block in evidence.get("sheets") or []:
            block_summary = block.get("summary") or {}
            print("    %-8s %-16s pages=%-3s cf_rules=%-4s defects=%-3d %s" % (
                block["verdict"], block["sheet"],
                block.get("page_count", "-"),
                block.get("conditional_formatting_rules_declared", "-"),
                sum(v.get("defect", 0) for v in block_summary.values()),
                block.get("blocked_reason") or "",
            ))

    index = os.path.join(args.out, "render-evidence-index.json")
    with open(index, "w", encoding="utf-8") as handle:
        json.dump(
            {"schema": "render-evidence-index/2",
             "cases": [{"case": r["case"], "verdict": r["verdict"],
                        "evidence": r.get("evidence_path"),
                        "page_count": r.get("page_count"),
                        "page_count_total": r.get("page_count_total"),
                        "sheets_examined": r.get("sheets_examined"),
                        "verdict_by_sheet": r.get("verdict_by_sheet"),
                        "blocked_reason": r.get("blocked_reason")} for r in results]},
            handle, indent=2)
        handle.write("\n")

    return 0 if all(r["verdict"] == PASS for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
