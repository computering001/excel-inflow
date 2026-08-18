#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildForecastAuthorityLedger,
  sealForecastAuthorityLedger,
  verifyForecastAuthorityLedger,
} from "./lib/forecast_authority_ledger.mjs";
import fs from "node:fs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import { buildOwnershipCensus } from "./lib/ownership_census.mjs";

const periods = [
  "2023-12-31",
  "2024-12-31",
  "2025-12-31",
  "2026-12-31",
  "2027-12-31",
  "2028-12-31",
].map((date, index) => ({
  date,
  status: index < 3 ? "historical" : "forecast",
}));
const auth = (value) => ({
  method: "company_guidance",
  value,
  source_kind: "company_guidance",
  source_id: "g",
  material: true,
  status: "PASS",
});
const modelCase = {
  case_id: "ledger",
  periods,
  instruments: [{
    instrument_id: "bond_a",
    class: "bond_fixed",
    source_line_ids: ["debt.note_1"],
  }],
  statement_structure: {
    income_statement: [{
      row_id: "revenue",
      semantic_role: "revenue",
      values: [1, 2, 3, 4, 5, 6],
      forecast_period_authorities: [auth(4), auth(5), auth(6)],
    }],
    cash_flow: [{
      row_id: "acq",
      semantic_role: "acquisitions_net_of_cash",
      values: [-1, -2, -3, 0, 0, 0],
      forecast_period_authorities: [0, 1, 2].map(() => ({
        method: "explicit_zero",
        value: 0,
        source_kind: "historical_inference",
        source_id: "semantic-event-backstop:acq",
      })),
    }],
  },
};

const ledger = sealForecastAuthorityLedger(modelCase);
assert.equal(ledger.status, "PASS");
assert.equal(ledger.rows.length, 6);
const ledgerSchema = JSON.parse(fs.readFileSync(new URL("../assets/forecast-authority-ledger-v2.schema.json", import.meta.url), "utf8"));
assert.deepEqual(validateJsonSchema(ledger, ledgerSchema), []);
assert.equal(ledger.selected_metric_traces.length, 6);
assert.deepEqual(
  [...new Set(ledger.rows.map((row) => row.disposition))],
  ["authority_selected"],
  "The ledger omitted the explicit economic disposition for selected authority rows.",
);
verifyForecastAuthorityLedger(modelCase);
const sealedModelCase = structuredClone(modelCase);
const censusSchema = JSON.parse(fs.readFileSync(new URL("../assets/ownership-census-v1.schema.json", import.meta.url), "utf8"));
assert.deepEqual(validateJsonSchema(modelCase.ownership_census, censusSchema), []);
assert.ok(modelCase.ownership_census.records.length > 100);
assert.deepEqual(
  [...new Set(modelCase.ownership_census.records.map((row) => row.visible_region))].sort(),
  [
    "adjustment_columns", "cash_flow", "debt_schedule", "income_statement",
    "interest_schedule", "leverage_liquidity", "pro_forma_columns", "rcf_waterfall",
  ],
  "The census omitted a visible economic region.",
);
assert.deepEqual(
  [...new Set(modelCase.ownership_census.records.map((row) => row.cell_class))].sort(),
  [
    "controlled_adjustment", "instrument_balance", "pro_forma_amount",
    "ratio", "schedule_amount", "statement_amount",
  ],
  "The census omitted a visible economic cell class.",
);
assert.deepEqual(
  [...new Set(modelCase.ownership_census.records.map((row) => row.column_role))].sort(),
  ["adjustment", "forecast", "historical", "pro_forma_forecast", "pro_forma_reference"],
  "The census omitted a visible economic column role.",
);
assert.equal(
  new Set(modelCase.ownership_census.records.map((row) => row.cell_key)).size,
  modelCase.ownership_census.records.length,
  "The ownership census contains duplicate visible-cell keys.",
);
for (const requiredRow of [
  "gross_debt_excluding_leases", "net_debt_to_adjusted_ebitda", "total_liquidity",
  "rcf_draw", "gross_interest_expense",
]) {
  assert.ok(
    modelCase.ownership_census.records.some((row) => row.row_id === requiredRow),
    `The ownership census omitted ${requiredRow}.`,
  );
}
assert.deepEqual(
  [...new Set(modelCase.ownership_census.records.filter((row) =>
    ["income_statement", "cash_flow"].includes(row.visible_region) && row.period_status === "historical"
  ).map((row) => row.historical_owner))],
  ["source_input"],
);
assert.deepEqual(
  [...new Set(modelCase.ownership_census.records.filter((row) =>
    row.visible_region === "income_statement" && row.row_id === "revenue" && row.period_status === "forecast"
  ).map((row) => row.forecast_owner))],
  ["guidance_owned"],
);
const before = ledger.ledger_sha256;

