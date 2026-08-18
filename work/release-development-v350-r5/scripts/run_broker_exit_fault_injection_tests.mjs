#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

import { compileEmergencyZeroBrokerPreview } from "./lib/broker_preview.mjs";
import { DELIVERY_CONSTITUTION } from "./lib/delivery_constitution.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  executeOptionalBrokerCircuitBreaker,
  optionalBrokerFailureReason,
} from "./lib/optional_broker_circuit_breaker.mjs";
import { superviseBrokerOutcome } from "./lib/broker_supervisor.mjs";

const passState = {
  pipeline_status: "PASS",
  lane_states: {
    filings: { pipeline_status: "PASS", blocker_class: null },
    broker: { pipeline_status: "PASS_DEGRADED", blocker_class: null },
    dcs: { pipeline_status: "PASS", blocker_class: null },
  },
};
const internalState = {
  pipeline_status: "BLOCKED_INTERNAL",
  lane_states: {
    filings: { pipeline_status: "PASS", blocker_class: null },
    broker: {
      pipeline_status: "BLOCKED_INTERNAL",
      blocker_class: "INTERNAL_WORK",
      summary: { terminal_reason: "degraded_close_missing_quarantine_receipt" },
    },
    dcs: { pipeline_status: "PASS", blocker_class: null },
  },
  summary: { terminal_reason: "degraded_close_missing_quarantine_receipt" },
};

const injected = [
  { id: "exception", error: new Error("adapter exploded"), expected: "broker_controller_exception" },
  { id: "timeout", error: new Error("broker adapter timed out"), expected: "broker_timeout" },
  { id: "missing_state", state: null, expected: "broker_invalid_state" },
  { id: "failed_optional_close", state: internalState, expected: "broker_optional_close_failure" },
];
let checks = 0;
const previewSchema = JSON.parse(
  fs.readFileSync(new URL("../assets/broker-preview-v1.schema.json", import.meta.url), "utf8"),
);
const emergencyPreview = compileEmergencyZeroBrokerPreview({
  bindingHashes: {
    broker_pack_sha256: "a".repeat(64),
    broker_source_tables_sha256: "b".repeat(64),
    broker_crosswalk_receipt_sha256: "c".repeat(64),
  },
  forecastPeriods: ["2026-12-31", "2027-12-31", "2028-12-31"],
  reasons: ["fault injection"],
});
assert.deepEqual(validateJsonSchema(emergencyPreview, previewSchema), []);
checks += 1;
for (const fault of injected) {
  let state = fault.state ?? null;
  let fallbackRuns = 0;
  const result = await executeOptionalBrokerCircuitBreaker({
    runPrimary: async () => {
      if (fault.error) throw fault.error;
    },
    readState: async () => state,
    runZeroAuthority: async () => {
      fallbackRuns += 1;
      state = passState;
    },
  });
  assert.equal(result.state.pipeline_status, "PASS");
  assert.equal(result.circuit_breaker_used, true);
  assert.equal(result.reason_code, fault.expected);
  assert.equal(fallbackRuns, 1);
  checks += 4;
}

assert.equal(optionalBrokerFailureReason({ state: {
  summary: { terminal_reason: "invalid_lane_state" },
} }), "broker_invalid_state");
checks += 1;

for (const reasonCode of DELIVERY_CONSTITUTION.degrade_reasons.filter(
  (reason) => reason.startsWith("broker_"),
)) {
  const supervised = superviseBrokerOutcome({
    outcome: "failed",
    reasonCode,
    attemptedSelection: !["broker_zero_usable_houses"].includes(reasonCode),
  });
  assert.equal(supervised.terminal_state, "CLOSED");
  assert.equal(supervised.authority_mode, "zero_broker_authority");
  assert.equal(supervised.selected_cell_count, 0);
  checks += 3;
}

console.log(JSON.stringify({
  schema_version: "broker-exit-fault-injection-report/1.0",
  status: "PASS",
  injected_exit_classes: injected.length,
  constitution_broker_reasons: DELIVERY_CONSTITUTION.degrade_reasons.filter(
    (reason) => reason.startsWith("broker_"),
  ).length,
  checks,
  broker_caused_hard_blocks: 0,
}, null, 2));
