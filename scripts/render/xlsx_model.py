"""Dependency-free OOXML reader and page-setup patcher.

Everything here is stdlib only: `zipfile` plus `xml.etree.ElementTree`. That is
a decision, not a constraint. openpyxl 3.1.5 IS native where this package runs
— the tenant capability audit confirms it, `assets/deployment-profile.json` declares
it `provision: native` / `required_at: import`, and `emit/` writes the workbook
through it. `render/` declines it anyway: this stage judges the workbook by
converting it and reading the rendered PDF, so it has no use for the workbook
object model and must not acquire a dependency it does not need. (`verify/` is
stdlib-only for a stronger reason again — it is the independent checker of what
`emit/` writes, so it must share no reader with it.) The release compiler
enforces both: an `openpyxl` import anywhere under `render/` or `verify/` fails
the build.

`references/validation.md` § "openpyxl is available; `render/` chose not to use
it" is the authoritative statement of this position; this docstring follows it.
An earlier version of this text claimed the platform "does NOT guarantee
openpyxl" — that was false and has been removed.

Nothing in this module writes to the workbook it is given; the patcher always
produces a separate copy.
"""

from __future__ import annotations

import copy
import io
import os
import re
import shutil
import zipfile
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import xml.etree.ElementTree as ET

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"

# Excel's column-width unit is the max-digit-width of the workbook DEFAULT font
# (fonts[0]).  For an 11pt Calibri/Carlito default Excel rounds that to 7px at
# 96dpi.  LibreOffice does NOT: see `column_width_chars_to_pt` below.
DEFAULT_MAX_DIGIT_WIDTH_PX = 7.0
PX_TO_PT = 0.75
DEFAULT_ROW_HEIGHT_PT = 15.0

# Calibri's (and metric-compatible Carlito's) digit advance, in em.  Used only
# as the fallback when the font file cannot be located; the measured advance
# from the font itself is preferred.
CALIBRI_DIGIT_ADVANCE_EM = 0.5068359375
DEFAULT_FONT_SIZE_PT = 11.0


def _q(tag: str) -> str:
    return "{%s}%s" % (NS_MAIN, tag)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


_COL_RE = re.compile(r"^([A-Z]+)(\d+)$")


def col_letters_to_index(letters: str) -> int:
    """'A' -> 1, 'AA' -> 27."""
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def col_index_to_letters(index: int) -> str:
    letters = ""
    while index > 0:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def split_ref(ref: str) -> Tuple[int, int]:
    """'B17' -> (17, 2)  (row, column index)."""
    m = _COL_RE.match(ref.replace("$", ""))
    if not m:
        raise ValueError("unparseable cell reference: %r" % ref)
    return int(m.group(2)), col_letters_to_index(m.group(1))


def excel_column_width_chars_to_pt(width_chars: float, mdw_px: float = DEFAULT_MAX_DIGIT_WIDTH_PX) -> float:
    """Excel column width in 'characters' -> points, the way EXCEL lays it out.

    Excel stores width as a character count against the default font's max digit
    width and adds 5px of cell padding, then quantises to 1/256 of an MDW.

    This is NOT what the render stage measures against.  It is kept because it
    is the correct answer for the Excel side of the honest limit, and because
    stating both makes the difference between them auditable rather than a
    silent assumption.  `column_width_chars_to_pt` below is the LibreOffice one.
    """
    raw = width_chars * mdw_px + 5.0
    quantised = int(raw / mdw_px * 256.0) / 256.0 * mdw_px
    return round(quantised) * PX_TO_PT


def column_width_chars_to_pt(width_chars: float, mdw_pt: float) -> float:
    """OOXML column width in 'characters' -> rendered points, as LIBREOFFICE.

    MEASURED, not assumed.  A column-width sweep (1, 2, ..., 8.43, 9, 9.5, 10,
    ..., 25 chars) rendered through LibreOffice and read back from the PDF fits

        width_pt = width_chars * max_digit_width_pt

    to better than 0.02pt across a full A4 landscape page.  Two things Excel
    does are absent: there is NO +5px cell padding, and there is NO rounding to
    whole pixels -- a 8.43-char column lands exactly 8.43/10 of the way to a
    10-char one.

    Getting this wrong is not a rounding nuisance.  Excel's formula makes a
    2-char gutter 14.25pt where LibreOffice renders 11.1pt, and a 45-char label
    column 240pt where LibreOffice renders 249.75pt.  Those errors are not
    proportional to each other, so no single fitted scale can absorb them: the
    residuals show up as a saw-tooth drift across each column block, which is
    exactly the pattern the horizontal calibration used to report.
    """
    return width_chars * mdw_pt


