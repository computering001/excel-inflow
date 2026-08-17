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
        r"(?:income statement|statement of (?:comprehensive income|income|operations|profit or loss)|"
        r"statement of profit or loss|consolidated results)", re.I,
    ),
    "cash_flow": re.compile(r"(?:cash flow statement|statement of cash flows|cash flows)", re.I),
}
STRICT_HEADINGS = {
    "income_statement": re.compile(
        r"^\s*(?:consolidated\s+)?(?:income statement|statement of\s+"
        r"(?:comprehensive income|income|operations|profit or loss(?: and other comprehensive income)?))\s*"
        r"(?:\(continued\)|continued)?\s*$",
        re.I,
    ),
    "cash_flow": re.compile(
        r"^\s*(?:consolidated\s+)?(?:cash flow statement|statement of cash flows?)\s*"
        r"(?:\(continued\)|continued)?\s*$",
        re.I,
    ),
}
YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
NUMBER_RE = re.compile(
    r"^\s*(?P<open>\()?\s*(?:[$€£¥])?\s*(?P<sign>[-+])?\s*"
    r"(?P<number>(?:\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d+)?)\s*%?\s*(?P<close>\))?\s*$"
)
DECORATION_RE = re.compile(
    r"^(?:for (?:the )?(?:year|period) ended\b|financial statements?\b.*(?:annual report|form 10-k|form 20-f)\b|"
    r"annual report\b.*(?:financial statements?|form 10-k|form 20-f)\b)",
    re.I,
)

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
    encoded = json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False).encode("utf-8")
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


def pdf_lines(target: Path) -> list[dict[str, Any]]:
    try:
        import fitz  # type: ignore
    except Exception as error:
        raise RuntimeError(f"PyMuPDF is required for filing extraction: {error}") from error
    document = fitz.open(target)
    lines: list[dict[str, Any]] = []
    for page_index, page in enumerate(document):
        grouped: list[list[tuple[Any, ...]]] = []
        for word in sorted(page.get_text("words", sort=True), key=lambda item: (float(item[1]), float(item[0]))):
            centre = (float(word[1]) + float(word[3])) / 2
            group = next(
                (
                    candidate for candidate in reversed(grouped[-8:])
                    if abs(
                        sum((float(item[1]) + float(item[3])) / 2 for item in candidate) / len(candidate)
                        - centre
                    ) <= 2.5
                ),
                None,
            )
            if group is None:
                group = []
                grouped.append(group)
            group.append(word)
        for words in grouped:
            words.sort(key=lambda word: float(word[0]))
            lines.append({
                "page": page_index + 1,
                "x0": min(float(word[0]) for word in words),
                "x1": max(float(word[2]) for word in words),
                "y0": min(float(word[1]) for word in words),
                "words": [{"x0": float(word[0]), "x1": float(word[2]), "text": str(word[4])} for word in words],
                "text": " ".join(str(word[4]) for word in words).strip(),
            })
    document.close()
    return sorted(lines, key=lambda line: (line["page"], line["y0"], line["x0"]))


