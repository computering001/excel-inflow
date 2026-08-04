"""The render-stage assertions.

Every check here is one that XML inspection structurally cannot make.  Where a
check *can* be made from XML it is stated as such and used only to corroborate.

Severity contract
-----------------
``blocked``  the run cannot be trusted at all (missing dependency, uncalibrated
             grid, unlocatable cell, unexpected font).  Never downgraded.
``defect``   a real rendering defect: clipping, overlap, a missing panel, a
             conditional-formatting rule that did not visibly fire.
``warning``  something to look at that is not on the fail-closed list.
``info``     measured facts recorded for the evidence file.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from . import calibrate, cfeval, pdfdoc
from . import xlsx_model as xm

BLOCKED = "blocked"
DEFECT = "defect"
WARNING = "warning"
INFO = "info"


@dataclass
class Finding:
    check: str
    severity: str
    message: str
    row: Optional[int] = None
    row_id: Optional[str] = None
    column: Optional[str] = None
    page: Optional[int] = None
    detail: dict = field(default_factory=dict)
    # Which sheet this finding is about.  The gate renders every visible sheet,
    # so an unqualified row/column/page number is ambiguous: `B9` means a
    # different thing on the Operating Model than it does on Brokers.  Stamped
    # by the caller once per sheet rather than passed through every check.
    sheet: Optional[str] = None

    def as_dict(self) -> dict:
        out = {
            "check": self.check,
            "severity": self.severity,
            "message": self.message,
        }
        if self.sheet is not None:
            out["sheet"] = self.sheet
        if self.row is not None:
            out["row"] = self.row
        if self.row_id is not None:
            out["row_id"] = self.row_id
        if self.column is not None:
            out["column"] = self.column
        if self.page is not None:
            out["page"] = self.page
        if self.detail:
            out["detail"] = self.detail
        return out


# --------------------------------------------------------------------------
# Raster sampling
# --------------------------------------------------------------------------


class Sampler:
    """Rasterises pages once and answers 'what colour is this rectangle'."""

    def __init__(self, rendered: pdfdoc.RenderedPdf, dpi: int = 150):
        self.rendered = rendered
        self.dpi = dpi
        self.scale = dpi / 72.0
        self._cache: Dict[int, object] = {}

    def raster(self, page: int):
        if page not in self._cache:
            self._cache[page] = self.rendered.raster(page, dpi=self.dpi)
        return self._cache[page]

    def modal_colour(
        self,
        page: int,
        rect: Tuple[float, float, float, float],
        exclude: Sequence[Tuple[float, float, float, float]] = (),
        inset_pt: float = 0.8,
    ) -> Optional[Tuple[int, int, int]]:
        import numpy as np

        arr = self.raster(page)
        h, w = arr.shape[0], arr.shape[1]
        x0 = int(math.floor((rect[0] + inset_pt) * self.scale))
        y0 = int(math.floor((rect[1] + inset_pt) * self.scale))
        x1 = int(math.ceil((rect[2] - inset_pt) * self.scale))
        y1 = int(math.ceil((rect[3] - inset_pt) * self.scale))
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(w, x1), min(h, y1)
        if x1 - x0 < 1 or y1 - y0 < 1:
            return None
        window = arr[y0:y1, x0:x1]
        mask = np.ones(window.shape[:2], dtype=bool)
        for ex in exclude:
            ex0 = max(x0, int(math.floor((ex[0] - 0.4) * self.scale))) - x0
            ey0 = max(y0, int(math.floor((ex[1] - 0.4) * self.scale))) - y0
            ex1 = min(x1, int(math.ceil((ex[2] + 0.4) * self.scale))) - x0
            ey1 = min(y1, int(math.ceil((ex[3] + 0.4) * self.scale))) - y0
            if ex1 > ex0 and ey1 > ey0:
                mask[max(0, ey0):max(0, ey1), max(0, ex0):max(0, ex1)] = False
        pixels = window[mask]
        if pixels.size == 0:
            pixels = window.reshape(-1, window.shape[-1])
        if pixels.size == 0:
            return None
        packed = (pixels[:, 0].astype(np.int32) << 16) | (pixels[:, 1].astype(np.int32) << 8) | pixels[:, 2].astype(np.int32)
        values, counts = np.unique(packed, return_counts=True)
        best = int(values[int(counts.argmax())])
        return ((best >> 16) & 255, (best >> 8) & 255, best & 255)


def hex_to_rgb(value: Optional[str]) -> Optional[Tuple[int, int, int]]:
    if not value:
        return None
    value = value.upper().lstrip("#")
    if len(value) == 8:
        value = value[2:]
    if len(value) != 6:
        return None
    try:
        return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))
    except ValueError:
        return None


def colour_distance(a: Tuple[int, int, int], b: Tuple[int, int, int]) -> int:
    return max(abs(int(a[i]) - int(b[i])) for i in range(3))


# --------------------------------------------------------------------------
# 1. Font set
# --------------------------------------------------------------------------

EXPECTED_FONT_FAMILIES = {"Carlito"}


def check_font_set(rendered: pdfdoc.RenderedPdf, expected: Optional[set] = None) -> List[Finding]:
    expected = expected or EXPECTED_FONT_FAMILIES
    observed = set(rendered.font_families())
    findings = [
        Finding("font_set", INFO, "observed font families: %s" % sorted(observed),
                detail={"observed": sorted(observed), "expected": sorted(expected)})
    ]
    if observed != expected:
        findings.append(
            Finding(
                "font_set", BLOCKED,
                "rendered font set %s != expected %s. Calibri->Carlito is "
                "metric-compatible; anything else (notably Aptos->DejaVu Sans) is "
                "not, and would make every geometry assertion in this file measure "
                "the wrong thing while still passing."
                % (sorted(observed), sorted(expected)),
                detail={"observed": sorted(observed), "expected": sorted(expected)},
            )
        )
    return findings


# --------------------------------------------------------------------------
# Cell text harvesting
# --------------------------------------------------------------------------


@dataclass
class CellRender:
    row: int
    col: int
    ref: str
    page: int
    rect: Tuple[float, float, float, float]
    words: List[pdfdoc.Word]

    @property
    def text(self) -> str:
        return " ".join(w.text for w in sorted(self.words, key=lambda w: w.x0))

    @property
    def bbox(self) -> Optional[Tuple[float, float, float, float]]:
        if not self.words:
            return None
        return (
            min(w.x0 for w in self.words), min(w.y0 for w in self.words),
            max(w.x1 for w in self.words), max(w.y1 for w in self.words),
        )


def assign_words(
    grid: calibrate.Grid,
    rendered: pdfdoc.RenderedPdf,
    workbook: Optional[xm.Workbook] = None,
    sheet: Optional[xm.Sheet] = None,
) -> Dict[Tuple[int, int], CellRender]:
    """Assign every rendered word to the cell whose rectangle contains its centre.

    Words whose centre falls outside every cell of the print grid are returned
    under key (-1, -1) so a caller can see that text landed somewhere it should
    not have.

    If `workbook`/`sheet` are supplied, spreadsheet OVERFLOW semantics are then
    applied: text that spills out of a cell into an EMPTY neighbour still belongs
    to the originating cell.  Without this, every long label that legitimately
    overflows a blank neighbour would be misread as a truncation, and its tail
    word would be misread as a misaligned entry in the neighbouring column.
    """
    out: Dict[Tuple[int, int], CellRender] = {}
    orphans = CellRender(-1, -1, "", -1, (0, 0, 0, 0), [])

    for fit in grid.pages:
        page = rendered.pages[fit.page]
        col_x = [grid.horizontal.x_of(e) for e in grid.col_edges_pt]
        row_y = {}
        for row in range(fit.first_row, fit.last_row + 1):
            ri = row - grid.first_row
            row_y[row] = (fit.y_of(grid.row_edges_pt[ri]), fit.y_of(grid.row_edges_pt[ri + 1]))
        for word in page.runs:
            row = None
            for candidate, (y0, y1) in row_y.items():
                if y0 - 0.5 <= word.cy <= y1 + 0.5:
                    row = candidate
                    break
            col = None
            for index in range(len(col_x) - 1):
                if col_x[index] - 0.5 <= word.cx <= col_x[index + 1] + 0.5:
                    col = grid.first_col + index
                    break
            if row is None or col is None:
                orphans.words.append(word)
                continue
            key = (row, col)
            if key not in out:
                ri = row - grid.first_row
                ci = col - grid.first_col
                out[key] = CellRender(
                    row=row, col=col,
                    ref="%s%d" % (xm.col_index_to_letters(col), row),
                    page=fit.page,
                    rect=(col_x[ci], row_y[row][0], col_x[ci + 1], row_y[row][1]),
                    words=[],
                )
            out[key].words.append(word)
    if workbook is not None and sheet is not None:
        _merge_overflow(out, grid, workbook, sheet)
    if orphans.words:
        out[(-1, -1)] = orphans
    return out


def _cell_has_text(workbook: xm.Workbook, sheet: xm.Sheet, row: int, col: int) -> bool:
    cell = sheet.cell(row, col)
    if cell is None or cell.is_empty:
        return False
    text = xm.cell_text(workbook, cell)
    return text is not None and str(text).strip() != ""


# Alignments that let a cell's text spill to the RIGHT of its own column, and
# to the LEFT.  `centerContinuous` is the one that matters most here: Excel
# centres the text across the whole run of following cells that carry the same
# alignment, so a column-group heading declared in G lands in the middle of
# G:L and is nowhere near G's own rectangle.
_SPILLS_RIGHT = {"left", "center", "centerContinuous", "general", "fill", "justify"}
_SPILLS_LEFT = {"right", "center", "centerContinuous", "justify"}


def _effective_alignment(workbook: xm.Workbook, sheet: xm.Sheet, row: int, col: int) -> str:
    cell = sheet.cell(row, col)
    if cell is None:
        return "left"
    style = workbook.style(cell.style_id)
    declared = style.horizontal if style is not None else None
    if declared:
        return declared
    # No explicit alignment: Excel's general format right-aligns numbers and
    # left-aligns text.
    return "right" if xm.cell_is_numeric(cell) else "left"


def _merge_overflow(
    out: Dict[Tuple[int, int], CellRender],
    grid: calibrate.Grid,
    workbook: xm.Workbook,
    sheet: xm.Sheet,
) -> None:
    """Re-attach spilled text to the cell that owns it.

    Spreadsheet text overflows into EMPTY neighbours, so a word sitting in an
    empty cell's rectangle belongs to a text-bearing cell on one side or the
    other.  Which side is decided by the candidate owner's alignment, not by a
    left-first guess: a right-aligned number spills leftwards and a
    `centerContinuous` heading spills rightwards, and getting that backwards
    files the heading under the wrong column and then reports its real column as
    empty.  The owner's CellRender is CREATED if it does not exist yet -- the
    previous version abandoned the merge in exactly the case that matters, where
    none of the owner's own text landed in its own rectangle.
    """
    rows = sorted({row for row, _col in out if row >= 0})
    for row in rows:
        for col in range(grid.first_col, grid.last_col + 1):
            key = (row, col)
            render = out.get(key)
            if render is None or _cell_has_text(workbook, sheet, row, col):
                continue

            left = next((c for c in range(col - 1, grid.first_col - 1, -1)
                         if _cell_has_text(workbook, sheet, row, c)), None)
            right = next((c for c in range(col + 1, grid.last_col + 1)
                          if _cell_has_text(workbook, sheet, row, c)), None)
            candidates: List[int] = []
            if left is not None and _effective_alignment(workbook, sheet, row, left) in _SPILLS_RIGHT:
                candidates.append(left)
            if right is not None and _effective_alignment(workbook, sheet, row, right) in _SPILLS_LEFT:
                candidates.append(right)
            if not candidates:
                continue
            # An owner that has not yet had any of its own text located is the
            # one that needs this text; if both are unplaced, the nearer wins.
            unplaced = [c for c in candidates if not out.get((row, c)) or not out[(row, c)].words]
            pool = unplaced or candidates
            owner_col = min(pool, key=lambda c: abs(c - col))
            owner = (row, owner_col)
            if owner == key:
                continue
            if owner not in out:
                rect = grid.cell_rect(row, owner_col)
                if rect is None:
                    continue
                out[owner] = CellRender(
                    row=row, col=owner_col,
                    ref="%s%d" % (xm.col_index_to_letters(owner_col), row),
                    page=rect[0], rect=rect[1:], words=[],
                )
            out[owner].words.extend(render.words)
            del out[key]


# --------------------------------------------------------------------------
# 2. Character-advance model (predicts clipping even when LibreOffice truncated)
# --------------------------------------------------------------------------


@dataclass
class TextMetrics:
    char_width_pt: Dict[str, float]
    mean_width_pt: float
    space_width_pt: float
    rms_error_pt: float
    samples: int

    def measure(self, text: str) -> float:
        total = 0.0
        for ch in text:
            if ch == " ":
                total += self.space_width_pt
            else:
                total += self.char_width_pt.get(ch, self.mean_width_pt)
        return total


def fit_text_metrics(rendered: pdfdoc.RenderedPdf, max_words: int = 6000) -> Optional[TextMetrics]:
    """Least-squares per-character advance widths, measured from this render.

    Deriving the metrics from the render itself rather than from a font file
    means the clipping check does not depend on locating Carlito on disk, and it
    automatically tracks whatever fit-to-width scale LibreOffice chose.
    """
    try:
        import numpy as np
    except Exception:
        return None

    samples: List[Tuple[str, float]] = []
    for page in rendered.pages:
        for word in page.runs:
            if 1 <= len(word.text) <= 32 and word.width > 0:
                samples.append((word.text, word.width))
            if len(samples) >= max_words:
                break
        if len(samples) >= max_words:
            break
    if len(samples) < 20:
        return None

    vocabulary = sorted({ch for text, _ in samples for ch in text})
    index = {ch: i for i, ch in enumerate(vocabulary)}
    matrix = np.zeros((len(samples), len(vocabulary)), dtype=float)
    target = np.zeros(len(samples), dtype=float)
    for i, (text, width) in enumerate(samples):
        for ch in text:
            matrix[i, index[ch]] += 1.0
        target[i] = width
    solution, *_ = np.linalg.lstsq(matrix, target, rcond=None)
    widths = {ch: float(max(0.0, solution[index[ch]])) for ch in vocabulary}
    residual = matrix.dot(solution) - target
    rms = float(np.sqrt((residual ** 2).mean()))

    # Text runs carry their own spaces, so the space advance falls out of the
    # same regression rather than needing a separate inter-word gap estimate.
    space = widths.get(" ")
    if not space:
        space = (sum(widths.values()) / max(1, len(widths))) * 0.45

    return TextMetrics(
        char_width_pt=widths,
        mean_width_pt=sum(widths.values()) / max(1, len(widths)),
        space_width_pt=space,
        rms_error_pt=rms,
        samples=len(samples),
    )


# --------------------------------------------------------------------------
# 3. Presence
# --------------------------------------------------------------------------

_HASH_ONLY = re.compile(r"^#+$")


def check_presence(
    workbook: xm.Workbook,
    sheet: xm.Sheet,
    grid: calibrate.Grid,
    assigned: Dict[Tuple[int, int], CellRender],
    row_ids: Dict[int, str],
) -> List[Finding]:
    findings: List[Finding] = []
    located = 0
    expected = 0
    for row in range(grid.first_row, grid.last_row + 1):
        for col in range(grid.first_col, grid.last_col + 1):
            cell = sheet.cell(row, col)
            if cell is None or cell.is_empty:
                continue
            text = xm.cell_text(workbook, cell)
            if text is None or str(text).strip() == "":
                continue
            expected += 1
            rect = grid.cell_rect(row, col)
            if rect is None:
                findings.append(
                    Finding("presence", BLOCKED,
                            "cell %s carries a value but falls outside the paginated "
                            "print range; the grid could not locate it" % cell.ref,
                            row=row, row_id=row_ids.get(row),
                            column=xm.col_index_to_letters(col))
                )
                continue
            render = assigned.get((row, col))
            if render is None or not render.words:
                # A number formatted to nothing (e.g. ";;;" custom format) is a
                # legitimate blank; anything else is a panel that did not render.
                fmt = _num_fmt(workbook, cell)
                if fmt and fmt.replace(" ", "") in (";;;", ";;"):
                    continue
                findings.append(
                    Finding("presence", DEFECT,
                            "cell %s holds %r but no text was rendered inside its "
                            "rectangle" % (cell.ref, _clip(text)),
                            row=row, row_id=row_ids.get(row),
                            column=xm.col_index_to_letters(col),
                            page=rect[0] + 1,
                            detail={"expected_text": _clip(text), "rect": [round(v, 2) for v in rect[1:]]})
                )
                continue
            located += 1
    findings.insert(0, Finding("presence", INFO,
                               "%d/%d non-empty cells located in the render" % (located, expected),
                               detail={"located": located, "expected": expected}))
    return findings


def _num_fmt(workbook: xm.Workbook, cell: xm.Cell) -> Optional[str]:
    style = workbook.style(cell.style_id)
    if style is None:
        return None
    return workbook.num_fmts.get(style.num_fmt_id)


def _clip(text, limit: int = 60) -> str:
    text = str(text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


# --------------------------------------------------------------------------
# 4. Clipping
# --------------------------------------------------------------------------


def check_clipping(
    workbook: xm.Workbook,
    sheet: xm.Sheet,
    grid: calibrate.Grid,
    assigned: Dict[Tuple[int, int], CellRender],
    metrics: Optional[TextMetrics],
    row_ids: Dict[int, str],
    *,
    overflow_tolerance_pt: float = 0.6,
) -> List[Finding]:
    findings: List[Finding] = []
    pad = max(0.5, grid.horizontal.right_edge_pad_pt)

    for (row, col), render in sorted(assigned.items()):
        if row < 0:
            continue
        cell = sheet.cell(row, col)
        if cell is None or cell.is_empty:
            continue
        expected_text = xm.cell_text(workbook, cell)
        if expected_text is None:
            continue
        is_text = not xm.cell_is_numeric(cell)
        bbox = render.bbox
        if bbox is None:
            continue

        neighbour = sheet.cell(row, col + 1)
        neighbour_occupied = neighbour is not None and not neighbour.is_empty
        column_right = render.rect[2]
        column_width = render.rect[2] - render.rect[0]

        rendered_text = render.text
        if _HASH_ONLY.match(rendered_text.strip()):
            findings.append(
                Finding("clipping", DEFECT,
                        "cell %s rendered as %r: the column is too narrow for the "
                        "formatted number" % (cell.ref, rendered_text.strip()),
                        row=row, row_id=row_ids.get(row),
                        column=xm.col_index_to_letters(col), page=render.page + 1,
                        detail={"expected": _clip(expected_text)})
            )
            continue

        if is_text:
            normalised_expected = calibrate.normalise_label(str(expected_text))
            normalised_actual = calibrate.normalise_label(rendered_text)
            if normalised_actual != normalised_expected:
                if normalised_expected.startswith(normalised_actual) and normalised_actual:
                    findings.append(
                        Finding("clipping", DEFECT,
                                "label %s rendered truncated: %r of %r"
                                % (cell.ref, _clip(rendered_text), _clip(expected_text)),
                                row=row, row_id=row_ids.get(row),
                                column=xm.col_index_to_letters(col), page=render.page + 1,
                                detail={"rendered": _clip(rendered_text),
                                        "expected": _clip(expected_text)})
                    )
                    continue

            if bbox[2] > column_right - pad + overflow_tolerance_pt and neighbour_occupied:
                findings.append(
                    Finding("clipping", DEFECT,
                            "label %s overflows its column (text right edge %.2fpt vs "
                            "column right edge %.2fpt) and column %s in the same row is "
                            "occupied"
                            % (cell.ref, bbox[2], column_right - pad,
                               xm.col_index_to_letters(col + 1)),
                            row=row, row_id=row_ids.get(row),
                            column=xm.col_index_to_letters(col), page=render.page + 1,
                            detail={"text_right_pt": round(bbox[2], 2),
                                    "column_right_pt": round(column_right - pad, 2),
                                    "text": _clip(rendered_text)})
                )
                continue

            # Centred and right-aligned labels spill LEFT as well.  Checking
            # only the right edge means a centred column heading that runs into
            # an occupied cell on its left is measured as fitting.
            left_neighbour = sheet.cell(row, col - 1) if col > grid.first_col else None
            left_occupied = left_neighbour is not None and not left_neighbour.is_empty
            if (_effective_alignment(workbook, sheet, row, col) in _SPILLS_LEFT
                    and left_occupied
                    and bbox[0] < render.rect[0] + pad - overflow_tolerance_pt):
                findings.append(
                    Finding("clipping", DEFECT,
                            "label %s overflows its column to the LEFT (text left edge "
                            "%.2fpt vs column left edge %.2fpt) and column %s in the "
                            "same row is occupied"
                            % (cell.ref, bbox[0], render.rect[0] + pad,
                               xm.col_index_to_letters(col - 1)),
                            row=row, row_id=row_ids.get(row),
                            column=xm.col_index_to_letters(col), page=render.page + 1,
                            detail={"text_left_pt": round(bbox[0], 2),
                                    "column_left_pt": round(render.rect[0] + pad, 2),
                                    "text": _clip(rendered_text)})
                )
                continue

            if metrics is not None:
                predicted = metrics.measure(str(expected_text))
                available = column_width - 2 * pad
                if predicted > available + 0.75 and neighbour_occupied:
                    findings.append(
                        Finding("clipping", DEFECT,
                                "label %s needs %.1fpt but column %s offers %.1fpt and the "
                                "next column is occupied"
                                % (cell.ref, predicted, xm.col_index_to_letters(col), available),
                                row=row, row_id=row_ids.get(row),
                                column=xm.col_index_to_letters(col), page=render.page + 1,
                                detail={"needed_pt": round(predicted, 2),
                                        "available_pt": round(available, 2),
                                        "text": _clip(expected_text)})
                    )
        else:
            if bbox[0] < render.rect[0] - overflow_tolerance_pt:
                findings.append(
                    Finding("clipping", DEFECT,
                            "number %s starts %.2fpt left of its column edge -- it does "
                            "not fit its column" % (cell.ref, render.rect[0] - bbox[0]),
                            row=row, row_id=row_ids.get(row),
                            column=xm.col_index_to_letters(col), page=render.page + 1,
                            detail={"text": _clip(rendered_text)})
                )
    return findings


# --------------------------------------------------------------------------
# 5. Overlap
# --------------------------------------------------------------------------


def check_overlap(
    grid: calibrate.Grid,
    assigned: Dict[Tuple[int, int], CellRender],
    row_ids: Dict[int, str],
    *,
    min_overlap_pt2: float = 0.25,
) -> List[Finding]:
    findings: List[Finding] = []
    by_row: Dict[int, List[CellRender]] = defaultdict(list)
    for (row, col), render in assigned.items():
        if row < 0:
            continue
        by_row[row].append(render)

    for row, renders in sorted(by_row.items()):
        renders.sort(key=lambda r: r.col)
        for i in range(len(renders)):
            for j in range(i + 1, len(renders)):
                a, b = renders[i], renders[j]
                if a.page != b.page:
                    continue
                box_a, box_b = a.bbox, b.bbox
                if box_a is None or box_b is None:
                    continue
                dx = min(box_a[2], box_b[2]) - max(box_a[0], box_b[0])
                dy = min(box_a[3], box_b[3]) - max(box_a[1], box_b[1])
                if dx > 0 and dy > 0 and dx * dy >= min_overlap_pt2:
                    findings.append(
                        Finding("overlap", DEFECT,
                                "text of %s and %s overlap by %.2f x %.2f pt"
                                % (a.ref, b.ref, dx, dy),
                                row=row, row_id=row_ids.get(row),
                                column=xm.col_index_to_letters(a.col), page=a.page + 1,
                                detail={"a": {"ref": a.ref, "text": _clip(a.text)},
                                        "b": {"ref": b.ref, "text": _clip(b.text)},
                                        "overlap_pt": [round(dx, 2), round(dy, 2)]})
                    )
    return findings


# --------------------------------------------------------------------------
# 6. Alignment
# --------------------------------------------------------------------------


def check_alignment(
    grid: calibrate.Grid,
    assigned: Dict[Tuple[int, int], CellRender],
    numeric_cols: Sequence[int],
    sheet: xm.Sheet,
    workbook: Optional[xm.Workbook] = None,
    *,
    tolerance_pt: float = 0.75,
) -> List[Finding]:
    """RIGHT-ALIGNED numeric cells in a numeric column must share a right-edge x.

    Two exclusions, both because the check would otherwise compare things that
    were never meant to line up:

    * cells that do not hold a number.  Numeric columns also carry left-aligned
      block headings.
    * cells that are not right-aligned.  These columns also carry deliberately
      CENTRED entries -- the On/Off control toggles and the term-table dates --
      and a centred cell's right edge is 13pt short of a right-aligned one by
      design.  Including them made the median meaningless and reported a correct
      layout as broken.

    The exclusions are counted and reported, so a column where nothing was
    comparable says so instead of passing silently.
    """
    findings: List[Finding] = []
    for col in numeric_cols:
        letters = xm.col_index_to_letters(col)
        numeric = 0
        edges: List[Tuple[int, float]] = []
        skipped: Dict[str, int] = {}
        for (row, c), render in assigned.items():
            if c != col or row < 0 or render.bbox is None:
                continue
            cell = sheet.cell(row, c)
            if cell is None or not xm.cell_is_numeric(cell):
                continue
            numeric += 1
            alignment = (
                _effective_alignment(workbook, sheet, row, col) if workbook is not None
                else "right"
            )
            if alignment != "right":
                skipped[alignment] = skipped.get(alignment, 0) + 1
                continue
            edges.append((row, render.bbox[2]))

        if len(edges) < 3:
            findings.append(
                Finding("alignment", INFO,
                        "column %s: only %d of %d numeric cells are right-aligned, too "
                        "few to assert a shared right edge (skipped: %s)"
                        % (letters, len(edges), numeric, skipped or "none"),
                        column=letters,
                        detail={"right_aligned": len(edges), "numeric": numeric,
                                "skipped_by_alignment": skipped})
            )
            continue

        values = sorted(e for _row, e in edges)
        median = values[len(values) // 2]
        outliers = [(row, e) for row, e in edges if abs(e - median) > tolerance_pt]
        worst = max(abs(e - median) for _row, e in edges)
        findings.append(
            Finding("alignment", INFO,
                    "column %s right edge x=%.2fpt over %d right-aligned cells of %d "
                    "numeric (max deviation %.2fpt; skipped: %s)"
                    % (letters, median, len(edges), numeric, worst, skipped or "none"),
                    column=letters,
                    detail={"right_edge_pt": round(median, 2), "cells": len(edges),
                            "numeric_cells": numeric,
                            "skipped_by_alignment": skipped,
                            "max_deviation_pt": round(worst, 3)})
        )
        if outliers:
            findings.append(
                Finding("alignment", DEFECT,
                        "column %s does not share a right edge: %d of %d right-aligned "
                        "cells deviate by more than %.2fpt"
                        % (letters, len(outliers), len(edges), tolerance_pt),
                        column=letters,
                        detail={"outliers": [{"row": row, "deviation_pt": round(e - median, 3)}
                                             for row, e in outliers[:12]]})
            )
    return findings


# --------------------------------------------------------------------------
# 7. Structure -- fills at coordinates derived from the row plan
# --------------------------------------------------------------------------


def check_structure(
    workbook: xm.Workbook,
    sheet: xm.Sheet,
    grid: calibrate.Grid,
    assigned: Dict[Tuple[int, int], CellRender],
    sampler: Sampler,
    row_map,
    *,
    tolerance: int = 10,
) -> List[Finding]:
    findings: List[Finding] = []
    section_rows = row_map.section_header_rows
    gutters = [xm.col_letters_to_index(c) for c in row_map.gutter_column_letters(
        xm.col_index_to_letters(grid.first_col), xm.col_index_to_letters(grid.last_col))]
    answer_rows = row_map.answer_rows()

    targets: List[Tuple[str, str, int, int]] = []  # (group, identity, row, col)
    for name, row in sorted(section_rows.items()):
        for col in range(grid.first_col, grid.last_col + 1):
            if col in gutters:
                continue
            targets.append(("section_band", name, row, col))
    for row in range(grid.first_row, grid.last_row + 1):
        for col in gutters:
            targets.append(("gutter", xm.col_index_to_letters(col), row, col))
    for name, row in sorted(answer_rows.items()):
        for col in range(grid.first_col, grid.last_col + 1):
            targets.append(("answer_row", name, row, col))

    cf_cells = _cf_covered_cells(sheet)
    checked = 0
    mismatches: List[Finding] = []
    seen: set = set()
    for group, identity, row, col in targets:
        if (row, col) in seen:
            continue
        seen.add((row, col))
        cell = sheet.cell(row, col)
        if cell is None:
            continue
        declared = workbook.cell_fill_rgb(cell.style_id)
        expected_rgb = hex_to_rgb(declared)
        if expected_rgb is None:
            continue
        if (row, col) in cf_cells:
            # A conditionally-formatted cell is allowed to differ from its static
            # fill; that case is asserted by check_conditional_formatting.
            continue
        rect = grid.cell_rect(row, col)
        if rect is None:
            continue
        render = assigned.get((row, col))
        exclude = [render.bbox] if render is not None and render.bbox else []
        observed = sampler.modal_colour(rect[0], rect[1:], exclude=exclude)
        if observed is None:
            continue
        checked += 1
        if colour_distance(observed, expected_rgb) > tolerance:
            mismatches.append(
                Finding("structure", DEFECT,
                        "%s %s: cell %s declares fill #%s but renders as #%02X%02X%02X"
                        % (group, identity, cell.ref, declared, *observed),
                        row=row, column=xm.col_index_to_letters(col), page=rect[0] + 1,
                        detail={"group": group, "identity": identity,
                                "declared": declared,
                                "observed": "%02X%02X%02X" % observed})
            )

    findings.append(
        Finding("structure", INFO,
                "%d structural cells sampled (%d section-band, gutter and answer-row "
                "coordinates derived from the row plan)" % (checked, len(seen)),
                detail={"sampled": checked, "targets": len(seen),
                        "gutter_columns": [xm.col_index_to_letters(c) for c in gutters],
                        "section_header_rows": section_rows})
    )
    findings.extend(mismatches[:200])
    if len(mismatches) > 200:
        findings.append(Finding("structure", INFO,
                                "%d further fill mismatches suppressed" % (len(mismatches) - 200)))
    return findings


def _cf_covered_cells(sheet: xm.Sheet) -> set:
    covered = set()
    for rule in sheet.cf_rules:
        try:
            covered.update(cfeval.expand_sqref(rule.sqref))
        except Exception:
            continue
    return covered


# --------------------------------------------------------------------------
# 8. Conditional formatting actually fired
# --------------------------------------------------------------------------


def check_conditional_formatting_declared(
    workbook: xm.Workbook,
    sheet: xm.Sheet,
    *,
    invisible_below: int = 4,
    faint_below: int = 24,
) -> List[Finding]:
    """The half of the CF check that needs no render geometry.

    Whether a rule fires, and whether the fill it applies differs from the fill
    already underneath, are both answerable from the workbook alone.  That
    matters because it is exactly the pair of failures behind the defect this
    check exists for -- a broker-case highlight whose fill was identical to
    every subtotal, so it marked nothing on 5 of 6 cases while passing every
    structural assertion.

    It is split out from the sampled half deliberately.  The Brokers sheet
    cannot always be calibrated (its rows repeat `Broker Alpha / Consensus /
    High / Low` per block, so a thin final page may carry no uniquely-labelled
    row to fit a grid against), and when calibration failed this analysis used
    to be skipped with it -- 4 of 8 cases reported ZERO conditional-formatting
    findings on the very sheet the defect lives on.  A calibration failure
    still BLOCKS the sheet; it no longer silences this.
    """
    findings: List[Finding] = []
    by_priority = sorted(
        sheet.cf_rules,
        key=lambda r: (r.priority if r.priority is not None else 10 ** 6),
    )

    fired_any = 0
    for rule in by_priority:
        outcome = cfeval.evaluate_rule(workbook, sheet, rule)
        dxf = workbook.dxfs[rule.dxf_id] if rule.dxf_id is not None and rule.dxf_id < len(workbook.dxfs) else None
        dxf_rgb = hex_to_rgb(dxf.fill_rgb) if dxf else None

        base = {
            "sqref": rule.sqref,
            "type": rule.rule_type,
            "priority": rule.priority,
            "dxf_id": rule.dxf_id,
            "formula": outcome.formula,
            "dxf_fill": dxf.fill_rgb if dxf else None,
            "fires_at": outcome.fires[:12],
            "quiet_at": len(outcome.quiet),
            "undetermined_at": len(outcome.undetermined),
        }

        if outcome.undetermined and not outcome.fires and not outcome.quiet:
            findings.append(
                Finding("conditional_formatting", WARNING,
                        "rule on %s (%s) could not be evaluated: %s -- whether it fires "
                        "is UNKNOWN, not false"
                        % (rule.sqref, rule.rule_type, outcome.reason),
                        detail=base)
            )
            continue

        if not outcome.fires:
            findings.append(
                Finding("conditional_formatting", WARNING,
                        "rule on %s (%s) fires on no cell in this case -- declared but "
                        "inert here" % (rule.sqref, rule.rule_type),
                        detail=base)
            )
            continue

        fired_any += 1

        if dxf_rgb is None:
            findings.append(
                Finding("conditional_formatting", INFO,
                        "rule on %s fires but applies no solid fill; nothing to sample"
                        % rule.sqref, detail=base)
            )
            continue

        deltas: Dict[str, int] = {}
        for ref in outcome.fires:
            row, col = xm.split_ref(ref)
            cell = sheet.cell(row, col)
            static = workbook.cell_fill_rgb(cell.style_id) if cell else None
            static_rgb = hex_to_rgb(static) or (255, 255, 255)
            deltas[ref] = colour_distance(static_rgb, dxf_rgb)
        if not deltas:
            continue
        worst = max(deltas.values())
        invisible = [r for r, d in deltas.items() if d < invisible_below]
        summary = dict(base, channel_deltas={
            "max": worst, "min": min(deltas.values()),
            "cells": len(deltas), "invisible_cells": len(invisible),
            "sample_invisible": sorted(invisible)[:8],
        })
        if worst < invisible_below:
            findings.append(
                Finding("conditional_formatting", DEFECT,
                        "rule on %s fires but its fill #%s is identical to the fill "
                        "already under every one of its %d cells -- the rule paints "
                        "no visible mark anywhere"
                        % (rule.sqref, dxf.fill_rgb, len(deltas)),
                        detail=summary)
            )
        elif invisible:
            findings.append(
                Finding("conditional_formatting", WARNING,
                        "rule on %s fires but is invisible on %d of %d cells: their "
                        "own fill is already #%s, so toggling the control changes "
                        "nothing there"
                        % (rule.sqref, len(invisible), len(deltas), dxf.fill_rgb),
                        detail=summary)
            )
        elif worst < faint_below:
            findings.append(
                Finding("conditional_formatting", WARNING,
                        "rule on %s fires but its fill #%s is within %d/255 of the "
                        "fill underneath on every cell -- barely visible"
                        % (rule.sqref, dxf.fill_rgb, worst),
                        detail=summary)
            )

    findings.insert(0, Finding("conditional_formatting", INFO,
                               "%d of %d declared rules fire somewhere in this case"
                               % (fired_any, len(sheet.cf_rules)),
                               detail={"rules": len(sheet.cf_rules), "firing": fired_any}))
    return findings


def check_conditional_formatting(
    workbook: xm.Workbook,
    sheet: xm.Sheet,
    grid: calibrate.Grid,
    assigned: Dict[Tuple[int, int], CellRender],
    sampler: Sampler,
    *,
    tolerance: int = 12,
    invisible_below: int = 4,
    faint_below: int = 24,
    max_cells_per_rule: int = 8,
) -> List[Finding]:
    """The check nothing else in the system can make.

    A CF rule is declared in XML but only executes at render.  Two failures are
    invisible to every structural check:

      * the predicate never evaluates true, so the rule does nothing;
      * the predicate fires but paints a fill indistinguishable from the fill
        already underneath, so the control carries no visible mark.

    The second is not hypothetical -- a broker-case highlight used a fill
    identical to every subtotal and so marked nothing on 5 of 6 cases while
    passing every structural assertion.

    This is the full check: the declaration analysis above, plus the sampled
    confirmation that the fill actually reached the page.  Callers that may not
    have a calibrated grid should run the two halves separately so a
    calibration failure cannot silence the first.
    """
    return (check_conditional_formatting_declared(
                workbook, sheet,
                invisible_below=invisible_below, faint_below=faint_below)
            + check_conditional_formatting_rendered(
                workbook, sheet, grid, assigned, sampler,
                tolerance=tolerance, max_cells_per_rule=max_cells_per_rule))


def check_conditional_formatting_rendered(
    workbook: xm.Workbook,
    sheet: xm.Sheet,
    grid: calibrate.Grid,
    assigned: Dict[Tuple[int, int], CellRender],
    sampler: Sampler,
    *,
    tolerance: int = 12,
    max_cells_per_rule: int = 8,
) -> List[Finding]:
    """Did the fill a firing rule declares actually reach the page?

    The half that needs a calibrated grid: it samples the rendered pixels under
    each firing cell.  A rule whose predicate is true and whose fill is plainly
    distinguishable can still paint nothing, and only the raster shows that.
    """
    findings: List[Finding] = []
    by_priority = sorted(
        sheet.cf_rules,
        key=lambda r: (r.priority if r.priority is not None else 10 ** 6),
    )

    for rule in by_priority:
        outcome = cfeval.evaluate_rule(workbook, sheet, rule)
        if not outcome.fires:
            continue
        dxf = workbook.dxfs[rule.dxf_id] if rule.dxf_id is not None and rule.dxf_id < len(workbook.dxfs) else None
        dxf_rgb = hex_to_rgb(dxf.fill_rgb) if dxf else None
        if dxf_rgb is None:
            continue

        base = {
            "sqref": rule.sqref,
            "type": rule.rule_type,
            "priority": rule.priority,
            "dxf_id": rule.dxf_id,
            "formula": outcome.formula,
            "dxf_fill": dxf.fill_rgb,
            "fires_at": outcome.fires[:12],
        }

        sampled = 0
        for ref in outcome.fires[:max_cells_per_rule]:
            row, col = xm.split_ref(ref)
            rect = grid.cell_rect(row, col)
            if rect is None:
                continue
            render = assigned.get((row, col))
            exclude = [render.bbox] if render is not None and render.bbox else []
            observed = sampler.modal_colour(rect[0], rect[1:], exclude=exclude)
            if observed is None:
                continue
            sampled += 1
            if colour_distance(observed, dxf_rgb) > tolerance:
                findings.append(
                    Finding("conditional_formatting", DEFECT,
                            "rule on %s should fire at %s (formula %r evaluates TRUE on "
                            "the delivered caches) and apply #%s, but the render shows "
                            "#%02X%02X%02X -- the rule is declared and does nothing"
                            % (rule.sqref, ref, outcome.formula, dxf.fill_rgb, *observed),
                            row=row, column=xm.col_index_to_letters(col), page=rect[0] + 1,
                            detail=dict(base, observed="%02X%02X%02X" % observed))
                )
                break
        if sampled == 0:
            findings.append(
                Finding("conditional_formatting", WARNING,
                        "rule on %s fires but no firing cell could be sampled in the "
                        "render" % rule.sqref, detail=base)
            )
    return findings
