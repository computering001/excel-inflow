#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beginExperienceTrace } from "./lib/experience_trace.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function sha(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-trace-test-"));
const output = path.join(root, "trace.json");
delete process.env.EXCEL_INFLOW_EXPERIENCE_TRACE_ID;
delete process.env.EXCEL_INFLOW_EXPERIENCE_TRACE_PATH;
const trace = beginExperienceTrace({ runId: "trace_test", outputPath: output });
const broker = trace.startSpan({ component: "broker", phase: "native_inspection", attributes: { houses: 3 } });
trace.endSpan(broker, { outcome: "PASS", attributes: { native_clean_houses: 1 } });
const host = trace.startSpan({ component: "model_host", phase: "semantic_response", waitReason: "external_host" });
trace.endSpan(host, { outcome: "DEGRADED" });
trace.markVisibleResponse({ status: "COMPLETE", attributes: { workbook_published: true } });
trace.finalize({ outcome: "PASS" });
const value = JSON.parse(await fs.readFile(output, "utf8"));
assert.equal(value.schema_version, "excel-inflow-experience-trace/1.0");
assert.equal(value.trace_id, trace.traceId);
assert.equal(value.run_id, "trace_test");
assert.equal(value.status, "PASS");
assert.ok(value.visible_response_at);
assert.equal(value.spans.length, 3);
assert.equal(value.spans[0].phase, "user_submission_to_visible_response");
assert.ok(value.spans.slice(1).every((span) => span.parent_span_id === value.root_span_id));
assert.ok(value.spans.every((span) => span.completed_at));
const unsigned = { ...value, trace_sha256: null };
assert.equal(value.trace_sha256, sha(unsigned));
const carrierSource = await fs.readFile(new URL("./lib/run_carrier.mjs", import.meta.url), "utf8");
assert.ok(carrierSource.includes("experience_trace_id"));
const controllerSource = await fs.readFile(new URL("./run_excel_inflow_vnext.mjs", import.meta.url), "utf8");
assert.ok(controllerSource.includes("experience_trace"));
console.log(JSON.stringify({ status: "PASS", checks: 14, trace: output }, null, 2));
