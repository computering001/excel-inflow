#!/usr/bin/env python3
"""Non-vacuous proof that broker vision work is demand- and cell-bounded."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from broker_terminal_recovery import canonical_hash
from compile_broker_vision import restrict_result_to_selected_cells


FORECAST_PERIODS = ["2027-12-31", "2028-12-31", "2029-12-31"]


def demand_graph() -> dict[str, Any]:
    nodes = [
        {
            "node_id": f"income_statement.revenue.fy{index + 1}",
            "section": "income_statement",
            "source_line_id": "revenue",
            "label": "Revenue",
            "parent_label": None,
            "period_end": period,
            "material": True,
            "has_historical_value": True,
            "allowed_authorities": ["selected_broker", "historical_inference"],
            "definition_signature_sha256": "b" * 64,
        }
        for index, period in enumerate(FORECAST_PERIODS)
    ]
    body = {
        "schema_version": "pre-broker-model-demand/1.0",
        "run_id": "selected_cell_recovery",
        "as_of": "2026-12-31",
        "reporting_currency": "USD",
        "units": "millions",
        "forecast_periods": FORECAST_PERIODS,
        "nodes": nodes,
        "counts": {"source_rows": 1, "forecast_nodes": 3, "material_nodes": 3},
    }
    return {**body, "graph_sha256": canonical_hash(body)}


def make_pdf(path: Path) -> None:
    import fitz  # type: ignore

    document = fitz.open()
    page = document.new_page()
    page.insert_textbox(
        fitz.Rect(40, 40, 550, 760),
        "Valuation summary\nTarget price 100\nP/E 20x\nEV/EBITDA 15x\nNo operating forecast rows on this page.",
        fontsize=12,
    )
    image_source = fitz.open()
    image_page = image_source.new_page()
    image_page.insert_textbox(
        fitz.Rect(40, 40, 550, 760),
        "Forecasts USDm\nMetric   2027E   2028E   2029E\nRevenue   100   110   120\nNet income   10   11   12",
        fontsize=18,
    )
    image_bytes = image_page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).tobytes("png")
    image_source.close()
    page = document.new_page()
    page.insert_image(page.rect, stream=image_bytes)
    document.save(path)
    document.close()


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    checks = 0
    with tempfile.TemporaryDirectory(prefix="broker-selected-cell-") as temporary:
        root = Path(temporary)
        pdf_path = root / "broker.pdf"
        make_pdf(pdf_path)
        request = {
            "schema_version": "broker-extraction-request/1.0",
            "run_id": "selected_cell_recovery",
            "model_context": {
                "as_of": "2026-12-31",
                "reporting_currency": "USD",
                "units": "millions",
                "forecast_periods": FORECAST_PERIODS,
                "model_demand_graph": demand_graph(),
            },
            "documents": [
                {
                    "document_id": "older",
                    "house_id": "older",
                    "house_name": "Older House",
                    "source_id": "older-source",
                    "path": str(pdf_path),
                    "media_type": "application/pdf",
                    "published_date": "2026-01-31",
                },
                {
                    "document_id": "latest",
                    "house_id": "latest",
                    "house_name": "Latest House",
                    "source_id": "latest-source",
                    "path": str(pdf_path),
                    "media_type": "application/pdf",
                    "published_date": "2026-12-31",
                },
            ],
        }
        request_path = root / "request.json"
        request_path.write_text(json.dumps(request), "utf-8")
        output = root / "out"
        completed = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("extract_broker_evidence.py")),
             str(request_path), "--out", str(output)],
            text=True,
            capture_output=True,
            check=False,
        )
        check(completed.returncode in {0, 2}, completed.stderr or completed.stdout); checks += 1
        bundle = json.loads((output / "broker-extraction-bundle.json").read_text("utf-8"))
        by_id = {item["document_id"]: item for item in bundle["documents"]}
        document = by_id["latest"]
        pages = document["surfaces"]
        page_images = [
            item for candidate in bundle["documents"]
            for item in candidate["artifacts"] if item["kind"] == "page_image"
        ]
        check(len(pages) == 2 and len(page_images) == 4, "every page was not preserved as an image"); checks += 1
        check(
            all(surface["lane_status"]["vision"] == "not_required" for surface in by_id["older"]["surfaces"]),
            "more than one house received optional OCR work",
        ); checks += 1
        check(pages[0]["model_demand_status"] == "archive_only_not_demanded", "irrelevant page did not close archive-only"); checks += 1
        check(pages[0]["lane_status"]["vision"] == "not_required", "irrelevant page still created OCR work"); checks += 1
        relevant = pages[1]
        check(relevant["selected_demand_metric_ids"] == ["revenue"], "relevant page did not inherit the sealed demand"); checks += 1
        task_artifact = next(
            item for item in document["artifacts"]
            if item["kind"] == "vision_task" and item["artifact_id"] in relevant["artifact_refs"]
        )
        task = json.loads((output / task_artifact["path"]).read_text("utf-8"))
        check(task["selected_cell_contract"]["targets"][0]["metric_id"] == "revenue", "task is not selected-cell bound"); checks += 1
        check("only the requested" in task["instruction"].casefold(), "task still requests a whole-page transcription"); checks += 1

        response = {
            "tables": [{
                "title": "Forecasts",
                "units": "USDm",
                "rows": [
                    ["Metric", "2027E", "2028E", "2029E"],
                    ["Revenue", "100", "110", "120"],
                    ["Net income", "10", "11", "12"],
                ],
            }],
        }
        projected = restrict_result_to_selected_cells(response, task)
        check(len(projected["tables"]) == 1, "selected result unexpectedly lost its demanded table"); checks += 1
        check(projected["tables"][0]["rows"] == [
            ["Metric", "2027E", "2028E", "2029E"],
            ["Revenue", "100", "110", "120"],
        ], "OCR widened authority beyond the selected Revenue row"); checks += 1

    print(json.dumps({"status": "PASS", "checks": checks, "violations": 0}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