const storedBodyTamper = structuredClone(modelCase);
storedBodyTamper.forecast_authority_ledger.rows[0].value = 999;
assert.throws(
  () => verifyForecastAuthorityLedger(storedBodyTamper),
  /drift/,
  "A stored ledger-body mutation was accepted because only the copied digest was compared.",
);

modelCase.statement_structure.income_statement[0]
  .forecast_period_authorities[0].value = 99;
assert.throws(() => verifyForecastAuthorityLedger(modelCase), /drift/);

const bad = structuredClone(modelCase);
delete bad.forecast_authority_ledger;
delete bad.forecast_authority_ledger_version;
bad.statement_structure.cash_flow[0]
  .forecast_period_authorities[0].method = "historical_average";
assert.equal(buildForecastAuthorityLedger(bad).status, "BLOCK");

const missingDisposition = structuredClone(modelCase);
delete missingDisposition.forecast_authority_ledger;
delete missingDisposition.forecast_authority_ledger_version;
missingDisposition.statement_structure.cash_flow.push({
  row_id: "unowned_material_row",
  semantic_role: "other_operating_cash_flow",
  row_type: "input",
  material: true,
  values: [1, 2, 3],
});
const missingDispositionLedger = buildForecastAuthorityLedger(missingDisposition);
assert.equal(missingDispositionLedger.status, "BLOCK");
assert.equal(
  missingDispositionLedger.rows.filter((row) => row.row_id === "unowned_material_row").length,
  3,
  "A material row without an authority array disappeared from the economic census.",
);
assert.ok(
  missingDispositionLedger.rows
    .filter((row) => row.row_id === "unowned_material_row")
    .every((row) => row.disposition === "unresolved_block" && row.status === "BLOCK"),
  "A missing material disposition was not represented as a typed unresolved block.",
);

const classifierFailure = structuredClone(modelCase);
delete classifierFailure.forecast_authority_ledger;
delete classifierFailure.forecast_authority_ledger_version;
delete classifierFailure.statement_structure.income_statement[0].row_id;
const classifierFailureLedger = buildForecastAuthorityLedger(classifierFailure);
assert.equal(classifierFailureLedger.status, "BLOCK");
assert.ok(
  classifierFailureLedger.violations.some((finding) =>
    finding.includes("forecast behavior classification failed")),
  "A behavior-classification exception was silently swallowed by the authority ledger.",
);

const doubleOwned = structuredClone(modelCase);
delete doubleOwned.ownership_census;
delete doubleOwned.ownership_census_version;
doubleOwned.statement_structure.income_statement.push({
  row_id: "revenue_child",
  parent_row_id: "revenue",
  row_type: "input",
  values: [1, 2, 3],
  forecast_period_authorities: [auth(1), auth(2), auth(3)],
});
const doubleOwnedCensus = buildOwnershipCensus(doubleOwned);
assert.equal(doubleOwnedCensus.status, "BLOCK");
assert.ok(doubleOwnedCensus.violations.every((finding) => finding.includes("both own forecasts")));

for (const rowId of ["gross_debt_excluding_leases", "net_debt_to_adjusted_ebitda"]) {
  const missingRegionCell = structuredClone(sealedModelCase);
  missingRegionCell.ownership_census.records = missingRegionCell.ownership_census.records.filter(
    (row) => row.row_id !== rowId,
  );
  assert.throws(
    () => verifyForecastAuthorityLedger(missingRegionCell),
    /ownership census drift/,
    `Deleting every ${rowId} ownership cell was not detected.`,
  );
}

const selfConfirmingLeverage = structuredClone(sealedModelCase);
const leverageCell = selfConfirmingLeverage.ownership_census.records.find(
  (row) => row.row_id === "net_debt_to_adjusted_ebitda" && row.period_status === "forecast",
);
leverageCell.forecast_owner = "user_assumption";
leverageCell.visible_mechanism = "visible_hardcode";
assert.throws(
  () => verifyForecastAuthorityLedger(selfConfirmingLeverage),
  /ownership census drift/,
  "A formula-owned leverage cell could be relabelled as a user hardcode.",
);

console.log(JSON.stringify({ status: "PASS", checks: 27, sha: before }));