def row_height_pt_to_rendered_pt(height_pt: float, excel_compat: bool = True) -> float:
    """OOXML row height -> the height LibreOffice actually renders.

    MEASURED, not assumed, and it depends on the PRODUCER.

    LibreOffice runs an Excel row-height compatibility path when the package
    says an Excel wrote it (see `declares_excel_generator`).  On that path a row
    height is truncated to a whole pixel at 96dpi:

        rendered_pt = floor(height_pt / 0.75) * 0.75

    A row-height sweep (9, 10, 10.5, 11, 11.25, 12, 12.5, ... 43pt) rendered
    through LibreOffice and read back from the PDF matches that on every one of
    42 samples: a 12.5pt row (16.67px) renders 12.0pt, an 11pt row (14.67px)
    renders 10.5pt.  Off that path the declared height is honoured: the same
    12.5pt row renders 12.47pt.

    That is a 4% difference on the 12.5pt rows these models use.  Over the ~63
    rows of one page it is more than a full row of accumulated drift -- enough
    to hand every downstream measurement the wrong rectangle while the fit still
    looks plausible.  Columns are never quantised; rows are, conditionally.  The
    asymmetry is LibreOffice's, not a mistake here.
    """
    if height_pt <= 0:
        return 0.0
    if not excel_compat:
        return height_pt
    return int(height_pt / PX_TO_PT) * PX_TO_PT


def declares_excel_generator(application: Optional[str]) -> bool:
    """Does `docProps/app.xml`'s <Application> put LibreOffice on the Excel path?

    MEASURED against this soffice by rewriting one workbook's <Application> and
    re-rendering.  The trigger is the string starting with "Microsoft",
    case-insensitively and with no leading whitespace:

        "Microsoft Excel"                            -> Excel path
        "Microsoft Excel Compatible / Openpyxl 3.1.5"-> Excel path
        "Microsoft Macintosh Excel"                  -> Excel path
        "Microsoft"  / "MicrosoftExcel" / "Microsoft Word"  -> Excel path
        "Excel" / "Openpyxl" / "" / " Microsoft Excel"      -> declared heights
        (no docProps/app.xml at all)                        -> declared heights

    This is the one place the two producers in this project genuinely differ:
    the openpyxl-based shipping path writes "Microsoft Excel Compatible /
    Openpyxl 3.1.5" and gets pixel-truncated rows; the artifact tool writes no
    docProps at all and gets its declared rows.  Same sheet XML, two different
    renders.  It is not a spelling difference the harness invented -- it is a
    real behavioural fork inside LibreOffice, and modelling only one side of it
    puts a 4% error into every row coordinate on the other.

    The choice is a PREDICTION.  `calibrate.build_grid` verifies it against the
    render and reports if the observation disagrees, rather than trusting it.
    """
    if not application:
        return False
    return application.startswith("Microsoft") or application.lower().startswith("microsoft")


@dataclass
class Cell:
    ref: str
    row: int
    col: int
    style_id: int
    kind: Optional[str]  # 't' attribute: None (numeric) / 'str' / 's' / 'b' / 'e'
    raw_value: Optional[str]
    formula: Optional[str]

    @property
    def is_empty(self) -> bool:
        return self.raw_value is None or self.raw_value == ""


@dataclass
class Style:
    style_id: int
    font_id: int
    fill_id: int
    border_id: int
    num_fmt_id: int
    horizontal: Optional[str]
    indent: int


@dataclass
class Font:
    name: Optional[str]
    size: Optional[float]
    bold: bool
    italic: bool
    color_rgb: Optional[str]


@dataclass
class Fill:
    pattern: Optional[str]
    fg_rgb: Optional[str]
    bg_rgb: Optional[str]

    @property
    def solid_rgb(self) -> Optional[str]:
        if self.pattern != "solid":
            return None
        return self.fg_rgb or self.bg_rgb


@dataclass
class CfRule:
    sqref: str
    rule_type: Optional[str]
    dxf_id: Optional[int]
    priority: Optional[int]
    operator: Optional[str]
    formulas: List[str]
    text: Optional[str]


@dataclass
class Dxf:
    dxf_id: int
    fill_rgb: Optional[str]
    font_color_rgb: Optional[str]
    bold: Optional[bool]


@dataclass
class Sheet:
    name: str
    part: str
    index: int  # 0-based position in workbook.xml
    # "visible" | "hidden" | "veryHidden", straight from workbook.xml.  The gate
    # renders every VISIBLE sheet, so this is what decides whether a sheet is in
    # scope; a sheet the author hid is not something an analyst sees.
    state: str = "visible"
    cells: Dict[str, Cell] = field(default_factory=dict)
    col_width_chars: Dict[int, float] = field(default_factory=dict)
    col_hidden: Dict[int, bool] = field(default_factory=dict)
    row_height_pt: Dict[int, float] = field(default_factory=dict)
    row_hidden: Dict[int, bool] = field(default_factory=dict)
    default_row_height_pt: float = DEFAULT_ROW_HEIGHT_PT
    default_col_width_chars: Optional[float] = None
    merged: List[str] = field(default_factory=list)
    cf_rules: List[CfRule] = field(default_factory=list)
    max_row: int = 0
    max_col: int = 0
    has_page_setup: bool = False
    fit_to_page: bool = False
    page_setup_attrs: Dict[str, str] = field(default_factory=dict)
    # The workbook default font's digit advance, in points.  Set by
    # `load_workbook`; it is the unit of the OOXML column width.
    max_digit_width_pt: float = CALIBRI_DIGIT_ADVANCE_EM * DEFAULT_FONT_SIZE_PT
    max_digit_width_source: str = "fallback:calibri-metric"
    # Whether LibreOffice will take its Excel row-height compatibility path for
    # the package this sheet came from.  Set by `load_workbook`.
    excel_row_height_compat: bool = False

    def cell(self, row: int, col: int) -> Optional[Cell]:
        return self.cells.get("%s%d" % (col_index_to_letters(col), row))


