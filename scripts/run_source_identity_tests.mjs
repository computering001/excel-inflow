#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  resolveSourceIdentity,
  assertCertifiedProductionIdentity,
} from "./lib/source_identity.mjs";
const exec = promisify(execFile);
const identity = await resolveSourceIdentity({ skillRoot: new URL("../", import.meta.url).pathname });
assert.ok(identity.source_commit);
assert.ok(identity.source_tree);
assert.equal(identity.schema_version, "source-identity/2.0");
assert.equal(identity.product_identity.schema_version, "product-identity/2.0");
assert.equal(identity.package_mode, "development");
assert.equal(identity.deployment_status, "not_installed");
assert.equal(identity.skill_version, "3.7.1");
assert.equal(identity.release_name, "Excel Inflow v3.7.1");
assert.equal(
  identity.runtime_code_closure_sha256,
  identity.product_identity.package.runtime_code_closure.sha256,
);
assert.throws(() => assertCertifiedProductionIdentity(identity), /package_mode=certified/);

const production = {
  ...identity,
  package_mode: "certified",
  deployment_status: "production_promoted",
  certified_runtime_code_closure_sha256: identity.runtime_code_closure_sha256,
  certified_closure_sha256: identity.runtime_code_closure_sha256,
  certification_evidence_receipt: { status: "PASS" },
  release_package_attestation_sha256: "e".repeat(64),
  installation_identity: "installed:fixture",
};
assert.doesNotThrow(() => assertCertifiedProductionIdentity(production));
assert.throws(
  () => assertCertifiedProductionIdentity({ ...production, deployment_status: "installed_candidate" }),
  /deployment_status=production_promoted/,
);
assert.throws(
  () => assertCertifiedProductionIdentity({
    ...production,
    certified_runtime_code_closure_sha256: "f".repeat(64),
  }),
  /runtime_code_closure_match/,
);

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-source-identity-"));
try {
  await fs.mkdir(path.join(fixtureRoot, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "assets", "runtime-manifest.json"),
    `${JSON.stringify({
      schema_version: 2,
      skill_version: "3.7.1",
      status: "v2_development",
      deployment_status: "not_installed",
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(fixtureRoot, "assets", "deployment-profile.json"),
    `${JSON.stringify({ release_name: "Excel Inflow" }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(fixtureRoot, "release-manifest.json"),
    `${JSON.stringify({
      releaseName: "Excel Inflow v3.6.0",
      skillVersion: "3.6.0",
      packageMode: "certified",
      deploymentStatus: "production_promoted",
    }, null, 2)}\n`,
  );
  await exec("git", ["init", "-q", fixtureRoot]);
  await exec("git", ["-C", fixtureRoot, "add", "."]);
  await exec("git", [
    "-C", fixtureRoot,
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", "fixture",
  ]);
  const fixtureIdentity = await resolveSourceIdentity({
    skillRoot: fixtureRoot,
    overrides: { runtime_code_closure_sha256: "a".repeat(64) },
  });
  assert.equal(fixtureIdentity.skill_version, "3.7.1");
  assert.equal(fixtureIdentity.release_name, "Excel Inflow v3.7.1");
  assert.equal(fixtureIdentity.package_mode, "development");
  assert.equal(fixtureIdentity.deployment_status, "not_installed");
  assert.notEqual(fixtureIdentity.source_commit, null);
  assert.notEqual(fixtureIdentity.source_tree, null);
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: "PASS", checks: 20 }));
