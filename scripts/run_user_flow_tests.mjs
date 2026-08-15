#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { COMPANY_SCREEN, inspectScreen, renderBrokerIntakeScreen, WELCOME_SCREEN } from "./lib/flow_screens.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import { assessCoverage } from "./lib/coverage.mjs";
import { canonicalBrokerIntakeJson, compileBrokerIntakeChoice } from "./lib/broker_intake_choice.mjs";
import {
  DELIVERY_BLOCKED_OUTCOMES,
  DELIVERY_FATAL_REASONS,
  normaliseUserFlowResult,
} from "./lib/workflow_state.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cases = path.resolve(
  process.argv[2] ??
    process.env.DEBT_OVERLAY_CASES_DIR ??
    "/Users/archiepreston/Documents/Codex/2026-07-24/ok/work/v2-certification/cases",
);
const out = path.resolve(
  process.argv[3] ?? await fs.mkdtemp(path.join(os.tmpdir(), "dmu-user-flow-test-")),
);
await fs.mkdir(out, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function command(script, args, { allowFailure = false } = {}) {
  try {
    return await exec(process.execPath, [path.join(HERE, script), ...args], {
      cwd: path.resolve(HERE, ".."),
      timeout: 300000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (!allowFailure) throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
}

async function flow(evidence, runDir, extra = [], options = {}) {
  const result = await command(
    "run_user_flow.mjs",
    [evidence, "--out", runDir, ...extra, "--json"],
    options,
  );
  return JSON.parse(result.stdout);
}

async function visibleFlow(evidence, runDir, extra = [], options = {}) {
  return command(
    "run_user_flow.mjs",
    [evidence, "--out", runDir, ...extra],
    options,
  );
}

const cleanEvidence = path.join(out, "clean-evidence-run.json");
const acquisitionEvidence = path.join(out, "acquisition-question-evidence-run.json");
await command("run_evidence_run_tests.mjs", [
  cases,
  "--emit-clean", cleanEvidence,
  "--emit-acquisition-question", acquisitionEvidence,
]);
const cleanEvidencePayload = JSON.parse(await fs.readFile(cleanEvidence, "utf8"));
const brokerChoiceFilingsReceipt = path.join(out, "broker-choice-filings-receipt.json");
await fs.writeFile(brokerChoiceFilingsReceipt, '{"status":"PASS"}\n');
const compiledBrokerSkip = await compileBrokerIntakeChoice({
  schema_version: "broker-intake-request/1.0",
  run_id: cleanEvidencePayload.run_id,
  issuer_identity: { name: cleanEvidencePayload.company_name ?? "Test issuer" },
  filings_receipt_path: brokerChoiceFilingsReceipt,
  runtime_closure_sha256: "a".repeat(64),
  attachments: [],
  reply: "continue without brokers",
  recorded_at: "2026-08-15T08:00:00.000Z",
});
const brokerSkipChoicePath = path.join(out, "broker-intake-choice.json");
await fs.writeFile(
  brokerSkipChoicePath,
  canonicalBrokerIntakeJson(compiledBrokerSkip.choice_receipt),
);

const tests = [];
async function test(name, callback) {
  try {
    await callback();
    tests.push({ name, status: "PASS" });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    tests.push({ name, status: "FAIL", message: error.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

await test("bare chat invocation is routed to the canonical Company screen", async () => {
  const skillRoot = path.resolve(HERE, "..");
  const skillInstructions = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const runtimeCore = await fs.readFile(
    path.join(skillRoot, "references", "runtime-core.md"),
    "utf8",
  );
  const centralInstructions = await fs.readFile(
    path.join(skillRoot, "central-instructions.md"),
    "utf8",
  );
  for (const [name, text] of [
    ["SKILL.md", skillInstructions],
    ["runtime-core.md", runtimeCore],
    ["central-instructions.md", centralInstructions],
  ]) {
    const flatText = text.replace(/\s+/g, " ");
    assert(text.includes("run excel inflow"), `${name} does not declare the bare trigger`);
    assert(
      text.includes("node scripts/run_excel_inflow_vnext.mjs --screen company"),
      `${name} does not route the bare trigger to the production controller`,
    );
    assert(
      text.includes("+=[ EXCEL INFLOW ]") && text.includes("[ COMPANY ]"),
      `${name} does not embed the canonical fenced entry screen`,
    );
    assert(
      /restyle|Never retype/.test(text),
      `${name} permits the failed generic intake response`,
    );
    assert(
      flatText.includes("asks for the COMPANY ONLY") ||
        flatText.includes("collects the company only"),
      `${name} still demands the full pack at entry`,
    );
    assert(
      flatText.includes("The bare trigger is presentation-only"),
      `${name} permits deployment work before the Company screen`,
    );
    assert(
      flatText.includes("Deployment certification belongs to the versioned installation transaction"),
      `${name} permits per-invocation release certification`,
    );
    assert(
      flatText.includes("emit progress prose"),
      `${name} permits visible pre-Company status text`,
    );
    assert(
      flatText.includes("Strict fresh-chat isolation") &&
        flatText.includes("saved memory, prior chat, recent upload") &&
        flatText.includes("end the turn immediately") &&
        flatText.includes("Only a later user message in this chat"),
      `${name} permits a bare trigger to inherit or auto-consume prior company context`,
    );
  }
  const welcome = await command("run_user_flow.mjs", ["--screen", "inputs"]);
  assert(welcome.stdout === `${WELCOME_SCREEN}\n`, "bare trigger target is not canonical Company bytes");
});

await test("vNext is the single public Company-screen controller", async () => {
  const result = await command("run_excel_inflow_vnext.mjs", ["--screen", "company"]);
  assert(result.stdout === `${COMPANY_SCREEN}\n`, "vNext did not render the canonical Company screen bytes");
  assert(inspectScreen(result.stdout).ok, "vNext Company screen violates the screen contract");
});

await test("production controller owns one canonical six-milestone visible journey", async () => {
  const stages = ["inputs", "evidence_review", "decisions", "build_checks", "delivery"];
  const expectedCompleted = [0, 4, 4, 4, 5];
  for (const [index, stage] of stages.entries()) {
    const result = await command("run_user_flow.mjs", ["--screen", stage]);
    const screen = result.stdout.replace(/\n$/, "");
    assert(
      screen.includes(`PROGRESS: ${expectedCompleted[index]} OF 6 COMPLETE`),
      `${stage} visible progress is missing`,
    );
    assert(!/STAGE\s+\d+\s+OF\s+\d+/i.test(screen), `${stage} leaks internal stage numbering`);
    assert(inspectScreen(screen).violations.length === 0, `${stage} screen violates the contract`);
  }
  const welcome = await command("run_user_flow.mjs", ["--screen", "inputs"]);
  assert(welcome.stdout === `${WELCOME_SCREEN}\n`, "production welcome differs from canonical bytes");
  const brokers = await command("run_user_flow.mjs", ["--screen", "brokers"]);
  const expectedBrokers = renderBrokerIntakeScreen("the selected company");
  assert(brokers.stdout === `${expectedBrokers}\n`, "Brokers checkpoint differs from canonical bytes");
  assert(brokers.stdout.includes("STATUS: ACTION REQUIRED"), "Brokers checkpoint is not action-required");
  assert(brokers.stdout.includes("continue without brokers"), "Brokers checkpoint omits explicit skip");
  assert(!brokers.stdout.includes("no response is required"), "Brokers checkpoint falsely claims no response");
});

await test("successful ordinary transitions emit ASCII while JSON remains pure", async () => {
  const runDir = path.join(out, "presentation-run");
  const inputs = await visibleFlow(cleanEvidence, runDir, ["--stop-after", "inputs"]);
  const evidence = await visibleFlow(cleanEvidence, runDir, ["--stop-after", "evidence_review"]);
  const decisions = await visibleFlow(cleanEvidence, runDir, ["--stop-after", "decisions"]);
  const screens = [inputs.stdout, evidence.stdout, decisions.stdout].map((value) => value.replace(/\n$/, ""));
  assert(screens[0].includes("PROGRESS: 4 OF 6 COMPLETE - BUILD NEXT"), "input-pack review progress is missing");
  assert(screens[0].includes("FactSet debt rows"), "FactSet row count is not explicitly labelled");
  assert(screens[0].includes("FactSet populated cells"), "FactSet cell count is not explicitly labelled");
  assert(!screens[0].includes("Source rows preserved"), "ambiguous cross-lane row count remains");
  assert(screens[0].includes("continues automatically; no response is required"), "input-pack review does not declare automatic continuation");
  assert(screens[1].includes("STATUS: COMPLETE"), "input-pack review completion screen is missing");
  assert(screens[2].includes("MATERIAL FORECAST PLAN"), "forecast plan is missing");
  assert(screens[2].includes("totals and links calculate"), "forecast/calculation boundary is missing");
  assert(screens[2].includes("continues automatically into Build"), "automatic Build continuation is missing");
  assert(!screens[2].includes("Reply continue to build"), "an undeclared pre-build stop remains");
  for (const screen of screens) {
    assert(inspectScreen(screen).violations.length === 0, "transition screen violates the contract");
    assert(!screen.includes('"schema_version"'), "machine JSON leaked into the visible route");
  }
  const machine = await command("run_user_flow.mjs", [
    cleanEvidence,
    "--out", runDir,
    "--stop-after", "decisions",
    "--json",
  ]);
  const parsed = JSON.parse(machine.stdout);
  assert(parsed.status === "PAUSED" && parsed.stage === "decisions", machine.stdout);
  assert(!machine.stdout.includes("MATERIAL FORECAST PLAN"), "ASCII leaked into JSON mode");
});

await test("no-question production path pauses after decisions", async () => {
  const result = await flow(cleanEvidence, path.join(out, "clean-run"), ["--stop-after", "decisions"]);
  assert(result.status === "PAUSED" && result.stage === "decisions", JSON.stringify(result));
  assert(result.reused_stages.length === 0, "first run unexpectedly reused a stage");
  const modelCase = JSON.parse(await fs.readFile(
    path.join(out, "clean-run", "stages", "decisions", "model-case.json"),
    "utf8",
  ));
  const modelCaseSchema = JSON.parse(await fs.readFile(
    path.join(HERE, "..", "assets", "model-case-v2.schema.json"),
    "utf8",
  ));
  const schemaErrors = validateJsonSchema(modelCase, modelCaseSchema);
  assert(schemaErrors.length === 0, `compiled decision case violates model-case schema: ${schemaErrors.join("; ")}`);
  const coverage = assessCoverage(modelCase);
  assert(
    coverage.ready_to_build,
    `compiled decision case fails build coverage: ${coverage.checks.filter((item) => item.status === "BLOCK").map((item) => item.id).join(", ")}`,
  );
  const aliasOwner = modelCase.statement_structure.income_statement.find(
    (row) => Array.isArray(row.role_aliases) && row.role_aliases.length > 0,
  );
  assert(aliasOwner?.role_aliases.includes("ebit"), "collapsed EBIT identity has no typed role alias");
  const mutated = structuredClone(modelCase);
  const mutatedAliasOwner = mutated.statement_structure.income_statement.find(
    (row) => row.row_id === aliasOwner.row_id,
  );
  mutatedAliasOwner.role_aliases.push(mutatedAliasOwner.role_aliases[0]);
  assert(
    validateJsonSchema(mutated, modelCaseSchema).some((error) => /unique/i.test(error)),
    "duplicate role alias mutation passed the model-case schema",
  );
  const changeInDebt = modelCase.statement_structure.cash_flow.find(
    (row) => row.semantic_role === "change_in_debt",
  );
  assert(
    changeInDebt?.historical_authority === "derived_formula" &&
      changeInDebt.calculation?.operator === "sum" &&
      (changeInDebt.calculation?.refs ?? []).length > 0,
    "compiler-created Change in Debt does not declare its historical formula authority",
  );
});

await test("run carrier references the canonical evidence snapshot without copying it", async () => {
  const runDir = path.join(out, "clean-run");
  const carrier = JSON.parse(
    await fs.readFile(path.join(runDir, "run-carrier.json"), "utf8"),
  );
  assert(
    carrier.files?.evidence_run?.path === "stages/inputs/evidence-run.json",
    `carrier points at a duplicate evidence payload: ${carrier.files?.evidence_run?.path}`,
  );
  let duplicateExists = true;
  try {
    await fs.access(path.join(runDir, "carrier", "evidence-run.json"));
  } catch {
    duplicateExists = false;
  }
  assert(!duplicateExists, "carrier copied the full evidence envelope a second time");
});

await test("run carrier preserves a sealed broker choice and never infers zero files as skip", async () => {
  const runDir = path.join(out, "broker-choice-carrier-run");
  const result = await flow(cleanEvidence, runDir, [
    "--broker-intake-choice", brokerSkipChoicePath,
    "--stop-after", "decisions",
  ]);
  assert(result.status === "PAUSED", JSON.stringify(result));
  const carrier = JSON.parse(await fs.readFile(path.join(runDir, "run-carrier.json"), "utf8"));
  assert(carrier.broker_intake_state === "choice_recorded", "carrier lost broker choice state");
  assert(carrier.files?.broker_intake_choice, "carrier omitted broker choice receipt");
  const ordinaryCarrier = JSON.parse(await fs.readFile(path.join(out, "clean-run", "run-carrier.json"), "utf8"));
  assert(ordinaryCarrier.broker_intake_state === "awaiting_choice", "legacy zero-file carrier was silently classified as skip");
});

await test("identical restart reuses all completed stages", async () => {
  const result = await flow(cleanEvidence, path.join(out, "clean-run"), ["--stop-after", "decisions"]);
  assert(
    JSON.stringify(result.reused_stages) === JSON.stringify(["inputs", "evidence_review", "decisions"]),
    `unexpected reuse set ${JSON.stringify(result.reused_stages)}`,
  );
});

await test("tampered stage output invalidates only that stage", async () => {
  const modelCase = path.join(out, "clean-run", "stages", "decisions", "model-case.json");
  const payload = JSON.parse(await fs.readFile(modelCase, "utf8"));
  payload.issuer.name = "Tampered Issuer";
  await fs.writeFile(modelCase, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const result = await flow(cleanEvidence, path.join(out, "clean-run"), ["--stop-after", "decisions"]);
  assert(
    JSON.stringify(result.reused_stages) === JSON.stringify(["inputs", "evidence_review"]),
    `tamper did not target decisions: ${JSON.stringify(result.reused_stages)}`,
  );
  const restored = JSON.parse(await fs.readFile(modelCase, "utf8"));
  assert(restored.issuer.name !== "Tampered Issuer", "tampered output was retained");
});

await test("question path stops once and never treats action-required as success", async () => {
  const runDir = path.join(out, "question-run");
  const first = await flow(acquisitionEvidence, runDir, ["--stop-after", "decisions"]);
  assert(first.status === "ACTION_REQUIRED" && first.question_count === 1, JSON.stringify(first));
  assert(
    first.blocker_class === "USER_DECISION" && first.user_blocking === true,
    "action-required result lacks typed user-decision ownership",
  );
  const second = await flow(acquisitionEvidence, runDir, ["--stop-after", "decisions"]);
  assert(second.status === "ACTION_REQUIRED", JSON.stringify(second));
  assert(!second.reused_stages.includes("decisions"), "action-required decision stage was reused as success");
});

await test("delivery blocker constitution covers every terminal user-flow outcome", async () => {
  const source = await fs.readFile(path.join(HERE, "run_user_flow.mjs"), "utf8");
  const blockedOutcomes = [...source.matchAll(
    /status:\s*"BLOCKED"[\s\S]{0,220}?outcome:\s*"([a-z0-9_]+)"/g,
  )].map((match) => match[1]);
  blockedOutcomes.push(
    "bad_inputs",
    "filings_incomplete",
    "entity_stop",
    "reconciliation_stop",
    "awaiting_reexport",
    "decision_replay_blocked",
    "decision_graph_blocked",
  );
  assert(blockedOutcomes.length > 0, "user flow exposes no statically auditable BLOCKED outcomes");
  const declared = new Set(Object.keys(DELIVERY_BLOCKED_OUTCOMES));
  for (const outcome of new Set(blockedOutcomes)) {
    const binding = DELIVERY_BLOCKED_OUTCOMES[outcome];
    assert(
      binding && DELIVERY_FATAL_REASONS.includes(binding.fatal_reason),
      `${outcome} lacks one of the declared fatal delivery reasons`,
    );
    assert(binding.domain, `${outcome} lacks a blocker domain`);
    declared.delete(outcome);
  }
  assert(declared.size === 0, `constitution declares stale BLOCKED outcomes: ${[...declared].join(", ")}`);
  let undeclaredRejected = false;
  try {
    normaliseUserFlowResult({
      status: "BLOCKED",
      stage: "evidence_review",
      outcome: "future_undeclared_stop",
      blocker_class: "INTERNAL_WORK",
    });
  } catch {
    undeclaredRejected = true;
  }
  assert(undeclaredRejected, "an undeclared future delivery blocker was accepted");
  let brokerRejected = false;
  try {
    normaliseUserFlowResult({
      status: "BLOCKED",
      stage: "evidence_review",
      outcome: "broker_uncertainty_blocked",
      blocker_class: "INTERNAL_WORK",
    });
  } catch {
    brokerRejected = true;
  }
  assert(brokerRejected, "broker uncertainty became a terminal delivery blocker");
});

await test("supplied answer persists and resumes deterministically", async () => {
  const answers = path.join(out, "acquisition-answers.json");
  await fs.writeFile(answers, `${JSON.stringify({ answers: { acquisition_funding: "debt" } }, null, 2)}\n`);
  const runDir = path.join(out, "question-run");
  const first = await flow(acquisitionEvidence, runDir, [
    "--answers", answers,
    "--stop-after", "decisions",
  ]);
  assert(first.status === "PAUSED", JSON.stringify(first));
  const second = await flow(acquisitionEvidence, runDir, [
    "--answers", answers,
    "--stop-after", "decisions",
  ]);
  assert(second.reused_stages.includes("decisions"), JSON.stringify(second));
  const answered = JSON.parse(
    await fs.readFile(path.join(runDir, "stages", "decisions", "model-case.json"), "utf8"),
  );
  assert(answered.acquisition?.enabled === 1, "debt-funded acquisition answer was not applied");
});

await test("invalid evidence blocks before reconciliation", async () => {
  const invalid = path.join(out, "invalid-evidence-run.json");
  const payload = JSON.parse(await fs.readFile(cleanEvidence, "utf8"));
  payload.dcs_export.entity.name = "Wrong Entity plc";
  await fs.writeFile(invalid, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const result = await flow(invalid, path.join(out, "invalid-run"), [], { allowFailure: true });
  assert(result.status === "BLOCKED" && result.stage === "inputs", JSON.stringify(result));
  assert(
    result.blocker_class === "INTERNAL_WORK" && result.user_blocking === false,
    "controller-produced invalid evidence leaked as a user re-upload request",
  );
});

await test("a case edited while the run waited blocks the resume by name", async () => {
  const answers = path.join(out, "pause-mutation-answers.json");
  await fs.writeFile(answers, `${JSON.stringify({ answers: { acquisition_funding: "debt" } }, null, 2)}\n`);
  const runDir = path.join(out, "pause-mutation-run");
  const workspaceToken = "workspace:pause-mutation-fixture";
  const paused = await flow(acquisitionEvidence, runDir, [
    "--answers", answers,
    "--workspace-token", workspaceToken,
    "--stop-after", "decisions",
  ]);
  assert(paused.status === "PAUSED", `expected a pause to resume from: ${JSON.stringify(paused)}`);
  const carrierPath = paused.carrier ?? path.join(runDir, "run-carrier.json");
  const resume = async () => {
    const result = await command(
      "run_user_flow.mjs",
      [
        "--out", runDir,
        "--carrier", carrierPath,
        "--workspace-token", workspaceToken,
        "--stop-after", "decisions",
        "--json",
      ],
      { allowFailure: true },
    );
    return JSON.parse(result.stdout);
  };
  const untouched = await resume();
  assert(
    untouched.status !== "BLOCKED",
    `an untouched pause must resume: ${JSON.stringify(untouched)}`,
  );
  const casePath = path.join(runDir, "stages", "decisions", "model-case.json");
  const payload = JSON.parse(await fs.readFile(casePath, "utf8"));
  payload.issuer.name = "Substituted Issuer plc";
  await fs.writeFile(casePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const blocked = await resume();
  assert(
    blocked.status === "BLOCKED" && /run_case_mutated_during_pause/.test(String(blocked.message)),
    `a substituted case resumed instead of blocking: ${JSON.stringify(blocked)}`,
  );
  assert(
    blocked.blocker_class === "INTERNAL_WORK" && blocked.user_blocking === false,
    "run mutation leaked as a user evidence blocker",
  );
});

const failures = tests.filter((entry) => entry.status !== "PASS");
const report = {
  schema_version: "production-user-flow-test-report/1.0",
  passed: tests.length - failures.length,
  failed: failures.length,
  tests,
};
await fs.writeFile(path.join(out, "production-user-flow-test-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${report.passed}/${tests.length} production user-flow tests pass`);
if (failures.length > 0) process.exitCode = 1;
