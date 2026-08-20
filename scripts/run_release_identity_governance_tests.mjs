#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyCiIdentityRoles,
  validateIdentityConvergence,
  validatePerformanceEvidence,
} from "./lib/release_identity_governance.mjs";
import { assertSkillVersionShape, declaredSkillVersion } from "./lib/skill_version_declaration.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const sourceCommit = "13cf667dbfbf66cb7c87fd1965a1eb3768a1138e";
const sourceTree = "3345b36bf4b2bd78769fc4dd3525d506148127d4";
const mergeCommit = "1469841378bfa58e500ecc8de40119153691b049";
const identity = readJson("audit/v373-governance/historical-v373-identity-convergence.json");
const performance = readJson("audit/v373-phase15/historical-full-run-performance-evidence.json");
const runtime = readJson("assets/runtime-manifest.json");
const options = {
  expectedVersion: "3.7.3",
  expectedSourceCommit: sourceCommit,
  expectedSourceTree: sourceTree,
  limitationsExists: fs.existsSync(path.join(root, "KNOWN_LIMITATIONS.md")),
};

assert.deepEqual(validateIdentityConvergence(identity, options), []);
assert.deepEqual(validatePerformanceEvidence(performance, options), []);
// Freeze criterion 9 (P8.9). This line used to read "DELIBERATE TRIPWIRE, not
// derivation": a copy of the version literal, kept so that a bump would fail
// here until an owner re-read the identity-governance expectations. It did not
// work. The previous bump missed this line and the registered gate ran red at
// exact head for a full release cycle (P0.3), and the same failure reproduced
// at head for the next flip before this package repaired it -- so the tripwire
// was not enforcing review, it was deferring a red build.
//
// The review discipline it was reaching for is now STRUCTURAL rather than
// per-site: the version is declared once and derived everywhere, and the
// registered skill-version-declaration suite fails if a new literal appears
// anywhere in the shipped or checked surface. The property this suite needs --
// that the ACTIVE candidate is not the historical release whose audit evidence
// it validates -- is asserted directly below.
assertSkillVersionShape(runtime.skill_version);
assert.equal(runtime.skill_version, declaredSkillVersion(root));
assert.notEqual(
  runtime.skill_version,
  options.expectedVersion,
  "Historical identity evidence is being read against a runtime manifest of the same version.",
);
assert.equal(runtime.status, "v2_development");
assert.equal(runtime.deployment_status, "not_installed");
assert(
  validateIdentityConvergence(identity, { ...options, expectedVersion: runtime.skill_version })
    .some((error) => error.includes("version")),
  "Historical v3.7.3 identity masqueraded as the active runtime-manifest candidate.",
);

const staleVersion = structuredClone(identity);
staleVersion.release.skill_version = "3.7.2";
assert(validateIdentityConvergence(staleVersion, options).some((error) => error.includes("version")));

const mergeMasquerade = structuredClone(identity);
mergeMasquerade.identity_roles.package_source.commit = mergeCommit;
assert(validateIdentityConvergence(mergeMasquerade, options).some((error) => error.includes("package source") || error.includes("merge-test")));

const wrongTree = structuredClone(identity);
wrongTree.identity_roles.package_source.tree = "f".repeat(40);
assert(validateIdentityConvergence(wrongTree, options).some((error) => error.includes("package source")));

assert(validateIdentityConvergence(identity, { ...options, limitationsExists: false }).some((error) => error.includes("KNOWN_LIMITATIONS")));

const stalePerformance = structuredClone(performance);
stalePerformance.source_identity.commit = "fd0f674934d07752906bb5f21ebc9f4c097a8437";
assert(validatePerformanceEvidence(stalePerformance, options).some((error) => error.includes("another source commit")));

const cleanRoles = classifyCiIdentityRoles({
  checkedOutCommit: sourceCommit,
  checkedOutTree: sourceTree,
  candidateSourceCommit: sourceCommit,
  candidateSourceTree: sourceTree,
  mergeTestCommit: mergeCommit,
  mergeTestTree: sourceTree,
  packageSourceCommit: sourceCommit,
  packageSourceTree: sourceTree,
});
assert.equal(cleanRoles.status, "PASS");
const mergeCheckout = classifyCiIdentityRoles({
  checkedOutCommit: mergeCommit,
  checkedOutTree: sourceTree,
  candidateSourceCommit: sourceCommit,
  candidateSourceTree: sourceTree,
  mergeTestCommit: mergeCommit,
  mergeTestTree: sourceTree,
  packageSourceCommit: mergeCommit,
  packageSourceTree: sourceTree,
});
assert.equal(mergeCheckout.status, "FAIL");
assert(mergeCheckout.errors.some((error) => error.includes("synthetic merge") || error.includes("not pinned")));

console.log(JSON.stringify({
  status: "PASS",
  positive_checks: 6,
  mutations_rejected: 7,
  historical_v372_identity_sha256: "f2980d92325614c682927d3b1eb187e109b4c078565c2a28cbeabb8d3096f26e",
  historical_v372_performance_sha256: "959c032d33c39be5ae0326d2c45c99e00e275f7da5b80d26917975db6a9c8e2f"
}, null, 2));
