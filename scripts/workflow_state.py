"""Canonical workflow-state and transition validation for evidence controllers."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
CONTRACT_PATH = ROOT / "assets" / "workflow-state-contract-v1.json"


@lru_cache(maxsize=1)
def workflow_contract() -> dict[str, Any]:
    value = json.loads(CONTRACT_PATH.read_text("utf-8"))
    if value.get("schema_version") != "workflow-state-contract/1.0":
        raise ValueError("Workflow-state contract has the wrong schema version")
    if not isinstance(value.get("layers"), dict):
        raise ValueError("Workflow-state contract has no layer registry")
    journey = value.get("visible_journey")
    if (
        not isinstance(journey, dict)
        or journey.get("schema_version") != "visible-journey/1.0"
        or not isinstance(journey.get("milestones"), list)
        or len(journey["milestones"]) != 6
    ):
        raise ValueError(
            "Workflow-state contract has no canonical six-milestone visible journey"
        )
    milestone_ids = [item.get("id") for item in journey["milestones"]]
    if any(not item for item in milestone_ids) or len(set(milestone_ids)) != 6:
        raise ValueError("Visible journey milestone ids must be unique")
    for stage_id in (
        "inputs", "evidence_review", "decisions", "build_checks", "delivery"
    ):
        if stage_id not in journey.get("checkpoints", {}):
            raise ValueError(
                f"Visible journey omits controller checkpoint {stage_id}"
            )
    constitution = value.get("delivery_blocker_constitution")
    if not isinstance(constitution, dict) or constitution.get("schema_version") != "delivery-blocker-constitution/1.0":
        raise ValueError("Workflow-state contract has no delivery-blocker constitution")
    return value


def assert_delivery_blocker(
    blocked: bool,
    fatal_reason: str | None = None,
    *,
    domain: str | None = None,
) -> None:
    constitution = workflow_contract()["delivery_blocker_constitution"]
    if not blocked:
        if fatal_reason is not None:
            raise ValueError("A non-blocked delivery result cannot carry a fatal reason")
        return
    if domain in set(constitution.get("non_delivery_blocking_domains", [])):
        raise ValueError(f"{domain} is a degradation domain, not a delivery blocker")
    if fatal_reason not in constitution.get("fatal_reasons", {}):
        raise ValueError(
            f"Delivery block must name one declared fatal reason; received {fatal_reason!r}"
        )


def assert_state(
    layer: str,
    status: str,
    blocker_class: str | None,
    user_blocking: bool,
    *,
    stage: str | None = None,
) -> None:
    contract = workflow_contract()
    declaration = contract["layers"].get(layer)
    if not declaration:
        raise ValueError(f"Unknown workflow-state layer: {layer}")
    state = declaration.get("states", {}).get(status)
    if not state:
        raise ValueError(f"Unknown {layer} workflow state: {status}")
    allowed_blockers = state.get("blocker_classes")
    if allowed_blockers is not None and blocker_class not in allowed_blockers:
        raise ValueError(
            f"{layer}.{status} cannot own blocker class {blocker_class!r}"
        )
    expected_user_blocking = state.get("user_blocking")
    if expected_user_blocking is None:
        expected_user_blocking = blocker_class in set(contract["user_blocking_classes"])
    if user_blocking is not expected_user_blocking:
        raise ValueError(
            f"{layer}.{status} user_blocking={user_blocking!r} disagrees with blocker ownership"
        )
    allowed_stages = state.get("stages")
    if allowed_stages is not None and stage not in allowed_stages:
        raise ValueError(f"{layer}.{status} cannot occur at stage {stage!r}")


def assert_transition(
    layer: str,
    previous_status: str | None,
    next_status: str,
    *,
    reset: bool = False,
) -> None:
    declaration = workflow_contract()["layers"].get(layer)
    if not declaration:
        raise ValueError(f"Unknown workflow-state layer: {layer}")
    if next_status not in declaration.get("states", {}):
        raise ValueError(f"Unknown {layer} workflow state: {next_status}")
    if previous_status is None or reset:
        return
    if previous_status not in declaration.get("states", {}):
        raise ValueError(f"Unknown prior {layer} workflow state: {previous_status}")
    allowed = declaration.get("transitions", {}).get(previous_status, [])
    if next_status not in allowed:
        raise ValueError(
            f"Illegal {layer} workflow transition: {previous_status} -> {next_status}"
        )


# End of the shared workflow-state transition contract.