@dataclass
class Workbook:
    path: str
    sheets: List[Sheet]
    fonts: List[Font]
    fills: List[Fill]
    styles: List[Style]
    dxfs: List[Dxf]
    num_fmts: Dict[int, str]
    shared_strings: List[str]
    defined_names: Dict[str, str]
    default_font: Optional[Font]
    calc_pr: Dict[str, str]
    workbook_part: str = "xl/workbook.xml"
    styles_part: Optional[str] = None
    shared_strings_part: Optional[str] = None
    max_digit_width_pt: float = CALIBRI_DIGIT_ADVANCE_EM * DEFAULT_FONT_SIZE_PT
    max_digit_width_source: str = "fallback:calibri-metric"
    generator_application: Optional[str] = None
    excel_row_height_compat: bool = False

    def sheet_by_name(self, name: str) -> Optional[Sheet]:
        for sheet in self.sheets:
            if sheet.name == name:
                return sheet
        return None

    def visible_sheets(self) -> List[Sheet]:
        """Every sheet an analyst can see, in workbook order."""
        return [s for s in self.sheets if s.state == "visible"]

    def style(self, style_id: int) -> Optional[Style]:
        if 0 <= style_id < len(self.styles):
            return self.styles[style_id]
        return None

    def cell_fill_rgb(self, style_id: int) -> Optional[str]:
        style = self.style(style_id)
        if style is None:
            return None
        if 0 <= style.fill_id < len(self.fills):
            return self.fills[style.fill_id].solid_rgb
        return None

    def cell_font(self, style_id: int) -> Optional[Font]:
        style = self.style(style_id)
        if style is None:
            return None
        if 0 <= style.font_id < len(self.fonts):
            return self.fonts[style.font_id]
        return None

    def declared_font_names(self) -> List[str]:
        names = set()
        for font in self.fonts:
            if font.name:
                names.add(font.name)
        return sorted(names)


def _rgb(elem: Optional[ET.Element]) -> Optional[str]:
    if elem is None:
        return None
    rgb = elem.get("rgb")
    if rgb:
        rgb = rgb.upper()
        return rgb[2:] if len(rgb) == 8 else rgb
    indexed = elem.get("indexed")
    if indexed is not None:
        return _INDEXED_COLORS.get(int(indexed))
    theme = elem.get("theme")
    if theme is not None:
        # Theme colours need the theme part to resolve.  We deliberately return
        # None rather than a guess: a wrong colour would make the fill check
        # assert against fiction.
        return None
    return None


# Legacy indexed palette, enough for the handful of files that still use it.
_INDEXED_COLORS = {
    0: "000000", 1: "FFFFFF", 2: "FF0000", 3: "00FF00", 4: "0000FF",
    5: "FFFF00", 6: "FF00FF", 7: "00FFFF", 8: "000000", 9: "FFFFFF",
    64: "000000", 65: "FFFFFF",
}


