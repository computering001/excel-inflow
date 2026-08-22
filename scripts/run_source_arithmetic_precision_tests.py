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


# ---------------------------------------------------------------------------
# Measured mutation adequacy (P7.5 discipline): every count below comes from a
# real mutant of the PRODUCTION source, materialised by textual mutation,
# executed in an isolated namespace, and rejected by this suite's own oracle.
# A mutant that survives fails the suite; nothing is written as a literal.
# ---------------------------------------------------------------------------
import json  # noqa: E402
from pathlib import Path  # noqa: E402

PRODUCTION_PATH = Path(__file__).resolve().parent / "extract_filing_statements.py"
PRODUCTION_SOURCE = PRODUCTION_PATH.read_text(encoding="utf-8")

SCENARIOS_RUNS = [
    {"x0": 0, "x1": 10, "text": "110.0"},
    {"x0": 100, "x1": 110, "text": "132.40"},
    {"x0": 200, "x1": 210, "text": "154"},
]


def mutated_namespace(old: str, new: str) -> dict:
    mutated = PRODUCTION_SOURCE.replace(old, new, 1)
    assert mutated != PRODUCTION_SOURCE, f"mutation site vanished from production source: {old!r}"
    namespace: dict = {"__name__": "mutated_extract_filing_statements"}
    exec(compile(mutated, str(PRODUCTION_PATH), "exec"), namespace)
    return namespace


def attack_decimal_band(namespace: dict) -> None:
    displayed = namespace["displayed_decimal_places"]
    assert displayed("(1,234.50)") == 2
    assert displayed("110") == 0
    assert displayed("—") is None


def attack_precision_pipeline(namespace: dict) -> None:
    runs = namespace["numeric_runs"](SCENARIOS_RUNS)
    values, states, precisions = namespace["nearest_typed_observations"](runs, [5, 105, 205])
    assert values == [110, 132.4, 154]
    assert states == ["reported_number"] * 3
    assert precisions == [1, 2, 0]


def attack_false_half_unit_rejected(namespace: dict) -> None:
    rows = [
        row("a", [100, 120, 140], [0, 0, 0], 1),
        row("b", [10, 12, 14], [0, 0, 0], 1),
        row("total", [110.4, 132.4, 154.4], [1, 1, 1], 0, subtotal=True),
    ]
    namespace["infer_source_arithmetic_links"](rows)
    assert all("parent_source_line_id" not in item for item in rows[:2])


# Each entry: (mutation name, production text, mutated text, oracle that must reject it).
MUTANTS = [
    (
        "decimal-band-counts-integer-part",
        'return len(number.rsplit(".", 1)[1]) if "." in number else 0',
        'return len(number.rsplit(".", 1)[0]) if "." in number else 0',
        attack_decimal_band,
    ),
    (
        "decimal-band-defaults-to-one",
        'return len(number.rsplit(".", 1)[1]) if "." in number else 0',
        'return len(number.rsplit(".", 1)[1]) if "." in number else 1',
        attack_decimal_band,
    ),
    (
        "runs-drop-displayed-precision",
        '"value_precision": displayed_decimal_places(token),',
        '"value_precision": None,',
        attack_precision_pipeline,
    ),
    (
        "nearest-column-picks-farthest-run",
        "key=lambda candidate: abs(columns[candidate] - centre)",
        "key=lambda candidate: -abs(columns[candidate] - centre)",
        attack_precision_pipeline,
    ),
    (
        "arithmetic-rounding-band-loosened-tenfold",
        "abs_tol=_source_tolerance(parent_row, index),",
        "abs_tol=_source_tolerance(parent_row, index) * 10,",
        attack_false_half_unit_rejected,
    ),
]

mutations_caught: list[str] = []
for name, old, new, attack in MUTANTS:
    namespace = mutated_namespace(old, new)
    try:
        attack(namespace)
    except AssertionError:
        mutations_caught.append(name)
    else:
        raise AssertionError(
            f"surviving mutation {name!r}: the production change was not caught by this suite"
        )

print(
    json.dumps(
        {
            "status": "PASS",
            "checks": 7 + len(mutations_caught),
            "mutations_total": len(MUTANTS),
            "mutations_caught": len(mutations_caught),
        }
    )
)
