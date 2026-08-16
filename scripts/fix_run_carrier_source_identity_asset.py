#!/usr/bin/env python3
"""Make the carrier consume the shipped source-identity asset without host env."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "scripts" / "lib" / "run_carrier.mjs"
text = path.read_text("utf-8")
old = '''async function runtimeSourceIdentity(skillRoot) {
  const runtime = await readJsonIfPresent(path.join(skillRoot, "assets", "runtime-manifest.json"));
  const release = await readJsonIfPresent(path.join(skillRoot, "release-manifest.json"));
  const certification = release?.certification ?? {};
  const sourceCommit = process.env.EXCEL_INFLOW_SOURCE_COMMIT ?? runtime.sourceCommit ?? release.sourceCommit ?? null;
  const sourceTree = process.env.EXCEL_INFLOW_SOURCE_TREE ?? runtime.sourceTree ?? release.sourceTree ?? null;
  const currentClosure = runtime.currentClosureSha256 ?? certification.currentClosureSha256 ?? null;
  const packageMode = runtime.packageMode ?? release.packageMode ?? "development";
  const identity = {
    schema_version: "excel-inflow-source-identity/1.0",
    repository: runtime.repository ?? release.repository ?? "computering001/excel-inflow",
    source_commit: sourceCommit,
    source_tree: sourceTree,
    current_closure_sha256: currentClosure,
    certified_closure_sha256: runtime.certifiedClosureSha256 ?? certification.certifiedClosureSha256 ?? null,
    package_mode: packageMode,
    skill_version: runtime.skillVersion ?? release.skillVersion ?? null,
    release_name: release.releaseName ?? null,
  };
'''
new = '''async function runtimeSourceIdentity(skillRoot) {
  const source = await readJsonIfPresent(path.join(skillRoot, "assets", "source-identity.json"));
  const runtime = await readJsonIfPresent(path.join(skillRoot, "assets", "runtime-manifest.json"));
  const release = await readJsonIfPresent(path.join(skillRoot, "release-manifest.json"));
  const certification = release?.certification ?? {};
  if (
    Object.keys(source).length > 0 &&
    source.schema_version !== "excel-inflow-source-identity/1.0"
  ) {
    throw new Error("Shipped source-identity asset has the wrong schema version.");
  }
  const sourceCommit = process.env.EXCEL_INFLOW_SOURCE_COMMIT ?? source.source_commit ?? runtime.sourceCommit ?? release.sourceCommit ?? null;
  const sourceTree = process.env.EXCEL_INFLOW_SOURCE_TREE ?? source.source_tree ?? runtime.sourceTree ?? release.sourceTree ?? null;
  const currentClosure = runtime.currentClosureSha256 ?? certification.currentClosureSha256 ?? null;
  const packageMode = source.package_mode ?? runtime.packageMode ?? release.packageMode ?? "development";
  const identity = {
    schema_version: "excel-inflow-source-identity/1.0",
    repository: source.repository ?? runtime.repository ?? release.repository ?? "computering001/excel-inflow",
    source_commit: sourceCommit,
    source_tree: sourceTree,
    source_branch: source.source_branch ?? null,
    current_closure_sha256: currentClosure,
    certified_closure_sha256: runtime.certifiedClosureSha256 ?? certification.certifiedClosureSha256 ?? null,
    package_mode: packageMode,
    skill_version: runtime.skillVersion ?? release.skillVersion ?? null,
    release_name: release.releaseName ?? null,
  };
'''
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise RuntimeError("Carrier source-identity helper shape is not recognised")
path.write_text(text, "utf-8")
print({"status": "PASS", "carrier": str(path.relative_to(ROOT))})
