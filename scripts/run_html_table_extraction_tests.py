#!/usr/bin/env python3
"""Plain-HTML fallback lane regression against synthetic fixtures (mp-Q).

Proves scripts/extract_html_tables.py on the three test-fixtures/html-tables/
documents: grid expansion (colspan/rowspan), period-header stitching,
broker_numeric-rule value parsing (parentheses negative, %/x suffix,
thousands separators, dash placeholders, superscript exclusion), the
inline-XBRL classification guard, byte-deterministic CLI artifacts, and a
mutation-style check (a corrupted fixture number must be detected, not
silently accepted). Also py_compiles the lane module.
"""
from __future__ import annotations

import hashlib
import json
import py_compile
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FIXTURES = ROOT / "test-fixtures" / "html-tables"
EXTRACTOR = HERE / "extract_html_tables.py"

sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import extract_html_tables as lane  # noqa: E402


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def extract(source: Path, out: Path) -> tuple[dict, subprocess.CompletedProcess]:
    completed = subprocess.run(
        [sys.executable, str(EXTRACTOR), str(source), "--out", str(out)],
        text=True, capture_output=True, check=False,
    )
    check(completed.returncode == 0, (
        f"extractor failed on {source.name} ({completed.returncode}): "
        f"{completed.stderr[-500:]}"
    ))
    return json.loads(out.read_text("utf-8")), completed


def facts_by_concept(result: dict) -> dict:
    table: dict[str, list[dict]] = {}
    for fact in result["facts"]:
        table.setdefault(fact["concept"], []).append(fact)
    return table


def assert_clean_income_statement(result: dict, source: Path) -> None:
    """Shared oracle: also reused by the mutation check."""
    check(result["schema_version"] == "html-table-facts/1.0", "schema_version")
    check(result["ixbrl_present"] is False, "ixbrl_present flag")
    check(result["source_sha256"] == hashlib.sha256(source.read_bytes()).hexdigest(),
          "source_sha256 binding")
    check(result["fact_count"] == 9, f"fact_count 9, got {result['fact_count']}")
    check(result["table_count"] == 1, "table_count")
    by_concept = facts_by_concept(result)
    check(set(by_concept) == {"revenue", "cost_of_revenue", "gross_profit"},
          f"concepts {sorted(by_concept)}")
    expected = {
        ("revenue", "2025"): (1_250_000 * 1e3, None),
        ("revenue", "2024"): (1_102_400 * 1e3, None),
        ("revenue", "2023"): (980_150 * 1e3, None),
        ("cost_of_revenue", "2025"): (-742_500 * 1e3, "-"),
        ("cost_of_revenue", "2024"): (-665_000 * 1e3, "-"),
        ("cost_of_revenue", "2023"): (-601_300 * 1e3, "-"),
        ("gross_profit", "2025"): (507_500 * 1e3, None),
        ("gross_profit", "2024"): (437_400 * 1e3, None),
        ("gross_profit", "2023"): (378_850 * 1e3, None),
    }
    for concept, entries in by_concept.items():
        for fact in entries:
            year = fact["period"]["end"][:4]
            value, sign = expected[(concept, year)]
            check(fact["value"] == value,
                  f"{concept} {year}: {fact['value']} != {value}")
            check(fact["sign"] == sign, f"{concept} {year} sign {fact['sign']}")
            check(fact["period"] == {
                "start": f"{year}-01-01", "end": f"{year}-12-31",
            }, f"{concept} {year} period {fact['period']}")
            check(fact["scale"] == "3", f"{concept} scale (in thousands)")
            check(fact["context_ref"] == "" and fact["dimensions"] == {},
                  "structured-lane shape: empty context/dimensions")
    columns = result["tables"][0]["columns"]
    check([c["period"] for c in columns] == [
        {},
        {"start": "2025-01-01", "end": "2025-12-31"},
        {"start": "2024-01-01", "end": "2024-12-31"},
        {"start": "2023-01-01", "end": "2023-12-31"},
    ], f"column periods {columns}")


def assert_rowspan_balance_sheet(result: dict) -> None:
    check(result["fact_count"] == 6, f"fact_count 6, got {result['fact_count']}")
    by_concept = facts_by_concept(result)
    check(set(by_concept) == {
        "current_assets_cash_and_equivalents",
        "current_assets_receivables_net",
        "non_current_assets_property_net",
    }, f"concepts {sorted(by_concept)} — rowspan label carry must stitch "
       f"'Current assets' onto both body rows")
    expected = {
        "current_assets_cash_and_equivalents": {2025: 412e6, 2024: 388e6},
        "current_assets_receivables_net": {2025: 275e6, 2024: 301e6},
        "non_current_assets_property_net": {2025: 1_120e6, 2024: -1_088e6},
    }
    for concept, entries in by_concept.items():
        for fact in entries:
            year = int(fact["period"]["instant"][:4])
            check(fact["period"] == {"instant": f"{year}-12-31"},
                  f"{concept} instant {fact['period']}")
            check(fact["value"] == expected[concept][year],
                  f"{concept} {year}: {fact['value']}")
            check(fact["scale"] == "6", f"{concept} scale (in millions)")
    negative = [f for f in by_concept["non_current_assets_property_net"]
                if f["value"] < 0]
    check(len(negative) == 1 and negative[0]["sign"] == "-",
          "parenthesized (1,088) must be negative with sign '-'")
    columns = result["tables"][0]["columns"]
    check(columns[2]["period"] == {"instant": "2025-12-31"}
          and columns[3]["period"] == {"instant": "2024-12-31"},
          f"stitched 'As of Dec 31,' + year sub-header: "
          f"{[c['period'] for c in columns[2:]]}")
    grid = lane.expand_grid(
        lane.parse_tables(
            (FIXTURES / "rowspan_balance_sheet.html").read_text("utf-8")
        )[0]["rows"]
    )
    check(len(grid) == 5 and len(grid[0]) == 4,
          f"grid must expand to 5x4 (rowspan/colspan), got "
          f"{len(grid)}x{len(grid[0])}")
    check(grid[2][0]["text"] == "Current assets"
          and not grid[2][0]["is_spanned"],
          "'Current assets' originates in the first body row")
    check(grid[3][0]["text"] == "Current assets" and grid[3][0]["is_spanned"],
          "rowspan copy carries 'Current assets' into the second body row")


