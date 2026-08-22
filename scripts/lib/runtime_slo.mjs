/**
 * P6.8 — THE RUNTIME SLO IS ONE DECLARATION, AND IT IS EVIDENCED.
 *
 * Before this module the repository carried THREE mutually contradictory
 * runtime service-level declarations:
 *
 *   1. assets/performance-policy-v1.json#service_objectives_minutes
 *        standard_p50 35 min, standard_p95 45 min, no_broker_p95 25 min
 *   2. scripts/lib/runtime_budget_policy.mjs#DEFAULT_RUNTIME_BUDGETS_MS
 *        end_to_end_target 900_000 ms, end_to_end_hard_ceiling 1_500_000 ms
 *   3. the execution pack's P6.8 row
 *        normal < 15 min, P95 < 20 min, ceiling 25 min
 *
 * (1) is not a rival opinion, it is UNSATISFIABLE: 35 minutes of median
 * runtime exceeds the 25-minute ceiling the runtime actually enforces, so a
 * run meeting that "objective" would already have exhausted the only clock it
 * has. (2) is enforced but has no percentile vocabulary at all — one target
 * and one ceiling cannot express a tail. (3) is the only triple coherent with
 * what is enforced, and it supplies the missing p95.
 *
 * So the ONE declaration lives in the asset (which P6.6 already made a live
 * policy input), it carries (3)'s numbers, and its p50 and hard ceiling are
 * BOUND to (2)'s constants: `validateRuntimeSloDeclaration` refuses the asset
 * the moment those numbers stop agreeing, and refuses it if the superseded
 * keys reappear anywhere in the document. Nothing in P6.1's files changed.
 *
 * This module VALIDATES and AGGREGATES. It never repairs a declaration, never
 * mints a measurement, and never relaxes an objective to fit a cohort.
 */
import { createHash } from "node:crypto";

import { PERFORMANCE_POLICY, PERFORMANCE_POLICY_REF, PERFORMANCE_POLICY_SHA256 } from "./experience_trace.mjs";
import { STAGE_FLOOR_TOTAL_ALLOWANCE_MS, STAGE_FLOOR_SPAWN_TOKEN_MS, RUNTIME_BUDGET_OVERRUN_REASON, validateRunDeadlineLedger } from "./run_deadline.mjs";
import { DEFAULT_RUNTIME_BUDGETS_MS } from "./runtime_budget_policy.mjs";

export const RUNTIME_SLO_SCHEMA = "excel-inflow-runtime-slo/1.0";
export const RUNTIME_SLO_COHORT_SCHEMA = "excel-inflow-runtime-slo-cohort/1.0";
export const RUNTIME_SLO_ENFORCEMENT_SCHEMA = "excel-inflow-hard-ceiling-enforcement/1.0";

/** The single declaration, read from the one asset that already governs performance policy. */
export const RUNTIME_SLO = Object.freeze(PERFORMANCE_POLICY?.runtime_slo ?? null);
export { PERFORMANCE_POLICY_REF, PERFORMANCE_POLICY_SHA256 };

/**
 * Keys whose presence ANYWHERE in the policy document means a second
 * end-to-end declaration has reappeared. The point of the single declaration
 * is that it is single; a validator that only checked the new object would let
 * the old one grow back beside it.
 */
export const SUPERSEDED_DECLARATION_KEYS = Object.freeze([
  "service_objectives_minutes",
  "standard_p50",
  "standard_p95",
  "no_broker_p95",
]);

export const REQUIRED_COHORTS = Object.freeze(["COLD", "WARM"]);

/** Closed refusal vocabulary. Every entry must have a producer below. */
export const RUNTIME_SLO_REFUSALS = Object.freeze([
  "refused.declaration_invalid",
  "refused.sample_not_ledger_measured",
  "refused.sample_ledger_invalid",
  "refused.sample_duplicate_run",
  "refused.sample_unknown_cohort",
  "refused.sample_unknown_scope",
  "refused.cohort_missing",
  "refused.cohort_below_minimum_sample",
  "refused.percentile_below_minimum_sample",
  "refused.percentile_unknown",
]);

