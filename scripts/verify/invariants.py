"""Python port of scripts/lib/validation_invariants.mjs.

Only the functions validate_dynamic_model.mjs actually imports are ported:
`embeddedRateLiterals`, `parseCsv`, `sha256`, `validateFiscalPeriods`,
`validateNativeEvidence` and `validateSemanticArtifacts`.  Error records keep
the Node field names verbatim so the two reports diff cleanly.

The Node module is pure arithmetic and rules -- no legacy workbook library -- so this is a
transliteration, not a redesign.  The one deliberate difference is that the
Node module is *also* used by files owned by other agents; this copy is
standalone so nothing here can perturb them.
"""

from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import quote
from typing import Any, Dict, List, Optional

APPROVED_MAPPING_METHODS = {
    "exact",
    "renamed",
    "aggregate",
    "split",
    "derived",
    "not_applicable",
}


def canonical(value: Any) -> Any:
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value.keys())}
    return value


def canonical_json(value: Any) -> str:
    """Matches `JSON.stringify(canonical(value))` byte-for-byte for the JSON
    subset these artefacts use (no NaN/Infinity, no undefined)."""
    return json.dumps(canonical(value), separators=(",", ":"), ensure_ascii=False)


def sha256(value) -> str:
    if isinstance(value, (bytes, bytearray)):
        return hashlib.sha256(value).hexdigest()
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


_LAYERED_GRAPH_VERSION = "layered-graph-constitution/1.1"
_ROW_PLAN_PROJECTION_SCOPE = "statement-row-projection/1.0"
_LAYER_IDS = ("evidence", "statement", "forecast", "economic", "row_plan")


