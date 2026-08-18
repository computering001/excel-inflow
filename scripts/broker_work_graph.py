#!/usr/bin/env python3
"""Append-only work graph for the broker evidence controller.

The broker pipeline is not a linear stage machine.  Canonical reconciliation
may legitimately discover a new vision task after a resolution or semantic
task has already been observed.  This module records that work as an
append-only graph: checkpoint, task and execution-receipt nodes are immutable;
only the current frontier changes.
"""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any


SCHEMA_VERSION = "broker-work-graph/1.0"


def canonical_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def checkpoint_node(checkpoint: dict[str, Any]) -> dict[str, Any]:
    body = {
        "node_kind": "checkpoint",
        "stage": checkpoint.get("stage"),
        "status": checkpoint.get("status"),
        "input_sha256": checkpoint.get("input_sha256"),
        "output_sha256": checkpoint.get("output_sha256"),
    }
    return {
        "node_id": f"broker-work-{canonical_hash(body)[:24]}",
        **body,
    }


def task_node(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "node_id": str(task["task_id"]),
        "node_kind": "task",
        "task_kind": task.get("task_kind"),
        "task_input_sha256": task.get("progress_measure", {}).get(
            "task_input_sha256"
        ),
        "document_id": task.get("document_id"),
        "surface_id": task.get("surface_id"),
    }


def receipt_node(task_id: str, receipt_sha256: str) -> dict[str, Any]:
    body = {
        "node_kind": "execution_receipt",
        "task_id": task_id,
        "receipt_sha256": receipt_sha256,
    }
    return {
        "node_id": f"broker-work-{canonical_hash(body)[:24]}",
        **body,
    }


def _prior_graph(prior: dict[str, Any], cache_key: str) -> dict[str, Any]:
    value = (
        prior.get("work_graph")
        or (prior.get("fixed_point") or {}).get("work_graph")
        if prior.get("cache_key") == cache_key
        else None
    )
    if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
        return {}
    return value


def build_work_graph(
    *,
    prior: dict[str, Any],
    cache_key: str,
    tasks: list[dict[str, Any]],
    checkpoints: list[dict[str, Any]],
    task_execution_receipts: dict[str, list[str]] | None = None,
    closed: bool = False,
) -> dict[str, Any]:
    """Return one deterministic append-only graph revision.

    Re-presenting an unchanged frontier is byte-identical.  A newly discovered
    task appends a node and frontier observation even when its task kind would
    have been an "earlier" stage in the retired ordinal controller.
    """

    previous = _prior_graph(prior, cache_key)
    node_by_id = {
        str(item.get("node_id")): copy.deepcopy(item)
        for item in previous.get("nodes", [])
        if isinstance(item, dict) and item.get("node_id")
    }

    for item in checkpoints:
        node = checkpoint_node(item)
        node_by_id.setdefault(node["node_id"], node)
    for item in tasks:
        node = task_node(item)
        node_by_id.setdefault(node["node_id"], node)
    for task_id, digests in sorted((task_execution_receipts or {}).items()):
        for digest in sorted(set(digests)):
            node = receipt_node(task_id, digest)
            node_by_id.setdefault(node["node_id"], node)

    open_task_ids = sorted(str(item["task_id"]) for item in tasks)
    frontier_sha256 = canonical_hash(open_task_ids)
    frontier_history = list(previous.get("frontier_history_sha256", []))
    if frontier_sha256 not in frontier_history:
        frontier_history.append(frontier_sha256)

    completed_node_ids = set(previous.get("completed_node_ids", []))
    completed_node_ids.update(
        checkpoint_node(item)["node_id"]
        for item in checkpoints
        if item.get("status") == "PASS"
    )
    completed_node_ids.update(
        node_id
        for node_id, node in node_by_id.items()
        if node.get("node_kind") == "execution_receipt"
    )
    # A task may legitimately recur after a later compiler pass rediscovers
    # the same immutable obligation.  Therefore leaving one intermediate
    # frontier is not itself proof of completion.  Execution receipts are
    # completed nodes as they arrive; task nodes become complete only when the
    # controller seals the entire graph CLOSED.
    if closed:
        completed_node_ids.update(
            node_id
            for node_id, node in node_by_id.items()
            if node.get("node_kind") == "task"
        )

    nodes = [node_by_id[node_id] for node_id in sorted(node_by_id)]
    prior_node_ids = {
        str(item.get("node_id"))
        for item in previous.get("nodes", [])
        if isinstance(item, dict) and item.get("node_id")
    }
    prior_completed = set(previous.get("completed_node_ids", []))
    monotonic = prior_node_ids.issubset(node_by_id) and prior_completed.issubset(
        completed_node_ids
    )
    violations = [] if monotonic else ["append_only_work_graph_regressed"]

    core = {
        "schema_version": SCHEMA_VERSION,
        "cache_key": cache_key,
        "status": "CLOSED" if closed else "OPEN",
        "nodes": nodes,
        "open_task_ids": [] if closed else open_task_ids,
        "completed_node_ids": sorted(completed_node_ids),
        "frontier_history_sha256": frontier_history,
        "current_frontier_sha256": canonical_hash([]) if closed else frontier_sha256,
        "monotonic_from_prior": monotonic,
        "violations": violations,
    }
    comparable = {key: value for key, value in core.items() if key != "revision"}
    previous_comparable = {
        key: value
        for key, value in previous.items()
        if key not in {"revision", "graph_sha256"}
    }
    changed = comparable != previous_comparable
    core["revision"] = int(previous.get("revision", 0)) + (1 if changed else 0)
    core["graph_sha256"] = canonical_hash(core)
    return core


