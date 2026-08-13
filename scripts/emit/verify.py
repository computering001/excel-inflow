"""
N13 VERIFY — compare two plans, channel by channel, and count.

The comparison is done on PLANS, not on workbooks, and both sides are produced
by the same extractor (`scripts/extract_plan.mjs`). That is deliberate: a
comparator with its own reading of the XML introduces a second parser, and a
disagreement between two parsers is indistinguishable from a disagreement
between two workbooks. One parser, one contract, and the diff means what it
says.

Styles are compared RESOLVED, never by index. The two files have different style
tables — openpyxl deduplicates differently from the legacy workbook library writer, and
the terminal indent patch appends clones — so equal indices would prove nothing
and unequal indices would prove nothing either. Each cell's style index is
dereferenced on its own side and the resulting records are compared field by
field, which is the only comparison that says anything about what a reader sees.

Every channel reports a count. A channel that is not reproduced says so and says
by how much; "partial and honest" is the standard, and a summary that reads
complete because a channel was skipped is the failure this file exists to
prevent.
"""

from __future__ import annotations

import json
from pathlib import Path

# The channels, in the order they are reported. Each is (key, label).
CELL_CHANNELS = [
    ("formula", "formula"),
    ("value", "value / cached value"),
    ("font_color", "font colour (PROVENANCE)"),
    ("bold", "bold"),
    ("italic", "italic"),
    ("font_name", "font name"),
    ("font_size", "font size"),
    ("number_format", "number format"),
    ("fill", "fill"),
    ("border", "border edges"),
    ("alignment", "alignment / indent"),
]


def _outline(sheet):
    """
    Outline properties compared as EFFECTIVE values, not as written elements.

    An absent `<outlinePr/>` and an `<outlinePr summaryBelow="1"
    summaryRight="1"/>` are the same sheet — summaryBelow and summaryRight both
    default to true. Comparing the elements instead of their meaning reports a
    difference no reader can see, and a comparator that cries wolf about
    spelling gets its real findings ignored.
    """
    record = dict(sheet.get("outline") or {})
    record.setdefault("summary_below", True)
    record.setdefault("summary_right", True)
    record.setdefault("outline_level_row", 0)
    record.setdefault("outline_level_col", 0)
    return record


def _normalise_sqref(sqref):
    """
    `C4:C4` and `C4` are the same range.

    The legacy workbook library writer spells a single-cell conditional-format range as a
    degenerate range; openpyxl spells it as a cell. Excel reads them
    identically, so the difference is orthography and must not be reported as a
    missing rule.
    """
    parts = []
    for token in str(sqref).split():
        if ":" in token:
            first, last = token.split(":", 1)
            if first == last:
                token = first
        parts.append(token)
    return " ".join(parts)


def _style_of(plan, cell):
    index = cell.get("s")
    if index is None:
        return {}
    return plan["workbook"]["styles"][index]


def _font(style):
    return style.get("font") or {}


def _normalise_number(value):
    """
    Numbers are compared as floats with a relative tolerance.

    A cached value that came back from a different float path is not a defect
    at the fifteenth significant figure; a cached value that is a different
    NUMBER is. The tolerance is tight enough that a real disagreement cannot
    hide inside it.
    """
    return value


def _values_equal(left, right):
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        if isinstance(left, bool) or isinstance(right, bool):
            return bool(left) == bool(right)
        if left == right:
            return True
        scale = max(abs(left), abs(right), 1.0)
        return abs(left - right) <= 1e-9 * scale
    return left == right


def _border_edges(style):
    border = style.get("border") or {}
    return {
        edge: (spec or {}).get("style") and (
            (spec or {}).get("style"),
            ((spec or {}).get("color") or "").upper(),
        )
        for edge, spec in border.items()
        if spec
    }


def _fill(style):
    fill = style.get("fill")
    if not fill:
        return None
    return (
        fill.get("pattern"),
        (fill.get("fg_color") or "").upper(),
        (fill.get("bg_color") or "").upper(),
    )


def _alignment(style):
    alignment = style.get("alignment") or {}
    return (
        alignment.get("horizontal"),
        alignment.get("vertical"),
        alignment.get("indent", 0),
        bool(alignment.get("wrap_text")),
    )


def _cell_channel_values(plan, cell):
    style = _style_of(plan, cell)
    font = _font(style)
    return {
        "formula": cell.get("f"),
        "value": cell.get("v"),
        "font_color": (font.get("color") or "").upper() or None,
        "bold": bool(font.get("bold")),
        "italic": bool(font.get("italic")),
        "font_name": font.get("name"),
        "font_size": font.get("size"),
        "number_format": style.get("number_format") or "General",
        "fill": _fill(style),
        "border": _border_edges(style),
        "alignment": _alignment(style),
    }


