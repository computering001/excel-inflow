"""Visual regression baseline.

One PNG per page per case, stored under a baselines directory.  On every build
the freshly rendered pages are diffed against those PNGs.

The discipline is the one already applied to numbers -- "0 changed values, 0
changed formulas, 0 changed font colours" -- extended to appearance.  Any pixel
change must be ATTRIBUTABLE to an intended change; an unattributed pixel change
is a defect, not a curiosity.  A section band splitting at column F is a pixel
change and nothing else in the system would see it.

WRITING A BASELINE REQUIRES EXPLICIT INTENT
-------------------------------------------
A comparison run NEVER authors a baseline.  Not on first run, not for a page
the baseline does not yet have, not for anything.  Every mutation of the
baselines tree goes through `_write_baseline_png` / `_remove_baseline_png`,
which refuse unless `update=True` AND the attribution carries a `reason`.

This is not a stylistic preference.  A gate that writes the file it is about to
compare against has authored its own expected output: the run that creates the
baseline may still fail, but the NEXT identical run passes against a picture
nobody ever approved.  That is a validator editing its own contract, which is
the one thing this project forbids everywhere else.

A MISSING BASELINE IS BLOCKED, NOT A PASS
-----------------------------------------
If a case has no baseline at all the gate cannot make a regression statement
about it, so it says so: mode "blocked".  A check that visited nothing has not
passed.  If a case HAS a baseline but an individual page does not, that page is
reported missing and counts as unattributed -- it cannot be silently created and
it cannot be silently skipped.

A PAGE-COUNT MISMATCH IS A FINDING IN ITS OWN RIGHT
---------------------------------------------------
Three pages against a four-page baseline means the document's pagination
changed, which is exactly what a visual regression gate exists to catch.  It is
reported as a defect and is never resolved by extending the baseline to fit.

Attribution file format (JSON)::

    {
      "reason": "moved the RCF waterfall below the interest schedule",
      "approved_by": "who signed it off",
      "pages": [2, 3],                 # optional page allow-list (1-based)
      "regions": [                     # optional, in baseline pixel coords
        {"page": 2, "bbox": [x0, y0, x1, y1], "reason": "..."}
      ]
    }
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from . import pdfdoc
from . import xlsx_model as xm

BASELINE_DPI = 100

PAGE_PNG_RE = re.compile(r"^page-(\d+)\.png$")

# ---------------------------------------------------------------------------
# Which producer may own a baseline
# ---------------------------------------------------------------------------
# LibreOffice honours declared row heights differently depending on whether
# `docProps/app.xml`'s <Application> string starts with "Microsoft" (see
# xlsx_model.declares_excel_generator, which was MEASURED against this soffice).
# On the Excel path a 12.5pt row renders 12.0pt; off it, 12.47pt.  Over ~63 rows
# that is more than a full row of drift, so the two producers in this project
# genuinely paginate differently:
#
#   shipping path (openpyxl, "Microsoft Excel Compatible / Openpyxl 3.1.5")
#       -> ROW_MODEL_EXCEL      -- this is what the baselines were populated from
#   artifact tool (writes no docProps at all)
#       -> ROW_MODEL_DECLARED   -- must be checked WITHOUT --baselines
#
# That constraint used to live only in prose.  Diffing the artifact tool against
# the shipping path's baselines would report hundreds of "regressions" that are
# nothing but the row model, and the obvious way to make them go away is to
# rewrite the baseline -- which would then pin the wrong renderer for the life
# of the file.  So the rule is in the code, and the app string is in the
# evidence either way, so a mismatch is visible rather than folklore.
ROW_MODEL_EXCEL = "excel-compat"
ROW_MODEL_DECLARED = "declared"

#: The row model the baselines under `render-fixtures/baselines/` were produced
#: with.  Overridable per run (`--baseline-row-model`) so a second, separately
#: populated baselines tree is possible -- but only as a stated intent, never as
#: a silent fallback when the check is inconvenient.
BASELINE_ROW_MODEL = ROW_MODEL_EXCEL


class BaselineWriteRefused(RuntimeError):
    """A baseline write was attempted without explicit, attributed intent."""


class BaselineProducerMismatch(RuntimeError):
    """The producer's row model differs from the one the baselines were made with."""


def row_model_for_application(application: Optional[str]) -> str:
    """The LibreOffice row model implied by a workbook's <Application> string."""
    return ROW_MODEL_EXCEL if xm.declares_excel_generator(application) else ROW_MODEL_DECLARED