def verify_work_graph(graph: dict[str, Any]) -> list[str]:
    """Independently verify graph identity and basic append-only invariants."""

    errors: list[str] = []
    if graph.get("schema_version") != SCHEMA_VERSION:
        errors.append("wrong_schema_version")
        return errors
    nodes = graph.get("nodes")
    if not isinstance(nodes, list):
        return ["nodes_not_array"]
    node_ids = [item.get("node_id") for item in nodes if isinstance(item, dict)]
    if len(node_ids) != len(nodes) or len(node_ids) != len(set(node_ids)):
        errors.append("duplicate_or_missing_node_id")
    if node_ids != sorted(node_ids):
        errors.append("nodes_not_canonical_order")
    node_set = set(node_ids)
    node_by_id = {
        str(item.get("node_id")): item
        for item in nodes
        if isinstance(item, dict) and item.get("node_id")
    }
    if not set(graph.get("open_task_ids", [])).issubset(node_set):
        errors.append("open_task_missing_node")
    if any(
        node_by_id.get(node_id, {}).get("node_kind") != "task"
        for node_id in graph.get("open_task_ids", [])
    ):
        errors.append("open_frontier_contains_non_task")
    if not set(graph.get("completed_node_ids", [])).issubset(node_set):
        errors.append("completed_node_missing")
    if set(graph.get("open_task_ids", [])) & set(graph.get("completed_node_ids", [])):
        errors.append("task_both_open_and_completed")
    if graph.get("status") == "CLOSED" and graph.get("open_task_ids"):
        errors.append("closed_graph_has_open_tasks")
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if node.get("node_kind") == "execution_receipt":
            target = node_by_id.get(str(node.get("task_id") or ""), {})
            if target.get("node_kind") != "task":
                errors.append("execution_receipt_missing_task")
    expected_frontier = canonical_hash(sorted(graph.get("open_task_ids", [])))
    if graph.get("current_frontier_sha256") != expected_frontier:
        errors.append("frontier_hash_mismatch")
    if graph.get("current_frontier_sha256") not in graph.get(
        "frontier_history_sha256", []
    ):
        errors.append("current_frontier_absent_from_history")
    body = {key: value for key, value in graph.items() if key != "graph_sha256"}
    if graph.get("graph_sha256") != canonical_hash(body):
        errors.append("graph_hash_mismatch")
    if graph.get("violations"):
        errors.append("graph_declares_violations")
    return sorted(set(errors))