def numeric_runs(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for word in words:
        token = word["text"]
        value = parse_number(token)
        if value is not None or token in {"-", "—", "–"}:
            runs.append({
                "x0": word["x0"],
                "x1": word["x1"],
                "text": token,
                "value": value,
            })
    return runs


def statement_window(
    lines: list[dict[str, Any]], section: str, periods: list[str],
) -> tuple[int, int] | None:
    """Select one actual face-statement surface, never the first prose mention.

    Annual reports refer to cash flows and income statements hundreds of times
    before the audited accounts.  A face statement must therefore have an
    anchored title, all three requested year columns on the same page, and a
    meaningful three-value row surface.  Selection is page-local so notes,
    governance and remuneration prose cannot expand the statement window.
    """
    page_ranges: dict[int, tuple[int, int]] = {}
    for index, line in enumerate(lines):
        page = int(line["page"])
        if page not in page_ranges:
            page_ranges[page] = (index, index + 1)
        else:
            page_ranges[page] = (page_ranges[page][0], index + 1)

    candidates: list[tuple[int, int, int]] = []
    requested_years = {str(period)[:4] for period in periods}
    for heading_index, line in enumerate(lines):
        if not STRICT_HEADINGS[section].fullmatch(line["text"]):
            continue
        _, page_end = page_ranges[int(line["page"])]
        local = lines[heading_index:page_end]
        observed_years = {
            word["text"].strip("(),")
            for candidate in local[:20]
            for word in candidate["words"]
            if YEAR_RE.fullmatch(word["text"].strip("(),"))
        }
        if not requested_years.issubset(observed_years):
            continue
        columns = year_columns(local, periods)
        if len(columns) != 3:
            continue
        resolved_rows = 0
        for candidate in local[1:]:
            runs = numeric_runs(candidate["words"])
            if len(runs) >= 3 and len(nearest_values(runs, columns)) == 3:
                resolved_rows += 1
        if resolved_rows < 5:
            continue
        # Exact title + complete period surface dominates; row count breaks
        # ties when an issuer repeats a face statement elsewhere in the file.
        candidates.append((1000 + resolved_rows, heading_index, page_end))
    if not candidates:
        return None
    _, start, end = max(candidates, key=lambda item: (item[0], item[1]))
    return start, end


def year_columns(window: list[dict[str, Any]], periods: list[str]) -> list[float]:
    years = [str(period)[:4] for period in periods]
    observed: dict[str, list[float]] = {year: [] for year in years}
    for line in window[:20]:
        for word in line["words"]:
            for year in years:
                if word["text"].strip("(),") == year:
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
    if len(columns) != 3:
        return []
    assigned: list[float | None] = [None, None, None]
    distances: list[float] = [float("inf")] * 3
    for run in runs:
        centre = (run["x0"] + run["x1"]) / 2
        index = min(range(3), key=lambda candidate: abs(columns[candidate] - centre))
        distance = abs(columns[index] - centre)
        if distance < distances[index]:
            assigned[index] = run["value"]
            distances[index] = distance
    return assigned


def _finite_series(row: dict[str, Any]) -> list[float] | None:
    values = row.get("values")
    if not isinstance(values, list) or len(values) != 3:
        return None
    result: list[float] = []
    for value in values:
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


def _series_sum_matches(parent: list[float], children: list[list[float]]) -> bool:
    if len(children) < 2:
        return False
    calculated = [sum(series[index] for series in children) for index in range(3)]
    # Filing faces are commonly rounded to whole millions or one decimal place.
    # Source-visible arithmetic is therefore proved within display precision,
    # not machine epsilon.  A 0.5-unit envelope is conservative for whole-unit
    # presentation while still rejecting economically different relationships.
    return all(
        math.isclose(calculated[index], parent[index], rel_tol=1e-9, abs_tol=0.5000001)
        for index in range(3)
    )


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
            while 0 <= cursor < len(rows) and len(indexes) < 10:
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
                    series = _finite_series(candidate)
                    neutral_separator = (
                        level == parent_level
                        and not candidate.get("is_subtotal")
                        and series is not None
                        and all(abs(value) <= 0.5000001 for value in series)
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
                    child_values = [_finite_series(rows[index]) for index in family]
                    if all(series is not None for series in child_values) and _series_sum_matches(
                        parent_values, child_values,  # type: ignore[arg-type]
                    ):
                        families.append(family)
        unique = []
        seen = set()
        for family in families:
            key = tuple(family)
            if key not in seen:
                seen.add(key); unique.append(family)
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
            if parent:
                row["parent_source_line_id"] = parent
        # A row only becomes a hierarchy owner when the source surface says it
        # is a total.  Unknown labels are preserved but do not invent families.
        if row.get("is_subtotal"):
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
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    bounds = statement_window(lines, section, periods)
    if not bounds:
        return None, [{"code": "HEADING_NOT_FOUND", "section": section}]
    start, end = bounds
    window = lines[start:end]
    columns = year_columns(window, periods)
    findings: list[dict[str, Any]] = []
    if len(columns) != 3:
        return None, [{"code": "PERIOD_COLUMNS_UNRESOLVED", "section": section, "page": window[0]["page"]}]
    rows = []
    base_x = min((line["x0"] for line in window[1:] if line["text"]), default=0)
    data_left = min(columns) - 20
    for line in window[1:]:
        if not line["text"] or all(YEAR_RE.fullmatch(word["text"].strip("(),")) for word in line["words"]):
            continue
        if DECORATION_RE.search(line["text"]):
            continue
        # Only the three period columns are values.  A leading dash is often a
        # list bullet and the separate Notes column is not a historical value.
        # Neither may truncate or contaminate the issuer's printed label.
        runs = [run for run in numeric_runs(line["words"]) if run["x1"] >= data_left]
        label_words = [
            word["text"]
            for word in line["words"]
            if word["x0"] < data_left and parse_number(word["text"]) is None
        ]
        label = " ".join(label_words).strip(" :–—-")
        if not label or HEADINGS[section].search(label):
            continue
        if DECORATION_RE.search(label):
            continue
        values = nearest_values(runs, columns) if runs else [None, None, None]
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
        hierarchy = max(0, min(8, round((line["x0"] - base_x) / 12)))
        rows.append({
            "source_line_id": source_line_id,
            "ordinal": len(rows) + 1,
            "raw_label": label,
            "values": values,
            "page_or_note": f"page {line['page']}",
            "material": any(value not in {None, 0} for value in values),
            "hierarchy_level": hierarchy,
            "is_subtotal": is_subtotal_label(label),
        })
    rows = model_statement_scope(rows, section)
    if not rows:
        return None, findings + [{"code": "NO_STATEMENT_ROWS", "section": section}]
    infer_parent_links(rows)
    manifest = {
        "schema_version": "face-statement-manifest/1.0",
        "statement": section,
        "statement_order": 1,
        "source_id": source_id,
        "document_sha256": raw_sha256,
        "page_or_note": f"pages {min(row['page_or_note'] for row in rows)} to {max(row['page_or_note'] for row in rows)}",
        "periods": periods,
        "complete_face_statement": True,
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
        "rows": [{
            "source_line_id": row["source_line_id"],
            "ordinal": row["ordinal"],
            "raw_label": row["raw_label"],
            "values": row["values"],
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
