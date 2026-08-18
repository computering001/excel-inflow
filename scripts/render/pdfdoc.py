"""PDF extraction: per-word boxes, fonts, vector edges, rasters.

The raster is useful for pixel sampling and for the regression baseline, but the
*word bounding boxes* are the more useful product: they are what makes clipping
and overlap detectable at all. PyMuPDF is preferred. The approved bundled
runtime does not always include it, so an equally fail-closed pdfplumber/
pdfminer reader plus the bundled ``pdftoppm`` rasterizer is supported too.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


class PyMuPdfMissing(RuntimeError):
    """No complete PDF extraction/raster backend is available."""


def _fitz():
    try:
        import fitz  # type: ignore

        return fitz
    except Exception as exc:  # pragma: no cover
        raise PyMuPdfMissing(
            "Neither PyMuPDF nor the approved pdfplumber + pdftoppm backend is "
            "available; the render stage is BLOCKED rather than silently dropping "
            "geometry, font or raster checks."
        ) from exc


class TextTraceMissing(RuntimeError):
    """`page.get_texttrace()` is required and its absence is BLOCKING.

    The word extractor MERGES two overlapping strings into a single word, so
    overlap -- one of the fail-closed checks -- becomes undetectable without the
    raw text-showing runs.  Falling back to words would silently disable the
    check while continuing to report zero overlaps.
    """


@dataclass
class TextRun:
    """One PDF text-showing operation.

    LibreOffice emits one run per cell, so this is the natural unit for
    per-cell geometry -- unlike `get_text("words")`, which merges two colliding
    cells into a single word and hides the collision.
    """

    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    font: str = ""
    size: float = 0.0

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2.0

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2.0

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    def as_dict(self) -> dict:
        return {"page": self.page, "bbox": [round(v, 2) for v in (self.x0, self.y0, self.x1, self.y1)],
                "text": self.text}


Word = TextRun  # backwards-compatible alias


@dataclass
class Page:
    number: int  # 0-based
    width: float
    height: float
    runs: List[TextRun] = field(default_factory=list)
    fonts: List[Tuple[str, str]] = field(default_factory=list)  # (basefont, type)
    vertical_edges: List[float] = field(default_factory=list)
    horizontal_edges: List[float] = field(default_factory=list)
    fill_rects: List[Tuple[Tuple[float, float, float, float], Optional[Tuple[float, float, float]]]] = field(default_factory=list)


@dataclass
class RenderedPdf:
    path: str
    pages: List[Page]
    _doc: object = None
    _backend: str = "fitz"
    _raster_cache: Dict[Tuple[int, int], object] = field(default_factory=dict)

    @property
    def page_count(self) -> int:
        return len(self.pages)

    @property
    def raster_backend(self) -> str:
        """Stable family name for the pixels produced by :meth:`raster`.

        MuPDF and Poppler both render a valid PDF, but their antialiasing and
        glyph rasterisation are not pixel-identical. A baseline written by one
        must therefore never be compared by the other and reported as product
        drift.
        """
        return "pymupdf" if self._backend == "fitz" else "poppler"

    def font_families(self) -> List[str]:
        names = set()
        for page in self.pages:
            for basefont, _kind in page.fonts:
                names.add(normalise_font_name(basefont))
        return sorted(n for n in names if n)

    def raster(self, page_number: int, dpi: int = 100):
        """Return an (H, W, 3) uint8 numpy array for the page."""
        import numpy as np
        if self._backend == "fitz":
            fitz = _fitz()
            page = self._doc[page_number]
            zoom = dpi / 72.0
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            arr = np.frombuffer(pix.samples, dtype=np.uint8)
            return arr.reshape(pix.height, pix.width, pix.n)[:, :, :3].copy()
        key = (page_number, dpi)
        if key in self._raster_cache:
            return self._raster_cache[key].copy()
        from PIL import Image
        with tempfile.TemporaryDirectory(prefix="debt-render-raster-") as folder:
            png = os.path.join(folder, "page.png")
            self.save_png(page_number, png, dpi=dpi)
            with Image.open(png) as image:
                value = np.asarray(image.convert("RGB"), dtype=np.uint8).copy()
                self._raster_cache[key] = value
                return value.copy()

    def save_png(self, page_number: int, dest: str, dpi: int = 100) -> str:
        os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
        if self._backend == "fitz":
            fitz = _fitz()
            page = self._doc[page_number]
            zoom = dpi / 72.0
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            pix.save(dest)
            return dest
        executable = shutil.which("pdftoppm")
        if not executable:
            raise PyMuPdfMissing(
                "pdfplumber extracted geometry but pdftoppm is unavailable; raster "
                "and pixel checks are BLOCKED rather than skipped."
            )
        with tempfile.TemporaryDirectory(prefix="debt-render-pdftoppm-") as folder:
            prefix = os.path.join(folder, "page")
            completed = subprocess.run(
                [
                    executable,
                    "-f", str(page_number + 1),
                    "-l", str(page_number + 1),
                    "-r", str(dpi),
                    "-png",
                    "-singlefile",
                    self.path,
                    prefix,
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            source = prefix + ".png"
            if completed.returncode != 0 or not os.path.exists(source) or os.path.getsize(source) == 0:
                raise PyMuPdfMissing(
                    "pdftoppm failed for page %d (exit %d): %s"
                    % (page_number + 1, completed.returncode, completed.stderr.decode("utf-8", "replace")[:500])
                )
            shutil.copyfile(source, dest)
        return dest

    def close(self) -> None:
        if self._doc is not None:
            try:
                self._doc.close()
            except Exception:
                pass


_SUBSET_PREFIX_LEN = 7  # e.g. "ABCDEE+Carlito"


def normalise_font_name(basefont: str) -> str:
    """'BAAAAA+Carlito-Bold' -> 'Carlito'.

    Subset prefixes and style suffixes are normal.  A different FAMILY is not:
    Calibri -> Carlito is metric-compatible and fine, Aptos -> DejaVu Sans is
    not, and if it ever fires every geometry assertion here silently measures
    the wrong thing while still passing.
    """
    name = basefont or ""
    if len(name) > _SUBSET_PREFIX_LEN and name[6] == "+":
        name = name[7:]
    for separator in ("-", ",", "_"):
        if separator in name:
            name = name.split(separator, 1)[0]
    return name.strip()


def open_pdf(path: str, *, collect_drawings: bool = True) -> RenderedPdf:
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    if os.path.getsize(path) == 0:
        raise ValueError("zero-byte PDF: %s" % path)

    try:
        import fitz  # type: ignore
    except Exception:
        return _open_pdfplumber(path, collect_drawings=collect_drawings)

    doc = fitz.open(path)
    pages: List[Page] = []
    for index in range(doc.page_count):
        pdf_page = doc[index]
        rect = pdf_page.rect
        page = Page(number=index, width=rect.width, height=rect.height)
        page.runs.extend(_text_runs(pdf_page, index))
        for entry in pdf_page.get_fonts(full=False):
            # (xref, ext, type, basefont, name, encoding)
            basefont = entry[3] if len(entry) > 3 else ""
            kind = entry[2] if len(entry) > 2 else ""
            page.fonts.append((str(basefont), str(kind)))

        if collect_drawings:
            _collect_drawings(pdf_page, page)

        pages.append(page)

    return RenderedPdf(path=path, pages=pages, _doc=doc, _backend="fitz")


def _open_pdfplumber(path: str, *, collect_drawings: bool) -> RenderedPdf:
    """Complete fallback backed by pdfminer geometry and Poppler rasterization.

    Every channel used by the gate is populated. Failure to extract characters,
    fonts, pages or a rasterizer is blocking; there is no geometry-lite pass.
    """
    try:
        import pdfplumber  # type: ignore
        from pypdf import PdfReader  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise PyMuPdfMissing(
            "PyMuPDF is unavailable and the approved pdfplumber/pypdf reader "
            "could not be imported; the render gate has no complete geometry backend."
        ) from exc
    if not shutil.which("pdftoppm"):
        raise PyMuPdfMissing(
            "PyMuPDF is unavailable and pdftoppm is absent; the pdfplumber "
            "fallback cannot produce the mandatory pixel evidence."
        )
    document = pdfplumber.open(path)
    operation_reader = PdfReader(path)
    if not document.pages:
        document.close()
        raise ValueError("PDF contains zero pages: %s" % path)
    if len(operation_reader.pages) != len(document.pages):
        document.close()
        raise PyMuPdfMissing(
            "pdfplumber and pypdf disagree on page count; text-operation geometry "
            "cannot be paired safely."
        )
    pages: List[Page] = []
    for index, source in enumerate(document.pages):
        page = Page(number=index, width=float(source.width), height=float(source.height))
        page.runs.extend(
            _pdfplumber_text_runs(operation_reader.pages[index], source, index)
        )
        font_names = sorted({str(char.get("fontname", "")) for char in source.chars if char.get("fontname")})
        if source.chars and not font_names:
            document.close()
            raise PyMuPdfMissing(
                "pdfplumber found characters but no font identities on page %d; "
                "the font-set check would be vacuous." % (index + 1)
            )
        page.fonts.extend((name, "pdfminer") for name in font_names)
        if collect_drawings:
            _collect_pdfplumber_drawings(source, page)
        pages.append(page)
    return RenderedPdf(path=path, pages=pages, _doc=document, _backend="pdfplumber")


def _pdfplumber_text_runs(operation_page, source, page_number: int) -> List[TextRun]:
    """Pair each PDF text-showing operation with pdfminer's character boxes.

    ``extract_words`` merges adjacent or overlapping strings and therefore can
    hide the exact defect the overlap check is meant to find. Pypdf's visitor
    preserves each showing operation; pdfplumber supplies exact boxes for its
    characters. Both readers traverse the decoded content stream in order, so
    an exact character-stream equality proves the pairing before any run is
    admitted. A disagreement blocks rather than falling back to merged words.
    """
    operations = []

    def visit(text, _cm, _tm, font, size):
        # Pypdf appends a layout newline after a showing operation. It is not a
        # glyph and pdfminer correctly has no character box for it.
        value = str(text or "").rstrip("\r\n")
        # LibreOffice emits separate space-only showing operations between
        # adjacent cells. They paint no glyph and pdfminer correctly produces
        # no character box for them, so they are not geometry runs.
        if value.strip():
            operations.append(
                (
                    value,
                    str((font or {}).get("/BaseFont", "")),
                    float(size or 0.0),
                )
            )

    operation_page.extract_text(visitor_text=visit)
    characters = list(source.chars)
    operation_text = "".join(item[0] for item in operations)
    character_text = "".join(str(item.get("text", "")) for item in characters)
    if operation_text != character_text:
        raise TextTraceMissing(
            "pypdf text operations and pdfplumber character boxes disagree on "
            "page %d (%d versus %d glyphs); per-operation overlap evidence is "
            "BLOCKED rather than replaced by merged words."
            % (page_number + 1, len(operation_text), len(character_text))
        )
    runs: List[TextRun] = []
    cursor = 0
    for text, operation_font, size in operations:
        boxes = []
        decoded = ""
        # Pdfminer may expose a ligature as one box whose text is two Unicode
        # characters (for example ``ti``). Pair by decoded text length, never
        # by box count, or every run after the first ligature shifts by one box
        # and appears to span unrelated cells.
        while cursor < len(characters) and len(decoded) < len(text):
            box = characters[cursor]
            cursor += 1
            boxes.append(box)
            decoded += str(box.get("text", ""))
        if decoded != text:
            raise TextTraceMissing(
                "text-operation/character-box pairing diverged on page %d: %r "
                "versus %r; overlap evidence is BLOCKED."
                % (page_number + 1, text[:80], decoded[:80])
            )
        if not text.strip() or not boxes:
            continue
        fonts = [str(item.get("fontname", "")) for item in boxes if item.get("fontname")]
        font = operation_font or (fonts[0] if fonts else "")
        runs.append(
            TextRun(
                page_number,
                min(float(item["x0"]) for item in boxes),
                min(float(item["top"]) for item in boxes),
                max(float(item["x1"]) for item in boxes),
                max(float(item["bottom"]) for item in boxes),
                text,
                font,
                size,
            )
        )
    return runs


def _collect_pdfplumber_drawings(source, page: Page) -> None:
    for rect in source.rects:
        x0 = float(rect.get("x0", 0.0))
        x1 = float(rect.get("x1", x0))
        y0 = float(rect.get("top", 0.0))
        y1 = float(rect.get("bottom", y0))
        colour = rect.get("non_stroking_color")
        if isinstance(colour, (list, tuple)) and len(colour) >= 3:
            page.fill_rects.append(((x0, y0, x1, y1), tuple(float(c) for c in colour[:3])))
        _append_axis_edges(page, x0, y0, x1, y1)
    for edge in source.edges:
        x0 = float(edge.get("x0", 0.0))
        x1 = float(edge.get("x1", x0))
        y0 = float(edge.get("top", 0.0))
        y1 = float(edge.get("bottom", y0))
        _append_axis_edges(page, x0, y0, x1, y1)


def _append_axis_edges(page: Page, x0: float, y0: float, x1: float, y1: float) -> None:
    width = x1 - x0
    height = y1 - y0
    if abs(width) <= 1.5 and abs(height) > 3.0:
        page.vertical_edges.append((x0 + x1) / 2.0)
    elif abs(height) <= 1.5 and abs(width) > 3.0:
        page.horizontal_edges.append((y0 + y1) / 2.0)
    else:
        page.vertical_edges.extend([x0, x1])
        page.horizontal_edges.extend([y0, y1])


def _text_runs(pdf_page, page_number: int) -> List[TextRun]:
    if not hasattr(pdf_page, "get_texttrace"):
        raise TextTraceMissing(
            "PyMuPDF on this system has no page.get_texttrace(); the overlap check "
            "cannot be made and the render stage is BLOCKED rather than reporting a "
            "vacuous zero."
        )
    runs: List[TextRun] = []
    for entry in pdf_page.get_texttrace():
        chars = entry.get("chars") or ()
        text = "".join(chr(c[0]) for c in chars if isinstance(c, (list, tuple)) and c)
        if not text.strip():
            continue
        bbox = entry.get("bbox")
        if bbox is None:
            boxes = [c[3] for c in chars if isinstance(c, (list, tuple)) and len(c) > 3]
            if not boxes:
                continue
            bbox = (min(b[0] for b in boxes), min(b[1] for b in boxes),
                    max(b[2] for b in boxes), max(b[3] for b in boxes))
        runs.append(
            TextRun(page_number, float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]),
                    text, str(entry.get("font", "")), float(entry.get("size", 0.0) or 0.0))
        )
    return runs


def _collect_drawings(pdf_page, page: Page) -> None:
    """Harvest vector geometry: filled rects (cell fills) and axis edges.

    LibreOffice paints every solid cell fill as a filled rectangle and every
    ruled border as a thin line, so the drawing list gives the true column and
    row boundaries as rendered -- which is what the calibration fits against.
    """
    try:
        drawings = pdf_page.get_drawings()
    except Exception:
        return
    for item in drawings:
        rect = item.get("rect")
        if rect is None:
            continue
        x0, y0, x1, y1 = float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)
        colour = item.get("fill")
        if item.get("type") in ("f", "fs") and colour is not None:
            page.fill_rects.append(((x0, y0, x1, y1), tuple(float(c) for c in colour[:3])))
        width = x1 - x0
        height = y1 - y0
        if width <= 1.5 and height > 3.0:
            page.vertical_edges.append((x0 + x1) / 2.0)
        elif height <= 1.5 and width > 3.0:
            page.horizontal_edges.append((y0 + y1) / 2.0)
        else:
            page.vertical_edges.extend([x0, x1])
            page.horizontal_edges.extend([y0, y1])


def runs_in_band(runs: Sequence[TextRun], y0: float, y1: float) -> List[TextRun]:
    return [r for r in runs if y0 <= r.cy <= y1]


def cluster(values: Iterable[float], tolerance: float) -> List[Tuple[float, int]]:
    """1-D clustering; returns (centre, count) sorted by centre."""
    ordered = sorted(values)
    if not ordered:
        return []
    clusters: List[List[float]] = [[ordered[0]]]
    for value in ordered[1:]:
        if value - clusters[-1][-1] <= tolerance:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    return [(sum(c) / len(c), len(c)) for c in clusters]
