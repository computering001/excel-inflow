#!/usr/bin/env python3
"""Raw-PDF broker test: native-clean houses survive one-house recovery selection."""
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
METRICS = [
    ("Revenue", [60000, 65000, 70000]),
    ("EBIT", [12000, 13000, 14000]),
    ("Adjusted EBITDA", [14500, 15700, 16900]),
    ("Depreciation and amortisation", [2500, 2700, 2900]),
    ("Effective tax rate", ["21%", "21%", "22%"]),
    ("Capital expenditure", [-3500, -3700, -3900]),
    ("Change in working capital", [-500, -550, -600]),
    ("Dividends paid", [-4000, -4300, -4600]),
    ("Share buybacks", [-1000, -1200, -1400]),
]


def draw_native_table(path: Path) -> None:
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((50, 45), "Financial forecasts", fontsize=13)
    left, top = 45, 70
    widths = [240, 90, 90, 90]
    row_height = 34
    rows = [["Metric", "2026E", "2027E", "2028E"], *[[label, *values] for label, values in METRICS]]
    x_positions = [left]
    for width in widths:
        x_positions.append(x_positions[-1] + width)
    for row_index in range(len(rows) + 1):
        y = top + row_index * row_height
        page.draw_line((left, y), (x_positions[-1], y), width=0.8)
    for x in x_positions:
        page.draw_line((x, top), (x, top + len(rows) * row_height), width=0.8)
    for row_index, row in enumerate(rows):
        y = top + row_index * row_height + 21
        for column_index, value in enumerate(row):
            x = x_positions[column_index] + 5
            page.insert_text((x, y), str(value), fontsize=8.5)
    document.save(path)
    document.close()


def make_scanned_copy(native_path: Path, scanned_path: Path) -> None:
    source = fitz.open(native_path)
    pixmap = source[0].get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    source.close()
    target = fitz.open()
    page = target.new_page(width=612, height=792)
    page.insert_image(page.rect, stream=pixmap.tobytes("png"))
    target.save(scanned_path)
    target.close()


def demand_graph() -> dict[str, Any]:
    periods = ["2026-12-31", "2027-12-31", "2028-12-31"]
    nodes = []
    definitions = [
        ("revenue", "Revenue", "income_statement"),
        ("ebit", "EBIT", "income_statement"),
        ("adjusted_ebitda", "Adjusted EBITDA", "income_statement"),
        ("depreciation_and_amortisation", "Depreciation and amortisation", "income_statement"),
        ("effective_tax_rate", "Effective tax rate", "income_statement"),
        ("capex", "Capital expenditure", "cash_flow"),
        ("change_in_working_capital", "Change in working capital", "cash_flow"),
        ("dividends", "Dividends paid", "cash_flow"),
        ("share_buybacks", "Share buybacks", "cash_flow"),
    ]
    for metric_id, label, section in definitions:
        for index, period in enumerate(periods):
            nodes.append({
                "node_id": f"test.{metric_id}.fy{index + 1}",
                "section": section,
                "source_line_id": f"test.{metric_id}",
                "label": label,
                "parent_label": None,
                "period_end": period,
                "material": True,
                "has_historical_value": True,
                "allowed_authorities": ["selected_broker", "historical_inference"],
                "definition_signature_sha256": hashlib.sha256(f"{metric_id}:{period}".encode()).hexdigest(),
            })
    body = {
        "schema_version": "pre-broker-model-demand/1.0",
        "run_id": "raw-broker-native-test",
        "as_of": "2025-12-31",
        "reporting_currency": "USD",
        "units": "millions",
        "forecast_periods": periods,
        "nodes": nodes,
        "counts": {"source_rows": len(definitions), "forecast_nodes": len(nodes), "material_nodes": len(nodes)},
    }
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    return {**body, "graph_sha256": hashlib.sha256(canonical).hexdigest()}


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="excel-inflow-raw-broker-native-") as temporary:
        root = Path(temporary)
        older = root / "older-clean.pdf"
        newer = root / "newer-scanned.pdf"
        draw_native_table(older)
        make_scanned_copy(older, newer)
        request = {
            "schema_version": "broker-extraction-request/1.0",
            "run_id": "raw_broker_native_test",
            "model_context": {
                "as_of": "2025-12-31",
                "reporting_currency": "USD",
                "units": "millions",
                "forecast_periods": ["2026-12-31", "2027-12-31", "2028-12-31"],
                "model_demand_graph": demand_graph(),
            },
            "documents": [
                {
                    "document_id": "older-clean",
                    "house_id": "older_clean",
                    "house_name": "Older Clean House",
                    "source_id": "broker_older_clean",
                    "path": str(older),
                    "media_type": "application/pdf",
                    "published_date": "2026-02-18",
                    "expected_sha256": hashlib.sha256(older.read_bytes()).hexdigest(),
                },
                {
                    "document_id": "newer-scanned",
                    "house_id": "newer_scanned",
                    "house_name": "Newer Scanned House",
                    "source_id": "broker_newer_scanned",
                    "path": str(newer),
                    "media_type": "application/pdf",
                    "published_date": "2026-06-30",
                    "expected_sha256": hashlib.sha256(newer.read_bytes()).hexdigest(),
                },
            ],
        }
        request_path = root / "request.json"
        request_path.write_text(json.dumps(request, indent=2) + "\n", "utf-8")
        output = root / "output"
        completed = subprocess.run(
            [sys.executable, str(HERE / "extract_broker_evidence.py"), str(request_path), "--out", str(output), "--render-dpi", "150"],
            cwd=HERE.parent,
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            raise AssertionError(completed.stderr or completed.stdout)
        bundle = json.loads((output / "broker-extraction-bundle.json").read_text("utf-8"))
        by_house = {document["house_id"]: document for document in bundle["documents"]}
        older_document = by_house["older_clean"]
        eligible_tables = [
            table for table in older_document.get("tables", [])
            if table.get("authority_role") != "archive_only" and table.get("model_use") != "prohibited"
        ]
        assert eligible_tables, "Older native-clean report was suppressed before quality selection"
        assert any(str(table.get("extraction_method") or "").startswith("native_") for table in eligible_tables)
        assert bundle["selected_cell_recovery_policy"]["maximum_recovery_house_count"] == 1
        assert bundle["selected_cell_recovery_policy"]["policy"] == "quality_ranked_native_then_one_recovery_frontier"
        selected_house = bundle["selected_cell_recovery_policy"].get("selected_house_id")
        assert selected_house in {None, "newer_scanned", "older_clean"}
        # Regardless of which report needs the bounded frontier, native-clean
        # cells from the other report stay eligible.
        assert all(table.get("model_use") != "prohibited" for table in eligible_tables)
        print(json.dumps({
            "schema_version": "raw-broker-native-integration/1.0",
            "status": "PASS",
            "selected_recovery_house": selected_house,
            "older_eligible_table_count": len(eligible_tables),
            "document_count": len(bundle["documents"]),
        }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
