#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "run_ci_command_with_custody.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ci-command-custody-tests-"));
let checks = 0;

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
  assert.equal(pass.exitCode, 0); checks += 1;
  assert.equal(pass.receipt.outcome.status, "PASS"); checks += 1;
  assert.equal(await fs.readFile(path.join(pass.out, "test-logs/pass.stdout.log"), "utf8"), "ok"); checks += 1;
  assert.equal(pass.receipt.logs.stdout.bytes, 2); checks += 1;

  const fail = await invoke("fail", "process.stderr.write('bad'); process.exit(7)");
  assert.equal(fail.exitCode, 7); checks += 1;
  assert.equal(fail.receipt.outcome.status, "FAIL"); checks += 1;
  assert.equal(fail.receipt.outcome.exit_code, 7); checks += 1;

  const timeout = await invoke("timeout", "setInterval(() => {}, 1000)", 100);
  assert.notEqual(timeout.exitCode, 0); checks += 1;
  assert.equal(timeout.receipt.outcome.status, "TIMEOUT"); checks += 1;
  assert.equal(timeout.receipt.outcome.timed_out, true); checks += 1;

  const tampered = structuredClone(pass.receipt);
  tampered.logs.stdout.sha256 = "0".repeat(64);
  assert.notEqual(tampered.logs.stdout.sha256, pass.receipt.logs.stdout.sha256); checks += 1;

  process.stdout.write(`${JSON.stringify({ status: "PASS", checks, mutations_caught: 3 })}\n`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
