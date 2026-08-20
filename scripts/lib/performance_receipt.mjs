import { createHash } from "node:crypto";

import {
  PERFORMANCE_POLICY_REF,
  PERFORMANCE_POLICY_SHA256,
  unattributedTimeAssessment,
} from "./experience_trace.mjs";

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

/**
 * P6.6 -- what each span ACTUALLY measures.
 *
 * The pre-P6.6 mapping fed `solver` from the semantic-gate clock and
 * `case_compilation` from the plan clock. Stage 4 proves the opposite:
 * the `semantic_gates` checkpoint runs runReleaseN0N9 (intake,
 * classification, reconciliation, derived semantic outputs) over the case --
 * that IS the compile -- while the `plan` checkpoint shells
 * build_dynamic_model.mjs --plan-only, which is the solver. Labels now follow
 * the work.
 *
 * Checkpoint attribution is a PREDICATE, not a fixed key list, so a new
 * checkpoint leaf (the render_sheet_NN family being the case that was silently
 * dropped) is attributed the moment it exists. Anything no predicate claims is
 * reported as an unmapped checkpoint instead of vanishing.
 */
const SPAN_SPECS = Object.freeze([
  {
    name: "source_acquisition",
    owner: "filings_source_custody",
    measures: "filings source acquisition inside the evidence pipeline",
    lane: (performance) => performance?.filings?.source_acquisition_ms,
  },
  {
    name: "filing_extraction",
    owner: "native_filing_extractor",
    measures: "native filing extraction inside the evidence pipeline",
    lane: (performance) => performance?.filings?.filing_extraction_ms,
  },
  {
    name: "broker_native_extraction",
    owner: "broker_evidence_lane",
    measures: "broker evidence lane wall time",
    lane: (performance) => performance?.lane_duration_ms?.broker,
  },
  {
    name: "semantic_recovery",
    owner: "declared_evidence_compiler",
    measures: "declared semantic recovery over non-native evidence",
    lane: (performance) => performance?.semantic_recovery_ms,
  },
  {
    name: "case_compilation",
    owner: "stage4_semantic_gates",
    measures: "portable N0-N9 semantic compilation of the case and its gates",
    checkpoint: (id) => id === "semantic_gates",
  },
  {
    name: "solver",
    owner: "stage4_plan_solver",
    measures: "build_dynamic_model.mjs --plan-only: the solver and plan compile",
    checkpoint: (id) => id === "plan",
  },
  {
    name: "workbook_build",
    owner: "stage4_emit_and_patch",
    measures: "python workbook emit plus the terminal patch",
    checkpoint: (id) => id === "emit" || id === "terminal_patch",
  },
  {
    name: "recalculation",
    owner: "stage4_recalculation",
    measures: "LibreOffice recalculation second opinion",
    checkpoint: (id) => id === "recalculate",
  },
  {
    name: "validation",
    owner: "stage4_validation",
    measures: "every verify_* gate, every render_sheet_NN leaf and the render aggregate",
    checkpoint: (id) => id.startsWith("verify_") || id === "render" || id.startsWith("render_sheet_"),
  },
  {
    name: "delivery",
    owner: "stage4_publish",
    measures: "publication of the sealed workbook",
    checkpoint: (id) => id === "publish",
  },
]);

if (
  SPAN_SPECS.length !== REQUIRED_PERFORMANCE_SPANS.length ||
  SPAN_SPECS.some((spec, index) => spec.name !== REQUIRED_PERFORMANCE_SPANS[index])
) {
  throw new Error("performance receipt span specs drifted from REQUIRED_PERFORMANCE_SPANS");
}

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

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sameMs(left, right) {
  if (left === null || right === null) return left === right;
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Math.abs(Number(left) - Number(right)) <= 1e-6;
}