def assert_footnote_superscripts(result: dict) -> None:
    check(result["fact_count"] == 3, f"fact_count 3, got {result['fact_count']}")
    by_concept = facts_by_concept(result)
    check(set(by_concept) == {"gross_margin", "net_revenue",
                              "headcount_reduction"},
          f"concepts {sorted(by_concept)}")
    margin = by_concept["gross_margin"][0]
    check(margin["value"] == 0.438, f"43.8%% -> 0.438, got {margin['value']}")
    check(margin["provenance"]["printed_token"] == "43.8%",
          "superscript must not leak into the numeric token")
    check("(a)" in margin["provenance"]["label_footnote_refs"],
          f"label footnote ref captured: {margin['provenance']}")
    revenue = by_concept["net_revenue"][0]
    check(revenue["value"] == 96_480.0,
          f"superscript '3' excluded from number: {revenue['value']}")
    check(revenue["provenance"]["footnote_refs"] == ["3"],
          f"footnote ref recorded: {revenue['provenance']['footnote_refs']}")
    check(revenue["concept"] == "net_revenue",
          "'[3]' stripped from concept")
    dash = by_concept["headcount_reduction"][0]
    check(dash["value"] == 0.0 and dash["sign"] is None,
          "em-dash placeholder reads 0.0 like the structured lane")
    for concept in by_concept:
        for fact in by_concept[concept]:
            check(fact["period"] == {"start": "2025-01-01",
                                     "end": "2025-12-31"},
                  f"{concept} 'Year ended Dec 31, 2025' period {fact['period']}")


def assert_ixbrl_guard(workdir: Path) -> None:
    source = workdir / "ixbrl_document.html"
    source.write_text(
        "<html><body><ix:nonfraction name=\"t:R\" contextRef=\"c\">1</ix:"
        "nonfraction></body></html>", "utf-8",
    )
    out = workdir / "should-not-exist.json"
    completed = subprocess.run(
        [sys.executable, str(EXTRACTOR), str(source), "--out", str(out)],
        text=True, capture_output=True, check=False,
    )
    check(completed.returncode == 0, f"guard must exit 0, got {completed.returncode}")
    payload = json.loads(completed.stdout)
    check(payload["status"] == "ixbrl_present_use_structured_lane",
          f"guard status: {payload}")
    check(not out.exists(), "guard must not write an extraction artifact")


def assert_mutation_detection(workdir: Path) -> None:
    """Mutation check: corrupt one printed number; the oracle must notice."""
    mutated_source = workdir / "mutated_income_statement.html"
    original = (FIXTURES / "clean_income_statement.html").read_text("utf-8")
    check("507,500" in original, "mutation anchor present in fixture")
    mutated_source.write_text(original.replace("507,500", "507,900"), "utf-8")
    out = workdir / "mutated.json"
    result, _ = extract(mutated_source, out)
    try:
        assert_clean_income_statement(result, mutated_source)
    except AssertionError as error:
        print(f"  mutation detected: {error}")
    else:
        raise AssertionError(
            "MUTATION SURVIVED: corrupted 507,500 -> 507,900 was not detected"
        )


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="mp-q-html-lane-") as tmp:
        workdir = Path(tmp)

        py_compile.compile(str(EXTRACTOR),
                           cfile=str(workdir / "extract_html_tables.pyc"),
                           doraise=True)
        py_compile.compile(str(Path(__file__)),
                           cfile=str(workdir / "runner.pyc"), doraise=True)
        print("  py_compile: extract_html_tables.py + runner OK")

        clean_out = workdir / "clean.json"
        clean, completed = extract(FIXTURES / "clean_income_statement.html",
                                   clean_out)
        payload = json.loads(completed.stdout)
        check(payload["status"] == "PASS" and payload["fact_count"] == 9,
              f"CLI payload {payload}")
        assert_clean_income_statement(clean, FIXTURES / "clean_income_statement.html")
        print("  fixture clean_income_statement.html: grid 4x4, 9 facts, "
              "periods+values+signs OK")

        assert_rowspan_balance_sheet(
            extract(FIXTURES / "rowspan_balance_sheet.html",
                    workdir / "rowspan.json")[0])
        print("  fixture rowspan_balance_sheet.html: 5x4 grid, 6 facts, "
              "stitched instants OK")

        assert_footnote_superscripts(
            extract(FIXTURES / "footnote_superscripts.html",
                    workdir / "footnotes.json")[0])
        print("  fixture footnote_superscripts.html: 3 facts, sup exclusion "
              "+ refs OK")

        determinism_out = workdir / "clean-rerun.json"
        extract(FIXTURES / "clean_income_statement.html", determinism_out)
        check(clean_out.read_bytes() == determinism_out.read_bytes(),
              "artifact must be byte-deterministic across runs")
        print("  byte-deterministic artifact OK")

        assert_ixbrl_guard(workdir)
        print("  ixbrl guard: status=ixbrl_present_use_structured_lane, "
              "exit 0, no artifact OK")

        assert_mutation_detection(workdir)
        print("  mutation check: corrupted number detected")

    print("PASS html-table fallback lane")
    return 0


if __name__ == "__main__":
    sys.exit(main())
