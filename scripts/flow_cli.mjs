#!/usr/bin/env node
/**
 * Portable user-flow command.
 *
 * The command deliberately consumes normalised JSON. Reading a PDF, spreadsheet
 * or filing is an evidence-extraction task; pretending this small runtime is a
 * universal document parser would turn an unsupported file into invented facts.
 * Once the evidence has been normalised, this command owns the deterministic
 * intake, reconciliation, question, answer and delivery stages.
 *
 * Usage:
 *   node scripts/flow_cli.mjs welcome
 *   node scripts/flow_cli.mjs start <evidence-run.json>
 *        [--residual reexport] [--out <result.json>]
 *   node scripts/flow_cli.mjs answer-run <evidence-run.json>
 *        <answers.txt|answers.json> [--residual reexport]
 *        [--case-out <answered-case.json>] [--out <result.json>]
 *   node scripts/flow_cli.mjs intake <intake.json> <draft-case.json>
 *        [--residual reexport] [--out <result.json>]
 *   node scripts/flow_cli.mjs answer <intake.json> <draft-case.json>
 *        <answers.txt|answers.json> [--residual reexport]
 *        [--case-out <answered-case.json>] [--out <result.json>]
 *   node scripts/flow_cli.mjs deliver <case.json> [--out <result.json>]
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  applyAnswers,
  deliver,
  parseAnswers,
  renderFailure,
  runIntake,
  WELCOME_SCREEN,
} from "./lib/flow.mjs";
import { validateEvidenceRun } from "./lib/evidence_run.mjs";
import { assertWriteTargetOutsideSkill } from "./lib/runtime_isolation.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

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

function readJson(target, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(target), "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

function writeJson(target, payload) {
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(path.resolve(target), `${JSON.stringify(payload, null, 2)}\n`);
}

function serialisable(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "function" ? undefined : item,
    ),
  );
}

function emit(result, outputPath = null) {
  const clean = serialisable(result);
  if (outputPath) writeJson(outputPath, clean);
  if (result.screen) process.stdout.write(`${result.screen}\n`);
  else process.stdout.write(`${JSON.stringify(clean, null, 2)}\n`);
}

function loadAnswers(target, questions) {
  const text = fs.readFileSync(path.resolve(target), "utf8");
  if (target.toLowerCase().endsWith(".json")) {
    const payload = JSON.parse(text);
    return new Map(Object.entries(payload.answers ?? payload));
  }
  return parseAnswers(text, questions);
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/flow_cli.mjs welcome",
      "  node scripts/flow_cli.mjs start <evidence-run.json> [--residual reexport] [--out result.json]",
      "  node scripts/flow_cli.mjs answer-run <evidence-run.json> <answers.txt|answers.json> [--residual reexport] [--case-out answered-case.json] [--out result.json]",
      "  node scripts/flow_cli.mjs intake <intake.json> <draft-case.json> [--residual reexport] [--out result.json]",
      "  node scripts/flow_cli.mjs answer <intake.json> <draft-case.json> <answers.txt|answers.json> [--residual reexport] [--case-out answered-case.json] [--out result.json]",
      "  node scripts/flow_cli.mjs deliver <case.json> [--out result.json]",
      "",
    ].join("\n"),
  );
}

async function main(argv) {
  const { positional, options } = parseArgs(argv);
  const [command, ...args] = positional;
  for (const key of ["out", "case-out"]) {
    if (!options[key]) continue;
    options[key] = await assertWriteTargetOutsideSkill({
      skillRoot: SKILL_ROOT,
      target: String(options[key]),
    });
  }

  if (command === "welcome") {
    process.stdout.write(`${WELCOME_SCREEN}\n`);
    return 0;
  }

  if (command === "start" || command === "answer-run") {
    const minimum = command === "answer-run" ? 2 : 1;
    if (args.length < minimum) {
      usage();
      return 2;
    }
    const evidenceRun = readJson(args[0], "evidence run");
    const validation = validateEvidenceRun(evidenceRun);
    if (!validation.ok) {
      const errors = validation.errors.map((entry) => entry.message);
      emit(
        {
          outcome: "bad_evidence",
          stage: 1,
          errors,
          evidence_validation: validation,
          screen: renderFailure({
            stage: "evidence",
            what_failed: `I can't start: ${errors[0] ?? "the evidence run is invalid"}`,
            why:
              errors.length > 1
                ? `${errors.length - 1} other evidence problem${errors.length > 2 ? "s" : ""} as well.`
                : null,
            what_would_fix_it: errors,
          }),
        },
        options.out ?? null,
      );
      return 1;
    }
    const first = runIntake({
      intake: validation.handoff.intake,
      draftCase: validation.handoff.model_case,
      residualDecision: options.residual ?? null,
    });
    if (command === "start") {
      emit(
        { ...first, evidence_validation: validation },
        options.out ?? null,
      );
      return [
        "bad_inputs",
        "entity_stop",
        "filings_incomplete",
        "inputs_look_wrong",
      ].includes(first.outcome)
        ? 1
        : 0;
    }
    if (first.outcome !== "questions") {
      emit(
        { ...first, evidence_validation: validation },
        options.out ?? null,
      );
      return first.outcome === "proceed" ? 0 : 1;
    }
    const answers = loadAnswers(args[1], first.plan.questions);
    const applied = applyAnswers({
      workingCase: first.working_case,
      plan: first.plan,
      answers,
    });
    if (options["case-out"]) {
      writeJson(options["case-out"], applied.modelCase);
    }
    emit(
      {
        outcome: "answered",
        model_case: applied.modelCase,
        applied: applied.applied,
        settled: applied.settled,
        evidence_validation: validation,
      },
      options.out ?? null,
    );
    return 0;
  }

  if (command === "intake" || command === "answer") {
    const minimum = command === "answer" ? 3 : 2;
    if (args.length < minimum) {
      usage();
      return 2;
    }
    const intake = readJson(args[0], "intake");
    const draftCase = readJson(args[1], "draft case");
    const first = runIntake({
      intake,
      draftCase,
      residualDecision: options.residual ?? null,
    });

    if (command === "intake") {
      emit(first, options.out ?? null);
      return ["bad_inputs", "entity_stop", "filings_incomplete", "inputs_look_wrong"].includes(
        first.outcome,
      )
        ? 1
        : 0;
    }

    if (first.outcome !== "questions") {
      emit(first, options.out ?? null);
      return first.outcome === "proceed" ? 0 : 1;
    }
    const answers = loadAnswers(args[2], first.plan.questions);
    const applied = applyAnswers({
      workingCase: first.working_case,
      plan: first.plan,
      answers,
    });
    if (options["case-out"]) writeJson(options["case-out"], applied.modelCase);
    const result = {
      outcome: "answered",
      applied: applied.applied,
      settled: applied.settled,
      model_case: applied.modelCase,
    };
    emit(result, options.out ?? null);
    return 0;
  }

  if (command === "deliver") {
    if (args.length < 1) {
      usage();
      return 2;
    }
    const result = deliver({ modelCase: readJson(args[0], "case") });
    emit(result, options.out ?? null);
    return result.outcome === "delivered" ? 0 : 1;
  }

  usage();
  return 2;
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