def _parse_styles(data: bytes) -> Tuple[List[Font], List[Fill], List[Style], List[Dxf], Dict[int, str]]:
    root = ET.fromstring(data)

    num_fmts: Dict[int, str] = {}
    for node in root.findall(_q("numFmts") + "/" + _q("numFmt")):
        num_fmts[int(node.get("numFmtId", "0"))] = node.get("formatCode", "")

    def parse_font(node: ET.Element) -> Font:
        name_node = node.find(_q("name"))
        size_node = node.find(_q("sz"))
        return Font(
            name=name_node.get("val") if name_node is not None else None,
            size=float(size_node.get("val")) if size_node is not None and size_node.get("val") else None,
            bold=node.find(_q("b")) is not None,
            italic=node.find(_q("i")) is not None,
            color_rgb=_rgb(node.find(_q("color"))),
        )

    fonts_parent = root.find(_q("fonts"))
    fonts = [parse_font(n) for n in fonts_parent] if fonts_parent is not None else []

    def parse_fill(node: ET.Element) -> Fill:
        pattern = node.find(_q("patternFill"))
        if pattern is None:
            return Fill(None, None, None)
        return Fill(
            pattern=pattern.get("patternType"),
            fg_rgb=_rgb(pattern.find(_q("fgColor"))),
            bg_rgb=_rgb(pattern.find(_q("bgColor"))),
        )

    fills_parent = root.find(_q("fills"))
    fills = [parse_fill(n) for n in fills_parent] if fills_parent is not None else []

    styles: List[Style] = []
    cell_xfs = root.find(_q("cellXfs"))
    if cell_xfs is not None:
        for i, node in enumerate(cell_xfs):
            alignment = node.find(_q("alignment"))
            styles.append(
                Style(
                    style_id=i,
                    font_id=int(node.get("fontId", "0")),
                    fill_id=int(node.get("fillId", "0")),
                    border_id=int(node.get("borderId", "0")),
                    num_fmt_id=int(node.get("numFmtId", "0")),
                    horizontal=alignment.get("horizontal") if alignment is not None else None,
                    indent=int(alignment.get("indent", "0")) if alignment is not None else 0,
                )
            )

    dxfs: List[Dxf] = []
    dxfs_parent = root.find(_q("dxfs"))
    if dxfs_parent is not None:
        for i, node in enumerate(dxfs_parent):
            fill_node = node.find(_q("fill"))
            fill_rgb = None
            if fill_node is not None:
                parsed = parse_fill(fill_node)
                # In a dxf the *background* colour of a solid patternFill is the
                # applied colour -- the opposite convention to a cell fill.
                fill_rgb = parsed.bg_rgb or parsed.fg_rgb
            font_node = node.find(_q("font"))
            dxfs.append(
                Dxf(
                    dxf_id=i,
                    fill_rgb=fill_rgb,
                    font_color_rgb=_rgb(font_node.find(_q("color"))) if font_node is not None else None,
                    bold=(font_node.find(_q("b")) is not None) if font_node is not None else None,
                )
            )

    return fonts, fills, styles, dxfs, num_fmts


def _parse_shared_strings(data: bytes) -> List[str]:
    root = ET.fromstring(data)
    out: List[str] = []
    for si in root:
        parts = [t.text or "" for t in si.iter(_q("t"))]
        out.append("".join(parts))
    return out


def _parse_sheet(data: bytes, sheet: Sheet) -> None:
    root = ET.fromstring(data)

    fmt = root.find(_q("sheetFormatPr"))
    if fmt is not None:
        if fmt.get("defaultRowHeight"):
            sheet.default_row_height_pt = float(fmt.get("defaultRowHeight"))
        if fmt.get("defaultColWidth"):
            sheet.default_col_width_chars = float(fmt.get("defaultColWidth"))

    cols = root.find(_q("cols"))
    if cols is not None:
        for node in cols:
            lo = int(node.get("min", "1"))
            hi = int(node.get("max", str(lo)))
            width = node.get("width")
            hidden = node.get("hidden") in ("1", "true")
            for c in range(lo, hi + 1):
                if width is not None:
                    sheet.col_width_chars[c] = float(width)
                sheet.col_hidden[c] = hidden

    sheet_pr = root.find(_q("sheetPr"))
    if sheet_pr is not None:
        setup_pr = sheet_pr.find(_q("pageSetUpPr"))
        if setup_pr is not None and setup_pr.get("fitToPage") in ("1", "true"):
            sheet.fit_to_page = True

    page_setup = root.find(_q("pageSetup"))
    if page_setup is not None:
        sheet.has_page_setup = True
        sheet.page_setup_attrs = dict(page_setup.attrib)

    data_root = root.find(_q("sheetData"))
    if data_root is not None:
        for row_node in data_root:
            row_index = int(row_node.get("r"))
            if row_node.get("ht"):
                sheet.row_height_pt[row_index] = float(row_node.get("ht"))
            if row_node.get("hidden") in ("1", "true"):
                sheet.row_hidden[row_index] = True
            sheet.max_row = max(sheet.max_row, row_index)
            for cell_node in row_node:
                ref = cell_node.get("r")
                if not ref:
                    continue
                r, c = split_ref(ref)
                value_node = cell_node.find(_q("v"))
                inline = cell_node.find(_q("is"))
                raw = None
                if value_node is not None:
                    raw = value_node.text
                elif inline is not None:
                    raw = "".join(t.text or "" for t in inline.iter(_q("t")))
                formula_node = cell_node.find(_q("f"))
                sheet.cells[ref] = Cell(
                    ref=ref,
                    row=r,
                    col=c,
                    style_id=int(cell_node.get("s", "0")),
                    kind=cell_node.get("t"),
                    raw_value=raw,
                    formula=formula_node.text if formula_node is not None else None,
                )
                sheet.max_col = max(sheet.max_col, c)

    merges = root.find(_q("mergeCells"))
    if merges is not None:
        sheet.merged = [n.get("ref") for n in merges if n.get("ref")]

    for cf in root.findall(_q("conditionalFormatting")):
        sqref = cf.get("sqref", "")
        for rule in cf.findall(_q("cfRule")):
            sheet.cf_rules.append(
                CfRule(
                    sqref=sqref,
                    rule_type=rule.get("type"),
                    dxf_id=int(rule.get("dxfId")) if rule.get("dxfId") is not None else None,
                    priority=int(rule.get("priority")) if rule.get("priority") is not None else None,
                    operator=rule.get("operator"),
                    formulas=[(f.text or "") for f in rule.findall(_q("formula"))],
                    text=rule.get("text"),
                )
            )


