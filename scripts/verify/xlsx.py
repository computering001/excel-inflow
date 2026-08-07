"""Dependency-free .xlsx reader for the deployment host-shippable validator.

The Node validator this replaces reached into `private workbook library` for three
things and two more that an earlier survey missed:

  1. `SpreadsheetFile.importXlsx()`      -> `Workbook.open()`
  2. `getRange(a).values[0][0]`          -> `Sheet.value(a)`
  3. `getRange(a).formulas[0][0]`        -> `Sheet.formula(a)`
  4. `workbook.inspect({kind: "sheet"})` -> `Workbook.sheet_names`
  5. `workbook.inspect({kind: "match"})` -> `Workbook.match_values()`

Nothing here needs a third-party package: only `zipfile` and
`xml.etree.ElementTree` from the standard library.  openpyxl/lxml would both
work, but a stdlib reader has no version surface at all, which is the point of
the port.

Semantics are matched to legacy workbook library, verified by probe against
kerry-v2.xlsx:

  * `values` returns the CACHED value: a float for `t="n"`, the text for
    `t="str"`/`t="s"`/`t="inlineStr"`, a bool for `t="b"`, the error text for
    `t="e"`, and None for an absent cell or an empty cached string.  Dates come
    back as the raw serial number (legacy workbook library does not rehydrate them).
  * `formulas` returns "" for a cell with no formula -- it does NOT fall back
    to the value the way the Office.js `Range.formulas` API does -- and returns
    the formula text with a leading "=" for a cell that has one.
"""

from __future__ import annotations

import re
import zipfile
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional, Tuple

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

REL_OFFICE_DOCUMENT = DOC_REL_NS + "/officeDocument"
REL_STYLES = DOC_REL_NS + "/styles"
REL_SHARED_STRINGS = DOC_REL_NS + "/sharedStrings"
REL_WORKSHEET = DOC_REL_NS + "/worksheet"
REL_THEME = DOC_REL_NS + "/theme"
REL_COMMENTS = DOC_REL_NS + "/comments"
REL_DRAWING = DOC_REL_NS + "/drawing"
REL_EXTERNAL_LINK = DOC_REL_NS + "/externalLink"

_ADDRESS = re.compile(r"^([A-Z]+)(\d+)$")


def resolve_part(base_part: str, target: str) -> str:
    """Resolve a relationship Target against the part that declared it.

    OPC targets are relative to the DECLARING PART'S FOLDER, and may climb out
    of it with `..`.  Prefixing "xl/" onto anything that does not already start
    with it -- which is what this used to do -- is a guess that happens to be
    right only because both producers keep everything under `xl/`.
    """
    if target.startswith("/"):
        return target[1:]
    base = base_part.rpartition("/")[0]
    segments: List[str] = base.split("/") if base else []
    for segment in target.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if segments:
                segments.pop()
            continue
        segments.append(segment)
    return "/".join(segments)


def column_number(column: str) -> int:
    total = 0
    for character in column:
        total = total * 26 + ord(character) - 64
    return total


def column_letters(number: int) -> str:
    value = number
    result = ""
    while value > 0:
        value -= 1
        result = chr(65 + (value % 26)) + result
        value //= 26
    return result


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


