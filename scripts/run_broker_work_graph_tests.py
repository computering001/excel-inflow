#!/usr/bin/env python3
"""Positive and adversarial tests for the append-only broker work graph."""

from __future__ import annotations

import copy
import json

from broker_work_graph import build_work_graph, verify_work_graph


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def task(task_id: str, task_kind: str) -> dict:
    return {
        "task_id": task_id,
        "task_kind": task_kind,
        "progress_measure": {"task_input_sha256": task_id[-24:].ljust(64, "0")},
    }


def main() -> int:
    cache_key = "a" * 64
    extract = {
        "stage": "extract",
        "status": "PASS",
        "input_sha256": "b" * 64,
        "output_sha256": "c" * 64,
        "reused": False,
    }
    resolution = task("broker-task-" + "1" * 24, "targeted_cell_adjudication")
    first = build_work_graph(
        prior={}, cache_key=cache_key, tasks=[resolution], checkpoints=[extract]
    )
    check(not verify_work_graph(first), "initial work graph is invalid")
    check(first["status"] == "OPEN" and len(first["open_task_ids"]) == 1, "initial frontier is not open")

    # The production defect: a later canonical sweep discovers vision work
    # after resolution. The task appends; no scalar stage regresses.
    vision = task("broker-task-" + "2" * 24, "independent_table_transcription")
    prior = {"cache_key": cache_key, "work_graph": first}
    second = build_work_graph(
        prior=prior, cache_key=cache_key, tasks=[vision], checkpoints=[extract]
    )
    check(not verify_work_graph(second), "late vision graph is invalid")
    check(first["nodes"][0]["node_id"] in {n["node_id"] for n in second["nodes"]}, "prior node disappeared")
    check(second["revision"] > first["revision"], "late task did not append a revision")

    # Re-observing the same frontier is byte-stable and costs nothing.
    polled = build_work_graph(
        prior={"cache_key": cache_key, "work_graph": second},
        cache_key=cache_key,
        tasks=[vision],
        checkpoints=[extract],
    )
    check(polled == second, "unchanged polling mutated the work graph")

    # A real execution receipt is an append-only completed node.
    receipt = "d" * 64
    executed = build_work_graph(
        prior={"cache_key": cache_key, "work_graph": second},
        cache_key=cache_key,
        tasks=[vision],
        checkpoints=[extract],
        task_execution_receipts={vision["task_id"]: [receipt]},
    )
    check(len(executed["completed_node_ids"]) > len(second["completed_node_ids"]), "execution receipt was not completed work")

    closed = build_work_graph(
        prior={"cache_key": cache_key, "work_graph": executed},
        cache_key=cache_key,
        tasks=[],
        checkpoints=[extract],
        task_execution_receipts={vision["task_id"]: [receipt]},
        closed=True,
    )
    check(not verify_work_graph(closed), "closed graph is invalid")
    check(closed["status"] == "CLOSED" and not closed["open_task_ids"], "closed graph retained work")
    check(
        {resolution["task_id"], vision["task_id"]}.issubset(closed["completed_node_ids"]),
        "closed graph did not retain completed task ownership",
    )

    mutations = 0
    for mutate, expected in (
        (lambda value: value.update({"graph_sha256": "0" * 64}), "graph_hash_mismatch"),
        (lambda value: value["open_task_ids"].append("missing-task"), "open_task_missing_node"),
        (lambda value: value["nodes"].append(copy.deepcopy(value["nodes"][0])), "duplicate_or_missing_node_id"),
        (
            lambda value: value["open_task_ids"].append(resolution["task_id"]),
            "task_both_open_and_completed",
        ),
        (
            lambda value: value.update({"current_frontier_sha256": "f" * 64}),
            "frontier_hash_mismatch",
        ),
        (
            lambda value: value["nodes"].reverse(),
            "nodes_not_canonical_order",
        ),
    ):
        candidate = copy.deepcopy(closed)
        mutate(candidate)
        errors = verify_work_graph(candidate)
        check(expected in errors, f"mutation {expected} was not detected: {errors}")
        mutations += 1

    print(json.dumps({
        "status": "PASS",
        "positive_checks": 10,
        "mutation_checks": mutations,
        "total_violation_count": 0,
        "closure_sha256": closed["graph_sha256"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