NS_EXTENDED_PROPS = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
REL_TYPE_EXTENDED_PROPS = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties")
REL_TYPE_OFFICE_DOCUMENT = NS_REL_DOC + "/officeDocument"
REL_TYPE_STYLES = NS_REL_DOC + "/styles"
REL_TYPE_SHARED_STRINGS = NS_REL_DOC + "/sharedStrings"
REL_TYPE_WORKSHEET = NS_REL_DOC + "/worksheet"


def _resolve_part(base_part: str, target: str) -> str:
    """Resolve a relationship Target against the part that declared it.

    Relationship targets are package paths, not filenames.  Resolving them by
    guessing a filename ("xl/styles.xml") is the defect this project has already
    found three times: two conformant producers may spell the same part
    differently and the guess silently reads nothing, so every style-derived
    assertion goes quiet instead of failing.
    """
    if target.startswith("/"):
        return target.lstrip("/")
    base_dir = os.path.dirname(base_part)
    joined = os.path.normpath(os.path.join(base_dir, target)) if base_dir else os.path.normpath(target)
    return joined.replace(os.sep, "/").lstrip("/")


def _read_rels(zf: "zipfile.ZipFile", part: str) -> List[Tuple[str, str, str]]:
    """[(Id, Type, resolved target part)] for the .rels of `part`."""
    base_dir = os.path.dirname(part)
    rels_name = "%s/_rels/%s.rels" % (base_dir, os.path.basename(part)) if base_dir \
        else "_rels/%s.rels" % os.path.basename(part)
    if rels_name not in set(zf.namelist()):
        return []
    root = ET.fromstring(zf.read(rels_name))
    out: List[Tuple[str, str, str]] = []
    for node in root:
        out.append((node.get("Id", ""), node.get("Type", ""),
                    _resolve_part(part, node.get("Target", ""))))
    return out


def workbook_part_name(zf: "zipfile.ZipFile") -> str:
    """The workbook part, found through the package root relationships."""
    # `_read_rels(zf, "")` reads `_rels/.rels`, which is where the
    # officeDocument relationship lives.
    for _rid, rel_type, target in _read_rels(zf, ""):
        if rel_type == REL_TYPE_OFFICE_DOCUMENT:
            return target
    raise KeyError("no officeDocument relationship in _rels/.rels of this package")


def resolve_max_digit_width_pt(default_font: Optional[Font]) -> Tuple[float, str]:
    """The OOXML column-width unit, in points, for `default_font`.

    LibreOffice's column width is `width_chars * digit_advance`, where the
    advance comes from the workbook's default font at its declared size.  It is
    measured from the font file when one is available; the Calibri metric is the
    documented fallback, and which one was used is recorded in the evidence so a
    reader can tell a measurement from an assumption.
    """
    size = (default_font.size if default_font and default_font.size else DEFAULT_FONT_SIZE_PT)
    try:
        from . import textfit  # local import: textfit imports this module

        fonts = textfit.load_font_set()
        advance = fonts.measure("0", size, bold=False)
        if advance > 0:
            # LibreOffice carries the char width in twips, so the advance is
            # truncated to 1/20pt before it becomes the column unit.
            return int(advance * 20.0) / 20.0, "measured:%s" % os.path.basename(fonts.regular_path)
    except Exception:  # noqa: BLE001 -- the fallback is documented, not silent
        pass
    return CALIBRI_DIGIT_ADVANCE_EM * size, "fallback:calibri-metric"


