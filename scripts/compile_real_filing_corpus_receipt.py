#!/usr/bin/env python3
"""Compile a redacted, hash-bound receipt for the external filing corpus.

The manifest and source documents are custody inputs.  They may contain public
locators and source-specific search expressions, so neither is copied into the
repository receipt.  The receipt retains only byte hashes, candidate ids,
source-host identity, page/line coordinates, and hashes of every matched
witness.
"""

from __future__ import annotations

import argparse
import hashlib
import html
from html.parser import HTMLParser
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


SCHEMA = "real-filing-corpus-classification-receipt/1.0"
MANIFEST_SCHEMA = "real-filing-corpus-manifest/1.0"
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
EXPECTED_CATEGORIES = {
    "accounting_framework": {"ifrs", "us_gaap"},
    "issuer_region": {"uk", "eu", "us", "ireland"},
    "reporting_period": {"annual", "interim"},
    "document_format": {"html", "native_pdf", "scanned_pdf"},
    "statement_structure": {
        "multi_page_cash_flow",
        "repeated_headers",
        "parent_first_subtotals",
        "parent_last_subtotals",
        "different_units",
        "dashes_blanks_zeroes",
        "footnote_references",
        "long_captions",
        "unfamiliar_adjusted_profit_terms",
    },
}
ALLOWED_PUBLIC_HOST_SUFFIXES = (
    "sec.gov",
    "siemens.com",
    "southernwater.co.uk",
    "coca-colacompany.com",
    "crh.com",
)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def normalize_text(value: str) -> str:
    return " ".join(html.unescape(value).replace("\u00a0", " ").split())


def candidate_id(raw_sha256: str) -> str:
    return sha256_text(f"real-filing-candidate:{raw_sha256}")[:16]


class CellTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []
        self.cells: list[str] = []
        self._block_depth = 0
        self._cell_depth = 0
        self._block_parts: list[str] = []
        self._cell_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in {"div", "p", "span", "tr", "h1", "h2", "h3", "h4"}:
            if self._block_depth == 0:
                self._block_parts = []
            self._block_depth += 1
        if tag in {"td", "th"}:
            if self._cell_depth == 0:
                self._cell_parts = []
            self._cell_depth += 1

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"div", "p", "span", "tr", "h1", "h2", "h3", "h4"} and self._block_depth:
            self._block_depth -= 1
            if self._block_depth == 0:
                self.blocks.append(normalize_text("".join(self._block_parts)))
        if tag in {"td", "th"} and self._cell_depth:
            self._cell_depth -= 1
            if self._cell_depth == 0:
                self.cells.append(normalize_text("".join(self._cell_parts)))

    def handle_data(self, data: str) -> None:
        if self._block_depth:
            self._block_parts.append(data)
        if self._cell_depth:
            self._cell_parts.append(data)


