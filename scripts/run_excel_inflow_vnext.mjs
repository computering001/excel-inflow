#!/usr/bin/env node
/**
 * Private model-first controller. Public invocations must enter through
 * run_excel_inflow_bootstrap.mjs, which verifies compiled-package custody
 * before this module and its transitive imports are instantiated.
 *
 * Raw evidence transaction -> model decisions ->
 * sealed authority resolution -> existing workbook build and delivery.
 *
 * The proven case compiler, economic graph, solver, renderer and validators
 * remain unchanged. This controller replaces host-side stage choreography and
 * emits one typed outcome instead of surfacing internal lane states.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  authorityQualitySummary,
  validatePreBrokerDemandCoverage,
} from "./lib/run_constitution_graph.mjs";
import {
  assertBreakerReceiptCarried,
  executeOptionalBrokerCircuitBreaker,
  validateBrokerBreakerReceipt,
} from "./lib/optional_broker_circuit_breaker.mjs";
import { laneBudgetCaps, loadLaneResourcePolicy } from "./lib/lane_resource_policy.mjs";
import { createExperienceTrace, writeExperienceTrace } from "./lib/experience_trace.mjs";
import { compilePerformanceReceipt, validatePerformanceReceipt } from "./lib/performance_receipt.mjs";
import { cancelProcessTreePids, runProcessTree } from "./lib/process_tree.mjs";
import {
  boundedStageTimeout,
  compileOwnershipPreflightControllerAction,
  compileRuntimeBudgetReceipt,
  remainingRuntimeMs,
  resolveRuntimeBudgetPolicy,
  validateRuntimeBudgetReceipt,
} from "./lib/runtime_budget_policy.mjs";
import {
  RUN_DEADLINE_ENV,
  STAGE_FLOOR_MS,
  beginComputeSpan,
  boundedOuterTimeoutMs,
  closeRunDeadline,
  endComputeSpan,
  openRunDeadline,
  remainingComputeMs,
  resolveRunDeadlinePath,
} from "./lib/run_deadline.mjs";
import {
  compileProgressEvidence,
  createProgressHeartbeat,
  validateProgressEvidence,
} from "./lib/progress_heartbeat.mjs";
import { resolveActiveSourceIdentity } from "./lib/source_identity.mjs";
import { deriveRuntimeMode } from "./lib/runtime_mode.mjs";
import {
  consumeScreenSession,
  issueScreenSession,
} from "./lib/screen_session.mjs";
import {
  COMPANY_SCREEN_SESSION_CONTRACT_SHA256,
} from "./lib/flow_screens.mjs";
import { classifySupport } from "./lib/support_envelope.mjs";
import { assertRunRootOutsideSkill } from "./lib/runtime_isolation.mjs";
import {
  assertRuntimeDoctorSatisfied,
  compileInstalledCapabilityReceipt,
  runRuntimeDoctor,
  writeInstalledCapabilityArtifactSet,
} from "./lib/runtime_doctor.mjs";
import {
  consumeControllerHandoff,
  createControllerHandoff,
} from "./lib/controller_handoff.mjs";


const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONTROLLER_FILE = fileURLToPath(import.meta.url);
const PUBLIC_BOOTSTRAP_FILE = path.join(HERE, "run_excel_inflow_bootstrap.mjs");
const USER_FLOW_FILE = path.join(HERE, "run_user_flow.mjs");
const CONTROLLER_VERSION = "excel-inflow-vnext/1.0";
let ACTIVE_RUNTIME_CLOSURE = null;
let ACTIVE_PERFORMANCE = null;
let ACTIVE_EXPERIENCE_TRACE = null;
let ACTIVE_EXPERIENCE_ROOT_SPAN = null;
let ACTIVE_SOURCE_IDENTITY = null;
let ACTIVE_PROGRESS_STARTED_AT = null;
let ACTIVE_PROGRESS_STARTED_EPOCH_MS = null;
let ACTIVE_PROGRESS_EVENTS = [];
let ACTIVE_PROGRESS_HEARTBEAT = null;
let ACTIVE_RUNTIME_BUDGET = null;
let ACTIVE_RUNTIME_BUDGET_EXECUTIONS = [];
// P6.1: THE run clock. Persisted in the run directory and shared with every
// delegate, so a new invocation, a new turn or a retry cannot restore budget
// that was already spent. It replaces the process-start origin that silently
// handed each invocation a fresh 25-minute ceiling.
let ACTIVE_RUN_DEADLINE = null;
let ACTIVE_CONTROLLER_SPAN = null;

/** Compute already spent by this RUN, or null before the clock is open. */
function consumedRunComputeMs() {
  return ACTIVE_RUN_DEADLINE ? ACTIVE_RUN_DEADLINE.ledger.compute_elapsed_ms : null;
}
const STATE_SCHEMA = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "excel-inflow-vnext-run.schema.json"), "utf8"),
);
// The support-envelope contract governing this runtime (P0.4): identity is
// bound by digest so every run receipt names the exact envelope version.
const { SUPPORT_ENVELOPE_IDENTITY, SUPPORT_ENVELOPE_CONTRACT } = await (async () => {
  const contractPath = path.join(ROOT, "assets", "support-envelope-v377.json");
  const bytes = await fs.readFile(contractPath);
  const contract = JSON.parse(bytes.toString("utf8"));
  return {
    SUPPORT_ENVELOPE_CONTRACT: contract,
    SUPPORT_ENVELOPE_IDENTITY: {
      version: contract.envelope_version,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
})();
const PRE_BROKER_DEMAND_SCHEMA = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "pre-broker-model-demand-v1.schema.json"), "utf8"),
);
const RUNTIME_DOCTOR_SCHEMA = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "runtime-doctor-report-v1.schema.json"), "utf8"),
);
const INSTALLED_CAPABILITY_SCHEMA = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "installed-capability-receipt-v1.3.schema.json"), "utf8"),
);
const HOST_PREFLIGHT_POINTER_SCHEMA = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "host-preflight-pointer-v1.schema.json"), "utf8"),
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

