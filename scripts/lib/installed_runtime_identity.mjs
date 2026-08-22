import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { identitySha256 } from "./identity_vocabulary.mjs";
import { validateJsonSchema } from "./json_schema.mjs";
import {
  INSTALLED_CANDIDATE_PLACEMENT,
  PRODUCTION_ACTIVE_PLACEMENT,
  RELEASE_CHANNELS,
  ReleaseIdentityError,
  assertChannelAdmission,
} from "./release_identity.mjs";
import { completePackageInventoryIdentity } from "./release_package_attestation.mjs";
import { captureRuntimeIntegrity } from "./runtime_isolation.mjs";

export const INSTALLATION_RECEIPT_SCHEMA = "excel-inflow-installation-receipt/1.0";
export const ACTIVE_INSTALL_POINTER_SCHEMA = "excel-inflow-active-install-pointer/1.0";
export const PRODUCTION_PROMOTION_RECEIPT_SCHEMA =
  "excel-inflow-production-promotion-receipt/1.0";

export const INSTALLED_RUNTIME_FILES = Object.freeze({
  installation_receipt: "installation-receipt.json",
  package_archive: "package-archive.tar",
  active_pointer: "active-install-pointer.json",
  promotion_receipt: "production-promotion-receipt.json",
  certification_receipt: "certification-receipt.json",
  rollback_package: "rollback-package.tar",
});

const DEFAULT_SKILL_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const exec = promisify(execFile);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function selfHash(value, field) {
  const body = { ...value };
  delete body[field];
  return identitySha256(body);
}

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, frozen(child)]),
    ));
  }
  return value;
}

export class InstalledRuntimeIdentityError extends Error {
  constructor(code, findings) {
    const normalised = Array.isArray(findings) ? findings.map(String) : [String(findings)];
    super(`${code}: ${normalised.join("; ")}`);
    this.name = "InstalledRuntimeIdentityError";
    this.code = code;
    this.findings = Object.freeze(normalised);
  }
}

function refuse(code, ...findings) {
  throw new InstalledRuntimeIdentityError(code, findings.flat());
}

async function optionalLstat(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function requireDirectory(target, label) {
  const stat = await optionalLstat(target);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    refuse("INSTALL_STATE_ROOT_INVALID", `${label} must be one existing non-symlink directory: ${target}`);
  }
  return fs.realpath(target);
}

