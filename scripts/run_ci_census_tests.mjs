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
  // P8.1: the A/B driver needs --out and creates git worktrees; the registered
  // package-ab suite exercises the comparison logic. Not a gate step.
  "run_package_ab_proof.mjs": "ARGUMENT_REQUIRED_HARNESS",
  // P6.7: the doctor CLI is an operator tool reporting host fitness; the
  // registered runtime-doctor suite covers its logic.
  "run_runtime_doctor.mjs": "ARGUMENT_REQUIRED_HARNESS",
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
  // P7.7: the layered gate's tier control. Its DEFAULT mode is its own
  // validating suite (declared tier coverage, deferrals, quarantine
  // owner/expiry); the pull-request gate's gate-tier-declaration job and
  // every scheduled deep-tier job invoke it as a first-class step whose
  // verdict is asserted, exactly like run_governance_evidence_tests.mjs.
  "run_ci_gate_tier_tests.mjs": "CI_WORKFLOW_STEP",
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
  // P6.0a suite committed at e0618e2 with neither registration nor
  // disposition; bare-runnable and green, no caller. Flagged by P7.6a as
  // deserving real registration in the development test registry.
  // Production library modules under scripts/lib whose filenames begin with
  // run_ because they model the "run" domain object (store, carrier,
  // deadline, constitution graph, scoped concepts); imported by the
  // pipeline, never runnable harnesses.
  "lib/run_carrier.mjs": "PRODUCTION_LIBRARY_MODULE",
  "lib/run_constitution_graph.mjs": "PRODUCTION_LIBRARY_MODULE",
  "lib/run_deadline.mjs": "PRODUCTION_LIBRARY_MODULE",
  "lib/run_scoped_broker_concepts.mjs": "PRODUCTION_LIBRARY_MODULE",
  "lib/run_store.mjs": "PRODUCTION_LIBRARY_MODULE",
  // Oracle mutation harnesses in scripts/verify: argument-driven authoring/
  // release harnesses that corrupt disposable artifact copies to prove their
  // owning oracle rejects them; not bare CI suites.
  "verify/run_finance_proof_mutations.py": "ORACLE_MUTATION_HARNESS",
  "verify/run_workbook_semantic_oracle_mutations.py": "ORACLE_MUTATION_HARNESS",
  "verify/run_layered_graph_python_tests.py": "ORACLE_MUTATION_HARNESS",
  // Same-language (JS) positive+mutation proof over a debt-linked add-back;
  // requires a caller-supplied case and imports lib/row_plan.mjs, so it is
  // NOT an independent oracle — census-visible, never registry-credited.
  "verify/run_linked_debt_addback_proof_test.mjs": "ORACLE_MUTATION_HARNESS",
  // Subordinate determinism oracle: consumes caller-built A/B workbooks;
  // invoked by run_frozen_cohort.mjs and the deployment-profile smoke
  // contract, never bare in CI.
  "verify/run_deterministic_tests.py": "SUBORDINATE_ORACLE",
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
// Recursive census: a runnable harness hiding in a subdirectory (verify/,
// lib/, ...) is still a run_* script and MUST carry a classification. Keys
// are scripts/-relative POSIX paths; top-level scripts keep their bare name.
async function collectRunScripts(directory, prefix = "") {
  const names = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      names.push(...(await collectRunScripts(path.join(directory, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.name.startsWith("run_") && (entry.name.endsWith(".mjs") || entry.name.endsWith(".py"))) {
      names.push(`${prefix}${entry.name}`);
    }
  }
  return names;
}
const scriptNames = new Set(await collectRunScripts(path.join(ROOT, "scripts")));

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
// D20 (P0.9): a gate must not mutate the tree it validates. The default path
// VERIFIES the committed census and refuses on drift; regeneration happens only
// under --write, matching run_ownership_census_tests.mjs and the coercion
// inventory. `source_commit`/`source_tree`/`toolchain` are declared-volatile:
// they are recomputed from git HEAD, so a committed census can never match a
// later run byte-for-byte and demanding that would be an unmeetable gate.
const VOLATILE_CENSUS_FIELDS = ["source_commit", "source_tree", "toolchain"];
const WRITE_CENSUS = process.argv.includes("--write");
const resolvedOut = path.resolve(ROOT, outPath);
const substantive = (value) => {
  const copy = { ...value };
  for (const field of VOLATILE_CENSUS_FIELDS) delete copy[field];
  return JSON.stringify(copy, Object.keys(copy).sort());
};
if (WRITE_CENSUS) {
  await fs.mkdir(path.dirname(resolvedOut), { recursive: true });
  await fs.writeFile(resolvedOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
} else {
  const committed = await fs
    .readFile(resolvedOut, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  check(
    committed !== null,
    `the committed census ${outPath} is absent; regenerate it with --write`,
  );
  check(
    substantive(committed) === substantive(report),
    `the committed census ${outPath} disagrees with the computed one on substantive content (script rows, checks, registry or critical requirements). Regenerate it with --write once you have confirmed the change is intended; the gate will not silently rewrite it.`,
  );
  checks += 2;
}
console.log(JSON.stringify({
  status: "PASS",
  checks,
  scripts: rows.length,
  out: outPath,
  mode: WRITE_CENSUS ? "write" : "verify",
}));
