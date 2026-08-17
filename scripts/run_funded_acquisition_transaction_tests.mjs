#!/usr/bin/env node
import assert from "node:assert/strict";
import { acquisitionTransactionFlows } from "./lib/acquisition_policy.mjs";
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
console.log(JSON.stringify({status:"PASS",checks:5}));