async function readRegularBytes(target, label, { optional = false } = {}) {
  const stat = await optionalLstat(target);
  if (!stat) {
    if (optional) return null;
    refuse("INSTALLED_IDENTITY_ARTIFACT_MISSING", `${label} is missing: ${target}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    refuse("INSTALLED_IDENTITY_ARTIFACT_UNSAFE", `${label} must be one regular non-symlink file: ${target}`);
  }
  return fs.readFile(target);
}

async function readJsonRecord(target, label, schema, { optional = false, hashField = null } = {}) {
  const bytes = await readRegularBytes(target, label, { optional });
  if (bytes === null) return null;
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    refuse("INSTALLED_IDENTITY_JSON_INVALID", `${label} is not valid JSON: ${error.message}`);
  }
  const findings = validateJsonSchema(value, schema);
  if (findings.length > 0) {
    refuse("INSTALLED_IDENTITY_SCHEMA_INVALID", `${label}: ${findings.join(" | ")}`);
  }
  if (hashField && value[hashField] !== selfHash(value, hashField)) {
    refuse("INSTALLED_IDENTITY_SELF_HASH_MISMATCH", `${label}.${hashField} does not bind its exact body`);
  }
  return frozen({ value, raw_sha256: sha256(bytes), path: target });
}

async function readSchema(skillRoot, name) {
  const target = path.join(skillRoot, "assets", name);
  const bytes = await readRegularBytes(target, `${name} schema`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    refuse("INSTALLED_IDENTITY_SCHEMA_UNREADABLE", `${name}: ${error.message}`);
  }
}

async function gitValue(skillRoot, args) {
  try {
    return (await exec("git", ["-C", skillRoot, ...args], { timeout: 5_000 })).stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readJsonFile(target, label) {
  const bytes = await readRegularBytes(target, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    refuse("LOCAL_PACKAGE_IDENTITY_INVALID", `${label} is not valid JSON: ${error.message}`);
  }
}

async function sourceCheckout(skillRoot) {
  const marker = await optionalLstat(path.join(skillRoot, ".git"));
  if (!marker) return false;
  if (marker.isSymbolicLink() || (!marker.isFile() && !marker.isDirectory())) {
    refuse("LOCAL_PACKAGE_IDENTITY_INVALID", ".git marker is not a regular file or directory");
  }
  return true;
}

async function localPackageIdentity(skillRoot, { inventoryRequired = false } = {}) {
  const root = await requireDirectory(skillRoot, "skillRoot");
  const checkout = await sourceCheckout(root);
  const runtimeManifest = await readJsonFile(
    path.join(root, "assets", "runtime-manifest.json"),
    "runtime manifest",
  );
  const integrity = await captureRuntimeIntegrity(root);
  const runtimeClosureSha256 = integrity.runtime_code_closure.sha256;

  if (checkout) {
    const declaredMode = runtimeManifest.package_mode ??
      (runtimeManifest.status === "v2_development" ? "development" : null);
    if (declaredMode !== "development") {
      refuse(
        "DEVELOPMENT_SOURCE_IDENTITY_INVALID",
        `source checkout must declare development package mode; got ${JSON.stringify(declaredMode)}`,
      );
    }
    const [commit, tree] = await Promise.all([
      gitValue(root, ["rev-parse", "HEAD"]),
      gitValue(root, ["rev-parse", "HEAD^{tree}"]),
    ]);
    return frozen({
      skill_root: root,
      source_checkout: true,
      package_mode: "development",
      source_commit: GIT_SHA.test(String(commit ?? "")) ? commit : null,
      source_tree: GIT_SHA.test(String(tree ?? "")) ? tree : null,
      runtime_closure_sha256: runtimeClosureSha256,
      certified_runtime_closure_sha256: null,
      package_inventory_sha256: inventoryRequired
        ? (await completePackageInventoryIdentity(root)).sha256
        : null,
    });
  }

  const manifest = await readJsonFile(path.join(root, "release-manifest.json"), "release manifest");
  const identity = manifest?.identity;
  const packageMode = identity?.package?.mode;
  const declaredClosure = identity?.package?.runtime_code_closure?.sha256;
  const certifiedClosure = identity?.package?.runtime_code_closure?.certified_sha256 ?? null;
  const sourceCommit = identity?.source?.commit_sha;
  const sourceTree = identity?.source?.tree_sha;
  if (
    manifest?.schemaVersion !== 2 || manifest?.packageMode !== packageMode ||
    !["development", "certified", "portable_certified"].includes(packageMode) ||
    !GIT_SHA.test(String(sourceCommit ?? "")) || !GIT_SHA.test(String(sourceTree ?? "")) ||
    !SHA256.test(String(declaredClosure ?? "")) || declaredClosure !== runtimeClosureSha256
  ) {
    refuse("COMPILED_PACKAGE_IDENTITY_INVALID", "release manifest does not bind the exact live source and runtime closure");
  }
  if (packageMode === "certified" && certifiedClosure !== runtimeClosureSha256) {
    refuse("CERTIFIED_PACKAGE_CLOSURE_MISMATCH", "certified closure does not equal the live runtime closure");
  }
  if (packageMode !== "certified" && certifiedClosure !== null && certifiedClosure !== runtimeClosureSha256) {
    refuse("COMPILED_PACKAGE_IDENTITY_INVALID", "declared certified closure is inconsistent");
  }
  return frozen({
    skill_root: root,
    source_checkout: false,
    package_mode: packageMode,
    source_commit: sourceCommit,
    source_tree: sourceTree,
    runtime_closure_sha256: runtimeClosureSha256,
    certified_runtime_closure_sha256: certifiedClosure,
    package_inventory_sha256: (await completePackageInventoryIdentity(root)).sha256,
  });
}

function validTimestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > Date.now() + 300_000) {
    refuse("INSTALLED_IDENTITY_TIMESTAMP_INVALID", `${label} is invalid or materially in the future`);
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 * MP2 Phase A (A4) — the installer ingress channel gate. The package's
 * release channel is a DERIVED field of its runtime manifest
 * (`assets/runtime-manifest.json#/release_channel`, stamped by
 * `compile_skill_release.mjs --write-release-identity` from
 * `assets/release-identity.json#/channel`), so an operator cannot claim a
 * channel the bytes do not declare. Before a placement is resolved, the
 * declared channel must be admitted for that placement:
 *   - any channel may sit in an INACTIVE CANDIDATE slot;
 *   - only stable/candidate may take the PRODUCTION-ACTIVE placement — a
 *     dev-channel build is refused with the typed code
 *     RELEASE_CHANNEL_REFUSAL_DEV_BUILD_AS_STABLE;
 *   - production-active additionally requires the field to EXIST (a package
 *     that predates channel stamping cannot prove what line it belongs to).
 * ------------------------------------------------------------------ */

async function declaredPackageChannel(skillRoot) {
  try {
    const bytes = await fs.readFile(path.join(skillRoot, "assets", "runtime-manifest.json"));
    const manifest = JSON.parse(bytes.toString("utf8"));
    return typeof manifest?.release_channel === "string" && manifest.release_channel.trim() !== ""
      ? manifest.release_channel
      : null;
  } catch {
    return null;
  }
}

function admitChannelOrRefuse(channel, target_placement) {
  if (target_placement === INSTALLED_CANDIDATE_PLACEMENT && channel === null) {
    // A package that predates channel stamping may still occupy an inactive
    // candidate slot. It can never reach the production placement below,
    // which requires a declared channel.
    return;
  }
  if (target_placement === PRODUCTION_ACTIVE_PLACEMENT && channel === null) {
    refuse(
      "RELEASE_CHANNEL_UNKNOWN",
      "the packaged runtime manifest declares no release_channel; the production-active placement requires one",
      `(stamped by scripts/compile_skill_release.mjs --write-release-identity from assets/release-identity.json#/channel; known channels: ${RELEASE_CHANNELS.join(", ")}).`,
    );
  }
  try {
    assertChannelAdmission({ channel, target_placement });
  } catch (error) {
    // Re-typed as this module's own error class so existing handlers keep
    // working, while preserving the typed code and findings verbatim.
    if (error instanceof ReleaseIdentityError) refuse(error.code, error.findings);
    throw error;
  }
}

function equalityFindings(pairs) {
  return pairs
    .filter(([, left, right]) => left !== right)
    .map(([label, left, right]) => `${label} mismatch (${JSON.stringify(left)} != ${JSON.stringify(right)})`);
}

function installationMatchesPackage(installation, local, archiveSha256) {
  return equalityFindings([
    ["source commit", installation.package.source_commit, local.source_commit],
    ["source tree", installation.package.source_tree, local.source_tree],
    ["package mode", installation.package.package_mode, local.package_mode],
    ["package inventory", installation.package.package_inventory_sha256, local.package_inventory_sha256],
    ["archive", installation.package.archive_sha256, archiveSha256],
    ["runtime closure", installation.package.runtime_closure_sha256, local.runtime_closure_sha256],
    [
      "certified runtime closure",
      installation.package.certified_runtime_closure_sha256,
      local.certified_runtime_closure_sha256,
    ],
    [
      "installed package",
      installation.package.installed_package_sha256,
      local.package_inventory_sha256,
    ],
  ]);
}

function productionJoins({ installationRecord, pointerRecord, promotionRecord, local }) {
  const installation = installationRecord.value;
  const pointer = pointerRecord.value;
  const promotion = promotionRecord.value;
  return equalityFindings([
    ["pointer slot", pointer.slot_id, installation.slot_id],
    ["promotion slot", promotion.slot_id, installation.slot_id],
    ["pointer installation", pointer.installation_identity, installation.installation_identity],
    ["promotion installation", promotion.installation_identity, installation.installation_identity],
    ["promotion installation generation", promotion.installation_generation, installation.installation_generation],
    ["pointer activation generation", pointer.generation, promotion.activation_generation],
    ["pointer installation receipt", pointer.installation_receipt_sha256, installationRecord.raw_sha256],
    ["promotion installation receipt", promotion.installation_receipt_sha256, installationRecord.raw_sha256],
    ["pointer package inventory", pointer.package_inventory_sha256, local.package_inventory_sha256],
    ["promotion package inventory", promotion.package_inventory_sha256, local.package_inventory_sha256],
    ["pointer archive", pointer.archive_sha256, installation.package.archive_sha256],
    ["promotion archive", promotion.archive_sha256, installation.package.archive_sha256],
    ["pointer runtime closure", pointer.runtime_closure_sha256, local.runtime_closure_sha256],
    ["promotion runtime closure", promotion.runtime_closure_sha256, local.runtime_closure_sha256],
    ["promotion certified closure", promotion.certified_runtime_closure_sha256, local.certified_runtime_closure_sha256],
    ["pointer previous slot", pointer.previous_slot_id, promotion.previous_slot_id],
    ["pointer rollback package", pointer.rollback_package_sha256, promotion.rollback_package_sha256],
    ["pointer promotion receipt", pointer.promotion_receipt_sha256, promotionRecord.raw_sha256],
    ["activation timestamp", pointer.activated_at, promotion.promoted_at],
  ]);
}

function sourceIdentityOverrides(local, installation, placement) {
  const deploymentStatus = placement === "development_source"
    ? "not_installed"
    : placement === "installed_candidate"
      ? "installed_candidate"
      : "production_promoted";
  const overrides = {
    package_mode: local.package_mode,
    deployment_status: deploymentStatus,
    installation_identity: installation?.installation_identity ?? null,
    installed_package_sha256: installation?.package?.installed_package_sha256 ?? null,
    complete_package_inventory_sha256: local.package_inventory_sha256,
    archive_sha256: installation?.package?.archive_sha256 ?? null,
    runtime_code_closure_sha256: local.runtime_closure_sha256,
    certified_runtime_code_closure_sha256: local.certified_runtime_closure_sha256,
  };
  if (local.source_commit) overrides.source_commit = local.source_commit;
  if (local.source_tree) overrides.source_tree = local.source_tree;
  return overrides;
}

function resolvedPlacement({
  placement,
  local,
  installation = null,
  pointer = null,
  promotion = null,
  evidenceHashes,
  extra = {},
}) {
  return frozen({
    placement,
    local_package: local,
    installation,
    active_pointer: pointer,
    production_promotion: promotion,
    source_identity_overrides: sourceIdentityOverrides(local, installation, placement),
    disk_space_policy_mode: placement === "development_source" ? "development" : "candidate",
    evidence_hashes: evidenceHashes,
    ...extra,
  });
}

/**
 * Resolve the package's placement from package-owned bytes plus one install-state
 * root locator. Callers cannot provide a deployment status, installation
 * identity, mode, pointer or receipt; those values exist only in verified files.
 */
export async function resolveInstalledRuntimeIdentity({
  skillRoot = DEFAULT_SKILL_ROOT,
  installStateRoot = null,
} = {}) {
  if (arguments[0] && Object.keys(arguments[0]).some(
    (key) => !["skillRoot", "installStateRoot"].includes(key),
  )) {
    refuse("UNTRUSTED_RUNTIME_IDENTITY_INPUT", "only skillRoot and installStateRoot locators are accepted");
  }

  const initialLocal = await localPackageIdentity(skillRoot);
  const declaredChannel = await declaredPackageChannel(initialLocal.skill_root);
  if (installStateRoot === null || installStateRoot === undefined) {
    if (!initialLocal.source_checkout || initialLocal.package_mode !== "development") {
      refuse("INSTALLED_STATE_REQUIRED", "a compiled package requires a verified install-state root");
    }
    return resolvedPlacement({
      placement: "development_source",
      local: initialLocal,
      evidenceHashes: {
        installation_receipt_sha256: null,
        active_pointer_sha256: null,
        production_promotion_receipt_sha256: null,
      },
    });
  }

  const stateRoot = await requireDirectory(path.resolve(String(installStateRoot)), "installStateRoot");
  const relativeState = path.relative(initialLocal.skill_root, stateRoot);
  if (
    relativeState === "" ||
    (!relativeState.startsWith(`..${path.sep}`) && relativeState !== ".." && !path.isAbsolute(relativeState))
  ) {
    refuse(
      "INSTALL_STATE_ROOT_INSIDE_SKILL",
      "installStateRoot must canonically resolve outside the immutable skill root",
    );
  }
  const [installationSchema, pointerSchema, promotionSchema] = await Promise.all([
    readSchema(initialLocal.skill_root, "installation-receipt-v1.schema.json"),
    readSchema(initialLocal.skill_root, "active-install-pointer-v1.schema.json"),
    readSchema(initialLocal.skill_root, "production-promotion-receipt-v1.schema.json"),
  ]);
  const installationRecord = await readJsonRecord(
    path.join(stateRoot, INSTALLED_RUNTIME_FILES.installation_receipt),
    "installation receipt",
    installationSchema,
    { optional: true, hashField: "receipt_sha256" },
  );
  if (!installationRecord) {
    if (!initialLocal.source_checkout || initialLocal.package_mode !== "development") {
      refuse("INSTALLATION_RECEIPT_MISSING", "compiled package has no installation receipt");
    }
    return resolvedPlacement({
      placement: "development_source",
      local: initialLocal,
      evidenceHashes: {
        installation_receipt_sha256: null,
        active_pointer_sha256: null,
        production_promotion_receipt_sha256: null,
      },
    });
  }

  const local = initialLocal.package_inventory_sha256
    ? initialLocal
    : await localPackageIdentity(skillRoot, { inventoryRequired: true });
  const archiveBytes = await readRegularBytes(
    path.join(stateRoot, INSTALLED_RUNTIME_FILES.package_archive),
    "installed package archive",
  );
  const archiveSha256 = sha256(archiveBytes);
  const installationFindings = installationMatchesPackage(
    installationRecord.value,
    local,
    archiveSha256,
  );
  validTimestamp(installationRecord.value.installed_at, "installation receipt installed_at");

  if (installationFindings.length > 0) {
    if (local.source_checkout && local.package_mode === "development") {
      return resolvedPlacement({
        placement: "development_source",
        local,
        evidenceHashes: {
          installation_receipt_sha256: null,
          active_pointer_sha256: null,
          production_promotion_receipt_sha256: null,
        },
        extra: {
          ignored_nonmatching_installation_receipt_sha256: installationRecord.raw_sha256,
        },
      });
    }
    refuse("INSTALLATION_PACKAGE_MISMATCH", installationFindings);
  }
  if (local.source_checkout) {
    refuse("SOURCE_CHECKOUT_CANNOT_BE_INSTALLED", "a development source checkout has a matching installation receipt");
  }

  const pointerRecord = await readJsonRecord(
    path.join(stateRoot, INSTALLED_RUNTIME_FILES.active_pointer),
    "active install pointer",
    pointerSchema,
    { optional: true, hashField: "pointer_sha256" },
  );
  if (!pointerRecord) {
    refuse(
      "ACTIVE_POINTER_MISSING",
      "installed placement requires a read-back active pointer; absence cannot prove an inactive candidate slot",
    );
  }
  validTimestamp(pointerRecord.value.activated_at, "active pointer activated_at");
  if (pointerRecord.value.slot_id !== installationRecord.value.slot_id) {
    const stalePromotion = await readRegularBytes(
      path.join(stateRoot, INSTALLED_RUNTIME_FILES.promotion_receipt),
      "production promotion receipt",
      { optional: true },
    );
    if (stalePromotion !== null) {
      refuse(
        "STALE_OR_WRONG_ACTIVE_POINTER",
        "a production promotion receipt exists for this installed package but the active pointer does not select its slot",
      );
    }
    // MP2 Phase A (A4) — channel admission for the inactive candidate
    // placement: any declared channel is admitted, an unknown token is refused.
    admitChannelOrRefuse(declaredChannel, INSTALLED_CANDIDATE_PLACEMENT);
    return resolvedPlacement({
      placement: "installed_candidate",
      local,
      installation: installationRecord.value,
      pointer: pointerRecord.value,
      evidenceHashes: {
        installation_receipt_sha256: installationRecord.raw_sha256,
        active_pointer_sha256: pointerRecord.raw_sha256,
        production_promotion_receipt_sha256: null,
      },
    });
  }
  const promotionRecord = await readJsonRecord(
    path.join(stateRoot, INSTALLED_RUNTIME_FILES.promotion_receipt),
    "production promotion receipt",
    promotionSchema,
    { hashField: "receipt_sha256" },
  );
  const joins = productionJoins({ installationRecord, pointerRecord, promotionRecord, local });
  if (local.package_mode !== "certified") joins.push("production-active package mode is not certified");
  if (local.runtime_closure_sha256 !== local.certified_runtime_closure_sha256) {
    joins.push("live runtime closure does not equal certified closure");
  }
  const installedAt = validTimestamp(installationRecord.value.installed_at, "installation installed_at");
  const promotedAt = validTimestamp(promotionRecord.value.promoted_at, "promotion promoted_at");
  const activatedAt = validTimestamp(pointerRecord.value.activated_at, "pointer activated_at");
  if (promotedAt < installedAt || activatedAt < installedAt) joins.push("promotion predates installation");

  const [certificationBytes, rollbackBytes] = await Promise.all([
    readRegularBytes(
      path.join(stateRoot, INSTALLED_RUNTIME_FILES.certification_receipt),
      "certification receipt",
    ),
    readRegularBytes(
      path.join(stateRoot, INSTALLED_RUNTIME_FILES.rollback_package),
      "rollback package",
    ),
  ]);
  if (sha256(certificationBytes) !== promotionRecord.value.certification_receipt_sha256) {
    joins.push("certification receipt SHA mismatch");
  }
  let certification;
  try {
    certification = JSON.parse(certificationBytes.toString("utf8"));
  } catch {
    joins.push("certification receipt is not JSON");
  }
  if (certification?.status !== "PASS") joins.push("certification receipt status is not PASS");
  if (
    certification?.runtime_code_closure_sha256 !== undefined &&
    certification.runtime_code_closure_sha256 !== local.runtime_closure_sha256
  ) joins.push("certification receipt runtime closure mismatch");
  if (sha256(rollbackBytes) !== pointerRecord.value.rollback_package_sha256) {
    joins.push("rollback package SHA mismatch");
  }
  if (joins.length > 0) refuse("PRODUCTION_ACTIVE_IDENTITY_MISMATCH", joins);

  // MP2 Phase A (A4) — the ingress refusal: a dev-channel build can never be
  // installed/promoted as the stable production placement, no matter how
  // well-joined its receipts are.
  admitChannelOrRefuse(declaredChannel, PRODUCTION_ACTIVE_PLACEMENT);

  return resolvedPlacement({
    placement: "production_active",
    local,
    installation: installationRecord.value,
    pointer: pointerRecord.value,
    promotion: promotionRecord.value,
    evidenceHashes: {
      installation_receipt_sha256: installationRecord.raw_sha256,
      active_pointer_sha256: pointerRecord.raw_sha256,
      production_promotion_receipt_sha256: promotionRecord.raw_sha256,
    },
  });
}

export default { resolveInstalledRuntimeIdentity };
