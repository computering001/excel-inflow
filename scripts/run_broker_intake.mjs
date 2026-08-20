#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  brokerIntakeRuntimeClosure,
  canonicalBrokerIntakeJson,
  compileBrokerIntakeChoice,
} from "./lib/broker_intake_choice.mjs";
import { renderBrokerIntakeScreen } from "./lib/flow_screens.mjs";
import { assertWorkflowState } from "./lib/workflow_state.mjs";

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    else options[key] = argv[++index];
  }
  return { positional, options };
}

async function atomicWrite(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, value);
  await fs.rename(temporary, target);
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (!positional[0] || !options.out) {
    throw new Error("Usage: run_broker_intake.mjs <broker-intake-request.json> --out <folder> [--json]");
  }
  const requestPath = path.resolve(positional[0]);
  const outputRoot = path.resolve(String(options.out));
  const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
  const runtimeClosureSha256 = await brokerIntakeRuntimeClosure(SKILL_ROOT);
  const compiled = await compileBrokerIntakeChoice(request, {
    baseDirectory: path.dirname(requestPath),
    runtimeClosureSha256,
  });
  assertWorkflowState("broker_intake", {
    status: compiled.status,
    blockerClass: compiled.blocker_class,
    userBlocking: compiled.user_blocking,
  });
  const screen = renderBrokerIntakeScreen(request.issuer_identity?.name);
  const screenPath = path.join(outputRoot, "broker-intake-screen.txt");
  await atomicWrite(screenPath, `${screen}\n`);
  let choiceReceiptPath = null;
  if (compiled.choice_receipt) {
    choiceReceiptPath = path.join(outputRoot, "broker-intake-choice.json");
    await atomicWrite(choiceReceiptPath, canonicalBrokerIntakeJson(compiled.choice_receipt));
  }
  const state = {
    schema_version: "broker-intake-run/1.0",
    run_id: request.run_id,
    status: compiled.status,
    blocker_class: compiled.blocker_class,
    user_blocking: compiled.user_blocking,
    intake_state: compiled.intake_state,
    processing_state: compiled.processing_state,
    authority_state: compiled.authority_state,
    choice_receipt_path: choiceReceiptPath,
    screen_path: screenPath,
    summary: compiled.status === "ACTION_REQUIRED"
      ? { message: "Attach 1-10 broker reports or explicitly continue without brokers." }
      : { message: compiled.intake_state === "supplied" ? "Broker reports supplied; internal processing may begin." : "Broker research explicitly skipped; continue to Debt." },
  };
  const statePath = path.join(outputRoot, "broker-intake-run-state.json");
  await atomicWrite(statePath, canonicalBrokerIntakeJson(state));
  if (options.json) process.stdout.write(canonicalBrokerIntakeJson({ ...state, state_path: statePath }));
  else if (compiled.status === "ACTION_REQUIRED") process.stdout.write(`${screen}\n`);
  else process.stdout.write(`${compiled.intake_state === "supplied" ? "brokers supplied" : "brokers explicitly skipped"}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
