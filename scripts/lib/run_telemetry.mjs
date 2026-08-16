import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const RUN_TELEMETRY_SCHEMA = "excel-inflow-run-telemetry/1.0";
const PROCESS_STARTED_AT = new Date().toISOString();
const PROCESS_STARTED_MS = Date.parse(PROCESS_STARTED_AT);

function iso(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}
function id(prefix) { return `${prefix}.${crypto.randomUUID()}`; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return crypto.createHash("sha256").update(`${JSON.stringify(canonical(value))}\n`).digest("hex"); }
function safeComponent(value) { return String(value ?? "process").replaceAll(/[^A-Za-z0-9_.-]+/g, "_"); }

export function createRunTelemetry({
  component = "process",
  runId = process.env.EXCEL_INFLOW_RUN_ID ?? null,
  traceId = process.env.EXCEL_INFLOW_TRACE_ID ?? id("trace"),
  userSubmittedAt = process.env.EXCEL_INFLOW_USER_SUBMITTED_AT ?? PROCESS_STARTED_AT,
  parentSpanId = process.env.EXCEL_INFLOW_PARENT_SPAN_ID ?? null,
  sourceIdentity = null,
} = {}) {
  const trace = {
    schema_version: RUN_TELEMETRY_SCHEMA,
    trace_id: traceId,
    run_id: runId,
    component: safeComponent(component),
    process_id: process.pid,
    parent_span_id: parentSpanId,
    user_submitted_at: iso(userSubmittedAt, PROCESS_STARTED_AT),
    process_started_at: PROCESS_STARTED_AT,
    visible_response_at: null,
    source_identity: sourceIdentity,
    spans: [],
    events: [],
    status: "OPEN",
  };
  const open = new Map();
  const startSpan = (name, attributes = {}) => {
    const span = {
      span_id: id("span"),
      parent_span_id: attributes.parent_span_id ?? parentSpanId,
      name: String(name),
      kind: attributes.kind ?? "internal",
      owner: attributes.owner ?? trace.component,
      started_at: new Date().toISOString(),
      ended_at: null,
      duration_ms: null,
      status: "OPEN",
      attributes: { ...attributes },
    };
    delete span.attributes.parent_span_id;
    open.set(span.span_id, span);
    trace.spans.push(span);
    return span.span_id;
  };
  const endSpan = (spanId, { status = "OK", attributes = {} } = {}) => {
    const span = open.get(spanId);
    if (!span) throw new Error(`Telemetry span ${spanId} is not open.`);
    span.ended_at = new Date().toISOString();
    span.duration_ms = Math.max(0, Date.parse(span.ended_at) - Date.parse(span.started_at));
    span.status = status;
    span.attributes = { ...span.attributes, ...attributes };
    open.delete(spanId);
    return span;
  };
  const event = (name, attributes = {}) => trace.events.push({
    event_id: id("event"), name: String(name), recorded_at: new Date().toISOString(), attributes: { ...attributes },
  });
  const markVisibleResponse = (attributes = {}) => {
    trace.visible_response_at = new Date().toISOString();
    event("visible_response", attributes);
  };
  const close = ({ status = "PASS", visibleResponse = false } = {}) => {
    if (visibleResponse && !trace.visible_response_at) markVisibleResponse({ status });
    for (const spanId of [...open.keys()]) endSpan(spanId, { status: status === "PASS" ? "OK" : "ERROR", attributes: { closed_by_trace: true } });
    trace.status = status;
    trace.process_ended_at = new Date().toISOString();
    trace.process_duration_ms = Math.max(0, Date.parse(trace.process_ended_at) - PROCESS_STARTED_MS);
    trace.user_visible_duration_ms = trace.visible_response_at
      ? Math.max(0, Date.parse(trace.visible_response_at) - Date.parse(trace.user_submitted_at))
      : null;
    const body = { ...trace };
    trace.telemetry_sha256 = hash(body);
    return trace;
  };
  return { trace, startSpan, endSpan, event, markVisibleResponse, close };
}