class Sheet:
    """One worksheet: cached values, formulas, and the raw part text."""

    def __init__(self, name: str, index: int, part: str, xml_text: str,
                 shared_strings: List[str]) -> None:
        self.name = name
        self.index = index
        self.part = part
        self.xml = xml_text
        self._values: Dict[str, object] = {}
        self._formulas: Dict[str, str] = {}
        self._shared_formula_bases: Dict[str, Tuple[str, str]] = {}
        self._parse(xml_text, shared_strings)

    # ---------------------------------------------------------------- parsing

    def _parse(self, xml_text: str, shared_strings: List[str]) -> None:
        root = ET.fromstring(xml_text)
        pending_shared: List[Tuple[str, str]] = []
        for cell in root.iter():
            if _local(cell.tag) != "c":
                continue
            address = cell.get("r")
            if not address:
                continue
            cell_type = cell.get("t") or "n"
            raw_value: Optional[str] = None
            formula_text = ""
            for child in cell:
                name = _local(child.tag)
                if name == "v":
                    raw_value = child.text
                elif name == "f":
                    body = child.text or ""
                    shared_index = child.get("si")
                    if child.get("t") == "shared" and body and shared_index is not None:
                        self._shared_formula_bases[shared_index] = (address, body)
                    if body:
                        formula_text = body
                    elif shared_index is not None:
                        pending_shared.append((address, shared_index))
                elif name == "is":
                    raw_value = "".join(
                        node.text or ""
                        for node in child.iter()
                        if _local(node.tag) == "t"
                    )
            if formula_text:
                self._formulas[address] = "=" + formula_text
            self._values[address] = self._decode(cell_type, raw_value, shared_strings)

        # Cells that only carry `si` inherit the base formula, shifted.
        for address, shared_index in pending_shared:
            base = self._shared_formula_bases.get(shared_index)
            if not base:
                continue
            base_address, base_formula = base
            self._formulas[address] = "=" + shift_shared_formula(
                base_formula, base_address, address
            )

    @staticmethod
    def _decode(cell_type: str, raw: Optional[str], shared_strings: List[str]):
        if raw is None:
            return None
        if cell_type == "s":
            try:
                return shared_strings[int(raw)]
            except (ValueError, IndexError):
                return None
        if cell_type in ("str", "inlineStr", "e"):
            return raw if raw != "" else None
        if cell_type == "b":
            return raw == "1"
        if cell_type == "d":
            return raw if raw != "" else None
        if raw == "":
            return None
        try:
            return float(raw)
        except ValueError:
            return raw

    # ------------------------------------------------------------- public API

    def value(self, address: str):
        """legacy workbook library `getRange(address).values[0][0] ?? null`."""
        return self._values.get(address, None)

    def formula(self, address: str) -> str:
        """legacy workbook library `getRange(address).formulas[0][0] ?? ""`."""
        return self._formulas.get(address, "")

    @property
    def cells(self) -> Dict[str, object]:
        return self._values

    @property
    def formula_cells(self) -> Dict[str, str]:
        return self._formulas


class PartResolutionError(Exception):
    """A required part could not be reached through any relationship.

    Raised rather than returning "" on purpose.  Every part this reader needs is
    load-bearing: an unread `sharedStrings` blanks every string cell, an unread
    `styles` erases every font colour, an unread `workbook` erases every sheet.
    Silently reading an empty part turns each of those into a green check over a
    file nothing was read from, which is the failure mode this whole class of
    fix exists to remove.
    """


