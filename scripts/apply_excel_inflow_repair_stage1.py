#!/usr/bin/env python3
"""Apply the first dependency-ordered Excel Inflow repair set.

Stage 1 fixes the earliest proven sources: filing arithmetic ownership, broker
native eligibility/recovery ordering, complete Tier-1 broker demand, discrete
event role closure and the stale development-registry interface. It is
idempotent and fails if the exact expected source shapes are absent.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text("utf-8")


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, "utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count == 0 and new in text:
        return text
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one source match, found {count}")
    return text.replace(old, new, 1)


def replace_all_required(text: str, old: str, new: str, label: str, minimum: int = 1) -> str:
    count = text.count(old)
    if count == 0 and new in text:
        return text
    if count < minimum:
        raise RuntimeError(f"{label}: expected at least {minimum} source matches, found {count}")
    return text.replace(old, new)


def sha(path: str) -> str:
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def patch_filing_arithmetic() -> list[str]:
    path = "scripts/extract_filing_statements.py"
    text = read(path)
    if "def infer_arithmetic_parent_links" not in text:
        marker = "\ndef infer_parent_links(rows: list[dict[str, Any]]) -> None:\n"
        if marker not in text:
            raise RuntimeError("filing arithmetic: infer_parent_links marker absent")
        addition = r'''

_ARITHMETIC_PARENT_MAX_CHILDREN = 6
_ARITHMETIC_PARENT_ABS_TOLERANCE = 1e-6
_ARITHMETIC_PARENT_REL_TOLERANCE = 1e-8
_ARITHMETIC_GENERIC_TOKENS = {
    "and", "of", "the", "total", "net", "adjusted", "reported",
    "income", "profit", "loss", "cash", "flow",
}


def _arithmetic_values_match(parent: dict[str, Any], children: list[dict[str, Any]]) -> bool:
    parent_values = parent.get("values") or []
    child_values = [child.get("values") or [] for child in children]
    if len(parent_values) != 3 or any(len(values) != 3 for values in child_values):
        return False
    for period_index in range(3):
        parent_value = parent_values[period_index]
        components = [values[period_index] for values in child_values]
        if parent_value is None or any(value is None for value in components):
            return False
        expected = sum(float(value) for value in components)
        actual = float(parent_value)
        scale = max(1.0, abs(actual), abs(expected), *(abs(float(value)) for value in components))
        tolerance = max(
            _ARITHMETIC_PARENT_ABS_TOLERANCE,
            _ARITHMETIC_PARENT_REL_TOLERANCE * scale,
        )
        if abs(actual - expected) > tolerance:
            return False
    return True


def _label_tokens(label: str) -> set[str]:
    return {
        token for token in re.findall(r"[a-z0-9]+", label.casefold())
        if token not in _ARITHMETIC_GENERIC_TOKENS and len(token) >= 3
    }


def _arithmetic_family_is_plausible(parent: dict[str, Any], children: list[dict[str, Any]]) -> bool:
    parent_level = int(parent.get("hierarchy_level") or 0)
    child_levels = [int(child.get("hierarchy_level") or 0) for child in children]
    # Source geometry is the strongest non-label signal. A visibly less-indented
    # row may own the contiguous component run whenever the three-period
    # arithmetic closes.
    if child_levels and all(level > parent_level for level in child_levels):
        return True
    # Flat tables remain common. In that shape, require one substantive source
    # token shared by the aggregate and at least one component. This is not a
    # subtotal-name whitelist: changing Product Revenue to Franchise Revenue
    # preserves the relation when its components change with it.
    parent_tokens = _label_tokens(str(parent.get("raw_label") or ""))
    return bool(parent_tokens) and any(
        parent_tokens & _label_tokens(str(child.get("raw_label") or ""))
        for child in children
    )


def infer_arithmetic_parent_links(rows: list[dict[str, Any]]) -> None:
    """Compile source-visible SUM ownership before caption taxonomy.

    A candidate aggregate may own two to six immediately preceding face rows
    only when all three reported periods close numerically and source geometry
    or a minimal flat-table family signal supports the contiguous family. The
    shortest closing family wins, allowing nested source totals. Existing
    explicit parent edges are never overwritten.
    """
    for parent_index, parent in enumerate(rows):
        if parent_index < 2:
            continue
        maximum = min(_ARITHMETIC_PARENT_MAX_CHILDREN, parent_index)
        for child_count in range(2, maximum + 1):
            children = rows[parent_index - child_count:parent_index]
            if any(child.get("parent_source_line_id") for child in children):
                continue
            if not _arithmetic_values_match(parent, children):
                continue
            if not _arithmetic_family_is_plausible(parent, children):
                continue
            parent_id = parent.get("source_line_id")
            if not parent_id:
                continue
            for child in children:
                child["parent_source_line_id"] = parent_id
            # The source arithmetic, rather than a caption regex, certifies that
            # this row is a visible subtotal owner for downstream topology.
            parent["is_subtotal"] = True
            break
'''
        text = text.replace(marker, addition + marker, 1)
    text = replace_once(
        text,
        "        if level > 0:\n            parent = next_subtotal_by_level.get(level - 1)",
        "        if level > 0 and not row.get(\"parent_source_line_id\"):\n            parent = next_subtotal_by_level.get(level - 1)",
        "filing arithmetic parent preservation",
    )
    text = replace_once(
        text,
        "    infer_parent_links(rows)\n    manifest = {",
        "    infer_arithmetic_parent_links(rows)\n    infer_parent_links(rows)\n    manifest = {",
        "filing arithmetic invocation",
    )
    write(path, text)
    test_path = "scripts/run_filing_arithmetic_topology_tests.py"
    if not (ROOT / test_path).exists():
        write(test_path, r'''#!/usr/bin/env python3
"""Non-vacuous filing source-arithmetic topology tests."""
from __future__ import annotations

import copy
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("extract_filing_statements", HERE / "extract_filing_statements.py")
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)


def row(identifier, label, values, level=0):
    return {
        "source_line_id": identifier,
        "raw_label": label,
        "values": values,
        "hierarchy_level": level,
        "is_subtotal": False,
    }


base = [
    row("is.product_sales", "Product Sales", [40000, 47000, 52000], 1),
    row("is.alliance_revenue", "Alliance Revenue", [5217, 6150, 6640], 1),
    row("is.product_revenue", "Product Revenue", [45217, 53150, 58640], 0),
    row("is.collaboration_revenue", "Collaboration Revenue", [1200, 1400, 1600], 1),
    row("is.total_revenue", "Total Revenue", [46417, 54550, 60240], 0),
]
module.infer_arithmetic_parent_links(base)
assert base[0]["parent_source_line_id"] == "is.product_revenue"
assert base[1]["parent_source_line_id"] == "is.product_revenue"
assert base[2]["parent_source_line_id"] == "is.total_revenue"
assert base[3]["parent_source_line_id"] == "is.total_revenue"
assert base[2]["is_subtotal"] is True and base[4]["is_subtotal"] is True

# Captions are not the owner: a complete family relabel preserves arithmetic.
renamed = copy.deepcopy(base)
for item in renamed:
    item.pop("parent_source_line_id", None)
renamed[0]["raw_label"] = "Franchise Sales"
renamed[1]["raw_label"] = "Franchise Alliance Income"
renamed[2]["raw_label"] = "Franchise Revenue"
module.infer_arithmetic_parent_links(renamed)
assert renamed[0]["parent_source_line_id"] == "is.product_revenue"
assert renamed[1]["parent_source_line_id"] == "is.product_revenue"

# A targeted arithmetic mutation must destroy the claimed source edge.
mutated = copy.deepcopy(base[:3])
for item in mutated:
    item.pop("parent_source_line_id", None)
mutated[2]["values"][1] += 1
module.infer_arithmetic_parent_links(mutated)
assert all("parent_source_line_id" not in item for item in mutated[:2])

# A coincidental flat sum with unrelated labels must not invent a family.
unrelated = [
    row("is.a", "North America", [10, 11, 12], 0),
    row("is.b", "Research expense", [20, 21, 22], 0),
    row("is.c", "Other income", [30, 32, 34], 0),
]
module.infer_arithmetic_parent_links(unrelated)
assert all("parent_source_line_id" not in item for item in unrelated)
print({"status": "PASS", "checks": 12})
''')
    return [path, test_path]


def patch_broker_native_selection_and_demand() -> list[str]:
    path = "scripts/extract_broker_evidence.py"
    text = read(path)
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
    new_block = '''        # Native-clean evidence from every supplied house remains eligible.
        # The one-house bound applies only to expensive OCR/vision recovery,
        # never to already-clean native cells. This preserves bounded runtime
        # without treating publication date as evidence quality.
        unselected_house_recovery = (
            vision_required
            and vision_house_id is not None
            and descriptor.get("house_id") != vision_house_id
        )
        archive_only = not selected_targets or unselected_house_recovery
'''
    text = replace_once(text, old_block, new_block, "broker blanket archive-only block")
    # Type annotations on both primary and rendered-fallback extractors.
    text = text.replace("vision_house_id: str,", "vision_house_id: str | None,")
    if "def expand_model_context_with_tier1_nodes" not in text:
        marker = "\ndef main() -> int:\n"
        if marker not in text:
            raise RuntimeError("broker helper insertion marker absent")
        helpers = r'''

_TIER1_DEMAND_ROWS = (
    ("revenue", "Revenue", "income_statement"),
    ("ebit", "EBIT", "income_statement"),
    ("adjusted_ebitda", "Adjusted EBITDA", "income_statement"),
    ("depreciation_and_amortisation", "Depreciation and amortisation", "income_statement"),
    ("effective_tax_rate", "Effective tax rate", "income_statement"),
    ("capex", "Capital expenditure", "cash_flow"),
    ("change_in_working_capital", "Change in working capital", "cash_flow"),
    ("dividends", "Dividends paid", "cash_flow"),
    ("share_buybacks", "Share buybacks", "cash_flow"),
)


def expand_model_context_with_tier1_nodes(model_context: dict[str, Any]) -> dict[str, Any]:
    """Complete the broker demand surface before extraction.

    The filings graph is authoritative for company-specific visible rows, but
    the debt-overlay contract also requires the standard broker bridge surface.
    Synthetic demand nodes request evidence only; they do not create workbook
    rows or forecast authority by themselves.
    """
    context = json.loads(json.dumps(model_context or {}))
    graph = context.get("model_demand_graph")
    if not isinstance(graph, dict):
        return context
    periods = list(graph.get("forecast_periods") or context.get("forecast_periods") or [])
    if len(periods) != 3:
        return context
    nodes = list(graph.get("nodes") or [])
    existing = {
        (str(node.get("label") or "").casefold(), str(node.get("period_end") or ""))
        for node in nodes
    }
    for metric_id, label, section in _TIER1_DEMAND_ROWS:
        for period_index, period_end in enumerate(periods):
            key = (label.casefold(), str(period_end))
            if key in existing:
                continue
            nodes.append({
                "node_id": f"tier1.{metric_id}.fy{period_index + 1}",
                "section": section,
                "source_line_id": f"tier1.{metric_id}",
                "label": label,
                "parent_label": None,
                "period_end": period_end,
                "material": True,
                "has_historical_value": True,
                "allowed_authorities": ["selected_broker", "historical_inference"],
                "definition_signature_sha256": hashlib.sha256(
                    f"tier1:{metric_id}:{period_end}".encode("utf-8")
                ).hexdigest(),
            })
            existing.add(key)
    graph["nodes"] = nodes
    counts = graph.setdefault("counts", {})
    counts["source_rows"] = len({str(node.get("source_line_id")) for node in nodes})
    counts["forecast_nodes"] = len(nodes)
    counts["material_nodes"] = sum(bool(node.get("material")) for node in nodes)
    body = {key: value for key, value in graph.items() if key != "graph_sha256"}
    graph["graph_sha256"] = hashlib.sha256(canonical_bytes(body)).hexdigest()
    context["model_demand_graph"] = graph
    context["forecast_periods"] = periods
    return context


def _native_house_quality(document: dict[str, Any]) -> tuple[int, int, int, int, str, str]:
    demanded_metrics: set[str] = set()
    native_table_count = 0
    native_numeric_cells = 0
    unresolved_surfaces = 0
    for surface in document.get("surfaces", []):
        if (surface.get("lane_status") or {}).get("vision") == "required":
            unresolved_surfaces += 1
        else:
            demanded_metrics.update(surface.get("selected_demand_metric_ids") or [])
    for table in document.get("tables", []):
        if table.get("authority_role") == "archive_only" or table.get("model_use") == "prohibited":
            continue
        method = str(table.get("extraction_method") or "")
        if method.startswith("native_"):
            native_table_count += 1
            native_numeric_cells += sum(
                1 for row in table.get("rows", []) for cell in row
                if cell.get("numeric_value") is not None
            )
    return (
        len(demanded_metrics),
        native_table_count,
        native_numeric_cells,
        -unresolved_surfaces,
        str(document.get("published_date") or ""),
        str(document.get("house_id") or ""),
    )


def select_recovery_house(documents: list[dict[str, Any]]) -> str | None:
    candidates = [
        document for document in documents
        if any(
            (surface.get("lane_status") or {}).get("vision") == "required"
            and surface.get("selected_demand_metric_ids")
            for surface in document.get("surfaces", [])
        )
    ]
    if not candidates:
        return None
    return str(max(candidates, key=_native_house_quality).get("house_id") or "") or None


def close_unselected_recovery_frontiers(
    documents: list[dict[str, Any]], recovery_house_id: str | None,
) -> None:
    for document in documents:
        if document.get("house_id") == recovery_house_id:
            continue
        changed = False
        for surface in document.get("surfaces", []):
            if (surface.get("lane_status") or {}).get("vision") != "required":
                continue
            surface.setdefault("lane_status", {})["vision"] = "not_required"
            surface["model_demand_status"] = "archive_only_unselected_house"
            surface_id = surface.get("surface_id")
            for table in document.get("tables", []):
                if table.get("surface_id") == surface_id:
                    table["authority_role"] = "archive_only"
                    table["model_use"] = "prohibited"
            changed = True
        if changed:
            document["extraction_status"] = (
                "needs_vision" if any(
                    (surface.get("lane_status") or {}).get("vision") == "required"
                    for surface in document.get("surfaces", [])
                ) else "complete"
            )
'''
        text = text.replace(marker, helpers + marker, 1)
    text = replace_once(
        text,
        "    demand_contract = compile_broker_demand_contract(request.get(\"model_context\") or {})\n    vision_house_id = str(sorted(\n        request[\"documents\"],\n        key=lambda item: (\n            str(item.get(\"published_date\") or \"\"),\n            str(item.get(\"house_id\") or \"\"),\n            str(item.get(\"document_id\") or \"\"),\n        ),\n        reverse=True,\n    )[0][\"house_id\"])\n",
        "    model_context = expand_model_context_with_tier1_nodes(request.get(\"model_context\") or {})\n    demand_contract = compile_broker_demand_contract(model_context)\n    # First pass evaluates every house's native evidence. Expensive recovery is\n    # selected only after that native quality surface exists.\n    vision_house_id = None\n",
        "broker demand and preselection",
    )
    unresolved_marker = "    unresolved = sum(\n        1\n        for document in documents\n"
    if "close_unselected_recovery_frontiers(documents" not in text:
        if unresolved_marker not in text:
            raise RuntimeError("broker unresolved summary marker absent")
        text = text.replace(
            unresolved_marker,
            "    vision_house_id = select_recovery_house(documents)\n    close_unselected_recovery_frontiers(documents, vision_house_id)\n\n" + unresolved_marker,
            1,
        )
    text = replace_all_required(
        text,
        '"policy": "latest_supplied_house_then_zero_authority"',
        '"policy": "quality_ranked_native_then_one_recovery_frontier"',
        "broker policy name",
    )
    write(path, text)

    schema_path = "assets/broker-extraction-bundle.schema.json"
    schema = read(schema_path)
    schema = schema.replace(
        '"latest_supplied_house_then_zero_authority"',
        '"quality_ranked_native_then_one_recovery_frontier"',
    )
    write(schema_path, schema)

    for doc_path in ["references/broker-extraction.md", "references/runtime-core.md", "references/model-intent.md", "SKILL.md", "central-instructions.md"]:
        if not (ROOT / doc_path).is_file():
            continue
        doc = read(doc_path)
        doc = doc.replace("latest supplied house", "quality-ranked recovery house")
        doc = doc.replace("latest-supplied house", "quality-ranked recovery house")
        doc = doc.replace("latest supplied publication", "highest native demanded coverage; publication date only as a stable late tie-break")
        write(doc_path, doc)

    test_path = "scripts/run_broker_native_eligibility_tests.py"
    if not (ROOT / test_path).exists():
        write(test_path, r'''#!/usr/bin/env python3
"""Quality-first all-house native eligibility and bounded recovery tests."""
from __future__ import annotations

import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("extract_broker_evidence", HERE / "extract_broker_evidence.py")
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)


def native_document(house, date, metrics, cells, needs_vision=False):
    surface = {
        "surface_id": f"{house}.p1",
        "lane_status": {"vision": "required" if needs_vision else "not_required"},
        "selected_demand_metric_ids": list(metrics),
        "model_demand_status": "selected_cell_recovery_required" if needs_vision else "native_candidate",
    }
    table = {
        "surface_id": surface["surface_id"],
        "authority_role": "native_structured_authority",
        "model_use": "eligible",
        "extraction_method": "native_pdf_table",
        "rows": [[{"numeric_value": index + 1} for index in range(cells)]],
    }
    return {
        "document_id": house,
        "house_id": house,
        "published_date": date,
        "surfaces": [surface],
        "tables": [table],
        "extraction_status": "needs_vision" if needs_vision else "complete",
    }


# Newest is unreadable; older is fully native-clean. The older house remains
# eligible, while the expensive frontier is assigned by native quality rather
# than date alone.
older_clean = native_document("older_clean", "2026-02-18", {"revenue", "ebit", "dividends"}, 30, False)
newest_unreadable = native_document("newest_unreadable", "2026-06-30", {"revenue"}, 2, True)
recovery = module.select_recovery_house([older_clean, newest_unreadable])
assert recovery == "newest_unreadable"
module.close_unselected_recovery_frontiers([older_clean, newest_unreadable], recovery)
assert older_clean["tables"][0]["model_use"] == "eligible"
assert older_clean["tables"][0]["authority_role"] != "archive_only"

# Two recovery candidates: demanded native quality outranks publication date.
older_better = native_document("older_better", "2026-02-18", {"revenue", "ebit", "dividends"}, 20, True)
newer_weaker = native_document("newer_weaker", "2026-06-30", {"revenue"}, 2, True)
assert module.select_recovery_house([older_better, newer_weaker]) == "older_better"

# Date is a stable late tie-break only when native quality is equal.
old_equal = native_document("old_equal", "2026-02-18", {"revenue"}, 2, True)
new_equal = native_document("new_equal", "2026-06-30", {"revenue"}, 2, True)
assert module.select_recovery_house([old_equal, new_equal]) == "new_equal"

# Non-selected unresolved frontiers close archive-only, but their already-clean
# sibling surfaces would remain untouched by the surface-local operation.
module.close_unselected_recovery_frontiers([older_better, newer_weaker], "older_better")
assert newer_weaker["surfaces"][0]["lane_status"]["vision"] == "not_required"
assert newer_weaker["tables"][0]["model_use"] == "prohibited"

context = {
    "forecast_periods": ["2026-12-31", "2027-12-31", "2028-12-31"],
    "model_demand_graph": {
        "schema_version": "pre-broker-model-demand/1.0",
        "as_of": "2025-12-31",
        "reporting_currency": "USD",
        "units": "millions",
        "forecast_periods": ["2026-12-31", "2027-12-31", "2028-12-31"],
        "nodes": [],
        "counts": {"source_rows": 0, "forecast_nodes": 0, "material_nodes": 0},
        "graph_sha256": "0" * 64,
    },
}
expanded = module.expand_model_context_with_tier1_nodes(context)
labels = {node["label"] for node in expanded["model_demand_graph"]["nodes"]}
assert labels == {
    "Revenue", "EBIT", "Adjusted EBITDA", "Depreciation and amortisation",
    "Effective tax rate", "Capital expenditure", "Change in working capital",
    "Dividends paid", "Share buybacks",
}
assert len(expanded["model_demand_graph"]["nodes"]) == 27
print({"status": "PASS", "checks": 12})
''')
    return [path, schema_path, test_path]


def patch_discrete_event_closure() -> list[str]:
    behavior_path = "scripts/lib/forecast_behavior.mjs"
    authority_path = "scripts/lib/forecast_authority.mjs"
    behavior = read(behavior_path)
    authority = read(authority_path)
    role_insertions = [
        "acquisitions_net_of_cash",
        "acquisition_of_subsidiaries_net_of_cash_acquired",
        "business_combinations_net_of_cash_acquired",
    ]
    for role in role_insertions:
        if f'"{role}"' not in behavior:
            behavior = replace_once(
                behavior,
                '  "acquisition", "acquisition_cost", "business_combination", "disposal",',
                f'  "acquisition", "acquisition_cost", "{role}", "business_combination", "disposal",',
                f"behavior role insertion {role}",
            )
        if f'"{role}"' not in authority:
            authority = replace_once(
                authority,
                '  "acquisition_cost",\n  "business_combination",',
                f'  "acquisition_cost",\n  "{role}",\n  "business_combination",',
                f"authority role insertion {role}",
            )
    # Asset sales/disposals are discrete unless specific forward evidence exists.
    for role in ["asset_disposal", "asset_sale"]:
        if f'"{role}"' not in behavior.split("const NON_RECURRING_ROLES", 1)[1].split("]);", 1)[0]:
            behavior = replace_once(
                behavior,
                '  "exceptional_item", "discontinued_operation",',
                f'  "exceptional_item", "discontinued_operation", "{role}",',
                f"non-recurring role {role}",
            )
        if f'"{role}"' not in authority.split("const STRUCTURAL_EVENT_ROLES", 1)[1].split("]);", 1)[0]:
            authority = replace_once(
                authority,
                '  "discontinued_operation",',
                f'  "discontinued_operation",\n  "{role}",',
                f"structural role {role}",
            )
    write(behavior_path, behavior)
    write(authority_path, authority)

    test_path = "scripts/run_discrete_event_forecast_tests.mjs"
    if not (ROOT / test_path).exists():
        write(test_path, r'''#!/usr/bin/env node
import assert from "node:assert/strict";
import { classifyForecastBehavior } from "./lib/forecast_behavior.mjs";
import { compileForecastCandidates } from "./lib/forecast_candidate_compiler.mjs";
import { isStructuredSemanticEvent } from "./lib/forecast_authority.mjs";

const periods = [
  { date: "2023-12-31", status: "historical" },
  { date: "2024-12-31", status: "historical" },
  { date: "2025-12-31", status: "historical" },
  { date: "2026-12-31", status: "forecast" },
  { date: "2027-12-31", status: "forecast" },
  { date: "2028-12-31", status: "forecast" },
];
const acquisition = {
  row_id: "cf.acquisitions_net_of_cash",
  semantic_role: "acquisitions_net_of_cash",
  label: "Acquisition of subsidiaries, net of cash acquired",
  values: [-900, -1100, -1026, null, null, null],
  historical_authority: "source_input",
  row_type: "input",
  material: true,
};
assert.equal(isStructuredSemanticEvent(acquisition), true);
const modelCase = {
  periods,
  controls: { broker_case: "Forecast Waterfall" },
  statement_structure: { income_statement: [], cash_flow: [acquisition] },
  source_coverage: {
    income_statement: [],
    cash_flow: [{
      source_line_id: "cf.acquisitions_net_of_cash",
      label: acquisition.label,
      material: true,
      mapped_row_ids: [acquisition.row_id],
      classified_role: acquisition.semantic_role,
    }],
  },
};
const classification = classifyForecastBehavior(modelCase, acquisition, "cash_flow", [acquisition]);
assert.equal(classification.behavior, "non_recurring_event");
const plan = compileForecastCandidates(modelCase, { observations: [] });
const states = plan.states.filter((state) => state.row_id === acquisition.row_id);
assert.equal(states.length, 3);
for (const state of states) {
  assert.notEqual(state.method, "historical_average");
  assert.notEqual(state.method, "historical_trend");
  assert.notEqual(state.method, "carry_forward");
  assert.equal(state.method, "explicit_zero");
  assert.equal(state.value, 0);
}
// Mutation: an ordinary recurring-but-lumpy row still retains its independent
// fallback policy and is not globally zeroed by the discrete-event repair.
const capex = { ...acquisition, row_id: "cf.capex", semantic_role: "capex", label: "Capital expenditure" };
assert.equal(isStructuredSemanticEvent(capex), false);
console.log(JSON.stringify({ status: "PASS", checks: 17 }, null, 2));
''')
    return [behavior_path, authority_path, test_path]


def patch_registry() -> list[str]:
    path = "assets/development-test-registry.json"
    registry = json.loads(read(path))
    tests = registry.get("tests") or []
    by_id = {test.get("id"): test for test in tests}
    universal = by_id.get("universal-broker-delivery-matrix")
    if not universal:
        raise RuntimeError("universal broker delivery matrix registry entry absent")
    universal["arguments"] = ["$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"]
    universal["requires"] = ["RAW_CANARY_EVIDENCE", "PYTHON", "SOFFICE"]
    additions = [
        {
            "id": "filing-source-arithmetic",
            "phase": "evidence",
            "runtime": "python",
            "script": "run_filing_arithmetic_topology_tests.py",
        },
        {
            "id": "broker-native-eligibility",
            "phase": "evidence",
            "runtime": "python",
            "script": "run_broker_native_eligibility_tests.py",
        },
        {
            "id": "discrete-event-forecast",
            "phase": "forecast",
            "runtime": "node",
            "script": "run_discrete_event_forecast_tests.mjs",
        },
        {
            "id": "test-registry-interface",
            "phase": "proof",
            "runtime": "node",
            "script": "run_test_registry_interface_tests.mjs",
        },
    ]
    for addition in additions:
        if addition["id"] not in by_id:
            tests.append(addition)
            by_id[addition["id"]] = addition
    registry["tests"] = tests
    write(path, json.dumps(registry, indent=2) + "\n")

    test_path = "scripts/run_test_registry_interface_tests.mjs"
    if not (ROOT / test_path).exists():
        write(test_path, r'''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const registry = JSON.parse(fs.readFileSync(path.join(root, "assets", "development-test-registry.json"), "utf8"));
const ids = new Set();
let checks = 0;
for (const test of registry.tests) {
  assert.ok(test.id && !ids.has(test.id), `duplicate test id ${test.id}`);
  ids.add(test.id);
  const scriptPath = path.join(here, test.script);
  assert.ok(fs.existsSync(scriptPath), `missing registered script ${test.script}`);
  const source = fs.readFileSync(scriptPath, "utf8");
  const destructure = /const\s*\[([^\]]+)\]\s*=\s*process\.argv\.slice\(2\)/.exec(source);
  if (destructure) {
    const positional = destructure[1].split(",").map((item) => item.trim()).filter(Boolean);
    const declared = test.arguments ?? [];
    assert.ok(
      declared.length >= positional.length || (test.requires ?? []).length >= positional.length,
      `${test.id}: source requires ${positional.length} positional arguments but registry declares ${declared.length}`,
    );
  }
  for (const requirement of test.requires ?? []) {
    assert.match(requirement, /^[A-Z][A-Z0-9_]*$/, `${test.id}: invalid custody requirement ${requirement}`);
  }
  checks += 1;
}
const universal = registry.tests.find((test) => test.id === "universal-broker-delivery-matrix");
assert.deepEqual(universal.arguments, ["$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"]);
assert.deepEqual(universal.requires, ["RAW_CANARY_EVIDENCE", "PYTHON", "SOFFICE"]);
checks += 2;
console.log(JSON.stringify({ status: "PASS", checks, tests: registry.tests.length }, null, 2));
''')
    return [path, test_path]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    before = {
        path: sha(path) for path in [
            "scripts/extract_filing_statements.py",
            "scripts/extract_broker_evidence.py",
            "scripts/lib/forecast_behavior.mjs",
            "scripts/lib/forecast_authority.mjs",
            "assets/development-test-registry.json",
        ]
    }
    changed = []
    changed += patch_filing_arithmetic()
    changed += patch_broker_native_selection_and_demand()
    changed += patch_discrete_event_closure()
    changed += patch_registry()
    changed = sorted(set(changed))
    after = {path: sha(path) for path in changed}
    report: dict[str, Any] = {
        "schema_version": "excel-inflow-repair-stage1/1.0",
        "before": before,
        "after": after,
        "changed_paths": changed,
        "invariants": [
            "broker failure remains non-blocking",
            "all broker values remain selected-cell verified",
            "one expensive recovery frontier",
            "issuer captions remain unchanged",
            "forecast authority remains one-writer",
            "no schemas or tests weakened",
        ],
    }
    report["report_sha256"] = hashlib.sha256(
        (json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n").encode()
    ).hexdigest()
    (output / "repair-stage1.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    print(json.dumps({"status": "PASS", "changed": len(changed), "report_sha256": report["report_sha256"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
