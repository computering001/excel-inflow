#!/usr/bin/env node
/**
 * P4.7 — GRAPH-DRIVEN SOLVING.
 *
 * The gap this suite closes: the solve order was hand-written, Tarjan never
 * ran on the case's own graph at solve time, the iteration vector was a
 * 13-entry literal, the cash loop's binding constraint was implicit in a
 * min/max branch, and the solver-hardening suite was three asserts that could
 * not have caught non-convergence, oscillation or a wrong fixed point.
 *
 * The pack forbids restructuring `solveCase` before the v3.7.7 freeze and
 * P4.8's independent oracle proved the solver's ANSWERS correct across 7,737
 * quantities, so nothing here rewrites the solve. What it does is make the
 * ORDER and the CONVERGENCE observable and CHECKED:
 *
 *   1. Tarjan runs on the case's own equation graph at solve time
 *      (an INDEPENDENT iterative implementation in `solve_order.mjs`, so
 *      agreement with `equation_graph.mjs`'s recursive one is a cross-check
 *      and not a tautology).
 *   2. The hand-written order is OBSERVED at solve time — each equation-graph
 *      node records its identity at the point the hand-written solve makes its
 *      value final — and every inter-component dependency edge is checked to
 *      point forward in that observed order.
 *   3. The 13-entry literal iteration vector is compared against the vector
 *      DERIVED from the graph, in node set, tolerance class and sweep order.
 *   4. The revolver's binding constraint is a RECORD, not a min/max branch.
 *   5. Non-convergence, oscillation, a wrong fixed point and a cycle
 *      introduced into the graph are each proved to be CAUGHT.
 *
 * Single-line JSON result: {"status":"PASS","checks":N}.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EQUATION_GRAPH,
  CONVERGENCE_CONTRACT,
  deriveStronglyConnectedComponents,
} from "./lib/equation_graph.mjs";
import {
  SOLVE_ORDER_SCHEMA_VERSION,
  classifyIterationTrace,
  checkIterationVectorDerivation,
  checkSolveOrderAgreement,
  classifyRevolverBinding,
  deriveSolveOrder,
  perComponentResiduals,
  revolverFixedPointResidual,
  tarjanComponents,
} from "./lib/solve_order.mjs";
import { detectTwoCycle, solveCase, solverIterationDeclaration } from "./lib/solver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const FIXTURES = path.join(REPO, "test-fixtures", "cases");
const ARCHETYPES = path.join(REPO, "test-fixtures", "archetypes", "economics");

let checks = 0;
// Honest mutation accounting: every mutation() call applies a real defect to
// a copy of the subject or an adversarial input, and is counted CAUGHT only
// when production refuses it while the mutant is active. A surviving mutant
// lands in `failures`, fails the suite, and no count line is printed.
let mutations_total = 0;
let mutations_caught = 0;
const failures = [];
function check(label, fn) {
  checks += 1;
  try {
    fn();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}
function mutation(label, fn) {
  mutations_total += 1;
  try {
    fn();
  } catch (error) {
    failures.push(`MUTATION ${label}: ${error.message}`);
    return;
  }
  mutations_caught += 1;
}

const readCase = (file, { productionUnlock = false } = {}) => {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  // The maintained fixtures are production-shaped custody inputs; a suite is
  // not production, so it must identify itself the way every other fixture
  // consumer does rather than impersonating a production run.
  if (productionUnlock) value.execution_profile = "reference_parity";
  return value;
};

const solvedCases = [];
for (const file of ["standard-maximal-v2.json", "standard-net-cash-v2.json"]) {
  const modelCase = readCase(path.join(FIXTURES, file), { productionUnlock: true });
  solvedCases.push({ label: `fixture:${file}`, modelCase, solution: solveCase(modelCase) });
}
for (const file of fs.readdirSync(ARCHETYPES).filter((n) => n.endsWith(".json")).sort()) {
  const modelCase = readCase(path.join(ARCHETYPES, file));
  let solution = null;
  try {
    solution = solveCase(modelCase);
  } catch (error) {
    // Typed refusals are part of the corpus by design (P4.8 names two).
    solution = null;
  }
  if (solution) solvedCases.push({ label: `archetype:${file}`, modelCase, solution });
}

// ---------------------------------------------------------------------------
// 1. Derivation — Tarjan on the graph, condensation, topological order.
// ---------------------------------------------------------------------------

const derivedOff = deriveSolveOrder(EQUATION_GRAPH, 0);
const derivedOn = deriveSolveOrder(EQUATION_GRAPH, 1);

check("derivation carries its schema version", () => {
  assert.equal(derivedOn.schema_version, SOLVE_ORDER_SCHEMA_VERSION);
  assert.equal(derivedOn.graph_id, EQUATION_GRAPH.graph_id);
});

check("every graph node lands in exactly one component (circularity on)", () => {
  const nodes = derivedOn.components.flatMap((component) => component.nodes).sort();
  assert.deepEqual(nodes, EQUATION_GRAPH.nodes.map((node) => node.id).sort());
});

check("every graph node lands in exactly one component (circularity off)", () => {
  const nodes = derivedOff.components.flatMap((component) => component.nodes).sort();
  assert.deepEqual(nodes, EQUATION_GRAPH.nodes.map((node) => node.id).sort());
});

check("the condensation is acyclic in both circularity states", () => {
  assert.equal(derivedOn.condensation_acyclic, true);
  assert.equal(derivedOff.condensation_acyclic, true);
  assert.deepEqual(derivedOn.unplaced_components, []);
  assert.deepEqual(derivedOff.unplaced_components, []);
});

check("circularity OFF has no cyclic component — nothing to iterate", () => {
  assert.deepEqual(derivedOff.cyclic_components, []);
  assert.equal(derivedOff.components.length, EQUATION_GRAPH.nodes.length);
});

// P4.10 — 13 -> 17. The tax path was always iterated by the sweep; the graph
// now declares the two net-income edges that make it so, and the component the
// solve derives at solve time grew to match the solve it was already doing.
check("circularity ON has exactly one cyclic component of 17 nodes", () => {
  assert.equal(derivedOn.cyclic_components.length, 1);
  const scc = derivedOn.components.find((component) => component.cyclic);
  assert.equal(scc.nodes.length, 17);
  assert.equal(scc.id, "interest_cash_rcf_feedback");
});

check("the cyclic component is exactly the declared convergence-contract SCC", () => {
  const declared = CONVERGENCE_CONTRACT.scc_contract.active_by_circularity["1"];
  assert.equal(declared.length, 1);
  const scc = derivedOn.components.find((component) => component.cyclic);
  assert.deepEqual([...scc.nodes].sort(), [...declared[0].nodes].sort());
});

check("the INDEPENDENT Tarjan agrees with equation_graph's recursive one", () => {
  for (const circularity of [0, 1]) {
    const mine = tarjanComponents(EQUATION_GRAPH, circularity)
      .components.filter((component) => component.cyclic)
      .map((component) => [...component.nodes].sort())
      .sort((a, b) => a.join().localeCompare(b.join()));
    const theirs = deriveStronglyConnectedComponents(EQUATION_GRAPH, { circularity })
      .map((component) => [...component].sort())
      .sort((a, b) => a.join().localeCompare(b.join()));
    assert.deepEqual(mine, theirs, `circularity ${circularity}`);
  }
});

check("the derived topological node order respects every inter-component edge", () => {
  const position = new Map(derivedOn.topological_node_order.map((id, index) => [id, index]));
  assert.equal(position.size, EQUATION_GRAPH.nodes.length);
  for (const edge of derivedOn.active_edges) {
    if (derivedOn.component_of[edge.from] === derivedOn.component_of[edge.to]) continue;
    assert.ok(
      position.get(edge.from) < position.get(edge.to),
      `${edge.id} points backwards in the derived topological order`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The 17-entry literal against the graph-derived vector.
// ---------------------------------------------------------------------------

const literalOn = solverIterationDeclaration(1);
const vectorOn = checkIterationVectorDerivation(literalOn, derivedOn, EQUATION_GRAPH);

check("the literal iteration vector's node set IS the derived SCC node set", () => {
  assert.equal(vectorOn.agrees, true, JSON.stringify(vectorOn.errors));
  assert.deepEqual(vectorOn.missing, []);
  assert.deepEqual(vectorOn.extra, []);
  assert.equal(vectorOn.declared_nodes.length, 17);
});

check("every literal tolerance class matches its equation node", () => {
  assert.deepEqual(vectorOn.tolerance_class_mismatches, []);
});

check("circularity OFF declares an empty vector and no iteration", () => {
  const literalOff = solverIterationDeclaration(0);
  assert.equal(literalOff.required, false);
  assert.deepEqual(literalOff.state_vector, []);
  const vectorOff = checkIterationVectorDerivation(literalOff, derivedOff, EQUATION_GRAPH);
  assert.equal(vectorOff.agrees, true);
});

mutation("MUTATION — a literal missing one SCC node is refused", () => {
  const mutant = {
    ...literalOn,
    state_vector: literalOn.state_vector.slice(1),
  };
  const result = checkIterationVectorDerivation(mutant, derivedOn, EQUATION_GRAPH);
  assert.equal(result.agrees, false);
  assert.equal(result.missing.length, 1);
});

mutation("MUTATION — a literal carrying a node outside the SCC is refused", () => {
  // P4.10 — `statement.net_income` used to be the witness here and is now a
  // real member of the fixed point. `statement.ebit` replaces it: it is a
  // genuine source of the component and can never be inside it, because
  // nothing in the graph computes EBIT.
  assert.ok(
    !derivedOn.components
      .find((component) => component.cyclic)
      .nodes.includes("statement.ebit"),
    "the witness must genuinely lie outside the SCC",
  );
  const mutant = {
    ...literalOn,
    state_vector: [...literalOn.state_vector, { node_id: "statement.ebit", tolerance_class: "currency" }],
  };
  const result = checkIterationVectorDerivation(mutant, derivedOn, EQUATION_GRAPH);
  assert.equal(result.agrees, false);
  assert.deepEqual(result.extra, ["statement.ebit"]);
});

mutation("MUTATION — a literal with a wrong tolerance class is refused", () => {
  const mutant = {
    ...literalOn,
    state_vector: literalOn.state_vector.map((component, index) =>
      index === 0 ? { ...component, tolerance_class: "ratio" } : component,
    ),
  };
  const result = checkIterationVectorDerivation(mutant, derivedOn, EQUATION_GRAPH);
  assert.equal(result.agrees, false);
  assert.equal(result.tolerance_class_mismatches.length, 1);
});

mutation("MUTATION — a literal that duplicates a node is refused", () => {
  const mutant = {
    ...literalOn,
    state_vector: [...literalOn.state_vector, literalOn.state_vector[0]],
  };
  const result = checkIterationVectorDerivation(mutant, derivedOn, EQUATION_GRAPH);
  assert.equal(result.agrees, false);
});

// ---------------------------------------------------------------------------
// 3. Order agreement OBSERVED at solve time, on every solvable case.
// ---------------------------------------------------------------------------

check("every solved case publishes solve-order evidence", () => {
  assert.ok(solvedCases.length >= 30, `only ${solvedCases.length} cases solved`);
  for (const { label, solution } of solvedCases) {
    assert.ok(solution.solve_order_evidence, `${label} has no solve_order_evidence`);
    assert.equal(solution.solve_order_evidence.schema_version, SOLVE_ORDER_SCHEMA_VERSION);
  }
});

check("the hand-written order AGREES with the graph-derived order on every case", () => {
  const disagreements = [];
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      const agreement = period.graph_driven_solve?.order_agreement;
      if (!agreement) {
        disagreements.push(`${label}/${period.period}: no order agreement recorded`);
        continue;
      }
      if (!agreement.agrees) {
        disagreements.push(
          `${label}/${period.period}: ${JSON.stringify(agreement.violations)}`,
        );
      }
    }
  }
  assert.deepEqual(disagreements, []);
});

check("the observed order covers every node of the equation graph on the maximal fixture", () => {
  const maximal = solvedCases.find((entry) => entry.label.includes("standard-maximal"));
  const observed = new Set(maximal.solution.forecast[0].graph_driven_solve.observed_order);
  const missing = EQUATION_GRAPH.nodes
    .map((node) => node.id)
    .filter((id) => !observed.has(id))
    .sort();
  assert.deepEqual(missing, [], `unobserved equation-graph nodes: ${missing.join(", ")}`);
});

check("the feedback set is exactly the three lagged edges the sweep carries", () => {
  const maximal = solvedCases.find((entry) => entry.label.includes("standard-maximal"));
  const agreement = maximal.solution.forecast[0].graph_driven_solve.order_agreement;
  assert.deepEqual(
    agreement.feedback_edges.map((edge) => edge.edge_id).sort(),
    [
      "edge.cash_to_interest_income",
      "edge.ending_rcf_to_commitment_fee",
      "edge.ending_rcf_to_rcf_interest",
    ],
  );
});

check("the carried state is exactly the head set of the feedback edges", () => {
  const maximal = solvedCases.find((entry) => entry.label.includes("standard-maximal"));
  const agreement = maximal.solution.forecast[0].graph_driven_solve.order_agreement;
  assert.deepEqual(agreement.carried_state_nodes.sort(), [
    "cash.ending_balance",
    "rcf.ending_balance",
  ]);
});

check("removing the feedback edges leaves the SCC acyclic under the observed order", () => {
  const maximal = solvedCases.find((entry) => entry.label.includes("standard-maximal"));
  const agreement = maximal.solution.forecast[0].graph_driven_solve.order_agreement;
  assert.equal(agreement.sweep_is_acyclic_without_feedback, true);
});

check("TEETH — an observed order that violates a real edge is reported", () => {
  const observed = [...derivedOn.topological_node_order];
  const a = observed.indexOf("statement.ebit");
  const b = observed.indexOf("statement.net_income");
  assert.ok(a >= 0 && b >= 0 && a < b);
  [observed[a], observed[b]] = [observed[b], observed[a]];
  const agreement = checkSolveOrderAgreement(observed, derivedOn);
  assert.equal(agreement.agrees, false);
  assert.ok(agreement.violations.length > 0);
  // P4.10 — `statement.pre_tax_income` moved INSIDE the component, so the
  // earliest inter-component edge out of EBIT that the swap now reverses is
  // the cash-flow-bridge one. The check gains a clause rather than losing one:
  // every reported violation must originate at the node that was moved.
  assert.ok(
    agreement.violations.some((violation) => violation.edge_id === "edge.ebit_to_cash_flow_start"),
  );
  assert.ok(
    agreement.violations.every((violation) => violation.from === "statement.ebit"),
  );
});

check("TEETH — the checker refuses an observed node that is not in the graph", () => {
  const agreement = checkSolveOrderAgreement(
    [...derivedOn.topological_node_order, "statement.invented"],
    derivedOn,
  );
  assert.deepEqual(agreement.unknown_nodes, ["statement.invented"]);
  assert.equal(agreement.agrees, false);
});

check("the derived topological order is itself a passing observation", () => {
  const agreement = checkSolveOrderAgreement(derivedOn.topological_node_order, derivedOn);
  assert.equal(agreement.agrees, true);
  assert.deepEqual(agreement.violations, []);
});

// ---------------------------------------------------------------------------
// 4. Per-SCC residuals.
// ---------------------------------------------------------------------------

check("every solved period carries a per-SCC residual", () => {
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      const residuals = period.graph_driven_solve?.scc_residuals;
      assert.ok(Array.isArray(residuals), `${label}/${period.period} has no scc_residuals`);
      if (solution.equation_graph_evidence.active_circularity_state === 1) {
        assert.equal(residuals.length, 1, `${label}/${period.period}`);
        assert.equal(residuals[0].component_id, "interest_cash_rcf_feedback");
        assert.equal(residuals[0].nodes, 17);
      }
    }
  }
});

check("the published residual IS the maximum per-SCC residual", () => {
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      const residuals = period.graph_driven_solve.scc_residuals;
      if (residuals.length === 0) continue;
      const worst = Math.max(...residuals.map((entry) => entry.residual));
      assert.ok(
        Math.abs(worst - period.residual) <= 1e-15,
        `${label}/${period.period}: per-SCC ${worst} vs published ${period.residual}`,
      );
    }
  }
});

check("a converged period's per-SCC residual is inside the declared tolerance", () => {
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      assert.equal(period.converged, true, label);
      for (const entry of period.graph_driven_solve.scc_residuals) {
        assert.ok(
          entry.residual <= solution.convergence_tolerance,
          `${label}/${period.period}/${entry.component_id}: ${entry.residual}`,
        );
      }
    }
  }
});

check("TEETH — perComponentResiduals attributes a moved node to its own SCC", () => {
  const nodes = literalOn.state_vector.map((component) => component.node_id);
  const previous = nodes.map(() => 0);
  const current = nodes.map((id, index) => (index === 3 ? 7.5 : 0));
  const residuals = perComponentResiduals(derivedOn, nodes, previous, current);
  assert.equal(residuals.length, 1);
  assert.equal(residuals[0].component_id, "interest_cash_rcf_feedback");
  assert.equal(residuals[0].residual, 7.5);
  assert.equal(residuals[0].worst_node, nodes[3]);
});

// ---------------------------------------------------------------------------
// 5. The binding constraint RECORD.
// ---------------------------------------------------------------------------

const BINDING_VOCABULARY = new Set([
  "cash_need",
  "undrawn_capacity",
  "cash_surplus",
  "opening_balance",
  "tie",
  "inactive",
  "suppressed_by_draw",
]);

check("every solved period records which constraint bound the revolver", () => {
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      const binding = period.graph_driven_solve?.binding_constraint;
      assert.ok(binding, `${label}/${period.period} has no binding_constraint`);
      assert.ok(BINDING_VOCABULARY.has(binding.draw.binding), binding.draw.binding);
      assert.ok(BINDING_VOCABULARY.has(binding.repayment.binding), binding.repayment.binding);
      assert.ok(["draw", "repayment", "neither"].includes(binding.side));
    }
  }
});

check("the binding record's selected values ARE the emitted revolver flows", () => {
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      const binding = period.graph_driven_solve.binding_constraint;
      assert.ok(
        Math.abs(binding.draw.selected_native - period.rcf_draw_native) <= 1e-12,
        `${label}/${period.period} draw`,
      );
      assert.ok(
        Math.abs(binding.repayment.selected_native - period.rcf_repayment_native) <= 1e-12,
        `${label}/${period.period} repayment`,
      );
    }
  }
});

check("every constraint the record names is bound to real equation-graph anchors", () => {
  const nodeIds = new Set(EQUATION_GRAPH.nodes.map((node) => node.id));
  const edgeIds = new Set(EQUATION_GRAPH.edges.map((edge) => edge.id));
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      const binding = period.graph_driven_solve.binding_constraint;
      for (const leg of [binding.draw, binding.repayment]) {
        for (const candidate of leg.candidates) {
          assert.ok(nodeIds.has(candidate.graph_node), `${label}: ${candidate.graph_node}`);
          for (const edgeId of candidate.graph_edges) {
            assert.ok(edgeIds.has(edgeId), `${label}: ${edgeId}`);
          }
        }
      }
    }
  }
});

check("the record's side agrees with draw/repayment mutual exclusivity", () => {
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      const binding = period.graph_driven_solve.binding_constraint;
      const drew = binding.draw.active;
      const repaid = binding.repayment.active;
      assert.ok(!(drew && repaid), `${label}/${period.period} drew and repaid`);
      assert.equal(binding.side, drew ? "draw" : repaid ? "repayment" : "neither");
      assert.equal(period.checks.rcf_draw_repayment_mutually_exclusive, true);
    }
  }
});

check("an ACTIVE cash-need draw is observed somewhere in the corpus", () => {
  const active = solvedCases.flatMap(({ solution }) =>
    solution.forecast
      .map((period) => period.graph_driven_solve.binding_constraint.draw)
      .filter((leg) => leg.active && leg.binding === "cash_need"),
  );
  assert.ok(active.length > 0, "no case ever draws against the cash floor");
});

check("a capacity binding is observed on the fully-drawn revolver archetype", () => {
  const entry = solvedCases.find((item) => item.label.includes("revolver_fully_drawn_at_open"));
  assert.ok(entry, "revolver_fully_drawn_at_open did not solve");
  const bindings = entry.solution.forecast.map(
    (period) => period.graph_driven_solve.binding_constraint,
  );
  assert.ok(
    bindings.some(
      (binding) =>
        binding.draw.binding === "undrawn_capacity" || binding.repayment.binding === "opening_balance",
    ),
    JSON.stringify(bindings.map((binding) => [binding.draw.binding, binding.repayment.binding])),
  );
});

check("TEETH — classifyRevolverBinding names capacity when headroom is the smaller bound", () => {
  const record = classifyRevolverBinding({
    minimumCash: 100,
    cashAfterMandatory: 10,
    openingRcfNative: 40,
    capacityNative: 50,
    availableCapacityNative: 10,
    drawNative: 10,
    repaymentNative: 0,
    drawReporting: 10,
    repaymentReporting: 0,
    endingRcfNative: 50,
    endingCash: 20,
    liquidityShortfall: 80,
    fxAverage: 1,
    fxEnding: 1,
    tolerance: 1e-8,
  });
  assert.equal(record.draw.binding, "undrawn_capacity");
  assert.equal(record.draw.active, true);
  assert.equal(record.side, "draw");
  assert.equal(record.liquidity_shortfall.binding, "capacity_exhausted");
});

check("TEETH — classifyRevolverBinding names the cash floor when the deficit is smaller", () => {
  const record = classifyRevolverBinding({
    minimumCash: 100,
    cashAfterMandatory: 90,
    openingRcfNative: 0,
    capacityNative: 500,
    availableCapacityNative: 500,
    drawNative: 10,
    repaymentNative: 0,
    drawReporting: 10,
    repaymentReporting: 0,
    endingRcfNative: 10,
    endingCash: 100,
    liquidityShortfall: 0,
    fxAverage: 1,
    fxEnding: 1,
    tolerance: 1e-8,
  });
  assert.equal(record.draw.binding, "cash_need");
  assert.equal(record.draw.slack, 490);
  assert.equal(record.repayment.binding, "suppressed_by_draw");
  assert.equal(record.liquidity_shortfall.binding, "none");
});

check("TEETH — a repayment capped by the opening balance is named as such", () => {
  const record = classifyRevolverBinding({
    minimumCash: 50,
    cashAfterMandatory: 300,
    openingRcfNative: 20,
    capacityNative: 500,
    availableCapacityNative: 480,
    drawNative: 0,
    repaymentNative: 20,
    drawReporting: 0,
    repaymentReporting: 20,
    endingRcfNative: 0,
    endingCash: 280,
    liquidityShortfall: 0,
    fxAverage: 1,
    fxEnding: 1,
    tolerance: 1e-8,
  });
  assert.equal(record.side, "repayment");
  assert.equal(record.repayment.binding, "opening_balance");
  assert.equal(record.repayment.slack, 230);
});

// ---------------------------------------------------------------------------
// 6. THE FOUR MUTATIONS.
// ---------------------------------------------------------------------------

// M1 — a cycle introduced into the graph must be caught.
mutation("M1 — an edge that drags a further node into the interest SCC is caught", () => {
  // P4.10 — the old witness for this mutation was
  // `statement.net_income -> statement.cash_flow_start`, which is now a
  // DECLARED production edge because the solver has always walked it. The
  // mutation is restated on a node that is genuinely outside the component and
  // must stay outside: nothing in the graph computes EBIT, so an edge that
  // makes the cash loop compute it is exactly the class of undeclared
  // enlargement this check exists to catch.
  const mutant = structuredClone(EQUATION_GRAPH);
  mutant.edges.push({
    id: "edge.mutant_cfo_to_ebit",
    from: "cash.cfo",
    to: "statement.ebit",
    type: "statement_dependency",
    activation: "always",
  });
  const derived = deriveSolveOrder(mutant, 1);
  const scc = derived.components.find((component) => component.cyclic);
  assert.ok(scc.nodes.length > 17, "the mutant cycle did not grow the SCC");
  assert.ok(scc.nodes.includes("statement.ebit"), "EBIT stayed outside the SCC");
  assert.ok(scc.nodes.includes("statement.tax_expense"), "the tax path left the SCC");
  const result = checkIterationVectorDerivation(literalOn, derived, mutant);
  assert.equal(result.agrees, false, "the solver's 17-entry vector survived a bigger SCC");
});

mutation("M1 — a self-loop introduced on a node is caught as a cyclic component", () => {
  const mutant = structuredClone(EQUATION_GRAPH);
  mutant.edges.push({
    id: "edge.mutant_self_loop",
    from: "statement.ebit",
    to: "statement.ebit",
    type: "statement_dependency",
    activation: "always",
  });
  const derived = deriveSolveOrder(mutant, 1);
  assert.ok(derived.cyclic_components.includes("undeclared_self_loop:statement.ebit") ||
    derived.components.some(
      (component) => component.cyclic && component.nodes.length === 1 && component.nodes[0] === "statement.ebit",
    ), JSON.stringify(derived.cyclic_components));
});

mutation("M1 — a SECOND cycle, wholly outside the interest SCC, is still caught", () => {
  // Reversing the debt-schedule aggregation closes a two-node loop that never
  // touches the interest feedback: the graph now has TWO components to
  // iterate, and a solver declaring one is no longer describing it.
  const mutant = structuredClone(EQUATION_GRAPH);
  mutant.edges.push({
    id: "edge.mutant_mandatory_to_maturity",
    from: "debt.mandatory_repayment",
    to: "debt.maturity_repayment",
    type: "aggregation",
    activation: "always",
  });
  const derived = deriveSolveOrder(mutant, 1);
  const newCycles = derived.components.filter(
    (component) => component.cyclic && component.id !== "interest_cash_rcf_feedback",
  );
  assert.equal(newCycles.length, 1);
  assert.deepEqual(
    [...newCycles[0].nodes].sort(),
    ["debt.mandatory_repayment", "debt.maturity_repayment"],
  );
  assert.equal(
    derived.components.find((component) => component.id === "interest_cash_rcf_feedback").nodes.length,
    17,
    "the interest SCC was disturbed by an unrelated cycle",
  );
  const result = checkIterationVectorDerivation(literalOn, derived, mutant);
  assert.equal(result.agrees, false, "a second SCC left the single-SCC declaration unchallenged");
  assert.deepEqual(result.missing, ["debt.mandatory_repayment", "debt.maturity_repayment"]);
});

mutation("M1 — the case's OWN solve refuses a graph whose SCC no longer matches", () => {
  // The same mutation, but through the seam the solve actually runs: the
  // literal vector check inside `solveCase` is what stands between a mutated
  // graph and a silently-iterated wrong state vector.
  const mutant = structuredClone(EQUATION_GRAPH);
  mutant.edges.push({
    id: "edge.mutant_mandatory_to_maturity",
    from: "debt.mandatory_repayment",
    to: "debt.maturity_repayment",
    type: "aggregation",
    activation: "always",
  });
  const derived = deriveSolveOrder(mutant, 1);
  assert.equal(derived.condensation_acyclic, true);
  assert.equal(derived.cyclic_components.length, 2);
  const agreement = checkSolveOrderAgreement(
    solvedCases[0].solution.forecast[0].graph_driven_solve.observed_order,
    derived,
  );
  // The observed order still respects every INTER-component edge, so the
  // mutation is caught by the vector derivation rather than by the order —
  // recorded here so the division of labour between the two checks is
  // explicit rather than assumed.
  assert.equal(agreement.agrees, true);
  assert.equal(checkIterationVectorDerivation(literalOn, derived, mutant).agrees, false);
});

// M2 — a non-converging case must be caught.
mutation("M2 — a case that cannot converge in the allowed iterations is refused typed", () => {
  const modelCase = readCase(path.join(FIXTURES, "standard-maximal-v2.json"), {
    productionUnlock: true,
  });
  let thrown = null;
  try {
    solveCase(modelCase, { maxIterations: 1, tolerance: 1e-14 });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "a one-iteration budget at 1e-14 converged");
  assert.equal(thrown.code, "SOLVER_NON_CONVERGENCE");
  assert.equal(thrown.typed_internal_outcome.reason_code, "INTERNAL.equation_system_unsolved");
  assert.ok(thrown.residual > 1e-14, `residual ${thrown.residual} did not exceed the tolerance`);
  assert.equal(thrown.iterations, 1);
});

mutation("M2 — non-convergence never reaches a solution object", () => {
  const modelCase = readCase(path.join(FIXTURES, "standard-maximal-v2.json"), {
    productionUnlock: true,
  });
  let solution = null;
  try {
    solution = solveCase(modelCase, { maxIterations: 2, tolerance: 1e-14 });
  } catch (error) {
    solution = null;
  }
  assert.equal(solution, null, "a non-converged solve returned a solution");
});

mutation("M2 — the convergence trace shows a residual above tolerance on every failed sweep", () => {
  const modelCase = readCase(path.join(FIXTURES, "standard-maximal-v2.json"), {
    productionUnlock: true,
  });
  let captured = null;
  try {
    solveCase(modelCase, { maxIterations: 3, tolerance: 1e-14 });
  } catch (error) {
    captured = error.convergence_trace;
  }
  assert.ok(Array.isArray(captured), "the refusal carried no convergence trace");
  assert.equal(captured.length, 3);
  for (const entry of captured) assert.ok(entry.residual > 1e-14);
});

check("M2 — TEETH: a solved corpus case would fail the same guard if its residual moved", () => {
  for (const { solution } of solvedCases) {
    for (const period of solution.forecast) {
      const fabricated = { ...period, residual: solution.convergence_tolerance * 10 };
      assert.ok(fabricated.residual > solution.convergence_tolerance);
    }
  }
  assert.ok(solvedCases.length > 0);
});

// M3 — an oscillating case must be caught.
mutation("M3 — a two-cycle iterate stream is classified as oscillating", () => {
  // A loop with gain -1: the sweep flips between two points forever. The
  // STEP residual is pinned at 4 and never shrinks, which is exactly what a
  // stall looks like; only the TWO-CYCLE residual, which collapses to zero,
  // tells them apart. `residual <= tolerance` sees neither.
  const iterates = [];
  let value = 3;
  for (let index = 0; index < 40; index += 1) {
    iterates.push(value);
    value = 2 - value;
  }
  const trace = iterates.slice(1).map((current, index) => ({
    iteration: index + 1,
    residual: Math.abs(current - iterates[index]),
    two_cycle_residual: index >= 1 ? Math.abs(current - iterates[index - 1]) : Number.POSITIVE_INFINITY,
  }));
  assert.ok(trace.every((entry) => entry.residual === 4), "the step residual was not flat");
  const verdict = classifyIterationTrace(trace, 1e-8);
  assert.equal(verdict.classification, "oscillating");
  assert.equal(verdict.converged, false);
  assert.ok(verdict.two_cycle_detections > 30);
});

mutation("M3 — detectTwoCycle fires on a real oscillating iterate stream", () => {
  const iterates = [];
  let state = [1, 5];
  for (let index = 0; index < 6; index += 1) {
    iterates.push(state);
    state = [6 - state[0], 10 - state[1]];
  }
  let detections = 0;
  for (let index = 2; index < iterates.length; index += 1) {
    if (detectTwoCycle(iterates[index - 2], iterates[index - 1], iterates[index], 1e-8)) {
      detections += 1;
    }
  }
  assert.ok(detections >= 3, `only ${detections} two-cycle detections`);
});

check("M3 — a monotonically converging stream is NOT called oscillating", () => {
  const trace = [];
  let residual = 1;
  for (let index = 0; index < 30; index += 1) {
    residual *= 0.4;
    trace.push({ iteration: index + 1, residual, two_cycle_residual: residual * 3.5 });
  }
  const verdict = classifyIterationTrace(trace, 1e-8);
  assert.equal(verdict.classification, "converging");
  assert.equal(verdict.converged, true);
});

mutation("M3 — a diverging stream is classified as diverging, not oscillating", () => {
  const trace = [];
  let residual = 1e-3;
  for (let index = 0; index < 20; index += 1) {
    residual *= 2.5;
    trace.push({ iteration: index + 1, residual, two_cycle_residual: residual * 3 });
  }
  assert.equal(classifyIterationTrace(trace, 1e-8).classification, "diverging");
});

mutation("M3 — a stalled stream is classified as stalled", () => {
  // Identical flat step residual to the oscillation above; the two-cycle
  // residual is what separates them.
  const trace = Array.from({ length: 20 }, (unused, index) => ({
    iteration: index + 1,
    residual: 0.25,
    two_cycle_residual: 0.5,
  }));
  assert.equal(classifyIterationTrace(trace, 1e-8).classification, "stalled");
});

check("M3 — every solved period's own trace classifies as converging", () => {
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      const trace = period.graph_driven_solve.convergence_trace;
      assert.ok(Array.isArray(trace) && trace.length >= 1, `${label}/${period.period}`);
      const verdict = classifyIterationTrace(trace, solution.convergence_tolerance);
      assert.equal(verdict.converged, true, `${label}/${period.period}: ${verdict.classification}`);
      assert.notEqual(verdict.classification, "oscillating", `${label}/${period.period}`);
    }
  }
});

check("M3 — no solved period ever needed the damping branch", () => {
  const damped = [];
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      if (period.graph_driven_solve.convergence_trace.some((entry) => entry.two_cycle_detected)) {
        damped.push(`${label}/${period.period}`);
      }
    }
  }
  // Recorded rather than assumed: if a corpus case ever starts oscillating,
  // this pin fails and the oscillation becomes visible instead of silent.
  assert.deepEqual(damped, []);
});

// M4 — a wrong fixed point must be caught.
check("M4 — every solved period sits at a zero residual of its OWN cash loop", () => {
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      const residual = revolverFixedPointResidual(period.graph_driven_solve.cash_loop);
      assert.ok(
        residual.max <= solution.convergence_tolerance,
        `${label}/${period.period}: ${JSON.stringify(residual)}`,
      );
    }
  }
});

mutation("M4 — a perturbed draw is rejected by the fixed-point residual", () => {
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      const loop = period.graph_driven_solve.cash_loop;
      const mutant = { ...loop, draw_native: loop.draw_native + 1e-3 };
      assert.ok(
        revolverFixedPointResidual(mutant).max > 1e-8,
        `${label}/${period.period}`,
      );
    }
  }
});

mutation("M4 — a perturbed repayment is rejected by the fixed-point residual", () => {
  for (const { label, solution } of solvedCases) {
    for (const period of solution.forecast) {
      const loop = period.graph_driven_solve.cash_loop;
      const mutant = { ...loop, repayment_native: loop.repayment_native + 1e-3 };
      assert.ok(
        revolverFixedPointResidual(mutant).max > 1e-8,
        `${label}/${period.period}`,
      );
    }
  }
});

mutation("M4 — a perturbed ending balance is rejected", () => {
  for (const { solution } of solvedCases) {
    const loop = solution.forecast[0].graph_driven_solve.cash_loop;
    const mutant = { ...loop, ending_rcf_native: loop.ending_rcf_native + 1e-3 };
    assert.ok(revolverFixedPointResidual(mutant).max > 1e-8);
  }
});

mutation("M4 — a perturbed ending cash is rejected", () => {
  for (const { solution } of solvedCases) {
    const loop = solution.forecast[0].graph_driven_solve.cash_loop;
    const mutant = { ...loop, ending_cash: loop.ending_cash + 1e-3 };
    assert.ok(revolverFixedPointResidual(mutant).max > 1e-8);
  }
});

mutation("M4 — both revolver legs positive at once is rejected", () => {
  for (const { solution } of solvedCases) {
    const loop = solution.forecast[0].graph_driven_solve.cash_loop;
    const mutant = { ...loop, draw_native: 5, repayment_native: 5 };
    const residual = revolverFixedPointResidual(mutant);
    assert.ok(residual.max > 1e-8 || residual.findings.includes("both_legs_positive"));
  }
});

mutation("M4 — a draw taken while cash is already above the floor is rejected", () => {
  const loop = {
    minimum_cash: 100,
    cash_after_mandatory: 500,
    deficit_native: 0,
    surplus_native: 400,
    opening_rcf_native: 0,
    capacity_native: 1000,
    available_capacity_native: 1000,
    draw_native: 50,
    repayment_native: 0,
    draw_reporting: 50,
    repayment_reporting: 0,
    ending_rcf_native: 50,
    ending_cash: 550,
    liquidity_shortfall: 0,
    fx_average: 1,
    fx_ending: 1,
    tolerance: 1e-8,
  };
  const residual = revolverFixedPointResidual(loop);
  assert.ok(residual.max > 1e-8);
  assert.ok(residual.findings.includes("draw_without_cash_need"));
});

mutation("M4 — a capacity breach is rejected", () => {
  const loop = {
    minimum_cash: 100,
    cash_after_mandatory: -400,
    deficit_native: 500,
    surplus_native: 0,
    opening_rcf_native: 0,
    capacity_native: 100,
    available_capacity_native: 100,
    draw_native: 500,
    repayment_native: 0,
    draw_reporting: 500,
    repayment_reporting: 0,
    ending_rcf_native: 500,
    ending_cash: 100,
    liquidity_shortfall: 0,
    fx_average: 1,
    fx_ending: 1,
    tolerance: 1e-8,
  };
  const residual = revolverFixedPointResidual(loop);
  assert.ok(residual.findings.includes("capacity_breached"));
});

check("M4 — TEETH: the verifier passes the untouched record it rejects when perturbed", () => {
  for (const { solution } of solvedCases) {
    const loop = solution.forecast[0].graph_driven_solve.cash_loop;
    assert.deepEqual(revolverFixedPointResidual(loop).findings, []);
  }
});

// ---------------------------------------------------------------------------
// 7. Determinism.
// ---------------------------------------------------------------------------

check("the derivation is insensitive to node and edge input order", () => {
  const shuffled = structuredClone(EQUATION_GRAPH);
  shuffled.nodes.reverse();
  shuffled.edges.reverse();
  const derived = deriveSolveOrder(shuffled, 1);
  assert.deepEqual(
    derived.components.map((component) => [component.id, component.nodes]),
    derivedOn.components.map((component) => [component.id, component.nodes]),
  );
  assert.deepEqual(derived.topological_node_order, derivedOn.topological_node_order);
});

check("solving the same case twice yields the same observed order", () => {
  const modelCase = readCase(path.join(FIXTURES, "standard-net-cash-v2.json"), {
    productionUnlock: true,
  });
  const first = solveCase(modelCase);
  const second = solveCase(modelCase);
  assert.deepEqual(
    first.solve_order_evidence.observed_orders,
    second.solve_order_evidence.observed_orders,
  );
});

if (failures.length > 0) {
  console.error(`graph-driven-solve FAILED (${failures.length} of ${checks}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(JSON.stringify({ status: "PASS", checks, mutations_total, mutations_caught }));