class Workbook:
    """A workbook read THROUGH ITS RELATIONSHIPS, not through guessed names.

    `xl/workbook.xml`, `xl/styles.xml`, `xl/sharedStrings.xml` and
    `xl/worksheets/sheetN.xml` are CONVENTIONS, not part names.  OPC says the
    package's `_rels/.rels` names the workbook part, the workbook's own rels
    name styles/sharedStrings/each worksheet, and a producer may put any of them
    anywhere it likes.  Both producers here happen to follow the convention, so
    nothing is mis-read today — but the same guess has now been the root of four
    separate defects in this project (the comments part, a sheet asked for by
    name, a reference regex anchored on a literal prefix, and these), and the
    consequence is not a crash: `sharedStrings` read as empty blanks EVERY
    string cell in the workbook and the reader reports success.

    Resolution therefore goes: `_rels/.rels` -> officeDocument -> the workbook's
    own `.rels` -> styles / sharedStrings / worksheets.  Anything that resolves
    to nothing raises `PartResolutionError` instead of yielding an empty string.
    """

    def __init__(self, path: str) -> None:
        self.path = path
        self._zip = zipfile.ZipFile(path)
        self.names: List[str] = self._zip.namelist()
        self._parts: Dict[str, str] = {}
        self.workbook_part = self._resolve_workbook_part()
        self.workbook_xml = self._require(self.workbook_part, "workbook")
        self.styles_part = self._resolve_single(
            self.workbook_part, REL_STYLES, "styles", required=True
        )
        self.styles_xml = self._require(self.styles_part, "styles")
        self.shared_strings_part = self._resolve_single(
            self.workbook_part, REL_SHARED_STRINGS, "sharedStrings", required=False
        )
        shared_strings = self._read_shared_strings()
        self.sheets: List[Sheet] = []
        for index, (name, part) in enumerate(self._sheet_parts()):
            self.sheets.append(
                Sheet(name, index, part, self._require(part, "worksheet %r" % name),
                      shared_strings)
            )
        self._by_name = {sheet.name: sheet for sheet in self.sheets}

    # ------------------------------------------------------------- packaging

    def _rels_name(self, part: str) -> str:
        directory, _, basename = part.rpartition("/")
        return "%s_rels/%s.rels" % (directory + "/" if directory else "", basename)

    def _relationships(self, part: str) -> List[Tuple[str, str, str]]:
        """(id, type, resolved target) for every relationship `part` declares."""
        text = self._part(self._rels_name(part))
        if not text:
            return []
        found = []
        for relationship in ET.fromstring(text):
            target = relationship.get("Target") or ""
            if not target or relationship.get("TargetMode") == "External":
                continue
            if target.startswith("http:") or target.startswith("https:"):
                continue
            found.append(
                (
                    relationship.get("Id") or "",
                    relationship.get("Type") or "",
                    resolve_part(part, target),
                )
            )
        return found

    def _resolve_workbook_part(self) -> str:
        for _, relationship_type, target in self._relationships(""):
            if relationship_type == REL_OFFICE_DOCUMENT:
                return target
        raise PartResolutionError(
            "no officeDocument relationship in _rels/.rels (parts: %s)"
            % ", ".join(sorted(self.names))
        )

    def _resolve_single(
        self, part: str, relationship_type: str, label: str, required: bool
    ) -> Optional[str]:
        targets = [
            target
            for _, declared, target in self._relationships(part)
            if declared == relationship_type
        ]
        if not targets:
            if required:
                raise PartResolutionError(
                    "%s declares no %s relationship (parts: %s)"
                    % (part, label, ", ".join(sorted(self.names)))
                )
            return None
        return targets[0]

    def _require(self, part: Optional[str], label: str) -> str:
        """Read a part that MUST have content, or say which one did not."""
        if not part:
            raise PartResolutionError("%s resolved to no part at all" % label)
        text = self._part(part)
        if not text:
            raise PartResolutionError(
                "%s resolved to %r, which is absent or empty (parts: %s)"
                % (label, part, ", ".join(sorted(self.names)))
            )
        return text

    def related_parts(self, part: str, relationship_type: str) -> List[str]:
        """Every part `part` points at with `relationship_type`, declared order."""
        return [
            target
            for _, declared, target in self._relationships(part)
            if declared == relationship_type
        ]

    def _part(self, name: str) -> str:
        if name not in self._parts:
            try:
                self._parts[name] = self._zip.read(name).decode("utf-8-sig")
            except KeyError:
                self._parts[name] = ""
        return self._parts[name]

    def part(self, name: str) -> str:
        return self._part(name)

    def part_bytes(self, name: str) -> bytes:
        return self._zip.read(name)

    def has_part(self, name: str) -> bool:
        return name in self.names

    def _read_shared_strings(self) -> List[str]:
        # THE HIGHEST-CONSEQUENCE GUESS OF THE FOUR.  A shared-strings part that
        # is not found reads as zero strings, and every `t="s"` cell in the
        # workbook then decodes to None — every label, every sheet title, every
        # provenance string — with no error anywhere.  A workbook that declares
        # the relationship must therefore produce a non-empty part or fail here.
        # A workbook that declares NO sharedStrings relationship is a different
        # thing entirely and is legal: both producers write inline strings, so
        # there is nothing to read and nothing to complain about.
        if not self.shared_strings_part:
            return []
        text = self._require(self.shared_strings_part, "sharedStrings")
        root = ET.fromstring(text)
        strings = []
        for item in root:
            if _local(item.tag) != "si":
                continue
            strings.append(
                "".join(
                    node.text or ""
                    for node in item.iter()
                    if _local(node.tag) == "t"
                )
            )
        return strings

    def _sheet_parts(self) -> List[Tuple[str, str]]:
        targets = {
            rid: target
            for rid, _, target in self._relationships(self.workbook_part)
            if rid
        }
        result: List[Tuple[str, str]] = []
        root = ET.fromstring(self.workbook_xml)
        for node in root.iter():
            if _local(node.tag) != "sheet":
                continue
            name = node.get("name") or ""
            rid = None
            for key, value in node.attrib.items():
                if _local(key) == "id":
                    rid = value
            # NO `xl/worksheets/sheet%d.xml` FALLBACK.  The old one keyed on the
            # ordinal of the `<sheet>` element, which is the workbook's DISPLAY
            # order and has no defined relationship to the part numbering -- move
            # a tab and the reader silently hands back a different worksheet's
            # cells under the right name.  A `<sheet>` with no resolvable `r:id`
            # is a malformed package, and saying so is the only safe answer.
            part = targets.get(rid or "")
            if not part:
                raise PartResolutionError(
                    "sheet %r declares r:id=%r, which %s does not relate to any "
                    "part (relationships: %s)"
                    % (
                        name,
                        rid,
                        self._rels_name(self.workbook_part),
                        ", ".join(sorted(targets)) or "none",
                    )
                )
            result.append((name, part))
        return result

    # ------------------------------------------------------------- public API

    @classmethod
    def open(cls, path: str) -> "Workbook":
        return cls(path)

    @property
    def sheet_names(self) -> List[str]:
        """Replaces `workbook.inspect({kind: "sheet", include: "id,name"})`."""
        return [sheet.name for sheet in self.sheets]

    def sheet(self, name: str) -> Sheet:
        return self._by_name[name]

    def match_values(self, pattern: str, max_results: int = 1000) -> List[dict]:
        """Replaces `workbook.inspect({kind: "match", options.useRegex})`.

        Probed against legacy workbook library: `kind: "match"` searches cached cell
        VALUES only.  Searching for "IFERROR" -- present in hundreds of
        formulas -- returned "matched 0 entries", while searching for "Revenue"
        returned value hits with `"match": "value"`.  This reproduces that
        scope exactly.  See BLIND SPOTS in validate_dynamic_model.py.
        """
        compiled = re.compile(pattern)
        hits: List[dict] = []
        for sheet in self.sheets:
            for address, value in sheet.cells.items():
                if value is None or isinstance(value, bool):
                    continue
                text = value if isinstance(value, str) else repr(value)
                if compiled.search(text):
                    hits.append(
                        {"sheet": sheet.name, "address": address, "value": value}
                    )
                    if len(hits) >= max_results:
                        return hits
        return hits


