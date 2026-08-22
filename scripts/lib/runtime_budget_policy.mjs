import { createHash } from "node:crypto";

export const RUNTIME_BUDGET_POLICY_SCHEMA = "excel-inflow-runtime-budget-policy/1.0";

export const DEFAULT_RUNTIME_BUDGETS_MS = Object.freeze({
  source_acquisition: 120_000,
  filing_extraction: 480_000,
  broker_native_extraction_per_document: 120_000,
  broker_semantic_recovery_per_frontier: 180_000,
  broker_global: 720_000,
  case_compilation_and_ownership: 90_000,
  solver: 120_000,
  workbook_build: 180_000,
  recalculation: 240_000,
  validation: 180_000,
  end_to_end_target: 900_000,
  end_to_end_hard_ceiling: 1_500_000,
  heartbeat_interval: 25_000,
  ownership_resolution_after_evidence: 120_000,
});

const REQUIRED_KEYS = Object.freeze(Object.keys(DEFAULT_RUNTIME_BUDGETS_MS));

/**
 * The stage budget each USER stage draws from. Declared here (not in the
 * controller) so every stage of the user flow consults the same policy and the
 * mandatory sequential path below can be reconciled against the ceiling.
 */
export const USER_FLOW_STAGE_BUDGET_KEYS = Object.freeze({
  inputs: "source_acquisition",
  evidence_review: "filing_extraction",
  decisions: "case_compilation_and_ownership",
  build_checks: "workbook_build",
  // Review performs only bounded custody verification and screen compilation;
  // it shares the validation allowance rather than minting a new budget.
  review: "validation",
  delivery: "validation",
});

/**
 * The budgets that MUST run in sequence for one delivered workbook. The other
 * keys are per-document, per-frontier, optional-lane or watchdog budgets that
 * are not additive on the mandatory path. P6.1: this sum is reconciled against
 * end_to_end_hard_ceiling, so stage-local budgets can no longer be declared in
 * a combination the run is not allowed to spend.
 */
export const MANDATORY_SEQUENTIAL_BUDGET_KEYS = Object.freeze([
  "source_acquisition",
  "filing_extraction",
  "case_compilation_and_ownership",
  "solver",
  "workbook_build",
  "recalculation",
  "validation",
]);

export function mandatorySequentialBudgetMs(budgets) {
  return MANDATORY_SEQUENTIAL_BUDGET_KEYS.reduce((total, key) => total + Number(budgets?.[key] ?? 0), 0);
}

/**
 * The aggressive stage-budget profile: the SAME mandatory sequential path with
 * tighter per-stage clocks for hosts where the certified path is known to fit.
 * Only the seven additive stages are tightened; per-document, per-frontier,
 * broker, heartbeat and ceiling keys stay at their declared defaults, so every
 * reconciliation rule that guards DEFAULT_RUNTIME_BUDGETS_MS applies unchanged.
 */
export const AGGRESSIVE_RUNTIME_BUDGETS_MS = Object.freeze({
  source_acquisition: 60_000,
  filing_extraction: 240_000,
  case_compilation_and_ownership: 60_000,
  solver: 60_000,
  workbook_build: 120_000,
  recalculation: 150_000,
  validation: 90_000,
});

/**
 * Named budget profiles. `default` IS the shipped declaration object (same
 * frozen reference); `aggressive` layers the tightened mandatory path over it.
 */
export const RUNTIME_BUDGET_PROFILES = Object.freeze({
  default: DEFAULT_RUNTIME_BUDGETS_MS,
  aggressive: Object.freeze({ ...DEFAULT_RUNTIME_BUDGETS_MS, ...AGGRESSIVE_RUNTIME_BUDGETS_MS }),
});

/**
 * Resolve a named profile to its complete budgets object. Unknown names are a
 * typed refusal, never a silent fall-back to the default: a typo'd profile
 * would otherwise quietly re-inflate every stage clock.
 */
export function resolveRuntimeBudgets(profile = "default") {
  if (typeof profile !== "string") {
    throw new Error(`Runtime budget profile must be a string, got ${typeof profile}.`);
  }
  const budgets = RUNTIME_BUDGET_PROFILES[profile];
  if (!budgets) {
    throw new Error(
      `Unknown runtime budget profile ${JSON.stringify(profile)}. Known profiles: ${Object.keys(RUNTIME_BUDGET_PROFILES).sort().join(", ")}.`,
    );
  }
  return budgets;
}

