#!/usr/bin/env python3
"""Plain-HTML table extraction — the filings lane's fallback source.

Some filing HTML carries NO inline XBRL: facts exist only as printed
<table> cells. This module parses such documents with the Python standard
library alone (html.parser — no new pip deps; the repo runs on locked
toolchains), turns each <table> into a rectangular cell grid honoring
colspan/rowspan, detects per-column periods from caption / preceding-heading
/ header-row context, and emits facts in the SAME shape the structured lane
(scripts/extract_inline_xbrl.py) produces, so downstream consumers need no
changes. Numeric parsing reuses broker_numeric.parse_broker_number when
importable and otherwise mirrors its exact rules (parentheses negative,
%/x suffixes, thousands separators, locale-safe decimal detection).

Classification guard: if the document contains inline-XBRL markers this is
NOT our lane — report 'ixbrl_present_use_structured_lane', exit 0 and do
not extract; the structured lane owns those bytes.

Output: {schema_version, source_sha256, fact_count, table_count,
ixbrl_present, tables[], facts[]} with each fact {concept, context_ref,
unit_ref, value, decimals, scale, sign, period {instant | start/end},
dimensions} plus a lane-specific `provenance` object (extra keys do not
affect downstream fact consumers). Facts are sorted canonically exactly
like the structured lane so artifacts stay byte-deterministic.

Known limits (documented, fail-closed): nested <table> content folds into
the enclosing cell's text; colspan/rowspan values <=0 or absurd (>MAX_SPAN)
are clamped rather than guessed; duration columns whose start cannot be
derived from printed text emit period {} with provenance
period_status='undetected' instead of fabricating a window.
"""
from __future__ import annotations

import argparse
import calendar
import datetime as dt
import hashlib
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

try:  # reuse the shared locale-safe parser when importable
    from broker_numeric import parse_broker_number as _parse_broker_number
except ImportError:  # mirror of scripts/broker_numeric.py rules
    import math
    from typing import Any

    _WRAPPER = re.compile(
        r"^\s*(?P<open>\()?\s*(?P<sign>[-+]?)\s*[$€£¥]?\s*"
        r"(?P<number>\d[\d., ]*)\s*(?P<suffix>%|[xX])?\s*(?P<close>\))?\s*$"
    )

    def _decimal_body(raw: str) -> str | None:
        compact = raw.replace(" ", "")
        if not compact or not re.fullmatch(r"\d[\d.,]*", compact):
            return None
        comma = compact.rfind(",")
        dot = compact.rfind(".")
        if comma >= 0 and dot >= 0:
            decimal = "," if comma > dot else "."
        elif comma >= 0:
            groups = compact.split(",")
            decimal = None if all(len(item) == 3 for item in groups[1:]) else ","
        elif dot >= 0:
            groups = compact.split(".")
            decimal = None if all(len(item) == 3 for item in groups[1:]) else "."
        else:
            decimal = None
        if decimal is None:
            return compact.replace(",", "").replace(".", "")
        integer, fraction = compact.rsplit(decimal, 1)
        if not fraction:
            return None
        integer = integer.replace(",", "").replace(".", "")
        return f"{integer}.{fraction}"

    def _parse_broker_number(value: Any, *, scale_percent: bool = True) -> float | None:
        if value is None or isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            number = float(value)
            return number if math.isfinite(number) else None
        match = _WRAPPER.fullmatch(str(value))
        if not match or bool(match.group("open")) != bool(match.group("close")):
            return None
        body = _decimal_body(match.group("number"))
        if body is None:
            return None
        try:
            number = float(body)
        except ValueError:
            return None
        if match.group("sign") == "-" or match.group("open"):
            number = -abs(number)
        if scale_percent and match.group("suffix") == "%":
            number /= 100.0
        return number if math.isfinite(number) else None