def _compare_sheet(expected_plan, actual_plan, expected, actual, examples):
    expected_cells = expected["cells"]
    actual_cells = actual["cells"]

    result = {
        "cells_expected": len(expected_cells),
        "cells_actual": len(actual_cells),
        "cells_missing": [],
        "cells_extra": [],
        "channels": {},
    }

    missing = [address for address in expected_cells if address not in actual_cells]
    extra = [address for address in actual_cells if address not in expected_cells]
    result["cells_missing"] = missing
    result["cells_extra"] = extra

    shared = [address for address in expected_cells if address in actual_cells]
    counters = {key: {"compared": 0, "match": 0, "mismatch": 0, "examples": []} for key, _ in CELL_CHANNELS}

    for address in shared:
        left = _cell_channel_values(expected_plan, expected_cells[address])
        right = _cell_channel_values(actual_plan, actual_cells[address])
        for key, _label in CELL_CHANNELS:
            counter = counters[key]
            counter["compared"] += 1
            a, b = left[key], right[key]
            same = _values_equal(a, b) if key == "value" else a == b
            if same:
                counter["match"] += 1
            else:
                counter["mismatch"] += 1
                if len(counter["examples"]) < examples:
                    counter["examples"].append({"cell": address, "expected": a, "actual": b})
    result["channels"] = counters

    # Sheet-level channels.
    result["sheet"] = {}

    def sheet_channel(name, left, right):
        result["sheet"][name] = {
            "match": left == right,
            "expected": left,
            "actual": right,
        }

    sheet_channel("freeze_pane", expected.get("freeze_pane"), actual.get("freeze_pane"))
    sheet_channel("show_gridlines", expected.get("show_gridlines"), actual.get("show_gridlines"))
    sheet_channel("outline", _outline(expected), _outline(actual))
    sheet_channel("default_row_height", expected.get("default_row_height"), actual.get("default_row_height"))
    sheet_channel("page_margins", expected.get("page_margins"), actual.get("page_margins"))
    sheet_channel("merges", expected.get("merges", []), actual.get("merges", []))

    # Column widths, keyed by column index rather than by <col> run, because two
    # writers legitimately group runs differently for identical widths.
    def widths(sheet):
        table = {}
        for record in sheet.get("columns", []):
            for index in range(record["min"], record["max"] + 1):
                table[index] = (record.get("width"), bool(record.get("hidden")))
        return table

    left_widths, right_widths = widths(expected), widths(actual)
    keys = sorted(set(left_widths) | set(right_widths))
    width_mismatch = [k for k in keys if left_widths.get(k) != right_widths.get(k)]
    result["sheet"]["column_widths"] = {
        "compared": len(keys),
        "match": len(keys) - len(width_mismatch),
        "mismatch": len(width_mismatch),
        "examples": [
            {"column": k, "expected": left_widths.get(k), "actual": right_widths.get(k)}
            for k in width_mismatch[:examples]
        ],
    }

    def rows(sheet):
        return {
            record["row"]: (record.get("height"), record.get("outline_level", 0), bool(record.get("hidden")))
            for record in sheet.get("rows", [])
        }

    left_rows, right_rows = rows(expected), rows(actual)
    keys = sorted(set(left_rows) | set(right_rows))
    row_mismatch = [k for k in keys if left_rows.get(k) != right_rows.get(k)]
    result["sheet"]["rows"] = {
        "compared": len(keys),
        "match": len(keys) - len(row_mismatch),
        "mismatch": len(row_mismatch),
        "examples": [
            {"row": k, "expected": left_rows.get(k), "actual": right_rows.get(k)}
            for k in row_mismatch[:examples]
        ],
    }

    # Conditional formats, resolved: sqref + rule shape + the dereferenced dxf.
    def conditional(plan, sheet):
        table = plan["workbook"].get("differential_styles", [])
        out = []
        for block in sheet.get("conditional_formats", []):
            for rule in block["rules"]:
                index = rule.get("dxf")
                out.append(
                    (
                        _normalise_sqref(block["sqref"]),
                        rule["type"],
                        rule.get("operator"),
                        tuple(rule.get("formulas", [])),
                        json.dumps(table[index] if index is not None else None, sort_keys=True),
                    )
                )
        return sorted(out)

    left_cf = conditional(expected_plan, expected)
    right_cf = conditional(actual_plan, actual)
    only_left = [r for r in left_cf if r not in right_cf]
    only_right = [r for r in right_cf if r not in left_cf]
    result["sheet"]["conditional_formats"] = {
        "expected": len(left_cf),
        "actual": len(right_cf),
        "match": len(left_cf) - len(only_left),
        "missing": len(only_left),
        "extra": len(only_right),
        "examples": [{"missing": r[:4]} for r in only_left[:examples]]
        + [{"extra": r[:4]} for r in only_right[:examples]],
    }

    def validations(sheet):
        return sorted(
            (
                _normalise_sqref(record["sqref"]),
                record["type"],
                record.get("operator"),
                record.get("formula1"),
                record.get("formula2"),
            )
            for record in sheet.get("data_validations", [])
        )

    left_dv, right_dv = validations(expected), validations(actual)
    result["sheet"]["data_validations"] = {
        "expected": len(left_dv),
        "actual": len(right_dv),
        "match": sum(1 for r in left_dv if r in right_dv),
        "missing": [r for r in left_dv if r not in right_dv][:examples],
        "extra": [r for r in right_dv if r not in left_dv][:examples],
    }

    # Comments are compared as a MULTISET of (cell, text), not as a cell -> text
    # map. The reference emitter attaches TWO identical threaded comments to
    # every provenance cell — `attachInputProvenance` and the emission branch
    # both add one, and legacy workbook library permitted the duplicate — so on Kerry
    # there are 260 threads over 131 cells. Keyed by cell, a renderer that
    # dropped one of each pair would compare clean. Counted as a multiset, it
    # cannot.
    def comments(sheet):
        counter: dict[tuple[str, str], int] = {}
        for record in sheet.get("comments", []):
            key = (record["cell"], record["text"])
            counter[key] = counter.get(key, 0) + 1
        return counter

    left_comments, right_comments = comments(expected), comments(actual)
    keys = sorted(set(left_comments) | set(right_comments))
    comment_mismatch = [k for k in keys if left_comments.get(k, 0) != right_comments.get(k, 0)]
    result["sheet"]["comments"] = {
        "expected": sum(left_comments.values()),
        "actual": sum(right_comments.values()),
        "distinct": len(keys),
        "match": len(keys) - len(comment_mismatch),
        "mismatch": len(comment_mismatch),
        "examples": [
            {"cell": k[0], "expected": left_comments.get(k, 0), "actual": right_comments.get(k, 0)}
            for k in comment_mismatch[:examples]
        ],
    }

    return result


