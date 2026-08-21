#!/usr/bin/env node

import assert from "node:assert/strict";

import { createExperienceTrace, experienceCoverageSummary } from "./lib/experience_trace.mjs";

const spans = [
  { span_id: "root", parent_span_id: null, category: "excel_inflow_active", external_wait_reason: null, start_offset_ms: 0, end_offset_ms: 100, metadata: { coverage_role: "root" } },
  { span_id: "stage", parent_span_id: "root", category: "excel_inflow_active", external_wait_reason: null, start_offset_ms: 10, end_offset_ms: 90, metadata: {} },
  { span_id: "leaf", parent_span_id: "stage", category: "excel_inflow_active", external_wait_reason: null, start_offset_ms: 20, end_offset_ms: 40, metadata: {} },
  { span_id: "wait", parent_span_id: "stage", category: "known_external_wait", external_wait_reason: "native_excel", start_offset_ms: 60, end_offset_ms: 80, metadata: {} },
];
const summary = experienceCoverageSummary(spans, 100);
assert.deepEqual(summary.leaf_span_ids, ["leaf", "wait"]);
assert.equal(summary.classified_ms, 40);
assert.equal(summary.unknown_ms, 60);
assert.equal(summary.longest_unknown_gap_ms, 20);
assert.deepEqual(summary.unknown, [[0, 20], [40, 60], [80, 100]]);

const hostile = experienceCoverageSummary([spans[0]], 100);
assert.equal(hostile.classified_ms, 0, "A root-only trace still masked its unowned time.");
assert.equal(hostile.unknown_ms, 100);

assert.throws(
  () => createExperienceTrace({ runId: "scope-mutation", scope: "vnext_controller" }),
  /Unsupported experience-trace scope/,
  "An unregistered scope must fail before an invalid trace can be emitted.",
);

console.log(JSON.stringify({ status: "PASS", checks: 8, mutations_rejected: 2 }));
