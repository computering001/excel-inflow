#!/usr/bin/env python3
"""Compile verified broker evidence and a semantic crosswalk into model inputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any


NUMBER = re.compile(r"^\s*(\()?\s*[-+]?[$€£¥]?\s*(\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.(\d+))?\s*(%)?\s*\)?\s*$")
REQUIRED_METRICS = {
    "revenue",
    "depreciation_and_amortisation",
    "effective_tax_rate",
    "capex",
    "change_in_working_capital",
    "dividends",
}


def parse_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or value is None:
        raise ValueError(f"{label} is not numeric.")
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip()
        match = NUMBER.fullmatch(text)
        if not match:
            raise ValueError(f"{label}={value!r} is not an unambiguous numeric cell.")
        negative = bool(match.group(1)) or text.startswith("-")
        cleaned = re.sub(r"[$€£¥,%() ]", "", text)
        number = float(cleaned)
        if negative:
            number = -abs(number)
        if match.group(4):
            number /= 100.0
    if not math.isfinite(number):
        raise ValueError(f"{label} is not finite.")
    return number


def scalar_rows(table: dict[str, Any]) -> list[list[Any]]:
    return [[cell.get("value") for cell in row] for row in table["rows"]]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    parser.add_argument("crosswalk")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    bundle = json.loads(Path(args.bundle).read_text("utf-8"))
    crosswalk = json.loads(Path(args.crosswalk).read_text("utf-8"))
    output_root = Path(args.out).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    if bundle.get("schema_version") != "broker-extraction-bundle/1.0" or bundle.get("gate_status") != "PASS":
        raise ValueError("Broker evidence must be a PASS broker-extraction-bundle/1.0 before semantic mapping.")
    if crosswalk.get("schema_version") != "broker-crosswalk/1.0":
        raise ValueError("Unsupported broker crosswalk schema.")
    if crosswalk.get("run_id") != bundle.get("run_id"):
        raise ValueError("The crosswalk run_id is not bound to the extraction bundle.")
    bundle_sha256 = hashlib.sha256(Path(args.bundle).read_bytes()).hexdigest()

    documents_by_house: dict[str, dict[str, Any]] = {}
    tables: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    for document in bundle["documents"]:
        house_id = document["house_id"]
        if house_id in documents_by_house:
            raise ValueError(f"More than one document is assigned to house_id {house_id!r}; consolidate the evidence deliberately before compilation.")
        documents_by_house[house_id] = document
        for table in document["tables"]:
            table_id = table["table_id"]
            if table_id in tables:
                raise ValueError(f"Duplicate table_id {table_id!r}.")
            tables[table_id] = (document, table)

    if not 3 <= len(documents_by_house) <= 10:
        raise ValueError("A production broker pack requires 3-10 distinct houses.")
    metrics = crosswalk.get("metrics") or {}
    missing_metrics = sorted(REQUIRED_METRICS - set(metrics))
    if missing_metrics:
        raise ValueError(f"The crosswalk is missing required metrics: {', '.join(missing_metrics)}.")
    if not ({"ebit", "adjusted_ebitda"} & set(metrics)):
        raise ValueError("The crosswalk requires at least one headline metric: EBIT or Adjusted EBITDA.")
    if len(crosswalk.get("forecast_periods") or []) != 3:
        raise ValueError("The broker crosswalk must declare exactly three forecast periods.")

    estimates: dict[str, dict[str, list[float | None]]] = {
        house_id: {metric_id: [None, None, None] for metric_id in metrics}
        for house_id in documents_by_house
    }
    mapping_receipts = []
    occupied: set[tuple[str, str, int]] = set()
    for index, mapping in enumerate(crosswalk.get("mappings") or []):
        house_id = mapping.get("house_id")
        metric_id = mapping.get("metric_id")
        period_index = mapping.get("period_index")
        key = (house_id, metric_id, period_index)
        if house_id not in documents_by_house:
            raise ValueError(f"mappings[{index}] names unknown house_id {house_id!r}.")
        if metric_id not in metrics:
            raise ValueError(f"mappings[{index}] names undeclared metric_id {metric_id!r}.")
        if period_index not in {0, 1, 2}:
            raise ValueError(f"mappings[{index}] has invalid period_index.")
        if key in occupied:
            raise ValueError(f"Duplicate broker mapping for {key}.")
        occupied.add(key)
        components = []
        total = float(mapping.get("constant", 0.0))
        for component_index, component in enumerate(mapping.get("sources") or []):
            table_id = component.get("table_id")
            if table_id not in tables:
                raise ValueError(f"mappings[{index}].sources[{component_index}] names unknown table {table_id!r}.")
            document, table = tables[table_id]
            if document["house_id"] != house_id:
                raise ValueError(f"mappings[{index}] reaches across houses from {house_id!r} to {document['house_id']!r}.")
            row = int(component.get("row", 0))
            column = int(component.get("column", 0))
            try:
                cell = table["rows"][row - 1][column - 1]
            except (IndexError, TypeError):
                raise ValueError(f"mappings[{index}] cell {table_id}!R{row}C{column} does not exist.")
            coefficient = float(component.get("coefficient", 0.0))
            raw_value = parse_number(cell.get("value"), f"{table_id}!R{row}C{column}")
            contribution = raw_value * coefficient
            total += contribution
            components.append({
                "table_id": table_id,
                "row": row,
                "column": column,
                "source_ref": cell["source_ref"],
                "raw_value": raw_value,
                "coefficient": coefficient,
                "contribution": contribution,
            })
        multiplier = float(mapping.get("multiplier", 1.0))
        total *= multiplier
        estimates[house_id][metric_id][period_index] = total
        mapping_receipts.append({
            "house_id": house_id,
            "metric_id": metric_id,
            "period_index": period_index,
            "components": components,
            "constant": float(mapping.get("constant", 0.0)),
            "multiplier": multiplier,
            "value": total,
            "rationale": mapping.get("rationale"),
            "review_status": mapping.get("review_status", "reviewed"),
        })

    source_label = crosswalk.get("source_label") or (
        f"{len(documents_by_house)}-house broker pack extracted and cell-crosswalked from hash-bound source documents"
    )
    houses = []
    for house_id, document in documents_by_house.items():
        has_native = any(
            int(surface.get("native_text_chars", 0)) > 0
            or surface.get("kind") == "workbook_sheet"
            for surface in document.get("surfaces", [])
        )
        has_verified_image = any(
            table.get("extraction_method") in {"vision_pass_consensus", "manual_verified"}
            for table in document.get("tables", [])
        )
        if not has_native and not has_verified_image:
            raise ValueError(
                f"{document['file_name']} has neither native evidence nor a verified image transcription."
            )
        extraction_method = (
            "mixed_verified" if has_native and has_verified_image
            else "verified_image_transcription" if has_verified_image
            else "native"
        )
        houses.append({
            "house_id": house_id,
            "house_name": document["house_name"],
            "published_date": document["published_date"],
            "analyst": None,
            "document": {
                "file_name": document["file_name"],
                "media_type": document["media_type"],
                "text_extractable": has_native,
                "extraction_method": extraction_method,
                "extraction_evidence_sha256": bundle_sha256,
                "page_reference": "See broker-source-tables.json and broker-crosswalk-receipt.json",
            },
            "estimates": estimates[house_id],
        })
    broker_pack = {
        "schema_version": "broker-pack/1.0",
        "pack_kind": "broker_forecast_set",
        "as_of": crosswalk["as_of"],
        "source_label": source_label,
        "reporting_currency": crosswalk["reporting_currency"],
        "units": crosswalk["units"],
        "forecast_periods": crosswalk["forecast_periods"],
        "metrics": metrics,
        "houses": houses,
        **({"provider_consensus": crosswalk["provider_consensus"]} if crosswalk.get("provider_consensus") else {}),
    }
    broker_sources = {
        "schema_version": "broker-source-tables/1.0",
        "run_id": bundle["run_id"],
        "houses": [
            {
                "house_id": document["house_id"],
                "house_name": document["house_name"],
                "source_id": document["source_id"],
                "content_sha256": document["raw_sha256"],
                "published_date": document["published_date"],
                "file_name": document["file_name"],
                "tables": [
                    {
                        "table_id": table["table_id"],
                        "title": table.get("title"),
                        "source_location": table["source_location"],
                        "units": table.get("units"),
                        "extraction_method": table["extraction_method"],
                        "rows": scalar_rows(table),
                    }
                    for table in document["tables"]
                ],
            }
            for document in bundle["documents"]
        ],
    }
    receipt = {
        "schema_version": "broker-crosswalk-receipt/1.0",
        "run_id": bundle["run_id"],
        "bundle_sha256": bundle_sha256,
        "crosswalk_sha256": hashlib.sha256(Path(args.crosswalk).read_bytes()).hexdigest(),
        "mapping_count": len(mapping_receipts),
        "mappings": mapping_receipts,
        "status": "PASS",
    }
    (output_root / "broker-pack.json").write_text(json.dumps(broker_pack, indent=2, ensure_ascii=False) + "\n", "utf-8")
    (output_root / "broker-source-tables.json").write_text(json.dumps(broker_sources, indent=2, ensure_ascii=False) + "\n", "utf-8")
    (output_root / "broker-crosswalk-receipt.json").write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(json.dumps({"status": "PASS", "houses": len(houses), "mappings": len(mapping_receipts), "metrics": len(metrics)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
