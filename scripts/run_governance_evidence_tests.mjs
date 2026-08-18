#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const auditRoot = path.join(root, "audit", "v372-governance");
const read = (relative) => fs.readFileSync(path.join(root, relative));
const json = (relative) => JSON.parse(read(relative));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const historical = json("audit/v372-governance/historical-v370-identity-classification.json");
const immutable = {
  "audit/v370/package-identity.json": historical.subject.sha256,
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

const identity = json("audit/v372-governance/current-identity-convergence.json");
assert.equal(identity.published_candidate_basis.source_commit, identity.published_candidate_basis.tag_resolves_to);
assert(identity.convergence_matrix.some((row) => row.surface === "installed_host" && row.classification === "HELD_BY_USER_NOT_INSTALLED"));
assert.deepEqual(
  Object.keys(identity.current_source_contract_matrix.fields).sort(),
  ["archive_hash", "deployment_status", "full_package_inventory", "installation_version", "package_mode", "product_version", "rollback_version", "runtime_closure", "source_commit", "source_tree"],
);
assert.equal(identity.current_source_contract_matrix.fields.rollback_version.instructions, "NO_HARD_CODED_CONTROLLER_NICKNAME");

const census = json("audit/v372-governance/test-registry-classification-census.json");
assert.equal(census.registry.sha256, sha256(read(census.registry.path)));
assert(Object.values(census.completeness).every(Boolean));
assert.equal(Object.values(census.counts.by_audit_class).reduce((sum, count) => sum + count, 0), census.registry.test_count);
assert(fs.existsSync(path.join(auditRoot, "current-identity-convergence.json")));

console.log(JSON.stringify({
  status: "PASS",
  checks: Object.keys(immutable).length + 14,
  immutable_historical_files: Object.keys(immutable).length,
  baseline_run_ids_in_custody: baseline.baseline_ci_runs.length,
  registry_tests_classified: census.registry.test_count,
}));
