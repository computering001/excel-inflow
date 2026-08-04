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

const STAGE_RUNTIME_MEMBERS = Object.freeze({
  inputs: Object.freeze([
    "scripts/run_user_flow.mjs",
    "scripts/lib/evidence_run.mjs",
    "scripts/lib/json_schema.mjs",
    "scripts/lib/flow_runtime.mjs",
    "scripts/lib/user_flow_controller.mjs",
    "scripts/lib/run_store.mjs",
    "scripts/lib/process_tree.mjs",
    "scripts/lib/runtime_isolation.mjs",
    "scripts/lib/run_carrier.mjs",
    "assets/evidence-run-v1.schema.json",
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
  ]),
  delivery: Object.freeze([
    "scripts/lib/flow_read.mjs",
    "scripts/lib/flow_screens.mjs",
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
    !member.startsWith("references/") &&
    !STAGE_RUNTIME_MEMBERS.delivery.includes(member));
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
  if ((!positional[0] && !options.carrier) || !options.out) {
    throw new Error(
      "Usage: run_user_flow.mjs <evidence-run.json> --out <run-dir> or " +
        "run_user_flow.mjs --carrier <run-carrier.json> --out <run-dir> " +
        "[--answers <answers.txt|json>] [--python <python>] [--soffice <path>] " +
        "[--run-id <id>] [--workspace-token <token>] " +
        "[--stop-after <stage>] [--json]",
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
    verifiedCarrier = await verifyRunCarrier({
      skillRoot: ROOT,
      runRoot: runDir,
      carrierPath: path.resolve(String(options.carrier)),
      controllerVersion: FLOW_CONTROLLER_VERSION,
      workspaceToken,
    });
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
  const stage3Outputs = { model_case: answeredCasePath };
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
    await writeJsonAtomic(answeredCasePath, answeredCase);
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
      },
    });
  }
  if (options["stop-after"] === "decisions") {
    const carrier = await persistCurrentCarrier("READY_TO_BUILD", { model_case: answeredCasePath });
    return finish({
      runDir,
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

  // Stage 5 — deliver the workbook and concise read, while keeping the manual
  // native-Excel gate explicit. Delivery succeeds; production certification is
  // still PASS_PENDING_MANUAL until that external evidence is attached.
  const stage5Dir = path.join(runDir, "stages", "delivery");
  const deliveryResultPath = path.join(stage5Dir, "delivery-result.json");
  const deliveryScreenPath = path.join(stage5Dir, "delivery-screen.txt");
  const stage5Inputs = {
    stage4_receipt: receipt4.receipt_hash,
    model_case: caseHash,
    runtime: runtimeDigests.delivery,
  };
  const stage5Outputs = {
    delivery_result: deliveryResultPath,
    delivery_screen: deliveryScreenPath,
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
    deliveryScreen = renderDeliveryReport(delivered.report, { status: "review required" });
    deliveryResult = {
      outcome: delivered.outcome,
      report: delivered.report,
      workbook,
      automated_gate_status: buildResult.status,
      manual_gate: "native_excel_restoration_and_visual_review",
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
      carrier: carrier.path,
      evidence_run: stage1Evidence,
      model_case: answeredCasePath,
      total_violations: 0,
      manual_gate: "native_excel_restoration_and_visual_review",
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
    process.exitCode = ["PAUSED", "ACTION_REQUIRED", "PASS_PENDING_MANUAL"].includes(result.status)
      ? 0
      : 1;
  })
  .catch((error) => {
    process.stderr.write(`${error.stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
