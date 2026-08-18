"""Map the workbook grid onto rendered PDF coordinates.

Fit-to-width means the scale factor is chosen by LibreOffice and is not known
a priori, so it is *measured from the render* rather than assumed:

  horizontal   right-aligned numeric columns produce tight vertical clusters of
               word right-edges.  Regressing those cluster centres against the
               workbook's cumulative column edges recovers (offset, scale).  The
               residuals of that regression ARE the alignment check.

  vertical     the scale is uniform (fitToHeight=0), so only a per-page offset
               and a per-page first row remain.  Both are recovered by matching
               the rendered label-column text against the workbook's label
               sequence -- i.e. by row identity, not by physical row number.

If either fit fails to reach its inlier threshold the caller must treat the run
as BLOCKED.  An uncalibrated grid would make every downstream assertion measure
the wrong rectangle while still reporting a pass.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from . import pdfdoc
from . import xlsx_model as xm


@dataclass
class HorizontalFit:
    offset_pt: float          # PDF x of workbook grid origin (print-area left edge)
    scale: float              # fit-to-width scale actually applied
    inliers: int
    candidates: int
    residual_max_pt: float
    residual_rms_pt: float
    right_edge_pad_pt: float  # cell right padding, in rendered points
    per_column_right_x: Dict[int, float] = field(default_factory=dict)
    per_column_spread_pt: Dict[int, float] = field(default_factory=dict)

    def x_of(self, cum_pt: float) -> float:
        return self.offset_pt + self.scale * cum_pt


@dataclass
class PageFit:
    page: int
    offset_pt: float
    scale: float
    first_row: int
    last_row: int
    matched_labels: int
    considered_labels: int
    residual_max_pt: float
    # How this page's row grid was established.  "fitted" means it was regressed
    # from this page's own label rows.  "inherited" means the page carried too
    # few uniquely-labelled rows to regress against and the grid was carried
    # forward from the preceding page by the tiling identity -- and then
    # VERIFIED against whatever rows the page does carry.  The distinction is
    # stated here and in the evidence rather than being absorbed silently: an
    # inherited grid is a weaker statement than a fitted one and must read as
    # one.
    grid_source: str = "fitted"
    inherited_from_page: Optional[int] = None
    verified_labels: int = 0

    def y_of(self, cum_pt: float) -> float:
        return self.offset_pt + self.scale * cum_pt


@dataclass
class Grid:
    sheet: xm.Sheet
    first_col: int
    last_col: int
    first_row: int
    last_row: int
    col_edges_pt: List[float]
    row_edges_pt: List[float]
    horizontal: HorizontalFit
    pages: List[PageFit]
    vertical: dict = field(default_factory=dict)

    def page_of_row(self, row: int) -> Optional[PageFit]:
        for fit in self.pages:
            if fit.first_row <= row <= fit.last_row:
                return fit
        return None

    def cell_rect(self, row: int, col: int) -> Optional[Tuple[int, float, float, float, float]]:
        """(page_number, x0, y0, x1, y1) in PDF points, or None if not paginated."""
        fit = self.page_of_row(row)
        if fit is None:
            return None
        ci = col - self.first_col
        ri = row - self.first_row
        if ci < 0 or ci + 1 >= len(self.col_edges_pt):
            return None
        if ri < 0 or ri + 1 >= len(self.row_edges_pt):
            return None
        x0 = self.horizontal.x_of(self.col_edges_pt[ci])
        x1 = self.horizontal.x_of(self.col_edges_pt[ci + 1])
        y0 = fit.y_of(self.row_edges_pt[ri])
        y1 = fit.y_of(self.row_edges_pt[ri + 1])
        return (fit.page, x0, y0, x1, y1)

    def column_width_pt(self, col: int) -> float:
        ci = col - self.first_col
        return self.horizontal.scale * (self.col_edges_pt[ci + 1] - self.col_edges_pt[ci])


class CalibrationError(RuntimeError):
    def __init__(self, message: str, *, kind: str, detail: Optional[dict] = None):
        super().__init__(message)
        self.kind = kind
        self.detail = detail or {}


# --------------------------------------------------------------------------
# Horizontal
# --------------------------------------------------------------------------


def fit_horizontal(
    pages: Sequence[pdfdoc.Page],
    col_edges_pt: Sequence[float],
    first_col: int,
    numeric_cols: Sequence[int],
    label_col: Optional[int] = None,
    *,
    cluster_tolerance_pt: float = 1.2,
    min_cluster_rows: int = 4,
    inlier_tolerance_pt: float = 2.0,
    min_inliers: int = 4,
) -> HorizontalFit:
    right_edges: List[float] = []
    for page in pages:
        right_edges.extend(w.x1 for w in page.runs)
    clusters = [c for c in pdfdoc.cluster(right_edges, cluster_tolerance_pt) if c[1] >= min_cluster_rows]
    if len(clusters) < 2:
        raise CalibrationError(
            "too few right-edge clusters (%d) to calibrate the column grid" % len(clusters),
            kind="calibration_horizontal",
            detail={"clusters": clusters},
        )

    expected_right = {col: col_edges_pt[col - first_col + 1] for col in numeric_cols}
    cols = sorted(expected_right)
    centres = [c[0] for c in clusters]

    best: Optional[Tuple[int, float, float]] = None  # (inliers, offset, scale)
    for i in range(len(centres)):
        for j in range(i + 1, len(centres)):
            for u in range(len(cols)):
                for v in range(u + 1, len(cols)):
                    dx_exp = expected_right[cols[v]] - expected_right[cols[u]]
                    if abs(dx_exp) < 1e-6:
                        continue
                    scale = (centres[j] - centres[i]) / dx_exp
                    if not (0.10 <= scale <= 2.0):
                        continue
                    offset = centres[i] - scale * expected_right[cols[u]]
                    inliers = 0
                    for col in cols:
                        predicted = offset + scale * expected_right[col]
                        if any(abs(predicted - c) <= inlier_tolerance_pt for c in centres):
                            inliers += 1
                    if best is None or inliers > best[0]:
                        best = (inliers, offset, scale)

    if best is None or best[0] < min_inliers:
        raise CalibrationError(
            "column grid calibration found only %s inlier columns" % (best[0] if best else 0),
            kind="calibration_horizontal",
            detail={"clusters": clusters, "expected_right": expected_right},
        )

    _inliers, offset, scale = best

    # Least-squares refinement over the matched pairs.
    xs: List[float] = []
    ys: List[float] = []
    matched: Dict[int, float] = {}
    for col in cols:
        predicted = offset + scale * expected_right[col]
        nearest = min(centres, key=lambda c: abs(c - predicted))
        if abs(nearest - predicted) <= inlier_tolerance_pt:
            xs.append(expected_right[col])
            ys.append(nearest)
            matched[col] = nearest
    if len(xs) >= 2:
        n = float(len(xs))
        mean_x = sum(xs) / n
        mean_y = sum(ys) / n
        denom = sum((x - mean_x) ** 2 for x in xs)
        if denom > 1e-9:
            scale = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / denom
            offset = mean_y - scale * mean_x

    residuals = [abs((offset + scale * x) - y) for x, y in zip(xs, ys)]
    # `offset` currently absorbs the cell text margin, because it was regressed
    # against right-aligned TEXT edges rather than against column boundaries.
    # Recover the margin from the left-aligned label column and move the origin
    # onto the real grid.
    pad, offset = _estimate_text_margin(pages, col_edges_pt, first_col, label_col, offset, scale)

    spread = _per_column_spread(pages, matched, cluster_tolerance_pt)

    return HorizontalFit(
        offset_pt=offset,
        scale=scale,
        inliers=len(xs),
        candidates=len(cols),
        residual_max_pt=max(residuals) if residuals else 0.0,
        residual_rms_pt=math.sqrt(sum(r * r for r in residuals) / len(residuals)) if residuals else 0.0,
        right_edge_pad_pt=pad,
        per_column_right_x=matched,
        per_column_spread_pt=spread,
    )


def _estimate_text_margin(pages, col_edges_pt, first_col, label_col, offset, scale):
    """Recover (cell text margin, true grid origin) in rendered points.

    The regression above matched right-aligned NUMBERS, whose x1 is the column
    right edge minus the cell text margin.  So the fitted `offset` is not the
    grid origin: it is the origin minus one margin, and every rectangle derived
    from it is one margin to the left of the real cell.

    The previous version tried to recover the margin by comparing those same
    numbers against a prediction made from them, which is circular -- it
    returned ~0 by construction, on every workbook, and left the origin wrong.

    The margin is recoverable because the label column is LEFT-aligned, so its
    text starts at the column left edge PLUS a margin:

        numbers:  x1  = origin + scale*E_right - margin   (fitted `offset`)
        labels:   x0  = origin + scale*E_left  + margin

    Two observations, two unknowns.  A negative or implausibly large solution is
    discarded rather than applied, and the caller can see it in the evidence as
    a zero margin.
    """
    if label_col is None:
        return 0.0, offset
    index = label_col - first_col
    if index < 0 or index >= len(col_edges_pt):
        return 0.0, offset
    predicted_left = offset + scale * col_edges_pt[index]
    buckets: Dict[float, int] = {}
    for page in pages:
        for word in page.runs:
            if -2.0 <= word.x0 - predicted_left <= 8.0:
                key = round(word.x0, 2)
                buckets[key] = buckets.get(key, 0) + 1
    if not buckets:
        return 0.0, offset
    observed, count = max(buckets.items(), key=lambda kv: (kv[1], -kv[0]))
    if count < 5:
        return 0.0, offset
    margin = (observed - predicted_left) / 2.0
    if not (0.0 <= margin <= 3.0):
        return 0.0, offset
    return margin, offset + margin


def _per_column_spread(pages, matched: Dict[int, float], tolerance: float) -> Dict[int, float]:
    """Max deviation of any word's right edge from its column's shared right x."""
    spread: Dict[int, float] = {}
    for col, centre in matched.items():
        worst = 0.0
        for page in pages:
            for word in page.runs:
                if abs(word.x1 - centre) <= tolerance * 3:
                    worst = max(worst, abs(word.x1 - centre))
        spread[col] = worst
    return spread


# --------------------------------------------------------------------------
# Vertical
# --------------------------------------------------------------------------

_WS = re.compile(r"\s+")


def normalise_label(text: str) -> str:
    return _WS.sub(" ", (text or "").strip()).casefold()


def fit_vertical(
    pages: Sequence[pdfdoc.Page],
    row_edges_pt: Sequence[float],
    first_row: int,
    last_row: int,
    label_x0: float,
    label_x1: float,
    expected_labels: Dict[int, str],
    scale_hint: float,
    *,
    min_matched_labels: int = 3,
    max_scale_disagreement: float = 0.02,
) -> Tuple[List[PageFit], dict]:
    """Recover the per-page row grid by matching labels to ROW IDENTITY.

    Three things this does that the previous version did not, each of which was
    producing a wrong answer rather than no answer:

    1.  **The vertical scale is measured, not borrowed.**  It used to be handed
        the horizontal fit's scale.  Those two are only equal if the workbook's
        column-width and row-height models are both exactly right; when the row
        model was 4% out (declared 12.5pt vs LibreOffice's rendered 12.0pt) the
        borrowed scale drifted more than a full row down a page, which is what
        made half the label bands fail to match.

    2.  **Pages tile the print range.**  With fit-to-width on and fit-to-height
        off, LibreOffice breaks vertically only, so page 1 starts at the first
        row of the print area and every subsequent page starts exactly where the
        previous one ended.  The old search let page 1 start wherever the best
        score happened to fall -- typically row 2 -- which orphaned row 1 and
        reported the title cell as "outside the paginated print range".  It was
        never outside; the grid simply refused to claim it.

    3.  **Matching is by unique label, not by prefix-versus-prefix.**  A prefix
        comparison over a mis-scaled grid manufactures agreement between
        neighbouring rows.

    Returns (fits, diagnostics).  Raises on anything it cannot establish: an
    uncalibrated grid makes every downstream assertion measure the wrong
    rectangle while still reporting a pass.
    """
    if scale_hint <= 0:
        raise CalibrationError("horizontal scale %r is not usable as a seed" % scale_hint,
                               kind="calibration_vertical")

    unique = _unique_labels(expected_labels)
    if len(unique) < min_matched_labels * len(pages):
        # Not fatal on its own -- some pages may still have plenty -- but it is
        # worth recording how thin the evidence is.
        pass

    per_page_bands = []
    for page in pages:
        bands = _label_bands(page, label_x0, label_x1)
        if not bands:
            raise CalibrationError(
                "page %d carries no label-column text; the label panel did not render"
                % (page.number + 1),
                kind="calibration_vertical",
                detail={"page": page.number + 1},
            )
        pairs = []
        for band_y, band_text in bands:
            row = unique.get(normalise_label(band_text))
            if row is not None and first_row <= row <= last_row:
                pairs.append((band_y, row))
        per_page_bands.append((page, bands, pairs))

    def anchor(row: int) -> float:
        """The row's bottom edge -- what a bottom-aligned label sits against."""
        return row_edges_pt[row - first_row + 1]

    # ---- which pages can be fitted from their own rows at all? ------------
    # A page that does not even carry `min_matched_labels` uniquely-labelled
    # rows cannot be regressed against, however good the matcher is.  That is a
    # property of the page, not a failure of the fit, and it is decided BEFORE
    # any fitting so that a page which has enough candidates but whose
    # candidates disagree still goes down the fitting path and still fails.
    fitted: List[int] = [i for i, (_p, _b, pairs) in enumerate(per_page_bands)
                         if len(pairs) >= min_matched_labels]
    thin: List[int] = [i for i in range(len(pages)) if i not in set(fitted)]
    if not fitted:
        raise CalibrationError(
            "no page carries %d uniquely-labelled rows; the row grid cannot be "
            "calibrated anywhere on this render" % min_matched_labels,
            kind="calibration_vertical",
            detail={"pages": len(pages),
                    "page_1_bands": len(per_page_bands[0][1])},
        )
    if 0 not in set(fitted):
        raise CalibrationError(
            "page 1 carries only %d uniquely-labelled rows, so the top-of-print "
            "reference every other page's grid is inherited from does not exist; "
            "a grid cannot be inherited backwards"
            % len(per_page_bands[0][2]),
            kind="calibration_vertical",
            detail={"page": 1, "unique_label_candidates": len(per_page_bands[0][2])},
        )

    # ---- joint fit: one shared scale, one offset per page -----------------
    scale = scale_hint
    offsets: List[float] = [0.0] * len(pages)
    inliers: List[List[Tuple[float, int]]] = [[] for _ in pages]
    tolerance = max(1.0, 0.35 * scale * _min_row_height(row_edges_pt))

    for _iteration in range(8):
        # (a) best offset per fittable page, given the current scale
        for index in fitted:
            page, _bands, pairs = per_page_bands[index]
            best: Optional[Tuple[int, float, List[Tuple[float, int]]]] = None
            for band_y, row in pairs:
                candidate = band_y - scale * anchor(row)
                kept = [(by, r) for by, r in pairs
                        if abs(candidate + scale * anchor(r) - by) <= tolerance]
                if best is None or len(kept) > len(best[2]):
                    best = (len(kept), candidate, kept)
            if best is None or len(best[2]) < min_matched_labels:
                raise CalibrationError(
                    "page %d: only %d label rows could be matched by identity; the row "
                    "grid is not calibrated and every downstream measurement would be "
                    "against the wrong rectangle"
                    % (page.number + 1, 0 if best is None else len(best[2])),
                    kind="calibration_vertical",
                    detail={"page": page.number + 1, "bands": len(_bands),
                            "unique_label_candidates": len(pairs)},
                )
            kept = best[2]
            # least-squares offset over the inliers
            offsets[index] = sum(by - scale * anchor(r) for by, r in kept) / len(kept)
            inliers[index] = kept

        # (b) refit the shared scale over every fitted page's inliers, with each
        #     page's offset removed
        xs: List[float] = []
        ys: List[float] = []
        for index in fitted:
            for band_y, row in inliers[index]:
                xs.append(anchor(row))
                ys.append(band_y - offsets[index])
        if len(xs) < 2:
            break
        mean_x = sum(xs) / len(xs)
        mean_y = sum(ys) / len(ys)
        denom = sum((x - mean_x) ** 2 for x in xs)
        if denom <= 1e-9:
            break
        refit = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / denom
        if not (0.05 <= refit <= 4.0):
            raise CalibrationError(
                "vertical scale refit to %.5f, which is outside any plausible "
                "fit-to-width range" % refit,
                kind="calibration_vertical",
            )
        if abs(refit - scale) < 1e-7:
            scale = refit
            break
        scale = refit

    # A shared scale that disagrees with the horizontal one means the workbook
    # geometry model itself is wrong, not that the render is odd.  Reporting a
    # pass from that state would be reporting a measurement of the wrong grid.
    disagreement = abs(scale - scale_hint) / scale_hint
    if disagreement > max_scale_disagreement:
        raise CalibrationError(
            "vertical scale %.5f and horizontal scale %.5f disagree by %.2f%%; "
            "LibreOffice scales both axes by one factor, so this means the "
            "workbook column-width or row-height model is wrong and every cell "
            "rectangle derived from it would be misplaced"
            % (scale, scale_hint, 100.0 * disagreement),
            kind="calibration_axes_disagree",
            detail={"vertical_scale": scale, "horizontal_scale": scale_hint,
                    "disagreement": disagreement},
        )

    # ---- page boundaries: the pages TILE the print range ------------------
    top_y = offsets[0] + scale * row_edges_pt[0]
    break_tolerance = 0.5 * scale * _min_row_height(row_edges_pt)

    def pin_start(index: int, lower: int) -> Tuple[int, float]:
        """The row whose top edge this page's own offset puts at the print top."""
        best_row, best_delta = None, None
        for row in range(lower, last_row + 1):
            delta = abs(offsets[index] + scale * row_edges_pt[row - first_row] - top_y)
            if best_delta is None or delta < best_delta:
                best_row, best_delta = row, delta
        if best_row is None:
            raise CalibrationError(
                "page %d starts below the last row of the print range" % (index + 1),
                kind="calibration_vertical")
        if best_delta > break_tolerance:
            raise CalibrationError(
                "page %d's first row could not be pinned to a row boundary "
                "(closest is row %d, %.2fpt away); the page break is not where the "
                "row model says it is" % (index + 1, best_row, best_delta),
                kind="calibration_vertical",
                detail={"page": index + 1, "closest_row": best_row,
                        "residual_pt": best_delta})
        return best_row, best_delta

    # Provisional starts for the pages that were fitted from their own rows.
    # These are the only starts that carry independent evidence, and the page
    # capacity below is measured from them alone.
    fitted_set = set(fitted)
    provisional: Dict[int, Tuple[int, float]] = {}
    provisional[0] = (first_row, 0.0)
    previous_fitted = first_row
    for index in fitted:
        if index == 0:
            continue
        row, delta = pin_start(index, previous_fitted + 1)
        provisional[index] = (row, delta)
        previous_fitted = row

    capacity = _page_capacity(row_edges_pt, first_row, last_row, fitted, provisional) \
        if thin else None

    starts: List[int] = [first_row]
    boundary_residual: List[float] = [0.0]
    inherited: Dict[int, dict] = {}
    for index in range(1, len(pages)):
        if index in fitted_set:
            row, delta = provisional[index]
            if row <= starts[-1]:
                raise CalibrationError(
                    "page %d's fitted first row (%d) is not after page %d's first "
                    "row (%d); the pages do not tile the print range"
                    % (index + 1, row, index, starts[-1]),
                    kind="calibration_vertical")
            starts.append(row)
            boundary_residual.append(delta)
            continue

        # ---- inherited: this page has too few uniquely-labelled rows to be
        # regressed against, so its grid is CARRIED FORWARD from the preceding
        # page instead of being fitted.  That is legitimate only because pages
        # tile the print range by construction and the vertical scale is shared:
        # the preceding page's calibrated extent fixes where this one starts,
        # and every page puts its first row's top edge at the same print top.
        # Nothing on this page is used to place it -- this page's own rows are
        # kept back and spent on VERIFYING the inherited grid below.
        if capacity is None:
            raise CalibrationError(
                "page %d carries too few uniquely-labelled rows to calibrate and "
                "the page capacity could not be measured from the pages that do; "
                "the grid cannot be inherited" % (index + 1),
                kind="calibration_vertical", detail={"page": index + 1})
        end_previous = _page_end(row_edges_pt, first_row, last_row, starts[-1], capacity)
        if end_previous is None:
            raise CalibrationError(
                "page %d: the measured page capacity (%.3f..%.3fpt of workbook rows) "
                "does not place page %d's last row unambiguously, so page %d's first "
                "row cannot be inherited"
                % (index + 1, capacity[0], capacity[1], index, index + 1),
                kind="calibration_vertical",
                detail={"page": index + 1, "capacity_pt": list(capacity)})
        row = end_previous + 1
        if row > last_row:
            raise CalibrationError(
                "page %d would start at row %d, past the last row (%d) of the print "
                "range" % (index + 1, row, last_row),
                kind="calibration_vertical", detail={"page": index + 1})
        offsets[index] = top_y - scale * row_edges_pt[row - first_row]
        starts.append(row)
        boundary_residual.append(0.0)
        inherited[index] = {
            "page": index + 1,
            "inherited_from_page": index,
            "first_row": row,
            "capacity_lo_pt": round(capacity[0], 4),
            "capacity_hi_pt": round(capacity[1], 4),
        }

    identified_rows = set(unique.values())
    fits: List[PageFit] = []
    for index, (page, bands, pairs) in enumerate(per_page_bands):
        start_row = starts[index]
        end_row = starts[index + 1] - 1 if index + 1 < len(starts) else last_row
        if end_row < start_row:
            raise CalibrationError(
                "page %d resolved to an empty row range (%d..%d)"
                % (page.number + 1, start_row, end_row),
                kind="calibration_vertical")
        if index in inherited:
            kept = _verify_inherited_page(
                page, start_row, end_row, pairs, unique, offsets[index], scale,
                anchor, tolerance, min_matched_labels)
            inliers[index] = kept
            inherited[index]["last_row"] = end_row
            inherited[index]["verified_labels"] = len(kept)
            inherited[index]["uniquely_labelled_rows_in_range"] = sum(
                1 for r in range(start_row, end_row + 1) if r in identified_rows)
            inherited[index]["verification_residual_max_pt"] = round(
                max((abs(offsets[index] + scale * anchor(r) - by) for by, r in kept),
                    default=0.0), 4)
        kept = inliers[index]
        worst = max(
            (abs(offsets[index] + scale * anchor(r) - by) for by, r in kept), default=0.0)
        fits.append(
            PageFit(
                page=page.number,
                offset_pt=offsets[index],
                scale=scale,
                first_row=start_row,
                last_row=end_row,
                matched_labels=len(kept),
                considered_labels=len(bands),
                residual_max_pt=worst,
                grid_source="inherited" if index in inherited else "fitted",
                # 0-based, to match `page` above.
                inherited_from_page=index - 1 if index in inherited else None,
                verified_labels=len(kept) if index in inherited else 0,
            )
        )

    covered = sum(f.last_row - f.first_row + 1 for f in fits)
    if covered != last_row - first_row + 1:
        raise CalibrationError(
            "the %d pages cover %d rows but the print range holds %d; some row is "
            "on no page or on two" % (len(fits), covered, last_row - first_row + 1),
            kind="calibration_vertical")

    diagnostics = {
        "vertical_scale": scale,
        "horizontal_scale": scale_hint,
        "axis_scale_ratio": scale / scale_hint,
        "unique_labels_available": len(unique),
        "page_start_rows": starts,
        "page_break_residual_pt": [round(v, 4) for v in boundary_residual],
        "inlier_tolerance_pt": tolerance,
        "page_grid_source": [f.grid_source for f in fits],
        "inherited_pages": [inherited[i] for i in sorted(inherited)],
        "page_capacity_pt": None if capacity is None else
                            [round(capacity[0], 4), round(capacity[1], 4)],
    }
    if inherited:
        diagnostics["inheritance_note"] = (
            "Page(s) %s carry fewer than %d uniquely-labelled rows, which is too few "
            "to regress a row grid against. Their grid was NOT fitted: it was "
            "inherited from the preceding page -- the pages tile the print range, the "
            "vertical scale is shared, and every page puts its first row's top edge at "
            "the same print top, so the preceding page's calibrated extent plus the "
            "measured page capacity fixes where the next one starts. The inherited "
            "grid was then verified against every uniquely-labelled row the page does "
            "carry; a page with none is refused rather than inherited, and a page whose "
            "rows disagree with the inherited grid is refused rather than inherited."
            % (", ".join(str(i + 1) for i in sorted(inherited)), min_matched_labels)
        )
    return fits, diagnostics


def _page_capacity(row_edges_pt: Sequence[float], first_row: int, last_row: int,
                   fitted: Sequence[int],
                   provisional: Dict[int, Tuple[int, float]]) -> Optional[Tuple[float, float]]:
    """How many workbook points of rows fit on one page, bracketed by measurement.

    Every page in a fit-to-width render has the same printable height, so a pair
    of ADJACENT pages whose starts were both fitted from their own label rows
    brackets that height: the rows from the first page's start up to (but not
    including) the second page's start all fitted, and one more row did not.

    Returns (lower, upper) with the upper bound EXCLUSIVE, or None when no two
    adjacent pages were both fitted -- in which case the caller must refuse to
    inherit rather than guess.
    """
    lower: Optional[float] = None
    upper: Optional[float] = None
    fitted_set = set(fitted)
    for index in fitted:
        following = index + 1
        if following not in fitted_set:
            continue
        base = row_edges_pt[provisional[index][0] - first_row]
        start_next = provisional[following][0]
        fits_span = row_edges_pt[start_next - first_row] - base
        # The first row beyond the break with a positive height is the one that
        # did NOT fit; a zero-height (hidden) row brackets nothing.
        overflow: Optional[float] = None
        for j in range(start_next + 1 - first_row, len(row_edges_pt)):
            if row_edges_pt[j] - base > fits_span + _CAPACITY_TOL:
                overflow = row_edges_pt[j] - base
                break
        lower = fits_span if lower is None else max(lower, fits_span)
        if overflow is not None:
            upper = overflow if upper is None else min(upper, overflow)
    if lower is None:
        return None
    if upper is None:
        upper = float("inf")
    if not (lower < upper):
        raise CalibrationError(
            "the pages that were fitted independently imply page capacities that "
            "cannot all be true (at least %.3fpt of rows fit, but fewer than "
            "%.3fpt do); the pagination is not a constant-height tiling and no "
            "grid can be inherited from it" % (lower, upper),
            kind="calibration_vertical",
            detail={"capacity_lower_pt": lower, "capacity_upper_pt": upper})
    return (lower, upper)


_CAPACITY_TOL = 1e-6


def _page_end(row_edges_pt: Sequence[float], first_row: int, last_row: int,
              start: int, capacity: Tuple[float, float]) -> Optional[int]:
    """The last row that fits on a page starting at `start`, or None if unclear.

    The capacity is only known as a bracket, so the answer is computed at both
    ends of it.  If the two disagree the bracket is too loose to name a row and
    the caller must refuse: a page break placed one row out is exactly the error
    that puts a real cell outside the grid while every check still reports a
    pass.
    """
    answers = []
    for bound, tol in ((capacity[0], _CAPACITY_TOL), (capacity[1], -_CAPACITY_TOL)):
        if bound == float("inf"):
            answers.append(last_row)
            continue
        base = row_edges_pt[start - first_row]
        end: Optional[int] = None
        for row in range(start, last_row + 1):
            if row_edges_pt[row + 1 - first_row] - base <= bound + tol:
                end = row
            else:
                break
        if end is None:
            return None
        answers.append(end)
    if answers[0] != answers[1]:
        return None
    return answers[0]


def _verify_inherited_page(page, start_row: int, end_row: int,
                           pairs: Sequence[Tuple[float, int]],
                           unique: Dict[str, int],
                           offset: float, scale: float, anchor,
                           tolerance: float, min_matched_labels: int
                           ) -> List[Tuple[float, int]]:
    """Test an inherited grid against the rows the page actually carries.

    Inheritance places the page without consulting it, which is what makes this
    a test rather than a restatement.  Three ways it can fail, all of them
    refusals:

    * the page's derived range turns out to hold enough uniquely-labelled rows
      to have been fitted -- then the shortage of matches is the MATCHER
      failing, not the page being thin, and inheritance would launder that bug
      into a pass;
    * the page contributed nothing to verify against -- a check that visited
      nothing has not passed;
    * a row it does carry does not sit where the inherited grid says it should.
    """
    identified_rows = set(unique.values())
    rows_with_unique_label = [r for r in range(start_row, end_row + 1)
                              if r in identified_rows]
    if len(rows_with_unique_label) >= min_matched_labels:
        raise CalibrationError(
            "page %d was placed by inheritance because only %d label rows matched by "
            "identity, but the range it resolved to (%d..%d) holds %d uniquely-"
            "labelled rows -- enough to have calibrated the page directly. The "
            "shortage is in the matching, not in the page, and inheriting here would "
            "hide it"
            % (page.number + 1, len(pairs), start_row, end_row,
               len(rows_with_unique_label)),
            kind="calibration_vertical",
            detail={"page": page.number + 1, "first_row": start_row,
                    "last_row": end_row,
                    "uniquely_labelled_rows_in_range": len(rows_with_unique_label),
                    "matched": len(pairs)})
    in_range = [(by, r) for by, r in pairs if start_row <= r <= end_row]
    if not in_range:
        raise CalibrationError(
            "page %d's grid was inherited but the page carries no uniquely-labelled "
            "row inside its own range (%d..%d) to test that grid against; an "
            "unverified grid is not a calibrated one"
            % (page.number + 1, start_row, end_row),
            kind="calibration_vertical",
            detail={"page": page.number + 1, "first_row": start_row,
                    "last_row": end_row, "unique_label_candidates": len(pairs)})
    bad = [(by, r, abs(offset + scale * anchor(r) - by)) for by, r in in_range
           if abs(offset + scale * anchor(r) - by) > tolerance]
    if bad:
        raise CalibrationError(
            "page %d's inherited grid puts row %d %.2fpt from where it rendered "
            "(tolerance %.2fpt); the grid carried forward from page %d does not "
            "describe this page"
            % (page.number + 1, bad[0][1], bad[0][2], tolerance, page.number),
            kind="calibration_vertical",
            detail={"page": page.number + 1, "tolerance_pt": tolerance,
                    "disagreements": [{"row": r, "residual_pt": round(d, 4)}
                                      for _by, r, d in bad[:5]]})
    stray = [(by, r) for by, r in pairs if not (start_row <= r <= end_row)]
    if stray:
        raise CalibrationError(
            "page %d's inherited range is %d..%d, but it renders the label of row "
            "%d, which that range does not contain; the inherited page boundary is "
            "wrong" % (page.number + 1, start_row, end_row, stray[0][1]),
            kind="calibration_vertical",
            detail={"page": page.number + 1, "first_row": start_row,
                    "last_row": end_row,
                    "rows_outside_range": [r for _by, r in stray[:5]]})
    return in_range


def _unique_labels(expected_labels: Dict[int, str]) -> Dict[str, int]:
    """Normalised label text -> row, for labels that occur exactly once.

    Ambiguous labels ("Revenue" appears in three blocks) are dropped rather than
    guessed at: one wrong anchor drags the whole page fit.
    """
    counts: Dict[str, List[int]] = {}
    for row, text in expected_labels.items():
        counts.setdefault(normalise_label(text), []).append(row)
    return {text: rows[0] for text, rows in counts.items() if len(rows) == 1 and text}


def _min_row_height(row_edges_pt: Sequence[float]) -> float:
    heights = [row_edges_pt[i + 1] - row_edges_pt[i] for i in range(len(row_edges_pt) - 1)]
    positive = [h for h in heights if h > 0.01]
    return min(positive) if positive else 12.0


def _label_bands(page: pdfdoc.Page, x0: float, x1: float, tolerance: float = 2.0):
    """Text bands that START in the label column, keyed on their BOTTOM edge.

    Two deliberate choices, both measured:

    * Selection is by LEFT edge, not by centre.  A left-aligned label long
      enough to overflow its column -- which is most of the section titles and
      the sheet title in B1 -- has its centre well to the right of the label
      column, so a centre test drops exactly the rows that anchor the top of
      each page.

    * The anchor is the band's bottom edge against the row's bottom edge, not
      its centre against the row's centre.  Cell text is bottom-aligned by
      default, so the bottom edge sits a fixed descent below the row boundary
      whatever the font size, while the centre moves by half the text height.
      On a sheet whose section headers are set in a larger font than its body
      rows, the centre anchor produced 0.80pt of residual and the bottom anchor
      0.20pt -- and the centre anchor's error is systematic on exactly the rows
      that matter, the section bands.
    """
    candidates = [w for w in page.runs if x0 - 1.0 <= w.x0 <= x1 + 1.0]
    if not candidates:
        return []
    candidates.sort(key=lambda w: (w.cy, w.x0))
    bands: List[List[pdfdoc.Word]] = [[candidates[0]]]
    for word in candidates[1:]:
        if abs(word.cy - bands[-1][-1].cy) <= tolerance:
            bands[-1].append(word)
        else:
            bands.append([word])
    out = []
    for band in bands:
        band.sort(key=lambda w: w.x0)
        bottom = max(w.y1 for w in band)
        out.append((bottom, " ".join(w.text for w in band)))
    return out


# --------------------------------------------------------------------------

# A vertical fit whose worst matched label sits further than this from its own
# row boundary is not a fit worth keeping.  Rendered rows are ~7.5pt tall at
# fit-to-width, so 1.2pt is well inside one row and comfortably outside the
# ~0.2pt that descent differences between font sizes can account for.
_ROW_MODEL_ACCEPT_PT = 1.2


def build_grid(
    rendered: pdfdoc.RenderedPdf,
    sheet: xm.Sheet,
    workbook: xm.Workbook,
    first_col: int,
    last_col: int,
    first_row: int,
    last_row: int,
    numeric_cols: Sequence[int],
    label_col: int,
) -> Grid:
    col_edges = xm.column_edges_pt(sheet, first_col, last_col)
    row_edges = xm.row_edges_pt(sheet, first_row, last_row)

    horizontal = fit_horizontal(rendered.pages, col_edges, first_col, numeric_cols, label_col)

    label_x0 = horizontal.x_of(col_edges[label_col - first_col])
    label_x1 = horizontal.x_of(col_edges[label_col - first_col + 1])

    expected_labels: Dict[int, str] = {}
    for row in range(first_row, last_row + 1):
        cell = sheet.cell(row, label_col)
        if cell is None:
            continue
        text = xm.cell_text(workbook, cell)
        if text:
            expected_labels[row] = text

    # The row-height model is a PREDICTION from the package's declared
    # generator (see `xlsx_model.declares_excel_generator`).  It is verified
    # here rather than trusted: the predicted model is fitted first, and the
    # other one is fitted too whenever the prediction did not land cleanly.
    # Whichever the render actually agrees with is the one used, and the fact
    # that they disagreed is reported rather than absorbed.
    predicted = sheet.excel_row_height_compat
    attempts: List[Tuple[bool, Optional[List[PageFit]], Optional[dict], Optional[Exception]]] = []
    for excel_compat in (predicted, not predicted):
        edges = xm.row_edges_pt(sheet, first_row, last_row, excel_compat=excel_compat)
        try:
            fits, diag = fit_vertical(
                rendered.pages, edges, first_row, last_row,
                label_x0, label_x1, expected_labels, horizontal.scale,
            )
        except CalibrationError as exc:
            attempts.append((excel_compat, None, None, exc))
            continue
        worst = max((f.residual_max_pt for f in fits), default=0.0)
        attempts.append((excel_compat, fits, dict(diag, row_edges=edges, residual_max_pt=worst), None))
        if worst <= _ROW_MODEL_ACCEPT_PT:
            break

    usable = [a for a in attempts if a[1] is not None]
    if not usable:
        raise attempts[0][3]
    excel_compat, pages, vertical, _ = min(usable, key=lambda a: a[2]["residual_max_pt"])
    row_edges = vertical.pop("row_edges")
    vertical["excel_row_height_compat_used"] = excel_compat
    vertical["excel_row_height_compat_predicted"] = predicted
    vertical["generator_application"] = workbook.generator_application
    vertical["row_model_attempts"] = [
        {"excel_row_height_compat": a[0],
         "residual_max_pt": round(a[2]["residual_max_pt"], 4) if a[2] else None,
         "error": None if a[3] is None else str(a[3])}
        for a in attempts
    ]
    if excel_compat != predicted:
        vertical["row_model_prediction_disagreed"] = (
            "the package declares Application=%r, which predicts "
            "excel_row_height_compat=%s, but the render agrees with %s"
            % (workbook.generator_application, predicted, excel_compat)
        )

    return Grid(
        sheet=sheet,
        first_col=first_col,
        last_col=last_col,
        first_row=first_row,
        last_row=last_row,
        col_edges_pt=col_edges,
        row_edges_pt=row_edges,
        horizontal=horizontal,
        pages=pages,
        vertical=vertical,
    )
