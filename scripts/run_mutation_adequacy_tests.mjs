#!/usr/bin/env node
/**
 * P7.5 — mutation adequacy suite.
 *
 * Validates the compiled mutation-adequacy artifact (ci/mutation_survivors.json)
 * against assets/mutation-adequacy-v1.schema.json and against the honesty rules
 * that make the score mean something. It VALIDATES; it never repairs the artifact
 * and never lowers any suite's mutation assertion.
 *
 * Eleven adversarial mutation families are applied to a COPY of the real
 * artifact and each must be REJECTED:
 *   A. a survivor omitted from the register            -> UNREGISTERED_SURVIVOR
 *   B. a P0 gate member with a survivor still PASSing  -> P0_SURVIVOR_DID_NOT_FAIL_THE_GATE
 *   C. a self-fixture kill counted as production       -> SELF_FIXTURE_COUNTED_AS_PRODUCTION
 *   G-I. F3 survivor-honesty: a suite_failed flag that contradicts its row, a
 *        deflated suite_health, and a mutation_score re-widened past the
 *        product-only/suite-failure-exclusive contract.
 * plus the register's retirement rule (a registered survivor that no longer
 * reproduces must be RETIRED, not left standing) and the no-invented-population
 * rule (a suite reporting no count may not carry killed/survived numbers).
 *
 * Prints one line: {"status":"PASS","checks":N}
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  MEASUREMENT_COVERAGE_FLOOR,
  MUTATION_SCOPES,
  NON_COUNT_MUTATION_FIELD_PATTERN,
  OBSERVED_MUTATION_COUNT_FIELDS,
  auditMutationAdequacy,
  deriveP0InvariantSet,
  extractMutationEvidence,
  isTestSidePath,
  lastJsonLine,
  oracleMatrixSplit,
  productionReachEvidence,
} from "./lib/mutation_adequacy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportIndex = process.argv.indexOf("--report");
if (reportIndex >= 0 && (!process.argv[reportIndex + 1] || process.argv[reportIndex + 1].startsWith("--"))) {
  throw new Error("--report requires an exact mutation-report path.");
}
const ARTIFACT_PATH = reportIndex >= 0
  ? path.resolve(process.argv[reportIndex + 1])
  : path.join(ROOT, "ci", "mutation_survivors.json");
const SCHEMA_PATH = path.join(ROOT, "assets", "mutation-adequacy-v1.schema.json");
const REGISTRY_PATH = path.join(ROOT, "assets", "development-test-registry.json");
const MATRIX_PATH = path.join(ROOT, "assets", "critical-invariant-oracle-matrix-v1.json");

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};
const clone = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// 1. The artifact exists, is generated, and validates
// ---------------------------------------------------------------------------
check(fs.existsSync(ARTIFACT_PATH), "ci/mutation_survivors.json is absent — run scripts/compile_mutation_adequacy.mjs");
check(fs.existsSync(SCHEMA_PATH), "assets/mutation-adequacy-v1.schema.json is absent");
const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

const schemaErrors = validateJsonSchema(artifact, schema);
assert.deepEqual(schemaErrors, [], `the compiled artifact violates its own schema:\n${schemaErrors.join("\n")}`);
checks += 1;

check(artifact.generator === "scripts/compile_mutation_adequacy.mjs", "the artifact must name its generator");
check(/never be hand-written|Editing it by hand/i.test(artifact.never_hand_written), "the artifact must declare that it is generated, never hand-written");

// The unenforced-keyword trap (P1.4): the local validator does not implement
// `not`, so the schema must not rely on it for the owner rules.
check(!JSON.stringify(schema).includes('"not"'), "the schema must not rely on `not`, which scripts/lib/json_schema.mjs does not implement");

// ---------------------------------------------------------------------------
// 2. The score is over the REAL registry corpus and invents nothing
// ---------------------------------------------------------------------------
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
const mutationTests = registry.tests.filter((test) => test.test_class === "mutation");
check(
  artifact.corpus.registry_mutation_suites === mutationTests.length,
  `the artifact claims ${artifact.corpus.registry_mutation_suites} mutation-class suites; the registry declares ${mutationTests.length}`,
);
check(artifact.suites.length === mutationTests.length, "every registry mutation-class suite must appear in the artifact");
const artifactIds = new Set(artifact.suites.map((row) => row.test_id));
for (const test of mutationTests) {
  assert.ok(artifactIds.has(test.id), `registry mutation suite ${test.id} is missing from the artifact`);
}
checks += 1;

const reporting = artifact.suites.filter((row) => row.reports_mutation_count).length;
check(artifact.corpus.suites_reporting_a_mutation_count === reporting, "suites_reporting_a_mutation_count must match the rows");
check(
  Math.abs(artifact.corpus.measurement_coverage - reporting / mutationTests.length) < 1e-4,
  "measurement_coverage must be the computed fraction (to the artifact's 4dp), not a declared constant",
);
check(
  artifact.corpus.measurement_coverage >= MEASUREMENT_COVERAGE_FLOOR,
  `measurement coverage ${artifact.corpus.measurement_coverage} is below the ratchet floor ${MEASUREMENT_COVERAGE_FLOOR} — measurement regressed. Restore the lost count line(s) or follow the raise procedure documented on MEASUREMENT_COVERAGE_FLOOR in scripts/lib/mutation_adequacy.mjs.`,
);
check(
  MEASUREMENT_COVERAGE_FLOOR > 0 && MEASUREMENT_COVERAGE_FLOOR <= 1,
  "the measurement-coverage floor must itself stay within (0, 1]",
);
check(
  artifact.corpus.measurement_coverage < 1 ? artifact.measurement_gaps.length > 0 : true,
  "a measurement coverage below 1 must be explained by at least one enumerated gap",
);
for (const gap of artifact.measurement_gaps) {
  assert.ok(gap.owner && gap.owner !== "UNOWNED", `measurement gap ${gap.test_id} has no owner`);
  assert.ok(gap.pointer && gap.remedy, `measurement gap ${gap.test_id} has no pointer or remedy`);
}
checks += 1;

const killed = artifact.suites.concat(artifact.p0_gate_adjunct_suites ?? []).filter((row) => row.corpus_membership === "registry_mutation_class").reduce((total, row) => total + row.killed, 0);
const survived = artifact.suites.reduce((total, row) => total + row.survived, 0);
check(artifact.score.killed === killed, `published killed ${artifact.score.killed} disagrees with the rows (${killed})`);
check(artifact.score.survived === survived, `published survived ${artifact.score.survived} disagrees with the rows (${survived})`);
check(artifact.score.measured_mutations === killed + survived, "measured_mutations must be killed + survived");
// F3 survivor honesty: the published mutation_score ranges over PRODUCT
// mutants only (never self-fixture) and excludes crashed suites'
// pseudo-survivors, which are reported once as suite_health instead.
const poolForScore = artifact.suites;
const productKilled = poolForScore.filter((row) => row.mutation_scope !== MUTATION_SCOPES.SELF_FIXTURE).reduce((total, row) => total + row.killed, 0);
const productEscapedSurvived = poolForScore
  .filter((row) => row.mutation_scope !== MUTATION_SCOPES.SELF_FIXTURE && row.status !== "FAIL")
  .reduce((total, row) => total + row.survived, 0);
const productMeasured = productKilled + productEscapedSurvived;
check(
  productMeasured === 0
    ? artifact.score.mutation_score === null
    : artifact.score.mutation_score !== null &&
        Math.abs(artifact.score.mutation_score - productKilled / productMeasured) < 1e-4,
  "mutation_score must be the product-only, suite-failure-exclusive ratio computed from the rows, never a literal",
);
const crashedSuites = artifact.suites.concat(artifact.p0_gate_adjunct_suites ?? []).filter((row) => row.status === "FAIL").length;
check(
  artifact.score.suite_health === crashedSuites,
  `suite_health ${artifact.score.suite_health} must equal the number of crashed suites (${crashedSuites})`,
);
check(/UPPER_BOUND/.test(artifact.score.production_mutation_score_qualifier), "production_mutation_score must declare itself an upper bound");

// A suite reporting no count must never carry an invented population.
for (const row of artifact.suites) {
  if (!row.reports_mutation_count) {
    assert.equal(row.declared_mutations, null, `${row.test_id} reports no count yet declares a population`);
    assert.equal(row.killed, 0, `${row.test_id} reports no count yet claims kills`);
  }
}
checks += 1;

// ---------------------------------------------------------------------------
// 3. The audit accepts the real artifact
// ---------------------------------------------------------------------------
const cleanViolations = auditMutationAdequacy(artifact);
assert.deepEqual(cleanViolations, [], `the compiled artifact fails its own audit:\n${cleanViolations.join("\n")}`);
checks += 1;

// ---------------------------------------------------------------------------
// 4. Survivor register discipline
// ---------------------------------------------------------------------------
for (const row of artifact.suites.concat(artifact.p0_gate_adjunct_suites ?? [])) {
  if (row.survived > 0) {
    const entry = (artifact.survivors ?? []).find((candidate) => candidate.test_id === row.test_id);
    assert.ok(entry, `${row.test_id} has surviving mutations and no register entry`);
    assert.ok(entry.owner && entry.owner !== "UNOWNED", `survivor ${entry.survivor_id} has no owner`);
    assert.ok(entry.pointer, `survivor ${entry.survivor_id} has no pointer`);
    assert.equal(entry.disposition, "OPEN", `survivor ${entry.survivor_id} must be OPEN`);
  }
}
checks += 1;
for (const entry of artifact.survivors ?? []) {
  const row = artifact.suites.concat(artifact.p0_gate_adjunct_suites ?? []).find((candidate) => candidate.test_id === entry.test_id);
  assert.ok(row && row.survived > 0, `registered survivor ${entry.survivor_id} no longer reproduces and must be RETIRED`);
  // F3: a register entry must classify itself — crashed suite (custody debt,
  // counted in suite_health) or escaped product mutant (mutation_score) — and
  // the classification must agree with the row's terminal status.
  assert.ok(typeof entry.suite_failed === "boolean", `survivor ${entry.survivor_id} carries no boolean suite_failed flag`);
  assert.equal(
    entry.suite_failed,
    row.status === "FAIL",
    `survivor ${entry.survivor_id} suite_failed=${entry.suite_failed} contradicts its row status ${row.status}`,
  );
}
checks += 1;
check(/RETIRED|retire/i.test(artifact.survivor_doctrine), "the survivor doctrine must state the retirement rule");
check(Array.isArray(artifact.retired_survivors), "retired_survivors must exist even when empty");

// ---------------------------------------------------------------------------
// 5. The zero-survivor gate has real members and a real rule
// ---------------------------------------------------------------------------
const gate = artifact.zero_survivor_gate;
check(gate.member_count >= 1 && gate.member_ids.length === gate.member_count, "a gate with no members is decorative");
check(gate.member_ids.length === gate.members.length, "gate member_ids and members must agree");
check(["PASS", "PASS_WITH_UNPROVEN_MEMBERS", "FAIL"].includes(gate.status), "gate status must be one of the three declared values");
const gateSurvivorCount = gate.members.reduce((total, member) => total + member.survived, 0);
check(
  gateSurvivorCount > 0 ? gate.status === "FAIL" : gate.status !== "FAIL",
  "gate status must follow from its members' survivors",
);
check(
  gate.members.every((member) => member.source === "parsed_from_p0_issue_card" || member.source === "derived_from_oracle_matrix_artifact_scope"),
  "every gate member must name how it entered the gate",
);
check(artifact.p0_invariant_set.derivation.length >= 1, "the gate derivation must be declared, not implicit");
check(
  artifact.p0_invariant_set.invariants.length >= 1 && artifact.p0_invariant_set.explicit_p0_set_exists === true,
  "the P0 invariant set must be read from the programme, not invented",
);
// A NOT_INDEPENDENTLY_PROVEN domain can never gate a P0 invariant.
if (fs.existsSync(MATRIX_PATH)) {
  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, "utf8"));
  const syntheticOracles = new Set();
  for (const domain of matrix.domains ?? []) {
    if (domain.independence === "NOT_INDEPENDENTLY_PROVEN") {
      for (const id of domain.independent_oracle_test_ids ?? []) syntheticOracles.add(id);
    }
  }
  const derived = new Set(artifact.p0_invariant_set.gate_members_derived);
  for (const id of syntheticOracles) {
    assert.ok(!derived.has(id), `${id} proves only NOT_INDEPENDENTLY_PROVEN domains and must not be a derived gate member`);
  }
  checks += 1;

  const split = oracleMatrixSplit(matrix);
  check(split.self_fixture_mutations >= 1, "the oracle matrix split must account for the synthetic domains P7.6a marked");
  check(
    split.production_domains.every((domain) => domain.independence !== "NOT_INDEPENDENTLY_PROVEN"),
    "no NOT_INDEPENDENTLY_PROVEN domain may land in the production half of the split",
  );
}

// ---------------------------------------------------------------------------
// 6. Scope split: a self-fixture mutation is never production coverage
// ---------------------------------------------------------------------------
const selfRows = artifact.suites.filter((row) => row.mutation_scope === MUTATION_SCOPES.SELF_FIXTURE);
const productionRows = artifact.suites.filter(
  (row) => row.mutation_scope === MUTATION_SCOPES.PRODUCTION_MODULE || row.mutation_scope === MUTATION_SCOPES.PRODUCTION_ARTIFACT,
);
check(
  artifact.score.breakdown.self_fixture_only.suites === selfRows.length,
  "the self-fixture bucket must contain exactly the self-fixture rows",
);
check(
  artifact.score.breakdown.production_module_or_artifact.killed === productionRows.reduce((total, row) => total + row.killed, 0),
  "the production bucket's kills must come only from production-scope rows",
);
check(
  selfRows.every((row) => row.production_modules_loaded === 0),
  "a row classified self_fixture_only must load no production module",
);
check(isTestSidePath("scripts/verify/oracle_independence.py"), "scripts/verify is test-side: importing an independent oracle proves no production reach");
check(!isTestSidePath("scripts/lib/solver.mjs"), "scripts/lib is production");
check(isTestSidePath("scripts/run_formula_ast_tests.mjs"), "a harness is test-side");

// ---------------------------------------------------------------------------
// 7. Extraction: field-name vocabulary, no double counting, no invented zeros
// ---------------------------------------------------------------------------
check(OBSERVED_MUTATION_COUNT_FIELDS.length >= 15, "the field-name inventory must be populated, not a stub");
check(NON_COUNT_MUTATION_FIELD_PATTERN.test("mutation_detection_rate"), "a detection RATE is not a mutation count");
check(!NON_COUNT_MUTATION_FIELD_PATTERN.test("mutations_caught"), "mutations_caught is a count");

check(extractMutationEvidence({ status: "PASS", checks: 12 }).reported === false, "a bare PASS reports no mutation population");
check(extractMutationEvidence({ status: "PASS", checks: 12 }).declared_mutations === null, "an unreported population must be null, never 0");
check(extractMutationEvidence({ status: "PASS", checks: 12, mutations_rejected: 4 }).declared_mutations === 4, "a single count field is the population");
// The real double-count shapes observed in the corpus.
check(
  extractMutationEvidence({ mutations: [1, 2, 3, 4, 5, 6, 7, 8], mutations_rejected: 8 }).declared_mutations === 8,
  "`mutations` array plus `mutations_rejected` for one population must not be summed to 16",
);
check(
  extractMutationEvidence({ adversarial_mutations: 10, mutations: new Array(10).fill({}) }).declared_mutations === 10,
  "an alias family equal to the base population must be collapsed, not summed",
);
check(
  extractMutationEvidence({ mutations_total: 22, mutations_detected: 22, governance_mutations_caught: 5 }).declared_mutations === 27,
  "a genuinely disjoint family must stay additive",
);
check(
  extractMutationEvidence({ mutations_total: 22, mutation_detection_rate: 1.0 }).declared_mutations === 22,
  "a rate must not be added to a count",
);
check(lastJsonLine('noise\n{"status":"PASS","mutations_caught":3}\n') !== null, "the last JSON line is the report line");
check(lastJsonLine("{'status': 'PASS', 'mutations': 4}") === null, "a Python dict repr is not a parseable report line");

// Static reach classification actually reads the tree.
const reach = productionReachEvidence({
  source: 'import { solver } from "./lib/solver.mjs";',
  scriptRelPath: "scripts/run_x_tests.mjs",
  exists: (relativePath) => fs.existsSync(path.join(ROOT, relativePath)),
});
check(reach.scope === MUTATION_SCOPES.PRODUCTION_MODULE, "a production library import is production reach");
check(/NECESSARY_NOT_SUFFICIENT/.test(reach.evidence_strength), "production reach must declare itself necessary-not-sufficient");
const noReach = productionReachEvidence({
  source: "const fixture = { a: 1 };",
  scriptRelPath: "scripts/run_y_tests.mjs",
  exists: () => false,
});
check(noReach.scope === MUTATION_SCOPES.SELF_FIXTURE, "a suite touching nothing but its own literals is self-fixture");

// ---------------------------------------------------------------------------
// 8. P0 derivation is parsed, not invented
// ---------------------------------------------------------------------------
const parsed = deriveP0InvariantSet({
  index: { sealed_packages: { "P0.9": { invariant: "synthetic probe", commit: "deadbee" } } },
  issueCards: { "P0.9": "- Active invariant: x\n- Focused failing test ID: formula-ast (registered; 3 checks)\n" },
  registryIds: new Set(["formula-ast"]),
  mutationIds: new Set(["formula-ast"]),
  matrix: null,
});
check(parsed.gate_members_parsed.includes("formula-ast"), "a focused test id named by a P0 card must become a gate member");
const unparsed = deriveP0InvariantSet({
  index: { sealed_packages: { "P0.9": { invariant: "x" } } },
  issueCards: { "P0.9": "- Focused failing test ID: n/a (discovery package)\n" },
  registryIds: new Set(["formula-ast"]),
  mutationIds: new Set(["formula-ast"]),
  matrix: null,
});
check(unparsed.gate_members_parsed.length === 0, "an n/a focused-test line must yield no gate member");
check(
  unparsed.p0_invariants_without_mutation_prover.some((entry) => entry.package_id === "P0.9"),
  "a P0 invariant with no mutation-class prover must be reported as a hole",
);

// ---------------------------------------------------------------------------
// 9. ADVERSARIAL MUTATIONS — each must be REJECTED by the audit
// ---------------------------------------------------------------------------
const mutationsCaught = {};
function mutationMustBeRejected(id, mutate, expected) {
  const candidate = clone(artifact);
  mutate(candidate);
  const violations = auditMutationAdequacy(candidate);
  const hit = violations.some((violation) => violation.includes(expected));
  assert.ok(
    hit,
    `mutation "${id}" escaped the audit: expected a ${expected} violation, got ${violations.length ? violations.join("; ") : "no violations at all"}`,
  );
  mutationsCaught[id] = true;
  checks += 1;
}

// A. a survivor dropped from the register.
mutationMustBeRejected(
  "survivor_omitted_from_the_register",
  (candidate) => {
    const row = candidate.suites.find((entry) => entry.survived > 0) ?? candidate.suites[0];
    row.survived = Math.max(1, row.survived);
    row.measurement = "SURVIVOR";
    candidate.survivors = [];
    resyncBuckets(candidate);
  },
  "UNREGISTERED_SURVIVOR",
);

// A'. the register kept past its repair.
mutationMustBeRejected(
  "stale_survivor_left_standing",
  (candidate) => {
    candidate.survivors = [
      {
        survivor_id: "formula-ast::suite-failure",
        test_id: "formula-ast",
        owner: "release-proof",
        pointer: "scripts/run_formula_ast_tests.mjs",
        survived_mutations: 1,
        count_basis: "UNKNOWN_POPULATION_FLOORED_AT_1",
        disposition: "OPEN",
      },
      ...candidate.survivors,
    ];
  },
  "STALE_SURVIVOR_MUST_BE_RETIRED",
);

// A''. a survivor with no owner.
mutationMustBeRejected(
  "survivor_without_an_owner",
  (candidate) => {
    if (candidate.survivors.length === 0) {
      const row = candidate.suites[0];
      row.survived = 1;
      row.measurement = "SURVIVOR";
      resyncBuckets(candidate);
      candidate.survivors = [{ survivor_id: `${row.test_id}::x`, test_id: row.test_id, pointer: row.script, owner: "UNOWNED", survived_mutations: 1, count_basis: "UNKNOWN_POPULATION_FLOORED_AT_1", disposition: "OPEN" }];
    } else {
      candidate.survivors[0].owner = "UNOWNED";
    }
  },
  "SURVIVOR_WITHOUT_OWNER",
);

// B. a P0 gate member with a survivor, gate still claiming PASS.
mutationMustBeRejected(
  "p0_survivor_does_not_fail_the_gate",
  (candidate) => {
    const memberId = candidate.zero_survivor_gate.member_ids[0];
    const pool = candidate.suites.concat(candidate.p0_gate_adjunct_suites ?? []);
    const row = pool.find((entry) => entry.test_id === memberId);
    row.survived = 1;
    row.measurement = "SURVIVOR";
    candidate.survivors = [
      ...candidate.survivors,
      {
        survivor_id: `${memberId}::suite-failure`,
        test_id: memberId,
        owner: row.owner,
        pointer: row.script,
        survived_mutations: 1,
        count_basis: "UNKNOWN_POPULATION_FLOORED_AT_1",
        disposition: "OPEN",
      },
    ];
    candidate.zero_survivor_gate.status = "PASS";
    resyncBuckets(candidate);
  },
  "P0_SURVIVOR_DID_NOT_FAIL_THE_GATE",
);

// C. a self-fixture kill smuggled into the production bucket.
mutationMustBeRejected(
  "self_fixture_kill_counted_as_production_coverage",
  (candidate) => {
    const selfKilled = candidate.suites
      .filter((entry) => entry.mutation_scope === MUTATION_SCOPES.SELF_FIXTURE)
      .reduce((total, entry) => total + entry.killed, 0);
    assert.ok(selfKilled > 0, "the real artifact must carry at least one self-fixture kill for this mutation to be meaningful");
    candidate.score.breakdown.production_module_or_artifact.killed += selfKilled;
    candidate.score.breakdown.self_fixture_only.killed -= selfKilled;
  },
  "SELF_FIXTURE_COUNTED_AS_PRODUCTION",
);

// D. an invented population on a suite that reports nothing.
mutationMustBeRejected(
  "invented_population_on_an_unreporting_suite",
  (candidate) => {
    const row = candidate.suites.find((entry) => entry.measurement === "UNREPORTED_POPULATION");
    row.killed = 7;
    resyncBuckets(candidate);
  },
  "INVENTED_POPULATION",
);

// E. a bucket suite count quietly padded.
mutationMustBeRejected(
  "production_bucket_suite_count_inflated",
  (candidate) => {
    candidate.score.breakdown.production_module_or_artifact.suites += 3;
  },
  "BUCKET_SUITE_COUNT_MISMATCH",
);

// F. the gate failing without a P0 survivor (a gate that cries wolf is also wrong).
mutationMustBeRejected(
  "gate_fails_without_a_p0_survivor",
  (candidate) => {
    candidate.zero_survivor_gate.status = "FAIL";
  },
  "GATE_FAILED_WITHOUT_A_P0_SURVIVOR",
);

// G. a register entry whose suite_failed flag lies about its row: a crashed
//    suite repainted as a completing suite (or vice versa) conflates custody
//    debt with escaped product behaviour.
mutationMustBeRejected(
  "suite_failed_flag_contradicts_the_row",
  (candidate) => {
    if (candidate.survivors.length > 0) {
      candidate.survivors[0].suite_failed = !candidate.survivors[0].suite_failed;
      return;
    }
    const row = candidate.suites[0];
    row.survived = Math.max(1, row.survived);
    row.measurement = "SURVIVOR";
    resyncBuckets(candidate);
    candidate.survivors = [
      { survivor_id: `${row.test_id}::x`, test_id: row.test_id, pointer: row.script, owner: row.owner || "release-proof", survived_mutations: 1, count_basis: "UNKNOWN_POPULATION_FLOORED_AT_1", suite_failed: row.status !== "FAIL", disposition: "OPEN" },
    ];
  },
  "SUITE_FAILED_FLAG_CONTRADICTS_ROW_STATUS",
);

// H. suite_health quietly deflated so crashing suites disappear from the
//    health ledger while their floored pseudo-survivors stay out of the score.
mutationMustBeRejected(
  "suite_health_deflated",
  (candidate) => {
    candidate.score.suite_health = Math.max(0, candidate.score.suite_health - 1);
  },
  "SUITE_HEALTH_COUNT_MISMATCH",
);

// I. mutation_score re-widened past its product-only, suite-failure-exclusive
//    contract (e.g. back to the old all-bucket ratio that let crashed suites
//    drag product coverage).
mutationMustBeRejected(
  "mutation_score_rewidenened_past_product_exclusive_contract",
  (candidate) => {
    candidate.score.mutation_score =
      candidate.score.mutation_score === null ? 0 : Math.max(0, candidate.score.mutation_score - 0.0002);
  },
  "MUTATION_SCORE_NOT_PRODUCT_EXCLUSIVE",
);

function resyncBuckets(candidate) {
  const recompute = (predicate) => {
    const rows = candidate.suites.filter(predicate);
    return {
      suites: rows.length,
      suites_reporting_a_count: rows.filter((row) => row.reports_mutation_count).length,
      measured_mutations: rows.reduce((total, row) => total + row.killed + row.survived, 0),
      killed: rows.reduce((total, row) => total + row.killed, 0),
      survived: rows.reduce((total, row) => total + row.survived, 0),
      score: null,
    };
  };
  candidate.score.breakdown.production_module_or_artifact = recompute(
    (row) => row.mutation_scope === MUTATION_SCOPES.PRODUCTION_MODULE || row.mutation_scope === MUTATION_SCOPES.PRODUCTION_ARTIFACT,
  );
  candidate.score.breakdown.self_fixture_only = recompute((row) => row.mutation_scope === MUTATION_SCOPES.SELF_FIXTURE);
  candidate.score.breakdown.mixed_per_domain = recompute((row) => row.mutation_scope === "mixed_per_domain");
  candidate.score.measured_mutations = Object.values(candidate.score.breakdown).reduce(
    (total, entry) => total + entry.killed + entry.survived,
    0,
  );
}

check(Object.keys(mutationsCaught).length === 11, `all eleven adversarial mutations must be caught; caught ${Object.keys(mutationsCaught).length}`);

// ---------------------------------------------------------------------------
// 10. Negative self-test: the audit must not be vacuously green
// ---------------------------------------------------------------------------
const vacuous = auditMutationAdequacy({ suites: [], survivors: [], zero_survivor_gate: {}, score: null });
check(vacuous.some((violation) => violation.startsWith("MISSING_SCOPE_BUCKET")), "an artifact with no buckets must not audit clean");

process.stdout.write(`${JSON.stringify({ status: "PASS", checks })}\n`);
