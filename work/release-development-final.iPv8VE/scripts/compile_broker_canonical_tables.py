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

from compile_broker_candidate_manifest import compile_manifest


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_artifact_name(value: Any) -> str:
    candidate = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "").strip())
    return candidate.strip("-.") or "surface"


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


PERIOD_LIKE_TOKEN = re.compile(
    r"^(?:(?:fy|cy)\s*\d|(?:q[1-4]|[1-4]q|h[12]|[12]h)\b|"
    r"(?:ltm|ntm|ttm)\b|(?:3|6|9)m\s*(?:fy|cy)?\s*\d|"
    r"(?:19|20)\d{1,3}(?:\s*/\s*\d{1,4})?)",
    re.I,
)


def surface_position(surface_id: Any) -> tuple[str, int] | None:
    """Return the document-local surface family and ordinal."""
    match = re.search(r"^(.*)\.(?:p|s)(\d+)$", str(surface_id or ""))
    if not match:
        return None
    return match.group(1), int(match.group(2))


def table_column_count(table: dict[str, Any]) -> int:
    return max(
        (int(cell.get("column", 0)) for row in table.get("rows", []) for cell in row),
        default=0,
    )


def table_period_headers(table: dict[str, Any]) -> dict[int, str]:
    headers: dict[int, str] = {
        int(item["column"]): str(item["period_label"])
        for item in table.get("effective_period_headers", [])
        if period_token(item.get("period_label"))
    }
    for row in table.get("rows", []):
        for cell in row:
            if period_token(cell.get("raw_text")):
                headers[int(cell.get("column", 0))] = str(cell.get("raw_text") or "").strip()
    return headers


def table_unresolved_period_columns(table: dict[str, Any]) -> set[int]:
    columns: set[int] = set()
    for row in table.get("rows", []):
        for cell in row:
            raw = re.sub(r"\s+", " ", str(cell.get("raw_text") or "").strip())
            if raw and PERIOD_LIKE_TOKEN.search(raw) and not period_token(raw):
                columns.add(int(cell.get("column", 0)))
    return columns


def header_fragment_only(table: dict[str, Any]) -> bool:
    """Return True only for a native table made solely of broken period text.

    PDF table finders frequently emit a narrow, header-only object whose box is
    just outside the rendered table box.  Such an object has no economic row
    label and no value authority; retaining it beside a verified rendered grid
    manufactures a second unresolved table.  The test is intentionally strict:
    every nonblank cell must be a complete period or a period-shaped fragment,
    there must be at least one unresolved fragment, and there may be no numeric
    economic value.  A disjoint table with a real row label therefore survives.
    """
    values = [
        re.sub(r"\s+", " ", str(cell.get("raw_text") or "").strip())
        for row in table.get("rows", [])
        for cell in row
        if str(cell.get("raw_text") or "").strip()
    ]
    if not values or not any(PERIOD_LIKE_TOKEN.search(value) and not period_token(value) for value in values):
        return False
    return all(
        period_token(value) is not None
        or bool(PERIOD_LIKE_TOKEN.search(value))
        for value in values
    ) and not table_numeric_tokens(table)


def rendered_has_complete_period_grid(table: dict[str, Any]) -> bool:
    """A rendered authority can supersede a header fragment only when complete."""
    return has_rendered_authority(table) and len(table_period_headers(table)) >= 2


