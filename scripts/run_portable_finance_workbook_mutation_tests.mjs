#!/usr/bin/env node

/** Build one disposable reference-parity workbook and run both semantic oracles. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({
  name: "portable_finance_workbook_mutation_tests",
  importMetaUrl: import.meta.url,
});

function runCommand(binary, args) {
  return execFileSync(binary, args, {
    cwd: run.ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600000,
  });
}

function readJson(target) {
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

const [representativePath, python = "python3", out] = run.runCli().argv;
if (!representativePath || !out) {
  console.error("usage: run_portable_finance_workbook_mutation_tests.mjs CASE.json PYTHON OUT");
  process.exit(2);
}

fs.mkdirSync(out, { recursive: true });
if (fs.readdirSync(out).length !== 0) {
  throw new Error("portable mutation output directory must start empty");
}

const derivedCase = path.join(out, "reference-parity-case.json");
const workbook = path.join(out, "model.xlsx");
const proofContract = `${workbook}.workbook-proof-contract.json`;
const financeOut = path.join(out, "finance-proof-mutations");
const semanticOut = path.join(out, "workbook-semantic-mutations");

const source = readJson(representativePath);
// Archived representative fixtures are deliberately outside the production
// evidence route. This explicit profile keeps the portable test from
// inventing or weakening production authority contracts.
source.execution_profile = "reference_parity";
fs.writeFileSync(derivedCase, `${JSON.stringify(source, null, 2)}\n`);

runCommand(process.execPath, [
  path.join(run.HERE, "build_dynamic_model.mjs"),
  derivedCase,
  "--plan-only",
  "--out",
  workbook,
]);
runCommand(python, [
  path.join(run.HERE, "emit", "__main__.py"),
  "build",
  `${workbook}.plan.json`,
  "--out",
  workbook,
]);
runCommand(python, [
  path.join(run.HERE, "verify", "run_finance_proof_mutations.py"),
  derivedCase,
  workbook,
  "--out",
  financeOut,
]);
runCommand(python, [
  path.join(run.HERE, "verify", "run_workbook_semantic_oracle_mutations.py"),
  "--xlsx",
  workbook,
  "--contract",
  proofContract,
  "--out",
  semanticOut,
]);

const finance = readJson(path.join(financeOut, "finance-proof-mutations.json"));
const semantic = readJson(path.join(semanticOut, "summary.json"));
const report = {
  schema_version: "portable-finance-workbook-mutations/1.0",
  status: finance.status === "PASS" && semantic.status === "PASS" ? "PASS" : "FAIL",
  finance_proof: {
    status: finance.status,
    mutations_rejected: finance.summary?.passed ?? null,
    mutations_failed: finance.summary?.failed ?? null,
  },
  workbook_semantic_oracle: {
    status: semantic.status,
    adversarial_mutations: semantic.adversarial_mutations ?? null,
  },
};
fs.writeFileSync(
  path.join(out, "portable-finance-workbook-mutations.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));
process.exitCode = report.status === "PASS" ? 0 : 1;
