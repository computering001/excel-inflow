"""Independent source-arithmetic topology oracle.

This module deliberately does not import the filing extractor or compiler. It
reconstructs candidate parent/child edges from source geometry, typed values,
dimensions and printed precision so production and oracle cannot share the
same subtotal implementation.
"""

from __future__ import annotations

from math import isclose
from typing import Any


def _numeric(row: dict[str, Any]) -> list[float] | None:
    values = row.get("values")
    states = row.get("value_states")
    if not isinstance(values, list) or len(values) != 3:
        return None
    result = []
    for index, value in enumerate(values):
        if isinstance(states, list) and len(states) == 3 and states[index] not in {
            "reported_number", "reported_zero",
        }:
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        result.append(number)
    return result


def _dimension(row: dict[str, Any], *names: str) -> str | None:
    for name in names:
        value = row.get(name)
        if value is not None and str(value).strip():
            return str(value).strip().lower()
    return None


def _compatible(family: list[dict[str, Any]]) -> bool:
    for names in (
        ("reporting_currency", "currency"),
        ("scale", "units", "unit_scale"),
        ("sign_convention", "source_sign_convention"),
        ("unit_class", "numeric_type", "number_format"),
    ):
        values = {_dimension(row, *names) for row in family}
        values.discard(None)
        if len(values) > 1:
            return False
    unit = next(iter({
        _dimension(row, "unit_class", "numeric_type", "number_format")
        for row in family
    } - {None}), None)
    if unit in {"percentage", "percent", "rate", "ratio", "count"}:
        return all(row.get("arithmetic_additive") is True for row in family)
    return True


def _tolerance(row: dict[str, Any], period: int) -> float:
    precision = (row.get("value_precisions") or [None] * 3)[period]
    if not isinstance(precision, int):
        text = str(row.get("values", [0, 0, 0])[period])
        precision = len(text.rsplit(".", 1)[1]) if "." in text else 0
    return 0.5 * 10 ** (-precision) + 1e-12


def reconstruct_source_topology(rows: list[dict[str, Any]]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for parent_index, parent in enumerate(rows):
        parent_values = _numeric(parent)
        if parent_values is None:
            continue
        parent_level = int(parent.get("hierarchy_level") or 0)
        matches: set[tuple[int, ...]] = set()
        for direction in (-1, 1):
            candidates = []
            cursor = parent_index + direction
            while 0 <= cursor < len(rows):
                level = int(rows[cursor].get("hierarchy_level") or 0)
                if level <= parent_level:
                    break
                if level == parent_level + 1 and _numeric(rows[cursor]) is not None:
                    candidates.append(cursor)
                cursor += direction
            if direction < 0:
                candidates.reverse()
            for start in range(len(candidates)):
                for end in range(start + 2, len(candidates) + 1):
                    indexes = tuple(candidates[start:end])
                    children = [rows[index] for index in indexes]
                    if not _compatible([parent, *children]):
                        continue
                    series = [_numeric(child) for child in children]
                    if all(
                        isclose(sum(values[p] for values in series), parent_values[p],
                                rel_tol=0, abs_tol=_tolerance(parent, p))
                        for p in range(3)
                    ):
                        matches.add(indexes)
        if len(matches) == 1:
            indexes = next(iter(matches))
            result[str(parent["source_line_id"])] = [
                str(rows[index]["source_line_id"]) for index in indexes
            ]
    return result
