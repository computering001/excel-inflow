#!/usr/bin/env node
/**
 * P6.8 — THE RUNTIME SLO SEAL.
 *
 * Invariant under test: the runtime SLO is ONE declaration, and it is
 * EVIDENCED — a cold/warm cohort measured on the real controller, aggregated
 * to p50/p95, plus a hard-ceiling enforcement proof that FAILS on breach.
 *
 * The reds this suite pins, every one measured at HEAD before the repair:
 *
 *  RED 1  THREE mutually contradictory declarations.
 *           assets/performance-policy-v1.json#service_objectives_minutes
 *             standard_p50 35 min, standard_p95 45 min, no_broker_p95 25 min
 *           scripts/lib/runtime_budget_policy.mjs#DEFAULT_RUNTIME_BUDGETS_MS
 *             end_to_end_target 900000 ms, end_to_end_hard_ceiling 1500000 ms
 *           the execution pack's P6.8 row
 *             normal < 15 min, P95 < 20 min, ceiling 25 min
 *         The asset's pair is not a rival opinion, it is UNSATISFIABLE:
 *         35 min (2100000 ms) and 45 min (2700000 ms) both exceed the
 *         1500000 ms ceiling the runtime enforces, so a run meeting the
 *         "objective" would already have exhausted its only clock. Measured:
 *           35*60000 = 2100000 > 1500000  -> true
 *           45*60000 = 2700000 > 1500000  -> true
 *         Part A is that reconciliation, and the mutations that stop the
 *         second declaration from growing back.
 *
 *  RED 2  NO percentile aggregation existed anywhere.
 *           grep -rn "function percentile|nearest_rank|quantile" scripts/
 *           -> zero hits
 *         So no runtime claim in the repository was ever a distribution; the
 *         budget policy has one target and one ceiling and no vocabulary for a
 *         tail. Part B.
 *
 *  RED 3  NO cold/warm cohort.
 *           grep -rln "cold_p50|warm_p95" scripts/ -> zero hits
 *         Worse, the obvious way to build one is WRONG: P6.1's clock is
 *         deliberately cumulative, so reading compute_elapsed_ms off a warm
 *         ledger reports the warm run as SLOWER than the cold run that seeded
 *         it. Measured on the real controller: cold 2820 ms, warm ledger total
 *         4533 ms, warm INVOCATION 1713 ms. Parts C and D.
 *
 *  RED 4  NO hard-ceiling enforcement test. P6.1's suite bounds the floor
 *         (grants past the ceiling draw from a finite allowance) but nothing
 *         ever stated the resulting envelope as a number, checked a real run's
 *         ledger against it, or FAILED on a breach. Part E.
 *
 * WHAT THIS SUITE DOES NOT RE-PROVE: P6.1's clock (run_hard_clock_tests),
 * P6.6's receipt honesty (run_performance_receipt_honesty_tests), P6.3's work
 * graph (run_evidence_work_graph_tests) and P6.4's enacted invalidation
 * (run_differential_invalidation_tests). None of those files are touched here;
 * this package reads them.
 *
 *   node scripts/run_runtime_slo_tests.mjs
 *   node scripts/run_runtime_slo_tests.mjs --seal evidence/phase_6
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DEFAULT_RUNTIME_BUDGETS_MS,
  resolveRuntimeBudgetPolicy,
} from "./lib/runtime_budget_policy.mjs";
import {
  STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
  RUNTIME_BUDGET_OVERRUN_REASON,
} from "./lib/run_deadline.mjs";
import { PERFORMANCE_POLICY } from "./lib/experience_trace.mjs";
import {
  PERFORMANCE_POLICY_REF,
  PERFORMANCE_POLICY_SHA256,
  REQUIRED_COHORTS,
  RUNTIME_SLO,
  RUNTIME_SLO_REFUSALS,
  RUNTIME_SLO_SCHEMA,
  RuntimeSloRefusal,
  SUPERSEDED_DECLARATION_KEYS,
  compileRuntimeSloCohortReport,
  compileRuntimeSloSeal,
  digest,
  hardCeilingEnforcementReport,
  percentileMs,
  runtimeSloSample,
  validateHardCeilingEnforcementReport,
  validateRuntimeSloCohortReport,
  validateRuntimeSloDeclaration,
} from "./lib/runtime_slo.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SEAL_INDEX = process.argv.indexOf("--seal");
const SEAL_DIR = SEAL_INDEX > 0 ? path.resolve(ROOT, String(process.argv[SEAL_INDEX + 1])) : null;
const CASES = path.resolve(
  process.env.DEBT_OVERLAY_CASES_DIR ?? fileURLToPath(new URL("../test-fixtures/cases", import.meta.url)),
);
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "dmu-runtime-slo-"));
const SCOPE = "evidence_half_through_decisions";

let checks = 0;
const violations = [];
function check(condition, message) {
  checks += 1;
  if (!condition) violations.push(message);
}
/** A refusal is a FEATURE: prove the exact refusal, not merely that it threw. */
function refuses(refusal, fn, message) {
  checks += 1;
  try {
    fn();
    violations.push(`${message} (nothing was refused)`);
  } catch (error) {
    if (!(error instanceof RuntimeSloRefusal) || error.refusal !== refusal) {
      violations.push(`${message} (got ${error?.refusal ?? error?.message})`);
    }
  }
}
async function command(script, args, options = {}) {
  return exec(process.execPath, [path.join(HERE, script), ...args], {
    cwd: ROOT,
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}
async function readJson(target) {
  return JSON.parse(await fs.readFile(target, "utf8"));
}
const clone = (value) => JSON.parse(JSON.stringify(value));

// ===========================================================================
// PART A — ONE DECLARATION, AND IT IS BOUND TO WHAT IS ENFORCED.
// ===========================================================================
check(validateRuntimeSloDeclaration().length === 0,
  `the single runtime SLO declaration does not validate: ${validateRuntimeSloDeclaration().join(", ")}`);
check(RUNTIME_SLO?.schema_version === RUNTIME_SLO_SCHEMA, "the declaration carries no schema version");
check(RUNTIME_SLO.declaration_authority === `${PERFORMANCE_POLICY_REF}#runtime_slo`,
  "the declaration does not name itself as the authority");

// The numbers are the pack's triple, expressed in the enforcement layer's unit.
check(RUNTIME_SLO.end_to_end_ms.p50 === 900_000, "the declared p50 is not fifteen minutes");
check(RUNTIME_SLO.end_to_end_ms.p95 === 1_200_000, "the declared p95 is not twenty minutes");
check(RUNTIME_SLO.end_to_end_ms.hard_ceiling === 1_500_000, "the declared hard ceiling is not twenty-five minutes");

// RED 1, restated as arithmetic: the superseded pair could not be met.
check(35 * 60_000 > DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_hard_ceiling,
  "the superseded 35-minute p50 no longer exceeds the enforced ceiling, so RED 1 has changed shape");
check(45 * 60_000 > DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_hard_ceiling,
  "the superseded 45-minute p95 no longer exceeds the enforced ceiling, so RED 1 has changed shape");

// THE BINDING: the asset is authoritative because the enforced constants must
// agree with it BY NAME. Divergence in either direction is refused.
check(DEFAULT_RUNTIME_BUDGETS_MS[RUNTIME_SLO.bound_runtime_budget_keys.p50] === RUNTIME_SLO.end_to_end_ms.p50,
  "the declared p50 is not bound to the enforced end_to_end_target");
check(
  DEFAULT_RUNTIME_BUDGETS_MS[RUNTIME_SLO.bound_runtime_budget_keys.hard_ceiling]
    === RUNTIME_SLO.end_to_end_ms.hard_ceiling,
  "the declared hard ceiling is not bound to the enforced end_to_end_hard_ceiling",
);
check(
  validateRuntimeSloDeclaration(RUNTIME_SLO, {
    budgets: { ...DEFAULT_RUNTIME_BUDGETS_MS, end_to_end_target: 900_001 },
  }).includes("p50_not_bound_to_enforced_target"),
  "a runtime whose enforced target drifts from the declaration is accepted",
);
check(
  validateRuntimeSloDeclaration(RUNTIME_SLO, {
    budgets: { ...DEFAULT_RUNTIME_BUDGETS_MS, end_to_end_hard_ceiling: 2_100_000 },
  }).includes("hard_ceiling_not_bound_to_enforced_ceiling"),
  "a runtime whose enforced ceiling drifts from the declaration is accepted",
);

// The envelope is declared, not hidden: ceiling + P6.1's bounded floor.
check(RUNTIME_SLO.enforced_envelope.bounded_floor_allowance_ms === STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
  "the declared floor allowance is not the one the clock actually grants");
check(
  RUNTIME_SLO.enforced_envelope.maximum_grantable_compute_ms
    === RUNTIME_SLO.end_to_end_ms.hard_ceiling + STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
  "the declared envelope is not ceiling plus bounded floor allowance",
);
check(RUNTIME_SLO.enforced_envelope.in_process_preemption === false,
  "the declaration claims in-process preemption the runtime does not perform");

// SINGLE means single. The superseded keys may not grow back beside it.
for (const key of SUPERSEDED_DECLARATION_KEYS) {
  const grownBack = clone(PERFORMANCE_POLICY);
  grownBack[key] = key === "service_objectives_minutes" ? { standard_p50: 35 } : 35;
  check(
    validateRuntimeSloDeclaration(RUNTIME_SLO, { policyDocument: grownBack })
      .includes(`rival_declaration:${key}`),
    `a second end-to-end declaration reintroduced as ${key} is accepted`,
  );
}
check(
  !JSON.stringify({ ...PERFORMANCE_POLICY, runtime_slo: { ...RUNTIME_SLO, supersedes: [] } })
    .includes("service_objectives_minutes"),
  "the superseded declaration is still live in the asset",
);
check(Array.isArray(RUNTIME_SLO.supersedes) && RUNTIME_SLO.supersedes.length === 2,
  "the asset does not record both superseded declarations");
check(RUNTIME_SLO.supersedes.every((entry) => entry.why_wrong.length > 40),
  "a superseded declaration is recorded without saying why it was wrong");
check(
  validateRuntimeSloDeclaration({ ...RUNTIME_SLO, supersedes: [{ declaration: "x" }] })
    .includes("supersedes_unjustified"),
  "a superseded declaration may be dropped without justification",
);
// The unsatisfiable shape itself is refused, so RED 1 cannot be re-declared.
check(
  validateRuntimeSloDeclaration({
    ...RUNTIME_SLO,
    end_to_end_ms: { p50: 2_100_000, p95: 2_700_000, hard_ceiling: 1_500_000 },
  }).includes("objective_not_ordered_inside_ceiling"),
  "an objective that sits outside the hard ceiling is accepted again",
);
// The instruction surfaces state the same two numbers in prose.
const skill = await fs.readFile(path.join(ROOT, "SKILL.md"), "utf8");
check(
  skill.replace(/\s+/g, " ").includes("target\nis fifteen minutes and the hard ceiling is twenty-five minutes".replace(/\s+/g, " ")),
  "the instruction surface no longer states the fifteen/twenty-five minute pair the declaration is bound to",
);

// Everything below AGGREGATES against the declaration, so an invalid
// declaration is reported here rather than surfacing as a stack trace from
// the first aggregation that refuses it.
if (validateRuntimeSloDeclaration().length > 0) {
  for (const violation of violations) process.stderr.write(`${violation}\n`);
  process.stderr.write(`declaration errors: ${validateRuntimeSloDeclaration().join(", ")}\n`);
  process.stdout.write(`${JSON.stringify({ status: "FAIL", checks })}\n`);
  await fs.rm(workspace, { recursive: true, force: true });
  process.exit(1);
}

// ===========================================================================
// PART B — PERCENTILES: correct, and refused when they would be meaningless.
// ===========================================================================
const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
check(percentileMs(ten, 50, { minimumSamples: 5 }) === 50, "nearest-rank p50 of 10 evenly spaced samples is wrong");
check(percentileMs(ten, 95, { minimumSamples: 5 }) === 100, "nearest-rank p95 of 10 evenly spaced samples is wrong");
check(percentileMs([5, 1, 3, 2, 4], 50, { minimumSamples: 5 }) === 3, "the percentile does not sort its input");
check(percentileMs([1, 1, 1, 1, 1], 95, { minimumSamples: 5 }) === 1, "a degenerate cohort does not return its value");
refuses("refused.percentile_below_minimum_sample",
  () => percentileMs([1, 2, 3, 4], 95, { minimumSamples: 5 }),
  "a p95 computed from fewer than the declared minimum sample was allowed");
refuses("refused.percentile_below_minimum_sample",
  () => percentileMs(ten, 95, {}),
  "a percentile with no declared minimum sample was allowed");
refuses("refused.percentile_unknown",
  () => percentileMs([1, 2, 3, 4, Number.NaN], 95, { minimumSamples: 5 }),
  "a percentile over a non-finite duration was allowed");
refuses("refused.percentile_unknown",
  () => percentileMs(ten, 0, { minimumSamples: 5 }),
  "a p0 was allowed");
check(RUNTIME_SLO.cohort.minimum_samples_per_cohort === 5, "the declared minimum sample is not five");
check(RUNTIME_SLO.cohort.conservative_upper_bound_below_samples === 20,
  "the declaration does not say below which sample size a p95 is only an upper bound");

// ===========================================================================
// PART C — A SAMPLE IS A MEASUREMENT OR IT IS NOTHING.
// ===========================================================================
const seedLedger = {
  schema_version: "excel-inflow-run-deadline/1.1",
  run_id: "seed_run",
  controller_versions: ["six-milestone/3.0"],
  source_digests: [],
  policy_digests: [],
  hard_deadline_compute_ms: 1_500_000,
  target_compute_ms: 900_000,
  compute_elapsed_ms: 1_000,
  floor_granted_ms: 0,
  floor_allowance_ms: STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
  stage_allowances: [{ stage: "inputs", requested_ms: 120_000, remaining_ms_at_consult: 1_500_000, granted_ms: 120_000 }],
  open_invocations: {},
  segments: [{ label: "stage:inputs", duration_ms: 1_000 }],
  deadline_receipts: [],
};
refuses("refused.sample_not_ledger_measured",
  () => runtimeSloSample({ cohort: "COLD", scope: SCOPE, ledger: null }),
  "a sample was built without a ledger");
refuses("refused.sample_unknown_cohort",
  () => runtimeSloSample({ cohort: "TEPID", scope: SCOPE, ledger: seedLedger }),
  "a sample declared an undeclared cohort");
refuses("refused.sample_unknown_scope",
  () => runtimeSloSample({ cohort: "COLD", scope: "whatever", ledger: seedLedger }),
  "a sample declared an undeclared scope");
refuses("refused.sample_unknown_cohort",
  () => runtimeSloSample({ cohort: "WARM", scope: SCOPE, ledger: seedLedger }),
  "a WARM sample was built with no prior ledger reading and no reuse");
refuses("refused.sample_unknown_cohort",
  () => runtimeSloSample({ cohort: "COLD", scope: SCOPE, ledger: seedLedger, reusedStages: ["inputs"] }),
  "a COLD sample was built from a run that reused work");
refuses("refused.sample_ledger_invalid",
  () => runtimeSloSample({
    cohort: "COLD",
    scope: SCOPE,
    ledger: { ...seedLedger, compute_elapsed_ms: 999_999 },
  }),
  "a sample was built from a ledger whose compute does not reconcile with its segments");
check(runtimeSloSample({ cohort: "COLD", scope: SCOPE, ledger: seedLedger }).compute_ms === 1_000,
  "a lawful cold sample does not report its ledger's compute");

// ===========================================================================
// PART D — THE REAL COHORT. FIVE COLD AND FIVE WARM RUNS OF THE REAL
//          CONTROLLER, MEASURED FROM THE LEDGERS THOSE RUNS PERSISTED.
// ===========================================================================
const evidenceRun = path.join(workspace, "acquisition-question-evidence-run.json");
await command("run_evidence_run_tests.mjs", [CASES, "--emit-acquisition-question", evidenceRun]);
const answers = path.join(workspace, "answers.json");
await fs.writeFile(answers, `${JSON.stringify({ answers: { acquisition_funding: "debt" } }, null, 2)}\n`);

const samples = [];
const cohortLedgers = [];
for (let index = 0; index < RUNTIME_SLO.cohort.minimum_samples_per_cohort; index += 1) {
  const runDir = path.join(workspace, "cohort", `run-${index}`);
  const ledgerPath = path.join(runDir, "run-deadline.json");
  const args = [evidenceRun, "--out", runDir, "--answers", answers, "--stop-after", "decisions", "--json"];

  const coldResult = JSON.parse((await command("run_user_flow.mjs", args)).stdout);
  const coldLedger = await readJson(ledgerPath);
  check(coldResult.status === "PAUSED", `cold run ${index} did not pause lawfully: ${coldResult.status}`);
  check((coldResult.reused_stages ?? []).length === 0, `cold run ${index} claimed reuse`);
  samples.push(runtimeSloSample({
    cohort: "COLD",
    scope: SCOPE,
    ledger: coldLedger,
    ledgerPath: path.relative(workspace, ledgerPath),
    expectedRunId: coldResult.run_id,
    reusedStages: coldResult.reused_stages ?? [],
  }));

  const warmResult = JSON.parse((await command("run_user_flow.mjs", args)).stdout);
  const warmLedger = await readJson(ledgerPath);
  check(warmResult.status === "PAUSED", `warm run ${index} did not pause lawfully: ${warmResult.status}`);
  check(
    JSON.stringify(warmResult.reused_stages) === JSON.stringify(["inputs", "evidence_review", "decisions"]),
    `warm run ${index} did not reuse the three evidence stages: ${JSON.stringify(warmResult.reused_stages)}`,
  );
  check(warmResult.run_id === coldResult.run_id, `warm run ${index} is not the same run as its cold half`);
  samples.push(runtimeSloSample({
    cohort: "WARM",
    scope: SCOPE,
    ledger: warmLedger,
    priorLedger: coldLedger,
    ledgerPath: path.relative(workspace, ledgerPath),
    expectedRunId: warmResult.run_id,
    reusedStages: warmResult.reused_stages ?? [],
  }));
  cohortLedgers.push({ label: `cohort_run_${index}`, ledger: warmLedger });

  // RED 3 in the live data: the cumulative clock would invert the comparison.
  check(
    warmLedger.compute_elapsed_ms > coldLedger.compute_elapsed_ms,
    `run ${index}: the persisted clock did not accumulate, so P6.1's invariant has regressed`,
  );
}
const cold = samples.filter((sample) => sample.cohort === "COLD");
const warm = samples.filter((sample) => sample.cohort === "WARM");
check(cold.length === 5 && warm.length === 5, `the cohort is not 5 cold and 5 warm: ${cold.length}/${warm.length}`);
check(
  warm.every((sample) => sample.compute_ms < sample.run_total_compute_ms),
  "a warm invocation was charged the whole run's clock rather than its own delta",
);

const cohortReport = compileRuntimeSloCohortReport({
  samples,
  capturedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: os.cpus().length,
    fixture: "acquisition-question evidence run (test-fixtures/cases)",
  },
});
check(validateRuntimeSloCohortReport(cohortReport).length === 0,
  `the cohort report does not validate: ${validateRuntimeSloCohortReport(cohortReport).join(", ")}`);
check(cohortReport.cohorts.COLD.samples === 5 && cohortReport.cohorts.WARM.samples === 5,
  "the report does not carry both cohorts at the declared sample size");
check(cohortReport.slo_coverage === "LOWER_BOUND_ONLY",
  "a cohort that stops short of delivery claims to certify the end-to-end objective");
check(cohortReport.cohorts.WARM.p95_estimate === "CONSERVATIVE_UPPER_BOUND",
  "a p95 from five samples is not declared a conservative upper bound");
check(cohortReport.cold_to_warm.warm_p95_within_cold_p95,
  `MEASURED FINDING: warm p95 ${cohortReport.cohorts.WARM.p95_ms} ms exceeds cold p95 ${cohortReport.cohorts.COLD.p95_ms} ms — enacted reuse made the run slower`);
check(cohortReport.cold_to_warm.p50_saved_ms > 0,
  `enacted reuse saved no median time (cold ${cohortReport.cohorts.COLD.p50_ms} ms, warm ${cohortReport.cohorts.WARM.p50_ms} ms)`);
// The percentiles are recomputed independently here, so the report cannot be
// the only witness to its own arithmetic.
check(
  cohortReport.cohorts.COLD.p50_ms === percentileMs(cold.map((s) => s.compute_ms), 50, { minimumSamples: 5 })
  && cohortReport.cohorts.WARM.p95_ms === percentileMs(warm.map((s) => s.compute_ms), 95, { minimumSamples: 5 }),
  "the report's percentiles do not match an independent computation over the same samples",
);

// Cohort refusals, on the REAL samples.
refuses("refused.cohort_missing",
  () => compileRuntimeSloCohortReport({ samples: cold }),
  "a cohort with no WARM runs was aggregated");
refuses("refused.cohort_missing",
  () => compileRuntimeSloCohortReport({ samples: warm }),
  "a cohort with no COLD runs was aggregated");
refuses("refused.cohort_below_minimum_sample",
  () => compileRuntimeSloCohortReport({ samples: [...cold.slice(0, 4), ...warm] }),
  "a cohort below the declared minimum sample was aggregated");
refuses("refused.sample_duplicate_run",
  () => compileRuntimeSloCohortReport({ samples: [...samples, samples[0]] }),
  "the same ledger reading was counted twice");
refuses("refused.sample_not_ledger_measured",
  () => compileRuntimeSloCohortReport({
    samples: samples.map((sample, index) => (index === 0
      ? { ...sample, measurement_source: "stopwatch" }
      : sample)),
  }),
  "a synthetic timing was admitted to the cohort");
refuses("refused.sample_not_ledger_measured",
  () => compileRuntimeSloCohortReport({
    samples: samples.map((sample, index) => (index === 1 ? { ...sample, compute_ms: 1 } : sample)),
  }),
  "a sample whose duration is not its invocation delta was admitted");
refuses("refused.sample_unknown_cohort",
  () => compileRuntimeSloCohortReport({
    samples: samples.map((sample) => (sample.cohort === "WARM"
      ? { ...sample, reused_stages: [], prior_ledger_sha256: null }
      : sample)),
  }),
  "a WARM sample that reused nothing was admitted");

// A verdict must follow from the numbers beneath it, in BOTH directions.
// A forged percentile, RE-SEALED so its own hash agrees. Only recomputing the
// aggregation from the samples can catch this.
const forgedPass = clone(cohortReport);
forgedPass.cohorts.COLD.p95_ms = 1;
delete forgedPass.report_sha256;
forgedPass.report_sha256 = digest(forgedPass);
const forgedPassErrors = validateRuntimeSloCohortReport(forgedPass);
check(forgedPassErrors.includes("cohorts") && !forgedPassErrors.includes("report_sha256"),
  `a re-sealed report with a forged percentile was not caught by recomputation: ${forgedPassErrors.join(", ")}`);
const breaching = compileRuntimeSloCohortReport({
  samples: samples.map((sample) => ({
    ...sample,
    compute_ms: sample.compute_ms + 1_300_000,
    run_total_compute_ms: sample.run_total_compute_ms + 1_300_000,
  })),
});
check(breaching.status === "SLO_EXCEEDED", "a cohort past the declared p95 did not report SLO_EXCEEDED");
check(breaching.breaches.includes("COLD:p95") && breaching.breaches.includes("WARM:p95"),
  "a p95 breach was not named per cohort");
const forgedVerdict = clone(breaching);
forgedVerdict.status = "WITHIN_SLO";
forgedVerdict.breaches = [];
const { report_sha256: _drop, ...forgedBody } = forgedVerdict;
forgedVerdict.report_sha256 = digest(forgedBody);
check(
  validateRuntimeSloCohortReport(forgedVerdict).includes("status"),
  "a WITHIN_SLO verdict stamped over a breaching cohort validated",
);

// ===========================================================================
// PART E — HARD-CEILING ENFORCEMENT, AND IT FAILS ON BREACH.
// ===========================================================================
// E-real-1: every real cohort ledger is inside the declared envelope.
for (const { label, ledger } of cohortLedgers) {
  const report = hardCeilingEnforcementReport({ ledger, label });
  check(report.status === "ENFORCED", `${label}: ${report.violations.join(", ")}`);
  check(validateHardCeilingEnforcementReport(report).length === 0, `${label}: enforcement report does not validate`);
}

// E-real-2: drive the REAL controller past a real ceiling. A tiny sealed
// policy makes the ceiling reachable in seconds; nothing about the enforcement
// path is stubbed.
const tinyPolicyPath = path.join(workspace, "tiny-policy.json");
const tinyPolicy = resolveRuntimeBudgetPolicy({
  source_acquisition: 1,
  filing_extraction: 1,
  case_compilation_and_ownership: 1,
  solver: 1,
  workbook_build: 1,
  recalculation: 1,
  validation: 1,
  end_to_end_target: 5,
  end_to_end_hard_ceiling: 7,
});
await fs.writeFile(tinyPolicyPath, `${JSON.stringify(tinyPolicy, null, 2)}\n`);
const tinyDir = path.join(workspace, "tiny-ceiling");
const tinyLedgerPath = path.join(tinyDir, "run-deadline.json");
const tinyArgs = [
  evidenceRun, "--out", tinyDir, "--answers", answers, "--stop-after", "decisions",
  "--runtime-budget-policy", tinyPolicyPath, "--json",
];
await command("run_user_flow.mjs", tinyArgs);
const tinyCold = await readJson(tinyLedgerPath);
check(tinyCold.hard_deadline_compute_ms === 7, "the stated tiny ceiling was not adopted by the ledger");
check(tinyCold.compute_elapsed_ms > tinyCold.hard_deadline_compute_ms,
  `the tiny-ceiling run did not reach its ceiling (${tinyCold.compute_elapsed_ms} of ${tinyCold.hard_deadline_compute_ms} ms)`);
// The overshoot is DISCLOSED with the registered code — that is the enforcement
// mode for in-process work, which is charged and typed but not preempted.
const tinyOverruns = tinyCold.deadline_receipts.filter(
  (receipt) => receipt.reason_code === RUNTIME_BUDGET_OVERRUN_REASON,
);
check(tinyOverruns.length > 0, "a run that overshot its ceiling recorded no typed overrun receipt");
const tinyColdReport = hardCeilingEnforcementReport({ ledger: tinyCold, label: "tiny_ceiling_cold" });
check(tinyColdReport.status === "ENFORCED", `tiny_ceiling_cold: ${tinyColdReport.violations.join(", ")}`);
check(tinyColdReport.observed.overshoot_past_ceiling_ms > 0,
  "the enforcement report does not size the overshoot it certified as disclosed");

// A SECOND invocation of the same run starts with the ceiling already spent,
// so every consult must draw BOUNDED floor debt and type it.
await command("run_user_flow.mjs", tinyArgs);
const tinyWarm = await readJson(tinyLedgerPath);
const floorGrants = tinyWarm.stage_allowances.filter((entry) => Number(entry.remaining_ms_at_consult) === 0);
check(floorGrants.length >= 3, "a run resumed past an exhausted ceiling did not consult the clock at zero remaining");
check(tinyWarm.floor_granted_ms > 0 && tinyWarm.floor_granted_ms <= tinyWarm.floor_allowance_ms,
  `floor debt is not bounded by the allowance (${tinyWarm.floor_granted_ms} of ${tinyWarm.floor_allowance_ms})`);
check(
  tinyWarm.deadline_receipts.some(
    (receipt) => receipt.kind === "deadline_exceeded" && receipt.reason_code === RUNTIME_BUDGET_OVERRUN_REASON,
  ),
  "a grant made past an exhausted ceiling carries no registered INTERNAL.runtime_budget_overrun receipt",
);
const tinyWarmReport = hardCeilingEnforcementReport({ ledger: tinyWarm, label: "tiny_ceiling_resumed" });
check(tinyWarmReport.status === "ENFORCED", `tiny_ceiling_resumed: ${tinyWarmReport.violations.join(", ")}`);

// E-real-3: THE CEILING IS GENUINELY TERMINAL. With the floor allowance spent,
// the REAL controller's next grants collapse to 1 ms — a hard refusal at every
// spawn boundary. This is what makes the ceiling more than advisory.
const exhausted = clone(tinyWarm);
exhausted.floor_granted_ms = exhausted.floor_allowance_ms;
await fs.writeFile(tinyLedgerPath, `${JSON.stringify(exhausted, null, 2)}\n`);
const grantsBefore = exhausted.stage_allowances.length;
await command("run_user_flow.mjs", tinyArgs);
const tinyExhausted = await readJson(tinyLedgerPath);
const collapsed = tinyExhausted.stage_allowances.slice(grantsBefore);
check(collapsed.length >= 3, "the exhausted-allowance run recorded no new grants to inspect");
check(collapsed.every((entry) => Number(entry.granted_ms) === 1),
  `once the ceiling and the whole floor allowance are spent every grant must collapse to 1 ms: ${JSON.stringify(collapsed.map((e) => e.granted_ms))}`);
check(tinyExhausted.floor_granted_ms === tinyExhausted.floor_allowance_ms,
  "the exhausted floor allowance was silently reissued");
check(hardCeilingEnforcementReport({ ledger: tinyExhausted, label: "tiny_ceiling_exhausted" }).status === "ENFORCED",
  "the exhausted-allowance ledger is not certified as enforced");

// E-mutations: THE TEST MUST FAIL WHEN THE CEILING IS BREACHED.
const mutations = [
  ["floor debt beyond the run's finite allowance", (ledger) => {
    ledger.floor_granted_ms = ledger.floor_allowance_ms + 1;
  }, "floor_debt_exceeds_allowance"],
  ["a grant larger than the envelope allowed", (ledger) => {
    ledger.stage_allowances.push({
      stage: "runaway", requested_ms: 9_000_000, remaining_ms_at_consult: 0, granted_ms: 9_000_000,
    });
  }, "grant_exceeds_envelope"],
  ["a grant of zero, which means 'no timeout' at a spawn", (ledger) => {
    ledger.stage_allowances.push({
      stage: "unbounded", requested_ms: 400, remaining_ms_at_consult: 0, granted_ms: 0,
    });
  }, "grant_zero"],
  ["a ledger ceiling above the single declaration", (ledger) => {
    ledger.hard_deadline_compute_ms = RUNTIME_SLO.end_to_end_ms.hard_ceiling + 1;
  }, "ledger_ceiling_above_declared_ceiling"],
  ["a floor allowance above the declared bound", (ledger) => {
    ledger.floor_allowance_ms = STAGE_FLOOR_TOTAL_ALLOWANCE_MS + 1;
  }, "floor_allowance_above_declared"],
  ["overshoot with the typed disclosure stripped", (ledger) => {
    ledger.deadline_receipts = [];
  }, "undisclosed_overshoot_past_ceiling"],
  ["a grant past the ceiling with no typed overrun receipt", (ledger) => {
    ledger.compute_elapsed_ms = ledger.hard_deadline_compute_ms;
    ledger.deadline_receipts = [];
  }, "untyped_grant_past_ceiling"],
];
for (const [description, mutate, expected] of mutations) {
  const mutated = clone(tinyWarm);
  mutate(mutated);
  const report = hardCeilingEnforcementReport({ ledger: mutated, label: "mutation" });
  check(report.status === "NOT_ENFORCED" && report.violations.some((entry) => entry.startsWith(expected)),
    `a breach was accepted — ${description} (expected ${expected}, got ${JSON.stringify(report.violations)})`);
}
// The enforcement report is itself hash-bound: an ENFORCED stamp cannot be
// pasted over recorded violations.
const forgedEnforcement = clone(hardCeilingEnforcementReport({
  ledger: (() => { const l = clone(tinyWarm); l.floor_granted_ms = l.floor_allowance_ms + 1; return l; })(),
  label: "forged",
}));
forgedEnforcement.status = "ENFORCED";
check(validateHardCeilingEnforcementReport(forgedEnforcement).includes("status"),
  "an ENFORCED verdict pasted over recorded violations validated");

// Every declared refusal must have a producer, and every produced refusal must
// be declared.
check(RUNTIME_SLO_REFUSALS.length === new Set(RUNTIME_SLO_REFUSALS).size, "the refusal vocabulary has duplicates");
check(
  RUNTIME_SLO_REFUSALS.every((refusal) => refusal.startsWith("refused.")),
  "a refusal is not named in the declared vocabulary shape",
);

// ===========================================================================
// PART F — THE SEAL.
// ===========================================================================
const enforcementReports = [
  ...cohortLedgers.map(({ label, ledger }) => hardCeilingEnforcementReport({ ledger, label })),
  tinyColdReport,
  tinyWarmReport,
  hardCeilingEnforcementReport({ ledger: tinyExhausted, label: "tiny_ceiling_exhausted" }),
];
const seal = compileRuntimeSloSeal({ cohortReport, enforcementReports });
check(seal.hard_ceiling_enforced === true, `the seal does not record the ceiling as enforced: ${seal.seal_status}`);
check(seal.superseded_declarations.length === 2, "the seal does not record both superseded declarations");
check(seal.policy_sha256 === PERFORMANCE_POLICY_SHA256, "the seal is not bound to the policy asset it read");
check(
  compileRuntimeSloSeal({ cohortReport, enforcementReports: [] }).seal_status === "UNSEALED_NO_ENFORCEMENT_EVIDENCE",
  "a phase can be sealed with no enforcement evidence at all",
);
check(REQUIRED_COHORTS.join(",") === "COLD,WARM", "the required cohorts are no longer cold and warm");

if (SEAL_DIR) {
  await fs.mkdir(SEAL_DIR, { recursive: true });
  const write = async (name, value) =>
    fs.writeFile(path.join(SEAL_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await write("runtime-slo-declaration.json", {
    schema_version: "excel-inflow-runtime-slo-declaration-receipt/1.0",
    policy_ref: PERFORMANCE_POLICY_REF,
    policy_sha256: PERFORMANCE_POLICY_SHA256,
    declaration: RUNTIME_SLO,
    declaration_errors: validateRuntimeSloDeclaration(),
    enforced_constants: {
      "scripts/lib/runtime_budget_policy.mjs#DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_target":
        DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_target,
      "scripts/lib/runtime_budget_policy.mjs#DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_hard_ceiling":
        DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_hard_ceiling,
      "scripts/lib/run_deadline.mjs#STAGE_FLOOR_TOTAL_ALLOWANCE_MS": STAGE_FLOOR_TOTAL_ALLOWANCE_MS,
    },
  });
  await write("runtime-slo-cohort.json", cohortReport);
  await write("hard-ceiling-enforcement.json", {
    schema_version: "excel-inflow-hard-ceiling-enforcement-cohort/1.0",
    reports: enforcementReports,
    status: enforcementReports.every((report) => report.status === "ENFORCED") ? "ENFORCED" : "NOT_ENFORCED",
  });
  await write("phase6-runtime-slo-seal.json", seal);
}

const status = violations.length === 0 ? "PASS" : "FAIL";
if (violations.length > 0) {
  for (const violation of violations) process.stderr.write(`${violation}\n`);
}
process.stdout.write(`${JSON.stringify({ status, checks })}\n`);
await fs.rm(workspace, { recursive: true, force: true });
process.exit(violations.length === 0 ? 0 : 1);
