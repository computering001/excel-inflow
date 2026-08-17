#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  creditMetricEbitdaPresentation,
} from "./build_dynamic_model.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import { compileRowPlan } from "./lib/row_plan.mjs";
import { compileSemanticManifest } from "./lib/semantic_graph.mjs";
import {
  ebitdaBasis,
  isEbitdaSemanticRole,
  selectedEbitdaRow,
} from "./lib/semantic_roles.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, ROOT), "utf8");
const schema = JSON.parse(read("assets/model-case-v2.schema.json"));
const basisSchema = {
  ...schema.$defs.ebitdaBasis,
  $defs: schema.$defs,
};

const reported = {
  row_id: "issuer_ebitda",
  semantic_role: "reported_ebitda",
  label: "EBITDA",
  row: 20,
};
const adjusted = {
  row_id: "issuer_adjusted_ebitda",
  semantic_role: "adjusted_ebitda",
  label: "Adjusted EBITDA",
  row: 21,
};

assert.equal(selectedEbitdaRow([reported]), reported);
assert.equal(selectedEbitdaRow([reported, adjusted]), adjusted);
assert.equal(ebitdaBasis(reported).label, "EBITDA");
assert.equal(ebitdaBasis(adjusted).label, "Adjusted EBITDA");
assert.equal(isEbitdaSemanticRole("reported EBITDA"), true);
assert.equal(isEbitdaSemanticRole("adjusted EBITDA"), true);
assert.equal(isEbitdaSemanticRole("EBIT"), false);

const reportedPresentation = creditMetricEbitdaPresentation(
  [reported],
  "Net debt (incl. leases)",
);
assert.equal(reportedPresentation.row, reported);
assert.equal(reportedPresentation.net_debt_leverage, "Net debt (incl. leases) / EBITDA");
assert.equal(reportedPresentation.coverage, "EBITDA / net interest expense");
assert(!JSON.stringify(reportedPresentation).includes("Adjusted EBITDA"));

const adjustedPresentation = creditMetricEbitdaPresentation(
  [adjusted],
  "Net debt (excl. leases)",
);
assert.equal(
  adjustedPresentation.net_debt_leverage,
  "Net debt (excl. leases) / Adjusted EBITDA",
);
assert.equal(
  adjustedPresentation.coverage,
  "Adjusted EBITDA / net interest expense",
);

const validBasis = {
  row_id: "issuer_ebitda",
  semantic_role: "reported_ebitda",
  label: "EBITDA",
  margin_label: "EBITDA margin",
  adjustment_basis: "reported",
  derivation: "reported_ebit_plus_compatible_da",
  source_row_ids: ["operating_profit", "depreciation_and_amortisation"],
  impairment_included: false,
};
assert.deepEqual(validateJsonSchema(validBasis, basisSchema), []);
assert.notDeepEqual(
  validateJsonSchema({ ...validBasis, label: "EBITDA proxy" }, basisSchema),
  [],
);
assert.notDeepEqual(
  validateJsonSchema({ ...validBasis, impairment_included: true }, basisSchema),
  [],
);

// Exercise the actual row planner and economic graph with a reported-EBITDA
// definition while retaining the legacy physical row ID used by v2 workbooks.
const modelCase = JSON.parse(read("test-fixtures/cases/standard-maximal-v2.json"));
const ebitdaRow = modelCase.statement_structure.income_statement.find(
  (row) => row.semantic_role === "adjusted_ebitda",
);
assert(ebitdaRow, "fixture has no EBITDA row to retype");
ebitdaRow.semantic_role = "reported_ebitda";
ebitdaRow.label = "EBITDA";
ebitdaRow.ebitda_basis = validBasis;
delete ebitdaRow.broker_metric_id;
ebitdaRow.forecast_treatment = "formula";
ebitdaRow.forecast_calculation = structuredClone(ebitdaRow.calculation);
for (const row of modelCase.statement_structure.income_statement) {
  if (row.row_id === "adjusted_ebitda_margin") row.label = "EBITDA margin";
  if (row.row_id === "adjusted_ebitda_bridge") row.label = "EBITDA bridge";
}
modelCase.selected_ebitda_basis = validBasis;

const rowPlan = compileRowPlan(modelCase);
const plannedEbitda = selectedEbitdaRow(rowPlan.statement_rows.income_statement);
assert(plannedEbitda, "reported EBITDA was projected out of the debt overlay");
assert.equal(plannedEbitda.semantic_role, "reported_ebitda");
const fcfConversion = rowPlan.statement_rows.cash_flow.find(
  (row) => row.row_id === "free_cash_flow_conversion",
);
assert.equal(
  fcfConversion.calculation.refs[1],
  plannedEbitda.row_id,
  "FCF conversion does not consume the selected EBITDA row",
);

const semanticManifest = compileSemanticManifest(modelCase, rowPlan);
const leverageEdge = semanticManifest.edges.find(
  (edge) => edge.from === "mechanical.leverage_adjusted_ebitda",
);
assert(leverageEdge, "leverage has no statement EBITDA dependency");
const leverageTarget = semanticManifest.nodes.find(
  (node) => node.node_id === leverageEdge.to,
);
assert.equal(
  leverageTarget.semantic_role,
  "reported_ebitda",
  "leverage is not bound to the selected reported-EBITDA node",
);

for (const relative of [
  "scripts/lib/case_compiler.mjs",
  "scripts/lib/case_source_proposer.mjs",
  "scripts/build_dynamic_model.mjs",
]) {
  assert.equal(
    read(relative).includes("EBITDA proxy"),
    false,
    `${relative} still authors a proxy KPI`,
  );
}

console.log(JSON.stringify({ status: "PASS", checks: 24 }, null, 2));
