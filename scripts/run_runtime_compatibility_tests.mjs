#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  REQUIRED_RUNTIME_MAPPINGS,
  compareCompatibilityVersions,
  evaluateRuntimeCompatibility,
  loadRuntimeCompatibilityContract,
  parseCompatibilityVersion,
  validateRuntimeCompatibilityContract,
} from "./lib/runtime_compatibility.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONTRACT_PATH = path.join(ROOT, "assets", "runtime-compatibility-v1.json");
const SCHEMA_PATH = path.join(ROOT, "assets", "runtime-compatibility-v1.schema.json");
let checks = 0;
const mutations = [];

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function versionFor(entry, numeric) {
  if (entry.version_parser === "node_semver") return `v${numeric}`;
  if (entry.version_parser === "python_tuple") return numeric.split(".").map(Number);
  if (entry.version_parser === "libreoffice_banner") return `LibreOffice ${numeric} test-build`;
  return numeric;
}

function baselineObservations(contract) {
  const selectedPython = "/opt/excel-inflow/python";
  return Object.fromEntries(contract.runtimes.map((entry) => [
    entry.runtime_name,
    {
      version: versionFor(entry, entry.minimum_version),
      import_name: entry.import_name,
      distribution_name: entry.distribution_name,
      ...(entry.runtime_kind === "python_runtime" ? { executable: selectedPython } : {}),
      ...(entry.runtime_kind === "python_distribution"
        ? { python_executable: selectedPython }
        : {}),
    },
  ]));
}

function expectMutation(id, contract, observations, code, runtimeName) {
  const result = evaluateRuntimeCompatibility({ contract, observations });
  check(
    result.status === "REFUSED" && result.findings.some(
      (item) => item.code === code && item.runtime_name === runtimeName,
    ),
    `${id} escaped without ${code}:${runtimeName}: ${JSON.stringify(result)}`,
  );
  mutations.push(id);
}

const contractBytes = await fs.readFile(CONTRACT_PATH);
const contract = JSON.parse(contractBytes.toString("utf8"));
const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, "utf8"));
check(validateJsonSchema(clone(contract), schema).length === 0, "runtime compatibility asset violates its schema");
check(validateRuntimeCompatibilityContract(contract).length === 0, "runtime compatibility semantic contract is invalid");
check(await loadRuntimeCompatibilityContract(CONTRACT_PATH) !== null, "shared loader did not accept the versioned contract");
check(contract.runtimes.length === 8, "the compatibility contract does not close exactly eight runtimes");
check(
  JSON.stringify(contract.runtimes.map((entry) => entry.runtime_name).sort()) ===
    JSON.stringify(Object.keys(REQUIRED_RUNTIME_MAPPINGS).sort()),
  "the compatibility asset and shared closed mapping disagree",
);
check(
  contract.rogo_host_validation.status === "PENDING" &&
    contract.rogo_host_validation.promotion_blocking === true &&
    contract.runtimes.every((entry) => entry.exercise_evidence.some(
      (item) => item.environment === "rogo_installed_host" &&
        item.status === "PENDING" && item.observed_version === null,
    )),
  "the contract invents installed-Rogo version evidence",
);

check(
  JSON.stringify(parseCompatibilityVersion("v22.23.2", "node_semver")) === "[22,23,2]" &&
    JSON.stringify(parseCompatibilityVersion([3, 9, 6], "python_tuple")) === "[3,9,6]" &&
    JSON.stringify(parseCompatibilityVersion("1.26.5", "python_distribution")) === "[1,26,5]" &&
    JSON.stringify(parseCompatibilityVersion("LibreOffice 26.2.5.2 build", "libreoffice_banner")) === "[26,2,5,2]",
  "one of the four typed version parsers does not accept its declared source form",
);
check(
  parseCompatibilityVersion("22.23.2 trailing", "node_semver") === null &&
    parseCompatibilityVersion("1.26.5rc1", "python_distribution") === null &&
    parseCompatibilityVersion("26.2.5.2", "libreoffice_banner") === null,
  "a typed parser accepted an ambiguous or wrong-source version",
);
check(
  compareCompatibilityVersions([3, 9], [3, 9, 0]) === 0 &&
    compareCompatibilityVersions([3, 9, 1], [3, 9]) === 1 &&
    compareCompatibilityVersions([3, 8, 99], [3, 9]) === -1,
  "numeric version comparison does not pad segments deterministically",
);

