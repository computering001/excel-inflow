#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACQUISITION_VALUATION_AUTHORITY,
  acquisitionAmountLabel,
  acquisitionTargetEbitdaFormula,
  acquisitionValuation,
} from "./lib/acquisition_policy.mjs";
import { solveCase, validateCaseShape } from "./lib/solver.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = process.argv[2] ??
  path.join(root, "test-fixtures", "cases", "standard-net-cash-v2.json");
const base = JSON.parse(fs.readFileSync(fixture, "utf8"));
base.execution_profile = "reference_parity";

const closeYear = Number(String(base.periods[3].date).slice(0, 4));
const negativePbtCase = structuredClone(base);
Object.assign(negativePbtCase.acquisition, {
  enabled: 1,
  transaction_enterprise_value: 100,
  entry_ev_to_ebitda: 10,
  acquisition_debt_amount: 200,
  incremental_rate: 0.5,
  close_year: closeYear,
  close_month: 1,
});

assert.deepEqual(validateCaseShape(negativePbtCase), []);
const valuation = acquisitionValuation(negativePbtCase);
assert.equal(valuation.authority, ACQUISITION_VALUATION_AUTHORITY);
assert.equal(valuation.target_ebitda, 10);
assert.equal(valuation.reporting_currency, negativePbtCase.issuer.reporting_currency);
assert.equal(valuation.units, negativePbtCase.issuer.units);
assert.equal(
  acquisitionAmountLabel(negativePbtCase, "Enterprise value"),
  "Enterprise value (USD, millions)",
);
assert.equal(
  acquisitionTargetEbitdaFormula("P5", "P6"),
  "=P5/P6",
);

const directTargetMutation = structuredClone(negativePbtCase);
directTargetMutation.acquisition.target_ebitda = 999;
assert.ok(
  validateCaseShape(directTargetMutation).some((message) =>
    message.includes("target EBITDA must be derived")),
  "A third editable target EBITDA input was accepted.",
);

const aliasMutation = structuredClone(negativePbtCase);
aliasMutation.acquisition.target_adjusted_ebitda = 999;
assert.ok(
  validateCaseShape(aliasMutation).some((message) =>
    message.includes("target EBITDA must be derived")),
  "A target EBITDA input alias was accepted.",
);

const multipleMutation = structuredClone(negativePbtCase);
multipleMutation.acquisition.entry_ev_to_ebitda = 20;
assert.equal(acquisitionValuation(multipleMutation).target_ebitda, 5);
const enterpriseValueMutation = structuredClone(negativePbtCase);
enterpriseValueMutation.acquisition.transaction_enterprise_value = 200;
assert.equal(acquisitionValuation(enterpriseValueMutation).target_ebitda, 20);

const zeroEnterpriseValueMutation = structuredClone(negativePbtCase);
zeroEnterpriseValueMutation.acquisition.transaction_enterprise_value = 0;
assert.ok(
  validateCaseShape(zeroEnterpriseValueMutation).some((message) =>
    message.includes("transaction_enterprise_value greater than zero")),
  "A zero transaction enterprise value escaped the acquisition case gate.",
);
const zeroMultipleMutation = structuredClone(negativePbtCase);
zeroMultipleMutation.acquisition.entry_ev_to_ebitda = 0;
assert.ok(
  validateCaseShape(zeroMultipleMutation).some((message) =>
    message.includes("entry_ev_to_ebitda greater than zero")),
  "A zero entry multiple escaped the acquisition case gate.",
);

const offCase = structuredClone(negativePbtCase);
offCase.acquisition.enabled = 0;
const off = solveCase(offCase);
const on = solveCase(negativePbtCase, { acquisitionBaseSolution: off });
const closeIndex = 0;
const targetPreTaxIncome =
  Number(on.forecast[closeIndex].pre_tax_income) -
  Number(off.forecast[closeIndex].pre_tax_income);
const targetTaxCharge =
  Number(on.forecast[closeIndex].tax) -
  Number(off.forecast[closeIndex].tax);
const standaloneTaxRate =
  Number(off.forecast[closeIndex].tax) /
  Number(off.forecast[closeIndex].pre_tax_income);
assert.ok(targetPreTaxIncome < 0, "The negative target PBT scenario was not reached.");
assert.ok(targetTaxCharge < 0, "Negative target PBT was silently denied its tax benefit.");
assert.ok(
  Math.abs(targetTaxCharge - targetPreTaxIncome * standaloneTaxRate) < 1e-8,
  "Target tax did not preserve the inherited standalone effective tax rate.",
);
assert.ok(
  Math.abs(
    (Number(on.forecast[closeIndex].net_income) -
      Number(off.forecast[closeIndex].net_income)) -
      (targetPreTaxIncome - targetTaxCharge),
  ) < 1e-8,
  "Negative target PBT and tax benefit did not flow through net income.",
);

console.log(JSON.stringify({
  status: "PASS",
  fixture,
  checks: 19,
  valuation_authority: ACQUISITION_VALUATION_AUTHORITY,
  target_pre_tax_income: targetPreTaxIncome,
  target_tax_charge: targetTaxCharge,
  mutations_rejected: 4,
}, null, 2));
