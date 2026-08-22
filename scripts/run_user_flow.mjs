#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateEvidenceRun } from "./lib/evidence_run.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  installedCapabilityReceiptDigest,
} from "./lib/runtime_doctor.mjs";
import { resolveActiveSourceIdentity } from "./lib/source_identity.mjs";
import {
  RUN_DEADLINE_ENV,
  beginComputeSpan,
  bindRunDeadlineIdentity,
  boundedOuterTimeoutMs,
  closeRunDeadline,
  consultStageBudget,
  endComputeSpan,
  openRunDeadline,
  recordComputeSegment,
} from "./lib/run_deadline.mjs";
import {
  DEFAULT_RUNTIME_BUDGETS_MS,
  RUNTIME_BUDGET_POLICY_SCHEMA,
  resolveRuntimeBudgetPolicy,
  validateRuntimeBudgetPolicy,
} from "./lib/runtime_budget_policy.mjs";
import { assertEconomicStageParityAfterBuild, sealEconomicStageParity } from "./lib/forecast_completion_constitution.mjs";
import {
  applyAnswers,
  deliver,
  parseAnswers,
  runIntake,
} from "./lib/flow.mjs";
import {
  FLOW_CONTROLLER_VERSION,
  earliestInvalidatedStage,
  nextStageId,
} from "./lib/flow_runtime.mjs";
import {
  assertPublicStateOwnership,
  assertWorkflowTransition,
  normaliseUserFlowResult,
} from "./lib/workflow_state.mjs";
import {
  COMPANY_SCREEN_SESSION_CONTRACT_SHA256,
  renderCompanyScreen,
  renderBrokerIntakeScreen,
  renderBrokerPreviewScreen,
  renderEvidenceReviewProgress,
  renderDeliveryReport,
  renderFailure,
  renderForecastPlanScreen,
  renderReviewGateScreen,
  renderStageStatus,
  WELCOME_SCREEN,
} from "./lib/flow_screens.mjs";
// The REVIEW gate: the display-only pause between BUILD AND CHECKS and
// DELIVERY, plus the plain-language translation of its change requests.
import {
  REVIEW_CHANGE_REPLY,
  recordUserReviewReceipt,
  resolveReviewReply,
  reviewQualityFrom,
  ReviewSealRefusal,
  REVIEW_DELIVER_REPLY,
  sealReviewBriefing,
} from "./lib/flow_review.mjs";
import {
  classifyChangeComplaint,
  describeReviseEntry,
} from "./lib/flow_remediation.mjs";
import { deriveRuntimeMode } from "./lib/runtime_mode.mjs";
import { verifyScreenSession } from "./lib/screen_session.mjs";
import {
  bindStageRecipes,
  deriveStageRuntimeClosure,
  persistStage,
  readJsonIfPresent,
  readUsableStage,
  writeJsonAtomic,
  writeRunResult,
  writeTextAtomic,
} from "./lib/user_flow_controller.mjs";
import {
  hashFile,
  hashValue,
} from "./lib/run_store.mjs";
import { createEvidenceWorkGraph } from "./lib/evidence_work_graph.mjs";
// P6.4 — the error classification table and the attempt ledger. Every evidence
// work node execution becomes an attempt with a receipt; a failure gets a CLASS
// that decides its retry budget, its cache-reuse rule, its downstream
// invalidation scope and its registered terminal outcome; and a failure the
// table cannot classify is REFUSED admission to that machinery (recorded with
// the repair it needs) and rethrown unchanged.
import {
  createAttemptLedger,
  errorClassificationTable,
} from "./lib/error_classification.mjs";
import { runProcessTree } from "./lib/process_tree.mjs";
import {
  runCarrierMigrationStageInput,
  verifyRunCarrier,
  writeRunCarrier,
} from "./lib/run_carrier.mjs";
import { verifyBrokerIntakeChoice } from "./lib/broker_intake_choice.mjs";
import {
  compileForecastPlan,
  forecastPlanSha256,
  materializeSelectedAuthorityContract,
  validateForecastPlan,
} from "./lib/forecast_candidate_compiler.mjs";
import {
  compileForecastBehaviorMap,
  validateForecastBehaviorMap,
} from "./lib/forecast_behavior.mjs";
import {
  compileModelDemandGraph,
  compileRunConstitutionGraph,
  compileSelectedAuthorityContract,
  validateModelDemandGraph,
  validateRunConstitutionGraph,
  validateSelectedAuthorityContract,
} from "./lib/run_constitution_graph.mjs";
import {
  applyBrokerPreviewSelection,
  applyBrokerPreviewSelectionToCaseEvidence,
  automaticBrokerPreviewConfirmation,
  compileBrokerForecastWaterfallFallback,
  compileEmergencyZeroBrokerPreview,
  compileBrokerPreview,
  projectZeroBrokerAuthorityCaseEvidence,
  validateBrokerPreview,
  verifyBrokerPreviewConfirmation,
} from "./lib/broker_preview.mjs";
import { assertBrokerFailureDegrades } from "./lib/delivery_constitution.mjs";
import { compileCase } from "./lib/case_compiler.mjs";
import { consumeControllerHandoff } from "./lib/controller_handoff.mjs";

import {
  assertLiveDeliveryAttestation,
  compileLiveDeliveryAttestation,
} from "./lib/live_delivery_attestation.mjs";
import {
  normaliseStatementRows,
  reconcileStatementProjectionCoverage,
  stripStatementPresentationMetadata,
} from "./lib/row_plan.mjs";
import {
  acquireRunLease,
  assertRunRootOutsideSkill,
  assertRuntimeIntegrityUnchanged,
  atomicWriteJson as writeIsolationJson,
  captureRuntimeIntegrity,
  initializeOrVerifyRunIdentity,
  releaseRunLease,
  validateRunId,
} from "./lib/runtime_isolation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONTROLLER_FILE = fileURLToPath(import.meta.url);
const VNEXT_CONTROLLER_FILE = path.join(HERE, "run_excel_inflow_vnext.mjs");

async function assertCompanyScreenPreflight(options) {
  const receiptPath = typeof options["host-capability-receipt"] === "string"
    ? path.resolve(options["host-capability-receipt"])
    : null;
  const reportPath = typeof options["runtime-doctor-report"] === "string"
    ? path.resolve(options["runtime-doctor-report"])
    : null;
  const screenSessionReceiptPath = typeof options["screen-session-receipt"] === "string"
    ? path.resolve(options["screen-session-receipt"])
    : null;
  const screenSessionId = typeof options["screen-session-id"] === "string"
    ? String(options["screen-session-id"])
    : null;
  const screenSessionSecret = typeof options["screen-session-secret"] === "string"
    ? String(options["screen-session-secret"])
    : null;
  if (
    !receiptPath || !reportPath || !screenSessionReceiptPath ||
    !screenSessionId || !screenSessionSecret
  ) {
    throw new Error(
      "Company screen requires the top-level controller's current host capability and " +
      "explicit screen-session receipt/id/secret; " +
      "invoke run_excel_inflow_bootstrap.mjs --screen company.",
    );
  }
  const [receiptBytes, reportBytes, receiptSchema, reportSchema] = await Promise.all([
    fs.readFile(receiptPath),
    fs.readFile(reportPath),
    fs.readFile(path.join(ROOT, "assets", "installed-capability-receipt-v1.3.schema.json"), "utf8")
      .then(JSON.parse),
    fs.readFile(path.join(ROOT, "assets", "runtime-doctor-report-v1.schema.json"), "utf8")
      .then(JSON.parse),
  ]);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  const report = JSON.parse(reportBytes.toString("utf8"));
  const errors = [
    ...validateJsonSchema(receipt, receiptSchema),
    ...validateJsonSchema(report, reportSchema),
  ];
  if (errors.length > 0) throw new Error(`Company-screen preflight artifacts are invalid: ${errors[0]}`);
  if (
    receipt.status !== "HOST_READY" || report.verdict !== "HOST_READY" ||
    !["evidence", "workbook"].every((lane) => receipt.requested_lanes.includes(lane))
  ) {
    throw new Error("Company-screen preflight did not certify both evidence and workbook lanes.");
  }
  if (installedCapabilityReceiptDigest(receipt) !== receipt.receipt_sha256) {
    throw new Error("Company-screen capability receipt failed its self-hash.");
  }
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  if (reportSha256 !== receipt.runtime_doctor_sha256) {
    throw new Error("Company-screen capability receipt does not bind the supplied runtime-doctor report bytes.");
  }
  const generatedAt = Date.parse(receipt.generated_at);
  if (!Number.isFinite(generatedAt) || generatedAt > Date.now() + 60_000 || Date.now() - generatedAt > 600_000) {
    throw new Error("Company-screen capability receipt is stale or has an invalid timestamp.");
  }
  const [activeNodeSha256, activePythonSha256, activeSofficeSha256] = await Promise.all([
    fs.readFile(process.execPath).then((bytes) => createHash("sha256").update(bytes).digest("hex")),
    fs.readFile(receipt.python.executable)
      .then((bytes) => createHash("sha256").update(bytes).digest("hex")),
    fs.readFile(receipt.workbook.soffice_executable)
      .then((bytes) => createHash("sha256").update(bytes).digest("hex")),
  ]);
  if (
    receipt.node.executable !== process.execPath || receipt.node.version !== process.version ||
    receipt.node.executable_sha256 !== activeNodeSha256 ||
    receipt.python.executable_sha256 !== activePythonSha256 ||
    receipt.workbook.soffice_executable_sha256 !== activeSofficeSha256
  ) {
    throw new Error("Company-screen capability receipt belongs to different Node or Python bytes.");
  }
  const runtimeMode = await deriveRuntimeMode({
    skillRoot: ROOT,
    installStateRoot: process.env.EXCEL_INFLOW_INSTALL_STATE_ROOT ?? null,
    capabilityReceipt: receipt,
    capabilityReceiptSha256: receipt.receipt_sha256,
  });
  const active = await resolveActiveSourceIdentity({
    skillRoot: ROOT,
    overrides: runtimeMode.source_identity_overrides,
  });
  if (
    receipt.source_identity.active_runtime_code_closure_sha256 !==
      active.active_runtime_code_closure_check.active_runtime_code_closure_sha256 ||
    receipt.source_identity.source_commit !== active.source_commit ||
    receipt.source_identity.source_tree !== active.source_tree
  ) {
    throw new Error("Company-screen capability receipt belongs to different active package bytes.");
  }
  const verifiedSession = await verifyScreenSession({
    skillRoot: ROOT,
    sessionRoot: path.dirname(screenSessionReceiptPath),
    receiptPath: screenSessionReceiptPath,
    sessionId: screenSessionId,
    sessionSecret: screenSessionSecret,
    expected: {
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
      capability_receipt_sha256:
        createHash("sha256").update(receiptBytes).digest("hex"),
      runtime_doctor_report_sha256: reportSha256,
      screen_contract_sha256: COMPANY_SCREEN_SESSION_CONTRACT_SHA256,
    },
  });
  return Object.freeze({ runtimeMode, screenSession: verifiedSession.receipt });
}
let ACTIVE_RUN_GUARD = null;
// P6.4 — the evidence work graph and its attempt ledger, held at module scope
// for the same reason the run guard is: `finish()` is the one place every exit
// passes through, and the reuse a result CLAIMS has to be sealed against what
// the graph RECORDED before that result is written.
let ACTIVE_WORK_GRAPH = null;
let ACTIVE_ATTEMPT_LEDGER = null;
let ACTIVE_RUN_DEADLINE = null;
// The whole invocation measured as ONE span against the persisted clock.
// Compute charged by stages and by the stage-4 subprocess is credited out of
// it automatically, so nothing is billed twice and nothing is unattributed.
let ACTIVE_INVOCATION_SPAN = null;
// The stage currently holding an allowance from the single clock.
let ACTIVE_STAGE_CLOCK = null;

const PRESENTATION_SCREENS = Object.freeze({
  evidence_review: Object.freeze({
    status: "in progress",
    summary:
      "Reading the supplied evidence and reconciling the issuer, periods, statements, debt and broker forecasts. No response is required.",
  }),
  decisions: Object.freeze({
    status: "complete",
    summary:
      "Evidence review is complete and no material unresolved decision requires an answer.",
  }),
  build_checks: Object.freeze({
    status: "in progress",
    summary:
      "Solving the economic graph, building the workbook and running the deterministic checks. No response is required.",
  }),
  delivery: Object.freeze({
    status: "in progress",
    summary:
      "The workbook cleared its automated build checks and the delivery package is being prepared. No response is required.",
  }),
});

const COMPLETION_SUMMARIES = Object.freeze({
  evidence_review:
    "The supplied evidence reconciled and the material decision set has been determined.",
  build_checks:
    "The workbook cleared the automated build and validation gates. Delivery can now be prepared.",
});

function renderPresentationScreen(stageId, companyPreflight = null) {
  // "company" is the v3 entry screen (constitution S1): company only, the
  // rest of the pack is collected at its own stage. "inputs" remains the
  // fast-path pack screen and the id older transcripts reference.
  if (stageId === "company") {
    if (!companyPreflight) throw new Error("Company screen has no verified screen session.");
    return renderCompanyScreen({
      runtimeMode: companyPreflight.runtimeMode.runtime_mode,
      screenNonce: companyPreflight.screenSession.screen_nonce,
    });
  }
  if (stageId === "brokers") return renderBrokerIntakeScreen("the selected company");
  if (stageId === "inputs") return WELCOME_SCREEN;
  const declaration = PRESENTATION_SCREENS[stageId];
  if (!declaration) {
    throw new Error(
      `--screen must be one of company, brokers, inputs, evidence_review, decisions, build_checks or delivery; got ${stageId}`,
    );
  }
  return renderStageStatus({ stageId, ...declaration });
}

function renderCompletionScreen(stageId) {
  const summary = COMPLETION_SUMMARIES[stageId];
  if (!summary) throw new Error(`No completion screen is declared for ${stageId}`);
  return renderStageStatus({ stageId, status: "complete", summary });
}

// P6.2: the five user stages no longer carry a HAND-MAINTAINED membership list.
// The list that used to live here was not closed over the real import graph —
// its `inputs` entry named 13 modules whose own transitive closure is 99 — so a
// change to a module the stage genuinely executes (solver.mjs, run_deadline.mjs,
// semantic_graph.mjs, ...) left the stage receipt reusable. Membership is now
// DERIVED by deriveStageRuntimeClosure() in user_flow_controller.mjs and carried
// in the receipt's recipe.

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

