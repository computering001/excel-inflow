#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrateLegacyDebtClasses } from "./lib/debt_class.mjs";
import { sealForecastAuthorityLedger } from "./lib/forecast_authority_ledger.mjs";
import {
  resolvedResidualInterestAuthority,
  validateResidualInterestAuthority,
} from "./lib/residual_interest_authority.mjs";

function duplicateRcfFeeFindings(formula, column, rows) {
  const compact = String(formula ?? "").replace(/\s+/g, "").replace(/\$/g, "");
  const subtotal = `${column}${rows.rcf_total_fees}`;
  const direct = [
    `${column}${rows.rcf_interest}`,
    `${column}${rows.rcf_commitment_fee}`,
  ].filter((reference) => compact.includes(reference));
  return compact.includes(subtotal) && direct.length > 0
    ? [{ issue: "rcf_fee_component_double_count", references: direct }]
    : [];
}

const zeroCase = { other_interest: [0, 0, 0] };
assert.deepEqual(validateResidualInterestAuthority(zeroCase), []);
assert.equal(resolvedResidualInterestAuthority(zeroCase).method, "zero");

const bareNonZero = { other_interest: [1, 2, 3] };
assert(
  validateResidualInterestAuthority(bareNonZero).some((message) =>
    /requires other_interest_authority/.test(message),
  ),
);
const explicit = {
  other_interest: [1, 2, 3],
  other_interest_authority: {
    contract_version: "residual-interest-authority/1.0",
    method: "explicit_forecast_assumption",
    basis_note: "Board-approved forecast assumption.",
  },
};
assert.deepEqual(validateResidualInterestAuthority(explicit), []);
assert(
  validateResidualInterestAuthority({
    ...explicit,
    other_interest_authority: {
      ...explicit.other_interest_authority,
      method: "zero",
    },
  }).some((message) => /cannot support non-zero/.test(message)),
);
assert(
  validateResidualInterestAuthority({
    ...explicit,
    other_interest_authority: {
      ...explicit.other_interest_authority,
      method: "broker_or_guidance",
    },
  }).some((message) => /source_id/.test(message)),
);

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "excel-inflow-interest-fixture."));
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
let productionCaseExercised = true;
let feeValues = [];
const duplicatedRcfFeeMutations = [];
try {
  productionCaseExercised = true;
  const modelCase = JSON.parse(fs.readFileSync(productionPath, "utf8"));
  migrateLegacyDebtClasses(modelCase);
  modelCase.rcf_policy.commitment_fee_convention = "bps_on_undrawn";
  modelCase.rcf_policy.commitment_fee_value = 125;
  sealForecastAuthorityLedger(modelCase);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "excel-inflow-interest-contract."));
  const casePath = path.join(root, "case.json");
  const workbookPath = path.join(root, "interest.xlsx");
  fs.writeFileSync(casePath, `${JSON.stringify(modelCase, null, 2)}\n`);
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("./build_dynamic_model.mjs", import.meta.url)),
      casePath,
      "--out",
      workbookPath,
      "--plan-only",
    ],
    { stdio: "ignore" },
  );
  const plan = JSON.parse(fs.readFileSync(`${workbookPath}.plan.json`, "utf8"));
  const rowMap = JSON.parse(fs.readFileSync(`${workbookPath}.row-map.json`, "utf8"));
  const solution = JSON.parse(fs.readFileSync(`${workbookPath}.solution.json`, "utf8"));
  const sheet = plan.workbook.sheets.find((item) => item.name === "Operating Model");
  const interest = rowMap.interest_summary_rows;
  for (const column of ["J", "K", "L", "S", "T", "U"]) {
    const totalFormula = sheet.cells[`${column}${interest.rcf_total_fees}`]?.f ?? "";
    assert.equal(
      totalFormula,
      `SUM(${column}${interest.rcf_interest}:${column}${interest.rcf_commitment_fee})`,
    );
    const grossFormula = sheet.cells[`${column}${interest.gross_interest_expense}`]?.f ?? "";
    assert(grossFormula.includes(`${column}${interest.rcf_total_fees}`));
    assert.equal(grossFormula.includes(`${column}${interest.rcf_interest}`), false);
    assert.equal(grossFormula.includes(`${column}${interest.rcf_commitment_fee}`), false);
    assert.deepEqual(duplicateRcfFeeFindings(grossFormula, column, interest), []);
    const mutatedGrossFormula =
      `${grossFormula}+${column}${interest.rcf_interest}+${column}${interest.rcf_commitment_fee}`;
    assert.deepEqual(
      duplicateRcfFeeFindings(mutatedGrossFormula, column, interest),
      [{
        issue: "rcf_fee_component_double_count",
        references: [
          `${column}${interest.rcf_interest}`,
          `${column}${interest.rcf_commitment_fee}`,
        ],
      }],
      "The isolated duplicate-RCF-fee mutation escaped the structural oracle.",
    );
    duplicatedRcfFeeMutations.push(`${column}${interest.gross_interest_expense}`);
  }
  for (const period of solution.standalone.forecast) {
    assert(period.rcf_commitment_fee > 0, "non-zero RCF fee mutation did not price");
    const components =
      period.instrument_interest +
      period.rcf_interest +
      period.rcf_commitment_fee +
      period.lease_interest +
      period.acquisition_interest +
      period.other_interest +
      period.non_cash_interest;
    assert(Math.abs(period.gross_interest - components) < 1e-8);
    feeValues.push(period.rcf_commitment_fee);
  }
  const residualRow = interest.other_unallocated_interest;
  assert.equal(sheet.cells[`B${residualRow}`]?.v, "Other / unallocated interest — zero");
  assert(
    sheet.comments.some(
      (comment) =>
        comment.cell === `B${residualRow}` &&
        /Forecast authority: zero/.test(comment.text),
    ),
  );
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      checks: productionCaseExercised ? 35 : 5,
      production_case_exercised: productionCaseExercised,
      non_zero_rcf_commitment_fees: feeValues,
      mutations: {
        duplicate_rcf_fee_components: duplicatedRcfFeeMutations,
      },
    },
    null,
    2,
  ),
);
