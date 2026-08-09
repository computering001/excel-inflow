#!/usr/bin/env python3
"""Reconcile broker extraction lanes into one hash-bound canonical table set.

The compiler is intentionally semantic-free.  It resolves duplicate native and
vision discoveries, preserves source provenance and reports all overlap or
coverage conflicts together.  It never accepts reviewer-declared header or
period rows.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def normalise(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def table_matrix(table: dict[str, Any]) -> list[list[str]]:
    return [[normalise(cell.get("raw_text")) for cell in row] for row in table.get("rows", [])]


def table_signature(table: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_bytes({
        "title": normalise(table.get("title")),
        "units": normalise(table.get("units")),
        "rows": table_matrix(table),
    })).hexdigest()


def bbox_iou(left: Any, right: Any) -> float:
    if not isinstance(left, list) or not isinstance(right, list) or len(left) != 4 or len(right) != 4:
        return 0.0
    lx0, ly0, lx1, ly1 = map(float, left)
    rx0, ry0, rx1, ry1 = map(float, right)
    intersection = max(0.0, min(lx1, rx1) - max(lx0, rx0)) * max(0.0, min(ly1, ry1) - max(ly0, ry0))
    union = max(0.0, (lx1 - lx0) * (ly1 - ly0)) + max(0.0, (rx1 - rx0) * (ry1 - ry0)) - intersection
    return 0.0 if union <= 0 else intersection / union


def bbox_min_overlap(left: Any, right: Any) -> float:
    """Intersection divided by the smaller rectangle, useful for nested lanes."""
    if not isinstance(left, list) or not isinstance(right, list) or len(left) != 4 or len(right) != 4:
        return 0.0
    lx0, ly0, lx1, ly1 = map(float, left)
    rx0, ry0, rx1, ry1 = map(float, right)
    intersection = max(0.0, min(lx1, rx1) - max(lx0, rx0)) * max(0.0, min(ly1, ry1) - max(ly0, ry0))
    smaller = min(max(0.0, (lx1 - lx0) * (ly1 - ly0)), max(0.0, (rx1 - rx0) * (ry1 - ry0)))
    return 0.0 if smaller <= 0 else intersection / smaller


def explicitly_equivalent_lanes(left: dict[str, Any], right: dict[str, Any]) -> bool:
    """Return True only for a producer-declared or lineage-proven equivalence.

    Equal table contents are not enough: broker pages commonly repeat the same
    numbers in separate summary, detail or scenario panels. Canonicalised lane
    records carry immutable ``source_table_ids``; an overlapping source ID is
    the existing explicit proof that two records descend from one physical
    table. Unrelated lanes have disjoint lineages and may not merge by content.
    """
    left_sources = {str(item) for item in (left.get("source_table_ids") or []) if str(item)}
    right_sources = {str(item) for item in (right.get("source_table_ids") or []) if str(item)}
    return bool(left_sources and right_sources and left_sources.intersection(right_sources))


def nonblank_count(table: dict[str, Any]) -> int:
    return sum(1 for row in table.get("rows", []) for cell in row if str(cell.get("raw_text") or "").strip())


def numeric_token(value: Any) -> str | None:
    raw = str(value or "").strip()
    if not re.fullmatch(r"\(?[-+]?[$€£¥]?\s*(?:\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d+)?[%x]?\)?", raw, re.I):
        return None
    negative = raw.startswith("(") and raw.endswith(")")
    suffix = "%" if "%" in raw else ("x" if raw.lower().endswith("x") else "")
    cleaned = re.sub(r"[$€£¥,%xX() ]", "", raw)
    try:
        number = float(cleaned)
    except ValueError:
        return raw
    if negative:
        number = -abs(number)
    return (str(int(number)) if number.is_integer() else format(number, ".15g")) + suffix


def table_numeric_tokens(table: dict[str, Any]) -> list[str]:
    return [
        token
        for row in table.get("rows", []) for cell in row
        for token in [numeric_token(cell.get("raw_text"))]
        if token is not None
    ]


PERIOD_TOKEN = re.compile(
    r"^(?:(?:fy|cy)\s*\d{2,4}[eaf]?|(?:19|20)\d{2}[eaf]?|"
    r"(?:(?:fy|cy)\s*)?(?:(?:19|20)\d{2}|\d{2})\s*/\s*(?:(?:19|20)\d{2}|\d{2})[eaf]?|"
    r"(?:q[1-4]|[1-4]q|h[12]|[12]h|[369]m)\s*(?:fy|cy)?\s*(?:19|20)?\d{2}[eaf]?|"
    r"ltm|ttm|ntm)$",
    re.I,
)


def period_token(value: Any) -> str | None:
    candidate = re.sub(r"\s+", " ", str(value or "").strip())
    return normalise(candidate) if PERIOD_TOKEN.fullmatch(candidate) else None


def economic_observations(table: dict[str, Any]) -> dict[tuple[str, str], list[str]]:
    """Return row/period/value observations independent of PDF cell geometry.

    Native PDF lanes often split one visible row into several cells while the
    rendered-image lane emits the same row as one matrix.  Cell coordinates are
    therefore evidence provenance, not economic identity.  The comparison key
    is the visible row label plus visible period header; when a source has no
    period header the numeric ordinal is used only within that labelled row.
    """
    headers: dict[int, str] = {}
    observations: dict[tuple[str, str], list[str]] = {}
    for row in table.get("rows", []):
        for cell in row:
            period = period_token(cell.get("raw_text"))
            if period:
                headers[int(cell.get("column", 0))] = period
    for row in table.get("rows", []):
        label = next((
            normalise(cell.get("raw_text"))
            for cell in row
            if normalise(cell.get("raw_text"))
            and numeric_token(cell.get("raw_text")) is None
            and period_token(cell.get("raw_text")) is None
        ), "")
        if not label:
            continue
        ordinal = 0
        for cell in row:
            token = numeric_token(cell.get("raw_text"))
            if token is None:
                continue
            ordinal += 1
            column = int(cell.get("column", 0))
            period = headers.get(column, f"ordinal:{ordinal}")
            observations.setdefault((label, period), []).append(token)
    return observations


def observation_conflicts(left: dict[str, Any], right: dict[str, Any]) -> list[dict[str, Any]]:
    left_observations = economic_observations(left)
    right_observations = economic_observations(right)
    conflicts = []
    for key in sorted(set(left_observations).intersection(right_observations)):
        left_values = Counter(left_observations[key])
        right_values = Counter(right_observations[key])
        if left_values != right_values:
            conflicts.append({
                "label": key[0],
                "period": key[1],
                "left_values": sorted(left_values.elements()),
                "right_values": sorted(right_values.elements()),
            })
    return conflicts


def has_rendered_authority(table: dict[str, Any]) -> bool:
    methods = table.get("extraction_methods") or [table.get("extraction_method")]
    return any("vision" in str(method) or "manual" in str(method) for method in methods if method)


def is_discovery_only(table: dict[str, Any]) -> bool:
    return (
        table.get("authority_role") == "discovery_only"
        or str(table.get("extraction_method") or "") == "native_pdf_text"
    )


def bounded_native_pair(left: dict[str, Any], right: dict[str, Any]) -> bool:
    methods = {
        str(left.get("extraction_method") or ""),
        str(right.get("extraction_method") or ""),
    }
    return methods == {"native_pdf_lines", "native_pdf_lines_strict"}


def segmentation_equivalent(left: dict[str, Any], right: dict[str, Any]) -> bool:
    """Recognise one physical table split differently by extraction lanes.

    This is deliberately narrower than fuzzy table matching: geometry must
    strongly overlap, at least one lane must be independently rendered, there
    must be no row/period value conflict, and the numeric evidence must either
    share a verified observation or have a multiset containment relationship.
    """
    overlap = bbox_iou(left.get("bbox"), right.get("bbox"))
    nested_overlap = bbox_min_overlap(left.get("bbox"), right.get("bbox"))
    if overlap < 0.70 and nested_overlap < 0.85:
        return False
    if not (
        has_rendered_authority(left)
        or has_rendered_authority(right)
        or bounded_native_pair(left, right)
    ):
        return False
    if observation_conflicts(left, right):
        return False
    left_observations = economic_observations(left)
    right_observations = economic_observations(right)
    shared_observation = any(
        Counter(left_observations[key]) == Counter(right_observations[key])
        for key in set(left_observations).intersection(right_observations)
    )
    left_tokens, right_tokens = Counter(table_numeric_tokens(left)), Counter(table_numeric_tokens(right))
    numeric_containment = bool(left_tokens and right_tokens) and (
        not (left_tokens - right_tokens) or not (right_tokens - left_tokens)
    )
    return shared_observation or numeric_containment


def matrix_contains(left: list[list[str]], right: list[list[str]]) -> bool:
    """True when every nonblank row of right appears in order in left."""
    needle = [row for row in right if any(row)]
    haystack = [row for row in left if any(row)]
    if not needle:
        return True
    position = 0
    for row in haystack:
        if position < len(needle) and row == needle[position]:
            position += 1
    return position == len(needle)


def merged_table(primary: dict[str, Any], contributors: list[dict[str, Any]]) -> dict[str, Any]:
    output = copy.deepcopy(primary)
    ordered = sorted(contributors, key=lambda item: item["table_id"])
    output["source_table_ids"] = sorted({
        str(source_id)
        for item in ordered
        for source_id in (item.get("source_table_ids") or [item["table_id"]])
    })
    output["extraction_methods"] = sorted({
        str(method)
        for item in ordered
        for method in (item.get("extraction_methods") or [item.get("extraction_method")])
        if method
    })
    output["footnotes"] = sorted({
        str(note).strip()
        for item in ordered for note in item.get("footnotes", [])
        if str(note).strip()
    })
    output["canonical_table_id"] = "ct-" + hashlib.sha256(canonical_bytes({
        "surface_id": output["surface_id"],
        "source_table_ids": output["source_table_ids"],
        "signature": table_signature(output),
    })).hexdigest()[:20]
    output["table_id"] = output["canonical_table_id"]
    output["physical_table_id"] = "pt-" + hashlib.sha256(canonical_bytes({
        "surface_id": output["surface_id"],
        "bbox": [round(float(value), 2) for value in (output.get("bbox") or [])],
        "signature": table_signature(output),
    })).hexdigest()[:20]
    output["authority_role"] = (
        "rendered_authority"
        if any(has_rendered_authority(item) for item in contributors)
        else "native_structured_authority"
    )
    output["verification_basis"] = (
        "two_pass_visual"
        if any(has_rendered_authority(item) for item in contributors)
        else "bounded_native_geometry"
    )
    return output


def canonicalise_tables(tables: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    findings: list[dict[str, Any]] = []
    canonical: list[dict[str, Any]] = []
    by_surface: dict[str, list[dict[str, Any]]] = {}
    for table in tables:
        if is_discovery_only(table):
            continue
        by_surface.setdefault(str(table.get("surface_id")), []).append(table)

    for surface_id in sorted(by_surface):
        remaining = sorted(by_surface[surface_id], key=lambda item: item["table_id"])
        while remaining:
            seed = remaining.pop(0)
            group = [seed]
            conflicts: list[dict[str, Any]] = []
            for candidate in list(remaining):
                exact = table_signature(seed) == table_signature(candidate)
                overlap = bbox_iou(seed.get("bbox"), candidate.get("bbox"))
                nested_overlap = bbox_min_overlap(seed.get("bbox"), candidate.get("bbox"))
                seed_matrix, candidate_matrix = table_matrix(seed), table_matrix(candidate)
                contained = matrix_contains(seed_matrix, candidate_matrix) or matrix_contains(candidate_matrix, seed_matrix)
                # Identical values on the same page can still be separate
                # economic objects. Merge identical content only when the
                # physical regions intersect or a lane explicitly proves
                # equivalence; disjoint summary/scenario panels survive.
                exact_same_region = exact and (
                    nested_overlap > 0.0 or explicitly_equivalent_lanes(seed, candidate)
                )
                if exact_same_region or ((overlap >= 0.70 or nested_overlap >= 0.85) and contained) or segmentation_equivalent(seed, candidate):
                    group.append(candidate)
                    remaining.remove(candidate)
                elif overlap >= 0.70 or nested_overlap >= 0.85:
                    conflicts.append(candidate)
            if conflicts:
                findings.append({
                    "id": "broker_canonical.overlap_conflict",
                    "severity": "blocker",
                    "surface_id": surface_id,
                    "table_ids": [seed["table_id"], *[item["table_id"] for item in conflicts]],
                    "conflicts": [
                        conflict
                        for candidate in conflicts
                        for conflict in observation_conflicts(seed, candidate)
                    ],
                    "message": "Overlapping extraction lanes contain a displayed economic conflict or cannot be reconciled to an independently rendered table.",
                })
            ranked = sorted(
                group,
                key=lambda item: (
                    1 if "vision" in str(item.get("extraction_method")) or "manual" in str(item.get("extraction_method")) else 0,
                    len(economic_observations(item)),
                    nonblank_count(item),
                    item["table_id"],
                ),
                reverse=True,
            )
            canonical.append(merged_table(ranked[0], group))

    # Deterministic continuation hints are evidence, not joins.  Matching
    # headers across adjacent surfaces retain both tables and link them.
    ordered = sorted(canonical, key=lambda item: (str(item.get("surface_id")), item["canonical_table_id"]))
    previous_by_header: dict[str, dict[str, Any]] = {}
    for table in ordered:
        rows = table_matrix(table)
        header = json.dumps(rows[0] if rows else [], separators=(",", ":"))
        previous = previous_by_header.get(header)
        current_match = re.search(r"\.(?:p|s)(\d+)$", str(table.get("surface_id")))
        previous_match = re.search(r"\.(?:p|s)(\d+)$", str(previous.get("surface_id"))) if previous else None
        adjacent = bool(current_match and previous_match and int(current_match.group(1)) == int(previous_match.group(1)) + 1)
        table["continuation_of"] = previous["canonical_table_id"] if previous and header != "[]" and adjacent else None
        previous_by_header[header] = table
    return ordered, findings


def canonicalise_bundle(bundle: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    output = copy.deepcopy(bundle)
    all_findings: list[dict[str, Any]] = []
    canonical_documents = []
    for document in output.get("documents", []):
        tables, findings = canonicalise_tables(document.get("tables", []))
        for finding in findings:
            finding["document_id"] = document.get("document_id")
        all_findings.extend(findings)
        document["canonical_tables"] = tables
        canonical_documents.extend(tables)
        for surface in document.get("surfaces", []):
            source = Counter(surface.get("source_table_numeric_tokens") or [])
            captured = Counter(
                token
                for table in tables if table.get("surface_id") == surface.get("surface_id")
                for token in table_numeric_tokens(table)
            )
            missing = source - captured
            extra = captured - source
            if missing:
                all_findings.append({
                    "id": "broker_canonical.source_table_tokens_missing",
                    "severity": "blocker",
                    "document_id": document.get("document_id"),
                    "surface_id": surface.get("surface_id"),
                    "tokens": sorted(token for token, count in missing.items() for _ in range(count)),
                    "message": "Canonical tables omit numeric tokens present inside independently discovered source table regions.",
                })
            if extra:
                all_findings.append({
                    "id": "broker_canonical.captured_tokens_unowned",
                    "severity": "blocker",
                    "document_id": document.get("document_id"),
                    "surface_id": surface.get("surface_id"),
                    "tokens": sorted(token for token, count in extra.items() for _ in range(count)),
                    "message": "Canonical tables contain duplicate or unowned numeric tokens beyond the source-region census.",
                })
    canonical_documents = [
        table
        for document in sorted(output.get("documents", []), key=lambda item: str(item.get("document_id")))
        for table in sorted(
            document.get("canonical_tables", []),
            key=lambda item: str(item.get("canonical_table_id") or item.get("table_id")),
        )
    ]
    output["canonical_tables_sha256"] = hashlib.sha256(canonical_bytes(canonical_documents)).hexdigest()
    return output, all_findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    input_path = Path(args.bundle).resolve()
    output_path = Path(args.out).resolve()
    bundle = json.loads(input_path.read_text("utf-8"))
    compiled, findings = canonicalise_bundle(bundle)
    compiled["schema_version"] = "broker-canonical-tables/1.0"
    compiled["source_bundle_sha256"] = hashlib.sha256(input_path.read_bytes()).hexdigest()
    compiled["canonical_findings"] = findings
    compiled["gate_status"] = "BLOCKED" if findings else compiled.get("gate_status", "PASS")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(canonical_bytes(compiled))
    print(json.dumps({"status": compiled["gate_status"], "findings": len(findings), "sha256": compiled["canonical_tables_sha256"]}, sort_keys=True))
    return 0 if compiled["gate_status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
