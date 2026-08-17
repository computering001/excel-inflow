#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { selectedIngressPythonExecutable } from "./lib/attachment_ingress.mjs";
import { resolvePythonExecutable, runProcessTree } from "./lib/process_tree.mjs";
import {
  acquireRunLease,
  releaseRunLease,
  RUNTIME_ISOLATION_CONSTANTS,
} from "./lib/runtime_isolation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
let checks = 0;
const mutations = [];

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function processIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]),
    );
  }
  return value;
}

function expiredForeignLease(overrides = {}) {
  const acquired = new Date(Date.now() - 60_000).toISOString();
  const heartbeat = new Date(Date.now() - 2_000).toISOString();
  const hostBody = {
    hostname: "other-host.invalid",
    platform: "linux",
    architecture: "x64",
  };
  return {
    schema_version: RUNTIME_ISOLATION_CONSTANTS.lease_schema,
    owner: "foreign-dead-controller",
    pid: 999_999,
    token: "foreign-token",
    host_identity: {
      ...hostBody,
      host_id: sha256(JSON.stringify(canonicalise(hostBody), null, 2)),
    },
    session_identity_hash: "b".repeat(64),
    acquired_at: acquired,
    heartbeat_at: heartbeat,
    expires_at: new Date(Date.now() - 1_000).toISOString(),
    lease_duration_ms: 1_000,
    heartbeat_interval_ms: 100,
    heartbeat_sequence: 4,
    ...overrides,
  };
}

function currentHostLease(overrides = {}) {
  const hostBody = {
    hostname: os.hostname(),
    platform: os.platform(),
    architecture: os.arch(),
  };
  const now = Date.now();
  return expiredForeignLease({
    pid: process.pid,
    host_identity: {
      ...hostBody,
      host_id: sha256(JSON.stringify(canonicalise(hostBody), null, 2)),
    },
    acquired_at: new Date(now - 60_000).toISOString(),
    heartbeat_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    lease_duration_ms: 120_000,
    heartbeat_interval_ms: 30_000,
    heartbeat_sequence: 1,
    ...overrides,
  });
}