/**
 * A stage budget DERIVED from the one remaining deadline: a stage may never be
 * offered more than the run has left, whatever its stage-local number says.
 */
export function deriveStageBudgetMs({ budgets = DEFAULT_RUNTIME_BUDGETS_MS, stage = null, remainingMs = null }) {
  const declared = stage && Object.hasOwn(budgets, stage)
    ? positiveInteger(budgets[stage], stage)
    : positiveInteger(budgets.end_to_end_hard_ceiling, "end_to_end_hard_ceiling");
  const remaining = Number(remainingMs);
  if (!Number.isFinite(remaining) || remaining <= 0) return declared;
  return Math.max(1, Math.min(declared, Math.floor(remaining)));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(`${JSON.stringify(canonical(value))}\n`).digest("hex");
}

/**
 * A budget that cannot be computed is a typed controller defect, not a number.
 * The reason code is the registered internal class; the payload carries the
 * registry's custody fields so the outer catch can serialise it directly.
 */
function runtimeBudgetInputError(message) {
  const error = new Error(message);
  error.typed_internal_outcome = {
    reason_code: "INTERNAL.compiler_or_graph_defect",
    earliest_responsible_layer: "runtime_governance",
    downstream_invalidation_scope: "runtime_budget_computation",
    checkpoint_required: true,
    evidence_preserved: true,
  };
  return error;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Runtime budget ${label} must be a positive integer number of milliseconds.`);
  }
  return number;
}

export function resolveRuntimeBudgetPolicy(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Runtime budget overrides must be one object.");
  }
  const unknown = Object.keys(overrides).filter((key) => !REQUIRED_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown runtime budget keys: ${unknown.sort().join(", ")}.`);
  const budgets = Object.fromEntries(REQUIRED_KEYS.map((key) => [
    key,
    positiveInteger(overrides[key] ?? DEFAULT_RUNTIME_BUDGETS_MS[key], key),
  ]));
  if (budgets.heartbeat_interval < 20_000 || budgets.heartbeat_interval > 30_000) {
    throw new Error("Runtime heartbeat_interval must be within 20,000..30,000 ms.");
  }
  if (budgets.end_to_end_target > budgets.end_to_end_hard_ceiling) {
    throw new Error("Runtime end-to-end target cannot exceed its hard ceiling.");
  }
  if (budgets.ownership_resolution_after_evidence > 120_000) {
    throw new Error("Ownership resolution after relevant evidence cannot exceed two minutes.");
  }
  // P6.1: stage-local budgets may not be declared in a combination the run is
  // not allowed to spend. A deadline can never be extended, so the mandatory
  // sequential path must fit inside the hard ceiling by construction.
  const mandatory = mandatorySequentialBudgetMs(budgets);
  if (mandatory > budgets.end_to_end_hard_ceiling) {
    throw new Error(
      `Mandatory sequential stage budgets total ${mandatory} ms, which exceeds the ${budgets.end_to_end_hard_ceiling} ms end-to-end hard ceiling.`,
    );
  }
  const body = {
    schema_version: RUNTIME_BUDGET_POLICY_SCHEMA,
    budgets_ms: budgets,
    optional_broker_timeout_disposition: "DEGRADE_TO_PARTIAL_OR_ZERO_AUTHORITY",
    ownership_failure_disposition: "CANCEL_DESCENDANTS_PRESERVE_CHECKPOINT_RESOLVE_AND_RESUME",
  };
  return { ...body, policy_sha256: digest(body) };
}

export function validateRuntimeBudgetPolicy(policy) {
  try {
    if (policy?.schema_version !== RUNTIME_BUDGET_POLICY_SCHEMA) return ["schema_version"];
    const expected = resolveRuntimeBudgetPolicy(policy?.budgets_ms ?? {});
    const errors = [];
    if (policy?.optional_broker_timeout_disposition !== expected.optional_broker_timeout_disposition) {
      errors.push("broker_timeout_disposition");
    }
    if (policy?.ownership_failure_disposition !== expected.ownership_failure_disposition) {
      errors.push("ownership_failure_disposition");
    }
    const { policy_sha256: declared, ...body } = policy ?? {};
    if (declared !== digest(body)) errors.push("policy_sha256");
    return errors;
  } catch (error) {
    return [String(error.message)];
  }
}

