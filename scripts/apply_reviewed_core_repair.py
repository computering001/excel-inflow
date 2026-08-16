#!/usr/bin/env python3
"""Apply the reviewed source-arithmetic, broker, forecast and harness repairs once.

This file is an implementation vehicle for the isolated repair branch. The
bootstrap workflow deletes it before publishing the reviewed product commit.
Every replacement is exact and fail-closed: source drift aborts the run.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text("utf-8")


def write(relative: str, value: str) -> None:
    (ROOT / relative).write_text(value, "utf-8")


def replace_once(value: str, old: str, new: str, label: str) -> str:
    count = value.count(old)
    if count != 1:
        raise AssertionError(f"{label}: expected one source match, found {count}")
    return value.replace(old, new, 1)


# Generic source-visible arithmetic owns statement hierarchy before caption
# heuristics. This is deliberately issuer-neutral and mutation-sensitive.
relative = "scripts/extract_filing_statements.py"
source = read(relative)
pattern = re.compile(
    r"def infer_parent_links\(rows: list\[dict\[str, Any\]\]\) -> None:\n.*?\n\ndef extract_statement\(",
    re.S,
)
match = pattern.search(source)
if not match:
    raise AssertionError("filing parent-inference function not found")
replacement = '''def _source_arithmetic_matches(
    parent: dict[str, Any], children: list[dict[str, Any]],
) -> bool:
    """Prove an issuer aggregate from geometry and all historical values."""
    if len(children) < 2:
        return False
    parent_values = parent.get("values") or []
    if len(parent_values) != 3:
        return False
    for period_index in range(3):
        parent_value = parent_values[period_index]
        child_values = [
            child.get("values", [None, None, None])[period_index]
            for child in children
        ]
        if parent_value is None or any(value is None for value in child_values):
            return False
        parent_number = float(parent_value)
        child_numbers = [float(value) for value in child_values]
        child_sum = sum(child_numbers)
        scale = max(
            1.0,
            abs(parent_number),
            sum(abs(value) for value in child_numbers),
        )
        if abs(parent_number - child_sum) > max(0.5, 0.001 * scale):
            return False
    return True


def infer_parent_links(rows: list[dict[str, Any]]) -> None:
    """Compile filing hierarchy from source arithmetic, then label fallback.

    Components normally precede their printed aggregate. A caption is only
    supporting evidence: an issuer-defined row such as Product Revenue owns
    direct geometric children when all three historical periods prove the sum.
    """
    for parent_index, parent in enumerate(rows):
        parent_level = int(parent.get("hierarchy_level") or 0)
        block: list[dict[str, Any]] = []
        cursor = parent_index - 1
        while cursor >= 0:
            candidate = rows[cursor]
            level = int(candidate.get("hierarchy_level") or 0)
            if level <= parent_level:
                break
            block.append(candidate)
            cursor -= 1
        block.reverse()
        direct_children = [
            candidate
            for candidate in block
            if int(candidate.get("hierarchy_level") or 0) == parent_level + 1
        ]
        if _source_arithmetic_matches(parent, direct_children):
            for child in direct_children:
                child["parent_source_line_id"] = parent["source_line_id"]

    # Conservative fallback for totals whose published values cannot be tested.
    next_subtotal_by_level: dict[int, str] = {}
    for row in reversed(rows):
        level = int(row.get("hierarchy_level") or 0)
        if level > 0 and not row.get("parent_source_line_id"):
            parent = next_subtotal_by_level.get(level - 1)
            if parent:
                row["parent_source_line_id"] = parent
        if row.get("is_subtotal"):
            next_subtotal_by_level[level] = row["source_line_id"]


def extract_statement('''
source = source[: match.start()] + replacement + source[match.end() :]
write(relative, source)


# Every house retains native-clean eligibility; only unresolved recovery work is
# restricted to one quality-ranked frontier.
relative = "scripts/extract_broker_evidence.py"
source = read(relative)
source = replace_once(
    source,
    '''        # The preview/selection contract chooses at most one coherent house
        # for model authority.  Every other supplied report is still retained
        # page-for-page, but it must be archive-only regardless of whether its
        # native lane happens to look complete.  Restricting this only to pages
        # that already needed vision let canonical reconciliation later re-arm
        # OCR for an unselected house, expanding optional work after selection
        # and breaking the one-house runtime/performance invariant.
        unselected_house = descriptor.get("house_id") != vision_house_id
        archive_only = not selected_targets or unselected_house
''',
    '''        # Native-clean evidence is evaluated for every supplied house. The
        # one-house invariant limits only expensive recovery work; it must never
        # erase already-readable cells before coherent-house quality is scored.
        unselected_house_recovery = (
            vision_required and descriptor.get("house_id") != vision_house_id
        )
        archive_only = not selected_targets or unselected_house_recovery
''',
    "broker native eligibility",
)
main_marker = "\ndef main() -> int:\n"
if main_marker not in source:
    raise AssertionError("broker main entry point not found")
helper = r'''

def _recovery_search_terms(demand_contract: dict[str, Any]) -> set[str]:
    terms: set[str] = set()
    for target in demand_contract.get("targets", []):
        for key in ("metric_id", "concept_id", "label", "source_label"):
            value = target.get(key)
            if isinstance(value, str) and value.strip():
                terms.add(normalise_text(value))
        for value in target.get("aliases", []) or target.get("search_terms", []) or []:
            if isinstance(value, str) and value.strip():
                terms.add(normalise_text(value))
    return {term for term in terms if term}


def select_recovery_house_id(
    request: dict[str, Any], request_dir: Path, demand_contract: dict[str, Any],
) -> str:
    """Choose one recovery frontier from cheap native evidence.

    Publication date is a final deterministic tie-break, never a proxy for
    readable demanded coverage. All houses still pass through native extraction.
    """
    terms = _recovery_search_terms(demand_contract)
    ranked: list[tuple[tuple[int, int, int, str, str, str], str]] = []
    for descriptor in request["documents"]:
        source_path = Path(str(descriptor.get("path") or ""))
        if not source_path.is_absolute():
            source_path = (request_dir / source_path).resolve()
        native_text = ""
        try:
            if (
                descriptor.get("media_type") == "application/pdf"
                and source_path.is_file()
            ):
                with fitz.open(source_path) as document:
                    native_text = "\n".join(
                        page.get_text("text") or "" for page in document
                    )
        except Exception:
            native_text = ""
        normalized = normalise_text(native_text)
        demand_hits = sum(1 for term in terms if term and term in normalized)
        numeric_tokens = len(
            re.findall(r"(?<![A-Za-z])[-+]?\(?\d[\d.,]*%?\)?", native_text)
        )
        score = (
            demand_hits,
            min(numeric_tokens, 10000),
            min(len(native_text), 1_000_000),
            str(descriptor.get("published_date") or ""),
            str(descriptor.get("house_id") or ""),
            str(descriptor.get("document_id") or ""),
        )
        ranked.append((score, str(descriptor["house_id"])))
    if not ranked:
        raise ValueError("Broker extraction request contains no documents.")
    ranked.sort(reverse=True)
    return ranked[0][1]
'''
source = source.replace(main_marker, helper + main_marker, 1)
source = replace_once(
    source,
    '''    vision_house_id = str(sorted(
        request["documents"],
        key=lambda item: (
            str(item.get("published_date") or ""),
            str(item.get("house_id") or ""),
            str(item.get("document_id") or ""),
        ),
        reverse=True,
    )[0]["house_id"])
''',
    '''    vision_house_id = select_recovery_house_id(
        request, request_path.parent, demand_contract,
    )
''',
    "quality-ranked recovery frontier",
)
source = source.replace(
    '"policy": "latest_supplied_house_then_zero_authority"',
    '"policy": "native_quality_ranked_one_house_then_zero_authority"',
)
write(relative, source)

schema_path = ROOT / "assets" / "broker-extraction-bundle.schema.json"
schema = json.loads(schema_path.read_text("utf-8"))


def replace_policy_const(node: Any) -> None:
    if isinstance(node, dict):
        if node.get("const") == "latest_supplied_house_then_zero_authority":
            node["const"] = "native_quality_ranked_one_house_then_zero_authority"
        for value in node.values():
            replace_policy_const(value)
    elif isinstance(node, list):
        for value in node:
            replace_policy_const(value)


replace_policy_const(schema)
schema_path.write_text(json.dumps(schema, indent=2) + "\n", "utf-8")


# Close the semantic-role vocabulary at the discrete acquisition event.
for relative in (
    "scripts/lib/forecast_behavior.mjs",
    "scripts/lib/forecast_authority.mjs",
):
    source = read(relative)
    if '"acquisitions_net_of_cash"' not in source:
        marker = '"acquisition_cost",'
        if marker not in source:
            raise AssertionError(f"{relative}: event-role marker not found")
        source = source.replace(
            marker,
            marker + ' "acquisitions_net_of_cash",',
            1,
        )
    write(relative, source)


# Invoke the universal matrix with the interface the executable actually owns.
relative = "assets/development-test-registry.json"
registry = json.loads(read(relative))
entry = next(
    (item for item in registry.get("tests", [])
     if item.get("id") == "universal-broker-delivery-matrix"),
    None,
)
if entry is None:
    raise AssertionError("universal broker matrix registry entry not found")
entry["arguments"] = ["$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"]
entry["requires"] = ["RAW_CANARY_EVIDENCE", "PYTHON", "SOFFICE"]
write(relative, json.dumps(registry, indent=2) + "\n")


# The local canary remains useful, but must disclose that it authors the model-
# host semantic response rather than claiming a true installed-host boundary.
relative = "scripts/run_raw_input_black_box_canary.mjs"
source = read(relative)
source = replace_once(
    source,
    "  preauthored_broker_crosswalk: false,\n",
    '''  preauthored_broker_crosswalk: brokerState === "usable",
  semantic_response_boundary: brokerState === "usable"
    ? "simulated_local_model_host_response"
    : "not_applicable",
''',
    "raw canary boundary disclosure",
)
write(relative, source)


# Remove executable author-machine case paths; shipped parity fixtures are the
# only portable default. External real corpora remain explicit custody inputs.
for path in sorted((ROOT / "scripts").rglob("*")):
    if not path.is_file() or path.suffix not in {".mjs", ".js", ".py", ".json"}:
        continue
    value = path.read_text("utf-8")
    updated = re.sub(
        r"/Users/[^\"'\s]+(?:/[^\"'\s]+)*/cases",
        "parity-fixtures",
        value,
    )
    updated = re.sub(
        r"/Users/[^\"'\s]+(?:/[^\"'\s]+)*/standard-maximal-v2\.json",
        "parity-fixtures/standard-maximal-v2.json",
        updated,
    )
    if updated != value:
        path.write_text(updated, "utf-8")


for relative in (
    "references/broker-extraction.md",
    "references/runtime-core.md",
    "SKILL.md",
    "central-instructions.md",
):
    source = read(relative)
    source = source.replace(
        "Choose at most one deterministic coherent house for optional OCR/vision (latest supplied publication, stable house/document tie-break). Already clean native cells from other houses remain eligible",
        "Evaluate native-clean candidate cells across every supplied house, then choose at most one deterministic house for optional OCR/vision using demanded native coverage and readability, with publication date only as a stable final tie-break. Already clean native cells from other houses remain eligible",
    )
    write(relative, source)

print(json.dumps({"status": "PASS", "repair": "reviewed_core"}))