# --------------------------------------------------------------------- shared
# Formula-reference helpers.  Ported one-for-one from validate_dynamic_model.mjs
# so that reference counting and closure walking behave identically.

_QUOTED_SEGMENT = re.compile(r'("(?:[^"]|"")*")')
_A1 = re.compile(r"(?<![A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)(\d+)")
_SHEET_QUALIFIED = re.compile(
    r"'(?:[^']|'')+'!\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?|"
    r"[A-Za-z_][A-Za-z0-9_.]*!\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?"
)
_SAME_SHEET = re.compile(r"(?<![A-Za-z0-9_.])\$?([A-Z]{1,3})\$?(\d+)")
_SAME_SHEET_RANGE = re.compile(
    r"(?<![A-Za-z0-9_.])\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)"
)


def shift_shared_formula(formula_text: str, base_address: str, target_address: str) -> str:
    base = _ADDRESS.match(base_address)
    target = _ADDRESS.match(target_address)
    if not base or not target:
        return formula_text
    column_delta = column_number(target.group(1)) - column_number(base.group(1))
    row_delta = int(target.group(2)) - int(base.group(2))

    def shift(match: "re.Match") -> str:
        absolute_column, column, absolute_row, row = match.groups()
        shifted_column = column if absolute_column else column_letters(
            column_number(column) + column_delta
        )
        shifted_row = int(row) if absolute_row else int(row) + row_delta
        if not shifted_column or shifted_row < 1:
            return match.group(0)
        return "%s%s%s%d" % (absolute_column, shifted_column, absolute_row, shifted_row)

    parts = _QUOTED_SEGMENT.split(formula_text)
    return "".join(
        segment if index % 2 == 1 else _A1.sub(shift, segment)
        for index, segment in enumerate(parts)
    )


def same_sheet_references(formula_text) -> List[str]:
    text = _SHEET_QUALIFIED.sub("", str(formula_text or ""))
    references: List[str] = []

    def expand(match: "re.Match") -> str:
        first_column = column_number(match.group(1))
        first_row = int(match.group(2))
        last_column = column_number(match.group(3))
        last_row = int(match.group(4))
        for column in range(min(first_column, last_column), max(first_column, last_column) + 1):
            for row in range(min(first_row, last_row), max(first_row, last_row) + 1):
                references.append("%s%s" % (column_letters(column), row))
        return " "

    without_ranges = _SAME_SHEET_RANGE.sub(expand, text)
    references.extend(
        "%s%s" % (match.group(1), match.group(2))
        for match in _SAME_SHEET.finditer(without_ranges)
    )
    return references
