#!/usr/bin/env python3
"""Prove native quality outranks recency and recovery remains one-house bounded."""
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path

import fitz

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "broker_extractor", HERE / "extract_broker_evidence.py"
)
assert SPEC and SPEC.loader
broker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(broker)


def make_pdf(path: Path, text: str) -> None:
    document = fitz.open()
    page = document.new_page()
    if text:
        page.insert_textbox(fitz.Rect(40, 40, 555, 800), text, fontsize=9)
    document.save(path)
    document.close()


with tempfile.TemporaryDirectory(prefix="broker-native-eligibility-") as temporary:
    root = Path(temporary)
    older = root / "older.pdf"
    newest = root / "newest.pdf"
    make_pdf(
        older,
        "Revenue 2026E 100 2027E 110 2028E 120\n"
        "Adjusted EBITDA 20 22 24\n"
        "Depreciation and amortisation 5 5 6\n"
        "Effective tax rate 21% 22% 22%\n"
        "Capital expenditure 8 9 10\n"
        "Change in working capital -2 -2 -3\n"
        "Dividends 4 5 6",
    )
    make_pdf(newest, "")
    request = {
        "documents": [
            {
                "document_id": "older",
                "house_id": "older_house",
                "published_date": "2026-02-01",
                "media_type": "application/pdf",
                "path": str(older),
            },
            {
                "document_id": "newest",
                "house_id": "newest_house",
                "published_date": "2026-06-30",
                "media_type": "application/pdf",
                "path": str(newest),
            },
        ]
    }
    demand = {
        "targets": [
            {"metric_id": "revenue", "label": "Revenue"},
            {"metric_id": "adjusted_ebitda", "label": "Adjusted EBITDA"},
            {
                "metric_id": "depreciation_and_amortisation",
                "label": "Depreciation and amortisation",
            },
            {"metric_id": "effective_tax_rate", "label": "Effective tax rate"},
            {"metric_id": "capex", "label": "Capital expenditure"},
            {
                "metric_id": "change_in_working_capital",
                "label": "Change in working capital",
            },
            {"metric_id": "dividends", "label": "Dividends"},
        ]
    }
    assert broker.select_recovery_house_id(request, root, demand) == "older_house"

source = (HERE / "extract_broker_evidence.py").read_text("utf-8")
assert "unselected_house_recovery" in source
assert "archive_only = not selected_targets or unselected_house_recovery" in source
assert "archive_only = not selected_targets or unselected_house\n" not in source
assert "quality_ranked_native_then_one_recovery_frontier" in source
print({"status": "PASS", "checks": 5})
