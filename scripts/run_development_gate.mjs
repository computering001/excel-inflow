#!/usr/bin/env node

/**
 * Lean, fail-closed local development gate.
 *
 * This runner never compiles a release, edits an authority, updates a golden,
 * installs a skill, opens Excel, or changes a route.  It only executes the
 * source-owned registry and writes one deterministic custody report.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DEVELOPMENT_GATE_PROFILES,
  canonical,
  effectiveTestTimeoutMs,
  effectiveTestMetadata,
  selectRegistryTests,
  testIdSetSha256,
  validateRegistryInvocationContract,
} from "./lib/development_gate_contract.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REGISTRY_PATH = path.join(ROOT, "assets", "development-test-registry.json");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function usage() {
  return [
    "Usage: run_development_gate.mjs [--phase all|workflow,evidence,graph,economic,economics,forecast,proof,real_corpus,cohort,performance]",
    "  [--profile all|portable|custody]",
    "  [--only <comma-separated exact registry test IDs>]",
    "  [--shard <index>/<total>]",
    "  [--cases <case-directory>] [--representative <compiled-case.json>]",
    "  [--broker-corpus <external-corpus.json>]",
    "  [--broker-real-pack-manifest <external-reviewed-pack-manifest.json>]",
    "  [--fixed-point-cases-manifest <external-case-manifest.json>]",
    "  [--degraded-delivery-report <report.json>] [--usable-broker-workbook <workbook.xlsx>]",
    "  [--raw-canary-evidence <evidence-run.json>] [--python <python>] [--soffice <path>]",
    "  [--real-filings-request <raw-annual-report-request.json>]",
    "  [--real-filings-expectations <run-scoped-expectations.json>]",
    "  [--real-filing-corpus-manifest <external-corpus-manifest.json>]",
    "  [--out <report-directory>]",
    "  [--concurrency <1-4>] [--timeout-ms <explicit per-test override milliseconds>]",
    "Each input also resolves from its UPPERCASE custody-name environment variable",
    " (PYTHON, SOFFICE, CASES, REPRESENTATIVE, ...) when its flag is absent; the flag wins.",
    "Reports contain source, registry and input hashes. Paths, commands and captured output are redacted.",
  ].join("\n");
}

async function exists(target) {
  if (!target) return false;
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function substitutions(options) {
  // Every custody input resolves flag-first, then from its declared custody
  // name in the environment (e.g. PYTHON=... SOFFICE=... CASES=...), and only
  // then counts as absent.  This keeps the hosted portable harness — which
  // exports the custody names rather than repeating every flag — able to
  // satisfy the contract WITHOUT weakening anything: a resolved name still
  // has to exist on disk or the suite stays BLOCKED (fail-closed), and an
  // explicit flag always wins over the environment.
  const resolveInput = (flag, name) => {
    const supplied = options[flag] ?? process.env[name];
    return supplied ? path.resolve(supplied) : null;
  };
  return {
    CASES: resolveInput("cases", "CASES"),
    REPRESENTATIVE: resolveInput("representative", "REPRESENTATIVE"),
    BROKER_CORPUS: resolveInput("broker-corpus", "BROKER_CORPUS"),
    BROKER_REAL_PACK_MANIFEST: resolveInput("broker-real-pack-manifest", "BROKER_REAL_PACK_MANIFEST"),
    FIXED_POINT_CASES_MANIFEST: resolveInput("fixed-point-cases-manifest", "FIXED_POINT_CASES_MANIFEST"),
    DEGRADED_DELIVERY_REPORT: resolveInput("degraded-delivery-report", "DEGRADED_DELIVERY_REPORT"),
    USABLE_BROKER_WORKBOOK: resolveInput("usable-broker-workbook", "USABLE_BROKER_WORKBOOK"),
    RAW_CANARY_EVIDENCE: resolveInput("raw-canary-evidence", "RAW_CANARY_EVIDENCE"),
    REAL_FILINGS_REQUEST: resolveInput("real-filings-request", "REAL_FILINGS_REQUEST"),
    REAL_FILINGS_EXPECTATIONS: resolveInput("real-filings-expectations", "REAL_FILINGS_EXPECTATIONS"),
    REAL_FILING_CORPUS_MANIFEST: resolveInput("real-filing-corpus-manifest", "REAL_FILING_CORPUS_MANIFEST"),
    PYTHON: resolveInput("python", "PYTHON"),
    SOFFICE: resolveInput("soffice", "SOFFICE"),
    INSTALLED_HOST_BROKER_RECEIPT: resolveInput("installed-host-broker-receipt", "INSTALLED_HOST_BROKER_RECEIPT"),
  };
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashDirectory(directory) {
  const entries = [];
  async function visit(current, relativeBase) {
    const children = await fs.readdir(current, { withFileTypes: true });
    children.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = path.posix.join(relativeBase, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(`Input directory contains a symbolic link at ${relative}.`);
      }
      if (child.isDirectory()) await visit(absolute, relative);
      else if (child.isFile()) entries.push(`${relative}\0${sha256Bytes(await fs.readFile(absolute))}`);
      else throw new Error(`Input directory contains a non-regular entry at ${relative}.`);
    }
  }
  await visit(directory, "");
  return sha256Bytes(`${entries.join("\n")}\n`);
}

async function describeInput(target) {
  if (!target || !(await exists(target))) return { status: "missing", kind: null, sha256: null };
  const supplied = path.resolve(target);
  const linkStat = await fs.lstat(supplied);
  const resolved = linkStat.isSymbolicLink() ? await fs.realpath(supplied) : supplied;
  const stat = await fs.stat(resolved);
  if (stat.isFile()) {
    return {
      status: "present",
      kind: linkStat.isSymbolicLink() ? "symlinked_regular_file" : "regular_file",
      sha256: sha256Bytes(await fs.readFile(resolved)),
    };
  }
  if (stat.isDirectory() && !linkStat.isSymbolicLink()) {
    return { status: "present", kind: "directory_tree", sha256: await hashDirectory(resolved) };
  }
  throw new Error("A development-gate input is neither a regular file nor a regular directory.");
}

async function sourceIdentity() {
  const [{ stdout: commit }, { stdout: status }] = await Promise.all([
    exec("git", ["rev-parse", "HEAD"], { cwd: ROOT }),
    exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: ROOT }),
  ]);
  return {
    commit: commit.trim(),
    worktree_dirty: status.trim().length > 0,
    worktree_status_sha256: sha256Bytes(status),
  };
}

function redactedExecutionResult(result, metadata) {
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  return canonical({
    id: result.id,
    phase: result.phase,
    status: result.status,
    exit_code: result.exit_code ?? null,
    signal: result.signal ?? null,
    started_at: result.started_at,
    completed_at: result.completed_at,
    duration_ms: result.duration_ms,
    timeout_ms: result.timeout_ms ?? null,
    timed_out: result.timed_out === true,
    missing: result.missing ?? [],
    stdout_bytes: Buffer.byteLength(stdout),
    stdout_sha256: sha256Bytes(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    stderr_sha256: sha256Bytes(stderr),
    stdout_log: result.stdout_log ?? null,
    stderr_log: result.stderr_log ?? null,
    output_custody: result.output_custody ?? {
      status: "missing",
      kind: null,
      sha256: null,
    },
    detail_policy: "protected_details_redacted",
    metadata,
  });
}

function resolveArgument(value, inputs) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.type === "literal") return String(value.value);
    const resolved = inputs[value.source];
    if (resolved === null || resolved === undefined) throw new Error(`Argument ${value.name ?? value.source} has no resolved source ${value.source}.`);
    return String(resolved);
  }
  const match = /^\$([A-Z_]+)$/.exec(String(value));
  return match ? inputs[match[1]] : String(value);
}

function phases(raw, known) {
  if (!raw || raw === "all") return known;
  const selected = [...new Set(String(raw).split(",").map((item) => item.trim()).filter(Boolean))];
  for (const phase of selected) {
    if (!known.includes(phase)) throw new Error(`Unknown phase ${phase}.\n${usage()}`);
  }
  return selected;
}

async function runTest(test, { inputs, python, timeoutOverrideMs, out }) {
  const wallStartedAt = new Date().toISOString();
  const timeoutMs = effectiveTestTimeoutMs(test, timeoutOverrideMs);
  const testOut = path.join(out, test.id);
  const missing = [];
  for (const requirement of test.requires ?? []) {
    if (!(await exists(inputs[requirement]))) missing.push(requirement);
  }
  const scriptPath = path.join(HERE, test.script);
  if (!(await exists(scriptPath))) missing.push(`SCRIPT:${test.script}`);
  if (missing.length > 0) {
    return {
      id: test.id,
      phase: test.phase,
      status: "BLOCKED",
      exit_code: null,
      started_at: wallStartedAt,
      completed_at: new Date().toISOString(),
      duration_ms: 0,
      timeout_ms: timeoutMs,
      timed_out: false,
      missing,
      stdout: "",
      stderr: `Missing required test custody input(s): ${missing.join(", ")}`,
      output_custody: { status: "missing", kind: null, sha256: null },
    };
  }
  const command = test.runtime === "python" ? python : process.execPath;
  const testInputs = { ...inputs, TEST_OUT: testOut };
  const args = [scriptPath, ...(test.arguments ?? []).map((item) => resolveArgument(item, testInputs))];
  const started = process.hrtime.bigint();
  let execution;
  try {
    const result = await exec(command, args, {
      cwd: ROOT,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        EXCEL_INFLOW_NODE: process.execPath,
        // Node-authored integration tests may launch the shipping Python
        // controller or Stage 4 themselves. They must inherit the exact
        // custody inputs selected for this development-gate invocation rather
        // than silently falling back to machine-local Codex fixtures/runtimes.
        EXCEL_INFLOW_TEST_PYTHON: python,
        EXCEL_INFLOW_PYTHON: python,
        DEBT_OVERLAY_PYTHON: python,
        PYTHON: python,
        ...(inputs.CASES ? { DEBT_OVERLAY_CASES_DIR: inputs.CASES } : {}),
        ...(inputs.SOFFICE ? { SOFFICE_BIN: inputs.SOFFICE } : {}),
      },
    });
    execution = {
      id: test.id,
      phase: test.phase,
      status: "PASS",
      exit_code: 0,
      duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
      timeout_ms: timeoutMs,
      started_at: wallStartedAt,
      completed_at: new Date().toISOString(),
      timed_out: false,
      command: [command, ...args],
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    execution = {
      id: test.id,
      phase: test.phase,
      status: error.killed || error.signal ? "BLOCKED" : "FAIL",
      exit_code: Number.isInteger(error.code) ? error.code : null,
      signal: error.signal ?? null,
      duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
      timeout_ms: timeoutMs,
      started_at: wallStartedAt,
      completed_at: new Date().toISOString(),
      timed_out: error.killed === true,
      command: [command, ...args],
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    };
  }
  try {
    return { ...execution, output_custody: await describeInput(testOut) };
  } catch (error) {
    return {
      ...execution,
      status: "FAIL",
      output_custody: { status: "invalid", kind: null, sha256: null },
      stderr: `${execution.stderr}\nTest output custody failed: ${error.message}`,
    };
  }
}

async function runPool(tests, concurrency, context) {
  const results = new Array(tests.length);
  const started = new Array(tests.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tests.length) {
      const index = cursor;
      cursor += 1;
      const test = tests[index];
      started[index] = test;
      try {
        results[index] = await runTest(test, context);
      } catch (error) {
        results[index] = {
          id: test.id,
          phase: test.phase,
          status: "FAIL",
          exit_code: null,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: 0,
          timeout_ms: effectiveTestTimeoutMs(test, context.timeoutOverrideMs),
          timed_out: false,
          missing: [],
          stdout: "",
          stderr: `Unreported worker exception converted to a terminal result: ${error?.message ?? String(error)}`,
          output_custody: { status: "invalid", kind: null, sha256: null },
        };
      }
      const result = results[index];
      console.log(`${result.status.padEnd(7)} ${result.id} (${Math.round(result.duration_ms)} ms)`);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), tests.length) }, worker),
  );
  return { results, started };
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}
const registryBytes = await fs.readFile(REGISTRY_PATH);
const registry = JSON.parse(registryBytes.toString("utf8"));
if (registry.schema_version !== "development-test-registry/2.0") {
  throw new Error("Development-test registry has the wrong schema version.");
}
const knownPhases = [...new Set(registry.tests.map((test) => test.phase))].sort();
const selectedPhases = phases(options.phase, knownPhases);
const profile = String(options.profile ?? "all");
if (!DEVELOPMENT_GATE_PROFILES.includes(profile)) {
  throw new Error(`Unknown development-gate profile ${profile}.\n${usage()}`);
}
const profileTests = selectRegistryTests(registry, { profile, phases: selectedPhases });
const requestedIds = options.only
  ? [...new Set(String(options.only).split(",").map((item) => item.trim()).filter(Boolean))]
  : null;
let selectedTests = requestedIds
  ? profileTests.filter((test) => requestedIds.includes(test.id))
  : profileTests;
if (requestedIds) {
  const selectedIds = new Set(selectedTests.map((test) => test.id));
  const missingIds = requestedIds.filter((id) => !selectedIds.has(id));
  if (missingIds.length > 0) {
    throw new Error(`Requested registry test IDs are absent from the ${profile} selection: ${missingIds.join(", ")}.`);
  }
}
// A matrix shard takes a deterministic interleaved slice of the selection so
// N runners cover it exactly once between them (position % total). The slice
// is stamped into the report; scripts/aggregate_development_gate_reports.mjs
// re-joins the shards against the full profile selection afterwards.
let shard = null;
if (options.shard !== undefined) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(options.shard));
  if (!match) throw new Error(`--shard expects <index>/<total>, e.g. 2/3.\n${usage()}`);
  const shardIndex = Number(match[1]);
  const shardTotal = Number(match[2]);
  if (shardIndex > shardTotal) throw new Error(`--shard index ${shardIndex} exceeds its total ${shardTotal}.\n${usage()}`);
  const shardedSelection = selectedTests.filter((_, position) => position % shardTotal === shardIndex - 1);
  if (shardedSelection.length === 0) throw new Error(`Shard ${shardIndex}/${shardTotal} selects no ${profile} test.\n${usage()}`);
  shard = { index: shardIndex, total: shardTotal };
  selectedTests = shardedSelection;
}
const inputs = substitutions(options);
const invocationErrors = validateRegistryInvocationContract(
  selectedTests,
  [...Object.keys(inputs), "TEST_OUT"],
);
if (invocationErrors.length > 0) {
  throw new Error(
    `Development-test registry invocation contract is invalid:\n${invocationErrors.join("\n")}`,
  );
}
const out = options.out
  ? path.resolve(options.out)
  : await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-development-gate-"));
const timeoutOverrideMs = options["timeout-ms"] === undefined
  ? null
  : Number(options["timeout-ms"]);
const concurrency = Math.min(4, Math.max(1, Number(options.concurrency ?? 3)));
await fs.mkdir(out, { recursive: true });

const inputCustody = Object.fromEntries(await Promise.all(
  Object.entries(inputs).map(async ([name, target]) => [name, await describeInput(target)]),
));
const source = await sourceIdentity();

const startedAt = new Date().toISOString();
const pool = await runPool(selectedTests, concurrency, {
  inputs,
  // The python runtime is the same custody-resolved PYTHON input the suites
  // were gated on — never a silent fallback to bare `python3` when the env
  // var (rather than the flag) supplied it.
  python: inputs.PYTHON ?? "python3",
  timeoutOverrideMs,
  out,
});
const logsRoot = path.join(out, "test-logs");
await fs.mkdir(logsRoot, { recursive: true });
await Promise.all(pool.results.map(async (result) => {
  const stdoutLog = path.join(logsRoot, `${result.id}.stdout.log`);
  const stderrLog = path.join(logsRoot, `${result.id}.stderr.log`);
  await Promise.all([
    fs.writeFile(stdoutLog, String(result.stdout ?? ""), "utf8"),
    fs.writeFile(stderrLog, String(result.stderr ?? ""), "utf8"),
  ]);
  result.stdout_log = path.relative(out, stdoutLog).split(path.sep).join("/");
  result.stderr_log = path.relative(out, stderrLog).split(path.sep).join("/");
}));
const results = pool.results.map((result, index) => redactedExecutionResult(
  result,
  effectiveTestMetadata(registry, selectedTests[index]),
));
const counts = Object.fromEntries(
  ["PASS", "FAIL", "BLOCKED"].map((status) => [
    status,
    results.filter((result) => result.status === status).length,
  ]),
);
const report = canonical({
  schema_version: "development-gate-report/2.0",
  kind: "source_owned_lean_development_gate",
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  phases: selectedPhases,
  source,
  registry: {
    path: path.relative(ROOT, REGISTRY_PATH),
    sha256: sha256Bytes(registryBytes),
    test_count: registry.tests.length,
  },
  selection: {
    profile,
    ...(shard ? { shard } : {}),
    selected_test_count: selectedTests.length,
    selected_test_ids: selectedTests.map((test) => test.id).sort(),
    selected_test_ids_sha256: testIdSetSha256(selectedTests),
  },
  lifecycle: {
    selected: {
      count: selectedTests.length,
      test_ids_sha256: testIdSetSha256(selectedTests),
    },
    started: {
      count: pool.started.filter(Boolean).length,
      test_ids_sha256: testIdSetSha256(pool.started.filter(Boolean)),
    },
    terminally_reported: {
      count: results.length,
      test_ids_sha256: testIdSetSha256(results),
    },
  },
  release_actions_performed: false,
  native_excel_actions_performed: false,
  golden_actions_performed: false,
  inputs: inputCustody,
  counts,
  status: counts.FAIL === 0 && counts.BLOCKED === 0 ? "PASS" : "FAIL",
  results,
});
const reportPath = path.join(out, "development-gate-report.json");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`${report.status}: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.BLOCKED} blocked`);
console.log(reportPath);
if (report.status !== "PASS") process.exitCode = 1;
