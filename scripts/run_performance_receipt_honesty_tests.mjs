#!/usr/bin/env node
/**
 * P6.6 -- performance receipt honesty.
 *
 * The receipt must tell the truth: spans labelled with the work they actually
 * measure, measured time reconciled against the total through an explicit
 * unattributed bucket whose threshold is READ from assets/performance-policy-v1.json,
 * a warm/resumed run (reused checkpoints, duration 0) lawful rather than
 * structurally MISSING, and the receipt validated in the delivered path instead
 * of shipped INCOMPLETE.
 *
 * Every check below was RED before the P6.6 repair.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { compilePerformanceReceipt, validatePerformanceReceipt } from "./lib/performance_receipt.mjs";
import {
  PERFORMANCE_POLICY,
  PERFORMANCE_POLICY_REF,
  PERFORMANCE_POLICY_SHA256,
  TRACE_POLICY,
} from "./lib/experience_trace.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("../", import.meta.url).pathname;
let checks = 0;
const mutationsRejected = [];
function check(condition, label) {
  assert.ok(condition, label);
  checks += 1;
}
function rehash(receipt) {
  const { receipt_sha256: _ignored, ...body } = receipt;
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return {
    ...body,
    receipt_sha256: createHash("sha256").update(`${JSON.stringify(canonical(body))}\n`).digest("hex"),
  };
}
function rejects(mutate, label, expectedError) {
  const errors = validatePerformanceReceipt(mutate());
  assert.ok(errors.length > 0, `${label} was accepted by the validator`);
  if (expectedError) {
    assert.ok(
      errors.includes(expectedError),
      `${label} did not raise ${expectedError} (raised ${errors.join(", ")})`,
    );
  }
  mutationsRejected.push(label);
  checks += 1;
}

const identity = "a".repeat(64);
const bindings = {
  runtimeClosureSha256: identity,
  attachmentStateSha256: "d".repeat(64),
  buildResultSha256: "e".repeat(64),
};
const lanes = {
  host_preflight_ms: 7,
  filings: { source_acquisition_ms: 11, filing_extraction_ms: 22 },
  lane_duration_ms: { broker: 33 },
  semantic_recovery_ms: 44,
};
const COLD_TIMINGS = {
  semantic_gates: 6666,
  plan: 5555,
  emit: 40,
  recalculate: 88,
  terminal_patch: 37,
  verify_ownership_physical: 9,
  verify_dynamic: 10,
  verify_style: 11,
  verify_cache: 12,
  verify_finance: 13,
  verify_semantic: 14,
  verify_aggregate: 15,
  render_sheet_01: 4000,
  render_sheet_02: 4000,
  render_sheet_03: 4000,
  render: 16,
  publish: 101,
};
const COLD_SUM = Object.values(COLD_TIMINGS).reduce((a, b) => a + b, 0) + 7 + 11 + 22 + 33 + 44;
const cold = compilePerformanceReceipt({
  ...bindings,
  runId: "cold",
  attachmentPerformance: lanes,
  checkpointTimings: COLD_TIMINGS,
  reusedCheckpoints: [],
  executedCheckpoints: Object.keys(COLD_TIMINGS),
  totalDurationMs: COLD_SUM + 1000,
});
const span = (receipt, name) => receipt.spans.find((entry) => entry.name === name);

// ---------------------------------------------------------------- span labels
// Stage 4 runs runReleaseN0N9 under `semantic_gates` (that is the case compile)
// and build_dynamic_model.mjs --plan-only under `plan` (that is the solver).
check(span(cold, "solver").duration_ms === COLD_TIMINGS.plan, "solver is fed the plan/solver clock");
check(span(cold, "solver").owner === "stage4_plan_solver", "solver owner names the plan checkpoint");
check(
  span(cold, "case_compilation").duration_ms === COLD_TIMINGS.semantic_gates,
  "case_compilation is fed the semantic-compilation clock",
);
check(
  span(cold, "solver").duration_ms !== span(cold, "case_compilation").duration_ms,
  "solver time and gate time are distinguishable",
);
check(
  span(cold, "solver").attribution.observed_checkpoint_ids.join(",") === "plan" &&
    span(cold, "case_compilation").attribution.observed_checkpoint_ids.join(",") === "semantic_gates",
  "each span declares the checkpoint ids it claims",
);

// ------------------------------------------------------- render leaf inclusion
check(
  span(cold, "validation").duration_ms === 12 * 1000 + 9 + 10 + 11 + 12 + 13 + 14 + 15 + 16,
  "render_sheet_NN leaves and verify_ownership_physical are inside the validation span",
);
check(
  ["render_sheet_01", "render_sheet_02", "render_sheet_03", "verify_ownership_physical"].every((id) =>
    span(cold, "validation").attribution.observed_checkpoint_ids.includes(id),
  ),
  "validation declares the render leaves it claims",
);
check(cold.reconciliation.unmapped_checkpoint_ids.length === 0, "every stage-4 checkpoint id is attributed");

// ------------------------------------------------- reconciliation and bucket
check(cold.reconciliation.measured_ms === COLD_SUM, "measured time is the sum of the leaf spans");
check(cold.reconciliation.unattributed_ms === 1000, "the unattributed bucket is explicit");
check(cold.summary.measured_span_ms === COLD_SUM, "the summary republishes the measured total");
check(cold.reconciliation.band === "WITHIN_ALLOWANCE", "a 1s gap is inside the declared allowance");
check(cold.status === "PASS" && validatePerformanceReceipt(cold).length === 0, "an honest cold receipt validates");

const explicitBrokerSkip = compilePerformanceReceipt({
  ...bindings,
  runId: "explicit-broker-skip",
  attachmentPerformance: {
    ...lanes,
    lane_duration_ms: { broker: 0 },
    broker_intake_state: "explicitly_skipped",
  },
  checkpointTimings: COLD_TIMINGS,
  reusedCheckpoints: [],
  executedCheckpoints: Object.keys(COLD_TIMINGS),
  totalDurationMs: COLD_SUM - 33 + 1000,
});
check(
  span(explicitBrokerSkip, "broker_native_extraction").status === "NOT_APPLICABLE" &&
    span(explicitBrokerSkip, "broker_native_extraction").duration_ms === 0 &&
    span(explicitBrokerSkip, "broker_native_extraction").lawful_zero_reason ===
      "broker_explicitly_skipped" &&
    explicitBrokerSkip.status === "PASS" &&
    validatePerformanceReceipt(explicitBrokerSkip).length === 0,
  "an explicit broker skip emits one lawful zero span instead of incomplete telemetry",
);

// ----------------------------------------------------- threshold provenance
const policyBytes = readFileSync(new URL("../assets/performance-policy-v1.json", import.meta.url), "utf8");
check(
  PERFORMANCE_POLICY_SHA256 === createHash("sha256").update(policyBytes).digest("hex"),
  "the policy digest binds the asset bytes",
);
check(PERFORMANCE_POLICY_REF === "assets/performance-policy-v1.json", "the threshold source is declared by path");
check(
  cold.input_bindings.performance_policy_sha256 === PERFORMANCE_POLICY_SHA256 &&
    cold.reconciliation.threshold_source.policy_sha256 === PERFORMANCE_POLICY_SHA256,
  "the receipt binds the policy asset it was judged against",
);
check(
  TRACE_POLICY.warning_ms === PERFORMANCE_POLICY.trace.unknown_gap_warning_ms &&
    TRACE_POLICY.investigation_ms === PERFORMANCE_POLICY.trace.unknown_gap_investigation_ms &&
    TRACE_POLICY.certification_block_ms === PERFORMANCE_POLICY.trace.unknown_internal_gap_certification_block_ms &&
    TRACE_POLICY.initial_target === PERFORMANCE_POLICY.trace.initial_classification_target &&
    TRACE_POLICY.engineering_target === PERFORMANCE_POLICY.trace.engineering_classification_target,
  "the trace policy is read from the asset, not from literals",
);
const traceSource = readFileSync(new URL("./lib/experience_trace.mjs", import.meta.url), "utf8");
check(
  !/warning_ms:\s*30000/.test(traceSource) && !/certification_block_ms:\s*300000/.test(traceSource),
  "the duplicated threshold literals are gone from experience_trace.mjs",
);
const receiptSource = readFileSync(new URL("./lib/performance_receipt.mjs", import.meta.url), "utf8");
check(
  !/30000|120000|300000|0\.95|0\.98/.test(receiptSource),
  "performance_receipt.mjs invents no threshold of its own",
);

// ------------------------------------- warm / resumed run: REUSED is LAWFUL
const WARM_IDS = Object.keys(COLD_TIMINGS);
const warmTimings = Object.fromEntries(WARM_IDS.map((id) => [id, 0]));
const warm = compilePerformanceReceipt({
  ...bindings,
  runId: "warm",
  attachmentPerformance: lanes,
  checkpointTimings: warmTimings,
  reusedCheckpoints: WARM_IDS,
  executedCheckpoints: [],
  totalDurationMs: 4200,
});
check(warm.summary.missing_span_names.length === 0, "a fully resumed run has no MISSING span");
check(warm.summary.leaf_span_coverage_ratio === 1, "a fully resumed run is fully covered");
check(
  warm.summary.reused_span_names.join(",") === "case_compilation,solver,workbook_build,recalculation,validation,delivery",
  "the resumed stage-4 spans are named as reused",
);
check(
  span(warm, "solver").status === "REUSED" &&
    span(warm, "solver").duration_ms === 0 &&
    span(warm, "solver").lawful_zero_reason === "checkpoint_reuse",
  "a reused checkpoint records a lawful zero",
);
check(warm.status === "PASS" && validatePerformanceReceipt(warm).length === 0, "a warm receipt validates");

// A PARTIAL resume: only the render leaves were reused, everything else ran.
const partialTimings = { ...COLD_TIMINGS, render_sheet_01: 0, render_sheet_02: 0, render_sheet_03: 0 };
const partial = compilePerformanceReceipt({
  ...bindings,
  runId: "partial",
  attachmentPerformance: lanes,
  checkpointTimings: partialTimings,
  reusedCheckpoints: ["render_sheet_01", "render_sheet_02", "render_sheet_03"],
  executedCheckpoints: WARM_IDS.filter((id) => !id.startsWith("render_sheet_")),
  totalDurationMs: 90_000,
});
check(
  span(partial, "validation").status === "PASS" &&
    span(partial, "validation").duration_ms === 9 + 10 + 11 + 12 + 13 + 14 + 15 + 16,
  "a partially reused span keeps the executed time it really measured",
);
check(validatePerformanceReceipt(partial).length === 0, "a partial resume validates");

// Reuse is the ONLY lawful zero: an executed checkpoint reporting 0 stays MISSING.
const zeroExecuted = compilePerformanceReceipt({
  ...bindings,
  runId: "zero-executed",
  attachmentPerformance: lanes,
  checkpointTimings: { ...COLD_TIMINGS, plan: 0 },
  reusedCheckpoints: [],
  executedCheckpoints: WARM_IDS,
  totalDurationMs: COLD_SUM,
});
check(
  span(zeroExecuted, "solver").status === "MISSING" && zeroExecuted.status === "INCOMPLETE",
  "an executed checkpoint reporting zero is still MISSING",
);
check(validatePerformanceReceipt(zeroExecuted).length > 0, "a zero-duration executed span fails validation");

// The pre-P6.6 regression itself: warm timings with NO reuse evidence.
const warmWithoutReuse = compilePerformanceReceipt({
  ...bindings,
  runId: "warm-unproven",
  attachmentPerformance: lanes,
  checkpointTimings: warmTimings,
  totalDurationMs: 4200,
});
check(
  warmWithoutReuse.status === "INCOMPLETE" && warmWithoutReuse.summary.missing_span_names.length === 6,
  "zero duration without declared reuse is not lawful",
);

// ------------------------------------------------------------ unattributed
const unattributed = compilePerformanceReceipt({
  ...bindings,
  runId: "unattributed",
  attachmentPerformance: lanes,
  checkpointTimings: COLD_TIMINGS,
  reusedCheckpoints: [],
  executedCheckpoints: WARM_IDS,
  totalDurationMs: COLD_SUM + TRACE_POLICY.certification_block_ms + 1,
});
check(
  unattributed.reconciliation.unattributed_ms === TRACE_POLICY.certification_block_ms + 1 &&
    unattributed.reconciliation.band === "CERTIFICATION_BLOCK",
  "unattributed time over the declared allowance is banded CERTIFICATION_BLOCK",
);
check(unattributed.status === "UNATTRIBUTED", "the receipt status reports unreconciled time");
check(
  validatePerformanceReceipt(unattributed).includes("unattributed_time"),
  "unattributed time over threshold fails validation",
);
const warned = compilePerformanceReceipt({
  ...bindings,
  runId: "warned",
  attachmentPerformance: lanes,
  checkpointTimings: COLD_TIMINGS,
  reusedCheckpoints: [],
  executedCheckpoints: WARM_IDS,
  totalDurationMs: COLD_SUM + TRACE_POLICY.warning_ms + 1,
});
check(
  warned.reconciliation.band === "WARNING" &&
    warned.reconciliation.meets_initial_target === false &&
    validatePerformanceReceipt(warned).length === 0,
  "a warning-band gap is recorded, not blocked (the policy blocks only over the certification allowance)",
);

// An unmapped checkpoint id is a structural attribution hole, not silence.
const unmapped = compilePerformanceReceipt({
  ...bindings,
  runId: "unmapped",
  attachmentPerformance: lanes,
  checkpointTimings: { ...COLD_TIMINGS, brand_new_leaf: 5000 },
  reusedCheckpoints: [],
  executedCheckpoints: [...WARM_IDS, "brand_new_leaf"],
  totalDurationMs: COLD_SUM + 5000,
});
check(
  unmapped.reconciliation.unmapped_checkpoint_ids.join(",") === "brand_new_leaf" &&
    unmapped.reconciliation.unmapped_checkpoint_ms === 5000 &&
    validatePerformanceReceipt(unmapped).includes("unmapped_checkpoint"),
  "an unattributed checkpoint leaf is named and fails validation",
);

// ------------------------------------------------------------- mutations
// 1. A MISLABELLED span: solver claims the semantic-gate clock. Rehashed, so
//    only the label<->work rule can catch it.
rejects(
  () => {
    const value = structuredClone(cold);
    const solver = value.spans.find((entry) => entry.name === "solver");
    const compile = value.spans.find((entry) => entry.name === "case_compilation");
    solver.attribution.observed_checkpoint_ids = ["semantic_gates"];
    compile.attribution.observed_checkpoint_ids = ["plan"];
    return rehash(value);
  },
  "mislabelled span (solver fed the gate clock)",
  "mislabelled:solver",
);
// 2. Unattributed time hidden by a forged bucket.
rejects(
  () => {
    const value = structuredClone(unattributed);
    value.reconciliation.unattributed_ms = 0;
    value.reconciliation.band = "WITHIN_ALLOWANCE";
    value.reconciliation.time_status = "PASS";
    value.reconciliation.status = "PASS";
    value.summary.unattributed_ms = 0;
    value.status = "PASS";
    return rehash(value);
  },
  "forged unattributed bucket",
  "reconciliation",
);
// 3. A warm run regressed back to MISSING spans.
rejects(
  () => {
    const value = structuredClone(warm);
    const solver = value.spans.find((entry) => entry.name === "solver");
    solver.status = "MISSING";
    solver.duration_ms = null;
    solver.lawful_zero_reason = null;
    value.summary.missing_span_names = ["solver"];
    value.summary.reused_span_names = value.summary.reused_span_names.filter((name) => name !== "solver");
    value.summary.observed_leaf_span_count -= 1;
    value.summary.leaf_span_coverage_ratio = 0.9;
    value.status = "INCOMPLETE";
    return rehash(value);
  },
  "warm run regressed to MISSING",
  "duration",
);
// 4. A lawful zero claimed without declared reuse.
rejects(
  () => {
    const value = structuredClone(warm);
    value.checkpoint_reuse.reused_checkpoint_ids = value.checkpoint_reuse.reused_checkpoint_ids.filter(
      (id) => id !== "plan",
    );
    return rehash(value);
  },
  "REUSED claimed without declared reuse",
  "reused_zero_not_lawful",
);
// 5. Double counting one checkpoint under two spans.
rejects(
  () => {
    const value = structuredClone(cold);
    value.spans.find((entry) => entry.name === "recalculation").attribution.observed_checkpoint_ids = [
      "recalculate",
      "publish",
    ];
    return rehash(value);
  },
  "one checkpoint claimed by two spans",
  "duplicate_attribution",
);
// 6. A foreign threshold source.
rejects(
  () => {
    const value = structuredClone(cold);
    value.input_bindings.performance_policy_sha256 = "f".repeat(64);
    value.reconciliation.threshold_source.policy_sha256 = "f".repeat(64);
    return rehash(value);
  },
  "threshold source not the policy asset",
  "threshold_source",
);
// 7. Over-attribution: measured time exceeding the wall clock.
rejects(
  () => {
    const value = structuredClone(cold);
    value.total_duration_ms = 10;
    return rehash(value);
  },
  "measured time over the wall clock",
  "reconciliation",
);
// 8. The legacy tamper surface still closed.
rejects(
  () => {
    const value = structuredClone(cold);
    value.spans.find((entry) => entry.name === "delivery").coverage_role = "root";
    return rehash(value);
  },
  "root span substituted for a leaf",
  "coverage_role",
);
rejects(() => {
  const value = structuredClone(cold);
  value.spans = value.spans.filter((entry) => entry.name !== "solver");
  return value;
}, "required span deleted", "span:solver");

// -------------------------------------------- production caller (static pins)
const vnext = readFileSync(new URL("./run_excel_inflow_vnext.mjs", import.meta.url), "utf8");
check(/import \{ compilePerformanceReceipt, validatePerformanceReceipt \}/.test(vnext), "vnext imports the validator");
check(
  /const performanceReceiptErrors = validatePerformanceReceipt\(performanceReceipt\);/.test(vnext),
  "vnext validates the receipt it just compiled",
);
check(
  /reusedCheckpoints: buildResult\?\.checkpointing\?\.reused \?\? \[\]/.test(vnext) &&
    /executedCheckpoints: buildResult\?\.checkpointing\?\.executed \?\? \[\]/.test(vnext),
  "vnext passes the stage-4 reuse sets into the receipt",
);
check(
  /artifacts\.performance_receipt_validation = performanceReceiptValidationPath;/.test(vnext) &&
    /PERFORMANCE_RECEIPT_NOT_HONEST/.test(vnext),
  "an invalid receipt is a typed, artifact-backed finding",
);
check(
  /ACTIVE_PERFORMANCE\.receipt = \{/.test(vnext),
  "the finding travels in the delivered run summary",
);
const orchestrator = readFileSync(new URL("./orchestrate_release.mjs", import.meta.url), "utf8");
check(
  /reused: \[\.\.\.reusedCheckpoints\]\.sort\(compareCheckpointSequence\),\n\s+executed: \[\.\.\.executedCheckpoints\]\.sort\(compareCheckpointSequence\),\n\s+receipts: checkpointReceipts,\n\s+timings_ms: timingsMs,/.test(
    orchestrator,
  ),
  "stage 4 publishes reused[], executed[] and timings_ms together",
);
check(HERE.endsWith("/scripts/") && ROOT.endsWith("/"), "suite resolved its own repository paths");

console.log(JSON.stringify({ status: "PASS", checks, mutations_rejected: mutationsRejected.length, violations: 0 }));