async function runMandatoryHostPreflight({
  runRoot,
  receiptPath,
  python = null,
  soffice = null,
  diskSpacePolicyPath = null,
  diskSpacePolicySha256 = null,
  minFreeBytes = null,
  installStateRoot = null,
}) {
  const report = await runRuntimeDoctor({
    skillRoot: ROOT,
    env: process.env,
    lanes: ["evidence", "workbook"],
    runRoot,
    python,
    soffice,
    diskSpacePolicyPath,
    diskSpacePolicySha256,
    minFreeBytes,
    installStateRoot,
  });
  const reportErrors = validateJsonSchema(report, RUNTIME_DOCTOR_SCHEMA);
  if (reportErrors.length > 0) {
    throw new Error(`Runtime doctor emitted an invalid report: ${reportErrors.join("; ")}`);
  }
  const receipt = compileInstalledCapabilityReceipt(report);
  const receiptErrors = validateJsonSchema(receipt, INSTALLED_CAPABILITY_SCHEMA);
  if (receiptErrors.length > 0) {
    throw new Error(`Installed capability receipt is invalid: ${receiptErrors.join("; ")}`);
  }
  const artifactSet = await writeInstalledCapabilityArtifactSet({
    artifactDirectory: path.dirname(receiptPath),
    report,
  });
  const pointerErrors = validateJsonSchema(artifactSet.pointer, HOST_PREFLIGHT_POINTER_SCHEMA);
  if (pointerErrors.length > 0) {
    throw new Error(`Host-preflight pointer is invalid: ${pointerErrors.join("; ")}`);
  }
  assertRuntimeDoctorSatisfied(report);
  const pythonExecutable = report.checks.find(
    (entry) => entry.precondition_id === "python_interpreter_custody",
  )?.detail?.resolved_executable;
  if (!path.isAbsolute(String(pythonExecutable ?? ""))) {
    throw new Error("Runtime doctor passed without binding one absolute Python executable.");
  }
  const sofficeExecutable = report.checks.find(
    (entry) => entry.precondition_id === "soffice_available",
  )?.detail?.resolved_executable;
  if (!path.isAbsolute(String(sofficeExecutable ?? ""))) {
    throw new Error("Runtime doctor passed without binding one absolute soffice executable.");
  }
  return {
    report,
    reportPath: artifactSet.reportPath,
    receipt,
    receiptPath: artifactSet.receiptPath,
    preflightPointerPath: artifactSet.pointerPath,
    pythonExecutable,
    sofficeExecutable,
  };
}

function requiredScreenSessionInputs(options) {
  const receiptPath = typeof options["screen-session-receipt"] === "string"
    ? path.resolve(String(options["screen-session-receipt"]))
    : null;
  const sessionId = typeof options["screen-session-id"] === "string"
    ? String(options["screen-session-id"])
    : null;
  const sessionSecret = typeof options["screen-session-secret"] === "string"
    ? String(options["screen-session-secret"])
    : null;
  if (!receiptPath || !sessionId || !sessionSecret) {
    throw new Error(
      "Company and product routes require --screen-session-receipt, " +
      "--screen-session-id and --screen-session-secret from the same explicit session.",
    );
  }
  return Object.freeze({
    receiptPath,
    sessionRoot: path.dirname(receiptPath),
    sessionId,
    sessionSecret,
  });
}

function screenSessionExpected(runtimeMode) {
  return Object.freeze({
    runtime_mode: runtimeMode.runtime_mode,
    source_commit: runtimeMode.source_identity_overrides.source_commit,
    source_tree: runtimeMode.source_identity_overrides.source_tree,
    runtime_closure_sha256:
      runtimeMode.source_identity_overrides.runtime_code_closure_sha256,
    package_inventory_sha256:
      runtimeMode.source_identity_overrides.complete_package_inventory_sha256,
    installation_identity:
      runtimeMode.source_identity_overrides.installation_identity,
    active_pointer_sha256:
      runtimeMode.installed_placement.active_pointer_sha256,
  });
}