def compare(expected_plan, actual_plan, *, examples=5):
    """Compare two plans. `expected_plan` is the reference."""
    report = {"sheets": {}, "workbook": {}}

    for key in ("calc_properties", "default_font", "comment_author"):
        left = expected_plan["workbook"].get(key)
        right = actual_plan["workbook"].get(key)
        report["workbook"][key] = {"match": left == right, "expected": left, "actual": right}

    expected_sheets = {sheet["name"]: sheet for sheet in expected_plan["workbook"]["sheets"]}
    actual_sheets = {sheet["name"]: sheet for sheet in actual_plan["workbook"]["sheets"]}
    report["workbook"]["sheet_order"] = {
        "match": [s["name"] for s in expected_plan["workbook"]["sheets"]]
        == [s["name"] for s in actual_plan["workbook"]["sheets"]],
        "expected": [s["name"] for s in expected_plan["workbook"]["sheets"]],
        "actual": [s["name"] for s in actual_plan["workbook"]["sheets"]],
    }

    for name, expected in expected_sheets.items():
        actual = actual_sheets.get(name)
        if actual is None:
            report["sheets"][name] = {"missing_sheet": True}
            continue
        report["sheets"][name] = _compare_sheet(
            expected_plan, actual_plan, expected, actual, examples
        )

    return report


def summarise(report):
    """Roll a comparison up into per-channel totals across every sheet."""
    totals = {key: {"compared": 0, "match": 0, "mismatch": 0} for key, _ in CELL_CHANNELS}
    cells = {"expected": 0, "actual": 0, "missing": 0, "extra": 0}
    sheet_level = {}
    # Structural failures the verdict must count: a sheet lost from the actual
    # plan, an extra sheet, a sheet-order change, or a workbook-level property
    # mismatch. Skipping them made the comparison exit clean on a workbook
    # missing an entire evidence tab.
    structural = {"missing_sheets": 0, "extra_sheets": 0, "workbook_mismatches": 0}
    expected_names = set(report["sheets"].keys())
    actual_names = set(report["workbook"].get("sheet_order", {}).get("actual") or [])
    structural["extra_sheets"] = len(actual_names - expected_names) if actual_names else 0
    for record in report["workbook"].values():
        if isinstance(record, dict) and record.get("match") is False:
            structural["workbook_mismatches"] += 1
    for sheet in report["sheets"].values():
        if sheet.get("missing_sheet"):
            structural["missing_sheets"] += 1
            continue
        cells["expected"] += sheet["cells_expected"]
        cells["actual"] += sheet["cells_actual"]
        cells["missing"] += len(sheet["cells_missing"])
        cells["extra"] += len(sheet["cells_extra"])
        for key, counter in sheet["channels"].items():
            for field in ("compared", "match", "mismatch"):
                totals[key][field] += counter[field]
        for name, record in sheet["sheet"].items():
            bucket = sheet_level.setdefault(name, {"ok": 0, "not_ok": 0})
            if "match" in record and isinstance(record["match"], bool):
                bucket["ok" if record["match"] else "not_ok"] += 1
            else:
                mismatch = record.get("mismatch")
                if mismatch is None:
                    mismatch = record.get("missing", 0)
                    if isinstance(mismatch, list):
                        mismatch = len(mismatch)
                    mismatch += len(record.get("extra", [])) if isinstance(record.get("extra"), list) else record.get("extra", 0)
                bucket["ok" if not mismatch else "not_ok"] += 1
    return {
        "cells": cells,
        "channels": totals,
        "sheet_level": sheet_level,
        "structural": structural,
    }


def load_plan(path):
    return json.loads(Path(path).read_text(encoding="utf8"))
