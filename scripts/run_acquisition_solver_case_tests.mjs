#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { solveCase } from "./lib/solver.mjs";
import {
  applyFundedAcquisitionRows,
  fundedAcquisitionCandidate,
  fundedAcquisitionRole,
} from "./lib/funded_acquisition_runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = process.argv[2] ?? path.join(root, "fixtures", "portable", "representative-model-case.json");
const base = JSON.parse(fs.readFileSync(fixture, "utf8"));

function clone(value) { return structuredClone(value); }
function normalise(value) { return String(value ?? "").toLowerCase().replaceAll(/[^a-z0-9]+/g, "_"); }
function forecastYears(modelCase) {
  return (modelCase.periods ?? []).filter((period) => period.status === "forecast").map((period) => Number(String(period.date ?? period.label).slice(0, 4)));
}
function mutateAcquisitionInputs(value, enabled, closeYear) {
  const seen = new Set();
  const visit = (node, acquisitionContext = false) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    for (const [key, entry] of Object.entries(node)) {
      const token = normalise(key);
      const nextContext = acquisitionContext || token.includes("acquisition") || token.includes("transaction");
      if (["transaction_enterprise_value", "transaction_value", "enterprise_value"].includes(token) && nextContext) node[key] = 1000;
      else if (["acquisition_debt_amount", "acquisition_debt", "debt_amount"].includes(token) && nextContext) node[key] = 400;
      else if (["close_year", "acquisition_close_year"].includes(token) && nextContext) node[key] = closeYear;
      else if (["close_month", "acquisition_close_month"].includes(token) && nextContext) node[key] = 6;
      else if (["entry_ev_ebitda", "entry_ev_to_ebitda", "entry_multiple"].includes(token) && nextContext) node[key] = 10;
      else if (["incremental_debt_rate", "acquisition_debt_rate", "incremental_rate"].includes(token) && nextContext) node[key] = 0.05;
      else if (["enabled", "acquisition_on", "adjustment_columns_on", "acquisition_case"].includes(token) && nextContext) {
        node[key] = typeof entry === "string" ? (enabled ? "On" : "Off") : enabled;
      } else visit(entry, nextContext);
    }
  };
  visit(value);
  value.acquisition ??= {};
  Object.assign(value.acquisition, {
    enabled,
    transaction_enterprise_value: 1000,
    acquisition_debt_amount: 400,
    close_year: closeYear,
    close_month: 6,
    entry_ev_ebitda: 10,
    incremental_debt_rate: 0.05,
  });
  value.controls ??= {};
  for (const key of ["acquisition_adjustments", "adjustment_columns", "acquisition_case"]) {
    if (key in value.controls) value.controls[key] = enabled ? "On" : "Off";
  }
}
function materialiseFundedRows(modelCase) {
  applyFundedAcquisitionRows(modelCase);
  for (const row of modelCase.statement_structure?.cash_flow ?? []) {
    if (!fundedAcquisitionRole(row)) continue;
    row.values ??= [null, null, null, null, null, null];
    for (let index = 0; index < 3; index += 1) {
      const candidate = fundedAcquisitionCandidate(modelCase, row, index);
      row.values[index + 3] = candidate.value;
      row.forecast_treatment = candidate.method;
      row.forecast_period_calculations ??= [null, null, null];
      row.forecast_period_calculations[index] = candidate.formula_spec;
    }
  }
}
function finite(value) { return value !== null && value !== undefined && Number.isFinite(Number(value)); }
function metric(period, names) {
  for (const name of names) if (finite(period?.[name])) return Number(period[name]);
  return null;
}
function assertMoved(onValue, offValue, predicate, label) {
  assert.ok(finite(onValue) && finite(offValue), `${label} is unavailable in solver output`);
  assert.ok(predicate(Number(onValue), Number(offValue)), `${label} did not move as required: on=${onValue}, off=${offValue}`);
}

const years = forecastYears(base);
assert.equal(years.length, 3);
const closeYear = years[1];
const offCase = clone(base);
const onCase = clone(base);
mutateAcquisitionInputs(offCase, false, closeYear);
mutateAcquisitionInputs(onCase, true, closeYear);
materialiseFundedRows(offCase);
materialiseFundedRows(onCase);

const off = solveCase(offCase);
const on = solveCase(onCase);
assert.equal(off.forecast.length, 3);
assert.equal(on.forecast.length, 3);
const closeIndex = 1;
const offClose = off.forecast[closeIndex];
const onClose = on.forecast[closeIndex];
const offBefore = off.forecast[0];
const onBefore = on.forecast[0];

// Before close the transaction case must be economically identical.
for (const key of ["cash_from_investing", "cash_from_financing", "gross_debt", "net_debt", "ending_cash", "rcf_draw"]) {
  if (finite(offBefore?.[key]) && finite(onBefore?.[key])) assert.equal(Number(onBefore[key]), Number(offBefore[key]), `${key} moved before close`);
}

assertMoved(
  metric(onClose, ["cash_from_investing", "investing_cash_flow"]),
  metric(offClose, ["cash_from_investing", "investing_cash_flow"]),
  (onValue, offValue) => onValue <= offValue - 999.99,
  "close-year investing cash",
);
assertMoved(
  metric(onClose, ["gross_debt", "ending_gross_debt"]),
  metric(offClose, ["gross_debt", "ending_gross_debt"]),
  (onValue, offValue) => onValue >= offValue + 399.99,
  "close-year gross debt",
);
assertMoved(
  metric(onClose, ["net_debt", "ending_net_debt"]),
  metric(offClose, ["net_debt", "ending_net_debt"]),
  (onValue, offValue) => onValue > offValue,
  "close-year net debt",
);
assertMoved(
  metric(onClose, ["gross_interest", "interest_expense", "net_interest"]),
  metric(offClose, ["gross_interest", "interest_expense", "net_interest"]),
  (onValue, offValue) => Math.abs(onValue) > Math.abs(offValue),
  "close-year interest",
);
const cashMoved = ["ending_cash", "rcf_draw", "rcf_repayment", "liquidity_shortfall"].some((key) =>
  finite(onClose?.[key]) && finite(offClose?.[key]) && Math.abs(Number(onClose[key]) - Number(offClose[key])) > 1e-6,
);
assert.ok(cashMoved, "Residual purchase funding did not reach cash/RCF mechanics");

// Acquisition debt remains outstanding after close unless an explicit supported repayment exists.
const onFinalDebt = metric(on.forecast[2], ["gross_debt", "ending_gross_debt"]);
const offFinalDebt = metric(off.forecast[2], ["gross_debt", "ending_gross_debt"]);
assertMoved(onFinalDebt, offFinalDebt, (onValue, offValue) => onValue >= offValue + 399.99, "post-close persistent debt");

console.log(JSON.stringify({
  status: "PASS",
  fixture,
  close_year: closeYear,
  checks: 11,
  close_year_delta: {
    cash_from_investing: metric(onClose, ["cash_from_investing", "investing_cash_flow"]) - metric(offClose, ["cash_from_investing", "investing_cash_flow"]),
    gross_debt: metric(onClose, ["gross_debt", "ending_gross_debt"]) - metric(offClose, ["gross_debt", "ending_gross_debt"]),
    net_debt: metric(onClose, ["net_debt", "ending_net_debt"]) - metric(offClose, ["net_debt", "ending_net_debt"]),
  },
}, null, 2));
