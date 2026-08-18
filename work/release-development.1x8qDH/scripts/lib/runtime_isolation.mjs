import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RUN_IDENTITY_SCHEMA = "debt-runtime-identity/1.0";
const RUN_LEASE_SCHEMA = "debt-runtime-lease/1.0";
const IDENTITY_FILE = ".run-identity.json";
const LEASE_DIRECTORY = ".run-lease";
const LEASE_FILE = "lease.json";
const LEASE_INITIALISATION_GRACE_MS = 30_000;
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

async function readLease(leaseDirectory) {
  try {
    return JSON.parse(await fs.readFile(path.join(leaseDirectory, LEASE_FILE), "utf8"));
  } catch {
    return null;
  }
}

async function leaseIsLive(lease, leaseDirectory) {
  if (!lease || lease.schema_version !== RUN_LEASE_SCHEMA) {
    // mkdir is the atomic acquisition point; the owner writes lease.json
    // immediately afterwards. A competing invocation must not steal that
    // directory during this short installation window merely because the JSON
    // is not visible yet. Old unreadable directories remain recoverable.
    try {
      const stat = await fs.stat(leaseDirectory);
      return Date.now() - stat.mtimeMs < LEASE_INITIALISATION_GRACE_MS;
    } catch {
      return false;
    }
  }
  if (lease.hostname !== os.hostname()) return true;
  return processIsLive(lease.pid);
}

export async function acquireRunLease(runRoot, { owner = "debt-model-runtime" } = {}) {
  const canonicalRunRoot = await canonicalPathThroughExistingAncestor(runRoot);
  await fs.mkdir(canonicalRunRoot, { recursive: true });
  const leaseDirectory = path.join(canonicalRunRoot, LEASE_DIRECTORY);
  let recoveredStale = false;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.mkdir(leaseDirectory);
      const token = randomUUID();
      const lease = {
        schema_version: RUN_LEASE_SCHEMA,
        owner: requireNonEmptyString("Lease owner", owner),
        pid: process.pid,
        hostname: os.hostname(),
        token,
      };
      await atomicWriteJson(path.join(leaseDirectory, LEASE_FILE), lease);
      return Object.freeze({
        path: leaseDirectory,
        token,
        recovered_stale: recoveredStale,
        lease,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const existing = await readLease(leaseDirectory);
    if (await leaseIsLive(existing, leaseDirectory)) {
      throw new Error(
        `Run already has a live lease${existing ? ` (pid ${existing.pid} on ${existing.hostname})` : ""}.`,
      );
    }

    const stale = `${leaseDirectory}.stale.${process.pid}.${randomUUID()}`;
    try {
      await fs.rename(leaseDirectory, stale);
      recoveredStale = true;
      await fs.rm(stale, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("Could not acquire the run lease after repeated concurrent attempts.");
}

export async function releaseRunLease(runRoot, token) {
  const canonicalRunRoot = await canonicalPathThroughExistingAncestor(runRoot);
  const leaseDirectory = path.join(canonicalRunRoot, LEASE_DIRECTORY);
  const existing = await readLease(leaseDirectory);
  if (!existing) throw new Error("Run lease is absent or unreadable.");
  if (existing.token !== token) throw new Error("Run lease token does not match the current owner.");
  await fs.rm(leaseDirectory, { recursive: true, force: true });
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

export async function computeDeclaredRuntimeClosure(skillRoot) {
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
  for (const item of stringList(profile, "resource_directory_allowlist")) {
    const directory = await assertDeclaredPath(canonicalSkillRoot, path.join(canonicalSkillRoot, item));
    for (const file of await walkFiles(directory)) declared.add(file);
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
  return Object.freeze({
    schema_version: "declared-runtime-closure/1.0",
    skill_root: canonicalSkillRoot,
    file_count: Object.keys(ordered).length,
    files: ordered,
    digest: sha256Value(ordered),
  });
}

export async function captureRuntimeIntegrity(skillRoot) {
  return computeDeclaredRuntimeClosure(skillRoot);
}

export async function assertRuntimeIntegrityUnchanged(before, skillRoot) {
  if (!before || !SHA256.test(String(before.digest))) {
    throw new Error("A valid pre-run declared-runtime digest is required.");
  }
  const after = await computeDeclaredRuntimeClosure(skillRoot);
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
  identity_schema: RUN_IDENTITY_SCHEMA,
  lease_schema: RUN_LEASE_SCHEMA,
});
