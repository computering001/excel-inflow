#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createRunner } from "./lib/test_harness.mjs";
import { validateIdentityConvergence, validatePerformanceEvidence } from "./lib/release_identity_governance.mjs";
import { assertSkillVersionShape, declaredSkillVersion } from "./lib/skill_version_declaration.mjs";

const run = createRunner({ name: "governance_evidence_tests", importMetaUrl: import.meta.url });
const root = run.ROOT;
const auditRoot = path.join(root, "audit", "v375-governance");
const read = (relative) => fs.readFileSync(path.join(root, relative));
const json = (relative) => JSON.parse(read(relative));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const historical = json("audit/v372-governance/historical-v370-identity-classification.json");
const immutable = {
  "audit/v370/package-identity.json": historical.subject.sha256,
  "audit/v372-governance/historical-v372-identity-convergence.json": "f2980d92325614c682927d3b1eb187e109b4c078565c2a28cbeabb8d3096f26e",
  "audit/v372-phase15/historical-full-run-performance-evidence.json": "959c032d33c39be5ae0326d2c45c99e00e275f7da5b80d26917975db6a9c8e2f",
  ...historical.immutability_checks,
};
for (const [relative, expected] of Object.entries(immutable)) {
  run.eq(sha256(read(relative)), expected, `Historical audit bytes changed: ${relative}.`);
}
run.eq(historical.active_authority, false, "historical classification still claims active authority");
run.eq(historical.historical_bytes_mutated, false, "historical bytes were mutated");

const baseline = json("audit/v372-governance/baseline-verification-and-run-custody.json");
run.eq(baseline.baseline.git_signature_status, "N", "baseline git signature status changed");
run.eq(baseline.baseline.verification_claim, false, "baseline claims verification it never had");
run.eq(baseline.chronology_deviation.status, "IRREDUCIBLE_HISTORICAL_DEVIATION", "chronology deviation class changed");
run.eq(baseline.baseline_ci_runs.map((entry) => entry.database_id).sort(), [32073013591, 32073120387], "baseline CI runs are not the two in custody");

const identity = json("audit/v373-governance/historical-v373-identity-convergence.json");
const performance = json("audit/v373-phase15/historical-full-run-performance-evidence.json");
const runtime = json("assets/runtime-manifest.json");
const expected = {
  expectedVersion: "3.7.3",
  expectedSourceCommit: "13cf667dbfbf66cb7c87fd1965a1eb3768a1138e",
  expectedSourceTree: "3345b36bf4b2bd78769fc4dd3525d506148127d4",
  limitationsExists: fs.existsSync(path.join(root, "KNOWN_LIMITATIONS.md")),
};
run.eq(validateIdentityConvergence(identity, expected), [], "v373 identity convergence drifted");
run.eq(validatePerformanceEvidence(performance, expected), [], "v373 performance evidence drifted");
// Freeze criterion 9 (P8.9): DERIVED, not a tripwire copy. The property this
// suite actually needs is not "the version is <literal>" but "the ACTIVE
// version is not the historical one this audit evidence belongs to" -- which is
// asserted below and now stated directly, against the single declaration.
run.check("runtime skill version shape is valid", () => assertSkillVersionShape(runtime.skill_version));
run.eq(runtime.skill_version, declaredSkillVersion(root), "runtime manifest disagrees with the declared skill version");
run.ne(
  runtime.skill_version,
  expected.expectedVersion,
  "Historical audit evidence is being read against a runtime manifest of the same version.",
);
run.eq(runtime.status, "v2_development", "runtime status changed");
run.eq(runtime.deployment_status, "not_installed", "runtime deployment status changed");
run.ok(
  validateIdentityConvergence(identity, { ...expected, expectedVersion: runtime.skill_version })
    .some((error) => error.includes("version")),
  "Historical v3.7.3 identity masqueraded as active v3.7.5 evidence.",
);

const census = json("audit/v375-governance/test-registry-classification-census.json");
run.eq(census.registry.sha256, sha256(read(census.registry.path)), "census registry digest does not match its bytes");
run.ok(Object.values(census.completeness).every(Boolean), "census completeness regressed");
run.eq(Object.values(census.counts.by_audit_class).reduce((sum, count) => sum + count, 0), census.registry.test_count, "census audit-class counts do not sum to the registry test count");
run.ok(fs.existsSync(path.join(auditRoot, "test-registry-classification-census.json")), "v375 census artifact is missing");

run.finish({
  immutable_historical_files: Object.keys(immutable).length,
  baseline_run_ids_in_custody: baseline.baseline_ci_runs.length,
  registry_tests_classified: census.registry.test_count,
  historical_identity_version: identity.release.skill_version,
  active_source_version: runtime.skill_version,
});
