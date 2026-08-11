#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateEvidenceRun } from "./lib/evidence_run.mjs";
import {
  applyAnswers,
  deliver,
  parseAnswers,
  runIntake,
} from "./lib/flow.mjs";
import {
  FLOW_CONTROLLER_VERSION,
  nextStageId,
} from "./lib/flow_runtime.mjs";
import {
  renderDeliveryReport,
  renderFailure,
  renderForecastPlanScreen,
  renderStageStatus,
  WELCOME_SCREEN,
} from "./lib/flow_screens.mjs";
import {
  persistStage,
  readUsableStage,
  writeJsonAtomic,
  writeRunResult,
  writeTextAtomic,
} from "./lib/user_flow_controller.mjs";
import {
  hashFile,
  hashValue,
} from "./lib/run_store.mjs";
import { runProcessTree } from "./lib/process_tree.mjs";
import {
  verifyRunCarrier,
  writeRunCarrier,
} from "./lib/run_carrier.mjs";
import {
  compileForecastPlan,
  forecastPlanSha256,
  materializeForecastPlan,
  validateForecastPlan,
  validateForecastPlanCaseParity,
} from "./lib/forecast_candidate_compiler.mjs";
import {
  compileForecastBehaviorMap,
  validateForecastBehaviorMap,
} from "./lib/forecast_behavior.mjs";
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
let ACTIVE_RUN_GUARD = null;

const PRESENTATION_SCREENS = Object.freeze({
  evidence_review: Object.freeze({
    status: "in progress",
    summary:
      "Reading the supplied evidence and reconciling the issuer, periods, statements, debt and broker forecasts.",
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
      "The workbook cleared its automated build checks and the delivery package is being prepared.",
  }),
});

const COMPLETION_SUMMARIES = Object.freeze({
  evidence_review:
    "The supplied evidence reconciled and the material decision set has been determined.",
  build_checks:
    "The workbook cleared the automated build and validation gates. Delivery can now be prepared.",
});

function renderPresentationScreen(stageId) {
  if (stageId === "inputs") return WELCOME_SCREEN;
  const declaration = PRESENTATION_SCREENS[stageId];
  if (!declaration) {
    throw new Error(
      `--screen must be one of inputs, evidence_review, decisions, build_checks or delivery; got ${stageId}`,
    );
  }
  return renderStageStatus({ stageId, ...declaration });
}

function renderCompletionScreen(stageId) {
  const summary = COMPLETION_SUMMARIES[stageId];
  if (!summary) throw new Error(`No completion screen is declared for ${stageId}`);
  return renderStageStatus({ stageId, status: "complete", summary });
}

const STAGE_RUNTIME_MEMBERS = Object.freeze({
  inputs: Object.freeze([
    "scripts/run_user_flow.mjs",
    "scripts/lib/evidence_run.mjs",
    "scripts/lib/forecast_observation.mjs",
    "scripts/lib/json_schema.mjs",
    "scripts/lib/flow_runtime.mjs",
    "scripts/lib/user_flow_controller.mjs",
    "scripts/lib/run_store.mjs",
    "scripts/lib/process_tree.mjs",
    "scripts/lib/runtime_isolation.mjs",
    "scripts/lib/run_carrier.mjs",
    "assets/evidence-run-v1.schema.json",
    "assets/forecast-observation-ledger-v1.schema.json",
    "assets/model-case-v2.schema.json",
  ]),
  evidence_review: Object.freeze([
    "scripts/lib/flow.mjs",
    "scripts/lib/intake.mjs",
    "scripts/lib/flow_entity.mjs",
    "scripts/lib/flow_reconcile.mjs",
    "scripts/lib/coverage.mjs",
    "scripts/lib/broker_anchor.mjs",
    "scripts/lib/statement_classifier.mjs",
    "assets/dcs-export.schema.json",
    "assets/broker-pack.schema.json",
    "assets/statement-semantic-taxonomy.v1.json",
  ]),
  decisions: Object.freeze([
    "scripts/lib/flow_questions.mjs",
    "scripts/lib/flow_impact.mjs",
    "scripts/lib/forecast_behavior.mjs",
    "scripts/lib/forecast_candidate_compiler.mjs",
    "scripts/lib/forecast_observation.mjs",
    "assets/forecast-behavior-map-v1.schema.json",
    "assets/forecast-plan-v2.schema.json",
    "assets/forecast-observation-ledger-v1.schema.json",
  ]),
  delivery: Object.freeze([
    "scripts/lib/flow_read.mjs",
    "scripts/lib/flow_screens.mjs",
    "scripts/lib/live_delivery_attestation.mjs",
    "scripts/lib/design_contract.mjs",
    "scripts/lib/flow_runtime.mjs",
    "scripts/lib/run_store.mjs",
    "assets/standardised-design-runtime.v2.json",
    "assets/standardised-design-runtime.v3.json",
    "assets/standardised-design-runtime.v4.json",
  ]),
});

