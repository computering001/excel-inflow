#!/usr/bin/env python3
"""Raw-PDF filing arithmetic integration test for issuer-specific aggregates."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import fitz  # type: ignore

HERE = Path(__file__).resolve().parent


def draw_statement(path: Path, *, family: str = "Product", mutate: bool = False) -> None:
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    font = "helv"
    page.insert_text((54, 48), "Consolidated Income Statement", fontsize=12, fontname=font)
    for x, year in [(330, "2023"), (420, "2024"), (510, "2025")]:
        page.insert_text((x, 72), year, fontsize=9, fontname=font)
    rows = [
        (90, f"{family} Sales", [40000, 47000, 52000]),
        (90, f"{family} Alliance Revenue", [5217, 6150, 6640]),
        (54, f"{family} Revenue", [45217, 53150 + (1 if mutate else 0), 58640]),
        (90, "Collaboration Revenue", [1200, 1400, 1600]),
        (54, "Total Revenue", [46417, 54550, 60240]),
        (90, "Cost of sales", [-12000, -14000, -15000]),
        (54, "Operating profit", [9000, 10500, 11600]),
        (54, "Profit before tax", [8200, 9700, 10800]),
        (54, "Net income", [6500, 7600, 8400]),
    ]
    y = 96
    for x, label, values in rows:
        page.insert_text((x, y), label, fontsize=9, fontname=font)
        for value_x, value in zip((330, 420, 510), values):
            printed = f"({abs(value)})" if value < 0 else str(value)
            page.insert_text((value_x, y), printed, fontsize=9, fontname=font)
        y += 20
    page.insert_text((54, 330), "Consolidated Statement of Cash Flows", fontsize=12, fontname=font)
    for x, year in [(330, "2023"), (420, "2024"), (510, "2025")]:
        page.insert_text((x, 354), year, fontsize=9, fontname=font)
    cash_rows = [
        (90, "Cash generated from operations", [10000, 12000, 13000]),
        (90, "Capital expenditure", [-2500, -2800, -3000]),
        (54, "Cash from investing", [-3000, -3200, -3400]),
        (90, "Cash from financing", [-1500, -1800, -1900]),
        (54, "Net change in cash", [5500, 7000, 7700]),
        (90, "Opening cash", [2000, 7500, 14500]),
        (54, "Ending cash", [7500, 14500, 22200]),
    ]
    y = 378
    for x, label, values in cash_rows:
        page.insert_text((x, y), label, fontsize=9, fontname=font)
        for value_x, value in zip((330, 420, 510), values):
            printed = f"({abs(value)})" if value < 0 else str(value)
            page.insert_text((value_x, y), printed, fontsize=9, fontname=font)
        y += 20
    document.save(path)
    document.close()


def extract(pdf: Path, output: Path) -> dict[str, Any]:
    request = {
        "schema_version": "filings-extraction-request/1.0",
        "run_id": output.name.replace("_", "-").lower(),
        "documents": [{
            "document_id": "annual-report",
            "attachment_id": "annual-report",
            "source_id": "annual_report",
            "path": str(pdf),
        }],
        "filing_facts": {
            "entity_name": "Example plc",
            "reporting_currency": "USD",
            "units": "millions",
            "historical_periods": ["2023-12-31", "2024-12-31", "2025-12-31"],
            "forecast_periods": ["2026-12-31", "2027-12-31", "2028-12-31"],
            "reported_gross_debt": 10000,
            "reported_cash": 22200,
        },
    }
    request_path = output.parent / f"{output.name}-request.json"
    request_path.write_text(json.dumps(request, indent=2) + "\n", "utf-8")
    completed = subprocess.run(
        [sys.executable, str(HERE / "extract_filing_statements.py"), str(request_path), "--out", str(output)],
        cwd=HERE.parent,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr or completed.stdout)
    response = json.loads((output / "filings-extraction-response.json").read_text("utf-8"))
    return response


def income_rows(response: dict[str, Any]) -> list[dict[str, Any]]:
    documents = response["documents"]
    manifests = documents[0]["face_statement_manifests"]["income_statement"]
    assert manifests, "Raw PDF did not yield an income-statement manifest"
    return manifests[0]["rows"]


def row_by_label(rows: list[dict[str, Any]], label: str) -> dict[str, Any]:
    return next(row for row in rows if row["raw_label"].casefold() == label.casefold())


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="excel-inflow-raw-filing-arithmetic-") as temporary:
        root = Path(temporary)
        base_pdf = root / "base.pdf"
        draw_statement(base_pdf)
        base_rows = income_rows(extract(base_pdf, root / "base"))
        product = row_by_label(base_rows, "Product Revenue")
        total = row_by_label(base_rows, "Total Revenue")
        sales = row_by_label(base_rows, "Product Sales")
        alliance = row_by_label(base_rows, "Product Alliance Revenue")
        collaboration = row_by_label(base_rows, "Collaboration Revenue")
        assert sales["parent_source_line_id"] == product["source_line_id"]
        assert alliance["parent_source_line_id"] == product["source_line_id"]
        assert product["parent_source_line_id"] == total["source_line_id"]
        assert collaboration["parent_source_line_id"] == total["source_line_id"]

        renamed_pdf = root / "renamed.pdf"
        draw_statement(renamed_pdf, family="Franchise")
        renamed_rows = income_rows(extract(renamed_pdf, root / "renamed"))
        franchise = row_by_label(renamed_rows, "Franchise Revenue")
        assert row_by_label(renamed_rows, "Franchise Sales")["parent_source_line_id"] == franchise["source_line_id"]
        assert row_by_label(renamed_rows, "Franchise Alliance Revenue")["parent_source_line_id"] == franchise["source_line_id"]

        mutated_pdf = root / "mutated.pdf"
        draw_statement(mutated_pdf, mutate=True)
        mutated_rows = income_rows(extract(mutated_pdf, root / "mutated"))
        mutated_product = row_by_label(mutated_rows, "Product Revenue")
        assert row_by_label(mutated_rows, "Product Sales").get("parent_source_line_id") != mutated_product["source_line_id"]
        assert row_by_label(mutated_rows, "Product Alliance Revenue").get("parent_source_line_id") != mutated_product["source_line_id"]

        receipt = {
            "schema_version": "raw-filing-arithmetic-integration/1.0",
            "status": "PASS",
            "base_pdf_sha256": hashlib.sha256(base_pdf.read_bytes()).hexdigest(),
            "checks": 8,
        }
        print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