def load_html(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    decoded = raw.decode("utf-8", errors="replace")
    parser = CellTextParser()
    parser.feed(decoded)
    blocks = [block for block in parser.blocks if block]
    return {
        "kind": "html",
        "raw": raw,
        "pages": [blocks],
        "cells": parser.cells,
        "text": normalize_text(" ".join(blocks)),
        "media_metrics": {
            "html_blocks": len(blocks),
            "html_cells": len(parser.cells),
            "inline_xbrl_markers": len(re.findall(r"<(?:ix:|ix\b)", decoded, re.I)),
        },
    }


def load_pdf(path: Path) -> dict[str, Any]:
    try:
        import fitz  # type: ignore
    except Exception as exc:  # pragma: no cover - custody environment defect
        raise RuntimeError("PyMuPDF is required for real PDF corpus classification") from exc

    raw = path.read_bytes()
    document = fitz.open(path)
    pages: list[list[str]] = []
    full_page_raster_pages = 0
    native_text_chars: list[int] = []
    for page in document:
        lines = [normalize_text(line) for line in page.get_text("text").splitlines()]
        lines = [line for line in lines if line]
        pages.append(lines)
        native_text_chars.append(sum(len(line) for line in lines))
        page_area = max(float(page.rect.width * page.rect.height), 1.0)
        max_image_coverage = 0.0
        for image in page.get_images(full=True):
            for rectangle in page.get_image_rects(image[0]):
                max_image_coverage = max(
                    max_image_coverage,
                    float(rectangle.width * rectangle.height) / page_area,
                )
        if max_image_coverage >= 0.80:
            full_page_raster_pages += 1
    page_count = len(pages)
    return {
        "kind": "pdf",
        "raw": raw,
        "pages": pages,
        "cells": [],
        "text": normalize_text(" ".join(" ".join(page) for page in pages)),
        "media_metrics": {
            "pdf_pages": page_count,
            "native_text_characters": sum(native_text_chars),
            "median_native_text_characters_per_page": (
                sorted(native_text_chars)[page_count // 2] if page_count else 0
            ),
            "full_page_raster_pages": full_page_raster_pages,
            "full_page_raster_fraction_ppm": (
                round(full_page_raster_pages * 1_000_000 / page_count) if page_count else 0
            ),
        },
    }


def text_scope(source: dict[str, Any], page: int | None) -> tuple[list[str], int | None]:
    if page is None:
        lines = [line for page_lines in source["pages"] for line in page_lines]
        return lines, None
    if not isinstance(page, int) or page < 1 or page > len(source["pages"]):
        raise AssertionError(f"page {page!r} is outside the source document")
    return source["pages"][page - 1], page


def regex_witness(
    source: dict[str, Any], pattern: str, page: int | None, *, flags: int = re.I
) -> dict[str, Any]:
    lines, page_number = text_scope(source, page)
    expression = re.compile(pattern, flags)
    for index, line in enumerate(lines):
        match = expression.search(line)
        if match:
            normalized_match = normalize_text(match.group(0))
            return {
                "page_ordinal": page_number,
                "line_ordinal": index + 1,
                "pattern_sha256": sha256_text(pattern),
                "line_sha256": sha256_text(line),
                "match_sha256": sha256_text(normalized_match),
                "match_character_count": len(normalized_match),
            }
    raise AssertionError(
        f"pattern {sha256_text(pattern)[:12]} did not match page {page_number or 'document'}"
    )


def classify_dimension(
    category: str, source: dict[str, Any], proof: dict[str, Any]
) -> list[dict[str, Any]]:
    page = proof.get("page")
    if category == "document_format.html":
        if source["kind"] != "html" or source["media_metrics"]["inline_xbrl_markers"] <= 0:
            raise AssertionError("HTML corpus member is not inline-XBRL HTML")
        return [{"media_metrics_sha256": sha256_text(canonical_json(source["media_metrics"]))}]
    if category == "document_format.native_pdf":
        metrics = source["media_metrics"]
        if (
            source["kind"] != "pdf"
            or metrics["median_native_text_characters_per_page"] < 200
            or metrics["full_page_raster_fraction_ppm"] >= 500_000
        ):
            raise AssertionError("PDF lacks a native text-bearing classification")
        return [{"media_metrics_sha256": sha256_text(canonical_json(metrics))}]
    if category == "document_format.scanned_pdf":
        metrics = source["media_metrics"]
        if source["kind"] != "pdf" or metrics["full_page_raster_fraction_ppm"] < 800_000:
            raise AssertionError("PDF lacks full-page raster scan evidence")
        return [{"media_metrics_sha256": sha256_text(canonical_json(metrics))}]

    builtins = {
        "accounting_framework.ifrs": (
            r"(?:prepared|reporting).{0,180}(?:in accordance with|under).{0,180}"
            r"(?:international financial reporting standards|ifrs accounting standards)"
        ),
        "accounting_framework.us_gaap": (
            r"(?:in conformity with|prepared under|presented under).{0,180}"
            r"(?:accounting principles generally accepted in the united states of america|u\.?s\.? gaap)"
        ),
        "issuer_region.uk": (
            r"(?:incorporated in the united kingdom|companies act 2006|england and wales)"
        ),
        "issuer_region.eu": (
            r"(?:the netherlands|dutch law|netherlands civil code|registered office.{0,80}(?:den haag|the hague))"
        ),
        "issuer_region.us": (
            r"(?:state of incorporation.{0,80}california|california.{0,80}94-2404110)"
        ),
        "issuer_region.ireland": (
            r"(?:^ireland$|dublin.{0,80}ireland|incorporated under irish law|republic of ireland)"
        ),
        "reporting_period.annual": r"(?:annual report|form 10-k|for the year ended)",
        "reporting_period.interim": (
            r"(?:condensed interim financial statements|form 10-q|six months ended|three months ended)"
        ),
    }
    if category not in builtins:
        raise AssertionError(f"unsupported dimension category {category}")
    witness = regex_witness(source, builtins[category], page, flags=re.I | re.S)
    witness["classifier_pattern_sha256"] = sha256_text(builtins[category])
    return [witness]


def canonical_cash_flow_heading(line: str) -> str:
    return normalize_text(re.sub(r"\s*\(?continued\)?\s*$", "", line, flags=re.I)).lower()


def structural_proof(
    category: str,
    proof: dict[str, Any],
    sources: dict[str, dict[str, Any]],
) -> tuple[list[str], list[dict[str, Any]]]:
    kind = proof.get("kind")
    source_ids: list[str] = []
    witnesses: list[dict[str, Any]] = []

    if kind in {"adjacent_cash_flow", "parent_order", "different_units", "footnote_reference", "long_caption", "adjusted_profit_term"}:
        source_ids = [proof["source"]]
        source = sources[source_ids[0]]
    else:
        source = {}

    if kind == "adjacent_cash_flow":
        first = int(proof["first_page"])
        second = int(proof["second_page"])
        if second != first + 1:
            raise AssertionError("cash-flow continuation pages are not adjacent")
        first_witness = regex_witness(source, proof["first_heading_pattern"], first)
        second_witness = regex_witness(source, proof["second_heading_pattern"], second)
        continuation = regex_witness(source, proof["continuation_pattern"], first)
        first_line = source["pages"][first - 1][first_witness["line_ordinal"] - 1]
        second_line = source["pages"][second - 1][second_witness["line_ordinal"] - 1]
        if canonical_cash_flow_heading(first_line) != canonical_cash_flow_heading(second_line):
            raise AssertionError("continued cash-flow header does not canonicalise to the first header")
        witnesses.extend([first_witness, continuation, second_witness])
    elif kind == "parent_order":
        page = int(proof["page"])
        parent = regex_witness(source, proof["parent_pattern"], page)
        children = [regex_witness(source, pattern, page) for pattern in proof["child_patterns"]]
        parent_line = parent["line_ordinal"]
        child_lines = [item["line_ordinal"] for item in children]
        if proof["order"] == "parent_first":
            valid = parent_line < min(child_lines)
        elif proof["order"] == "parent_last":
            valid = max(child_lines) < parent_line
        else:
            raise AssertionError("parent order is not recognised")
        if not valid:
            raise AssertionError("declared parent/subtotal order is absent")
        witnesses.extend([parent, *children])
    elif kind == "different_units":
        first = regex_witness(source, proof["first_pattern"], int(proof["first_page"]))
        second = regex_witness(source, proof["second_pattern"], int(proof["second_page"]))
        if first["match_sha256"] == second["match_sha256"]:
            raise AssertionError("unit witnesses are not different")
        witnesses.extend([first, second])
    elif kind == "cell_states":
        state_sources = proof["state_sources"]
        source_ids = sorted({item for values in state_sources.values() for item in values})
        for state in ("dash", "blank", "zero"):
            count = 0
            samples: list[tuple[str, str, int]] = []
            for source_id in state_sources.get(state, []):
                item = sources[source_id]
                if item["kind"] == "html":
                    values = item["cells"]
                else:
                    values = [line for page in item["pages"] for line in page]
                for index, value in enumerate(values):
                    if state == "blank":
                        matches = value == ""
                    elif state == "dash":
                        matches = value in {"-", "–", "—"}
                    else:
                        matches = re.fullmatch(r"\(?0(?:\.0+)?\)?", value.replace(",", "")) is not None
                    if matches:
                        count += 1
                        if len(samples) < 3:
                            samples.append((source_id, sha256_text(value), index + 1))
            if count <= 0:
                raise AssertionError(f"no {state} cell state was observed")
            witnesses.append({
                "cell_state": state,
                "observed_count": count,
                "sample_witnesses": [
                    {"source_id_sha256": sha256_text(source_id), "value_sha256": value_hash, "ordinal": ordinal}
                    for source_id, value_hash, ordinal in samples
                ],
            })
    elif kind == "footnote_reference":
        page = int(proof["page"])
        witnesses.append(regex_witness(source, proof["heading_pattern"], page))
        row = regex_witness(source, proof["row_pattern"], page)
        reference = regex_witness(source, proof["reference_pattern"], page)
        if abs(row["line_ordinal"] - reference["line_ordinal"]) > int(proof.get("max_line_distance", 3)):
            raise AssertionError("footnote reference is not adjacent to its statement row")
        witnesses.extend([row, reference])
    elif kind == "long_caption":
        witness = regex_witness(source, proof["pattern"], int(proof["page"]))
        if witness["match_character_count"] < int(proof["minimum_characters"]):
            raise AssertionError("caption witness is shorter than the declared threshold")
        witnesses.append(witness)
    elif kind == "adjusted_profit_term":
        approved = re.compile(
            r"(?:adjusted ebitda|core operating profit|underlying operating profit|profit industrial business)",
            re.I,
        )
        witness = regex_witness(source, proof["pattern"], int(proof["page"]))
        line = source["pages"][int(proof["page"]) - 1][witness["line_ordinal"] - 1]
        if not approved.search(line):
            raise AssertionError("adjusted-profit witness is outside the bounded vocabulary")
        witnesses.append(witness)
    else:
        raise AssertionError(f"unsupported structure proof kind {kind!r}")

    if category == "statement_structure.repeated_headers" and kind != "adjacent_cash_flow":
        raise AssertionError("repeated headers require the adjacent cash-flow proof")
    return source_ids, witnesses


def compile_receipt(manifest: dict[str, Any]) -> dict[str, Any]:
    if manifest.get("schema_version") != MANIFEST_SCHEMA:
        raise AssertionError("wrong real-filing corpus manifest schema")
    if set(manifest) != {"schema_version", "corpus_id", "documents", "categories"}:
        raise AssertionError("manifest fields are not exact")
    documents = manifest["documents"]
    if not isinstance(documents, list) or not documents:
        raise AssertionError("manifest has no documents")

    loaded: dict[str, dict[str, Any]] = {}
    document_receipts: list[dict[str, Any]] = []
    for document in documents:
        if set(document) != {
            "document_id", "path", "expected_sha256", "public_source_locator",
        }:
            raise AssertionError("document fields are not exact")
        document_id = document["document_id"]
        if not isinstance(document_id, str) or not document_id or document_id in loaded:
            raise AssertionError("document ids are not unique non-empty strings")
        path = Path(document["path"]).resolve(strict=True)
        expected = document["expected_sha256"]
        if not SHA256_RE.fullmatch(str(expected)):
            raise AssertionError("document expected hash is invalid")
        raw = path.read_bytes()
        actual = sha256_bytes(raw)
        if actual != expected:
            raise AssertionError(f"document hash mismatch for {document_id}")
        locator = document["public_source_locator"]
        parsed = urlparse(locator)
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or not any(
            host == suffix or host.endswith(f".{suffix}") for suffix in ALLOWED_PUBLIC_HOST_SUFFIXES
        ):
            raise AssertionError(f"document {document_id} lacks an approved official HTTPS source")
        if raw.startswith(b"%PDF-"):
            source = load_pdf(path)
        elif re.search(br"<(?:!doctype\s+html|html\b)", raw[:4096], re.I):
            source = load_html(path)
        else:
            raise AssertionError(f"document {document_id} has unsupported magic bytes")
        source.update({
            "document_id": document_id,
            "raw_sha256": actual,
            "candidate_id": candidate_id(actual),
        })
        loaded[document_id] = source
        document_receipts.append({
            "document_id_sha256": sha256_text(document_id),
            "candidate_id": source["candidate_id"],
            "raw_sha256": actual,
            "raw_byte_count": len(raw),
            "source_host": host,
            "source_locator_sha256": sha256_text(locator),
            "media_kind": source["kind"],
            "media_metrics": source["media_metrics"],
        })

    categories = manifest["categories"]
    if not isinstance(categories, dict) or set(categories) != set(EXPECTED_CATEGORIES):
        raise AssertionError("corpus category dimensions are not exact")
    category_receipts: list[dict[str, Any]] = []
    for dimension, required in EXPECTED_CATEGORIES.items():
        entries = categories[dimension]
        if not isinstance(entries, list):
            raise AssertionError(f"{dimension} category entries are not a list")
        ids = [entry.get("category_id") for entry in entries if isinstance(entry, dict)]
        if len(ids) != len(set(ids)) or set(ids) != required:
            raise AssertionError(f"{dimension} category ids are not exact")
        for entry in entries:
            if set(entry) != {"category_id", "proof"}:
                raise AssertionError(f"{dimension}.{entry.get('category_id')} fields are not exact")
            category = f"{dimension}.{entry['category_id']}"
            proof = entry["proof"]
            if dimension != "statement_structure":
                source_ids = [proof["source"]]
                witnesses = classify_dimension(category, loaded[source_ids[0]], proof)
            else:
                source_ids, witnesses = structural_proof(category, proof, loaded)
            if any(source_id not in loaded for source_id in source_ids):
                raise AssertionError(f"{category} cites an unknown source")
            proof_payload = {
                "category": category,
                "candidate_ids": sorted(loaded[source_id]["candidate_id"] for source_id in source_ids),
                "witnesses": witnesses,
            }
            category_receipts.append({
                "dimension": dimension,
                "category_id": entry["category_id"],
                "status": "HASH_BOUND_VERIFIED",
                "candidate_ids": proof_payload["candidate_ids"],
                "proof_kind": proof["kind"],
                "proof_sha256": sha256_text(canonical_json(proof_payload)),
                "witness_count": len(witnesses),
                "witnesses_sha256": sha256_text(canonical_json(witnesses)),
            })

    raw_hashes = sorted(item["raw_sha256"] for item in document_receipts)
    coverage_payload = sorted(
        category_receipts, key=lambda item: (item["dimension"], item["category_id"])
    )
    receipt = {
        "schema_version": SCHEMA,
        "status": "PASS",
        "corpus_id_sha256": sha256_text(manifest["corpus_id"]),
        "document_count": len(document_receipts),
        "candidate_set_sha256": sha256_text("\n".join(raw_hashes) + "\n"),
        "documents": sorted(document_receipts, key=lambda item: item["candidate_id"]),
        "category_count": len(category_receipts),
        "verified_category_count": len(category_receipts),
        "categories": coverage_payload,
        "coverage_sha256": sha256_text(canonical_json(coverage_payload)),
        "licensed_or_public_document_bytes_in_repository": False,
        "source_text_in_receipt": False,
        "violations": 0,
    }
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    parser.add_argument("--out", required=True)
    parser.add_argument("--expect")
    args = parser.parse_args()

    manifest = json.loads(Path(args.manifest).read_text("utf-8"))
    receipt = compile_receipt(manifest)
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", "utf-8")
    if args.expect:
        expected = json.loads(Path(args.expect).read_text("utf-8"))
        if receipt != expected:
            raise AssertionError("compiled corpus receipt differs from the frozen redacted receipt")
    print(json.dumps({
        "schema_version": "real-filing-corpus-classifier-result/1.0",
        "status": receipt["status"],
        "documents": receipt["document_count"],
        "verified_categories": receipt["verified_category_count"],
        "coverage_sha256": receipt["coverage_sha256"],
        "violations": receipt["violations"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
