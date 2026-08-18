#!/usr/bin/env python3
"""Deterministically extract complete face statements from text-bearing PDFs."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any


HEADINGS = {
    "income_statement": re.compile(
        r"(?:income statements?|statements? of (?:comprehensive income|income|operations|profit or loss)|"
        r"statement of profit or loss|consolidated results)", re.I,
    ),
    "cash_flow": re.compile(r"(?:cash flow statements?|statements? of cash flows|cash flows)", re.I),
}
STRICT_HEADINGS = {
    "income_statement": re.compile(
        r"^\s*(?:consolidated\s+)?(?:income statements?|statements? of\s+"
        r"(?:comprehensive income|income|operations|profit or loss(?: and other comprehensive income)?))\s*"
        r"(?:\(unaudited\))?\s*(?:\(continued\)|continued)?\s*$",
        re.I,
    ),
    "cash_flow": re.compile(
        r"^\s*(?:consolidated\s+)?(?:cash flow statements?|statements? of cash flows?)\s*"
        r"(?:\(unaudited\))?\s*(?:\(continued\)|continued)?\s*$",
        re.I,
    ),
}
YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
FISCAL_RANGE_RE = re.compile(r"^((?:19|20)\d{2})[\u2013\u2014/-](\d{2})$")


def years_in_token(text: str) -> set[str]:
    """Years one printed token observes, including UK fiscal ranges.

    "2025" observes {2025}; "2024-25"/"2024/25"/"2024\u201325" observe
    {2024, 2025} — statutory accounts label columns by fiscal RANGE, and a
    March-2025 period is printed as 2024-25, never as a bare 2025.
    """
    token = text.strip("(),")
    if YEAR_RE.fullmatch(token):
        return {token}
    match = FISCAL_RANGE_RE.fullmatch(token)
    if match:
        start = match.group(1)
        end = start[:2] + match.group(2)
        return {start, end}
    return set()
NUMBER_RE = re.compile(
    r"^\s*(?P<open>\()?\s*(?:[$€£¥])?\s*(?P<sign>[-+])?\s*"
    r"(?P<number>(?:\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d+)?)\s*%?\s*(?P<close>\))?\s*$"
)
NOT_APPLICABLE_RE = re.compile(
    r"^(?:n/?a|n\.?m\.?|not applicable|not meaningful)$",
    re.I,
)
DECORATION_RE = re.compile(
    r"^(?:for (?:the )?(?:year|period) ended\b|financial statements?\b.*(?:annual report|form 10-k|form 20-f)\b|"
    r"annual report\b.*(?:financial statements?|form 10-k|form 20-f)\b)",
    re.I,
)
SOURCE_REFERENCE_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:[A-Z]{1,3}-\d{1,3}|notes?\s+\d+[A-Za-z]?)(?![A-Za-z0-9])",
    re.I,
)
UNIT_HEADER_RE = re.compile(
    r"^\s*(?:amounts?\s+)?(?:expressed\s+)?(?:in\s+)?"
    r"(?:(?:USD|GBP|EUR|CAD|AUD|NZD|JPY|CHF|SEK|NOK|DKK|ZAR|INR|CNY|RMB|HKD|SGD|"
    r"[$€£¥])\s*(?:in\s+)?)?"
    r"(?:units?|thousands?|millions?|billions?|000s?|m|mm|bn)"
    r"(?:\s+unless otherwise stated)?\s*$",
    re.I,
)
CONTINUED_RE = re.compile(r"\bcontinued\b", re.I)

ACCOUNTING_FRAMEWORK_PATTERNS = {
    "ifrs": [
        re.compile(
            r"(?:financial statements|accounts).{0,160}(?:prepared|drawn up|comply).{0,160}"
            r"(?:international financial reporting standards|ifrs accounting standards|"
            r"international accounting standards)",
            re.I | re.S,
        ),
        re.compile(
            r"prepared.{0,160}in accordance with.{0,160}(?:international financial reporting standards|"
            r"ifrs accounting standards|(?:uk[- ]adopted )?international accounting standards)",
            re.I | re.S,
        ),
    ],
    "us_gaap": [
        re.compile(
            r"(?:financial statements|accounts).{0,160}(?:prepared|presented).{0,160}"
            r"(?:accounting principles generally accepted in (?:the )?united states|u\.?s\.? gaap)",
            re.I | re.S,
        ),
        re.compile(
            r"prepared.{0,160}in accordance with.{0,160}"
            r"(?:accounting principles generally accepted in (?:the )?united states|u\.?s\.? gaap)",
            re.I | re.S,
        ),
    ],
}


def detect_accounting_framework(lines: list[dict[str, Any]]) -> str | None:
    """Read a preparation-basis declaration; never default from a mention."""
    text = " ".join(str(line.get("text") or "") for line in lines)
    matches = {
        framework
        for framework, patterns in ACCOUNTING_FRAMEWORK_PATTERNS.items()
        if any(pattern.search(text) for pattern in patterns)
    }
    return next(iter(matches)) if len(matches) == 1 else None


def model_statement_scope(rows: list[dict[str, Any]], section: str) -> list[dict[str, Any]]:
    """Project a face-statement capture onto the operating-model surface.

    The raw PDF remains the immutable archive.  A combined statement of
    comprehensive income, however, contains three different surfaces: the
    profit-and-loss statement, OCI, and per-share/share-count supplements.
    Only the first is an operating statement.  Profit attribution remains in
    scope because it reconciles reported net income.  This is a structural
    contract over visible section headings, not an issuer- or OCR exception.

    Cash-flow statements need no economic pruning; only a valueless Notes
    column caption is decoration rather than a filed cash-flow row.
    """
    scoped: list[dict[str, Any]] = []
    in_profit_attribution = False
    past_profit_attribution = False
    in_oci = False

    for row in rows:
        label = str(row.get("raw_label") or "").strip()
        normalised = re.sub(r"\s+", " ", label).lower().rstrip(".")
        has_values = any(value is not None for value in row.get("values", []))

        if normalised in {"note", "notes"} and not has_values:
            continue
        if section != "income_statement":
            scoped.append(row)
            continue

        if normalised.startswith("other comprehensive income"):
            in_oci = True
            in_profit_attribution = False
            continue
        if normalised == "profit attributable to":
            in_oci = False
            in_profit_attribution = True
            continue
        if normalised.startswith("total comprehensive income attributable to"):
            in_profit_attribution = False
            past_profit_attribution = True
            continue

        if in_oci or past_profit_attribution:
            continue
        if re.match(
            r"^earnings per share\b|^shares used in computing earnings per share\b|"
            r"^(?:basic|diluted) earnings per\b|^weighted average number of\b|"
            r"^diluted weighted average number of\b|^dividends? declared\b",
            normalised,
        ):
            past_profit_attribution = True
            continue
        if re.match(r"^all activities were in respect of continuing operations", normalised):
            continue
        # In a combined statement, the two numeric children immediately below
        # “Profit attributable to” are part of the P&L.  A later comprehensive
        # attribution block has already tripped the stop above.
        if in_profit_attribution or not in_oci:
            scoped.append(row)

    for ordinal, row in enumerate(scoped, start=1):
        row["ordinal"] = ordinal
    return scoped


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def hash_value(value: Any) -> str:
    # Exact equivalent of scripts/lib/run_store.mjs hashValue.
    def javascript_numbers(item: Any) -> Any:
        # JSON.stringify serialises integral finite Numbers without a decimal
        # suffix (including -0). Python's json encoder preserves ``.0``.
        if isinstance(item, float) and math.isfinite(item) and item.is_integer():
            return int(item)
        if isinstance(item, list):
            return [javascript_numbers(child) for child in item]
        if isinstance(item, dict):
            return {key: javascript_numbers(child) for key, child in item.items()}
        return item

    encoded = json.dumps(
        javascript_numbers(value), sort_keys=True, indent=2, ensure_ascii=False
    ).encode("utf-8")
    return digest(encoded)


def parse_number(text: str) -> float | None:
    if text.strip() in {"-", "—", "–", ""}:
        return None
    match = NUMBER_RE.match(text)
    if not match:
        return None
    number = float(match.group("number").replace(",", "").replace(" ", ""))
    if match.group("open") or match.group("sign") == "-":
        number = -abs(number)
    return int(number) if number.is_integer() else number


def split_source_reference_tokens(label: str) -> tuple[str, list[str]]:
    """Separate filing references from the economic label they decorate.

    Tokens such as ``F-5`` and ``Note 12`` identify source locations; they are
    not statement concepts.  Preserve their printed form for provenance while
    ensuring a reference-only line cannot be minted as an economic model row.
    The deliberately narrow grammar does not consume accounting labels such as
    ``IFRS 16 lease expense``.
    """

    tokens: list[str] = []
    for match in SOURCE_REFERENCE_TOKEN_RE.finditer(str(label or "")):
        token = re.sub(r"\s+", " ", match.group(0)).strip()
        if token and token not in tokens:
            tokens.append(token)
    cleaned = SOURCE_REFERENCE_TOKEN_RE.sub(" ", str(label or ""))
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" :;,.()[]–—-")
    return cleaned, tokens


def source_provenance_note(page: int, reference_tokens: list[str]) -> str:
    base = f"page {page}"
    if not reference_tokens:
        return base
    return f"{base}; source reference {', '.join(reference_tokens)}"


def classify_value_token(text: str) -> tuple[float | None, str] | None:
    """Preserve the source-visible state independently from its value."""

    token = text.strip()
    if token in {"-", "—", "–"}:
        return None, "reported_dash"
    if NOT_APPLICABLE_RE.fullmatch(token):
        return None, "not_applicable"
    value = parse_number(token)
    if value is None:
        return None
    return value, "reported_zero" if value == 0 else "reported_number"


def displayed_decimal_places(text: str) -> int | None:
    """Return the source-visible decimal precision of a numeric token."""

    if classify_value_token(text) is None:
        return None
    match = NUMBER_RE.match(text)
    if not match:
        return None
    number = match.group("number").replace(",", "").replace(" ", "")
    return len(number.rsplit(".", 1)[1]) if "." in number else 0


def _group_page_words(words: list[tuple[Any, ...]], page_number: int) -> list[dict[str, Any]]:
    """Recover logical statement lines from source-visible word geometry.

    Some filing generators vertically centre the three numeric cells against a
    two-line caption. Their centres can therefore sit about half a text line
    below the caption's first line. A five-point band joins that printed row
    while remaining well inside the normal statement-row pitch. The grouping
    remains geometric: no caption, value or issuer-specific wording is used.
    """

    grouped: list[list[tuple[Any, ...]]] = []
    for word in sorted(words, key=lambda item: (float(item[1]), float(item[0]))):
        centre = (float(word[1]) + float(word[3])) / 2
        group = next(
            (
                candidate for candidate in reversed(grouped[-8:])
                if abs(
                    sum((float(item[1]) + float(item[3])) / 2 for item in candidate) / len(candidate)
                    - centre
                ) <= 5.0
            ),
            None,
        )
        if group is None:
            group = []
            grouped.append(group)
        group.append(word)
    lines = []
    for line_words in grouped:
        line_words.sort(key=lambda word: float(word[0]))
        lines.append({
            "page": page_number,
            "x0": min(float(word[0]) for word in line_words),
            "x1": max(float(word[2]) for word in line_words),
            "y0": min(float(word[1]) for word in line_words),
            "y1": max(float(word[3]) for word in line_words),
            "words": [
                {
                    "x0": float(word[0]),
                    "y0": float(word[1]),
                    "x1": float(word[2]),
                    "y1": float(word[3]),
                    "text": str(word[4]),
                }
                for word in line_words
            ],
            "text": " ".join(str(word[4]) for word in line_words).strip(),
        })
    return lines


def pdf_lines(target: Path) -> list[dict[str, Any]]:
    try:
        import fitz  # type: ignore
    except Exception as error:
        raise RuntimeError(f"PyMuPDF is required for filing extraction: {error}") from error
    document = fitz.open(target)
    lines: list[dict[str, Any]] = []
    for page_index, page in enumerate(document):
        lines.extend(_group_page_words(page.get_text("words", sort=True), page_index + 1))
    document.close()
    return sorted(lines, key=lambda line: (line["page"], line["y0"], line["x0"]))


def numeric_runs(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for word in words:
        token = word["text"]
        observation = classify_value_token(token)
        if observation is not None:
            value, value_state = observation
            runs.append({
                "x0": word["x0"],
                "x1": word["x1"],
                "y0": word.get("y0"),
                "y1": word.get("y1"),
                "text": token,
                "value": value,
                "value_state": value_state,
                "value_precision": displayed_decimal_places(token),
            })
    return runs


def _page_ranges(lines: list[dict[str, Any]]) -> dict[int, tuple[int, int]]:
    ranges: dict[int, tuple[int, int]] = {}
    for index, line in enumerate(lines):
        page = int(line["page"])
        if page not in ranges:
            ranges[page] = (index, index + 1)
        else:
            ranges[page] = (ranges[page][0], index + 1)
    return ranges


def _line_years(line: dict[str, Any]) -> set[str]:
    return {
        word["text"].strip("(),")
        for word in line.get("words", [])
        if YEAR_RE.fullmatch(word["text"].strip("(),"))
    }


def _unit_header_text(text: str) -> str | None:
    normalised = re.sub(r"[()]", " ", str(text or ""))
    normalised = re.sub(r"\s+", " ", normalised).strip(" :;,.–—-")
    return normalised if UNIT_HEADER_RE.fullmatch(normalised) else None


def _is_period_header(line: dict[str, Any], periods: list[str]) -> bool:
    requested_years = {str(period)[:4] for period in periods}
    if not requested_years.issubset(_line_years(line)):
        return False
    residue = str(line.get("text") or "")
    for year in requested_years:
        residue = re.sub(rf"\b{re.escape(year)}\b", " ", residue)
    residue = re.sub(
        r"\b(?:notes?|year|years|ended|ending|for|the|period|periods|audited|unaudited|"
        r"current|prior|restated|reported|january|february|march|april|may|june|july|"
        r"august|september|october|november|december)\b",
        " ",
        residue,
        flags=re.I,
    )
    residue = re.sub(r"\b(?:[12]?\d|3[01])\b", " ", residue)
    residue = re.sub(r"[(),:;/|–—-]", " ", residue)
    residue = re.sub(r"\s+", " ", residue).strip()
    return not residue or _unit_header_text(residue) is not None


def _is_statement_header_line(
    line: dict[str, Any], periods: list[str], section: str | None = None,
) -> bool:
    text = str(line.get("text") or "").strip()
    heading_patterns = [STRICT_HEADINGS[section]] if section else list(STRICT_HEADINGS.values())
    return (
        any(pattern.fullmatch(text) for pattern in heading_patterns)
        or _is_period_header(line, periods)
        or _unit_header_text(text) is not None
    )


def _resolved_row_count(
    page_lines: list[dict[str, Any]], columns: list[float], periods: list[str], section: str,
) -> int:
    if len(columns) != 3:
        return 0
    count = 0
    for line in page_lines:
        if _is_statement_header_line(line, periods) or DECORATION_RE.search(str(line.get("text") or "")):
            continue
        runs = numeric_runs(line.get("words", []))
        if len(runs) >= 3 and len(nearest_values(runs, columns)) == 3:
            count += 1
    return count


def _continuation_page(
    previous_lines: list[dict[str, Any]], page_lines: list[dict[str, Any]],
    section: str, periods: list[str], inherited_columns: list[float],
) -> tuple[bool, list[float]]:
    """Prove that one adjacent page continues the selected face statement."""
    top = page_lines[:20]
    for line in top:
        text = str(line.get("text") or "").strip()
        for candidate_section, pattern in STRICT_HEADINGS.items():
            if candidate_section != section and pattern.fullmatch(text):
                return False, []

    def canonical_heading(text: str) -> str:
        return re.sub(
            r"\s+", " ", CONTINUED_RE.sub("", text).replace("(", " ").replace(")", " ")
        ).strip().lower()

    previous_headings = [
        str(line.get("text") or "").strip()
        for line in previous_lines
        if STRICT_HEADINGS[section].fullmatch(str(line.get("text") or "").strip())
    ]
    current_headings = [
        str(line.get("text") or "").strip()
        for line in top
        if STRICT_HEADINGS[section].fullmatch(str(line.get("text") or "").strip())
    ]
    if current_headings and previous_headings and not any(
        canonical_heading(current) == canonical_heading(previous)
        for current in current_headings
        for previous in previous_headings
    ):
        # A new face statement in the same broad section (for example a
        # statement of comprehensive income after a statement of operations)
        # is not a continuation of the selected surface.
        return False, []

    same_heading = any(
        STRICT_HEADINGS[section].fullmatch(str(line.get("text") or "").strip())
        for line in top
    )
    explicit_continuation = any(
        CONTINUED_RE.search(str(line.get("text") or ""))
        for line in [*previous_lines[-12:], *top]
    )
    page_columns = year_columns(page_lines, periods)
    resolved_columns = page_columns if len(page_columns) == 3 else inherited_columns
    resolved_rows = _resolved_row_count(page_lines, resolved_columns, periods, section)
    has_period_header = any(_is_period_header(line, periods) for line in top)
    has_unit_header = any(_unit_header_text(str(line.get("text") or "")) for line in top)

    certified = resolved_rows >= 2 and (
        same_heading or explicit_continuation or (has_period_header and has_unit_header)
    )
    return certified, resolved_columns if certified else []


def statement_window(
    lines: list[dict[str, Any]], section: str, periods: list[str],
) -> tuple[int, int] | None:
    """Select one actual face-statement surface, never the first prose mention.

    Annual reports refer to cash flows and income statements hundreds of times
    before the audited accounts.  A face statement must therefore have an
    anchored title, all three requested year columns on the opening page, and
    a meaningful three-value row surface. Adjacent pages join only through a
    positive continuation certificate; notes, governance and remuneration
    prose therefore cannot expand the statement window.
    """
    page_ranges = _page_ranges(lines)

    candidates: list[tuple[int, int, int]] = []
    requested_years = {str(period)[:4] for period in periods}
    for heading_index, line in enumerate(lines):
        if not STRICT_HEADINGS[section].fullmatch(line["text"]):
            continue
        page = int(line["page"])
        page_start, page_end = page_ranges[page]
        local = lines[heading_index:page_end]
        observed_years = {
            year
            for candidate in local[:20]
            for word in candidate["words"]
            for year in years_in_token(word["text"])
        }
        if not requested_years.issubset(observed_years):
            continue
        columns = year_columns(local, periods)
        if len(columns) != 3:
            continue
        resolved_rows = _resolved_row_count(local[1:], columns, periods, section)
        end = page_end
        previous_page_lines = lines[page_start:page_end]
        inherited_columns = columns
        next_page = page + 1
        while next_page in page_ranges:
            next_start, next_end = page_ranges[next_page]
            next_page_lines = lines[next_start:next_end]
            continued, resolved_columns = _continuation_page(
                previous_page_lines, next_page_lines, section, periods, inherited_columns,
            )
            if not continued:
                break
            resolved_rows += _resolved_row_count(
                next_page_lines, resolved_columns, periods, section,
            )
            end = next_end
            previous_page_lines = next_page_lines
            inherited_columns = resolved_columns
            next_page += 1
        if resolved_rows < 5:
            continue
        # Exact title + complete period surface dominates; row count breaks
        # ties when an issuer repeats a face statement elsewhere in the file.
        candidates.append((1000 + resolved_rows, heading_index, end))
    if not candidates:
        return None
    _, start, end = max(candidates, key=lambda item: (item[0], item[1]))
    return start, end


def year_columns(window: list[dict[str, Any]], periods: list[str]) -> list[float]:
    years = [str(period)[:4] for period in periods]
    observed: dict[str, list[float]] = {year: [] for year in years}
    for line in window[:20]:
        for word in line["words"]:
            token_years = years_in_token(word["text"])
            for year in years:
                if year in token_years:
                    observed[year].append((word["x0"] + word["x1"]) / 2)
    columns = [sum(observed[year]) / len(observed[year]) if observed[year] else math.nan for year in years]
    if all(math.isfinite(value) for value in columns):
        return columns
    all_years = sorted({
        ((word["x0"] + word["x1"]) / 2, word["text"].strip("(),"))
        for line in window[:20]
        for word in line["words"]
        if YEAR_RE.fullmatch(word["text"].strip("(),"))
    })
    if len(all_years) >= 3:
        return [entry[0] for entry in all_years[-3:]]
    return []


def nearest_values(runs: list[dict[str, Any]], columns: list[float]) -> list[float | None]:
    return nearest_observations(runs, columns)[0]


def nearest_observations(
    runs: list[dict[str, Any]],
    columns: list[float],
    *,
    missing_state: str = "reported_blank",
) -> tuple[list[float | None], list[str]]:
    values, states, _ = nearest_typed_observations(
        runs,
        columns,
        missing_state=missing_state,
    )
    return values, states


def nearest_typed_observations(
    runs: list[dict[str, Any]],
    columns: list[float],
    *,
    missing_state: str = "reported_blank",
) -> tuple[list[float | None], list[str], list[int | None]]:
    if len(columns) != 3:
        return [], [], []
    assigned: list[float | None] = [None, None, None]
    states = [missing_state, missing_state, missing_state]
    precisions: list[int | None] = [None, None, None]
    distances: list[float] = [float("inf")] * 3
    for run in runs:
        centre = (run["x0"] + run["x1"]) / 2
        index = min(range(3), key=lambda candidate: abs(columns[candidate] - centre))
        distance = abs(columns[index] - centre)
        if distance < distances[index]:
            assigned[index] = run["value"]
            states[index] = run["value_state"]
            precisions[index] = run.get("value_precision")
            distances[index] = distance
    return assigned, states, precisions


def nearest_custodied_observations(
    runs: list[dict[str, Any]],
    columns: list[float],
    *,
    line: dict[str, Any],
    periods: list[str],
    reporting_currency: str,
    units: str,
    missing_state: str = "reported_blank",
) -> tuple[list[float | None], list[str], list[int | None], list[dict[str, Any]]]:
    """Bind every period cell to its exact printed token and source geometry."""

    values, states, precisions = nearest_typed_observations(
        runs,
        columns,
        missing_state=missing_state,
    )
    if len(values) != 3:
        return values, states, precisions, []
    assigned_runs: list[dict[str, Any] | None] = [None, None, None]
    distances = [float("inf")] * 3
    for run in runs:
        centre = (run["x0"] + run["x1"]) / 2
        index = min(range(3), key=lambda candidate: abs(columns[candidate] - centre))
        distance = abs(columns[index] - centre)
        if distance < distances[index]:
            assigned_runs[index] = run
            distances[index] = distance

    page = int(line["page"])
    line_y0 = float(line.get("y0") or 0)
    line_y1 = float(line.get("y1") or line_y0)
    cells = []
    for index, run in enumerate(assigned_runs):
        inferred = run is None
        x0 = float(run["x0"]) if run else float(columns[index])
        x1 = float(run["x1"]) if run else float(columns[index])
        y0 = float(run.get("y0") if run and run.get("y0") is not None else line_y0)
        y1 = float(run.get("y1") if run and run.get("y1") is not None else line_y1)
        cells.append({
            "raw_text": str(run["text"]) if run else "",
            "source_page": page,
            "source_coordinates": {
                "coordinate_system": "pdf_points_top_left",
                "x0": x0,
                "y0": y0,
                "x1": x1,
                "y1": y1,
                "inferred_blank_position": inferred,
            },
            "confidence": 1.0 if run is not None or states[index] == "reported_blank" else 0.0,
            "typed_state": states[index],
            "currency": reporting_currency,
            "units": units,
            "period": periods[index],
            "normalized_value": values[index],
        })
    return values, states, precisions, cells


def _merge_wrapped_caption_lines(
    lines: list[dict[str, Any]], columns_by_page: dict[int, list[float]],
) -> list[dict[str, Any]]:
    """Join a lower-case caption continuation that owns the period values."""

    merged: list[dict[str, Any]] = []
    index = 0
    while index < len(lines):
        current = lines[index]
        if index + 1 >= len(lines):
            merged.append(current)
            break
        following = lines[index + 1]
        page = int(current.get("page") or 0)
        columns = columns_by_page.get(page, [])
        if page != int(following.get("page") or -1) or len(columns) != 3:
            merged.append(current)
            index += 1
            continue
        data_left = min(columns) - 20
        current_runs = [
            run for run in numeric_runs(current.get("words", [])) if run["x1"] >= data_left
        ]
        following_runs = [
            run for run in numeric_runs(following.get("words", [])) if run["x1"] >= data_left
        ]
        current_label_words = [
            word for word in current.get("words", [])
            if word["x0"] < data_left and parse_number(word["text"]) is None
        ]
        following_label_words = [
            word for word in following.get("words", [])
            if word["x0"] < data_left and parse_number(word["text"]) is None
        ]
        following_label = " ".join(word["text"] for word in following_label_words).strip()
        vertical_gap = float(following.get("y0") or 0) - float(current.get("y0") or 0)
        join = (
            not current_runs
            and len(following_runs) >= 3
            and bool(current_label_words)
            and bool(re.match(r"^[a-z]", following_label))
            and 0 < vertical_gap <= 16
            and abs(float(current.get("x0") or 0) - float(following.get("x0") or 0)) <= 12
        )
        if not join:
            merged.append(current)
            index += 1
            continue
        numeric_words = [
            word for word in following.get("words", []) if word["x0"] >= data_left
        ]
        combined_words = [*current_label_words, *following_label_words, *numeric_words]
        merged.append({
            **current,
            "x0": min(float(word["x0"]) for word in combined_words),
            "x1": max(float(word["x1"]) for word in combined_words),
            "words": combined_words,
            "text": " ".join(str(word["text"]) for word in combined_words).strip(),
        })
        index += 2
    return merged


def infer_structural_roles(rows: list[dict[str, Any]]) -> None:
    """Stamp a heading only from positive hierarchy evidence.

    A row without resolved numerics is not thereby a heading.  It becomes one
    only when the source geometry places at least one subsequent row beneath
    it before the next same-or-higher-level boundary.  Everything else remains
    a body row, including unresolved, dash-only and N/A-only observations.
    """

    explicit_body_states = {
        "reported_number",
        "reported_zero",
        "reported_dash",
        "not_applicable",
    }
    for index, row in enumerate(rows):
        states = row.get("value_states") or []
        if any(state in explicit_body_states for state in states):
            row["structural_role"] = "body"
            continue
        level = int(row.get("hierarchy_level") or 0)
        owns_indented_child = False
        for candidate in rows[index + 1 :]:
            candidate_level = int(candidate.get("hierarchy_level") or 0)
            if candidate_level <= level:
                break
            owns_indented_child = True
            break
        row["structural_role"] = "header" if owns_indented_child else "body"
        if owns_indented_child:
            row["value_states"] = [
                "reported_blank" if state == "unresolved" else state
                for state in states
            ]


def _finite_series(row: dict[str, Any]) -> list[float] | None:
    values = row.get("values")
    if not isinstance(values, list) or len(values) != 3:
        return None
    result: list[float] = []
    states = row.get("value_states")
    for index, value in enumerate(values):
        if isinstance(states, list) and len(states) == 3:
            state = states[index]
            if state not in {"reported_number", "reported_zero"}:
                return None
        if value is None or isinstance(value, bool):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(number):
            return None
        result.append(number)
    return result


def _typed_partial_series(row: dict[str, Any]) -> list[float | None] | None:
    """Return typed numerics while preserving dash/blank/N/A as unknown."""

    values = row.get("values")
    states = row.get("value_states")
    if not isinstance(values, list) or len(values) != 3:
        return None
    result: list[float | None] = []
    for index, value in enumerate(values):
        state = states[index] if isinstance(states, list) and len(states) == 3 else None
        if state not in {"reported_number", "reported_zero"}:
            result.append(None)
            continue
        if value is None or isinstance(value, bool):
            result.append(None)
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            result.append(None)
            continue
        result.append(number if math.isfinite(number) else None)
    return result if any(value is not None for value in result) else None


def _explicit_zero_series(row: dict[str, Any]) -> bool:
    series = _finite_series(row)
    if series is None or any(value != 0 for value in series):
        return False
    states = row.get("value_states")
    return not isinstance(states, list) or states == ["reported_zero"] * 3


def _display_precision(row: dict[str, Any], index: int) -> int:
    precisions = row.get("value_precisions")
    if (
        isinstance(precisions, list)
        and len(precisions) == 3
        and isinstance(precisions[index], int)
        and not isinstance(precisions[index], bool)
        and precisions[index] >= 0
    ):
        return precisions[index]
    value = row.get("values", [None, None, None])[index]
    text = str(value)
    return len(text.rsplit(".", 1)[1]) if "." in text else 0


def _source_tolerance(row: dict[str, Any], index: int) -> float:
    return 0.5 * (10 ** -_display_precision(row, index)) + 1e-12


def _declared_dimension(row: dict[str, Any], *names: str) -> str | None:
    for name in names:
        value = row.get(name)
        if value is not None and str(value).strip():
            return str(value).strip().lower()
    return None


def _arithmetic_dimensions_compatible(
    parent_row: dict[str, Any], child_rows: list[dict[str, Any]],
) -> bool:
    """Require one additive economic dimension before numeric coincidence counts.

    Older face manifests do not carry row dimensions, so absent dimensions stay
    backwards compatible. Once any row declares a dimension, every declaration
    in the family must agree. Percentages, rates and presentation counts are not
    additive statement amounts unless the source explicitly marks them additive.
    """

    family = [parent_row, *child_rows]
    dimension_specs = (
        ("currency", ("reporting_currency", "currency")),
        ("scale", ("scale", "units", "unit_scale")),
        ("sign", ("sign_convention", "source_sign_convention")),
    )
    for _label, names in dimension_specs:
        declared = {
            value for row in family
            if (value := _declared_dimension(row, *names)) is not None
        }
        if len(declared) > 1:
            return False

    unit_classes = {
        value for row in family
        if (value := _declared_dimension(
            row, "unit_class", "numeric_type", "number_format",
        )) is not None
    }
    if len(unit_classes) > 1:
        return False
    if unit_classes & {"percentage", "percent", "rate", "ratio", "count"}:
        return all(row.get("arithmetic_additive") is True for row in family)
    return True


def _series_sum_matches(parent_row: dict[str, Any], child_rows: list[dict[str, Any]]) -> bool:
    if not _arithmetic_dimensions_compatible(parent_row, child_rows):
        return False
    parent = _finite_series(parent_row)
    children = [_finite_series(row) for row in child_rows]
    if parent is None or len(children) < 2 or any(series is None for series in children):
        return False
    calculated = [
        sum(series[index] for series in children if series is not None)
        for index in range(3)
    ]
    # The printed parent owns the equality claim. Its per-period last displayed
    # digit therefore owns the rounding band, in the manifest's declared units.
    # Missing/dash/N/A cells never enter this lane as numeric zero.
    return all(
        math.isclose(
            calculated[index],
            parent[index],
            rel_tol=0.0,
            abs_tol=_source_tolerance(parent_row, index),
        )
        for index in range(3)
    )


def _partial_series_sum_matches(
    parent_row: dict[str, Any], child_rows: list[dict[str, Any]],
) -> bool:
    """Prove a subtotal on every period whose children are all reported.

    A dash or blank remains unknown and is never turned into zero. Two exact
    fully observed periods, a printed subtotal, source adjacency and the same
    statement surface are required before a partial comparative can join the
    family. The later face-additivity check deliberately skips the incomplete
    period while preserving its typed source state.
    """

    if not _arithmetic_dimensions_compatible(parent_row, child_rows):
        return False
    parent = _finite_series(parent_row)
    children = [_typed_partial_series(row) for row in child_rows]
    if parent is None or len(children) < 2 or any(series is None for series in children):
        return False
    proved_periods = 0
    for period in range(3):
        if any(series[period] is None for series in children if series is not None):
            continue
        calculated = sum(series[period] for series in children if series is not None)
        if not math.isclose(
            calculated,
            parent[period],
            rel_tol=0.0,
            abs_tol=_source_tolerance(parent_row, period),
        ):
            return False
        proved_periods += 1
    return proved_periods >= 2


def infer_source_arithmetic_links(rows: list[dict[str, Any]]) -> None:
    """Bind unique source-visible arithmetic independent of issuer wording.

    Geometry supplies candidate families and all three historical values prove
    the edge. Both total-last and total-first filing shapes are supported. A
    relationship is materialised only when one candidate family matches; an
    ambiguous equality remains unowned rather than guessed.
    """
    matches: dict[int, list[list[int]]] = {}
    for parent_index, parent_row in enumerate(rows):
        parent_values = _finite_series(parent_row)
        if parent_values is None:
            continue
        parent_level = int(parent_row.get("hierarchy_level") or 0)
        families: list[list[int]] = []
        for direction in (-1, 1):
            indexes: list[int] = []
            cursor = parent_index + direction
            while 0 <= cursor < len(rows):
                candidate = rows[cursor]
                level = int(candidate.get("hierarchy_level") or 0)
                if level <= parent_level:
                    # A same-level, non-subtotal line that is numerically zero
                    # in every reported period is an arithmetically neutral
                    # separator, not proof that a visible subtotal family ended.
                    # Skip it only inside the three-period arithmetic search; it
                    # is never promoted to a child and caption fallback remains
                    # conservative. This covers filing surfaces that print a
                    # zero net-finance/result line between operating cash-flow
                    # components while preserving the issuer's proved subtotal.
                    neutral_separator = (
                        level <= parent_level
                        and not candidate.get("is_subtotal")
                        and _explicit_zero_series(candidate)
                    )
                    if neutral_separator:
                        cursor += direction
                        continue
                    break
                if level == parent_level + 1 and _finite_series(candidate) is not None:
                    indexes.append(cursor)
                cursor += direction
            if direction < 0:
                indexes.reverse()
            for start in range(len(indexes)):
                for end in range(start + 2, len(indexes) + 1):
                    family = indexes[start:end]
                    child_rows = [rows[index] for index in family]
                    if _series_sum_matches(parent_row, child_rows):
                        families.append(family)
        # Zero-valued child rows cannot distinguish two otherwise identical
        # arithmetic families. Canonicalise matches over informative children
        # only: geometry can still attach an adjacent zero child in the caption
        # pass, while the arithmetic proof owns the non-zero family. This avoids
        # treating [A, B, C] and [A, B, C, zero_row] as contradictory proofs.
        unique = []
        seen = set()
        for family in families:
            informative = []
            for index in family:
                if _explicit_zero_series(rows[index]):
                    continue
                informative.append(index)
            key = tuple(informative)
            # One informative nested subtotal plus explicit printed zero rows
            # is still a rival source family. Retaining it as an ambiguity
            # witness prevents an arithmetically equivalent EBITDA bridge from
            # being mistaken for the pre-tax hierarchy; caption geometry then
            # selects the nearer printed subtotal boundary.
            nested_subtotal_witness = any(
                rows[index].get("is_subtotal") for index in family
            )
            if len(key) < 2 and not (len(key) == 1 and nested_subtotal_witness):
                continue
            if key not in seen:
                seen.add(key); unique.append(informative)
        if len(unique) == 1:
            matches[parent_index] = unique

    # Many US-GAAP faces align every caption at the same x-coordinate, so the
    # PDF carries no indentation signal. For a visibly printed subtotal only,
    # test suffixes of the preceding numeric surface. Exact equality in all
    # available periods supplies the missing structure. Blank narrative lines
    # are ignored; partial rows retain their unknown state and need two other
    # complete comparative periods to prove membership.
    for parent_index, parent_row in enumerate(rows):
        if (
            parent_index in matches
            or not parent_row.get("is_subtotal")
        ):
            continue
        candidates = [
            index
            for index in range(max(0, parent_index - 64), parent_index)
            if (
                _typed_partial_series(rows[index]) is not None
                and int(rows[index].get("hierarchy_level") or 0)
                == int(parent_row.get("hierarchy_level") or 0)
            )
        ]
        families: list[list[int]] = []
        for start in range(len(candidates) - 1):
            family = candidates[start:]
            # A flat face may legitimately carry one nested subtotal into a
            # larger total (for example operating profit into pre-tax income).
            # Two or more prior subtotals are an arithmetic bridge, not a
            # single parent family: EBITDA plus D&A can coincidentally equal
            # operating profit or pre-tax income and must not mint hierarchy.
            if sum(bool(rows[index].get("is_subtotal")) for index in family) > 1:
                continue
            if _partial_series_sum_matches(parent_row, [rows[index] for index in family]):
                families.append(family)
        unique = []
        seen = set()
        for family in families:
            key = tuple(family)
            if key not in seen:
                seen.add(key)
                unique.append(family)
        if len(unique) == 1:
            matches[parent_index] = unique

    claimed_children: set[int] = set()
    for parent_index, families in matches.items():
        family = families[0]
        if any(index in claimed_children for index in family):
            continue
        parent_id = rows[parent_index]["source_line_id"]
        rows[parent_index]["is_subtotal"] = True
        for index in family:
            if not rows[index].get("parent_source_line_id"):
                rows[index]["parent_source_line_id"] = parent_id
                claimed_children.add(index)

def is_subtotal_label(label: str) -> bool:
    """Recognise visible accounting totals without relying on issuer wording alone.

    Geometry remains the primary hierarchy evidence.  This predicate is used
    only to decide which lower-indented rows may own preceding children; it
    does not classify the row's economic role.
    """
    if re.search(r"(?:margin|rate|per share|reconciliation|conversion)\s*%?$", label, re.I):
        return False
    return bool(re.search(
        r"^(?:total\b|gross (?:profit|loss)\b|adjusted ebitda\b|ebitda\b|ebit\b|"
        r"operating (?:profit|income|loss)\b|profit (?:before|after|for)\b|"
        r"income before\b|net (?:income|profit|loss|cash)\b|"
        r"net (?:increase|decrease|change)\b|"
        r"cash (?:generated|from|used)\b|closing\b|ending\b)",
        label,
        re.I,
    ))


def infer_parent_links(rows: list[dict[str, Any]]) -> None:
    """Bind source arithmetic first, then use captions only as fallback.

    Arithmetic ownership is issuer-language independent.  The legacy caption
    walk is retained only for rows that remain unowned after structural proof.
    """
    infer_source_arithmetic_links(rows)
    arithmetic_parents = {
        row["parent_source_line_id"]
        for row in rows
        if row.get("parent_source_line_id")
    }

    """Bind indented face rows to the next visible subtotal one level above.

    Face statements normally print components before their total.  Walking
    backwards gives each component the nearest later subtotal at exactly one
    lower indentation level.  Requiring both the geometry step and a subtotal
    surface avoids attaching rows to an intervening ratio or narrative line.
    Nested totals work naturally (for example PBT -> CFO bridge -> CFO).
    """
    next_subtotal_by_level: dict[int, str] = {}
    for row in reversed(rows):
        level = int(row.get("hierarchy_level") or 0)
        if level > 0 and not row.get("parent_source_line_id"):
            parent = next_subtotal_by_level.get(level - 1)
            if parent and parent not in arithmetic_parents:
                row["parent_source_line_id"] = parent
        # A row only becomes a hierarchy owner when the source surface says it
        # is a total.  Unknown labels are preserved but do not invent families.
        if row.get("is_subtotal"):
            # A nearer printed subtotal is a source-visible boundary even when
            # PDF geometry places its caption at an unexpectedly deeper x
            # coordinate. Do not let an older shallower subtotal reach back
            # across that boundary and claim the preceding components. Exact
            # three-period arithmetic may still establish the nearer family;
            # otherwise the relationship remains deliberately unowned.
            for candidate_level in list(next_subtotal_by_level):
                if candidate_level < level:
                    next_subtotal_by_level.pop(candidate_level, None)
            next_subtotal_by_level[level] = row["source_line_id"]
            for candidate_level in list(next_subtotal_by_level):
                if candidate_level > level:
                    next_subtotal_by_level.pop(candidate_level, None)
        else:
            # A same- or shallower-level valued non-total is a structural
            # boundary. A valueless ratio/helper row (for example an EBITDA
            # margin header) is not part of the filed arithmetic surface and
            # must not sever an otherwise visible component -> subtotal edge.
            # Keep general valueless headings fail-closed; only the ratio/helper
            # vocabulary already excluded from subtotal ownership is transparent.
            transparent_helper = (
                _finite_series(row) is None
                and re.search(
                    r"(?:margin|rate|per share|reconciliation)\s*%?$",
                    str(row.get("raw_label") or ""),
                    re.I,
                )
            )
            if not transparent_helper:
                for candidate_level in list(next_subtotal_by_level):
                    if candidate_level >= level:
                        next_subtotal_by_level.pop(candidate_level, None)


def extract_statement(
    lines: list[dict[str, Any]], section: str, source_id: str,
    raw_sha256: str, periods: list[str], used_ids: set[str],
    reporting_currency: str | None = None, units: str | None = None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    if not re.fullmatch(r"[A-Z]{3}", str(reporting_currency or "")):
        return None, [{
            "code": "REPORTING_CURRENCY_UNRESOLVED",
            "section": section,
        }]
    if units not in {"units", "thousands", "millions"}:
        return None, [{
            "code": "REPORTING_UNITS_UNRESOLVED",
            "section": section,
        }]
    bounds = statement_window(lines, section, periods)
    if not bounds:
        return None, [{"code": "HEADING_NOT_FOUND", "section": section}]
    start, end = bounds
    window = lines[start:end]
    columns = year_columns(window, periods)
    findings: list[dict[str, Any]] = []
    if len(columns) != 3:
        return None, [{"code": "PERIOD_COLUMNS_UNRESOLVED", "section": section, "page": window[0]["page"]}]
    source_pages = list(dict.fromkeys(int(line["page"]) for line in window))
    page_lines = {
        page: [line for line in window if int(line["page"]) == page]
        for page in source_pages
    }
    columns_by_page: dict[int, list[float]] = {}
    inherited_columns = columns
    for page in source_pages:
        local_columns = year_columns(page_lines[page], periods)
        if len(local_columns) == 3:
            inherited_columns = local_columns
        columns_by_page[page] = inherited_columns
    window = _merge_wrapped_caption_lines(window, columns_by_page)
    source_unit_labels = list(dict.fromkeys(
        unit_label
        for line in window
        if (unit_label := _unit_header_text(str(line.get("text") or ""))) is not None
    ))
    rows = []
    pending_reference_tokens: list[str] = []
    base_x_by_page = {
        page: min(
            (
                line["x0"] for line in page_lines[page]
                if line["text"] and not _is_statement_header_line(line, periods)
            ),
            default=0,
        )
        for page in source_pages
    }
    for line in window[1:]:
        if not line["text"] or _is_statement_header_line(line, periods):
            continue
        if DECORATION_RE.search(line["text"]):
            continue
        # Only the three period columns are values.  A leading dash is often a
        # list bullet and the separate Notes column is not a historical value.
        # Neither may truncate or contaminate the issuer's printed label.
        line_page = int(line["page"])
        line_columns = columns_by_page[line_page]
        data_left = min(line_columns) - 20
        runs = [run for run in numeric_runs(line["words"]) if run["x1"] >= data_left]
        label_words = [
            word["text"]
            for word in line["words"]
            if word["x0"] < data_left and parse_number(word["text"]) is None
        ]
        label = " ".join(label_words).strip(" :–—-")
        label, reference_tokens = split_source_reference_tokens(label)
        if reference_tokens and not label:
            # A standalone source marker belongs to the adjacent statement
            # evidence, never to the economic row inventory. Prefer the prior
            # row on the same reading surface; otherwise carry it to the next
            # economic row.
            if rows:
                prior_tokens = [
                    token
                    for token in reference_tokens
                    if token not in rows[-1]["page_or_note"]
                ]
                if prior_tokens:
                    rows[-1]["page_or_note"] += (
                        f"; source reference {', '.join(prior_tokens)}"
                    )
            else:
                pending_reference_tokens.extend(
                    token
                    for token in reference_tokens
                    if token not in pending_reference_tokens
                )
            continue
        if not label or HEADINGS[section].search(label):
            continue
        if DECORATION_RE.search(label):
            continue
        values, value_states, value_precisions, cells = nearest_custodied_observations(
            runs,
            line_columns,
            line=line,
            periods=periods,
            reporting_currency=reporting_currency,
            units=units,
            missing_state="reported_blank" if runs else "unresolved",
        )
        if len(values) != 3:
            findings.append({"code": "ROW_VALUES_UNRESOLVED", "section": section, "page": line["page"], "label": label})
            continue
        if not runs and re.search(r"(?:continued|unaudited|year ended|in millions|£m|\$m|€m)", label, re.I):
            continue
        if runs and len(runs) < 3:
            findings.append({
                "code": "PARTIAL_STATEMENT_ROW",
                "section": section,
                "page": line["page"],
                "label": label,
                "captured_value_count": len(runs),
            })
        slug = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "line"
        section_prefix = "is" if section == "income_statement" else "cf"
        source_line_id = f"{section_prefix}.{slug}"
        suffix = 2
        while source_line_id in used_ids:
            source_line_id = f"{section_prefix}.{slug}_{suffix}"
            suffix += 1
        used_ids.add(source_line_id)
        hierarchy = max(0, min(8, round((line["x0"] - base_x_by_page[line_page]) / 12)))
        provenance_tokens = [
            *pending_reference_tokens,
            *(
                token
                for token in reference_tokens
                if token not in pending_reference_tokens
            ),
        ]
        pending_reference_tokens = []
        rows.append({
            "source_line_id": source_line_id,
            "ordinal": len(rows) + 1,
            "raw_label": label,
            "values": values,
            "value_states": value_states,
            "value_precisions": value_precisions,
            "cells": cells,
            "page_or_note": source_provenance_note(
                int(line["page"]), provenance_tokens
            ),
            "material": any(value not in {None, 0} for value in values),
            "hierarchy_level": hierarchy,
            "is_subtotal": is_subtotal_label(label),
        })
    infer_structural_roles(rows)
    for row in rows:
        for index, cell in enumerate(row.get("cells") or []):
            cell["typed_state"] = row["value_states"][index]
            cell["normalized_value"] = row["values"][index]
            if cell["typed_state"] == "reported_blank":
                cell["confidence"] = 1.0
    rows = model_statement_scope(rows, section)
    if not rows:
        return None, findings + [{"code": "NO_STATEMENT_ROWS", "section": section}]
    infer_parent_links(rows)
    manifest = {
        "schema_version": "face-statement-manifest/1.3",
        "statement": section,
        "statement_order": 1,
        "source_id": source_id,
        "document_sha256": raw_sha256,
        "page_or_note": (
            f"pages {source_pages[0]}-{source_pages[-1]}"
            if len(source_pages) > 1 else f"page {source_pages[0]}"
        ),
        "periods": periods,
        "complete_face_statement": True,
        "source_pages": source_pages,
        **({"reporting_currency": reporting_currency} if reporting_currency else {}),
        **({"units": units} if units else {}),
        "source_unit_labels": source_unit_labels,
        "row_count": len(rows),
        "rows_sha256": "0" * 64,
        "rows": rows,
    }
    # Mirrors the JavaScript faceStatementManifestDigest projection.
    projected = {
        "schema_version": manifest["schema_version"],
        "statement": manifest["statement"],
        "statement_order": manifest["statement_order"],
        "source_id": manifest["source_id"],
        "document_sha256": manifest["document_sha256"],
        "page_or_note": manifest["page_or_note"],
        "periods": manifest["periods"],
        "complete_face_statement": manifest["complete_face_statement"],
        "source_pages": manifest["source_pages"],
        **({"reporting_currency": manifest["reporting_currency"]} if "reporting_currency" in manifest else {}),
        **({"units": manifest["units"]} if "units" in manifest else {}),
        "source_unit_labels": manifest["source_unit_labels"],
        "rows": [{
            "source_line_id": row["source_line_id"],
            "ordinal": row["ordinal"],
            "raw_label": row["raw_label"],
            "values": row["values"],
            "value_states": row["value_states"],
            "value_precisions": row["value_precisions"],
            "cells": row["cells"],
            "structural_role": row["structural_role"],
            "page_or_note": row["page_or_note"],
            "material": row["material"],
            "parent_source_line_id": row.get("parent_source_line_id"),
            "hierarchy_level": row.get("hierarchy_level"),
            "is_subtotal": row.get("is_subtotal"),
        } for row in rows],
    }
    manifest["rows_sha256"] = hash_value(projected)
    return manifest, findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    request_path = Path(args.request).resolve()
    request = json.loads(request_path.read_text("utf-8"))
    base = request_path.parent
    documents = []
    findings = []
    used_ids: set[str] = set()
    selected = {section: False for section in HEADINGS}
    detected_frameworks: set[str] = set()
    for declaration in request["documents"]:
        target = Path(declaration["path"])
        if not target.is_absolute():
            target = (base / target).resolve()
        raw_sha256 = digest(target.read_bytes())
        document_manifests = {section: [] for section in HEADINGS}
        disposition = "reviewed_supplemental"
        if target.suffix.lower() == ".pdf":
            lines = pdf_lines(target)
            detected_framework = detect_accounting_framework(lines)
            if detected_framework:
                detected_frameworks.add(detected_framework)
            for section in HEADINGS:
                if selected[section]:
                    continue
                manifest, section_findings = extract_statement(
                    lines, section, declaration["source_id"], raw_sha256,
                    request["filing_facts"]["historical_periods"], used_ids,
                    request["filing_facts"].get("reporting_currency"),
                    request["filing_facts"].get("units"),
                )
                findings.extend({"document_id": declaration["document_id"], **item} for item in section_findings)
                if manifest:
                    document_manifests[section].append(manifest)
                    selected[section] = True
                    disposition = "selected_face_statement_authority"
        else:
            findings.append({
                "document_id": declaration["document_id"],
                "code": "NATIVE_FORMAT_UNSUPPORTED",
                "format": target.suffix.lower(),
            })
        documents.append({
            "document_id": declaration["document_id"],
            "attachment_id": declaration["attachment_id"],
            "source_id": declaration["source_id"],
            "raw_sha256": raw_sha256,
            "disposition": disposition,
            "review_reason": (
                "Native geometry-aware extraction selected complete face statements."
                if disposition == "selected_face_statement_authority"
                else "Reviewed by native extraction; no selected face statement was found in this document."
            ),
            "face_statement_manifests": document_manifests,
        })
    for section, found in selected.items():
        if not found:
            findings.append({"code": "SELECTED_AUTHORITY_MISSING", "section": section})
    filing_facts = dict(request["filing_facts"])
    if "accounting_framework" not in filing_facts and len(detected_frameworks) == 1:
        filing_facts["accounting_framework"] = next(iter(detected_frameworks))
    response = {
        "schema_version": "filings-extraction-response/1.0",
        "run_id": request["run_id"],
        "documents": documents,
        "filing_facts": filing_facts,
    }
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    response_path = output / "filings-extraction-response.json"
    response_path.write_bytes(canonical(response))
    receipt = {
        "schema_version": "filings-native-extraction-receipt/1.0",
        "status": "PASS" if not findings else "NEEDS_REVIEW",
        "request_sha256": digest(request_path.read_bytes()),
        "response_sha256": digest(response_path.read_bytes()),
        "document_count": len(documents),
        "findings": findings,
    }
    (output / "filings-native-extraction-receipt.json").write_bytes(canonical(receipt))
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