function measuredSpanMs(spans) {
  return (spans ?? []).reduce((total, span) => {
    const duration = Number(span?.duration_ms);
    return total + (Number.isFinite(duration) ? duration : 0);
  }, 0);
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
  reusedCheckpoints,
  executedCheckpoints,
  totalDurationMs,
}) {
  const performance = attachmentPerformance ?? {};
  const timings = checkpointTimings ?? {};
  const timingIds = Object.keys(timings).map(String);
  const reusedIds = [...new Set((reusedCheckpoints ?? []).map(String))].sort();
  const executedIds = [...new Set((executedCheckpoints ?? []).map(String))].sort();
  const reused = new Set(reusedIds);
  const claimed = new Set();
  const spans = SPAN_SPECS.map((spec) => {
    if (spec.lane) {
      const duration = finiteDuration(spec.lane(performance));
      return {
        name: spec.name,
        owner: spec.owner,
        measures: spec.measures,
        coverage_role: "leaf",
        attribution: {
          kind: "evidence_lane",
          observed_checkpoint_ids: [],
          reused_checkpoint_ids: [],
        },
        duration_ms: duration,
        lawful_zero_reason: null,
        status: duration === null ? "MISSING" : "PASS",
      };
    }
    const observed = timingIds.filter((id) => spec.checkpoint(id)).sort();
    for (const id of observed) claimed.add(id);
    const reusedObserved = observed.filter((id) => reused.has(id));
    const values = observed.map((id) => nonNegative(timings[id]));
    const total = values.some((value) => value === null)
      ? null
      : values.reduce((sum, value) => sum + value, 0);
    // A REUSED checkpoint records timings_ms[id] = 0 by construction
    // (orchestrate_release.mjs:639). Zero is therefore LAWFUL evidence of reuse
    // -- but only when every observed contributor is in the stage-4 reused[]
    // set. An executed checkpoint that reports zero is still MISSING.
    const fullyReused = observed.length > 0 && reusedObserved.length === observed.length;
    const lawfulZero = total === 0 && fullyReused;
    const status = observed.length === 0 || total === null
      ? "MISSING"
      : total > 0
        ? "PASS"
        : lawfulZero
          ? "REUSED"
          : "MISSING";
    return {
      name: spec.name,
      owner: spec.owner,
      measures: spec.measures,
      coverage_role: "leaf",
      attribution: {
        kind: "checkpoint_leaf",
        observed_checkpoint_ids: observed,
        reused_checkpoint_ids: reusedObserved,
      },
      duration_ms: status === "REUSED" ? 0 : status === "PASS" ? total : null,
      lawful_zero_reason: status === "REUSED" ? "checkpoint_reuse" : null,
      status,
    };
  });
  const missing = spans.filter((span) => span.status === "MISSING").map((span) => span.name);
  const reusedSpanNames = spans.filter((span) => span.status === "REUSED").map((span) => span.name);
  const unmapped = timingIds.filter((id) => !claimed.has(id)).sort();
  const unmappedMs = unmapped.reduce((sum, id) => sum + (nonNegative(timings[id]) ?? 0), 0);
  const measured = measuredSpanMs(spans);
  const assessment = unattributedTimeAssessment({ measuredMs: measured, totalMs: totalDurationMs });
  const reconciliation = {
    ...assessment,
    // Time bands come from the policy asset; an unmapped checkpoint leaf is a
    // structural attribution hole and is reported separately so it cannot hide
    // inside a passing time band.
    time_status: assessment.status,
    status: unmapped.length > 0 ? "UNMAPPED_CHECKPOINTS" : assessment.status,
    unmapped_checkpoint_ids: unmapped,
    unmapped_checkpoint_ms: unmappedMs,
    gap_localisation: "unavailable_no_span_offsets",
    aggregate_rule_is_stronger_than_per_gap_rule: true,
  };
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
      performance_policy_ref: PERFORMANCE_POLICY_REF,
      performance_policy_sha256: PERFORMANCE_POLICY_SHA256,
    },
    total_duration_ms: Number.isFinite(Number(totalDurationMs)) ? Number(totalDurationMs) : null,
    required_span_names: [...REQUIRED_PERFORMANCE_SPANS],
    spans,
    checkpoint_reuse: {
      reused_checkpoint_ids: reusedIds,
      executed_checkpoint_ids: executedIds,
      zero_duration_is_lawful_for_reused_checkpoints: true,
    },
    reconciliation,
    summary: {
      required_span_count: REQUIRED_PERFORMANCE_SPANS.length,
      observed_leaf_span_count: spans.length - missing.length,
      missing_span_names: missing,
      reused_span_names: reusedSpanNames,
      leaf_span_coverage_ratio: (spans.length - missing.length) / spans.length,
      root_span_substitution_allowed: false,
      measured_span_ms: measured,
      unattributed_ms: reconciliation.unattributed_ms,
      attribution_ratio: reconciliation.attribution_ratio,
      attribution_band: reconciliation.band,
    },
    status: missing.length > 0
      ? "INCOMPLETE"
      : reconciliation.status === "PASS"
        ? "PASS"
        : "UNATTRIBUTED",
  };
  return { ...body, receipt_sha256: hash(body) };
}

