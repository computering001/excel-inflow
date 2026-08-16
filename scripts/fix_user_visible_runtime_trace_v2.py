#!/usr/bin/env python3
"""Install a process-safe parent/child user-visible runtime trace contract."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
module = ROOT / "scripts" / "lib" / "user_visible_runtime_trace.mjs"
module.write_text(r'''import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function iso(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid user-visible runtime timestamp: ${value}`);
  }
  return parsed.toISOString();
}

function duration(start, end) {
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

function atomicWrite(target, value) {
  const absolute = path.resolve(target);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, absolute);
}

function readTrace(target) {
  try {
    const value = JSON.parse(fs.readFileSync(path.resolve(target), "utf8"));
    return value?.schema_version === "user-visible-runtime-trace/1.0"
      ? value
      : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function rootTrace(entrypoint, traceId, submittedAt, processStartedAt) {
  return {
    schema_version: "user-visible-runtime-trace/1.0",
    trace_id: traceId,
    run_id: process.env.EXCEL_INFLOW_RUN_ID ?? null,
    entrypoint,
    submitted_at: submittedAt,
    process_started_at: processStartedAt,
    visible_response_at: null,
    user_visible_duration_ms: null,
    attributed_span_duration_ms: 0,
    unattributed_duration_ms: null,
    attribution_coverage: null,
    spans: [],
  };
}

function recompute(trace) {
  const end = trace.visible_response_at ?? new Date().toISOString();
  trace.user_visible_duration_ms = duration(trace.submitted_at, end);
  const completed = trace.spans.filter(
    (span) => span.completed_at && Number.isFinite(Number(span.duration_ms)),
  );
  trace.attributed_span_duration_ms = completed.reduce(
    (sum, span) => sum + Number(span.duration_ms),
    0,
  );
  trace.unattributed_duration_ms = Math.max(
    0,
    trace.user_visible_duration_ms - trace.attributed_span_duration_ms,
  );
  trace.attribution_coverage = trace.user_visible_duration_ms === 0
    ? 1
    : Math.min(
        1,
        trace.attributed_span_duration_ms / trace.user_visible_duration_ms,
      );
  return trace;
}

function mergeSpan(trace, span) {
  const index = trace.spans.findIndex((candidate) => candidate.span_id === span.span_id);
  if (index >= 0) trace.spans[index] = span;
  else trace.spans.push(span);
  trace.spans.sort((left, right) =>
    String(left.started_at).localeCompare(String(right.started_at)) ||
    String(left.span_id).localeCompare(String(right.span_id)),
  );
}

/**
 * Join or create the one submission-to-visible-response trace.
 *
 * The host sets EXCEL_INFLOW_USER_SUBMISSION_AT and optionally TRACE_ID. Every
 * nested process inherits the same trace path and the parent span id. Each
 * process owns only its span; it never rewrites another process's span.
 */
export function initializeUserVisibleProcessTrace(entrypoint) {
  const outputPath = process.env.EXCEL_INFLOW_USER_TRACE_PATH;
  if (!outputPath) return null;
  const submittedAt = iso(process.env.EXCEL_INFLOW_USER_SUBMISSION_AT);
  const processStartedAt = new Date().toISOString();
  const traceId = process.env.EXCEL_INFLOW_TRACE_ID ?? crypto.randomUUID();
  const existing = readTrace(outputPath);
  if (existing && existing.trace_id !== traceId) {
    throw new Error("User-visible runtime trace id does not match the active transaction.");
  }
  const trace = existing ?? rootTrace(
    entrypoint,
    traceId,
    submittedAt,
    processStartedAt,
  );
  if (trace.submitted_at !== submittedAt) {
    throw new Error("Nested runtime process changed the user-submission boundary.");
  }
  const span = {
    span_id: crypto.randomUUID(),
    parent_span_id: process.env.EXCEL_INFLOW_PARENT_SPAN_ID ?? null,
    name: entrypoint,
    started_at: processStartedAt,
    completed_at: null,
    duration_ms: null,
    owner: "excel_inflow_process",
    process_id: process.pid,
  };
  mergeSpan(trace, span);
  recompute(trace);
  atomicWrite(outputPath, trace);

  // Every child process launched after this point inherits the same trace and
  // names this process span as parent without each caller having to reinvent a
  // telemetry propagation contract.
  process.env.EXCEL_INFLOW_TRACE_ID = traceId;
  process.env.EXCEL_INFLOW_PARENT_SPAN_ID = span.span_id;
  process.env.EXCEL_INFLOW_USER_SUBMISSION_AT = submittedAt;

  let completed = false;
  const complete = ({ visibleResponse = span.parent_span_id === null } = {}) => {
    if (completed) return;
    completed = true;
    const completedAt = new Date().toISOString();
    span.completed_at = completedAt;
    span.duration_ms = duration(span.started_at, completedAt);
    const latest = readTrace(outputPath) ?? trace;
    if (latest.trace_id !== traceId) {
      throw new Error("Runtime trace changed identity before process completion.");
    }
    mergeSpan(latest, span);
    if (visibleResponse) latest.visible_response_at = completedAt;
    recompute(latest);
    atomicWrite(outputPath, latest);
  };
  process.once("beforeExit", () => complete());
  process.once("exit", () => complete());
  return {
    trace_id: traceId,
    span_id: span.span_id,
    parent_span_id: span.parent_span_id,
    outputPath: path.resolve(outputPath),
    complete,
    childEnv(overrides = {}) {
      return {
        ...process.env,
        ...overrides,
        EXCEL_INFLOW_TRACE_ID: traceId,
        EXCEL_INFLOW_PARENT_SPAN_ID: span.span_id,
        EXCEL_INFLOW_USER_SUBMISSION_AT: submittedAt,
        EXCEL_INFLOW_USER_TRACE_PATH: path.resolve(outputPath),
      };
    },
  };
}
''', "utf-8")

test = ROOT / "scripts" / "run_user_visible_runtime_trace_tests.mjs"
test.write_text(r'''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeUserVisibleProcessTrace } from "./lib/user_visible_runtime_trace.mjs";

const target = path.join(os.tmpdir(), `excel-inflow-trace-${process.pid}.json`);
process.env.EXCEL_INFLOW_USER_TRACE_PATH = target;
process.env.EXCEL_INFLOW_USER_SUBMISSION_AT = new Date(Date.now() - 2500).toISOString();
process.env.EXCEL_INFLOW_TRACE_ID = "trace-test";
delete process.env.EXCEL_INFLOW_PARENT_SPAN_ID;
const parent = initializeUserVisibleProcessTrace("run_excel_inflow_vnext.mjs");
assert.ok(parent);
const parentId = parent.span_id;
process.env.EXCEL_INFLOW_PARENT_SPAN_ID = parentId;
const child = initializeUserVisibleProcessTrace("run_user_flow.mjs");
assert.ok(child);
assert.equal(child.parent_span_id, parentId);
child.complete({ visibleResponse: false });
parent.complete({ visibleResponse: true });
const trace = JSON.parse(fs.readFileSync(target, "utf8"));
assert.equal(trace.schema_version, "user-visible-runtime-trace/1.0");
assert.equal(trace.trace_id, "trace-test");
assert.equal(trace.spans.length, 2);
assert.equal(trace.spans.find((span) => span.span_id === child.span_id).parent_span_id, parentId);
assert.ok(trace.user_visible_duration_ms >= 2400);
assert.ok(trace.attributed_span_duration_ms >= 0);
assert.ok(trace.unattributed_duration_ms >= 0);
assert.ok(trace.attribution_coverage >= 0 && trace.attribution_coverage <= 1);
assert.ok(trace.visible_response_at);
console.log(JSON.stringify({
  status: "PASS",
  span_count: trace.spans.length,
  attribution_coverage: trace.attribution_coverage,
}, null, 2));
''', "utf-8")

print({"status": "PASS", "module": str(module.relative_to(ROOT))})
