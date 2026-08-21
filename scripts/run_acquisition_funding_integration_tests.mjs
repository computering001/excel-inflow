#!/usr/bin/env node
import assert from "node:assert/strict";

import { createRunner } from "./lib/test_harness.mjs";
import { acquisitionTransactionFlows } from "./lib/acquisition_policy.mjs";
import {
  applyFundedAcquisitionRows,
  fundedAcquisitionCandidate,
  fundedAcquisitionRole,
} from "./lib/funded_acquisition_runtime.mjs";

const run = createRunner({
  name: "acquisition_funding_integration_tests",
  importMetaUrl: import.meta.url,
});

const modelCase = {
  periods: ["2023", "2024", "2025", "2026", "2027", "2028"].map(
    (date, index) => ({
      date: `${date}-12-31`,
      status: index < 3 ? "historical" : "forecast",
    }),
  ),
  acquisition: {
    enabled: 1,
    transaction_enterprise_value: 1000,
    acquisition_debt_amount: 400,
    close_year: 2027,
  },
  statement_structure: {
    cash_flow: [
      {
        row_id: "acquisitions_net_of_cash",
        semantic_role: "acquisitions_net_of_cash",
      },
      {
        row_id: "change_in_debt",
        semantic_role: "change_in_debt",
      },
      {
        row_id: "debt_issuance",
        semantic_role: "debt_issuance",
        forecast_capture_parent_id: "change_in_debt",
      },
    ],
  },
};

const before = structuredClone(modelCase.statement_structure);

run.check("pre-close periods carry no direct acquisition cash flow", () => {
  assert.equal(acquisitionTransactionFlows(modelCase, 0).net_direct_cash_flow, 0);
  return true;
});

run.check("close-period consideration is an outflow of the enterprise value", () => {
  assert.equal(
    acquisitionTransactionFlows(modelCase, 1).consideration_cash_flow,
    -1000,
  );
  return true;
});

run.check("close-period debt funding draws the acquisition debt", () => {
  assert.equal(
    acquisitionTransactionFlows(modelCase, 1).acquisition_debt_proceeds,
    400,
  );
  return true;
});

run.check("unfunded consideration is bridged by residual cash or RCF", () => {
  assert.equal(
    acquisitionTransactionFlows(modelCase, 1).residual_cash_or_rcf_funding,
    600,
  );
  return true;
});

run.check("post-close periods carry no direct acquisition cash flow", () => {
  assert.equal(acquisitionTransactionFlows(modelCase, 2).net_direct_cash_flow, 0);
  return true;
});

run.check("funded-acquisition overlay authors no standalone statement rows", () => {
  applyFundedAcquisitionRows(modelCase);
  assert.deepEqual(
    modelCase.statement_structure,
    before,
    "The acquisition overlay authored duplicate standalone statement rows.",
  );
  return true;
});

const [consideration, changeInDebt, capturedIssuance] =
  modelCase.statement_structure.cash_flow;

run.check("consideration row carries the consideration role", () => {
  assert.equal(fundedAcquisitionRole(consideration), "consideration");
  return true;
});

run.check("change-in-debt row carries the debt-proceeds role", () => {
  assert.equal(fundedAcquisitionRole(changeInDebt), "debt_proceeds");
  return true;
});

run.check("captured issuance row carries the debt-proceeds role", () => {
  assert.equal(fundedAcquisitionRole(capturedIssuance), "debt_proceeds");
  return true;
});

run.check("consideration row is not an acquisition-funding candidate", () => {
  assert.equal(fundedAcquisitionCandidate(modelCase, consideration, 1), null);
  return true;
});

run.check("change-in-debt row is not an acquisition-funding candidate", () => {
  assert.equal(fundedAcquisitionCandidate(modelCase, changeInDebt, 1), null);
  return true;
});

run.check("disabled acquisition emits no consideration or debt flows", () => {
  const off = structuredClone(modelCase);
  off.acquisition.enabled = 0;
  assert.equal(
    Math.abs(acquisitionTransactionFlows(off, 1).consideration_cash_flow),
    0,
  );
  assert.equal(acquisitionTransactionFlows(off, 1).acquisition_debt_proceeds, 0);
  return true;
});

run.finish();
