#!/usr/bin/env python3
"""Classify each PDF page's text layer: text-bearing vs scanned image."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCANNED_THRESHOLD_CHARS = 50  # below this a page is treated as having no usable text layer


def classify_pdf(target: Path) -> dict:
    try:
        import fitz  # type: ignore
    except Exception as error:
        raise RuntimeError(f"PyMuPDF is required for PDF normalization: {error}") from error
    pages = []
    document = fitz.open(target)
    try:
        for page_index, page in enumerate(document):
            chars = len(page.get_text("text"))
            pages.append({
                "page": page_index + 1,
                "chars": chars,
                "classification": "scanned" if chars < SCANNED_THRESHOLD_CHARS else "text",
            })
    finally:
        document.close()
    scanned = sum(1 for p in pages if p["classification"] == "scanned")
    if scanned == 0:
        overall = "text"
    elif scanned == len(pages):
        overall = "scanned"
    else:
        overall = "mixed"
    return {"pages": pages, "overall": overall}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("-o", "--out", type=Path, default=None, help="write classification JSON here (default: stdout)")
    args = parser.parse_args()

    if not args.pdf.exists():
        print(f"typed refusal: input file not found: {args.pdf}", file=sys.stderr)
        return 1
    result = classify_pdf(args.pdf)
    payload = json.dumps(result, indent=2)
    if args.out is not None:
        args.out.write_text(payload + "\n", encoding="utf-8")
        print(f"classification written: {args.out} ({result['overall']}, {len(result['pages'])} pages)")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
