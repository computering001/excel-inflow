#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { runProcessTree } from "./lib/process_tree.mjs";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

const separator = process.argv.indexOf("--");
const out = option("out");
const jobId = option("job-id");
const timeoutMs = Number(option("timeout-ms", "3600000"));
if (!out || !jobId || separator < 0 || separator === process.argv.length - 1) {
  throw new Error(
    "Usage: run_ci_command_with_custody.mjs --job-id <id> --out <directory> " +
      "[--timeout-ms <ms>] -- <command> [arguments...]",
  );
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("--timeout-ms must be a positive finite number.");
}

const command = process.argv[separator + 1];
const args = process.argv.slice(separator + 2);
const outputRoot = path.resolve(out);
const logsRoot = path.join(outputRoot, "test-logs");
await fs.mkdir(logsRoot, { recursive: true });
const stdoutPath = path.join(logsRoot, `${jobId}.stdout.log`);
const stderrPath = path.join(logsRoot, `${jobId}.stderr.log`);
const receiptPath = path.join(outputRoot, "command-receipt.json");
const startedAt = new Date().toISOString();
const startedEpoch = Date.now();
const result = await runProcessTree(command, args, {
  cwd: process.cwd(),
  env: process.env,
  timeout: timeoutMs,
  maxBuffer: 256 * 1024 * 1024,
  terminateDescendantsOnSuccess: true,
});
await fs.writeFile(stdoutPath, result.stdout ?? "", "utf8");
await fs.writeFile(stderrPath, result.stderr ?? "", "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const receipt = {
  schema_version: "ci-command-custody/1.0",
  job_id: jobId,
  source_commit: process.env.CANDIDATE_SOURCE_SHA ?? process.env.GITHUB_SHA ?? null,
  source_tree: process.env.CANDIDATE_SOURCE_TREE ?? null,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  duration_ms: Date.now() - startedEpoch,
  timeout_ms: timeoutMs,
  command: {
    executable: path.basename(command),
    argument_count: args.length,
  },
  outcome: {
    status: result.timed_out ? "TIMEOUT" : result.ok ? "PASS" : "FAIL",
    exit_code: result.code ?? null,
    signal: result.signal ?? null,
    timed_out: result.timed_out === true,
  },
  logs: {
    stdout: {
      path: path.relative(outputRoot, stdoutPath).split(path.sep).join("/"),
      bytes: Buffer.byteLength(result.stdout ?? ""),
      sha256: sha256(result.stdout ?? ""),
    },
    stderr: {
      path: path.relative(outputRoot, stderrPath).split(path.sep).join("/"),
      bytes: Buffer.byteLength(result.stderr ?? ""),
      sha256: sha256(result.stderr ?? ""),
    },
  },
};
await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...receipt, receipt_path: receiptPath })}\n`);
if (receipt.outcome.status !== "PASS") process.exitCode = Number.isInteger(result.code) && result.code !== 0 ? result.code : 1;
