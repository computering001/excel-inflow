#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { EQUATION_GRAPH } from "./lib/equation_graph.mjs";
import {
  compileLayeredGraphConstitution,
  rowPlanConstitutionProjection,
  validateLayeredGraphConstitution,
} from "./lib/layered_graph_constitution.mjs";
import { hashValue } from "./lib/run_store.mjs";
import { compileRowPlan } from "./lib/row_plan.mjs";

const casePath = process.argv[2];
if (!casePath) {
  throw new Error("Usage: run_layered_graph_constitution_tests.mjs <model-case.json>");
}
const modelCase = JSON.parse(await fs.readFile(casePath, "utf8"));
const plan = compileRowPlan(modelCase);
const baseline = compileLayeredGraphConstitution(modelCase, plan);
assert.equal(baseline.status, "PASS", JSON.stringify(baseline.violations, null, 2));
assert.deepEqual(validateLayeredGraphConstitution(baseline), []);
assert.equal(
  baseline.row_plan_projection_sha256,
  hashValue(rowPlanConstitutionProjection(plan)),
  "The graph seal is not bound to the declared row-plan projection.",
);
const endingCash = plan.statement_rows.cash_flow.find(
  (row) => row.semantic_role === "ending_cash" || row.row_id === "ending_cash",
);
const openingCash = plan.statement_rows.cash_flow.find(
  (row) => row.semantic_role === "opening_cash" || row.row_id === "opening_cash",
);
assert(openingCash, "The cash-flow graph has no opening-cash node.");
assert.deepEqual(
  [...(openingCash.dependency_refs ?? [])].sort(),
  ["ending_cash"],
  "Opening cash does not declare its prior-period ending-cash dependency.",
);
assert(endingCash, "The cash-flow graph has no ending-cash node.");
assert.deepEqual(
  [...(endingCash.dependency_refs ?? [])].sort(),
  ["fx_effect_on_cash", "net_change_in_cash", "opening_cash"],
  "Ending cash does not declare the complete physical cash roll-forward.",
);
assert.equal(
  compileLayeredGraphConstitution(structuredClone(modelCase), structuredClone(plan)).closure_sha256,
  baseline.closure_sha256,
  "Identical graph inputs did not produce a stable closure hash.",
);
const finalRendererPlan = structuredClone(plan);
finalRendererPlan.broker_digest_bands = [{ sheet: "Broker 1", entries: [] }];
finalRendererPlan.label_indents = { 99: 1 };
assert.equal(
  compileLayeredGraphConstitution(modelCase, finalRendererPlan).row_plan_projection_sha256,
  baseline.row_plan_projection_sha256,
  "Renderer-only row-map metadata changed the explicitly scoped graph projection hash.",
);
const projectedMutation = structuredClone(plan);
projectedMutation.statement_rows.cash_flow.find(
  (row) => row.row_id === endingCash.row_id,
).row += 1;
assert.notEqual(
  compileLayeredGraphConstitution(modelCase, projectedMutation).row_plan_projection_sha256,
  baseline.row_plan_projection_sha256,
  "A physical statement-row projection mutation did not change the graph seal.",
);

function hasCode(artifact, code) {
  return artifact.violations.some((violation) => violation.code === code);
}

const mutations = [];
function mutation(name, mutate, expectedCode, options = {}) {
  const candidate = structuredClone(modelCase);
  const candidatePlan = structuredClone(plan);
  const candidateGraph = structuredClone(EQUATION_GRAPH);
  mutate(candidate, candidatePlan, candidateGraph);
  const artifact = compileLayeredGraphConstitution(candidate, candidatePlan, {
    equationGraph: candidateGraph,
  });
  assert.equal(artifact.status, "BLOCK", `${name} did not block.`);
  assert(hasCode(artifact, expectedCode), `${name} did not emit ${expectedCode}: ${JSON.stringify(artifact.violations)}`);
  if (options.expectHashChange !== false) {
    assert.notEqual(artifact.closure_sha256, baseline.closure_sha256, `${name} did not change graph closure.`);
  }
  mutations.push(name);
}

mutation("duplicate section-local stable row", (candidate) => {
  candidate.statement_structure.cash_flow.push(
    structuredClone(candidate.statement_structure.cash_flow.find((row) => row.row_type !== "header")),
  );
}, "STATEMENT_DUPLICATE_STABLE_ID");

mutation("orphan formula dependency", (candidate) => {
  const row = candidate.statement_structure.cash_flow.find((item) => item.calculation?.refs?.length);
  row.calculation.refs.push("node_that_does_not_exist");
}, "STATEMENT_ORPHAN_DEPENDENCY");

mutation("reverse cross-section dependency", (candidate) => {
  const income = candidate.statement_structure.income_statement.find((row) => row.row_type !== "header");
  const cash = candidate.statement_structure.cash_flow.find((row) => row.row_type !== "header");
  income.calculation = { operator: "link", refs: [cash.row_id] };
}, "STATEMENT_ILLEGAL_CROSS_SECTION_DEPENDENCY");

mutation("cross-section capture", (candidate) => {
  const income = candidate.statement_structure.income_statement.find((row) => row.row_type !== "header");
  const cash = candidate.statement_structure.cash_flow.find((row) => row.row_type !== "header");
  cash.forecast_capture_parent_id = income.row_id;
}, "STATEMENT_CROSS_SECTION_OR_ORPHAN_PARENT");

mutation("duplicate physical projection", (_candidate, candidatePlan) => {
  const rows = candidatePlan.statement_rows.income_statement.filter((row) => Number.isInteger(row.row));
  rows[1].row = rows[0].row;
}, "ROW_PLAN_MULTIPLE_WRITERS");

mutation("duplicate economic writer", (_candidate, _candidatePlan, graph) => {
  graph.nodes.push({ ...structuredClone(graph.nodes[0]), id: `${graph.nodes[0].id}.duplicate` });
}, "ECONOMIC_MULTIPLE_WRITERS");

mutation("orphan economic edge", (_candidate, _candidatePlan, graph) => {
  graph.edges.push({
    ...structuredClone(graph.edges[0]),
    id: "mutation.orphan",
    to: "missing.economic.node",
  });
}, "ECONOMIC_ORPHAN_EDGE");

const tampered = structuredClone(baseline);
tampered.layers[1].nodes[0].row_type = "tampered";
assert(
  validateLayeredGraphConstitution(tampered).some((message) => message.includes("graph hash")),
  "Layer-content mutation did not invalidate the persisted graph hash.",
);

console.log(JSON.stringify({
  status: "PASS",
  baseline_closure_sha256: baseline.closure_sha256,
  layers: baseline.layer_hashes,
  positive_checks: 9,
  adversarial_mutations_caught: mutations.length + 1,
  total_violations: 0,
}, null, 2));
