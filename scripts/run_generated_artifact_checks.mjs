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
 *   node scripts/run_generated_artifact_checks.mjs --check   # read-only verify
 *   node scripts/run_generated_artifact_checks.mjs           # same default
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
const unsupportedArgs = process.argv.slice(2).filter((arg) => arg !== "--check");
if (unsupportedArgs.length > 0) {
  console.error(`GENERATED_ARTIFACT_CHECKS_FAIL: unsupported arguments: ${unsupportedArgs.join(" ")}`);
  process.exit(1);
}

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
  if (typeof artifact.writer_script !== "string" || artifact.writer_script.length === 0) {
    console.error(
      `GENERATED_ARTIFACT_CHECKS_FAIL: ${artifact.artifact_path} needs a sanctioned writer; hand-owned artifacts must name their generated-bindings writer.`,
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

function suiteCheck(artifact, command, args, existsPath, timeoutMs = 600_000) {
  const artifactPath = artifact.artifact_path;
  const target = path.join(ROOT, existsPath ?? artifactPath.split("#")[0]);
  if (!fs.existsSync(target)) {
    record(artifactPath, false, `artifact missing at ${existsPath ?? artifactPath} — run the writer: ${artifact.writer_script}`);
    return;
  }
  const outcome = run(command, args, timeoutMs);
  record(
    artifactPath,
    outcome.ok,
    outcome.ok
      ? `${command} ${args.join(" ")}`
      : `exit ${outcome.status}${outcome.signal ? ` (${outcome.signal})` : ""}: ${outcome.output.slice(-400)} — run the writer: ${artifact.writer_script}`,
  );
}

function handOwnedBindingCheck(artifact, verifierArgs) {
  const artifactPath = artifact.artifact_path;
  const target = path.join(ROOT, artifactPath);
  if (!fs.existsSync(target)) {
    record(artifactPath, false, `artifact missing — run the writer: ${artifact.writer_script}`);
    return;
  }
  const binding = run(process.execPath, [
    "scripts/write_hand_owned_artifact_bindings.mjs",
    "--check",
    "--artifact",
    artifactPath,
  ], 120_000);
  const verifier = binding.ok
    ? run(process.execPath, verifierArgs, 600_000)
    : { ok: false, status: null, signal: null, output: "independent verifier not run because generated bindings are stale" };
  const ok = binding.ok && verifier.ok;
  record(
    artifactPath,
    ok,
    ok
      ? `generated bindings exactly regenerate; independent verifier PASS (${verifierArgs.join(" ")})`
      : `${binding.ok ? "bindings PASS" : `bindings FAIL: ${binding.output.slice(-350)}`}; ${verifier.ok ? "verifier PASS" : `verifier FAIL: ${verifier.output.slice(-350)}`} — run the writer: ${artifact.writer_script}`,
  );
}

function executionCensusCheck(artifact) {
  const primary = run(process.execPath, ["scripts/run_ci_census_tests.mjs"], 120_000);
  const independent = primary.ok
    ? run(process.execPath, ["scripts/run_gate_side_effect_tests.mjs"], 600_000)
    : { ok: false, output: "independent verifier not run because exact regeneration failed" };
  const ok = primary.ok && independent.ok;
  record(
    artifact.artifact_path,
    ok,
    ok
      ? "read-only substantive regeneration PASS; independent side-effect and drift-mutation verifier PASS"
      : `${primary.ok ? "regeneration PASS" : `regeneration FAIL: ${primary.output.slice(-350)}`}; ${independent.ok ? "independent verifier PASS" : `independent verifier FAIL: ${independent.output.slice(-350)}`} — run the writer: ${artifact.writer_script}`,
  );
}

function releaseIdentityAgreement(root) {
  const manifestPath = path.join(root, "assets", "runtime-manifest.json");
  const identityPath = path.join(root, "assets", "release-identity.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  return {
    agrees:
      manifest.skill_version === identity.version &&
      manifest.release_channel === identity.channel,
    manifest,
    identity,
  };
}

function exactReleaseIdentityCheck(artifact) {
  try {
    const { agrees, manifest, identity } = releaseIdentityAgreement(ROOT);
    if (!agrees) {
      record(
        artifact.artifact_path,
        false,
        `runtime identity ${JSON.stringify({ version: manifest.skill_version, channel: manifest.release_channel })} disagrees with the single declaration ${JSON.stringify({ version: identity.version, channel: identity.channel })} — run the writer: ${artifact.writer_script}`,
      );
      return;
    }
    const independent = run(process.execPath, ["scripts/run_skill_version_declaration_tests.mjs"], 600_000);
    record(
      artifact.artifact_path,
      independent.ok,
      independent.ok
        ? `exact version/channel equality to release-identity; independent declaration verifier PASS`
        : `exact equality PASS but independent verifier failed: ${independent.output.slice(-400)} — run the writer: ${artifact.writer_script}`,
    );
  } catch (error) {
    record(
      artifact.artifact_path,
      false,
      `release identity surfaces are unreadable: ${error.message} — run the writer: ${artifact.writer_script}`,
    );
  }
}

function copyFileIntoRoot(sourceRoot, targetRoot, relative) {
  const source = path.join(sourceRoot, ...relative.split("/"));
  const target = path.join(targetRoot, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function runBindingMutationProof(artifactPath, sourcePaths, verifierPath) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "generated-binding-mutation-"));
  try {
    for (const relative of [artifactPath, ...sourcePaths, verifierPath]) {
      copyFileIntoRoot(ROOT, scratch, relative);
    }
    const invoke = (...args) => run(process.execPath, [
      path.join(ROOT, "scripts", "write_hand_owned_artifact_bindings.mjs"),
      "--root",
      scratch,
      "--artifact",
      artifactPath,
      ...args,
    ], 120_000);
    if (!invoke("--check").ok) return false;

    const target = path.join(scratch, artifactPath);
    const handEdited = JSON.parse(fs.readFileSync(target, "utf8"));
    handEdited._d4_mutation = "unauthorised hand edit";
    fs.writeFileSync(target, `${JSON.stringify(handEdited, null, 2)}\n`, "utf8");
    const staleBody = invoke("--check");
    if (staleBody.ok || !/Run the writer/.test(staleBody.output)) return false;

    if (!invoke("--write").ok || !invoke("--check").ok) return false;
    const source = path.join(scratch, sourcePaths[0]);
    fs.appendFileSync(source, "\n// D4 stale-source mutation\n", "utf8");
    const staleSource = invoke("--check");
    return !staleSource.ok && /Run the writer/.test(staleSource.output);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function runReleaseIdentityMutationProof() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "generated-release-identity-mutation-"));
  try {
    for (const relative of ["assets/release-identity.json", "assets/runtime-manifest.json"]) {
      copyFileIntoRoot(ROOT, scratch, relative);
    }
    const identity = JSON.parse(fs.readFileSync(path.join(scratch, "assets", "release-identity.json"), "utf8"));
    const manifestPath = path.join(scratch, "assets", "runtime-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.skill_version = identity.version === "9.9.9" ? "8.8.8" : "9.9.9";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const mutated = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return (
      mutated.skill_version !== identity.version &&
      /^\d+\.\d+\.\d+$/.test(mutated.skill_version) &&
      releaseIdentityAgreement(scratch).agrees === false
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
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

  // Identity is a generated leaf of the ONE release declaration. A second
  // well-formed-but-different version is drift, not a structural PASS.
  if (artifactPath === "assets/runtime-manifest.json#skill_version") {
    exactReleaseIdentityCheck(artifact);
    continue;
  }

  if (artifactPath === "architecture/ownership_census.json") {
    suiteCheck(artifact, process.execPath, ["scripts/run_ownership_census_tests.mjs"]);
  } else if (artifactPath === "assets/runtime-manifest.json") {
    suiteCheck(artifact, process.execPath, ["scripts/run_certified_code_closure_tests.mjs"]);
  } else if (artifactPath === "assets/controller-terminal-exit-inventory-v1.json") {
    handOwnedBindingCheck(artifact, ["scripts/run_controller_exit_inventory_tests.mjs"]);
  } else if (artifactPath === "ci/execution_test_census.json") {
    executionCensusCheck(artifact);
  } else if (artifactPath === "ci/coercion_inventory.json") {
    suiteCheck(artifact, process.execPath, ["scripts/run_coercion_ban_tests.mjs"]);
  } else if (artifactPath === "assets/critical-invariant-oracle-matrix-v1.json") {
    suiteCheck(artifact, "python3", [
      "scripts/run_critical_invariant_oracle_matrix_tests.py",
      "--verify-bindings",
    ]);
  } else if (artifactPath === "assets/workflow-state-contract-v1.json") {
    handOwnedBindingCheck(artifact, ["scripts/run_workflow_state_tests.mjs"]);
  } else {
    record(artifactPath, false, `no runner branch for this artifact — extend scripts/run_generated_artifact_checks.mjs`);
  }
}

// Targeted non-vacuity: a hand edit and a governed-source edit must both make
// the binding check red until the sanctioned writer is run. The version proof
// uses a different, still-well-formed value so the former structural-only hole
// can never reopen.
const mutationProofs = [
  {
    id: "terminal-inventory-hand-and-source-drift",
    passed: runBindingMutationProof(
      "assets/controller-terminal-exit-inventory-v1.json",
      [
        "scripts/run_excel_inflow_bootstrap.mjs",
        "scripts/run_excel_inflow_vnext.mjs",
        "scripts/run_user_flow.mjs",
      ],
      "scripts/run_controller_exit_inventory_tests.mjs",
    ),
  },
  {
    id: "workflow-contract-hand-and-source-drift",
    passed: runBindingMutationProof(
      "assets/workflow-state-contract-v1.json",
      ["scripts/lib/workflow_state.mjs", "scripts/workflow_state.py"],
      "scripts/run_workflow_state_tests.mjs",
    ),
  },
  {
    id: "well-formed-foreign-skill-version-drift",
    passed: runReleaseIdentityMutationProof(),
  },
];
for (const mutation of mutationProofs) {
  console.log(`${mutation.passed ? "PASS" : "FAIL"}  mutation:${mutation.id}`);
  if (!mutation.passed) {
    results.push({
      artifact_path: `mutation:${mutation.id}`,
      status: "FAIL",
      detail: "the stale/hand-edit mutation survived the D4 check",
    });
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
    registered_surfaces: results.length,
    physical_artifact_files: new Set(
      register.artifacts.map((artifact) => artifact.artifact_path.split("#")[0]),
    ).size,
    mutation_proofs: mutationProofs.length,
    failures: failed.length,
  }),
);
process.exit(failed.length === 0 ? 0 : 1);
