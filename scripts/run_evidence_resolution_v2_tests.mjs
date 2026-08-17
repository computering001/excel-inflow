#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  compileEvidenceResolutionV2,
  evidenceResolutionCanonicalJson,
  validateEvidenceResolutionV2,
} from "./lib/evidence_resolution_v2.mjs";

const sha = (digit) => digit.repeat(64);
const clone = (value) => structuredClone(value);

function evidenceRun() {
  return {
    schema_version: "evidence-run/1.0",
    run_id: "vnext-test",
    source_inventory: [
      { source_id: "annual_report", kind: "company_annual_report", name: "annual.pdf", content_sha256: sha("a"), status: "used" },
      { source_id: "factset_export", kind: "user_factset_export", name: "debt.xlsx", content_sha256: sha("b"), status: "used" },
      { source_id: "broker_1", kind: "user_broker_research", name: "alpha.pdf", content_sha256: sha("c"), status: "used" },
      { source_id: "broker-pack", kind: "user_broker_research", name: "pack.json", content_sha256: sha("d"), status: "used" },
    ],
    filings: {
      historical_periods: ["2023-12-31", "2024-12-31", "2025-12-31"],
      forecast_periods: ["2026-12-31", "2027-12-31", "2028-12-31"],
      units: "USD millions",
      income_statement: [
        { source_line_id: "is.revenue", semantic_role: "revenue", values: [100, 110, 120], source_id: "annual_report", page_or_note: "p10", material: true },
      ],
      cash_flow: [
        { source_line_id: "cf.capex", semantic_role: "capex", values: [-8, -9, -10], source_id: "annual_report", page_or_note: "p14", material: true },
      ],
    },
    broker_pack: {
      schema_version: "broker-pack/1.0",
      forecast_periods: ["2026-12-31", "2027-12-31", "2028-12-31"],
      units: "USD millions",
      metrics: {
        revenue: { label: "Revenue", unit_kind: "currency", tier: 1 },
      },
      houses: [
        {
          house_id: "alpha",
          house_name: "Alpha",
          document: { file_name: "alpha.pdf", page_reference: "p4", extraction_evidence_sha256: sha("e") },
          estimates: { revenue: [130, 140, 150] },
          digest: [{
            metric_id: "revenue",
            definition_id: "reported_revenue",
            consumed: true,
            grades: ["dual_read", "dual_read", "adjudicated"],
            source_locations: ["t1!B4", "t1!C4", "t1!D4"],
          }],
        },
      ],
    },
    broker_crosswalk_receipt: {
      mappings: [
        {
          mapping_id: "m.alpha.revenue.0",
          house_id: "alpha",
          metric_id: "revenue",
          period_index: 0,
          components: [{
            table_id: "alpha-table-1",
            row: 4,
            column: 2,
            source_ref: "alpha.pdf#page=4;table=1;r=4;c=2",
            raw_value: 130,
            coefficient: 1,
            contribution: 130,
            crop_sha256: sha("1"),
          }],
        },
      ],
    },
    dcs_export: {
      schema_version: "dcs-export/1.0",
      as_of: "2025-12-31",
      units: "USD millions",
      instruments: [
        {
          instrument_id: "bond_1",
          source_row: "dcs.1",
          description: "5% notes",
          instrument_type: "fixed_bond",
          currency: "USD",
          outstanding_amount: 50,
          maturity_date: "2030-06-30",
          rate_type: "fixed",
          coupon_rate: 0.05,
          clean_price: 99.5,
          yield_to_worst: 0.052,
        },
      ],
    },
    case_evidence: {
      lanes: {
        dcs: {
          term_authorities: [
            {
              instrument_id: "bond_1",
              model_field: "coupon_rate",
              source_cells: ["dcs.1.coupon_rate"],
            },
          ],
        },
      },
    },
  };
}

function forecastPlan({ unresolved = false, method = "broker_consensus" } = {}) {
  const stateId = "income_statement.revenue.fy1";
  return {
    schema_version: "forecast-plan/2.0",
    status: unresolved ? "BLOCK" : "PASS",
    unresolved_material_count: unresolved ? 1 : 0,
    states: [{
      state_id: stateId,
      section: "income_statement",
      row_id: "revenue",
      period_end: "2026-12-31",
      material: true,
      status: unresolved ? "UNRESOLVED" : "RESOLVED",
      method: unresolved ? "unresolved" : method,
      selected_candidate_id: unresolved ? null : `${stateId}:broker`,
      source_bindings: unresolved ? [] : ["broker-pack"],
    }],
    candidate_ledger: unresolved ? [] : [
      { candidate_id: `${stateId}:guidance`, state_id: stateId, selected: false, rejection_reason: "not_available" },
      { candidate_id: `${stateId}:broker`, state_id: stateId, selected: true, rejection_reason: null },
    ],
  };
}

const clean = compileEvidenceResolutionV2({
  evidenceRun: evidenceRun(),
  forecastPlan: forecastPlan(),
  laneStates: {
    filings: { pipeline_status: "PASS", artifacts: {}, artifact_sha256: {} },
    broker: { pipeline_status: "PASS", artifacts: {}, artifact_sha256: {} },
    dcs: { pipeline_status: "PASS", artifacts: {}, artifact_sha256: {} },
  },
});
assert.equal(clean.status, "PASS");
assert.equal(clean.quality_mode, "VERIFIED");
assert.equal(validateEvidenceResolutionV2(clean).ok, true);
assert(clean.observations.some((entry) => entry.lane === "filings" && entry.concept_id === "revenue"));
assert(clean.observations.some((entry) =>
  entry.lane === "broker" && entry.provenance.cell === "alpha.pdf#page=4;table=1;r=4;c=2"));
