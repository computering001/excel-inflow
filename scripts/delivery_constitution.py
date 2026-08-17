from __future__ import annotations

import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CONSTITUTION_PATH = ROOT / "assets" / "delivery-constitution-v1.json"
DELIVERY_CONSTITUTION: dict[str, Any] = json.loads(
    CONSTITUTION_PATH.read_text(encoding="utf-8")
)


def _required_flag(finding: dict[str, Any], name: str) -> bool:
    if name == "unresolved":
        return finding.get("unresolved") is True
    if name == "material":
        return finding.get("material") is True
    if name == "reachable_to_material_output":
        return finding.get("reachable_to_material_output") is True
    if name == "no_alternative_authority_path":
        return finding.get("alternative_authority_path_exists") is not True
    if name == "mandatory_evidence_lane":
        return DELIVERY_CONSTITUTION["lanes"].get(finding.get("lane")) == "mandatory"
    if name == "finite_user_resolution_available":
        return finding.get("finite_user_resolution_available") is True
    raise ValueError(f"Unknown delivery-constitution predicate {name}")


def _predicate_passes(predicate: dict[str, Any], finding: dict[str, Any]) -> bool:
    return all(_required_flag(finding, name) for name in predicate["all"])


def classify_delivery_finding(finding: dict[str, Any]) -> str:
    lane = finding.get("lane")
    criticality = DELIVERY_CONSTITUTION["lanes"].get(lane)
    if criticality is None:
        raise ValueError(f"Unknown delivery-constitution lane {lane}")
    if criticality == "optional":
        return (
            "DEGRADE"
            if finding.get("reachable_to_material_output") is True
            or finding.get("unresolved") is True
            else "LOG"
        )
    if _predicate_passes(DELIVERY_CONSTITUTION["ask_predicate"], finding):
        return "ASK"
    if _predicate_passes(DELIVERY_CONSTITUTION["block_predicate"], finding):
        return "BLOCK"
    return "DEGRADE" if finding.get("reachable_to_material_output") is True else "LOG"


def assert_broker_failure_degrades(reason: str) -> str:
    if reason not in DELIVERY_CONSTITUTION["degrade_reasons"]:
        raise ValueError(f"Broker failure reason {reason} is not registered for degradation")
    owner = classify_delivery_finding(
        {
            "lane": "broker",
            "unresolved": True,
            "material": True,
            "reachable_to_material_output": True,
            "alternative_authority_path_exists": False,
            "finite_user_resolution_available": False,
        }
    )
    if owner != "DEGRADE":
        raise ValueError(f"Optional broker failure mutated to {owner}; DEGRADE is required")
    return owner