def producer_row_model_refusal(
    application: Optional[str],
    expected_row_model: str = BASELINE_ROW_MODEL,
) -> Optional[str]:
    """Why this producer must not be diffed against these baselines, or None.

    Returns a human-readable refusal reason when the workbook's <Application>
    string implies a different LibreOffice row model from the one the baselines
    were produced under.  The caller turns that into BLOCKED; it is never a
    pass, and it is never grounds for rewriting the baseline.
    """
    actual = row_model_for_application(application)
    if actual == expected_row_model:
        return None
    return (
        "producer row model %r does not match the baselines' %r: docProps/app.xml "
        "declares <Application>%s, and LibreOffice %s. The two producers paginate "
        "differently by measurement, so this comparison would report the row model "
        "as a regression. Check this producer WITHOUT --baselines, or point "
        "--baselines at a tree populated from it and say so with "
        "--baseline-row-model %s."
        % (
            actual,
            expected_row_model,
            ("=%r" % application) if application else " is absent",
            (
                "truncates row heights to whole 96dpi pixels on that path"
                if actual == ROW_MODEL_EXCEL
                else "honours the declared row height off that path"
            ),
            actual,
        )
    )


@dataclass
class PageDiff:
    page: int              # 1-based; 0 is reserved for whole-document findings
    baseline_path: Optional[str]
    changed_pixels: int
    total_pixels: int
    bbox: Optional[Tuple[int, int, int, int]]
    attributed: bool
    attribution: Optional[str]
    note: Optional[str] = None
    diff_png: Optional[str] = None
    #: no baseline PNG exists for this page -- not a pass, and never created here
    missing: bool = False
    #: a whole-document defect (page count changed) rather than a pixel diff
    defect: bool = False

    def as_dict(self) -> dict:
        return {
            "page": self.page,
            "baseline": self.baseline_path,
            "changed_pixels": self.changed_pixels,
            "total_pixels": self.total_pixels,
            "changed_fraction": (self.changed_pixels / self.total_pixels) if self.total_pixels else None,
            "bbox": list(self.bbox) if self.bbox else None,
            "attributed": self.attributed,
            "attribution": self.attribution,
            "note": self.note,
            "diff_png": self.diff_png,
            "missing_baseline": self.missing,
            "defect": self.defect,
        }


@dataclass
class BaselineResult:
    case: str
    baseline_dir: str
    mode: str                 # "compared" | "created" | "updated" | "blocked"
    page_diffs: List[PageDiff] = field(default_factory=list)
    current_pngs: List[str] = field(default_factory=list)
    page_count_baseline: Optional[int] = None
    page_count_current: Optional[int] = None
    blocked: bool = False
    blocked_reason: Optional[str] = None
    page_count_mismatch: bool = False
    producer_application: Optional[str] = None
    producer_row_model: Optional[str] = None
    expected_row_model: Optional[str] = None
    raster_backend: Optional[str] = None
    expected_raster_backend: Optional[str] = None
    written: List[str] = field(default_factory=list)
    removed: List[str] = field(default_factory=list)

    @property
    def missing_pages(self) -> List[int]:
        return [d.page for d in self.page_diffs if d.missing]

    @property
    def unattributed_changes(self) -> List[PageDiff]:
        """Every page this run could not state was unchanged for a stated reason.

        A missing baseline and a changed page count both belong here: neither is
        a pixel diff, and both mean the gate cannot report "no visual change".
        """
        return [
            d for d in self.page_diffs
            if (d.changed_pixels > 0 or d.missing or d.defect) and not d.attributed
        ]

    def as_dict(self) -> dict:
        return {
            "case": self.case,
            "baseline_dir": self.baseline_dir,
            "mode": self.mode,
            "blocked": self.blocked,
            "blocked_reason": self.blocked_reason,
            "page_count_baseline": self.page_count_baseline,
            "page_count_current": self.page_count_current,
            "page_count_mismatch": self.page_count_mismatch,
            "producer_application": self.producer_application,
            "producer_row_model": self.producer_row_model,
            "expected_row_model": self.expected_row_model,
            "raster_backend": self.raster_backend,
            "expected_raster_backend": self.expected_raster_backend,
            "baselines_written": self.written,
            "baselines_removed": self.removed,
            "pages": [d.as_dict() for d in self.page_diffs],
            "missing_baseline_pages": self.missing_pages,
            "unattributed_pages": [d.page for d in self.unattributed_changes],
        }


def _load_png(path: str):
    import numpy as np

    try:
        from PIL import Image
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("Pillow is required for baseline diffing") from exc
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"))


