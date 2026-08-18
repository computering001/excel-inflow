#!/usr/bin/env python3
"""Render broker PDFs into archive-only page images.

These images preserve screenshot evidence only. They carry no semantic or
selected-cell model authority. Rendering failure may remove the optional page
images, but it must never remove raw-file custody or prevent model delivery.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def archive_pdf_pages(
    raw_path: Path,
    output_root: Path,
    *,
    source_id: str,
) -> list[dict[str, Any]]:
    """Render every PDF page for archive display and return sealed metadata."""

    import fitz

    output_root.mkdir(parents=True, exist_ok=True)
    pages: list[dict[str, Any]] = []
    with fitz.open(raw_path) as document:
        for page_index, page in enumerate(document):
            page_number = page_index + 1
            artifact_path = output_root / f"page-{page_number:04d}.png"
            pixmap = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
            pixmap.save(artifact_path)
            pages.append(
                {
                    "page_number": page_number,
                    "surface_id": f"{source_id}.page.{page_number}",
                    "width_points": float(page.rect.width),
                    "height_points": float(page.rect.height),
                    "artifact_path": str(artifact_path),
                    "artifact_sha256": _sha256_file(artifact_path),
                }
            )
    return pages