async function installLease(runRoot, lease) {
  const leaseDirectory = path.join(runRoot, RUNTIME_ISOLATION_CONSTANTS.lease_directory);
  await fs.mkdir(leaseDirectory, { recursive: true });
  await fs.writeFile(
    path.join(leaseDirectory, RUNTIME_ISOLATION_CONSTANTS.lease_file),
    `${JSON.stringify(lease, null, 2)}\n`,
  );
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-runtime-custody-"));
try {
  // RUNTIME-041: a detached grandchild ignores SIGTERM and holds both output
  // pipes. The robust helper must retain logs, kill the complete tree and
  // return only after the descendant is observably gone.
  const descendantCode = [
    "process.on('SIGTERM',()=>{});",
    "console.log('descendant-log-before-timeout');",
    "setInterval(()=>{},1000);",
  ].join("");
  const parentCode = [
    "const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],`,
    "{detached:true,stdio:['ignore','inherit','inherit']});",
    "console.log('DESCENDANT_PID='+child.pid);",
    "console.error('parent-stderr-before-timeout');",
    "process.on('SIGTERM',()=>{});",
    "setInterval(()=>{},1000);",
  ].join("");
  const timeoutResult = await runProcessTree(process.execPath, ["-e", parentCode], {
    timeout: 400,
    terminationGraceMs: 100,
  });
  const descendantPid = Number(/DESCENDANT_PID=(\d+)/.exec(timeoutResult.stdout)?.[1]);
  check(
    timeoutResult.timed_out && timeoutResult.error_code === "ETIMEDOUT" &&
    timeoutResult.termination_verified === true && timeoutResult.survivor_pids.length === 0,
    "timeout was not typed and survivor-verified",
  );
  check(timeoutResult.stdout.includes("descendant-log-before-timeout"), "descendant stdout was lost");
  check(timeoutResult.stderr.includes("parent-stderr-before-timeout"), "parent stderr was lost");
  check(
    Number.isInteger(descendantPid) &&
    timeoutResult.terminated_pids.includes(descendantPid) &&
    !processIsLive(descendantPid),
    "run state returned before a targeted descendant was observably gone",
  );
  mutations.push("direct_child_only_timeout_rejected");

  const vnextSource = await fs.readFile(path.join(HERE, "run_excel_inflow_vnext.mjs"), "utf8");
  check(vnextSource.includes("runProcessTree(command, args"), "vNext does not use the robust process-tree helper");
  check(!vnextSource.includes("child.kill(\"SIGTERM\")"), "vNext retained its weak direct-child timeout path");
  check(
    vnextSource.includes("delegate_stdout:") &&
    vnextSource.includes("delegate_stderr:") &&
    vnextSource.includes("delegate_termination_verified:") &&
    vnextSource.includes("delegate_survivor_pids:"),
    "vNext failure state does not retain both logs and termination evidence",
  );

  // RUNTIME-042: resolve once, then bind every subordinate through argument
  // and environment custody. A poisoned PATH must not replace the selection.
  const resolvedPython = await resolvePythonExecutable(
    process.env.EXCEL_INFLOW_TEST_PYTHON ?? process.env.PYTHON ?? "python3",
  );
  check(path.isAbsolute(resolvedPython), "Python executable was not resolved absolutely");
  const poison = path.join(scratch, "poison-bin");
  await fs.mkdir(poison);
  const poisonPython = path.join(poison, "python3");
  await fs.writeFile(poisonPython, "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  const selected = selectedIngressPythonExecutable({
    PATH: `${poison}${path.delimiter}${process.env.PATH ?? ""}`,
    PYTHON: poisonPython,
    EXCEL_INFLOW_PYTHON: resolvedPython,
  });
  check(selected === resolvedPython, "a subordinate replaced the top-level Python selection");
  check(
    (vnextSource.match(/\.push\("--python", pythonCommand\)/g) ?? []).length === 2 &&
    vnextSource.includes("EXCEL_INFLOW_PYTHON: pythonCommand") &&
    vnextSource.includes("runPrimary: () => run(pythonCommand"),
    "vNext does not pass one resolved Python to direct evidence and both user-flow launches",
  );
  const userFlowSource = await fs.readFile(path.join(HERE, "run_user_flow.mjs"), "utf8");
  check(
    userFlowSource.includes('args.push("--python", options.python)'),
    "the user-flow subordinate does not forward the top-level Python into release orchestration",
  );
  const filingsSource = await fs.readFile(path.join(HERE, "run_filings_pipeline.mjs"), "utf8");
  check(
    filingsSource.includes("process.env.EXCEL_INFLOW_PYTHON") &&
    !/execFileAsync\(\s*["']python3["']/.test(filingsSource),
    "the filings subordinate still launches a bare Python executable",
  );
  assert.throws(
    () => selectedIngressPythonExecutable({ EXCEL_INFLOW_PYTHON: "python3" }),
    /resolved absolute executable/,
  );
  checks += 1;
  mutations.push("bare_python_path_override_rejected");

  // RUNTIME-043: active ownership carries typed host/session identity and a
  // renewing heartbeat. Live contention blocks; expired foreign custody can
  // be taken over only with a permanent receipt.
  const liveRoot = path.join(scratch, "live-lease");
  await fs.mkdir(liveRoot);
  const live = await acquireRunLease(liveRoot, {
    owner: "runtime-custody-test",
    sessionId: "session-one",
    leaseDurationMs: 400,
    heartbeatIntervalMs: 100,
  });
  check(
    live.lease.schema_version === "debt-runtime-lease/1.1" &&
    live.lease.host_identity?.host_id &&
    live.lease.session_identity_hash &&
    (process.platform === "win32" || live.lease.process_start_identity) &&
    live.lease.heartbeat_at && live.lease.expires_at,
    "lease omitted heartbeat, expiry, host, session or process-birth custody",
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const renewed = JSON.parse(await fs.readFile(
    path.join(liveRoot, RUNTIME_ISOLATION_CONSTANTS.lease_directory, RUNTIME_ISOLATION_CONSTANTS.lease_file),
    "utf8",
  ));
  check(renewed.heartbeat_sequence >= 1 && renewed.heartbeat_at > live.lease.heartbeat_at, "lease heartbeat did not renew");
  await assert.rejects(
    acquireRunLease(liveRoot, {
      owner: "contender",
      sessionId: "session-two",
      leaseDurationMs: 400,
      heartbeatIntervalMs: 100,
    }),
    /live lease/,
  );
  checks += 1;
  mutations.push("live_lease_takeover_rejected");
  await releaseRunLease(liveRoot, live.token);

  const deadLocalRoot = path.join(scratch, "dead-local-current-lease");
  await fs.mkdir(deadLocalRoot);
  await installLease(deadLocalRoot, currentHostLease({
    pid: 2_147_483_647,
    process_start_identity: "not-a-live-process",
  }));
  const deadLocalTakeover = await acquireRunLease(deadLocalRoot, {
    owner: "dead-local-contender",
    sessionId: "dead-local-session",
    leaseDurationMs: 400,
    heartbeatIntervalMs: 100,
  });
  const deadLocalReceipt = JSON.parse(await fs.readFile(
    deadLocalTakeover.takeover_receipts[0],
    "utf8",
  ));
  check(
    deadLocalTakeover.recovered_stale &&
    deadLocalReceipt.reason === "same_host_process_dead",
    "a dead same-host owner remained live until heartbeat expiry",
  );
  await releaseRunLease(deadLocalRoot, deadLocalTakeover.token);
  mutations.push("dead_same_host_pid_not_misclassified_live");

  if (process.platform !== "win32") {
    const reusedPidRoot = path.join(scratch, "reused-local-pid-lease");
    await fs.mkdir(reusedPidRoot);
    await installLease(reusedPidRoot, currentHostLease({
      pid: process.pid,
      process_start_identity: "different-process-birth",
    }));
    const reusedPidTakeover = await acquireRunLease(reusedPidRoot, {
      owner: "reused-pid-contender",
      sessionId: "reused-pid-session",
      leaseDurationMs: 400,
      heartbeatIntervalMs: 100,
    });
    const reusedPidReceipt = JSON.parse(await fs.readFile(
      reusedPidTakeover.takeover_receipts[0],
      "utf8",
    ));
    check(
      reusedPidTakeover.recovered_stale &&
      reusedPidReceipt.reason === "same_host_pid_reused",
      "a reused same-host PID was accepted as the original lease owner",
    );
    await releaseRunLease(reusedPidRoot, reusedPidTakeover.token);
    mutations.push("reused_same_host_pid_not_misclassified_live");
  }

  const takeoverRoot = path.join(scratch, "expired-foreign-lease");
  await fs.mkdir(takeoverRoot);
  const priorLease = expiredForeignLease();
  await installLease(takeoverRoot, priorLease);
  const takeover = await acquireRunLease(takeoverRoot, {
    owner: "safe-takeover",
    sessionId: "takeover-session",
    leaseDurationMs: 400,
    heartbeatIntervalMs: 100,
  });
  check(takeover.recovered_stale && takeover.takeover_receipts.length === 1, "expired foreign lease was not recoverable");
  const receipt = JSON.parse(await fs.readFile(takeover.takeover_receipts[0], "utf8"));
  const { receipt_sha256: receiptSha256, ...receiptBody } = receipt;
  check(
    receipt.reason === "heartbeat_expired" &&
    receipt.prior_lease_sha256 === sha256(JSON.stringify(canonicalise(priorLease), null, 2)) &&
    receiptSha256 === sha256(JSON.stringify(canonicalise(receiptBody), null, 2)),
    "safe takeover receipt did not bind the expired owner",
  );
  check(
    receipt.prior_host_identity.hostname === "other-host.invalid" &&
    receipt.prior_session_identity_hash === "b".repeat(64) &&
    receipt.acquiring_session_identity_hash === takeover.lease.session_identity_hash,
    "takeover receipt omitted host/session identity",
  );
  await releaseRunLease(takeoverRoot, takeover.token);
  mutations.push("dead_cross_host_lease_recovered_with_receipt");

  const futureRoot = path.join(scratch, "future-foreign-lease");
  await fs.mkdir(futureRoot);
  await installLease(futureRoot, expiredForeignLease({
    heartbeat_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }));
  await assert.rejects(
    acquireRunLease(futureRoot, {
      owner: "unsafe-contender",
      sessionId: "unsafe-session",
      leaseDurationMs: 400,
      heartbeatIntervalMs: 100,
    }),
    /live lease/,
  );
  checks += 1;
  mutations.push("unexpired_cross_host_takeover_rejected");

  const malformedRoot = path.join(scratch, "malformed-current-lease");
  await fs.mkdir(malformedRoot);
  const malformed = expiredForeignLease();
  delete malformed.session_identity_hash;
  await installLease(malformedRoot, malformed);
  await assert.rejects(
    acquireRunLease(malformedRoot, {
      owner: "malformed-contender",
      sessionId: "malformed-session",
      leaseDurationMs: 400,
      heartbeatIntervalMs: 100,
    }),
    /live lease/,
  );
  checks += 1;
  mutations.push("malformed_current_lease_fails_closed_during_grace");

  process.stdout.write(`${JSON.stringify({
    kind: "runtime-custody-tests/1.0",
    status: "PASS",
    checks,
    mutations_rejected: mutations.length,
    mutations,
    total_violation_count: 0,
  }, null, 2)}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
