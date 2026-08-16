import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const EXPERIENCE_TRACE_SCHEMA = "excel-inflow-experience-trace/1.0";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function now() {
  return new Date().toISOString();
}

function atomicWrite(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

function targetPath(traceId, explicitPath = null) {
  if (explicitPath) return path.resolve(explicitPath);
  if (process.env.EXCEL_INFLOW_EXPERIENCE_TRACE_PATH) {
    return path.resolve(process.env.EXCEL_INFLOW_EXPERIENCE_TRACE_PATH);
  }
  const root = process.env.EXCEL_INFLOW_RUN_ROOT
    ? path.resolve(process.env.EXCEL_INFLOW_RUN_ROOT)
    : os.tmpdir();
  return path.join(root, `excel-inflow-experience-${traceId}.json`);
}

export function beginExperienceTrace({
  runId = process.env.EXCEL_INFLOW_RUN_ID ?? null,
  component = "public_controller",
  outputPath = null,
} = {}) {
  const traceId = process.env.EXCEL_INFLOW_EXPERIENCE_TRACE_ID || crypto.randomUUID();
  const rootSpanId = crypto.randomUUID();
  const output = targetPath(traceId, outputPath);
  const startedAt = now();
  const spans = [{
    span_id: rootSpanId,
    parent_span_id: null,
    component,
    phase: "user_submission_to_visible_response",
    started_at: startedAt,
    completed_at: null,
    outcome: "OPEN",
    retry_count: 0,
    reused: false,
    wait_reason: null,
    attributes: {},
  }];
  let finalized = false;
  const trace = {
    schema_version: EXPERIENCE_TRACE_SCHEMA,
    trace_id: traceId,
    run_id: runId,
    root_span_id: rootSpanId,
    created_at: startedAt,
    completed_at: null,
    visible_response_at: null,
    status: "OPEN",
    spans,
    trace_sha256: null,
  };

  process.env.EXCEL_INFLOW_EXPERIENCE_TRACE_ID = traceId;
  process.env.EXCEL_INFLOW_EXPERIENCE_TRACE_PATH = output;
  process.env.EXCEL_INFLOW_EXPERIENCE_ROOT_SPAN_ID = rootSpanId;

  const persist = () => {
    const unsigned = { ...trace, trace_sha256: null };
    trace.trace_sha256 = sha256(unsigned);
    atomicWrite(output, trace);
  };
  persist();

  const startSpan = ({
    component: childComponent,
    phase,
    parentSpanId = rootSpanId,
    attributes = {},
    retryCount = 0,
    reused = false,
    waitReason = null,
  }) => {
    if (finalized) throw new Error("Cannot start a span after the experience trace is finalized.");
    const span = {
      span_id: crypto.randomUUID(),
      parent_span_id: parentSpanId,
      component: childComponent,
      phase,
      started_at: now(),
      completed_at: null,
      outcome: "OPEN",
      retry_count: Number(retryCount) || 0,
      reused: Boolean(reused),
      wait_reason: waitReason,
      attributes: canonical(attributes),
    };
    spans.push(span);
    persist();
    return span.span_id;
  };

  const endSpan = (spanId, { outcome = "PASS", attributes = {} } = {}) => {
    const span = spans.find((candidate) => candidate.span_id === spanId);
    if (!span) throw new Error(`Unknown experience span ${spanId}.`);
    if (span.completed_at) throw new Error(`Experience span ${spanId} is already closed.`);
    span.completed_at = now();
    span.outcome = outcome;
    span.attributes = canonical({ ...span.attributes, ...attributes });
    persist();
  };

  const markVisibleResponse = ({ status = "COMPLETE", attributes = {} } = {}) => {
    if (!trace.visible_response_at) trace.visible_response_at = now();
    const root = spans[0];
    root.attributes = canonical({ ...root.attributes, visible_status: status, ...attributes });
    persist();
  };

  const finalize = ({ outcome = "PASS", attributes = {} } = {}) => {
    if (finalized) return output;
    finalized = true;
    const root = spans[0];
    if (!root.completed_at) root.completed_at = now();
    root.outcome = outcome;
    root.attributes = canonical({ ...root.attributes, ...attributes });
    trace.completed_at = root.completed_at;
    trace.status = outcome;
    persist();
    return output;
  };

  const failFromError = (error, origin) => finalize({
    outcome: "FAIL",
    attributes: {
      failure_origin: origin,
      error_name: error?.name ?? "Error",
      error_message: String(error?.message ?? error),
    },
  });

  process.once("beforeExit", () => finalize({
    outcome: process.exitCode && process.exitCode !== 0 ? "FAIL" : "PASS",
  }));
  process.once("uncaughtExceptionMonitor", (error, origin) => failFromError(error, origin));
  process.once("unhandledRejection", (reason) => failFromError(
    reason instanceof Error ? reason : new Error(String(reason)),
    "unhandledRejection",
  ));

  return {
    traceId,
    rootSpanId,
    outputPath: output,
    startSpan,
    endSpan,
    markVisibleResponse,
    finalize,
  };
}

export default { beginExperienceTrace, EXPERIENCE_TRACE_SCHEMA };
