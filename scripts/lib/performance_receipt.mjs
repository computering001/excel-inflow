import { createHash } from "node:crypto";

export const REQUIRED_PERFORMANCE_SPANS = Object.freeze([
  "source_acquisition",
  "filing_extraction",
  "broker_native_extraction",
  "semantic_recovery",
  "case_compilation",
  "solver",
  "workbook_build",
  "recalculation",
  "validation",
  "delivery",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return createHash("sha256").update(`${JSON.stringify(canonical(value))}\n`).digest("hex");
}

function finiteDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

export function compilePerformanceReceipt({
  runId,
  sourceCommit,
  sourceTree,
  runtimeClosureSha256,
  attachmentStateSha256,
  buildResultSha256,
  attachmentPerformance,
  checkpointTimings,
  totalDurationMs,
}) {
  const filings = attachmentPerformance?.filings ?? {};
  const lanes = attachmentPerformance?.lane_duration_ms ?? {};
  const timings = checkpointTimings ?? {};
  const spans = [
    ["source_acquisition", filings.source_acquisition_ms, "filings_source_custody"],
    ["filing_extraction", filings.filing_extraction_ms, "native_filing_extractor"],
    ["broker_native_extraction", lanes.broker, "broker_evidence_lane"],
    ["semantic_recovery", attachmentPerformance?.semantic_recovery_ms, "declared_evidence_compiler"],
    ["case_compilation", timings.plan, "stage4_plan"],
    ["solver", timings.semantic_gates, "stage4_semantic_gates"],
    ["workbook_build", Number(timings.emit ?? 0) + Number(timings.terminal_patch ?? 0), "stage4_emit_and_patch"],
    ["recalculation", timings.recalculate, "stage4_recalculation"],
    ["validation", ["verify_dynamic", "verify_style", "verify_cache", "verify_finance", "verify_semantic", "verify_aggregate", "render"].reduce((sum, key) => sum + Number(timings[key] ?? 0), 0), "stage4_validation"],
    ["delivery", timings.publish, "stage4_publish"],
  ].map(([name, rawDuration, owner]) => ({
    name,
    owner,
    coverage_role: "leaf",
    duration_ms: finiteDuration(rawDuration),
    status: finiteDuration(rawDuration) === null ? "MISSING" : "PASS",
  }));
  const missing = spans.filter((span) => span.status !== "PASS").map((span) => span.name);
  const body = {
    schema_version: "excel-inflow-performance-receipt/1.0",
    run_id: String(runId ?? "unknown"),
    source_identity: {
      commit: sourceCommit ?? null,
      tree: sourceTree ?? null,
      runtime_closure_sha256: runtimeClosureSha256 ?? null,
    },
    input_bindings: {
      attachment_state_sha256: attachmentStateSha256 ?? null,
      build_result_sha256: buildResultSha256 ?? null,
    },
    total_duration_ms: Number.isFinite(Number(totalDurationMs)) ? Number(totalDurationMs) : null,
    required_span_names: [...REQUIRED_PERFORMANCE_SPANS],
    spans,
    summary: {
      required_span_count: REQUIRED_PERFORMANCE_SPANS.length,
      observed_leaf_span_count: spans.length - missing.length,
      missing_span_names: missing,
      leaf_span_coverage_ratio: (spans.length - missing.length) / spans.length,
      root_span_substitution_allowed: false,
    },
    status: missing.length === 0 ? "PASS" : "INCOMPLETE",
  };
  return { ...body, receipt_sha256: hash(body) };
}

export function validatePerformanceReceipt(receipt) {
  const errors = [];
  if (receipt?.schema_version !== "excel-inflow-performance-receipt/1.0") errors.push("schema_version");
  const names = (receipt?.spans ?? []).map((span) => span?.name);
  for (const required of REQUIRED_PERFORMANCE_SPANS) {
    if (names.filter((name) => name === required).length !== 1) errors.push(`span:${required}`);
  }
  if ((receipt?.spans ?? []).some((span) => span?.coverage_role !== "leaf")) errors.push("coverage_role");
  if ((receipt?.spans ?? []).some((span) => span?.status !== "PASS" || finiteDuration(span?.duration_ms) === null)) errors.push("duration");
  if (receipt?.summary?.root_span_substitution_allowed !== false) errors.push("root_span_masking");
  if (!/^[a-f0-9]{64}$/.test(String(receipt?.source_identity?.runtime_closure_sha256 ?? ""))) errors.push("runtime_closure");
  if (!/^[a-f0-9]{64}$/.test(String(receipt?.input_bindings?.attachment_state_sha256 ?? ""))) errors.push("attachment_binding");
  if (!/^[a-f0-9]{64}$/.test(String(receipt?.input_bindings?.build_result_sha256 ?? ""))) errors.push("build_binding");
  const { receipt_sha256: declared, ...body } = receipt ?? {};
  if (declared !== hash(body)) errors.push("receipt_sha256");
  if (receipt?.status !== "PASS" || receipt?.summary?.leaf_span_coverage_ratio !== 1) errors.push("status");
  return [...new Set(errors)].sort();
}
