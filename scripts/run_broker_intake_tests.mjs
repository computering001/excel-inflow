#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  BROKER_SKIP_PHRASE,
  compileBrokerIntakeChoice,
  verifyBrokerIntakeChoice,
} from "./lib/broker_intake_choice.mjs";
import { inspectScreen, renderBrokerIntakeScreen } from "./lib/flow_screens.mjs";

const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-broker-intake-"));
const filings = path.join(root, "filings-receipt.json");
const brokerA = path.join(root, "house-a.pdf");
const brokerB = path.join(root, "house-b.pdf");
await fs.writeFile(filings, '{"status":"PASS"}\n');
await fs.writeFile(brokerA, "%PDF broker A\n");
await fs.writeFile(brokerB, "%PDF broker B\n");
const runtime = "a".repeat(64);
const base = {
  schema_version: "broker-intake-request/1.0",
  run_id: "broker-intake-test",
  issuer_identity: { name: "Example plc", lei: null, ticker: "EXM" },
  filings_receipt_path: filings,
  runtime_closure_sha256: runtime,
  recorded_at: "2026-08-15T08:00:00.000Z",
};

let checks = 0;
function check(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}

const waiting = await compileBrokerIntakeChoice({ ...base, attachments: [], reply: "" });
check(waiting.status === "ACTION_REQUIRED", "zero files silently skipped Brokers");
check(waiting.intake_state === "awaiting_choice", "waiting choice has wrong intake state");
check(waiting.user_blocking === true && waiting.blocker_class === "USER_DECISION", "waiting choice ownership is wrong");

const screen = renderBrokerIntakeScreen("Example plc");
const screenInspection = inspectScreen(screen);
check(screenInspection.ok, screenInspection.violations.join("; "));
check(screen.includes("STATUS: ACTION REQUIRED"), "Brokers screen does not say action required");
check(screen.includes(BROKER_SKIP_PHRASE), "Brokers screen omits exact skip phrase");
check(!/no response is required/i.test(screen), "Brokers action screen falsely says no response required");

const skipped = await compileBrokerIntakeChoice({
  ...base,
  attachments: [],
  reply: BROKER_SKIP_PHRASE,
});
check(skipped.status === "COMPLETE", "explicit skip did not complete");
check(skipped.choice_receipt.intake_state === "explicitly_skipped", "skip receipt did not preserve explicit state");
check(skipped.choice_receipt.authority_state === "zero", "skip receipt did not set zero broker authority");
check(verifyBrokerIntakeChoice(skipped.choice_receipt, { run_id: base.run_id }).valid, "skip receipt did not independently verify");

const supplied = await compileBrokerIntakeChoice({
  ...base,
  attachments: [
    { attachment_id: "house-a", path: brokerA, media_type: "application/pdf" },
    { attachment_id: "house-b", path: brokerB, media_type: "application/pdf" },
  ],
  reply: "",
});
check(supplied.status === "COMPLETE", "supplied brokers did not complete intake");
check(supplied.choice_receipt.intake_state === "supplied", "supplied receipt has wrong state");
check(supplied.choice_receipt.attachments.length === 2, "supplied receipt lost attachment inventory");
check(verifyBrokerIntakeChoice(supplied.choice_receipt, { run_id: base.run_id }).valid, "supplied receipt did not independently verify");

const tampered = structuredClone(supplied.choice_receipt);
tampered.attachments[0].sha256 = "0".repeat(64);
check(!verifyBrokerIntakeChoice(tampered).valid, "tampered attachment hash passed receipt verification");
await assert.rejects(
  compileBrokerIntakeChoice({
    ...base,
    attachments: [{ attachment_id: "house-a", path: brokerA }],
    reply: BROKER_SKIP_PHRASE,
  }),
  /Do not combine/,
);
checks += 1;

const requestPath = path.join(root, "request.json");
const outputPath = path.join(root, "runner");
const { runtime_closure_sha256: _testRuntime, ...runnerBase } = base;
await fs.writeFile(requestPath, JSON.stringify({ ...runnerBase, attachments: [], reply: "" }));
const run = await exec(process.execPath, [
  new URL("./run_broker_intake.mjs", import.meta.url).pathname,
  requestPath,
  "--out",
  outputPath,
  "--json",
]);
const runnerState = JSON.parse(run.stdout);
check(runnerState.status === "ACTION_REQUIRED", "runner did not stop at Brokers");
check(runnerState.choice_receipt_path === null, "runner minted an implicit skip receipt");

process.stdout.write(`${JSON.stringify({ status: "PASS", checks, total_violations: 0 }, null, 2)}\n`);