const mappedBroker = clean.observations.find((entry) =>
  entry.observation_id === "broker.alpha.revenue.fy1");
assert.equal(mappedBroker.mapping_components[0].table, "alpha-table-1");
assert.equal(mappedBroker.mapping_components[0].page, 4);
assert.equal(mappedBroker.mapping_components[0].crop_sha256, sha("1"));
assert(clean.observations.some((entry) => entry.lane === "dcs" && entry.concept_id.endsWith("coupon_rate") && entry.model_driving));
const coupon = clean.observations.find((entry) => entry.concept_id.endsWith("coupon_rate"));
assert.equal(coupon.mapping_components[0].source_ref, "dcs.1.coupon_rate");
assert(clean.observations.some((entry) => entry.lane === "dcs" && entry.concept_id.endsWith("clean_price") && !entry.model_driving));
assert.equal(clean.authority_graph.unresolved_material_count, 0);
assert.equal(clean.input_bindings.evidence_run_sha256.length, 64);
assert.equal(clean.input_bindings.forecast_plan_sha256.length, 64);

const repeated = compileEvidenceResolutionV2({
  evidenceRun: evidenceRun(),
  forecastPlan: forecastPlan(),
  laneStates: {
    broker: { pipeline_status: "PASS", artifacts: {}, artifact_sha256: {} },
  },
});
const repeatedAgain = compileEvidenceResolutionV2({
  evidenceRun: evidenceRun(),
  forecastPlan: forecastPlan(),
  laneStates: {
    broker: { pipeline_status: "PASS", artifacts: {}, artifact_sha256: {} },
  },
});
assert.equal(evidenceResolutionCanonicalJson(repeated), evidenceResolutionCanonicalJson(repeatedAgain));

const degradedEvidence = evidenceRun();
degradedEvidence.broker_pack.houses[0].estimates.revenue[1] = null;
const degraded = compileEvidenceResolutionV2({
  evidenceRun: degradedEvidence,
  forecastPlan: forecastPlan({ method: "historical_average" }),
  laneStates: {
    broker: {
      pipeline_status: "PASS_DEGRADED",
      artifacts: { degraded_close_receipt: "/run/broker/degraded.json" },
      artifact_sha256: { degraded_close_receipt: sha("f") },
    },
  },
});
assert.equal(degraded.status, "PASS_DEGRADED");
assert.equal(degraded.quality_mode, "DEGRADED");
assert.equal(degraded.user_blocking, false);
assert(degraded.quarantines.some((entry) => entry.scope.includes("fy2")));
assert(degraded.authority_graph.nodes.some((entry) => entry.state === "FALLBACK"));

const inputRequired = compileEvidenceResolutionV2({
  evidenceRun: evidenceRun(),
  forecastPlan: forecastPlan({ unresolved: true }),
});
assert.equal(inputRequired.status, "ACTION_REQUIRED");
assert.equal(inputRequired.quality_mode, "INPUT_REQUIRED");
assert.equal(inputRequired.blocker_class, "USER_DECISION");

const internal = compileEvidenceResolutionV2({
  evidenceRun: evidenceRun(),
  forecastPlan: forecastPlan(),
  laneStates: {
    broker: { pipeline_status: "BLOCKED_INTERNAL", blocker_class: "INTERNAL_WORK", user_blocking: false, summary: { message: "controller defect" } },
  },
});
assert.equal(internal.status, "NEEDS_INTERNAL_WORK");
assert.equal(internal.user_blocking, false);

const fatal = compileEvidenceResolutionV2({
  evidenceRun: evidenceRun(),
  forecastPlan: forecastPlan(),
  laneStates: {
    filings: { pipeline_status: "BLOCKED_INPUT", blocker_class: "FATAL_SOURCE", user_blocking: true, summary: { message: "encrypted filing" } },
  },
});
assert.equal(fatal.status, "BLOCKED");
assert.equal(fatal.quality_mode, "FATAL");
assert.equal(fatal.user_blocking, true);

const tampered = clone(clean);
tampered.observations[0].value = 999;
assert.equal(validateEvidenceResolutionV2(tampered).ok, false);

const staleCount = clone(clean);
staleCount.receipt.observation_count += 1;
assert.equal(validateEvidenceResolutionV2(staleCount).ok, false);

const staleInput = clone(clean);
staleInput.input_bindings.forecast_plan_sha256 = sha("9");
assert.equal(validateEvidenceResolutionV2(staleInput, {
  evidenceRun: evidenceRun(),
  forecastPlan: forecastPlan(),
  laneStates: {
    filings: { pipeline_status: "PASS", artifacts: {}, artifact_sha256: {} },
    broker: { pipeline_status: "PASS", artifacts: {}, artifact_sha256: {} },
    dcs: { pipeline_status: "PASS", artifacts: {}, artifact_sha256: {} },
  },
}).ok, false);

const staleSourceSnapshot = clone(clean);
staleSourceSnapshot.source_snapshot_sha256 = sha("8");
assert.equal(validateEvidenceResolutionV2(staleSourceSnapshot).ok, false);

const missingSource = clone(clean);
missingSource.source_store = missingSource.source_store.filter(
  (source) => source.source_id !== "broker_1");
assert.equal(validateEvidenceResolutionV2(missingSource).ok, false);

const undeclaredSelection = clone(clean);
undeclaredSelection.authority_graph.nodes[0].selected_candidate_id = "not-a-candidate";
assert.equal(validateEvidenceResolutionV2(undeclaredSelection).ok, false);

process.stdout.write(JSON.stringify({
  status: "PASS",
  checks: 29,
  verified_observations: clean.observations.length,
  degraded_quarantines: degraded.quarantines.length,
  authority_nodes: clean.authority_graph.nodes.length,
}, null, 2));
process.stdout.write("\n");
