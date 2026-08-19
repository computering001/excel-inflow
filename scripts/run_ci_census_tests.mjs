#!/usr/bin/env node
/**
 * P0.3 — Exact-head CI truthfulness: the machine-generated test census.
 *
 * Invariant: a failed critical test makes the authoritative CI gate fail —
 * which requires that every critical test IS registered, no registry entry
 * points at a missing script, no id is duplicated, and every runnable
 * `run_*` script on disk carries an explicit disposition. A new script with
 * no disposition fails this census; silence is not a classification.
 *
 * The census also emits the toolchain versions the verdict ran under, so a
 * gate report is bound to the interpreter identities that produced it.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const outPath = option("out", path.join(ROOT, "ci", "test_registry_census.json"));

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(`CI_CENSUS_FAIL: ${message}`);
  checks += 1;
}

// Non-registry dispositions. Every entry names WHY the script is lawfully
// outside the registry; the census fails on any script with no row anywhere.
const DISPOSITIONS = {
  // Product/pipeline entry points — they ARE the system under test.
  "run_attachment_evidence_pipeline.py": "PIPELINE_ENTRYPOINT",
  "run_broker_intake.mjs": "PIPELINE_ENTRYPOINT",
  "run_broker_pipeline.py": "PIPELINE_ENTRYPOINT",
  "run_dcs_pipeline.py": "PIPELINE_ENTRYPOINT",
  "run_excel_inflow_vnext.mjs": "PIPELINE_ENTRYPOINT",
  "run_filings_pipeline.mjs": "PIPELINE_ENTRYPOINT",
  "run_user_flow.mjs": "PIPELINE_ENTRYPOINT",
  "run_structural_ownership_preflight.mjs": "PIPELINE_ENTRYPOINT",
  "run_frozen_cohort.mjs": "PIPELINE_ENTRYPOINT",
  // The gate/aggregation machinery itself and checks the CI workflow invokes
  // as first-class steps (their verdicts are asserted by the workflow).
  "run_development_gate.mjs": "CI_GATE_MACHINERY",
  "run_current_package_source_identity_check.mjs": "CI_WORKFLOW_STEP",
  "run_merge_compatibility_identity_check.mjs": "CI_WORKFLOW_STEP",
  "run_governance_evidence_tests.mjs": "CI_WORKFLOW_STEP",
  // Harnesses that require caller-supplied artifacts; they cannot run bare
  // and are exercised via their owning registered suites or manually.
  "run_authority_projection_mutations.mjs": "ARGUMENT_REQUIRED_HARNESS",
  "run_case_compiler_mutation_tests.mjs": "ARGUMENT_REQUIRED_HARNESS",
  "run_real_statement_outcome_regression.mjs": "ARGUMENT_REQUIRED_HARNESS",
  // Suites reachable only through the legacy reviewed gate, which no CI
  // workflow invokes. Explicitly ORPHANED: disposition (register or delete)
  // is Phase 9 (v3.8 code deletion) work unless a case proves them critical.
  "run_reviewed_portable_gate.py": "ORPHANED_LEGACY_GATE",
  "run_broker_native_eligibility_tests.py": "ORPHANED_VIA_LEGACY_GATE",
  "run_broker_selected_cell_recovery_tests.py": "ORPHANED_VIA_LEGACY_GATE",
  "run_source_arithmetic_tests.py": "ORPHANED_VIA_LEGACY_GATE",
  // Bare-runnable green suites with no caller and no registration; recorded
  // as orphans for the same Phase 9 disposition decision.
  "run_broker_tier1_demand_tests.py": "ORPHANED_BARE_RUNNABLE",
  "run_standardised_design_contract_mutations.mjs": "ORPHANED_BARE_RUNNABLE",
};

// The playbook's named critical suites: each MUST resolve to at least one
// registered entry. This is the list P0.3 step 4 demands.
const CRITICAL_REQUIREMENTS = {
  "tax_etr": ["tax-rate-policy"],
  "runtime_deadline": ["run-deadline"],
  "forecast_completion": ["forecast-completion"],
  "period_stitching": ["period-support-stitch"],
  "inline_xbrl_typed_values": ["inline-xbrl-structured-lane"],
  "entity_identity": ["entity-identity"],
  "package_closure": ["release-certification-contract", "immutable-release-package-attestation", "release-identity-governance"],
  "installed_host_receipts": ["installed-host-broker-receipt-contract", "installed-host-usable-broker"],
  "blocker_replay_corpus": ["blocker-replay-corpus"],
};

async function census(registry, scriptNames) {
  const ids = registry.tests.map((test) => test.id);
  check(new Set(ids).size === ids.length, `duplicate registry test ids: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`);
  const registeredScripts = new Set(registry.tests.map((test) => test.script));
  for (const test of registry.tests) {
    // Registered scripts may live in subdirectories (verify/...); existence
    // on disk is the contract, top-level naming is not.
    const exists = scriptNames.has(test.script) ||
      (await fs.access(path.join(ROOT, "scripts", test.script)).then(() => true, () => false));
    check(exists, `registry entry ${test.id} points at missing script ${test.script}`);
  }
  const rows = [];
  for (const name of [...scriptNames].sort()) {
    if (registeredScripts.has(name)) {
      rows.push({ script: name, disposition: "REGISTERED" });
    } else if (DISPOSITIONS[name]) {
      rows.push({ script: name, disposition: DISPOSITIONS[name] });
    } else {
      rows.push({ script: name, disposition: "UNCLASSIFIED" });
    }
  }
  const unclassified = rows.filter((row) => row.disposition === "UNCLASSIFIED");
  check(unclassified.length === 0,
    `unclassified run_* scripts (register them or add an explicit disposition): ${unclassified.map((row) => row.script).join(", ")}`);
  for (const [requirement, candidates] of Object.entries(CRITICAL_REQUIREMENTS)) {
    check(candidates.some((id) => ids.includes(id)),
      `critical requirement ${requirement} has no registered suite (expected one of: ${candidates.join(", ")})`);
  }
  const staleDispositions = Object.keys(DISPOSITIONS).filter(
    (name) => !scriptNames.has(name) || registeredScripts.has(name),
  );
  check(staleDispositions.length === 0,
    `stale dispositions (script gone or now registered): ${staleDispositions.join(", ")}`);
  return rows;
}

const registry = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "development-test-registry.json"), "utf8"),
);
const scriptNames = new Set(
  (await fs.readdir(path.join(ROOT, "scripts")))
    .filter((name) => name.startsWith("run_") && (name.endsWith(".mjs") || name.endsWith(".py"))),
);

const rows = await census(registry, scriptNames);

// Negative self-test: an injected unregistered script MUST fail the census.
{
  const mutated = new Set(scriptNames);
  mutated.add("run_totally_unregistered_tests.mjs");
  let refused = false;
  try {
    await census(registry, mutated);
  } catch (error) {
    refused = String(error.message).includes("unclassified run_* scripts");
  }
  check(refused, "an unregistered, undispositioned script MUST fail the census");
}
// Negative self-test: a duplicated id MUST fail the census.
{
  const mutated = structuredClone(registry);
  mutated.tests.push(structuredClone(mutated.tests[0]));
  let refused = false;
  try {
    await census(mutated, scriptNames);
  } catch (error) {
    refused = String(error.message).includes("duplicate registry test ids");
  }
  check(refused, "a duplicate registry id MUST fail the census");
}

const [nodeVersion, pythonVersion, sofficeVersion] = await Promise.all([
  Promise.resolve(process.version),
  exec(option("python", "python3"), ["--version"]).then((r) => (r.stdout + r.stderr).trim()).catch(() => "UNAVAILABLE"),
  exec(option("soffice", "soffice"), ["--version"]).then((r) => r.stdout.split("\n")[0].trim()).catch(() => "UNAVAILABLE"),
]);
const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], { cwd: ROOT });
const { stdout: tree } = await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: ROOT });

const report = {
  schema_version: "excel-inflow-ci-census/1.0",
  status: "PASS",
  checks,
  source_commit: commit.trim(),
  source_tree: tree.trim(),
  toolchain: { node: nodeVersion, python: pythonVersion, soffice: sofficeVersion },
  registry: { test_count: registry.tests.length },
  scripts: rows,
  critical_requirements: Object.keys(CRITICAL_REQUIREMENTS),
  generated_at_source_identity_only: true,
};
await fs.mkdir(path.dirname(path.resolve(ROOT, outPath)), { recursive: true });
await fs.writeFile(path.resolve(ROOT, outPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: "PASS", checks, scripts: rows.length, out: outPath }));
