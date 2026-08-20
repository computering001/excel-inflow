import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DECLARED_RUNTIME_INTEGRITY_SCHEMA,
  runtimeCodeClosureIdentity,
} from "./identity_vocabulary.mjs";
// The ONE runtime-code-closure membership definition. This module must not
// carry its own rule for which declared files are the executable closure.
import { runtimeCodeClosureMembers } from "./source_identity.mjs";

const RUN_IDENTITY_SCHEMA = "debt-runtime-identity/1.0";
const RUN_LEASE_SCHEMA = "debt-runtime-lease/1.1";
const LEGACY_RUN_LEASE_SCHEMA = "debt-runtime-lease/1.0";
const IDENTITY_FILE = ".run-identity.json";
const LEASE_DIRECTORY = ".run-lease";
const LEASE_FILE = "lease.json";
const LEASE_TAKEOVER_DIRECTORY = ".run-lease-takeovers";
const LEASE_INITIALISATION_GRACE_MS = 30_000;
const DEFAULT_LEASE_DURATION_MS = 300_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_LEASE_DURATION_MS = 3_600_000;
const LEGACY_CROSS_HOST_EXPIRY_MS = 86_400_000;
const PROCESS_SESSION_ID = randomUUID();
const ACTIVE_LEASE_HEARTBEATS = new Map();
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISSUER_IDENTITY_FIELDS = Object.freeze([
  "name",
  "legal_name",
  "lei",
  "ticker",
  "exchange",
  "country",
  "reporting_currency",
  "fiscal_year_end",
]);

