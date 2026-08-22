#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRunner } from "./lib/test_harness.mjs";
import {
  BROKER_SKIP_PHRASE,
  compileBrokerIntakeChoice,
  verifyBrokerIntakeChoice,
} from "./lib/broker_intake_choice.mjs";
import { inspectScreen, renderBrokerIntakeScreen } from "./lib/flow_screens.mjs";

const run = createRunner({ name: "broker_intake_tests", importMetaUrl: import.meta.url });
const { exec } = run.runCli();

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

const waiting = await compileBrokerIntakeChoice({ ...base, attachments: [], reply: "" });
run.ok(waiting.status === "ACTION_REQUIRED", "zero files silently skipped Brokers");
run.ok(waiting.intake_state === "awaiting_choice", "waiting choice has wrong intake state");
run.ok(waiting.user_blocking === true && waiting.blocker_class === "USER_DECISION", "waiting choice ownership is wrong");

const screen = renderBrokerIntakeScreen("Example plc");
const screenInspection = inspectScreen(screen);
run.ok(screenInspection.ok, screenInspection.violations.join("; "));
run.ok(screen.includes("STATUS: ACTION REQUIRED"), "Brokers screen does not say action required");
run.ok(screen.includes(BROKER_SKIP_PHRASE), "Brokers screen omits exact skip phrase");
run.doesNotMatch(screen, /no response is required/i, "Brokers action screen falsely says no response required");

const skipped = await compileBrokerIntakeChoice({
  ...base,
  attachments: [],
  reply: BROKER_SKIP_PHRASE,
});
run.ok(skipped.status === "COMPLETE", "explicit skip did not complete");
run.ok(skipped.choice_receipt.intake_state === "explicitly_skipped", "skip receipt did not preserve explicit state");
run.ok(skipped.choice_receipt.authority_state === "zero", "skip receipt did not set zero broker authority");
run.ok(verifyBrokerIntakeChoice(skipped.choice_receipt, { run_id: base.run_id }).valid, "skip receipt did not independently verify");

const supplied = await compileBrokerIntakeChoice({
  ...base,
  attachments: [
    { attachment_id: "house-a", path: brokerA, media_type: "application/pdf" },
    { attachment_id: "house-b", path: brokerB, media_type: "application/pdf" },
  ],
  reply: "",
});
run.ok(supplied.status === "COMPLETE", "supplied brokers did not complete intake");
run.ok(supplied.choice_receipt.intake_state === "supplied", "supplied receipt has wrong state");
run.ok(supplied.choice_receipt.attachments.length === 2, "supplied receipt lost attachment inventory");
run.ok(verifyBrokerIntakeChoice(supplied.choice_receipt, { run_id: base.run_id }).valid, "supplied receipt did not independently verify");

const tampered = structuredClone(supplied.choice_receipt);
tampered.attachments[0].sha256 = "0".repeat(64);
run.ok(!verifyBrokerIntakeChoice(tampered).valid, "tampered attachment hash passed receipt verification");
try {
  await compileBrokerIntakeChoice({
    ...base,
    attachments: [{ attachment_id: "house-a", path: brokerA }],
    reply: BROKER_SKIP_PHRASE,
  });
  run.ok(false, "combining the skip phrase with attachments was accepted");
} catch (error) {
  run.match(String(error?.message ?? error), /Do not combine/, "skip phrase plus attachments is refused");
}

const requestPath = path.join(root, "request.json");
const outputPath = path.join(root, "runner");
const { runtime_closure_sha256: _testRuntime, ...runnerBase } = base;
await fs.writeFile(requestPath, JSON.stringify({ ...runnerBase, attachments: [], reply: "" }));
const childRun = await exec(process.execPath, [
  new URL("./run_broker_intake.mjs", import.meta.url).pathname,
  requestPath,
  "--out",
  outputPath,
  "--json",
]);
const runnerState = JSON.parse(childRun.stdout);
run.ok(runnerState.status === "ACTION_REQUIRED", "runner did not stop at Brokers");
run.ok(runnerState.choice_receipt_path === null, "runner minted an implicit skip receipt");

run.finish({ total_violations: 0 });