async function deriveModeFromPreflight(preflight) {
  return deriveRuntimeMode({
    skillRoot: ROOT,
    installStateRoot: process.env.EXCEL_INFLOW_INSTALL_STATE_ROOT ?? null,
    capabilityReceipt: preflight.receipt,
    capabilityReceiptSha256: preflight.receipt.receipt_sha256,
  });
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
  preconsultedRunAllowance = false,
} = {}) {
  const started = Date.now();
  // The remaining budget comes from the PERSISTED run clock, not from this
  // process's start: a resumed or retried invocation inherits what earlier
  // invocations already spent instead of restoring the whole ceiling.
  // Before the clock is open (only the screen renderer runs that early) the
  // caller's own explicit timeout is the bound. There is deliberately no
  // process-start fallback: that fallback WAS the reset.
  const consumedComputeMs = consumedRunComputeMs();
  const clockOpen = ACTIVE_RUNTIME_BUDGET !== null && consumedComputeMs !== null;
  const remaining = clockOpen
    ? remainingRuntimeMs({
      policy: ACTIVE_RUNTIME_BUDGET,
      consumedComputeMs,
      nowEpochMs: started,
    })
    : Number(timeout);
  const effectiveTimeout = preconsultedRunAllowance
    ? Number(timeout)
    : clockOpen && budgetStage
    ? boundedStageTimeout({
      policy: ACTIVE_RUNTIME_BUDGET,
      stage: budgetStage,
      requestedMs: timeout,
      consumedComputeMs,
      nowEpochMs: started,
    })
    : Math.min(Number(timeout), remaining);
  // Every subprocess is measured against the one clock. A delegate that shares
  // the ledger charges itself; the credit inside endComputeSpan means this
  // parent span only ever adds the part nobody else billed.
  const clockSpan = ACTIVE_RUN_DEADLINE
    ? beginComputeSpan(ACTIVE_RUN_DEADLINE, `subprocess:${path.basename(command)}`)
    : null;
  if (progress) ACTIVE_PROGRESS_HEARTBEAT?.update({ ...progress, actionRequired: false });
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
    if (clockSpan && ACTIVE_RUN_DEADLINE) {
      await endComputeSpan(ACTIVE_RUN_DEADLINE, clockSpan, {
        stage: budgetStage,
        allowanceMs: budgetStage ? effectiveTimeout : null,
      });
    }
    if (progress) ACTIVE_PROGRESS_HEARTBEAT?.update({
      stage: progress.stage,
      documentsComplete: progress.documentsTotal ?? 0,
      actionRequired: false,
    });
  }
}

