#!/usr/bin/env node

import {
  brokerLink,
  brokerMetricRowMap,
  buildBrokersSheet,
} from "./build_dynamic_model.mjs";
import { sealBrokerConsensusMembership } from "./lib/broker_consensus.mjs";
import { PlanWorkbook } from "./lib/plan_builder.mjs";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const signature = {
  metric_id: "adjusted_ebitda",
  accounting_basis: "IFRS",
  operation_scope: "continuing",
  adjustment_basis: "adjusted",
  currency: "GBP",
  units: "millions",
  fiscal_calendar: "fixed_date",
  cash_flow_basis: null,
  lease_basis: "including_leases",
};

function fixture(provider = [99, 116, 125]) {
  const houses = ["House A", "House B", "House C"];
  const membership = sealBrokerConsensusMembership({
    schema_version: "broker-consensus-membership/1.0",
    metric_id: "adjusted_ebitda",
    contributors: houses.map((houseName) => ({
      house_name: houseName,
      status: "included",
      reasons: [],
      definition_signature: structuredClone(signature),
      period_status: ["included", "included", "included"],
      period_reasons: [[], [], []],
    })),
  });
  return {
    case_id: "broker-consensus-workbook-fixture",
    contract_version: "2.0",
    issuer: {
      name: "Neutral Issuer",
      accounting_basis: "IFRS",
      reporting_currency: "GBP",
      units: "millions",
      fiscal_calendar: "fixed_date",
    },
    periods: [2023, 2024, 2025, 2026, 2027, 2028].map((year, index) => ({
      date: `${year}-12-31`,
      kind: index < 3 ? "historical" : "forecast",
    })),
    controls: { broker_case: "Model Consensus" },
    broker_pack: {
      source_label: "sealed neutral broker fixture",
      forecast_periods: ["2026-12-31", "2027-12-31", "2028-12-31"],
      metrics: {
        adjusted_ebitda: {
          label: "Adjusted EBITDA",
          definition_signature: structuredClone(signature),
          brokers: {
            "House A": [100, 110, 120],
            "House B": [102, 112, 122],
            "House C": [104, 114, 124],
          },
          ...(provider ? { provider_consensus: provider } : {}),
          ...(provider ? {
            provider_consensus_source: {
              source_note: "Neutral provider consensus note",
              period_lineage: ["page 1 / cell D4", "page 1 / cell E4", "page 1 / cell F4"],
            },
          } : {}),
          consensus_membership: membership,
        },
      },
    },
  };
}

function build(modelCase) {
  const workbook = PlanWorkbook.create();
  const rowPlan = {
    controls: { broker_case: 1 },
    broker_metric_rows: brokerMetricRowMap(modelCase),
    statement_rows: { income_statement: [], cash_flow: [] },
  };
  const rows = buildBrokersSheet(workbook, modelCase, rowPlan);
  return { workbook, sheet: workbook.sheetByName("Brokers"), rows };
}

const present = build(fixture());
const labels = new Map();
for (const address of present.sheet.cellAddresses()) {
  const cell = present.sheet.cellAt(address);
  if (address.startsWith("B") && typeof cell?.value === "string") {
    labels.set(cell.value, Number(address.slice(1)));
  }
}
const modelRow = labels.get("Adjusted EBITDA — Model Consensus");
const providerRow = labels.get("Provider Consensus");
const differenceRow = labels.get("Difference — Provider less Model");
const differencePctRow = [...labels]
  .find(([label]) => label.startsWith("Difference % — review above"))?.[1];
const contributorCountRow = labels.get("Contributor Count");
const excludedCountRow = labels.get("Excluded Count");
const highRow = labels.get("High");
const lowRow = labels.get("Low");
const selectedRow = present.rows.selectedRows.adjusted_ebitda;

assert(modelRow && providerRow && differenceRow && differencePctRow, "consensus reconciliation rows are incomplete");
assert(
  modelRow < providerRow && providerRow < differenceRow && differenceRow < differencePctRow &&
    differencePctRow < contributorCountRow && contributorCountRow < excludedCountRow &&
    excludedCountRow < highRow && highRow < lowRow && lowRow < selectedRow,
  "broker consensus rows are not in the required analyst order",
);

const modelCell = present.sheet.cellAt(`D${modelRow}`);
const providerCell = present.sheet.cellAt(`D${providerRow}`);
const selectedCell = present.sheet.cellAt(`D${selectedRow}`);
assert(/^IFERROR\(AVERAGE\(/.test(modelCell.formula), "Model Consensus is not a formula");
assert(modelCell.font.color === "FF000000", "Model Consensus formula is not black");
assert(providerCell.value === 99 && providerCell.formula === undefined, "Provider Consensus is not the exact source value");
assert(providerCell.font.color === "FF0000FF", "Provider Consensus source value is not blue");
assert(
  present.sheet._comments.some((comment) =>
    comment.cell === `D${providerRow}` &&
    comment.text.includes("Neutral provider consensus note") &&
    comment.text.includes("page 1 / cell D4"),
  ),
  "Provider Consensus omitted source note/page-cell lineage",
);
assert(selectedCell.formula.includes(`D${modelRow}`), "Selected Forecast does not offer Model Consensus");
assert(selectedCell.formula.includes(`D${providerRow}`), "Selected Forecast does not offer Provider Consensus");
assert(
  brokerLink(present.rows, "adjusted_ebitda", 0) === `='Brokers'!D${selectedRow}`,
  "Operating Model does not consume Selected Forecast through a cross-sheet link",
);

const absent = build(fixture(null));
const absentLabels = [...absent.sheet.cellAddresses()]
  .map((address) => absent.sheet.cellAt(address)?.value)
  .filter((value) => typeof value === "string");
assert(!absentLabels.includes("Provider Consensus"), "absent Provider Consensus still rendered");
assert(!absentLabels.some((label) => label.startsWith("Difference — Provider")), "provider reconciliation rendered without source evidence");

const longLabelCase = fixture();
longLabelCase.broker_pack.metrics.adjusted_ebitda.label = "Depreciation and amortisation";
const longLabel = build(longLabelCase);
const longSelectedRow = longLabel.rows.selectedRows.adjusted_ebitda;
assert(
  longLabel.sheet.cellAt(`B${longSelectedRow}`)?.value ===
    "Depreciation and amortisation — Selected Forecast",
  "the longest selected-forecast caption was not preserved",
);
assert(
  longLabel.sheet._columnWidths.get(2) >= 36,
  "the Brokers label column is too narrow for the longest selected-forecast caption",
);

console.log(JSON.stringify({
  status: "PASS",
  workbook_scenarios: 3,
  row_order_assertions: 9,
  provenance_assertions: 3,
  selected_cross_sheet_formula_assertions: 1,
  selected_forecast_layout_assertions: 2,
  total_violations: 0,
}, null, 2));
