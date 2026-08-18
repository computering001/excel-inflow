#!/usr/bin/env node
/**
 * Forecast Completion Constitution + economic stage parity regression.
 *
 * Proves: every material row × period receives exactly one lawful
 * disposition; residual unresolved cells ESCALATE (never silently pass);
 * the parity receipt binds the case identity and refuses an incomplete
 * graph; a mutated case fails verification.
 */

import assert from "node:assert/strict";

import {
  LAWFUL_DISPOSITIONS,
  compileForecastCompletionCensus,
  sealEconomicStageParity,
  verifyEconomicStageParity,
} from "./lib/forecast_completion_constitution.mjs";

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

const authority = (method, extra = {}) => ({ method, ...extra });
const row = (row_id, overrides = {}) => ({ row_id, row_type: "input", values: [1, 2, 3, null, null, null], ...overrides });

const completeCase = {
  case_id: "census-fixture",
  statement_structure: {
    income_statement: [
      row("revenue", { forecast_period_authorities: [authority("broker_consensus"), authority("company_guidance"), authority("user_assumption")] }),
      row("ebitda", { row_type: "calculation", calculation: { operator: "sum", refs: ["revenue"] }, forecast_period_authorities: [authority("accounting_identity"), authority("accounting_identity"), authority("accounting_identity")] }),
      row("effective_tax_rate", {
        semantic_role: "effective_tax_rate",
        forecast_period_authorities: [0, 1, 2].map(() =>
          authority("historical_average", { tax_rate_normalization: { schema_version: "excel-inflow-tax-rate-policy/1.0" } })),
      }),
      row("interest", { forecast_period_authorities: [authority("schedule_link"), authority("schedule_link"), authority("schedule_link")] }),
    ],
    cash_flow: [
      row("wc_detail", { forecast_period_authorities: [authority("not_separately_forecast"), authority("not_separately_forecast"), authority("not_separately_forecast")], forecast_capture_parent_id: "change_in_working_capital" }),
      row("dividends", { forecast_period_authorities: [authority("historical_average"), authority("historical_average"), authority("carry_forward")] }),
    ],
  },
};

// 1. a complete case: PASS, every cell lawful, dispositions well typed
{
  const census = compileForecastCompletionCensus(completeCase);
  check(census.status === "PASS", "a complete case must pass the census");
  check(census.cell_count === 18, "every row x period is enumerated");
  check(census.cells.every((cell) => LAWFUL_DISPOSITIONS.includes(cell.disposition)),
    "every cell carries a lawful disposition");
  check(census.disposition_counts.role_policy_owned === 3, "the tax policy periods are typed role_policy_owned");
  check(census.disposition_counts.captured_by_parent === 3, "captured detail is typed captured_by_parent");
  check(census.disposition_counts.schedule_owned === 3, "schedule links are typed schedule_owned");
}

// 2. an unresolved material cell ESCALATES with a named reason — no silent pass
{
  const broken = structuredClone(completeCase);
  broken.statement_structure.cash_flow[1].forecast_period_authorities[1] = { method: "unresolved" };
  const census = compileForecastCompletionCensus(broken);
  check(census.status === "ESCALATE", "an unresolved material cell escalates");
  check(census.escalations.length === 1 && census.escalations[0].row_id === "dividends",
    "the escalation names the exact cell");
  check(census.cells.some((cell) => cell.disposition === "unresolved"), "the census does not hide the state");
}

// 3. parity: seals a complete case, binds the identity, refuses an incomplete one
{
  const receipt = sealEconomicStageParity(completeCase);
  check(receipt.status === "PASS" && /^[0-9a-f]{64}$/.test(receipt.receipt_sha256), "parity receipt seals");
  check(verifyEconomicStageParity(completeCase, receipt).length === 0, "the receipt verifies against the same case");
  const mutated = structuredClone(completeCase);
  mutated.statement_structure.income_statement[0].values[3] = 999;
  check(verifyEconomicStageParity(mutated, receipt).includes("model_case_sha256"),
    "a mutated case fails parity verification");
  const broken = structuredClone(completeCase);
  broken.statement_structure.income_statement[0].forecast_period_authorities = undefined;
  let refused = false;
  try { sealEconomicStageParity(broken); } catch { refused = true; }
  check(refused, "parity refuses an incomplete economic graph");
}

console.log(JSON.stringify({ checks, status: "PASS" }));
