#!/usr/bin/env node
import assert from "node:assert/strict";

import { compilePerformanceReceipt, validatePerformanceReceipt } from "./lib/performance_receipt.mjs";

const identity = "a".repeat(64);
const receipt = compilePerformanceReceipt({
  runId: "full-run",
  sourceCommit: "b".repeat(40),
  sourceTree: "c".repeat(40),
  runtimeClosureSha256: identity,
  attachmentStateSha256: "d".repeat(64),
  buildResultSha256: "e".repeat(64),
  attachmentPerformance: {
    host_preflight_ms: 7,
    filings: { source_acquisition_ms: 11, filing_extraction_ms: 22 },
    lane_duration_ms: { broker: 33 },
    semantic_recovery_ms: 44,
  },
  checkpointTimings: {
    plan: 55,
    semantic_gates: 66,
    emit: 40,
    terminal_patch: 37,
    recalculate: 88,
    verify_dynamic: 10,
    verify_style: 11,
    verify_cache: 12,
    verify_finance: 13,
    verify_semantic: 14,
    verify_aggregate: 15,
    render: 16,
    publish: 101,
  },
  totalDurationMs: 999,
});
assert.deepEqual(validatePerformanceReceipt(receipt), []);
assert.equal(receipt.spans.length, 11);
assert.equal(receipt.spans.find((span) => span.name === "workbook_build").duration_ms, 77);
assert.equal(receipt.spans.find((span) => span.name === "validation").duration_ms, 91);

const mutations = [
  (value) => { value.spans = value.spans.filter((span) => span.name !== "solver"); },
  (value) => { value.spans.find((span) => span.name === "recalculation").duration_ms = 0; },
  (value) => { value.spans.find((span) => span.name === "delivery").coverage_role = "root"; },
  (value) => { value.source_identity.runtime_closure_sha256 = "wrong"; },
  (value) => { value.input_bindings.build_result_sha256 = "f".repeat(64); },
];
for (const mutate of mutations) {
  const value = structuredClone(receipt);
  mutate(value);
  assert.ok(validatePerformanceReceipt(value).length > 0);
}

const incomplete = compilePerformanceReceipt({
  runId: "incomplete",
  runtimeClosureSha256: identity,
  attachmentStateSha256: "d".repeat(64),
  buildResultSha256: "e".repeat(64),
  attachmentPerformance: {},
  checkpointTimings: {},
});
assert.equal(incomplete.status, "INCOMPLETE");
assert.equal(incomplete.summary.missing_span_names.length, 11);
assert.ok(validatePerformanceReceipt(incomplete).length > 0);

console.log(JSON.stringify({ status: "PASS", checks: 8, mutations_rejected: mutations.length + 1, violations: 0 }, null, 2));