export function validatePerformanceReceipt(receipt) {
  const errors = [];
  if (receipt?.schema_version !== "excel-inflow-performance-receipt/1.0") errors.push("schema_version");
  const spans = receipt?.spans ?? [];
  const names = spans.map((span) => span?.name);
  for (const required of REQUIRED_PERFORMANCE_SPANS) {
    if (names.filter((name) => name === required).length !== 1) errors.push(`span:${required}`);
  }
  if (spans.some((span) => span?.coverage_role !== "leaf")) errors.push("coverage_role");
  const declaredReused = new Set((receipt?.checkpoint_reuse?.reused_checkpoint_ids ?? []).map(String));
  // A span's LABEL must match the work it claims: every checkpoint id a span
  // attributes to itself has to satisfy that span's own predicate, and no
  // checkpoint may be claimed twice. This is what makes "solver" fed by the
  // semantic-gate clock a validator failure rather than a silent lie.
  const claimedBy = new Map();
  for (const span of spans) {
    const spec = SPAN_SPECS.find((candidate) => candidate.name === span?.name);
    const observed = (span?.attribution?.observed_checkpoint_ids ?? []).map(String);
    const reusedObserved = (span?.attribution?.reused_checkpoint_ids ?? []).map(String);
    if (!spec) continue;
    if (spec.lane) {
      if (span?.attribution?.kind !== "evidence_lane" || observed.length > 0 || reusedObserved.length > 0) {
        errors.push(`mislabelled:${span?.name}`);
      }
      continue;
    }
    if (span?.attribution?.kind !== "checkpoint_leaf") errors.push(`mislabelled:${span?.name}`);
    if (!observed.every((id) => spec.checkpoint(id))) errors.push(`mislabelled:${span?.name}`);
    if (!reusedObserved.every((id) => observed.includes(id) && declaredReused.has(id))) {
      errors.push(`mislabelled:${span?.name}`);
    }
    for (const id of observed) {
      if (claimedBy.has(id) && claimedBy.get(id) !== span?.name) errors.push("duplicate_attribution");
      claimedBy.set(id, span?.name);
    }
  }
  for (const span of spans) {
    const duration = Number(span?.duration_ms);
    if (span?.status === "PASS") {
      if (!(Number.isFinite(duration) && duration > 0)) errors.push("duration");
      if (span?.lawful_zero_reason !== null) errors.push("duration");
      continue;
    }
    if (span?.status === "REUSED") {
      // Zero is lawful ONLY as corroborated reuse: checkpoint-backed span, at
      // least one observed contributor, and every contributor declared reused.
      const observed = (span?.attribution?.observed_checkpoint_ids ?? []).map(String);
      const lawful =
        duration === 0 &&
        span?.attribution?.kind === "checkpoint_leaf" &&
        span?.lawful_zero_reason === "checkpoint_reuse" &&
        observed.length > 0 &&
        observed.every((id) => declaredReused.has(id));
      if (!lawful) errors.push("reused_zero_not_lawful");
      continue;
    }
    errors.push("duration");
  }
  if (receipt?.summary?.root_span_substitution_allowed !== false) errors.push("root_span_masking");
  if (!/^[a-f0-9]{64}$/.test(String(receipt?.source_identity?.runtime_closure_sha256 ?? ""))) errors.push("runtime_closure");
  if (!/^[a-f0-9]{64}$/.test(String(receipt?.input_bindings?.attachment_state_sha256 ?? ""))) errors.push("attachment_binding");
  if (!/^[a-f0-9]{64}$/.test(String(receipt?.input_bindings?.build_result_sha256 ?? ""))) errors.push("build_binding");
  // The declared threshold source must be the policy asset this runtime reads.
  if (receipt?.input_bindings?.performance_policy_ref !== PERFORMANCE_POLICY_REF) errors.push("threshold_source");
  if (receipt?.input_bindings?.performance_policy_sha256 !== PERFORMANCE_POLICY_SHA256) errors.push("threshold_source");
  if (receipt?.reconciliation?.threshold_source?.policy_sha256 !== PERFORMANCE_POLICY_SHA256) errors.push("threshold_source");
  // Reconciliation is recomputed from the spans, never trusted as declared.
  const measured = measuredSpanMs(spans);
  const recomputed = unattributedTimeAssessment({ measuredMs: measured, totalMs: receipt?.total_duration_ms });
  const reconciliation = receipt?.reconciliation ?? null;
  if (!reconciliation) errors.push("reconciliation");
  else {
    if (!sameMs(reconciliation.measured_ms, measured)) errors.push("reconciliation");
    if (!sameMs(reconciliation.unattributed_ms, recomputed.unattributed_ms)) errors.push("reconciliation");
    if (!sameMs(reconciliation.over_attributed_ms, recomputed.over_attributed_ms)) errors.push("reconciliation");
    if (reconciliation.time_status !== recomputed.status) errors.push("reconciliation");
    if (reconciliation.band !== recomputed.band) errors.push("reconciliation");
    if (!sameMs(receipt?.summary?.measured_span_ms, measured)) errors.push("reconciliation");
    if ((reconciliation.unmapped_checkpoint_ids ?? []).length > 0) errors.push("unmapped_checkpoint");
    if (reconciliation.status !== "PASS") errors.push("unattributed_time");
  }
  const { receipt_sha256: declared, ...body } = receipt ?? {};
  if (declared !== hash(body)) errors.push("receipt_sha256");
  if (receipt?.status !== "PASS" || receipt?.summary?.leaf_span_coverage_ratio !== 1) errors.push("status");
  return [...new Set(errors)].sort();
}
