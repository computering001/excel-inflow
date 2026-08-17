#!/usr/bin/env node

import assert from "node:assert/strict";

import { ECONOMIC_SOLVE_POLICY } from "./lib/economic_solve_policy.mjs";
import {
  CONVERGENCE_CONTRACT,
  EQUATION_GRAPH,
  activeEquationEdges,
  canonicalJsonSha256,
  compileEquationGraphState,
  compileSolverEquationGraphEvidence,
  deriveStronglyConnectedComponents,
  validateEquationGraph,
  validateSolverEquationGraphEvidence,
  validateSolverIterationDeclaration,
} from "./lib/equation_graph.mjs";
import { solverIterationDeclaration } from "./lib/solver.mjs";

function clone(value) {
  return structuredClone(value);
}

function mutation(name, mutate, expectedFragment) {
  const graph = clone(EQUATION_GRAPH);
  const contract = clone(CONVERGENCE_CONTRACT);
  mutate(graph, contract);
  const errors = validateEquationGraph(graph, contract);
  assert.ok(
    errors.some((error) => error.includes(expectedFragment)),
    `${name} should fail with ${expectedFragment}; got ${errors.join(" | ")}`,
  );
  return { name, status: "PASS", total_violations: errors.length };
}

function policyMutation(name, mutate, expectedFragment) {
  const graph = clone(EQUATION_GRAPH);
  const contract = clone(CONVERGENCE_CONTRACT);
  const policy = clone(ECONOMIC_SOLVE_POLICY);
  mutate(policy);
  contract.policy_binding.canonical_sha256 = canonicalJsonSha256(policy);
  const errors = validateEquationGraph(graph, contract, policy);
  assert.ok(
    errors.some((error) => error.includes(expectedFragment)),
    `${name} should fail with ${expectedFragment}; got ${errors.join(" | ")}`,
  );
  return { name, status: "PASS", total_violations: errors.length };
}

function withoutEdge(graph, edgeId) {
  graph.edges = graph.edges.filter((edge) => edge.id !== edgeId);
}

function reachable(edges, from, to) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  const pending = [from];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === to) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []).sort());
  }
  return false;
}

assert.deepEqual(validateEquationGraph(EQUATION_GRAPH, CONVERGENCE_CONTRACT), []);

const on = compileEquationGraphState({ circularity: 1 });
const off = compileEquationGraphState({ circularity: 0 });
assert.equal(on.active_sccs.length, 1, "circularity on must activate the declared interest/cash/RCF SCC");
assert.equal(on.active_sccs[0].id, "interest_cash_rcf_feedback");
assert.equal(on.solver_iteration.required, true);
assert.equal(on.solver_iteration.absolute_tolerance, ECONOMIC_SOLVE_POLICY.solver.absolute_tolerance);
assert.equal(on.solver_iteration.state_vector.length, on.active_sccs[0].nodes.length);
assert.ok(on.solver_iteration.state_vector.every((item) => item.tolerance_class === "currency"));
assert.equal(off.active_sccs.length, 0, "circularity off must kill the interest SCC");
assert.equal(off.solver_iteration.required, false);
assert.deepEqual(off.solver_iteration.state_vector, []);
assert.equal(on.economic_solve_policy_sha256, CONVERGENCE_CONTRACT.policy_binding.canonical_sha256);

const solverOnDeclaration = solverIterationDeclaration(1);
const solverOffDeclaration = solverIterationDeclaration(0);
assert.deepEqual(validateSolverIterationDeclaration(solverOnDeclaration), []);
assert.deepEqual(validateSolverIterationDeclaration(solverOffDeclaration), []);
const solverOnEvidence = compileSolverEquationGraphEvidence(solverOnDeclaration);
const solverOffEvidence = compileSolverEquationGraphEvidence(solverOffDeclaration);
assert.deepEqual(validateSolverEquationGraphEvidence(solverOnEvidence), []);
assert.deepEqual(validateSolverEquationGraphEvidence(solverOffEvidence), []);
assert.equal(solverOnEvidence.graph_sha256, on.graph_sha256);
assert.equal(solverOnEvidence.economic_solve_policy_sha256, on.economic_solve_policy_sha256);
assert.equal(solverOffEvidence.active_sccs.length, 0);

const solverVectorMismatch = clone(solverOnDeclaration);
solverVectorMismatch.state_vector.pop();
assert.ok(
  validateSolverIterationDeclaration(solverVectorMismatch)
    .some((error) => error.includes("state_vector does not match")),
  "a solver-owned iteration-vector mismatch must fail closed",
);
const solverStateMismatch = clone(solverOnEvidence);
solverStateMismatch.active_circularity_state = 0;
assert.ok(
  validateSolverEquationGraphEvidence(solverStateMismatch)
    .some((error) => error.includes("active_circularity_state")),
  "a solve-evidence circularity-state mismatch must fail closed",
);
const solverGraphHashMismatch = clone(solverOnEvidence);
solverGraphHashMismatch.graph_sha256 = "0".repeat(64);
assert.ok(
  validateSolverEquationGraphEvidence(solverGraphHashMismatch)
    .some((error) => error.includes("graph_sha256")),
  "a solve-evidence graph-hash mismatch must fail closed",
);
const solverPolicyHashMismatch = clone(solverOnEvidence);
solverPolicyHashMismatch.economic_solve_policy_sha256 = "f".repeat(64);
assert.ok(
  validateSolverEquationGraphEvidence(solverPolicyHashMismatch)
    .some((error) => error.includes("economic_solve_policy_sha256")),
  "a solve-evidence policy-hash mismatch must fail closed",
);

