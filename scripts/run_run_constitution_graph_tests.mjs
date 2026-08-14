#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  authorityQualitySummary,
  compileModelDemandGraph,
  compileRunConstitutionGraph,
  compileSelectedAuthorityContract,
  validateModelDemandGraph,
  validateRunConstitutionGraph,
  validateSelectedAuthorityContract,
} from "./lib/run_constitution_graph.mjs";

const periods = [
  { date: "2023-12-31", status: "historical" },
  { date: "2024-12-31", status: "historical" },
  { date: "2025-12-31", status: "historical" },
  { date: "2026-12-31", status: "forecast" },
  { date: "2027-12-31", status: "forecast" },
  { date: "2028-12-31", status: "forecast" },
];
const modelCase = {
  case_id: "constitution-test",
  periods,
  statement_structure: {
    income_statement: [
      { row_id: "revenue", semantic_role: "revenue", row_type: "input", material: true },
      {
        row_id: "ebit",
        semantic_role: "ebit",
        row_type: "calculation",
        material: true,
        forecast_calculation: { operator: "sum", refs: ["revenue"] },
      },
    ],
    cash_flow: [
      { row_id: "capex", semantic_role: "capex", row_type: "input", material: true },
      {
        row_id: "ending_cash",
        semantic_role: "ending_cash",
        row_type: "calculation",
        material: true,
        dependencies: ["capex"],
      },
    ],
  },
  instrument_term_authorities: [
    { instrument_id: "bond_2029", model_field: "maturity_date", source_cells: ["dcs!R2C4"] },
  ],
};

const states = [];
const candidateLedger = [];
for (const section of ["income_statement", "cash_flow"]) {
  for (const row of modelCase.statement_structure[section]) {
    for (let index = 0; index < 3; index += 1) {
      const stateId = `${section}.${row.row_id}.fy${index + 1}`;
      const structural = row.row_type === "calculation";
      const candidateId = `${stateId}:01:test:${structural ? "accounting_identity" : "historical_average"}`;
      states.push({
        state_id: stateId,
        row_id: row.row_id,
        section,
        forecast_index: index,
        period_end: periods[index + 3].date,
        method: structural ? "accounting_identity" : "historical_average",
        material: true,
        selected_candidate_id: candidateId,
        source_bindings: structural ? [] : ["filing-2025"],
        status: "RESOLVED",
      });
      candidateLedger.push({
        candidate_id: candidateId,
        state_id: stateId,
        method: structural ? "accounting_identity" : "historical_average",
        selected: true,
        source_bindings: structural ? [] : ["filing-2025"],
      });
    }
  }
}
const forecastPlan = { schema_version: "forecast-plan/1.0", status: "PASS", states, candidate_ledger: candidateLedger };
const evidenceRun = {
  source_inventory: [{ source_id: "filing-2025", status: "used" }],
  broker_crosswalk_receipt: {
    terminal_recovery: {
      quarantined_candidates: [{ candidate_id: "broker.bad.cell", rationale: "Selected OCR conflict did not survive verification." }],
    },
  },
};

const demand = compileModelDemandGraph(modelCase);
assert.equal(validateModelDemandGraph(demand).valid, true);
assert.equal(demand.counts.forecast_states, 12);
assert.equal(demand.counts.contractual_terms, 1);
assert.ok(demand.edges.some((edge) => edge.from === "income_statement.revenue.fy1" && edge.to === "income_statement.ebit.fy1"));

const authority = compileSelectedAuthorityContract({ modelCase, forecastPlan, modelDemandGraph: demand, evidenceRun });
assert.equal(validateSelectedAuthorityContract(authority, { modelDemandGraph: demand, forecastPlan }).valid, true);
assert.equal(authority.quality_mode, "DEGRADED");
assert.equal(authority.counts.unresolved, 0);
assert.equal(authority.authorities.length, demand.nodes.length);
assert.equal(authorityQualitySummary(authority).fallback_count, authority.counts.fallbacks);
assert.equal(authorityQualitySummary(authority).quarantined_evidence_count, 1);

const constitution = compileRunConstitutionGraph({
  evidenceRun,
  modelCase,
  forecastPlan,
  modelDemandGraph: demand,
  selectedAuthorityContract: authority,
});
assert.equal(validateRunConstitutionGraph(constitution).valid, true);
assert.equal(constitution.counts.orphan_selected_authorities, 0);
assert.ok(constitution.counts.selected_paths > 0);

const tamperedDemand = structuredClone(demand);
tamperedDemand.nodes[0].material = !tamperedDemand.nodes[0].material;
assert.equal(validateModelDemandGraph(tamperedDemand).valid, false);

const tamperedAuthority = structuredClone(authority);
tamperedAuthority.authorities.pop();
assert.equal(
  validateSelectedAuthorityContract(tamperedAuthority, { modelDemandGraph: demand, forecastPlan }).valid,
  false,
);

const orphaned = structuredClone(constitution);
orphaned.counts.orphan_selected_authorities = 1;
assert.equal(validateRunConstitutionGraph(orphaned).valid, false);

const detachedProduct = structuredClone(constitution);
detachedProduct.product_constitution_sha256 = "0".repeat(64);
assert.equal(validateRunConstitutionGraph(detachedProduct).valid, false);

process.stdout.write(`${JSON.stringify({ status: "PASS", positive_checks: 14, adversarial_mutations: 4, total_violations: 0 }, null, 2)}\n`);
