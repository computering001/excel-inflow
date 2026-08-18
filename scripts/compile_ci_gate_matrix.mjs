#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { testProfile } from "./lib/development_gate_contract.mjs";

function arg(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${flag}.`);
  return path.resolve(process.argv[index + 1]);
}
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const registryBytes = fs.readFileSync(path.join(root, "assets", "development-test-registry.json"));
const registry = JSON.parse(registryBytes);
const custody = JSON.parse(fs.readFileSync(arg("--custody-report"), "utf8"));
const portable = JSON.parse(fs.readFileSync(arg("--portable-aggregate"), "utf8"));
const comparison = JSON.parse(fs.readFileSync(arg("--comparison"), "utf8"));
const packageIdentity = JSON.parse(fs.readFileSync(arg("--package-report"), "utf8"));
const out = arg("--out");
const custodyExpected = registry.tests.filter((test) => testProfile(test) === "custody").map((test) => test.id).sort();
const custodyResults = [...(custody.results ?? [])].sort((left, right) => left.id.localeCompare(right.id));
const errors = [];
if (portable.status !== "PASS") errors.push("Portable aggregate is not PASS.");
if (comparison.status !== "PASS") errors.push("Current-SHA serial/parallel comparison is not PASS.");
if (packageIdentity.status !== "PASS") errors.push("Current package/source identity is not PASS.");
if (packageIdentity.source_commit !== portable.source_commit) errors.push("Package/source identity is bound to a different source commit.");
if (!packageIdentity.source_tree) errors.push("Package/source identity has no source tree.");
if (custody.registry?.sha256 !== createHash("sha256").update(registryBytes).digest("hex")) errors.push("Custody report registry hash differs.");
if (JSON.stringify(custodyResults.map((row) => row.id)) !== JSON.stringify(custodyExpected)) errors.push("Custody tests are not enumerated exactly once.");
if (custodyResults.some((row) => !["PASS", "BLOCKED"].includes(row.status))) errors.push("A custody test has an invalid CI inventory status.");
const matrix = {
  schema_version: "ci-gate-matrix/1.0",
  source_commit: portable.source_commit,
  portable: { status: portable.status, test_count: portable.observed_test_count },
  custody: { policy: "PASS_OR_EXPLICIT_BLOCKED", tests: custodyResults.map((row) => ({ id: row.id, status: row.status, missing: row.missing ?? [] })) },
  serial_parallel_comparison: { status: comparison.status, compared_test_count: comparison.compared_test_count },
  package_source_identity: { status: packageIdentity.status, source_commit: packageIdentity.source_commit, source_tree: packageIdentity.source_tree },
  errors,
  status: errors.length === 0 ? "PASS" : "FAIL",
};
fs.writeFileSync(out, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
console.log(JSON.stringify(matrix, null, 2));
if (matrix.status !== "PASS") process.exitCode = 1;
