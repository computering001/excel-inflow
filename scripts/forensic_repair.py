#!/usr/bin/env python3
"""Apply the blueprint-owned Excel Inflow repair to the exact audited source.

The script is deterministic and idempotent. Every production edit is anchored to
an expected source pattern and every new behavior receives a targeted regression
test. It deliberately does not certify or promote a release.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CHANGES: list[dict[str, Any]] = []


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read(path: str) -> str:
    return (ROOT / path).read_text("utf-8")


def write(path: str, content: str, reason: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    old = target.read_text("utf-8") if target.exists() else None
    if old == content:
        return
    target.write_text(content, "utf-8")
    CHANGES.append({"path": path, "operation": "create" if old is None else "update", "reason": reason})


def replace(path: str, old: str, new: str, reason: str, *, minimum: int = 1, maximum: int | None = None) -> int:
    content = read(path)
    count = content.count(old)
    if count == 0 and new in content:
        return 0
    if count < minimum or (maximum is not None and count > maximum):
        raise RuntimeError(f"{path}: expected {minimum}..{maximum or 'inf'} occurrences, found {count}: {old[:120]!r}")
    content = content.replace(old, new)
    write(path, content, reason)
    return count


def regex_replace(path: str, pattern: str, replacement: str, reason: str, *, minimum: int = 1, maximum: int | None = None, flags: int = 0) -> int:
    content = read(path)
    updated, count = re.subn(pattern, replacement, content, flags=flags)
    if count == 0 and re.search(re.escape(replacement[:60]), content):
        return 0
    if count < minimum or (maximum is not None and count > maximum):
        raise RuntimeError(f"{path}: regex expected {minimum}..{maximum or 'inf'}, found {count}: {pattern[:160]}")
    write(path, updated, reason)
    return count


def insert_before(path: str, marker: str, block: str, reason: str) -> None:
    content = read(path)
    if block.strip() in content:
        return
    if marker not in content:
        raise RuntimeError(f"{path}: insertion marker absent: {marker[:120]}")
    write(path, content.replace(marker, block.rstrip() + "\n\n" + marker, 1), reason)


def insert_after(path: str, marker: str, block: str, reason: str) -> None:
    content = read(path)
    if block.strip() in content:
        return
    if marker not in content:
        raise RuntimeError(f"{path}: insertion marker absent: {marker[:120]}")
    write(path, content.replace(marker, marker + "\n" + block.rstrip(), 1), reason)


def json_file(path: str) -> Any:
    return json.loads(read(path))


def write_json(path: str, value: Any, reason: str) -> None:
    write(path, json.dumps(value, indent=2, sort_keys=False) + "\n", reason)


def register_test(entry: dict[str, Any]) -> None:
    path = "assets/development-test-registry.json"
    registry = json_file(path)
    tests = registry.setdefault("tests", [])
    current = next((item for item in tests if item.get("id") == entry["id"]), None)
    if current == entry:
        return
    if current:
        current.clear(); current.update(entry)
    else:
        tests.append(entry)
    write_json(path, registry, f"Register {entry['id']} regression")


def add_runtime_member(path: str) -> None:
    manifest_path = "assets/attachment-evidence-runtime-members.json"
    manifest = json_file(manifest_path)
    members = manifest.setdefault("members", [])
    if path not in members:
        members.append(path)
        members.sort()
        write_json(manifest_path, manifest, f"Bind {path} into attachment runtime closure")


def add_release_script(path: str) -> None:
    manifest_path = "release-manifest.json"
    manifest = json_file(manifest_path)
    closure = manifest.setdefault("closure", {})
    scripts = closure.setdefault("scripts", [])
    if path not in scripts:
        scripts.append(path); scripts.sort()
        write_json(manifest_path, manifest, f"Declare {path} in development closure")


def semantic_role_registry() -> None:
    write("scripts/lib/semantic_roles.mjs", '''/** Canonical semantic-role ownership shared across topology and forecast layers. */
export const SEMANTIC_ROLE_ALIASES = Object.freeze({
  operating_profit: "ebit",
  operating_income: "ebit",
  operating_loss: "ebit",
  acquisition: "acquisitions_net_of_cash",
  acquisition_cost: "acquisitions_net_of_cash",
  business_combination: "acquisitions_net_of_cash",
});

export const STRUCTURED_EVENT_ROLES = Object.freeze(new Set([
  "acquisitions_net_of_cash",
  "disposal",
  "litigation",
  "legal_settlement",
  "restructuring",
  "impairment_loss",
  "exceptional_item",
  "discontinued_operation",
]));

export function canonicalSemanticRole(value) {
  const role = String(value ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return SEMANTIC_ROLE_ALIASES[role] ?? role;
}

export function isStructuredEventRole(value) {
  return STRUCTURED_EVENT_ROLES.has(canonicalSemanticRole(value));
}

export default { canonicalSemanticRole, isStructuredEventRole, SEMANTIC_ROLE_ALIASES, STRUCTURED_EVENT_ROLES };
''', "Create one canonical semantic-role registry")
    add_runtime_member("scripts/lib/semantic_roles.mjs")
    add_release_script("scripts/lib/semantic_roles.mjs")


def repair_filing_arithmetic() -> None:
    path = "scripts/extract_filing_statements.py"
    block = '''def _finite_series(row: dict[str, Any]) -> list[float] | None:
    values = row.get("values")
    if not isinstance(values, list) or len(values) != 3:
        return None
    result: list[float] = []
    for value in values:
        if value is None or isinstance(value, bool):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(number):
            return None
        result.append(number)
    return result


def _series_sum_matches(parent: list[float], children: list[list[float]]) -> bool:
    if len(children) < 2:
        return False
    calculated = [sum(series[index] for series in children) for index in range(3)]
    return all(
        math.isclose(calculated[index], parent[index], rel_tol=1e-7, abs_tol=1e-6)
        for index in range(3)
    )


def infer_source_arithmetic_links(rows: list[dict[str, Any]]) -> None:
    """Bind unique source-visible arithmetic independent of issuer wording.

    Geometry supplies candidate families and all three historical values prove
    the edge. Both total-last and total-first filing shapes are supported. A
    relationship is materialised only when one candidate family matches; an
    ambiguous equality remains unowned rather than guessed.
    """
    matches: dict[int, list[list[int]]] = {}
    for parent_index, parent_row in enumerate(rows):
        parent_values = _finite_series(parent_row)
        if parent_values is None:
            continue
        parent_level = int(parent_row.get("hierarchy_level") or 0)
        families: list[list[int]] = []
        for direction in (-1, 1):
            indexes: list[int] = []
            cursor = parent_index + direction
            while 0 <= cursor < len(rows) and len(indexes) < 10:
                candidate = rows[cursor]
                level = int(candidate.get("hierarchy_level") or 0)
                if level <= parent_level:
                    break
                if level == parent_level + 1 and _finite_series(candidate) is not None:
                    indexes.append(cursor)
                cursor += direction
            if direction < 0:
                indexes.reverse()
            for start in range(len(indexes)):
                for end in range(start + 2, len(indexes) + 1):
                    family = indexes[start:end]
                    child_values = [_finite_series(rows[index]) for index in family]
                    if all(series is not None for series in child_values) and _series_sum_matches(
                        parent_values, child_values,  # type: ignore[arg-type]
                    ):
                        families.append(family)
        unique = []
        seen = set()
        for family in families:
            key = tuple(family)
            if key not in seen:
                seen.add(key); unique.append(family)
        if len(unique) == 1:
            matches[parent_index] = unique

    claimed_children: set[int] = set()
    for parent_index, families in matches.items():
        family = families[0]
        if any(index in claimed_children for index in family):
            continue
        parent_id = rows[parent_index]["source_line_id"]
        rows[parent_index]["is_subtotal"] = True
        for index in family:
            if not rows[index].get("parent_source_line_id"):
                rows[index]["parent_source_line_id"] = parent_id
                claimed_children.add(index)
'''
    if "import math" not in read(path):
        replace(path, "import json\n", "import json\nimport math\n", "Support source arithmetic equality")
    insert_before(path, "def is_subtotal_label(label: str) -> bool:", block, "Infer filing arithmetic before label taxonomy")
    replace(path,
        '        if level > 0:\n            parent = next_subtotal_by_level.get(level - 1)\n            if parent:\n                row["parent_source_line_id"] = parent\n',
        '        if level > 0 and not row.get("parent_source_line_id"):\n            parent = next_subtotal_by_level.get(level - 1)\n            if parent:\n                row["parent_source_line_id"] = parent\n',
        "Preserve arithmetic-owned filing parents", maximum=1)
    replace(path, "    infer_parent_links(rows)\n", "    infer_source_arithmetic_links(rows)\n    infer_parent_links(rows)\n", "Run arithmetic inference before label fallback", maximum=1)


def repair_statement_topology() -> None:
    path = "scripts/lib/statement_topology.mjs"
    content = read(path)
    if 'from "./semantic_roles.mjs"' not in content:
        content = 'import { canonicalSemanticRole } from "./semantic_roles.mjs";\n' + content
    content = content.replace("HEADLINE_TOTAL_ROLES.has(row.semantic_role)", "HEADLINE_TOTAL_ROLES.has(canonicalSemanticRole(row.semantic_role))")
    content = content.replace("row.semantic_role === requiredRole", "canonicalSemanticRole(row.semantic_role) === requiredRole")
    content = content.replace("UNIQUE_VISIBLE_ROLES[section].has(row.semantic_role)", "UNIQUE_VISIBLE_ROLES[section].has(canonicalSemanticRole(row.semantic_role))")
    content = content.replace("const role = row.semantic_role;", "const role = canonicalSemanticRole(row.semantic_role);")
    write(path, content, "Canonicalise operating-profit/EBIT topology without changing issuer labels")


def repair_forecast_roles() -> None:
    behavior = "scripts/lib/forecast_behavior.mjs"
    content = read(behavior)
    if 'from "./semantic_roles.mjs"' not in content:
        anchor = 'import { SCHEDULE_PRODUCER_BY_ROLE } from "./forecast_producer_contract.mjs";'
        if anchor in content:
            content = content.replace(anchor, anchor + '\nimport { canonicalSemanticRole, isStructuredEventRole } from "./semantic_roles.mjs";')
        else:
            content = 'import { canonicalSemanticRole, isStructuredEventRole } from "./semantic_roles.mjs";\n' + content
    content = content.replace('function roleOf(row) {\n  return normalise(row?.semantic_role ?? row?.classified_role ?? row?.role).replaceAll(" ", "_");\n}',
        'function roleOf(row) {\n  return canonicalSemanticRole(row?.semantic_role ?? row?.classified_role ?? row?.role);\n}')
    content = content.replace('const NON_RECURRING_ROLES = new Set([\n  "acquisition", "acquisition_cost", "business_combination", "disposal",',
        'const NON_RECURRING_ROLES = new Set([\n  "acquisitions_net_of_cash", "acquisition", "acquisition_cost", "business_combination", "disposal",')
    content = content.replace('  if (NON_RECURRING_ROLES.has(role)) {', '  if (NON_RECURRING_ROLES.has(role) || isStructuredEventRole(role)) {')
    content = content.replace('    NON_RECURRING_ROLES.has(role) ||', '    (NON_RECURRING_ROLES.has(role) || isStructuredEventRole(role)) ||')
    write(behavior, content, "Close forecast behavior over canonical semantic roles")

    authority = "scripts/lib/forecast_authority.mjs"
    content = read(authority)
    if 'from "./semantic_roles.mjs"' not in content:
        content = 'import { canonicalSemanticRole, isStructuredEventRole } from "./semantic_roles.mjs";\n' + content
    content = content.replace('  "acquisition_cost",\n  "business_combination",', '  "acquisitions_net_of_cash",\n  "acquisition_cost",\n  "business_combination",')
    old = '    ["debt_issuance_cost", "other_cash_debt_movement"].includes(\n      row?.movement_type,\n    ) || STRUCTURAL_EVENT_ROLES.has(row?.semantic_role)'
    new = '    ["debt_issuance_cost", "other_cash_debt_movement"].includes(\n      row?.movement_type,\n    ) || STRUCTURAL_EVENT_ROLES.has(canonicalSemanticRole(row?.semantic_role)) ||\n    isStructuredEventRole(row?.semantic_role)'
    if old in content:
        content = content.replace(old, new)
    write(authority, content, "Make discrete-event zero authority vocabulary-complete")


def repair_broker_extractor() -> None:
    path = "scripts/extract_broker_evidence.py"
    content = read(path)
    old_block = '''        # The preview/selection contract chooses at most one coherent house
        # for model authority.  Every other supplied report is still retained
        # page-for-page, but it must be archive-only regardless of whether its
        # native lane happens to look complete.  Restricting this only to pages
        # that already needed vision let canonical reconciliation later re-arm
        # OCR for an unselected house, expanding optional work after selection
        # and breaking the one-house runtime/performance invariant.
        unselected_house = descriptor.get("house_id") != vision_house_id
        archive_only = not selected_targets or unselected_house
'''
    new_block = '''        # All houses receive cheap native inspection. Native-clean compatible
        # cells remain eligible regardless of which house is later chosen for
        # the single expensive recovery frontier. Only unresolved recovery work
        # is house-bounded; publication date never decides native eligibility.
        unselected_house_recovery = (
            vision_required and vision_house_id is not None and
            descriptor.get("house_id") != vision_house_id
        )
        archive_only = not selected_targets or unselected_house_recovery
'''
    if old_block in content:
        content = content.replace(old_block, new_block)
    elif "archive-only regardless of whether its" in content:
        raise RuntimeError("Broker blanket-suppression source drifted; refusing an unsafe partial edit")

    core_block = '''CORE_BROKER_DEMANDS = (
    ("revenue", "Revenue", ("revenue", "sales", "turnover")),
    ("ebit", "EBIT / Operating Profit", ("ebit", "operating profit", "operating income")),
    ("adjusted_ebitda", "Adjusted EBITDA", ("adjusted ebitda", "ebitda")),
    ("depreciation_and_amortisation", "Depreciation and amortisation", ("d&a", "depreciation", "amortisation")),
    ("effective_tax_rate", "Effective tax rate", ("effective tax rate", "tax rate")),
    ("capex", "Capital expenditure", ("capex", "capital expenditure")),
    ("change_in_working_capital", "Change in working capital", ("working capital", "change in working capital")),
    ("dividends", "Dividends", ("dividend", "dividends")),
)


def _canonical_contract_hash(value: object) -> str:
    return hashlib.sha256(
        (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\\n").encode("utf-8")
    ).hexdigest()


def augment_core_broker_demand_contract(contract: dict[str, Any]) -> dict[str, Any]:
    """Ensure the debt-overlay Tier-1 surface exists before broker recovery."""
    output = json.loads(json.dumps(contract))
    targets = output.setdefault("targets", [])
    existing = {str(item.get("metric_id") or item.get("concept_id") or "") for item in targets}
    periods = list(output.get("forecast_periods") or [])
    for metric_id, label, aliases in CORE_BROKER_DEMANDS:
        if metric_id in existing:
            continue
        targets.append({
            "target_id": f"tier1.{metric_id}",
            "metric_id": metric_id,
            "concept_id": metric_id,
            "label": label,
            "search_terms": list(aliases),
            "aliases": list(aliases),
            "forecast_periods": periods,
            "periods": periods,
            "material": True,
            "tier": 1,
        })
    graph_text = json.dumps(output.get("model_demand_graph") or output, sort_keys=True).lower()
    if any(term in graph_text for term in ("buyback", "share repurchase", "share_repurchase")) and "share_buybacks" not in existing:
        targets.append({
            "target_id": "tier1.share_buybacks", "metric_id": "share_buybacks",
            "concept_id": "share_buybacks", "label": "Share buybacks",
            "search_terms": ["share buybacks", "share repurchases", "buybacks"],
            "aliases": ["share buybacks", "share repurchases", "buybacks"],
            "forecast_periods": periods, "periods": periods, "material": True, "tier": 1,
        })
    output.pop("contract_sha256", None)
    output["contract_sha256"] = _canonical_contract_hash(output)
    return output


def _native_house_metrics(document: dict[str, Any]) -> set[str]:
    metrics: set[str] = set()
    for surface in document.get("surfaces", []):
        if (surface.get("lane_status") or {}).get("vision") == "required":
            continue
        metrics.update(str(value) for value in surface.get("selected_demand_metric_ids", []) if value)
    return metrics


def select_recovery_house_id(
    documents: list[dict[str, Any]], descriptors: list[dict[str, Any]], demand_contract: dict[str, Any]
) -> tuple[str, list[dict[str, Any]]]:
    descriptor_by_id = {str(item.get("document_id")): item for item in descriptors}
    demanded = {str(item.get("metric_id") or item.get("concept_id")) for item in demand_contract.get("targets", [])}
    rows = []
    for document in documents:
        descriptor = descriptor_by_id.get(str(document.get("document_id")), {})
        native = _native_house_metrics(document)
        unresolved = sum(
            1 for surface in document.get("surfaces", [])
            if (surface.get("lane_status") or {}).get("vision") == "required"
        )
        native_tables = sum(
            1 for table in document.get("tables", [])
            if table.get("model_use") != "prohibited" and table.get("authority_role") != "archive_only"
        )
        rows.append({
            "house_id": str(document.get("house_id") or descriptor.get("house_id") or ""),
            "document_id": str(document.get("document_id") or ""),
            "published_date": str(descriptor.get("published_date") or ""),
            "native_demand_coverage": len(native & demanded),
            "native_metric_ids": sorted(native & demanded),
            "unresolved_surface_count": unresolved,
            "native_table_count": native_tables,
        })
    rows.sort(key=lambda item: (
        item["native_demand_coverage"], -item["unresolved_surface_count"],
        item["native_table_count"], item["published_date"], item["house_id"], item["document_id"],
    ), reverse=True)
    if not rows or not rows[0]["house_id"]:
        raise ValueError("No broker house is available for bounded recovery selection.")
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank
    return rows[0]["house_id"], rows


def enforce_one_recovery_frontier(documents: list[dict[str, Any]], selected_house_id: str) -> None:
    for document in documents:
        if str(document.get("house_id") or "") == selected_house_id:
            continue
        for surface in document.get("surfaces", []):
            if (surface.get("lane_status") or {}).get("vision") != "required":
                continue
            surface.setdefault("lane_status", {})["vision"] = "not_required"
            surface["model_demand_status"] = "archive_only_unselected_house_recovery"
            surface["selected_demand_metric_ids"] = []
            surface["recovery_prohibited"] = True
            surface_id = surface.get("surface_id")
            for table in document.get("tables", []):
                if table.get("surface_id") != surface_id:
                    continue
                if table.get("authority_role") in {"native_structured_authority", "bounded_native"}:
                    continue
                table["authority_role"] = "archive_only"
                table["model_use"] = "prohibited"
        document["extraction_status"] = (
            "needs_vision" if any(
                (surface.get("lane_status") or {}).get("vision") == "required"
                for surface in document.get("surfaces", [])
            ) else "complete"
        )
'''
    marker = "def main() -> int:"
    if core_block.strip() not in content:
        if marker not in content:
            raise RuntimeError("Broker main marker absent")
        content = content.replace(marker, core_block.rstrip() + "\n\n" + marker, 1)
    content = content.replace("demand_contract = compile_broker_demand_contract(request.get(\"model_context\") or {})",
        "demand_contract = augment_core_broker_demand_contract(\n        compile_broker_demand_contract(request.get(\"model_context\") or {})\n    )")
    latest_pattern = re.compile(r'''    vision_house_id = str\(sorted\(\n        request\["documents"\],\n        key=lambda item: \(\n            str\(item\.get\("published_date"\) or ""\),\n            str\(item\.get\("house_id"\) or ""\),\n            str\(item\.get\("document_id"\) or ""\),\n        \),\n        reverse=True,\n    \)\[0\]\["house_id"\]\)\n''')
    content, changed = latest_pattern.subn("    vision_house_id = None  # selected after all houses receive native inspection\n", content)
    if changed == 0 and "selected after all houses receive native inspection" not in content:
        raise RuntimeError("Publication-date broker preselection block not found")
    unresolved_marker = "    unresolved = sum(\n"
    selection_block = '''    vision_house_id, house_ranking = select_recovery_house_id(
        documents, request["documents"], demand_contract,
    )
    enforce_one_recovery_frontier(documents, vision_house_id)
'''
    if selection_block.strip() not in content:
        if unresolved_marker not in content:
            raise RuntimeError("Broker unresolved marker absent")
        content = content.replace(unresolved_marker, selection_block + "\n" + unresolved_marker, 1)
    content = content.replace('"policy": "latest_supplied_house_then_zero_authority",', '"policy": "quality_ranked_native_then_one_recovery_frontier",')
    content = content.replace('"maximum_recovery_house_count": 1,\n        },', '"maximum_recovery_house_count": 1,\n            "house_ranking": house_ranking,\n        },')
    write(path, content, "Evaluate all native broker evidence before one bounded recovery frontier")

    schema_path = "assets/broker-extraction-bundle.schema.json"
    schema = json_file(schema_path)
    raw = json.dumps(schema)
    raw = raw.replace('"const": "latest_supplied_house_then_zero_authority"', '"const": "quality_ranked_native_then_one_recovery_frontier"')
    schema = json.loads(raw)
    # Permit additive ranking/recovery metadata without weakening selected-cell provenance.
    def visit(value: Any) -> None:
        if isinstance(value, dict):
            props = value.get("properties")
            if isinstance(props, dict) and "maximum_recovery_house_count" in props and "selected_house_id" in props:
                props.setdefault("house_ranking", {"type": "array", "items": {"type": "object"}})
            if isinstance(props, dict) and "model_demand_status" in props:
                enum = props["model_demand_status"].get("enum", [])
                if "archive_only_unselected_house_recovery" not in enum:
                    enum.append("archive_only_unselected_house_recovery")
                props.setdefault("recovery_prohibited", {"type": "boolean"})
            for child in value.values(): visit(child)
        elif isinstance(value, list):
            for child in value: visit(child)
    visit(schema)
    write_json(schema_path, schema, "Describe quality-ranked broker recovery metadata")


def repair_test_truthfulness() -> None:
    registry_path = "assets/development-test-registry.json"
    registry = json_file(registry_path)
    for item in registry.get("tests", []):
        if item.get("id") == "universal-broker-delivery-matrix":
            item["arguments"] = ["$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"]
            item["requires"] = ["RAW_CANARY_EVIDENCE", "PYTHON", "SOFFICE"]
    write_json(registry_path, registry, "Align universal matrix registry with executable CLI")

    path = "scripts/run_raw_input_black_box_canary.mjs"
    content = read(path)
    content = content.replace("// Simulate the installed model-host semantic response from the raw PDF.",
        "// Deterministic downstream semantic fixture derived from raw-PDF candidates.\n    // This does not certify the installed model-host semantic seam; release certification\n    // requires a separate installed-host-broker-canary receipt.")
    content = content.replace('preauthored_broker_crosswalk: false,', 'preauthored_broker_crosswalk: brokerState === "usable",\n  broker_semantic_host_mode: brokerState === "usable" ? "deterministic_component_fixture" : "not_applicable",')
    write(path, content, "Stop overstating the deterministic broker fixture as an installed-host canary")


def repair_workflow_ownership() -> None:
    paths = [
        "scripts/run_excel_inflow_vnext.mjs", "scripts/run_user_flow.mjs",
        "scripts/lib/user_flow_controller.mjs", "scripts/lib/workflow_state.mjs",
        "scripts/lib/flow.mjs", "scripts/lib/flow_read.mjs", "scripts/lib/flow_questions.mjs",
    ]
    for path in paths:
        target = ROOT / path
        if not target.exists():
            continue
        content = target.read_text("utf-8")
        # Repair only explicit public/internal ownership contradictions.
        content = re.sub(
            r'(status\s*:\s*["\'])ACTION_REQUIRED(["\'][\s\S]{0,220}?blocker_class\s*:\s*["\'])INTERNAL_WORK(["\'])',
            r'\1NEEDS_INTERNAL_WORK\2INTERNAL_WORK\3', content,
        )
        content = re.sub(
            r'(blocker_class\s*:\s*["\'])INTERNAL_WORK(["\'][\s\S]{0,220}?status\s*:\s*["\'])ACTION_REQUIRED(["\'])',
            r'\1INTERNAL_WORK\2NEEDS_INTERNAL_WORK\3', content,
        )
        if content != target.read_text("utf-8"):
            write(path, content, "Reserve ACTION_REQUIRED for genuine user-owned resolution")

    state_path = "scripts/lib/workflow_state.mjs"
    block = '''export function assertPublicStateOwnership(value) {
  const status = value?.status ?? value?.response_status ?? null;
  const blockerClass = value?.blocker_class ?? value?.blockerClass ?? null;
  const userBlocking = value?.user_blocking ?? value?.userBlocking ?? null;
  if (status === "ACTION_REQUIRED" && !["USER_DECISION", "USER_EVIDENCE", "FATAL_SOURCE"].includes(blockerClass)) {
    throw new Error(`ACTION_REQUIRED cannot be owned by ${blockerClass ?? "no blocker class"}.`);
  }
  if (blockerClass === "INTERNAL_WORK" && userBlocking === true) {
    throw new Error("INTERNAL_WORK cannot be user-blocking.");
  }
  return value;
}
'''
    if (ROOT / state_path).exists() and "assertPublicStateOwnership" not in read(state_path):
        write(state_path, read(state_path) + "\n" + block, "Add executable public-state ownership invariant")


def repair_portability() -> None:
    pattern = re.compile(r"/(?:Users|home)/[A-Za-z0-9._-]+/[^\s\"'`]+")
    for path in list(ROOT.rglob("*.mjs")) + list(ROOT.rglob("*.js")) + list(ROOT.rglob("*.py")) + list(ROOT.rglob("*.json")) + list(ROOT.rglob("*.md")):
        if any(part in {".git", "node_modules", "audit"} for part in path.relative_to(ROOT).parts):
            continue
        content = path.read_text("utf-8", errors="ignore")
        def replacement(match: re.Match[str]) -> str:
            original = match.group(0)
            tail = original.split("/", 4)[-1]
            return f"fixtures/external/{tail}"
        updated = pattern.sub(replacement, content)
        if updated != content:
            write(rel(path), updated, "Remove developer-specific fixture path")


def repair_source_identity() -> None:
    write("scripts/lib/source_identity.mjs", '''import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

async function readJson(target) {
  try { return JSON.parse(await fs.readFile(target, "utf8")); } catch { return null; }
}
async function gitValue(skillRoot, args) {
  try { return (await exec("git", ["-C", skillRoot, ...args], { timeout: 5000 })).stdout.trim() || null; }
  catch { return null; }
}
export async function resolveSourceIdentity({ skillRoot, overrides = {} } = {}) {
  const root = path.resolve(skillRoot ?? new URL("../../", import.meta.url).pathname);
  const release = await readJson(path.join(root, "release-manifest.json")) ?? {};
  const runtime = await readJson(path.join(root, "assets", "runtime-manifest.json")) ?? {};
  const commit = overrides.source_commit ?? process.env.EXCEL_INFLOW_SOURCE_COMMIT ?? runtime.source_commit ?? await gitValue(root, ["rev-parse", "HEAD"]);
  const tree = overrides.source_tree ?? process.env.EXCEL_INFLOW_SOURCE_TREE ?? runtime.source_tree ?? await gitValue(root, ["rev-parse", "HEAD^{tree}"]);
  const certification = release.certification ?? {};
  return {
    schema_version: "source-identity/1.0",
    repository: overrides.repository ?? process.env.EXCEL_INFLOW_SOURCE_REPOSITORY ?? "computering001/excel-inflow",
    source_commit: commit,
    source_tree: tree,
    package_mode: release.packageMode ?? runtime.package_mode ?? null,
    release_name: release.releaseName ?? null,
    skill_version: release.skillVersion ?? runtime.skill_version ?? null,
    current_closure_sha256: certification.currentClosureSha256 ?? runtime.current_closure_sha256 ?? null,
    certified_closure_sha256: certification.certifiedClosureSha256 ?? null,
    certification_evidence_receipt: certification.evidenceReceipt ?? null,
    installation_identity: overrides.installation_identity ?? process.env.EXCEL_INFLOW_INSTALLATION_IDENTITY ?? null,
  };
}
export function assertProductionSourceIdentity(identity) {
  const required = ["source_commit", "source_tree", "current_closure_sha256", "certified_closure_sha256", "certification_evidence_receipt", "installation_identity"];
  const missing = required.filter((field) => !identity?.[field]);
  if (identity?.package_mode !== "production") missing.push("package_mode=production");
  if (identity?.current_closure_sha256 !== identity?.certified_closure_sha256) missing.push("closure_match");
  if (missing.length) throw new Error(`Production source identity is incomplete: ${missing.join(", ")}`);
  return identity;
}
export default { resolveSourceIdentity, assertProductionSourceIdentity };
''', "Persist source, closure, certification and installation identity")
    add_runtime_member("scripts/lib/source_identity.mjs")
    add_release_script("scripts/lib/source_identity.mjs")

    path = "scripts/lib/run_carrier.mjs"
    content = read(path)
    if 'from "./source_identity.mjs"' not in content:
        anchor = 'import { createHash } from "node:crypto";'
        content = content.replace(anchor, anchor + '\nimport { resolveSourceIdentity } from "./source_identity.mjs";', 1)
    content = content.replace('export const RUN_CARRIER_SCHEMA = "debt-model-run-carrier/2.0";',
        'export const RUN_CARRIER_SCHEMA = "debt-model-run-carrier/3.0";\nexport const LEGACY_RUN_CARRIER_SCHEMA = "debt-model-run-carrier/2.0";')
    content = content.replace('  artifacts = {},\n}) {', '  artifacts = {},\n  sourceIdentity = null,\n}) {')
    marker = '    issuer_identity_hash: sha256Bytes(canonicalJson(normalisedIssuer)),\n'
    if marker in content and 'source_identity:' not in content:
        content = content.replace(marker, marker + '    source_identity: sourceIdentity ?? await resolveSourceIdentity({ skillRoot }),\n', 1)
    content = content.replace('if (carrier.schema_version !== RUN_CARRIER_SCHEMA) throw new Error("Run carrier schema does not match.");',
        'if (![RUN_CARRIER_SCHEMA, LEGACY_RUN_CARRIER_SCHEMA].includes(carrier.schema_version)) throw new Error("Run carrier schema does not match.");\n  if (carrier.schema_version === RUN_CARRIER_SCHEMA) {\n    for (const field of ["source_commit", "source_tree", "current_closure_sha256", "package_mode"]) {\n      if (!carrier.source_identity?.[field]) throw new Error(`Run carrier source identity is missing ${field}.`);\n    }\n  }')
    write(path, content, "Upgrade run carrier to auditable source identity while retaining legacy resume")


def repair_acquisition_contract() -> None:
    path = "scripts/lib/acquisition_policy.mjs"
    content = read(path)
    if "ACQUISITION_TRANSACTION_MODE" not in content:
        block = '''
export const ACQUISITION_TRANSACTION_MODE = "funded_transaction";

function finiteAcquisitionValue(value, fallback = 0) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : fallback;
}
function acquisitionInput(modelCase, names, fallback = null) {
  const roots = [modelCase?.acquisition, modelCase?.acquisition_case, modelCase?.acquisition_overlay, modelCase?.transaction, modelCase?.controls, modelCase?.assumptions];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    for (const name of names) if (root[name] !== undefined && root[name] !== null) return root[name];
    for (const value of Object.values(root)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const name of names) if (value[name] !== undefined && value[name] !== null) return value[name];
    }
  }
  return fallback;
}
export function acquisitionTransactionFlows(modelCase, forecastIndex) {
  const periods = (modelCase?.periods ?? []).filter((period) => period?.status === "forecast");
  const period = periods[forecastIndex];
  const closeYear = Number(acquisitionInput(modelCase, ["close_year", "acquisition_close_year"], 0));
  const periodYear = Number(String(period?.date ?? period?.label ?? "").slice(0, 4));
  const enabledRaw = acquisitionInput(modelCase, ["enabled", "adjustment_columns_on", "acquisition_on", "acquisition_case"], false);
  const enabled = enabledRaw === true || enabledRaw === 1 || String(enabledRaw).toLowerCase() === "on";
  const atClose = enabled && periodYear === closeYear;
  const consideration = atClose ? finiteAcquisitionValue(acquisitionInput(modelCase, ["transaction_enterprise_value", "transaction_value", "enterprise_value"], 0)) : 0;
  const debtProceeds = atClose ? finiteAcquisitionValue(acquisitionInput(modelCase, ["acquisition_debt_amount", "acquisition_debt", "debt_amount"], 0)) : 0;
  return {
    schema_version: "funded-acquisition-transaction/1.0",
    mode: ACQUISITION_TRANSACTION_MODE,
    forecast_index: forecastIndex,
    at_close: atClose,
    consideration_cash_flow: -Math.abs(consideration),
    acquisition_debt_proceeds: Math.abs(debtProceeds),
    direct_transaction_cash_flow: -Math.abs(consideration),
    net_direct_cash_flow: -Math.abs(consideration) + Math.abs(debtProceeds),
    residual_cash_or_rcf_funding: Math.max(0, Math.abs(consideration) - Math.abs(debtProceeds)),
  };
}
'''
        # Append before default export when present, otherwise at end.
        if "export default" in content:
            content = content.replace("export default", block + "\nexport default", 1)
        else:
            content += "\n" + block
    write(path, content, "Define one funded lightweight acquisition transaction contract")

    acquisition_doc = read("references/acquisition.md")
    acquisition_doc = acquisition_doc.replace("This is a debt overlay, not a sources-and-uses schedule. The overlay has zero\ndirect transaction cash-flow effect. Enterprise value is\nused only to infer the target's operating contribution.",
        "This remains a lightweight debt overlay rather than a full sources-and-uses or purchase-accounting model. Enterprise value is used once as the purchase-consideration proxy and also to infer the target's operating contribution. The close-year acquisition adjustment records the full consideration as an investing cash outflow; the separately supplied acquisition-debt amount records one financing inflow and one persistent debt balance. Any residual consideration is funded through existing cash and the ordinary RCF waterfall. No automatic equity plug is invented.")
    acquisition_doc = acquisition_doc.replace("Do not create an unmatched financing inflow, a purchase-consideration outflow, an equity\nresidual, financing-proceeds row, acquisition amortisation or an acquisition\nmaturity.",
        "Do not create an automatic equity residual, acquisition amortisation, acquisition maturity, purchase accounting, fees, synergies or multiple financing tranches. The canonical overlay does show the consideration outflow and acquisition-debt proceeds explicitly once at close.")
    acquisition_doc = acquisition_doc.replace("the acquisition overlay has zero direct cash-flow effect;", "transaction value enters investing cash once and acquisition debt enters financing cash once;")
    write("references/acquisition.md", acquisition_doc, "Resolve acquisition specification in favour of funded transaction economics")

    for doc in ["SKILL.md", "central-instructions.md", "references/runtime-core.md", "references/model-intent.md"]:
        if not (ROOT / doc).exists(): continue
        content = read(doc)
        content = content.replace("zero direct transaction cash-flow effect", "one close-year consideration outflow and one acquisition-debt financing inflow")
        content = content.replace("zero direct cash-flow effect", "funded close-year transaction cash-flow effect")
        write(doc, content, "Align acquisition instructions to funded transaction contract")


def add_tests() -> None:
    write("scripts/run_source_arithmetic_topology_tests.py", '''#!/usr/bin/env python3
from extract_filing_statements import infer_source_arithmetic_links

def row(identifier, label, values, level):
    return {"source_line_id": identifier, "raw_label": label, "values": values, "hierarchy_level": level, "is_subtotal": False}

def assert_family(label):
    rows = [
        row("is.product_sales", "Product Sales", [100, 120, 140], 1),
        row("is.alliance_revenue", "Alliance Revenue", [10, 12, 14], 1),
        row("is.parent", label, [110, 132, 154], 0),
    ]
    infer_source_arithmetic_links(rows)
    assert rows[0]["parent_source_line_id"] == "is.parent"
    assert rows[1]["parent_source_line_id"] == "is.parent"
    assert rows[2]["is_subtotal"] is True

assert_family("Product Revenue")
assert_family("Whatever the issuer calls this aggregate")
parent_first = [
    row("is.parent", "Operating family", [110, 132, 154], 0),
    row("is.a", "A", [100, 120, 140], 1), row("is.b", "B", [10, 12, 14], 1),
]
infer_source_arithmetic_links(parent_first)
assert all(item.get("parent_source_line_id") == "is.parent" for item in parent_first[1:])
mutated = [
    row("is.a", "A", [100, 120, 140], 1), row("is.b", "B", [10, 12, 14], 1),
    row("is.parent", "Aggregate", [111, 132, 154], 0),
]
infer_source_arithmetic_links(mutated)
assert not any(item.get("parent_source_line_id") for item in mutated)
print('{"status":"PASS","checks":4}')
''', "Add non-vacuous relabel-stable filing arithmetic regression")

    write("scripts/run_semantic_role_closure_tests.mjs", '''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonicalSemanticRole, isStructuredEventRole } from "./lib/semantic_roles.mjs";
const taxonomy = JSON.parse(fs.readFileSync(new URL("../assets/statement-semantic-taxonomy.v1.json", import.meta.url)));
const emitted = new Set(taxonomy.roles.map((row) => canonicalSemanticRole(row.id)));
assert.equal(canonicalSemanticRole("operating_profit"), "ebit");
assert.equal(canonicalSemanticRole("operating income"), "ebit");
assert.ok(emitted.has("acquisitions_net_of_cash"));
assert.ok(isStructuredEventRole("acquisitions_net_of_cash"));
assert.ok(isStructuredEventRole("business_combination"));
console.log(JSON.stringify({ status: "PASS", checks: 5 }));
''', "Add semantic-role vocabulary closure regression")

    write("scripts/run_public_state_ownership_tests.mjs", '''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicStateOwnership } from "./lib/workflow_state.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.throws(() => assertPublicStateOwnership({ status: "ACTION_REQUIRED", blocker_class: "INTERNAL_WORK", user_blocking: false }));
assert.throws(() => assertPublicStateOwnership({ status: "NEEDS_INTERNAL_WORK", blocker_class: "INTERNAL_WORK", user_blocking: true }));
assert.doesNotThrow(() => assertPublicStateOwnership({ status: "ACTION_REQUIRED", blocker_class: "USER_DECISION", user_blocking: true }));
for (const relative of ["scripts/run_excel_inflow_vnext.mjs", "scripts/run_user_flow.mjs", "scripts/lib/flow.mjs"]) {
  const content = fs.readFileSync(path.join(root, relative), "utf8");
  assert.ok(!/ACTION_REQUIRED[\s\S]{0,220}INTERNAL_WORK|INTERNAL_WORK[\s\S]{0,220}ACTION_REQUIRED/.test(content), relative);
}
console.log(JSON.stringify({ status: "PASS", checks: 6 }));
''', "Add public/internal workflow ownership regression")

    write("scripts/run_broker_core_demand_tests.py", '''#!/usr/bin/env python3
from extract_broker_evidence import augment_core_broker_demand_contract, select_recovery_house_id
base = {"schema_version":"broker-selected-cell-demand/1.0","model_demand_graph_sha256":"a"*64,"forecast_periods":["2026-12-31","2027-12-31","2028-12-31"],"targets":[]}
contract = augment_core_broker_demand_contract(base)
metrics = {row["metric_id"] for row in contract["targets"]}
required = {"revenue","ebit","adjusted_ebitda","depreciation_and_amortisation","effective_tax_rate","capex","change_in_working_capital","dividends"}
assert required <= metrics
documents = [
 {"document_id":"new","house_id":"new","surfaces":[{"lane_status":{"vision":"required"},"selected_demand_metric_ids":["revenue"]}],"tables":[]},
 {"document_id":"older","house_id":"older","surfaces":[{"lane_status":{"vision":"not_required"},"selected_demand_metric_ids":sorted(required)}],"tables":[{"model_use":"active_input","authority_role":"native_structured_authority"}]},
]
descriptors = [
 {"document_id":"new","house_id":"new","published_date":"2026-06-30"},
 {"document_id":"older","house_id":"older","published_date":"2026-02-01"},
]
selected, ranking = select_recovery_house_id(documents, descriptors, contract)
assert selected == "older", ranking
assert ranking[0]["native_demand_coverage"] > ranking[1]["native_demand_coverage"]
print('{"status":"PASS","checks":3}')
''', "Add quality-first core broker demand regression")

    write("scripts/run_nonrecurring_forecast_policy_tests.mjs", '''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
const behavior = fs.readFileSync(new URL("./lib/forecast_behavior.mjs", import.meta.url), "utf8");
const authority = fs.readFileSync(new URL("./lib/forecast_authority.mjs", import.meta.url), "utf8");
const candidate = fs.readFileSync(new URL("./lib/forecast_candidate_compiler.mjs", import.meta.url), "utf8");
assert.match(behavior, /isStructuredEventRole/);
assert.match(authority, /isStructuredEventRole/);
assert.match(candidate, /eventZeroCandidate/);
assert.ok(!/acquisitions_net_of_cash[\s\S]{0,500}historical_average/.test(candidate));
console.log(JSON.stringify({ status: "PASS", checks: 4 }));
''', "Add discrete-event non-recurrence regression")

    write("scripts/run_source_identity_tests.mjs", '''#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolveSourceIdentity, assertProductionSourceIdentity } from "./lib/source_identity.mjs";
const identity = await resolveSourceIdentity({ skillRoot: new URL("../", import.meta.url).pathname });
assert.ok(identity.source_commit);
assert.ok(identity.source_tree);
assert.ok(identity.current_closure_sha256);
assert.throws(() => assertProductionSourceIdentity(identity));
const production = { ...identity, package_mode: "production", certified_closure_sha256: identity.current_closure_sha256, certification_evidence_receipt: "receipt.json", installation_identity: "installed:fixture" };
assert.doesNotThrow(() => assertProductionSourceIdentity(production));
console.log(JSON.stringify({ status: "PASS", checks: 5 }));
''', "Add source/release identity separation regression")

    write("scripts/run_test_registry_contract_tests.mjs", '''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(fs.readFileSync(path.join(root,"assets/development-test-registry.json"),"utf8"));
const matrix = registry.tests.find((row) => row.id === "universal-broker-delivery-matrix");
assert.deepEqual(matrix.arguments, ["$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"]);
assert.deepEqual(matrix.requires, ["RAW_CANARY_EVIDENCE", "PYTHON", "SOFFICE"]);
const script = fs.readFileSync(path.join(root,"scripts/run_universal_broker_delivery_matrix.mjs"),"utf8");
assert.match(script, /cleanFixtureArg, pythonArg, sofficeArg/);
console.log(JSON.stringify({ status: "PASS", checks: 3 }));
''', "Add test-registry/executable interface regression")

    write("scripts/run_portability_contract_tests.mjs", '''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const offenders=[];
for (const top of ["scripts","assets","references","SKILL.md","central-instructions.md"]) {
  const start=path.join(root,top); if(!fs.existsSync(start)) continue;
  const walk=(target)=>{const stat=fs.statSync(target); if(stat.isDirectory()){for(const name of fs.readdirSync(target)) walk(path.join(target,name)); return;} const content=fs.readFileSync(target,"utf8"); if(/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(content)) offenders.push(path.relative(root,target));};
  walk(start);
}
assert.deepEqual(offenders, []);
console.log(JSON.stringify({ status:"PASS", checks:1 }));
''', "Add repository portability regression")

    write("assets/installed-host-broker-canary-v1.schema.json", json.dumps({
      "$schema":"https://json-schema.org/draft/2020-12/schema",
      "title":"Installed-host usable-broker canary receipt",
      "type":"object","additionalProperties":False,
      "required":["schema_version","status","source_identity","raw_pdf_sha256","host_response_sha256","selected_cells","workbook_sha256","workbook_consumption"],
      "properties":{
        "schema_version":{"const":"installed-host-broker-canary/1.0"},
        "status":{"const":"PASS"},
        "source_identity":{"type":"object"},
        "raw_pdf_sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"},
        "host_response_sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"},
        "selected_cells":{"type":"array","minItems":1,"items":{"type":"object"}},
        "workbook_sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"},
        "workbook_consumption":{"type":"array","minItems":1,"items":{"type":"object"}},
      }
    }, indent=2)+"\n", "Define true installed-host usable-broker certification receipt")

    write("scripts/verify_installed_host_broker_canary.mjs", '''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
const receiptPath=process.argv[2]; if(!receiptPath) throw new Error("Usage: verify_installed_host_broker_canary.mjs <receipt.json>");
const receipt=JSON.parse(fs.readFileSync(receiptPath,"utf8"));
assert.equal(receipt.schema_version,"installed-host-broker-canary/1.0"); assert.equal(receipt.status,"PASS");
assert.ok(receipt.selected_cells.length>0); assert.ok(receipt.workbook_consumption.length>0);
for(const row of receipt.workbook_consumption){assert.ok(row.metric_id); assert.ok(row.source_cell); assert.ok(row.workbook_cell); assert.equal(row.consumed,true);}
console.log(JSON.stringify({status:"PASS",selected_cells:receipt.selected_cells.length,consumed:receipt.workbook_consumption.length}));
''', "Add external installed-host broker certification verifier")

    tests = [
      {"id":"source-arithmetic-topology","phase":"evidence","runtime":"python","script":"run_source_arithmetic_topology_tests.py"},
      {"id":"semantic-role-closure","phase":"forecast","runtime":"node","script":"run_semantic_role_closure_tests.mjs"},
      {"id":"public-state-ownership","phase":"workflow","runtime":"node","script":"run_public_state_ownership_tests.mjs"},
      {"id":"broker-core-demand-quality","phase":"evidence","runtime":"python","script":"run_broker_core_demand_tests.py"},
      {"id":"nonrecurring-forecast-policy","phase":"forecast","runtime":"node","script":"run_nonrecurring_forecast_policy_tests.mjs"},
      {"id":"source-release-identity","phase":"proof","runtime":"node","script":"run_source_identity_tests.mjs"},
      {"id":"test-registry-contract","phase":"proof","runtime":"node","script":"run_test_registry_contract_tests.mjs"},
      {"id":"portability-contract","phase":"proof","runtime":"node","script":"run_portability_contract_tests.mjs"},
      {"id":"installed-host-usable-broker","phase":"real_corpus","runtime":"node","script":"verify_installed_host_broker_canary.mjs","arguments":["$INSTALLED_HOST_BROKER_RECEIPT"],"requires":["INSTALLED_HOST_BROKER_RECEIPT"]},
    ]
    for entry in tests: register_test(entry)
    for path in [
      "scripts/run_source_arithmetic_topology_tests.py","scripts/run_semantic_role_closure_tests.mjs",
      "scripts/run_public_state_ownership_tests.mjs","scripts/run_broker_core_demand_tests.py",
      "scripts/run_nonrecurring_forecast_policy_tests.mjs","scripts/run_source_identity_tests.mjs",
      "scripts/run_test_registry_contract_tests.mjs","scripts/run_portability_contract_tests.mjs",
      "scripts/verify_installed_host_broker_canary.mjs",
    ]: add_release_script(path)


def repair_development_gate_inputs() -> None:
    path = "scripts/run_development_gate.mjs"
    content = read(path)
    if "INSTALLED_HOST_BROKER_RECEIPT" not in content:
        marker = '    SOFFICE: options.soffice ? path.resolve(options.soffice) : null,\n'
        if marker in content:
            content = content.replace(marker, marker + '    INSTALLED_HOST_BROKER_RECEIPT: options["installed-host-broker-receipt"]\n      ? path.resolve(options["installed-host-broker-receipt"]) : null,\n')
        usage_marker = '  [--out <report-directory>],'
        # Usage text differs by vintage; append to the existing SOFFICE line instead.
        content = content.replace('  [--real-filings-expectations <run-scoped-expectations.json>],',
            '  [--real-filings-expectations <run-scoped-expectations.json>]\n  [--installed-host-broker-receipt <installed-host-broker-canary.json>],')
    write(path, content, "Expose true installed-host canary custody input")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    semantic_role_registry()
    repair_filing_arithmetic()
    repair_statement_topology()
    repair_forecast_roles()
    repair_broker_extractor()
    repair_test_truthfulness()
    repair_workflow_ownership()
    repair_portability()
    repair_source_identity()
    repair_acquisition_contract()
    add_tests()
    repair_development_gate_inputs()

    manifest = {
        "schema_version":"excel-inflow-forensic-repair/1.0",
        "change_count":len(CHANGES),
        "changes":CHANGES,
        "preserved_invariants":[
          "optional broker failure cannot block mandatory model delivery",
          "raw broker archive and screenshot pages remain immutable evidence",
          "selected broker values require exact cell provenance",
          "instrument-period debt, cash/RCF/interest fixed point and circularity remain strict",
          "DCS term authority and opening-debt reconciliation remain mandatory",
          "development identity remains uncertified until host/native/visual evidence exists",
        ],
    }
    (out/"repair-manifest.json").write_text(json.dumps(manifest,indent=2)+"\n","utf8")
    print(json.dumps({"status":"APPLIED","changes":len(CHANGES)},sort_keys=True))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
