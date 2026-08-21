#!/usr/bin/env node
import { acquisitionTransactionFlows } from "./lib/acquisition_policy.mjs";
import {
  applyFundedAcquisitionPlan,
  applyFundedAcquisitionWorkbook,
} from "./lib/funded_acquisition_plan.mjs";
import { applyFundedAcquisitionRows } from "./lib/funded_acquisition_runtime.mjs";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "funded_acquisition_transaction_tests", importMetaUrl: import.meta.url });

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
run.eq(JSON.stringify(modelCase.statement_structure), before, "funded acquisition must not author duplicate standalone rows");
run.eq(Math.abs(acquisitionTransactionFlows(modelCase, 0).consideration_cash_flow), 0, "no consideration cash flow before close");
run.eq(acquisitionTransactionFlows(modelCase, 1).consideration_cash_flow, -1482.5, "close period books the enterprise-value outflow");
run.eq(acquisitionTransactionFlows(modelCase, 1).acquisition_debt_proceeds, 1187.5, "close period books acquisition debt proceeds");
run.eq(acquisitionTransactionFlows(modelCase, 1).residual_cash_or_rcf_funding, 295, "residual cash or RCF funding balances the transaction");

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
run.eq(workbookResult.changed, 3, "workbook route changed exactly three cells");
run.match(cells.get("O65").formula, /-\$P\$5/, "consideration formula binds to the EV input");
run.doesNotMatch(cells.get("O65").formula, /101|fx/i, "consideration formula never references the fx row");
run.eq(cells.get("O65").cachedValue, -1482.5, "consideration cell caches the negative EV");
run.eq(cells.get("O70").formula, "=O97", "debt issuance row keeps its existing formula");
run.eq(workbookResult.debt_proceeds_row, 70, "debt proceeds row is reported as row 70");

const fxBoundPlan = structuredClone(rowPlan);
fxBoundPlan.statement_rows.cash_flow.find(
  (row) => row.row_id === "cash_from_investing",
).calculation.refs = ["fx_effect_on_cash"];
run.throws(
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
run.eq(capturedResult.changed, 6, "captured-plan route changed all six addressed cells");
run.match(capturedPlan.rows[0].cells[1].formula, /-\$P\$5/, "captured-plan consideration binds to the EV input");
run.eq(capturedPlan.rows[2].cells[1].formula, "=0", "captured-plan fx row is left at zero");

const duplicateCapturedPlan = structuredClone(capturedPlan);
duplicateCapturedPlan.rows[2].semantic_role = "acquisitions_net_of_cash";
run.throws(
  () => applyFundedAcquisitionPlan(duplicateCapturedPlan, modelCase),
  /exactly one|duplicate/i,
  "The captured-plan route accepted a second physical consideration row.",
);

run.finish();
