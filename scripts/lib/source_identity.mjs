import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  PRODUCT_IDENTITY_SCHEMA,
  assertDeploymentStatus,
  assertIdentitySha256,
  assertPackageMode,
  productIdentity,
} from "./identity_vocabulary.mjs";
import { verifyReleasePackageAttestation } from "./release_package_attestation.mjs";
import { captureRuntimeIntegrity } from "./runtime_isolation.mjs";
const exec = promisify(execFile);

function assertPortableClosurePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty relative path.`);
  }
  if (value.includes("\\")) {
    throw new Error(`${label} must use forward slashes to stay portable: ${JSON.stringify(value)}.`);
  }
  if (value.startsWith("/")) {
    throw new Error(`${label} must be relative to the skill root: ${JSON.stringify(value)}.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain empty, "." or ".." segments: ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * THE single definition of runtime-code-closure membership.
 *
 * A runtime code closure is the executable and machine-contract subset of a
 * package: the shipped scripts and Python modules, the declared assets, the
 * declared resource files, and each vendored dependency's runtime bytes plus
 * its sibling package.json and licence. Instruction files (SKILL.md and
 * references/) can never be members. Both the release compiler
 * (scripts/compile_skill_release.mjs) and the runtime-isolation validator
 * (scripts/lib/runtime_isolation.mjs) consume this function; neither may carry
 * its own membership rule, so the packaged closure identity and the live
 * closure identity can only ever be computed the same way.
 *
 * Inputs are portable forward-slash paths: `scripts`/`pythonModules` relative
 * to scripts/, `assets` relative to assets/, `resources` relative to the skill
 * root. Returns a frozen array of { key, source } sorted by key, where `key`
 * is the closure-identity path and `source` is the skill-root-relative path of
 * the bytes (they differ only for vendored install paths).
 */
export function runtimeCodeClosureMembers({
  scripts = [],
  pythonModules = [],
  assets = [],
  resources = [],
  vendoredDependencies = [],
} = {}) {
  const members = new Map();
  const add = (keyValue, sourceValue) => {
    const key = assertPortableClosurePath(keyValue, "Runtime code closure member");
    const source = assertPortableClosurePath(
      sourceValue,
      `Runtime code closure member ${key} source`,
    );
    if (key === "SKILL.md" || key.startsWith("references/")) {
      throw new Error(`Runtime code closure must never contain instruction files: ${key}.`);
    }
    if (members.has(key)) {
      throw new Error(`Runtime code closure member is declared more than once: ${key}.`);
    }
    members.set(key, source);
  };
  for (const name of scripts) add(`scripts/${name}`, `scripts/${name}`);
  for (const name of pythonModules) add(`scripts/${name}`, `scripts/${name}`);
  for (const name of assets) add(`assets/${name}`, `assets/${name}`);
  for (const name of resources) add(name, name);
  for (const dependency of vendoredDependencies ?? []) {
    add(dependency?.install_path, dependency?.source);
    add(
      path.posix.join(path.posix.dirname(String(dependency?.install_path ?? "")), "package.json"),
      path.posix.join(path.posix.dirname(String(dependency?.source ?? "")), "package.json"),
    );
    add(dependency?.license_install_path, dependency?.license_source);
  }
  return Object.freeze(
    [...members.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, source]) => Object.freeze({ key, source })),
  );
}

/**
 * Prove the live runtime-code closure is the one the package identity claims.
 * A declared/pinned closure that does not match the active bytes fails closed;
 * a tree that declares no closure records "development_unpinned" honestly
 * instead of failing. The returned record belongs in the run summary.
 */
