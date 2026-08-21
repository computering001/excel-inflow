import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CONTROLLER_HANDOFF_PATH_ENV = "EXCEL_INFLOW_CONTROLLER_HANDOFF_PATH";
export const CONTROLLER_HANDOFF_SECRET_ENV = "EXCEL_INFLOW_CONTROLLER_HANDOFF_SECRET";
export const CONTROLLER_HANDOFF_SCHEMA = "excel-inflow-controller-handoff/1.0";
const MAX_TTL_MS = 180_000;
const DEFAULT_TTL_MS = 120_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hmac(secret, body) {
  return createHmac("sha256", secret).update(canonicalJson(body)).digest("hex");
}

function equalHex(left, right) {
  if (!/^[a-f0-9]{64}$/.test(String(left)) || !/^[a-f0-9]{64}$/.test(String(right))) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

async function fileIdentity(target) {
  const canonical = await fs.realpath(path.resolve(target));
  const stat = await fs.lstat(canonical);
  if (!stat.isFile()) throw new ControllerHandoffError("controller_not_regular_file");
  return { path: canonical, sha256: sha256(await fs.readFile(canonical)) };
}

async function packageIdentity(packageRoot) {
  const canonical = await fs.realpath(path.resolve(packageRoot));
  const manifest = path.join(canonical, "release-manifest.json");
  const manifestSha256 = await fs.readFile(manifest).then(sha256).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  return { root: canonical, release_manifest_sha256: manifestSha256 };
}

export class ControllerHandoffError extends Error {
  constructor(reason, detail = null) {
    super(`Controller handoff refused: ${reason}.`);
    this.name = "ControllerHandoffError";
    this.code = "INTERNAL.controller_handoff_refused";
    this.handoff_reason = reason;
    this.handoff_detail = detail;
    this.controller_handoff_refusal = true;
  }
}

export async function createControllerHandoff({
  packageRoot,
  parentController,
  childController,
  childArgs,
  ttlMs = DEFAULT_TTL_MS,
  nowEpochMs = Date.now(),
  handoffBase = os.tmpdir(),
}) {
  if (!Array.isArray(childArgs) || !childArgs.every((value) => typeof value === "string")) {
    throw new ControllerHandoffError("invalid_child_arguments");
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new ControllerHandoffError("invalid_ttl");
  }
  const [packageBinding, parentBinding, childBinding] = await Promise.all([
    packageIdentity(packageRoot),
    fileIdentity(parentController),
    fileIdentity(childController),
  ]);
  const secret = randomBytes(32).toString("hex");
  const issuedAt = Number(nowEpochMs);
  const body = {
    schema_version: CONTROLLER_HANDOFF_SCHEMA,
    handoff_id: randomUUID(),
    nonce: randomBytes(32).toString("hex"),
    issued_at_epoch_ms: issuedAt,
    expires_at_epoch_ms: issuedAt + ttlMs,
    one_use: true,
    package: packageBinding,
    parent_controller: parentBinding,
    child_controller: childBinding,
    child_argv_sha256: sha256(Buffer.from(canonicalJson(childArgs), "utf8")),
  };
  const payload = { ...body, hmac_sha256: hmac(secret, body) };
  const directory = await fs.mkdtemp(path.join(path.resolve(handoffBase), "excel-inflow-controller-handoff-"));
  await fs.chmod(directory, 0o700).catch(() => {});
  const handoffPath = path.join(directory, `${body.handoff_id}.json`);
  await fs.writeFile(handoffPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return {
    path: handoffPath,
    secret,
    body,
    env: {
      [CONTROLLER_HANDOFF_PATH_ENV]: handoffPath,
      [CONTROLLER_HANDOFF_SECRET_ENV]: secret,
    },
    cleanup: async () => {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export async function consumeControllerHandoff({
  packageRoot,
  parentController,
  childController,
  childArgs,
  env = process.env,
  nowEpochMs = Date.now(),
}) {
  const handoffPath = env[CONTROLLER_HANDOFF_PATH_ENV];
  const secret = env[CONTROLLER_HANDOFF_SECRET_ENV];
  delete env[CONTROLLER_HANDOFF_PATH_ENV];
  delete env[CONTROLLER_HANDOFF_SECRET_ENV];
  if (typeof handoffPath !== "string" || handoffPath.length === 0 || !/^[a-f0-9]{64}$/.test(String(secret ?? ""))) {
    throw new ControllerHandoffError("missing_credentials");
  }
  const claimedPath = `${path.resolve(handoffPath)}.claimed-${process.pid}-${randomUUID()}`;
  try {
    await fs.rename(path.resolve(handoffPath), claimedPath);
  } catch (error) {
    throw new ControllerHandoffError(error?.code === "ENOENT" ? "missing_or_replayed" : "claim_failed", error?.code ?? null);
  }
  try {
    const payload = await fs.readFile(claimedPath, "utf8").then(JSON.parse).catch(() => {
      throw new ControllerHandoffError("invalid_payload");
    });
    const { hmac_sha256: statedHmac, ...body } = payload ?? {};
    if (body.schema_version !== CONTROLLER_HANDOFF_SCHEMA || body.one_use !== true) {
      throw new ControllerHandoffError("invalid_contract");
    }
    if (!equalHex(statedHmac, hmac(secret, body))) throw new ControllerHandoffError("authentication_failed");
    const now = Number(nowEpochMs);
    if (
      !Number.isFinite(now) || !Number.isInteger(body.issued_at_epoch_ms) ||
      !Number.isInteger(body.expires_at_epoch_ms) || body.expires_at_epoch_ms <= body.issued_at_epoch_ms ||
      body.expires_at_epoch_ms - body.issued_at_epoch_ms > MAX_TTL_MS ||
      now < body.issued_at_epoch_ms - 5_000 || now > body.expires_at_epoch_ms
    ) throw new ControllerHandoffError("stale_or_invalid_time");
    if (!Array.isArray(childArgs) || !childArgs.every((value) => typeof value === "string")) {
      throw new ControllerHandoffError("invalid_child_arguments");
    }
    const [expectedPackage, expectedParent, expectedChild] = await Promise.all([
      packageIdentity(packageRoot),
      fileIdentity(parentController),
      fileIdentity(childController),
    ]);
    if (canonicalJson(body.package) !== canonicalJson(expectedPackage)) {
      throw new ControllerHandoffError("wrong_package");
    }
    if (canonicalJson(body.parent_controller) !== canonicalJson(expectedParent)) {
      throw new ControllerHandoffError("wrong_parent_controller");
    }
    if (canonicalJson(body.child_controller) !== canonicalJson(expectedChild)) {
      throw new ControllerHandoffError("wrong_child_controller");
    }
    const argvSha256 = sha256(Buffer.from(canonicalJson(childArgs), "utf8"));
    if (body.child_argv_sha256 !== argvSha256) throw new ControllerHandoffError("wrong_child_arguments");
    return Object.freeze({ ...body });
  } finally {
    await fs.rm(claimedPath, { force: true }).catch(() => {});
    await fs.rmdir(path.dirname(claimedPath)).catch(() => {});
  }
}