async function runUserFlow(childArgs, options = {}) {
  const handoff = await createControllerHandoff({
    packageRoot: ROOT,
    parentController: CONTROLLER_FILE,
    childController: USER_FLOW_FILE,
    childArgs,
  });
  try {
    return await run(process.execPath, [USER_FLOW_FILE, ...childArgs], {
      ...options,
      env: { ...(options.env ?? process.env), ...handoff.env },
    });
  } finally {
    await handoff.cleanup();
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

function terminalCheckpointProjection(events) {
  const latest = new Map();
  for (const event of events) latest.set(event.checkpoint_id, event);
  return [...latest.values()];
}

async function finish({ out, runId, status, qualityMode, blockerClass, checkpoints, artifacts, summary }) {
  ACTIVE_PROGRESS_HEARTBEAT?.stop({ actionRequired: false });
  ACTIVE_PROGRESS_HEARTBEAT = null;
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
    schema_version: "excel-inflow-vnext-run/1.1",
    controller_version: CONTROLLER_VERSION,
    runtime_closure_sha256: ACTIVE_RUNTIME_CLOSURE,
    // Which support-envelope contract governed this run (P0.4). Metadata
    // only: classification wiring into intake preflight is Phase 2 work.
    support_envelope: SUPPORT_ENVELOPE_IDENTITY,
    run_id: runId,
    status,
    quality_mode: qualityMode,
    blocker_class: blockerClass,
    user_blocking: ["USER_DECISION", "FATAL_SOURCE"].includes(blockerClass),
    checkpoints: terminalCheckpointProjection(checkpoints),
    checkpoint_events: checkpoints,
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
  ACTIVE_PROGRESS_EVENTS = [];
  ACTIVE_RUNTIME_BUDGET_EXECUTIONS = [];
  ACTIVE_PERFORMANCE = {
    schema_version: "excel-inflow-performance/1.0",
    started_at: new Date().toISOString(),
    started_epoch_ms: Date.now(),
    stages: {},
  };
  const rawArgs = process.argv.slice(2);
  const options = parseArgs(rawArgs);
  if (options["controller-diagnostic"] === true) {
    process.stdout.write(`${JSON.stringify({
      schema_version: "excel-inflow-private-controller-diagnostic/1.0",
      controller: "run_excel_inflow_vnext",
      status: "PASS",
      product_route_executed: false,
    })}\n`);
    return;
  }
  await consumeControllerHandoff({
    packageRoot: ROOT,
    parentController: PUBLIC_BOOTSTRAP_FILE,
    childController: CONTROLLER_FILE,
    childArgs: rawArgs,
  });
  const runtimeBudgetOverrides = options["runtime-budget"]
    ? await readJson(path.resolve(String(options["runtime-budget"])), "runtime budget overrides")
    : {};
  ACTIVE_RUNTIME_BUDGET = resolveRuntimeBudgetPolicy(runtimeBudgetOverrides.budgets_ms ?? runtimeBudgetOverrides);
  if (options.screen) {
    if (String(options.screen) === "company") {
      const session = requiredScreenSessionInputs(options);
      await assertRunRootOutsideSkill({ skillRoot: ROOT, runRoot: session.sessionRoot });
      await fs.mkdir(session.sessionRoot, { recursive: true });
      const screenCapabilityRoot = await fs.mkdtemp(
        path.join(session.sessionRoot, "screen-preflight-"),
      );
      const preflight = await runMandatoryHostPreflight({
        runRoot: path.join(screenCapabilityRoot, "prospective-run"),
        receiptPath: path.join(screenCapabilityRoot, "installed-capability-receipt.json"),
        python: String(
          options.python ?? process.env.EXCEL_INFLOW_PYTHON ?? process.env.PYTHON ?? "python3",
        ),
        soffice: options.soffice ? String(options.soffice) : null,
        diskSpacePolicyPath: options["disk-space-policy"] ? String(options["disk-space-policy"]) : null,
        diskSpacePolicySha256: options["disk-space-policy-sha256"] ? String(options["disk-space-policy-sha256"]) : null,
        minFreeBytes: options["min-free-bytes"] ? Number(options["min-free-bytes"]) : null,
        installStateRoot: process.env.EXCEL_INFLOW_INSTALL_STATE_ROOT ?? null,
      });
      const runtimeMode = await deriveModeFromPreflight(preflight);
      const issued = await issueScreenSession({
        skillRoot: ROOT,
        sessionRoot: session.sessionRoot,
        receiptPath: session.receiptPath,
        sessionId: session.sessionId,
        sessionSecret: session.sessionSecret,
        runtimeMode: runtimeMode.runtime_mode,
        sourceCommit: runtimeMode.source_identity_overrides.source_commit,
        sourceTree: runtimeMode.source_identity_overrides.source_tree,
        runtimeClosureSha256:
          runtimeMode.source_identity_overrides.runtime_code_closure_sha256,
        packageInventorySha256:
          runtimeMode.source_identity_overrides.complete_package_inventory_sha256,
        installationIdentity:
          runtimeMode.source_identity_overrides.installation_identity,
        activePointerSha256:
          runtimeMode.installed_placement.active_pointer_sha256,
        capabilityReceiptSha256: await sha256File(preflight.receiptPath),
        runtimeDoctorReportSha256: await sha256File(preflight.reportPath),
        screenContractSha256: COMPANY_SCREEN_SESSION_CONTRACT_SHA256,
      });
      const screenArgs = [
        "--screen",
        String(options.screen),
        "--host-capability-receipt",
        preflight.receiptPath,
        "--runtime-doctor-report",
        preflight.reportPath,
        "--screen-session-receipt",
        issued.receiptPath,
        "--screen-session-id",
        session.sessionId,
        "--screen-session-secret",
        session.sessionSecret,
      ];
      const screen = await runUserFlow(screenArgs, {
        timeout: 30_000,
      });
      if (screen.code !== 0) {
        throw new Error(screen.stderr.trim() || `Unable to render ${options.screen} screen.`);
      }
      process.stdout.write(screen.stdout);
      return;
    }
    const screen = await runUserFlow([
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
  await assertRunRootOutsideSkill({ skillRoot: ROOT, runRoot: out });
  const screenSession = requiredScreenSessionInputs(options);
  // Open THE clock before the mandatory host probe or any model work is
  // spawned. It lives in the run directory,
  // so a second invocation of this controller against the same run inherits
  // what the first one spent instead of starting the ceiling again.
  ACTIVE_RUN_DEADLINE = await openRunDeadline({
    runDir: out,
    ledgerPath: process.env[RUN_DEADLINE_ENV] ?? null,
    budgets: ACTIVE_RUNTIME_BUDGET.budgets_ms,
    identity: {
      controllerVersion: CONTROLLER_VERSION,
      policyDigest: ACTIVE_RUNTIME_BUDGET.policy_sha256,
      invocationLabel: "run_excel_inflow_vnext",
    },
  });
  ACTIVE_CONTROLLER_SPAN = beginComputeSpan(ACTIVE_RUN_DEADLINE, "vnext_controller_overhead");
  ACTIVE_PROGRESS_HEARTBEAT = createProgressHeartbeat({
    stage: "controller preflight",
    documentsTotal: 1,
    intervalMs: ACTIVE_RUNTIME_BUDGET.budgets_ms.heartbeat_interval,
    observe: (event) => ACTIVE_PROGRESS_EVENTS.push({
      ...event,
      activity_id: "controller_run",
      controller_elapsed_ms: Date.now() - ACTIVE_PROGRESS_STARTED_EPOCH_MS,
    }),
  });
  ACTIVE_EXPERIENCE_TRACE = createExperienceTrace({ runId: path.basename(out), scope: "controller_process" });
  ACTIVE_EXPERIENCE_ROOT_SPAN = ACTIVE_EXPERIENCE_TRACE.start(
    "vnext_controller",
    "run_excel_inflow_vnext",
    "excel_inflow_active",
    { coverage_role: "root" },
  );
  const hostPreflightStarted = Date.now();
  const hostPreflight = await runMandatoryHostPreflight({
    runRoot: out,
    receiptPath: path.join(out, "installed-capability-receipt.json"),
    python: String(
      options.python ?? process.env.EXCEL_INFLOW_PYTHON ?? process.env.PYTHON ?? "python3",
    ),
    soffice: options.soffice ? String(options.soffice) : null,
    diskSpacePolicyPath: options["disk-space-policy"] ? String(options["disk-space-policy"]) : null,
    diskSpacePolicySha256: options["disk-space-policy-sha256"] ? String(options["disk-space-policy-sha256"]) : null,
    minFreeBytes: options["min-free-bytes"] ? Number(options["min-free-bytes"]) : null,
    installStateRoot: process.env.EXCEL_INFLOW_INSTALL_STATE_ROOT ?? null,
  });
  ACTIVE_PERFORMANCE.stages.host_preflight_ms = Math.max(1, Date.now() - hostPreflightStarted);
  ACTIVE_RUNTIME_CLOSURE = await runtimeClosure();
  const activeRuntimeMode = await deriveModeFromPreflight(hostPreflight);
  await consumeScreenSession({
    skillRoot: ROOT,
    sessionRoot: screenSession.sessionRoot,
    receiptPath: screenSession.receiptPath,
    sessionId: screenSession.sessionId,
    sessionSecret: screenSession.sessionSecret,
    expected: screenSessionExpected(activeRuntimeMode),
    consumerRunId: `vnext-${digestBytes(out).slice(0, 24)}`,
  });
  ACTIVE_SOURCE_IDENTITY = await resolveActiveSourceIdentity({
    skillRoot: ROOT,
    overrides: activeRuntimeMode.source_identity_overrides,
  });
  const pythonCommand = hostPreflight.pythonExecutable;
  const sofficeCommand = hostPreflight.sofficeExecutable;
  const pythonProbe = await run(pythonCommand, [
    "-c",
    "import os, openpyxl; print(os.path.dirname(os.path.dirname(openpyxl.__file__)))",
  ], { timeout: 30_000 });
  const pythonSite = pythonProbe.code === 0 ? pythonProbe.stdout.trim() : "";
  const runtimeEnv = {
    ...process.env,
    EXCEL_INFLOW_NODE: process.execPath,
    PYTHON: pythonCommand,
    EXCEL_INFLOW_PYTHON: pythonCommand,
    PYTHONDONTWRITEBYTECODE: "1",
    SOFFICE_BIN: sofficeCommand,
    // Every delegate charges the SAME ledger file. This is what makes the
    // delegate's stage clock and this controller's clock one clock rather than
    // two, and it is why a paused-then-resumed run cannot double its ceiling.
    [RUN_DEADLINE_ENV]: ACTIVE_RUN_DEADLINE.path,
    ...(pythonSite
      ? { PYTHONPATH: [pythonSite, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) }
      : {}),
  };
  const checkpoints = [];
  const artifacts = {};
  artifacts.runtime_doctor_report = hostPreflight.reportPath;
  artifacts.installed_capability_receipt = hostPreflight.receiptPath;
  artifacts.run_deadline = ACTIVE_RUN_DEADLINE.path;
  const runtimeBudgetPolicyPath = path.join(out, "runtime-budget-policy.json");
  await writeJson(runtimeBudgetPolicyPath, ACTIVE_RUNTIME_BUDGET);
  artifacts.runtime_budget_policy = runtimeBudgetPolicyPath;
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
    const brokerBreakerReceiptPath = path.join(
      out,
      "optional-broker-breaker-receipt.json",
    );
    const priorBrokerBreakerReceipt = await readJson(
      brokerBreakerReceiptPath,
      "prior optional broker breaker receipt",
    ).catch(() => null);
    const usablePriorBrokerBreakerReceipt = priorBrokerBreakerReceipt
      && validateBrokerBreakerReceipt(priorBrokerBreakerReceipt).length === 0
      ? priorBrokerBreakerReceipt
      : null;
    const remainingRunBudgetMs = remainingComputeMs(ACTIVE_RUN_DEADLINE);
    const brokerBudgetSliceMs = laneBudgetCaps({
      policy: loadLaneResourcePolicy(),
      remainingComputeMs: remainingRunBudgetMs,
    }).optional_cap_ms ?? ACTIVE_RUNTIME_BUDGET.budgets_ms.broker_global;
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
      runZeroAuthority: async () => {
        // This is deterministic state closure over preserved broker custody,
        // not another broker-processing attempt. Consult the persisted run
        // clock for one small closure allowance and bypass run()'s second
        // remaining-compute clamp only because that exact allowance is already
        // ledger-recorded here.
        const closureAllowanceMs = await boundedOuterTimeoutMs(ACTIVE_RUN_DEADLINE, {
          stage: "optional_broker_zero_authority_close",
          requestedMs: STAGE_FLOOR_MS,
          floorMs: STAGE_FLOOR_MS,
        });
        return run(
          pythonCommand,
          [...attachmentArgs, "--force-zero-broker"],
          {
            timeout: closureAllowanceMs,
            env: runtimeEnv,
            progress: { stage: "evidence review", documentsTotal: documentTotal },
            preconsultedRunAllowance: true,
          },
        );
      },
      remainingBudgetMs: remainingRunBudgetMs,
      budgetSliceMs: brokerBudgetSliceMs,
      priorReceipt: usablePriorBrokerBreakerReceipt,
    });
    const brokerBreakerReceipt = assertBreakerReceiptCarried(brokerCircuitBreaker);
    await writeJson(brokerBreakerReceiptPath, brokerBreakerReceipt);
    artifacts.optional_broker_breaker_receipt = brokerBreakerReceiptPath;
    checkpoints.push(await checkpoint(
      "optional_broker_circuit_breaker",
      brokerCircuitBreaker.circuit_breaker_used ? "PASS_DEGRADED" : "PASS",
      brokerBreakerReceiptPath,
    ));
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
    const structuralPreflightPath =
      attachmentState.artifacts?.structural_ownership_preflight;
    if (!structuralPreflightPath) {
      throw new Error(
        "PASS raw evidence omitted the pre-descendant structural ownership receipt.",
      );
    }
    const structuralPreflight = await readJson(
      structuralPreflightPath,
      "structural ownership preflight",
    );
    const structuralArtifactHash = await sha256File(structuralPreflightPath);
    if (
      structuralPreflight.checkpoint !== "A_STRUCTURAL" ||
      structuralPreflight.status !== "PASS" ||
      structuralPreflight.controller_signal?.action !== "continue" ||
      attachmentState.artifact_sha256?.structural_ownership_preflight !==
        structuralArtifactHash
    ) {
      throw new Error(
        "PASS raw evidence carries a stale, tampered or blocking structural ownership receipt.",
      );
    }
    artifacts.structural_ownership_preflight = structuralPreflightPath;
    checkpoints.push(await checkpoint(
      "structural_ownership_preflight",
      "PASS",
      structuralPreflightPath,
    ));
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
  // P2.8 wiring of the P0.4 support envelope: classify from evidence-lane
  // facts BEFORE any model stage runs. Facts the evidence run cannot state
  // stay undeclared and classify to their contract-declared unknown classes;
  // an early-stop predicate ends the run as UNSUPPORTED_PROFILE with its
  // typed reason, before model compilation spends anything.
  const supportVerdict = (() => {
    const filings = evidenceRun.filings ?? {};
    // P2.11: the framework may be stated on the filings facts OR declared on the
    // case source's identity. Reading only the former left every certified-fixture
    // run classified UNSUPPORTED (framework silent) while the stop did not fire —
    // an inert preflight. Both origins are authoritative declarations.
    const framework = String(
      filings.accounting_framework ??
        evidenceRun.case_source?.identity?.accounting_framework ??
        "",
    ).toLowerCase();
    const historicalCount = (filings.historical_periods ?? []).length;
    const sections = evidenceRun.case_evidence?.face_statement_manifests ?? {};
    const descriptor = {
      ...(framework === "ifrs" ? { accounting_framework: "ifrs" } : {}),
      ...(framework === "us_gaap" ? { accounting_framework: "us_gaap" } : {}),
      ...(filings.fiscal_calendar_kind === "fixed_date" ? { fiscal_calendar: "fixed_date" } : {}),
      ...(filings.fiscal_calendar_kind === "52_53_week" ? { fiscal_calendar: "week_52_53" } : {}),
      ...(historicalCount >= 3
        ? { historical_periods: "three_or_more" }
        : historicalCount === 2
          ? { historical_periods: "two_with_prior_filing_support" }
          : historicalCount > 0
            ? { historical_periods: "fewer_than_two" }
            : {}),
      ...((sections.cash_flow ?? []).length === 0 && (sections.income_statement ?? []).length > 0
        ? { statement_topology: "cash_flow_absent" }
        : {}),
    };
    return classifySupport(SUPPORT_ENVELOPE_CONTRACT, descriptor);
  })();
  if (supportVerdict.early_stop.stopped) {
    checkpoints.push(await checkpoint("support_envelope_preflight", "BLOCKED", evidencePath));
    return finish({
      out,
      runId,
      status: "BLOCKED",
      qualityMode: "FATAL",
      blockerClass: "FATAL_SOURCE",
      checkpoints,
      artifacts,
      summary: {
        message: `The case is outside the versioned support envelope: ${supportVerdict.early_stop.reason_code}.`,
        support_envelope_verdict: supportVerdict.support_class,
        support_envelope_reason: supportVerdict.early_stop.reason_code,
      },
    });
  }
  checkpoints.push(await checkpoint("support_envelope_preflight", "PASS", evidencePath));
  const userFlowOut = path.join(out, "model");
  const workspaceToken = String(options["workspace-token"] ?? `vnext:${digestBytes(out).slice(0, 24)}`);
  const firstArgs = [
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
  firstArgs.push("--runtime-budget-policy", runtimeBudgetPolicyPath);
  firstArgs.push("--soffice", sofficeCommand);
  const firstExecution = await runUserFlow(firstArgs, {
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
  if (userFlowResult.status === "BLOCKED" && userFlowResult.stage === "inputs") {
    const compileReportPath = path.join(userFlowOut, "stages", "inputs", "case-compile-report.json");
    const compileReport = await readJson(compileReportPath, "case compile report").catch(() => null);
    const ownershipFinding = (compileReport?.findings ?? []).find(
      (finding) => finding?.id === "forecast_ownership.preflight" &&
        finding?.context?.controller_signal?.action ===
          "cancel_descendants_preserve_checkpoint",
    );
    if (ownershipFinding) {
      const descendantPids = [
        ...(ownershipFinding.context?.controller_signal?.descendant_pids ?? []),
        ...(firstExecution.live_descendant_pids ?? []),
      ];
      const cancellationExecution = await cancelProcessTreePids(descendantPids);
      const checkpointSha256 = String(
        userFlowResult?.receipt?.receipt_hash ?? await sha256File(compileReportPath),
      );
      const action = compileOwnershipPreflightControllerAction({
        preflightReceipt: ownershipFinding.context.receipt,
        checkpointSha256,
        descendantPids,
      });
      action.cancellation_execution = cancellationExecution;
      action.resume = {
        topology_resolution: "forecast_ownership",
        preserve_checkpoint_sha256: checkpointSha256,
        resume_scope: "downstream_only",
        reenter_filings: false,
        reenter_dcs: false,
        reenter_broker: false,
      };
      const unsignedAction = { ...action };
      delete unsignedAction.action_sha256;
      action.action_sha256 = digestBytes(canonicalJson(unsignedAction));
      const actionPath = path.join(out, "ownership-preflight-controller-action.json");
      await writeJson(actionPath, action);
      artifacts.ownership_preflight_controller_action = actionPath;
      artifacts.case_compile_report = compileReportPath;
      checkpoints.push(await checkpoint("ownership_preflight", "BLOCKED_RESUMABLE", actionPath));
      const recoveryBudget = Math.max(
        1,
        ACTIVE_RUNTIME_BUDGET.budgets_ms.case_compilation_and_ownership -
          Number(firstExecution.duration_ms ?? 0),
      );
      const recoveryExecution = await run(process.execPath, firstArgs, {
        timeout: recoveryBudget,
        budgetStage: "case_compilation_and_ownership",
        env: {
          ...runtimeEnv,
          EXCEL_INFLOW_OWNERSHIP_DEGRADE: "historical_average",
        },
        progress: {
          stage: "ownership topology recovery",
          documentsTotal: 1,
          documentsComplete: 0,
        },
      });
      const recovered = await readJson(
        userFlowResultPath,
        "ownership-recovered user-flow result",
      ).catch(() => null);
      action.recovery_execution = {
        exit_code: recoveryExecution.code,
        duration_ms: recoveryExecution.duration_ms,
        timed_out: recoveryExecution.timed_out,
        termination_verified: recoveryExecution.termination_verified,
        status: recovered?.status ?? "ABSENT",
        reentered_filings: false,
        reentered_dcs: false,
        reentered_broker: false,
        user_reupload_required: false,
      };
      const recoveredUnsigned = { ...action };
      delete recoveredUnsigned.action_sha256;
      action.action_sha256 = digestBytes(canonicalJson(recoveredUnsigned));
      await writeJson(actionPath, action);
      if (recoveryExecution.code === 0 && recovered?.status === "PAUSED") {
        userFlowResult = recovered;
        checkpoints.push(await checkpoint("ownership_topology_recovery", "PASS", userFlowResultPath));
      }
    }
  }
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
    "--carrier",
    path.resolve(userFlowResult.carrier),
    "--out",
    userFlowOut,
    "--workspace-token",
    workspaceToken,
    "--json",
  ];
  // The review gate is fail-closed: a resume may continue past it only when
  // the caller explicitly accepted delivery (the canary and any scripted
  // caller pass --review-deliver; a human at the terminal replies the same
  // way). Forward the caller's reply onto the resume.
  if (process.argv.includes("--review-deliver")) resumeArgs.push("--review-deliver");
  if (process.argv.includes("--review-change")) {
    const idx = process.argv.indexOf("--review-change");
    if (idx >= 0 && process.argv[idx + 1]) resumeArgs.push("--review-change", process.argv[idx + 1]);
  }
  resumeArgs.push("--python", pythonCommand);
  resumeArgs.push("--runtime-budget-policy", runtimeBudgetPolicyPath);
  resumeArgs.push("--soffice", sofficeCommand);
  const pausedResultSha256 = await sha256File(userFlowResultPath);
  const resumeExecution = await runUserFlow(resumeArgs, {
    // This is only the controller watchdog. Stage-4 enforces solver, build,
    // recalc and validation independently and cumulatively. The watchdog is
    // sized by the PERSISTED clock, so a resume gets what the run has left —
    // not a fresh ceiling because this process started a moment ago.
    timeout: Math.max(1, remainingRuntimeMs({
      policy: ACTIVE_RUNTIME_BUDGET,
      consumedComputeMs: consumedRunComputeMs(),
    })),
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
  checkpoints.push(await checkpoint("model_decisions", "PASS", userFlowResultPath));
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
  if (!buildResult.runtime_budget?.receipt) {
    throw new Error("Stage-4 build result omitted its independent runtime-budget receipt.");
  }
  const stage4RuntimeReceiptPath = path.resolve(buildResult.runtime_budget.receipt);
  const stage4RuntimeReceipt = await readJson(stage4RuntimeReceiptPath, "Stage-4 runtime budget receipt");
  const stage4RuntimeErrors = validateRuntimeBudgetReceipt(stage4RuntimeReceipt, ACTIVE_RUNTIME_BUDGET);
  if (stage4RuntimeErrors.length > 0) {
    throw new Error(`Stage-4 runtime budget receipt failed closed: ${stage4RuntimeErrors.join(", ")}`);
  }
  ACTIVE_RUNTIME_BUDGET_EXECUTIONS.push(...stage4RuntimeReceipt.stage_executions);
  artifacts.stage4_runtime_budget_receipt = stage4RuntimeReceiptPath;
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
    // P6.6: a REUSED stage-4 checkpoint records timings_ms[id] = 0. Without the
    // reuse sets a warm run emitted MISSING spans by construction, so the
    // receipt lied about a lawful resume. Reuse is declared, never inferred.
    reusedCheckpoints: buildResult?.checkpointing?.reused ?? [],
    executedCheckpoints: buildResult?.checkpointing?.executed ?? [],
    totalDurationMs: Date.now() - ACTIVE_PERFORMANCE.started_epoch_ms,
    hostPreflightDurationMs: ACTIVE_PERFORMANCE.stages.host_preflight_ms,
  });
  await writeJson(performanceReceiptPath, performanceReceipt);
  artifacts.performance_receipt = performanceReceiptPath;
  // P6.6: the receipt is VALIDATED here, in the delivered path, instead of
  // being shipped INCOMPLETE with no caller. A receipt defect is a typed,
  // visible FINDING with its own artifact and a line in the run summary --
  // never a reason to discard a workbook that stage 4 already built,
  // recalculated and independently validated. Deleting proven work because its
  // stopwatch is unlabelled would trade a real deliverable for a bookkeeping
  // defect; the runtime-budget and progress receipts above still fail closed
  // because those measure whether the run stayed inside its declared
  // envelope, which is a correctness claim about the run itself.
  const performanceReceiptErrors = validatePerformanceReceipt(performanceReceipt);
  const performanceReceiptValidationPath = path.join(out, "performance-receipt-validation.json");
  await writeJson(performanceReceiptValidationPath, {
    schema_version: "excel-inflow-performance-receipt-validation/1.0",
    run_id: runId,
    validator: "validatePerformanceReceipt",
    validation_status: performanceReceiptErrors.length === 0 ? "PASS" : "FINDING",
    finding_class: performanceReceiptErrors.length === 0 ? null : "PERFORMANCE_RECEIPT_NOT_HONEST",
    errors: performanceReceiptErrors,
    receipt: performanceReceiptPath,
    receipt_sha256: performanceReceipt.receipt_sha256,
    receipt_status: performanceReceipt.status,
    reconciliation: performanceReceipt.reconciliation,
    threshold_source: {
      policy_ref: performanceReceipt.input_bindings.performance_policy_ref,
      policy_sha256: performanceReceipt.input_bindings.performance_policy_sha256,
    },
    delivery_impact:
      "none: a delivered workbook is never discarded for a receipt defect; the finding is recorded and surfaced in the run summary.",
  });
  artifacts.performance_receipt_validation = performanceReceiptValidationPath;
  // ACTIVE_PERFORMANCE is merged into the delivered summary by finish(), so the
  // finding travels with the run state without touching any finish() site.
  ACTIVE_PERFORMANCE.receipt = {
    path: performanceReceiptPath,
    sha256: performanceReceipt.receipt_sha256,
    status: performanceReceipt.status,
    validation_status: performanceReceiptErrors.length === 0 ? "PASS" : "FINDING",
    finding_class: performanceReceiptErrors.length === 0 ? null : "PERFORMANCE_RECEIPT_NOT_HONEST",
    errors: performanceReceiptErrors,
    unattributed_ms: performanceReceipt.reconciliation.unattributed_ms,
    attribution_band: performanceReceipt.reconciliation.band,
    attribution_ratio: performanceReceipt.reconciliation.attribution_ratio,
    reused_span_names: performanceReceipt.summary.reused_span_names,
    missing_span_names: performanceReceipt.summary.missing_span_names,
    threshold_source: performanceReceipt.input_bindings.performance_policy_ref,
    validation_artifact: performanceReceiptValidationPath,
  };
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
      active_runtime_code_closure_check: ACTIVE_SOURCE_IDENTITY?.active_runtime_code_closure_check ?? null,
    },
  });
}

/**
 * Charge this controller invocation to the one clock and release its claim on
 * it. Called on the delivered path AND on the terminal catch, so a thrown
 * outer controller run is as visible to the ceiling as a delivered one.
 */
async function closeControllerRunDeadline() {
  if (!ACTIVE_RUN_DEADLINE) return;
  try {
    if (ACTIVE_CONTROLLER_SPAN) {
      const span = ACTIVE_CONTROLLER_SPAN;
      ACTIVE_CONTROLLER_SPAN = null;
      await endComputeSpan(ACTIVE_RUN_DEADLINE, span);
    }
    await closeRunDeadline(ACTIVE_RUN_DEADLINE);
  } catch {}
}

main().catch(async (error) => {
  // P3.7 pattern at the OUTER boundary (P6.0a): an uncaught controller
  // failure is serialised as a typed internal-failure artifact with the
  // registry's five payload fields; the public stderr carries one typed
  // summary line, never a stack (TOC.F). The stack is preserved inside the
  // artifact for engineering.
  const reasonCode =
    error?.typed_internal_outcome?.reason_code ?? "INTERNAL.compiler_or_graph_defect";
  const summaryLine = String(error?.message ?? error).split("\n")[0];
  let artifactNote = "no --out directory was resolvable; no artifact written";
  try {
    const outFlagIndex = process.argv.indexOf("--out");
    const outDir = !error?.controller_handoff_refusal && outFlagIndex >= 0 && process.argv[outFlagIndex + 1]
      ? path.resolve(String(process.argv[outFlagIndex + 1]))
      : null;
    if (outDir) {
      const payload = {
        schema_version: "excel-inflow-internal-failure/1.0",
        reason_code: reasonCode,
        earliest_responsible_layer:
          error?.typed_internal_outcome?.earliest_responsible_layer ??
          "unattributed (repair: type this throw)",
        downstream_invalidation_scope:
          error?.typed_internal_outcome?.downstream_invalidation_scope ??
          "unknown_full_rerun",
        resumable_checkpoint_path: outDir,
        preserved_source_hashes:
          "evidence and run artifacts under the run directory remain immutable",
        detail: error?.typed_internal_outcome ?? null,
        message: String(error?.message ?? error),
        stack: String(error?.stack ?? ""),
      };
      await fs.mkdir(outDir, { recursive: true });
      const artifactPath = path.join(outDir, "internal-failure.json");
      await fs.writeFile(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      artifactNote = artifactPath;
    }
  } catch {}
  process.stderr.write(
    `INTERNAL_FAILURE ${reasonCode}: ${summaryLine} (see ${artifactNote})\n`,
  );
  try { ACTIVE_PROGRESS_HEARTBEAT?.stop?.(); } catch {}
  process.exitCode = 1;
}).finally(async () => {
  // P6.1: whatever ended this invocation — delivery or a throw — the compute it
  // consumed is charged to the one persisted clock and its claim is released,
  // so a kill/retry loop cannot hide its compute from the ceiling.
  await closeControllerRunDeadline();
});
