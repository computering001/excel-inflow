#!/usr/bin/env python3
"""Mutation proof for the independent Python graph-constitution port."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

from invariants import _hash_value, parse_csv, validate_semantic_artifacts


def reseal(constitution: dict) -> None:
    constitution["layer_hashes"] = {}
    for layer in constitution["layers"]:
        core = {
            "layer_id": layer["layer_id"],
            "nodes": layer["nodes"],
            "edges": layer["edges"],
        }
        layer["graph_sha256"] = _hash_value(core)
        constitution["layer_hashes"][layer["layer_id"]] = layer["graph_sha256"]
    constitution["violation_sha256"] = _hash_value(
        sorted(
            constitution.get("violations") or [],
            key=lambda item: (
                "%s\x00%s" % (item.get("code"), item.get("message"))
            ).encode("utf-8"),
        )
    )
    closure = {
        "schema_version": constitution["schema_version"],
        "case_id": constitution["case_id"],
        "case_sha256": constitution["case_sha256"],
        "row_plan_projection_scope": constitution["row_plan_projection_scope"],
        "row_plan_projection_sha256": constitution[
            "row_plan_projection_sha256"
        ],
        "layer_hashes": constitution["layer_hashes"],
        "violation_sha256": constitution["violation_sha256"],
    }
    constitution["closure_sha256"] = _hash_value(closure)


def errors_for(manifest, crosswalk, row_plan, equation_graph) -> list[dict]:
    return validate_semantic_artifacts(
        manifest,
        crosswalk,
        row_plan=row_plan,
        equation_graph=equation_graph,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--row-map", required=True, type=Path)
    parser.add_argument("--crosswalk", required=True, type=Path)
    parser.add_argument("--equation-graph", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    row_plan = json.loads(args.row_map.read_text(encoding="utf-8"))
    equation_graph = json.loads(args.equation_graph.read_text(encoding="utf-8"))
    crosswalk = parse_csv(args.crosswalk.read_text(encoding="utf-8"))
    baseline_errors = errors_for(manifest, crosswalk, row_plan, equation_graph)
    if baseline_errors:
        raise RuntimeError(
            "clean Python constitution proof failed: %s"
            % json.dumps(baseline_errors[:5])
        )

    mutations = []

    def exercise(identifier, mutate, expected_prefix):
        candidate_manifest = copy.deepcopy(manifest)
        candidate_row_plan = copy.deepcopy(row_plan)
        mutate(candidate_manifest, candidate_row_plan)
        observed = errors_for(
            candidate_manifest, crosswalk, candidate_row_plan, equation_graph
        )
        ids = [item.get("id") for item in observed]
        caught = any(str(item).startswith(expected_prefix) for item in ids)
        mutations.append(
            {
                "id": identifier,
                "expected_prefix": expected_prefix,
                "caught": caught,
                "observed_error_ids": ids,
            }
        )

    def mutate_layer(layer_id, change):
        def apply(candidate_manifest, _row_plan):
            constitution = candidate_manifest["layered_graph_constitution"]
            layer = next(
                item for item in constitution["layers"] if item["layer_id"] == layer_id
            )
            change(layer)
            # Re-seal every Node-style hash. Only an independent source
            # reconstruction can catch these mutations after this point.
            reseal(constitution)

        return apply

    exercise(
        "forecast-writer-resealed",
        mutate_layer(
            "forecast",
            lambda layer: layer["nodes"][0].__setitem__(
                "writer", "formula:mutation"
            ),
        ),
        "manifest.layered_graph_constitution.node_mismatch",
    )
    exercise(
        "statement-edge-resealed",
        mutate_layer("statement", lambda layer: layer["edges"].pop()),
        "manifest.layered_graph_constitution.edge_mismatch",
    )
    exercise(
        "economic-role-resealed",
        mutate_layer(
            "economic",
            lambda layer: layer["nodes"][0].__setitem__(
                "role", "mutation.unbound_economic_role"
            ),
        ),
        "manifest.layered_graph_constitution.node_mismatch",
    )
    exercise(
        "physical-projection-resealed",
        mutate_layer(
            "row_plan",
            lambda layer: layer["nodes"][0].__setitem__(
                "physical_row", int(layer["nodes"][0]["physical_row"]) + 1
            ),
        ),
        "manifest.layered_graph_constitution.node_mismatch",
    )

    def alter_emitted_row_map(_candidate_manifest, candidate_row_plan):
        candidate_row_plan["statement_rows"]["income_statement"][0]["row"] += 1

    exercise(
        "emitted-row-map-drift",
        alter_emitted_row_map,
        "manifest.layered_graph_constitution.row_plan_hash_binding",
    )

    summary = {
        "schema_version": 1,
        "kind": "independent_python_layered_graph_mutations",
        "status": "PASS" if all(item["caught"] for item in mutations) else "BLOCK",
        "positive_checks": 1,
        "adversarial_mutations": len(mutations),
        "mutations": mutations,
    }
    (args.out / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