function runtimeSubsetDigest(integrity, members, label) {
  const selected = {};
  for (const member of [...new Set(members)].sort()) {
    const digest = integrity.files?.[member];
    if (!digest) throw new Error(`Declared runtime member for ${label} is absent: ${member}`);
    selected[member] = digest;
  }
  return hashValue(selected);
}

function stageRuntimeDigests(integrity) {
  const controller = runtimeSubsetDigest(integrity, STAGE_RUNTIME_MEMBERS.inputs, "inputs");
  const allRuntimeMembers = Object.keys(integrity.files ?? {});
  const buildMembers = allRuntimeMembers.filter((member) =>
    !member.startsWith("references/"));
  return Object.freeze({
    inputs: controller,
    evidence_review: runtimeSubsetDigest(integrity, STAGE_RUNTIME_MEMBERS.evidence_review, "evidence review"),
    decisions: runtimeSubsetDigest(integrity, STAGE_RUNTIME_MEMBERS.decisions, "decisions"),
    build_checks: runtimeSubsetDigest(integrity, buildMembers, "build and checks"),
    delivery: runtimeSubsetDigest(integrity, STAGE_RUNTIME_MEMBERS.delivery, "delivery"),
  });
}

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

async function loadAnswers(target, questions) {
  const text = await fs.readFile(path.resolve(target), "utf8");
  if (target.toLowerCase().endsWith(".json")) {
    const payload = JSON.parse(text);
    return { answers: new Map(Object.entries(payload.answers ?? payload)), errors: [], complete: true };
  }
  return parseAnswers(text, questions);
}

function stoppedOutcome(outcome) {
  return [
    "bad_inputs",
    "filings_incomplete",
    "entity_stop",
    "reconciliation_stop",
    "awaiting_reexport",
    "inputs_look_wrong",
  ].includes(outcome);
}

function stageForOutcome(outcome) {
  if (outcome === "bad_inputs") return "inputs";
  if (["filings_incomplete", "entity_stop", "reconciliation_stop", "awaiting_reexport"].includes(outcome)) {
    return "evidence_review";
  }
  return "decisions";
}

