import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./json_schema.mjs";
import {
  effectiveTestMetadata,
  effectiveTestTimeoutMs,
  testProfile,
  validateRegistryInvocationContract,
} from "./development_gate_contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readSchema = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "assets", name), "utf8"));

const SOURCE_SCHEMA = readSchema("ci-source-identity-receipt-v1.schema.json");
const REGISTRY_SCHEMA = readSchema("ci-registry-selection-receipt-v1.schema.json");
const LIFECYCLE_SCHEMA = readSchema("ci-test-lifecycle-receipt-v1.schema.json");
const MUTATION_SCHEMA = readSchema("ci-mutation-measurement-receipt-v1.schema.json");
const ATTESTATION_SCHEMA = readSchema("release-candidate-attestation-v1.schema.json");

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const JOB_IDS = Object.freeze([
  "source_identity",
  "registry_selection",
  "targeted_runtime",
  "portable_gate",
  "package_a",
  "package_b",
  "package_reproducibility",
  "archive_capability",
  "mutation_measurement",
  "synthetic_merge",
]);

export const CI_PREREQUISITE_JOB_IDS = JOB_IDS;

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys must be exactly ${wanted.join(", ")}; received ${actual.join(", ")}.`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function requireSha(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is not a canonical digest.`);
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}.`);
  return value;
}

function requireIso(value, label) {
  requireString(value, label);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 instant.`);
  }
  return value;
}

function requireSchema(value, schema, label) {
  const errors = validateJsonSchema(value, schema);
  if (errors.length) throw new Error(`${label} is not schema-valid:\n${errors.join("\n")}`);
}

function seal(value, field = "evidence_sha256") {
  const sealed = { ...value, [field]: canonicalSha256(value) };
  return canonical(sealed);
}

function requireSealed(value, field, label) {
  exactKeys(value, Object.keys(value), label);
  requireSha(value[field], SHA256, `${label}.${field}`);
  const unsigned = { ...value };
  delete unsigned[field];
  if (canonicalSha256(unsigned) !== value[field]) throw new Error(`${label}.${field} does not match the receipt bytes.`);
}

function sourceBinding(source) {
  return canonical({
    github_sha: source.github_sha,
    source_tree: source.source_tree,
    ref: source.ref,
    event_name: source.event_name,
    run_id: source.run.id,
    run_attempt: source.run.attempt,
  });
}

function sameBinding(receipt, binding, label) {
  if (canonicalSha256(receipt.source_binding) !== canonicalSha256(binding)) {
    throw new Error(`${label} is bound to a different source identity.`);
  }
}

export function compileSourceIdentityReceipt(input) {
  exactKeys(input, [
    "github_sha", "source_commit", "source_tree", "repository", "ref", "event_name",
    "run", "runner", "toolchain", "worktree", "recorded_at",
  ], "source identity input");
  if (!SHA1.test(input.github_sha) || input.source_commit !== input.github_sha) {
    throw new Error("source_commit must exactly equal canonical GITHUB_SHA.");
  }
  requireSha(input.source_tree, SHA1, "source_tree");
  requireString(input.repository, "repository");
  if (!/^refs\/(heads|tags|pull)\/.+/.test(input.ref)) throw new Error("ref must be a full Git ref.");
  if (!/^[a-z][a-z0-9_]*$/.test(input.event_name)) throw new Error("event_name is invalid.");
  exactKeys(input.run, ["id", "attempt"], "run");
  requireString(String(input.run.id), "run.id");
  requireInteger(input.run.attempt, "run.attempt", 1);
  exactKeys(input.runner, ["os", "arch", "image"], "runner");
  Object.entries(input.runner).forEach(([key, value]) => requireString(value, `runner.${key}`));
  exactKeys(input.toolchain, ["node", "python", "soffice"], "toolchain");
  Object.entries(input.toolchain).forEach(([key, value]) => requireString(value, `toolchain.${key}`));
  exactKeys(input.worktree, ["clean", "status_sha256"], "worktree");
  if (input.worktree.clean !== true) throw new Error("exact-head source worktree must be clean.");
  requireSha(input.worktree.status_sha256, SHA256, "worktree.status_sha256");
  requireIso(input.recorded_at, "recorded_at");

  const receipt = seal({
    schema_version: "excel-inflow-ci-source-identity-receipt/1.0",
    status: "PASS",
    ...canonical(input),
    toolchain_sha256: canonicalSha256(input.toolchain),
  });
  requireSchema(receipt, SOURCE_SCHEMA, "source identity receipt");
  return receipt;
}

