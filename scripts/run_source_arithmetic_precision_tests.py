#!/usr/bin/env python3
"""Independent mutations for typed source arithmetic and printed precision."""

from extract_filing_statements import (
    displayed_decimal_places,
    infer_source_arithmetic_links,
    nearest_typed_observations,
    numeric_runs,
)


def row(line_id, values, precisions, level, subtotal=False, states=None):
    return {
        "source_line_id": line_id,
        "raw_label": line_id,
        "values": values,
        "value_states": states or [
            "reported_blank" if value is None else
            "reported_zero" if value == 0 else
            "reported_number"
            for value in values
        ],
        "value_precisions": precisions,
        "hierarchy_level": level,
        "is_subtotal": subtotal,
    }


assert displayed_decimal_places("(1,234.50)") == 2
assert displayed_decimal_places("110") == 0
assert displayed_decimal_places("—") is None

runs = numeric_runs([
    {"x0": 0, "x1": 10, "text": "110.0"},
    {"x0": 100, "x1": 110, "text": "132.40"},
    {"x0": 200, "x1": 210, "text": "154"},
])
values, states, precisions = nearest_typed_observations(runs, [5, 105, 205])
assert values == [110, 132.4, 154]
assert states == ["reported_number"] * 3
assert precisions == [1, 2, 0]

false_half_unit = [
    row("a", [100, 120, 140], [0, 0, 0], 1),
    row("b", [10, 12, 14], [0, 0, 0], 1),
    row("total", [110.4, 132.4, 154.4], [1, 1, 1], 0, subtotal=True),
]
infer_source_arithmetic_links(false_half_unit)
assert all("parent_source_line_id" not in item for item in false_half_unit[:2])

exact = [
    row("a", [100, 120, 140], [0, 0, 0], 1),
    row("b", [10, 12, 14], [0, 0, 0], 1),
    row("total", [110, 132, 154], [1, 1, 1], 0, subtotal=True),
]
infer_source_arithmetic_links(exact)
assert [item.get("parent_source_line_id") for item in exact[:2]] == ["total", "total"]

missing = [
    row("a", [100, 120, 140], [0, 0, 0], 1),
    row("blank", [None, None, None], [None, None, None], 1),
    row("total", [100, 120, 140], [0, 0, 0], 0, subtotal=True),
]
infer_source_arithmetic_links(missing)
assert all("parent_source_line_id" not in item for item in missing[:2])

nonzero_separator = [
    row("a", [100, 120, 140], [0, 0, 0], 1),
    row("b", [10, 12, 14], [0, 0, 0], 1),
    row("small", [0.4, 0.4, 0.4], [1, 1, 1], 0),
    row("total", [110, 132, 154], [0, 0, 0], 0, subtotal=True),
]
infer_source_arithmetic_links(nonzero_separator)
assert all("parent_source_line_id" not in item for item in nonzero_separator[:2])

print({"status": "PASS", "checks": 7, "mutations": 4})
