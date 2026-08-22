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
const forecastColumns = ["J", "K", "L"];
const adjustmentColumns = ["N", "O", "P"];
const proFormaColumns = ["S", "T", "U"];
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

const simpleOffCase = {
  ...simpleCase,
  controls: { circularity: 0 },
};
const simpleOff = leaseForecast(simpleOffCase);
assert.deepEqual(rounded(simpleOff.map((period) => period.ending_total)), [105, 111, 118]);
assert.deepEqual(simpleOff.map((period) => period.interest), [0, 0, 0]);
assert.deepEqual(leaseProjectionErrors(simpleOffCase, simpleOff), []);

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

// Explicit exclusion is itself the typed authority: no liability was selected
// for the model, so a historical/opening balance must not be fabricated merely
// to satisfy the schedule shape. The carried state is explicit and remains 0.
const excludedWithoutDeclaredLiability = baseCase({
  mode: "exclude",
  principal_repayment: [0, 0, 0],
  additions: [0, 0, 0],
  effective_rate: [0, 0, 0],
  include_in_gross_debt: false,
  include_in_net_debt: false,
  include_in_leverage: false,
});
const excludedWithoutDeclaredLiabilityForecast = leaseForecast(
  excludedWithoutDeclaredLiability,
);
assert.deepEqual(
  excludedWithoutDeclaredLiabilityForecast.map((period) => period.opening_total),
  [0, 0, 0],
);
assert.deepEqual(
  excludedWithoutDeclaredLiabilityForecast.map((period) => period.ending_total),
  [0, 0, 0],
);
assert.deepEqual(validateLeasePolicy(excludedWithoutDeclaredLiability), []);

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

// Match the shipping validator exactly: formulas are selected from one
// forecast column, while their same-sheet precedents collapse to semantic row
// ownership regardless of the precedent's physical column.
const shippingRowFormulaCycles = (cells, column) => {
  const graph = new Map();
  const addresses = Object.keys(cells).filter((address) => address.startsWith(column));
  const knownRows = new Set(addresses.map((address) => Number(address.slice(column.length))));
  for (const address of addresses) {
    const formula = cells[address]?.f;
    if (typeof formula !== "string") continue;
    const row = Number(address.slice(column.length));
    const localFormula = formula.replace(/'(?:[^']|'')+'!\$?[A-Z]+\$?\d+/g, "");
    const refs = [];
    for (const match of localFormula.matchAll(/\$?([A-Z]+)\$?(\d+)/g)) {
      const target = Number(match[2]);
      if (target !== row && knownRows.has(target)) refs.push(target);
    }
    if (refs.length) graph.set(row, [...new Set(refs)]);
  }
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const cycles = [];
  const connect = (row) => {
    indices.set(row, nextIndex);
    low.set(row, nextIndex);
    nextIndex += 1;
    stack.push(row);
    onStack.add(row);
    for (const target of graph.get(row) ?? []) {
      if (!indices.has(target)) {
        connect(target);
        low.set(row, Math.min(low.get(row), low.get(target)));
      } else if (onStack.has(target)) {
        low.set(row, Math.min(low.get(row), indices.get(target)));
      }
    }
    if (low.get(row) !== indices.get(row)) return;
    const component = [];
    while (stack.length) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === row) break;
    }
    if (component.length > 1) cycles.push(component.sort((a, b) => a - b));
  };
  for (const row of graph.keys()) if (!indices.has(row)) connect(row);
  return cycles;
};

const buildLeaseWorkbookPlan = (
  label,
  leasePolicy,
  circularity,
  baseModelCase = productionCase,
) => {
  const modelCase = structuredClone(baseModelCase);
  modelCase.case_id = `lease_full_workbook_${label}`;
  modelCase.lease_policy = leasePolicy;
  modelCase.controls.circularity = circularity;
  if (modelCase.execution_profile !== "reference_parity") {
    sealForecastAuthorityLedger(modelCase);
  }
  const casePath = path.join(fixtureRoot, `${label}.json`);
  const workbookPath = path.join(fixtureRoot, `${label}.xlsx`);
  fs.writeFileSync(casePath, `${JSON.stringify(modelCase, null, 2)}\n`);
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("./build_dynamic_model.mjs", import.meta.url)),
      casePath,
      "--plan-only",
      "--out",
      workbookPath,
    ],
    { stdio: "ignore" },
  );
  return {
    modelCase,
    plan: JSON.parse(fs.readFileSync(`${workbookPath}.plan.json`, "utf8")),
    rowMap: JSON.parse(fs.readFileSync(`${workbookPath}.row-map.json`, "utf8")),
  };
};

