#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRunner } from "./lib/test_harness.mjs";
import { compilePerformanceReceipt, validatePerformanceReceipt } from "./lib/performance_receipt.mjs";

const run = createRunner({ name: "performance_receipt_tests", importMetaUrl: import.meta.url });

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

// One counted check per named behaviour; plain asserts inside each body keep
// the count faithful to the pre-harness runner (8).
run.check("a fully-specified receipt validates cleanly", () => {
  assert.deepEqual(validatePerformanceReceipt(receipt), []);
  return true;
});
run.check("the receipt records 11 spans", () => {
  assert.equal(receipt.spans.length, 11);
  return true;
});
run.check("workbook_build span duration is recorded", () => {
  assert.equal(receipt.spans.find((span) => span.name === "workbook_build").duration_ms, 77);
  return true;
});
run.check("validation span duration is recorded", () => {
  assert.equal(receipt.spans.find((span) => span.name === "validation").duration_ms, 91);
  return true;
});

const mutations = [
  (value) => { value.spans = value.spans.filter((span) => span.name !== "solver"); },
  (value) => { value.spans.find((span) => span.name === "recalculation").duration_ms = 0; },
  (value) => { value.spans.find((span) => span.name === "delivery").coverage_role = "root"; },
  (value) => { value.source_identity.runtime_closure_sha256 = "wrong"; },
  (value) => { value.input_bindings.build_result_sha256 = "f".repeat(64); },
];
run.check("every mutated receipt is refused", () => {
  for (const mutate of mutations) {
    const value = structuredClone(receipt);
    mutate(value);
    assert.ok(validatePerformanceReceipt(value).length > 0);
  }
  return true;
});

const incomplete = compilePerformanceReceipt({
  runId: "incomplete",
  runtimeClosureSha256: identity,
  attachmentStateSha256: "d".repeat(64),
  buildResultSha256: "e".repeat(64),
  attachmentPerformance: {},
  checkpointTimings: {},
});
run.check("an incomplete receipt is marked INCOMPLETE", () => {
  assert.equal(incomplete.status, "INCOMPLETE");
  return true;
});
run.check("the incomplete summary lists every missing span", () => {
  assert.equal(incomplete.summary.missing_span_names.length, 11);
  return true;
});
run.check("an incomplete receipt must not validate", () => {
  assert.ok(validatePerformanceReceipt(incomplete).length > 0);
  return true;
});

run.finish({ mutations_rejected: mutations.length + 1, violations: 0 });