def _save_png(array, path: str) -> str:
    """Write a PNG anywhere.  NOT for the baselines tree -- see below."""
    from PIL import Image

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    Image.fromarray(array).save(path)
    return path


# ---------------------------------------------------------------------------
# The only two functions in this module that may touch the baselines tree.
# ---------------------------------------------------------------------------

def _require_write_intent(path: str, update: bool, reason: Optional[str]) -> None:
    if not update:
        raise BaselineWriteRefused(
            "refusing to write %s: a comparison run must never author a baseline. "
            "Creating the picture you are about to compare against makes the next "
            "identical run pass against expected output nobody approved. Use "
            "--update-baseline with --attribution carrying a reason." % path
        )
    if not reason:
        raise BaselineWriteRefused(
            "refusing to write %s: --update-baseline requires an attribution "
            "'reason'. A baseline rewritten without a stated reason silently "
            "launders an unintended visual change into the new expectation." % path
        )


def _write_baseline_png(array, path: str, *, update: bool, reason: Optional[str]) -> str:
    _require_write_intent(path, update, reason)
    return _save_png(array, path)


def _remove_baseline_png(path: str, *, update: bool, reason: Optional[str]) -> str:
    _require_write_intent(path, update, reason)
    os.remove(path)
    return path


def load_attribution(path: Optional[str]) -> dict:
    if not path:
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_manifest(baseline_dir: str) -> dict:
    """Load a baseline-tree manifest when one exists.

    Synthetic self-tests deliberately use an isolated tree with no manifest;
    production trees carry one. A malformed production manifest is blocking,
    not an excuse to compare pixels without knowing their raster producer.
    """
    path = os.path.join(baseline_dir, "BASELINES.json")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise BaselineProducerMismatch("baseline manifest is not a JSON object: %s" % path)
    return value