const productionPolicy = productionCase.lease_policy;
const maximalFixtureCase = JSON.parse(
  fs.readFileSync(
    fileURLToPath(
      new URL("../test-fixtures/cases/standard-maximal-v2.json", import.meta.url),
    ),
    "utf8",
  ),
);
migrateLegacyDebtClasses(maximalFixtureCase);
maximalFixtureCase.execution_profile = "reference_parity";
const leasePlanVariants = [
  [
    "flat_total",
    {
      ...productionPolicy,
      mode: "flat_replacement",
      interest_basis: "total_liability",
      other_movements: [0.5, -0.25, 0.75],
    },
  ],
  [
    "simple_total",
    {
      ...productionPolicy,
      mode: "simple_roll_forward",
      interest_basis: "total_liability",
      additions: [4.5, 5, 5.5],
      other_movements: [0.5, -0.25, 0.75],
    },
  ],
  [
    "simple_separate",
    {
      ...productionPolicy,
      mode: "simple_roll_forward",
      interest_basis: "separately_supplied",
      additions: [4.5, 5, 5.5],
      other_movements: [0.5, -0.25, 0.75],
      historical_interest_bearing_liabilities: [8, 7, 6],
      forecast_interest_bearing_liabilities: [5.5, 5, 4.5],
    },
  ],
  [
    "sourced_total",
    {
      ...productionPolicy,
      mode: "sourced_balance",
      interest_basis: "total_liability",
      forecast_liabilities: [19, 18, 17],
      other_movements: [0.5, -0.25, 0.75],
    },
  ],
  [
    "sourced_separate",
    {
      ...productionPolicy,
      mode: "sourced_balance",
      interest_basis: "separately_supplied",
      forecast_liabilities: [19, 18, 17],
      other_movements: [0.5, -0.25, 0.75],
      historical_interest_bearing_liabilities: [8, 7, 6],
      forecast_interest_bearing_liabilities: [5.5, 5, 4.5],
    },
  ],
  [
    "standard_maximal_production_fixture",
    maximalFixtureCase.lease_policy,
    maximalFixtureCase,
  ],
];
const workbookMutations = [];
for (const [label, policy, baseModelCase] of leasePlanVariants) {
  for (const circularity of [1, 0]) {
  const stateLabel = `${label}_${circularity === 1 ? "on" : "off"}`;
  const { modelCase, plan, rowMap } = buildLeaseWorkbookPlan(
    stateLabel,
    policy,
    circularity,
    baseModelCase,
  );
  const sheet = plan.workbook.sheets.find((candidate) => candidate.name === "Operating Model");
  const cells = sheet.cells;
  const debtRows = rowMap.debt_summary_rows;
  const interestRows = rowMap.interest_summary_rows;
  const expected = leaseForecast(modelCase);
  const leaseRows = new Set([
    debtRows.lease_liability,
    debtRows.lease_additions_assumption,
    debtRows.lease_effective_rate_assumption,
    debtRows.lease_interest_bearing_liability,
    interestRows.lease_interest,
  ].filter(Number.isInteger));
  for (const [index, column] of forecastColumns.entries()) {
    const closingCell = cells[`${column}${debtRows.lease_liability}`];
    const additionsCell = cells[`${column}${debtRows.lease_additions_assumption}`];
    const principalCell = cells[`${column}${debtRows.lease_principal_assumption}`];
    const otherCell = cells[`${column}${debtRows.lease_other_movements_assumption}`];
    const rateCell = cells[`${column}${debtRows.lease_effective_rate_assumption}`];
    const interestCell = cells[`${column}${interestRows.lease_interest}`];
    assert.equal(Number(closingCell.v), expected[index].ending_total, `${stateLabel} closing cache ${column}`);
    assert.equal(Number(additionsCell.v), expected[index].additions, `${stateLabel} additions cache ${column}`);
    assert.equal(Number(principalCell.v), expected[index].principal_repayment, `${stateLabel} principal cache ${column}`);
    assert.equal(Number(otherCell.v), expected[index].other_movements, `${stateLabel} other cache ${column}`);
    assert.equal(
      Number(rateCell.v),
      policy.interest_basis === "none" ? 0 : Number(policy.effective_rate[index]),
      `${stateLabel} visible rate authority ${column}`,
    );
    const termColumn = ["C", "D", "E"][index];
    assert.equal(
      cells[`${termColumn}${interestRows.lease_interest}`].f,
      `${column}${debtRows.lease_effective_rate_assumption}`,
      `${stateLabel} Interest Schedule rate lineage ${column}`,
    );
    const expectedInterestCache = expected[index].interest === 0
      ? 0
      : -expected[index].interest;
    assert.equal(Number(interestCell.v), expectedInterestCache, `${stateLabel} interest cache ${column}`);
    assert.ok(typeof interestCell.f === "string" && interestCell.f.includes("AVERAGE("), `${stateLabel} visible average-balance lease interest ${column}`);
    const opening = index === 0
      ? Number(cells[`I${debtRows.lease_liability}`].v)
      : Number(cells[`${forecastColumns[index - 1]}${debtRows.lease_liability}`].v);
    assert.ok(
      Math.abs(
        opening + Number(additionsCell.v) - Number(interestCell.v) +
          Number(otherCell.v) - Number(principalCell.v) - Number(closingCell.v),
      ) < 1e-9,
      `${stateLabel} full visible lease identity ${column}`,
    );
    const leaseCycles = shippingRowFormulaCycles(cells, column)
      .filter((component) => component.some((row) => leaseRows.has(row)));
    assert.deepEqual(leaseCycles, [], `${stateLabel} must not create a lease SCC in ${column}`);
    assert.equal(Number(cells[`${adjustmentColumns[index]}${debtRows.lease_liability}`].v), 0, `${stateLabel} adjustment lease cache ${column}`);
    assert.equal(
      Number(cells[`${proFormaColumns[index]}${debtRows.lease_liability}`].v),
      Number(closingCell.v),
      `${stateLabel} pro forma lease cache ${column}`,
    );
  }

  const mutatedCells = structuredClone(cells);
  for (const [index, column] of forecastColumns.entries()) {
    const prior = index === 0 ? `I${debtRows.lease_liability}` : `${forecastColumns[index - 1]}${debtRows.lease_liability}`;
    mutatedCells[`${column}${debtRows.lease_liability}`].f =
      `MAX(0,${prior}+${column}${debtRows.lease_additions_assumption}+` +
      `${column}${debtRows.lease_other_movements_assumption}-` +
      `${column}${debtRows.lease_principal_assumption}-${column}${interestRows.lease_interest})`;
    if (policy.interest_basis === "separately_supplied") {
      mutatedCells[`${column}${interestRows.lease_interest}`].f =
        `IF($C$5=0,0,-AVERAGE(${prior},${column}${debtRows.lease_liability})*$C$${interestRows.lease_interest})`;
    }
  }
  assert.ok(
    forecastColumns.every((column) =>
      shippingRowFormulaCycles(mutatedCells, column)
        .some((component) => component.some((row) => leaseRows.has(row))),
    ),
    `${stateLabel} cyclic lease-formula mutation must be detected in every forecast column`,
  );
  workbookMutations.push(stateLabel);
  }
}
fs.rmSync(fixtureRoot, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      status: "PASS",
      checks: 154,
      mutations: [...mutations.map(([label]) => label), ...workbookMutations],
      production_case_exercised: true,
      full_workbook_plan_variants: workbookMutations,
    },
    null,
    2,
  ),
);