export function verifySourceIdentityReceipt(receipt) {
  requireSchema(receipt, SOURCE_SCHEMA, "source identity receipt");
  requireSealed(receipt, "evidence_sha256", "source identity receipt");
  if (receipt.github_sha !== receipt.source_commit || receipt.worktree.clean !== true) {
    throw new Error("source identity receipt is not exact-head clean evidence.");
  }
  if (canonicalSha256(receipt.toolchain) !== receipt.toolchain_sha256) {
    throw new Error("source identity toolchain digest does not match.");
  }
  return receipt;
}

function validateRegistryRow(row, index) {
  exactKeys(row, ["id", "command", "timeout_seconds", "disposition"], `registry row ${index}`);
  if (!ID.test(row.id)) throw new Error(`registry row ${index} id is invalid.`);
  if (!Array.isArray(row.command) || row.command.length < 2 || row.command.some((part) => typeof part !== "string" || part.trim() === "")) {
    throw new Error(`registry row ${row.id} command must be a non-empty argv array with an executable and script.`);
  }
  if (/\s/.test(row.command[0])) throw new Error(`registry row ${row.id} executable must not be a shell command string.`);
  requireInteger(row.timeout_seconds, `registry row ${row.id} timeout_seconds`, 1);
  if (!["PORTABLE_SELECTED", "INSTALLED_HOST_EXCLUDED"].includes(row.disposition)) {
    throw new Error(`registry row ${row.id} has an invalid disposition.`);
  }
}

export function compileRegistrySelectionReceipt({ source_identity, rows, recorded_at }) {
  verifySourceIdentityReceipt(source_identity);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("registry rows must be non-empty.");
  rows.forEach(validateRegistryRow);
  const ids = rows.map((row) => row.id);
  if (new Set(ids).size !== ids.length) throw new Error("registry test IDs must be unique.");
  const suiteKeys = rows.map((row) => canonicalSha256(row.command));
  if (new Set(suiteKeys).size !== suiteKeys.length) throw new Error("registry contains a duplicate suite command.");
  requireIso(recorded_at, "recorded_at");
  const ordered = [...rows].sort((left, right) => left.id.localeCompare(right.id)).map(canonical);
  const selected = ordered.filter((row) => row.disposition === "PORTABLE_SELECTED").map((row) => row.id);
  if (selected.length === 0) throw new Error("registry selects no portable tests.");
  const excluded = ordered.filter((row) => row.disposition === "INSTALLED_HOST_EXCLUDED").map((row) => row.id);
  const receipt = seal({
    schema_version: "excel-inflow-ci-registry-selection-receipt/1.0",
    status: "PASS",
    source_binding: sourceBinding(source_identity),
    registry_sha256: canonicalSha256(ordered),
    counts: {
      registry: ordered.length,
      portable: selected.length,
      installed_host_excluded: excluded.length,
      selected: selected.length,
    },
    selected_test_ids: selected,
    selected_test_ids_sha256: canonicalSha256(selected),
    installed_host_excluded_test_ids: excluded,
    rows: ordered,
    recorded_at,
  });
  requireSchema(receipt, REGISTRY_SCHEMA, "registry selection receipt");
  return receipt;
}

const REGISTRY_INPUT_SOURCES = Object.freeze([
  "CASES", "REPRESENTATIVE", "BROKER_CORPUS", "BROKER_REAL_PACK_MANIFEST",
  "FIXED_POINT_CASES_MANIFEST", "DEGRADED_DELIVERY_REPORT", "USABLE_BROKER_WORKBOOK",
  "RAW_CANARY_EVIDENCE", "REAL_FILINGS_REQUEST", "REAL_FILINGS_EXPECTATIONS",
  "REAL_FILING_CORPUS_MANIFEST", "PYTHON", "SOFFICE", "INSTALLED_HOST_BROKER_RECEIPT",
  "TEST_OUT",
]);

function registryArgumentToken(argument) {
  if (argument && typeof argument === "object" && !Array.isArray(argument)) {
    return argument.type === "literal" ? String(argument.value) : `$${argument.source}`;
  }
  return String(argument);
}

