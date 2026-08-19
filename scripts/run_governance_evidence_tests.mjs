#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateIdentityConvergence, validatePerformanceEvidence } from "./lib/release_identity_governance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  assert.equal(sha256(read(relative)), expected, `Historical audit bytes changed: ${relative}.`);
}
assert.equal(historical.active_authority, false);
assert.equal(historical.historical_bytes_mutated, false);

const baseline = json("audit/v372-governance/baseline-verification-and-run-custody.json");
assert.equal(baseline.baseline.git_signature_status, "N");
assert.equal(baseline.baseline.verification_claim, false);
assert.equal(baseline.chronology_deviation.status, "IRREDUCIBLE_HISTORICAL_DEVIATION");
assert.deepEqual(baseline.baseline_ci_runs.map((run) => run.database_id).sort(), [32073013591, 32073120387]);

const identity = json("audit/v373-governance/historical-v373-identity-convergence.json");
const performance = json("audit/v373-phase15/historical-full-run-performance-evidence.json");
const runtime = json("assets/runtime-manifest.json");
const expected = {
  expectedVersion: "3.7.3",
  expectedSourceCommit: "13cf667dbfbf66cb7c87fd1965a1eb3768a1138e",
  expectedSourceTree: "3345b36bf4b2bd78769fc4dd3525d506148127d4",
  limitationsExists: fs.existsSync(path.join(root, "KNOWN_LIMITATIONS.md")),
};
assert.deepEqual(validateIdentityConvergence(identity, expected), []);
assert.deepEqual(validatePerformanceEvidence(performance, expected), []);
// DELIBERATE TRIPWIRE (see run_release_identity_governance_tests.mjs):
// update this literal IN THE SAME COMMIT as any runtime-manifest bump.
assert.equal(runtime.skill_version, "3.7.6");
assert.equal(runtime.status, "v2_development");
assert.equal(runtime.deployment_status, "not_installed");
assert(
  validateIdentityConvergence(identity, { ...expected, expectedVersion: runtime.skill_version })
    .some((error) => error.includes("version")),
  "Historical v3.7.3 identity masqueraded as active v3.7.5 evidence.",
);

const census = json("audit/v375-governance/test-registry-classification-census.json");
assert.equal(census.registry.sha256, sha256(read(census.registry.path)));
assert(Object.values(census.completeness).every(Boolean));
assert.equal(Object.values(census.counts.by_audit_class).reduce((sum, count) => sum + count, 0), census.registry.test_count);
assert(fs.existsSync(path.join(auditRoot, "test-registry-classification-census.json")));

console.log(JSON.stringify({
  status: "PASS",
  checks: Object.keys(immutable).length + 14,
  immutable_historical_files: Object.keys(immutable).length,
  baseline_run_ids_in_custody: baseline.baseline_ci_runs.length,
  registry_tests_classified: census.registry.test_count,
  historical_identity_version: identity.release.skill_version,
  active_source_version: runtime.skill_version,
}));
