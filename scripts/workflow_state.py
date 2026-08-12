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
    return value


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