const cleanObservations = baselineObservations(contract);
const clean = evaluateRuntimeCompatibility({ contract, observations: cleanObservations });
check(clean.status === "PASS" && clean.total_violations === 0, `minimum-inclusive baseline refused: ${JSON.stringify(clean)}`);
const evidenceOnly = clone(cleanObservations);
delete evidenceOnly.LibreOffice;
delete evidenceOnly.Pillow;
delete evidenceOnly.NumPy;
const evidenceOnlyResult = evaluateRuntimeCompatibility({
  contract,
  observations: evidenceOnly,
  requestedLanes: ["evidence"],
});
check(
  evidenceOnlyResult.status === "PASS" &&
    !evidenceOnlyResult.evaluated_runtime_names.includes("LibreOffice") &&
    evidenceOnlyResult.evaluated_runtime_names.includes("lxml"),
  "lane-scoped compatibility required workbook-only runtimes for an evidence-only run",
);

for (const entry of contract.runtimes) {
  const name = entry.runtime_name;

  const absent = clone(cleanObservations);
  delete absent[name];
  expectMutation(`absent-${name}`, contract, absent, "MISSING_RUNTIME_VERSION", name);

  const unparsable = clone(cleanObservations);
  unparsable[name].version = entry.version_parser === "python_tuple" ? [3, "bad"] : "not-a-version";
  expectMutation(`unparsable-${name}`, contract, unparsable, "UNPARSABLE_RUNTIME_VERSION", name);

  const below = clone(cleanObservations);
  below[name].version = versionFor(entry, "0.0.0");
  expectMutation(`below-minimum-${name}`, contract, below, "VERSION_BELOW_MINIMUM", name);

  const atMaximum = clone(cleanObservations);
  atMaximum[name].version = versionFor(entry, entry.maximum_exclusive_version);
  expectMutation(`at-exclusive-maximum-${name}`, contract, atMaximum, "VERSION_AT_OR_ABOVE_MAXIMUM", name);
}

const distributionMismatch = clone(cleanObservations);
distributionMismatch.PyMuPDF.distribution_name = "fitz";
expectMutation(
  "pymupdf-distribution-name-is-not-import-name",
  contract,
  distributionMismatch,
  "IMPORT_DISTRIBUTION_MISMATCH",
  "PyMuPDF",
);

const moduleMismatch = clone(cleanObservations);
moduleMismatch.Pillow.import_name = "Pillow";
expectMutation(
  "pillow-import-name-is-not-distribution-name",
  contract,
  moduleMismatch,
  "IMPORT_DISTRIBUTION_MISMATCH",
  "Pillow",
);

const secondInterpreter = clone(cleanObservations);
secondInterpreter.lxml.python_executable = "/opt/other/python";
expectMutation(
  "distribution-queried-through-second-interpreter",
  contract,
  secondInterpreter,
  "MULTIPLE_PYTHON_INTERPRETERS",
  "lxml",
);

const contractMapping = clone(contract);
contractMapping.runtimes.find((entry) => entry.runtime_name === "PyMuPDF").import_name = "pymupdf";
check(
  validateRuntimeCompatibilityContract(contractMapping).some(
    (item) => item.code === "IMPORT_DISTRIBUTION_CONTRACT_MISMATCH" && item.runtime_name === "PyMuPDF",
  ),
  "the contract validator accepted the wrong PyMuPDF import/distribution mapping",
);
mutations.push("contract-pymupdf-mapping");

const rogoOverclaim = clone(contract);
rogoOverclaim.rogo_host_validation.status = "PASS";
rogoOverclaim.rogo_host_validation.promotion_blocking = false;
check(
  validateRuntimeCompatibilityContract(rogoOverclaim).some(
    (item) => item.code === "ROGO_VALIDATION_OVERCLAIMED",
  ),
  "the contract validator admitted invented Rogo compatibility",
);
mutations.push("rogo-validation-overclaim");

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  checks,
  runtimes: contract.runtimes.length,
  mutations_declared: mutations.length,
  mutations_applied: mutations.length,
  mutations_caught: mutations.length,
  mutations_survived: 0,
  range_semantics: "minimum_inclusive_maximum_exclusive",
  rogo_host_validation: contract.rogo_host_validation.status,
})}\n`);