async function readJson(target, label) {
  try {
    return JSON.parse(await fs.readFile(path.resolve(target), "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

/**
 * Hash a declared stage input, or a stable sentinel when it is absent. This
 * exists so a blocked path and the success path of the same stage can share ONE
 * input shape: a shape that throws on a missing artifact would force the
 * blocked path back to a narrower, incomparable key.
 */
async function hashFileOrAbsent(target) {
  try {
    return await hashFile(target);
  } catch {
    return hashValue({ absent: path.basename(String(target)) });
  }
}

function serialisable(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "function" ? undefined : item,
    ),
  );
}

async function runCommand(binary, args, options = {}) {
  return runProcessTree(binary, args, {
    cwd: options.cwd ?? process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 300000,
    env: options.env ?? { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
}

function stage4OuterTimeout(modelCase, explicit) {
  if (explicit !== undefined && explicit !== null) return Number(explicit);
  const statementRows = [
    ...(modelCase?.statement_structure?.income_statement ?? []),
    ...(modelCase?.statement_structure?.cash_flow ?? []),
  ].length;
  const brokerHouses = Math.max(
    (modelCase?.broker_pack?.houses ?? []).length,
    (modelCase?.broker_pack?.page_evidence ?? []).length,
    Array.isArray(modelCase?.broker_pack?.raw_tables)
      ? modelCase.broker_pack.raw_tables.length
      : Object.keys(modelCase?.broker_pack?.raw_tables ?? {}).length,
  );
  const instruments = (modelCase?.instruments ?? []).length;
  // The inner controller owns leaf-level dynamic timeouts and resumable
  // checkpoints. The outer shell must outlive the worst single inner leaf,
  // plus enough headroom for plan/emit/publish, without imposing a shorter
  // fixed ceiling on a larger evidence-backed workbook.
  const complexityUnits = Math.max(1, Math.ceil(statementRows / 50)) + brokerHouses + Math.ceil(instruments / 10);
  // The complexity formula sizes the allowance BETWEEN its floor and the
  // product's own end-to-end hard ceiling. There is deliberately no longer an
  // independent one-hour class: no single stage may be granted more compute
  // than the whole run is promised to take.
  return Math.min(
    DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_hard_ceiling,
    600_000 + complexityUnits * 90_000,
  );
}

async function loadAnswers(target, questions) {
  const text = await fs.readFile(path.resolve(target), "utf8");
  if (target.toLowerCase().endsWith(".json")) {
    const payload = JSON.parse(text);
    const answers = new Map(Object.entries(payload.answers ?? payload));
    const errors = [];
    for (const question of questions ?? []) {
      if (!answers.has(question.id)) {
        errors.push(`Missing answer for ${question.id}.`);
        continue;
      }
      const allowed = new Set((question.options ?? []).map((option) => option.id));
      if (!allowed.has(answers.get(question.id))) {
        errors.push(
          `Invalid answer for ${question.id}; expected one of ${[...allowed].join(", ")}.`,
        );
      }
    }
    return { answers, errors, complete: errors.length === 0 };
  }
  return parseAnswers(text, questions);
}

function caseSourceWithRecordedAnswers(caseSource, applied) {
  const next = structuredClone(caseSource ?? {});
  const byId = new Map(
    (next.answers ?? []).map((entry) => [entry.question_id, structuredClone(entry)]),
  );
  for (const entry of applied ?? []) {
    byId.set(entry.id, {
      question_id: entry.id,
      round: "B",
      question: entry.text ?? null,
      answer: entry.answer,
      answered_at: null,
    });
  }
  next.answers = [...byId.values()].sort((left, right) =>
    left.question_id.localeCompare(right.question_id));
  return next;
}

function recordedDecisionMap(caseSource) {
  return new Map(
    (caseSource?.answers ?? [])
      .filter((entry) => entry?.round !== "derived")
      .map((entry) => [entry.question_id, entry.answer]),
  );
}

function stoppedOutcome(outcome) {
  return [
    "bad_inputs",
    "filings_incomplete",
    "entity_stop",
    "reconciliation_stop",
    "awaiting_reexport",
    "decision_replay_blocked",
    "decision_graph_blocked",
  ].includes(outcome);
}

function stageForOutcome(outcome) {
  if (outcome === "bad_inputs") return "inputs";
  if (["filings_incomplete", "entity_stop", "reconciliation_stop", "awaiting_reexport"].includes(outcome)) {
    return "evidence_review";
  }
  return "decisions";
}

function blockerForStoppedOutcome(outcome) {
  return ["decision_replay_blocked", "decision_graph_blocked"].includes(outcome)
    ? "INTERNAL_WORK"
    : "USER_EVIDENCE";
}

/**
 * Enter one user stage against THE clock. Every stage consults the same
 * remaining budget before it runs — that consult is recorded in the ledger, so
 * a stage that skipped it is detectable — and the previous stage's consumption
 * is closed out first.
 */
async function enterFlowStage(stage) {
  if (!ACTIVE_RUN_DEADLINE) return null;
  await closeFlowStage();
  const allowanceMs = await consultStageBudget(ACTIVE_RUN_DEADLINE, { stage });
  ACTIVE_STAGE_CLOCK = {
    stage,
    allowanceMs,
    span: beginComputeSpan(ACTIVE_RUN_DEADLINE, `stage:${stage}`),
  };
  return allowanceMs;
}

/** Close the open stage and charge what it consumed to the single clock. */
async function closeFlowStage() {
  if (!ACTIVE_RUN_DEADLINE || !ACTIVE_STAGE_CLOCK) return;
  const clock = ACTIVE_STAGE_CLOCK;
  ACTIVE_STAGE_CLOCK = null;
  await endComputeSpan(ACTIVE_RUN_DEADLINE, clock.span, {
    stage: clock.stage,
    allowanceMs: clock.allowanceMs,
  });
}

/**
 * Charge every millisecond this invocation consumed, whatever ends it. Called
 * from finish() AND from the terminal catch, so a thrown run is as visible to
 * the ceiling as a delivered one. (A killed run is charged by the ledger's own
 * abandoned-invocation sweep on the next open.)
 */
async function chargeInvocationToRunDeadline() {
  if (!ACTIVE_RUN_DEADLINE) return;
  await closeFlowStage();
  if (ACTIVE_INVOCATION_SPAN) {
    const span = ACTIVE_INVOCATION_SPAN;
    ACTIVE_INVOCATION_SPAN = null;
    await endComputeSpan(ACTIVE_RUN_DEADLINE, span);
  }
  await closeRunDeadline(ACTIVE_RUN_DEADLINE);
}

async function finish({ runDir, result, screen = null, machine = false }) {
  // PUBLIC-STATE OWNERSHIP, enforced rather than scanned for. Every one of this
  // controller's 19 result sites exits through finish(), so asserting here binds
  // them all: ACTION_REQUIRED may only be owned by USER_DECISION, USER_EVIDENCE
  // or FATAL_SOURCE, and INTERNAL_WORK may never be user-blocking.
  //
  // Until now the only protection for this file was a TEXT-PROXIMITY SCAN in
  // run_public_state_ownership_tests.mjs, which fails whenever the two tokens
  // appear within 220 characters of each other. It was firing on the correct
  // ternary at the decisions stage -- the one that routes an internal
  // decision-graph failure to BLOCKED/INTERNAL_WORK and only a genuine user
  // question to ACTION_REQUIRED. A proximity regex cannot see a branch, so it
  // read the repair as the defect. That is the same name-standing-for-meaning
  // class the programme has found repeatedly; the answer is to assert the
  // property, not to loosen the regex.
  assertPublicStateOwnership(result);
  // Attribute this invocation's remaining compute (everything outside the
  // separately measured stage and stage-4 spans) so no interval stays
  // unattributed and no interval is counted twice.
  await chargeInvocationToRunDeadline();
  // P6.4 — SEAL THE REUSE CLAIM. `reused_stages` used to be a list of stages
  // whose RECEIPT was reused; it said nothing about whether the work inside
  // them ran, and on a warm answered run it reported three stages as reused
  // while five nodes re-executed inside them. The graph now checks the claim:
  // every node in a claimed stage must either have been SKIPPED, or have
  // re-executed and reproduced EXACTLY the output the receipt it rests on
  // recorded, or be the controller's own recorded degradation. Anything else
  // is a dishonest claim and is REFUSED here — never quietly corrected, and
  // never dropped from the list to make the check pass.
  if (ACTIVE_WORK_GRAPH) {
    const sealed = await ACTIVE_WORK_GRAPH.sealReuseClaim(result?.reused_stages ?? []);
    await writeJsonAtomic(path.join(runDir, "reuse-enactment.json"), {
      schema_version: "reuse-enactment/1.0",
      run_id: result?.run_id ?? null,
      controller_version: FLOW_CONTROLLER_VERSION,
      ...sealed,
    });
    if (sealed.violations.length > 0) {
      throw new Error(
        `The run claimed reuse it did not perform: ${sealed.violations.join("; ")}`,
      );
    }
  }
  if (ACTIVE_ATTEMPT_LEDGER) await ACTIVE_ATTEMPT_LEDGER.close();
  if (ACTIVE_RUN_GUARD) {
    const closing = await assertRuntimeIntegrityUnchanged(ACTIVE_RUN_GUARD.integrity, ROOT);
    await writeIsolationJson(path.join(runDir, "skill-integrity.json"), {
      schema_version: "skill-integrity-evidence/1.0",
      status: "PASS",
      opening_digest: ACTIVE_RUN_GUARD.integrity.digest,
      closing_digest: closing.digest,
      file_count: closing.file_count,
    });
  }
  const clean = serialisable(normaliseUserFlowResult(result));
  const priorResult = await readJsonIfPresent(path.join(runDir, "user-flow-result.json"));
  assertWorkflowTransition(
    "user_flow",
    priorResult?.status,
    clean.status,
    { reset: priorResult?.run_id !== clean.run_id },
  );
  await writeRunResult(runDir, clean);
  if (machine) process.stdout.write(`${JSON.stringify(clean, null, 2)}\n`);
  else if (screen) process.stdout.write(`${screen}\n`);
  else process.stdout.write(`${clean.status}: ${clean.message ?? clean.workbook ?? "see run evidence"}\n`);
  return clean;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const { positional, options } = parseArgs(rawArgs);
  if (options["controller-diagnostic"] === true) {
    const diagnostic = {
      schema_version: "excel-inflow-private-controller-diagnostic/1.0",
      controller: "run_user_flow",
      status: "SCREEN",
      product_route_executed: false,
    };
    process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
    return diagnostic;
  }
  await consumeControllerHandoff({
    packageRoot: ROOT,
    parentController: VNEXT_CONTROLLER_FILE,
    childController: CONTROLLER_FILE,
    childArgs: rawArgs,
  });
  if (options.screen) {
    if (options.screen === true) {
      throw new Error("--screen requires a stage id");
    }
    const stage = String(options.screen);
    const companyPreflight = stage === "company"
      ? await assertCompanyScreenPreflight(options)
      : null;
    process.stdout.write(`${renderPresentationScreen(stage, companyPreflight)}\n`);
    return normaliseUserFlowResult({ status: "SCREEN", stage });
  }
  if ((!positional[0] && !options.carrier) || !options.out) {
    throw new Error(
      "Usage: run_user_flow.mjs <evidence-run.json> --out <run-dir> or " +
        "run_user_flow.mjs --carrier <run-carrier.json> --out <run-dir> " +
        "[--carrier-migration-receipt <receipt.json>] " +
        "[--broker-intake-choice <choice.json>] [--broker-confirmation <confirmation.json>] [--answers <answers.txt|json>] " +
        "[--python <python>] [--soffice <path>] " +
        "[--run-id <id>] [--workspace-token <token>] " +
        "[--stop-after <stage>] [--review-deliver | --review-change <text>] [--json], or " +
        "run_user_flow.mjs --screen <company|brokers|inputs|evidence_review|decisions|build_checks|delivery> " +
        "[private top-controller capability handoff]",
    );
  }
  const isolated = await assertRunRootOutsideSkill({ skillRoot: ROOT, runRoot: options.out });
  const runDir = isolated.run_root;
  // ONE persisted compute clock for the WHOLE user run: it survives chat
  // turns, resume, retry and host transition, so no stage and no new
  // invocation ever restarts the budget. When an outer controller is already
  // holding the clock it hands its ledger path down, so parent and child
  // charge the SAME file rather than keeping two clocks.
  const inheritedDeadlinePath = typeof options["run-deadline"] === "string"
    ? String(options["run-deadline"])
    : (process.env[RUN_DEADLINE_ENV] ?? null);
  // One budget policy, one ceiling: if the caller states a policy, the clock is
  // opened against THAT policy rather than a second copy of the defaults.
  let runBudgets = DEFAULT_RUNTIME_BUDGETS_MS;
  let runBudgetPolicy = null;
  if (options["runtime-budget-policy"]) {
    const declaredPolicy = await readJson(
      path.resolve(String(options["runtime-budget-policy"])),
      "runtime budget policy",
    );
    const policyErrors = validateRuntimeBudgetPolicy(declaredPolicy);
    if (policyErrors.length > 0) {
      throw new Error(`The stated runtime budget policy is invalid: ${policyErrors.join(", ")}.`);
    }
    runBudgetPolicy = declaredPolicy;
    runBudgets = declaredPolicy.budgets_ms;
  } else {
    runBudgetPolicy = resolveRuntimeBudgetPolicy();
  }
  const runDeadline = await openRunDeadline({
    runDir,
    ledgerPath: inheritedDeadlinePath,
    budgets: runBudgets,
    identity: {
      controllerVersion: FLOW_CONTROLLER_VERSION,
      policyDigest: runBudgetPolicy?.policy_sha256 ?? null,
      invocationLabel: "run_user_flow",
    },
  });
  ACTIVE_RUN_DEADLINE = runDeadline;
  ACTIVE_INVOCATION_SPAN = beginComputeSpan(runDeadline, "controller_invocation_overhead");
  if (options.carrier && positional[0]) {
    throw new Error("Provide either a positional evidence run or --carrier, not both.");
  }
  const explicitWorkspaceToken = options["workspace-token"] ?? process.env.EXCEL_INFLOW_WORKSPACE_TOKEN ?? null;
  if (options.carrier && !explicitWorkspaceToken) {
    throw new Error("--carrier requires --workspace-token or EXCEL_INFLOW_WORKSPACE_TOKEN.");
  }
  const workspaceToken = String(explicitWorkspaceToken ?? `workspace:${path.dirname(runDir)}`);
  let verifiedCarrier = null;
  let evidencePath;
  if (options.carrier) {
    const carrierPath = path.resolve(String(options.carrier));
    try {
      verifiedCarrier = await verifyRunCarrier({
        skillRoot: ROOT,
        runRoot: runDir,
        carrierPath,
        controllerVersion: FLOW_CONTROLLER_VERSION,
        workspaceToken,
        migrationReceiptPath:
          typeof options["carrier-migration-receipt"] === "string"
            ? path.resolve(options["carrier-migration-receipt"])
            : null,
      });
    } catch (error) {
      // One class of carrier failure is not a caller error and should not read
      // like one: the artifacts the run paused on no longer hash to what the
      // carrier recorded. Something edited the run while it waited. Until now
      // that arrived as an unhandled stack trace, which looks like a tooling
      // fault and invites a retry or a hand-repair, when it is a refusal and
      // needs to look like one - a named outcome the caller can act on.
      //
      // Everything else a carrier can get wrong - the wrong workspace token, a
      // rebound run identity, an unsupported controller version, a malformed
      // descriptor - is the caller holding the wrong carrier, and keeps its
      // existing hard failure.
      const mutation = /^Carrier file (\S+) hash does not match\.$/.exec(String(error.message));
      if (!mutation) throw error;
      const mutatedFile = mutation[1];
      const carrierRunId = await readJson(carrierPath, "run carrier")
        .then((carrier) => carrier?.run_id ?? null)
        .catch(() => null);
      const message =
        `run_case_mutated_during_pause: the run's ${mutatedFile} no longer hashes to what the carrier ` +
        `recorded at pause time. A run whose artifacts changed while it waited is a different run ` +
        `wearing the first one's receipts.`;
      const screen = renderFailure({
        stage: "inputs",
        what_failed: `The run's ${mutatedFile} changed while this run was paused.`,
        why: message,
        what_would_fix_it: [
          "Start a fresh run for the changed inputs; a paused run may only be continued on the exact artifacts its carrier was minted against.",
          "Serve side requests that arrive during a pause from a scratch copy, never by editing the run's own artifacts.",
        ],
      });
      return finish({
        runDir,
        screen,
        machine: options.json === true,
        result: {
          schema_version: "user-flow-run/1.0",
          controller_version: FLOW_CONTROLLER_VERSION,
          ...(carrierRunId ? { run_id: carrierRunId } : {}),
          status: "BLOCKED",
          stage: "inputs",
          outcome: "run_case_mutated_during_pause",
          blocker_class: "INTERNAL_WORK",
          message,
          reused_stages: [],
        },
      });
    }
    evidencePath = verifiedCarrier.files.evidence_run;
    if (!options.answers && verifiedCarrier.files.answers) options.answers = verifiedCarrier.files.answers;
    if (!options["broker-confirmation"] && verifiedCarrier.files.broker_confirmation) {
      options["broker-confirmation"] = verifiedCarrier.files.broker_confirmation;
    }
    if (!options["broker-intake-choice"] && verifiedCarrier.files.broker_intake_choice) {
      options["broker-intake-choice"] = verifiedCarrier.files.broker_intake_choice;
    }
    if (options["run-id"] && options["run-id"] !== verifiedCarrier.carrier.run_id) {
      throw new Error("--run-id does not match the verified run carrier.");
    }
    options["run-id"] = verifiedCarrier.carrier.run_id;
  } else {
    evidencePath = path.resolve(positional[0]);
  }
  const evidenceRun = await readJson(evidencePath, "evidence run");
  const runId = validateRunId(String(evidenceRun.run_id ?? ""));
  if (options["run-id"] && options["run-id"] !== runId) {
    throw new Error("--run-id must exactly match the validated evidence-run ID.");
  }
  await fs.mkdir(runDir, { recursive: true });
  const issuerIdentity = {
    name:
      evidenceRun.company_name ??
      evidenceRun.case_source?.identity?.issuer_name ??
      "Unknown issuer",
  };
  const identity = await initializeOrVerifyRunIdentity({
    skillRoot: ROOT,
    runRoot: runDir,
    runId,
    controllerVersion: FLOW_CONTROLLER_VERSION,
    workspaceToken,
    issuerIdentity,
  });
  const lease = await acquireRunLease(runDir, {
    owner: `run_user_flow:${runId}`,
    sessionId: workspaceToken,
  });
  const integrity = await captureRuntimeIntegrity(ROOT);
  ACTIVE_RUN_GUARD = { runDir, identity, lease, integrity };
  // The clock now learns WHICH RUN it is measuring. A ledger left in this
  // directory by another run is caught here: it is not adopted, and the compute
  // it recorded is carried forward as spent rather than returned.
  await bindRunDeadlineIdentity(runDeadline, { runId, sourceDigest: integrity.digest });
  // Re-baseline the invocation span against the (possibly carried-forward)
  // reading so the credit arithmetic cannot swallow this invocation's own time.
  ACTIVE_INVOCATION_SPAN = {
    ...ACTIVE_INVOCATION_SPAN,
    elapsed_at_start_ms: runDeadline.ledger.compute_elapsed_ms,
  };
  const reusedStages = [];
  // ONE derived executable closure, and ONE recipe binding through which every
  // stage receipt in this run is written or reused. The closure record is
  // persisted so the recipe in every receipt can be audited against the members
  // it was computed over.
  const runtimeClosure = await deriveStageRuntimeClosure({ skillRoot: ROOT, integrity });
  bindStageRecipes({
    closure: runtimeClosure,
    contractVersions: {
      runtime_integrity_schema: integrity.schema_version,
      runtime_budget_policy_schema: RUNTIME_BUDGET_POLICY_SCHEMA,
    },
  });
  await writeJsonAtomic(path.join(runDir, "stage-runtime-closure.json"), runtimeClosure);
  // P6.3 — the evidence half is a DECLARED work DAG. Every expensive
  // compilation in stages 1-3 runs as a named node with declared inputs,
  // declared outputs, a cache key and an invalidation rule, and every cache
  // decision records its reason (hit, miss with the component that moved, or
  // invalid with why) into stages/_work_graph/decisions.json. The graph reuses
  // stage 4's proven checkpoint() call shape verbatim and does NOT enact reuse:
  // hoisting this work behind its keys is P6.4's differential invalidation, and
  // a DAG that changed what is computed would not be additive. See
  // scripts/lib/evidence_work_graph.mjs.
  //
  // P6.4 wires the attempt ledger through it, and hoists the stage-3 reuse
  // check ABOVE the answered-case recompile and the decision replay so a run
  // that reports the decisions stage as reused has actually skipped them.
  const attemptLedger = createAttemptLedger({
    runDir,
    runId,
    controllerVersion: FLOW_CONTROLLER_VERSION,
    downstreamScope: (change) => earliestInvalidatedStage(change)?.id ?? null,
  });
  ACTIVE_ATTEMPT_LEDGER = attemptLedger;
  const workGraph = createEvidenceWorkGraph({
    runDir,
    runId,
    controllerVersion: FLOW_CONTROLLER_VERSION,
    runtimeDigest: runtimeClosure.digest,
    attemptLedger,
  });
  ACTIVE_WORK_GRAPH = workGraph;
  // The classification table, with its downstream-invalidation column computed
  // from the corrected CHANGE_INVALIDATION map rather than restated here.
  await writeJsonAtomic(path.join(runDir, "error-classification.json"), {
    schema_version: "error-classification/1.0",
    run_id: runId,
    controller_version: FLOW_CONTROLLER_VERSION,
    classes: errorClassificationTable({
      changeInvalidationStage: (change) => earliestInvalidatedStage(change)?.id ?? null,
    }),
  });
  const carrierMigrationInput = (stageId) =>
    runCarrierMigrationStageInput(verifiedCarrier, stageId);
  let brokerIntakeChoicePath = null;
  if (typeof options["broker-intake-choice"] === "string") {
    brokerIntakeChoicePath = path.resolve(options["broker-intake-choice"]);
    const brokerIntakeChoice = await readJson(
      brokerIntakeChoicePath,
      "broker intake choice",
    );
    const verifiedChoice = verifyBrokerIntakeChoice(brokerIntakeChoice, {
      run_id: runId,
    });
    if (!verifiedChoice.valid) {
      throw new Error(`Broker intake choice is invalid: ${verifiedChoice.errors[0]}`);
    }
  }

  // Stage 1 — validate the complete evidence envelope.
  // Every stage consults the SAME remaining budget before it runs.
  await enterFlowStage("inputs");
  const stage1Dir = path.join(runDir, "stages", "inputs");
  const stage1Validation = path.join(stage1Dir, "evidence-validation.json");
  const stage1Evidence = path.join(stage1Dir, "evidence-run.json");
  const stage1CaseSource = path.join(stage1Dir, "case-source.json");
  const stage1CaseEvidence = path.join(stage1Dir, "case-evidence.json");
  const stage1CompileReport = path.join(stage1Dir, "case-compile-report.json");
  let stage2BrokerConfirmation = null;
  await writeTextAtomic(stage1Evidence, await fs.readFile(evidencePath, "utf8"));
  await writeJsonAtomic(stage1CaseSource, evidenceRun.case_source ?? {});
  await writeJsonAtomic(stage1CaseEvidence, evidenceRun.case_evidence ?? {});
  async function persistCurrentCarrier(status, artifacts = {}) {
    return writeRunCarrier({
      skillRoot: ROOT,
      runRoot: runDir,
      runId,
      controllerVersion: FLOW_CONTROLLER_VERSION,
      workspaceToken,
      issuerIdentity,
      evidencePath: stage1Evidence,
      answersPath: typeof options.answers === "string" ? path.resolve(options.answers) : null,
      brokerIntakeChoicePath,
      brokerConfirmationPath: stage2BrokerConfirmation,
      status,
      artifacts,
    });
  }
  const stage1Inputs = {
    evidence_run: await hashFile(evidencePath),
    ...(brokerIntakeChoicePath
      ? { broker_intake_choice: await hashFile(brokerIntakeChoicePath) }
      : {}),
    runtime: runtimeClosure.digest,
    ...carrierMigrationInput("inputs"),
  };
  const stage1Outputs = {
    evidence_validation: stage1Validation,
    evidence_run: stage1Evidence,
    case_source: stage1CaseSource,
    case_evidence: stage1CaseEvidence,
    case_compile_report: stage1CompileReport,
  };
  const cached1 = await readUsableStage({
    runDir,
    runId,
    stageId: "inputs",
    inputHashes: stage1Inputs,
    previousReceiptHash: null,
    outputs: stage1Outputs,
  });
  let validation;
  let receipt1;
  if (cached1.reusable) {
    validation = await readJson(stage1Validation, "cached evidence validation");
    receipt1 = cached1.receipt;
    reusedStages.push("inputs");
    await workGraph.reuseStage("inputs");
  } else {
    validation = (await workGraph.runNode({
      id: "evidence_validation",
      recipe: "evidence-validation/1.0",
      inputs: { evidence_run: stage1Inputs.evidence_run },
      outputs: {
        evidence_validation: stage1Validation,
        case_compile_report: stage1CompileReport,
      },
      action: () => validateEvidenceRun(evidenceRun),
    })).value;
    await writeJsonAtomic(stage1Validation, serialisable(validation));
    await writeJsonAtomic(
      stage1CompileReport,
      validation.case_compile_report ?? {
        schema_version: "case-compile-report/1.0",
        status: "findings",
        counts: { total: 1, block: 1, warn: 0 },
        findings: [{
          id: "case_compile.not_run",
          severity: "BLOCK",
          message: "The case compiler did not produce a report.",
        }],
      },
    );
    if (!validation.ok) {
      const errors = validation.errors.map((entry) => entry.message);
      const screen = renderFailure({
        stage: "evidence",
        what_failed: `I cannot start: ${errors[0] ?? "the evidence run is invalid"}`,
        why: errors.length > 1 ? `${errors.length - 1} other evidence problems were found.` : null,
        what_would_fix_it: errors,
      });
      receipt1 = await persistStage({
        runDir,
        runId,
        stageId: "inputs",
        status: "blocked",
        inputHashes: stage1Inputs,
        previousReceiptHash: null,
        outputs: stage1Outputs,
        detail: { errors },
      });
      return finish({
        runDir,
        screen,
        machine: options.json === true,
        result: {
          schema_version: "user-flow-run/1.0",
          controller_version: FLOW_CONTROLLER_VERSION,
          run_id: runId,
          status: "BLOCKED",
          stage: "inputs",
          outcome: "bad_evidence",
          blocker_class: "INTERNAL_WORK",
          message: errors[0] ?? "Evidence validation failed.",
          receipt: receipt1,
          reused_stages: reusedStages,
        },
      });
    }
    receipt1 = await persistStage({
      runDir,
      runId,
      stageId: "inputs",
      status: "success",
      inputHashes: stage1Inputs,
      previousReceiptHash: null,
      outputs: stage1Outputs,
    });
  }
  if (options["stop-after"] === "inputs") {
    return finish({
      runDir,
      screen: renderEvidenceReviewProgress(evidenceRun),
      machine: options.json === true,
      result: {
        schema_version: "user-flow-run/1.0",
        controller_version: FLOW_CONTROLLER_VERSION,
        run_id: runId,
        status: "PAUSED",
        stage: "inputs",
        next_stage: nextStageId("inputs"),
        reused_stages: reusedStages,
      },
    });
  }

  // Stage 2 — reconcile evidence. The receipt is bound to Stage 1 and to the
  // complete result file, so an interrupted run can resume without silently
  // changing its question set or its reconciled case.
  await enterFlowStage("evidence_review");
  const stage2Dir = path.join(runDir, "stages", "evidence_review");
  const stage2Result = path.join(stage2Dir, "intake-result.json");
  const brokerPreviewPath = path.join(stage2Dir, "broker-preview.json");
  const brokerPreviewScreenPath = path.join(stage2Dir, "broker-preview.txt");
  const brokerPackArtifactPath = path.join(stage2Dir, "broker-pack.json");
  const brokerSourceTablesArtifactPath = path.join(
    stage2Dir,
    "broker-source-tables.json",
  );
  const brokerCrosswalkReceiptArtifactPath = path.join(
    stage2Dir,
    "broker-crosswalk-receipt.json",
  );
  const brokerConfirmationTemplatePath = path.join(
    stage2Dir,
    "broker-confirmation-template.json",
  );
  const brokerConfirmationPath = path.join(stage2Dir, "broker-confirmation.json");
  const brokerSelectedCaseEvidencePath = path.join(
    stage2Dir,
    "broker-selected-case-evidence.json",
  );
  const brokerSelectedCompileReportPath = path.join(
    stage2Dir,
    "broker-selected-case-compile-report.json",
  );
  let activeCaseEvidence = validation.handoff.case_evidence;
  let activeCaseCompileReport = validation.handoff.case_compile_report;
  let activeModelCase = validation.handoff.model_case;
  let brokerSelectedCompilation = null;
  const productionBrokerPreviewRequired = Boolean(
    evidenceRun.ingress?.broker_evidence ||
    evidenceRun.broker_pack?.recommended_primary_house_id ||
    (evidenceRun.broker_pack?.houses ?? []).length > 0,
  );
  let brokerPreview = null;
  let brokerPreviewValidation = null;
  let brokerConfirmation = null;
  let brokerConfirmationCheck = null;
  if (productionBrokerPreviewRequired) {
    const brokerState =
      evidenceRun.case_evidence?.lanes?.broker_evidence?.controller_state ?? {};
    const brokerIngress = evidenceRun.ingress?.broker_evidence ?? {};
    const brokerBindingHashes = {
      broker_pack_sha256:
        brokerState.artifact_sha256?.broker_pack ??
        hashValue(evidenceRun.broker_pack ?? null),
      broker_source_tables_sha256:
        brokerIngress.source_tables_sha256 ??
        brokerState.artifact_sha256?.source_tables ??
        hashValue(evidenceRun.broker_source_tables ?? null),
      broker_crosswalk_receipt_sha256:
        brokerIngress.crosswalk_receipt_sha256 ??
        brokerState.artifact_sha256?.broker_crosswalk_receipt ??
        hashValue(evidenceRun.broker_crosswalk_receipt ?? null),
    };
    const fallbackBrokerPreview = (reasons) => {
      assertBrokerFailureDegrades("broker_preview_failure");
      try {
        return compileBrokerForecastWaterfallFallback({
          brokerPack: evidenceRun.broker_pack,
          sourceTables: evidenceRun.broker_source_tables,
          crosswalkReceipt: evidenceRun.broker_crosswalk_receipt,
          bindingHashes: brokerBindingHashes,
          reasons,
        });
      } catch (error) {
        return compileEmergencyZeroBrokerPreview({
          bindingHashes: brokerBindingHashes,
          forecastPeriods: evidenceRun.broker_pack?.forecast_periods ?? [],
          reasons: [
            ...reasons,
            `Forecast-waterfall preview compilation also failed internally: ${error.message}`,
          ],
        });
      }
    };
    try {
      brokerPreview = (await workGraph.runNode({
        id: "broker_preview",
        recipe: "broker-preview/1.0",
        inputs: {
          broker_pack: brokerBindingHashes.broker_pack_sha256,
          broker_source_tables: brokerBindingHashes.broker_source_tables_sha256,
          broker_crosswalk_receipt: brokerBindingHashes.broker_crosswalk_receipt_sha256,
        },
        outputs: { broker_preview: brokerPreviewPath },
        action: () => compileBrokerPreview({
          brokerPack: evidenceRun.broker_pack,
          sourceTables: evidenceRun.broker_source_tables,
          crosswalkReceipt: evidenceRun.broker_crosswalk_receipt,
          bindingHashes: brokerBindingHashes,
        }),
      })).value;
    } catch (error) {
      brokerPreview = fallbackBrokerPreview([
        `Primary-house preview compilation failed internally: ${error.message}`,
      ]);
    }
    await writeJsonAtomic(brokerPackArtifactPath, evidenceRun.broker_pack);
    await writeJsonAtomic(
      brokerSourceTablesArtifactPath,
      evidenceRun.broker_source_tables ?? null,
    );
    await writeJsonAtomic(
      brokerCrosswalkReceiptArtifactPath,
      evidenceRun.broker_crosswalk_receipt ?? null,
    );
    brokerPreviewValidation = validateBrokerPreview(brokerPreview);
    if (brokerPreview.status !== "PASS" || !brokerPreviewValidation.valid) {
      brokerPreview = fallbackBrokerPreview([
        ...(brokerPreview.violations ?? []),
        ...(brokerPreviewValidation.violations ?? []),
      ]);
      brokerPreviewValidation = validateBrokerPreview(brokerPreview);
    }
    await writeJsonAtomic(brokerPreviewPath, brokerPreview);
    await writeTextAtomic(
      brokerPreviewScreenPath,
      `${renderBrokerPreviewScreen(brokerPreview)}\n`,
    );
    await writeJsonAtomic(brokerConfirmationTemplatePath, {
      schema_version: "broker-preview-confirmation/1.0",
      preview_sha256: brokerPreview.preview_sha256,
      selected_house_id:
        brokerPreview.recommended_primary_house_id ?? "FORECAST_WATERFALL",
      confirmed: true,
    });
    if (typeof options["broker-confirmation"] === "string") {
      brokerConfirmation = await readJson(
        options["broker-confirmation"],
        "broker confirmation",
      );
    } else if (brokerPreview.status === "PASS" && brokerPreviewValidation.valid) {
      // Broker handling is one automatic evidence step. The deterministic
      // recommendation is accepted internally; if no coherent house exists,
      // the ordinary forecast waterfall is selected. A user confirmation is
      // accepted only as an optional explicit override, never as a mandatory
      // extra broker stage.
      brokerConfirmation = automaticBrokerPreviewConfirmation(brokerPreview);
    }
    if (brokerConfirmation) {
      brokerConfirmationCheck = verifyBrokerPreviewConfirmation(
        brokerPreview,
        brokerConfirmation,
      );
      if (!brokerConfirmationCheck.valid) {
        // A malformed optional override must never resurrect a separate
        // broker-confirmation stage. Keep the deterministic clean selection
        // (or forecast-waterfall fallback) and preserve the rejected override
        // only as an internal audit detail.
        const rejectedErrors = [...(brokerConfirmationCheck.errors ?? [])];
        brokerConfirmation = automaticBrokerPreviewConfirmation(brokerPreview);
        brokerConfirmationCheck = verifyBrokerPreviewConfirmation(
          brokerPreview,
          brokerConfirmation,
        );
        brokerConfirmationCheck.rejected_optional_override_errors = rejectedErrors;
      }
    }
    if (brokerConfirmationCheck?.valid) {
      await writeJsonAtomic(brokerConfirmationPath, brokerConfirmation);
      stage2BrokerConfirmation = brokerConfirmationPath;
      const brokerProjection = applyBrokerPreviewSelectionToCaseEvidence(
        validation.handoff.case_evidence,
        brokerPreview,
        brokerConfirmation,
      );
      activeCaseEvidence = brokerProjection.case_evidence;
      brokerSelectedCompilation = (await workGraph.runNode({
        id: "broker_selected_case_compile",
        recipe: "broker-selected-case-compile/1.0",
        inputs: {
          case_source: hashValue(validation.handoff.case_source ?? null),
          case_evidence: hashValue(activeCaseEvidence ?? null),
        },
        outputs: {
          model_case: brokerSelectedCaseEvidencePath,
          case_compile_report: brokerSelectedCompileReportPath,
        },
        action: () => compileCase(validation.handoff.case_source, activeCaseEvidence),
      })).value;
      activeCaseCompileReport = brokerSelectedCompilation.report;
      activeModelCase = brokerSelectedCompilation.model_case;
      if (
        brokerSelectedCompilation.report?.status !== "clean" &&
        brokerPreview.selection_mode === "primary_house"
      ) {
        const failedSelectionFindings = (
          brokerSelectedCompilation.report?.findings ?? []
        )
          .filter((entry) => entry.severity === "BLOCK")
          .map((entry) => entry.message);
        brokerPreview = fallbackBrokerPreview([
          "The selected coherent broker house did not compile cleanly and was removed from model authority.",
          ...failedSelectionFindings,
        ]);
        brokerPreviewValidation = validateBrokerPreview(brokerPreview);
        brokerConfirmation = automaticBrokerPreviewConfirmation(brokerPreview);
        brokerConfirmationCheck = verifyBrokerPreviewConfirmation(
          brokerPreview,
          brokerConfirmation,
        );
        await writeJsonAtomic(brokerPreviewPath, brokerPreview);
        await writeTextAtomic(
          brokerPreviewScreenPath,
          `${renderBrokerPreviewScreen(brokerPreview)}\n`,
        );
        await writeJsonAtomic(brokerConfirmationPath, brokerConfirmation);
        const fallbackProjection = applyBrokerPreviewSelectionToCaseEvidence(
          validation.handoff.case_evidence,
          brokerPreview,
          brokerConfirmation,
        );
        activeCaseEvidence = fallbackProjection.case_evidence;
        brokerSelectedCompilation = compileCase(
          validation.handoff.case_source,
          activeCaseEvidence,
        );
        activeCaseCompileReport = brokerSelectedCompilation.report;
        activeModelCase = brokerSelectedCompilation.model_case;
      }
      await writeJsonAtomic(brokerSelectedCaseEvidencePath, activeCaseEvidence);
      await writeJsonAtomic(
        brokerSelectedCompileReportPath,
        activeCaseCompileReport,
      );
    }
  }
  if (
    brokerSelectedCompilation &&
    brokerSelectedCompilation.report?.status !== "clean"
  ) {
    assertBrokerFailureDegrades("broker_semantic_failure");
    const blocks = (brokerSelectedCompilation.report?.findings ?? []).filter(
      (entry) => entry.severity === "BLOCK",
    );
    brokerPreview = compileEmergencyZeroBrokerPreview({
      bindingHashes: {
        broker_pack_sha256: hashValue(evidenceRun.broker_pack ?? null),
        broker_source_tables_sha256: hashValue(evidenceRun.broker_source_tables ?? null),
        broker_crosswalk_receipt_sha256: hashValue(evidenceRun.broker_crosswalk_receipt ?? null),
      },
      forecastPeriods: evidenceRun.broker_pack?.forecast_periods ?? [],
      reasons: [
        "The broker-selected case failed compilation and was removed from model authority.",
        ...blocks.map((entry) => entry.message),
      ],
    });
    brokerPreviewValidation = validateBrokerPreview(brokerPreview);
    brokerConfirmation = automaticBrokerPreviewConfirmation(brokerPreview);
    brokerConfirmationCheck = verifyBrokerPreviewConfirmation(
      brokerPreview,
      brokerConfirmation,
    );
    await writeJsonAtomic(brokerPreviewPath, brokerPreview);
    await writeTextAtomic(
      brokerPreviewScreenPath,
      `${renderBrokerPreviewScreen(brokerPreview)}\n`,
    );
    await writeJsonAtomic(brokerConfirmationPath, brokerConfirmation);
    stage2BrokerConfirmation = brokerConfirmationPath;
    const zeroProjection = projectZeroBrokerAuthorityCaseEvidence(
      validation.handoff.case_evidence,
    );
    activeCaseEvidence = zeroProjection.case_evidence;
    const zeroCompilation = compileCase(
      validation.handoff.case_source,
      activeCaseEvidence,
    );
    if (zeroCompilation.report?.status === "clean") {
      brokerSelectedCompilation = zeroCompilation;
      activeCaseCompileReport = zeroCompilation.report;
      activeModelCase = zeroCompilation.model_case;
    } else {
      // The mandatory evidence case already passed Stage 1. A later optional
      // broker adapter must not be able to invalidate it. Remove broker wiring
      // from that sealed model and let the executable forecast resolver select
      // the next lawful rung during Stage 3.
      brokerSelectedCompilation = null;
      activeCaseEvidence = validation.handoff.case_evidence;
      activeCaseCompileReport = validation.handoff.case_compile_report;
      activeModelCase = applyBrokerPreviewSelection(
        structuredClone(validation.handoff.model_case),
        brokerPreview,
        brokerConfirmation,
      );
    }
    await writeJsonAtomic(brokerSelectedCaseEvidencePath, activeCaseEvidence);
    await writeJsonAtomic(
      brokerSelectedCompileReportPath,
      activeCaseCompileReport,
    );
  }
  const stage2Inputs = {
    stage1_receipt: receipt1.receipt_hash,
    evidence_validation: await hashFile(stage1Validation),
    broker_confirmation:
      productionBrokerPreviewRequired && stage2BrokerConfirmation
        ? await hashFile(stage2BrokerConfirmation)
        : hashValue({ pending: productionBrokerPreviewRequired }),
    runtime: runtimeClosure.digest,
    ...carrierMigrationInput("evidence_review"),
  };
  const stage2Outputs = {
    intake_result: stage2Result,
    ...(productionBrokerPreviewRequired
      ? {
          broker_preview: brokerPreviewPath,
          broker_preview_screen: brokerPreviewScreenPath,
          broker_pack: brokerPackArtifactPath,
          broker_source_tables: brokerSourceTablesArtifactPath,
          broker_crosswalk_receipt: brokerCrosswalkReceiptArtifactPath,
          broker_confirmation_template: brokerConfirmationTemplatePath,
          ...(stage2BrokerConfirmation
            ? {
                broker_confirmation: stage2BrokerConfirmation,
                broker_selected_case_evidence: brokerSelectedCaseEvidencePath,
                broker_selected_compile_report: brokerSelectedCompileReportPath,
              }
            : {}),
        }
      : {}),
  };
  const cached2 = await readUsableStage({
    runDir,
    runId,
    stageId: "evidence_review",
    inputHashes: stage2Inputs,
    previousReceiptHash: receipt1.receipt_hash,
    outputs: stage2Outputs,
  });
  let receipt2;
  // P6.2: ONE stage-3 input shape. The blocked and action-required paths used to
  // key on `{ stage2_receipt }` or `{ stage2_receipt, answers }` while the
  // success path keyed on four components, so a stage-3 miss could never be
  // explained against the receipt that preceded it — the two keys were not
  // comparable. Every stage-3 receipt is now keyed identically; only the
  // `answers` component varies, and it varies over NAMED states.
  const ANSWERS_NOT_SUPPLIED = hashValue({ answers: "not_supplied" });
  const ANSWERS_NOT_REQUIRED = hashValue({ answers: "not_required" });
  const stage3InputsFor = (answers) => ({
    stage2_receipt: receipt2.receipt_hash,
    answers,
    runtime: runtimeClosure.digest,
    ...carrierMigrationInput("decisions"),
  });
  const freshIntakeResult = (await workGraph.runNode({
    id: "intake_plan",
    recipe: "intake-decision-plan/1.0",
    inputs: {
      intake: hashValue(serialisable(validation.handoff.intake ?? null)),
      draft_case: hashValue(serialisable(activeModelCase ?? null)),
    },
    outputs: { intake_result: stage2Result },
    action: () => runIntake({
      intake: validation.handoff.intake,
      draftCase: activeModelCase,
    }),
  })).value;
  if (brokerConfirmationCheck?.valid && !stoppedOutcome(freshIntakeResult.outcome)) {
    applyBrokerPreviewSelection(
      freshIntakeResult.working_case,
      brokerPreview,
      brokerConfirmation,
    );
  }
  let intakeResult = freshIntakeResult;
  if (cached2.reusable) {
    const cachedSummary = await readJson(stage2Result, "cached intake result");
    if (hashValue(cachedSummary) === hashValue(serialisable(freshIntakeResult))) {
      // Keep the fresh object because its option handlers are functions and
      // therefore cannot survive JSON. The receipt proves its serialisable
      // decision plan is byte-equivalent to the persisted prior run.
      receipt2 = cached2.receipt;
      reusedStages.push("evidence_review");
      await workGraph.reuseStage("evidence_review");
    } else {
      await writeJsonAtomic(stage2Result, serialisable(freshIntakeResult));
    }
  } else {
    await writeJsonAtomic(stage2Result, serialisable(freshIntakeResult));
  }
  if (stoppedOutcome(intakeResult.outcome)) {
    const stoppedStage = stageForOutcome(intakeResult.outcome);
    if (stoppedStage === "inputs") {
      // Structural evidence validation succeeded, but the intake contract did
      // not. Replace the provisional Stage-1 success with the authoritative
      // blocked receipt so no downstream stage can reuse a false success.
      receipt1 = await persistStage({
        runDir,
        runId,
        stageId: "inputs",
        status: "blocked",
        inputHashes: stage1Inputs,
        previousReceiptHash: null,
        outputs: {
          evidence_validation: stage1Validation,
          intake_result: stage2Result,
        },
        detail: { outcome: intakeResult.outcome },
      });
      const result = {
        schema_version: "user-flow-run/1.0",
        controller_version: FLOW_CONTROLLER_VERSION,
        run_id: runId,
        status: "BLOCKED",
        stage: stoppedStage,
        outcome: intakeResult.outcome,
        blocker_class: blockerForStoppedOutcome(intakeResult.outcome),
        receipt: receipt1,
        reused_stages: reusedStages,
      };
      return finish({ runDir, result, screen: intakeResult.screen, machine: options.json === true });
    }
    receipt2 = await persistStage({
      runDir,
      runId,
      stageId: "evidence_review",
      status: stoppedStage === "evidence_review" ? "blocked" : "success",
      inputHashes: stage2Inputs,
      previousReceiptHash: receipt1.receipt_hash,
      outputs: stage2Outputs,
      detail: { outcome: intakeResult.outcome },
    });
    if (stoppedStage === "decisions") {
      const stage3Dir = path.join(runDir, "stages", "decisions");
      const stage3Result = path.join(stage3Dir, "decision-result.json");
      await writeJsonAtomic(stage3Result, serialisable(intakeResult));
      // TOC.D crossing (1): a decision-graph failure is INTERNAL_WORK
      // (blockerForStoppedOutcome), and the workflow-state contract admits
      // ACTION_REQUIRED only with USER_DECISION. An internal decision-graph
      // failure therefore surfaces as the internal-owned BLOCKED state the
      // delivery-blocker constitution already binds (equation_system_unsolved,
      // equation_graph) — never as a user-owned question. The registry lists
      // "graph failure" as an explicitly illegal ACTION_REQUIRED cause.
      const internalDecisionFailure =
        blockerForStoppedOutcome(intakeResult.outcome) === "INTERNAL_WORK";
      const receipt3 = await persistStage({
        runDir,
        runId,
        stageId: "decisions",
        status: internalDecisionFailure ? "blocked" : "action_required",
        inputHashes: stage3InputsFor(ANSWERS_NOT_SUPPLIED),
        previousReceiptHash: receipt2.receipt_hash,
        outputs: { decision_result: stage3Result },
        detail: { outcome: intakeResult.outcome },
      });
      const decisionStopResult = internalDecisionFailure
        ? {
          schema_version: "user-flow-run/1.0",
          controller_version: FLOW_CONTROLLER_VERSION,
          run_id: runId,
          status: "BLOCKED",
          stage: "decisions",
          outcome: intakeResult.outcome,
          blocker_class: "INTERNAL_WORK",
          typed_internal_outcome: {
            reason_code: "INTERNAL.equation_system_unsolved",
            earliest_responsible_layer: "decision_graph",
            downstream_invalidation_scope: "decisions_stage_and_descendants",
            outcome: intakeResult.outcome,
            detail: serialisable(
              intakeResult.replay?.invalid ?? intakeResult.plan?.blocked ?? null,
            ),
          },
          receipt: receipt3,
          reused_stages: reusedStages,
        }
        : {
          schema_version: "user-flow-run/1.0",
          controller_version: FLOW_CONTROLLER_VERSION,
          run_id: runId,
          status: "ACTION_REQUIRED",
          stage: "decisions",
          outcome: intakeResult.outcome,
          blocker_class: blockerForStoppedOutcome(intakeResult.outcome),
          receipt: receipt3,
          reused_stages: reusedStages,
        };
      return finish({
        runDir,
        screen: intakeResult.screen,
        machine: options.json === true,
        result: decisionStopResult,
      });
    }
    return finish({
      runDir,
      screen: intakeResult.screen,
      machine: options.json === true,
      result: {
        schema_version: "user-flow-run/1.0",
        controller_version: FLOW_CONTROLLER_VERSION,
        run_id: runId,
        status: "BLOCKED",
        stage: "evidence_review",
        outcome: intakeResult.outcome,
        blocker_class: blockerForStoppedOutcome(intakeResult.outcome),
        receipt: receipt2,
        reused_stages: reusedStages,
      },
    });
  }
  if (
    productionBrokerPreviewRequired &&
    (brokerPreview.status !== "PASS" || !brokerPreviewValidation?.valid)
  ) {
    assertBrokerFailureDegrades("broker_preview_failure");
    brokerPreview = compileEmergencyZeroBrokerPreview({
      bindingHashes: {
        broker_pack_sha256: hashValue(evidenceRun.broker_pack ?? null),
        broker_source_tables_sha256: hashValue(evidenceRun.broker_source_tables ?? null),
        broker_crosswalk_receipt_sha256: hashValue(evidenceRun.broker_crosswalk_receipt ?? null),
      },
      forecastPeriods: evidenceRun.broker_pack?.forecast_periods ?? [],
      reasons: ["The broker preview validator failed; zero broker authority was selected."],
    });
    brokerPreviewValidation = validateBrokerPreview(brokerPreview);
  }
  if (productionBrokerPreviewRequired && !brokerConfirmationCheck?.valid) {
    assertBrokerFailureDegrades("broker_preview_failure");
    brokerConfirmation = automaticBrokerPreviewConfirmation(brokerPreview);
    brokerConfirmationCheck = verifyBrokerPreviewConfirmation(
      brokerPreview,
      brokerConfirmation,
    );
    await writeJsonAtomic(brokerConfirmationPath, brokerConfirmation);
    stage2BrokerConfirmation = brokerConfirmationPath;
  }
  if (!receipt2) {
    receipt2 = await persistStage({
      runDir,
      runId,
      stageId: "evidence_review",
      status: "success",
      inputHashes: stage2Inputs,
      previousReceiptHash: receipt1.receipt_hash,
      outputs: stage2Outputs,
    });
  }
  if (options["stop-after"] === "evidence_review") {
    return finish({
      runDir,
      screen: renderCompletionScreen("evidence_review"),
      machine: options.json === true,
      result: {
        schema_version: "user-flow-run/1.0",
        controller_version: FLOW_CONTROLLER_VERSION,
        run_id: runId,
        status: "PAUSED",
        stage: "evidence_review",
        next_stage: nextStageId("evidence_review"),
        reused_stages: reusedStages,
      },
    });
  }

  // Stage 3 — zero questions skips; otherwise one supplied answer file settles
  // the complete question set. No default may answer a question that was shown.
  await enterFlowStage("decisions");
  const stage3Dir = path.join(runDir, "stages", "decisions");
  const answeredCasePath = path.join(stage3Dir, "model-case.json");
  const answeredCaseSourcePath = path.join(stage3Dir, "case-source.json");
  const answeredCompileReportPath = path.join(stage3Dir, "case-compile-report.json");
  const forecastPlanPath = path.join(stage3Dir, "forecast-plan.txt");
  const forecastPlanJsonPath = path.join(stage3Dir, "forecast-plan.json");
  const forecastBehaviorPath = path.join(stage3Dir, "forecast-behavior-map.json");
  const modelDemandGraphPath = path.join(stage3Dir, "model-demand-graph.json");
  const selectedAuthorityContractPath = path.join(stage3Dir, "selected-authority-contract.json");
  const runConstitutionGraphPath = path.join(stage3Dir, "run-constitution-graph.json");
  let answeredCase;
  // P6.4 — THE HOIST.
  //
  // The stage-3 reuse check used to sit BELOW the answered-case recompile and
  // the decision replay, so a warm run recompiled the case and replayed every
  // recorded decision, threw both results away, read the cached model case off
  // disk, and then reported the decisions stage as REUSED. Measured on the
  // acquisition fixture: 228ms of work inside a stage the run said it had
  // reused, on every warm run, for ever.
  //
  // Nothing forced that order. Stage 3's cache key is `{ stage2_receipt,
  // answers, runtime, carrier }` — the stage-2 receipt hash, the ANSWER FILE's
  // hash, the runtime closure digest and the carrier migration input. Not one
  // of those four needs the recompile or the replay to exist: the answer file
  // can be hashed straight off disk. So the key is computed first, the reuse
  // check is asked first, and the recompile and the replay run only when the
  // answer is that the stage must re-run.
  //
  // Two things make this safe rather than merely faster. The receipt is only
  // resumable when its status is `success`, so a stage that stopped for
  // questions or blocked on an incomplete answer file can never be skipped
  // here — those exits keep their original position, above the check. And the
  // work being skipped is work whose result the reuse path already discarded:
  // `answeredCase` was read from the cached `model-case.json` either way. The
  // warm-equals-cold proof in run_differential_invalidation_tests.mjs is the
  // evidence, not the argument.
  let answerHash;
  if (intakeResult.outcome === "questions") {
    answerHash = options.answers
      ? await hashFile(path.resolve(options.answers))
      : ANSWERS_NOT_SUPPLIED;
  } else {
    answerHash = ANSWERS_NOT_REQUIRED;
  }
  const stage3Inputs = stage3InputsFor(answerHash);
  const stage3Outputs = {
    model_case: answeredCasePath,
    forecast_plan: forecastPlanPath,
    forecast_plan_json: forecastPlanJsonPath,
    forecast_behavior_map: forecastBehaviorPath,
    model_demand_graph: modelDemandGraphPath,
    selected_authority_contract: selectedAuthorityContractPath,
    run_constitution_graph: runConstitutionGraphPath,
    case_source: answeredCaseSourcePath,
    case_compile_report: answeredCompileReportPath,
  };
  const cached3 = await readUsableStage({
    runDir,
    runId,
    stageId: "decisions",
    inputHashes: stage3Inputs,
    previousReceiptHash: receipt2.receipt_hash,
    outputs: stage3Outputs,
  });
  if (!cached3.reusable && intakeResult.outcome === "questions") {
    if (!options.answers) {
      const questionResult = path.join(stage3Dir, "question-result.json");
      const questionScreen = path.join(stage3Dir, "question-screen.txt");
      await writeJsonAtomic(questionResult, serialisable(intakeResult));
      await writeTextAtomic(questionScreen, `${intakeResult.screen}\n`);
      const receipt3 = await persistStage({
        runDir,
        runId,
        stageId: "decisions",
        status: "action_required",
        inputHashes: stage3InputsFor(ANSWERS_NOT_SUPPLIED),
        previousReceiptHash: receipt2.receipt_hash,
        outputs: { question_result: questionResult, question_screen: questionScreen },
        detail: { question_count: intakeResult.plan.questions.length },
      });
      const carrier = await persistCurrentCarrier("AWAITING_DECISIONS", {
        case_source: stage1CaseSource,
        case_compile_report: stage1CompileReport,
      });
      return finish({
        runDir,
        screen: intakeResult.screen,
        machine: options.json === true,
        result: {
          schema_version: "user-flow-run/1.0",
          controller_version: FLOW_CONTROLLER_VERSION,
          run_id: runId,
          status: "ACTION_REQUIRED",
          stage: "decisions",
          // The flow is asking the user to settle displayed questions, so the
          // question path is USER_DECISION. The class was simply absent, which
          // told the user to act while declaring no owner for the ask.
          blocker_class: "USER_DECISION",
          question_count: intakeResult.plan.questions.length,
          carrier: carrier.path,
          evidence_run: stage1Evidence,
          receipt: receipt3,
          reused_stages: reusedStages,
        },
      });
    }
    const parsed = await loadAnswers(options.answers, intakeResult.plan.questions);
    if (!parsed.complete || parsed.errors.length > 0) {
      const screen = renderFailure({
        stage: "questions",
        what_failed: "The answer file does not settle every displayed question.",
        why: null,
        what_would_fix_it: parsed.errors,
      });
      const answerFailure = path.join(stage3Dir, "answer-errors.json");
      await writeJsonAtomic(answerFailure, parsed.errors);
      const receipt3 = await persistStage({
        runDir,
        runId,
        stageId: "decisions",
        status: "blocked",
        inputHashes: stage3InputsFor(await hashFile(path.resolve(options.answers))),
        previousReceiptHash: receipt2.receipt_hash,
        outputs: { answer_errors: answerFailure },
        detail: { errors: parsed.errors },
      });
      return finish({
        runDir,
        screen,
        machine: options.json === true,
        result: {
          schema_version: "user-flow-run/1.0",
          controller_version: FLOW_CONTROLLER_VERSION,
          run_id: runId,
          status: "ACTION_REQUIRED",
          stage: "decisions",
          outcome: "answers_incomplete",
          blocker_class: "USER_DECISION",
          receipt: receipt3,
          reused_stages: reusedStages,
        },
      });
    }
    const applied = applyAnswers({
      workingCase: intakeResult.working_case,
      plan: intakeResult.plan,
      answers: parsed.answers,
    });
    const answeredCaseSource = caseSourceWithRecordedAnswers(
      validation.handoff.case_source,
      applied.applied,
    );
    const recompilation = (await workGraph.runNode({
      id: "answered_case_recompile",
      recipe: "answered-case-compile/1.0",
      inputs: {
        answered_case_source: hashValue(answeredCaseSource ?? null),
        case_evidence: hashValue(activeCaseEvidence ?? null),
      },
      outputs: {
        model_case: answeredCaseSourcePath,
        case_compile_report: answeredCompileReportPath,
      },
      action: () => compileCase(answeredCaseSource, activeCaseEvidence),
    })).value;
    await writeJsonAtomic(answeredCaseSourcePath, answeredCaseSource);
    await writeJsonAtomic(answeredCompileReportPath, recompilation.report);
    if (recompilation.report.status !== "clean") {
      const blocks = (recompilation.report.findings ?? []).filter(
        (entry) => entry.severity === "BLOCK",
      );
      const failurePath = path.join(stage3Dir, "case-recompile-failure.json");
      await writeJsonAtomic(failurePath, {
        blocker_class: "INTERNAL_WORK",
        findings: blocks,
      });
      const receipt3 = await persistStage({
        runDir,
        runId,
        stageId: "decisions",
        status: "blocked",
        inputHashes: stage3InputsFor(await hashFile(path.resolve(options.answers))),
        previousReceiptHash: receipt2.receipt_hash,
        outputs: {
          case_source: answeredCaseSourcePath,
          case_compile_report: answeredCompileReportPath,
          compile_failure: failurePath,
        },
        detail: { blocker_class: "INTERNAL_WORK", block_count: blocks.length },
      });
      return finish({
        runDir,
        screen: renderFailure({
          stage: "decisions",
          what_failed: "The recorded decisions did not recompile into a clean case.",
          why: "This is an internal compiler finding, not a request to replace the evidence pack.",
          what_would_fix_it: blocks.slice(0, 5).map((entry) => entry.message),
        }),
        machine: options.json === true,
        result: {
          schema_version: "user-flow-run/1.0",
          controller_version: FLOW_CONTROLLER_VERSION,
          run_id: runId,
          status: "BLOCKED",
          stage: "decisions",
          outcome: "case_recompile_blocked",
          blocker_class: "INTERNAL_WORK",
          receipt: receipt3,
          reused_stages: reusedStages,
        },
      });
    }
    const replayedIntake = (await workGraph.runNode({
      id: "intake_replay",
      recipe: "intake-decision-replay/1.0",
      inputs: {
        intake: hashValue(serialisable(validation.handoff.intake ?? null)),
        recompiled_case: hashValue(serialisable(recompilation.model_case ?? null)),
        prior_answers: hashValue([...recordedDecisionMap(answeredCaseSource)]),
      },
      outputs: { intake_result: path.join(stage3Dir, "question-result.json") },
      action: () => runIntake({
        intake: validation.handoff.intake,
        draftCase: recompilation.model_case,
        priorAnswers: recordedDecisionMap(answeredCaseSource),
      }),
    })).value;
    if (brokerConfirmationCheck?.valid && !stoppedOutcome(replayedIntake.outcome)) {
      applyBrokerPreviewSelection(
        replayedIntake.working_case,
        brokerPreview,
        brokerConfirmation,
      );
    }
    if (replayedIntake.outcome === "questions") {
      const pendingResult = path.join(stage3Dir, "question-result.json");
      const pendingScreen = path.join(stage3Dir, "question-screen.txt");
      await writeJsonAtomic(pendingResult, serialisable(replayedIntake));
      await writeTextAtomic(pendingScreen, `${replayedIntake.screen}\n`);
      // The answered case-source is now the authority for the next round.  It
      // replaces only the carrier snapshot; immutable raw evidence stays the
      // same and the normal compiler will replay every recorded decision.
      const continuedEvidencePath = path.join(stage3Dir, "continued-evidence-run.json");
      const continuedEvidence = structuredClone(evidenceRun);
      continuedEvidence.case_source = answeredCaseSource;
      await writeJsonAtomic(continuedEvidencePath, continuedEvidence);
      await writeTextAtomic(stage1Evidence, await fs.readFile(continuedEvidencePath, "utf8"));
      const receipt3 = await persistStage({
        runDir,
        runId,
        stageId: "decisions",
        status: "action_required",
        inputHashes: stage3InputsFor(await hashFile(path.resolve(options.answers))),
        previousReceiptHash: receipt2.receipt_hash,
        outputs: {
          case_source: answeredCaseSourcePath,
          case_compile_report: answeredCompileReportPath,
          question_result: pendingResult,
          question_screen: pendingScreen,
          continued_evidence_run: continuedEvidencePath,
        },
        detail: {
          question_count: replayedIntake.plan.questions.length,
          remaining_question_count: replayedIntake.plan.remaining_question_count ?? 0,
        },
      });
      // Do not carry the just-consumed answer file into the next round.
      options.answers = null;
      const carrier = await persistCurrentCarrier("AWAITING_DECISIONS", {
        case_source: answeredCaseSourcePath,
        case_compile_report: answeredCompileReportPath,
      });
      return finish({
        runDir,
        screen: replayedIntake.screen,
        machine: options.json === true,
        result: {
          schema_version: "user-flow-run/1.0",
          controller_version: FLOW_CONTROLLER_VERSION,
          run_id: runId,
          status: "ACTION_REQUIRED",
          stage: "decisions",
          // As above: the replay path is still asking the user to decide.
          blocker_class: "USER_DECISION",
          question_count: replayedIntake.plan.questions.length,
          remaining_question_count: replayedIntake.plan.remaining_question_count ?? 0,
          carrier: carrier.path,
          evidence_run: continuedEvidencePath,
          receipt: receipt3,
          reused_stages: reusedStages,
        },
      });
    }
    if (replayedIntake.outcome !== "proceed") {
      throw new Error(
        `Decision replay did not settle the freshly compiled case: ${replayedIntake.outcome}`,
      );
    }
    answeredCase = replayedIntake.working_case;
    answeredCase.stage_three_answers = {
      ...(answeredCase.stage_three_answers ?? {}),
      ...Object.fromEntries(recordedDecisionMap(answeredCaseSource)),
    };
  } else if (!cached3.reusable) {
    answeredCase = intakeResult.working_case;
    await writeJsonAtomic(answeredCaseSourcePath, validation.handoff.case_source);
    await writeJsonAtomic(
      answeredCompileReportPath,
      activeCaseCompileReport,
    );
  }
  let receipt3;
  if (cached3.reusable) {
    answeredCase = await readJson(answeredCasePath, "cached answered case");
    receipt3 = cached3.receipt;
    reusedStages.push("decisions");
    await workGraph.reuseStage("decisions");
  } else {
    const planningCase = structuredClone(answeredCase);
    const normalisation = (await workGraph.runNode({
      id: "statement_normalisation",
      recipe: "statement-normalisation/1.0",
      inputs: { answered_case: hashValue(serialisable(answeredCase ?? null)) },
      outputs: { statement_structure: null, source_coverage: null },
      action: () => {
        const normalizedStatements = {
          income_statement: stripStatementPresentationMetadata(
            normaliseStatementRows(
              answeredCase,
              "income_statement",
              { forecastDecisionMode: "defer" },
            ),
          ),
          cash_flow: stripStatementPresentationMetadata(
            normaliseStatementRows(
              answeredCase,
              "cash_flow",
              { forecastDecisionMode: "defer" },
            ),
          ),
        };
        planningCase.statement_structure = normalizedStatements;
        return {
          statement_structure: normalizedStatements,
          source_coverage: reconcileStatementProjectionCoverage(
            planningCase,
            normalizedStatements,
          ),
        };
      },
    })).value;
    planningCase.source_coverage = normalisation.source_coverage;
    const behaviorMap = (await workGraph.runNode({
      id: "forecast_behavior_map",
      recipe: "forecast-behavior-map/1.0",
      inputs: { planning_case: hashValue(serialisable(planningCase)) },
      outputs: { forecast_behavior_map: forecastBehaviorPath },
      action: () => compileForecastBehaviorMap(
        planningCase,
        planningCase.statement_structure,
      ),
    })).value;
    const behaviorValidation = validateForecastBehaviorMap(behaviorMap);
    if (!behaviorValidation.valid) {
      throw new Error(
        `Forecast behavior artifact is invalid: ${behaviorValidation.violations[0]?.message ?? "unknown violation"}`,
      );
    }
    const modelDemandGraph = (await workGraph.runNode({
      id: "model_demand_graph",
      recipe: "model-demand-graph/1.0",
      inputs: { planning_case: hashValue(serialisable(planningCase)) },
      outputs: { model_demand_graph: modelDemandGraphPath },
      action: () => compileModelDemandGraph(planningCase),
    })).value;
    const demandValidation = validateModelDemandGraph(modelDemandGraph);
    if (!demandValidation.valid) {
      throw new Error(
        `Model-demand graph is invalid: ${demandValidation.errors[0] ?? "unknown violation"}`,
      );
    }
    const forecastPlan = (await workGraph.runNode({
      id: "forecast_plan",
      recipe: "forecast-plan/1.0",
      inputs: {
        planning_case: hashValue(serialisable(planningCase)),
        observation_ledger: hashValue(
          serialisable(validation.handoff?.forecast_observation_ledger ?? null),
        ),
        source_inventory: hashValue(serialisable(evidenceRun?.source_inventory ?? [])),
      },
      outputs: { forecast_plan: forecastPlanJsonPath },
      action: () => compileForecastPlan(
        planningCase,
        planningCase.statement_structure,
        {
          behaviorMap,
          observationLedger:
            validation.handoff?.forecast_observation_ledger ?? null,
          sourceInventory: evidenceRun?.source_inventory ?? [],
        },
      ),
    })).value;
    const forecastPlanErrors = validateForecastPlan(
      forecastPlan,
      planningCase.statement_structure,
    );
    if (forecastPlanErrors.length > 0) {
      throw new Error(`Forecast plan artifact is invalid: ${forecastPlanErrors[0]}`);
    }
    const selectedAuthorityContract = (await workGraph.runNode({
      id: "selected_authority_contract",
      recipe: "selected-authority-contract/1.0",
      inputs: {
        planning_case: hashValue(serialisable(planningCase)),
        evidence_run: stage1Inputs.evidence_run,
      },
      outputs: { selected_authority_contract: selectedAuthorityContractPath },
      action: () => compileSelectedAuthorityContract({
        modelCase: planningCase,
        forecastPlan,
        modelDemandGraph,
        evidenceRun,
      }),
    })).value;
    const authorityValidation = validateSelectedAuthorityContract(
      selectedAuthorityContract,
      { modelDemandGraph, forecastPlan },
    );
    if (!authorityValidation.valid) {
      throw new Error(
        `Selected-authority contract is invalid: ${authorityValidation.errors[0] ?? "unknown violation"}`,
      );
    }
    const runConstitutionGraph = (await workGraph.runNode({
      id: "run_constitution_graph",
      recipe: "run-constitution-graph/1.0",
      inputs: {
        planning_case: hashValue(serialisable(planningCase)),
        evidence_run: stage1Inputs.evidence_run,
      },
      outputs: { run_constitution_graph: runConstitutionGraphPath },
      action: () => compileRunConstitutionGraph({
        evidenceRun,
        modelCase: planningCase,
        forecastPlan,
        modelDemandGraph,
        selectedAuthorityContract,
      }),
    })).value;
    const constitutionValidation = validateRunConstitutionGraph(runConstitutionGraph);
    if (!constitutionValidation.valid) {
      throw new Error(
        `Run constitution graph is invalid: ${constitutionValidation.errors[0] ?? "unknown violation"}`,
      );
    }
    await writeJsonAtomic(forecastBehaviorPath, behaviorMap);
    await writeJsonAtomic(forecastPlanJsonPath, forecastPlan);
    await writeJsonAtomic(modelDemandGraphPath, modelDemandGraph);
    await writeJsonAtomic(selectedAuthorityContractPath, selectedAuthorityContract);
    await writeJsonAtomic(runConstitutionGraphPath, runConstitutionGraph);
    if (forecastPlan.status !== "PASS") {
      await writeTextAtomic(
        forecastPlanPath,
        `${renderForecastPlanScreen(planningCase, forecastPlan)}\n`,
      );
      const receipt3 = await persistStage({
        runDir,
        runId,
        stageId: "decisions",
        status: "action_required",
        inputHashes: stage3Inputs,
        previousReceiptHash: receipt2.receipt_hash,
        outputs: {
          forecast_plan: forecastPlanPath,
          forecast_plan_json: forecastPlanJsonPath,
          forecast_behavior_map: forecastBehaviorPath,
        },
        detail: {
          unresolved_material_forecast_states:
            forecastPlan.unresolved_material_count,
          forecast_plan_sha256: forecastPlanSha256(forecastPlan),
        },
      });
      return finish({
        runDir,
        screen: renderForecastPlanScreen(planningCase, forecastPlan),
        machine: options.json === true,
        result: {
          schema_version: "user-flow-run/1.0",
          controller_version: FLOW_CONTROLLER_VERSION,
          run_id: runId,
          status: "ACTION_REQUIRED",
          stage: "decisions",
          outcome: "forecast_authority_unresolved",
          blocker_class: "USER_DECISION",
          message: `${forecastPlan.unresolved_material_count} material forecast state(s) are unresolved.`,
          forecast_plan: forecastPlanJsonPath,
          receipt: receipt3,
          reused_stages: reusedStages,
        },
      });
    }
    answeredCase = materializeSelectedAuthorityContract(
      planningCase,
      selectedAuthorityContract,
    );
    answeredCase.model_demand_graph_sha256 = modelDemandGraph.graph_sha256;
    answeredCase.selected_authority_contract_sha256 =
      selectedAuthorityContract.contract_sha256;
    answeredCase.run_constitution_graph_sha256 = runConstitutionGraph.graph_sha256;
    answeredCase.evidence_quality_mode = selectedAuthorityContract.quality_mode;
    await writeJsonAtomic(answeredCasePath, answeredCase);
    await writeTextAtomic(
      forecastPlanPath,
      `${renderForecastPlanScreen(answeredCase, forecastPlan)}\n`,
    );
    receipt3 = await persistStage({
      runDir,
      runId,
      stageId: "decisions",
      status: "success",
      inputHashes: stage3Inputs,
      previousReceiptHash: receipt2.receipt_hash,
      outputs: stage3Outputs,
      detail: {
        question_count: intakeResult.outcome === "questions" ? intakeResult.plan.questions.length : 0,
        forecast_plan_sha256: forecastPlanSha256(forecastPlan),
        forecast_state_count: forecastPlan.states.length,
        model_demand_graph_sha256: modelDemandGraph.graph_sha256,
        selected_authority_contract_sha256:
          selectedAuthorityContract.contract_sha256,
        run_constitution_graph_sha256: runConstitutionGraph.graph_sha256,
      },
    });
  }
  if (options["stop-after"] === "decisions") {
    const carrier = await persistCurrentCarrier("READY_TO_BUILD", {
      model_case: answeredCasePath,
      case_source: answeredCaseSourcePath,
      case_compile_report: answeredCompileReportPath,
      model_demand_graph: modelDemandGraphPath,
      selected_authority_contract: selectedAuthorityContractPath,
      run_constitution_graph: runConstitutionGraphPath,
    });
    return finish({
      runDir,
      screen: renderForecastPlanScreen(answeredCase),
      machine: options.json === true,
      result: {
        schema_version: "user-flow-run/1.0",
        controller_version: FLOW_CONTROLLER_VERSION,
        run_id: runId,
        status: "PAUSED",
        stage: "decisions",
        next_stage: nextStageId("decisions"),
        carrier: carrier.path,
        evidence_run: stage1Evidence,
        model_case: answeredCasePath,
        model_demand_graph: modelDemandGraphPath,
        selected_authority_contract: selectedAuthorityContractPath,
        run_constitution_graph: runConstitutionGraphPath,
        reused_stages: reusedStages,
      },
    });
  }

  // Stage 4 — invoke the real portable workbook controller. The build folder
  // is content-addressed so a changed case never overwrites prior evidence.
  await enterFlowStage("build_checks");
  const stage4Dir = path.join(runDir, "stages", "build_checks");
  const caseHash = await hashFile(answeredCasePath);
  // P6.2: ONE stage-4 input shape, computed BEFORE the first path that can
  // refuse the stage. The case-mutation refusal used to key on a three-component
  // subset, so its receipt could never be compared with the success receipt it
  // was meant to replace. Absent forecast artifacts hash to a sentinel rather
  // than throwing, which is what lets the refusal path share the full shape.
  const stage4Inputs = {
    stage3_receipt: receipt3.receipt_hash,
    model_case: caseHash,
    forecast_plan: await hashFileOrAbsent(forecastPlanJsonPath),
    model_demand_graph: await hashFileOrAbsent(modelDemandGraphPath),
    selected_authority_contract: await hashFileOrAbsent(selectedAuthorityContractPath),
    run_constitution_graph: await hashFileOrAbsent(runConstitutionGraphPath),
    runtime: runtimeClosure.digest,
    ...carrierMigrationInput("build_checks"),
  };

  // A paused run holds a position; it does not hand the case over for editing.
  // Because the build folder is content-addressed, a case that changed while the
  // run waited does not collide with anything - it quietly opens a second build
  // under a new name and carries the first run's receipts forward over it. The
  // stage-3 receipt and the run carrier both recorded what the case hashed to at
  // pause time, so the substitution is detectable here, before any build folder
  // is derived from the new bytes.
  const pauseTimeCaseHashes = [
    ["stage-3 receipt", receipt3?.output_hashes?.model_case],
    ["run carrier", verifiedCarrier?.carrier?.files?.model_case?.sha256],
  ].filter(([, hash]) => /^[a-f0-9]{64}$/.test(String(hash ?? "")));
  const mutatedAgainst = pauseTimeCaseHashes.filter(([, hash]) => hash !== caseHash);
  if (mutatedAgainst.length > 0) {
    const detail = mutatedAgainst
      .map(([label, hash]) => `${label} recorded ${hash.slice(0, 12)}`)
      .join("; ");
    const message =
      `run_case_mutated_during_pause: the model case on disk hashes to ${caseHash.slice(0, 12)}, ` +
      `but ${detail}. A run whose case changed while it waited is a different run wearing the ` +
      `first one's receipts.`;
    const screen = renderFailure({
      stage: "build_checks",
      what_failed: "The model case changed while this run was paused.",
      why: message,
      what_would_fix_it: [
        "Start a fresh run for the changed case; a paused run may only be continued on the exact case its receipts were issued against.",
        "Serve side requests that arrive during a pause from a scratch copy, never by editing the run's own case.",
      ],
    });
    const mutationPath = path.join(stage4Dir, "case-mutation.json");
    await writeJsonAtomic(mutationPath, {
      on_disk_model_case: caseHash,
      pause_time_model_case: Object.fromEntries(pauseTimeCaseHashes),
      message,
    });
    const blockedReceipt = await persistStage({
      runDir,
      runId,
      stageId: "build_checks",
      status: "blocked",
      inputHashes: stage4Inputs,
      previousReceiptHash: receipt3.receipt_hash,
      outputs: { case_mutation: mutationPath },
      detail: {
        on_disk_model_case: caseHash,
        pause_time_model_case: Object.fromEntries(pauseTimeCaseHashes),
      },
    });
    return finish({
      runDir,
      screen,
      machine: options.json === true,
      result: {
        schema_version: "user-flow-run/1.0",
        controller_version: FLOW_CONTROLLER_VERSION,
        run_id: runId,
        status: "BLOCKED",
        stage: "build_checks",
        outcome: "run_case_mutated_during_pause",
        blocker_class: "INTERNAL_WORK",
        message,
        receipt: blockedReceipt,
        reused_stages: reusedStages,
      },
    });
  }

  const buildDir = path.join(runDir, `build-${caseHash.slice(0, 12)}`);
  const buildResultPath = path.join(stage4Dir, "build-result.json");
  const workbook = path.join(buildDir, "model.xlsx");
  const evidenceInputsDir = path.join(stage4Dir, "evidence-inputs");
  const dcsPath = path.join(evidenceInputsDir, "dcs-export.json");
  const brokerPath = path.join(evidenceInputsDir, "broker-pack.json");
  const filingsPath = path.join(evidenceInputsDir, "filings.json");
  await writeJsonAtomic(dcsPath, validation.handoff.intake.export);
  await writeJsonAtomic(
    brokerPath,
    // Stage-4 N0 validates the immutable source-shaped broker pack. The
    // selected-cell projection belongs only in model_case/case_evidence; it is
    // deliberately a different schema and must never masquerade as raw input.
    validation.handoff.intake.broker_pack,
  );
  await writeJsonAtomic(filingsPath, validation.handoff.intake.filings);
  const stage4Outputs = {
    build_result: buildResultPath,
    workbook,
    plan: `${workbook}.plan.json`,
    coverage: `${workbook}.coverage.json`,
    row_map: `${workbook}.row-map.json`,
    semantic_manifest: `${workbook}.semantic-manifest.json`,
    solution: `${workbook}.solution.json`,
    source_crosswalk: `${workbook}.source-crosswalk.csv`,
    semantic_gates: path.join(buildDir, "n0-n9-gates.json"),
    verification: { path: path.join(buildDir, "verify"), kind: "directory" },
    render_evidence: { path: path.join(buildDir, "render"), kind: "directory" },
    skill_integrity: path.join(buildDir, "skill-integrity.json"),
    publication_manifest: path.join(buildDir, "publication.json"),
    recalc_receipt: path.join(buildDir, "verify", "libreoffice-recalc-receipt.json"),
  };
  const cached4 = await readUsableStage({
    runDir,
    runId,
    stageId: "build_checks",
    inputHashes: stage4Inputs,
    previousReceiptHash: receipt3.receipt_hash,
    outputs: stage4Outputs,
  });
  let buildResult;
  let receipt4;
  if (cached4.reusable) {
    buildResult = await readJson(buildResultPath, "cached build result");
    receipt4 = cached4.receipt;
    reusedStages.push("build_checks");
  } else {
    await fs.mkdir(buildDir, { recursive: true });
    const args = [
      path.join(HERE, "orchestrate_release.mjs"),
      answeredCasePath,
      "--out",
      buildDir,
      "--dcs-export",
      dcsPath,
      "--broker-pack",
      brokerPath,
      "--filings",
      filingsPath,
      "--model-demand-graph",
      modelDemandGraphPath,
      "--selected-authority-contract",
      selectedAuthorityContractPath,
      "--run-constitution-graph",
      runConstitutionGraphPath,
      "--json",
    ];
    if (options.python) args.push("--python", options.python);
    if (options.soffice) args.push("--soffice", options.soffice);
    if (options["runtime-budget-policy"]) {
      args.push("--runtime-budget-policy", path.resolve(String(options["runtime-budget-policy"])));
    }
    const runtimeHome = path.join(runDir, ".runtime-home");
    const runtimeTmp = path.join(runDir, ".runtime-tmp");
    await fs.mkdir(runtimeHome, { recursive: true });
    await fs.mkdir(runtimeTmp, { recursive: true });
    // Phase-5 parity: the economic graph is sealed BEFORE Build. A refusal
    // here is a controller sequencing defect surfaced at the cheap boundary,
    // not a workbook failure discovered after fifty minutes of build work.
    const stageParityReceipt = sealEconomicStageParity(answeredCase);
    await writeJsonAtomic(
      path.join(runDir, "stages", "build_checks", "economic-stage-parity.json"),
      stageParityReceipt,
    );
    // An EXPLICIT operator budget is a hard promise: the no-block stage
    // floor may lift derived budgets so checkpoints can close, but it must
    // never silently extend a budget the caller stated (P6.1: a deadline
    // cannot be extended). The kill/resume proof depends on this.
    const stage4AllowanceMs = await boundedOuterTimeoutMs(runDeadline, {
      stage: "workbook_build_outer",
      requestedMs: stage4OuterTimeout(answeredCase, options.timeout),
      ...(options.timeout !== undefined && options.timeout !== null
        ? { floorMs: Math.min(60_000, Number(options.timeout)) }
        : {}),
    });
    const stage4StartedMs = Date.now();
    const executed = await runCommand(process.execPath, args, {
      cwd: buildDir,
      timeout: stage4AllowanceMs,
      env: {
        ...process.env,
        HOME: runtimeHome,
        TMPDIR: runtimeTmp,
        PYTHONDONTWRITEBYTECODE: "1",
        EXCEL_INFLOW_WORKSPACE_TOKEN: workspaceToken,
      },
    });
    // Charged to the SAME clock. The stage span and the invocation span both
    // credit this growth, so it is billed exactly once.
    await recordComputeSegment(runDeadline, {
      label: "stage4_build_execution",
      durationMs: Date.now() - stage4StartedMs,
    });
    try {
      buildResult = JSON.parse(executed.stdout);
    } catch {
      buildResult = {
        status: "BLOCKED",
        message: "The workbook controller did not return readable JSON.",
        stderr: executed.stderr.slice(-4000),
      };
    }
    await writeJsonAtomic(buildResultPath, buildResult);
    if (buildResult.status !== "PASS_PENDING_MANUAL") {
      const failureScreen = renderFailure({
        stage: "build",
        what_failed: buildResult.message ?? "The workbook build did not clear its automated gates.",
        why: null,
        what_would_fix_it: ["Inspect the build result and repair the earliest failed source layer."],
      });
      const receiptStatus = buildResult.status === "BLOCKED" ? "blocked" : "failed";
      receipt4 = await persistStage({
        runDir,
        runId,
        stageId: "build_checks",
        status: receiptStatus,
        inputHashes: stage4Inputs,
        previousReceiptHash: receipt3.receipt_hash,
        outputs: { build_result: buildResultPath },
        detail: buildResult,
      });
      return finish({
        runDir,
        screen: failureScreen,
        machine: options.json === true,
        result: {
          schema_version: "user-flow-run/1.0",
          controller_version: FLOW_CONTROLLER_VERSION,
          run_id: runId,
          status: "BLOCKED",
          stage: "build_checks",
          outcome: "workbook_build_blocked",
          blocker_class: "INTERNAL_WORK",
          controller_status: buildResult.status ?? "BLOCKED",
          message: buildResult.message,
          receipt: receipt4,
          reused_stages: reusedStages,
        },
      });
    }
    // P3.2: the parity receipt sealed before Build is re-verified against the
    // case that survived Build. Sealing alone proved only that the graph was
    // coherent at the cheap boundary; this proves Build did not invalidate it.
    assertEconomicStageParityAfterBuild(answeredCase, stageParityReceipt);
    receipt4 = await persistStage({
      runDir,
      runId,
      stageId: "build_checks",
      status: "success",
      inputHashes: stage4Inputs,
      previousReceiptHash: receipt3.receipt_hash,
      outputs: stage4Outputs,
      detail: { automated_gate_status: buildResult.status },
    });
  }
  if (options["stop-after"] === "build_checks") {
    const carrier = await persistCurrentCarrier("READY_FOR_DELIVERY", {
      model_case: answeredCasePath,
      workbook,
    });
    return finish({
      runDir,
      screen: renderCompletionScreen("build_checks"),
      machine: options.json === true,
      result: {
        schema_version: "user-flow-run/1.0",
        controller_version: FLOW_CONTROLLER_VERSION,
        run_id: runId,
        status: "PAUSED",
        stage: "build_checks",
        next_stage: nextStageId("build_checks"),
        workbook,
        carrier: carrier.path,
        evidence_run: stage1Evidence,
        model_case: answeredCasePath,
        reused_stages: reusedStages,
      },
    });
  }

  // REVIEW GATE — the last look before delivery, display-only by construction.
  // It writes no stage receipt and owns no milestone: it renders what the build
  // already produced and blocks until the controller is told one of exactly
  // two replies. `--review-deliver` continues into the ordinary delivery stage
  // unchanged; `--review-change "<what to change>"` records the complaint,
  // classifies it onto the declared change types, and stops WITHOUT
  // delivering. No reply at all leaves the run paused here — the gate is
  // fail-closed by the same rule resolveReviewReply enforces.
  const reviewReply = resolveReviewReply({
    reviewDeliver:
      options["review-deliver"] !== undefined && options["review-deliver"] !== false,
    reviewChange:
      typeof options["review-change"] === "string"
        ? options["review-change"]
        : options["review-change"] === true
          ? true
          : null,
  });
  // SEALED BRIEFING, VERIFIED AT REPLY TIME. Every arrival at the gate —
  // pausing, delivering, or requesting a change — renders the briefing from
  // the artifacts Build persisted (stages/build_checks/build-result.json and
  // the workbook's solution sidecar) and re-verifies the seal against those
  // bytes as they are now. A build result edited after the briefing was
  // sealed is a refusal: the gate never re-solves the case to look past it.
  const reviewDir = path.join(runDir, "stages", "review");
  await fs.mkdir(reviewDir, { recursive: true });
  let reviewBrokerPreview = brokerPreview;
  if (!reviewBrokerPreview) {
    try {
      reviewBrokerPreview = await readJson(brokerPreviewPath, "Broker preview");
    } catch {
      reviewBrokerPreview = null;
    }
  }
  let sealedReview;
  try {
    sealedReview = await sealReviewBriefing({
      runDir,
      workbookPath: workbook,
      modelCase: await readJson(answeredCasePath, "Compiled decision case"),
      quality: reviewQualityFrom({ brokerPreview: reviewBrokerPreview }),
    });
  } catch (error) {
    if (!(error instanceof ReviewSealRefusal)) throw error;
    const refusalScreen = renderFailure({
      stage: "build_checks",
      what_failed:
        "The review gate refuses to brief from, or take a reply against, the recorded build artifacts.",
      why: error.message,
      what_would_fix_it: [
        "Re-run the build stage so stages/build_checks/build-result.json and the workbook's solution sidecar are exactly what this run sealed.",
        "Never repair the gate by editing a recorded artifact or by recomputing the numbers — the briefing must stay byte-identical to what Build checked in.",
      ],
    });
    await writeTextAtomic(
      path.join(reviewDir, "review-gate.txt"),
      `${refusalScreen}\n`,
    );
    return finish({
      runDir,
      screen: refusalScreen,
      machine: options.json === true,
      result: {
        schema_version: "user-flow-run/1.0",
        controller_version: FLOW_CONTROLLER_VERSION,
        run_id: runId,
        status: "PAUSED",
        stage: "build_checks",
        next_stage: null,
        awaiting: "review_seal_refusal",
        message: error.message,
        reused_stages: reusedStages,
      },
    });
  }
  const reviewBriefing = sealedReview.briefing;
  const reviewScreen = renderReviewGateScreen(reviewBriefing);
  await writeTextAtomic(
    path.join(reviewDir, "review-gate.txt"),
    `${reviewScreen}\n`,
  );
  if (reviewReply.mode === "blocked") {
    const carrier = await persistCurrentCarrier("READY_FOR_DELIVERY", {
      model_case: answeredCasePath,
      workbook,
    });
    return finish({
      runDir,
      screen: reviewScreen,
      machine: options.json === true,
      result: {
        schema_version: "user-flow-run/1.0",
        controller_version: FLOW_CONTROLLER_VERSION,
        run_id: runId,
        status: "PAUSED",
        stage: "build_checks",
        next_stage: nextStageId("build_checks"),
        awaiting: "review_gate_reply",
        message:
          'The review gate is waiting for one reply: --review-deliver, or --review-change "<what to change>".',
        carrier: carrier.path,
        model_case: answeredCasePath,
        reused_stages: reusedStages,
      },
    });
  }
  if (reviewReply.mode === "change") {
    const reviewClassification = classifyChangeComplaint(reviewReply.complaint);
    const reviewChangeRecord = {
      schema_version: "flow-review-change/1.0",
      complaint: reviewReply.complaint,
      change_types: reviewClassification.change_types,
      classified: reviewClassification.classified,
      invalidated_from_stage: reviewClassification.stage_id,
      invalidated_from_milestone: reviewClassification.milestone_label,
      revise_entry: describeReviseEntry(reviewClassification),
      recorded_at: new Date().toISOString(),
      delivered: false,
    };
    await writeJsonAtomic(
      path.join(reviewDir, "review-change.json"),
      reviewChangeRecord,
    );
    // The user's reply is evidence in its own right: one receipt per reply,
    // chained to the previous receipt this run recorded, bound to the exact
    // sealed briefing it was made against.
    await recordUserReviewReceipt({
      runDir,
      reply: REVIEW_CHANGE_REPLY,
      changeClass: reviewChangeRecord.change_types,
      seal: sealedReview.seal,
    });
    return finish({
      runDir,
      screen: reviewScreen,
      machine: options.json === true,
      result: {
        schema_version: "user-flow-run/1.0",
        controller_version: FLOW_CONTROLLER_VERSION,
        run_id: runId,
        status: "PAUSED",
        stage: "build_checks",
        next_stage: null,
        review_change: reviewChangeRecord,
        message: `${describeReviseEntry(reviewClassification)} Nothing was delivered.`,
        reused_stages: reusedStages,
      },
    });
  }
  // The deliver reply: receipted against the sealed briefing, then the run
  // continues into the ordinary delivery stage unchanged.
  await recordUserReviewReceipt({
    runDir,
    reply: REVIEW_DELIVER_REPLY,
    seal: sealedReview.seal,
  });

  // The chat host is not an authority. Before Stage 5 can expose any workbook,
  // independently bind the exact file to this controller, its Stage-4 receipt,
  // the active design epoch and the physical workbook topology. An ad-hoc
  // compact workbook can be internally consistent; it still must never leave
  // this run as an Excel Inflow result.
  const deliveryAttestationPath = path.join(
    runDir,
    "stages",
    "delivery",
    "live-delivery-attestation.json",
  );
  let deliveryAttestation;
  try {
    deliveryAttestation = await compileLiveDeliveryAttestation({
      runRoot: runDir,
      runId,
      workbook,
      buildResult,
      stage4Receipt: receipt4,
      modelCasePath: answeredCasePath,
    });
    await writeJsonAtomic(deliveryAttestationPath, deliveryAttestation);
    assertLiveDeliveryAttestation(deliveryAttestation);
  } catch (error) {
    const failureScreen = renderFailure({
      stage: "delivery",
      what_failed: "The workbook is not the attested output of the controlled Excel Inflow build path.",
      why: error.message,
      what_would_fix_it: [
        "Resume the hash-bound run carrier and rebuild through scripts/run_user_flow.mjs; do not construct or repair a workbook manually.",
      ],
    });
    return finish({
      runDir,
      screen: failureScreen,
      machine: options.json === true,
      result: {
        schema_version: "user-flow-run/1.0",
        controller_version: FLOW_CONTROLLER_VERSION,
        run_id: runId,
        status: "BLOCKED",
        stage: "delivery",
        outcome: "delivery_attestation_blocked",
        blocker_class: "INTERNAL_WORK",
        message: error.message,
        reused_stages: reusedStages,
      },
    });
  }

  // Stage 5 — deliver the workbook and concise read, while keeping the manual
  // native-Excel gate explicit. Delivery succeeds; production certification is
  // still PASS_PENDING_MANUAL until that external evidence is attached.
  await enterFlowStage("delivery");
  const stage5Dir = path.join(runDir, "stages", "delivery");
  const deliveryResultPath = path.join(stage5Dir, "delivery-result.json");
  const deliveryScreenPath = path.join(stage5Dir, "delivery-screen.txt");
  // THE CONTROLLER NAMES THE DELIVERABLE, NOT THE CHAT. Every run used to
  // deliver under one reused friendly filename, so a user's Downloads folder
  // accumulated identically-named workbooks from different eras and a stale
  // one was eventually opened and mistaken for the delivery. The name is now
  // minted here, after attestation, and carries the attested workbook hash —
  // two different workbooks can never share a delivery filename, and the name
  // itself is checkable against artifact_hashes.workbook in the attestation.
  // The chat layer attaches this file byte-for-byte and never renames it.
  const issuerToken = (String(answeredCase?.issuer?.name ?? "Model").match(/[A-Za-z0-9]+/g) ?? ["Model"])[0];
  const deliveryFileName = `${issuerToken}_Debt_Overlay_${deliveryAttestation.artifact_hashes.workbook.slice(0, 8)}.xlsx`;
  const deliveryFilePath = path.join(stage5Dir, deliveryFileName);
  await fs.copyFile(workbook, deliveryFilePath);
  const stage5Inputs = {
    stage4_receipt: receipt4.receipt_hash,
    model_case: caseHash,
    live_delivery_attestation: await hashFile(deliveryAttestationPath),
    runtime: runtimeClosure.digest,
    ...carrierMigrationInput("delivery"),
  };
  const stage5Outputs = {
    delivery_result: deliveryResultPath,
    delivery_screen: deliveryScreenPath,
    live_delivery_attestation: deliveryAttestationPath,
    delivery_file: deliveryFilePath,
  };
  const cached5 = await readUsableStage({
    runDir,
    runId,
    stageId: "delivery",
    inputHashes: stage5Inputs,
    previousReceiptHash: receipt4.receipt_hash,
    outputs: stage5Outputs,
  });
  let deliveryResult;
  let deliveryScreen;
  let receipt5;
  if (cached5.reusable) {
    deliveryResult = await readJson(deliveryResultPath, "cached delivery result");
    deliveryScreen = await fs.readFile(deliveryScreenPath, "utf8");
    receipt5 = cached5.receipt;
    reusedStages.push("delivery");
  } else {
    const delivered = deliver({ modelCase: answeredCase });
    if (delivered.outcome !== "delivered") {
      throw new Error(`Delivery read failed after a successful build: ${delivered.outcome}`);
    }
    const report = {
      ...delivered.report,
      build_identity: [
        `Controller ${deliveryAttestation.controller_version}`,
        `Authority ${deliveryAttestation.authority_profile} / design epoch ${deliveryAttestation.design_epoch}`,
        `Attestation ${deliveryAttestation.attestation_sha256}`,
        `Delivery file ${deliveryFileName}`,
        `Workbook SHA-256 ${deliveryAttestation.artifact_hashes.workbook}`,
        `Sheets ${(deliveryAttestation.topology.sheet_names ?? []).join(" | ")}`,
      ],
    };
    deliveryScreen = renderDeliveryReport(report, { status: "review required" });
    deliveryResult = {
      outcome: delivered.outcome,
      report,
      workbook,
      delivery_file: deliveryFilePath,
      delivery_file_name: deliveryFileName,
      delivery_file_sha256: deliveryAttestation.artifact_hashes.workbook,
      sheet_names: deliveryAttestation.topology.sheet_names ?? [],
      automated_gate_status: buildResult.status,
      manual_gate: "native_excel_restoration_and_visual_review",
      live_delivery_attestation: deliveryAttestationPath,
      live_delivery_attestation_sha256: deliveryAttestation.attestation_sha256,
      controller_version: FLOW_CONTROLLER_VERSION,
      authority_profile: deliveryAttestation.authority_profile,
      design_epoch: deliveryAttestation.design_epoch,
    };
    await writeJsonAtomic(deliveryResultPath, deliveryResult);
    await writeTextAtomic(deliveryScreenPath, `${deliveryScreen}\n`);
    receipt5 = await persistStage({
      runDir,
      runId,
      stageId: "delivery",
      status: "success",
      inputHashes: stage5Inputs,
      previousReceiptHash: receipt4.receipt_hash,
      outputs: stage5Outputs,
      detail: { overall_status: "PASS_PENDING_MANUAL" },
    });
  }
  const carrier = await persistCurrentCarrier("DELIVERED_PENDING_NATIVE_EXCEL", {
    model_case: answeredCasePath,
    workbook,
    delivery_result: deliveryResultPath,
  });
  return finish({
    runDir,
    screen: deliveryScreen,
    machine: options.json === true,
    result: {
      schema_version: "user-flow-run/1.0",
      controller_version: FLOW_CONTROLLER_VERSION,
      run_id: runId,
      status: "PASS_PENDING_MANUAL",
      stage: "delivery",
      workbook,
      delivery_file: deliveryFilePath,
      delivery_file_name: deliveryFileName,
      delivery_file_sha256: deliveryAttestation.artifact_hashes.workbook,
      sheet_names: deliveryAttestation.topology.sheet_names ?? [],
      carrier: carrier.path,
      evidence_run: stage1Evidence,
      model_case: answeredCasePath,
      total_violations: 0,
      manual_gate: "native_excel_restoration_and_visual_review",
      live_delivery_attestation: deliveryAttestationPath,
      live_delivery_attestation_sha256: deliveryAttestation.attestation_sha256,
      authority_profile: deliveryAttestation.authority_profile,
      design_epoch: deliveryAttestation.design_epoch,
      receipt: receipt5,
      reused_stages: reusedStages,
    },
  });
}

async function guardedMain() {
  try {
    return await main();
  } finally {
    if (ACTIVE_RUN_GUARD) {
      let integrityError = null;
      try {
        await assertRuntimeIntegrityUnchanged(ACTIVE_RUN_GUARD.integrity, ROOT);
      } catch (error) {
        integrityError = error;
      }
      await releaseRunLease(ACTIVE_RUN_GUARD.runDir, ACTIVE_RUN_GUARD.lease.token);
      ACTIVE_RUN_GUARD = null;
      if (integrityError) throw integrityError;
    }
  }
}

guardedMain()
  .then((result) => {
    process.exitCode = ["SCREEN", "PAUSED", "ACTION_REQUIRED", "PASS_PENDING_MANUAL"].includes(result.status)
      ? 0
      : 1;
  })
  .catch(async (error) => {
    process.stderr.write(`${error.stack ?? String(error)}\n`);
    // P6.1: a thrown run still records what it consumed. Without this a
    // kill/retry loop was invisible to the ceiling: every attempt burned real
    // compute and none of it was ever charged.
    try {
      await chargeInvocationToRunDeadline();
    } catch {}
    // P3.7: an internal failure carrying a typed outcome is serialised with
    // the registry's payload fields so the run is diagnosable and resumable —
    // a bare stack print is not a terminal state.
    try {
      const outDir = !error?.controller_handoff_refusal && process.argv.includes("--out")
        ? process.argv[process.argv.indexOf("--out") + 1]
        : null;
      if (outDir) {
        const payload = {
          schema_version: "excel-inflow-internal-failure/1.0",
          reason_code: error.typed_internal_outcome?.reason_code ?? "INTERNAL.compiler_or_graph_defect",
          earliest_responsible_layer:
            error.typed_internal_outcome?.earliest_responsible_layer ?? "unattributed (repair: type this throw)",
          downstream_invalidation_scope:
            error.typed_internal_outcome?.downstream_invalidation_scope ?? "unknown_full_rerun",
          resumable_checkpoint_path: path.join(outDir, "stages"),
          preserved_source_hashes: "evidence and stage artifacts under the run directory remain immutable",
          detail: error.typed_internal_outcome ?? null,
          message: String(error.message ?? error),
        };
        await fs.mkdir(outDir, { recursive: true });
        await fs.writeFile(
          path.join(outDir, "internal-failure.json"),
          `${JSON.stringify(payload, null, 2)}\n`,
          "utf8",
        );
      }
    } catch {}
    process.exitCode = 1;
  });
