#!/usr/bin/env python3
"""Mutation-sensitive tests for issuer-independent filing arithmetic ownership."""
from __future__ import annotations

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "filing_extractor", HERE / "extract_filing_statements.py"
)
assert SPEC and SPEC.loader
extractor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(extractor)


def rows(parent_label: str = "Product Revenue") -> list[dict]:
    return [
        {
            "source_line_id": "is.product_sales",
            "raw_label": "Product Sales",
            "values": [40.0, 50.0, 60.0],
            "hierarchy_level": 1,
            "is_subtotal": False,
        },
        {
            "source_line_id": "is.alliance_revenue",
            "raw_label": "Alliance Revenue",
            "values": [5.0, 6.0, 7.0],
            "hierarchy_level": 1,
            "is_subtotal": False,
        },
        {
            "source_line_id": "is.product_revenue",
            "raw_label": parent_label,
            "values": [45.0, 56.0, 67.0],
            "hierarchy_level": 0,
            "is_subtotal": False,
        },
        {
            "source_line_id": "is.collaboration_revenue",
            "raw_label": "Collaboration Revenue",
            "values": [2.0, 3.0, 4.0],
            "hierarchy_level": 1,
            "is_subtotal": False,
        },
        {
            "source_line_id": "is.total_revenue",
            "raw_label": "Total Revenue",
            "values": [47.0, 59.0, 71.0],
            "hierarchy_level": 0,
            "is_subtotal": True,
        },
    ]


checks = 0
base = rows()
extractor.infer_parent_links(base)
assert base[0]["parent_source_line_id"] == "is.product_revenue"
assert base[1]["parent_source_line_id"] == "is.product_revenue"
assert base[3]["parent_source_line_id"] == "is.total_revenue"
checks += 3

relabeled = rows("Issuer-defined aggregate X")
extractor.infer_parent_links(relabeled)
assert relabeled[0]["parent_source_line_id"] == "is.product_revenue"
assert relabeled[1]["parent_source_line_id"] == "is.product_revenue"
checks += 2

mutated = rows("Issuer-defined aggregate X")
mutated[2]["values"][1] += 10
extractor.infer_parent_links(mutated)
assert "parent_source_line_id" not in mutated[0]
assert "parent_source_line_id" not in mutated[1]
checks += 2

rounded = rows("Issuer-defined aggregate Y")
rounded[2]["values"] = [45.1, 55.9, 67.0]
extractor.infer_parent_links(rounded)
assert rounded[0]["parent_source_line_id"] == "is.product_revenue"
assert rounded[1]["parent_source_line_id"] == "is.product_revenue"
checks += 2

print({"status": "PASS", "checks": checks})
