#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import {
  compileDevelopmentRegistrySelectionReceipt,
  compileRegistrySelectionReceipt,
  compileReleaseCandidateAttestation,
  compileSourceIdentityReceipt,
  compileTestLifecycleReceipt,
  loadD52ClosureLedger,
} from "./lib/external_ci_evidence.mjs";

const exec = promisify(execFile);

const MODES = new Set([
  "capture-source-identity",
  "capture-registry-selection",
  "source-identity",
  "registry-selection",
  "lifecycle-from-gate-report",
  "final-attestation",
]);

function environment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Required CI environment ${name} is absent.`);
  return value;
}

async function observedVersion(executable, label) {
  const result = await exec(path.resolve(executable), ["--version"], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const value = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n")[0]?.trim();
  if (!value) throw new Error(`${label} produced no version observation.`);
  return value;
}

async function captureSourceIdentity({ repo, python, soffice }) {
  const root = path.resolve(repo);
  const [{ stdout: commit }, { stdout: tree }, { stdout: status }, pythonVersion, sofficeVersion] = await Promise.all([
    exec("git", ["rev-parse", "HEAD"], { cwd: root }),
    exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: root }),
    exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }),
    observedVersion(python, "Python"),
    observedVersion(soffice, "LibreOffice"),
  ]);
  const statusBytes = Buffer.from(status);
  return compileSourceIdentityReceipt({
    github_sha: environment("GITHUB_SHA"),
    source_commit: commit.trim(),
    source_tree: tree.trim(),
    repository: environment("GITHUB_REPOSITORY"),
    ref: environment("GITHUB_REF"),
    event_name: environment("GITHUB_EVENT_NAME"),
    run: { id: environment("GITHUB_RUN_ID"), attempt: Number(environment("GITHUB_RUN_ATTEMPT")) },
    runner: {
      os: environment("RUNNER_OS"),
      arch: environment("RUNNER_ARCH"),
      image: [process.env.ImageOS, process.env.ImageVersion].filter(Boolean).join("@") || environment("RUNNER_OS"),
    },
    toolchain: { node: process.version, python: pythonVersion, soffice: sofficeVersion },
    worktree: { clean: statusBytes.length === 0, status_sha256: createHash("sha256").update(statusBytes).digest("hex") },
    recorded_at: new Date().toISOString(),
  });
}

function parse(argv) {
  const mode = argv[0];
  if (!MODES.has(mode)) {
    throw new Error(`First argument must be one of: ${[...MODES].join(", ")}.`);
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const token = argv[index];
    if (!token?.startsWith("--") || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error(`Every option must be a --name value pair; invalid token ${token ?? "<missing>"}.`);
    }
    const key = token.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option --${key}.`);
    options[key] = argv[index + 1];
  }
  return { mode, options };
}

function exactOptions(options, required, optional = []) {
  const expected = [...required].sort().map((key) => `--${key}`).join(", ");
  const unexpected = Object.keys(options).filter((key) => !required.includes(key) && !optional.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`Options must be exactly ${expected}; received unexpected ${unexpected.sort().map((key) => `--${key}`).join(", ")}.`);
  }
  const missing = required.filter((key) => !(key in options));
  if (missing.length > 0) {
    throw new Error(`Options must be exactly ${expected}; missing ${missing.sort().map((key) => `--${key}`).join(", ")}.`);
  }
}

