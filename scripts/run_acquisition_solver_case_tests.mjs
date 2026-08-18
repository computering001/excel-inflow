#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyFundedAcquisitionRows } from "./lib/funded_acquisition_runtime.mjs";
import { solveCase, validateCaseShape } from "./lib/solver.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.resolve(
  process.argv[2] ??
    path.join(root, "test-fixtures", "cases", "standard-net-cash-v2.json"),
);
const source = JSON.parse(fs.readFileSync(fixture, "utf8"));
const base = structuredClone(source);
// The maintained fixtures are production-shaped custody inputs. Scenario
// mutations are deliberately forensic and must identify themselves as such;
// they may not impersonate production evidence after values have changed.
base.execution_profile = "reference_parity";
const edgeFixture = path.join(
  root,
  "test-fixtures",
  "cases",
  "standard-net-cash-v2.json",
);
const edgeBase = JSON.parse(fs.readFileSync(edgeFixture, "utf8"));
edgeBase.execution_profile = "reference_parity";

const clone = (value) => structuredClone(value);
const finite = (value) =>
  value !== null && value !== undefined && Number.isFinite(Number(value));
const metric = (period, names) => {
  for (const name of names) if (finite(period?.[name])) return Number(period[name]);
  return null;
};
const almostEqual = (left, right, tolerance = 1e-8) =>
  Math.abs(Number(left) - Number(right)) <=
  tolerance * Math.max(1, Math.abs(Number(left)), Math.abs(Number(right)));

function forecastYears(modelCase) {
  return (modelCase.periods ?? [])
    .filter((period) => period.status === "forecast")
    .map((period) => Number(String(period.date ?? period.label).slice(0, 4)));
}

function acquisitionCase(
  modelCase,
  { enabled, closeIndex, closeMonth = 6, enterpriseValue = 1000, debt = 400 },
) {
  const value = clone(modelCase);
  value.acquisition = {
    enabled: enabled ? 1 : 0,
    transaction_enterprise_value: enterpriseValue,
    entry_ev_to_ebitda: 10,
    acquisition_debt_amount: debt,
    incremental_rate: 0.05,
    close_year: forecastYears(value)[closeIndex],
    close_month: closeMonth,
  };
  const before = JSON.stringify(value.statement_structure);
  applyFundedAcquisitionRows(value);
  assert.equal(
    JSON.stringify(value.statement_structure),
    before,
    "Acquisition runtime contaminated standalone statement authority.",
  );
  return value;
}

function periodFraction(modelCase, closeIndex, closeMonth) {
  const periodIndex = closeIndex + 3;
  const day = 24 * 60 * 60 * 1000;
  const start = new Date(new Date(modelCase.periods[periodIndex - 1].date).getTime() + day);
  const end = new Date(modelCase.periods[periodIndex].date);
  const close = new Date(
    Date.UTC(forecastYears(modelCase)[closeIndex], closeMonth - 1, 1),
  );
  return (end.getTime() - close.getTime() + day) /
    (end.getTime() - start.getTime() + day);
}

function setMetric(modelCase, metricId, forecastValues, historicalTail = undefined) {
  const metricDefinition = modelCase.operating_metrics?.[metricId];
  assert.ok(metricDefinition, `Missing operating metric ${metricId}`);
  if (historicalTail !== undefined) metricDefinition.values[2] = historicalTail;
  metricDefinition.values.splice(3, 3, ...forecastValues);
  const brokerMetric = modelCase.broker_pack?.metrics?.[metricId];
  if (!brokerMetric) return;
  brokerMetric.provider_consensus = [...forecastValues];
  for (const broker of Object.keys(brokerMetric.brokers ?? {})) {
    brokerMetric.brokers[broker] = [...forecastValues];
  }
}

function assertBeforeCloseUnchanged(off, on, closeIndex) {
  for (let index = 0; index < closeIndex; index += 1) {
    for (const key of [
      "cash_from_investing",
      "cash_from_financing",
      "gross_debt",
      "net_debt",
      "ending_cash",
      "rcf_draw",
      "adjusted_ebitda",
      "pre_tax_income",
    ]) {
      if (finite(off.forecast[index]?.[key]) && finite(on.forecast[index]?.[key])) {
        assert.ok(
          almostEqual(on.forecast[index][key], off.forecast[index][key]),
          `${key} moved before close in forecast index ${index}`,
        );
      }
    }
  }
}

