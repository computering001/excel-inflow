import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  return {
    schema_version: "source-identity/1.0",
    repository: overrides.repository ?? process.env.EXCEL_INFLOW_SOURCE_REPOSITORY ?? "computering001/excel-inflow",
    source_commit: commit,
    source_tree: tree,
    package_mode: release.packageMode ?? runtime.package_mode ?? null,
    release_name: release.releaseName ?? null,
    skill_version: release.skillVersion ?? runtime.skill_version ?? null,
    current_closure_sha256: certification.currentClosureSha256 ?? runtime.current_closure_sha256 ?? null,
    certified_closure_sha256: certification.certifiedClosureSha256 ?? null,
    certification_evidence_receipt: certification.evidenceReceipt ?? null,
    installation_identity: overrides.installation_identity ?? process.env.EXCEL_INFLOW_INSTALLATION_IDENTITY ?? null,
  };
}
export function assertProductionSourceIdentity(identity) {
  const required = ["source_commit", "source_tree", "current_closure_sha256", "certified_closure_sha256", "certification_evidence_receipt", "installation_identity"];
  const missing = required.filter((field) => !identity?.[field]);
  if (identity?.package_mode !== "production") missing.push("package_mode=production");
  if (identity?.current_closure_sha256 !== identity?.certified_closure_sha256) missing.push("closure_match");
  if (missing.length) throw new Error(`Production source identity is incomplete: ${missing.join(", ")}`);
  return identity;
}
export default { resolveSourceIdentity, assertProductionSourceIdentity };