SCHEMA_VERSION = "html-table-facts/1.0"
INLINE_XBRL_MARKERS = (
    b"ix:nonfraction",  # identical to the structured lane's markers
    b"xbrl.org/2013/inlinexbrl",
)
GUARD_STATUS = "ixbrl_present_use_structured_lane"
MAX_SPAN = 1000
DASH_TOKENS = {"-", "—", "–"}  # hyphen / em dash / en dash placeholders
CURRENCY_BY_SYMBOL = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY"}
SCALE_EXPONENTS = {"thousands": 3, "millions": 6, "billions": 9}
COUNT_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
}
MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}

_MONTH_ALTERNATION = (
    r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
    r"jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|"
    r"dec(?:ember)?"
)
_MONTH_DAY_YEAR = re.compile(
    rf"\b(?P<mon>{_MONTH_ALTERNATION})\.?,?\s+(?P<day>\d{{1,2}})"
    rf"(?:st|nd|rd|th)?\s*,?\s+(?P<year>\d{{4}})\b",
    re.IGNORECASE,
)
_ISO_DATE = re.compile(r"\b(?P<year>\d{4})-(?P<mon>\d{2})-(?P<day>\d{2})\b")
_MONTH_YEAR = re.compile(
    rf"\b(?P<mon>{_MONTH_ALTERNATION})\.?,?\s+(?P<year>\d{{4}})\b",
    re.IGNORECASE,
)
_INSTANT_CUE = re.compile(r"\b(?:as\s+of|at)\b", re.IGNORECASE)
_DURATION_CUE = re.compile(
    r"(?:for\s+)?(?:the\s+)?(?:"
    r"(?P<count>twelve|eleven|ten|nine|eight|seven|six|five|four|three|two|one|\d{1,2})"
    r"\s+months?|(?:fiscal\s+)?years?"
    r")\s+ended\b(?P<rest>.*)",
    re.IGNORECASE | re.DOTALL,
)
_FOOTNOTE_REF = re.compile(r"\(\d+\)|\([a-z]\)|\[\d+\]", re.IGNORECASE)
_SCALE_HINT = re.compile(
    r"\b(?:in\s+)?(thousands|millions|billions)\b", re.IGNORECASE
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_inline_xbrl_bytes(raw: bytes) -> bool:
    lowered = raw.lower()
    return any(marker in lowered for marker in INLINE_XBRL_MARKERS)


def normalized_concept(label: str) -> str:
    cleaned = _FOOTNOTE_REF.sub(" ", str(label or ""))
    words = re.findall(r"[a-z0-9]+", cleaned.lower())
    return "_".join(words)[:120]


# --------------------------------------------------------------------------
# HTML parsing (stdlib html.parser only)
# --------------------------------------------------------------------------

class _TableCollector(HTMLParser):
    """Collect top-level tables as raw row/cell records.

    Text routing: caption buffer while inside <caption>, footnote buffer
    while inside <sup>/<sub>, heading buffer while inside <h1>-<h6>,
    otherwise the currently open cell of the outermost open table.
    Nested <table> tags are swallowed: their rows/cells create no separate
    entry and their text folds into the enclosing cell.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[dict] = []
        self.last_heading = ""
        self._table_depth = 0
        self._table_stack: list[dict] = []
        self._caption_parts: list[str] | None = None
        self._heading_tag = ""
        self._heading_parts: list[str] | None = None
        self._cell: dict | None = None
        self._footnote_mode = 0

    def _flush_cell(self) -> None:
        if self._cell is not None and self._table_stack:
            self._table_stack[-1]["rows"][-1].append(self._cell)
            self._cell = None

    def _flush_row(self) -> None:
        self._flush_cell()
        if self._table_stack:
            self._table_stack[-1]["rows"].append([])

    def _flush_table(self) -> None:
        if not self._table_stack:
            return
        record = self._table_stack.pop()
        rows = [row for row in record["rows"] if row]
        for row in rows:
            for cell in row:
                cell["text"] = re.sub(
                    r"\s+", " ", " ".join(cell.pop("text_parts", []))).strip()
        self.tables.append({
            "caption": re.sub(r"\s+", " ", " ".join(record["caption_parts"])).strip(),
            "preceding_heading": record["preceding_heading"],
            "rows": rows,
        })

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "table":
            if self._table_depth == 0:
                self._table_stack.append({
                    "caption_parts": [],
                    "preceding_heading": self.last_heading,
                    "rows": [[]],
                })
            self._table_depth += 1
            return
        if tag == "tr" and self._table_depth == 1:
            self._flush_row()
            return
        if tag in {"td", "th"} and self._table_depth == 1:
            self._flush_cell()
            try:
                colspan = max(1, int(attributes.get("colspan") or "1"))
                rowspan = max(1, int(attributes.get("rowspan") or "1"))
            except ValueError:
                colspan = rowspan = 1
            self._cell = {
                "text_parts": [],
                "footnotes": [],
                "colspan": min(colspan, MAX_SPAN),
                "rowspan": min(rowspan, MAX_SPAN),
                "is_header": tag == "th",
            }
            return
        if tag == "caption" and self._table_depth >= 1:
            self._caption_parts = self._table_stack[-1]["caption_parts"]
            return
        if tag in {"sup", "sub"} and self._cell is not None:
            self._footnote_mode += 1
            return
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and self._table_depth == 0:
            self._heading_tag = tag
            self._heading_parts = []

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "table":
            if self._table_depth > 1:
                self._table_depth -= 1
            else:
                self._flush_row()
                self._table_depth = 0
                self._flush_table()
            return
        if tag == "tr":
            self._flush_row()
        elif tag in {"td", "th"}:
            self._flush_cell()
        elif tag == "caption":
            self._caption_parts = None
        elif tag in {"sup", "sub"} and self._footnote_mode > 0:
            self._footnote_mode -= 1
        elif tag == self._heading_tag and self._heading_parts is not None:
            self.last_heading = re.sub(
                r"\s+", " ", " ".join(self._heading_parts)).strip()
            self._heading_tag = ""
            self._heading_parts = None

    def handle_data(self, data):
        if not data.strip():
            return
        if self._caption_parts is not None:
            self._caption_parts.append(data.strip())
        elif self._heading_parts is not None:
            self._heading_parts.append(data.strip())
        elif self._cell is not None:
            if self._footnote_mode > 0:
                self._cell["footnotes"].append(data.strip())
            else:
                self._cell["text_parts"].append(data.strip())


def parse_tables(raw_html: str) -> list[dict]:
    collector = _TableCollector()
    collector.feed(raw_html)
    collector.close()
    return collector.tables


# --------------------------------------------------------------------------
# Grid expansion (HTML table model)
# --------------------------------------------------------------------------

def expand_grid(raw_rows: list[list[dict]]) -> list[list[dict]]:
    """Place every cell honoring colspan/rowspan.

    Spanned slots receive copies of the origin cell (same text) flagged
    ``is_spanned=True`` so downstream label stitching still sees repeated
    group labels. Ragged rows are padded with empty cells.
    """
    occupied: set[tuple[int, int]] = set()
    placements: list[tuple[int, int, dict]] = []
    for r, row in enumerate(raw_rows):
        c = 0
        for cell in row:
            while (r, c) in occupied:
                c += 1
            colspan = min(max(1, int(cell.get("colspan", 1))), MAX_SPAN)
            rowspan = min(max(1, int(cell.get("rowspan", 1))), MAX_SPAN)
            for dr in range(rowspan):
                for dc in range(colspan):
                    slot = (r + dr, c + dc)
                    occupied.add(slot)
                    placements.append((slot[0], slot[1], cell))
            c += colspan
    width = max((col for _, col, _ in placements), default=-1) + 1
    height = len(raw_rows)
    annotated: list[list[dict | None]] = [[None] * width for _ in range(height)]
    ordered = sorted(placements, key=lambda item: (item[0], item[1]))
    origin_of: dict[int, tuple[int, int]] = {}
    for r, c, cell in ordered:
        key = id(cell)
        if key not in origin_of:
            origin_of[key] = (r, c)
        origin_row, origin_col = origin_of[key]
        annotated[r][c] = {
            "text": cell.get("text", ""),
            "footnote_refs": list(cell.get("footnotes", [])),
            "is_header": bool(cell.get("is_header")),
            "is_spanned": (r, c) != (origin_row, origin_col),
            "origin_row": origin_row,
            "origin_col": origin_col,
        }
    for r in range(height):
        for c in range(width):
            if annotated[r][c] is None:
                annotated[r][c] = {
                    "text": "", "footnote_refs": [], "is_header": False,
                    "is_spanned": False, "origin_row": r, "origin_col": c,
                }
    return annotated  # type: ignore[return-value]


# --------------------------------------------------------------------------
# Period detection
# --------------------------------------------------------------------------

def _date_from_text(text: str) -> tuple[int, int, int] | None:
    """Extract (year, month, day); month-year forms take the month's last day."""
    match = _ISO_DATE.search(text)
    if match:
        return (
            int(match.group("year")), int(match.group("mon")),
            int(match.group("day")),
        )
    match = _MONTH_DAY_YEAR.search(text)
    if match:
        return (
            int(match.group("year")), MONTHS[match.group("mon").lower()[:3]],
            int(match.group("day")),
        )
    match = _MONTH_YEAR.search(text)
    if match:
        year = int(match.group("year"))
        month = MONTHS[match.group("mon").lower()[:3]]
        return (year, month, calendar.monthrange(year, month)[1])
    return None


def detect_period(header_text: str) -> dict:
    """Classify one column header into {instant} or {start, end}."""
    duration = _DURATION_CUE.search(header_text)
    if duration:
        rest = duration.group("rest") or ""
        date = _date_from_text(rest)
        if date is None:
            return {}
        end_year, end_month, end_day = date
        count_token = (duration.group("count") or "").lower()
        months = COUNT_WORDS.get(count_token)
        if months is None and count_token.isdigit():
            months = int(count_token)
        if "month" in duration.group(0).lower():
            if not months:
                return {}
            total = end_year * 12 + (end_month - 1) - months
            start_year, rem = divmod(total, 12)
            start_month = rem + 1
            start_day = min(end_day, calendar.monthrange(start_year, start_month)[1])
            start = dt.date(start_year, start_month, start_day) + dt.timedelta(days=1)
            start_iso = start.isoformat()
        else:  # "(fiscal) year(s) ended <date>" spans that calendar year
            start_iso = f"{end_year:04d}-01-01"
        return {
            "start": start_iso,
            "end": f"{end_year:04d}-{end_month:02d}-{end_day:02d}",
        }
    cue = _INSTANT_CUE.search(header_text)
    probe = header_text[cue.end():] if cue else header_text
    date = _date_from_text(probe)
    if date is not None:
        year, month, day = date
        return {"instant": f"{year:04d}-{month:02d}-{day:02d}"}
    return {}


def column_periods(grid: list[list[dict]]) -> list[dict]:
    """Stitch multi-row headers per column and classify each column."""
    width = len(grid[0]) if grid else 0
    header_row_indexes = [
        r for r, row in enumerate(grid)
        if any(cell["is_header"] and not cell["is_spanned"] for cell in row)
    ]
    columns: list[dict] = []
    for c in range(width):
        parts = [
            grid[r][c]["text"]
            for r in header_row_indexes
            if grid[r][c]["text"]
        ]
        header_text = re.sub(r"\s+,", ",", " ".join(parts)).strip()
        columns.append({
            "index": c,
            "header_text": header_text,
            "period": detect_period(header_text),
        })
    return columns


# --------------------------------------------------------------------------
# Fact emission
# --------------------------------------------------------------------------

def _unit_context(text: str) -> tuple[str, int]:
    currency = ""
    for symbol, code in CURRENCY_BY_SYMBOL.items():
        if symbol in text:
            currency = code
            break
    exponent = 0
    hint = _SCALE_HINT.search(text)
    if hint:
        exponent = SCALE_EXPONENTS[hint.group(1).lower()]
    return currency, exponent


def _parse_cell_number(token: str) -> tuple[float, str | None] | None:
    """Return (value, sign) under broker_numeric rules; None if not numeric."""
    cleaned = token.replace("\xa0", " ").strip()
    if cleaned in DASH_TOKENS:
        return (0.0, None)
    value = _parse_broker_number(cleaned, scale_percent=True)
    if value is None:
        return None
    return (value, "-" if value < 0 else None)


def extract_tables_from_document(source: Path) -> dict:
    raw_html = source.read_text("utf-8", errors="replace")
    tables = parse_tables(raw_html)
    facts: list[dict] = []
    table_summaries: list[dict] = []
    for table_index, table in enumerate(tables):
        grid = expand_grid(table["rows"])
        if not grid or not grid[0]:
            continue
        header_texts = [
            cell["text"]
            for row in grid for cell in row
            if cell["is_header"] and cell["text"]
        ]
        context_text = " ".join(
            [table["caption"], table["preceding_heading"], *header_texts]
        )
        currency, unit_exponent = _unit_context(context_text)
        columns = column_periods(grid)
        table_fact_count = 0
        for r, row in enumerate(grid):
            if any(cell["is_header"] and not cell["is_spanned"] for cell in row):
                continue  # header row: never emits facts
            label_parts: list[str] = []
            label_refs: list[str] = []
            data_cells: list[tuple[int, dict]] = []
            for c, cell in enumerate(row):
                text = cell["text"]
                if not text:
                    continue
                parsed = _parse_cell_number(text)
                if parsed is None:
                    label_parts.append(text)
                    label_refs.extend(cell["footnote_refs"])
                else:
                    data_cells.append((c, cell))
            if not data_cells:
                continue
            label = re.sub(r"\s+", " ", " ".join(label_parts)).strip()
            concept = normalized_concept(label) or f"table_{table_index}_row_{r}"
            for c, cell in data_cells:
                parsed = _parse_cell_number(cell["text"])
                if parsed is None:
                    continue
                value, sign = parsed
                scaled = round(value * (10 ** unit_exponent), 6)
                period = columns[c]["period"] if c < len(columns) else {}
                facts.append({
                    "concept": concept,
                    "context_ref": "",
                    "unit_ref": currency,
                    "value": scaled,
                    "decimals": None,
                    "scale": str(unit_exponent) if unit_exponent else None,
                    "sign": sign,
                    "period": dict(period),
                    "dimensions": {},
                    "provenance": {
                        "lane": "html_table_fallback",
                        "table_index": table_index,
                        "row_label": label,
                        "label_footnote_refs": label_refs,
                        "column_index": c,
                        "printed_token": cell["text"],
                        "footnote_refs": list(cell["footnote_refs"]),
                        "period_status": "detected" if period else "undetected",
                    },
                })
                table_fact_count += 1
        table_summaries.append({
            "table_index": table_index,
            "caption": table["caption"],
            "preceding_heading": table["preceding_heading"],
            "columns": columns,
            "fact_count": table_fact_count,
        })
    facts.sort(key=lambda fact: (
        fact["concept"], fact["context_ref"],
        json.dumps(fact["period"], sort_keys=True), fact["value"],
    ))
    return {
        "schema_version": SCHEMA_VERSION,
        "source_sha256": sha256_file(source),
        "fact_count": len(facts),
        "table_count": len(table_summaries),
        "ixbrl_present": False,
        "tables": table_summaries,
        "facts": facts,
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Plain-HTML filing (no inline XBRL)")
    parser.add_argument("--out", required=True, help="Output fact-table JSON path")
    args = parser.parse_args()
    source = Path(args.source).resolve()
    raw = source.read_bytes()
    if is_inline_xbrl_bytes(raw):
        print(json.dumps({
            "status": GUARD_STATUS,
            "source_sha256": hashlib.sha256(raw).hexdigest(),
        }, sort_keys=True))
        return 0  # classification only — the structured lane extracts these
    result = extract_tables_from_document(source)
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({
        "status": "PASS" if result["fact_count"] > 0 else "EMPTY",
        "fact_count": result["fact_count"],
        "table_count": result["table_count"],
        "out": str(out),
    }, sort_keys=True))
    return 0 if result["fact_count"] > 0 else 2


if __name__ == "__main__":
    sys.exit(main())