const offEdges = activeEquationEdges(EQUATION_GRAPH, 0);
const offEdgeIds = new Set(offEdges.map((edge) => edge.id));
for (const edgeId of CONVERGENCE_CONTRACT.rcf_sweep_contract.edge_ids) {
  assert.ok(offEdgeIds.has(edgeId), `${edgeId} must remain active with circularity off`);
}
assert.ok(reachable(offEdges, "statement.cash_flow_start", "cash.ending_balance"), "declared cash-flow start -> CFO -> cash must remain live with circularity off");
assert.ok(reachable(offEdges, "cash.cfo", "rcf.ending_balance"), "CFO -> RCF sweep -> ending RCF must remain live with circularity off");
assert.ok(reachable(offEdges, "debt.issuance", "cash.ending_balance"), "debt issuance -> cash must remain live with circularity off");
assert.ok(reachable(offEdges, "debt.scheduled_amortisation", "cash.ending_balance"), "debt repayment -> mandatory repayment -> cash must remain live with circularity off");
assert.ok(reachable(offEdges, "lease.principal", "cash.ending_balance"), "lease principal -> mandatory repayment -> cash must remain live with circularity off");

const nodesById = new Map(EQUATION_GRAPH.nodes.map((node) => [node.id, node]));
for (const edge of offEdges.filter((item) => item.type !== "control_gate")) {
  assert.notEqual(nodesById.get(edge.from).circularity_behavior, "zero_when_off", `${edge.id} leaks killed interest into breaker mode`);
  assert.notEqual(nodesById.get(edge.to).circularity_behavior, "zero_when_off", `${edge.id} calculates killed interest in breaker mode`);
}

const reordered = clone(EQUATION_GRAPH);
reordered.nodes.reverse();
reordered.edges.reverse();
assert.deepEqual(
  deriveStronglyConnectedComponents(reordered),
  deriveStronglyConnectedComponents(EQUATION_GRAPH),
  "Tarjan structural SCC derivation must not depend on graph array order",
);
assert.deepEqual(
  deriveStronglyConnectedComponents(reordered, { circularity: 0 }),
  deriveStronglyConnectedComponents(EQUATION_GRAPH, { circularity: 0 }),
  "Tarjan active SCC derivation must not depend on graph array order",
);

const mutations = [
  mutation(
    "missing cash to interest income",
    (graph) => withoutEdge(graph, "edge.cash_to_interest_income"),
    "required economic edge edge.cash_to_interest_income is missing",
  ),
  mutation(
    "missing ending RCF to RCF interest",
    (graph) => withoutEdge(graph, "edge.ending_rcf_to_rcf_interest"),
    "required economic edge edge.ending_rcf_to_rcf_interest is missing",
  ),
  mutation(
    "missing statement start to CFO",
    (graph) => withoutEdge(graph, "edge.cash_flow_start_to_cfo"),
    "required economic edge edge.cash_flow_start_to_cfo is missing",
  ),
  mutation(
    "missing CFO to cash",
    (graph) => withoutEdge(graph, "edge.cfo_to_cash"),
    "required economic edge edge.cfo_to_cash is missing",
  ),
  mutation(
    "unrelated cycle",
    (graph) => {
      graph.edges.push(
        { id: "edge.mutant_issuance_to_amortisation", from: "debt.issuance", to: "debt.scheduled_amortisation", type: "balance_rollforward", activation: "always" },
        { id: "edge.mutant_amortisation_to_issuance", from: "debt.scheduled_amortisation", to: "debt.issuance", type: "balance_rollforward", activation: "always" },
      );
    },
    "derived structural SCCs do not match",
  ),
  mutation(
    "reverse statement schedule direction",
    (graph) => {
      const edge = graph.edges.find((item) => item.id === "edge.gross_interest_to_finance_statement");
      [edge.from, edge.to] = [edge.to, edge.from];
    },
    "schedule-to-statement authority direction is reversed",
  ),
  mutation(
    "missing circularity gate",
    (graph) => withoutEdge(graph, "edge.control_to_rcf_interest"),
    "zero_when_off node interest.rcf must have exactly one always-active circularity control gate",
  ),
  mutation(
    "gate RCF sweep off",
    (graph) => {
      graph.edges.find((edge) => edge.id === "edge.cfo_to_rcf_draw").activation = "circularity_on";
    },
    "RCF sweep edge edge.cfo_to_rcf_draw must remain active when circularity is off",
  ),
  mutation(
    "policy role drift",
    (_graph, contract) => { contract.role_contract.live_when_off.pop(); },
    "live_when_off roles must exactly match",
  ),
  mutation(
    "state tolerance class drift",
    (_graph, contract) => { contract.solver_iteration.state_by_circularity["1"].state_vector[0].tolerance_class = "ratio"; },
    "tolerance class does not match",
  ),
  policyMutation(
    "workbook tolerance drift",
    (policy) => { policy.workbook_calculation.iterate_delta = 1e-5; },
    "iterate_delta must exactly equal native_tolerances.currency",
  ),
  mutation(
    "strict schema rejects extension",
    (graph) => { graph.uncontracted_extension = true; },
    "is not an allowed property",
  ),
];

console.log(JSON.stringify({
  status: "PASS",
  total_violations: 0,
  graph_schema_version: EQUATION_GRAPH.schema_version,
  convergence_contract_version: CONVERGENCE_CONTRACT.schema_version,
  policy_schema_version: ECONOMIC_SOLVE_POLICY.schema_version,
  structural_scc_count: on.structural_sccs.length,
  active_scc_count: { circularity_off: off.active_sccs.length, circularity_on: on.active_sccs.length },
  off_state_live_edge_count: offEdges.length,
  iteration_state_size: on.solver_iteration.state_vector.length,
  mutations,
}, null, 2));
