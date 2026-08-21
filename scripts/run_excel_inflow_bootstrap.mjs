#!/usr/bin/env node
/**
 * The sole public Excel Inflow product entrypoint.
 *
 * This file deliberately imports Node built-ins only.  It verifies an unpacked
 * release before the internal controller is instantiated, so missing or
 * syntactically invalid product modules still produce one typed refusal.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const BOOTSTRAP_FILE = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.dirname(BOOTSTRAP_FILE);
const PACKAGE_ROOT_LEXICAL = path.resolve(SCRIPTS_DIR, "..");
const INTERNAL_CONTROLLER_RELATIVE = "scripts/run_excel_inflow_vnext.mjs";
const RUNTIME_DOCTOR_RELATIVE = "scripts/run_runtime_doctor.mjs";
const BOOTSTRAP_RELATIVE = "scripts/run_excel_inflow_bootstrap.mjs";
const CONTROLLER_HANDOFF_RELATIVE = "scripts/lib/controller_handoff.mjs";
const SCREEN_BUFFER_LIMIT = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const PACKAGE_MODES = new Set(["development", "certified", "portable_certified"]);
const COMPANY_HEADER = "+=[ EXCEL INFLOW ]==============================[ COMPANY ]=+";
const DEVELOPMENT_MODE_MARKER = "DEVELOPMENT SOURCE · NOT INSTALLED";
const CANDIDATE_MODE_MARKER = "CANDIDATE SLOT · NOT ACTIVE";
const SESSION_MARKER = /HOST READY · SESSION [A-F0-9]{6}/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : null;
}

function classifyInvocation(argv) {
  if (argv[0] === "--diagnostic") {
    return { kind: "diagnostic", childArgs: argv.slice(1) };
  }
  return {
    kind: optionValue(argv, "--screen") === "company" ? "screen" : "normal",
    childArgs: [...argv],
  };
}

function safeInventoryPath(value) {
  return typeof value === "string" && value.length > 0 &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

async function canonicalExisting(target) {
  return fs.realpath(target);
}

async function packageMode(packageRoot) {
  const sourceMarker = await fs.lstat(path.join(packageRoot, ".git")).catch(() => null);
  if (sourceMarker?.isFile() || sourceMarker?.isDirectory()) return "source_checkout";
  return "compiled_package";
}

function minimumManifestFindings(manifest) {
  const findings = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [{ path: "release-manifest.json", issue: "manifest_not_object" }];
  }
  if (manifest.schemaVersion !== 2) {
    findings.push({ path: "release-manifest.json", issue: "unsupported_schema_version" });
  }
  if (typeof manifest.releaseName !== "string" || manifest.releaseName.trim() === "") {
    findings.push({ path: "release-manifest.json", issue: "missing_release_identity" });
  }
  if (!PACKAGE_MODES.has(manifest.packageMode)) {
    findings.push({ path: "release-manifest.json", issue: "invalid_package_mode" });
  }
  if (manifest.profile !== "assets/deployment-profile.json") {
    findings.push({ path: "release-manifest.json", issue: "invalid_deployment_profile_identity" });
  }
  if (!manifest.identity || typeof manifest.identity !== "object" || Array.isArray(manifest.identity)) {
    findings.push({ path: "release-manifest.json", issue: "missing_product_identity" });
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    findings.push({ path: "release-manifest.json", issue: "missing_file_inventory" });
  }
  return findings;
}

async function verifyCompiledPackage(packageRoot) {
  const manifestPath = path.join(packageRoot, "release-manifest.json");
  let manifestBytes;
  let manifest;
  try {
    manifestBytes = await fs.readFile(manifestPath);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    return {
      findings: [{
        path: "release-manifest.json",
        issue: error?.code === "ENOENT" ? "missing" : "unreadable_or_invalid_json",
      }],
      preservedSourceHashes: {},
    };
  }

  const findings = minimumManifestFindings(manifest);
  const records = new Map();
  for (const record of Array.isArray(manifest.files) ? manifest.files : []) {
    const member = record?.path;
    if (!safeInventoryPath(member) || !SHA256.test(String(record?.sha256 ?? ""))) {
      findings.push({ path: String(member ?? "(missing)"), issue: "invalid_inventory_record" });
      continue;
    }
    if (record.bytes !== undefined && (!Number.isSafeInteger(record.bytes) || record.bytes < 0)) {
      findings.push({ path: member, issue: "invalid_declared_byte_count" });
      continue;
    }
    if (records.has(member)) {
      findings.push({ path: member, issue: "duplicate_inventory_path" });
      continue;
    }
    records.set(member, record);
  }

  for (const required of [BOOTSTRAP_RELATIVE, INTERNAL_CONTROLLER_RELATIVE, RUNTIME_DOCTOR_RELATIVE, CONTROLLER_HANDOFF_RELATIVE]) {
    if (!records.has(required)) findings.push({ path: required, issue: "required_entrypoint_not_in_inventory" });
  }

  const actualMembers = new Set();
  async function walk(directory, prefix = "") {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      findings.push({ path: prefix || ".", issue: "package_directory_unreadable" });
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const stat = await fs.lstat(target).catch(() => null);
      if (!stat) {
        findings.push({ path: relative, issue: "package_member_unreadable" });
      } else if (stat.isSymbolicLink()) {
        findings.push({ path: relative, issue: "symlink_package_member" });
      } else if (stat.isDirectory()) {
        await walk(target, relative);
      } else if (stat.isFile()) {
        actualMembers.add(relative);
      } else {
        findings.push({ path: relative, issue: "non_regular_package_member" });
      }
    }
  }
  await walk(packageRoot);

  const expectedMembers = new Set([...records.keys(), "release-manifest.json"]);
  for (const member of actualMembers) {
    if (!expectedMembers.has(member)) findings.push({ path: member, issue: "unexpected_package_member" });
  }
  for (const member of expectedMembers) {
    if (!actualMembers.has(member)) findings.push({ path: member, issue: "missing_package_member" });
  }

  for (const [member, record] of records) {
    if (!actualMembers.has(member)) continue;
    const target = path.join(packageRoot, ...member.split("/"));
    const bytes = await fs.readFile(target).catch(() => null);
    if (!bytes) {
      findings.push({ path: member, issue: "package_member_unreadable" });
      continue;
    }
    const observed = sha256(bytes);
    if (observed !== record.sha256) {
      findings.push({
        path: member,
        issue: "sha256_mismatch",
        expected_sha256: record.sha256,
        observed_sha256: observed,
      });
    }
    if (Number.isSafeInteger(record.bytes) && bytes.length !== record.bytes) {
      findings.push({ path: member, issue: "byte_count_mismatch" });
    }
  }

  const preservedSourceHashes = {
    release_manifest_sha256: sha256(manifestBytes),
    expected_member_sha256: Object.fromEntries(
      [...records.entries()]
        .filter(([member]) => findings.some((finding) => finding.path === member))
        .map(([member, record]) => [member, record.sha256]),
    ),
  };
  return { findings, preservedSourceHashes };
}

async function nearestExistingRealpath(target) {
  let cursor = path.resolve(target);
  const suffix = [];
  for (;;) {
    try {
      const real = await fs.realpath(cursor);
      return path.join(real, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertArtifactDirectorySafe(directory, packageRoot) {
  const resolved = await nearestExistingRealpath(directory);
  if (resolved === packageRoot || resolved.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error("bootstrap artifact directory resolves inside the immutable package");
  }
  return resolved;
}

function artifactDirectory(invocation, argv) {
  const out = optionValue(argv, "--out");
  if (!out) return null;
  return invocation.kind === "diagnostic" ? path.dirname(path.resolve(out)) : path.resolve(out);
}

async function writeAtomicDurable(target, bytes) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
    await syncDirectoryIfSupported(path.dirname(target));
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function syncDirectoryIfSupported(directory) {
  let directoryHandle;
  const unsupported = new Set(["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]);
  try {
    directoryHandle = await fs.open(directory, "r");
    await directoryHandle.sync();
  } catch (error) {
    // Windows filesystems commonly refuse opening or fsyncing a directory.
    // The file itself was fsynced and atomically renamed above; tolerate only
    // the closed set of platform-unsupported directory-sync errors.
    if (!unsupported.has(error?.code)) throw error;
  } finally {
    if (directoryHandle) await directoryHandle.close();
  }
}

function compileRefusal({ packageRoot, findings, preservedSourceHashes, subordinateExecutionAttempted }) {
  return {
    schema_version: "excel-inflow-runtime-bootstrap-refusal/1.0",
    generated_at: new Date().toISOString(),
    verdict: "REFUSED",
    terminal_state: "INTERNAL_FAILURE",
    owner: "BLOCK",
    reason_code: "INTERNAL.runtime_bootstrap_failed",
    earliest_responsible_layer: "runtime_bootstrap",
    downstream_invalidation_scope: "all_runtime_lanes",
    resumable_checkpoint_path: null,
    preserved_source_hashes: preservedSourceHashes ?? {},
    subordinate_execution_attempted: Boolean(subordinateExecutionAttempted),
    package_root: packageRoot,
    findings: findings.length > 0 ? findings : [{ path: "runtime", issue: "unknown_bootstrap_failure" }],
  };
}

async function publishRefusal(refusal, directory, packageRoot) {
  const bytes = Buffer.from(`${JSON.stringify(refusal, null, 2)}\n`, "utf8");
  if (!directory) return { bytes, immutablePath: null, pointerPath: null };
  const safeDirectory = await assertArtifactDirectorySafe(directory, packageRoot);
  await fs.mkdir(safeDirectory, { recursive: true });
  const digest = sha256(bytes);
  const immutablePath = path.join(safeDirectory, `excel-inflow-bootstrap-refusal-${digest}.json`);
  await writeAtomicDurable(immutablePath, bytes);
  const pointer = {
    schema_version: "excel-inflow-runtime-bootstrap-pointer/1.0",
    status: "REFUSED",
    refusal_file: path.basename(immutablePath),
    refusal_sha256: digest,
    refusal_bytes: bytes.length,
  };
  const pointerPath = path.join(safeDirectory, "runtime-bootstrap-current.json");
  await writeAtomicDurable(pointerPath, Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, "utf8"));
  return { bytes, immutablePath, pointerPath };
}

function companyScreenComplete(stdout, stderr, code, overflowed) {
  if (code !== 0 || overflowed || stderr.length !== 0 || stdout.length === 0) return false;
  const text = stdout.toString("utf8");
  const developmentMarkers = text.split(DEVELOPMENT_MODE_MARKER).length - 1;
  const candidateMarkers = text.split(CANDIDATE_MODE_MARKER).length - 1;
  return text.startsWith("```text\n") && text.endsWith("```\n") &&
    text.includes(`${COMPANY_HEADER}\n`) &&
    SESSION_MARKER.test(text) &&
    developmentMarkers <= 1 && candidateMarkers <= 1 &&
    developmentMarkers + candidateMarkers <= 1 &&
    (text.match(/```/g) ?? []).length === 2;
}

function runBuffered(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["inherit", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    const collect = (bucket, chunk, kind) => {
      if (overflowed) return;
      if (kind === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > SCREEN_BUFFER_LIMIT) {
        overflowed = true;
        child.kill("SIGKILL");
        return;
      }
      bucket.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.on("error", (error) => resolve({ code: null, signal: null, error, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), overflowed }));
    child.on("close", (code, signal) => resolve({ code, signal, error: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), overflowed }));
  });
}

function runPassthrough(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
    child.on("close", (code, signal) => resolve({ code, signal, error: null }));
  });
}

async function childFailureFingerprints(directory) {
  const owned = new Map();
  if (!directory) return owned;
  const resolved = await nearestExistingRealpath(directory).catch(() => null);
  if (!resolved) return owned;
  const entries = await fs.readdir(resolved, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const target = path.join(resolved, entry.name);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || stat.size <= 0 || stat.size > 8 * 1024 * 1024) continue;
    const value = await fs.readFile(target, "utf8").then(JSON.parse).catch(() => null);
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const typed = typeof value.schema_version === "string" &&
      typeof value.reason_code === "string" &&
      (
        value.terminal_state === "INTERNAL_FAILURE" ||
        value.status === "INTERNAL_FAILURE" ||
        value.status === "NEEDS_INTERNAL_WORK" ||
        value.verdict === "REFUSED"
      );
    if (
      typed ||
      value.schema_version === "excel-inflow-runtime-bootstrap-refusal/1.0"
    ) owned.set(target, sha256(await fs.readFile(target)));
  }
  return owned;
}

async function childCreatedFreshFailure(directory, before) {
  const after = await childFailureFingerprints(directory);
  return [...after].some(([target, fingerprint]) => before.get(target) !== fingerprint);
}

async function main() {
  const originalArgs = process.argv.slice(2);
  const invocation = classifyInvocation(originalArgs);
  const packageRoot = await canonicalExisting(PACKAGE_ROOT_LEXICAL);
  const mode = await packageMode(packageRoot);
  const directory = artifactDirectory(invocation, originalArgs);

  if (directory) {
    try {
      await assertArtifactDirectorySafe(directory, packageRoot);
    } catch (error) {
      const refusal = compileRefusal({
        packageRoot,
        findings: [{ path: directory, issue: error.message }],
        preservedSourceHashes: {},
        subordinateExecutionAttempted: false,
      });
      process.stdout.write(`${JSON.stringify(refusal, null, 2)}\n`);
      return 1;
    }
  }

  if (mode === "compiled_package") {
    const verification = await verifyCompiledPackage(packageRoot);
    if (verification.findings.length > 0) {
      const refusal = compileRefusal({
        packageRoot,
        findings: verification.findings,
        preservedSourceHashes: verification.preservedSourceHashes,
        subordinateExecutionAttempted: false,
      });
      const published = await publishRefusal(refusal, directory, packageRoot);
      process.stdout.write(published.bytes);
      return 1;
    }
  }

  const childRelative = invocation.kind === "diagnostic"
    ? RUNTIME_DOCTOR_RELATIVE
    : INTERNAL_CONTROLLER_RELATIVE;
  const childPath = await canonicalExisting(path.join(packageRoot, ...childRelative.split("/")));
  let handoff = null;
  const childEnvironment = { ...process.env };
  if (invocation.kind !== "diagnostic") {
    const handoffModulePath = await canonicalExisting(
      path.join(packageRoot, ...CONTROLLER_HANDOFF_RELATIVE.split("/")),
    );
    const { createControllerHandoff } = await import(pathToFileURL(handoffModulePath).href);
    handoff = await createControllerHandoff({
      packageRoot,
      parentController: BOOTSTRAP_FILE,
      childController: childPath,
      childArgs: invocation.childArgs,
    });
    Object.assign(childEnvironment, handoff.env);
  }
  const childOptions = { cwd: packageRoot, env: childEnvironment };

  if (invocation.kind === "screen") {
    const result = await runBuffered(process.execPath, [childPath, ...invocation.childArgs], childOptions)
      .finally(() => handoff?.cleanup());
    if (companyScreenComplete(result.stdout, result.stderr, result.code, result.overflowed)) {
      process.stdout.write(result.stdout);
      return 0;
    }
    const refusal = compileRefusal({
      packageRoot,
      findings: [{
        path: childRelative,
        issue: result.error
          ? `spawn_failed:${result.error.message}`
          : result.overflowed
            ? "company_screen_buffer_limit_exceeded"
            : `company_screen_child_failed_or_incomplete:exit=${result.code}:signal=${result.signal ?? "none"}`,
      }],
      preservedSourceHashes: {},
      subordinateExecutionAttempted: true,
    });
    const published = await publishRefusal(refusal, directory, packageRoot);
    process.stdout.write(published.bytes);
    return 1;
  }

  const priorChildFailures = await childFailureFingerprints(directory);
  const result = await runPassthrough(process.execPath, [childPath, ...invocation.childArgs], childOptions)
    .finally(() => handoff?.cleanup());
  if (result.code === 0) return 0;
  if (await childCreatedFreshFailure(directory, priorChildFailures)) {
    return Number.isInteger(result.code) ? result.code : 1;
  }

  const refusal = compileRefusal({
    packageRoot,
    findings: [{
      path: childRelative,
      issue: result.error
        ? `spawn_failed:${result.error.message}`
        : `child_exited_nonzero:exit=${result.code}:signal=${result.signal ?? "none"}`,
    }],
    preservedSourceHashes: {},
    subordinateExecutionAttempted: true,
  });
  const published = await publishRefusal(refusal, directory, packageRoot);
  process.stdout.write(published.bytes);
  return 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  const packageRoot = await canonicalExisting(PACKAGE_ROOT_LEXICAL).catch(() => PACKAGE_ROOT_LEXICAL);
  const originalArgs = process.argv.slice(2);
  const invocation = classifyInvocation(originalArgs);
  const directory = artifactDirectory(invocation, originalArgs);
  const refusal = compileRefusal({
    packageRoot,
    findings: [{ path: "runtime_bootstrap", issue: error?.message ?? String(error) }],
    preservedSourceHashes: {},
    subordinateExecutionAttempted: false,
  });
  const published = await publishRefusal(refusal, directory, packageRoot).catch(() => ({
    bytes: Buffer.from(`${JSON.stringify(refusal, null, 2)}\n`, "utf8"),
  }));
  process.stdout.write(published.bytes);
  process.exitCode = 1;
}