def continuation_certificate(
    previous: dict[str, Any], current: dict[str, Any]
) -> dict[str, Any] | None:
    """Prove an adjacent-page continuation without changing source cells.

    Repeated headers are direct evidence.  Omitted or truncated headers may be
    inherited only when adjacent surfaces share document lineage, table title,
    units and column geometry.  The certificate records the exact inherited
    columns; downstream code never relabels an inference as raw source text.
    """
    prior_position = surface_position(previous.get("surface_id"))
    current_position = surface_position(current.get("surface_id"))
    if (
        not prior_position
        or not current_position
        or prior_position[0] != current_position[0]
        or current_position[1] != prior_position[1] + 1
    ):
        return None
    prior_headers = table_period_headers(previous)
    current_headers = table_period_headers(current)
    if len(prior_headers) < 2:
        return None
    same_columns = table_column_count(previous) == table_column_count(current)
    prior_title = normalise(previous.get("title"))
    prior_lineage_title = normalise(
        (previous.get("continuation_certificate") or {}).get("continuation_title")
    ) or prior_title
    current_title = normalise(current.get("title"))
    continued_title = re.sub(r"\b(?:continued|contd|cont)\b", "", current_title).strip()
    same_title = bool(
        prior_lineage_title
        and (
            prior_lineage_title == current_title
            or prior_lineage_title == continued_title
        )
    )
    title_continuation = same_title or bool(prior_lineage_title and not current_title)
    prior_units = normalise(previous.get("units"))
    current_units = normalise(current.get("units"))
    compatible_units = not prior_units or not current_units or prior_units == current_units
    if not same_columns or not compatible_units:
        return None

    if current_headers == prior_headers:
        basis = "repeated_header"
        inherited: list[dict[str, Any]] = []
    else:
        unresolved_columns = table_unresolved_period_columns(current)
        inheritable_columns = sorted(
            column for column in prior_headers
            if column not in current_headers
            and (not current_headers or column in unresolved_columns)
        )
        # Header omission/truncation needs the stronger title match because
        # adjacent pages can contain unrelated tables with the same width.
        if not title_continuation or not inheritable_columns:
            return None
        basis = "truncated_header" if unresolved_columns else "omitted_header"
        inherited = [
            {
                "column": column,
                "period_label": prior_headers[column],
                "source_table_id": previous["canonical_table_id"],
                "source_surface_id": previous["surface_id"],
            }
            for column in inheritable_columns
        ]

    body = {
        "schema_version": "broker-table-continuation-certificate/1.0",
        "predecessor_table_id": previous["canonical_table_id"],
        "predecessor_surface_id": previous["surface_id"],
        "current_surface_id": current["surface_id"],
        "basis": basis,
        "same_title": same_title,
        "title_continuation": title_continuation,
        "continuation_title": prior_lineage_title or current_title or None,
        "compatible_units": compatible_units,
        "same_column_count": same_columns,
        "inherited_period_headers": inherited,
    }
    return {
        **body,
        "certificate_sha256": hashlib.sha256(canonical_bytes(body)).hexdigest(),
    }


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


def rendered_native_authority_pair(left: dict[str, Any], right: dict[str, Any]) -> bool:
    """A verified rendered table may adjudicate a conflicting native lane.

    The rendered contributor is not a raw OCR guess: it is either two-pass
    visual consensus or a conflict-ledger-bound reviewed resolution. Native
    extraction remains discovery/corroboration evidence, but cannot create a
    second blocking table after the visual conflict has already been resolved.
    """
    rendered = [item for item in (left, right) if has_rendered_authority(item)]
    native = [item for item in (left, right) if not has_rendered_authority(item)]
    return len(rendered) == 1 and len(native) == 1


