#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
let checks = 0;

const behavior = read("scripts/lib/forecast_behavior.mjs");
const authority = read("scripts/lib/forecast_authority.mjs");
const candidateCompiler = read("scripts/lib/forecast_candidate_compiler.mjs");
assert.match(behavior, /NON_RECURRING_ROLES[\s\S]*acquisitions_net_of_cash/);
assert.match(authority, /STRUCTURAL_EVENT_ROLES[\s\S]*acquisitions_net_of_cash/);
assert.match(candidateCompiler, /behavior !== "non_recurring_event"/);
assert.match(candidateCompiler, /method: "explicit_zero"/);
checks += 4;

const canary = read("scripts/run_raw_input_black_box_canary.mjs");
assert.match(canary, /preauthored_broker_crosswalk: brokerState === "usable"/);
assert.match(
  canary,
  /broker_semantic_host_mode:[\s\S]*deterministic_component_fixture/,
);
assert.doesNotMatch(canary, /simulated_local_model_host_response/);
assert.doesNotMatch(canary, /preauthored_broker_crosswalk: false/);
checks += 4;

const registry = JSON.parse(read("assets/development-test-registry.json"));
const matrix = registry.tests.find((item) => item.id === "universal-broker-delivery-matrix");
assert.deepEqual(matrix.arguments, ["$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"]);
assert.deepEqual(matrix.requires, ["RAW_CANARY_EVIDENCE", "PYTHON", "SOFFICE"]);
checks += 2;

for (const relative of [
  "scripts/lib/acquisition_policy.mjs",
  "scripts/lib/funded_acquisition_plan.mjs",
  "scripts/lib/solver.mjs",
  "scripts/lib/row_plan.mjs",
]) {
  const source = read(relative);
  assert.match(source, /consideration/i, `${relative} lacks consideration semantics`);
  assert.match(source, /debt proceeds|debt_proceeds/i, `${relative} lacks debt-proceeds semantics`);
  checks += 2;
}
assert.match(read("scripts/verify/finance_proof.py"), /acquisition_debt_amount/);
assert.match(read("scripts/verify/finance_proof.py"), /acquisition_interest/);
assert.match(read("references/acquisition.md"), /consideration/i);
assert.match(read("references/acquisition.md"), /acquisition debt|funding/i);
assert.match(read("references/validation.md"), /consideration/i);
assert.match(read("references/validation.md"), /acquisition debt|debt funding/i);
checks += 6;
assert.doesNotMatch(read("references/acquisition.md"), /zero direct transaction cash-flow effect/i);
checks += 1;

for (const relative of [
  "scripts/run_forecast_behavior_tests.mjs",
  "scripts/run_forecast_topology_tests.mjs",
]) {
  execFileSync(process.execPath, [path.join(root, relative)], { cwd: root, stdio: "pipe" });
  checks += 1;
}

console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