async function readJson(file, label) {
  try {
    return JSON.parse(await fs.readFile(path.resolve(file), "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

async function writeJson(file, value) {
  const target = path.resolve(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
}

function lifecycleFromGateReport({ source, registry, gate, jobId, selectionScope }) {
  if (!Array.isArray(gate?.selection?.selected_test_ids)) {
    throw new Error("gate report must carry selection.selected_test_ids; a digest/count alone cannot prove which tests were selected.");
  }
  if (!Array.isArray(gate?.results)) throw new Error("gate report results must be an array.");
  const starts = gate.results.map((row) => ({ id: row.id, started_at: row.started_at }));
  const terminals = gate.results.map((row) => ({
    id: row.id,
    status: row.status,
    exit_code: row.exit_code ?? null,
    signal: row.signal ?? null,
    started_at: row.started_at,
    completed_at: row.completed_at,
    duration_ms: Math.round(row.duration_ms),
    timeout_ms: row.timeout_ms,
    timed_out: row.timed_out,
    stdout_log: row.stdout_log,
    stderr_log: row.stderr_log,
  }));
  return compileTestLifecycleReceipt({
    job_id: jobId,
    source_identity: source,
    registry_selection: registry,
    selection_scope: selectionScope,
    selected_test_ids: gate.selection.selected_test_ids,
    starts,
    terminals,
    recorded_at: gate.completed_at,
  });
}

const { mode, options } = parse(process.argv.slice(2));
let result;
if (mode === "capture-source-identity") {
  exactOptions(options, ["repo", "python", "soffice", "out"]);
  result = await captureSourceIdentity(options);
} else if (mode === "capture-registry-selection") {
  exactOptions(options, ["source-identity", "registry", "scripts-root", "out"]);
  const [source, registry] = await Promise.all([
    readJson(options["source-identity"], "source identity receipt"),
    readJson(options.registry, "development test registry"),
  ]);
  result = compileDevelopmentRegistrySelectionReceipt({
    source_identity: source,
    registry,
    scripts_root: options["scripts-root"],
    recorded_at: new Date().toISOString(),
  });
} else if (mode === "source-identity") {
  exactOptions(options, ["input", "out"]);
  result = compileSourceIdentityReceipt(await readJson(options.input, "source identity input"));
} else if (mode === "registry-selection") {
  exactOptions(options, ["source-identity", "input", "out"]);
  const [source, input] = await Promise.all([
    readJson(options["source-identity"], "source identity receipt"),
    readJson(options.input, "registry selection input"),
  ]);
  if (!input || typeof input !== "object" || !Array.isArray(input.rows) || typeof input.recorded_at !== "string") {
    throw new Error("registry selection input must contain exactly the rows and recorded_at inputs used by the compiler.");
  }
  result = compileRegistrySelectionReceipt({ source_identity: source, rows: input.rows, recorded_at: input.recorded_at });
} else if (mode === "lifecycle-from-gate-report") {
  exactOptions(options, ["source-identity", "registry-selection", "gate-report", "job-id", "selection-scope", "out"]);
  const [source, registry, gate] = await Promise.all([
    readJson(options["source-identity"], "source identity receipt"),
    readJson(options["registry-selection"], "registry selection receipt"),
    readJson(options["gate-report"], "gate report"),
  ]);
  result = lifecycleFromGateReport({
    source,
    registry,
    gate,
    jobId: options["job-id"],
    selectionScope: options["selection-scope"],
  });
} else {
  const receiptOptions = [
    "source-identity", "registry-selection", "targeted-runtime", "portable-gate",
    "package-a", "package-b", "package-reproducibility", "archive-capability",
    "mutation-measurement", "synthetic-merge",
  ];
  exactOptions(options, [...receiptOptions, "created-at", "out"], ["d52-closure-ledger"]);
  const values = await Promise.all(receiptOptions.map((key) => readJson(options[key], `${key} receipt`)));
  const d52Closure = loadD52ClosureLedger(options["d52-closure-ledger"]
    ? { ledger_path: options["d52-closure-ledger"], required: true }
    : {});
  result = compileReleaseCandidateAttestation(
    Object.fromEntries(receiptOptions.map((key, index) => [key.replaceAll("-", "_"), values[index]])),
    { createdAt: options["created-at"], d52Closure: d52Closure?.summary ?? null },
  );
}

await writeJson(options.out, result);
console.log(JSON.stringify({ status: result.status, schema_version: result.schema_version, out: path.resolve(options.out) }));
