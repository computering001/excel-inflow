"""A synthetic spreadsheet renderer, used only to test the checks themselves.

This is NOT a substitute for LibreOffice and must never be used to certify a
workbook.  Its single purpose is to produce a PDF whose layout is known exactly,
with faults injected on demand, so that every check in `checks.py` can be shown
to FIRE on a defect and stay silent on a clean render.

Without this, "zero clips, zero overlaps" would be indistinguishable from "the
clip and overlap checks are broken" -- which is the same green-tick-for-missing-
evidence failure the fail-closed contract exists to prevent.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from . import cfeval
from . import xlsx_model as xm

A4_LANDSCAPE = (842.0, 595.0)
MARGIN_PT = 50.4  # 0.7in
FONT = "Helvetica"  # a base-14 stand-in; the font-set check is exercised separately


@dataclass
class Fault:
    """A deliberate defect to inject."""

    kind: str
    row: Optional[int] = None
    col: Optional[int] = None
    detail: dict = field(default_factory=dict)


@dataclass
class SynthPlan:
    scale: float
    origin_x: float
    origin_y: float
    pages: List[Tuple[int, int]]  # (first_row, last_row) per page


def render(
    workbook: xm.Workbook,
    sheet: xm.Sheet,
    dest_path: str,
    *,
    first_col: int,
    last_col: int,
    first_row: int,
    last_row: int,
    faults: Sequence[Fault] = (),
    apply_conditional_formatting: bool = True,
) -> SynthPlan:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfgen import canvas

    col_edges = xm.column_edges_pt(sheet, first_col, last_col)
    row_edges = xm.row_edges_pt(sheet, first_row, last_row)

    page_w, page_h = A4_LANDSCAPE
    usable_w = page_w - 2 * MARGIN_PT
    usable_h = page_h - 2 * MARGIN_PT
    scale = usable_w / col_edges[-1]

    pages: List[Tuple[int, int]] = []
    row = first_row
    while row <= last_row:
        start_offset = row_edges[row - first_row]
        end = row
        while end + 1 <= last_row and \
                (row_edges[end + 1 - first_row + 1] - start_offset) * scale <= usable_h:
            end += 1
        pages.append((row, end))
        row = end + 1

    by_fault: Dict[Tuple[Optional[int], Optional[int]], List[Fault]] = {}
    for fault in faults:
        by_fault.setdefault((fault.row, fault.col), []).append(fault)

    cf_fill = _conditional_fills(workbook, sheet) if apply_conditional_formatting else {}
    for fault in faults:
        if fault.kind == "cf_not_fired":
            cf_fill.pop((fault.row, fault.col), None)

    document = canvas.Canvas(dest_path, pagesize=A4_LANDSCAPE, pageCompression=0)
    for first, last in pages:
        top = row_edges[first - first_row]

        def x_of(col: int) -> float:
            return MARGIN_PT + scale * col_edges[col - first_col]

        def y_of(r: int) -> float:
            return MARGIN_PT + scale * (row_edges[r - first_row] - top)

        for r in range(first, last + 1):
            for c in range(first_col, last_col + 1):
                cell = sheet.cell(r, c)
                rgb = cf_fill.get((r, c))
                if rgb is None and cell is not None:
                    rgb = _rgb01(workbook.cell_fill_rgb(cell.style_id))
                for fault in by_fault.get((r, c), []):
                    if fault.kind == "wrong_fill":
                        rgb = _rgb01(fault.detail.get("rgb", "FF00FF"))
                if rgb is None:
                    continue
                x0, x1 = x_of(c), x_of(c + 1)
                y0, y1 = y_of(r), y_of(r + 1)
                document.setFillColorRGB(*rgb)
                document.rect(
                    x0,
                    page_h - y1,
                    x1 - x0,
                    y1 - y0,
                    stroke=0,
                    fill=1,
                )

        for r in range(first, last + 1):
            for c in range(first_col, last_col + 1):
                cell = sheet.cell(r, c)
                if cell is None or cell.is_empty:
                    continue
                text = _display_text(workbook, cell)
                if not text:
                    continue
                cell_faults = by_fault.get((r, c), [])
                if any(f.kind == "missing_text" for f in cell_faults):
                    continue
                font_obj = workbook.cell_font(cell.style_id)
                size = (font_obj.size if font_obj and font_obj.size else 11.0) * scale
                for fault in cell_faults:
                    if fault.kind == "widen_label":
                        # Grow the label until it overflows its column, but keep
                        # its midpoint inside the column so it is still assigned
                        # to this cell -- otherwise the fixture would exercise
                        # `presence`, not `clipping`.
                        available = x_of(c + 1) - x_of(c) - 4.0 * scale
                        target = available * fault.detail.get("factor", 1.4)
                        while pdfmetrics.stringWidth(text, FONT, size) < target:
                            text += "W"
                colour = _rgb01(font_obj.color_rgb if font_obj else None) or (0, 0, 0)
                width = pdfmetrics.stringWidth(text, FONT, size)
                pad = 2.0 * scale
                numeric = xm.cell_is_numeric(cell)
                if numeric:
                    x = x_of(c + 1) - pad - width
                else:
                    style = workbook.style(cell.style_id)
                    indent = (style.indent if style else 0) * 6.0 * scale
                    x = x_of(c) + pad + indent
                for fault in cell_faults:
                    if fault.kind == "shift_left":
                        x -= fault.detail.get("pt", 12.0)
                    if fault.kind == "misalign":
                        x += fault.detail.get("pt", 3.0)
                    if fault.kind == "overlap_left":
                        # Start the number just left of its own column edge: its
                        # centre stays inside the column (so it is still assigned
                        # to this cell) while its head collides with the number in
                        # the column to the left.
                        x = x_of(c) - fault.detail.get("pt", 4.0)
                baseline = y_of(r + 1) - (y_of(r + 1) - y_of(r) - size * 0.72) / 2.0
                document.setFillColorRGB(*colour)
                document.setFont(FONT, size)
                document.drawString(x, page_h - baseline, text)

        document.showPage()

    document.save()
    return SynthPlan(scale=scale, origin_x=MARGIN_PT, origin_y=MARGIN_PT, pages=pages)


def _conditional_fills(workbook: xm.Workbook, sheet: xm.Sheet) -> Dict[Tuple[int, int], Tuple[float, float, float]]:
    """What a correct renderer would paint for the CF rules that fire."""
    out: Dict[Tuple[int, int], Tuple[float, float, float]] = {}
    for rule in sorted(sheet.cf_rules, key=lambda r: (r.priority if r.priority is not None else 10 ** 6),
                       reverse=True):
        if rule.dxf_id is None or rule.dxf_id >= len(workbook.dxfs):
            continue
        rgb = _rgb01(workbook.dxfs[rule.dxf_id].fill_rgb)
        if rgb is None:
            continue
        outcome = cfeval.evaluate_rule(workbook, sheet, rule)
        for ref in outcome.fires:
            out[xm.split_ref(ref)] = rgb
    return out


def _rgb01(hex_value: Optional[str]) -> Optional[Tuple[float, float, float]]:
    if not hex_value:
        return None
    value = hex_value.upper().lstrip("#")
    if len(value) == 8:
        value = value[2:]
    if len(value) != 6:
        return None
    try:
        return tuple(int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    except ValueError:
        return None


def _display_text(workbook: xm.Workbook, cell: xm.Cell) -> str:
    text = xm.cell_text(workbook, cell)
    if text is None:
        return ""
    if xm.cell_is_numeric(cell):
        value = float(cell.raw_value)
        return ("%.1f" % value) if abs(value) >= 0.5 else ("%.2f" % value)
    return str(text)