def load_workbook(path: str) -> Workbook:
    """Parse the parts of an .xlsx that the render checks depend on."""
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())

        wb_part = workbook_part_name(zf)
        application = None
        for _rid, rel_type, target in _read_rels(zf, ""):
            if rel_type == REL_TYPE_EXTENDED_PROPS and target in names:
                props = ET.fromstring(zf.read(target))
                node = props.find("{%s}Application" % NS_EXTENDED_PROPS)
                application = (node.text or "") if node is not None else ""
                break
        rel_targets: Dict[str, str] = {}
        rel_by_type: Dict[str, List[str]] = {}
        for rid, rel_type, target in _read_rels(zf, wb_part):
            rel_targets[rid] = target
            rel_by_type.setdefault(rel_type, []).append(target)

        wb_root = ET.fromstring(zf.read(wb_part))
        sheets: List[Sheet] = []
        sheets_parent = wb_root.find(_q("sheets"))
        for i, node in enumerate(sheets_parent if sheets_parent is not None else []):
            rid = node.get("{%s}id" % NS_REL_DOC)
            part = rel_targets.get(rid, "")
            sheets.append(Sheet(name=node.get("name", ""), part=part, index=i,
                                state=node.get("state", "visible")))

        defined_names: Dict[str, str] = {}
        dn_parent = wb_root.find(_q("definedNames"))
        if dn_parent is not None:
            for node in dn_parent:
                defined_names[node.get("name", "")] = node.text or ""

        calc_pr: Dict[str, str] = {}
        calc_node = wb_root.find(_q("calcPr"))
        if calc_node is not None:
            calc_pr = dict(calc_node.attrib)

        fonts: List[Font] = []
        fills: List[Fill] = []
        styles: List[Style] = []
        dxfs: List[Dxf] = []
        num_fmts: Dict[int, str] = {}
        styles_part = next((t for t in rel_by_type.get(REL_TYPE_STYLES, []) if t in names), None)
        if styles_part:
            fonts, fills, styles, dxfs, num_fmts = _parse_styles(zf.read(styles_part))

        shared: List[str] = []
        shared_part = next(
            (t for t in rel_by_type.get(REL_TYPE_SHARED_STRINGS, []) if t in names), None)
        if shared_part:
            shared = _parse_shared_strings(zf.read(shared_part))

        for sheet in sheets:
            if sheet.part in names:
                _parse_sheet(zf.read(sheet.part), sheet)

    default_font = fonts[0] if fonts else None
    mdw_pt, mdw_source = resolve_max_digit_width_pt(default_font)
    excel_compat = declares_excel_generator(application)
    for sheet in sheets:
        sheet.max_digit_width_pt = mdw_pt
        sheet.max_digit_width_source = mdw_source
        sheet.excel_row_height_compat = excel_compat

    return Workbook(
        path=path,
        sheets=sheets,
        fonts=fonts,
        fills=fills,
        styles=styles,
        dxfs=dxfs,
        num_fmts=num_fmts,
        shared_strings=shared,
        defined_names=defined_names,
        default_font=default_font,
        calc_pr=calc_pr,
        workbook_part=wb_part,
        styles_part=styles_part,
        shared_strings_part=shared_part,
        max_digit_width_pt=mdw_pt,
        max_digit_width_source=mdw_source,
        generator_application=application,
        excel_row_height_compat=excel_compat,
    )


def cell_text(workbook: Workbook, cell: Cell) -> Optional[str]:
    """The cell's *stored* value as a string, resolving shared strings."""
    if cell.raw_value is None:
        return None
    if cell.kind == "s":
        try:
            return workbook.shared_strings[int(cell.raw_value)]
        except (ValueError, IndexError):
            return None
    return cell.raw_value


def cell_is_numeric(cell: Cell) -> bool:
    if cell.raw_value is None:
        return False
    if cell.kind in ("s", "str", "b", "e", "inlineStr"):
        return False
    try:
        float(cell.raw_value)
        return True
    except ValueError:
        return False


# --------------------------------------------------------------------------
# Geometry derived from the workbook
# --------------------------------------------------------------------------


def column_edges_pt(sheet: Sheet, first_col: int, last_col: int, mdw_pt: Optional[float] = None) -> List[float]:
    """Cumulative left edges (plus a trailing right edge) in rendered points."""
    if mdw_pt is None:
        mdw_pt = sheet.max_digit_width_pt
    edges = [0.0]
    total = 0.0
    for c in range(first_col, last_col + 1):
        if sheet.col_hidden.get(c):
            width_pt = 0.0
        else:
            chars = sheet.col_width_chars.get(c, sheet.default_col_width_chars or 8.43)
            width_pt = column_width_chars_to_pt(chars, mdw_pt)
        total += width_pt
        edges.append(total)
    return edges


def row_edges_pt(sheet: Sheet, first_row: int, last_row: int,
                 excel_compat: Optional[bool] = None) -> List[float]:
    """Cumulative row top edges (plus a trailing bottom edge), as RENDERED.

    Row heights go through `row_height_pt_to_rendered_pt`, which is producer
    dependent: see `declares_excel_generator`.  Using the declared height on the
    Excel-compatibility path drifts 4% on a 12.5pt row -- a full row per page.
    """
    if excel_compat is None:
        excel_compat = sheet.excel_row_height_compat
    edges = [0.0]
    total = 0.0
    for r in range(first_row, last_row + 1):
        if sheet.row_hidden.get(r):
            height = 0.0
        else:
            height = row_height_pt_to_rendered_pt(
                sheet.row_height_pt.get(r, sheet.default_row_height_pt), excel_compat)
        total += height
        edges.append(total)
    return edges


# --------------------------------------------------------------------------
# Page-setup patcher
# --------------------------------------------------------------------------

