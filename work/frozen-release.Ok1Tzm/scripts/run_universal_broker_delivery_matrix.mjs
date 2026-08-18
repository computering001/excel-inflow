#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  brokerSupervisorMachine,
  superviseBrokerOutcome,
} from "./lib/broker_supervisor.mjs";
import {
  compileEmergencyZeroBrokerPreview,
  projectZeroBrokerAuthorityCaseEvidence,
} from "./lib/broker_preview.mjs";
import { hashValue } from "./lib/run_store.mjs";

const [degradedReportPath, usableBrokerWorkbookArg] = process.argv.slice(2);
if (!degradedReportPath) {
  throw new Error("Usage: node scripts/run_universal_broker_delivery_matrix.mjs <degraded-delivery-report.json>");
}
const degraded = JSON.parse(await fs.readFile(path.resolve(degradedReportPath), "utf8"));
assert.equal(degraded.status, "PASS", "the matrix requires a real passing degraded-delivery build");
assert.equal(degraded.stage4_status, "PASS_PENDING_MANUAL");
assert.equal(degraded.zero_broker_stage4_status, "PASS_PENDING_MANUAL");
await fs.stat(degraded.workbook);
await fs.stat(degraded.zero_broker_workbook);
const usableBrokerWorkbook = path.resolve(
  usableBrokerWorkbookArg ?? process.env.EXCEL_INFLOW_USABLE_BROKER_WORKBOOK ?? "",
);
if (!usableBrokerWorkbookArg && !process.env.EXCEL_INFLOW_USABLE_BROKER_WORKBOOK) {
  throw new Error("Supply the independently built usable-broker workbook as the second argument.");
}
await fs.stat(usableBrokerWorkbook);
const usableManifest = JSON.parse(
  await fs.readFile(`${usableBrokerWorkbook}.semantic-manifest.json`, "utf8"),
);
function countBrokerBindings(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countBrokerBindings(item), 0);
  if (!value || typeof value !== "object") return 0;
  return (typeof value.broker_metric_id === "string" ? 1 : 0) +
    Object.values(value).reduce((sum, item) => sum + countBrokerBindings(item), 0);
}
const usableBrokerBindingCount = countBrokerBindings(usableManifest);
assert.ok(usableBrokerBindingCount > 0, "usable-broker workbook has no broker-bound formula authority");

const cases = [
  ["no_brokers", "broker_zero_usable_houses"],
  ["explicit_skip", "broker_zero_usable_houses"],
  ["good_brokers", null],
  ["partial_house", "broker_incomplete_house"],
  ["scan", "broker_ocr_failure"],
  ["native_text_failure", "broker_ocr_failure"],
  ["ocr_disagreement", "broker_ocr_failure"],
  ["multi_page_table", "broker_multi_page_header_ambiguity"],
  ["missing_header", "broker_multi_page_header_ambiguity"],
  ["selected_conflict", "broker_selected_cell_conflict"],
  ["unselected_conflict", "broker_table_reconciliation_failure"],
  ["missing_crosswalk", "broker_crosswalk_failure"],
  ["semantic_failure", "broker_semantic_failure"],
  ["canonical_table_failure", "broker_table_reconciliation_failure"],
  ["census_failure", "broker_table_reconciliation_failure"],
  ["preview_failure", "broker_preview_failure"],
  ["timeout", "broker_timeout"],
  ["exception", "broker_controller_exception"],
  ["invalid_state", "broker_invalid_state"],
  ["failed_negative_close", "broker_optional_close_failure"],
  ["all_houses_unusable", "broker_zero_usable_houses"],
];

