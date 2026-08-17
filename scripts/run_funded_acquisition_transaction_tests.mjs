#!/usr/bin/env node
import assert from "node:assert/strict";
import { acquisitionTransactionFlows } from "./lib/acquisition_policy.mjs";
import {
  applyFundedAcquisitionPlan,
  applyFundedAcquisitionWorkbook,
} from "./lib/funded_acquisition_plan.mjs";
import { applyFundedAcquisitionRows } from "./lib/funded_acquisition_runtime.mjs";

const modelCase = {
  controls: { acquisition: 1 },
  periods: ["2023","2024","2025","2026","2027","2028"].map((date,i)=>({date,status:i<3?"historical":"forecast"})),
  acquisition: {
    enabled: 1,
    mode: "funded_transaction",
    transaction_enterprise_value: 1482.5,
    acquisition_debt_amount: 1187.5,
    entry_ev_to_ebitda: 8.375,
    incremental_rate: 0.0685,
    close_year: 2027,
    close_month: 5,
  },
  statement_structure: {
    income_statement: [],
    cash_flow: [
      { row_id: "acquisitions_net_of_cash", semantic_role: "acquisitions_net_of_cash", values: [0,0,0,null,null,null] },
      { row_id: "debt_issuance", semantic_role: "debt_issuance", values: [0,0,0,null,null,null] },
    ],
  },
};
const before = JSON.stringify(modelCase.statement_structure);
applyFundedAcquisitionRows(modelCase);
assert.equal(JSON.stringify(modelCase.statement_structure), before, "funded acquisition must not author duplicate standalone rows");
assert.equal(Math.abs(acquisitionTransactionFlows(modelCase, 0).consideration_cash_flow), 0);
assert.equal(acquisitionTransactionFlows(modelCase, 1).consideration_cash_flow, -1482.5);
assert.equal(acquisitionTransactionFlows(modelCase, 1).acquisition_debt_proceeds, 1187.5);
assert.equal(acquisitionTransactionFlows(modelCase, 1).residual_cash_or_rcf_funding, 295);

const rowPlan = {
  statement_rows: {
    cash_flow: [
      {
        row_id: "acquisitions_net_of_cash",
        semantic_role: "acquisitions_net_of_cash",
        row: 65,
      },
      {
        row_id: "change_in_debt",
        semantic_role: "change_in_debt",
        row: 70,
      },
      {
        row_id: "debt_issuance",
        semantic_role: "debt_issuance",
        row: 71,
        forecast_treatment: "uncalculated",
        forecast_capture_parent_id: "change_in_debt",
      },
      {
        row_id: "cash_from_investing",
        semantic_role: "cash_from_investing",
        row: 82,
        calculation: {
          operator: "sum",
          refs: ["acquisitions_net_of_cash"],
        },
      },
      {
        row_id: "cash_from_financing",
        semantic_role: "cash_from_financing",
        row: 90,
        calculation: { operator: "sum", refs: ["change_in_debt"] },
      },
      {
        row_id: "fx_effect_on_cash",
        semantic_role: "fx_effect_on_cash",
        row: 101,
      },
    ],
  },
};
const cells = new Map();
for (const rowNumber of [65, 70]) {
  for (const column of ["N", "O", "P"]) {
    cells.set(`${column}${rowNumber}`, {
      formula: rowNumber === 70 ? `=${column}97` : "=0",
      cachedValue: 0,
    });
  }
}
const sheet = {
  cellAt(address) { return cells.get(address); },
  setFormulaText(address, formula) {
    const cell = cells.get(address);
    if (!cell) return false;
    cell.formula = formula;
    return true;
  },
  setCachedValue(address, value) {
    const cell = cells.get(address);
    if (!cell) return false;
    cell.cachedValue = value;
    return true;
  },
};
const workbook = {
  sheetByName(name) { return name === "Operating Model" ? sheet : null; },
};
const workbookResult = applyFundedAcquisitionWorkbook(
  workbook,
  rowPlan,
  modelCase,
);
assert.equal(workbookResult.changed, 3);
assert.match(cells.get("O65").formula, /-\$P\$5/);
assert.doesNotMatch(cells.get("O65").formula, /101|fx/i);
assert.equal(cells.get("O65").cachedValue, -1482.5);
assert.equal(cells.get("O70").formula, "=O97");
assert.equal(workbookResult.debt_proceeds_row, 70);

const fxBoundPlan = structuredClone(rowPlan);
fxBoundPlan.statement_rows.cash_flow.find(
  (row) => row.row_id === "cash_from_investing",
).calculation.refs = ["fx_effect_on_cash"];
assert.throws(
  () => applyFundedAcquisitionWorkbook(workbook, fxBoundPlan, modelCase),
  /investing|exactly once/i,
  "An acquisition consideration row not owned exactly once by investing cash flow was accepted.",
);

const addressedCells = (rowNumber) => ["N", "O", "P"].map((column) => ({
  address: `${column}${rowNumber}`,
  formula: "=0",
  cached_value: 0,
}));
const capturedPlan = {
  rows: [
    {
      row_id: "acquisitions_net_of_cash",
      semantic_role: "acquisitions_net_of_cash",
      cells: addressedCells(65),
    },
    {
      row_id: "change_in_debt",
      semantic_role: "change_in_debt",
      cells: addressedCells(70),
    },
    {
      row_id: "fx_effect_on_cash",
      semantic_role: "fx_effect_on_cash",
      cells: addressedCells(101),
    },
  ],
};
const capturedResult = applyFundedAcquisitionPlan(capturedPlan, modelCase);
assert.equal(capturedResult.changed, 6);
assert.match(capturedPlan.rows[0].cells[1].formula, /-\$P\$5/);
assert.equal(capturedPlan.rows[2].cells[1].formula, "=0");

const duplicateCapturedPlan = structuredClone(capturedPlan);
duplicateCapturedPlan.rows[2].semantic_role = "acquisitions_net_of_cash";
assert.throws(
  () => applyFundedAcquisitionPlan(duplicateCapturedPlan, modelCase),
  /exactly one|duplicate/i,
  "The captured-plan route accepted a second physical consideration row.",
);

console.log(JSON.stringify({status:"PASS",checks:16}));
