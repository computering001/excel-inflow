#!/usr/bin/env python3
"""Close the broker model-demand contract over the core debt-overlay metrics."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "scripts" / "extract_broker_evidence.py"
source = TARGET.read_text("utf-8")

if "def ensure_core_broker_demand_contract(" not in source:
    marker = "\ndef main() -> int:\n"
    if marker not in source:
        raise SystemExit("Broker extractor main entry point was not found.")
    helper = r'''

_CORE_BROKER_DEMAND = (
    ("adjusted_ebitda", "Adjusted EBITDA"),
    ("depreciation_and_amortisation", "Depreciation and amortisation"),
    ("effective_tax_rate", "Effective tax rate"),
    ("capex", "Capital expenditure"),
    ("change_in_working_capital", "Change in working capital"),
)


def _replace_demand_identity(
    value: Any, old_metric: str, old_label: str, new_metric: str, new_label: str,
) -> Any:
    if isinstance(value, list):
        return [
            _replace_demand_identity(item, old_metric, old_label, new_metric, new_label)
            for item in value
        ]
    if isinstance(value, dict):
        return {
            key: _replace_demand_identity(item, old_metric, old_label, new_metric, new_label)
            for key, item in value.items()
        }
    if isinstance(value, str):
        result = value.replace(old_label, new_label)
        result = result.replace(old_metric, new_metric)
        result = result.replace(old_metric.replace("_", "."), new_metric.replace("_", "."))
        return result
    return value


def ensure_core_broker_demand_contract(contract: dict[str, Any]) -> dict[str, Any]:
    """Add missing Tier-1 rows without changing periods or model-node custody.

    The contract compiler may start from filing face rows, which do not contain
    synthetic bridge/driver nodes. A cloned schema-valid target preserves the
    exact period and selected-cell shape while assigning the canonical metric
    identity. The selected-authority resolver still decides whether a recovered
    value is actually consumed.
    """
    output = json.loads(json.dumps(contract))
    targets = list(output.get("targets") or [])
    existing = {
        str(target.get("metric_id") or target.get("concept_id") or "")
        for target in targets
    }
    prototype = next(
        (
            target for target in targets
            if str(target.get("metric_id") or target.get("concept_id")) == "revenue"
        ),
        targets[0] if targets else None,
    )
    if prototype is None:
        return output
    old_metric = str(prototype.get("metric_id") or prototype.get("concept_id") or "revenue")
    old_label = str(prototype.get("label") or prototype.get("source_label") or "Revenue")
    for metric_id, label in _CORE_BROKER_DEMAND:
        if metric_id in existing:
            continue
        target = _replace_demand_identity(
            prototype, old_metric, old_label, metric_id, label,
        )
        for key in ("metric_id", "concept_id", "semantic_role"):
            if key in target:
                target[key] = metric_id
        for key in ("label", "source_label"):
            if key in target:
                target[key] = label
        if "definition_id" in target:
            target["definition_id"] = f"dict.{metric_id}"
        if "source_line_id" in target:
            target["source_line_id"] = f"synthetic-tier1.{metric_id}"
        if "definition_signature_sha256" in target:
            target["definition_signature_sha256"] = hashlib.sha256(
                f"tier1-demand:{metric_id}".encode("utf-8")
            ).hexdigest()
        if "aliases" in target:
            target["aliases"] = [label, metric_id.replace("_", " ")]
        if "search_terms" in target:
            target["search_terms"] = [label, metric_id.replace("_", " ")]
        targets.append(target)
        existing.add(metric_id)
    output["targets"] = targets
    if "contract_sha256" in output:
        body = {key: value for key, value in output.items() if key != "contract_sha256"}
        output["contract_sha256"] = hashlib.sha256(
            (json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        ).hexdigest()
    return output
'''
    source = source.replace(marker, helper + marker, 1)

old = '    demand_contract = compile_broker_demand_contract(request.get("model_context") or {})\n'
new = (
    '    demand_contract = ensure_core_broker_demand_contract(\n'
    '        compile_broker_demand_contract(request.get("model_context") or {}),\n'
    '    )\n'
)
if old in source:
    source = source.replace(old, new, 1)
elif "demand_contract = ensure_core_broker_demand_contract(" not in source:
    raise SystemExit("Broker demand compiler call was not found.")

TARGET.write_text(source, "utf-8")
print({"status": "PASS", "repair": "tier1_broker_demand"})