export function compileDevelopmentRegistrySelectionReceipt({
  source_identity,
  registry,
  scripts_root,
  recorded_at,
}) {
  verifySourceIdentityReceipt(source_identity);
  if (registry?.schema_version !== "development-test-registry/2.0" || !Array.isArray(registry.tests) || registry.tests.length === 0) {
    throw new Error("development registry is absent or has the wrong schema version.");
  }
  const invocationErrors = validateRegistryInvocationContract(registry.tests, REGISTRY_INPUT_SOURCES);
  if (invocationErrors.length) throw new Error(`development registry invocation contract is invalid:\n${invocationErrors.join("\n")}`);
  const scriptsRoot = path.resolve(scripts_root);
  const rows = registry.tests.map((test, index) => {
    if (!ID.test(test.id ?? "")) throw new Error(`development registry row ${index} has an invalid id.`);
    if (!["node", "python"].includes(test.runtime)) throw new Error(`development registry row ${test.id} has an invalid runtime.`);
    if (test.mutates_product_tree !== false) throw new Error(`development registry row ${test.id} may mutate the product tree.`);
    if (typeof test.script !== "string" || path.isAbsolute(test.script) || test.script.split(/[\\/]/).includes("..")) {
      throw new Error(`development registry row ${test.id} has an unsafe script path.`);
    }
    effectiveTestTimeoutMs(test);
    effectiveTestMetadata(registry, test);
    const script = path.resolve(scriptsRoot, test.script);
    const relative = path.relative(scriptsRoot, script);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`development registry row ${test.id} escapes scripts root.`);
    let stat;
    try {
      stat = fs.lstatSync(script);
    } catch {
      throw new Error(`development registry row ${test.id} points at missing script ${test.script}.`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`development registry row ${test.id} script is not one regular file.`);
    return {
      id: test.id,
      command: [test.runtime === "node" ? "node" : "python3", `scripts/${test.script}`, ...(test.arguments ?? []).map(registryArgumentToken)],
      timeout_seconds: test.timeout_seconds,
      disposition: testProfile(test) === "portable" ? "PORTABLE_SELECTED" : "INSTALLED_HOST_EXCLUDED",
    };
  });
  if (rows.length !== registry.tests.length) throw new Error("development registry row omission detected.");
  return compileRegistrySelectionReceipt({ source_identity, rows, recorded_at });
}

export function verifyRegistrySelectionReceipt(receipt, sourceIdentity = null) {
  return validateRegistrySelection(receipt, sourceIdentity);
}

function validateRegistrySelection(receipt, sourceIdentity) {
  requireSchema(receipt, REGISTRY_SCHEMA, "registry selection receipt");
  requireSealed(receipt, "evidence_sha256", "registry selection receipt");
  if (sourceIdentity) sameBinding(receipt, sourceBinding(sourceIdentity), "registry selection receipt");
  const selected = receipt.rows.filter((row) => row.disposition === "PORTABLE_SELECTED").map((row) => row.id).sort();
  const excluded = receipt.rows.filter((row) => row.disposition === "INSTALLED_HOST_EXCLUDED").map((row) => row.id).sort();
  if (new Set(receipt.rows.map((row) => row.id)).size !== receipt.rows.length) throw new Error("registry receipt contains duplicate IDs.");
  if (new Set(receipt.rows.map((row) => canonicalSha256(row.command))).size !== receipt.rows.length) throw new Error("registry receipt contains duplicate suite commands.");
  receipt.rows.forEach(validateRegistryRow);
  if (canonicalSha256(receipt.rows) !== receipt.registry_sha256 || canonicalSha256(selected) !== receipt.selected_test_ids_sha256) {
    throw new Error("registry receipt digest mismatch.");
  }
  if (JSON.stringify(selected) !== JSON.stringify(receipt.selected_test_ids) || JSON.stringify(excluded) !== JSON.stringify(receipt.installed_host_excluded_test_ids)) {
    throw new Error("registry receipt selection does not match its rows.");
  }
  if (receipt.counts.registry !== receipt.rows.length || receipt.counts.portable !== selected.length ||
      receipt.counts.selected !== selected.length || receipt.counts.installed_host_excluded !== excluded.length) {
    throw new Error("registry receipt counts do not match its rows.");
  }
  return receipt;
}

