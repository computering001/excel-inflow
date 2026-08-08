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


VERSION = "broker-evidence-extractor/1.0"
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

        page_tables: list[Any] = []
        table_status = "none"
        try:
            finder = page.find_tables()
            page_tables = list(getattr(finder, "tables", []) or [])
            table_status = "pass" if page_tables else "none"
        except Exception:
            table_status = "error"

        for table_index, native_table in enumerate(page_tables, start=1):
            extracted = native_table.extract() or []
            if not extracted:
                continue
            table_id = f"{surface_id}.t{table_index}"
            bbox_tuple = tuple(float(value) for value in native_table.bbox)
            rows: list[list[dict[str, Any]]] = []
            for row_index, row in enumerate(extracted, start=1):
                cells: list[dict[str, Any]] = []
                for column_index, value in enumerate(row, start=1):
                    cells.append(cell_record(
                        row_index,
                        column_index,
                        value,
                        f"{path.name}#page={page_index + 1};table={table_index};r={row_index};c={column_index}",
                        confidence=0.98,
                    ))
                rows.append(cells)
            table = {
                "table_id": table_id,
                "surface_id": surface_id,
                "source_location": f"page {page_index + 1}, table {table_index}",
                "title": None,
                "units": None,
                "bbox": list(bbox_tuple),
                "extraction_method": "native_pdf_table",
                "confidence": 0.98,
                "rows": rows,
            }
            tables.append(table)
            source_table_tokens.extend(pdf_words_in_bbox(words, bbox_tuple))
            captured_table_tokens.extend(table_tokens(table))
            writer.write_json(f"tables/{safe_id(table_id)}.json", "table_json", table)

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

        page_numeric_count = len(numeric_tokens(text))
        sparse = len(text.strip()) < 40
        undetected_numeric_grid = page_numeric_count >= 6 and not page_tables
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
                reasons.append("numeric page without native table")
            vision_reason = "; ".join(reasons)

        artifact_refs = [text_ref, words_ref, *image_refs]
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
                    "instruction": "Transcribe every visible table cell and table footnote independently. Preserve blanks, dashes, parentheses, percentages, units and period headings. Return cell coordinates plus confidence; do not normalize metrics in this step.",
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
            "table_count": len(page_tables),
            "image_count": len(image_infos),
            "artifact_refs": artifact_refs,
            "lane_status": {
                "native_text": "pass" if text.strip() else "empty",
                "geometry": "pass" if words else "empty",
                "tables": table_status,
                "images": "pass" if image_infos else "none",
                "vision": "required" if vision_required else "not_required",
            },
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
        rows: list[list[dict[str, Any]]] = []
        for row_number in range(min_row, max_row + 1):
            cells: list[dict[str, Any]] = []
            for column_number in range(min_col, max_col + 1):
                formula_cell = sheet.cell(row_number, column_number)
                value_cell = value_sheet.cell(row_number, column_number)
                formula = str(formula_cell.value) if formula_cell.data_type == "f" else None
                value = value_cell.value if formula else formula_cell.value
                cells.append(cell_record(
                    row_number - min_row + 1,
                    column_number - min_col + 1,
                    value,
                    f"{path.name}#sheet={sheet.title};cell={formula_cell.coordinate}",
                    formula=formula,
                    number_format=formula_cell.number_format,
                    confidence=1.0,
                ))
                token = normalise_numeric_token(value)
                if token is not None:
                    source_tokens.append(token)
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
            "artifact_refs": [grid_ref],
            "lane_status": {
                "native_text": "pass",
                "geometry": "pass",
                "tables": "pass",
                "images": "unsupported" if getattr(sheet, "_images", []) else "none",
                "vision": "not_required",
            },
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
    task = {
        "schema_version": "broker-vision-task/1.0",
        "document_id": descriptor["document_id"],
        "surface_id": surface_id,
        "image_artifact_id": image_ref,
        "instruction": "Transcribe every visible table cell in reading order. Preserve labels, blanks, signs, units, periods and column positions. Do not normalize metrics.",
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
        "artifact_refs": [image_ref, task_ref],
        "lane_status": {
            "native_text": "empty",
            "geometry": "unsupported",
            "tables": "none",
            "images": "pass",
            "vision": "required",
        },
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
    tokens = table_tokens(table)
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
        "artifact_refs": [text_ref, table_ref],
        "lane_status": {
            "native_text": "pass",
            "geometry": "unsupported",
            "tables": "pass",
            "images": "none",
            "vision": "not_required",
        },
        "vision_reason": None,
    }
    return [surface], [table], tokens, tokens, "complete"


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
    if ledger["missing_tokens"]:
        status = "blocked"
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
                "id": "broker_extraction.numeric_tokens_missing",
                "severity": "blocker",
                "document_id": document["document_id"],
                "surface_id": None,
                "message": f"{len(document['numeric_ledger']['missing_tokens'])} native table numeric tokens were not captured.",
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
    bundle = {
        "schema_version": "broker-extraction-bundle/1.0",
        "run_id": request["run_id"],
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "extractor_version": VERSION,
        "tool_versions": tool_versions(),
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
