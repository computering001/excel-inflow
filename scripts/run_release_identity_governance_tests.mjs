#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  classifyCiIdentityRoles,
  validateIdentityConvergence,
  validatePerformanceEvidence,
} from "./lib/release_identity_governance.mjs";
import { assertSkillVersionShape, declaredSkillVersion } from "./lib/skill_version_declaration.mjs";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "release_identity_governance_tests", importMetaUrl: import.meta.url });
const root = run.ROOT;
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

run.eq(validateIdentityConvergence(identity, options), [], "identity convergence validates cleanly");
run.eq(validatePerformanceEvidence(performance, options), [], "performance evidence validates cleanly");
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
run.ok(assertSkillVersionShape(runtime.skill_version), "runtime skill version has a valid declared shape");
run.eq(runtime.skill_version, declaredSkillVersion(root), "runtime manifest version equals the declared skill version");
run.ne(
  runtime.skill_version,
  options.expectedVersion,
  "Historical identity evidence is being read against a runtime manifest of the same version.",
);
run.eq(runtime.status, "v2_development", "runtime status is v2_development");
run.eq(runtime.deployment_status, "not_installed", "runtime deployment status is not_installed");
run.ok(
  validateIdentityConvergence(identity, { ...options, expectedVersion: runtime.skill_version })
    .some((error) => error.includes("version")),
  "Historical v3.7.3 identity masqueraded as the active runtime-manifest candidate.",
);

const staleVersion = structuredClone(identity);
staleVersion.release.skill_version = "3.7.2";
run.ok(validateIdentityConvergence(staleVersion, options).some((error) => error.includes("version")), "stale release version is rejected");

const mergeMasquerade = structuredClone(identity);
mergeMasquerade.identity_roles.package_source.commit = mergeCommit;
run.ok(validateIdentityConvergence(mergeMasquerade, options).some((error) => error.includes("package source") || error.includes("merge-test")), "merge-test commit masquerading as package source is rejected");

const wrongTree = structuredClone(identity);
wrongTree.identity_roles.package_source.tree = "f".repeat(40);
run.ok(validateIdentityConvergence(wrongTree, options).some((error) => error.includes("package source")), "wrong package source tree is rejected");

run.ok(validateIdentityConvergence(identity, { ...options, limitationsExists: false }).some((error) => error.includes("KNOWN_LIMITATIONS")), "missing KNOWN_LIMITATIONS is rejected");

const stalePerformance = structuredClone(performance);
stalePerformance.source_identity.commit = "fd0f674934d07752906bb5f21ebc9f4c097a8437";
run.ok(validatePerformanceEvidence(stalePerformance, options).some((error) => error.includes("another source commit")), "performance evidence bound to another source commit is rejected");

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
run.eq(cleanRoles.status, "PASS", "clean CI identity roles classify as PASS");
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
run.eq(mergeCheckout.status, "FAIL", "merge-checkout identity roles classify as FAIL");
run.ok(mergeCheckout.errors.some((error) => error.includes("synthetic merge") || error.includes("not pinned")), "merge-checkout failure names the synthetic-merge cause");

run.finish({
  positive_checks: 6,
  mutations_rejected: 7,
  historical_v372_identity_sha256: "f2980d92325614c682927d3b1eb187e109b4c078565c2a28cbeabb8d3096f26e",
  historical_v372_performance_sha256: "959c032d33c39be5ae0326d2c45c99e00e275f7da5b80d26917975db6a9c8e2f",
});