export function checkActiveRuntimeCodeClosure({
  declaredSha256 = null,
  declaredSource = null,
  activeSha256,
} = {}) {
  assertIdentitySha256(activeSha256, "Active runtime code closure identity");
  if (declaredSha256 === null || declaredSha256 === undefined) {
    return Object.freeze({
      status: "development_unpinned",
      declared_runtime_code_closure_sha256: null,
      declared_source: null,
      active_runtime_code_closure_sha256: activeSha256,
    });
  }
  assertIdentitySha256(declaredSha256, "Declared runtime code closure identity");
  if (declaredSha256 !== activeSha256) {
    throw new Error(
      [
        "Active runtime code closure does not match the declared package identity.",
        `  declared ${declaredSha256} (${declaredSource ?? "unknown source"})`,
        `  active   ${activeSha256}`,
        "  The live bytes are not the package they claim to be; refuse to run and re-verify the installation.",
      ].join("\n"),
    );
  }
  return Object.freeze({
    status: "match",
    declared_runtime_code_closure_sha256: declaredSha256,
    declared_source: declaredSource ?? null,
    active_runtime_code_closure_sha256: activeSha256,
  });
}

async function readJson(target) {
  try { return JSON.parse(await fs.readFile(target, "utf8")); } catch { return null; }
}
async function pathExists(target) {
  try { await fs.stat(target); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
async function gitValue(skillRoot, args) {
  try { return (await exec("git", ["-C", skillRoot, ...args], { timeout: 5000 })).stdout.trim() || null; }
  catch { return null; }
}
export async function resolveSourceIdentity({
  skillRoot,
  overrides = {},
  activeRuntimeCodeClosureSha256 = null,
} = {}) {
  const root = path.resolve(skillRoot ?? new URL("../../", import.meta.url).pathname);
  const releaseCandidate = await readJson(path.join(root, "release-manifest.json")) ?? {};
  const runtime = await readJson(path.join(root, "assets", "runtime-manifest.json")) ?? {};
  const deploymentProfile =
    await readJson(path.join(root, "assets", "deployment-profile.json")) ?? {};
  const gitTree = await gitValue(root, ["rev-parse", "HEAD^{tree}"]);
  const gitBranch = await gitValue(root, ["branch", "--show-current"]);
  const releaseCandidateIdentity = releaseCandidate.identity ?? {};
  const releaseCandidateIsTyped =
    releaseCandidateIdentity.schema_version === PRODUCT_IDENTITY_SCHEMA;
  const releaseCandidateMatchesRuntime =
    releaseCandidate.skillVersion === runtime.skill_version;
  const releaseCandidateMatchesSource =
    !gitTree ||
    gitBranch?.startsWith("packages/") ||
    releaseCandidateIdentity.source?.tree_sha === gitTree;
  // A package manifest is package-owned evidence, not mutable-source authority.
  // Source checkouts historically retained old package manifests at the root;
  // accepting one can silently replace the live version, commit and tree with
  // an older release. Trust only a typed, version-compatible manifest whose
  // source tree matches the checkout (or an explicit package-only branch).
  const release =
    releaseCandidateIsTyped &&
    releaseCandidateMatchesRuntime &&
    releaseCandidateMatchesSource
      ? releaseCandidate
      : {};
  const attestationPath = path.resolve(
    overrides.release_package_attestation_path ??
      process.env.EXCEL_INFLOW_RELEASE_PACKAGE_ATTESTATION ??
      `${root}.attestation.json`,
  );
  const externalAttestation = await readJson(attestationPath);
  let verifiedExternalAttestation = null;
  if (externalAttestation) {
    const archivePath = path.resolve(
      overrides.release_package_archive_path ??
        process.env.EXCEL_INFLOW_RELEASE_PACKAGE_ARCHIVE ??
        `${root}.tar`,
    );
    const verification = await verifyReleasePackageAttestation({
      packageRoot: root,
      attestation: externalAttestation,
      archivePath: (await pathExists(archivePath)) ? archivePath : null,
    });
    if (verification.status !== "PASS") {
      throw new Error(
        `External release-package attestation does not match installed package: ${verification.findings.join("; ")}`,
      );
    }
    verifiedExternalAttestation = externalAttestation;
  }
  const certification = release.certification ?? {};
  const releaseIdentity = release.identity ?? {};
  const attestedIdentity = verifiedExternalAttestation?.package?.product_identity ?? {};
  const commit =
    overrides.source_commit ??
    process.env.EXCEL_INFLOW_SOURCE_COMMIT ??
    attestedIdentity.source?.commit_sha ??
    releaseIdentity.source?.commit_sha ??
    runtime.source_commit ??
    await gitValue(root, ["rev-parse", "HEAD"]);
  const tree =
    overrides.source_tree ??
    process.env.EXCEL_INFLOW_SOURCE_TREE ??
    attestedIdentity.source?.tree_sha ??
    releaseIdentity.source?.tree_sha ??
    runtime.source_tree ??
    gitTree;
  const packageMode = assertPackageMode(
    overrides.package_mode ??
      attestedIdentity.package?.mode ??
      releaseIdentity.package?.mode ??
      release.packageMode ??
      runtime.package_mode ??
      (runtime.status === "v2_development"
        ? "development"
        : runtime.status === "local_production_certified"
          ? "certified"
          : null),
  );
  const deploymentStatus = assertDeploymentStatus(
    overrides.deployment_status ??
      process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS ??
      attestedIdentity.deployment?.status ??
      releaseIdentity.deployment?.status ??
      release.deploymentStatus ??
      "not_installed",
  );
  // Track WHERE the closure identity came from: a declared/pinned value is a
  // package's claim about itself and must later be proven against live bytes;
  // a computed_live value is the live bytes and needs no such proof.
  const declaredClosureCandidates = [
    ["override", overrides.runtime_code_closure_sha256],
    ["release_package_attestation", attestedIdentity.package?.runtime_code_closure?.sha256],
    ["release_manifest", releaseIdentity.package?.runtime_code_closure?.sha256],
    [
      "certification_receipt",
      certification.runtimeCodeClosureSha256 ?? certification.currentClosureSha256,
    ],
    [
      "runtime_manifest",
      runtime.runtime_code_closure_sha256 ?? runtime.current_closure_sha256,
    ],
  ];
  const declaredClosure =
    declaredClosureCandidates.find(([, value]) => value !== null && value !== undefined) ?? null;
  let runtimeCodeClosureSha256 = declaredClosure?.[1] ?? null;
  if (!runtimeCodeClosureSha256) {
    runtimeCodeClosureSha256 =
      activeRuntimeCodeClosureSha256 ??
      (await captureRuntimeIntegrity(root)).runtime_code_closure.sha256;
  }
  const runtimeCodeClosureSha256Source = declaredClosure?.[0] ?? "computed_live";
  const certifiedRuntimeCodeClosureSha256 =
    overrides.certified_runtime_code_closure_sha256 ??
    attestedIdentity.package?.runtime_code_closure?.certified_sha256 ??
    releaseIdentity.package?.runtime_code_closure?.certified_sha256 ??
    certification.certifiedRuntimeCodeClosureSha256 ??
    certification.certifiedClosureSha256 ??
    null;
  const installationIdentity =
    overrides.installation_identity ??
    process.env.EXCEL_INFLOW_INSTALLATION_IDENTITY ??
    releaseIdentity.deployment?.installation_identity ??
    null;
  const typedIdentity = productIdentity({
    repository:
      overrides.repository ??
      process.env.EXCEL_INFLOW_SOURCE_REPOSITORY ??
      attestedIdentity.source?.repository ??
      releaseIdentity.source?.repository ??
      "computering001/excel-inflow",
    sourceCommit: commit,
    sourceTree: tree,
    packageMode,
    deploymentStatus,
    runtimeCodeClosureSha256,
    certifiedRuntimeCodeClosureSha256,
    completePackageInventorySha256:
      overrides.complete_package_inventory_sha256 ??
      attestedIdentity.package?.complete_package_inventory?.sha256 ??
      releaseIdentity.package?.complete_package_inventory?.sha256 ??
      null,
    archiveSha256:
      overrides.archive_sha256 ??
      attestedIdentity.package?.archive?.sha256 ??
      releaseIdentity.package?.archive?.sha256 ??
      null,
    installedPackageSha256:
      overrides.installed_package_sha256 ??
      releaseIdentity.deployment?.installed_package?.sha256 ??
      null,
    installationIdentity,
  });
  const skillVersion = release.skillVersion ?? runtime.skill_version ?? null;
  const sourceWorktreeDirty =
    overrides.source_worktree_dirty ?? release.sourceWorktreeDirty ?? null;
  const releaseName =
    release.releaseName ??
    (deploymentProfile.release_name && skillVersion
      ? `${deploymentProfile.release_name} v${skillVersion}`
      : null);
  return {
    schema_version: "source-identity/2.0",
    product_identity_schema: PRODUCT_IDENTITY_SCHEMA,
    product_identity: typedIdentity,
    repository: typedIdentity.source.repository,
    source_commit: commit,
    source_tree: tree,
    source_worktree_dirty: sourceWorktreeDirty,
    package_mode: packageMode,
    deployment_status: deploymentStatus,
    release_name: releaseName,
    skill_version: skillVersion,
    runtime_code_closure_sha256: runtimeCodeClosureSha256,
    runtime_code_closure_sha256_source: runtimeCodeClosureSha256Source,
    certified_runtime_code_closure_sha256: certifiedRuntimeCodeClosureSha256,
    // Carrier v3 compatibility aliases. Carrier v4 will remove the ambiguous
    // names and bind the typed product identity directly.
    current_closure_sha256: runtimeCodeClosureSha256,
    certified_closure_sha256: certifiedRuntimeCodeClosureSha256,
    certification_evidence_receipt:
      verifiedExternalAttestation?.certification_evidence ??
      certification.evidenceReceipt ??
      null,
    release_package_attestation_sha256:
      verifiedExternalAttestation?.attestation_sha256 ?? null,
    installation_identity: installationIdentity,
  };
}

/**
 * Resolve identity against current shipped bytes, not a manifest's assertion —
 * and PROVE the two agree wherever a manifest asserts one. Every run-start
 * identity resolution (controllers, run carriers, release orchestration) flows
 * through here, so a pinned package whose live bytes moved cannot start.
 */
export async function resolveActiveSourceIdentity({ skillRoot, overrides = {} } = {}) {
  const root = path.resolve(skillRoot ?? new URL("../../", import.meta.url).pathname);
  const integrity = await captureRuntimeIntegrity(root);
  const activeSha256 = integrity.runtime_code_closure.sha256;
  const identity = await resolveSourceIdentity({
    skillRoot: root,
    overrides,
    activeRuntimeCodeClosureSha256: activeSha256,
  });
  const pinned = identity.runtime_code_closure_sha256_source !== "computed_live";
  const check = checkActiveRuntimeCodeClosure({
    declaredSha256: pinned ? identity.runtime_code_closure_sha256 : null,
    declaredSource: pinned ? identity.runtime_code_closure_sha256_source : null,
    activeSha256,
  });
  return Object.freeze({
    ...identity,
    active_declared_runtime_integrity_sha256: integrity.digest,
    active_runtime_code_closure: integrity.runtime_code_closure,
    active_runtime_code_closure_check: check,
  });
}

export function assertCertifiedProductionIdentity(identity) {
  const required = [
    "source_commit",
    "source_tree",
    "runtime_code_closure_sha256",
    "certified_runtime_code_closure_sha256",
    "certification_evidence_receipt",
    "release_package_attestation_sha256",
    "installation_identity",
  ];
  const missing = required.filter((field) => !identity?.[field]);
  if (identity?.package_mode !== "certified") missing.push("package_mode=certified");
  if (identity?.deployment_status !== "production_promoted") {
    missing.push("deployment_status=production_promoted");
  }
  if (
    identity?.runtime_code_closure_sha256 !==
    identity?.certified_runtime_code_closure_sha256
  ) {
    missing.push("runtime_code_closure_match");
  }
  if (missing.length) throw new Error(`Production source identity is incomplete: ${missing.join(", ")}`);
  return identity;
}

// Compatibility export for callers that have not yet adopted the clearer
// assertion name. Its semantics are the v2 typed vocabulary, not the removed
// package_mode="production" convention.
export const assertProductionSourceIdentity = assertCertifiedProductionIdentity;

export default {
  runtimeCodeClosureMembers,
  checkActiveRuntimeCodeClosure,
  resolveSourceIdentity,
  resolveActiveSourceIdentity,
  assertCertifiedProductionIdentity,
  assertProductionSourceIdentity,
};
