#!/usr/bin/env node
/**
 * One model-first controller: raw evidence transaction -> model decisions ->
 * sealed authority resolution -> existing workbook build and delivery.
 *
 * The proven case compiler, economic graph, solver, renderer and validators
 * remain unchanged. This controller replaces host-side stage choreography and
 * emits one typed outcome instead of surfacing internal lane states.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  authorityQualitySummary,
  validatePreBrokerDemandCoverage,
} from "./lib/run_constitution_graph.mjs";
import { executeOptionalBrokerCircuitBreaker } from "./lib/optional_broker_circuit_breaker.mjs";
import { createExperienceTrace, writeExperienceTrace } from "./lib/experience_trace.mjs";
import { compilePerformanceReceipt } from "./lib/performance_receipt.mjs";
import { resolvePythonExecutable, runProcessTree } from "./lib/process_tree.mjs";
import {
  boundedStageTimeout,
  compileRuntimeBudgetReceipt,
  remainingRuntimeMs,
  resolveRuntimeBudgetPolicy,
  validateRuntimeBudgetReceipt,
} from "./lib/runtime_budget_policy.mjs";
import {
  compileProgressEvidence,
  createProgressHeartbeat,
  validateProgressEvidence,
} from "./lib/progress_heartbeat.mjs";
import { resolveActiveSourceIdentity } from "./lib/source_identity.mjs";


const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONTROLLER_VERSION = "excel-inflow-vnext/1.0";
let ACTIVE_RUNTIME_CLOSURE = null;
let ACTIVE_PERFORMANCE = null;
let ACTIVE_EXPERIENCE_TRACE = null;
let ACTIVE_EXPERIENCE_ROOT_SPAN = null;
let ACTIVE_SOURCE_IDENTITY = null;
let ACTIVE_PROGRESS_STARTED_AT = null;
let ACTIVE_PROGRESS_STARTED_EPOCH_MS = null;
let ACTIVE_PROGRESS_ACTIVITY_COUNTER = 0;
let ACTIVE_PROGRESS_EVENTS = [];
let ACTIVE_RUNTIME_BUDGET = null;
let ACTIVE_RUNTIME_BUDGET_EXECUTIONS = [];
const STATE_SCHEMA = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "excel-inflow-vnext-run.schema.json"), "utf8"),
);
const PRE_BROKER_DEMAND_SCHEMA = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "pre-broker-model-demand-v1.schema.json"), "utf8"),
);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    const next = argv[index + 1];
    options[key] = next && !next.startsWith("--") ? argv[++index] : true;
  }
  return options;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonical(value))}\n`;
}

function digestBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(target) {
  return digestBytes(await fs.readFile(target));
}

async function runtimeClosure() {
  const profile = await readJson(path.join(ROOT, "assets", "deployment-profile.json"), "deployment profile");
  const members = [
    ...(profile.script_allowlist ?? []).map((item) => path.join("scripts", item)),
    ...(profile.python_module_allowlist ?? []).map((item) => path.join("scripts", item)),
    ...(profile.asset_allowlist ?? []).map((item) => path.join("assets", item)),
    ...(profile.reference_allowlist ?? []).map((item) => path.join("references", item)),
    "assets/deployment-profile.json",
    "assets/runtime-manifest.json",
    "release-manifest.json",
    "SKILL.md",
    "central-instructions.md",
  ];
  const hashes = {};
  for (const relative of [...new Set(members)].sort()) {
    const target = path.join(ROOT, relative);
    if (await fs.stat(target).then((entry) => entry.isFile()).catch(() => false)) {
      hashes[relative] = await sha256File(target);
    }
  }
  return digestBytes(canonicalJson(hashes));
}

async function readJson(target, label) {
  const value = JSON.parse(await fs.readFile(path.resolve(target), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one JSON object.`);
  }
  return value;
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, canonicalJson(value));
  await fs.rename(temporary, target);
}

async function run(command, args, {
  cwd = ROOT,
  env = process.env,
  timeout = 3_600_000,
  progress = null,
  budgetStage = null,
} = {}) {
  const started = Date.now();
  const remaining = ACTIVE_RUNTIME_BUDGET
    ? remainingRuntimeMs({
      policy: ACTIVE_RUNTIME_BUDGET,
      controllerStartedEpochMs: ACTIVE_PROGRESS_STARTED_EPOCH_MS,
      nowEpochMs: started,
    })
    : Number(timeout);
  const effectiveTimeout = ACTIVE_RUNTIME_BUDGET && budgetStage
    ? boundedStageTimeout({
      policy: ACTIVE_RUNTIME_BUDGET,
      stage: budgetStage,
      requestedMs: timeout,
      controllerStartedEpochMs: ACTIVE_PROGRESS_STARTED_EPOCH_MS,
      nowEpochMs: started,
    })
    : Math.min(Number(timeout), remaining);
  const activityId = progress ? `activity_${String(++ACTIVE_PROGRESS_ACTIVITY_COUNTER).padStart(2, "0")}` : null;
  const heartbeat = progress ? createProgressHeartbeat({
    ...progress,
    intervalMs: ACTIVE_RUNTIME_BUDGET?.budgets_ms?.heartbeat_interval,
    observe: (event) => ACTIVE_PROGRESS_EVENTS.push({
      ...event,
      activity_id: activityId,
      controller_elapsed_ms: Date.now() - ACTIVE_PROGRESS_STARTED_EPOCH_MS,
    }),
  }) : null;
  const spanId = ACTIVE_EXPERIENCE_TRACE?.start(
    `subprocess:${path.basename(command)}`,
    "run_excel_inflow_vnext",
    "excel_inflow_active",
    { parent_span_id: ACTIVE_EXPERIENCE_ROOT_SPAN, coverage_role: "leaf" },
  );
  try {
    const result = await runProcessTree(command, args, { cwd, env, timeout: Math.max(1, effectiveTimeout) });
    if (budgetStage) {
      ACTIVE_RUNTIME_BUDGET_EXECUTIONS.push({
        stage: budgetStage,
        budget_ms: effectiveTimeout,
        duration_ms: Date.now() - started,
        outcome: result.timed_out ? "TIMEOUT" : result.ok ? "PASS" : "FAIL",
        process_tree_termination_verified: result.termination_verified !== false,
        checkpoint_preserved: true,
        evidence_retained: true,
      });
    }
    if (spanId) {
      ACTIVE_EXPERIENCE_TRACE.end(
        spanId,
        result.ok ? "PASS" : "FAIL",
        { timed_out: result.timed_out, termination_verified: result.termination_verified },
      );
    }
    return { ...result, duration_ms: Date.now() - started };
  } catch (error) {
    if (budgetStage) {
      ACTIVE_RUNTIME_BUDGET_EXECUTIONS.push({
        stage: budgetStage,
        budget_ms: effectiveTimeout,
        duration_ms: Date.now() - started,
        outcome: "FAIL",
        process_tree_termination_verified: true,
        checkpoint_preserved: true,
        evidence_retained: true,
      });
    }
    if (spanId) ACTIVE_EXPERIENCE_TRACE.end(spanId, "FAIL", { error: error.message });
    throw error;
  } finally {
    heartbeat?.stop({
      documentsComplete: progress?.documentsTotal ?? 0,
      actionRequired: false,
    });
  }
}

async function attachmentDocumentCount(specTarget) {
  const specPath = path.resolve(String(specTarget));
  const spec = await readJson(specPath, "attachment controller spec");
  let total = 0;
  for (const lane of ["filings", "broker", "dcs"]) {
    const requestValue = spec?.[lane]?.request_path;
    if (!requestValue) continue;
    const requestPath = path.resolve(path.dirname(specPath), String(requestValue));
    const request = await readJson(requestPath, `${lane} request`).catch(() => null);
    const candidates = [request?.documents, request?.sources, request?.pdfs, request?.houses]
      .filter(Array.isArray)
      .map((items) => items.length);
    total += Math.max(1, ...candidates);
  }
  return Math.max(1, total);
}

async function checkpoint(id, status, target = null) {
  return {
    checkpoint_id: id,
    status,
    sha256: target && await fs.stat(target).then((entry) => entry.isFile()).catch(() => false)
      ? await sha256File(target)
      : null,
  };
}

async function finish({ out, runId, status, qualityMode, blockerClass, checkpoints, artifacts, summary }) {
  if (ACTIVE_RUNTIME_BUDGET) {
    const runtimeBudgetReceipt = compileRuntimeBudgetReceipt({
      policy: ACTIVE_RUNTIME_BUDGET,
      startedAt: ACTIVE_PROGRESS_STARTED_AT,
      endedAt: new Date().toISOString(),
      stageExecutions: ACTIVE_RUNTIME_BUDGET_EXECUTIONS,
    });
    const runtimeBudgetErrors = validateRuntimeBudgetReceipt(runtimeBudgetReceipt, ACTIVE_RUNTIME_BUDGET);
    if (runtimeBudgetErrors.length > 0) {
      throw new Error(`Runtime budget evidence failed closed: ${runtimeBudgetErrors.join(", ")}`);
    }
    const runtimeBudgetReceiptPath = path.join(out, "runtime-budget-receipt.json");
    await writeJson(runtimeBudgetReceiptPath, runtimeBudgetReceipt);
    artifacts = { ...artifacts, runtime_budget_receipt: runtimeBudgetReceiptPath };
  }
  if (ACTIVE_PROGRESS_EVENTS.length > 0) {
    const progressEvidence = compileProgressEvidence({
      controllerStartedAt: ACTIVE_PROGRESS_STARTED_AT,
      events: ACTIVE_PROGRESS_EVENTS,
    });
    const progressErrors = validateProgressEvidence(progressEvidence);
    if (progressErrors.length > 0) {
      throw new Error(`Progress evidence failed closed: ${progressErrors.join(", ")}`);
    }
    const progressEvidencePath = path.join(out, "progress-evidence.json");
    await writeJson(progressEvidencePath, progressEvidence);
    artifacts = { ...artifacts, progress_evidence: progressEvidencePath };
  }
  if (ACTIVE_EXPERIENCE_TRACE && ACTIVE_EXPERIENCE_ROOT_SPAN) {
    const traceStatus = status === "PASS_PENDING_MANUAL"
      ? "PASS"
      : ["BLOCKED", "NEEDS_USER_INPUT"].includes(status)
        ? "BLOCKED"
        : "FAIL";
    ACTIVE_EXPERIENCE_TRACE.end(ACTIVE_EXPERIENCE_ROOT_SPAN, traceStatus);
    ACTIVE_EXPERIENCE_ROOT_SPAN = null;
    const experienceTracePath = path.join(out, "experience-trace.json");
    await writeExperienceTrace(experienceTracePath, ACTIVE_EXPERIENCE_TRACE.finish());
    artifacts = { ...artifacts, experience_trace: experienceTracePath };
  }
  if (ACTIVE_PERFORMANCE) {
    ACTIVE_PERFORMANCE.total_duration_ms = Date.now() - ACTIVE_PERFORMANCE.started_epoch_ms;
  }
  const artifactHashes = {};
  for (const [name, target] of Object.entries(artifacts)) {
    if (await fs.stat(target).then((entry) => entry.isFile()).catch(() => false)) {
      artifactHashes[name] = await sha256File(target);
    }
  }
  const state = {
    schema_version: "excel-inflow-vnext-run/1.0",
    controller_version: CONTROLLER_VERSION,
    runtime_closure_sha256: ACTIVE_RUNTIME_CLOSURE,
    run_id: runId,
    status,
    quality_mode: qualityMode,
    blocker_class: blockerClass,
    user_blocking: ["USER_DECISION", "FATAL_SOURCE"].includes(blockerClass),
    checkpoints,
    artifacts,
    artifact_sha256: artifactHashes,
    summary: ACTIVE_PERFORMANCE ? { ...summary, performance: ACTIVE_PERFORMANCE } : summary,
  };
  const errors = validateJsonSchema(state, STATE_SCHEMA);
  if (errors.length > 0) throw new Error(`vNext state failed schema: ${errors[0]}`);
  const statePath = path.join(out, "excel-inflow-vnext-run-state.json");
  await writeJson(statePath, state);
  process.stdout.write(`${JSON.stringify({ ...state, state: statePath }, null, 2)}\n`);
  return state;
}

async function main() {
  ACTIVE_PROGRESS_STARTED_AT = new Date().toISOString();
  ACTIVE_PROGRESS_STARTED_EPOCH_MS = Date.now();
  ACTIVE_PROGRESS_ACTIVITY_COUNTER = 0;
  ACTIVE_PROGRESS_EVENTS = [];
  ACTIVE_RUNTIME_BUDGET_EXECUTIONS = [];
  ACTIVE_PERFORMANCE = {
    schema_version: "excel-inflow-performance/1.0",
    started_at: new Date().toISOString(),
    started_epoch_ms: Date.now(),
    stages: {},
  };
  const options = parseArgs(process.argv.slice(2));
  const runtimeBudgetOverrides = options["runtime-budget"]
    ? await readJson(path.resolve(String(options["runtime-budget"])), "runtime budget overrides")
    : {};
  ACTIVE_RUNTIME_BUDGET = resolveRuntimeBudgetPolicy(runtimeBudgetOverrides.budgets_ms ?? runtimeBudgetOverrides);
  if (options.screen) {
    const screen = await run(process.execPath, [
      path.join(HERE, "run_user_flow.mjs"),
      "--screen",
      String(options.screen),
    ], { timeout: 30_000 });
    if (screen.code !== 0) {
      throw new Error(screen.stderr.trim() || `Unable to render ${options.screen} screen.`);
    }
    process.stdout.write(screen.stdout);
    return;
  }
  const out = path.resolve(String(options.out ?? ""));
  if (!options.out || (!options["attachment-spec"] && !options["evidence-run"])) {
    throw new Error(
      "Usage: run_excel_inflow_vnext.mjs (--attachment-spec <controller-spec.json> | " +
      "--evidence-run <evidence-run.json>) --out <run-folder> [--answers <answers.json>] " +
      "[--attachment-state <state.json>] [--python <python>] [--soffice <path>] " +
      "[--workspace-token <token>] [--runtime-budget <budget-overrides.json>]",
    );
  }
  if (out === ROOT || out.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error("vNext run output must be outside the immutable skill tree.");
  }
  await fs.mkdir(out, { recursive: true });
  ACTIVE_EXPERIENCE_TRACE = createExperienceTrace({ runId: path.basename(out), scope: "vnext_controller" });
  ACTIVE_EXPERIENCE_ROOT_SPAN = ACTIVE_EXPERIENCE_TRACE.start(
    "vnext_controller",
    "run_excel_inflow_vnext",
    "excel_inflow_active",
    { coverage_role: "root" },
  );
  ACTIVE_RUNTIME_CLOSURE = await runtimeClosure();
  ACTIVE_SOURCE_IDENTITY = await resolveActiveSourceIdentity({ skillRoot: ROOT });
  const pythonCommand = await resolvePythonExecutable(
    String(options.python ?? process.env.PYTHON ?? "python3"),
    { cwd: ROOT, env: process.env, timeout: 30_000 },
  );
  const pythonProbe = await run(pythonCommand, [
    "-c",
    "import os, openpyxl; print(os.path.dirname(os.path.dirname(openpyxl.__file__)))",
  ], { timeout: 30_000, budgetStage: "source_acquisition" });
  const pythonSite = pythonProbe.code === 0 ? pythonProbe.stdout.trim() : "";
  const runtimeEnv = {
    ...process.env,
    PYTHON: pythonCommand,
    EXCEL_INFLOW_PYTHON: pythonCommand,
    ...(pythonSite
      ? { PYTHONPATH: [pythonSite, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) }
      : {}),
  };
  const checkpoints = [];
  const artifacts = {};
  let evidencePath;
  let attachmentState = null;

  if (options["attachment-spec"]) {
    const attachmentStarted = Date.now();
    const documentTotal = await attachmentDocumentCount(options["attachment-spec"]);
    const attachmentOut = path.join(out, "evidence");
    const attachmentArgs = [
      path.join(HERE, "run_attachment_evidence_pipeline.py"),
      path.resolve(String(options["attachment-spec"])),
      "--out",
      attachmentOut,
    ];
    const attachmentStatePath = path.join(attachmentOut, "attachment-evidence-run-state.json");
    const brokerCircuitBreaker = await executeOptionalBrokerCircuitBreaker({
      runPrimary: () => run(pythonCommand, attachmentArgs, {
        timeout: ACTIVE_RUNTIME_BUDGET.budgets_ms.end_to_end_hard_ceiling,
        env: runtimeEnv,
        progress: { stage: "evidence review", documentsTotal: documentTotal },
      }),
      readState: () => readJson(
        attachmentStatePath,
        "attachment evidence state",
      ),
      fingerprintState: () => fs.stat(attachmentStatePath)
        .then((entry) => `${entry.mtimeMs}:${entry.size}`)
        .catch(() => null),
      runZeroAuthority: () => run(
        pythonCommand,
        [...attachmentArgs, "--force-zero-broker"],
        {
          timeout: ACTIVE_RUNTIME_BUDGET.budgets_ms.broker_global,
          env: runtimeEnv,
          progress: { stage: "evidence review", documentsTotal: documentTotal },
        },
      ),
    });
    attachmentState = brokerCircuitBreaker.state;
    ACTIVE_PERFORMANCE.stages.evidence_resolution_ms = Date.now() - attachmentStarted;
    if (attachmentState.summary?.performance) {
      ACTIVE_PERFORMANCE.evidence_lanes = attachmentState.summary.performance;
    }
    artifacts.attachment_state = attachmentStatePath;
    checkpoints.push(await checkpoint("raw_evidence", attachmentState.pipeline_status, attachmentStatePath));
    if (attachmentState.pipeline_status !== "PASS") {
      const fatal = attachmentState.blocker_class === "FATAL_SOURCE" || attachmentState.user_blocking === true;
      return finish({
        out,
        runId: attachmentState.run_id ?? "vnext-run",
        status: fatal ? "BLOCKED" : "NEEDS_INTERNAL_WORK",
        qualityMode: fatal ? "FATAL" : "INTERNAL_WORK",
        blockerClass: fatal ? "FATAL_SOURCE" : "INTERNAL_WORK",
        checkpoints,
        artifacts,
        summary: {
          message: fatal
            ? "A fatal raw-source boundary remains."
            : "The controller retains internal work; no user response or re-upload is requested.",
          lane_statuses: Object.fromEntries(Object.entries(attachmentState.lane_states ?? {}).map(([lane, state]) => [lane, state.pipeline_status])),
        },
      });
    }
    evidencePath = attachmentState.artifacts?.evidence_run;
    if (!evidencePath) throw new Error("PASS attachment state has no evidence_run artifact.");
    const brokerIntakeChoicePath = attachmentState.artifacts?.broker_intake_choice;
    if (!brokerIntakeChoicePath) {
      throw new Error("PASS attachment state has no sealed Brokers upload-or-skip choice.");
    }
    artifacts.broker_intake_choice = brokerIntakeChoicePath;
    if (attachmentState.lane_states?.broker && attachmentState.lane_states?.filings) {
      const preBrokerDemandPath = attachmentState.artifacts?.pre_broker_model_demand;
      if (!preBrokerDemandPath) {
        throw new Error("PASS raw evidence omitted the filings-derived pre-broker demand artifact.");
      }
      artifacts.pre_broker_model_demand = preBrokerDemandPath;
      checkpoints.push(await checkpoint("pre_broker_demand", "PASS", preBrokerDemandPath));
    }
  } else {
    evidencePath = path.resolve(String(options["evidence-run"]));
    if (options["attachment-state"]) {
      const attachmentStatePath = path.resolve(String(options["attachment-state"]));
      attachmentState = await readJson(attachmentStatePath, "attachment evidence state");
      artifacts.attachment_state = attachmentStatePath;
    }
    checkpoints.push(await checkpoint("raw_evidence", "SUPPLIED", evidencePath));
  }

  const evidenceRun = await readJson(evidencePath, "evidence run");
  const runId = String(evidenceRun.run_id ?? "vnext-run");
  artifacts.evidence_run = evidencePath;
  const userFlowOut = path.join(out, "model");
  const workspaceToken = String(options["workspace-token"] ?? `vnext:${digestBytes(out).slice(0, 24)}`);
  const firstArgs = [
    path.join(HERE, "run_user_flow.mjs"),
    evidencePath,
    "--out",
    userFlowOut,
    "--workspace-token",
    workspaceToken,
    "--stop-after",
    "decisions",
    "--json",
  ];
  if (options.answers) firstArgs.push("--answers", path.resolve(String(options.answers)));
  if (artifacts.broker_intake_choice) {
    firstArgs.push("--broker-intake-choice", path.resolve(artifacts.broker_intake_choice));
  }
  firstArgs.push("--python", pythonCommand);
  if (options.soffice) firstArgs.push("--soffice", String(options.soffice));
  const firstExecution = await run(process.execPath, firstArgs, {
    timeout: ACTIVE_RUNTIME_BUDGET.budgets_ms.case_compilation_and_ownership,
    budgetStage: "case_compilation_and_ownership",
    env: runtimeEnv,
    progress: {
      stage: "model decisions",
      documentsTotal: attachmentState?.summary?.performance
        ? Object.values(attachmentState.summary.performance.lane_duration_ms ?? {}).filter((value) => Number(value) >= 0).length
        : 1,
      documentsComplete: attachmentState ? Object.keys(attachmentState.lane_states ?? {}).length : 1,
    },
  });
  ACTIVE_PERFORMANCE.stages.model_decisions_ms =
    (ACTIVE_PERFORMANCE.stages.model_decisions_ms ?? 0) +
    Number(firstExecution.duration_ms ?? 0);
  const userFlowResultPath = path.join(userFlowOut, "user-flow-result.json");
  if (
    firstExecution.code !== 0 ||
    !(await fs.stat(userFlowResultPath).then((entry) => entry.isFile()).catch(() => false))
  ) {
    return finish({
      out,
      runId,
      status: "NEEDS_INTERNAL_WORK",
      qualityMode: "INTERNAL_WORK",
      blockerClass: "INTERNAL_WORK",
      checkpoints,
      artifacts,
      summary: {
        message: "The model decision delegate failed before writing a sealed result; no user re-upload is requested.",
        delegate_exit_code: firstExecution.code,
        delegate_stdout: String(firstExecution.stdout ?? "").slice(-4000),
        delegate_stderr: String(firstExecution.stderr ?? "").slice(-4000),
        delegate_timed_out: firstExecution.timed_out,
        delegate_termination_verified: firstExecution.termination_verified,
        delegate_survivor_pids: firstExecution.survivor_pids,
        delegate_error: String(
          firstExecution.stderr || firstExecution.stdout || "missing result artifact",
        ).slice(-2000),
      },
    });
  }
  let userFlowResult = await readJson(userFlowResultPath, "user-flow decision result");
  artifacts.user_flow_result = userFlowResultPath;
  checkpoints.push(await checkpoint("model_decisions", userFlowResult.status, userFlowResultPath));
  if (userFlowResult.status === "ACTION_REQUIRED") {
    return finish({
      out,
      runId,
      status: "ACTION_REQUIRED",
      qualityMode: "INPUT_REQUIRED",
      blockerClass: "USER_DECISION",
      checkpoints,
      artifacts,
      summary: {
        message: "One consolidated set of genuine model decisions remains.",
        question_count: userFlowResult.question_count ?? null,
        carrier: userFlowResult.carrier ?? null,
      },
    });
  }
  if (userFlowResult.status !== "PAUSED" || userFlowResult.stage !== "decisions") {
    const internal = userFlowResult.blocker_class !== "FATAL_SOURCE";
    return finish({
      out,
      runId,
      status: internal ? "NEEDS_INTERNAL_WORK" : "BLOCKED",
      qualityMode: internal ? "INTERNAL_WORK" : "FATAL",
      blockerClass: internal ? "INTERNAL_WORK" : "FATAL_SOURCE",
      checkpoints,
      artifacts,
      summary: {
        message: userFlowResult.message ?? "The existing model controller did not reach the build boundary.",
        outcome: userFlowResult.outcome ?? null,
      },
    });
  }

  const decisionsRoot = path.join(userFlowOut, "stages", "decisions");
  const forecastPlanPath = path.join(decisionsRoot, "forecast-plan.json");
  const demandGraphPath = path.join(decisionsRoot, "model-demand-graph.json");
  const authorityContractPath = path.join(decisionsRoot, "selected-authority-contract.json");
  const runGraphPath = path.join(decisionsRoot, "run-constitution-graph.json");
  const authorityContract = await readJson(
    authorityContractPath,
    "selected authority contract",
  );
  const modelDemandGraph = await readJson(demandGraphPath, "model demand graph");
  if (artifacts.pre_broker_model_demand) {
    const preBrokerDemand = await readJson(
      artifacts.pre_broker_model_demand,
      "pre-broker model demand",
    );
    const schemaErrors = validateJsonSchema(preBrokerDemand, PRE_BROKER_DEMAND_SCHEMA);
    const coverage = validatePreBrokerDemandCoverage(preBrokerDemand, modelDemandGraph);
    if (schemaErrors.length > 0 || !coverage.valid) {
      return finish({
        out,
        runId,
        status: "NEEDS_INTERNAL_WORK",
        qualityMode: "INTERNAL_WORK",
        blockerClass: "INTERNAL_WORK",
        checkpoints: [
          ...checkpoints,
          await checkpoint("pre_broker_demand_binding", "BLOCKED", demandGraphPath),
        ],
        artifacts,
        summary: {
          message: "The filings-derived demand graph did not survive intact into final authority resolution.",
          violations: [...schemaErrors, ...coverage.errors],
        },
      });
    }
    checkpoints.push(await checkpoint("pre_broker_demand_binding", "PASS", demandGraphPath));
  }
  const runGraph = await readJson(runGraphPath, "run constitution graph");
  const qualitySummary = authorityQualitySummary(authorityContract);
  artifacts.forecast_plan = forecastPlanPath;
  artifacts.model_demand_graph = demandGraphPath;
  artifacts.selected_authority_contract = authorityContractPath;
  artifacts.run_constitution_graph = runGraphPath;
  checkpoints.push(await checkpoint("authority_resolution", "PASS", runGraphPath));

  const resumeArgs = [
    path.join(HERE, "run_user_flow.mjs"),
    "--carrier",
    path.resolve(userFlowResult.carrier),
    "--out",
    userFlowOut,
    "--workspace-token",
    workspaceToken,
    "--json",
  ];
  resumeArgs.push("--python", pythonCommand);
  if (options.soffice) resumeArgs.push("--soffice", String(options.soffice));
  const pausedResultSha256 = await sha256File(userFlowResultPath);
  const resumeExecution = await run(process.execPath, resumeArgs, {
    timeout: Math.min(
      ACTIVE_RUNTIME_BUDGET.budgets_ms.end_to_end_hard_ceiling,
      ACTIVE_RUNTIME_BUDGET.budgets_ms.solver +
        ACTIVE_RUNTIME_BUDGET.budgets_ms.workbook_build +
        ACTIVE_RUNTIME_BUDGET.budgets_ms.recalculation +
        ACTIVE_RUNTIME_BUDGET.budgets_ms.validation,
    ),
    env: runtimeEnv,
    progress: {
      stage: "workbook build and checks",
      documentsTotal: Math.max(1, Object.keys(attachmentState?.lane_states ?? {}).length),
      documentsComplete: Math.max(1, Object.keys(attachmentState?.lane_states ?? {}).length),
    },
  });
  ACTIVE_PERFORMANCE.stages.build_and_delivery_ms = resumeExecution.duration_ms;
  const resumedResultSha256 = await fs.stat(userFlowResultPath)
    .then((entry) => entry.isFile() ? sha256File(userFlowResultPath) : null)
    .catch(() => null);
  if (
    resumeExecution.code !== 0 ||
    !resumedResultSha256 ||
    resumedResultSha256 === pausedResultSha256
  ) {
    return finish({
      out,
      runId,
      status: "NEEDS_INTERNAL_WORK",
      qualityMode: "INTERNAL_WORK",
      blockerClass: "INTERNAL_WORK",
      checkpoints: [
        ...checkpoints,
        await checkpoint("build_and_delivery", "BLOCKED", userFlowResultPath),
      ],
      artifacts,
      summary: {
        message: "The build delegate failed before writing a fresh sealed delivery result; no user re-upload is requested.",
        delegate_exit_code: resumeExecution.code,
        stale_result_rejected: resumedResultSha256 === pausedResultSha256,
        delegate_stdout: String(resumeExecution.stdout ?? "").slice(-4000),
        delegate_stderr: String(resumeExecution.stderr ?? "").slice(-4000),
        delegate_timed_out: resumeExecution.timed_out,
        delegate_termination_verified: resumeExecution.termination_verified,
        delegate_survivor_pids: resumeExecution.survivor_pids,
        delegate_error: String(
          resumeExecution.stderr || resumeExecution.stdout || "missing fresh result artifact",
        ).slice(-2000),
      },
    });
  }
  userFlowResult = await readJson(userFlowResultPath, "user-flow delivery result");
  checkpoints.push(await checkpoint("build_and_delivery", userFlowResult.status, userFlowResultPath));
  if (userFlowResult.status !== "PASS_PENDING_MANUAL") {
    return finish({
      out,
      runId,
      status: userFlowResult.blocker_class === "FATAL_SOURCE" ? "BLOCKED" : "NEEDS_INTERNAL_WORK",
      qualityMode: userFlowResult.blocker_class === "FATAL_SOURCE" ? "FATAL" : "INTERNAL_WORK",
      blockerClass: userFlowResult.blocker_class === "FATAL_SOURCE" ? "FATAL_SOURCE" : "INTERNAL_WORK",
      checkpoints,
      artifacts,
      summary: {
        message: userFlowResult.message ?? "Workbook build or delivery validation did not close.",
        outcome: userFlowResult.outcome ?? null,
      },
    });
  }
  artifacts.delivery_file = userFlowResult.delivery_file;
  artifacts.live_delivery_attestation = userFlowResult.live_delivery_attestation;
  const attachmentStatePath = artifacts.attachment_state ?? null;
  const buildResultPath = path.join(userFlowOut, "stages", "build_checks", "build-result.json");
  const buildResult = await readJson(buildResultPath, "Stage-4 build result");
  const performanceReceiptPath = path.join(out, "performance-receipt.json");
  const performanceReceipt = compilePerformanceReceipt({
    runId,
    sourceCommit: ACTIVE_SOURCE_IDENTITY?.source_commit,
    sourceTree: ACTIVE_SOURCE_IDENTITY?.source_tree,
    runtimeClosureSha256: ACTIVE_SOURCE_IDENTITY?.runtime_code_closure_sha256,
    attachmentStateSha256: attachmentStatePath ? await sha256File(attachmentStatePath) : null,
    buildResultSha256: await sha256File(buildResultPath),
    attachmentPerformance: attachmentState?.summary?.performance ?? {},
    checkpointTimings: buildResult?.checkpointing?.timings_ms ?? {},
    totalDurationMs: Date.now() - ACTIVE_PERFORMANCE.started_epoch_ms,
  });
  await writeJson(performanceReceiptPath, performanceReceipt);
  artifacts.performance_receipt = performanceReceiptPath;
  artifacts.build_result = buildResultPath;
  return finish({
    out,
    runId,
    status: "PASS_PENDING_MANUAL",
    qualityMode: authorityContract.quality_mode,
    blockerClass: null,
    checkpoints,
    artifacts,
    summary: {
      message: "The model was built and independently validated; native Excel review remains the declared manual gate.",
      delivery_file: userFlowResult.delivery_file,
      workbook_sha256: userFlowResult.delivery_file_sha256,
      quality_receipt_sha256: runGraph.graph_sha256,
      quarantined_evidence_count: qualitySummary.quarantined_evidence_count,
      fallback_count: qualitySummary.fallback_count,
      total_violations: userFlowResult.total_violations,
    },
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
