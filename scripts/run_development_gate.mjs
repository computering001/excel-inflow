#!/usr/bin/env node

/**
 * Lean, fail-closed local development gate.
 *
 * This runner never compiles a release, edits an authority, updates a golden,
 * installs a skill, opens Excel, or changes a route.  It only executes the
 * source-owned registry and writes one deterministic custody report.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
    "Usage: run_development_gate.mjs [--phase all|graph,workflow,evidence,forecast,economics,cohort,proof,real_corpus]",
    "  [--cases <case-directory>] [--representative <compiled-case.json>]",
    "  [--broker-corpus <external-corpus.json>]",
    "  [--broker-real-pack-manifest <external-reviewed-pack-manifest.json>]",
    "  [--fixed-point-cases-manifest <external-case-manifest.json>]",
    "  [--degraded-delivery-report <report.json>] [--usable-broker-workbook <workbook.xlsx>]",
    "  [--raw-canary-evidence <evidence-run.json>] [--python <python>] [--soffice <path>]",
    "  [--real-filings-request <raw-annual-report-request.json>]",
    "  [--real-filings-expectations <run-scoped-expectations.json>]",
    "  [--out <report-directory>]",
    "  [--concurrency <1-4>] [--timeout-ms <milliseconds>]",
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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function substitutions(options) {
  return {
    CASES: options.cases ? path.resolve(options.cases) : null,
    REPRESENTATIVE: options.representative ? path.resolve(options.representative) : null,
    BROKER_CORPUS: options["broker-corpus"] ? path.resolve(options["broker-corpus"]) : null,
    BROKER_REAL_PACK_MANIFEST: options["broker-real-pack-manifest"]
      ? path.resolve(options["broker-real-pack-manifest"])
      : null,
    FIXED_POINT_CASES_MANIFEST: options["fixed-point-cases-manifest"]
      ? path.resolve(options["fixed-point-cases-manifest"])
      : null,
    DEGRADED_DELIVERY_REPORT: options["degraded-delivery-report"]
      ? path.resolve(options["degraded-delivery-report"])
      : null,
    USABLE_BROKER_WORKBOOK: options["usable-broker-workbook"]
      ? path.resolve(options["usable-broker-workbook"])
      : null,
    RAW_CANARY_EVIDENCE: options["raw-canary-evidence"]
      ? path.resolve(options["raw-canary-evidence"])
      : null,
    REAL_FILINGS_REQUEST: options["real-filings-request"]
      ? path.resolve(options["real-filings-request"])
      : null,
    REAL_FILINGS_EXPECTATIONS: options["real-filings-expectations"]
      ? path.resolve(options["real-filings-expectations"])
      : null,
    PYTHON: options.python ? path.resolve(options.python) : null,
    SOFFICE: options.soffice ? path.resolve(options.soffice) : null,
    INSTALLED_HOST_BROKER_RECEIPT: options["installed-host-broker-receipt"]
      ? path.resolve(options["installed-host-broker-receipt"]) : null,
  };
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

async function runTest(test, { inputs, python, timeoutMs, out }) {
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
      duration_ms: 0,
      missing,
      stdout: "",
      stderr: `Missing required test custody input(s): ${missing.join(", ")}`,
    };
  }
  const command = test.runtime === "python" ? python : process.execPath;
  const testInputs = { ...inputs, TEST_OUT: path.join(out, test.id) };
  const args = [scriptPath, ...(test.arguments ?? []).map((item) => resolveArgument(item, testInputs))];
  const started = process.hrtime.bigint();
  try {
    const result = await exec(command, args, {
      cwd: ROOT,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        // Node-authored integration tests may launch the shipping Python
        // controller or Stage 4 themselves. They must inherit the exact
        // custody inputs selected for this development-gate invocation rather
        // than silently falling back to machine-local Codex fixtures/runtimes.
        EXCEL_INFLOW_TEST_PYTHON: python,
        DEBT_OVERLAY_PYTHON: python,
        ...(inputs.CASES ? { DEBT_OVERLAY_CASES_DIR: inputs.CASES } : {}),
        ...(inputs.SOFFICE ? { SOFFICE_BIN: inputs.SOFFICE } : {}),
      },
    });
    return {
      id: test.id,
      phase: test.phase,
      status: "PASS",
      exit_code: 0,
      duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
      command: [command, ...args],
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      id: test.id,
      phase: test.phase,
      status: error.killed || error.signal ? "BLOCKED" : "FAIL",
      exit_code: Number.isInteger(error.code) ? error.code : null,
      signal: error.signal ?? null,
      duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
      command: [command, ...args],
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    };
  }
}

async function runPool(tests, concurrency, context) {
  const results = new Array(tests.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tests.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await runTest(tests[index], context);
      const result = results[index];
      console.log(`${result.status.padEnd(7)} ${result.id} (${Math.round(result.duration_ms)} ms)`);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), tests.length) }, worker),
  );
  return results;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}
const registry = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf8"));
if (registry.schema_version !== "development-test-registry/2.0") {
  throw new Error("Development-test registry has the wrong schema version.");
}
const knownPhases = [...new Set(registry.tests.map((test) => test.phase))].sort();
const selectedPhases = phases(options.phase, knownPhases);
const selectedTests = registry.tests.filter((test) => selectedPhases.includes(test.phase));
const inputs = substitutions(options);
const out = options.out
  ? path.resolve(options.out)
  : await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-development-gate-"));
const timeoutMs = Math.max(1000, Number(options["timeout-ms"] ?? 300000));
const concurrency = Math.min(4, Math.max(1, Number(options.concurrency ?? 3)));
await fs.mkdir(out, { recursive: true });

const startedAt = new Date().toISOString();
const results = await runPool(selectedTests, concurrency, {
  inputs,
  python: options.python ?? "python3",
  timeoutMs,
  out,
});
const counts = Object.fromEntries(
  ["PASS", "FAIL", "BLOCKED"].map((status) => [
    status,
    results.filter((result) => result.status === status).length,
  ]),
);
const report = canonical({
  schema_version: "development-gate-report/1.0",
  kind: "source_owned_lean_development_gate",
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  phases: selectedPhases,
  registry_path: path.relative(ROOT, REGISTRY_PATH),
  release_actions_performed: false,
  native_excel_actions_performed: false,
  golden_actions_performed: false,
  inputs,
  counts,
  status: counts.FAIL === 0 && counts.BLOCKED === 0 ? "PASS" : "FAIL",
  results,
});
const reportPath = path.join(out, "development-gate-report.json");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`${report.status}: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.BLOCKED} blocked`);
console.log(reportPath);
if (report.status !== "PASS") process.exitCode = 1;