function solvePair(options) {
  const offCase = acquisitionCase(base, { ...options, enabled: false });
  const onCase = acquisitionCase(base, { ...options, enabled: true });
  assert.deepEqual(validateCaseShape(offCase), []);
  assert.deepEqual(validateCaseShape(onCase), []);
  const off = solveCase(offCase);
  const on = solveCase(onCase);
  assertBeforeCloseUnchanged(off, on, options.closeIndex);
  return { offCase, onCase, off, on };
}

assert.equal(forecastYears(base).length, 3);
assert.deepEqual(validateCaseShape(base), []);

const yearScenarios = [];
for (const closeIndex of [0, 1, 2]) {
  const closeMonth = closeIndex === 1 ? 6 : closeIndex === 0 ? 1 : 12;
  const pair = solvePair({ closeIndex, closeMonth, debt: 400 });
  const offClose = pair.off.forecast[closeIndex];
  const onClose = pair.on.forecast[closeIndex];
  assert.ok(
    almostEqual(onClose.acquisition_debt, 400),
    `Acquisition debt was not drawn in close year ${closeIndex + 1}`,
  );
  assert.ok(
    almostEqual(
      onClose.acquisition_interest,
      400 * 0.05 * periodFraction(pair.onCase, closeIndex, closeMonth),
    ),
    `Acquisition interest timing is wrong in close year ${closeIndex + 1}`,
  );
  assert.ok(
    metric(onClose, ["cash_from_investing", "investing_cash_flow"]) <=
      metric(offClose, ["cash_from_investing", "investing_cash_flow"]) - 999.99,
    `Consideration did not enter investing once in close year ${closeIndex + 1}`,
  );
  for (let index = closeIndex; index < 3; index += 1) {
    assert.ok(
      almostEqual(pair.on.forecast[index].acquisition_debt, 400),
      `Acquisition debt did not persist after close year ${closeIndex + 1}`,
    );
  }
  yearScenarios.push({
    close_year_index: closeIndex + 1,
    close_month: closeMonth,
    acquisition_interest: onClose.acquisition_interest,
  });
}

// The schema has always allowed zero acquisition debt. Prove the runtime and
// coverage-facing shape gate now honour that contract and fund the full
// consideration through cash/RCF without creating interest or debt proceeds.
const allCash = solvePair({ closeIndex: 0, closeMonth: 6, debt: 0 });
const allCashClose = allCash.on.forecast[0];
assert.equal(allCashClose.acquisition_debt, 0);
assert.equal(allCashClose.acquisition_debt_proceeds, 0);
assert.equal(allCashClose.acquisition_interest, 0);
assert.equal(allCashClose.acquisition_cash_consideration, 1000);
assert.ok(
  ["ending_cash", "rcf_draw", "rcf_repayment", "liquidity_shortfall"].some(
    (key) =>
      finite(allCashClose[key]) &&
      finite(allCash.off.forecast[0][key]) &&
      !almostEqual(allCashClose[key], allCash.off.forecast[0][key]),
  ),
  "All-cash consideration did not reach cash/RCF mechanics.",
);

// A debt-funded case has no residual purchase price for the cash/RCF waterfall.
const debtFunded = solvePair({ closeIndex: 2, closeMonth: 1, debt: 1000 });
assert.equal(debtFunded.on.forecast[2].acquisition_debt_proceeds, 1000);
assert.equal(debtFunded.on.forecast[2].acquisition_cash_consideration, 1000);

// A high target D&A burden creates a genuinely loss-making target at EBIT,
// independently of the already-covered negative-PBT/tax-benefit case.
const lossBase = clone(edgeBase);
setMetric(lossBase, "depreciation_and_amortisation", [400, 400, 400]);
setMetric(lossBase, "ebit", [-200, -200, -200]);
const lossOff = solveCase(
  acquisitionCase(lossBase, { enabled: false, closeIndex: 2 }),
);
const lossOn = solveCase(
  acquisitionCase(lossBase, { enabled: true, closeIndex: 2 }),
);
assert.ok(lossOn.forecast[2].adjusted_ebitda > lossOff.forecast[2].adjusted_ebitda);
assert.ok(
  lossOn.forecast[2].ebit < lossOff.forecast[2].ebit,
  "High target D&A did not produce a loss-making target EBIT contribution.",
);

