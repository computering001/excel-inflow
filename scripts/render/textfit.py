"""Font-metric clipping prediction.

The render is the authority on clipping, but the same question can be answered
from advance widths alone, and doing so is worth having for two reasons:

  * it corroborates the rendered measurement -- if the prediction and the render
    disagree, one of them is wrong and that is worth knowing;
  * where LibreOffice is unavailable it is the only thing that can be said about
    clipping at all, and saying it precisely is better than saying nothing and
    better than claiming a pass.

Carlito is metric-compatible with Calibri, so measuring with EITHER font gives
the advance widths the LibreOffice render will use.  That equivalence is the
whole reason Calibri is kept in the workbook (ARCHITECTURE §9/§10); it does NOT
hold for Aptos -> DejaVu Sans.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from . import xlsx_model as xm

# Carlito first (what deployment host actually renders with), then Calibri (metric-
# compatible, and what ships with Microsoft Office).
FONT_CANDIDATES = {
    "regular": (
        "/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf",
        "/usr/share/fonts/crosextra/Carlito-Regular.ttf",
        "/usr/share/fonts/truetype/Carlito-Regular.ttf",
        os.path.expanduser("~/Library/Fonts/Carlito-Regular.ttf"),
        "/Applications/Microsoft Excel.app/Contents/Resources/DFonts/Calibri.ttf",
        "/Library/Fonts/Microsoft/Calibri.ttf",
        "C:/Windows/Fonts/calibri.ttf",
    ),
    "bold": (
        "/usr/share/fonts/truetype/crosextra/Carlito-Bold.ttf",
        "/usr/share/fonts/crosextra/Carlito-Bold.ttf",
        "/usr/share/fonts/truetype/Carlito-Bold.ttf",
        os.path.expanduser("~/Library/Fonts/Carlito-Bold.ttf"),
        "/Applications/Microsoft Excel.app/Contents/Resources/DFonts/Calibrib.ttf",
        "/Library/Fonts/Microsoft/Calibrib.ttf",
        "C:/Windows/Fonts/calibrib.ttf",
    ),
}

# The cell text margin, MEASURED from real renders rather than assumed.
#
# This constant used to say 2.835pt ("LibreOffice's default cell text margin is
# 0.1cm each side").  Calibrating the grid origin against the label column
# across 16 workbooks puts the rendered margin at 0.57-0.65pt at fit-to-width
# scales of 0.60-0.64, i.e. 0.94-1.02pt unscaled -- three times smaller than the
# assumption.  The corrected origin lands within 0.04pt of LibreOffice's own
# rendered column rules, so it is the origin, not the rules, that was wrong.
#
# The 3x overstatement made the prediction claim cells were clipped that the
# render then showed fitting.  A prediction that contradicts the authority it is
# meant to corroborate is worse than no prediction.
LIBREOFFICE_CELL_TEXT_MARGIN_PT = 0.95
# Excel's own cell padding is wider, so Excel clips sooner than LibreOffice.
# A cell that fits under the LibreOffice margin but not under this one is a
# real Excel risk that the LibreOffice render will NOT show.
EXCEL_CELL_TEXT_MARGIN_PT = 1.5
CELL_TEXT_MARGIN_PT = LIBREOFFICE_CELL_TEXT_MARGIN_PT


class FontUnavailable(RuntimeError):
    pass


@dataclass
class FontSet:
    regular_path: str
    bold_path: Optional[str]
    _fonts: dict = field(default_factory=dict)

    def _font(self, bold: bool):
        import fitz

        key = "bold" if bold and self.bold_path else "regular"
        if key not in self._fonts:
            path = self.bold_path if key == "bold" else self.regular_path
            self._fonts[key] = fitz.Font(fontfile=path)
        return self._fonts[key]

    def measure(self, text: str, size_pt: float, bold: bool = False) -> float:
        return self._font(bold).text_length(text, fontsize=size_pt)

    def family(self, bold: bool = False) -> str:
        return os.path.basename(self.bold_path if bold and self.bold_path else self.regular_path)


def load_font_set(regular: Optional[str] = None, bold: Optional[str] = None) -> FontSet:
    def first_existing(explicit, candidates):
        if explicit:
            if not os.path.exists(explicit):
                raise FontUnavailable("font file not found: %s" % explicit)
            return explicit
        for candidate in candidates:
            if os.path.exists(candidate):
                return candidate
        return None

    regular_path = first_existing(regular, FONT_CANDIDATES["regular"])
    if regular_path is None:
        raise FontUnavailable(
            "neither Carlito nor Calibri could be located; clipping cannot be "
            "predicted from metrics. Tried: %s" % ", ".join(FONT_CANDIDATES["regular"])
        )
    return FontSet(regular_path=regular_path,
                   bold_path=first_existing(bold, FONT_CANDIDATES["bold"]))


@dataclass
class ClipPrediction:
    ref: str
    row: int
    col: str
    text: str
    font_size_pt: float
    bold: bool
    required_pt: float
    own_column_pt: float
    available_pt: float          # own column plus any empty columns it can spill into
    blocked_by: Optional[str]    # the first occupied column to the right
    overflow_pt: float
    overflow_ratio: float

    def as_dict(self) -> dict:
        return {
            "ref": self.ref, "row": self.row, "column": self.col,
            "text": self.text, "font_size_pt": self.font_size_pt, "bold": self.bold,
            "required_pt": round(self.required_pt, 2),
            "own_column_pt": round(self.own_column_pt, 2),
            "available_pt": round(self.available_pt, 2),
            "blocked_by": self.blocked_by,
            "overflow_pt": round(self.overflow_pt, 2),
            "overflow_ratio": round(self.overflow_ratio, 4),
        }


def predict_clipping(
    workbook: xm.Workbook,
    sheet: xm.Sheet,
    fonts: FontSet,
    first_col: int,
    last_col: int,
    first_row: int,
    last_row: int,
    *,
    margin_pt: float = CELL_TEXT_MARGIN_PT,
    indent_pt_per_level: float = 9.0,
) -> List[ClipPrediction]:
    """Text cells whose rendered width exceeds the space they can occupy.

    Overflow into EMPTY neighbours is legal, so the space available to a cell is
    its own column plus every following empty column, up to the first occupied
    one.  This is scale-invariant: fit-to-width shrinks the text and the columns
    by the same factor.
    """
    edges = xm.column_edges_pt(sheet, first_col, last_col)
    out: List[ClipPrediction] = []

    for row in range(first_row, last_row + 1):
        for col in range(first_col, last_col + 1):
            cell = sheet.cell(row, col)
            if cell is None or cell.is_empty or xm.cell_is_numeric(cell):
                continue
            text = xm.cell_text(workbook, cell)
            if not text or not str(text).strip():
                continue
            style = workbook.style(cell.style_id)
            font = workbook.cell_font(cell.style_id)
            size = (font.size if font and font.size else 11.0)
            bold = bool(font.bold) if font else False
            alignment = (style.horizontal if style is not None else None) or "left"
            if alignment == "centerContinuous":
                # Excel centres the text across the whole following run of
                # centerContinuous cells; the space available is that run, and
                # it is measured below by walking right through empty cells.
                alignment = "center"

            indent = (style.indent if style else 0) * indent_pt_per_level
            required = fonts.measure(str(text), size, bold) + indent

            own = edges[col - first_col + 1] - edges[col - first_col]
            available = own
            blocked_by = None
            for c in range(col + 1, last_col + 1):
                neighbour = sheet.cell(row, c)
                occupied = neighbour is not None and not neighbour.is_empty and \
                    str(xm.cell_text(workbook, neighbour) or "").strip() != ""
                if occupied:
                    blocked_by = xm.col_index_to_letters(c)
                    break
                available += edges[c - first_col + 1] - edges[c - first_col]

            # Centred and right-aligned text also spills LEFT.  The previous
            # version skipped those cells entirely, which meant the centred
            # column headings -- the cells that the render actually finds
            # overflowing -- were reported as neither clipping nor unknown.
            if alignment in ("center", "right"):
                for c in range(col - 1, first_col - 1, -1):
                    neighbour = sheet.cell(row, c)
                    occupied = neighbour is not None and not neighbour.is_empty and \
                        str(xm.cell_text(workbook, neighbour) or "").strip() != ""
                    if occupied:
                        break
                    available += edges[c - first_col + 1] - edges[c - first_col]

            usable = available - 2 * margin_pt
            if required > usable:
                # Recorded so a reader can see how close the call was: the
                # prediction uses Calibri metrics and the render uses Carlito,
                # so a cell within a few tenths of a point of the boundary can
                # legitimately be called differently by the two. The render is
                # the authority; this is corroboration, not a second verdict.
                out.append(
                    ClipPrediction(
                        ref=cell.ref, row=row, col=xm.col_index_to_letters(col),
                        text=str(text), font_size_pt=size, bold=bold,
                        required_pt=required, own_column_pt=own, available_pt=usable,
                        blocked_by=blocked_by,
                        overflow_pt=required - usable,
                        overflow_ratio=(required / usable) if usable > 0 else float("inf"),
                    )
                )
    return out
