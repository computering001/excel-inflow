#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "controller_exit_inventory_tests", importMetaUrl: import.meta.url });
const ROOT = run.ROOT;
const inventory = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets", "controller-terminal-exit-inventory-v1.json"), "utf8"),
);
const sources = {
  "scripts/run_excel_inflow_bootstrap.mjs": fs.readFileSync(path.join(ROOT, "scripts", "run_excel_inflow_bootstrap.mjs"), "utf8"),
  "scripts/run_excel_inflow_vnext.mjs": fs.readFileSync(path.join(ROOT, "scripts", "run_excel_inflow_vnext.mjs"), "utf8"),
  "scripts/run_user_flow.mjs": fs.readFileSync(path.join(ROOT, "scripts", "run_user_flow.mjs"), "utf8"),
};
for (const [file, expectedKinds] of Object.entries(inventory.source_exit_kinds)) {
  const source = sources[file];
  const actualKinds = file.endsWith("run_excel_inflow_bootstrap.mjs")
    ? {
      artifact_boundary_refusal: (source.match(/bootstrap artifact directory resolves inside the immutable package/g) ?? []).length,
      inventory_integrity_refusal: (source.match(/if \(verification\.findings\.length > 0\)/g) ?? []).length,
      screen_success: (source.match(/if \(companyScreenComplete\(result\.stdout, result\.stderr, result\.code, result\.overflowed\)\)/g) ?? []).length,
      screen_refusal: (source.match(/company_screen_child_failed_or_incomplete/g) ?? []).length,
      child_success_passthrough: (source.match(/if \(result\.code === 0\) return 0/g) ?? []).length,
      child_failure_passthrough: (source.match(/return Number\.isInteger\(result\.code\) \? result\.code : 1/g) ?? []).length,
      generated_child_failure_refusal: (source.match(/child_exited_nonzero:exit=\$\{result\.code\}/g) ?? []).length,
      outer_refusal: (source.match(/process\.exitCode = 1/g) ?? []).length,
    }
    : file.endsWith("run_excel_inflow_vnext.mjs")
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
  run.check(`${file} terminal exit-kind census holds`, () => {
    assert.deepEqual(actualKinds, expectedKinds, `${file} terminal exit-kind census drifted`);
    assert.equal(
      Object.values(actualKinds).reduce((sum, count) => sum + count, 0),
      inventory.source_exit_counts[file],
      `${file} terminal exit total drifted`,
    );
    assert.equal((source.match(/process\.exit\s*\(/g) ?? []).length, 0, `${file} bypasses the typed exit owners`);
    return true;
  });
}
for (const exit of inventory.exits) {
  const file = exit.controller === "bootstrap"
    ? "scripts/run_excel_inflow_bootstrap.mjs"
    : exit.controller === "vnext"
      ? "scripts/run_excel_inflow_vnext.mjs"
      : "scripts/run_user_flow.mjs";
  run.check(`${exit.id} source signature, owner and broker-safety`, () => {
    assert.ok(sources[file].includes(exit.signature), `${exit.id} source signature disappeared`);
    assert.ok(
      ["BLOCK", "ASK", "DEGRADE", "LOG", "DELIVER"].includes(exit.owner),
      `${exit.id} has ambiguous or unregistered owner ${exit.owner}`,
    );
    assert.ok(exit.broker_safe, `${exit.id} is not owned by the optional-broker invariant`);
    return true;
  });
}
run.check("bootstrap controller census equals its exit count", () => {
  assert.equal(
    inventory.exits.filter((exit) => exit.controller === "bootstrap").length,
    inventory.source_exit_counts["scripts/run_excel_inflow_bootstrap.mjs"],
  );
  return true;
});
run.check("vnext controller census equals its exit count", () => {
  assert.equal(
    inventory.exits.filter((exit) => exit.controller === "vnext").length,
    inventory.source_exit_counts["scripts/run_excel_inflow_vnext.mjs"],
  );
  return true;
});
run.check("delegate controller census equals its exit count", () => {
  assert.equal(
    inventory.exits.filter((exit) => exit.controller === "delegate").length,
    inventory.source_exit_counts["scripts/run_user_flow.mjs"],
  );
  return true;
});

const docs = ["SKILL.md", "central-instructions.md", "references/runtime-core.md"]
  .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"));
for (const doc of docs) {
  run.check("operator docs keep the company-screen entry point", () => {
    assert.ok(doc.includes("node scripts/run_excel_inflow_bootstrap.mjs --screen company"));
    assert.ok(!doc.includes("An ordinary production company run invokes only `scripts/run_user_flow.mjs`"));
    return true;
  });
}

// Executable red proof for the internal controller's outer catch. A missing runtime-budget
// document fails before host preflight, so this mutation is quick and cannot
// be confused with a downstream broker/filings failure. It must still emit
// the one typed internal-failure line and the preserved engineering artifact.
const outerScratch = fs.mkdtempSync(path.join(os.tmpdir(), "controller-outer-exit-"));
try {
  const outerOut = path.join(outerScratch, "run");
  const outer = spawnSync(process.execPath, [
    path.join(ROOT, "scripts", "run_excel_inflow_bootstrap.mjs"),
    "--attachment-spec", path.join(outerScratch, "unused-attachment.json"),
    "--out", outerOut,
    "--runtime-budget", path.join(outerScratch, "missing-budget.json"),
  ], { encoding: "utf8", timeout: 30_000 });
  const outerArtifact = JSON.parse(
    fs.readFileSync(path.join(outerOut, "internal-failure.json"), "utf8"),
  );
  run.check("internal outer-catch mutation fails closed", () => {
    assert.equal(outer.status, 1, "internal outer-catch mutation did not fail closed");
    return true;
  });
  run.check("internal outer-catch mutation emits one typed terminal line", () => {
    assert.match(
      outer.stderr,
      /^INTERNAL_FAILURE INTERNAL\.compiler_or_graph_defect:/,
      "internal outer-catch mutation did not emit one typed terminal line",
    );
    return true;
  });
  run.check("public stderr leaks no stack trace", () => {
    assert.ok(!/\n\s+at\s/.test(outer.stderr), "public stderr leaked a stack trace");
    return true;
  });
  run.check("preserved engineering artifact carries the internal-failure schema", () => {
    assert.equal(outerArtifact.schema_version, "excel-inflow-internal-failure/1.0");
    return true;
  });
  run.check("preserved engineering artifact names the defect reason code", () => {
    assert.equal(outerArtifact.reason_code, "INTERNAL.compiler_or_graph_defect");
    return true;
  });
  run.check("preserved engineering artifact keeps the resumable checkpoint", () => {
    assert.equal(outerArtifact.resumable_checkpoint_path, outerOut);
    return true;
  });
} finally {
  fs.rmSync(outerScratch, { recursive: true, force: true });
}

run.finish({
  public_exit_count: inventory.source_exit_counts["scripts/run_excel_inflow_bootstrap.mjs"],
  internal_controller_exit_count: inventory.source_exit_counts["scripts/run_excel_inflow_vnext.mjs"],
  delegate_exit_count: inventory.source_exit_counts["scripts/run_user_flow.mjs"],
  public_controller_count: 1,
});