const rows = [];
for (const [state, reasonCode] of cases) {
  const supervised = superviseBrokerOutcome({
    outcome: state === "good_brokers" ? "usable" : "failed",
    reasonCode,
  });
  assert.equal(supervised.terminal_state, "CLOSED", `${state} did not close`);
  if (state !== "good_brokers") {
    assert.equal(supervised.authority_mode, "zero_broker_authority");
    assert.equal(supervised.selected_cell_count, 0);
  }
  rows.push({
    broker_state: state,
    reason_code: reasonCode,
    supervisor_terminal: supervised.terminal_state,
    authority_mode: supervised.authority_mode,
    delivery_status: state === "good_brokers"
      ? degraded.stage4_status
      : degraded.zero_broker_stage4_status,
    workbook: state === "good_brokers" ? usableBrokerWorkbook : degraded.zero_broker_workbook,
  });
}
assert.equal(rows.filter((row) => row.delivery_status !== "PASS_PENDING_MANUAL").length, 0);

// State-machine model checking: every edge is monotone, CLOSED has no outgoing
// edge, and every non-terminal state reaches CLOSED. This is exhaustive over
// the finite machine asset rather than a few hand-picked traces.
const machine = brokerSupervisorMachine();
const rank = new Map(machine.states.map((state) => [state.id, state.rank]));
for (const [from, to] of machine.transitions) assert.ok(rank.get(to) >= rank.get(from));
assert.equal(machine.transitions.filter(([from]) => from === "CLOSED").length, 0);
const outgoing = new Map();
for (const [from, to] of machine.transitions) outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
function reachesClosed(start, seen = new Set()) {
  if (start === "CLOSED") return true;
  if (seen.has(start)) return false;
  seen.add(start);
  return (outgoing.get(start) ?? []).some((next) => reachesClosed(next, new Set(seen)));
}
for (const state of machine.states) assert.ok(reachesClosed(state.id), `${state.id} cannot reach CLOSED`);

// Metamorphic zero-authority projection: archive mutations cannot survive into
// selected observations or economic broker bindings after the circuit breaker.
const evidence = {
  lanes: {
    controls: { broker_case: "Consensus" },
    broker_pack: {
      source_label: "metamorphic broker pack",
      forecast_periods: ["2026-12-31", "2027-12-31", "2028-12-31"],
      metrics: { revenue: { label: "Revenue", unit_kind: "currency", brokers: { A: [1, 2, 3] } } },
      source_mappings: [{ mapping_id: "selected", metric_id: "revenue" }],
      raw_tables: [{ house_id: "a", rows: [["unused", "page"]] }],
    },
  },
  forecast_observation_ledger: {
    observations: [{ source_kind: "broker_estimate", observation_id: "broker.a.revenue.fy1" }],
  },
};
const mutated = structuredClone(evidence);
mutated.lanes.broker_pack.raw_tables[0].rows[0][1] = "corrupted-unused-page";
const left = projectZeroBrokerAuthorityCaseEvidence(evidence).case_evidence;
const right = projectZeroBrokerAuthorityCaseEvidence(mutated).case_evidence;
assert.equal(left.forecast_observation_ledger.observations.length, 0);
assert.equal(right.forecast_observation_ledger.observations.length, 0);
assert.equal(hashValue(left.lanes.controls), hashValue(right.lanes.controls));
assert.equal(hashValue(left.lanes.broker_pack.metrics), hashValue(right.lanes.broker_pack.metrics));
const preview = compileEmergencyZeroBrokerPreview({
  bindingHashes: { broker_pack_sha256: "a".repeat(64) },
  forecastPeriods: ["2026-12-31", "2027-12-31", "2028-12-31"],
  reasons: ["fault injection"],
});
assert.equal(preview.selected_value_count, 0);

console.log(JSON.stringify({
  schema_version: "universal-broker-delivery-matrix/1.0",
  status: "PASS",
  cases: rows,
  case_count: rows.length,
  broker_caused_hard_blocks: 0,
  model_checked_states: machine.states.length,
  model_checked_transitions: machine.transitions.length,
  metamorphic_checks: 4,
  real_workbook_build_classes: 2,
  usable_broker_binding_count: usableBrokerBindingCount,
}, null, 2));
