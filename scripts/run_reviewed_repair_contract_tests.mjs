#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "reviewed_repair_contract_tests", importMetaUrl: import.meta.url });
const read = (relative) => fs.readFileSync(path.join(run.ROOT, relative), "utf8");

const behavior = read("scripts/lib/forecast_behavior.mjs");
const authority = read("scripts/lib/forecast_authority.mjs");
const candidateCompiler = read("scripts/lib/forecast_candidate_compiler.mjs");
run.match(behavior, /NON_RECURRING_ROLES[\s\S]*acquisitions_net_of_cash/, "non-recurring roles must name acquisitions_net_of_cash");
run.match(authority, /STRUCTURAL_EVENT_ROLES[\s\S]*acquisitions_net_of_cash/, "structural event roles must name acquisitions_net_of_cash");
run.match(candidateCompiler, /behavior !== "non_recurring_event"/, "candidate compiler must branch on the non-recurring behaviour");
run.match(candidateCompiler, /method: "explicit_zero"/, "candidate compiler must emit explicit zeros");

const canary = read("scripts/run_raw_input_black_box_canary.mjs");
run.match(canary, /preauthored_broker_crosswalk: brokerState === "usable"/);
run.match(
  canary,
  /broker_semantic_host_mode:[\s\S]*deterministic_component_fixture/,
);
run.doesNotMatch(canary, /simulated_local_model_host_response/);
run.doesNotMatch(canary, /preauthored_broker_crosswalk: false/);

const registry = JSON.parse(read("assets/development-test-registry.json"));
const matrix = registry.tests.find((item) => item.id === "universal-broker-delivery-matrix");
run.eq(matrix.arguments, ["$RAW_CANARY_EVIDENCE", "$PYTHON", "$SOFFICE"]);
run.eq(matrix.requires, ["RAW_CANARY_EVIDENCE", "PYTHON", "SOFFICE"]);

for (const relative of [
  "scripts/lib/acquisition_policy.mjs",
  "scripts/lib/funded_acquisition_plan.mjs",
  "scripts/lib/solver.mjs",
  "scripts/lib/row_plan.mjs",
]) {
  const source = read(relative);
  run.match(source, /consideration/i, `${relative} lacks consideration semantics`);
  run.match(source, /debt proceeds|debt_proceeds/i, `${relative} lacks debt-proceeds semantics`);
}
run.match(read("scripts/verify/finance_proof.py"), /acquisition_debt_amount/);
run.match(read("scripts/verify/finance_proof.py"), /acquisition_interest/);
run.match(read("references/acquisition.md"), /consideration/i);
run.match(read("references/acquisition.md"), /acquisition debt|funding/i);
run.match(read("references/validation.md"), /consideration/i);
run.match(read("references/validation.md"), /acquisition debt|debt funding/i);
run.doesNotMatch(read("references/acquisition.md"), /zero direct transaction cash-flow effect/i);

for (const relative of [
  "scripts/run_forecast_behavior_tests.mjs",
  "scripts/run_forecast_topology_tests.mjs",
]) {
  // The named suite must still exit 0 under its own invocation.
  run.check(`${relative} runs clean`, () => {
    execFileSync(process.execPath, [path.join(run.ROOT, relative)], { cwd: run.ROOT, stdio: "pipe" });
    return true;
  });
}

run.finish();