// A non-positive standalone EBITDA margin cannot derive target revenue. The
// runtime must return an explicit zero target-revenue contribution, not divide
// by the margin or emit an Excel error.
const zeroRevenueBase = clone(edgeBase);
setMetric(zeroRevenueBase, "adjusted_ebitda", [-200, -200, -200], -200);
setMetric(zeroRevenueBase, "ebit", [-250, -250, -250], -250);
const zeroRevenueOff = solveCase(
  acquisitionCase(zeroRevenueBase, { enabled: false, closeIndex: 2 }),
);
const zeroRevenueOn = solveCase(
  acquisitionCase(zeroRevenueBase, { enabled: true, closeIndex: 2 }),
);
assert.ok(
  almostEqual(zeroRevenueOn.forecast[2].revenue, zeroRevenueOff.forecast[2].revenue),
  "Zero target revenue changed the pro-forma revenue amount.",
);
assert.ok(
  zeroRevenueOn.forecast[2].adjusted_ebitda >
    zeroRevenueOff.forecast[2].adjusted_ebitda,
  "Zero target revenue incorrectly suppressed derived target EBITDA.",
);

const zeroStandaloneBase = clone(edgeBase);
setMetric(zeroStandaloneBase, "adjusted_ebitda", [0, 0, 0], 0);
setMetric(zeroStandaloneBase, "ebit", [-50, -50, -50], -50);
assert.throws(
  () =>
    solveCase(
      acquisitionCase(zeroStandaloneBase, {
        enabled: true,
        closeIndex: 1,
      }),
    ),
  /prior standalone EBITDA is zero or unavailable/,
);

const inconsistentUnits = acquisitionCase(base, {
  enabled: true,
  closeIndex: 1,
});
inconsistentUnits.issuer.units = "USD millions";
assert.ok(
  validateCaseShape(inconsistentUnits).some((message) =>
    message.includes("issuer.units"),
  ),
  "Inconsistent acquisition units did not fail case validation.",
);

const afterHorizon = acquisitionCase(base, {
  enabled: true,
  closeIndex: 2,
});
afterHorizon.acquisition.close_year = forecastYears(afterHorizon)[2] + 1;
assert.ok(
  validateCaseShape(afterHorizon).some((message) =>
    message.includes("close date must fall within"),
  ),
  "A close after the forecast horizon did not fail case validation.",
);

const negativeDebt = acquisitionCase(base, {
  enabled: true,
  closeIndex: 1,
  debt: -1,
});
assert.ok(
  validateCaseShape(negativeDebt).some((message) =>
    message.includes("greater than or equal to zero"),
  ),
  "Negative acquisition debt did not fail case validation.",
);

// Repeated independent solves prove that no solver state latches across the
// same Off -> On -> Off -> On transition required from the workbook surface.
const transitionCases = [false, true, false, true].map((enabled) =>
  acquisitionCase(base, { enabled, closeIndex: 1, closeMonth: 6, debt: 400 }),
);
const transitionSolutions = transitionCases.map((modelCase) => solveCase(modelCase));
assert.deepEqual(transitionSolutions[0], transitionSolutions[2]);
assert.deepEqual(transitionSolutions[1], transitionSolutions[3]);

console.log(
  JSON.stringify(
    {
      schema_version: "acquisition-solver-scenarios/2.0",
      status: "PASS",
      source_fixture: fixture,
      edge_fixture: edgeFixture,
      source_execution_profile: source.execution_profile ?? null,
      scenario_execution_profile: base.execution_profile,
      scenarios: {
        off: "PASS",
        all_cash: "PASS",
        acquisition_debt: "PASS",
        rcf_residual_and_mixed_funding: "PASS",
        year_1_2_3_and_mid_year_interest: yearScenarios,
        loss_making_target: "PASS",
        zero_target_revenue: "PASS",
        zero_standalone_ebitda: "REJECTED",
        inconsistent_input_units: "REJECTED",
        close_after_forecast_horizon: "REJECTED",
        negative_acquisition_debt: "REJECTED",
        off_on_off_on_restoration: "PASS",
      },
    },
    null,
    2,
  ),
);
