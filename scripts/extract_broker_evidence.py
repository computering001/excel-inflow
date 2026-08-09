#!/usr/bin/env python3
"""Extract broker documents into a hash-bound, cell-level evidence bundle.

The extractor is deliberately conservative. Native PDF/XLSX/CSV structure is
captured deterministically. Pages whose numeric content cannot be reconstructed
confidently are rendered and emitted as explicit vision tasks; they are never
silently treated as complete.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


VERSION = "broker-evidence-extractor/1.1"
NUMERIC_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:\(?[-+]?[$€£¥]?\s*(?:\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d+)?%?\)?|[-+]?\d+(?:\.\d+)?x)(?![A-Za-z])",
)
SUPPORTED = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
    "text/csv",
    "text/plain",
    "text/markdown",
    "text/html",
    "application/json",
    "image/png",
    "image/jpeg",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def safe_id(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9_.-]+", "-", str(value).lower()).strip("-.")
    return cleaned or "item"


def normalise_numeric_token(value: Any) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not text or text in {"-", "–", "—"}:
        return None
    match = NUMERIC_RE.fullmatch(text)
    if not match:
        return None
    negative = text.startswith("(") and text.endswith(")")
    percent = "%" in text
    multiple = text.lower().endswith("x")
    cleaned = text.replace(",", "").replace(" ", "")
    cleaned = re.sub(r"[$€£¥%xX()]", "", cleaned)
    try:
        number = float(cleaned)
    except ValueError:
        return text
    if negative:
        number = -abs(number)
    if number == 0:
        number = 0.0
    formatted = str(int(number)) if float(number).is_integer() else format(number, ".15g")
    if percent:
        formatted += "%"
    if multiple:
        formatted += "x"
    return formatted


def numeric_tokens(text: str) -> list[str]:
    result: list[str] = []
    for match in NUMERIC_RE.finditer(text or ""):
        token = normalise_numeric_token(match.group(0))
        if token is not None:
            result.append(token)
    return result


def counter_difference(left: Iterable[str], right: Iterable[str]) -> list[str]:
    difference = Counter(left) - Counter(right)
    return sorted(token for token, count in difference.items() for _ in range(count))


def value_kind(value: Any, formula: str | None = None) -> str:
    if formula:
        return "formula"
    if value is None:
        return "blank"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (dt.date, dt.datetime, dt.time)):
        return "date"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "number"
    return "text"


def serialise_value(value: Any) -> Any:
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return str(value)
    return value


class ArtifactWriter:
    def __init__(self, root: Path, document_id: str):
        self.root = root
        self.document_id = safe_id(document_id)
        self.document_root = root / "artifacts" / self.document_id
        self.document_root.mkdir(parents=True, exist_ok=True)
        self.records: list[dict[str, Any]] = []

    def write(self, name: str, kind: str, data: bytes) -> str:
        path = self.document_root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        relative = path.relative_to(self.root).as_posix()
        artifact_id = f"{self.document_id}.{safe_id(name)}"
        self.records.append({
            "artifact_id": artifact_id,
            "kind": kind,
            "path": relative,
            "sha256": sha256_bytes(data),
        })
        return artifact_id

    def write_json(self, name: str, kind: str, value: Any) -> str:
        return self.write(name, kind, canonical_json(value))

    def write_text(self, name: str, kind: str, value: str) -> str:
        return self.write(name, kind, value.encode("utf-8"))


def cell_record(row: int, column: int, raw: Any, source_ref: str, *, formula: str | None = None,
                number_format: str | None = None, bbox: list[float] | None = None,
                confidence: float | None = 1.0) -> dict[str, Any]:
    value = serialise_value(raw)
    return {
        "row": row,
        "column": column,
        "raw_text": None if raw is None else str(serialise_value(raw)),
        "value": value,
        "value_kind": value_kind(raw, formula),
        "number_format": number_format,
        "formula": formula,
        "bbox": bbox,
        "source_ref": source_ref,
        "confidence": confidence,
    }


def table_tokens(table: dict[str, Any]) -> list[str]:
    tokens: list[str] = []
    for row in table["rows"]:
        for cell in row:
            token = normalise_numeric_token(cell.get("raw_text"))
            if token is not None:
                tokens.append(token)
    return tokens


def pdf_words_in_bbox(words: list[list[Any]], bbox: tuple[float, float, float, float]) -> list[str]:
    x0, y0, x1, y1 = bbox
    values: list[str] = []
    for word in words:
        wx0, wy0, wx1, wy1 = map(float, word[:4])
        cx, cy = (wx0 + wx1) / 2, (wy0 + wy1) / 2
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            values.extend(numeric_tokens(str(word[4])))
    return values


def bbox_iou(left: list[float] | tuple[float, ...] | None,
             right: list[float] | tuple[float, ...] | None) -> float:
    """Return intersection-over-union for two page-space rectangles."""
    if not left or not right or len(left) != 4 or len(right) != 4:
        return 0.0
    lx0, ly0, lx1, ly1 = map(float, left)
    rx0, ry0, rx1, ry1 = map(float, right)
    width = max(0.0, min(lx1, rx1) - max(lx0, rx0))
    height = max(0.0, min(ly1, ry1) - max(ly0, ry0))
    intersection = width * height
    union = max(0.0, (lx1 - lx0) * (ly1 - ly0)) + max(0.0, (rx1 - rx0) * (ry1 - ry0)) - intersection
    return 0.0 if union <= 0 else intersection / union


def word_numeric_records(words: list[list[Any]]) -> list[dict[str, Any]]:
    """Create the source-owned whole-surface numeric denominator.

    These records are generated before table discovery.  Later table or vision
    lanes may account for them, but may never create or remove them.
    """
    records: list[dict[str, Any]] = []
    for word_index, word in enumerate(words):
        raw = str(word[4])
        for token_index, token in enumerate(numeric_tokens(raw)):
            records.append({
                "token_id": f"w{word_index + 1}.n{token_index + 1}",
                "token": token,
                "raw_text": raw,
                "bbox": [float(value) for value in word[:4]],
                "block": int(word[5]),
                "line": int(word[6]),
                "word": int(word[7]),
            })
    return records


def record_inside_any_bbox(record: dict[str, Any], bboxes: list[list[float]]) -> bool:
    x0, y0, x1, y1 = map(float, record["bbox"])
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    return any(float(box[0]) <= cx <= float(box[2]) and float(box[1]) <= cy <= float(box[3]) for box in bboxes)


def uncovered_numeric_regions(records: list[dict[str, Any]], bboxes: list[list[float]]) -> list[dict[str, Any]]:
    """Cluster source numbers not covered by any discovered table rectangle."""
    uncovered = [record for record in records if not record_inside_any_bbox(record, bboxes)]
    by_line: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for record in uncovered:
        by_line.setdefault((record["block"], record["line"]), []).append(record)
    regions: list[dict[str, Any]] = []
    for region_index, ((block, line), items) in enumerate(sorted(by_line.items()), start=1):
        items.sort(key=lambda item: (item["bbox"][0], item["token_id"]))
        bbox = [
            min(item["bbox"][0] for item in items),
            min(item["bbox"][1] for item in items),
            max(item["bbox"][2] for item in items),
            max(item["bbox"][3] for item in items),
        ]
        regions.append({
            "region_id": f"uncovered-{region_index}",
            "block": block,
            "line": line,
            "bbox": bbox,
            "token_ids": [item["token_id"] for item in items],
            "tokens": [item["token"] for item in items],
            "material": len(items) >= 2,
            "disposition": "requires_vision" if len(items) >= 2 else "unclassified_singleton",
        })
    return regions


def table_context(words: list[list[Any]], bbox: list[float]) -> tuple[str | None, str | None, list[str]]:
    """Preserve nearby caption, unit and footnote text without interpreting metrics."""
    x0, y0, x1, y1 = map(float, bbox)
    above: list[tuple[float, str]] = []
    below: list[tuple[float, str]] = []
    for word in words:
        wx0, wy0, wx1, wy1 = map(float, word[:4])
        if wx1 < x0 - 20 or wx0 > x1 + 20:
            continue
        text = str(word[4]).strip()
        if not text:
            continue
        if 0 <= y0 - wy1 <= 42:
            above.append((wy0, text))
        elif 0 <= wy0 - y1 <= 48:
            below.append((wy0, text))
    caption = " ".join(text for _, text in sorted(above)) or None
    footnote_text = " ".join(text for _, text in sorted(below))
    footnotes = [footnote_text] if footnote_text else []
    unit_match = re.search(r"(?:in\s+)?(?:[$€£¥]|usd|eur|gbp)?\s*(?:m|mn|mm|bn|billions?|millions?|thousands?|%|x)\b", caption or "", re.I)
    units = unit_match.group(0).strip() if unit_match else None
    return caption, units, footnotes


def native_cell_bbox(native_table: Any, row_index: int, column_index: int) -> list[float] | None:
    try:
        row = native_table.rows[row_index - 1]
        bbox = row.cells[column_index - 1]
        return None if bbox is None else [float(value) for value in bbox]
    except Exception:
        return None


def extract_pdf(path: Path, descriptor: dict[str, Any], writer: ArtifactWriter,
                render_dpi: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], list[str], str]:
    try:
        import fitz  # type: ignore
    except Exception as error:  # pragma: no cover - environment-specific
        raise RuntimeError(f"PyMuPDF is required for PDF extraction: {error}") from error

    document = fitz.open(path)
    if document.needs_pass:
        password = descriptor.get("password") or ""
        if not document.authenticate(password):
            raise RuntimeError("PDF is encrypted and the supplied password did not authenticate.")

    surfaces: list[dict[str, Any]] = []
    tables: list[dict[str, Any]] = []
    source_table_tokens: list[str] = []
    captured_table_tokens: list[str] = []
    unresolved = False
    seen_images: set[int] = set()

    for page_index in range(document.page_count):
        page = document.load_page(page_index)
        surface_id = f"{descriptor['document_id']}.p{page_index + 1}"
        text = page.get_text("text", sort=True) or ""
        words = page.get_text("words", sort=True) or []
        text_ref = writer.write_text(f"pages/page-{page_index + 1:04d}.txt", "native_text", text)
        word_payload = [
            {"bbox": [float(v) for v in word[:4]], "text": str(word[4]), "block": int(word[5]), "line": int(word[6]), "word": int(word[7])}
            for word in words
        ]
        words_ref = writer.write_json(f"pages/page-{page_index + 1:04d}.words.json", "word_geometry", word_payload)

        # The source denominator is created before any table lane runs.  It is
        # deliberately the whole page rather than the union of accepted table
        # rectangles, which was the former self-certifying boundary.
        source_numeric_records = word_numeric_records(words)
        source_table_tokens.extend(record["token"] for record in source_numeric_records)

        discovery_specs = [
            ("lines", {}),
            ("lines_strict", {"vertical_strategy": "lines_strict", "horizontal_strategy": "lines_strict"}),
            ("text", {"vertical_strategy": "text", "horizontal_strategy": "text", "min_words_vertical": 2, "min_words_horizontal": 1}),
        ]
        page_tables: list[tuple[str, Any]] = []
        lane_summaries: list[dict[str, Any]] = []
        for lane_id, kwargs in discovery_specs:
            try:
                finder = page.find_tables(**kwargs)
                found = list(getattr(finder, "tables", []) or [])
                lane_summaries.append({"lane_id": lane_id, "status": "pass" if found else "empty", "candidate_count": len(found)})
                page_tables.extend((lane_id, item) for item in found)
            except Exception as error:
                lane_summaries.append({"lane_id": lane_id, "status": "error", "candidate_count": 0, "message": str(error)})

        table_bboxes: list[list[float]] = []
        for table_index, (lane_id, native_table) in enumerate(page_tables, start=1):
            extracted = native_table.extract() or []
            if not extracted:
                continue
            table_id = f"{surface_id}.{lane_id}-t{table_index}"
            bbox = [float(value) for value in native_table.bbox]
            table_bboxes.append(bbox)
            rows: list[list[dict[str, Any]]] = []
            for row_index, row in enumerate(extracted, start=1):
                cells: list[dict[str, Any]] = []
                for column_index, value in enumerate(row, start=1):
                    cells.append(cell_record(
                        row_index,
                        column_index,
                        value,
                        f"{path.name}#page={page_index + 1};lane={lane_id};table={table_index};r={row_index};c={column_index}",
                        bbox=native_cell_bbox(native_table, row_index, column_index),
                        confidence=0.98 if lane_id != "text" else 0.90,
                    ))
                rows.append(cells)
            caption, units, footnotes = table_context(words, bbox)
            table = {
                "table_id": table_id,
                "surface_id": surface_id,
                "source_location": f"page {page_index + 1}, {lane_id} table {table_index}",
                "title": caption,
                "units": units,
                "footnotes": footnotes,
                "bbox": bbox,
                "extraction_method": f"native_pdf_{lane_id}",
                "discovery_lane": lane_id,
                "confidence": 0.98 if lane_id != "text" else 0.90,
                "rows": rows,
            }
            tables.append(table)
            captured_table_tokens.extend(table_tokens(table))
            writer.write_json(f"tables/{safe_id(table_id)}.json", "table_json", table)

        uncovered_regions = uncovered_numeric_regions(source_numeric_records, table_bboxes)
        material_uncovered = [region for region in uncovered_regions if region["material"]]
        source_table_numeric_tokens = [
            record["token"] for record in source_numeric_records
            if record_inside_any_bbox(record, table_bboxes)
        ]
        census = {
            "schema_version": "broker-surface-census/1.0",
            "document_id": descriptor["document_id"],
            "surface_id": surface_id,
            "kind": "pdf_page",
            "source_numeric_tokens": source_numeric_records,
            "whole_surface_numeric_token_count": len(source_numeric_records),
            "source_table_numeric_tokens": source_table_numeric_tokens,
            "table_discovery_lanes": lane_summaries,
            "discovered_table_bboxes": table_bboxes,
            "uncovered_numeric_regions": uncovered_regions,
            "material_uncovered_region_count": len(material_uncovered),
        }
        census_ref = writer.write_json(f"census/page-{page_index + 1:04d}.json", "surface_census", census)

        image_infos = page.get_image_info(xrefs=True) or []
        page_area = max(float(page.rect.width * page.rect.height), 1.0)
        material_image = False
        image_refs: list[str] = []
        for image_index, info in enumerate(image_infos, start=1):
            bbox = info.get("bbox")
            if bbox:
                image_area = max(0.0, float((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])))
                if image_area / page_area >= 0.08:
                    material_image = True
            xref = int(info.get("xref") or 0)
            if xref <= 0 or xref in seen_images:
                continue
            seen_images.add(xref)
            try:
                extracted_image = document.extract_image(xref)
                extension = extracted_image.get("ext") or "bin"
                ref = writer.write(
                    f"images/xref-{xref}.{extension}",
                    "embedded_image",
                    extracted_image["image"],
                )
                image_refs.append(ref)
            except Exception:
                continue

        page_numeric_count = len(source_numeric_records)
        sparse = len(text.strip()) < 40
        undetected_numeric_grid = bool(material_uncovered)
        vision_required = (material_image and (page_numeric_count >= 2 or sparse)) or undetected_numeric_grid
        vision_reason = None
        if vision_required:
            unresolved = True
            reasons = []
            if material_image:
                reasons.append("material embedded image")
            if sparse:
                reasons.append("sparse native text")
            if undetected_numeric_grid:
                reasons.append(f"{len(material_uncovered)} material numeric region(s) outside discovered tables")
            vision_reason = "; ".join(reasons)

        artifact_refs = [text_ref, words_ref, census_ref, *image_refs]
        if vision_required or page_tables:
            matrix = fitz.Matrix(render_dpi / 72.0, render_dpi / 72.0)
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            page_image_ref = writer.write(
                f"pages/page-{page_index + 1:04d}.png",
                "page_image",
                pixmap.tobytes("png"),
            )
            artifact_refs.append(page_image_ref)
            if vision_required:
                task = {
                    "schema_version": "broker-vision-task/1.0",
                    "document_id": descriptor["document_id"],
                    "surface_id": surface_id,
                    "image_artifact_id": page_image_ref,
                    "reason": vision_reason,
                    "required_passes": 2,
                    "source_census_artifact_id": census_ref,
                    "uncovered_region_ids": [region["region_id"] for region in material_uncovered],
                    "instruction": "Inventory the complete page first, then transcribe every visible table cell, caption, unit and footnote independently. Preserve blanks, dashes, parentheses, percentages, units, period headings, bboxes and continuations. Return all tables, including tables already visible to native extraction; do not normalize metrics.",
                }
                task_ref = writer.write_json(
                    f"vision/page-{page_index + 1:04d}.task.json",
                    "vision_task",
                    task,
                )
                artifact_refs.append(task_ref)

        surfaces.append({
            "surface_id": surface_id,
            "kind": "pdf_page",
            "ordinal": page_index + 1,
            "label": f"Page {page_index + 1}",
            "width": float(page.rect.width),
            "height": float(page.rect.height),
            "native_text_chars": len(text),
            "native_word_count": len(words),
            "numeric_token_count": page_numeric_count,
            "table_count": len([table for table in tables if table["surface_id"] == surface_id]),
            "image_count": len(image_infos),
            "artifact_refs": artifact_refs,
            "lane_status": {
                "native_text": "pass" if text.strip() else "empty",
                "geometry": "pass" if words else "empty",
                "tables": "pass" if page_tables else ("error" if all(item["status"] == "error" for item in lane_summaries) else "none"),
                "images": "pass" if image_infos else "none",
                "vision": "required" if vision_required else "not_required",
            },
            "surface_census_artifact_id": census_ref,
            "whole_surface_numeric_token_count": len(source_numeric_records),
            "source_table_numeric_tokens": source_table_numeric_tokens,
            "uncovered_numeric_regions": uncovered_regions,
            "table_discovery_lanes": lane_summaries,
            "vision_reason": vision_reason,
        })

    return surfaces, tables, source_table_tokens, captured_table_tokens, "needs_vision" if unresolved else "complete"


def extract_xlsx(path: Path, descriptor: dict[str, Any], writer: ArtifactWriter) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], list[str], str]:
    try:
        import openpyxl  # type: ignore
    except Exception as error:  # pragma: no cover - environment-specific
        raise RuntimeError(f"openpyxl is required for workbook extraction: {error}") from error

    keep_vba = descriptor["media_type"].endswith("macroEnabled.12")
    formula_book = openpyxl.load_workbook(path, data_only=False, read_only=False, keep_vba=keep_vba)
    value_book = openpyxl.load_workbook(path, data_only=True, read_only=False, keep_vba=keep_vba)
    surfaces: list[dict[str, Any]] = []
    tables: list[dict[str, Any]] = []
    source_tokens: list[str] = []
    captured_tokens: list[str] = []

    for sheet_index, sheet in enumerate(formula_book.worksheets, start=1):
        value_sheet = value_book[sheet.title]
        nonempty = [cell for row in sheet.iter_rows() for cell in row if cell.value is not None]
        if not nonempty:
            min_row = min_col = 1
            max_row = max_col = 1
        else:
            min_row = min(cell.row for cell in nonempty)
            max_row = max(cell.row for cell in nonempty)
            min_col = min(cell.column for cell in nonempty)
            max_col = max(cell.column for cell in nonempty)
        cell_span = (max_row - min_row + 1) * (max_col - min_col + 1)
        if cell_span > 200000:
            raise RuntimeError(f"Workbook sheet {sheet.title!r} has a {cell_span:,}-cell used rectangle; trim the workbook before extraction.")
        surface_id = f"{descriptor['document_id']}.s{sheet_index}"
        source_cell_records: list[dict[str, Any]] = []
        for formula_cell in nonempty:
            value_cell = value_sheet[formula_cell.coordinate]
            formula = str(formula_cell.value) if formula_cell.data_type == "f" else None
            value = value_cell.value if formula else formula_cell.value
            token = normalise_numeric_token(value)
            source_cell_records.append({
                "cell": formula_cell.coordinate,
                "row": formula_cell.row,
                "column": formula_cell.column,
                "raw_value": serialise_value(formula_cell.value),
                "display_value": serialise_value(value),
                "formula": formula,
                "number_format": formula_cell.number_format,
                "numeric_token": token,
                "bold": bool(formula_cell.font.bold),
                "indent": float(formula_cell.alignment.indent or 0),
                "row_hidden": bool(sheet.row_dimensions[formula_cell.row].hidden),
                "column_hidden": bool(sheet.column_dimensions[formula_cell.column_letter].hidden),
            })
            if token is not None:
                source_tokens.append(token)
        rows: list[list[dict[str, Any]]] = []
        for row_number in range(min_row, max_row + 1):
            cells: list[dict[str, Any]] = []
            for column_number in range(min_col, max_col + 1):
                formula_cell = sheet.cell(row_number, column_number)
                value_cell = value_sheet.cell(row_number, column_number)
                formula = str(formula_cell.value) if formula_cell.data_type == "f" else None
                value = value_cell.value if formula else formula_cell.value
                record = cell_record(
                    row_number - min_row + 1,
                    column_number - min_col + 1,
                    value,
                    f"{path.name}#sheet={sheet.title};cell={formula_cell.coordinate}",
                    formula=formula,
                    number_format=formula_cell.number_format,
                    confidence=1.0,
                )
                record["address"] = formula_cell.coordinate
                record["bold"] = bool(formula_cell.font.bold)
                record["indent"] = float(formula_cell.alignment.indent or 0)
                cells.append(record)
                token = normalise_numeric_token(value)
                if token is not None:
                    captured_tokens.append(token)
            rows.append(cells)
        table_id = f"{surface_id}.used-range"
        table = {
            "table_id": table_id,
            "surface_id": surface_id,
            "source_location": f"sheet {sheet.title}, {sheet.cell(min_row, min_col).coordinate}:{sheet.cell(max_row, max_col).coordinate}",
            "title": sheet.title,
            "units": None,
            "bbox": None,
            "extraction_method": "xlsx_cells",
            "confidence": 1.0,
            "rows": rows,
        }
        tables.append(table)
        grid_ref = writer.write_json(f"sheets/{sheet_index:03d}-{safe_id(sheet.title)}.json", "xlsx_grid", table)
        census = {
            "schema_version": "broker-surface-census/1.0",
            "document_id": descriptor["document_id"],
            "surface_id": surface_id,
            "kind": "workbook_sheet",
            "source_cells": source_cell_records,
            "nonblank_cell_count": len(source_cell_records),
            "whole_surface_numeric_token_count": sum(1 for cell in source_cell_records if cell["numeric_token"] is not None),
            "source_table_numeric_tokens": [cell["numeric_token"] for cell in source_cell_records if cell["numeric_token"] is not None],
            "merged_ranges": sorted(str(item) for item in sheet.merged_cells.ranges),
            "hidden_rows": sorted(index for index, dimension in sheet.row_dimensions.items() if dimension.hidden),
            "hidden_columns": sorted(key for key, dimension in sheet.column_dimensions.items() if dimension.hidden),
            "table_discovery_lanes": [{"lane_id": "xlsx_used_range", "status": "pass", "candidate_count": 1}],
            "uncovered_numeric_regions": [],
            "material_uncovered_region_count": 0,
        }
        census_ref = writer.write_json(f"census/sheet-{sheet_index:04d}.json", "surface_census", census)
        surfaces.append({
            "surface_id": surface_id,
            "kind": "workbook_sheet",
            "ordinal": sheet_index,
            "label": sheet.title,
            "width": float(max_col - min_col + 1),
            "height": float(max_row - min_row + 1),
            "native_text_chars": sum(len(str(cell.value)) for cell in nonempty),
            "native_word_count": len(nonempty),
            "numeric_token_count": len(table_tokens(table)),
            "table_count": 1,
            "image_count": len(getattr(sheet, "_images", [])),
            "artifact_refs": [grid_ref, census_ref],
            "lane_status": {
                "native_text": "pass",
                "geometry": "pass",
                "tables": "pass",
                "images": "unsupported" if getattr(sheet, "_images", []) else "none",
                "vision": "not_required",
            },
            "surface_census_artifact_id": census_ref,
            "whole_surface_numeric_token_count": census["whole_surface_numeric_token_count"],
            "source_table_numeric_tokens": [cell["numeric_token"] for cell in source_cell_records if cell["numeric_token"] is not None],
            "uncovered_numeric_regions": [],
            "table_discovery_lanes": census["table_discovery_lanes"],
            "vision_reason": None,
        })
    return surfaces, tables, source_tokens, captured_tokens, "complete"


def extract_image(path: Path, descriptor: dict[str, Any], writer: ArtifactWriter) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], list[str], str]:
    """Preserve a standalone broker-table image and emit a bound vision task.

    No OCR output is accepted here.  The image remains NEEDS_VISION until
    compile_broker_vision.py receives two independently produced, hash-bound
    cell transcriptions (or an explicit reviewed resolution).
    """
    try:
        import fitz  # type: ignore
    except Exception as error:  # pragma: no cover - environment-specific
        raise RuntimeError(f"PyMuPDF is required for standalone image extraction: {error}") from error
    raw = path.read_bytes()
    image_document = fitz.open(path)
    if image_document.page_count != 1:
        image_document.close()
        raise RuntimeError("A standalone image must decode to exactly one surface.")
    image_page = image_document.load_page(0)
    width, height = image_page.rect.width, image_page.rect.height
    image_document.close()
    surface_id = f"{descriptor['document_id']}.i1"
    image_ref = writer.write("pages/page-0001.png", "page_image", raw)
    census = {
        "schema_version": "broker-surface-census/1.0",
        "document_id": descriptor["document_id"],
        "surface_id": surface_id,
        "kind": "image_page",
        "source_numeric_tokens": [],
        "whole_surface_numeric_token_count": None,
        "source_table_numeric_tokens": [],
        "table_discovery_lanes": [{"lane_id": "native", "status": "unsupported", "candidate_count": 0}],
        "uncovered_numeric_regions": [{
            "region_id": "full-image",
            "bbox": [0.0, 0.0, float(width), float(height)],
            "token_ids": [],
            "tokens": [],
            "material": True,
            "disposition": "requires_vision",
        }],
        "material_uncovered_region_count": 1,
    }
    census_ref = writer.write_json("census/image-0001.json", "surface_census", census)
    task = {
        "schema_version": "broker-vision-task/1.0",
        "document_id": descriptor["document_id"],
        "surface_id": surface_id,
        "image_artifact_id": image_ref,
        "source_census_artifact_id": census_ref,
        "uncovered_region_ids": ["full-image"],
        "instruction": "Inventory the complete image, then transcribe every visible table cell, caption, unit and footnote in reading order. Preserve labels, blanks, signs, units, periods, bboxes and column positions. Do not normalize metrics.",
        "required_independent_passes": 2,
    }
    task_ref = writer.write_json("vision/image-0001.task.json", "vision_task", task)
    surface = {
        "surface_id": surface_id,
        "kind": "image_page",
        "ordinal": 1,
        "label": path.name,
        "width": float(width),
        "height": float(height),
        "native_text_chars": 0,
        "native_word_count": 0,
        "numeric_token_count": 0,
        "table_count": 0,
        "image_count": 1,
        "artifact_refs": [image_ref, census_ref, task_ref],
        "lane_status": {
            "native_text": "empty",
            "geometry": "unsupported",
            "tables": "none",
            "images": "pass",
            "vision": "required",
        },
        "surface_census_artifact_id": census_ref,
        "whole_surface_numeric_token_count": None,
        "source_table_numeric_tokens": [],
        "uncovered_numeric_regions": census["uncovered_numeric_regions"],
        "table_discovery_lanes": census["table_discovery_lanes"],
        "vision_reason": "Standalone image requires two-pass cell-addressed table transcription.",
    }
    return [surface], [], [], [], "needs_vision"


def rectangular_rows(raw_rows: list[list[Any]], source_name: str, surface_id: str,
                     method: str) -> dict[str, Any]:
    width = max((len(row) for row in raw_rows), default=1)
    rows: list[list[dict[str, Any]]] = []
    for row_index, raw_row in enumerate(raw_rows, start=1):
        cells = []
        for column_index in range(1, width + 1):
            value = raw_row[column_index - 1] if column_index <= len(raw_row) else None
            cells.append(cell_record(
                row_index,
                column_index,
                value,
                f"{source_name}#r={row_index};c={column_index}",
                confidence=1.0,
            ))
        rows.append(cells)
    return {
        "table_id": f"{surface_id}.table-1",
        "surface_id": surface_id,
        "source_location": "entire document",
        "title": None,
        "units": None,
        "bbox": None,
        "extraction_method": method,
        "confidence": 1.0,
        "rows": rows,
    }


def extract_delimited_or_text(path: Path, descriptor: dict[str, Any], writer: ArtifactWriter) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], list[str], str]:
    text = path.read_text("utf-8-sig")
    surface_id = f"{descriptor['document_id']}.text"
    text_ref = writer.write_text("document.txt", "native_text", text)
    media_type = descriptor["media_type"]
    rows: list[list[Any]] = []
    method = "csv"
    if media_type == "application/json":
        value = json.loads(text)
        if isinstance(value, list) and all(isinstance(row, list) for row in value):
            rows = value
        else:
            rows = [[json.dumps(value, sort_keys=True, ensure_ascii=False)]]
        method = "json"
    elif media_type == "text/csv":
        rows = [list(row) for row in csv.reader(text.splitlines())]
    else:
        for line in text.splitlines():
            if "\t" in line:
                rows.append(line.split("\t"))
            elif "," in line:
                rows.append(next(csv.reader([line])))
            else:
                rows.append([line])
    if not rows:
        rows = [[None]]
    table = rectangular_rows(rows, path.name, surface_id, method)
    table_ref = writer.write_json("table.json", "table_json", table)
    source_tokens = numeric_tokens(text)
    captured_tokens = table_tokens(table)
    census = {
        "schema_version": "broker-surface-census/1.0",
        "document_id": descriptor["document_id"],
        "surface_id": surface_id,
        "kind": "text_document",
        "source_numeric_tokens": [
            {"token_id": f"n{index}", "token": token, "raw_text": token, "bbox": None}
            for index, token in enumerate(source_tokens, start=1)
        ],
        "whole_surface_numeric_token_count": len(source_tokens),
        "source_table_numeric_tokens": source_tokens,
        "table_discovery_lanes": [{"lane_id": method, "status": "pass", "candidate_count": 1}],
        "uncovered_numeric_regions": [],
        "material_uncovered_region_count": 0,
    }
    census_ref = writer.write_json("census/document.json", "surface_census", census)
    surface = {
        "surface_id": surface_id,
        "kind": "text_document",
        "ordinal": 1,
        "label": path.name,
        "width": float(max(len(row) for row in rows)),
        "height": float(len(rows)),
        "native_text_chars": len(text),
        "native_word_count": len(text.split()),
        "numeric_token_count": len(numeric_tokens(text)),
        "table_count": 1,
        "image_count": 0,
        "artifact_refs": [text_ref, table_ref, census_ref],
        "lane_status": {
            "native_text": "pass",
            "geometry": "unsupported",
            "tables": "pass",
            "images": "none",
            "vision": "not_required",
        },
        "surface_census_artifact_id": census_ref,
        "whole_surface_numeric_token_count": len(source_tokens),
        "source_table_numeric_tokens": source_tokens,
        "uncovered_numeric_regions": [],
        "table_discovery_lanes": census["table_discovery_lanes"],
        "vision_reason": None,
    }
    return [surface], [table], source_tokens, captured_tokens, "complete"


def build_ledger(source_tokens: list[str], captured_tokens: list[str]) -> dict[str, Any]:
    missing = counter_difference(source_tokens, captured_tokens)
    extra = counter_difference(captured_tokens, source_tokens)
    denominator = len(source_tokens)
    recall = 1.0 if denominator == 0 else max(0.0, (denominator - len(missing)) / denominator)
    return {
        "source_tokens": source_tokens,
        "captured_tokens": captured_tokens,
        "missing_tokens": missing,
        "duplicate_tokens": extra,
        "recall": recall,
        "denominator_scope": "whole_surface",
        "captured_scope": "discovered_table_cells",
    }


def extract_document(root: Path, request_dir: Path, descriptor: dict[str, Any], render_dpi: int) -> dict[str, Any]:
    media_type = descriptor["media_type"]
    if media_type not in SUPPORTED:
        raise RuntimeError(f"Unsupported media type {media_type!r}.")
    source_path = Path(descriptor["path"])
    if not source_path.is_absolute():
        source_path = (request_dir / source_path).resolve()
    if not source_path.is_file():
        raise RuntimeError(f"Broker source does not exist: {source_path}")
    raw_hash = sha256_file(source_path)
    if descriptor.get("expected_sha256") and descriptor["expected_sha256"] != raw_hash:
        raise RuntimeError(f"{descriptor['document_id']} expected_sha256 does not match its bytes.")
    writer = ArtifactWriter(root, descriptor["document_id"])
    if media_type == "application/pdf":
        surfaces, tables, source_tokens, captured_tokens, status = extract_pdf(source_path, descriptor, writer, render_dpi)
    elif media_type in {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel.sheet.macroEnabled.12",
    }:
        surfaces, tables, source_tokens, captured_tokens, status = extract_xlsx(source_path, descriptor, writer)
    elif media_type in {"image/png", "image/jpeg"}:
        surfaces, tables, source_tokens, captured_tokens, status = extract_image(source_path, descriptor, writer)
    else:
        surfaces, tables, source_tokens, captured_tokens, status = extract_delimited_or_text(source_path, descriptor, writer)
    ledger = build_ledger(source_tokens, captured_tokens)
    return {
        "document_id": descriptor["document_id"],
        "house_id": descriptor["house_id"],
        "house_name": descriptor["house_name"],
        "source_id": descriptor["source_id"],
        "file_name": source_path.name,
        "media_type": media_type,
        "published_date": descriptor["published_date"],
        "raw_sha256": raw_hash,
        "byte_length": source_path.stat().st_size,
        "surfaces": surfaces,
        "tables": tables,
        "numeric_ledger": ledger,
        "artifacts": writer.records,
        "extraction_status": status,
    }


def validate_request(request: dict[str, Any]) -> None:
    if request.get("schema_version") != "broker-extraction-request/1.0":
        raise ValueError("Unsupported broker extraction request schema_version.")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", str(request.get("run_id", ""))):
        raise ValueError("run_id must be a stable lower-case identifier.")
    documents = request.get("documents")
    if not isinstance(documents, list) or not 1 <= len(documents) <= 10:
        raise ValueError("documents must contain 1-10 broker sources.")
    required = {"document_id", "house_id", "house_name", "source_id", "path", "media_type", "published_date"}
    seen_documents: set[str] = set()
    for index, descriptor in enumerate(documents):
        missing = sorted(required - set(descriptor or {}))
        if missing:
            raise ValueError(f"documents[{index}] is missing {', '.join(missing)}.")
        if descriptor["document_id"] in seen_documents:
            raise ValueError(f"Duplicate document_id {descriptor['document_id']!r}.")
        seen_documents.add(descriptor["document_id"])


def tool_versions() -> dict[str, Any]:
    versions: dict[str, Any] = {"python": sys.version.split()[0]}
    try:
        import fitz  # type: ignore
        versions["pymupdf"] = getattr(fitz, "VersionBind", getattr(fitz, "__version__", "unknown"))
    except Exception:
        versions["pymupdf"] = None
    try:
        import openpyxl  # type: ignore
        versions["openpyxl"] = getattr(openpyxl, "__version__", "unknown")
    except Exception:
        versions["openpyxl"] = None
    return versions


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", help="broker-extraction-request/1.0 JSON")
    parser.add_argument("--out", required=True, help="output directory outside the skill tree")
    parser.add_argument("--render-dpi", type=int, default=120)
    args = parser.parse_args()
    request_path = Path(args.request).resolve()
    output_root = Path(args.out).resolve()
    request = json.loads(request_path.read_text("utf-8"))
    validate_request(request)
    output_root.mkdir(parents=True, exist_ok=True)

    documents: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    for descriptor in request["documents"]:
        try:
            documents.append(extract_document(output_root, request_path.parent, descriptor, args.render_dpi))
        except Exception as error:
            findings.append({
                "id": "broker_extraction.document_failed",
                "severity": "blocker",
                "document_id": descriptor.get("document_id"),
                "surface_id": None,
                "message": str(error),
            })

    unresolved = sum(
        1
        for document in documents
        for surface in document["surfaces"]
        if surface["lane_status"]["vision"] == "required"
    )
    for document in documents:
        if document["numeric_ledger"]["missing_tokens"]:
            findings.append({
                "id": "broker_extraction.numeric_tokens_outside_tables",
                "severity": "warning",
                "document_id": document["document_id"],
                "surface_id": None,
                "message": f"{len(document['numeric_ledger']['missing_tokens'])} whole-surface numeric tokens are outside discovered table cells; their regions remain explicit in the surface census.",
            })
        if document["extraction_status"] == "needs_vision":
            findings.append({
                "id": "broker_extraction.vision_required",
                "severity": "warning",
                "document_id": document["document_id"],
                "surface_id": None,
                "message": "One or more pages require two-pass vision transcription before normalization.",
            })

    if any(item["severity"] == "blocker" for item in findings):
        gate_status = "BLOCKED"
    elif unresolved:
        gate_status = "NEEDS_VISION"
    else:
        gate_status = "PASS"
    surface_count = sum(len(document["surfaces"]) for document in documents)
    table_count = sum(len(document["tables"]) for document in documents)
    cell_count = sum(len(row) for document in documents for table in document["tables"] for row in table["rows"])
    source_token_count = sum(len(document["numeric_ledger"]["source_tokens"]) for document in documents)
    missing_token_count = sum(len(document["numeric_ledger"]["missing_tokens"]) for document in documents)
    recall = 1.0 if source_token_count == 0 else (source_token_count - missing_token_count) / source_token_count
    duplicate_count = sum(len(document["numeric_ledger"]["duplicate_tokens"]) for document in documents)
    uncovered_region_count = sum(
        len(surface.get("uncovered_numeric_regions", []))
        for document in documents for surface in document["surfaces"]
    )
    material_uncovered_region_count = sum(
        sum(1 for region in surface.get("uncovered_numeric_regions", []) if region.get("material"))
        for document in documents for surface in document["surfaces"]
    )
    bundle = {
        "schema_version": "broker-extraction-bundle/1.0",
        "run_id": request["run_id"],
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "extractor_version": VERSION,
        "tool_versions": tool_versions(),
        "artifact_root": str(output_root),
        "documents": documents,
        "summary": {
            "document_count": len(documents),
            "surface_count": surface_count,
            "table_count": table_count,
            "cell_count": cell_count,
            "numeric_token_count": source_token_count,
            "native_numeric_recall": recall,
            "unresolved_surface_count": unresolved,
            "duplicate_cell_count": duplicate_count,
            "uncovered_numeric_region_count": uncovered_region_count,
            "material_uncovered_region_count": material_uncovered_region_count,
        },
        "gate_status": gate_status,
        "findings": findings,
    }
    bundle_path = output_root / "broker-extraction-bundle.json"
    bundle_path.write_bytes(canonical_json(bundle))
    print(json.dumps({
        "status": gate_status,
        "bundle": str(bundle_path),
        "documents": len(documents),
        "surfaces": surface_count,
        "tables": table_count,
        "cells": cell_count,
        "native_numeric_recall": recall,
        "unresolved_surfaces": unresolved,
    }, sort_keys=True))
    return 0 if gate_status != "BLOCKED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