function canonicalise(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalise(value[key]);
  return output;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalise(value), null, 2);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Value(value) {
  return sha256Bytes(canonicalJson(value));
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Resolve a path even when its final components do not exist. The deepest
 * existing ancestor is resolved with realpath, so an existing symlink cannot
 * disguise a target inside a protected tree. A dangling symlink is rejected:
 * treating its spelling as an ordinary missing component would reopen the
 * escape this function exists to close.
 */
export async function canonicalPathThroughExistingAncestor(target) {
  if (typeof target !== "string" || target.trim() === "") {
    throw new Error("A non-empty filesystem path is required.");
  }
  const absolute = path.resolve(target);
  const remainder = [];
  let cursor = absolute;

  while (true) {
    try {
      const resolved = await fs.realpath(cursor);
      return path.join(resolved, ...remainder);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      if (await pathExists(cursor)) {
        throw new Error(`Existing path cannot be resolved safely: ${cursor}`);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`No existing ancestor could be resolved for ${absolute}`);
      remainder.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isEqualToOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function assertRunRootOutsideSkill({ skillRoot, runRoot }) {
  const canonicalSkillRoot = await canonicalPathThroughExistingAncestor(skillRoot);
  const canonicalRunRoot = await canonicalPathThroughExistingAncestor(runRoot);
  if (isEqualToOrInside(canonicalRunRoot, canonicalSkillRoot)) {
    throw new Error(`Run root must be outside the immutable skill root: ${canonicalRunRoot}`);
  }
  return Object.freeze({
    skill_root: canonicalSkillRoot,
    run_root: canonicalRunRoot,
  });
}

/**
 * Refuse any direct output target that resolves into the immutable skill tree.
 * Lower-level diagnostic entry points do not own a run workspace, but they
 * must still uphold the non-negotiable half of the production contract: no
 * generated case, sidecar, workbook or report may be written into the skill.
 */
export async function assertWriteTargetOutsideSkill({ skillRoot, target }) {
  const canonicalSkillRoot = await canonicalPathThroughExistingAncestor(skillRoot);
  const canonicalTarget = await canonicalPathThroughExistingAncestor(target);
  if (isEqualToOrInside(canonicalTarget, canonicalSkillRoot)) {
    throw new Error(`Output target must be outside the immutable skill root: ${canonicalTarget}`);
  }
  return canonicalTarget;
}

export function validateRunId(runId) {
  if (typeof runId !== "string" || !SAFE_RUN_ID.test(runId) || runId === "." || runId === "..") {
    throw new Error(
      "Run ID must be one safe non-empty path segment (1-128 ASCII letters, digits, dot, underscore or hyphen).",
    );
  }
  return runId;
}

function requireNonEmptyString(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

export function normaliseIssuerIdentity(value) {
  const input = typeof value === "string" ? { name: value } : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Issuer identity must be a name or an object of stable issuer identifiers.");
  }
  const unknown = Object.keys(input).filter((key) => !ISSUER_IDENTITY_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Issuer identity contains non-identity fields: ${unknown.sort().join(", ")}`);
  }
  const identity = {};
  for (const key of ISSUER_IDENTITY_FIELDS) {
    if (input[key] === undefined || input[key] === null) continue;
    if (!["string", "number"].includes(typeof input[key])) {
      throw new Error(`Issuer identity field ${key} must be a scalar.`);
    }
    const text = String(input[key]).trim();
    if (text !== "") identity[key] = text;
  }
  if (Object.keys(identity).length === 0) {
    throw new Error("Issuer identity must contain at least one stable identifier.");
  }
  return Object.freeze(canonicalise(identity));
}

function uniqueTemporaryPath(target) {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

async function writeTemporaryFile(target, bytes, encoding = null) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = uniqueTemporaryPath(target);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    if (encoding) await handle.writeFile(bytes, encoding);
    else await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    return temporary;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function atomicWriteText(target, text) {
  const absolute = path.resolve(target);
  const temporary = await writeTemporaryFile(absolute, String(text), "utf8");
  try {
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return absolute;
}

export async function atomicWriteJson(target, value) {
  return atomicWriteText(target, `${canonicalJson(value)}\n`);
}

function identityBody({ runId, controllerVersion, workspaceToken, issuerIdentity }) {
  const normalisedIssuer = normaliseIssuerIdentity(issuerIdentity);
  return {
    schema_version: RUN_IDENTITY_SCHEMA,
    run_id: validateRunId(runId),
    controller_version: requireNonEmptyString("Controller version", controllerVersion),
    workspace_session_token_hash: sha256Bytes(
      requireNonEmptyString("Workspace/session token", workspaceToken),
    ),
    issuer_identity: normalisedIssuer,
    issuer_identity_hash: sha256Value(normalisedIssuer),
  };
}

function completeIdentity(body) {
  return Object.freeze({ ...body, identity_hash: sha256Value(body) });
}

function verifyIdentityShape(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("Run identity is not a JSON object.");
  }
  if (identity.schema_version !== RUN_IDENTITY_SCHEMA) {
    throw new Error("Run identity schema does not match.");
  }
  if (!SHA256.test(String(identity.identity_hash)) || identity.identity_hash !== sha256Value((() => {
    const { identity_hash: _ignored, ...body } = identity;
    return body;
  })())) {
    throw new Error("Run identity hash does not match its contents.");
  }
}

async function installImmutableJson(target, value) {
  const temporary = await writeTemporaryFile(target, `${canonicalJson(value)}\n`, "utf8");
  try {
    // link() is the portable no-replace primitive available to Node here. It
    // atomically installs the complete temporary inode and returns EEXIST when
    // another invocation has already established the immutable identity.
    await fs.link(temporary, target);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function initializeOrVerifyRunIdentity({
  skillRoot,
  runRoot,
  runId,
  controllerVersion,
  workspaceToken,
  issuerIdentity,
}) {
  const isolated = await assertRunRootOutsideSkill({ skillRoot, runRoot });
  await fs.mkdir(isolated.run_root, { recursive: true });
  const expected = completeIdentity(identityBody({
    runId,
    controllerVersion,
    workspaceToken,
    issuerIdentity,
  }));
  const target = path.join(isolated.run_root, IDENTITY_FILE);
  const created = await installImmutableJson(target, expected);
  let actual;
  try {
    actual = JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    throw new Error(`Run identity is unreadable: ${error.message}`);
  }
  verifyIdentityShape(actual);
  if (sha256Value(actual) !== sha256Value(expected)) {
    throw new Error("Run identity does not match this run, controller, workspace/session or issuer.");
  }
  return Object.freeze({
    created,
    path: target,
    identity: actual,
    run_root: isolated.run_root,
  });
}

function processIsLive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function observeLocalProcess(pid) {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  const observed = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "stat=", "-o", "lstart="],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    },
  );
  if (observed.status !== 0) return null;
  const match = String(observed.stdout ?? "").trim().match(/^(\S+)\s+(.+)$/);
  if (!match) return null;
  return Object.freeze({
    state: match[1],
    start_identity: match[2].replaceAll(/\s+/g, " ").trim(),
    zombie: match[1].startsWith("Z"),
  });
}

function positiveDuration(label, value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 50 || parsed > MAX_LEASE_DURATION_MS) {
    throw new Error(`${label} must be between 50 and ${MAX_LEASE_DURATION_MS} milliseconds.`);
  }
  return Math.floor(parsed);
}

function leaseHostIdentity() {
  const body = {
    hostname: os.hostname(),
    platform: os.platform(),
    architecture: os.arch(),
  };
  return Object.freeze({ ...body, host_id: sha256Value(body) });
}

function leaseSessionIdentity(sessionId) {
  const source = String(
    sessionId ??
    process.env.EXCEL_INFLOW_WORKSPACE_TOKEN ??
    process.env.CODEX_THREAD_ID ??
    PROCESS_SESSION_ID,
  );
  return sha256Bytes(source);
}

function leaseTimestamp(epochMs) {
  return new Date(epochMs).toISOString();
}

function leaseExpiryEpoch(lease) {
  const parsed = Date.parse(String(lease?.expires_at ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function leaseShapeIsCurrent(lease) {
  const hostBody = {
    hostname: lease?.host_identity?.hostname,
    platform: lease?.host_identity?.platform,
    architecture: lease?.host_identity?.architecture,
  };
  const acquired = Date.parse(String(lease?.acquired_at ?? ""));
  const heartbeat = Date.parse(String(lease?.heartbeat_at ?? ""));
  const expiry = leaseExpiryEpoch(lease);
  return Boolean(
    lease &&
    lease.schema_version === RUN_LEASE_SCHEMA &&
    typeof lease.owner === "string" && lease.owner.trim() !== "" &&
    Number.isSafeInteger(lease.pid) && lease.pid > 0 &&
    typeof lease.token === "string" && lease.token !== "" &&
    lease.host_identity?.hostname &&
    SHA256.test(String(lease.host_identity?.host_id ?? "")) &&
    lease.host_identity.host_id === sha256Value(hostBody) &&
    typeof lease.session_identity_hash === "string" && SHA256.test(lease.session_identity_hash) &&
    (lease.process_start_identity === undefined || lease.process_start_identity === null ||
      (typeof lease.process_start_identity === "string" && lease.process_start_identity.trim() !== "")) &&
    Number.isFinite(acquired) && Number.isFinite(heartbeat) && expiry !== null &&
    Number.isSafeInteger(lease.heartbeat_sequence) && lease.heartbeat_sequence >= 0 &&
    Number.isSafeInteger(lease.lease_duration_ms) &&
    lease.lease_duration_ms >= 50 && lease.lease_duration_ms <= MAX_LEASE_DURATION_MS &&
    acquired <= heartbeat && heartbeat < expiry &&
    expiry - heartbeat <= lease.lease_duration_ms + 1_000
  );
}

async function readLease(leaseDirectory) {
  try {
    return JSON.parse(await fs.readFile(path.join(leaseDirectory, LEASE_FILE), "utf8"));
  } catch {
    return null;
  }
}

async function inspectLease(lease, leaseDirectory, now = Date.now()) {
  if (!lease || ![RUN_LEASE_SCHEMA, LEGACY_RUN_LEASE_SCHEMA].includes(lease.schema_version)) {
    // mkdir is the atomic acquisition point; the owner writes lease.json
    // immediately afterwards. A competing invocation must not steal that
    // directory during this short installation window merely because the JSON
    // is not visible yet. Old unreadable directories remain recoverable.
    try {
      const stat = await fs.stat(leaseDirectory);
      const age = now - stat.mtimeMs;
      return {
        live: age < LEASE_INITIALISATION_GRACE_MS,
        takeover_reason: age < LEASE_INITIALISATION_GRACE_MS
          ? null
          : "unreadable_lease_after_initialisation_grace",
      };
    } catch {
      return { live: false, takeover_reason: "lease_directory_absent" };
    }
  }
  if (lease.schema_version === RUN_LEASE_SCHEMA) {
    if (!leaseShapeIsCurrent(lease)) {
      try {
        const stat = await fs.stat(leaseDirectory);
        const withinGrace = now - stat.mtimeMs < LEASE_INITIALISATION_GRACE_MS;
        return {
          live: withinGrace,
          takeover_reason: withinGrace ? null : "malformed_lease_after_initialisation_grace",
        };
      } catch {
        return { live: false, takeover_reason: "lease_directory_absent" };
      }
    }
    const expiry = leaseExpiryEpoch(lease);
    if (lease.host_identity.hostname === os.hostname()) {
      if (!processIsLive(lease.pid)) {
        return { live: false, takeover_reason: "same_host_process_dead" };
      }
      const observedProcess = observeLocalProcess(lease.pid);
      if (observedProcess?.zombie) {
        return { live: false, takeover_reason: "same_host_process_zombie" };
      }
      if (
        lease.process_start_identity &&
        observedProcess?.start_identity &&
        lease.process_start_identity !== observedProcess.start_identity
      ) {
        return { live: false, takeover_reason: "same_host_pid_reused" };
      }
    }
    if (now < expiry) return { live: true, takeover_reason: null };
    return { live: false, takeover_reason: "heartbeat_expired" };
  }
  if (lease.hostname === os.hostname()) {
    return {
      live: processIsLive(lease.pid),
      takeover_reason: processIsLive(lease.pid) ? null : "legacy_same_host_process_dead",
    };
  }
  try {
    const stat = await fs.stat(path.join(leaseDirectory, LEASE_FILE));
    const expired = now - stat.mtimeMs >= LEGACY_CROSS_HOST_EXPIRY_MS;
    return {
      live: !expired,
      takeover_reason: expired ? "legacy_cross_host_lease_expired" : null,
    };
  } catch {
    return { live: true, takeover_reason: null };
  }
}

async function writeLeaseWithoutRecreatingDirectory(leaseDirectory, lease) {
  const target = path.join(leaseDirectory, LEASE_FILE);
  const temporary = path.join(
    leaseDirectory,
    `.heartbeat.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${canonicalJson(lease)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const current = await readLease(leaseDirectory);
    if (!current || current.token !== lease.token) {
      throw new Error("Run lease changed owner before its heartbeat could be written.");
    }
    await fs.rename(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function heartbeatRunLease(runRoot, token, { leaseDurationMs } = {}) {
  const canonicalRunRoot = await canonicalPathThroughExistingAncestor(runRoot);
  const leaseDirectory = path.join(canonicalRunRoot, LEASE_DIRECTORY);
  const existing = await readLease(leaseDirectory);
  if (!leaseShapeIsCurrent(existing)) throw new Error("Run lease is absent, legacy or malformed.");
  if (existing.token !== token) throw new Error("Run lease token does not match the current owner.");
  const now = Date.now();
  if (now >= leaseExpiryEpoch(existing)) {
    throw new Error("An expired run lease cannot be revived by a late heartbeat.");
  }
  const duration = positiveDuration(
    "Lease duration",
    leaseDurationMs ?? existing.lease_duration_ms,
    DEFAULT_LEASE_DURATION_MS,
  );
  const renewed = {
    ...existing,
    heartbeat_at: leaseTimestamp(now),
    expires_at: leaseTimestamp(now + duration),
    heartbeat_sequence: Number(existing.heartbeat_sequence ?? 0) + 1,
  };
  await writeLeaseWithoutRecreatingDirectory(leaseDirectory, renewed);
  return Object.freeze(renewed);
}

function startLeaseHeartbeat(runRoot, token, leaseDurationMs, heartbeatIntervalMs) {
  const entry = { timer: null, last_error: null };
  entry.timer = setInterval(() => {
    heartbeatRunLease(runRoot, token, { leaseDurationMs }).catch((error) => {
      entry.last_error = error;
      clearInterval(entry.timer);
    });
  }, heartbeatIntervalMs);
  entry.timer.unref?.();
  ACTIVE_LEASE_HEARTBEATS.set(token, entry);
}

async function recordLeaseTakeover({ runRoot, staleDirectory, observed, reason, owner, sessionIdentity }) {
  const captured = await readLease(staleDirectory);
  if (sha256Value(captured) !== sha256Value(observed)) {
    throw new Error("Run lease changed while an expired takeover was being isolated.");
  }
  const takeoverId = randomUUID();
  const receiptBody = {
    schema_version: "debt-runtime-lease-takeover/1.0",
    takeover_id: takeoverId,
    occurred_at: new Date().toISOString(),
    reason,
    prior_lease_sha256: sha256Value(captured),
    prior_owner: captured?.owner ?? null,
    prior_pid: captured?.pid ?? null,
    prior_host_identity: captured?.host_identity ?? (
      captured?.hostname ? { hostname: captured.hostname, host_id: null } : null
    ),
    prior_session_identity_hash: captured?.session_identity_hash ?? null,
    prior_heartbeat_at: captured?.heartbeat_at ?? null,
    prior_expires_at: captured?.expires_at ?? null,
    acquiring_owner: owner,
    acquiring_host_identity: leaseHostIdentity(),
    acquiring_session_identity_hash: sessionIdentity,
  };
  const receipt = { ...receiptBody, receipt_sha256: sha256Value(receiptBody) };
  const receiptDirectory = path.join(runRoot, LEASE_TAKEOVER_DIRECTORY);
  await fs.mkdir(receiptDirectory, { recursive: true });
  const receiptPath = path.join(receiptDirectory, `${receipt.occurred_at.replace(/[:.]/g, "-")}-${takeoverId}.json`);
  await atomicWriteJson(receiptPath, receipt);
  return receiptPath;
}

export async function acquireRunLease(runRoot, {
  owner = "debt-model-runtime",
  sessionId = null,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
} = {}) {
  const canonicalRunRoot = await canonicalPathThroughExistingAncestor(runRoot);
  await fs.mkdir(canonicalRunRoot, { recursive: true });
  const leaseDirectory = path.join(canonicalRunRoot, LEASE_DIRECTORY);
  let recoveredStale = false;
  const takeoverReceipts = [];
  const normalisedOwner = requireNonEmptyString("Lease owner", owner);
  const sessionIdentity = leaseSessionIdentity(sessionId);
  const duration = positiveDuration("Lease duration", leaseDurationMs, DEFAULT_LEASE_DURATION_MS);
  const heartbeatInterval = positiveDuration(
    "Lease heartbeat interval",
    heartbeatIntervalMs,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  if (heartbeatInterval >= duration) {
    throw new Error("Lease heartbeat interval must be shorter than lease duration.");
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.mkdir(leaseDirectory);
      const token = randomUUID();
      const now = Date.now();
      const lease = {
        schema_version: RUN_LEASE_SCHEMA,
        owner: normalisedOwner,
        pid: process.pid,
        token,
        host_identity: leaseHostIdentity(),
        session_identity_hash: sessionIdentity,
        process_start_identity: observeLocalProcess(process.pid)?.start_identity ?? null,
        acquired_at: leaseTimestamp(now),
        heartbeat_at: leaseTimestamp(now),
        expires_at: leaseTimestamp(now + duration),
        lease_duration_ms: duration,
        heartbeat_interval_ms: heartbeatInterval,
        heartbeat_sequence: 0,
      };
      await atomicWriteJson(path.join(leaseDirectory, LEASE_FILE), lease);
      startLeaseHeartbeat(canonicalRunRoot, token, duration, heartbeatInterval);
      return Object.freeze({
        path: leaseDirectory,
        token,
        recovered_stale: recoveredStale,
        takeover_receipts: Object.freeze([...takeoverReceipts]),
        lease,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const existing = await readLease(leaseDirectory);
    const inspection = await inspectLease(existing, leaseDirectory);
    if (inspection.live) {
      throw new Error(
        `Run already has a live lease${existing ? ` (pid ${existing.pid} on ${existing.host_identity?.hostname ?? existing.hostname ?? "unknown host"})` : ""}.`,
      );
    }

    const stale = `${leaseDirectory}.stale.${process.pid}.${randomUUID()}`;
    try {
      await fs.rename(leaseDirectory, stale);
      const takeoverReceipt = await recordLeaseTakeover({
        runRoot: canonicalRunRoot,
        staleDirectory: stale,
        observed: existing,
        reason: inspection.takeover_reason,
        owner: normalisedOwner,
        sessionIdentity,
      });
      takeoverReceipts.push(takeoverReceipt);
      recoveredStale = true;
      await fs.rm(stale, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        const staleExists = await pathExists(stale);
        const activeExists = await pathExists(leaseDirectory);
        if (staleExists && !activeExists) {
          await fs.rename(stale, leaseDirectory).catch(() => {});
        }
        throw error;
      }
    }
  }
  throw new Error("Could not acquire the run lease after repeated concurrent attempts.");
}

export async function releaseRunLease(runRoot, token) {
  const heartbeat = ACTIVE_LEASE_HEARTBEATS.get(token);
  if (heartbeat) {
    clearInterval(heartbeat.timer);
    ACTIVE_LEASE_HEARTBEATS.delete(token);
  }
  const canonicalRunRoot = await canonicalPathThroughExistingAncestor(runRoot);
  const leaseDirectory = path.join(canonicalRunRoot, LEASE_DIRECTORY);
  const existing = await readLease(leaseDirectory);
  if (!existing) throw new Error("Run lease is absent or unreadable.");
  if (existing.token !== token) throw new Error("Run lease token does not match the current owner.");
  await fs.rm(leaseDirectory, { recursive: true, force: true });
  if (heartbeat?.last_error) {
    throw new Error(`Run lease heartbeat failed before release: ${heartbeat.last_error.message}`);
  }
}

async function walkFiles(root) {
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(target);
      else throw new Error(`Declared runtime contains a non-regular entry: ${target}`);
    }
  }
  await walk(root);
  return files;
}

async function assertDeclaredPath(skillRoot, target) {
  const canonical = await canonicalPathThroughExistingAncestor(target);
  if (!isEqualToOrInside(canonical, skillRoot)) {
    throw new Error(`Declared runtime path escapes the skill root: ${target}`);
  }
  return canonical;
}

function stringList(profile, key) {
  const value = profile[key] ?? [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`deployment-profile ${key} must be an array of non-empty paths.`);
  }
  return value;
}

function safeProfileRelativePath(value, label) {
  if (typeof value !== "string" || value.trim() === "" || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path.`);
  }
  const normalized = path.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} escapes the skill root.`);
  }
  return normalized;
}

async function optionalRegularFile(target) {
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`Vendored runtime member is not a regular file: ${target}`);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function addVendoredRuntimeFiles({ canonicalSkillRoot, profile, files }) {
  const dependencies = profile.vendored_dependencies ?? [];
  if (!Array.isArray(dependencies)) throw new Error("deployment-profile vendored_dependencies must be an array.");
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) {
      throw new Error("Each vendored dependency must be an object.");
    }
    const name = String(dependency.name ?? "").trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("Vendored dependency name is invalid.");
    const runtimeRelative = safeProfileRelativePath(dependency.install_path, `vendored dependency ${name} install path`);
    const runtimeSource = safeProfileRelativePath(dependency.source, `vendored dependency ${name} source path`);
    if (runtimeSource !== runtimeRelative) {
      throw new Error(`Vendored dependency ${name} source and install paths must be identical in the immutable source skill.`);
    }
    const runtimeTarget = await assertDeclaredPath(canonicalSkillRoot, path.resolve(canonicalSkillRoot, runtimeRelative));
    if (!(await optionalRegularFile(runtimeTarget))) throw new Error(`Vendored dependency ${name} runtime bytes are absent.`);
    const runtimeBytes = await fs.readFile(runtimeTarget);
    const runtimeHash = sha256Bytes(runtimeBytes);
    if (!SHA256.test(String(dependency.sha256 ?? "")) || runtimeHash !== dependency.sha256) {
      throw new Error(`Vendored dependency ${name} runtime hash does not match deployment-profile.`);
    }
    files[runtimeRelative.split(path.sep).join("/")] = runtimeHash;

    const licenseRelative = safeProfileRelativePath(dependency.license_install_path, `vendored dependency ${name} license install path`);
    const licenseSource = safeProfileRelativePath(dependency.license_source, `vendored dependency ${name} license source path`);
    if (licenseSource !== licenseRelative) {
      throw new Error(`Vendored dependency ${name} license source and install paths must be identical in the immutable source skill.`);
    }
    const licenseTarget = await assertDeclaredPath(canonicalSkillRoot, path.resolve(canonicalSkillRoot, licenseRelative));
    if (!(await optionalRegularFile(licenseTarget))) throw new Error(`Vendored dependency ${name} license bytes are absent.`);
    const licenseHash = sha256Bytes(await fs.readFile(licenseTarget));
    if (!SHA256.test(String(dependency.license_sha256 ?? "")) || licenseHash !== dependency.license_sha256) {
      throw new Error(`Vendored dependency ${name} license hash does not match deployment-profile.`);
    }
    files[licenseRelative.split(path.sep).join("/")] = licenseHash;

    const packageRelative = path.join(path.dirname(runtimeRelative), "package.json");
    const packageTarget = await assertDeclaredPath(canonicalSkillRoot, path.resolve(canonicalSkillRoot, packageRelative));
    if (!(await optionalRegularFile(packageTarget))) throw new Error(`Vendored dependency ${name} package.json is absent.`);
    const packageHash = sha256Bytes(await fs.readFile(packageTarget));
    if (!SHA256.test(String(dependency.package_sha256 ?? "")) || packageHash !== dependency.package_sha256) {
      throw new Error(`Vendored dependency ${name} package hash does not match deployment-profile.`);
    }
    files[packageRelative.split(path.sep).join("/")] = packageHash;
  }
}

export async function computeDeclaredRuntimeIntegrity(skillRoot) {
  const canonicalSkillRoot = await canonicalPathThroughExistingAncestor(skillRoot);
  const profilePath = path.join(canonicalSkillRoot, "assets", "deployment-profile.json");
  const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
  const declared = new Set([
    path.join(canonicalSkillRoot, "SKILL.md"),
    profilePath,
    ...stringList(profile, "reference_allowlist").map((item) => path.join(canonicalSkillRoot, "references", item)),
    ...stringList(profile, "asset_allowlist").map((item) => path.join(canonicalSkillRoot, "assets", item)),
    ...stringList(profile, "script_allowlist").map((item) => path.join(canonicalSkillRoot, "scripts", item)),
    ...stringList(profile, "python_module_allowlist").map((item) => path.join(canonicalSkillRoot, "scripts", item)),
  ]);
  const resourceFiles = [];
  for (const item of stringList(profile, "resource_directory_allowlist")) {
    const directory = await assertDeclaredPath(canonicalSkillRoot, path.join(canonicalSkillRoot, item));
    for (const file of await walkFiles(directory)) {
      declared.add(file);
      resourceFiles.push(path.relative(canonicalSkillRoot, file).split(path.sep).join("/"));
    }
  }

  const files = {};
  for (const target of [...declared].sort()) {
    const canonical = await assertDeclaredPath(canonicalSkillRoot, target);
    const stat = await fs.stat(canonical);
    if (!stat.isFile()) throw new Error(`Declared runtime member is not a regular file: ${target}`);
    const relative = path.relative(canonicalSkillRoot, canonical).split(path.sep).join("/");
    files[relative] = sha256Bytes(await fs.readFile(canonical));
  }
  await addVendoredRuntimeFiles({ canonicalSkillRoot, profile, files });
  const ordered = canonicalise(files);
  // Select the executable closure's bytes using the single membership
  // definition; this validator only proves the members exist and hashes them.
  const members = runtimeCodeClosureMembers({
    scripts: stringList(profile, "script_allowlist"),
    pythonModules: stringList(profile, "python_module_allowlist"),
    assets: stringList(profile, "asset_allowlist"),
    resources: resourceFiles,
    vendoredDependencies: Array.isArray(profile.vendored_dependencies)
      ? profile.vendored_dependencies
      : [],
  });
  const runtimeCodeFiles = {};
  for (const member of members) {
    const digest = ordered[member.key];
    if (!digest) {
      throw new Error(
        `Runtime code closure member is missing from the declared runtime inventory: ${member.key}`,
      );
    }
    runtimeCodeFiles[member.key] = digest;
  }
  const runtimeCodeClosure = runtimeCodeClosureIdentity(runtimeCodeFiles);
  return Object.freeze({
    schema_version: DECLARED_RUNTIME_INTEGRITY_SCHEMA,
    identity_kind: "declared_runtime_integrity",
    skill_root: canonicalSkillRoot,
    file_count: Object.keys(ordered).length,
    files: ordered,
    digest: sha256Value(ordered),
    runtime_code_closure: runtimeCodeClosure,
  });
}

// Compatibility name retained for installed callers. The returned object now
// names the full process-integrity inventory separately from its executable
// runtime-code closure, so neither can be mistaken for a package identity.
export const computeDeclaredRuntimeClosure = computeDeclaredRuntimeIntegrity;

export async function captureRuntimeIntegrity(skillRoot) {
  return computeDeclaredRuntimeIntegrity(skillRoot);
}

export async function assertRuntimeIntegrityUnchanged(before, skillRoot) {
  if (!before || !SHA256.test(String(before.digest))) {
    throw new Error("A valid pre-run declared-runtime digest is required.");
  }
  const after = await computeDeclaredRuntimeIntegrity(skillRoot);
  if (after.digest !== before.digest) {
    const changed = [];
    const names = new Set([...Object.keys(before.files ?? {}), ...Object.keys(after.files ?? {})]);
    for (const name of [...names].sort()) {
      if ((before.files ?? {})[name] !== (after.files ?? {})[name]) changed.push(name);
    }
    throw new Error(`Immutable skill runtime changed during the run: ${changed.join(", ") || "closure digest changed"}`);
  }
  return after;
}

export const RUNTIME_ISOLATION_CONSTANTS = Object.freeze({
  identity_file: IDENTITY_FILE,
  lease_directory: LEASE_DIRECTORY,
  lease_file: LEASE_FILE,
  lease_takeover_directory: LEASE_TAKEOVER_DIRECTORY,
  identity_schema: RUN_IDENTITY_SCHEMA,
  lease_schema: RUN_LEASE_SCHEMA,
  legacy_lease_schema: LEGACY_RUN_LEASE_SCHEMA,
  default_lease_duration_ms: DEFAULT_LEASE_DURATION_MS,
  default_heartbeat_interval_ms: DEFAULT_HEARTBEAT_INTERVAL_MS,
  maximum_lease_duration_ms: MAX_LEASE_DURATION_MS,
});
