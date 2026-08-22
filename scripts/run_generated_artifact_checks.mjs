#!/usr/bin/env node
/**
 * mp2-D — generated-artifact register checks.
 *
 * Every generated artifact in assets/generated-artifact-register.json must
 * agree with its writer: either the writer's own verify suite PASSes, or (for
 * artifacts whose check is a recompute-and-compare) the committed bytes equal
 * what the writer would emit now. This runner invokes each artifact's check
 * and PASSes only when ALL of them agree; any disagreement names the stale
 * artifact and its regeneration command.
 *
 * Modes:
 *   node scripts/run_generated_artifact_checks.mjs   # verify (default)
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REGISTER_PATH = path.join(ROOT, "assets", "generated-artifact-register.json");

function sha256Of(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(command, args, timeoutMs) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

// ---- Register integrity ----------------------------------------------------
const registerText = fs.readFileSync(REGISTER_PATH, "utf8");
let register;
try {
  register = JSON.parse(registerText);
} catch (error) {
  console.error(`GENERATED_ARTIFACT_CHECKS_FAIL: register is not valid JSON: ${error.message}`);
  process.exit(1);
}
if (register.schema_version !== "generated-artifact-register/1.0") {
  console.error(
    `GENERATED_ARTIFACT_CHECKS_FAIL: expected schema_version "generated-artifact-register/1.0", got ${JSON.stringify(register.schema_version)}`,
  );
  process.exit(1);
}
if (!Array.isArray(register.artifacts) || register.artifacts.length === 0) {
  console.error("GENERATED_ARTIFACT_CHECKS_FAIL: register.artifacts must be a non-empty array.");
  process.exit(1);
}
for (const artifact of register.artifacts) {
  if (typeof artifact.artifact_path !== "string" || artifact.artifact_path.length === 0) {
    console.error("GENERATED_ARTIFACT_CHECKS_FAIL: every artifact needs artifact_path.");
    process.exit(1);
  }
  if (!artifact.hand_owned && typeof artifact.writer_script !== "string") {
    console.error(
      `GENERATED_ARTIFACT_CHECKS_FAIL: ${artifact.artifact_path} needs writer_script or hand_owned:true.`,
    );
    process.exit(1);
  }
  if (typeof artifact.check_invocation !== "string" || artifact.check_invocation.length === 0) {
    console.error(
      `GENERATED_ARTIFACT_CHECKS_FAIL: ${artifact.artifact_path} needs check_invocation.`,
    );
    process.exit(1);
  }
}

const results = [];
function record(artifactPath, ok, detail) {
  results.push({ artifact_path: artifactPath, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${artifactPath}${detail ? ` — ${detail}` : ""}`);
}

function suiteCheck(artifactPath, command, args, existsPath, timeoutMs = 600_000) {
  const target = path.join(ROOT, existsPath ?? artifactPath.split("#")[0]);
  if (!fs.existsSync(target)) {
    record(artifactPath, false, `artifact missing at ${existsPath ?? artifactPath} — regenerate with the registered writer`);
    return;
  }
  const outcome = run(command, args, timeoutMs);
  record(
    artifactPath,
    outcome.ok,
    outcome.ok
      ? `${command} ${args.join(" ")}`
      : `exit ${outcome.status}${outcome.signal ? ` (${outcome.signal})` : ""}: ${outcome.output.slice(-400)}`,
  );
}

// ---- Per-artifact checks -----------------------------------------------------
for (const artifact of register.artifacts) {
  const artifactPath = artifact.artifact_path;

  // The ci census is checked by recompute-and-compare against its compiler.
  if (artifactPath === "ci/test_registry_census.json") {
    const scratch = path.join(os.tmpdir(), `generated-artifact-census-${process.pid}.json`);
    try {
      const compile = run(
        process.execPath,
        ["scripts/compile_test_registry_census.mjs", "--out", scratch],
        120_000,
      );
      if (!compile.ok) {
        record(artifactPath, false, `compiler failed (exit ${compile.status}): ${compile.output.slice(-300)}`);
      } else {
        const committed = fs.readFileSync(path.join(ROOT, "ci", "test_registry_census.json"));
        const recomputed = fs.readFileSync(scratch);
        record(
          artifactPath,
          committed.equals(recomputed),
          committed.equals(recomputed)
            ? "committed census byte-equals recompiled census"
            : "stale census — regenerate: node scripts/compile_test_registry_census.mjs --out ci/test_registry_census.json",
        );
      }
    } finally {
      fs.rmSync(scratch, { force: true });
    }
    continue;
  }

  // The runtime-manifest identity field is checked structurally here; the
  // closure digest fields are covered by the certified-closure suite entry.
  if (artifactPath === "assets/runtime-manifest.json#skill_version") {
    const manifestPath = path.join(ROOT, "assets", "runtime-manifest.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const skillVersion = manifest.skill_version;
      const ok =
        typeof skillVersion === "string" && /^\d+\.\d+(\.\d+)?/.test(skillVersion);
      record(
        artifactPath,
        ok,
        ok
          ? `skill_version ${skillVersion} present and well-formed`
          : `skill_version missing/malformed (${JSON.stringify(skillVersion)}) — regenerate via the MP2-A release_identity writer`,
      );
    } catch (error) {
      record(artifactPath, false, `manifest unreadable: ${error.message}`);
    }
    continue;
  }

  if (artifactPath === "architecture/ownership_census.json") {
    suiteCheck(artifactPath, process.execPath, ["scripts/run_ownership_census_tests.mjs"]);
  } else if (artifactPath === "assets/runtime-manifest.json") {
    suiteCheck(artifactPath, process.execPath, ["scripts/run_certified_code_closure_tests.mjs"]);
  } else if (artifactPath === "assets/controller-terminal-exit-inventory-v1.json") {
    suiteCheck(artifactPath, process.execPath, ["scripts/run_controller_exit_inventory_tests.mjs"]);
  } else if (artifactPath === "ci/coercion_inventory.json") {
    suiteCheck(artifactPath, process.execPath, ["scripts/run_coercion_ban_tests.mjs"]);
  } else if (artifactPath === "assets/critical-invariant-oracle-matrix-v1.json") {
    suiteCheck(artifactPath, "python3", [
      "scripts/run_critical_invariant_oracle_matrix_tests.py",
      "--verify-bindings",
    ]);
  } else if (artifactPath === "assets/workflow-state-contract-v1.json") {
    suiteCheck(artifactPath, process.execPath, ["scripts/run_workflow_state_tests.mjs"]);
  } else {
    record(artifactPath, false, `no runner branch for this artifact — extend scripts/run_generated_artifact_checks.mjs`);
  }
}

// ---- Verdict -----------------------------------------------------------------
const failed = results.filter((entry) => entry.status === "FAIL");
console.log(
  JSON.stringify({
    status: failed.length === 0 ? "PASS" : "FAIL",
    mode: "verify",
    register_sha256: sha256Of(REGISTER_PATH),
    artifacts_checked: results.length,
    failures: failed.length,
  }),
);
process.exit(failed.length === 0 ? 0 : 1);
