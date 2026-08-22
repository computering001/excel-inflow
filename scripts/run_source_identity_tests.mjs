#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createRunner } from "./lib/test_harness.mjs";
import {
  resolveSourceIdentity,
  assertCertifiedProductionIdentity,
} from "./lib/source_identity.mjs";
import { generatedInstructionSurfaces } from "./generate_canonical_instructions.mjs";
import {
  declaredReleaseName,
  declaredSkillVersion,
} from "./lib/skill_version_declaration.mjs";

const run = createRunner({
  name: "source_identity_tests",
  importMetaUrl: import.meta.url,
});

const skillRoot = new URL("../", import.meta.url).pathname;
const exec = promisify(execFile);
const identity = await resolveSourceIdentity({ skillRoot });
run.check("identity resolves from the development tree", () => {
  assert.ok(identity && typeof identity === "object");
  return true;
});
run.check("identity names a source commit", () => {
  assert.ok(identity.source_commit);
  return true;
});
run.check("identity names a source tree", () => {
  assert.ok(identity.source_tree);
  return true;
});
run.check("identity carries the source-identity/2.0 schema", () => {
  assert.equal(identity.schema_version, "source-identity/2.0");
  return true;
});
run.check("product identity carries the product-identity/2.0 schema", () => {
  assert.equal(identity.product_identity.schema_version, "product-identity/2.0");
  return true;
});
run.check("development tree resolves package_mode=development", () => {
  assert.equal(identity.package_mode, "development");
  return true;
});
run.check("development tree resolves deployment_status=not_installed", () => {
  assert.equal(identity.deployment_status, "not_installed");
  return true;
});
// Freeze criterion 9 (P8.9): DERIVED, not a tripwire copy. These two are the
// load-bearing half of the criterion: `identity` comes out of the whole
// resolveSourceIdentity pipeline (package manifest, attestation, env overrides,
// runtime manifest), and the expectation comes from the single declaration.
// They agree only if that pipeline really derives the version and composes the
// release name from the deployment profile's product stem -- so a regression
// that let a stale release-manifest or an env override supply the version still
// fails here, which is exactly what a hard-coded literal used to catch.
run.check("skill version is derived from the single declaration", () => {
  assert.equal(identity.skill_version, declaredSkillVersion(skillRoot));
  return true;
});
run.check("release name composes the declared product stem", () => {
  assert.equal(identity.release_name, declaredReleaseName(skillRoot));
  return true;
});
run.check("runtime closure digest matches the packaged product identity", () => {
  assert.equal(
    identity.runtime_code_closure_sha256,
    identity.product_identity.package.runtime_code_closure.sha256,
  );
  return true;
});
run.check("development identity is refused as certified production", () => {
  assert.throws(() => assertCertifiedProductionIdentity(identity), /package_mode=certified/);
  return true;
});

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
run.check("complete certified production identity verifies", () => {
  assert.doesNotThrow(() => assertCertifiedProductionIdentity(production));
  return true;
});
run.check("certified identity demands production_promoted deployment", () => {
  assert.throws(
    () => assertCertifiedProductionIdentity({ ...production, deployment_status: "installed_candidate" }),
    /deployment_status=production_promoted/,
  );
  return true;
});

const skillInstructions = await fs.readFile(new URL("../SKILL.md", import.meta.url), "utf8");
run.check("SKILL.md surfaces only canonical instructions", () => {
  assert.doesNotThrow(() => generatedInstructionSurfaces(skillInstructions));
  return true;
});
let instruction_rollback_mutations_caught = 0;
run.check("obsolete nickname-based rollback wording is rejected", () => {
  assert.throws(
    () => generatedInstructionSurfaces(skillInstructions.replace(
      "package-retained internal delegate",
      "v64 implementation is an internal rollback delegate",
    )),
    /obsolete nickname-based rollback wording/,
    "Obsolete nickname-based rollback wording escaped canonical instruction generation.",
  );
  instruction_rollback_mutations_caught = 1;
  return true;
});
run.check("certified identity demands the sealed runtime closure digest", () => {
  assert.throws(
    () => assertCertifiedProductionIdentity({
      ...production,
      certified_runtime_code_closure_sha256: "f".repeat(64),
    }),
    /runtime_code_closure_match/,
  );
  return true;
});

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
  run.check("fixture version comes from the runtime manifest, not the stale release manifest", () => {
    assert.equal(fixtureIdentity.skill_version, "3.7.1");
    return true;
  });
  run.check("fixture release name derives from the deployment profile", () => {
    assert.equal(fixtureIdentity.release_name, "Excel Inflow v3.7.1");
    return true;
  });
  run.check("stale certified release manifest cannot flip package_mode", () => {
    assert.equal(fixtureIdentity.package_mode, "development");
    return true;
  });
  run.check("stale promoted release manifest cannot flip deployment_status", () => {
    assert.equal(fixtureIdentity.deployment_status, "not_installed");
    return true;
  });
  run.check("fixture resolves a source commit", () => {
    assert.notEqual(fixtureIdentity.source_commit, null);
    return true;
  });
  run.check("fixture resolves a source tree", () => {
    assert.notEqual(fixtureIdentity.source_tree, null);
    return true;
  });

  // Deployment placement is installed-host evidence. Environment variables may
  // locate tools and external package artefacts, but they may never declare
  // that source bytes are installed, promoted or owned by an installation.
  const priorDeploymentStatus = process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS;
  const priorInstallationIdentity = process.env.EXCEL_INFLOW_INSTALLATION_IDENTITY;
  process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS = "production_promoted";
  process.env.EXCEL_INFLOW_INSTALLATION_IDENTITY = "environment-spoofed-installation";
  try {
    const environmentSpoof = await resolveSourceIdentity({
      skillRoot: fixtureRoot,
      overrides: { runtime_code_closure_sha256: "a".repeat(64) },
    });
    run.check("environment cannot spoof deployment_status", () => {
      assert.equal(environmentSpoof.deployment_status, "not_installed");
      return true;
    });
    run.check("environment cannot install an installation identity", () => {
      assert.equal(environmentSpoof.installation_identity, null);
      return true;
    });
    run.check("product identity ignores environment deployment claims", () => {
      assert.equal(environmentSpoof.product_identity.deployment.status, "not_installed");
      return true;
    });
    run.check("product identity ignores environment installation claims", () => {
      assert.equal(environmentSpoof.product_identity.deployment.installation_identity, null);
      return true;
    });
  } finally {
    if (priorDeploymentStatus === undefined) delete process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS;
    else process.env.EXCEL_INFLOW_DEPLOYMENT_STATUS = priorDeploymentStatus;
    if (priorInstallationIdentity === undefined) delete process.env.EXCEL_INFLOW_INSTALLATION_IDENTITY;
    else process.env.EXCEL_INFLOW_INSTALLATION_IDENTITY = priorInstallationIdentity;
  }
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}

run.finish({ instruction_rollback_mutations_caught });
