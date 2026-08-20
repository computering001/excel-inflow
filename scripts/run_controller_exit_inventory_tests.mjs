#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
for (const [file, expectedKinds] of Object.entries(inventory.source_exit_kinds)) {
  const source = sources[file];
  const actualKinds = file.endsWith("run_excel_inflow_vnext.mjs")
    ? {
      model_finish: (source.match(/return finish\s*\(/g) ?? []).length,
      presentation: (source.match(/process\.stdout\.write\(screen\.stdout\);\s*return;/g) ?? []).length,
      outer_internal_failure: (source.match(/main\(\)\.catch\(async \(error\)/g) ?? []).length,
    }
    : {
      model_finish: (source.match(/return finish\s*\(/g) ?? []).length,
      presentation: (source.match(/return normaliseUserFlowResult\(\{ status: "SCREEN", stage \}\)/g) ?? []).length,
      outer_internal_failure: (source.match(/\.catch\(async \(error\) => \{/g) ?? []).length,
    };
  assert.deepEqual(actualKinds, expectedKinds, `${file} terminal exit-kind census drifted`);
  assert.equal(
    Object.values(actualKinds).reduce((sum, count) => sum + count, 0),
    inventory.source_exit_counts[file],
    `${file} terminal exit total drifted`,
  );
  assert.equal((source.match(/process\.exit\s*\(/g) ?? []).length, 0, `${file} bypasses the typed exit owners`);
  checks += 1;
}
for (const exit of inventory.exits) {
  const file = exit.controller === "vnext"
    ? "scripts/run_excel_inflow_vnext.mjs"
    : "scripts/run_user_flow.mjs";
  assert.ok(sources[file].includes(exit.signature), `${exit.id} source signature disappeared`);
  assert.ok(
    ["BLOCK", "ASK", "DEGRADE", "LOG", "DELIVER"].includes(exit.owner),
    `${exit.id} has ambiguous or unregistered owner ${exit.owner}`,
  );
  assert.ok(exit.broker_safe, `${exit.id} is not owned by the optional-broker invariant`);
  checks += 3;
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

// Executable red proof for the public outer catch. A missing runtime-budget
// document fails before host preflight, so this mutation is quick and cannot
// be confused with a downstream broker/filings failure. It must still emit
// the one typed internal-failure line and the preserved engineering artifact.
const outerScratch = fs.mkdtempSync(path.join(os.tmpdir(), "controller-outer-exit-"));
try {
  const outerOut = path.join(outerScratch, "run");
  const outer = spawnSync(process.execPath, [
    path.join(root, "scripts", "run_excel_inflow_vnext.mjs"),
    "--attachment-spec", path.join(outerScratch, "unused-attachment.json"),
    "--out", outerOut,
    "--runtime-budget", path.join(outerScratch, "missing-budget.json"),
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(outer.status, 1, "public outer-catch mutation did not fail closed");
  assert.match(
    outer.stderr,
    /^INTERNAL_FAILURE INTERNAL\.compiler_or_graph_defect:/,
    "public outer-catch mutation did not emit one typed terminal line",
  );
  assert.ok(!/\n\s+at\s/.test(outer.stderr), "public stderr leaked a stack trace");
  const outerArtifact = JSON.parse(
    fs.readFileSync(path.join(outerOut, "internal-failure.json"), "utf8"),
  );
  assert.equal(outerArtifact.schema_version, "excel-inflow-internal-failure/1.0");
  assert.equal(outerArtifact.reason_code, "INTERNAL.compiler_or_graph_defect");
  assert.equal(outerArtifact.resumable_checkpoint_path, outerOut);
  checks += 6;
} finally {
  fs.rmSync(outerScratch, { recursive: true, force: true });
}

console.log(JSON.stringify({
  status: "PASS",
  checks,
  public_exit_count: inventory.source_exit_counts["scripts/run_excel_inflow_vnext.mjs"],
  delegate_exit_count: inventory.source_exit_counts["scripts/run_user_flow.mjs"],
  public_controller_count: 1,
}, null, 2));
