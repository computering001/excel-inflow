#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const inventory = JSON.parse(
  fs.readFileSync(path.join(root, "assets", "controller-terminal-exit-inventory-v1.json"), "utf8"),
);
const sources = {
  "scripts/run_excel_inflow_vnext.mjs": fs.readFileSync(path.join(root, "scripts", "run_excel_inflow_vnext.mjs"), "utf8"),
  "scripts/run_user_flow.mjs": fs.readFileSync(path.join(root, "scripts", "run_user_flow.mjs"), "utf8"),
};
let checks = 0;
for (const [file, expected] of Object.entries(inventory.source_exit_counts)) {
  const actual = (sources[file].match(/return finish\s*\(/g) ?? []).length;
  assert.equal(actual, expected, `${file} terminal finish count drifted from the frozen inventory`);
  checks += 1;
}
for (const exit of inventory.exits) {
  const file = exit.controller === "vnext"
    ? "scripts/run_excel_inflow_vnext.mjs"
    : "scripts/run_user_flow.mjs";
  assert.ok(sources[file].includes(exit.signature), `${exit.id} source signature disappeared`);
  assert.ok(exit.broker_safe, `${exit.id} is not owned by the optional-broker invariant`);
  checks += 2;
}
assert.equal(
  inventory.exits.filter((exit) => exit.controller === "vnext").length,
  inventory.source_exit_counts["scripts/run_excel_inflow_vnext.mjs"],
);
assert.equal(
  inventory.exits.filter((exit) => exit.controller === "delegate").length,
  inventory.source_exit_counts["scripts/run_user_flow.mjs"],
);
checks += 2;

const docs = ["SKILL.md", "central-instructions.md", "references/runtime-core.md"]
  .map((file) => fs.readFileSync(path.join(root, file), "utf8"));
for (const doc of docs) {
  assert.ok(doc.includes("node scripts/run_excel_inflow_vnext.mjs --screen company"));
  assert.ok(!doc.includes("An ordinary production company run invokes only `scripts/run_user_flow.mjs`"));
  checks += 2;
}

console.log(JSON.stringify({
  status: "PASS",
  checks,
  public_exit_count: inventory.source_exit_counts["scripts/run_excel_inflow_vnext.mjs"],
  delegate_exit_count: 18,
  public_controller_count: 1,
}, null, 2));
