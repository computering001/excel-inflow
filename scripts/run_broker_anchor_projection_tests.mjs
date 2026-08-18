#!/usr/bin/env node

import { resolveAnchorPlanDecision } from "./lib/broker_anchor.mjs";

let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
}

const baseCase = {
  controls: { broker_case: "Consensus" },
  issuer: {
    accounting_basis: "ifrs",
    reporting_currency: "USD",
    units: "millions",
    fiscal_calendar: "fixed_date",
  },
  broker_pack: {
    metrics: {
      adjusted_ebitda: { brokers: { "House A": [220, 230, 240] } },
      depreciation_and_amortisation: { brokers: { "House A": [50, 52, 54] } },
    },
  },
};

const rows = [
  {
    row_id: "adjusted_ebitda",
    semantic_role: "adjusted_ebitda",
    forecast_treatment: "broker",
    broker_metric_id: "adjusted_ebitda",
    calculation: { operator: "sum", refs: ["operating_profit", "depreciation_and_amortisation"] },
  },
  {
    row_id: "operating_profit",
    semantic_role: "operating_profit",
    role_aliases: ["ebit"],
    forecast_treatment: "formula",
  },
  {
    row_id: "depreciation_and_amortisation",
    semantic_role: "depreciation_and_amortisation",
    forecast_treatment: "broker",
    broker_metric_id: "depreciation_and_amortisation",
    values: [50, 50, 50, 50, 52, 54],
  },
];

const projected = resolveAnchorPlanDecision(baseCase, rows);
check(projected.status === "applied", `projected EBIT alias did not resolve: ${projected.reason}`);
check(projected.bridge.ebitRow.row_id === "operating_profit", "projected EBIT owner was not selected");
check(projected.bridge.ebitTerm === "operating_profit", "projected EBIT bridge term was not preserved");

const directRows = structuredClone(rows);
directRows[1].semantic_role = "ebit";
delete directRows[1].role_aliases;
check(resolveAnchorPlanDecision(baseCase, directRows).status === "applied", "direct EBIT role regressed");

const brokenRows = structuredClone(rows);
delete brokenRows[1].role_aliases;
check(
  resolveAnchorPlanDecision(baseCase, brokenRows).status === "unresolved",
  "missing semantic lineage was silently accepted",
);

console.log(JSON.stringify({ status: "PASS", checks }));