_PAGE_SETUP_SUCCESSORS = ("headerFooter", "rowBreaks", "colBreaks", "customProperties",
                          "cellWatches", "ignoredErrors", "smartTags", "drawing",
                          "legacyDrawing", "legacyDrawingHF", "picture", "oleObjects",
                          "controls", "webPublishItems", "tableParts", "extLst")

# A4 landscape, less LibreOffice's default 0.7874in (20mm) left/right margins.
A4_LANDSCAPE_WIDTH_PT = 841.89
DEFAULT_SIDE_MARGIN_PT = 56.69
PRINTABLE_WIDTH_PT = A4_LANDSCAPE_WIDTH_PT - 2 * DEFAULT_SIDE_MARGIN_PT


def needs_fit_to_width(sheet: "Sheet", first_col: int, last_col: int) -> bool:
    """Whether this print range is too wide for the page at natural scale.

    Fit-to-width shrinks AND magnifies.  Applying it unconditionally is what
    turned the 377pt Brokers sheet into twelve uncalibratable pages, so the
    answer is measured from the sheet's own column widths rather than assumed.
    """
    return column_edges_pt(sheet, first_col, last_col)[-1] > PRINTABLE_WIDTH_PT


@dataclass
class PageSetupPlan:
    sheet_name: str
    first_col: int
    last_col: int
    first_row: int
    last_row: int
    orientation: str = "landscape"
    paper_size: str = "9"  # A4
    fit_to_width: int = 1
    fit_to_height: int = 0
    hide_other_sheets: bool = True
    strip_full_calc_on_load: bool = True
    # Fit-to-width scales in BOTH directions.  On a sheet narrower than the
    # printable width it magnifies rather than shrinks: the 377pt Brokers sheet
    # rendered over 12 pages at roughly 6 rows each, and its label panel landed
    # outside the fitted column grid so no page could be calibrated at all.  A
    # sheet that already fits is therefore printed at natural scale.  This is
    # chosen per sheet from measured content width (see `needs_fit_to_width`),
    # never assumed, and the Operating Model at 1188pt is unaffected.
    fit_to_page: bool = True

    @property
    def print_area(self) -> str:
        return "$%s$%d:$%s$%d" % (
            col_index_to_letters(self.first_col), self.first_row,
            col_index_to_letters(self.last_col), self.last_row,
        )


def _insert_before_known_successor(parent: ET.Element, child: ET.Element, successors: Sequence[str]) -> None:
    for i, existing in enumerate(list(parent)):
        if _local(existing.tag) in successors:
            parent.insert(i, child)
            return
    parent.append(child)


