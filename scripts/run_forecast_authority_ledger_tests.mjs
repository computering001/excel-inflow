#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildForecastAuthorityLedger,
  sealForecastAuthorityLedger,
  verifyForecastAuthorityLedger,
} from "./lib/forecast_authority_ledger.mjs";

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
verifyForecastAuthorityLedger(modelCase);
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

console.log(JSON.stringify({ status: "PASS", checks: 6, sha: before }));
