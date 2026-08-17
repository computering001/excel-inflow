import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  PRODUCT_IDENTITY_SCHEMA,
  assertDeploymentStatus,
  assertPackageMode,
  productIdentity,
} from "./identity_vocabulary.mjs";
const exec = promisify(execFile);

async function readJson(target) {
  try { return JSON.parse(await fs.readFile(target, "utf8")); } catch { return null; }
}
async function gitValue(skillRoot, args) {
  try { return (await exec("git", ["-C", skillRoot, ...args], { timeout: 5000 })).stdout.trim() || null; }
  catch { return null; }
}
export async function resolveSourceIdentity({ skillRoot, overrides = {} } = {}) {
  const root = path.resolve(skillRoot ?? new URL("../../", import.meta.url).pathname);
  const release = await readJson(path.join(root, "release-manifest.json")) ?? {};
  const runtime = await readJson(path.join(root, "assets", "runtime-manifest.json")) ?? {};
  const commit = overrides.source_commit ?? process.env.EXCEL_INFLOW_SOURCE_COMMIT ?? runtime.source_commit ?? await gitValue(root, ["rev-parse", "HEAD"]);
  const tree = overrides.source_tree ?? process.env.EXCEL_INFLOW_SOURCE_TREE ?? runtime.source_tree ?? await gitValue(root, ["rev-parse", "HEAD^{tree}"]);
  const certification = release.certification ?? {};
  const releaseIdentity = release.identity ?? {};
  const packageMode = assertPackageMode(
    overrides.package_mode ??
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
      releaseIdentity.deployment?.status ??
      release.deploymentStatus ??
      "not_installed",
  );
  const runtimeCodeClosureSha256 =
    overrides.runtime_code_closure_sha256 ??
    releaseIdentity.package?.runtime_code_closure?.sha256 ??
    certification.runtimeCodeClosureSha256 ??
    certification.currentClosureSha256 ??
    runtime.runtime_code_closure_sha256 ??
    runtime.current_closure_sha256 ??
    null;
  const certifiedRuntimeCodeClosureSha256 =
    overrides.certified_runtime_code_closure_sha256 ??
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
    repository: overrides.repository ?? process.env.EXCEL_INFLOW_SOURCE_REPOSITORY ?? "computering001/excel-inflow",
    sourceCommit: commit,
    sourceTree: tree,
    packageMode,
    deploymentStatus,
    runtimeCodeClosureSha256,
    certifiedRuntimeCodeClosureSha256,
    completePackageInventorySha256:
      overrides.complete_package_inventory_sha256 ??
      releaseIdentity.package?.complete_package_inventory?.sha256 ??
      null,
    archiveSha256: overrides.archive_sha256 ?? releaseIdentity.package?.archive?.sha256 ?? null,
    installedPackageSha256:
      overrides.installed_package_sha256 ??
      releaseIdentity.deployment?.installed_package?.sha256 ??
      null,
    installationIdentity,
  });
  return {
    schema_version: "source-identity/2.0",
    product_identity_schema: PRODUCT_IDENTITY_SCHEMA,
    product_identity: typedIdentity,
    repository: typedIdentity.source.repository,
    source_commit: commit,
    source_tree: tree,
    package_mode: packageMode,
    deployment_status: deploymentStatus,
    release_name: release.releaseName ?? null,
    skill_version: release.skillVersion ?? runtime.skill_version ?? null,
    runtime_code_closure_sha256: runtimeCodeClosureSha256,
    certified_runtime_code_closure_sha256: certifiedRuntimeCodeClosureSha256,
    // Carrier v3 compatibility aliases. Carrier v4 will remove the ambiguous
    // names and bind the typed product identity directly.
    current_closure_sha256: runtimeCodeClosureSha256,
    certified_closure_sha256: certifiedRuntimeCodeClosureSha256,
    certification_evidence_receipt: certification.evidenceReceipt ?? null,
    installation_identity: installationIdentity,
  };
}

export function assertCertifiedProductionIdentity(identity) {
  const required = [
    "source_commit",
    "source_tree",
    "runtime_code_closure_sha256",
    "certified_runtime_code_closure_sha256",
    "certification_evidence_receipt",
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
  resolveSourceIdentity,
  assertCertifiedProductionIdentity,
  assertProductionSourceIdentity,
};