def native_table_covered_by_rendered(
    native: dict[str, Any], rendered_tables: list[dict[str, Any]]
) -> bool:
    """Prove a native table is a corroborating read of a rendered table.

    A page may contain several genuinely separate tables, so the presence of
    any rendered table cannot suppress every native table on that page.  A
    native lane is superseded only when it physically intersects a rendered
    table, or when both lanes share an economic row label and numeric value.
    The latter covers PDF extractors whose boxes shrink to a header/body
    fragment while retaining immutable row/value evidence.
    """
    native_observations = economic_observations(native)
    native_labels = {label for label, _period in native_observations}
    native_tokens = set(table_numeric_tokens(native))
    for rendered in rendered_tables:
        if bbox_min_overlap(native.get("bbox"), rendered.get("bbox")) > 0.0:
            return True
        if header_fragment_only(native) and rendered_has_complete_period_grid(rendered):
            # Same surface is guaranteed by canonicalise_tables' by-surface
            # grouping.  The native object carries no economic observation;
            # the complete dual-read grid owns the visible header authority.
            return True
        rendered_observations = economic_observations(rendered)
        rendered_labels = {label for label, _period in rendered_observations}
        rendered_tokens = set(table_numeric_tokens(rendered))
        if native_labels.intersection(rendered_labels) and native_tokens.intersection(rendered_tokens):
            return True
    return False


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
        surface_tables = sorted(by_surface[surface_id], key=lambda item: item["table_id"])
        rendered_tables = [item for item in surface_tables if has_rendered_authority(item)]
        native_tables = [item for item in surface_tables if not has_rendered_authority(item)]
        if rendered_tables:
            # Vision compilation accepts a rendered surface only after two
            # independent, hash-bound reads agree (or one targeted resolution
            # dispositions every displayed conflict).  That accepted surface
            # is therefore the physical table authority.  Native PDF lanes are
            # still preserved by the source-bundle hash, artifacts and numeric
            # receipt, but they must not survive as competing analytical
            # tables merely because a PDF extractor emitted a smaller/different
            # bounding box.  In particular, truncated native year fragments
            # must not manufacture unresolved period cells beside a complete
            # rendered header.
            #
            # Conflicts between rendered tables are deliberately NOT hidden:
            # they remain in ``remaining`` and are checked below.  Model-linked
            # value accuracy is independently enforced by the crosswalk and
            # semantic verifier after this physical-capture boundary.
            superseded_native = [
                item for item in native_tables
                if native_table_covered_by_rendered(item, rendered_tables)
            ]
            for rendered in rendered_tables:
                corroborating = [
                    item for item in superseded_native
                    if native_table_covered_by_rendered(item, [rendered])
                ]
                if not corroborating:
                    continue
                rendered["source_table_ids"] = sorted({
                    *(
                        str(item)
                        for item in (rendered.get("source_table_ids") or [rendered["table_id"]])
                    ),
                    *(str(item["table_id"]) for item in corroborating),
                })
                rendered["extraction_methods"] = sorted({
                    *(
                        str(item)
                        for item in (
                            rendered.get("extraction_methods")
                            or [rendered.get("extraction_method")]
                        )
                        if item
                    ),
                    *(
                        str(method)
                        for item in corroborating
                        for method in (
                            item.get("extraction_methods")
                            or [item.get("extraction_method")]
                        )
                        if method
                    ),
                })
            unmatched_native = [
                item for item in native_tables if item not in superseded_native
            ]
            remaining = [*rendered_tables, *unmatched_native]
            if superseded_native:
                findings.append({
                    "id": "broker_canonical.native_tables_superseded_by_rendered_surface",
                    "severity": "warning",
                    "scope": "physical_capture",
                    "model_linked": False,
                    "surface_id": surface_id,
                    "rendered_table_ids": [item["table_id"] for item in rendered_tables],
                    "native_table_ids": [item["table_id"] for item in superseded_native],
                    "message": (
                        "The independently verified rendered surface is the physical table authority; "
                        "native PDF table lanes remain preserved as corroboration and cannot create "
                        "competing analytical rows or period headers."
                    ),
                })
        else:
            remaining = surface_tables
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
                verified_rendered_adjudication = (
                    (overlap >= 0.70 or nested_overlap >= 0.85)
                    and rendered_native_authority_pair(seed, candidate)
                )
                if exact_same_region or verified_rendered_adjudication or ((overlap >= 0.70 or nested_overlap >= 0.85) and contained) or segmentation_equivalent(seed, candidate):
                    group.append(candidate)
                    remaining.remove(candidate)
                elif overlap >= 0.70 or nested_overlap >= 0.85:
                    conflicts.append(candidate)
            if conflicts:
                rendered_conflict = any(
                    has_rendered_authority(item)
                    for item in [seed, *conflicts]
                )
                findings.append({
                    "id": "broker_canonical.overlap_conflict",
                    "severity": "needs_resolution" if rendered_conflict else "needs_vision",
                    "scope": "physical_capture",
                    "model_linked": False,
                    "remedy": "targeted_cell_adjudication" if rendered_conflict else "independent_rendered_grid",
                    "surface_id": surface_id,
                    "table_ids": [seed["table_id"], *[item["table_id"] for item in conflicts]],
                    "conflicts": [
                        conflict
                        for candidate in conflicts
                        for conflict in observation_conflicts(seed, candidate)
                    ],
                    "message": (
                        "Overlapping lanes have not yet been reconciled to one physical table. "
                        "This is bounded internal capture work, not evidence that the readable source is unusable."
                    ),
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

    # Build a deterministic continuation graph. Raw page cells remain
    # immutable; inferred headers live only in a hash-bound certificate.
    ordered = sorted(
        canonical,
        key=lambda item: (
            surface_position(item.get("surface_id")) or (str(item.get("surface_id")), 0),
            item["canonical_table_id"],
        ),
    )
    prior_tables: list[dict[str, Any]] = []
    for table in ordered:
        current_position = surface_position(table.get("surface_id"))
        candidates = [
            (candidate, continuation_certificate(candidate, table))
            for candidate in prior_tables
            if current_position
            and surface_position(candidate.get("surface_id"))
            and surface_position(candidate.get("surface_id"))[0] == current_position[0]
            and surface_position(candidate.get("surface_id"))[1] == current_position[1] - 1
        ]
        proven = [(candidate, certificate) for candidate, certificate in candidates if certificate]
        # Ambiguity is fail-safe: no inheritance when two predecessor tables
        # independently look compatible.
        if len(proven) == 1:
            previous, certificate = proven[0]
            table["continuation_of"] = previous["canonical_table_id"]
            table["continuation_certificate"] = certificate
            table["effective_period_headers"] = [
                *(
                    {
                        "column": column,
                        "period_label": label,
                        "authority": "source_cell",
                        "source_table_id": table["canonical_table_id"],
                        "source_surface_id": table["surface_id"],
                    }
                    for column, label in sorted(table_period_headers(table).items())
                ),
                *(
                    {
                        **item,
                        "authority": "continuation_certificate",
                    }
                    for item in certificate["inherited_period_headers"]
                ),
            ]
        else:
            table["continuation_of"] = None
            table["continuation_certificate"] = None
            table["effective_period_headers"] = [
                {
                    "column": column,
                    "period_label": label,
                    "authority": "source_cell",
                    "source_table_id": table["canonical_table_id"],
                    "source_surface_id": table["surface_id"],
                }
                for column, label in sorted(table_period_headers(table).items())
            ]
        prior_tables.append(table)
    return ordered, findings


def physical_capture_receipt(
    *,
    document_id: str | None,
    surface: dict[str, Any],
    tables: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Seal physical preservation without pretending it is semantic authority.

    Native coordinates, table extractors, OCR and rendered vision are
    corroborating observations of one visible surface. Their raw token
    multiplicities need not agree: segmentation can repeat a year header or
    split one visible number across lanes. A dual-read/adjudicated rendered
    grid is the physical authority for that surface; native-only disagreement
    instead requests the next bounded internal lane. Whether any captured cell
    may drive the model remains a later crosswalk/semantic decision.
    """
    surface_id = str(surface.get("surface_id") or "")
    source = Counter(surface.get("source_table_numeric_tokens") or [])
    captured = Counter(
        token for table in tables for token in table_numeric_tokens(table)
    )
    missing = sorted((source - captured).elements())
    unowned = sorted((captured - source).elements())
    rendered = any(has_rendered_authority(table) for table in tables)
    verified_non_tabular = surface.get("vision_disposition") == "verified_non_tabular"
    quarantined_evidence_only = (
        surface.get("vision_disposition") == "quarantined_evidence_only"
    )
    findings: list[dict[str, Any]] = []

    if quarantined_evidence_only:
        # Physical preservation is COMPLETE (bytes, renders, raw fragments all
        # sealed); model authority is separately prohibited by the quarantine.
        status = "PASS_EVIDENCE_ONLY"
        basis = "bounded_quarantine_after_exhaustion"
        findings.append({
            "id": "broker_canonical.surface_quarantined_evidence_only",
            "severity": "warning",
            "scope": "physical_capture",
            "model_linked": False,
            "document_id": document_id,
            "surface_id": surface_id,
            "message": (
                "Bounded reconciliation was exhausted; the surface is preserved as "
                "evidence-only and contributes no model-eligible table."
            ),
        })
    elif verified_non_tabular:
        status = "PASS_EVIDENCE_ONLY"
        basis = "two_pass_verified_non_tabular"
    elif tables and not missing and not unowned:
        status = "PASS_ANALYTICAL"
        basis = "rendered_grid" if rendered else "bounded_native_geometry"
    elif tables and rendered:
        # The rendered table is already bound to two independent reads or a
        # conflict-ledger resolution. Preserve native disagreement in the
        # receipt, but do not allow it to erase a visibly complete grid.
        status = "PASS_ANALYTICAL"
        basis = "rendered_grid_resolves_native_lane_disagreement"
        findings.append({
            "id": "broker_canonical.native_lane_disagreement_resolved",
            "severity": "warning",
            "scope": "physical_capture",
            "model_linked": False,
            "document_id": document_id,
            "surface_id": surface_id,
            "missing_native_tokens": missing,
            "unowned_native_tokens": unowned,
            "message": (
                "A hash-bound independently verified rendered grid preserves the visible table; "
                "native-lane token multiplicity differs and remains recorded as corroboration evidence."
            ),
        })
    elif tables or source:
        status = "NEEDS_VISION"
        basis = "native_lane_reconciliation_pending"
        findings.append({
            "id": "broker_canonical.physical_capture_reconciliation_required",
            "severity": "needs_vision",
            "scope": "physical_capture",
            "model_linked": False,
            "remedy": "independent_rendered_grid",
            "document_id": document_id,
            "surface_id": surface_id,
            "missing_native_tokens": missing,
            "unowned_native_tokens": unowned,
            "message": (
                "Native extraction lanes do not yet reconcile to one complete visible grid. "
                "Run the bounded rendered/OCR recovery lane; do not request a replacement readable report."
            ),
        })
    else:
        # A native-readable page with no table-region numbers is retained in
        # the source inventory but cannot manufacture a model table.
        status = "PASS_EVIDENCE_ONLY"
        basis = "native_surface_has_no_tabular_numeric_region"

    receipt = {
        "surface_id": surface_id,
        "status": status,
        "verification_basis": basis,
        "physical_capture_complete": status.startswith("PASS_"),
        "analytical_table_count": len(tables),
        "source_table_numeric_token_count": sum(source.values()),
        "captured_numeric_token_count": sum(captured.values()),
        "missing_native_tokens": missing,
        "unowned_native_tokens": unowned,
        "model_linked_accuracy_status": "PENDING_SEMANTIC_CROSSWALK",
    }
    return receipt, findings


def pending_physical_findings(
    findings: list[dict[str, Any]],
    *,
    document_id: Any,
    surface_id: Any,
) -> list[dict[str, Any]]:
    """Return every canonical physical-capture instruction for one surface."""
    return [
        finding
        for finding in findings
        if finding.get("document_id") == document_id
        and finding.get("surface_id") == surface_id
        and finding.get("scope") == "physical_capture"
        and finding.get("severity") in {"needs_vision", "needs_resolution"}
    ]


def ensure_late_promotion_tasks(
    bundle: dict[str, Any],
    findings: list[dict[str, Any]],
    *,
    fallback_artifact_root: Path,
) -> list[dict[str, Any]]:
    """Mint the task artifact that a canonical-stage promotion requires.

    Extraction cannot create a task for a surface that initially passed.  If
    canonical reconciliation later proves that the same rendered PDF/image
    needs another read, this compiler owns that transition and therefore owns
    the deterministic task.  Existing extraction-time tasks remain immutable;
    only a missing late-promotion task is created here.
    """
    root_value = str(bundle.get("artifact_root") or "").strip()
    artifact_root = Path(root_value).resolve() if root_value else fallback_artifact_root.resolve()
    added_findings: list[dict[str, Any]] = []
    for document in bundle.get("documents", []):
        document_id = document.get("document_id")
        artifacts = document.setdefault("artifacts", [])
        artifacts_by_id = {str(item.get("artifact_id")): item for item in artifacts}
        for surface in document.get("surfaces", []):
            surface_id = surface.get("surface_id")
            pending = pending_physical_findings(
                findings,
                document_id=document_id,
                surface_id=surface_id,
            )
            if not pending:
                continue
            surface.setdefault("lane_status", {})["vision"] = "required"
            surface["vision_reason"] = "canonical physical reconciliation requires an independently rendered grid"
            document["extraction_status"] = "needs_vision"
            task_artifacts = [
                artifacts_by_id.get(str(ref))
                for ref in surface.get("artifact_refs", [])
                if (artifacts_by_id.get(str(ref)) or {}).get("kind") == "vision_task"
            ]
            if task_artifacts:
                continue
            image_artifact = next(
                (
                    artifacts_by_id.get(str(ref))
                    for ref in surface.get("artifact_refs", [])
                    if (artifacts_by_id.get(str(ref)) or {}).get("kind") == "page_image"
                ),
                None,
            )
            census_artifact = next(
                (
                    artifacts_by_id.get(str(ref))
                    for ref in surface.get("artifact_refs", [])
                    if (artifacts_by_id.get(str(ref)) or {}).get("kind") == "surface_census"
                ),
                None,
            )
            if (
                surface.get("kind") not in {"pdf_page", "image_page"}
                or image_artifact is None
                or census_artifact is None
            ):
                added_findings.append({
                    "id": "broker_canonical.late_promotion_not_renderable",
                    "severity": "blocker",
                    "scope": "controller_integrity",
                    "model_linked": None,
                    "document_id": document_id,
                    "surface_id": surface_id,
                    "message": (
                        "Canonical reconciliation requested rendered recovery for a surface without a "
                        "sealed page image and census. This is an internal compiler defect, not a request to replace the source."
                    ),
                })
                continue
            image_path = artifact_root / str(image_artifact.get("path") or "")
            census_path = artifact_root / str(census_artifact.get("path") or "")
            if (
                not image_path.is_file()
                or sha256_file(image_path) != image_artifact.get("sha256")
                or not census_path.is_file()
                or sha256_file(census_path) != census_artifact.get("sha256")
            ):
                added_findings.append({
                    "id": "broker_canonical.late_promotion_image_integrity",
                    "severity": "blocker",
                    "scope": "controller_integrity",
                    "model_linked": None,
                    "document_id": document_id,
                    "surface_id": surface_id,
                    "message": (
                        "The sealed page image or census needed by canonical late recovery is absent or hash-mismatched. "
                        "This is an internal artifact-integrity failure."
                    ),
                })
                continue
            finding_projection = [
                {
                    "id": item.get("id"),
                    "severity": item.get("severity"),
                    "remedy": item.get("remedy"),
                    "table_ids": item.get("table_ids"),
                    "missing_native_tokens": item.get("missing_native_tokens"),
                    "unowned_native_tokens": item.get("unowned_native_tokens"),
                }
                for item in pending
            ]
            authority_sha256 = hashlib.sha256(canonical_bytes({
                "document_id": document_id,
                "surface_id": surface_id,
                "page_image_sha256": image_artifact.get("sha256"),
                "source_census_sha256": census_artifact.get("sha256"),
                "findings": finding_projection,
            })).hexdigest()
            task_id = f"{surface_id}-late-vision-{authority_sha256[:16]}"
            relative_path = Path("late-vision") / f"{safe_artifact_name(surface_id)}-{authority_sha256[:16]}.task.json"
            task_path = artifact_root / relative_path
            task = {
                "schema_version": "broker-vision-task/1.0",
                "document_id": document_id,
                "surface_id": surface_id,
                "image_artifact_id": image_artifact.get("artifact_id"),
                "reason": "late canonical physical-capture promotion",
                "required_passes": 2,
                "source_census_artifact_id": census_artifact.get("artifact_id"),
                "uncovered_region_ids": [],
                "region_crops": [],
                "canonical_promotion_sha256": authority_sha256,
                "canonical_finding_ids": sorted({str(item.get("id")) for item in pending}),
                "instruction": (
                    "Independently transcribe every visible table on this rendered surface as a grid with exact "
                    "row labels, period headers, values, blanks, signs, units and continuations. Do not return a "
                    "flat numeric inventory. If no analytical table is visible, certify verified_non_tabular with "
                    "a specific reason. This task was promoted by canonical reconciliation and is internal work; "
                    "do not request replacement research."
                ),
            }
            task_path.parent.mkdir(parents=True, exist_ok=True)
            task_path.write_bytes(canonical_bytes(task))
            task_artifact = {
                "artifact_id": task_id,
                "kind": "vision_task",
                "path": relative_path.as_posix(),
                "sha256": sha256_file(task_path),
            }
            artifacts.append(task_artifact)
            artifacts_by_id[task_id] = task_artifact
            surface.setdefault("artifact_refs", []).append(task_id)
    findings.extend(added_findings)
    return added_findings


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
        capture_receipts = []
        for surface in document.get("surfaces", []):
            receipt, receipt_findings = physical_capture_receipt(
                document_id=document.get("document_id"),
                surface=surface,
                tables=[
                    table for table in tables
                    if table.get("surface_id") == surface.get("surface_id")
                ],
            )
            capture_receipts.append(receipt)
            all_findings.extend(receipt_findings)
            if receipt["status"] == "NEEDS_VISION":
                surface.setdefault("lane_status", {})["vision"] = "required"
                surface["vision_reason"] = (
                    "native physical-table lanes require one independently rendered grid"
                )
                document["extraction_status"] = "needs_vision"
        # Table-lane overlap findings are created before the per-surface
        # token receipt and can require resolution even when that receipt is
        # otherwise complete. Project every pending canonical finding back to
        # the owning surface so the controller cannot emit a taskless state.
        for surface in document.get("surfaces", []):
            if pending_physical_findings(
                all_findings,
                document_id=document.get("document_id"),
                surface_id=surface.get("surface_id"),
            ):
                surface.setdefault("lane_status", {})["vision"] = "required"
                surface["vision_reason"] = "canonical physical reconciliation remains pending"
                document["extraction_status"] = "needs_vision"
        document["physical_capture_receipts"] = capture_receipts
    canonical_documents = [
        table
        for document in sorted(output.get("documents", []), key=lambda item: str(item.get("document_id")))
        for table in sorted(
            document.get("canonical_tables", []),
            key=lambda item: str(item.get("canonical_table_id") or item.get("table_id")),
        )
    ]
    output["canonical_tables_sha256"] = hashlib.sha256(canonical_bytes(canonical_documents)).hexdigest()
    all_receipts = [
        receipt
        for document in output.get("documents", [])
        for receipt in document.get("physical_capture_receipts", [])
    ]
    output["physical_capture_receipt"] = {
        "schema_version": "broker-physical-capture-receipt/1.0",
        "status": (
            "NEEDS_RESOLUTION"
            if any(item.get("severity") == "needs_resolution" for item in all_findings)
            else "NEEDS_VISION"
            if any(item.get("severity") == "needs_vision" for item in all_findings)
            else "PASS"
        ),
        "surface_count": len(all_receipts),
        "complete_surface_count": sum(
            1 for item in all_receipts if item.get("physical_capture_complete") is True
        ),
        "analytical_surface_count": sum(
            1 for item in all_receipts if item.get("status") == "PASS_ANALYTICAL"
        ),
        "evidence_only_surface_count": sum(
            1 for item in all_receipts if item.get("status") == "PASS_EVIDENCE_ONLY"
        ),
        "pending_surface_ids": sorted({
            *(
                item.get("surface_id") for item in all_receipts
                if not item.get("physical_capture_complete")
            ),
            *(
                item.get("surface_id") for item in all_findings
                if item.get("scope") == "physical_capture"
                and item.get("severity") in {"needs_vision", "needs_resolution"}
                and item.get("surface_id")
            ),
        }),
        "model_linked_accuracy_status": "PENDING_SEMANTIC_CROSSWALK",
    }
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
    ensure_late_promotion_tasks(
        compiled,
        findings,
        fallback_artifact_root=input_path.parent,
    )
    for document in compiled.get("documents", []):
        document["tables"] = copy.deepcopy(document.get("canonical_tables", []))
    # This is still the broker extraction bundle after canonical physical
    # reconciliation. Keep one public bundle schema across controller stages;
    # the canonical-table version is carried by its own nested receipt/assets.
    compiled["schema_version"] = "broker-extraction-bundle/1.0"
    compiled["source_bundle_sha256"] = hashlib.sha256(input_path.read_bytes()).hexdigest()
    compiled["canonical_findings"] = findings
    compiled["gate_status"] = compiled["physical_capture_receipt"]["status"]
    compiled["candidate_manifest"] = compile_manifest(
        compiled,
        source_bundle_sha256=compiled["source_bundle_sha256"],
    )
    if (
        compiled["candidate_manifest"].get("gate_status") == "BLOCKED"
        or any(item.get("severity") == "blocker" for item in findings)
    ):
        compiled["gate_status"] = "BLOCKED"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(canonical_bytes(compiled))
    print(json.dumps({"status": compiled["gate_status"], "findings": len(findings), "sha256": compiled["canonical_tables_sha256"]}, sort_keys=True))
    return 0 if compiled["gate_status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