def apply_page_setup(source_path: str, dest_path: str, plan: PageSetupPlan) -> Dict[str, object]:
    """Write a copy of `source_path` at `dest_path` with deterministic pagination.

    Why this exists: explicit page scaling does NOT survive LibreOffice (85%
    silently became 100%), but print area + fit-to-width does.  Without a
    deliberate print area every "clipping" finding is a pagination artefact
    rather than a real defect, so this is the step most likely to be got wrong.

    The source workbook is never modified.  The delivered workbook is never sent
    back through LibreOffice; only this throwaway copy is.
    """
    ET.register_namespace("x", NS_MAIN)
    ET.register_namespace("r", NS_REL_DOC)
    notes: Dict[str, object] = {
        "print_area": plan.print_area,
        "fit_to_page": plan.fit_to_page,
        "fit_to_width": plan.fit_to_width if plan.fit_to_page else None,
        "fit_to_height": plan.fit_to_height if plan.fit_to_page else None,
        "orientation": plan.orientation,
        "hidden_sheets": [],
        "stripped_calc_attrs": [],
    }

    with zipfile.ZipFile(source_path) as src:
        entries = [(info, src.read(info.filename)) for info in src.infolist()]
        # Resolved by RELATIONSHIP, never by guessed filename.  Two conformant
        # producers spell these parts differently and a filename guess reads the
        # wrong bytes -- or none -- while still reporting success.
        wb_part = workbook_part_name(src)
        sheet_rels = _read_rels(src, wb_part)

    parts = {info.filename: payload for info, payload in entries}
    notes["workbook_part"] = wb_part

    # --- workbook.xml : print area defined name, hide other sheets ----------
    wb_root = ET.fromstring(parts[wb_part])
    sheets_parent = wb_root.find(_q("sheets"))
    target_index = None
    for i, node in enumerate(sheets_parent):
        if node.get("name") == plan.sheet_name:
            target_index = i
        elif plan.hide_other_sheets:
            node.set("state", "hidden")
            notes["hidden_sheets"].append(node.get("name"))
    if target_index is None:
        raise KeyError("sheet %r not found in %s" % (plan.sheet_name, source_path))

    dn_parent = wb_root.find(_q("definedNames"))
    if dn_parent is None:
        dn_parent = ET.Element(_q("definedNames"))
        # Schema order: sheets, functionGroups, externalReferences, definedNames,
        # calcPr, ...
        _insert_before_known_successor(
            wb_root, dn_parent,
            ("calcPr", "oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr",
             "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects",
             "extLst"),
        )
    for node in list(dn_parent):
        if node.get("name") == "_xlnm.Print_Area" and node.get("localSheetId") == str(target_index):
            dn_parent.remove(node)
    dn = ET.SubElement(dn_parent, _q("definedName"))
    dn.set("name", "_xlnm.Print_Area")
    dn.set("localSheetId", str(target_index))
    quoted = plan.sheet_name.replace("'", "''")
    dn.text = "'%s'!%s" % (quoted, plan.print_area)

    if plan.strip_full_calc_on_load:
        calc = wb_root.find(_q("calcPr"))
        if calc is not None:
            for attr in ("fullCalcOnLoad", "forceFullCalc"):
                if attr in calc.attrib:
                    del calc.attrib[attr]
                    notes["stripped_calc_attrs"].append(attr)

    # --- point the active tab at the target sheet --------------------------
    # LibreOffice will NOT hide the sheet named by `activeTab`.  Leaving it at
    # the workbook's stored value meant that staging any sheet other than the
    # active one produced a PDF of the ACTIVE sheet -- silently, exit code 0,
    # with the target sheet appended at the back and the whole document laid
    # out under the active sheet's page setup.  Targeting `Brokers` rendered
    # nine pages of Operating Model followed by three of Brokers; the only
    # symptom was a calibration error about a missing label panel.
    #
    # This was invisible while the gate only ever asked for the Operating
    # Model, which is sheet 0 and already the active tab.
    for view in wb_root.iter(_q("workbookView")):
        view.set("activeTab", str(target_index))
        view.set("firstSheet", str(target_index))
    notes["active_tab"] = target_index

    parts[wb_part] = _serialise(wb_root)

    # --- sheet part : pageSetUpPr + pageSetup ------------------------------
    rel_targets = {rid: target for rid, _type, target in sheet_rels}
    rid = list(sheets_parent)[target_index].get("{%s}id" % NS_REL_DOC)
    sheet_part = rel_targets.get(rid)
    if sheet_part is None or sheet_part not in parts:
        raise KeyError(
            "sheet %r resolves through relationship %r to %r, which is not in the "
            "package" % (plan.sheet_name, rid, sheet_part))

    # `tabSelected` is the per-sheet half of the same story as `activeTab`
    # above: a sheet still flagged selected is treated as in view and is not
    # hidden.  Resolved through the same relationship table as the target, so a
    # package that spells its parts unusually is not silently skipped.
    for i, node in enumerate(list(sheets_parent)):
        part_name = rel_targets.get(node.get("{%s}id" % NS_REL_DOC))
        if part_name is None or part_name not in parts:
            continue
        root = ET.fromstring(parts[part_name])
        changed = False
        for view in root.iter(_q("sheetView")):
            want = "1" if i == target_index else None
            if want is None:
                if "tabSelected" in view.attrib:
                    del view.attrib["tabSelected"]
                    changed = True
            elif view.get("tabSelected") != want:
                view.set("tabSelected", want)
                changed = True
        if changed:
            parts[part_name] = _serialise(root)

    sheet_root = ET.fromstring(parts[sheet_part])

    sheet_pr = sheet_root.find(_q("sheetPr"))
    if sheet_pr is None:
        sheet_pr = ET.Element(_q("sheetPr"))
        sheet_root.insert(0, sheet_pr)
    setup_pr = sheet_pr.find(_q("pageSetUpPr"))
    if setup_pr is None:
        setup_pr = ET.SubElement(sheet_pr, _q("pageSetUpPr"))
    setup_pr.set("fitToPage", "1" if plan.fit_to_page else "0")

    for existing in sheet_root.findall(_q("pageSetup")):
        sheet_root.remove(existing)
    page_setup = ET.Element(_q("pageSetup"))
    page_setup.set("paperSize", plan.paper_size)
    page_setup.set("orientation", plan.orientation)
    if plan.fit_to_page:
        page_setup.set("fitToWidth", str(plan.fit_to_width))
        page_setup.set("fitToHeight", str(plan.fit_to_height))
    # Deliberately NO `scale` attribute: explicit scaling does not survive the
    # LibreOffice round trip, fit-to-width does.
    _insert_before_known_successor(sheet_root, page_setup, _PAGE_SETUP_SUCCESSORS)

    parts[sheet_part] = _serialise(sheet_root)
    notes["sheet_part"] = sheet_part

    with zipfile.ZipFile(dest_path, "w", zipfile.ZIP_DEFLATED) as dst:
        for info, _payload in entries:
            dst.writestr(info.filename, parts[info.filename])

    return notes


def _serialise(root: ET.Element) -> bytes:
    buf = io.BytesIO()
    ET.ElementTree(root).write(buf, encoding="utf-8", xml_declaration=True)
    return buf.getvalue()