export async function writeRunTelemetry(target, telemetry) {
  const absolute = path.resolve(target);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const temp = `${absolute}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(canonical(telemetry), null, 2)}\n`, "utf8");
  await fsp.rename(temp, absolute);
  return absolute;
}

function intervals(spans) {
  return spans
    .filter((span) => span.started_at && span.ended_at)
    .map((span) => [Date.parse(span.started_at), Date.parse(span.ended_at)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .sort((a, b) => a[0] - b[0]);
}
function unionDuration(items) {
  let total = 0; let current = null;
  for (const item of items) {
    if (!current) { current = [...item]; continue; }
    if (item[0] <= current[1]) current[1] = Math.max(current[1], item[1]);
    else { total += current[1] - current[0]; current = [...item]; }
  }
  if (current) total += current[1] - current[0];
  return total;
}

export function mergeRunTelemetry(traces, { visibleResponseAt = null } = {}) {
  if (!Array.isArray(traces) || traces.length === 0) throw new Error("At least one telemetry trace is required.");
  const traceIds = new Set(traces.map((trace) => trace.trace_id));
  if (traceIds.size !== 1) throw new Error("Telemetry traces do not share one trace_id.");
  const submitted = traces.map((trace) => Date.parse(trace.user_submitted_at)).filter(Number.isFinite);
  const starts = traces.map((trace) => Date.parse(trace.process_started_at)).filter(Number.isFinite);
  const ends = traces.map((trace) => Date.parse(trace.process_ended_at ?? trace.visible_response_at)).filter(Number.isFinite);
  const visible = Date.parse(visibleResponseAt ?? traces.map((trace) => trace.visible_response_at).filter(Boolean).sort().at(-1) ?? new Date(Math.max(...ends)).toISOString());
  const start = Math.min(...submitted, ...starts);
  const total = Math.max(0, visible - start);
  const allSpans = traces.flatMap((trace) => trace.spans ?? []);
  const attributed = unionDuration(intervals(allSpans));
  const summary = {
    schema_version: "excel-inflow-run-telemetry-summary/1.0",
    trace_id: traces[0].trace_id,
    run_ids: [...new Set(traces.map((trace) => trace.run_id).filter(Boolean))],
    user_submitted_at: new Date(start).toISOString(),
    visible_response_at: new Date(visible).toISOString(),
    user_visible_duration_ms: total,
    attributed_span_ms: attributed,
    unattributed_gap_ms: Math.max(0, total - attributed),
    attribution_ratio: total === 0 ? 1 : Math.min(1, attributed / total),
    component_count: traces.length,
    span_count: allSpans.length,
    source_identities: traces.map((trace) => trace.source_identity).filter(Boolean),
  };
  return { ...summary, telemetry_sha256: hash(summary) };
}

export function installProcessTelemetry(component, options = {}) {
  const telemetry = createRunTelemetry({ component, ...options });
  const rootSpan = telemetry.startSpan("process", { kind: "process", owner: component });
  const directory = process.env.EXCEL_INFLOW_TELEMETRY_DIR;
  let closed = false;
  const persistSync = (status) => {
    if (closed || !directory) return;
    closed = true;
    try {
      telemetry.endSpan(rootSpan, { status: status === "PASS" ? "OK" : "ERROR" });
      const trace = telemetry.close({ status });
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, `${safeComponent(component)}-${process.pid}.json`);
      const temp = `${target}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(canonical(trace), null, 2)}\n`, "utf8");
      fs.renameSync(temp, target);
    } catch {
      // Telemetry must never change workbook economics or delivery liveness.
    }
  };
  process.once("beforeExit", () => persistSync(process.exitCode ? "FAIL" : "PASS"));
  process.once("exit", (code) => persistSync(code === 0 ? "PASS" : "FAIL"));
  return telemetry;
}

export default { createRunTelemetry, installProcessTelemetry, mergeRunTelemetry, writeRunTelemetry };