/**
 * Remaining runtime against the hard ceiling.
 *
 * P6.1: `consumedComputeMs` is the PERSISTED reading of the one run-scoped
 * compute clock and takes precedence. The `controllerStartedEpochMs` form
 * measures from a PROCESS start, so every new invocation restored the whole
 * ceiling; it survives only for callers that genuinely mean "since this
 * process began" and must never be used to bound a run.
 */
export function remainingRuntimeMs({ policy, consumedComputeMs = null, controllerStartedEpochMs, nowEpochMs = Date.now() }) {
  const ceiling = positiveInteger(policy?.budgets_ms?.end_to_end_hard_ceiling, "end_to_end_hard_ceiling");
  const consumed = consumedComputeMs === null || consumedComputeMs === undefined
    ? Number.NaN
    : Number(consumedComputeMs);
  if (Number.isFinite(consumed) && consumed >= 0) {
    return Math.max(0, Math.floor(ceiling - consumed));
  }
  const elapsed = Number(nowEpochMs) - Number(controllerStartedEpochMs);
  // A budget computation must REFUSE rather than return a non-finite number.
  // An unusable input used to propagate as NaN all the way into a subprocess
  // spawn, where "no budget" is indistinguishable from "no timeout" — exactly
  // the unbounded compute this layer exists to prevent.
  if (!Number.isFinite(elapsed)) {
    throw runtimeBudgetInputError(
      "Remaining runtime cannot be computed: neither the persisted compute reading (consumedComputeMs) nor a usable elapsed window (controllerStartedEpochMs, nowEpochMs) was supplied.",
    );
  }
  return Math.max(0, Math.floor(ceiling - Math.max(0, elapsed)));
}

export function boundedStageTimeout({ policy, stage, requestedMs, consumedComputeMs = null, controllerStartedEpochMs, nowEpochMs = Date.now() }) {
  const stageBudget = positiveInteger(policy?.budgets_ms?.[stage], stage);
  const requested = requestedMs === undefined ? stageBudget : positiveInteger(requestedMs, `${stage}:requested`);
  const remaining = remainingRuntimeMs({ policy, consumedComputeMs, controllerStartedEpochMs, nowEpochMs });
  if (remaining <= 0) return 0;
  const bounded = Math.min(stageBudget, requested, remaining);
  // Belt and braces: no non-finite timeout may ever leave this layer.
  if (!Number.isFinite(bounded)) {
    throw runtimeBudgetInputError(`The ${stage} stage timeout could not be bounded to a finite number of milliseconds.`);
  }
  return bounded;
}

export function compileRuntimeBudgetReceipt({ policy, startedAt, endedAt, stageExecutions = [] }) {
  const executions = stageExecutions.map((execution, index) => ({
    sequence: index + 1,
    stage: String(execution.stage ?? ""),
    budget_ms: Number(execution.budget_ms),
    duration_ms: Math.max(0, Number(execution.duration_ms ?? 0)),
    outcome: String(execution.outcome ?? ""),
    process_tree_termination_verified: execution.process_tree_termination_verified !== false,
    checkpoint_preserved: execution.checkpoint_preserved !== false,
    evidence_retained: execution.evidence_retained !== false,
  }));
  const violations = [];
  for (const execution of executions) {
    if (!Object.hasOwn(policy?.budgets_ms ?? {}, execution.stage)) violations.push(`unknown_stage:${execution.stage}`);
    if (!Number.isFinite(execution.budget_ms) || execution.budget_ms <= 0) violations.push(`budget:${execution.stage}`);
    // The budget stops useful work. Allow only the bounded process-tree
    // termination and survivor-verification tail after the timer fires.
    if (execution.duration_ms > execution.budget_ms + 5_000) violations.push(`overrun:${execution.stage}`);
    if (execution.outcome === "TIMEOUT" && !execution.process_tree_termination_verified) {
      violations.push(`survivors:${execution.stage}`);
    }
    if (execution.outcome === "TIMEOUT" && (!execution.checkpoint_preserved || !execution.evidence_retained)) {
      violations.push(`custody:${execution.stage}`);
    }
  }
  const body = {
    schema_version: "excel-inflow-runtime-budget-receipt/1.0",
    policy_sha256: policy?.policy_sha256 ?? null,
    started_at: String(startedAt ?? ""),
    ended_at: String(endedAt ?? ""),
    stage_executions: executions,
    status: violations.length === 0 ? "PASS" : "FAIL",
    violations: [...new Set(violations)].sort(),
  };
  return { ...body, receipt_sha256: digest(body) };
}