def compare(
    rendered: pdfdoc.RenderedPdf,
    case: str,
    baseline_dir: str,
    out_dir: str,
    *,
    dpi: int = BASELINE_DPI,
    update: bool = False,
    attribution: Optional[dict] = None,
    pixel_tolerance: int = 0,
    producer_application: Optional[str] = None,
    expected_row_model: str = BASELINE_ROW_MODEL,
) -> BaselineResult:
    import numpy as np

    attribution = attribution or {}
    global_reason = attribution.get("reason")

    # Fail before rendering anything if the caller asked to write without intent,
    # so a refused run cannot leave a half-written baseline behind.
    if update and not global_reason:
        raise BaselineWriteRefused(
            "refusing to update the baselines for case %r: --update-baseline "
            "requires an attribution 'reason'." % case
        )

    case_dir = os.path.join(baseline_dir, case)
    current_dir = os.path.join(out_dir, "pages")
    os.makedirs(current_dir, exist_ok=True)   # out_dir only; never the baseline tree

    existing = sorted(
        f for f in (os.listdir(case_dir) if os.path.isdir(case_dir) else [])
        if PAGE_PNG_RE.match(f)
    )
    if update:
        mode = "updated" if existing else "created"
    elif existing:
        mode = "compared"
    else:
        mode = "blocked"

    result = BaselineResult(
        case=case,
        baseline_dir=case_dir,
        mode=mode,
        page_count_baseline=len(existing) or None,
        page_count_current=rendered.page_count,
        producer_application=producer_application,
        producer_row_model=row_model_for_application(producer_application),
        expected_row_model=expected_row_model,
        raster_backend=rendered.raster_backend,
    )

    manifest = load_manifest(baseline_dir)
    expected_raster = manifest.get("raster_backend")
    result.expected_raster_backend = expected_raster
    if expected_raster and expected_raster != rendered.raster_backend:
        for index in range(rendered.page_count):
            name = "page-%02d.png" % (index + 1)
            current_path = os.path.join(current_dir, name)
            rendered.save_png(index, current_path, dpi=dpi)
            result.current_pngs.append(current_path)
        result.mode = "blocked"
        result.blocked = True
        result.blocked_reason = (
            "raster backend %r does not match the baseline tree's %r. MuPDF "
            "and Poppler antialias the same PDF differently, so a cross-backend "
            "pixel diff would report renderer pixels as workbook drift. Use the "
            "declared backend, or approve a separately attributed baseline epoch "
            "for %r before comparing."
            % (rendered.raster_backend, expected_raster, rendered.raster_backend)
        )
        return result

    if mode == "blocked":
        # Render the current pages into out_dir so a human can inspect (and, with
        # explicit intent, later adopt) them -- but state plainly that no
        # regression statement was made.  A check that visited nothing has not
        # passed.
        for index in range(rendered.page_count):
            name = "page-%02d.png" % (index + 1)
            current_path = os.path.join(current_dir, name)
            rendered.save_png(index, current_path, dpi=dpi)
            result.current_pngs.append(current_path)
        result.blocked = True
        result.blocked_reason = (
            "no baseline exists for case %r under %s. A visual regression gate "
            "cannot make a statement about a case it has never seen, and a "
            "comparison run must not author one. The %d rendered page(s) are in "
            "%s; adopt them only with --update-baseline and --attribution."
            % (case, case_dir, rendered.page_count, current_dir)
        )
        return result

    approved_pages = set(attribution.get("pages") or [])
    regions = attribution.get("regions") or []

    for index in range(rendered.page_count):
        name = "page-%02d.png" % (index + 1)
        current_path = os.path.join(current_dir, name)
        rendered.save_png(index, current_path, dpi=dpi)
        result.current_pngs.append(current_path)
        baseline_path = os.path.join(case_dir, name)

        if update:
            os.makedirs(case_dir, exist_ok=True)
            _write_baseline_png(
                _load_png(current_path), baseline_path,
                update=update, reason=global_reason,
            )
            result.written.append(baseline_path)
            result.page_diffs.append(
                PageDiff(index + 1, baseline_path, 0, 0, None, True, global_reason,
                         note="baseline %s" % mode)
            )
            continue

        if not os.path.exists(baseline_path):
            # The case HAS a baseline but this page does not: the document grew.
            # Reported, never created.
            cur = _load_png(current_path)
            result.page_diffs.append(
                PageDiff(index + 1, None, 0, int(cur.shape[0] * cur.shape[1]), None,
                         False, None,
                         note="no baseline for this page: %s does not exist. The "
                              "document has more pages than the baseline, which is "
                              "itself the finding. NOT created by this run."
                              % baseline_path,
                         missing=True)
            )
            continue

        base = _load_png(baseline_path)
        cur = _load_png(current_path)
        if base.shape != cur.shape:
            result.page_diffs.append(
                PageDiff(index + 1, baseline_path, cur.shape[0] * cur.shape[1],
                         cur.shape[0] * cur.shape[1], None,
                         (index + 1) in approved_pages, global_reason,
                         note="page geometry changed: baseline %s vs current %s"
                              % (base.shape, cur.shape))
            )
            continue

        delta = np.abs(base.astype(np.int16) - cur.astype(np.int16)).max(axis=2)
        changed = delta > pixel_tolerance
        count = int(changed.sum())
        bbox = None
        if count:
            ys, xs = np.nonzero(changed)
            bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)

        attributed = count == 0
        reason = None
        if count and (index + 1) in approved_pages:
            attributed = True
            reason = global_reason
        if count and not attributed:
            covered = np.zeros_like(changed)
            for region in regions:
                if int(region.get("page", 0)) != index + 1:
                    continue
                x0, y0, x1, y1 = region["bbox"]
                covered[int(y0):int(y1), int(x0):int(x1)] = True
            if changed[~covered].sum() == 0:
                attributed = True
                reason = "; ".join(
                    r.get("reason", global_reason or "attributed region")
                    for r in regions if int(r.get("page", 0)) == index + 1
                )

        diff_png = None
        if count:
            highlight = cur.copy()
            highlight[changed] = [255, 0, 255]
            diff_png = _save_png(highlight, os.path.join(out_dir, "diff", name))

        result.page_diffs.append(
            PageDiff(index + 1, baseline_path, count, int(changed.size), bbox,
                     attributed, reason, diff_png=diff_png)
        )

    if update:
        # Pages the document no longer has would otherwise linger and make every
        # later run report a page-count mismatch forever.  Removing them is a
        # baseline mutation like any other and carries the same gate.
        for name in existing:
            match = PAGE_PNG_RE.match(name)
            if match and int(match.group(1)) > rendered.page_count:
                stale = os.path.join(case_dir, name)
                _remove_baseline_png(stale, update=update, reason=global_reason)
                result.removed.append(stale)
        return result

    if len(existing) != rendered.page_count:
        result.page_count_mismatch = True
        result.page_diffs.append(
            PageDiff(0, None, 0, 0, None, False, None,
                     note="page count changed: baseline %d, current %d. The "
                          "document's pagination moved; that is the finding. It is "
                          "NOT resolved by extending the baseline to fit."
                          % (len(existing), rendered.page_count),
                     defect=True)
        )

    return result