function uniqueIds(records, label) {
  const ids = records.map((record) => record.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate test IDs.`);
  return ids.sort();
}

function validLog(log, label) {
  exactKeys(log, ["path", "sha256", "bytes"], label);
  requireString(log.path, `${label}.path`);
  if (path.isAbsolute(log.path) || log.path.split(/[\\/]/).includes("..")) throw new Error(`${label}.path must be relative and traversal-free.`);
  requireSha(log.sha256, SHA256, `${label}.sha256`);
  requireInteger(log.bytes, `${label}.bytes`, 0);
}

export function compileTestLifecycleReceipt({
  job_id,
  source_identity,
  registry_selection,
  selection_scope,
  selected_test_ids,
  starts,
  terminals,
  recorded_at,
}) {
  verifySourceIdentityReceipt(source_identity);
  validateRegistrySelection(registry_selection, source_identity);
  if (!ID.test(job_id)) throw new Error("job_id is invalid.");
  if (!["TARGETED", "PORTABLE_ALL"].includes(selection_scope)) throw new Error("selection_scope is invalid.");
  if (!Array.isArray(selected_test_ids) || selected_test_ids.length === 0) throw new Error("selected_test_ids must be non-empty.");
  if (!Array.isArray(starts) || !Array.isArray(terminals)) throw new Error("starts and terminals must be arrays.");
  requireIso(recorded_at, "recorded_at");
  const selected = [...selected_test_ids].sort();
  if (new Set(selected).size !== selected.length || selected.some((id) => !ID.test(id))) throw new Error("selected test IDs must be unique canonical IDs.");
  const registrySet = new Set(registry_selection.selected_test_ids);
  if (selected.some((id) => !registrySet.has(id))) throw new Error("lifecycle selects a test outside the portable registry selection.");
  if (selection_scope === "PORTABLE_ALL" && JSON.stringify(selected) !== JSON.stringify(registry_selection.selected_test_ids)) {
    throw new Error("PORTABLE_ALL lifecycle selection omits or adds registry tests.");
  }
  starts.forEach((start, index) => {
    exactKeys(start, ["id", "started_at"], `start ${index}`);
    if (!ID.test(start.id)) throw new Error(`start ${index} has invalid id.`);
    requireIso(start.started_at, `start ${start.id}.started_at`);
  });
  terminals.forEach((terminal, index) => {
    exactKeys(terminal, [
      "id", "status", "exit_code", "signal", "started_at", "completed_at", "duration_ms",
      "timeout_ms", "timed_out", "stdout_log", "stderr_log",
    ], `terminal ${index}`);
    if (!ID.test(terminal.id)) throw new Error(`terminal ${index} has invalid id.`);
    if (!["PASS", "FAIL", "BLOCKED", "TIMEOUT"].includes(terminal.status)) throw new Error(`terminal ${terminal.id} status is invalid.`);
    if (!(terminal.exit_code === null || Number.isInteger(terminal.exit_code))) throw new Error(`terminal ${terminal.id} exit_code is invalid.`);
    if (!(terminal.signal === null || typeof terminal.signal === "string")) throw new Error(`terminal ${terminal.id} signal is invalid.`);
    requireIso(terminal.started_at, `terminal ${terminal.id}.started_at`);
    requireIso(terminal.completed_at, `terminal ${terminal.id}.completed_at`);
    requireInteger(terminal.duration_ms, `terminal ${terminal.id}.duration_ms`, 0);
    requireInteger(terminal.timeout_ms, `terminal ${terminal.id}.timeout_ms`, 1);
    if (typeof terminal.timed_out !== "boolean") throw new Error(`terminal ${terminal.id} timed_out must be boolean.`);
    if ((terminal.status === "TIMEOUT") !== terminal.timed_out) throw new Error(`terminal ${terminal.id} timeout status and flag disagree.`);
    if (terminal.status === "PASS" && terminal.exit_code !== 0) throw new Error(`terminal ${terminal.id} PASS requires exit_code 0.`);
    validLog(terminal.stdout_log, `terminal ${terminal.id}.stdout_log`);
    validLog(terminal.stderr_log, `terminal ${terminal.id}.stderr_log`);
  });
  const startIds = uniqueIds(starts, "starts");
  const terminalIds = uniqueIds(terminals, "terminals");
  const errors = [];
  if (JSON.stringify(startIds) !== JSON.stringify(selected)) errors.push("selected != started");
  if (JSON.stringify(terminalIds) !== JSON.stringify(selected)) errors.push("selected != terminally reported");
  const startsById = new Map(starts.map((row) => [row.id, row]));
  for (const terminal of terminals) {
    if (startsById.get(terminal.id)?.started_at !== terminal.started_at) errors.push(`start time mismatch: ${terminal.id}`);
    if (new Date(terminal.completed_at) < new Date(terminal.started_at)) errors.push(`completion precedes start: ${terminal.id}`);
    if (terminal.status !== "PASS") errors.push(`${terminal.id}:${terminal.status}`);
  }
  const orderedStarts = [...starts].sort((a, b) => a.id.localeCompare(b.id));
  const orderedTerminals = [...terminals].sort((a, b) => a.id.localeCompare(b.id));
  const receipt = seal({
    schema_version: "excel-inflow-ci-test-lifecycle-receipt/1.0",
    job_id,
    status: errors.length === 0 ? "PASS" : "FAIL",
    source_binding: sourceBinding(source_identity),
    registry_selection_sha256: registry_selection.evidence_sha256,
    selection_scope,
    selected_test_ids: selected,
    selected_test_ids_sha256: canonicalSha256(selected),
    counts: { selected: selected.length, started: starts.length, terminal: terminals.length, pass: terminals.filter((row) => row.status === "PASS").length },
    starts: orderedStarts,
    terminals: orderedTerminals,
    errors: [...new Set(errors)].sort(),
    recorded_at,
  });
  requireSchema(receipt, LIFECYCLE_SCHEMA, "test lifecycle receipt");
  return receipt;
}

export function verifyTestLifecycleReceipt(receipt, sourceIdentity, registrySelection) {
  requireSchema(receipt, LIFECYCLE_SCHEMA, "test lifecycle receipt");
  requireSealed(receipt, "evidence_sha256", "test lifecycle receipt");
  sameBinding(receipt, sourceBinding(sourceIdentity), "test lifecycle receipt");
  if (receipt.registry_selection_sha256 !== registrySelection.evidence_sha256) throw new Error("lifecycle registry-selection binding mismatch.");
  const rebuilt = compileTestLifecycleReceipt({
    job_id: receipt.job_id,
    source_identity: sourceIdentity,
    registry_selection: registrySelection,
    selection_scope: receipt.selection_scope,
    selected_test_ids: receipt.selected_test_ids,
    starts: receipt.starts,
    terminals: receipt.terminals,
    recorded_at: receipt.recorded_at,
  });
  if (rebuilt.evidence_sha256 !== receipt.evidence_sha256) {
    throw new Error("lifecycle receipt fields do not match their executable lifecycle semantics.");
  }
  return receipt;
}

function requireJobEnvelope(receipt, jobId, binding) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error(`${jobId} receipt is missing.`);
  if (receipt.job_id !== jobId) throw new Error(`${jobId} receipt has wrong job_id.`);
  if (receipt.status !== "PASS") throw new Error(`${jobId} receipt is not PASS.`);
  sameBinding(receipt, binding, `${jobId} receipt`);
}

function requirePackage(receipt, jobId, binding, source) {
  exactKeys(receipt, [
    "schema_version", "job_id", "status", "source_binding", "clean_checkout", "toolchain_sha256",
    "candidate_version", "package_mode", "deployment_status", "build_timestamp_policy",
    "package_inventory_sha256", "archive_sha256", "archive_bytes", "runtime_closure_sha256", "build_log",
  ], `${jobId} receipt`);
  if (receipt.schema_version !== "excel-inflow-ci-package-build-receipt/1.0") throw new Error(`${jobId} schema is invalid.`);
  requireJobEnvelope(receipt, jobId, binding);
  if (receipt.clean_checkout !== true) throw new Error(`${jobId} was not built from a clean checkout.`);
  if (receipt.toolchain_sha256 !== source.toolchain_sha256) throw new Error(`${jobId} toolchain differs from source identity.`);
  if (!/^\d+\.\d+\.\d+$/.test(String(receipt.candidate_version)) || receipt.package_mode !== "development" || receipt.deployment_status !== "not_installed") {
    throw new Error(`${jobId} does not carry the expected pre-install candidate identity.`);
  }
  exactKeys(receipt.build_timestamp_policy, ["kind", "source_date_epoch", "generated_at"], `${jobId}.build_timestamp_policy`);
  if (receipt.build_timestamp_policy.kind !== "SOURCE_DATE_EPOCH" || !Number.isInteger(receipt.build_timestamp_policy.source_date_epoch) ||
      receipt.build_timestamp_policy.source_date_epoch < 0 ||
      new Date(receipt.build_timestamp_policy.source_date_epoch * 1000).toISOString() !== receipt.build_timestamp_policy.generated_at) {
    throw new Error(`${jobId} build timestamp policy is invalid.`);
  }
  ["package_inventory_sha256", "archive_sha256", "runtime_closure_sha256"].forEach((key) => requireSha(receipt[key], SHA256, `${jobId}.${key}`));
  requireInteger(receipt.archive_bytes, `${jobId}.archive_bytes`, 1024);
  validLog(receipt.build_log, `${jobId}.build_log`);
}

export const D52_CLOSURE_LEDGER_PATH = "audit/v379/d52-closure-ledger.json";
const D52_FINDING_STATUSES = Object.freeze(["closed", "custody-deferred", "open"]);
const D52_SUMMARY_KEYS = Object.freeze(["total", "closed", "custody_deferred", "open"]);

export function summarizeD52ClosureLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) throw new Error("D52 closure ledger must be an object.");
  if (typeof ledger.schema_version !== "string" || !/^excel-inflow-d52-closure-ledger\/\d+\.\d+$/.test(ledger.schema_version)) {
    throw new Error("D52 closure ledger schema_version is not an excel-inflow-d52-closure-ledger version.");
  }
  if (!Array.isArray(ledger.findings) || ledger.findings.length === 0) throw new Error("D52 closure ledger findings must be a non-empty array.");
  const counts = Object.fromEntries(D52_SUMMARY_KEYS.map((key) => [key, 0]));
  const seen = new Set();
  ledger.findings.forEach((finding, index) => {
    const label = `D52 closure ledger finding ${index}`;
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) throw new Error(`${label} must be an object.`);
    const id = requireString(finding.finding_id, `${label}.finding_id`);
    if (seen.has(id)) throw new Error(`D52 closure ledger repeats finding id ${id}.`);
    seen.add(id);
    if (!D52_FINDING_STATUSES.includes(finding.status)) throw new Error(`${label} (${id}) has an unrecognized status.`);
    if (!Array.isArray(finding.mapped_commits)) throw new Error(`${label} (${id}) must carry a mapped_commits array.`);
    finding.mapped_commits.forEach((commit, commitIndex) => {
      requireSha(commit?.sha, SHA1, `${label} (${id}).mapped_commits[${commitIndex}].sha`);
    });
    if (!Array.isArray(finding.proof_suites)) throw new Error(`${label} (${id}) must carry a proof_suites array.`);
    finding.proof_suites.forEach((suite, suiteIndex) => {
      requireString(suite?.suite, `${label} (${id}).proof_suites[${suiteIndex}].suite`);
    });
    counts.total += 1;
    counts[finding.status === "custody-deferred" ? "custody_deferred" : finding.status] += 1;
  });
  if (ledger.summary !== undefined) {
    if (!ledger.summary || typeof ledger.summary !== "object" || Array.isArray(ledger.summary) ||
        D52_SUMMARY_KEYS.some((key) => !Number.isInteger(ledger.summary[key]) || ledger.summary[key] !== counts[key])) {
      throw new Error("D52 closure ledger summary counts do not match its findings.");
    }
  }
  return counts;
}

export function loadD52ClosureLedger({ root = ROOT, ledger_path = D52_CLOSURE_LEDGER_PATH, required = false } = {}) {
  const file = path.resolve(root, ledger_path);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return null;
    throw new Error(error?.code === "ENOENT"
      ? `D52 closure ledger is absent at ${file}.`
      : `D52 closure ledger is not readable: ${error.message}`);
  }
  let ledger;
  try {
    ledger = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`D52 closure ledger is not readable JSON: ${error.message}`);
  }
  return {
    summary: Object.freeze({
      ...summarizeD52ClosureLedger(ledger),
      ledger_sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
    ledger,
  };
}

function requireD52ClosureSummary(value) {
  exactKeys(value, [...D52_SUMMARY_KEYS, "ledger_sha256"], "D52 closure summary");
  D52_SUMMARY_KEYS.forEach((key) => requireInteger(value[key], `d52_closure.${key}`, 0));
  if (value.total < 1 || value.closed + value.custody_deferred + value.open !== value.total) {
    throw new Error("d52_closure counts do not sum to the ledger total.");
  }
  requireSha(value.ledger_sha256, SHA256, "d52_closure.ledger_sha256");
  return canonical(value);
}

export function compileReleaseCandidateAttestation(input, { createdAt = input?.source_identity?.recorded_at, d52Closure = null } = {}) {
  exactKeys(input, JOB_IDS, "release candidate prerequisites");
  const source = verifySourceIdentityReceipt(input.source_identity);
  const binding = sourceBinding(source);
  const registry = validateRegistrySelection(input.registry_selection, source);
  verifyTestLifecycleReceipt(input.targeted_runtime, source, registry);
  verifyTestLifecycleReceipt(input.portable_gate, source, registry);
  requireJobEnvelope(input.targeted_runtime, "targeted_runtime", binding);
  requireJobEnvelope(input.portable_gate, "portable_gate", binding);
  if (input.targeted_runtime.selection_scope !== "TARGETED") throw new Error("targeted runtime receipt has wrong selection scope.");
  if (input.portable_gate.selection_scope !== "PORTABLE_ALL") throw new Error("portable gate receipt is not the full portable selection.");
  requirePackage(input.package_a, "package_a", binding, source);
  requirePackage(input.package_b, "package_b", binding, source);
  if (input.package_a.candidate_version !== input.package_b.candidate_version ||
      canonicalSha256(input.package_a.build_timestamp_policy) !== canonicalSha256(input.package_b.build_timestamp_policy)) {
    throw new Error("Package A and B do not share one candidate version and build timestamp policy.");
  }
  requireIso(createdAt, "created_at");
  const d52ClosureSummary = d52Closure == null ? null : requireD52ClosureSummary(d52Closure);

  const repro = input.package_reproducibility;
  exactKeys(repro, [
    "schema_version", "job_id", "status", "source_binding", "archive_a_sha256", "archive_b_sha256",
    "inventory_a_sha256", "inventory_b_sha256", "paths_types_bytes_sha_modes_identical",
    "archives_byte_identical", "inventories_identical", "source_date_epoch",
  ], "package_reproducibility receipt");
  if (repro.schema_version !== "excel-inflow-ci-package-reproducibility-receipt/1.0") throw new Error("reproducibility schema is invalid.");
  requireJobEnvelope(repro, "package_reproducibility", binding);
  if (repro.paths_types_bytes_sha_modes_identical !== true || repro.archives_byte_identical !== true || repro.inventories_identical !== true) {
    throw new Error("package reproducibility comparison is not exact.");
  }
  requireInteger(repro.source_date_epoch, "package_reproducibility.source_date_epoch", 0);
  if (repro.archive_a_sha256 !== input.package_a.archive_sha256 || repro.archive_b_sha256 !== input.package_b.archive_sha256 ||
      repro.inventory_a_sha256 !== input.package_a.package_inventory_sha256 || repro.inventory_b_sha256 !== input.package_b.package_inventory_sha256 ||
      repro.archive_a_sha256 !== repro.archive_b_sha256 || repro.inventory_a_sha256 !== repro.inventory_b_sha256 ||
      input.package_a.runtime_closure_sha256 !== input.package_b.runtime_closure_sha256) {
    throw new Error("reproducibility receipt does not join exactly to package A and B.");
  }

  const archive = input.archive_capability;
  exactKeys(archive, [
    "schema_version", "job_id", "status", "source_binding", "archive_sha256", "source_checkout_used",
    "public_bootstrap_status", "installed_capability_status", "independent_oracle_status",
    "capability_report_sha256", "capability_receipt_sha256", "independent_oracle_report_sha256",
  ], "archive_capability receipt");
  if (archive.schema_version !== "excel-inflow-ci-archive-capability-receipt/1.0") throw new Error("archive capability schema is invalid.");
  requireJobEnvelope(archive, "archive_capability", binding);
  if (archive.archive_sha256 !== input.package_a.archive_sha256 || archive.source_checkout_used !== false ||
      archive.public_bootstrap_status !== "PASS" || archive.installed_capability_status !== "PASS" || archive.independent_oracle_status !== "PASS") {
    throw new Error("archive-only bootstrap/capability/oracle evidence is incomplete.");
  }
  ["capability_report_sha256", "capability_receipt_sha256", "independent_oracle_report_sha256"].forEach((key) => requireSha(archive[key], SHA256, `archive_capability.${key}`));

  const mutation = input.mutation_measurement;
  exactKeys(mutation, [
    "schema_version", "job_id", "status", "source_binding", "total_mutation_suites",
    "measured_mutation_suites", "unmeasured_mutation_suites", "measurement_coverage",
    "measured_mutations_applied", "measured_mutations_caught", "measured_mutations_survived",
    "p0_fully_measured", "p0_status", "report_sha256",
  ], "mutation_measurement receipt");
  if (mutation.schema_version !== "excel-inflow-ci-mutation-measurement-receipt/1.0") throw new Error("mutation schema is invalid.");
  requireSchema(mutation, MUTATION_SCHEMA, "mutation measurement receipt");
  requireJobEnvelope(mutation, "mutation_measurement", binding);
  [
    "total_mutation_suites", "measured_mutation_suites", "unmeasured_mutation_suites",
    "measured_mutations_applied", "measured_mutations_caught", "measured_mutations_survived",
  ].forEach((key) => requireInteger(mutation[key], `mutation_measurement.${key}`, 0));
  if (mutation.total_mutation_suites < 1 || mutation.measured_mutation_suites < 1 ||
      mutation.total_mutation_suites !== mutation.measured_mutation_suites + mutation.unmeasured_mutation_suites ||
      mutation.measurement_coverage !== mutation.measured_mutation_suites / mutation.total_mutation_suites) {
    throw new Error("mutation suite coverage is inconsistent or hides unmeasured suites.");
  }
  if (mutation.measured_mutations_applied < 1 ||
      mutation.measured_mutations_caught + mutation.measured_mutations_survived !== mutation.measured_mutations_applied ||
      mutation.measured_mutations_survived !== 0) {
    throw new Error("measured mutation counts are inconsistent or have a survivor.");
  }
  if (mutation.p0_fully_measured !== true || mutation.p0_status !== "PASS") {
    throw new Error("P0 mutation evidence is not fully measured and PASS.");
  }
  requireSha(mutation.report_sha256, SHA256, "mutation_measurement.report_sha256");

  const merge = input.synthetic_merge;
  exactKeys(merge, [
    "schema_version", "job_id", "status", "source_binding", "candidate_commit", "candidate_tree",
    "merge_commit", "merge_tree", "candidate_is_parent",
  ], "synthetic_merge receipt");
  if (merge.schema_version !== "excel-inflow-ci-synthetic-merge-receipt/1.0") throw new Error("synthetic merge schema is invalid.");
  requireJobEnvelope(merge, "synthetic_merge", binding);
  ["candidate_commit", "candidate_tree", "merge_commit", "merge_tree"].forEach((key) => requireSha(merge[key], SHA1, `synthetic_merge.${key}`));
  if (merge.candidate_commit !== source.github_sha || merge.candidate_tree !== source.source_tree ||
      merge.merge_commit === source.github_sha || merge.candidate_is_parent !== true) {
    throw new Error("synthetic merge is not separately bound to the exact candidate head.");
  }

  const prerequisites = Object.fromEntries(JOB_IDS.map((jobId) => {
    const receipt = input[jobId];
    return [jobId, {
      schema_version: receipt.schema_version,
      status: receipt.status,
      sha256: jobId === "source_identity" || jobId === "registry_selection" || jobId === "targeted_runtime" || jobId === "portable_gate"
        ? receipt.evidence_sha256
        : canonicalSha256(receipt),
    }];
  }));
  const attestation = seal({
    schema_version: "excel-inflow-release-candidate-attestation/1.0",
    status: "PASS",
    scope: "EXACT_HEAD_DEVELOPMENT_EVIDENCE_ONLY",
    production_promotion_eligible: false,
    full_release_certification: false,
    candidate_version: input.package_a.candidate_version,
    source_commit: source.source_commit,
    source_tree: source.source_tree,
    runtime_closure_sha256: input.package_a.runtime_closure_sha256,
    complete_package_inventory_sha256: input.package_a.package_inventory_sha256,
    archive_sha256: input.package_a.archive_sha256,
    exact_head_ci_run: `github-actions:${source.repository}:${source.run.id}:${source.run.attempt}`,
    test_results_sha256: canonicalSha256({
      targeted_runtime: input.targeted_runtime.evidence_sha256,
      portable_gate: input.portable_gate.evidence_sha256,
    }),
    mutation_report_sha256: mutation.report_sha256,
    package_reproducibility_sha256: canonicalSha256(repro),
    installed_capability_archive_test_sha256: canonicalSha256(archive),
    created_at: createdAt,
    source_binding: binding,
    source_identity_sha256: source.evidence_sha256,
    toolchain_sha256: source.toolchain_sha256,
    registry_selection_sha256: registry.evidence_sha256,
    selected_test_ids_sha256: registry.selected_test_ids_sha256,
    package: {
      candidate_version: input.package_a.candidate_version,
      package_mode: input.package_a.package_mode,
      deployment_status: input.package_a.deployment_status,
      build_timestamp_policy: input.package_a.build_timestamp_policy,
      inventory_sha256: input.package_a.package_inventory_sha256,
      archive_sha256: input.package_a.archive_sha256,
      runtime_closure_sha256: input.package_a.runtime_closure_sha256,
    },
    mutation: {
      total_suites: mutation.total_mutation_suites,
      measured_suites: mutation.measured_mutation_suites,
      unmeasured_suites: mutation.unmeasured_mutation_suites,
      measurement_coverage: mutation.measurement_coverage,
      measured_applied: mutation.measured_mutations_applied,
      measured_caught: mutation.measured_mutations_caught,
      measured_survived: mutation.measured_mutations_survived,
      p0_fully_measured: mutation.p0_fully_measured,
      p0_status: mutation.p0_status,
    },
    ...(d52ClosureSummary ? { d52_closure: d52ClosureSummary } : {}),
    prerequisites,
  }, "attestation_sha256");
  requireSchema(attestation, ATTESTATION_SCHEMA, "release candidate attestation");
  return attestation;
}

export function verifyReleaseCandidateAttestation(attestation) {
  requireSchema(attestation, ATTESTATION_SCHEMA, "release candidate attestation");
  requireSealed(attestation, "attestation_sha256", "release candidate attestation");
  if (Object.keys(attestation.prerequisites).sort().join(",") !== [...JOB_IDS].sort().join(",")) {
    throw new Error("release candidate attestation does not name exactly ten prerequisite jobs.");
  }
  if (attestation.production_promotion_eligible !== false || attestation.full_release_certification !== false ||
      attestation.package.candidate_version !== attestation.candidate_version ||
      attestation.package.inventory_sha256 !== attestation.complete_package_inventory_sha256 ||
      attestation.package.archive_sha256 !== attestation.archive_sha256 ||
      attestation.package.runtime_closure_sha256 !== attestation.runtime_closure_sha256) {
    throw new Error("release candidate attestation overclaims promotion or its top-level package identity projection disagrees.");
  }
  return attestation;
}