export function validateRuntimeBudgetReceipt(receipt, policy) {
  const expected = compileRuntimeBudgetReceipt({
    policy,
    startedAt: receipt?.started_at,
    endedAt: receipt?.ended_at,
    stageExecutions: receipt?.stage_executions ?? [],
  });
  const errors = [];
  if (receipt?.schema_version !== expected.schema_version) errors.push("schema_version");
  if (receipt?.policy_sha256 !== policy?.policy_sha256) errors.push("policy_binding");
  if (receipt?.status !== "PASS" || expected.status !== "PASS") errors.push("status");
  if (receipt?.receipt_sha256 !== expected.receipt_sha256) errors.push("receipt_sha256");
  return [...new Set(errors)].sort();
}

export const STAGE4_RUNTIME_STAGES = Object.freeze([
  "solver",
  "workbook_build",
  "recalculation",
  "validation",
]);

export function stage4BudgetStage(checkpointId) {
  const id = String(checkpointId ?? "");
  if (["semantic_gates", "plan"].includes(id)) return "solver";
  if (["emit", "terminal_patch"].includes(id)) return "workbook_build";
  if (id === "recalculate") return "recalculation";
  if (id.startsWith("verify_") || id === "render" || id.startsWith("render_sheet_")) {
    return "validation";
  }
  return null;
}

/**
 * Cumulative Stage-4 budget ledger. A logical budget is shared by all of its
 * checkpoints, so splitting work into children can never reset the clock.
 */
export class RuntimeStageBudgetLedger {
  constructor(policy, { now = () => Date.now() } = {}) {
    const errors = validateRuntimeBudgetPolicy(policy);
    if (errors.length > 0) throw new Error(`Invalid runtime budget policy: ${errors.join(", ")}`);
    this.policy = policy;
    this.now = now;
    this.startedAt = new Date().toISOString();
    this.elapsed = Object.fromEntries(STAGE4_RUNTIME_STAGES.map((stage) => [stage, 0]));
    this.outcomes = Object.fromEntries(STAGE4_RUNTIME_STAGES.map((stage) => [stage, "PASS"]));
    this.terminationVerified = Object.fromEntries(STAGE4_RUNTIME_STAGES.map((stage) => [stage, true]));
    this.checkpointPreserved = Object.fromEntries(STAGE4_RUNTIME_STAGES.map((stage) => [stage, true]));
    this.evidenceRetained = Object.fromEntries(STAGE4_RUNTIME_STAGES.map((stage) => [stage, true]));
    this.observed = new Set();
  }