export class RuntimeSloRefusal extends Error {
  constructor(refusal, message) {
    super(message);
    this.name = "RuntimeSloRefusal";
    this.refusal = refusal;
    if (!RUNTIME_SLO_REFUSALS.includes(refusal)) {
      throw new Error(`Refusal ${refusal} is not in the declared runtime-SLO refusal vocabulary.`);
    }
  }
}

function refuse(refusal, message) {
  throw new RuntimeSloRefusal(refusal, message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function digest(value) {
  return createHash("sha256").update(`${JSON.stringify(canonical(value))}\n`).digest("hex");
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function keysDeep(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) keysDeep(entry, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      found.add(key);
      keysDeep(entry, found);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// THE DECLARATION
// ---------------------------------------------------------------------------

/**
 * VALIDATE (never repair) the single declaration, and validate that it is
 * still SINGLE. Returns sorted error keys; an empty array is the only pass.
 */
export function validateRuntimeSloDeclaration(
  declaration = RUNTIME_SLO,
  {
    budgets = DEFAULT_RUNTIME_BUDGETS_MS,
    floorAllowanceMs = STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
    policyDocument = PERFORMANCE_POLICY,
  } = {},
) {
  const errors = [];
  if (declaration?.schema_version !== RUNTIME_SLO_SCHEMA) errors.push("schema_version");
  if (declaration?.declaration_authority !== `${PERFORMANCE_POLICY_REF}#runtime_slo`) {
    errors.push("declaration_authority");
  }

  // Single means single: no superseded key may exist anywhere in the document,
  // except inside the `supersedes` prose that records why it was removed.
  if (policyDocument) {
    const { runtime_slo: slo, ...rest } = policyDocument;
    const { supersedes: _record, ...sloWithoutRecord } = slo ?? {};
    const live = keysDeep({ ...rest, runtime_slo: sloWithoutRecord });
    for (const key of SUPERSEDED_DECLARATION_KEYS) {
      if (live.has(key)) errors.push(`rival_declaration:${key}`);
    }
  }
  if (!Array.isArray(declaration?.supersedes) || declaration.supersedes.length === 0) {
    errors.push("supersedes_unrecorded");
  } else if (declaration.supersedes.some((entry) => !entry?.declaration || !entry?.why_wrong)) {
    errors.push("supersedes_unjustified");
  }

  const objective = declaration?.end_to_end_ms ?? {};
  if (!positive(objective.p50) || !positive(objective.p95) || !positive(objective.hard_ceiling)) {
    errors.push("end_to_end_ms");
  } else if (!(objective.p50 < objective.p95 && objective.p95 < objective.hard_ceiling)) {
    // A p95 at or beyond the ceiling is the exact defect that made the
    // superseded declaration unsatisfiable. It may never be declared again.
    errors.push("objective_not_ordered_inside_ceiling");
  }

  // The BINDING. This is what makes the asset authoritative rather than merely
  // additional: the enforced constants must agree with it, by name.
  const bound = declaration?.bound_runtime_budget_keys ?? {};
  if (budgets?.[bound.p50] !== objective.p50) errors.push("p50_not_bound_to_enforced_target");
  if (budgets?.[bound.hard_ceiling] !== objective.hard_ceiling) {
    errors.push("hard_ceiling_not_bound_to_enforced_ceiling");
  }

  const envelope = declaration?.enforced_envelope ?? {};
  if (envelope.hard_ceiling_ms !== objective.hard_ceiling) errors.push("envelope_ceiling");
  if (envelope.bounded_floor_allowance_ms !== floorAllowanceMs) errors.push("envelope_floor_allowance");
  if (envelope.maximum_grantable_compute_ms !== Number(objective.hard_ceiling) + Number(floorAllowanceMs)) {
    errors.push("envelope_maximum_grantable");
  }
  if (envelope.in_process_preemption !== false) errors.push("envelope_preemption_claim");

  const cohort = declaration?.cohort ?? {};
  if (JSON.stringify(cohort.required_cohorts) !== JSON.stringify([...REQUIRED_COHORTS])) {
    errors.push("cohort_required_cohorts");
  }
  if (!positive(cohort.minimum_samples_per_cohort)) errors.push("cohort_minimum_samples");
  if (JSON.stringify(cohort.percentiles) !== JSON.stringify([50, 95])) errors.push("cohort_percentiles");
  if (cohort.percentile_method !== "nearest_rank_inclusive") errors.push("cohort_percentile_method");
  if (cohort.measurement_source !== "persisted_run_deadline_ledger") errors.push("cohort_measurement_source");
  if (cohort.warm_p95_may_not_exceed_cold_p95 !== true) errors.push("cohort_warm_rule");

  const components = declaration?.component_objectives_ms ?? {};
  for (const [name, value] of Object.entries(components)) {
    if (name === "note") continue;
    if (!positive(value)) errors.push(`component_objective:${name}`);
    else if (value > objective.p95) errors.push(`component_objective_above_p95:${name}`);
  }

  const scopes = declaration?.scopes ?? {};
  if (typeof scopes.end_to_end_delivery !== "string" || typeof scopes.evidence_half_through_decisions !== "string") {
    errors.push("scopes");
  }

  return [...new Set(errors)].sort();
}

export function assertRuntimeSloDeclaration(declaration = RUNTIME_SLO, options = {}) {
  const errors = validateRuntimeSloDeclaration(declaration, options);
  if (errors.length > 0) {
    refuse("refused.declaration_invalid", `The runtime SLO declaration is invalid: ${errors.join(", ")}.`);
  }
  return declaration;
}

/** The scopes a sample may declare, and whether that scope can CERTIFY the objective. */
export const SLO_SCOPES = Object.freeze({
  end_to_end_delivery: { certifies: true },
  evidence_half_through_decisions: { certifies: false },
});

// ---------------------------------------------------------------------------
// PERCENTILES
// ---------------------------------------------------------------------------

/**
 * Nearest-rank inclusive percentile. REFUSES below the declared minimum
 * sample: a percentile computed from too few observations is a number with no
 * meaning, and reporting one is exactly the false evidence this package
 * exists to prevent.
 */
export function percentileMs(values, percentile, { minimumSamples } = {}) {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    refuse("refused.percentile_unknown", `Percentile ${percentile} is not in (0, 100].`);
  }
  const sorted = [...(values ?? [])]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (sorted.length !== (values ?? []).length) {
    refuse("refused.percentile_unknown", "A percentile cannot be taken over non-finite or negative durations.");
  }
  const minimum = Number(minimumSamples);
  if (!Number.isFinite(minimum) || minimum <= 0) {
    refuse("refused.percentile_below_minimum_sample", "A percentile requires a declared minimum sample size.");
  }
  if (sorted.length < minimum) {
    refuse(
      "refused.percentile_below_minimum_sample",
      `A p${percentile} was requested from ${sorted.length} samples; the declaration requires at least ${minimum}.`,
    );
  }
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

// ---------------------------------------------------------------------------
// SAMPLES — a measurement, or nothing
// ---------------------------------------------------------------------------

/**
 * Build ONE cohort sample from a run's REAL persisted deadline ledger.
 *
 * The measured duration is an INVOCATION DELTA, not the ledger total. P6.1's
 * clock is deliberately cumulative — a resume may never restore spent budget —
 * so a warm run's ledger carries the cold run's compute too. Reading
 * `compute_elapsed_ms` straight off a warm ledger reports the warm cohort as
 * SLOWER than the cold one it was seeded by, which is the exact opposite of
 * what happened. (Measured on the real controller: cold 2820 ms, warm ledger
 * total 4533 ms, warm invocation 1713 ms.) The delta is taken against the
 * prior reading of the SAME ledger and must reconcile against the labelled
 * segments this invocation appended.
 *
 * The cohort label is structural, not a caller's assertion:
 *   COLD  requires NO prior ledger reading and NO reused stages.
 *   WARM  requires a prior ledger reading AND stages the run actually reused.
 * So a warm cohort cannot be fabricated, and a cohort with no warm runs cannot
 * be dressed up as one.
 *
 * A caller can never supply a duration. The only way to make a sample is to
 * hand over a ledger that validates against P6.1's own validator.
 */
export function runtimeSloSample({
  cohort,
  scope,
  ledger,
  priorLedger = null,
  reusedStages = [],
  ledgerPath = null,
  expectedRunId = undefined,
  notes = null,
}) {
  if (!REQUIRED_COHORTS.includes(cohort)) {
    refuse("refused.sample_unknown_cohort", `Cohort ${cohort} is not one of ${REQUIRED_COHORTS.join(", ")}.`);
  }
  if (!Object.hasOwn(SLO_SCOPES, String(scope))) {
    refuse("refused.sample_unknown_scope", `Scope ${scope} is not a declared SLO scope.`);
  }
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    refuse("refused.sample_not_ledger_measured", "A cohort sample requires the run's persisted deadline ledger.");
  }
  const ledgerErrors = validateRunDeadlineLedger(ledger, { expectedRunId, priorLedger });
  if (ledgerErrors.length > 0) {
    refuse("refused.sample_ledger_invalid", `The sampled ledger does not validate: ${ledgerErrors.join(", ")}.`);
  }
  const reused = [...new Set((reusedStages ?? []).map(String))].sort();
  if (cohort === "COLD" && (priorLedger !== null || reused.length > 0)) {
    refuse(
      "refused.sample_unknown_cohort",
      `A COLD sample may not have a prior ledger reading or reused stages (reused: ${JSON.stringify(reused)}).`,
    );
  }
  if (cohort === "WARM" && (priorLedger === null || reused.length === 0)) {
    refuse(
      "refused.sample_unknown_cohort",
      "A WARM sample must carry the prior reading of the SAME ledger AND the stages the run actually reused.",
    );
  }

  const total = Number(ledger.compute_elapsed_ms);
  const priorTotal = Number(priorLedger?.compute_elapsed_ms ?? 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    refuse("refused.sample_not_ledger_measured", "The sampled ledger carries no usable compute reading.");
  }
  const priorSegments = (priorLedger?.segments ?? []).length;
  const appended = (ledger.segments ?? []).slice(priorSegments);
  const appendedSum = appended.reduce((sum, entry) => sum + Number(entry?.duration_ms ?? 0), 0);
  const invocation = total - priorTotal;
  if (invocation < 0 || appendedSum !== invocation) {
    // The delta must be explained by the segments this invocation appended.
    // Anything else is unattributed compute wearing a cohort label.
    refuse(
      "refused.sample_ledger_invalid",
      `The invocation delta (${invocation} ms) does not reconcile against the ${appended.length} segments it appended (${appendedSum} ms).`,
    );
  }

  return {
    cohort,
    scope: String(scope),
    run_id: ledger.run_id ?? null,
    measurement_source: "persisted_run_deadline_ledger",
    ledger_path: ledgerPath === null ? null : String(ledgerPath),
    ledger_sha256: digest(ledger),
    prior_ledger_sha256: priorLedger === null ? null : digest(priorLedger),
    compute_ms: invocation,
    run_total_compute_ms: total,
    prior_total_compute_ms: priorTotal,
    hard_deadline_compute_ms: Number(ledger.hard_deadline_compute_ms),
    target_compute_ms: Number(ledger.target_compute_ms),
    floor_granted_ms: Number(ledger.floor_granted_ms ?? 0),
    reused_stages: reused,
    invocation_segments: appended.map((entry) => String(entry.label)).sort(),
    notes: notes === null ? null : String(notes),
  };
}

// ---------------------------------------------------------------------------
// THE COHORT REPORT
// ---------------------------------------------------------------------------

function summariseCohort(samples, { minimumSamples, conservativeBelow, objective }) {
  const durations = samples.map((sample) => sample.compute_ms);
  const p50 = percentileMs(durations, 50, { minimumSamples });
  const p95 = percentileMs(durations, 95, { minimumSamples });
  // The percentiles are per INVOCATION; the hard ceiling governs the WHOLE
  // run, so it is judged against the cumulative reading, never the delta.
  const runTotals = samples.map((sample) => sample.run_total_compute_ms);
  return {
    samples: samples.length,
    minimum_samples_required: minimumSamples,
    p50_ms: p50,
    p95_ms: p95,
    min_ms: Math.min(...durations),
    max_ms: Math.max(...durations),
    p95_estimate:
      samples.length < conservativeBelow ? "CONSERVATIVE_UPPER_BOUND" : "NEAREST_RANK",
    p95_estimate_note:
      samples.length < conservativeBelow
        ? `Fewer than ${conservativeBelow} samples: nearest-rank p95 lands on the slowest observation, so this is an upper bound on the true p95, never an understatement.`
        : null,
    meets_p50: p50 <= objective.p50,
    meets_p95: p95 <= objective.p95,
    max_run_total_compute_ms: Math.max(...runTotals),
    inside_hard_ceiling: Math.max(...runTotals) <= objective.hard_ceiling,
    scopes: [...new Set(samples.map((sample) => sample.scope))].sort(),
  };
}

/**
 * Compile the cold/warm cohort report. REFUSES rather than reporting when the
 * cohort cannot support the claim: a missing cohort, an undersized cohort, a
 * duplicated run, or a percentile below the declared minimum.
 */
export function compileRuntimeSloCohortReport({
  samples = [],
  declaration = RUNTIME_SLO,
  capturedAt = new Date().toISOString(),
  environment = {},
  validationOptions = {},
}) {
  assertRuntimeSloDeclaration(declaration, validationOptions);
  const objective = declaration.end_to_end_ms;
  const cohortPolicy = declaration.cohort;
  const minimumSamples = cohortPolicy.minimum_samples_per_cohort;

  const seen = new Set();
  for (const sample of samples) {
    if (sample?.measurement_source !== "persisted_run_deadline_ledger") {
      refuse(
        "refused.sample_not_ledger_measured",
        `A cohort sample declaring measurement_source ${JSON.stringify(sample?.measurement_source)} is not a measurement.`,
      );
    }
    const key = `${sample.cohort}:${sample.run_id}:${sample.ledger_sha256}`;
    if (seen.has(key)) {
      refuse("refused.sample_duplicate_run", `The same ledger reading was offered twice as ${key}.`);
    }
    seen.add(key);
    // Re-assert the structural cohort rules on the RECORD, so a hand-written
    // sample that never went through runtimeSloSample is refused too.
    const reused = sample.reused_stages ?? [];
    if (sample.cohort === "WARM" && (!sample.prior_ledger_sha256 || reused.length === 0)) {
      refuse(
        "refused.sample_unknown_cohort",
        `A WARM sample record must name the prior ledger reading and the stages it reused (run ${sample.run_id}).`,
      );
    }
    if (sample.cohort === "COLD" && (sample.prior_ledger_sha256 || reused.length > 0)) {
      refuse(
        "refused.sample_unknown_cohort",
        `A COLD sample record may not name a prior ledger reading or reused stages (run ${sample.run_id}).`,
      );
    }
    if (Number(sample.compute_ms) !== Number(sample.run_total_compute_ms) - Number(sample.prior_total_compute_ms)) {
      refuse(
        "refused.sample_not_ledger_measured",
        `Sample ${sample.run_id} declares a duration that is not its invocation delta against the persisted clock.`,
      );
    }
  }

  const byCohort = {};
  for (const cohort of REQUIRED_COHORTS) {
    const rows = samples.filter((sample) => sample.cohort === cohort);
    if (rows.length === 0) {
      refuse(
        "refused.cohort_missing",
        `The cohort has no ${cohort} runs. A cold/warm comparison with one side missing evidences nothing.`,
      );
    }
    if (rows.length < minimumSamples) {
      refuse(
        "refused.cohort_below_minimum_sample",
        `The ${cohort} cohort has ${rows.length} samples; the declaration requires at least ${minimumSamples}.`,
      );
    }
    byCohort[cohort] = summariseCohort(rows, {
      minimumSamples,
      conservativeBelow: cohortPolicy.conservative_upper_bound_below_samples ?? minimumSamples,
      objective,
    });
  }

  const scopes = [...new Set(samples.map((sample) => sample.scope))].sort();
  const certifying = scopes.every((scope) => SLO_SCOPES[scope]?.certifies === true);
  const breaches = [];
  for (const cohort of REQUIRED_COHORTS) {
    if (!byCohort[cohort].meets_p50) breaches.push(`${cohort}:p50`);
    if (!byCohort[cohort].meets_p95) breaches.push(`${cohort}:p95`);
    if (!byCohort[cohort].inside_hard_ceiling) breaches.push(`${cohort}:hard_ceiling`);
  }
  const warmNotSlower = byCohort.WARM.p95_ms <= byCohort.COLD.p95_ms;
  if (cohortPolicy.warm_p95_may_not_exceed_cold_p95 === true && !warmNotSlower) {
    breaches.push("warm_p95_exceeds_cold_p95");
  }

  const body = {
    schema_version: RUNTIME_SLO_COHORT_SCHEMA,
    captured_at: String(capturedAt),
    declaration_authority: declaration.declaration_authority,
    policy_ref: PERFORMANCE_POLICY_REF,
    policy_sha256: PERFORMANCE_POLICY_SHA256,
    objective_ms: { p50: objective.p50, p95: objective.p95, hard_ceiling: objective.hard_ceiling },
    percentile_method: cohortPolicy.percentile_method,
    measurement_source: cohortPolicy.measurement_source,
    scopes,
    // A subset scope can REFUTE the objective but never certify it. Saying so
    // in the report is the difference between evidence and a claim.
    slo_coverage: certifying ? "CERTIFYING" : "LOWER_BOUND_ONLY",
    slo_coverage_note: certifying
      ? "Every sample ran the full delivered path, so these percentiles speak to the end-to-end objective directly."
      : "At least one sample stopped short of delivery, so these percentiles bound the end-to-end objective from BELOW: they can refute it, never certify it.",
    environment: canonical(environment ?? {}),
    cohorts: byCohort,
    cold_to_warm: {
      p50_saved_ms: byCohort.COLD.p50_ms - byCohort.WARM.p50_ms,
      p95_saved_ms: byCohort.COLD.p95_ms - byCohort.WARM.p95_ms,
      warm_p95_within_cold_p95: warmNotSlower,
    },
    breaches: [...new Set(breaches)].sort(),
    status: breaches.length === 0 ? "WITHIN_SLO" : "SLO_EXCEEDED",
    samples: samples.map((sample) => canonical(sample)),
  };
  return { ...body, report_sha256: digest(body) };
}

/**
 * VALIDATE a cohort report by RECOMPUTING it from its own samples. A verdict
 * that does not follow from the numbers beneath it is rejected — including a
 * WITHIN_SLO stamped over a breaching cohort.
 */
export function validateRuntimeSloCohortReport(report, { declaration = RUNTIME_SLO, validationOptions = {} } = {}) {
  const errors = [];
  if (report?.schema_version !== RUNTIME_SLO_COHORT_SCHEMA) return ["schema_version"];
  let expected;
  try {
    expected = compileRuntimeSloCohortReport({
      samples: (report.samples ?? []).map((sample) => ({ ...sample })),
      declaration,
      capturedAt: report.captured_at,
      environment: report.environment,
      validationOptions,
    });
  } catch (error) {
    return [error?.refusal ?? "refused.declaration_invalid"];
  }
  for (const field of ["objective_ms", "cohorts", "cold_to_warm", "breaches", "status", "slo_coverage", "scopes"]) {
    if (digest(report[field] ?? null) !== digest(expected[field] ?? null)) errors.push(field);
  }
  if (report.policy_sha256 !== PERFORMANCE_POLICY_SHA256) errors.push("policy_binding");
  const { report_sha256: declared, ...body } = report ?? {};
  if (declared !== digest(body)) errors.push("report_sha256");
  return [...new Set(errors)].sort();
}

// ---------------------------------------------------------------------------
// HARD-CEILING ENFORCEMENT
// ---------------------------------------------------------------------------

/**
 * Is the hard ceiling ENFORCED on this run's real ledger?
 *
 * P6.1 bounded the stage floor, so the ceiling is enforceable as an envelope
 * rather than as a single number. These are the properties that make it real,
 * each computed from the ledger the run actually persisted:
 *
 *   E1  no grant exceeded what the clock had left plus the floor allowance
 *       still available at that moment
 *   E2  granted floor debt never exceeded the run's finite floor allowance
 *   E3  once the allowance is spent the grant collapses (never a fresh floor),
 *       and never to zero, because zero means "no timeout" at a spawn
 *   E4  every grant made past an exhausted ceiling carries the registered
 *       INTERNAL.runtime_budget_overrun receipt
 *   E5  compute past the ceiling is DISCLOSED — in-process stages are not
 *       preempted, so undisclosed overshoot is the failure, not overshoot
 *
 * A breach of any of these is a FAIL. This function never adjusts a number to
 * make a run pass.
 */
export function hardCeilingEnforcementReport({ ledger, declaration = RUNTIME_SLO, label = null }) {
  assertRuntimeSloDeclaration(declaration);
  const envelope = declaration.enforced_envelope;
  const ceiling = Number(ledger?.hard_deadline_compute_ms);
  const allowance = Number(ledger?.floor_allowance_ms ?? 0);
  const granted = Number(ledger?.floor_granted_ms ?? 0);
  const elapsed = Number(ledger?.compute_elapsed_ms ?? 0);
  const allowances = Array.isArray(ledger?.stage_allowances) ? ledger.stage_allowances : [];
  const receipts = Array.isArray(ledger?.deadline_receipts) ? ledger.deadline_receipts : [];
  const violations = [];

  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) violations.push("ledger_has_no_ceiling");
  if (ceiling > envelope.hard_ceiling_ms) violations.push("ledger_ceiling_above_declared_ceiling");
  if (allowance > envelope.bounded_floor_allowance_ms) violations.push("floor_allowance_above_declared");

  // E2
  if (granted > allowance) violations.push("floor_debt_exceeds_allowance");
  // E1 / E3 — replay the grants in order against the allowance they consumed.
  let debtSpent = 0;
  let previousPastCeilingGrant = null;
  for (const record of allowances) {
    const remaining = Number(record?.remaining_ms_at_consult ?? 0);
    const grant = Number(record?.granted_ms ?? 0);
    const availableDebt = Math.max(0, allowance - debtSpent);
    if (grant < 1) violations.push(`grant_zero:${record?.stage}`);
    // E3 requires every grant to be at least the single-millisecond spawn
    // token (zero means "no timeout" at a spawn), so once BOTH the ceiling
    // and the allowance are spent the envelope must still admit exactly that
    // token — and nothing larger. E1 stays absolute above it.
    const envelopeMax = remaining + availableDebt
      + (remaining <= 0 && availableDebt === 0 ? STAGE_FLOOR_SPAWN_TOKEN_MS : 0);
    if (grant > envelopeMax) violations.push(`grant_exceeds_envelope:${record?.stage}`);
    const debt = Math.max(0, Math.min(grant - remaining, availableDebt));
    if (remaining <= 0) {
      if (previousPastCeilingGrant !== null && grant > previousPastCeilingGrant && availableDebt < grant) {
        violations.push(`floor_reissued:${record?.stage}`);
      }
      previousPastCeilingGrant = grant;
    }
    debtSpent += debt;
  }
  if (debtSpent > allowance) violations.push("replayed_debt_exceeds_allowance");

  // E4 — a grant past an exhausted ceiling must be typed.
  const pastCeilingGrants = allowances.filter((record) => Number(record?.remaining_ms_at_consult ?? 0) <= 0);
  const overrunReceipts = receipts.filter(
    (record) => record?.kind === "deadline_exceeded" && record?.reason_code === RUNTIME_BUDGET_OVERRUN_REASON,
  );
  if (pastCeilingGrants.length > 0 && overrunReceipts.length === 0) {
    violations.push("untyped_grant_past_ceiling");
  }

  // E5 — overshoot must be disclosed, because in-process work is not preempted.
  const overshoot = Math.max(0, elapsed - ceiling);
  const disclosed = receipts.some((record) =>
    ["deadline_exceeded", "stage_budget_overrun"].includes(record?.kind)
    && record?.reason_code === RUNTIME_BUDGET_OVERRUN_REASON);
  if (overshoot > 0 && !disclosed) violations.push("undisclosed_overshoot_past_ceiling");
  if (elapsed > ceiling + allowance && !disclosed) violations.push("compute_beyond_declared_envelope");

  const body = {
    schema_version: RUNTIME_SLO_ENFORCEMENT_SCHEMA,
    label: label === null ? null : String(label),
    run_id: ledger?.run_id ?? null,
    declared_envelope_ms: {
      hard_ceiling: envelope.hard_ceiling_ms,
      bounded_floor_allowance: envelope.bounded_floor_allowance_ms,
      maximum_grantable_compute: envelope.maximum_grantable_compute_ms,
    },
    observed: {
      ledger_ceiling_ms: Number.isFinite(ceiling) ? ceiling : null,
      compute_elapsed_ms: elapsed,
      overshoot_past_ceiling_ms: overshoot,
      floor_allowance_ms: allowance,
      floor_granted_ms: granted,
      floor_allowance_remaining_ms: Math.max(0, allowance - granted),
      grants: allowances.length,
      grants_past_ceiling: pastCeilingGrants.length,
      typed_overrun_receipts: overrunReceipts.length,
    },
    in_process_preemption: false,
    enforcement_mode: "BOUNDED_ENVELOPE_ON_GRANTS_WITH_TYPED_DISCLOSURE",
    violations: [...new Set(violations)].sort(),
    status: violations.length === 0 ? "ENFORCED" : "NOT_ENFORCED",
  };
  return { ...body, report_sha256: digest(body) };
}

export function validateHardCeilingEnforcementReport(report, { declaration = RUNTIME_SLO } = {}) {
  if (report?.schema_version !== RUNTIME_SLO_ENFORCEMENT_SCHEMA) return ["schema_version"];
  const errors = [];
  if (report.status !== (report.violations?.length === 0 ? "ENFORCED" : "NOT_ENFORCED")) errors.push("status");
  const envelope = declaration?.enforced_envelope ?? {};
  if (report.declared_envelope_ms?.hard_ceiling !== envelope.hard_ceiling_ms) errors.push("declared_ceiling");
  if (report.declared_envelope_ms?.maximum_grantable_compute !== envelope.maximum_grantable_compute_ms) {
    errors.push("declared_envelope");
  }
  const { report_sha256: declared, ...body } = report ?? {};
  if (declared !== digest(body)) errors.push("report_sha256");
  return [...new Set(errors)].sort();
}

/** The phase-6 seal: one declaration, one cohort, one enforcement proof. */
export function compileRuntimeSloSeal({ declaration = RUNTIME_SLO, cohortReport, enforcementReports = [], sealedAt = new Date().toISOString() }) {
  assertRuntimeSloDeclaration(declaration);
  const enforcementViolations = enforcementReports.flatMap((report) => report?.violations ?? []);
  const body = {
    schema_version: "excel-inflow-phase6-runtime-slo-seal/1.0",
    sealed_at: String(sealedAt),
    declaration_authority: declaration.declaration_authority,
    policy_sha256: PERFORMANCE_POLICY_SHA256,
    objective_ms: declaration.end_to_end_ms,
    superseded_declarations: declaration.supersedes.map((entry) => entry.declaration),
    cohort_report_sha256: cohortReport?.report_sha256 ?? null,
    cohort_status: cohortReport?.status ?? null,
    cohort_slo_coverage: cohortReport?.slo_coverage ?? null,
    cohort_breaches: cohortReport?.breaches ?? [],
    enforcement_reports: enforcementReports.map((report) => ({
      label: report?.label ?? null,
      status: report?.status ?? null,
      report_sha256: report?.report_sha256 ?? null,
    })),
    hard_ceiling_enforced: enforcementViolations.length === 0 && enforcementReports.length > 0,
    seal_status:
      enforcementReports.length === 0
        ? "UNSEALED_NO_ENFORCEMENT_EVIDENCE"
        : enforcementViolations.length > 0
          ? "SEALED_WITH_ENFORCEMENT_DEFECT"
          : cohortReport?.status === "WITHIN_SLO"
            ? "SEALED"
            : "SEALED_WITH_SLO_FINDING",
    seal_status_note:
      "The seal records what was measured. A cohort that exceeds the objective is a FINDING recorded here, never a reason to move the objective.",
  };
  return { ...body, seal_sha256: digest(body) };
}