def _hash_value(value: Any) -> str:
    """Python port of run_store.mjs `hashValue`.

    The two-space JSON representation is part of that persisted hash contract;
    `canonical_json` above intentionally uses the compact representation for
    older sidecars, so this helper must remain separate.
    """

    payload = json.dumps(canonical(value), indent=2, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _stable_layer_node_id(layer: str, *parts: Any) -> str:
    safe = "-_.!~*'()"  # JavaScript encodeURIComponent's unescaped set.
    encoded = [quote(str("" if part is None else part), safe=safe) for part in parts]
    return ":".join([layer, *encoded])


def _portable_sorted(values, key=lambda value: value):
    return sorted(values, key=lambda value: str(key(value)).encode("utf-8"))


def _layer_index(constitution: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {
        item.get("layer_id"): item
        for item in constitution.get("layers") or []
        if isinstance(item, dict) and item.get("layer_id")
    }


def _error(errors: List[Dict[str, Any]], identifier: str, **detail: Any) -> None:
    errors.append({"id": identifier, **detail})


def _node_map(layer: Dict[str, Any]) -> Dict[Any, Dict[str, Any]]:
    return {
        node.get("id"): node
        for node in layer.get("nodes") or []
        if isinstance(node, dict) and node.get("id")
    }


# ---------------------------------------------------------------------------
# Economic-layer statement binding (P4.6), re-derived independently.
#
# The economic layer used to be an isolated node set: every node carried five
# identity fields and no edge left the layer, so this oracle could compare it
# against the canonical equation graph alone.  The layer now also carries the
# canonical equation-node -> statement-row relation, and an unchecked field is
# exactly how the drift that binding closes would reappear.  So these are
# declared here rather than imported: `scripts/verify` may not import
# `scripts/lib` (see oracle_independence.py), and re-declaring the vocabulary is
# what makes disagreement between the two sides detectable at all.
#
# What this oracle verifies INDEPENDENTLY, from the equation-graph asset and the
# artifact's own statement layer:
#   * the binding field set is exactly this, per node — no missing field and no
#     unchecked extra field;
#   * disposition and status are declared members, and the disposition
#     constrains which statuses and which companion fields are legal;
#   * the status is RE-DERIVED from the statement layer, so `bound`,
#     `row_absent` and `row_ambiguous` each have to be earned: a node may not
#     claim its row is missing while the layer contains it, nor claim a binding
#     the layer cannot resolve to exactly one row;
#   * the bound statement node genuinely carries the declared section and
#     semantic role, and no statement row is claimed by two economic nodes;
#   * the cross-layer edge set follows exactly from the RE-DERIVED bound set,
#     not from the nodes' own claims.
#
# What it does NOT independently verify: WHICH (section, semantic_role) pair a
# node declares.  That pair is a declaration with no second source, exactly as
# the node's `role` is read from the equation-graph asset rather than derived.
# Promoting the register to a declarative asset both sides read would close
# that gap; it is recorded here rather than pretended away.
_ECONOMIC_BINDING_FIELDS = (
    "binding_disposition",
    "binding_join_basis",
    "binding_row_family",
    "binding_status",
    "bound_section",
    "bound_semantic_role",
    "bound_statement_node_id",
)

_ECONOMIC_BINDING_DISPOSITIONS = ("schedule_row", "solver_control", "statement_row")

_ECONOMIC_BINDING_STATUSES = (
    "bound",
    "not_row_realised",
    "row_absent",
    "row_ambiguous",
    # A second claimant on a row another node already realises. The claim is
    # refused, so no realisation edge exists for it and the row derivation below
    # does not apply.
    "row_contested",
    "schedule_row_uncovered",
    "undeclared",
)

# One disposition admits exactly these statuses.  Without this the layer could
# relabel an unbound node `schedule_row_uncovered` and escape the row checks.
_ECONOMIC_STATUS_BY_DISPOSITION = {
    "solver_control": ("not_row_realised",),
    "schedule_row": ("schedule_row_uncovered",),
    "statement_row": ("bound", "row_absent", "row_ambiguous", "row_contested"),
}


def _economic_statement_role_index(
    statement_layer: Dict[str, Any],
) -> Dict[Any, List[Dict[str, Any]]]:
    index: Dict[Any, List[Dict[str, Any]]] = {}
    for node in statement_layer.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        role = node.get("semantic_role")
        if not role:
            continue
        index.setdefault((node.get("section"), role), []).append(node)
    return index


def _validate_economic_statement_binding(
    errors: List[Dict[str, Any]],
    *,
    economic_layer: Dict[str, Any],
    statement_layer: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Check every binding field and return the expected cross-layer edges."""

    role_index = _economic_statement_role_index(statement_layer)
    statement_by_id = _node_map(statement_layer)
    expected_edges: List[Dict[str, Any]] = []
    claimed_statement_nodes: Dict[Any, Any] = {}
    for node in economic_layer.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        missing = [field for field in _ECONOMIC_BINDING_FIELDS if field not in node]
        extra = _portable_sorted(
            set(node)
            - set(_ECONOMIC_BINDING_FIELDS)
            - {"id", "equation_node_id", "role", "domain", "writer"}
        )
        if missing or extra:
            _error(
                errors,
                "manifest.layered_graph_constitution.economic_binding_field_set",
                stable_id=node_id,
                missing=missing,
                unchecked=extra,
            )
            continue
        disposition = node.get("binding_disposition")
        status = node.get("binding_status")
        if disposition not in _ECONOMIC_BINDING_DISPOSITIONS:
            _error(
                errors,
                "manifest.layered_graph_constitution.economic_binding_disposition",
                stable_id=node_id,
                disposition=disposition,
            )
            continue
        if status not in _ECONOMIC_BINDING_STATUSES:
            _error(
                errors,
                "manifest.layered_graph_constitution.economic_binding_status",
                stable_id=node_id,
                status=status,
            )
            continue
        if status not in _ECONOMIC_STATUS_BY_DISPOSITION[disposition]:
            _error(
                errors,
                "manifest.layered_graph_constitution.economic_binding_status_disposition",
                stable_id=node_id,
                disposition=disposition,
                status=status,
                allowed=list(_ECONOMIC_STATUS_BY_DISPOSITION[disposition]),
            )
            continue
        if disposition == "schedule_row" and not node.get("binding_row_family"):
            _error(
                errors,
                "manifest.layered_graph_constitution.economic_binding_row_family",
                stable_id=node_id,
            )
        if disposition != "schedule_row" and node.get("binding_row_family") is not None:
            _error(
                errors,
                "manifest.layered_graph_constitution.economic_binding_row_family",
                stable_id=node_id,
                row_family=node.get("binding_row_family"),
            )
        if disposition != "statement_row":
            for field in (
                "bound_section",
                "bound_semantic_role",
                "bound_statement_node_id",
            ):
                if node.get(field) is not None:
                    _error(
                        errors,
                        "manifest.layered_graph_constitution.economic_binding_unbound_claim",
                        stable_id=node_id,
                        field=field,
                        value=node.get(field),
                    )
            continue
        section = node.get("bound_section")
        semantic_role = node.get("bound_semantic_role")
        if not section or not semantic_role:
            _error(
                errors,
                "manifest.layered_graph_constitution.economic_binding_incomplete_join",
                stable_id=node_id,
                section=section,
                semantic_role=semantic_role,
            )
            continue
        if status == "row_contested":
            # The claim was refused, not resolved: the row exists and would
            # derive `bound`, so the derivation does not apply. What must hold is
            # that the refusal carries no target and no edge.
            if node.get("bound_statement_node_id") is not None:
                _error(
                    errors,
                    "manifest.layered_graph_constitution.economic_binding_unbound_claim",
                    stable_id=node_id,
                    field="bound_statement_node_id",
                    value=node.get("bound_statement_node_id"),
                )
            continue
        matches = role_index.get((section, semantic_role)) or []
        derived_status = (
            "bound"
            if len(matches) == 1
            else "row_absent"
            if not matches
            else "row_ambiguous"
        )
        if derived_status != status:
            # The whole point: absence and ambiguity are re-derived from the
            # statement layer, so neither can be asserted into existence.
            _error(
                errors,
                "manifest.layered_graph_constitution.economic_binding_status_derivation",
                stable_id=node_id,
                section=section,
                semantic_role=semantic_role,
                claimed=status,
                derived=derived_status,
                statement_matches=[item.get("id") for item in matches],
            )
            continue
        if derived_status != "bound":
            if node.get("bound_statement_node_id") is not None:
                _error(
                    errors,
                    "manifest.layered_graph_constitution.economic_binding_unbound_claim",
                    stable_id=node_id,
                    field="bound_statement_node_id",
                    value=node.get("bound_statement_node_id"),
                )
            continue
        target = matches[0]
        if node.get("bound_statement_node_id") != target.get("id"):
            _error(
                errors,
                "manifest.layered_graph_constitution.economic_binding_target",
                stable_id=node_id,
                expected=target.get("id"),
                actual=node.get("bound_statement_node_id"),
            )
            continue
        persisted = statement_by_id.get(target.get("id")) or {}
        if (
            persisted.get("section") != section
            or persisted.get("semantic_role") != semantic_role
        ):
            _error(
                errors,
                "manifest.layered_graph_constitution.economic_binding_target_role",
                stable_id=node_id,
                statement_id=target.get("id"),
                expected=[section, semantic_role],
                actual=[persisted.get("section"), persisted.get("semantic_role")],
            )
            continue
        contender = claimed_statement_nodes.get(target.get("id"))
        if contender is not None:
            _error(
                errors,
                "manifest.layered_graph_constitution.economic_binding_row_contested",
                statement_id=target.get("id"),
                claimants=_portable_sorted([contender, node_id]),
            )
            continue
        claimed_statement_nodes[target.get("id")] = node_id
        expected_edges.append(
            {
                "id": _stable_layer_node_id(
                    "edge", "economic_realises_row", node.get("equation_node_id")
                ),
                "type": "realises_statement_row",
                "from": node_id,
                "to": target.get("id"),
                "activation": "always",
                "cross_layer": True,
            }
        )
    return expected_edges


def _compare_exact_inventory(
    errors: List[Dict[str, Any]],
    *,
    layer_id: str,
    item_kind: str,
    expected: List[Dict[str, Any]],
    actual: List[Dict[str, Any]],
) -> None:
    expected_by_id = {item.get("id"): item for item in expected}
    actual_by_id = {item.get("id"): item for item in actual}
    if len(expected_by_id) != len(expected) or len(actual_by_id) != len(actual):
        _error(
            errors,
            "manifest.layered_graph_constitution.duplicate_%s" % item_kind,
            layer=layer_id,
        )
    for identifier in _portable_sorted(set(expected_by_id) | set(actual_by_id)):
        wanted = expected_by_id.get(identifier)
        observed = actual_by_id.get(identifier)
        if wanted != observed:
            _error(
                errors,
                "manifest.layered_graph_constitution.%s_mismatch" % item_kind,
                layer=layer_id,
                stable_id=identifier,
                expected=wanted,
                actual=observed,
            )


def validate_layered_graph_constitution(
    constitution: Any,
    *,
    manifest: Optional[Dict[str, Any]] = None,
    row_plan: Optional[Dict[str, Any]] = None,
    equation_graph: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Independently validate and re-project the five graph layers.

    This is deliberately not a trust check on the Node-produced PASS label.
    Python recomputes every persisted graph/closure hash and, when its source
    artefacts are supplied, reconstructs the evidence, statement dependency,
    forecast writer, canonical economic and physical row-plan inventories.
    """

    errors: List[Dict[str, Any]] = []
    artifact = constitution if isinstance(constitution, dict) else {}
    if artifact.get("schema_version") != _LAYERED_GRAPH_VERSION:
        _error(
            errors,
            "manifest.layered_graph_constitution.schema_version",
            expected=_LAYERED_GRAPH_VERSION,
            actual=artifact.get("schema_version"),
        )
        return errors

    layers = artifact.get("layers") or []
    actual_layer_ids = [item.get("layer_id") for item in layers if isinstance(item, dict)]
    if actual_layer_ids != list(_LAYER_IDS):
        _error(
            errors,
            "manifest.layered_graph_constitution.layer_order",
            expected=list(_LAYER_IDS),
            actual=actual_layer_ids,
        )
    layer_by_id = _layer_index(artifact)
    all_node_ids: List[Any] = []
    expected_layer_hashes: Dict[str, Any] = {}
    for layer_id in _LAYER_IDS:
        layer = layer_by_id.get(layer_id)
        if not isinstance(layer, dict):
            _error(errors, "manifest.layered_graph_constitution.layer_missing", layer=layer_id)
            continue
        nodes = layer.get("nodes") or []
        edges = layer.get("edges") or []
        all_node_ids.extend(
            node.get("id") for node in nodes if isinstance(node, dict)
        )
        core = {"layer_id": layer_id, "nodes": nodes, "edges": edges}
        calculated = _hash_value(core)
        expected_layer_hashes[layer_id] = calculated
        if layer.get("graph_sha256") != calculated:
            _error(
                errors,
                "manifest.layered_graph_constitution.layer_hash",
                layer=layer_id,
                expected=calculated,
                actual=layer.get("graph_sha256"),
            )

    duplicate_node_ids = _portable_sorted(
        {node_id for node_id in all_node_ids if all_node_ids.count(node_id) > 1}
    )
    if duplicate_node_ids:
        _error(
            errors,
            "manifest.layered_graph_constitution.duplicate_node_id",
            stable_ids=duplicate_node_ids,
        )
    node_id_set = set(all_node_ids)
    for layer_id, layer in layer_by_id.items():
        for edge in layer.get("edges") or []:
            if edge.get("from") not in node_id_set or edge.get("to") not in node_id_set:
                _error(
                    errors,
                    "manifest.layered_graph_constitution.orphan_edge",
                    layer=layer_id,
                    edge_id=edge.get("id"),
                    source=edge.get("from"),
                    target=edge.get("to"),
                )

    if artifact.get("layer_hashes") != expected_layer_hashes:
        _error(
            errors,
            "manifest.layered_graph_constitution.layer_hash_inventory",
            expected=expected_layer_hashes,
            actual=artifact.get("layer_hashes"),
        )
    sorted_violations = _portable_sorted(
        artifact.get("violations") or [],
        key=lambda item: "%s\x00%s" % (item.get("code"), item.get("message")),
    )
    expected_violation_sha256 = _hash_value(sorted_violations)
    if artifact.get("violation_sha256") != expected_violation_sha256:
        _error(
            errors,
            "manifest.layered_graph_constitution.violation_hash",
            expected=expected_violation_sha256,
            actual=artifact.get("violation_sha256"),
        )
    # The closure core seals the economic binding register and the coverage
    # ledger alongside the layer hashes (P4.6).  This oracle must rebuild the
    # SAME core: a stale core here would report a hash mismatch on every build
    # while the artifact was in fact self-consistent, which is a disagreement
    # between two views of one graph rather than a finding.
    closure_core = {
        "schema_version": artifact.get("schema_version"),
        "case_id": artifact.get("case_id"),
        "case_sha256": artifact.get("case_sha256"),
        "row_plan_projection_scope": artifact.get("row_plan_projection_scope"),
        "row_plan_projection_sha256": artifact.get("row_plan_projection_sha256"),
        "layer_hashes": artifact.get("layer_hashes"),
        "economic_binding_scope": artifact.get("economic_binding_scope"),
        "economic_binding_sha256": artifact.get("economic_binding_sha256"),
        "economic_coverage_sha256": artifact.get("economic_coverage_sha256"),
        "violation_sha256": artifact.get("violation_sha256"),
    }
    expected_closure_sha256 = _hash_value(closure_core)
    if artifact.get("closure_sha256") != expected_closure_sha256:
        _error(
            errors,
            "manifest.layered_graph_constitution.closure_hash",
            expected=expected_closure_sha256,
            actual=artifact.get("closure_sha256"),
        )
    if sorted_violations or artifact.get("status") != "PASS":
        _error(
            errors,
            "manifest.layered_graph_constitution.status",
            status=artifact.get("status"),
            violations=sorted_violations,
        )

    manifest = manifest if isinstance(manifest, dict) else None
    statement_nodes: List[Dict[str, Any]] = []
    statement_by_key: Dict[tuple, Dict[str, Any]] = {}
    if manifest is not None:
        if artifact.get("case_id") != manifest.get("case_id"):
            _error(
                errors,
                "manifest.layered_graph_constitution.case_id_binding",
                expected=manifest.get("case_id"),
                actual=artifact.get("case_id"),
            )
        if artifact.get("case_sha256") != manifest.get("case_sha256"):
            _error(
                errors,
                "manifest.layered_graph_constitution.case_hash_binding",
                expected=manifest.get("case_sha256"),
                actual=artifact.get("case_sha256"),
            )
        statement_nodes = [
            node
            for node in manifest.get("nodes") or []
            if isinstance(node, dict) and node.get("node_kind") == "statement_row"
        ]
        statement_by_key = {
            (node.get("section"), node.get("row_id")): node
            for node in statement_nodes
        }
        actual_statement = _node_map(layer_by_id.get("statement") or {})
        expected_statement_ids = {
            _stable_layer_node_id(
                "statement", node.get("section"), node.get("row_id"), 0
            )
            for node in statement_nodes
        }
        if set(actual_statement) != expected_statement_ids:
            _error(
                errors,
                "manifest.layered_graph_constitution.statement_inventory",
                missing=_portable_sorted(expected_statement_ids - set(actual_statement)),
                unexpected=_portable_sorted(set(actual_statement) - expected_statement_ids),
            )
        for node in statement_nodes:
            identifier = _stable_layer_node_id(
                "statement", node.get("section"), node.get("row_id"), 0
            )
            actual = actual_statement.get(identifier) or {}
            # Evidence-only rows are reconstructed from a different source
            # object than rendered row-plan rows, so their source IDs are
            # already proved through the evidence layer rather than duplicated
            # here.
            source_ids = (
                actual.get("source_line_ids")
                if node.get("projection_status") != "rendered"
                else _portable_sorted(set(node.get("source_line_ids") or []))
            )
            expected_fields = {
                "section": node.get("section"),
                "row_id": node.get("row_id"),
                "semantic_role": node.get("semantic_role"),
                "row_type": node.get("row_type"),
                "source_line_ids": source_ids,
            }
            for field, expected in expected_fields.items():
                if actual.get(field) != expected:
                    _error(
                        errors,
                        "manifest.layered_graph_constitution.statement_binding",
                        stable_id=identifier,
                        field=field,
                        expected=expected,
                        actual=actual.get(field),
                    )

        expected_statement_edges: List[Dict[str, Any]] = []
        for node in statement_nodes:
            section = node.get("section")
            row_id = node.get("row_id")
            source_id = _stable_layer_node_id("statement", section, row_id, 0)
            for reference in node.get("dependencies") or []:
                target = statement_by_key.get((section, reference))
                if target is None:
                    global_targets = [
                        candidate
                        for candidate in statement_nodes
                        if candidate.get("row_id") == reference
                    ]
                    target = global_targets[0] if len(global_targets) == 1 else None
                if target is None:
                    continue
                target_section = target.get("section")
                expected_statement_edges.append(
                    {
                        "id": _stable_layer_node_id(
                            "edge",
                            "statement_dependency",
                            section,
                            row_id,
                            target_section,
                            reference,
                        ),
                        "type": (
                            "cross_section_dependency"
                            if target_section != section
                            else "depends_on"
                        ),
                        "from": source_id,
                        "to": _stable_layer_node_id(
                            "statement", target_section, reference, 0
                        ),
                    }
                )
            for edge_type, parent_field in (
                ("presentation_parent", "parent_row_id"),
                ("forecast_capture", "forecast_capture_parent_id"),
            ):
                parent_id = node.get(parent_field)
                if not parent_id:
                    continue
                expected_statement_edges.append(
                    {
                        "id": _stable_layer_node_id(
                            "edge", edge_type, section, row_id, parent_id
                        ),
                        "type": edge_type,
                        "from": source_id,
                        "to": _stable_layer_node_id(
                            "statement", section, parent_id, 0
                        ),
                    }
                )
        _compare_exact_inventory(
            errors,
            layer_id="statement",
            item_kind="edge",
            expected=expected_statement_edges,
            actual=(layer_by_id.get("statement") or {}).get("edges") or [],
        )

        expected_forecast_nodes: List[Dict[str, Any]] = []
        expected_forecast_edges: List[Dict[str, Any]] = []
        for node in statement_nodes:
            if node.get("row_type") == "header":
                continue
            for forecast_index, authority in enumerate(
                node.get("forecast_authorities") or []
            ):
                identifier = _stable_layer_node_id(
                    "forecast",
                    node.get("section"),
                    node.get("row_id"),
                    forecast_index,
                )
                writer = "%s:%s" % (
                    authority.get("mechanism"), authority.get("method")
                )
                expected_forecast_nodes.append(
                    {
                        "id": identifier,
                        "section": node.get("section"),
                        "row_id": node.get("row_id"),
                        "forecast_index": forecast_index,
                        "method": authority.get("method"),
                        "mechanism": authority.get("mechanism"),
                        "writer": writer,
                    }
                )
                expected_forecast_edges.append(
                    {
                        "id": _stable_layer_node_id(
                            "edge",
                            "forecast_writes",
                            node.get("section"),
                            node.get("row_id"),
                            forecast_index,
                        ),
                        "type": "writes_period",
                        "from": identifier,
                        "to": _stable_layer_node_id(
                            "statement",
                            node.get("section"),
                            node.get("row_id"),
                            0,
                        ),
                    }
                )
        _compare_exact_inventory(
            errors,
            layer_id="forecast",
            item_kind="node",
            expected=expected_forecast_nodes,
            actual=(layer_by_id.get("forecast") or {}).get("nodes") or [],
        )
        _compare_exact_inventory(
            errors,
            layer_id="forecast",
            item_kind="edge",
            expected=expected_forecast_edges,
            actual=(layer_by_id.get("forecast") or {}).get("edges") or [],
        )

        expected_evidence_nodes: List[Dict[str, Any]] = []
        expected_evidence_edges: List[Dict[str, Any]] = []
        occurrences: Dict[tuple, int] = {}
        for source in manifest.get("source_inventory") or []:
            section = source.get("section")
            source_line_id = source.get("source_line_id")
            key = (section, source_line_id)
            ordinal = occurrences.get(key, 0)
            occurrences[key] = ordinal + 1
            identifier = _stable_layer_node_id(
                "evidence", section, source_line_id, ordinal
            )
            expected_evidence_nodes.append(
                {
                    "id": identifier,
                    "section": section,
                    "source_line_id": source_line_id,
                    "material": source.get("material") is True,
                    "disposition": source.get("disposition"),
                    "writer": "sealed_source",
                }
            )
            for row_id in source.get("mapped_row_ids") or []:
                expected_evidence_edges.append(
                    {
                        "id": _stable_layer_node_id(
                            "edge",
                            "evidence_supplies",
                            section,
                            source_line_id,
                            ordinal,
                            row_id,
                        ),
                        "type": "supplies",
                        "from": identifier,
                        "to": _stable_layer_node_id(
                            "statement", section, row_id, 0
                        ),
                    }
                )
        _compare_exact_inventory(
            errors,
            layer_id="evidence",
            item_kind="node",
            expected=expected_evidence_nodes,
            actual=(layer_by_id.get("evidence") or {}).get("nodes") or [],
        )
        _compare_exact_inventory(
            errors,
            layer_id="evidence",
            item_kind="edge",
            expected=expected_evidence_edges,
            actual=(layer_by_id.get("evidence") or {}).get("edges") or [],
        )

    if row_plan is not None:
        projection = {
            "scope": _ROW_PLAN_PROJECTION_SCOPE,
            "statement_rows": row_plan.get("statement_rows") or {},
        }
        expected_row_plan_sha256 = _hash_value(projection)
        if artifact.get("row_plan_projection_scope") != _ROW_PLAN_PROJECTION_SCOPE:
            _error(
                errors,
                "manifest.layered_graph_constitution.row_plan_projection_scope",
                expected=_ROW_PLAN_PROJECTION_SCOPE,
                actual=artifact.get("row_plan_projection_scope"),
            )
        if artifact.get("row_plan_projection_sha256") != expected_row_plan_sha256:
            _error(
                errors,
                "manifest.layered_graph_constitution.row_plan_hash_binding",
                expected=expected_row_plan_sha256,
                actual=artifact.get("row_plan_projection_sha256"),
            )
        expected_projection_nodes: List[Dict[str, Any]] = []
        expected_projection_edges: List[Dict[str, Any]] = []
        for section in ("income_statement", "cash_flow"):
            for row in (row_plan.get("statement_rows") or {}).get(section) or []:
                identifier = _stable_layer_node_id(
                    "row_plan", section, row.get("row_id"), 0
                )
                expected_projection_nodes.append(
                    {
                        "id": identifier,
                        "section": section,
                        "row_id": row.get("row_id"),
                        "sheet": "Operating Model",
                        "physical_row": row.get("row"),
                        "writer": "row_plan",
                    }
                )
                expected_projection_edges.append(
                    {
                        "id": _stable_layer_node_id(
                            "edge", "projects", section, row.get("row_id"), 0
                        ),
                        "type": "projects",
                        "from": identifier,
                        "to": _stable_layer_node_id(
                            "statement", section, row.get("row_id"), 0
                        ),
                    }
                )
        _compare_exact_inventory(
            errors,
            layer_id="row_plan",
            item_kind="node",
            expected=expected_projection_nodes,
            actual=(layer_by_id.get("row_plan") or {}).get("nodes") or [],
        )
        _compare_exact_inventory(
            errors,
            layer_id="row_plan",
            item_kind="edge",
            expected=expected_projection_edges,
            actual=(layer_by_id.get("row_plan") or {}).get("edges") or [],
        )

    if equation_graph is not None:
        _ECONOMIC_IDENTITY_FIELDS = (
            "id",
            "equation_node_id",
            "role",
            "domain",
            "writer",
        )
        expected_economic_nodes = [
            {
                "id": _stable_layer_node_id("economic", node.get("id")),
                "equation_node_id": node.get("id"),
                "role": node.get("role"),
                "domain": node.get("domain"),
                "writer": "canonical_solver_equation",
            }
            for node in equation_graph.get("nodes") or []
        ]
        # The identity half of each node row stays an EXACT expectation derived
        # from the canonical equation graph: an invented node, a missing node, a
        # renamed role, a changed domain or a foreign writer are all still
        # caught.  Only the fields the asset cannot predict are moved to
        # `_validate_economic_statement_binding`, which checks every one of them
        # and rejects any field neither half accounts for — so nothing became
        # unchecked, and this comparison did not get weaker.
        actual_economic_nodes = (layer_by_id.get("economic") or {}).get("nodes") or []
        _compare_exact_inventory(
            errors,
            layer_id="economic",
            item_kind="node",
            expected=expected_economic_nodes,
            actual=[
                {
                    field: node.get(field)
                    for field in _ECONOMIC_IDENTITY_FIELDS
                    if field in node
                }
                for node in actual_economic_nodes
                if isinstance(node, dict)
            ],
        )
        expected_cross_layer_edges = _validate_economic_statement_binding(
            errors,
            economic_layer=layer_by_id.get("economic") or {},
            statement_layer=layer_by_id.get("statement") or {},
        )
        expected_economic_edges = [
            {
                "id": _stable_layer_node_id("edge", "economic", edge.get("id")),
                "type": edge.get("type"),
                "from": _stable_layer_node_id("economic", edge.get("from")),
                "to": _stable_layer_node_id("economic", edge.get("to")),
                "activation": edge.get("activation"),
            }
            for edge in equation_graph.get("edges") or []
        ] + expected_cross_layer_edges
        _compare_exact_inventory(
            errors,
            layer_id="economic",
            item_kind="edge",
            expected=expected_economic_edges,
            actual=(layer_by_id.get("economic") or {}).get("edges") or [],
        )
        # The layer artifact intentionally keeps graph domains separate. The
        # deployed Python proof closes the boundary independently through the
        # shared semantic role: one canonical economic writer -> one statement
        # meaning -> one physical projection when that statement is rendered.
        statement_by_role: Dict[Any, List[Dict[str, Any]]] = {}
        for node in (layer_by_id.get("statement") or {}).get("nodes") or []:
            role = node.get("semantic_role")
            if role:
                statement_by_role.setdefault(role, []).append(node)
        economic_by_role: Dict[Any, List[Dict[str, Any]]] = {}
        for node in (layer_by_id.get("economic") or {}).get("nodes") or []:
            role = node.get("role")
            if role:
                economic_by_role.setdefault(role, []).append(node)
        projected_statement_targets = {
            edge.get("to")
            for edge in (layer_by_id.get("row_plan") or {}).get("edges") or []
            if edge.get("type") == "projects"
        }
        overlapping_roles = _portable_sorted(
            set(statement_by_role) & set(economic_by_role)
        )
        if len(overlapping_roles) < 5:
            _error(
                errors,
                "manifest.layered_graph_constitution.economic_statement_binding_vacuous",
                roles=overlapping_roles,
            )
        for role in overlapping_roles:
            statement_claims = statement_by_role[role]
            economic_claims = economic_by_role[role]
            if len(statement_claims) != 1 or len(economic_claims) != 1:
                _error(
                    errors,
                    "manifest.layered_graph_constitution.economic_statement_writer_conflict",
                    semantic_role=role,
                    statement_claims=[item.get("id") for item in statement_claims],
                    economic_claims=[item.get("id") for item in economic_claims],
                )
                continue
            statement_claim = statement_claims[0]
            manifest_statement = statement_by_key.get(
                (statement_claim.get("section"), statement_claim.get("row_id"))
            )
            if (
                manifest_statement is not None
                and manifest_statement.get("projection_status") == "rendered"
                and statement_claim.get("id") not in projected_statement_targets
            ):
                _error(
                    errors,
                    "manifest.layered_graph_constitution.economic_statement_projection_missing",
                    semantic_role=role,
                    statement_id=statement_claim.get("id"),
                    economic_id=economic_claims[0].get("id"),
                )
    return errors


def build_native_evidence_bindings(
    *,
    case_id: Any,
    case_sha256: Any,
    workbook_bytes: bytes,
    semantic_manifest_bytes: bytes,
    row_map_bytes: bytes,
) -> Dict[str, Any]:
    return {
        "case_id": case_id,
        "case_sha256": case_sha256,
        "workbook_sha256": sha256(workbook_bytes),
        "semantic_manifest_sha256": sha256(semantic_manifest_bytes),
        "row_map_sha256": sha256(row_map_bytes),
    }


def parse_csv(text: Optional[str]) -> List[Dict[str, str]]:
    rows: List[List[str]] = []
    row: List[str] = []
    cell = ""
    quoted = False
    source = str(text or "")
    if source.startswith("﻿"):
        source = source[1:]
    index = 0
    length = len(source)
    while index < length:
        character = source[index]
        if quoted:
            if character == '"' and index + 1 < length and source[index + 1] == '"':
                cell += '"'
                index += 1
            elif character == '"':
                quoted = False
            else:
                cell += character
        elif character == '"':
            quoted = True
        elif character == ",":
            row.append(cell)
            cell = ""
        elif character == "\n":
            row.append(cell[:-1] if cell.endswith("\r") else cell)
            rows.append(row)
            row = []
            cell = ""
        else:
            cell += character
        index += 1
    if cell or row:
        row.append(cell[:-1] if cell.endswith("\r") else cell)
        rows.append(row)
    non_blank = [item for item in rows if any(value != "" for value in item)]
    if not non_blank:
        return []
    headers = non_blank[0]
    result = []
    for values in non_blank[1:]:
        result.append(
            {
                header: (values[position] if position < len(values) else "")
                for position, header in enumerate(headers)
            }
        )
    return result


def validate_fiscal_periods(model_case: Dict[str, Any]) -> List[Dict[str, Any]]:
    # Port of DEFECT 0.6 in lib/validation_invariants.mjs: a 52/53-week filer's
    # year end MOVES, so the literal MM-DD comparison only applies under the
    # fixed_date calendar. Under 52_53_week what must hold is one closing
    # weekday, 52/53 whole weeks between consecutive ends, and every end within
    # a week of the declared anchor.
    errors: List[Dict[str, Any]] = []
    fiscal_year_end = str((model_case.get("issuer") or {}).get("fiscal_year_end") or "")
    match = re.match(r"^(\d{2})-(\d{2})$", fiscal_year_end)
    if not match:
        return [
            {
                "id": "periods.invalid_fiscal_year_end",
                "message": "issuer.fiscal_year_end must use MM-DD.",
            }
        ]
    calendar = (model_case.get("issuer") or {}).get("fiscal_calendar") or "fixed_date"
    periods = model_case.get("periods") or []
    if calendar == "52_53_week":
        import datetime

        dates: List[Any] = []
        for index, period in enumerate(periods):
            try:
                dates.append(
                    datetime.date.fromisoformat(str(period.get("date") or ""))
                )
            except ValueError:
                errors.append(
                    {
                        "id": "periods.invalid_period_date",
                        "period_index": index,
                        "period_date": period.get("date"),
                    }
                )
        if errors:
            return errors
        weekdays = {date.weekday() for date in dates}
        if len(weekdays) > 1:
            errors.append(
                {
                    "id": "periods.52_53_week_weekday_drift",
                    "message": (
                        "A 52/53-week filer closes on ONE weekday. "
                        "These period ends fall on more than one."
                    ),
                    "weekdays": sorted(weekdays),
                    "period_dates": [str(period.get("date")) for period in periods],
                }
            )
        for index in range(1, len(dates)):
            span_days = (dates[index] - dates[index - 1]).days
            weeks = span_days / 7
            if span_days % 7 != 0 or weeks not in (52, 53):
                errors.append(
                    {
                        "id": "periods.52_53_week_span",
                        "period_index": index,
                        "period_date": periods[index].get("date"),
                        "previous_period_date": periods[index - 1].get("date"),
                        "weeks": weeks,
                    }
                )
        anchor_month = int(match.group(1))
        anchor_day = int(match.group(2))
        for index, date in enumerate(dates):
            candidates = []
            for year in (date.year - 1, date.year, date.year + 1):
                try:
                    candidates.append(datetime.date(year, anchor_month, anchor_day))
                except ValueError:
                    continue
            nearest = min(candidates, key=lambda c: abs((c - date).days))
            if abs((nearest - date).days) > 7:
                errors.append(
                    {
                        "id": "periods.52_53_week_anchor_drift",
                        "period_index": index,
                        "period_date": periods[index].get("date"),
                        "anchor_month_day": "%s-%s" % (match.group(1), match.group(2)),
                        "message": (
                            "A 52/53-week year end is the chosen weekday NEAREST "
                            "the anchor, so it cannot sit more than a week away "
                            "from it."
                        ),
                    }
                )
        return errors
    expected = "%s-%s" % (match.group(1), match.group(2))
    for index, period in enumerate(periods):
        if str(period.get("date") or "")[5:] != expected:
            errors.append(
                {
                    "id": "periods.fiscal_year_end_mismatch",
                    "period_index": index,
                    "period_date": period.get("date"),
                    "expected_month_day": expected,
                }
            )
    return errors


def validate_semantic_artifacts(
    manifest,
    crosswalk_rows,
    *,
    row_plan=None,
    equation_graph=None,
) -> List[Dict[str, Any]]:
    errors: List[Dict[str, Any]] = []
    manifest = manifest or {}
    nodes = manifest.get("nodes") or []
    edges = manifest.get("edges") or []
    sources = manifest.get("source_inventory") or []
    full_semantic_manifest = any(
        node.get("node_kind") == "statement_row" for node in nodes
    ) or bool(sources)
    constitution = manifest.get("layered_graph_constitution")
    if full_semantic_manifest and not constitution:
        errors.append(
            {
                "id": "manifest.layered_graph_constitution_missing",
                "message": "A full semantic manifest requires the sealed five-layer graph constitution.",
            }
        )
    elif constitution:
        errors.extend(
            validate_layered_graph_constitution(
                constitution,
                manifest=manifest,
                row_plan=row_plan,
                equation_graph=equation_graph,
            )
        )
    instrument_period_state = manifest.get("instrument_period_state")
    if int(manifest.get("contract_version") or 0) == 2 and not instrument_period_state:
        errors.append(
            {
                "id": "manifest.instrument_period_state_missing",
                "message": "A v2 semantic manifest requires the compiled instrument-period state.",
            }
        )
    if instrument_period_state:
        states = instrument_period_state.get("states") or []
        forecast_period_ids = [
            period.get("date")
            for period in manifest.get("periods") or []
            if period.get("status") == "forecast"
        ]
        if instrument_period_state.get("schema_version") != "instrument-period-state/1.0":
            errors.append(
                {
                    "id": "manifest.instrument_period_state_invalid",
                    "message": "schema_version must be instrument-period-state/1.0.",
                }
            )
        if instrument_period_state.get("forecast_period_ids") != forecast_period_ids:
            errors.append(
                {
                    "id": "manifest.instrument_period_state_periods",
                    "expected": forecast_period_ids,
                    "actual": instrument_period_state.get("forecast_period_ids"),
                }
            )
        if manifest.get("definition_basis_graph") != instrument_period_state.get("definition_basis_graph"):
            errors.append(
                {
                    "id": "manifest.definition_basis_graph_binding",
                    "message": "The semantic definition-basis graph must be the graph carried by instrument-period state.",
                }
            )
        state_by_id = {}
        periods_by_instrument = {}
        for state in states:
            state_id = state.get("state_id")
            if not state_id or state_id in state_by_id:
                errors.append(
                    {
                        "id": "manifest.instrument_period_state_invalid",
                        "message": "Instrument-period state IDs must be present and unique.",
                        "state_id": state_id,
                    }
                )
            state_by_id[state_id] = state
            periods_by_instrument.setdefault(state.get("instrument_id"), []).append(
                state.get("period_index")
            )
            if (
                state.get("class") == "rcf"
                and (state.get("inclusion") or {}).get("liquidity") is True
                and (
                state.get("repayment_state") != "discretionary_rcf"
                or (state.get("inclusion") or {}).get("mandatory_repayment") is not False
                or abs(float((state.get("maturity_repayment") or {}).get("basis_amount") or 0)) > 1e-9
                )
            ):
                errors.append(
                    {
                        "id": "manifest.instrument_period_state_invalid",
                        "message": "RCF entered the mandatory repayment pool.",
                        "state_id": state_id,
                    }
                )
            if (
                state.get("class") == "rcf"
                and (state.get("inclusion") or {}).get("liquidity") is not True
                and state.get("repayment_state") == "discretionary_rcf"
            ):
                errors.append(
                    {
                        "id": "manifest.instrument_period_state_invalid",
                        "message": "An ordinary revolver was treated as the balancing facility.",
                        "state_id": state_id,
                    }
                )
            if state.get("balance_basis") == "reporting_currency_carrying_value":
                translation = state.get("translation") or {}
                if (
                    translation.get("method") != "reporting_currency_carrying_value_no_translation"
                    or any(abs(float(translation.get(key) or 0) - 1) > 1e-9 for key in ("opening_rate", "flow_rate", "closing_rate"))
                ):
                    errors.append(
                        {
                            "id": "manifest.instrument_period_state_invalid",
                            "message": "Reporting-currency carrying value is exposed to double FX translation.",
                            "state_id": state_id,
                        }
                    )
        for instrument_id, period_indexes in periods_by_instrument.items():
            if sorted(period_indexes) != [0, 1, 2]:
                errors.append(
                    {
                        "id": "manifest.instrument_period_state_invalid",
                        "message": "Each instrument requires exactly one state per forecast period.",
                        "instrument_id": instrument_id,
                    }
                )
        for node in [item for item in nodes if item.get("node_kind") == "debt_instrument"]:
            expected_states = sorted(
                [state for state in states if state.get("instrument_id") == node.get("instrument_id")],
                key=lambda state: state.get("period_index"),
            )
            expected_ids = [state.get("state_id") for state in expected_states]
            if node.get("instrument_period_state_ids") != expected_ids:
                errors.append(
                    {
                        "id": "manifest.instrument_period_state_node_binding",
                        "node_id": node.get("node_id"),
                        "expected": expected_ids,
                        "actual": node.get("instrument_period_state_ids") or [],
                    }
                )
            for index, state_id in enumerate(node.get("instrument_period_state_ids") or []):
                state = state_by_id.get(state_id)
                memberships = node.get("instrument_period_membership") or []
                membership = memberships[index] if index < len(memberships) else None
                if not state or membership != state.get("inclusion"):
                    errors.append(
                        {
                            "id": "manifest.instrument_period_membership_binding",
                            "node_id": node.get("node_id"),
                            "state_id": state_id,
                        }
                    )
    node_ids = set()
    semantic_ids = set()
    for node in nodes:
        node_id = node.get("node_id")
        if not node_id or node_id in node_ids:
            errors.append(
                {
                    "id": "manifest.node_id",
                    "node_id": node_id,
                    "message": "Manifest node IDs must be present and unique.",
                }
            )
        node_ids.add(node_id)
        if node.get("node_kind") == "statement_row":
            semantic_id = node.get("semantic_id")
            if not semantic_id or semantic_id in semantic_ids:
                errors.append(
                    {
                        "id": "manifest.semantic_id",
                        "node_id": node_id,
                        "semantic_id": semantic_id,
                        "message": "Statement semantic IDs must be present and unique.",
                    }
                )
            semantic_ids.add(semantic_id)
            if (
                node.get("row_type") in ("calculation", "subtotal")
                and node.get("formula_authority") == "declared_dependency"
                and len(node.get("dependencies") or []) == 0
            ):
                errors.append(
                    {
                        "id": "manifest.calculation_dependencies",
                        "node_id": node_id,
                        "message": "Declared calculation nodes require semantic dependencies.",
                    }
                )
            if node.get("row_type") != "header":
                authorities = node.get("forecast_authorities")
                if not isinstance(authorities, list) or len(authorities) != 3:
                    errors.append(
                        {
                            "id": "manifest.forecast_authorities",
                            "node_id": node_id,
                            "message": "Every non-header statement node requires three period forecast authorities.",
                        }
                    )
                else:
                    for forecast_index, authority in enumerate(authorities):
                        mechanism = authority.get("mechanism") if isinstance(authority, dict) else None
                        method = authority.get("method") if isinstance(authority, dict) else None
                        expected_mechanism = {
                            "schedule_link": "formula",
                            "accounting_identity": "formula",
                            "driver_formula": "formula",
                            "roll_forward": "formula",
                            "broker_consensus": "broker",
                            "actual_plus_remainder": "hardcode",
                            "contractual_commitment": "hardcode",
                            "company_guidance": "hardcode",
                            "company_indication": "hardcode",
                            "user_assumption": "hardcode",
                            "seasonal_run_rate": "hardcode",
                            # These three are visible, auditable formula
                            # methods.  The source values remain historical
                            # hardcodes, but the forecast writer is a formula.
                            "historical_average": "formula",
                            "historical_trend": "formula",
                            "carry_forward": "formula",
                            "explicit_zero": "zero",
                            "not_separately_forecast": "uncalculated",
                            "not_applicable": "uncalculated",
                        }.get(method)
                        if (
                            not isinstance(authority, dict)
                            or authority.get("forecast_index") != forecast_index
                            or not authority.get("method")
                            or mechanism not in ("formula", "broker", "hardcode", "zero", "uncalculated")
                        ):
                            errors.append(
                                {
                                    "id": "manifest.forecast_authority_shape",
                                    "node_id": node_id,
                                    "forecast_index": forecast_index,
                                    "authority": authority,
                                }
                            )
                        if expected_mechanism and mechanism != expected_mechanism:
                            errors.append(
                                {
                                    "id": "manifest.forecast_authority_mechanism",
                                    "node_id": node_id,
                                    "forecast_index": forecast_index,
                                    "method": method,
                                    "expected_mechanism": expected_mechanism,
                                    "actual_mechanism": mechanism,
                                }
                            )
                        if isinstance(authority, dict) and method == "unresolved":
                            errors.append(
                                {
                                    "id": "manifest.forecast_authority_unresolved",
                                    "node_id": node_id,
                                    "forecast_index": forecast_index,
                                }
                            )
                        if (
                            isinstance(authority, dict)
                            and authority.get("inferred") is not True
                            and method
                            in (
                                "actual_plus_remainder",
                                "contractual_commitment",
                                "company_guidance",
                                "company_indication",
                            )
                            and (not authority.get("source_id") or not authority.get("as_of_date"))
                        ):
                            errors.append(
                                {
                                    "id": "manifest.forecast_authority_provenance",
                                    "node_id": node_id,
                                    "forecast_index": forecast_index,
                                }
                            )
                        if isinstance(authority, dict) and method == "actual_plus_remainder":
                            partial = authority.get("partial_period") or {}
                            try:
                                reported = float(partial.get("reported_to_date"))
                                remainder = float(partial.get("forecast_remainder"))
                                value = float(authority.get("value"))
                                partial_valid = (
                                    bool(partial.get("reported_through"))
                                    and abs(value - (reported + remainder)) <= 1e-9
                                )
                            except (TypeError, ValueError):
                                partial_valid = False
                            if not partial_valid:
                                errors.append(
                                    {
                                        "id": "manifest.forecast_authority_partial_period",
                                        "node_id": node_id,
                                        "forecast_index": forecast_index,
                                    }
                                )
                        if (
                            isinstance(authority, dict)
                            and method in ("explicit_zero", "not_separately_forecast", "not_applicable")
                            and authority.get("inferred") is not True
                            and not authority.get("note")
                        ):
                            errors.append(
                                {
                                    "id": "manifest.forecast_authority_rationale",
                                    "node_id": node_id,
                                    "forecast_index": forecast_index,
                                    }
                                )
                        if (
                            isinstance(authority, dict)
                            and (
                                node.get("row_type") == "uncalculated"
                                or node.get("formula_authority") == "intentionally_blank"
                            )
                            and mechanism != "uncalculated"
                        ):
                            errors.append(
                                {
                                    "id": "manifest.structural_absence_conflict",
                                    "node_id": node_id,
                                    "forecast_index": forecast_index,
                                    "formula_authority": node.get("formula_authority"),
                                    "row_type": node.get("row_type"),
                                    "actual_mechanism": mechanism,
                                    "message": "A structurally absent forecast row cannot retain a live or zero period authority.",
                                }
                            )
            if (
                node.get("forecast_capture_parent_id")
                and node.get("forecast_capture_parent_id") == node.get("row_id")
            ):
                errors.append(
                    {
                        "id": "manifest.forecast_capture_self_reference",
                        "node_id": node_id,
                    }
                )
        if (
            node.get("movement_type") == "non_cash_debt_movement"
            and node.get("waterfall_stage") != "excluded"
        ):
            errors.append(
                {
                    "id": "manifest.non_cash_debt_in_waterfall",
                    "node_id": node_id,
                    "waterfall_stage": node.get("waterfall_stage"),
                }
            )
        if (
            node.get("movement_type") in ("rcf_draw", "rcf_repayment")
            and node.get("waterfall_stage") != "rcf_balance"
        ):
            errors.append(
                {
                    "id": "manifest.rcf_stage",
                    "node_id": node_id,
                    "waterfall_stage": node.get("waterfall_stage"),
                }
            )
    for edge in [item for item in edges if item.get("edge_type") == "depends_on"]:
        if edge.get("from") not in node_ids or edge.get("to") not in node_ids:
            errors.append(
                {
                    "id": "manifest.unresolved_dependency",
                    "from": edge.get("from"),
                    "to": edge.get("to"),
                }
            )
    source_ids = set()
    crosswalk_by_source: Dict[Any, List[Dict[str, str]]] = {}
    for row in crosswalk_rows or []:
        crosswalk_by_source.setdefault(row.get("source_line_id"), []).append(row)
        if row.get("mapping_method") not in APPROVED_MAPPING_METHODS:
            errors.append(
                {
                    "id": "crosswalk.mapping_method",
                    "source_line_id": row.get("source_line_id"),
                    "mapping_method": row.get("mapping_method"),
                }
            )
    for source in sources:
        source_line_id = source.get("source_line_id")
        if not source_line_id or source_line_id in source_ids:
            errors.append(
                {"id": "manifest.source_id", "source_line_id": source_line_id}
            )
        source_ids.add(source_line_id)
        rows = crosswalk_by_source.get(source_line_id, [])
        resolved = any(row.get("mapping_status") == "resolved" for row in rows)
        documented_exclusion = any(
            row.get("mapping_status") == "documented_exclusion"
            and row.get("mapping_method") == "not_applicable"
            and len(str(row.get("reason") or "").strip()) > 0
            for row in rows
        )
        if source.get("material") and not resolved and not documented_exclusion:
            errors.append(
                {
                    "id": "crosswalk.orphan_material_source",
                    "source_line_id": source_line_id,
                }
            )
        for destination in source.get("mapped_row_ids") or []:
            if not any(
                row.get("destination_row_id") == destination
                and row.get("mapping_status") == "resolved"
                for row in rows
            ):
                errors.append(
                    {
                        "id": "crosswalk.missing_destination",
                        "source_line_id": source_line_id,
                        "destination_row_id": destination,
                    }
                )
    for source_line_id in crosswalk_by_source:
        if source_line_id not in source_ids:
            errors.append(
                {"id": "crosswalk.unknown_source", "source_line_id": source_line_id}
            )
    return errors


_RATE_LITERAL = re.compile(
    r"(?:\*|/|\+|-)\s*\(?\s*(-?(?:\d+(?:\.\d+)?|\.\d+))(?![A-Za-z0-9_])"
)
_MECHANICAL_CONSTANTS = {0.0, 1.0, 2.0, 12.0, 360.0, 365.0, 10000.0}


def embedded_rate_literals(formula) -> List[Dict[str, Any]]:
    text = str(formula or "")
    if text.startswith("="):
        text = text[1:]
    matches = []
    for match in _RATE_LITERAL.finditer(text):
        value = float(match.group(1))
        if abs(value) not in _MECHANICAL_CONSTANTS:
            matches.append({"literal": match.group(1), "index": match.start()})
    return matches


_NATIVE_SCHEMA = "native-excel-restoration-evidence/3.2"
_NATIVE_SEQUENCE = [1, 0, 1, 0, 1]
_NATIVE_TOLERANCE_POLICY = {
    "currency_abs": 1e-6,
    "ratio_abs": 1e-9,
    "percentage_abs": 1e-10,
    "control_abs": 0,
    "default_abs": 1e-9,
    "relative": 1e-12,
}
_NATIVE_DRIFT_CLASSES = ("currency", "ratio", "percentage", "control", "default")
_NATIVE_PROFILE_TESTS = {
    "acquisition": {
        "native-excel-circularity-restoration-acquisition-case": "circularity",
        "native-excel-acquisition-restoration": "acquisition",
    },
    "stressed_liquidity": {
        "native-excel-circularity-restoration-stressed-case": "circularity",
        "native-excel-maturity-restoration": "debt_maturities_roll",
    },
}
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SAFE_STATE_PATH = re.compile(r"^[^/\\]+(?:/[^/\\]+)*$")


def _native_error(errors: List[Dict[str, Any]], identifier: str, **details: Any) -> None:
    errors.append({"id": identifier, **details})


def _valid_hash(value: Any) -> bool:
    return bool(_SHA256.fullmatch(str(value or "")))


def _safe_state_path(value: Any) -> bool:
    text = str(value or "")
    return bool(
        text
        and _SAFE_STATE_PATH.fullmatch(text)
        and not text.startswith("/")
        and all(part not in ("", ".", "..") for part in text.split("/"))
    )


def _exact_int_list(value: Any, expected: List[int]) -> bool:
    return isinstance(value, list) and len(value) == len(expected) and all(
        type(actual) is int and actual == wanted
        for actual, wanted in zip(value, expected)
    )


def _valid_native_drift(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    for channel in ("max_abs_by_class", "max_rel_by_class"):
        classes = value.get(channel)
        if not isinstance(classes, dict):
            return False
        for name in _NATIVE_DRIFT_CLASSES:
            number = classes.get(name)
            if not isinstance(number, (int, float)) or isinstance(number, bool) or number < 0:
                return False
    return True


def validate_native_evidence(evidence, expected) -> List[Dict[str, Any]]:
    """Validate aggregate, hash-bound native-Excel evidence.

    This is intentionally fail-closed.  A PASS label or top-level workbook hash
    is not evidence: both required candidates, all four tests, every repeated
    state, non-vacuous effects, restoration counts and candidate binding must
    be present and internally coherent.
    """

    errors: List[Dict[str, Any]] = []
    evidence = evidence if isinstance(evidence, dict) else {}
    expected = expected if isinstance(expected, dict) else {}

    if evidence.get("schema_version") != _NATIVE_SCHEMA:
        _native_error(
            errors,
            "native.schema_version",
            expected=_NATIVE_SCHEMA,
            actual=evidence.get("schema_version"),
        )
    if evidence.get("status") != "PASS":
        _native_error(errors, "native.status", message="Native evidence must be PASS.")
    if evidence.get("diagnostic_only") is not False:
        _native_error(errors, "native.diagnostic_only")
    if evidence.get("application") not in (
        "Microsoft Excel for Mac",
        "Microsoft Excel for Windows",
    ):
        _native_error(errors, "native.application", actual=evidence.get("application"))
    if not str(evidence.get("method") or "").strip():
        _native_error(errors, "native.method")
    if not re.match(
        r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$",
        str(evidence.get("generated_at") or ""),
    ):
        _native_error(errors, "native.generated_at", actual=evidence.get("generated_at"))
    if type(evidence.get("total_violations")) is not int or evidence.get("total_violations") != 0:
        _native_error(
            errors,
            "native.total_violations",
            actual=evidence.get("total_violations"),
        )
    if not _valid_hash(evidence.get("certified_closure_sha256")):
        _native_error(
            errors,
            "native.certified_closure_sha256",
            actual=evidence.get("certified_closure_sha256"),
        )
    if evidence.get("tolerance_policy") != _NATIVE_TOLERANCE_POLICY:
        _native_error(
            errors,
            "native.tolerance_policy",
            expected=_NATIVE_TOLERANCE_POLICY,
            actual=evidence.get("tolerance_policy"),
        )

    evidence_hash = evidence.get("evidence_sha256")
    hash_body = dict(evidence)
    hash_body.pop("evidence_sha256", None)
    calculated_hash = sha256(canonical_json(hash_body))
    if not _valid_hash(evidence_hash) or evidence_hash != calculated_hash:
        _native_error(
            errors,
            "native.evidence_sha256",
            expected=calculated_hash,
            actual=evidence_hash,
        )

    required_ids = [
        test_id
        for tests in _NATIVE_PROFILE_TESTS.values()
        for test_id in tests
    ]
    matrix = evidence.get("release_matrix")
    if not isinstance(matrix, dict):
        _native_error(errors, "native.release_matrix")
        matrix = {}
    if matrix.get("status") != "PASS":
        _native_error(errors, "native.release_matrix.status")
    if matrix.get("required_test_ids") != required_ids:
        _native_error(
            errors,
            "native.release_matrix.required_test_ids",
            expected=required_ids,
            actual=matrix.get("required_test_ids"),
        )
    if matrix.get("candidate_profiles") != list(_NATIVE_PROFILE_TESTS):
        _native_error(
            errors,
            "native.release_matrix.candidate_profiles",
            expected=list(_NATIVE_PROFILE_TESTS),
            actual=matrix.get("candidate_profiles"),
        )

    candidates = evidence.get("candidates")
    if not isinstance(candidates, list):
        _native_error(errors, "native.candidates")
        candidates = []
    profiles = [candidate.get("profile") for candidate in candidates if isinstance(candidate, dict)]
    if len(candidates) != 2 or profiles != list(_NATIVE_PROFILE_TESTS) or len(set(profiles)) != len(profiles):
        _native_error(
            errors,
            "native.candidate_profiles",
            expected=list(_NATIVE_PROFILE_TESTS),
            actual=profiles,
        )

    all_test_ids: List[Any] = []
    matching_candidates = []
    binding_keys = (
        "case_id",
        "case_sha256",
        "workbook_sha256",
        "semantic_manifest_sha256",
        "row_map_sha256",
    )
    for candidate_index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            _native_error(errors, "native.candidate", candidate_index=candidate_index)
            continue
        profile = candidate.get("profile")
        prefix = "native.candidate.%s" % (profile or candidate_index)
        profile_tests = _NATIVE_PROFILE_TESTS.get(profile)
        if profile_tests is None:
            _native_error(errors, "%s.profile" % prefix, actual=profile)
            profile_tests = {}

        for key in binding_keys:
            value = candidate.get(key)
            valid = bool(str(value or "").strip()) if key == "case_id" else _valid_hash(value)
            if not valid:
                _native_error(errors, "%s.%s" % (prefix, key), actual=value)

        snapshot_record = candidate.get("candidate_snapshot")
        if not isinstance(snapshot_record, dict):
            _native_error(errors, "%s.candidate_snapshot" % prefix)
            snapshot_record = {}
        if not isinstance(snapshot_record.get("sheet_names"), list) or not snapshot_record.get("sheet_names"):
            _native_error(errors, "%s.candidate_snapshot.sheet_names" % prefix)
        if not isinstance(snapshot_record.get("calculation_settings"), dict):
            _native_error(errors, "%s.candidate_snapshot.calculation_settings" % prefix)
        for signature in ("formula_signature", "numeric_signature", "structure_signature"):
            if not _valid_hash(snapshot_record.get(signature)):
                _native_error(errors, "%s.candidate_snapshot.%s" % (prefix, signature))

        tests = candidate.get("tests")
        if not isinstance(tests, list):
            _native_error(errors, "%s.tests" % prefix)
            tests = []
        test_ids = [test.get("id") for test in tests if isinstance(test, dict)]
        all_test_ids.extend(test_ids)
        if len(tests) != len(profile_tests) or test_ids != list(profile_tests):
            _native_error(
                errors,
                "%s.test_ids" % prefix,
                expected=list(profile_tests),
                actual=test_ids,
            )

        for test_index, test in enumerate(tests):
            if not isinstance(test, dict):
                _native_error(errors, "%s.test" % prefix, test_index=test_index)
                continue
            test_id = test.get("id")
            test_prefix = "%s.test.%s" % (prefix, test_id or test_index)
            expected_control = profile_tests.get(test_id)
            if expected_control is None:
                _native_error(errors, "%s.id" % test_prefix, actual=test_id)
            if test.get("control_id") != expected_control:
                _native_error(
                    errors,
                    "%s.control_id" % test_prefix,
                    expected=expected_control,
                    actual=test.get("control_id"),
                )
            if test.get("status") != "PASS":
                _native_error(errors, "%s.status" % test_prefix)
            if test.get("failures") != []:
                _native_error(errors, "%s.failures" % test_prefix, actual=test.get("failures"))
            if not _exact_int_list(test.get("expected_sequence"), _NATIVE_SEQUENCE):
                _native_error(errors, "%s.expected_sequence" % test_prefix)
            if not _exact_int_list(test.get("actual_sequence"), _NATIVE_SEQUENCE):
                _native_error(errors, "%s.actual_sequence" % test_prefix)
            if not str(test.get("control_cell") or "").startswith("Operating Model!"):
                _native_error(errors, "%s.control_cell" % test_prefix)
            if test.get("tolerance_policy") != _NATIVE_TOLERANCE_POLICY:
                _native_error(errors, "%s.tolerance_policy" % test_prefix)
            if not _valid_native_drift(test.get("max_observed_drift")):
                _native_error(errors, "%s.max_observed_drift" % test_prefix)

            files = test.get("files")
            if not isinstance(files, list) or len(files) != 5:
                _native_error(errors, "%s.files" % test_prefix)
                files = []
            paths = []
            hashes = []
            for state_index, state in enumerate(files):
                if not isinstance(state, dict):
                    _native_error(errors, "%s.file" % test_prefix, state_index=state_index)
                    continue
                state_path = state.get("path")
                state_hash = state.get("sha256")
                paths.append(state_path)
                hashes.append(state_hash)
                if not _safe_state_path(state_path):
                    _native_error(errors, "%s.file.path" % test_prefix, actual=state_path)
                if not _valid_hash(state_hash):
                    _native_error(errors, "%s.file.sha256" % test_prefix, actual=state_hash)
                for field in ("worksheets_scanned", "used_cells_scanned"):
                    if type(state.get(field)) is not int or state.get(field) <= 0:
                        _native_error(
                            errors,
                            "%s.file.%s" % (test_prefix, field),
                            state_index=state_index,
                            actual=state.get(field),
                        )
                if state.get("excel_error_count") != 0:
                    _native_error(
                        errors,
                        "%s.file.excel_error_count" % test_prefix,
                        state_index=state_index,
                        actual=state.get("excel_error_count"),
                    )
                if state.get("excel_error_cells") != []:
                    _native_error(
                        errors,
                        "%s.file.excel_error_cells" % test_prefix,
                        state_index=state_index,
                        actual=state.get("excel_error_cells"),
                    )
            if len(paths) != len(set(paths)):
                _native_error(errors, "%s.file.duplicate_path" % test_prefix)
            if len(set(hashes)) < 2:
                _native_error(errors, "%s.file.insufficient_distinct_sha256" % test_prefix)

            for field in ("formula_cells_compared", "numeric_cells_compared"):
                if type(test.get(field)) is not int or test.get(field) <= 0:
                    _native_error(errors, "%s.%s" % (test_prefix, field), actual=test.get(field))
            for field, expected_counts in (
                ("on_restoration_difference_counts", [0, 0]),
                ("off_restoration_difference_counts", [0]),
            ):
                if not _exact_int_list(test.get(field), expected_counts):
                    _native_error(errors, "%s.%s" % (test_prefix, field), actual=test.get(field))
            for field in ("declared_effect_cells_present", "declared_effect_cells_changed"):
                if type(test.get(field)) is not int or test.get(field) <= 0:
                    _native_error(errors, "%s.%s" % (test_prefix, field), actual=test.get(field))
            declared_effects = test.get("declared_effect_cells")
            effects_present = test.get("declared_effect_cells_present")
            effects_changed = test.get("declared_effect_cells_changed")
            if (
                type(declared_effects) is not int
                or declared_effects <= 0
                or type(effects_present) is not int
                or type(effects_changed) is not int
                or not (0 < effects_changed <= effects_present <= declared_effects)
            ):
                _native_error(errors, "%s.declared_effect_count_consistency" % test_prefix)
            if type(test.get("on_off_difference_count_excluding_control")) is not int or test.get("on_off_difference_count_excluding_control") <= 0:
                _native_error(errors, "%s.on_off_difference_count_excluding_control" % test_prefix)
            elif type(effects_changed) is int and test.get("on_off_difference_count_excluding_control") < effects_changed:
                _native_error(errors, "%s.on_off_difference_count_consistency" % test_prefix)

            if expected_control in ("circularity", "acquisition"):
                if type(test.get("declared_kill_switch_cells")) is not int or test.get("declared_kill_switch_cells") <= 0:
                    _native_error(errors, "%s.declared_kill_switch_cells" % test_prefix)
                if type(test.get("declared_kill_switch_nonzero_on")) is not int or test.get("declared_kill_switch_nonzero_on") <= 0:
                    _native_error(errors, "%s.declared_kill_switch_nonzero_on" % test_prefix)
                elif test.get("declared_kill_switch_nonzero_on") > test.get("declared_kill_switch_cells"):
                    _native_error(errors, "%s.declared_kill_switch_count_consistency" % test_prefix)
            if test.get("declared_kill_switch_bad_off") != 0:
                _native_error(errors, "%s.declared_kill_switch_bad_off" % test_prefix)

            binding = test.get("candidate_binding")
            if not isinstance(binding, dict):
                _native_error(errors, "%s.candidate_binding" % test_prefix)
                binding = {}
            if binding.get("status") != "PASS" or binding.get("failures") != []:
                _native_error(errors, "%s.candidate_binding.status" % test_prefix)
            for field in (
                "formula_signature_match",
                "structure_signature_match",
                "sheet_order_match",
                "calculation_settings_match",
            ):
                if binding.get(field) is not True:
                    _native_error(errors, "%s.candidate_binding.%s" % (test_prefix, field))
            if binding.get("numeric_difference_count") != 0:
                _native_error(errors, "%s.candidate_binding.numeric_difference_count" % test_prefix)
            if not _valid_native_drift(binding.get("max_observed_drift")):
                _native_error(errors, "%s.candidate_binding.max_observed_drift" % test_prefix)
            if binding.get("candidate_control_value") != 1 or binding.get("state_1_control_value") != 1:
                _native_error(errors, "%s.candidate_binding.control_values" % test_prefix)
            if binding.get("candidate_workbook_sha256") != candidate.get("workbook_sha256"):
                _native_error(errors, "%s.candidate_binding.workbook_sha256" % test_prefix)
            for binding_field, snapshot_field in (
                ("candidate_formula_signature", "formula_signature"),
                ("candidate_structure_signature", "structure_signature"),
            ):
                if (
                    not _valid_hash(binding.get(binding_field))
                    or binding.get(binding_field) != snapshot_record.get(snapshot_field)
                ):
                    _native_error(
                        errors,
                        "%s.candidate_binding.%s" % (test_prefix, binding_field),
                    )
            for binding_field in (
                "state_1_formula_signature",
                "state_1_structure_signature",
            ):
                if not _valid_hash(binding.get(binding_field)):
                    _native_error(
                        errors,
                        "%s.candidate_binding.%s" % (test_prefix, binding_field),
                    )
            if binding.get("state_1_formula_signature") != binding.get("candidate_formula_signature"):
                _native_error(errors, "%s.candidate_binding.formula_signature_consistency" % test_prefix)
            if binding.get("state_1_structure_signature") != binding.get("candidate_structure_signature"):
                _native_error(errors, "%s.candidate_binding.structure_signature_consistency" % test_prefix)
            state_one_hash = files[0].get("sha256") if files and isinstance(files[0], dict) else None
            if binding.get("state_1_sha256") != state_one_hash:
                _native_error(errors, "%s.candidate_binding.state_1_sha256" % test_prefix)

        if all(
            expected.get(key) and candidate.get(key) == expected.get(key)
            for key in binding_keys
        ):
            matching_candidates.append(candidate)

    actual_ids = matrix.get("actual_test_ids")
    if actual_ids != all_test_ids or all_test_ids != required_ids or len(set(all_test_ids)) != len(all_test_ids):
        _native_error(
            errors,
            "native.release_matrix.actual_test_ids",
            expected=required_ids,
            actual=actual_ids,
            candidate_tests=all_test_ids,
        )

    missing_expected = [key for key in binding_keys if not expected.get(key)]
    if missing_expected:
        _native_error(errors, "native.expected_bindings", missing=missing_expected)
    if len(matching_candidates) != 1:
        _native_error(
            errors,
            "native.binding.candidate",
            expected={key: expected.get(key) for key in binding_keys},
            matches=len(matching_candidates),
        )
    return errors