  remaining(stage) {
    if (!STAGE4_RUNTIME_STAGES.includes(stage)) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.policy.budgets_ms[stage] - this.elapsed[stage]);
  }

  timeout(stage, requestedMs) {
    const remaining = this.remaining(stage);
    const requested = Number(requestedMs);
    return Math.max(1, Math.floor(Number.isFinite(requested) && requested > 0
      ? Math.min(remaining, requested)
      : remaining));
  }

  begin(stage) {
    if (!STAGE4_RUNTIME_STAGES.includes(stage)) return null;
    if (this.remaining(stage) <= 0) {
      const error = new Error(`Independent ${stage} runtime budget is exhausted.`);
      error.code = "STAGE_RUNTIME_BUDGET_EXHAUSTED";
      error.budget_stage = stage;
      throw error;
    }
    this.observed.add(stage);
    return { stage, started: this.now() };
  }

  end(token, { outcome = "PASS", terminationVerified = true, checkpointPreserved = true, evidenceRetained = true } = {}) {
    if (!token) return;
    const duration = Math.max(0, this.now() - token.started);
    this.elapsed[token.stage] += duration;
    if (outcome !== "PASS" && this.outcomes[token.stage] === "PASS") this.outcomes[token.stage] = outcome;
    if (!terminationVerified) this.terminationVerified[token.stage] = false;
    if (!checkpointPreserved) this.checkpointPreserved[token.stage] = false;
    if (!evidenceRetained) this.evidenceRetained[token.stage] = false;
    if (this.elapsed[token.stage] > this.policy.budgets_ms[token.stage] && this.outcomes[token.stage] === "PASS") {
      this.outcomes[token.stage] = "TIMEOUT";
    }
  }

  noteProcessResult(stage, result) {
    if (!STAGE4_RUNTIME_STAGES.includes(stage) || !result) return;
    if (result.timed_out) {
      this.outcomes[stage] = "TIMEOUT";
      this.terminationVerified[stage] = result.termination_verified === true;
    } else if (!result.ok && this.outcomes[stage] === "PASS") {
      this.outcomes[stage] = "FAIL";
    }
  }

  receipt({ requireAll = false } = {}) {
    const missing = requireAll ? STAGE4_RUNTIME_STAGES.filter((stage) => !this.observed.has(stage)) : [];
    const receipt = compileRuntimeBudgetReceipt({
      policy: this.policy,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      stageExecutions: [...this.observed].map((stage) => ({
        stage,
        budget_ms: this.policy.budgets_ms[stage],
        duration_ms: this.elapsed[stage],
        outcome: this.outcomes[stage],
        process_tree_termination_verified: this.terminationVerified[stage],
        checkpoint_preserved: this.checkpointPreserved[stage],
        evidence_retained: this.evidenceRetained[stage],
      })),
    });
    const nonPassing = requireAll
      ? STAGE4_RUNTIME_STAGES.filter((stage) => this.observed.has(stage) && this.outcomes[stage] !== "PASS")
      : [];
    if (missing.length === 0 && nonPassing.length === 0) return receipt;
    const { receipt_sha256: _discard, ...body } = receipt;
    body.status = "FAIL";
    body.violations = [...new Set([
      ...(body.violations ?? []),
      ...missing.map((stage) => `missing_stage:${stage}`),
      ...nonPassing.map((stage) => `nonpassing_stage:${stage}:${this.outcomes[stage]}`),
    ])].sort();
    return { ...body, receipt_sha256: digest(body) };
  }
}

export function ownershipFailureCancellationPlan({ checkpointSha256, descendantPids = [] } = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(checkpointSha256 ?? ""))) {
    throw new Error("Ownership cancellation requires a sealed checkpoint SHA-256.");
  }
  const pids = [...new Set(descendantPids.map(Number))].filter((pid) => Number.isInteger(pid) && pid > 0).sort((a, b) => a - b);
  const body = {
    schema_version: "ownership-failure-cancellation/1.0",
    checkpoint_sha256: checkpointSha256,
    cancel_descendant_pids: pids,
    preserve_checkpoint: true,
    resume_from: "ownership_resolution",
    broker_restart_allowed: false,
    user_reupload_required: false,
  };
  return { ...body, plan_sha256: digest(body) };
}

export function compileOwnershipPreflightControllerAction({
  preflightReceipt,
  checkpointSha256,
  descendantPids = [],
} = {}) {
  const { receipt_sha256: declaredReceiptSha, ...receiptBody } = preflightReceipt ?? {};
  if (
    preflightReceipt?.schema_version !== "forecast-ownership-preflight/1.0" ||
    preflightReceipt?.status !== "BLOCK" ||
    preflightReceipt?.controller_signal?.action !== "cancel_descendants_preserve_checkpoint" ||
    declaredReceiptSha !== digest(receiptBody)
  ) {
    throw new Error("Ownership controller action requires one sealed BLOCK preflight receipt.");
  }
  const body = {
    schema_version: "ownership-preflight-controller-action/1.0",
    preflight_receipt: preflightReceipt,
    controller_signal: preflightReceipt.controller_signal,
    cancellation: ownershipFailureCancellationPlan({ checkpointSha256, descendantPids }),
  };
  return { ...body, action_sha256: digest(body) };
}
