#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  leaseForecast,
  leaseProjectionErrors,
  validateLeasePolicy,
} from "./lib/lease_policy.mjs";
import { migrateLegacyDebtClasses } from "./lib/debt_class.mjs";
import { sealForecastAuthorityLedger } from "./lib/forecast_authority_ledger.mjs";
import { solveCase } from "./lib/solver.mjs";

const baseCase = (leasePolicy, accountingBasis = "IFRS") => ({
  issuer: { accounting_basis: accountingBasis },
  lease_policy: leasePolicy,
});
const rounded = (values) => values.map((value) => Number(value.toFixed(6)));
const common = {
  historical_liabilities: [80, 90, 100],
  principal_repayment: [10, 12, 14],
  additions: [15, 18, 21],
  effective_rate: [0.05, 0.05, 0.05],
  include_in_gross_debt: true,
  include_in_net_debt: true,
  include_in_leverage: true,
};

const simpleCase = baseCase({ ...common, mode: "simple_roll_forward" });
const simple = leaseForecast(simpleCase);
assert.deepEqual(rounded(simple.map((period) => period.opening_total)), [100, 110.25641, 122.064431]);
assert.deepEqual(rounded(simple.map((period) => period.ending_total)), [110.25641, 122.064431, 135.503633]);
assert.deepEqual(simple.map((period) => period.additions), [15, 18, 21]);
assert.deepEqual(simple.map((period) => period.principal_repayment), [10, 12, 14]);
assert.deepEqual(rounded(simple.map((period) => period.interest)), [5.25641, 5.808021, 6.439202]);
assert.deepEqual(leaseProjectionErrors(simpleCase, simple), []);
assert.deepEqual(validateLeasePolicy(simpleCase), []);

const flatCase = baseCase({ ...common, mode: "flat_replacement" });
const flat = leaseForecast(flatCase);
assert.deepEqual(flat.map((period) => period.ending_total), [100, 100, 100]);
assert.deepEqual(flat.map((period) => period.additions), [5, 7, 9]);
assert.deepEqual(leaseProjectionErrors(flatCase, flat), []);

const sourcedCase = baseCase({
  ...common,
  mode: "sourced_balance",
  forecast_liabilities: [95, 85, 70],
});
const sourced = leaseForecast(sourcedCase);
assert.deepEqual(sourced.map((period) => period.ending_total), [95, 85, 70]);
assert.deepEqual(sourced.map((period) => period.additions), [0.125, -2.5, -4.875]);
assert.deepEqual(leaseProjectionErrors(sourcedCase, sourced), []);

const otherMovementCase = baseCase({
  ...common,
  mode: "simple_roll_forward",
  other_movements: [2, -1, 3],
});
const otherMovement = leaseForecast(otherMovementCase);
assert.deepEqual(otherMovement.map((period) => period.other_movements), [2, -1, 3]);
assert.deepEqual(leaseProjectionErrors(otherMovementCase, otherMovement), []);

const separateCase = baseCase({
  ...common,
  mode: "simple_roll_forward",
  interest_basis: "separately_supplied",
  historical_interest_bearing_liabilities: [30, 28, 25],
  forecast_interest_bearing_liabilities: [22, 18, 15],
});
const separate = leaseForecast(separateCase);
assert.deepEqual(
  rounded(separate.map((period) => period.interest)),
  [1.175, 1, 0.825],
);
assert.deepEqual(leaseProjectionErrors(separateCase, separate), []);

const excludedCase = baseCase({ ...common, mode: "exclude" });
const excluded = leaseForecast(excludedCase);
assert.deepEqual(excluded.map((period) => period.ending_total), [0, 0, 0]);
assert.deepEqual(excluded.map((period) => period.interest), [0, 0, 0]);
assert.deepEqual(leaseProjectionErrors(excludedCase, excluded), []);

const usGaapInvalid = baseCase(
  { ...common, mode: "simple_roll_forward", interest_basis: "total_liability" },
  "US_GAAP",
);
assert(validateLeasePolicy(usGaapInvalid).some((message) => /US GAAP/.test(message)));

const mutations = [
  ["opening continuity", (projection) => { projection[1].opening_total += 1; }],
  ["closing equation", (projection) => { projection[0].ending_total += 1; }],
  ["interest-bearing basis", (projection) => { projection[2].ending_interest_bearing += 1; }],
  ["interest calculation", (projection) => { projection[0].interest += 1; }],
  ["principal leg", (projection) => { projection[2].principal_repayment += 1; }],
  ["other movement leg", (projection) => { projection[1].other_movements += 1; }],
];
for (const [label, mutate] of mutations) {
  const projection = structuredClone(simple);
  mutate(projection);
  assert.notDeepEqual(leaseProjectionErrors(simpleCase, projection), [], label);
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "excel-inflow-lease-contract."));
const productionPath = path.join(fixtureRoot, "model-case.json");
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL("./run_evidence_run_tests.mjs", import.meta.url)),
    fileURLToPath(new URL("../test-fixtures/cases", import.meta.url)),
    "--emit-compiled-case",
    productionPath,
    "--production",
  ],
  { stdio: "ignore" },
);
const productionCase = JSON.parse(fs.readFileSync(productionPath, "utf8"));
migrateLegacyDebtClasses(productionCase);
sealForecastAuthorityLedger(productionCase);
const solved = solveCase(productionCase);
assert.deepEqual(
  solved.forecast.map((period) => period.ending_lease),
  [20, 20, 20],
);
assert.deepEqual(
  solved.forecast.map((period) => period.lease_principal),
    [4, 4, 4],
);
assert.deepEqual(
  solved.forecast.map((period) => period.lease_additions),
  [3, 3, 3],
);
assert.deepEqual(
  solved.forecast.map((period) => period.lease_interest),
  [1, 1, 1],
);
assert.equal(solved.all_checks_pass, true);
fs.rmSync(fixtureRoot, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      status: "PASS",
      checks: 34,
      mutations: mutations.map(([label]) => label),
      production_case_exercised: true,
    },
    null,
    2,
  ),
);
