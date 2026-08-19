#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  brokerSupervisorMachine,
  superviseBrokerOutcome,
} from "./lib/broker_supervisor.mjs";
import {
  compileEmergencyZeroBrokerPreview,
  projectZeroBrokerAuthorityCaseEvidence,
} from "./lib/broker_preview.mjs";
import { hashValue } from "./lib/run_store.mjs";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const [cleanFixtureArg, pythonArg, sofficeArg] = process.argv.slice(2);
if (!cleanFixtureArg || !pythonArg || !sofficeArg) {
  throw new Error(
    "Usage: node scripts/run_universal_broker_delivery_matrix.mjs " +
    "<clean-evidence-fixture.json> <python> <soffice>",
  );
}
const cleanFixture = path.resolve(cleanFixtureArg);
const python = path.resolve(pythonArg);
const soffice = path.resolve(sofficeArg);
await Promise.all([cleanFixture, python, soffice].map((target) => fs.stat(target)));

// Every row enters through the public raw-input canary and creates a fresh raw
// PDF/CSV transaction, evidence graph, model case and workbook. No workbook is
// reused to stand in for another broker state.
const rawClasses = [];
for (const brokerState of ["explicit_skip", "failed_optional_close", "usable"]) {
  for (const dcsBalanceBasis of ["native_principal", "reporting_currency_carrying_value"]) {
    const executed = await exec(process.execPath, [
      path.join(here, "run_raw_input_black_box_canary.mjs"),
      cleanFixture,
      python,
      soffice,
      "--broker-state", brokerState,
      "--dcs-balance-basis", dcsBalanceBasis,
    ], {
      cwd: root,
      timeout: 1_800_000,
      maxBuffer: 128 * 1024 * 1024,
    });
    const receipt = JSON.parse(executed.stdout);
    assert.equal(receipt.status, "PASS");
    assert.equal(receipt.broker_state, brokerState);
    assert.equal(receipt.dcs_balance_basis, dcsBalanceBasis);
    assert.ok(Object.values(receipt.branch_receipts).every((value) => value === true));
    assert.ok(receipt.workbook_bytes > 0);
    await fs.stat(receipt.workbook);
    rawClasses.push(receipt);
  }
}
assert.equal(new Set(rawClasses.map((row) => row.workbook)).size, rawClasses.length);
assert.equal(new Set(rawClasses.map((row) => row.run_root)).size, rawClasses.length);

for (const dcsBalanceBasis of ["native_principal", "reporting_currency_carrying_value"]) {
  const rows = rawClasses.filter((row) => row.dcs_balance_basis === dcsBalanceBasis);
  const skip = rows.find((row) => row.broker_state === "explicit_skip");
  const failed = rows.find((row) => row.broker_state === "failed_optional_close");
  const usable = rows.find((row) => row.broker_state === "usable");
  assert.equal(skip.runtime_broker_selected_value_count, 0);
  assert.equal(failed.runtime_broker_selected_value_count, 0);
  assert.equal(skip.selected_broker_case, "Forecast Waterfall");
  assert.equal(failed.selected_broker_case, "Forecast Waterfall");
  assert.equal(
    skip.economic_signature_sha256,
    failed.economic_signature_sha256,
    `failed optional broker close changed zero-authority economics for ${dcsBalanceBasis}`,
  );
  assert.ok(usable.runtime_broker_selected_value_count > 0);
  assert.notEqual(usable.selected_broker_case, "Forecast Waterfall");
  assert.notEqual(
    usable.economic_signature_sha256,
    skip.economic_signature_sha256,
    `usable broker authority did not change economics for ${dcsBalanceBasis}`,
  );
}

// The larger taxonomy is the exhaustive finite controller model. Its cases
// map to an independently proven raw build class; they do not pretend that one
// reused workbook is 21 separate black-box deliveries.
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
const stateRows = cases.map(([state, reasonCode]) => {
  const supervised = superviseBrokerOutcome({
    outcome: state === "good_brokers" ? "usable" : "failed",
    reasonCode,
  });
  assert.equal(supervised.terminal_state, "CLOSED", `${state} did not close`);
  if (state !== "good_brokers") {
    assert.equal(supervised.authority_mode, "zero_broker_authority");
    assert.equal(supervised.selected_cell_count, 0);
  }
  return {
    broker_state: state,
    reason_code: reasonCode,
    supervisor_terminal: supervised.terminal_state,
    authority_mode: supervised.authority_mode,
    raw_delivery_proof_class: state === "good_brokers" ? "usable" : "failed_or_absent",
  };
});

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

// Metamorphic containment: changing archive-only bytes changes the input hash,
// but cannot create a selected observation or economic broker binding after
// zero-authority projection.
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
assert.notEqual(hashValue(evidence), hashValue(mutated));
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
  schema_version: "universal-broker-delivery-matrix/2.0",
  status: "PASS",
  raw_delivery_runs: rawClasses.map((row) => ({
    broker_state: row.broker_state,
    dcs_balance_basis: row.dcs_balance_basis,
    broker_selected_value_count: row.runtime_broker_selected_value_count,
    selected_broker_case: row.selected_broker_case,
    economic_signature_sha256: row.economic_signature_sha256,
    workbook: row.workbook,
    workbook_bytes: row.workbook_bytes,
  })),
  raw_delivery_run_count: rawClasses.length,
  unique_workbook_count: new Set(rawClasses.map((row) => row.workbook)).size,
  zero_authority_economic_parity_checks: 2,
  usable_authority_economic_mutation_checks: 2,
  controller_cases: stateRows,
  controller_case_count: stateRows.length,
  broker_caused_hard_blocks: 0,
  model_checked_states: machine.states.length,
  model_checked_transitions: machine.transitions.length,
  metamorphic_checks: 6,
}, null, 2));