async function finish({ runDir, result, screen = null, machine = false }) {
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
  const clean = serialisable(result);
  await writeRunResult(runDir, clean);
  if (machine) process.stdout.write(`${JSON.stringify(clean, null, 2)}\n`);
  else if (screen) process.stdout.write(`${screen}\n`);
  else process.stdout.write(`${clean.status}: ${clean.message ?? clean.workbook ?? "see run evidence"}\n`);
  return clean;
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.screen) {
    if (options.screen === true) {
      throw new Error("--screen requires a stage id");
    }
    const stage = String(options.screen);
    process.stdout.write(`${renderPresentationScreen(stage)}\n`);
    return { status: "SCREEN", stage };
  }
  if ((!positional[0] && !options.carrier) || !options.out) {
    throw new Error(
      "Usage: run_user_flow.mjs <evidence-run.json> --out <run-dir> or " +
        "run_user_flow.mjs --carrier <run-carrier.json> --out <run-dir> " +
        "[--answers <answers.txt|json>] [--python <python>] [--soffice <path>] " +
        "[--run-id <id>] [--workspace-token <token>] " +
        "[--stop-after <stage>] [--json], or " +
        "run_user_flow.mjs --screen <inputs|evidence_review|decisions|build_checks|delivery>",
    );
  }
  const isolated = await assertRunRootOutsideSkill({ skillRoot: ROOT, runRoot: options.out });
  const runDir = isolated.run_root;
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
          message,
          reused_stages: [],
        },
      });
    }
    evidencePath = verifiedCarrier.files.evidence_run;
    if (!options.answers && verifiedCarrier.files.answers) options.answers = verifiedCarrier.files.answers;
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
    name: evidenceRun.company_name ?? evidenceRun.model_case?.issuer?.name ?? "Unknown issuer",
  };
  const identity = await initializeOrVerifyRunIdentity({
    skillRoot: ROOT,
    runRoot: runDir,
    runId,
    controllerVersion: FLOW_CONTROLLER_VERSION,
    workspaceToken,
    issuerIdentity,
  });
  const lease = await acquireRunLease(runDir, { owner: `run_user_flow:${runId}` });
  const integrity = await captureRuntimeIntegrity(ROOT);
  ACTIVE_RUN_GUARD = { runDir, identity, lease, integrity };
  const reusedStages = [];
  const runtimeDigests = stageRuntimeDigests(integrity);

  // Stage 1 — validate the complete evidence envelope.
  const stage1Dir = path.join(runDir, "stages", "inputs");
  const stage1Validation = path.join(stage1Dir, "evidence-validation.json");
  const stage1Evidence = path.join(stage1Dir, "evidence-run.json");
  await writeTextAtomic(stage1Evidence, await fs.readFile(evidencePath, "utf8"));
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
      status,
      artifacts,
    });
  }
  const stage1Inputs = {
    evidence_run: await hashFile(evidencePath),
    runtime: runtimeDigests.inputs,
  };
  const stage1Outputs = {
    evidence_validation: stage1Validation,
    evidence_run: stage1Evidence,
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
  } else {
    validation = validateEvidenceRun(evidenceRun);
    await writeJsonAtomic(stage1Validation, serialisable(validation));
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
      screen: renderPresentationScreen("evidence_review"),
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
  const stage2Dir = path.join(runDir, "stages", "evidence_review");
  const stage2Result = path.join(stage2Dir, "intake-result.json");
  const stage2Inputs = {
    stage1_receipt: receipt1.receipt_hash,
    evidence_validation: await hashFile(stage1Validation),
    runtime: runtimeDigests.evidence_review,
  };
  const stage2Outputs = { intake_result: stage2Result };
  const cached2 = await readUsableStage({
    runDir,
    runId,
    stageId: "evidence_review",
    inputHashes: stage2Inputs,
    previousReceiptHash: receipt1.receipt_hash,
    outputs: stage2Outputs,
  });
  const freshIntakeResult = runIntake({
    intake: validation.handoff.intake,
    draftCase: validation.handoff.model_case,
  });
  let intakeResult = freshIntakeResult;
  let receipt2;
  if (cached2.reusable) {
    const cachedSummary = await readJson(stage2Result, "cached intake result");
    if (hashValue(cachedSummary) === hashValue(serialisable(freshIntakeResult))) {
      // Keep the fresh object because its option handlers are functions and
      // therefore cannot survive JSON. The receipt proves its serialisable
      // decision plan is byte-equivalent to the persisted prior run.
      receipt2 = cached2.receipt;
      reusedStages.push("evidence_review");
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
      const receipt3 = await persistStage({
        runDir,
        runId,
        stageId: "decisions",
        status: "blocked",
        inputHashes: { stage2_receipt: receipt2.receipt_hash },
        previousReceiptHash: receipt2.receipt_hash,
        outputs: { decision_result: stage3Result },
        detail: { outcome: intakeResult.outcome },
      });
      return finish({
        runDir,
        screen: intakeResult.screen,
        machine: options.json === true,
        result: {
          schema_version: "user-flow-run/1.0",
          controller_version: FLOW_CONTROLLER_VERSION,
          run_id: runId,
          status: "BLOCKED",
          stage: "decisions",
          outcome: intakeResult.outcome,
          receipt: receipt3,
          reused_stages: reusedStages,
        },
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
        receipt: receipt2,
        reused_stages: reusedStages,
      },
    });
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
  const stage3Dir = path.join(runDir, "stages", "decisions");
  const answeredCasePath = path.join(stage3Dir, "model-case.json");
  const forecastPlanPath = path.join(stage3Dir, "forecast-plan.txt");
  const forecastPlanJsonPath = path.join(stage3Dir, "forecast-plan.json");
  const forecastBehaviorPath = path.join(stage3Dir, "forecast-behavior-map.json");
  let answeredCase;
  let answerHash;
  if (intakeResult.outcome === "questions") {
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
        inputHashes: { stage2_receipt: receipt2.receipt_hash },
        previousReceiptHash: receipt2.receipt_hash,
        outputs: { question_result: questionResult, question_screen: questionScreen },
        detail: { question_count: intakeResult.plan.questions.length },
      });
      const carrier = await persistCurrentCarrier("AWAITING_DECISIONS");
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
        inputHashes: {
          stage2_receipt: receipt2.receipt_hash,
          answers: await hashFile(path.resolve(options.answers)),
        },
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
          status: "BLOCKED",
          stage: "decisions",
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
    answeredCase = applied.modelCase;
    answerHash = await hashFile(path.resolve(options.answers));
  } else {
    answeredCase = intakeResult.working_case;
    answerHash = hashValue({ skipped: true });
  }
  const stage3Inputs = {
    stage2_receipt: receipt2.receipt_hash,
    answers: answerHash,
    runtime: runtimeDigests.decisions,
  };
  const stage3Outputs = {
    model_case: answeredCasePath,
    forecast_plan: forecastPlanPath,
    forecast_plan_json: forecastPlanJsonPath,
    forecast_behavior_map: forecastBehaviorPath,
  };
  const cached3 = await readUsableStage({
    runDir,
    runId,
    stageId: "decisions",
    inputHashes: stage3Inputs,
    previousReceiptHash: receipt2.receipt_hash,
    outputs: stage3Outputs,
  });
  let receipt3;
  if (cached3.reusable) {
    answeredCase = await readJson(answeredCasePath, "cached answered case");
    receipt3 = cached3.receipt;
    reusedStages.push("decisions");
  } else {
    const planningCase = structuredClone(answeredCase);
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
    planningCase.source_coverage = reconcileStatementProjectionCoverage(
      planningCase,
      normalizedStatements,
    );
    const behaviorMap = compileForecastBehaviorMap(
      planningCase,
      planningCase.statement_structure,
    );
    const behaviorValidation = validateForecastBehaviorMap(behaviorMap);
    if (!behaviorValidation.valid) {
      throw new Error(
        `Forecast behavior artifact is invalid: ${behaviorValidation.violations[0]?.message ?? "unknown violation"}`,
      );
    }
    const forecastPlan = compileForecastPlan(
      planningCase,
      planningCase.statement_structure,
      {
        behaviorMap,
        observationLedger:
          validation.handoff?.forecast_observation_ledger ?? null,
      },
    );
    const forecastPlanErrors = validateForecastPlan(
      forecastPlan,
      planningCase.statement_structure,
    );
    if (forecastPlanErrors.length > 0) {
      throw new Error(`Forecast plan artifact is invalid: ${forecastPlanErrors[0]}`);
    }
    await writeJsonAtomic(forecastBehaviorPath, behaviorMap);
    await writeJsonAtomic(forecastPlanJsonPath, forecastPlan);
    if (forecastPlan.status !== "PASS") {
      await writeTextAtomic(
        forecastPlanPath,
        `${renderForecastPlanScreen(planningCase, forecastPlan)}\n`,
      );
      const receipt3 = await persistStage({
        runDir,
        runId,
        stageId: "decisions",
        status: "blocked",
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
          status: "BLOCKED",
          stage: "decisions",
          message: `${forecastPlan.unresolved_material_count} material forecast state(s) are unresolved.`,
          forecast_plan: forecastPlanJsonPath,
          receipt: receipt3,
          reused_stages: reusedStages,
        },
      });
    }
    answeredCase = materializeForecastPlan(planningCase, forecastPlan);
    const parityErrors = validateForecastPlanCaseParity(answeredCase, forecastPlan);
    if (parityErrors.length > 0) {
      throw new Error(`Materialized forecast plan parity failed: ${parityErrors[0]}`);
    }
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
      },
    });
  }
  if (options["stop-after"] === "decisions") {
    const carrier = await persistCurrentCarrier("READY_TO_BUILD", { model_case: answeredCasePath });
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
        reused_stages: reusedStages,
      },
    });
  }

  // Stage 4 — invoke the real portable workbook controller. The build folder
  // is content-addressed so a changed case never overwrites prior evidence.
  const stage4Dir = path.join(runDir, "stages", "build_checks");
  const caseHash = await hashFile(answeredCasePath);

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
      inputHashes: {
        stage3_receipt: receipt3.receipt_hash,
        model_case: caseHash,
        runtime: runtimeDigests.build_checks,
      },
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
  await writeJsonAtomic(brokerPath, validation.handoff.intake.broker_pack);
  await writeJsonAtomic(filingsPath, validation.handoff.intake.filings);
  const stage4Inputs = {
    stage3_receipt: receipt3.receipt_hash,
    model_case: caseHash,
    forecast_plan: await hashFile(forecastPlanJsonPath),
    runtime: runtimeDigests.build_checks,
  };
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
      "--json",
    ];
    if (options.python) args.push("--python", options.python);
    if (options.soffice) args.push("--soffice", options.soffice);
    const runtimeHome = path.join(runDir, ".runtime-home");
    const runtimeTmp = path.join(runDir, ".runtime-tmp");
    await fs.mkdir(runtimeHome, { recursive: true });
    await fs.mkdir(runtimeTmp, { recursive: true });
    const executed = await runCommand(process.execPath, args, {
      cwd: buildDir,
      timeout: Number(options.timeout ?? 600000),
      env: {
        ...process.env,
        HOME: runtimeHome,
        TMPDIR: runtimeTmp,
        PYTHONDONTWRITEBYTECODE: "1",
        EXCEL_INFLOW_WORKSPACE_TOKEN: workspaceToken,
      },
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
          status: buildResult.status ?? "BLOCKED",
          stage: "build_checks",
          message: buildResult.message,
          receipt: receipt4,
          reused_stages: reusedStages,
        },
      });
    }
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
        message: error.message,
        reused_stages: reusedStages,
      },
    });
  }

  // Stage 5 — deliver the workbook and concise read, while keeping the manual
  // native-Excel gate explicit. Delivery succeeds; production certification is
  // still PASS_PENDING_MANUAL until that external evidence is attached.
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
    runtime: runtimeDigests.delivery,
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
  .catch((error) => {
    process.stderr.write(`${error.stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
