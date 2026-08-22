#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createRunner } from "./lib/test_harness.mjs";
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

const run = createRunner({
  name: "ebitda_basis_contract_tests",
  importMetaUrl: import.meta.url,
});
const read = (relative) => fs.readFileSync(path.join(run.ROOT, relative), "utf8");
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

run.check("sole reported-EBITDA row is selected verbatim", () => {
  assert.equal(selectedEbitdaRow([reported]), reported);
  return true;
});
run.check("reported EBITDA loses selection to an adjusted definition", () => {
  assert.equal(selectedEbitdaRow([reported, adjusted]), adjusted);
  return true;
});
run.check("reported basis keeps the plain EBITDA label", () => {
  assert.equal(ebitdaBasis(reported).label, "EBITDA");
  return true;
});
run.check("adjusted basis keeps the Adjusted EBITDA label", () => {
  assert.equal(ebitdaBasis(adjusted).label, "Adjusted EBITDA");
  return true;
});
run.check("reported_ebitda is an EBITDA semantic role", () => {
  assert.equal(isEbitdaSemanticRole("reported EBITDA"), true);
  return true;
});
run.check("adjusted_ebitda is an EBITDA semantic role", () => {
  assert.equal(isEbitdaSemanticRole("adjusted EBITDA"), true);
  return true;
});
run.check("EBIT alone is not an EBITDA semantic role", () => {
  assert.equal(isEbitdaSemanticRole("EBIT"), false);
  return true;
});

const reportedPresentation = creditMetricEbitdaPresentation(
  [reported],
  "Net debt (incl. leases)",
);
run.check("sole-row presentation binds the reported row itself", () => {
  assert.equal(reportedPresentation.row, reported);
  return true;
});
run.check("reported presentation states net-debt leverage over EBITDA", () => {
  assert.equal(reportedPresentation.net_debt_leverage, "Net debt (incl. leases) / EBITDA");
  return true;
});
run.check("reported presentation states EBITDA coverage of interest", () => {
  assert.equal(reportedPresentation.coverage, "EBITDA / net interest expense");
  return true;
});
run.check("reported presentation never mentions adjusted EBITDA", () => {
  assert(!JSON.stringify(reportedPresentation).includes("Adjusted EBITDA"));
  return true;
});

const adjustedPresentation = creditMetricEbitdaPresentation(
  [adjusted],
  "Net debt (excl. leases)",
);
run.check("adjusted presentation states leverage over Adjusted EBITDA", () => {
  assert.equal(
    adjustedPresentation.net_debt_leverage,
    "Net debt (excl. leases) / Adjusted EBITDA",
  );
  return true;
});
run.check("adjusted presentation states Adjusted EBITDA coverage of interest", () => {
  assert.equal(
    adjustedPresentation.coverage,
    "Adjusted EBITDA / net interest expense",
  );
  return true;
});

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
run.check("a complete reported basis validates against the contract schema", () => {
  assert.deepEqual(validateJsonSchema(validBasis, basisSchema), []);
  return true;
});
run.check("a relabelled basis fails the contract schema", () => {
  assert.notDeepEqual(
    validateJsonSchema({ ...validBasis, label: "EBITDA proxy" }, basisSchema),
    [],
  );
  return true;
});
run.check("impairment-included basis fails the contract schema", () => {
  assert.notDeepEqual(
    validateJsonSchema({ ...validBasis, impairment_included: true }, basisSchema),
    [],
  );
  return true;
});

// Exercise the actual row planner and economic graph with a reported-EBITDA
// definition while retaining the legacy physical row ID used by v2 workbooks.
const modelCase = JSON.parse(read("test-fixtures/cases/standard-maximal-v2.json"));
const ebitdaRow = modelCase.statement_structure.income_statement.find(
  (row) => row.semantic_role === "adjusted_ebitda",
);
run.check("fixture has an EBITDA row to retype", () => {
  assert(ebitdaRow, "fixture has no EBITDA row to retype");
  return true;
});
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
run.check("retyped reported EBITDA survives the row plan projection", () => {
  assert(plannedEbitda, "reported EBITDA was projected out of the debt overlay");
  return true;
});
run.check("projected row keeps the reported_ebitda role", () => {
  assert.equal(plannedEbitda.semantic_role, "reported_ebitda");
  return true;
});
const fcfConversion = rowPlan.statement_rows.cash_flow.find(
  (row) => row.row_id === "free_cash_flow_conversion",
);
run.check("FCF conversion consumes the selected EBITDA row", () => {
  assert.equal(
    fcfConversion.calculation.refs[1],
    plannedEbitda.row_id,
    "FCF conversion does not consume the selected EBITDA row",
  );
  return true;
});

const semanticManifest = compileSemanticManifest(modelCase, rowPlan);
const leverageEdge = semanticManifest.edges.find(
  (edge) => edge.from === "mechanical.leverage_adjusted_ebitda",
);
run.check("leverage keeps a statement EBITDA dependency edge", () => {
  assert(leverageEdge, "leverage has no statement EBITDA dependency");
  return true;
});
const leverageTarget = semanticManifest.nodes.find(
  (node) => node.node_id === leverageEdge.to,
);
run.check("leverage binds to the selected reported-EBITDA node", () => {
  assert.equal(
    leverageTarget.semantic_role,
    "reported_ebitda",
    "leverage is not bound to the selected reported-EBITDA node",
  );
  return true;
});

for (const relative of [
  "scripts/lib/case_compiler.mjs",
  "scripts/lib/case_source_proposer.mjs",
  "scripts/build_dynamic_model.mjs",
]) {
  run.check(`${relative} authors no proxy KPI`, () => {
    assert.equal(
      read(relative).includes("EBITDA proxy"),
      false,
      `${relative} still authors a proxy KPI`,
    );
    return true;
  });
}

run.finish();
