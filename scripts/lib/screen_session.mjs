import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonBytes,
  publishDurableImmutableJson,
} from "./durable_artifact_generation.mjs";
import { validateJsonSchema } from "./json_schema.mjs";
import {
  assertRunRootOutsideSkill,
  canonicalPathThroughExistingAncestor,
} from "./runtime_isolation.mjs";

export const SCREEN_SESSION_SCHEMA_VERSION = "excel-inflow-screen-session/1.0";
export const SCREEN_SESSION_EXPECTED_NEXT_STAGE = "company_resolution";
export const SCREEN_SESSION_RUNTIME_MODES = Object.freeze([
  "DEVELOPMENT_SOURCE",
  "INSTALLED_CANDIDATE",
  "PRODUCTION_ACTIVE",
]);
export const DEFAULT_SCREEN_SESSION_TTL_MS = 10 * 60 * 1000;
export const MAX_SCREEN_SESSION_TTL_MS = 60 * 60 * 1000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_ROOT = path.resolve(HERE, "../..");
const SCHEMA = JSON.parse(
  await fs.readFile(
    path.join(DEFAULT_SKILL_ROOT, "assets", "screen-session-receipt-v1.schema.json"),
    "utf8",
  ),
);
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RECEIPT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}\.json$/;

function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalise(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(secret, value) {
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("hex");
}

function equalHex(left, right) {
  if (!SHA256.test(String(left)) || !SHA256.test(String(right))) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function without(receipt, keys) {
  return Object.fromEntries(
    Object.entries(receipt).filter(([key]) => !keys.includes(key)),
  );
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ScreenSessionError("INVALID_ARGUMENT", `${label} must be a non-empty string.`);
  }
  return value;
}

function requiredSha(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!SHA256.test(String(value ?? ""))) {
    throw new ScreenSessionError("INVALID_ARGUMENT", `${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requiredGitSha(value, label) {
  if (!GIT_SHA.test(String(value ?? ""))) {
    throw new ScreenSessionError("INVALID_ARGUMENT", `${label} must be a lowercase 40-character Git digest.`);
  }
  return value;
}

function assertSessionSecret(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new ScreenSessionError(
      "INVALID_SESSION_SECRET",
      "Session secret must contain at least 32 UTF-8 bytes.",
    );
  }
  return secret;
}

function assertSessionId(sessionId) {
  if (!SAFE_SESSION_ID.test(String(sessionId ?? ""))) {
    throw new ScreenSessionError(
      "INVALID_SESSION_ID",
      "Session ID must be one safe explicit 1-128 character identifier.",
    );
  }
  return sessionId;
}

function assertRuntimeMode(mode) {
  if (!SCREEN_SESSION_RUNTIME_MODES.includes(mode)) {
    throw new ScreenSessionError(
      "INVALID_RUNTIME_MODE",
      `Runtime mode must be one of ${SCREEN_SESSION_RUNTIME_MODES.join(", ")}.`,
    );
  }
  return mode;
}

function assertModeIdentity({
  runtimeMode,
  packageInventorySha256,
  installationIdentity,
  activePointerSha256,
}) {
  if (runtimeMode === "DEVELOPMENT_SOURCE") {
    if (
      packageInventorySha256 !== null || installationIdentity !== null ||
      activePointerSha256 !== null
    ) {
      throw new ScreenSessionError(
        "MODE_IDENTITY_MISMATCH",
        "Development source must not claim installed-package, installation or active-pointer identity.",
      );
    }
    return;
  }
  requiredSha(packageInventorySha256, "Package inventory identity");
  requiredText(installationIdentity, "Installation identity");
  requiredSha(activePointerSha256, "Active-pointer identity");
}

function parseTime(value, label) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new ScreenSessionError("INVALID_TIME", `${label} must be one canonical UTC timestamp.`);
  }
  return parsed;
}

export class ScreenSessionError extends Error {
  constructor(reason, message, detail = null) {
    super(message);
    this.name = "ScreenSessionError";
    this.code = `SCREEN_SESSION.${reason}`;
    this.reason = reason;
    this.detail = detail;
  }
}

export function screenSessionReceiptDigest(receipt) {
  return sha256(canonicalJson(without(receipt, ["receipt_sha256"])));
}

function screenSessionBindingBody(receipt) {
  return without(receipt, ["session_binding_hmac_sha256", "receipt_sha256"]);
}

async function assertExternalSessionRoot({ skillRoot, sessionRoot }) {
  requiredText(sessionRoot, "Screen-session root");
  const before = await assertRunRootOutsideSkill({
    skillRoot: path.resolve(skillRoot ?? DEFAULT_SKILL_ROOT),
    runRoot: path.resolve(sessionRoot),
  });
  await fs.mkdir(before.run_root, { recursive: true });
  const metadata = await fs.lstat(before.run_root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ScreenSessionError(
      "UNSAFE_SESSION_ROOT",
      "Screen-session root must be one real directory, not a file or symbolic link.",
    );
  }
  const after = await assertRunRootOutsideSkill({
    skillRoot: path.resolve(skillRoot ?? DEFAULT_SKILL_ROOT),
    runRoot: await fs.realpath(before.run_root),
  });
  return after.run_root;
}

async function resolveReceiptTarget({ root, receiptPath }) {
  requiredText(receiptPath, "Screen-session receipt path");
  const absolute = await canonicalPathThroughExistingAncestor(path.resolve(receiptPath));
  const basename = path.basename(absolute);
  if (
    path.dirname(absolute) !== root || !SAFE_RECEIPT_FILE.test(basename) ||
    basename.endsWith(".consumed.json")
  ) {
    throw new ScreenSessionError(
      "RECEIPT_OUTSIDE_STORE",
      "Receipt must be supplied explicitly and be a direct immutable member of this session root.",
    );
  }
  return absolute;
}

async function assertReceiptInStore({ root, receiptPath }) {
  const absolute = await resolveReceiptTarget({ root, receiptPath });
  const metadata = await fs.lstat(absolute).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new ScreenSessionError("RECEIPT_NOT_FOUND", "Screen-session receipt does not exist.");
    }
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ScreenSessionError(
      "UNSAFE_RECEIPT_PATH",
      "Screen-session receipt must be one regular non-symlink file.",
    );
  }
  const canonical = await fs.realpath(absolute);
  if (path.dirname(canonical) !== root) {
    throw new ScreenSessionError("RECEIPT_OUTSIDE_STORE", "Receipt resolves outside the session root.");
  }
  return canonical;
}

function validateReceipt(receipt, {
  nowEpochMs,
  sessionId,
  sessionSecret,
  expected,
  sessionRootSha256,
  receiptPathSha256,
}) {
  const structural = validateJsonSchema(receipt, SCHEMA);
  if (structural.length > 0) {
    throw new ScreenSessionError(
      "SCHEMA_INVALID",
      `Screen-session receipt violates its schema: ${structural[0]}`,
      structural,
    );
  }
  const created = parseTime(receipt.created_at, "created_at");
  const expires = parseTime(receipt.expires_at, "expires_at");
  if (expires <= created || expires - created > MAX_SCREEN_SESSION_TTL_MS) {
    throw new ScreenSessionError("INVALID_EXPIRY", "Screen-session expiry is not a bounded interval.");
  }
  if (!Number.isFinite(nowEpochMs) || nowEpochMs < created - 60_000) {
    throw new ScreenSessionError("INVALID_TIME", "Verification time is invalid or precedes receipt issuance.");
  }
  if (nowEpochMs >= expires) {
    throw new ScreenSessionError("EXPIRED", "Screen-session receipt has expired.");
  }
  if (screenSessionReceiptDigest(receipt) !== receipt.receipt_sha256) {
    throw new ScreenSessionError("SELF_HASH_MISMATCH", "Screen-session receipt self-hash does not match.");
  }
  if (!equalHex(receipt.session_root_sha256, sessionRootSha256)) {
    throw new ScreenSessionError("WRONG_SESSION_ROOT", "Screen-session receipt belongs to a different session root.");
  }
  if (!equalHex(receipt.receipt_path_sha256, receiptPathSha256)) {
    throw new ScreenSessionError("WRONG_RECEIPT_PATH", "Screen-session receipt belongs to a different exact path.");
  }
  if (receipt.session_id !== sessionId) {
    throw new ScreenSessionError("WRONG_SESSION_ID", "Screen-session receipt belongs to a different session ID.");
  }
  const secretSha256 = sha256(Buffer.from(sessionSecret, "utf8"));
  if (!equalHex(receipt.session_secret_sha256, secretSha256)) {
    throw new ScreenSessionError("WRONG_SESSION_SECRET", "Screen-session secret does not match.");
  }
  const expectedHmac = hmac(sessionSecret, screenSessionBindingBody(receipt));
  if (!equalHex(receipt.session_binding_hmac_sha256, expectedHmac)) {
    throw new ScreenSessionError("AUTHENTICATION_FAILED", "Screen-session HMAC does not match.");
  }
  if (receipt.expected_next_stage !== SCREEN_SESSION_EXPECTED_NEXT_STAGE) {
    throw new ScreenSessionError("WRONG_NEXT_STAGE", "Screen-session receipt does not authorize company resolution.");
  }
  const requiredExpected = [
    "runtime_mode",
    "source_commit",
    "source_tree",
    "runtime_closure_sha256",
    "package_inventory_sha256",
    "installation_identity",
    "active_pointer_sha256",
  ];
  if (!expected || requiredExpected.some((key) => !Object.hasOwn(expected, key))) {
    throw new ScreenSessionError(
      "EXPECTED_IDENTITY_INCOMPLETE",
      "Verification requires the complete current mode, package, installation and pointer identity.",
    );
  }
  const comparisons = {
    runtime_mode: "WRONG_RUNTIME_MODE",
    source_commit: "WRONG_SOURCE_COMMIT",
    source_tree: "WRONG_SOURCE_TREE",
    runtime_closure_sha256: "WRONG_RUNTIME_CLOSURE",
    package_inventory_sha256: "WRONG_PACKAGE",
    installation_identity: "WRONG_INSTALLATION",
    active_pointer_sha256: "WRONG_ACTIVE_POINTER",
    capability_receipt_sha256: "WRONG_CAPABILITY_RECEIPT",
    runtime_doctor_report_sha256: "WRONG_RUNTIME_DOCTOR_REPORT",
    screen_contract_sha256: "WRONG_SCREEN_CONTRACT",
    rendered_screen_sha256: "WRONG_RENDERED_SCREEN",
  };
  for (const [key, reason] of Object.entries(comparisons)) {
    if (Object.hasOwn(expected, key) && receipt[key] !== expected[key]) {
      throw new ScreenSessionError(reason, `Screen-session ${key} no longer matches current authority.`);
    }
  }
  assertModeIdentity({
    runtimeMode: receipt.runtime_mode,
    packageInventorySha256: receipt.package_inventory_sha256,
    installationIdentity: receipt.installation_identity,
    activePointerSha256: receipt.active_pointer_sha256,
  });
}

export async function issueScreenSession({
  skillRoot = DEFAULT_SKILL_ROOT,
  sessionRoot,
  receiptPath = null,
  sessionId,
  sessionSecret,
  runtimeMode,
  createdAt = new Date().toISOString(),
  ttlMs = DEFAULT_SCREEN_SESSION_TTL_MS,
  sourceCommit,
  sourceTree,
  runtimeClosureSha256,
  packageInventorySha256 = null,
  installationIdentity = null,
  activePointerSha256 = null,
  capabilityReceiptSha256,
  runtimeDoctorReportSha256,
  screenContractSha256,
  renderedScreenSha256 = null,
} = {}) {
  const root = await assertExternalSessionRoot({ skillRoot, sessionRoot });
  const explicitSessionId = assertSessionId(sessionId);
  const secret = assertSessionSecret(sessionSecret);
  const mode = assertRuntimeMode(runtimeMode);
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_SCREEN_SESSION_TTL_MS) {
    throw new ScreenSessionError("INVALID_EXPIRY", "Screen-session TTL is outside its bounded policy.");
  }
  const createdEpoch = parseTime(createdAt, "created_at");
  const expiresAt = new Date(createdEpoch + ttlMs).toISOString();
  assertModeIdentity({
    runtimeMode: mode,
    packageInventorySha256,
    installationIdentity,
    activePointerSha256,
  });
  const screenSessionId = randomUUID();
  const target = receiptPath === null
    ? path.join(root, `screen-session-${screenSessionId}.json`)
    : await resolveReceiptTarget({ root, receiptPath });
  const base = {
    schema_version: SCREEN_SESSION_SCHEMA_VERSION,
    screen_session_id: screenSessionId,
    screen_nonce: randomBytes(3).toString("hex").toUpperCase(),
    session_root_sha256: sha256(Buffer.from(root, "utf8")),
    receipt_path_sha256: sha256(Buffer.from(target, "utf8")),
    session_id: explicitSessionId,
    session_secret_sha256: sha256(Buffer.from(secret, "utf8")),
    runtime_mode: mode,
    created_at: createdAt,
    expires_at: expiresAt,
    expected_next_stage: SCREEN_SESSION_EXPECTED_NEXT_STAGE,
    source_commit: requiredGitSha(sourceCommit, "Source commit"),
    source_tree: requiredGitSha(sourceTree, "Source tree"),
    runtime_closure_sha256: requiredSha(runtimeClosureSha256, "Runtime closure"),
    package_inventory_sha256: requiredSha(
      packageInventorySha256,
      "Package inventory",
      { nullable: mode === "DEVELOPMENT_SOURCE" },
    ),
    installation_identity: installationIdentity,
    active_pointer_sha256: requiredSha(
      activePointerSha256,
      "Active pointer",
      { nullable: mode === "DEVELOPMENT_SOURCE" },
    ),
    capability_receipt_sha256: requiredSha(capabilityReceiptSha256, "Capability receipt"),
    runtime_doctor_report_sha256: requiredSha(runtimeDoctorReportSha256, "Runtime-doctor report"),
    screen_contract_sha256: requiredSha(screenContractSha256, "Screen contract"),
    rendered_screen_sha256: requiredSha(
      renderedScreenSha256,
      "Rendered screen",
      { nullable: true },
    ),
  };
  const authenticated = {
    ...base,
    session_binding_hmac_sha256: hmac(secret, base),
  };
  const receipt = Object.freeze({
    ...authenticated,
    receipt_sha256: screenSessionReceiptDigest(authenticated),
  });
  const structural = validateJsonSchema(receipt, SCHEMA);
  if (structural.length > 0) {
    throw new ScreenSessionError(
      "SCHEMA_INVALID",
      `Compiled screen-session receipt violates its schema: ${structural[0]}`,
      structural,
    );
  }
  const publication = await publishDurableImmutableJson({ target, value: receipt });
  if (!publication.created) {
    throw new ScreenSessionError("SESSION_ID_COLLISION", "Random screen-session identity already exists.");
  }
  return Object.freeze({ receipt, receiptPath: target, sessionRoot: root });
}

export async function verifyScreenSession({
  skillRoot = DEFAULT_SKILL_ROOT,
  sessionRoot,
  receiptPath,
  sessionId,
  sessionSecret,
  expected,
  now = new Date(),
} = {}) {
  const root = await assertExternalSessionRoot({ skillRoot, sessionRoot });
  const explicitSessionId = assertSessionId(sessionId);
  const secret = assertSessionSecret(sessionSecret);
  const target = await assertReceiptInStore({ root, receiptPath });
  const bytes = await fs.readFile(target);
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ScreenSessionError("INVALID_JSON", "Screen-session receipt is not valid JSON.");
  }
  if (!bytes.equals(canonicalJsonBytes(receipt))) {
    throw new ScreenSessionError("NON_CANONICAL_BYTES", "Screen-session receipt bytes are not canonical.");
  }
  const nowEpochMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  validateReceipt(receipt, {
    nowEpochMs,
    sessionId: explicitSessionId,
    sessionSecret: secret,
    expected,
    sessionRootSha256: sha256(Buffer.from(root, "utf8")),
    receiptPathSha256: sha256(Buffer.from(target, "utf8")),
  });
  return Object.freeze({ receipt: Object.freeze(receipt), receiptPath: target, sessionRoot: root });
}

export async function consumeScreenSession({
  consumerRunId,
  consumedAt = new Date().toISOString(),
  ...verification
} = {}) {
  if (!SAFE_RUN_ID.test(String(consumerRunId ?? ""))) {
    throw new ScreenSessionError("INVALID_CONSUMER_RUN", "Consumer run ID is not one safe explicit identifier.");
  }
  const verified = await verifyScreenSession(verification);
  parseTime(consumedAt, "consumed_at");
  const claim = {
    schema_version: "excel-inflow-screen-session-consumption/1.0",
    screen_session_id: verified.receipt.screen_session_id,
    receipt_sha256: verified.receipt.receipt_sha256,
    session_id: verified.receipt.session_id,
    consumer_run_id: consumerRunId,
    consumed_at: consumedAt,
  };
  const claimPath = path.join(
    verified.sessionRoot,
    `screen-session-${verified.receipt.screen_session_id}.consumed.json`,
  );
  try {
    const publication = await publishDurableImmutableJson({ target: claimPath, value: claim });
    if (!publication.created) {
      throw new ScreenSessionError("ALREADY_CONSUMED", "Screen-session receipt was already consumed.");
    }
  } catch (error) {
    if (error instanceof ScreenSessionError) throw error;
    if (
      error?.code === "DURABLE_ARTIFACT_IMMUTABLE_COLLISION" ||
      error?.code === "EEXIST"
    ) {
      throw new ScreenSessionError("ALREADY_CONSUMED", "Screen-session receipt was already consumed.");
    }
    throw error;
  }
  return Object.freeze({ ...verified, claim: Object.freeze(claim), claimPath });
}

export default {
  issueScreenSession,
  verifyScreenSession,
  consumeScreenSession,
  screenSessionReceiptDigest,
};
