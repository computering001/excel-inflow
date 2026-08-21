#!/usr/bin/env python3
"""OCR-raster table extraction — the filings lane's last rung.

For true image-only scanned PDFs the fallback ladder ends today at the
terminal status BLOCKED_SCANNED_PDF_OCR_REQUIRED (see
scripts/run_real_filing_corpus_extraction_outcomes.py). This module is the
OCR lane that resolves it: it accepts a PDF + page range, re-verifies via
the normalize_pdf probe that each requested page really is scanned (no
usable text layer), rasterizes the page with pdftoppm at 300 dpi (an
already-pinned CI toolchain component), runs tesseract TSV output, and
reconstructs word boxes into a cell grid by simple geometry — line grouping
by y-centre clustering, column splitting on x-gaps. Facts are emitted in
the SAME shape as scripts/extract_html_tables.py (html-table-facts style:
concept/context_ref/unit_ref/value/decimals/scale/sign/period/dimensions +
lane provenance), so downstream fact consumers need no changes. Numeric
parsing reuses broker_numeric.parse_broker_number under the exact html-lane
rules (parentheses negative, %/x suffixes, thousands separators).

Typed degradation, never silent: every failure mode — missing engine,
missing rasterizer, subprocess nonzero exit, unparseable TSV, non-scanned
page range, unreadable registry — exits 3 with a single-line JSON status on
stdout ({status: ocr_engine_unavailable | rasterizer_unavailable |
rasterization_failed | ocr_recognition_failed | no_scanned_pages_in_range |
input_file_not_found | classification_probe_failed | registry_invalid |
lane_dependency_missing, ...}) and never a traceback. Engines are declared
in assets/ocr-engine-registry-v1.json; tesseract is host-installed and
optional, 'unavailable' is a terminal marker that is never selectable.

Known limits (documented, fail-closed): periods are NOT detected from OCR
headers — every fact emits period {} with provenance period_status=
'undetected' instead of fabricating a window; no colspan/rowspan model —
each reconstructed line is one grid row; OCR confidence below floor words
are dropped; artifacts are byte-deterministic only for a fixed host binary
pair (pdftoppm/tesseract versions affect recognition).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.dont_write_bytecode = True
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

try:
    from broker_numeric import parse_broker_number as _parse_broker_number
    import normalize_pdf as _normalize_pdf
except ImportError as error:  # in-repo siblings must sit beside this file
    print(json.dumps({
        "status": "lane_dependency_missing",
        "detail": str(error),
    }, sort_keys=True))
    sys.exit(3)

SCHEMA_VERSION = "ocr-raster-facts/1.0"  # facts are key-compatible with html-table-facts/1.0
DEFAULT_REGISTRY = ROOT / "assets" / "ocr-engine-registry-v1.json"
DEFAULT_DPI = 300
MIN_WORD_CONFIDENCE = 0.0        # tesseract TSV conf < 0 marks structural rows: drop
LINE_TOLERANCE_HEIGHTS = 0.65    # y-centre drift tolerance, in median glyph heights
LINE_TOLERANCE_MIN_PX = 6.0
COLUMN_GAP_HEIGHTS = 1.15        # x-gap that starts a new column, in median heights
COLUMN_GAP_MIN_PX = 12.0
STDERR_TAIL_CHARS = 300

EXIT_OK = 0
EXIT_EMPTY = 2
EXIT_TYPED_REFUSAL = 3

STATUS_ENGINE_UNAVAILABLE = "ocr_engine_unavailable"
TERMINAL_ENGINE_ID = "unavailable"

DASH_TOKENS = {"-", "—", "–"}  # hyphen / em dash / en dash placeholders
CURRENCY_BY_SYMBOL = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY"}
SCALE_EXPONENTS = {"thousands": 3, "millions": 6, "billions": 9}
_SCALE_HINT = re.compile(
    r"\b(?:in\s+)?(thousands|millions|billions)\b", re.IGNORECASE
)
_FOOTNOTE_REF = re.compile(r"\(\d+\)|\([a-z]\)|\[\d+\]", re.IGNORECASE)


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------

def load_registry(path: Path) -> dict:
    """Load and structurally validate the OCR engine registry."""
    try:
        registry = json.loads(path.read_text("utf-8"))
    except Exception as error:
        raise _TypedRefusal("registry_invalid", {"detail": f"{path}: {error}"})
    engines = registry.get("engines")
    policy = registry.get("policy")
    if not isinstance(engines, list) or not engines:
        raise _TypedRefusal("registry_invalid", {
            "detail": "engines must be a non-empty list"})
    if not isinstance(policy, dict):
        raise _TypedRefusal("registry_invalid", {"detail": "policy must be an object"})
    for entry in engines:
        if not isinstance(entry, dict) or "id" not in entry or "provision" not in entry:
            raise _TypedRefusal("registry_invalid", {
                "detail": f"engine entry missing id/provision: {entry!r}"})
    return registry


def resolve_engine(registry: dict) -> tuple[dict | None, str | None, list[str]]:
    """Walk policy.fallback_order; return (entry, binary_path, probed_names).

    The 'unavailable' entry is a terminal typed-degradation marker and is
    never selectable. Absence of every optional host engine is NOT an
    exception — callers translate None into STATUS_ENGINE_UNAVAILABLE.
    """
    by_id = {entry["id"]: entry for entry in registry["engines"]}
    probed: list[str] = []
    for engine_id in registry["policy"].get("fallback_order", []):
        if engine_id == TERMINAL_ENGINE_ID:
            continue
        entry = by_id.get(engine_id)
        if entry is None:
            probed.append(engine_id)
            continue
        binary = entry.get("binary") or engine_id
        probed.append(binary)
        resolved = shutil.which(binary)
        if resolved:
            return entry, resolved, probed
    return None, None, probed


class _TypedRefusal(Exception):
    """Internal control flow: carries a typed status + detail to main()."""

    def __init__(self, status: str, detail: dict | None = None) -> None:
        super().__init__(status)
        self.status = status
        self.detail = dict(detail or {})


# --------------------------------------------------------------------------
# Page selection + scanned-page probe (normalize_pdf reuse)
# --------------------------------------------------------------------------

def parse_page_spec(spec: str, total_pages: int) -> list[int]:
    """Resolve 'all' | '3' | '2-5' | '1,3-4' into a deduped 1-based list."""
    pages: list[int] = []
    spec = (spec or "all").strip().lower()
    if spec == "all":
        return list(range(1, total_pages + 1))
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start_text, end_text = part.split("-", 1)
            start, end = int(start_text), int(end_text)
        else:
            start = end = int(part)
        for page in range(max(1, start), min(total_pages, end) + 1):
            if page not in pages:
                pages.append(page)
    if not pages:
        raise ValueError(f"empty page range {spec!r} for {total_pages}-page document")
    return pages


def classify_document(pdf: Path) -> dict:
    """Reuse the normalize_pdf text-vs-scanned probe verbatim."""
    try:
        return _normalize_pdf.classify_pdf(pdf)
    except Exception as error:
        raise _TypedRefusal("classification_probe_failed", {"detail": str(error)})


# --------------------------------------------------------------------------
# Rasterize + recognize
# --------------------------------------------------------------------------

def rasterize_page(pdf: Path, page: int, dpi: int, workdir: Path) -> tuple[Path, str]:
    """pdftoppm one page to PNG; returns (png_path, pdftoppm_binary)."""
    binary = shutil.which("pdftoppm")
    if not binary:
        raise _TypedRefusal("rasterizer_unavailable", {
            "detail": "pdftoppm not found on PATH",
            "hint": "poppler-utils is a pinned CI toolchain component",
        })
    prefix = workdir / f"pg{page}"
    completed = subprocess.run(  # noqa: S603 — fixed pinned binary, no shell
        [binary, "-png", "-r", str(dpi), "-f", str(page), "-l", str(page),
         str(pdf), str(prefix)],
        text=True, capture_output=True, check=False,
    )
    if completed.returncode != 0:
        raise _TypedRefusal("rasterization_failed", {
            "page": page,
            "returncode": completed.returncode,
            "stderr_tail": completed.stderr[-STDERR_TAIL_CHARS:],
        })
    produced = sorted(workdir.glob(f"pg{page}-*.png"))
    if not produced:
        raise _TypedRefusal("rasterization_failed", {
            "page": page, "detail": "pdftoppm produced no PNG"})
    return produced[0], binary


_TSV_FIELDS = ("level", "page_num", "block_num", "par_num", "line_num",
               "word_num", "left", "top", "width", "height", "conf", "text")


def run_tesseract(binary: str, png: Path) -> str:
    """Run tesseract TSV over one PNG; any failure is typed."""
    try:
        completed = subprocess.run(  # noqa: S603 — fixed pinned binary, no shell
            [binary, str(png), "stdout", "tsv"],
            text=True, capture_output=True, check=False,
        )
    except OSError as error:
        raise _TypedRefusal("ocr_recognition_failed", {"detail": str(error)})
    if completed.returncode != 0:
        raise _TypedRefusal("ocr_recognition_failed", {
            "returncode": completed.returncode,
            "stderr_tail": completed.stderr[-STDERR_TAIL_CHARS:],
        })
    return completed.stdout


def parse_tsv(tsv_text: str) -> list[dict]:
    """Parse tesseract TSV into word records (level-5 rows only).

    Malformed lines raise ValueError — callers convert that into a typed
    ocr_recognition_failed rather than silently dropping bytes.
    """
    lines = [line for line in tsv_text.splitlines() if line.strip()]
    if not lines:
        return []
    header = lines[0].split("\t")
    try:
        index_of = {name.strip().lower(): i for i, name in enumerate(header)}
        columns = [index_of[name] for name in _TSV_FIELDS]
    except (KeyError, IndexError) as error:
        raise ValueError(f"unrecognized TSV header: {error}")
    words: list[dict] = []
    for line in lines[1:]:
        fields = line.split("\t")
        try:
            record = {name: fields[col] for name, col in zip(_TSV_FIELDS, columns)}
        except IndexError as error:
            raise ValueError(f"short TSV row: {line[:80]!r}: {error}")
        if record["level"] != "5":
            continue
        text = record["text"].strip()
        confidence = float(record["conf"])
        if not text or confidence < MIN_WORD_CONFIDENCE:
            continue
        words.append({
            "text": text,
            "conf": confidence,
            "left": int(record["left"]),
            "top": int(record["top"]),
            "width": int(record["width"]),
            "height": int(record["height"]),
        })
    return words


# --------------------------------------------------------------------------
# Geometry reconstruction: line grouping by y, column split by x-gaps
# --------------------------------------------------------------------------

def cluster_lines(words: list[dict], median_height: float) -> list[list[dict]]:
    tolerance = max(LINE_TOLERANCE_MIN_PX, LINE_TOLERANCE_HEIGHTS * median_height)
    ordered = sorted(words, key=lambda w: (w["top"] + w["height"] / 2.0, w["left"]))
    lines: list[list[dict]] = []
    current: list[dict] = []
    anchor: float | None = None
    for word in ordered:
        centre = word["top"] + word["height"] / 2.0
        if current and anchor is not None and abs(centre - anchor) > tolerance:
            lines.append(current)
            current = []
            anchor = None
        current.append(word)
        anchor = centre if anchor is None else (anchor * (len(current) - 1) + centre) / len(current)
    if current:
        lines.append(current)
    return [sorted(line, key=lambda w: w["left"]) for line in lines]


def split_columns(line: list[dict], median_height: float) -> list[list[dict]]:
    gap_threshold = max(COLUMN_GAP_MIN_PX, COLUMN_GAP_HEIGHTS * median_height)
    groups: list[list[dict]] = []
    current: list[dict] = []
    for word in line:
        if current:
            previous = current[-1]
            gap = word["left"] - (previous["left"] + previous["width"])
            if gap > gap_threshold:
                groups.append(current)
                current = []
        current.append(word)
    if current:
        groups.append(current)
    return groups


def build_grid(words: list[dict]) -> list[list[str]]:
    """Word boxes -> rectangular grid of cell strings."""
    if not words:
        return []
    median_height = statistics.median(w["height"] for w in words)
    grid: list[list[str]] = []
    for line in cluster_lines(words, median_height):
        row: list[str] = []
        for group in split_columns(line, median_height):
            row.append(" ".join(word["text"] for word in group))
        grid.append(row)
    width = max(len(row) for row in grid)
    return [row + [""] * (width - len(row)) for row in grid]


# --------------------------------------------------------------------------
# Fact emission (html-table-facts shape)
# --------------------------------------------------------------------------

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_concept(label: str) -> str:
    cleaned = _FOOTNOTE_REF.sub(" ", str(label or ""))
    words = re.findall(r"[a-z0-9]+", cleaned.lower())
    return "_".join(words)[:120]


def _unit_context(text: str) -> tuple[str, int]:
    currency = ""
    for symbol, code in CURRENCY_BY_SYMBOL.items():
        if symbol in text:
            currency = code
            break
    exponent = 0
    hint = _SCALE_HINT.search(text)
    if hint:
        exponent = SCALE_EXPONENTS[hint.group(1).lower()]
    return currency, exponent


def _parse_cell_number(token: str) -> tuple[float, str | None] | None:
    """Return (value, sign) under broker_numeric rules; None if not numeric."""
    cleaned = token.replace("\xa0", " ").strip()
    if cleaned in DASH_TOKENS:
        return (0.0, None)
    value = _parse_broker_number(cleaned, scale_percent=True)
    if value is None:
        return None
    return (value, "-" if value < 0 else None)


def extract_facts_for_grid(grid: list[list[str]], table_index: int,
                           page: int) -> tuple[list[dict], dict]:
    currency, unit_exponent = _unit_context(
        " ".join(cell for row in grid for cell in row))
    facts: list[dict] = []
    for r, row in enumerate(grid):
        label_parts: list[str] = []
        data_cells: list[tuple[int, str, float, str | None]] = []
        for c, text in enumerate(row):
            if not text:
                continue
            parsed = _parse_cell_number(text)
            if parsed is None:
                label_parts.append(text)
            else:
                value, sign = parsed
                data_cells.append((c, text, value, sign))
        if not data_cells:
            continue
        label = " ".join(label_parts).strip()
        concept = normalized_concept(label) or f"table_{table_index}_row_{r}"
        for c, token, value, sign in data_cells:
            scaled = round(value * (10 ** unit_exponent), 6)
            facts.append({
                "concept": concept,
                "context_ref": "",
                "unit_ref": currency,
                "value": scaled,
                "decimals": None,
                "scale": str(unit_exponent) if unit_exponent else None,
                "sign": sign,
                "period": {},  # fail-closed: OCR headers never fabricate windows
                "dimensions": {},
                "provenance": {
                    "lane": "ocr_raster_fallback",
                    "page": page,
                    "table_index": table_index,
                    "row_label": label,
                    "column_index": c,
                    "printed_token": token,
                    "period_status": "undetected",
                },
            })
    header_row = grid[0] if grid else []
    summary = {
        "table_index": table_index,
        "page": page,
        "caption": "",
        "preceding_heading": "",
        "grid": grid,
        "row_count": len(grid),
        "column_count": len(header_row),
        "columns": [
            {"index": c, "header_text": header_row[c] if c < len(header_row) else "",
             "period": {}}
            for c in range(len(header_row))
        ],
        "fact_count": len(facts),
    }
    return facts, summary


# --------------------------------------------------------------------------
# Lane driver
# --------------------------------------------------------------------------

def extract_ocr(source: Path, out: Path, pages_spec: str, dpi: int,
                registry_path: Path) -> tuple[dict, int]:
    registry = load_registry(registry_path)
    if not source.exists():
        raise _TypedRefusal("input_file_not_found", {"source": str(source)})
    classification = classify_document(source)
    total_pages = len(classification["pages"])
    pages = parse_page_spec(pages_spec, total_pages)  # ValueError -> refusal below
    classified = {p["page"]: p["classification"] for p in classification["pages"]}
    scanned_pages = [p for p in pages if classified.get(p) == "scanned"]
    if not scanned_pages:
        raise _TypedRefusal("no_scanned_pages_in_range", {
            "requested_pages": pages,
            "classifications": {str(p): classified.get(p) for p in pages},
        })
    engine_entry, engine_binary, probed = resolve_engine(registry)
    if engine_entry is None or engine_binary is None:
        raise _TypedRefusal(STATUS_ENGINE_UNAVAILABLE, {
            "probed": probed,
            "registry_schema_version": registry.get("schema_version"),
            "policy_absence_status":
                registry["policy"].get("absence_status", STATUS_ENGINE_UNAVAILABLE),
        })

    facts: list[dict] = []
    tables: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="ocr-raster-lane-") as tmp:
        workdir = Path(tmp)
        rasterizer_binary: str | None = None
        for table_index, page in enumerate(scanned_pages):
            png, rasterizer_binary = rasterize_page(source, page, dpi, workdir)
            tsv_text = run_tesseract(engine_binary, png)
            try:
                words = parse_tsv(tsv_text)
            except ValueError as error:
                raise _TypedRefusal("ocr_recognition_failed", {
                    "page": page, "detail": str(error)})
            grid = build_grid(words)
            page_facts, summary = extract_facts_for_grid(grid, table_index, page)
            facts.extend(page_facts)
            tables.append(summary)

    facts.sort(key=lambda fact: (
        fact["concept"], fact["context_ref"],
        json.dumps(fact["period"], sort_keys=True), fact["value"],
    ))
    result = {
        "schema_version": SCHEMA_VERSION,
        "source_sha256": sha256_file(source),
        "fact_count": len(facts),
        "table_count": len(tables),
        "ixbrl_present": False,
        "dpi": dpi,
        "engine": {
            "id": engine_entry["id"],
            "binary": engine_binary,
            "provision": engine_entry.get("provision"),
        },
        "rasterizer": rasterizer_binary,
        "pages_processed": scanned_pages,
        "tables": tables,
        "facts": facts,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1, sort_keys=True) + "\n", "utf-8")
    status = "PASS" if result["fact_count"] > 0 else "EMPTY"
    payload = {
        "status": status,
        "fact_count": result["fact_count"],
        "table_count": result["table_count"],
        "pages_processed": scanned_pages,
        "engine": engine_entry["id"],
        "out": str(out),
    }
    return payload, (EXIT_OK if result["fact_count"] > 0 else EXIT_EMPTY)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Scanned PDF (image-only pages)")
    parser.add_argument("--out", required=True, help="Output fact-table JSON path")
    parser.add_argument("--pages", default="all",
                        help="Pages to process: all | 3 | 2-5 | 1,3-4 (default: all)")
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI,
                        help=f"Rasterization DPI (default: {DEFAULT_DPI})")
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY,
                        help="OCR engine registry JSON")
    args = parser.parse_args()

    source = Path(args.source).resolve()
    out = Path(args.out).resolve()
    try:
        payload, exit_code = extract_ocr(
            source, out, args.pages, args.dpi, args.registry.resolve())
    except _TypedRefusal as refusal:
        payload = {"status": refusal.status}
        payload.update(refusal.detail)
        if source.exists():
            payload.setdefault("source_sha256", sha256_file(source))
        print(json.dumps(payload, sort_keys=True))
        print(f"typed refusal: {refusal.status}", file=sys.stderr)
        return EXIT_TYPED_REFUSAL
    except ValueError as error:  # e.g. bad page spec
        print(json.dumps({"status": "invalid_request", "detail": str(error)},
                         sort_keys=True))
        print(f"typed refusal: invalid_request", file=sys.stderr)
        return EXIT_TYPED_REFUSAL
    print(json.dumps(payload, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
