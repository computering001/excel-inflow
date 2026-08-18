#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateGateReports,
  selectRegistryTests,
  testIdSetSha256,
  testProfile,
} from "./lib/development_gate_contract.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "assets", "development-test-registry.json");
const registryBytes = fs.readFileSync(registryPath);
const registrySha256 = createHash("sha256").update(registryBytes).digest("hex");
const registry = JSON.parse(registryBytes.toString("utf8"));
const matrix = registry.tests.find((row) => row.id === "universal-broker-delivery-matrix");
assert.deepEqual(matrix.arguments, ["$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"]);
assert.deepEqual(matrix.requires, ["RAW_CANARY_EVIDENCE", "PYTHON", "SOFFICE"]);
const script = fs.readFileSync(path.join(root,"scripts/run_universal_broker_delivery_matrix.mjs"),"utf8");
assert.match(script, /cleanFixtureArg, pythonArg, sofficeArg/);

const ids = registry.tests.map((test) => test.id);
assert.equal(new Set(ids).size, ids.length, "Registry test ids are not unique.");
for (const test of registry.tests) {
  assert(fs.existsSync(path.join(root, "scripts", test.script)), `Registry script is absent for ${test.id}.`);
}
assert.equal(registry.tests.find((test) => test.id === "acquisition-valuation-contract")?.script, "run_acquisition_valuation_contract_tests.mjs");
assert.equal(registry.tests.find((test) => test.id === "broker-period-independent-oracle")?.test_class, "mutation");
assert.deepEqual(
  registry.tests.find((test) => test.id === "portable-finance-workbook-semantic-mutations")?.requires,
  ["REPRESENTATIVE", "PYTHON"],
);
assert.equal(testProfile(registry.tests.find((test) => test.id === "installed-host-usable-broker")), "custody");
assert.equal(testProfile(registry.tests.find((test) => test.id === "installed-host-broker-receipt-contract")), "portable");
const portable = selectRegistryTests(registry, { profile: "portable" });
const custody = selectRegistryTests(registry, { profile: "custody" });
assert.equal(portable.length + custody.length, registry.tests.length);
assert.deepEqual(portable.filter((test) => custody.some((row) => row.id === test.id)), []);

const report = (profile, tests, sourceCommit = "a".repeat(40)) => ({
  schema_version: "development-gate-report/2.0",
  source: { commit: sourceCommit, worktree_dirty: false },
  registry: { sha256: registrySha256 },
  selection: { profile, selected_test_ids_sha256: testIdSetSha256(tests) },
  results: tests.map((test) => ({ id: test.id, status: "PASS" })),
});
const portableReport = report("portable", portable);
const custodyReport = report("custody", custody);
assert.equal(aggregateGateReports({ registry, registrySha256, profile: "all", reports: [portableReport, custodyReport] }).status, "PASS");

const missingMutation = structuredClone(portableReport);
missingMutation.results.pop();
assert.equal(aggregateGateReports({ registry, registrySha256, profile: "portable", reports: [missingMutation] }).status, "FAIL");
const duplicateMutation = structuredClone(portableReport);
duplicateMutation.results.push(structuredClone(duplicateMutation.results[0]));
assert.equal(aggregateGateReports({ registry, registrySha256, profile: "portable", reports: [duplicateMutation] }).status, "FAIL");
const registryMutation = structuredClone(portableReport);
registryMutation.registry.sha256 = "b".repeat(64);
assert.equal(aggregateGateReports({ registry, registrySha256, profile: "portable", reports: [registryMutation] }).status, "FAIL");
const commitMutation = structuredClone(custodyReport);
commitMutation.source.commit = "b".repeat(40);
assert.equal(aggregateGateReports({ registry, registrySha256, profile: "all", reports: [portableReport, commitMutation] }).status, "FAIL");
const dirtyMutation = structuredClone(portableReport);
dirtyMutation.source.worktree_dirty = true;
assert.equal(aggregateGateReports({ registry, registrySha256, profile: "portable", reports: [dirtyMutation] }).status, "FAIL");

const gateRunner = fs.readFileSync(path.join(root, "scripts/run_development_gate.mjs"), "utf8");
assert.match(gateRunner, /output_custody: await describeInput\(testOut\)/);
assert.match(gateRunner, /detail_policy: "protected_details_redacted"/);
assert.doesNotMatch(
  gateRunner.slice(gateRunner.indexOf("function redactedExecutionResult"), gateRunner.indexOf("function resolveArgument")),
  /command:/,
);

console.log(JSON.stringify({
  status: "PASS",
  checks: 20 + registry.tests.length,
  registry_tests: registry.tests.length,
  portable_tests: portable.length,
  custody_tests: custody.length,
  aggregate_mutations_caught: 5,
}));
