#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "ci_command_with_custody_tests", importMetaUrl: import.meta.url });
const { exec } = run.runCli(() => ({}));
const RUNNER = path.join(run.HERE, "run_ci_command_with_custody.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ci-command-custody-tests-"));

async function invoke(label, code, timeoutMs = 5000) {
  const out = path.join(root, label);
  let exitCode = 0;
  try {
    await exec(process.execPath, [
      RUNNER,
      "--job-id", label,
      "--out", out,
      "--timeout-ms", String(timeoutMs),
      "--", process.execPath, "-e", code,
    ], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    exitCode = Number(error.code);
  }
  return {
    exitCode,
    out,
    receipt: JSON.parse(await fs.readFile(path.join(out, "command-receipt.json"), "utf8")),
  };
}

try {
  const pass = await invoke("pass", "process.stdout.write('ok'); process.stderr.write('note')");
  run.eq(pass.exitCode, 0, "a passing command exits 0");
  run.eq(pass.receipt.outcome.status, "PASS");
  run.eq(await fs.readFile(path.join(pass.out, "test-logs/pass.stdout.log"), "utf8"), "ok");
  run.eq(pass.receipt.logs.stdout.bytes, 2);

  const fail = await invoke("fail", "process.stderr.write('bad'); process.exit(7)");
  run.eq(fail.exitCode, 7, "the child's failing exit code propagates");
  run.eq(fail.receipt.outcome.status, "FAIL");
  run.eq(fail.receipt.outcome.exit_code, 7);

  const timeout = await invoke("timeout", "setInterval(() => {}, 1000)", 100);
  run.ne(timeout.exitCode, 0, "a timed-out command must not report success");
  run.eq(timeout.receipt.outcome.status, "TIMEOUT");
  run.eq(timeout.receipt.outcome.timed_out, true);

  const tampered = structuredClone(pass.receipt);
  tampered.logs.stdout.sha256 = "0".repeat(64);
  run.ne(tampered.logs.stdout.sha256, pass.receipt.logs.stdout.sha256, "the tampered digest differs before verification");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

run.finish({ mutations_caught: 3 });
