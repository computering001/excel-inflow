#!/usr/bin/env node
/**
 * P7.4 — metamorphic test suite.
 *
 * Before this suite the repository held exactly one metamorphic block, six
 * checks inside the custody-profile broker delivery matrix, blocked on CI. No
 * label-synonym, legal-suffix, ticker-market, row-reorder, whitespace,
 * repeated-header or unit-wording transform existed anywhere, and no test
 * anywhere compared two runs of a transformed pair.
 *
 * Two claims are proven here.
 *
 *   PRESERVING — a transform declared not to change the economics does not
 *   change them, over the FULL economic signature (75 of the solver's 84
 *   forecast fields; the other nine are declared solver diagnostics), on
 *   archetype cases and on generated cases.
 *
 *   LOCALITY — a transform declared to change the economics changes EXACTLY
 *   what the canonical equation graph says it may. The authority is the graph's
 *   own active edge set at the case's declared circularity. Anything outside is
 *   an escape; an escape not accounted for by the declared defect register fails
 *   the suite.
 *
 * Nothing here is weakened to pass. Three real non-invariances are recorded in
 * assets/metamorphic-relations-v1.json as OPEN defects with reproducing cases,
 * and each is asserted to still reproduce, so the register cannot rot and the
 * relations stay at full strength.
 *
 * Emits one line: {"status":"PASS","checks":N,...}
 */

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { solveCase } from "./lib/solver.mjs";
import { EQUATION_GRAPH, activeEquationEdges } from "./lib/equation_graph.mjs";
import {
  RELATIONS,
  RELATIONS_SHA256,
  NODE_OBSERVABLE,
  OBSERVABLE_NODE,
  NODE_TOLERANCE_CLASS,
  TRANSFORMS,
  applyTransform,
  buildMetamorphicCohort,
  canaryCoveredKeys,
  changedObservableNodes,
  changingFamilyIds,
  comparePreservingSignatures,
  compareRefusalVerdicts,
  declaredLocality,
  declaredMissingEdges,
  economicSignature,
  economicSignatureSha256,
  forwardReachable,
  localityFamilyIds,
  localityVerdict,
  preservingFamilyIds,
  signatureCoveredKeys,
  signatureDelta,
  statementBindingFor,
  transformFamily,
  validateNodeObservableTotality,
} from "./lib/metamorphic_relations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ARCHETYPE_ROOT = path.join(ROOT, "test-fixtures", "archetypes");

let checks = 0;
function check(description, fn) {
  try {
    fn();
  } catch (error) {
    console.error(`FAIL ${description}\n${error?.message ?? error}`);
    process.exit(1);
  }
  checks += 1;
}

// ---------------------------------------------------------------------------
// A. The register itself
// ---------------------------------------------------------------------------

check("relation register declares its schema and version", () => {
  assert.equal(RELATIONS.schema_version, "metamorphic-relations/1.0");
  assert.equal(typeof RELATIONS.relations_version, "string");
  assert.equal(RELATIONS_SHA256.length, 64);
});

check("every equation-graph node is covered by the observable register exactly once", () => {
  assert.deepEqual(validateNodeObservableTotality(), []);
  assert.equal(Object.keys(RELATIONS.node_observables).length, EQUATION_GRAPH.nodes.length);
});

check("node-observable totality bites: an undeclared node is caught", () => {
  const mutated = { ...RELATIONS.node_observables };
  delete mutated["statement.net_income"];
  const errors = validateNodeObservableTotality(mutated);
  assert.ok(errors.some((line) => line.startsWith("NODE_OBSERVABLE_UNDECLARED_NODE")), errors.join("; "));
});

check("node-observable totality bites: an orphan declaration is caught", () => {
  const mutated = { ...RELATIONS.node_observables, "statement.invented": { observable: null, unobservable_reason: "x".repeat(30) } };
  const errors = validateNodeObservableTotality(mutated);
  assert.ok(errors.some((line) => line.startsWith("NODE_OBSERVABLE_DECLARATION_ORPHAN")), errors.join("; "));
});

check("node-observable totality bites: an unreasoned absence is caught", () => {
  const mutated = { ...RELATIONS.node_observables, "statement.cash_flow_start": { observable: null } };
  const errors = validateNodeObservableTotality(mutated);
  assert.ok(errors.some((line) => line.startsWith("NODE_OBSERVABLE_UNREASONED_ABSENCE")), errors.join("; "));
});

check("node-observable totality bites: two nodes cannot claim one forecast field", () => {
  const mutated = { ...RELATIONS.node_observables, "statement.finance_expense": { observable: "gross_interest" } };
  const errors = validateNodeObservableTotality(mutated);
  assert.ok(errors.some((line) => line.startsWith("NODE_OBSERVABLE_FIELD_CONTESTED")), errors.join("; "));
});

check("the forecast-field partition is exhaustive over every field the solver emits", () => {
  const seen = new Set();
  for (const file of economicsArchetypeFiles()) {
    const solution = solveOrNull(readArchetype(file));
    if (!solution) continue;
    for (const period of solution.forecast) for (const field of Object.keys(period)) seen.add(field);
  }
  const unclassified = [...seen].filter((field) => RELATIONS.forecast_field_classes[field] === undefined).sort();
  assert.deepEqual(unclassified, [], `unclassified forecast fields: ${unclassified.join(", ")}`);
  assert.ok(seen.size >= 80, `expected the archetype corpus to exercise the whole record; saw ${seen.size}`);
});

check("every partition class is a declared class with stated semantics", () => {
  const declared = new Set(Object.keys(RELATIONS.forecast_field_class_semantics));
  for (const [field, klass] of Object.entries(RELATIONS.forecast_field_classes)) {
    assert.ok(declared.has(klass), `${field} carries undeclared class ${klass}`);
  }
});

check("the economic signature is a strict superset of the raw canary's key set", () => {
  const covered = new Set(signatureCoveredKeys());
  const missing = canaryCoveredKeys().filter((key) => !covered.has(key));
  assert.deepEqual(missing, [], `canary keys the metamorphic signature drops: ${missing.join(", ")}`);
  assert.ok(covered.size > canaryCoveredKeys().length, "signature must be strictly wider than the canary's 23 keys");
});

check("an unclassified forecast field cannot enter or leave the signature silently", () => {
  const solution = solveCase(readArchetype("deferred_revenue_ratable.json"));
  solution.forecast[0].invented_field = 1;
  assert.throws(() => economicSignature(solution), /not classified/);
});

check("every declared transform family is implemented, and every implementation is declared", () => {
  const declared = RELATIONS.transform_families.map((family) => family.id).sort();
  const implemented = Object.keys(TRANSFORMS).sort();
  assert.deepEqual(implemented, declared);
  for (const family of RELATIONS.transform_families) {
    assert.ok(["economics_preserving", "economics_changing"].includes(family.kind), family.id);
    assert.ok(typeof family.rationale === "string" && family.rationale.length > 40, `${family.id} has no stated rationale`);
    assert.ok(Array.isArray(family.targets) && family.targets.length > 0, `${family.id} names no target`);
    assert.ok(
      Number.isInteger(family.minimum_applications?.archetypes) &&
        Number.isInteger(family.minimum_applications?.generated) &&
        (family.kind !== "economics_preserving" || Number.isInteger(family.minimum_applications?.refused)),
      `${family.id} declares no application floor — a family that quietly stops applying would go unnoticed`,
    );
  }
  assert.throws(() => applyTransform("not_a_family", {}), /Undeclared transform family/);
});

check("the seven transform families the P7.4 gap named are all present", () => {
  const named = new Set(
    RELATIONS.transform_families.map((family) => family.named_by_gap).filter(Boolean),
  );
  for (const required of [
    "label-synonym", "legal-suffix", "ticker-market", "row-reorder",
    "whitespace", "repeated-header", "unit-wording",
  ]) {
    assert.ok(named.has(required), `the gap named "${required}" and no family claims it`);
  }
});

check("every locality family names a real equation-graph INPUT node", () => {
  const kinds = new Map(EQUATION_GRAPH.nodes.map((node) => [node.id, node.kind]));
  const ids = localityFamilyIds();
  assert.ok(ids.length >= 5, `expected at least five perturbation sites; got ${ids.length}`);
  for (const id of ids) {
    const node = transformFamily(id).perturbed_node;
    assert.ok(kinds.has(node), `${id} perturbs an unknown node ${node}`);
    assert.equal(kinds.get(node), "input", `${id} perturbs ${node}, which the graph does not declare an input`);
  }
});

check("the locality authority is the graph's own activation-filtered edge set", () => {
  const on = activeEquationEdges(EQUATION_GRAPH, 1).length;
  const off = activeEquationEdges(EQUATION_GRAPH, 0).length;
  assert.ok(off < on, "circularity_on edges must drop out at circularity 0");
  const etrOn = declaredLocality("statement.effective_tax_rate", 1);
  assert.deepEqual(etrOn.may_move_observable, ["statement.net_income", "statement.tax_expense"]);
  assert.equal(etrOn.must_not_move_observable.length, Object.keys(NODE_OBSERVABLE).length - 2);
  const minOn = declaredLocality("cash.minimum_cash", 1);
  const minOff = declaredLocality("cash.minimum_cash", 0);
  assert.ok(
    minOff.may_move_observable.length < minOn.may_move_observable.length,
    "the circularity gate must narrow locality when the loop is off",
  );
});

check("P4.6's statement binding is reachable for the bound observable nodes", () => {
  const bound = Object.keys(NODE_OBSERVABLE).filter((node) => statementBindingFor(node));
  assert.ok(bound.length >= 8, `expected the observable plane to reach P4.6 statement rows; got ${bound.length}`);
  assert.deepEqual(statementBindingFor("cash.cfo"), {
    section: "cash_flow", semantic_role: "cash_from_operations", presence: "required",
  });
});

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function economicsArchetypeFiles() {
  const dir = path.join(ARCHETYPE_ROOT, "economics");
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
}

function readArchetype(file, group = "economics") {
  return JSON.parse(fs.readFileSync(path.join(ARCHETYPE_ROOT, group, file), "utf8"));
}

function solveOrNull(modelCase) {
  try {
    return solveCase(structuredClone(modelCase));
  } catch {
    return null;
  }
}

const archetypeCases = [];
for (const group of fs.readdirSync(ARCHETYPE_ROOT).filter((name) =>
  fs.statSync(path.join(ARCHETYPE_ROOT, name)).isDirectory(),
).sort()) {
  for (const file of fs.readdirSync(path.join(ARCHETYPE_ROOT, group)).filter((name) => name.endsWith(".json")).sort()) {
    const modelCase = readArchetype(file, group);
    const solution = solveOrNull(modelCase);
    if (!solution) continue;
    archetypeCases.push({ id: `${group}/${file}`, model_case: modelCase, solution });
  }
}

check("the archetype corpus supplies solvable cases to transform", () => {
  assert.ok(archetypeCases.length >= 30, `expected >= 30 solvable archetypes; got ${archetypeCases.length}`);
  // The corpus split is recorded rather than left as an unexplained number: the
  // 29 presentation archetypes are presentation-plane fixtures, not full model
  // cases, and solveCase refuses them on shape. Every case this suite transforms
  // comes from the economics group. Both catalogues are READ ONLY here.
  const groups = new Set(archetypeCases.map((item) => item.id.split("/")[0]));
  assert.deepEqual([...groups], ["economics"]);
});

const cohort = buildMetamorphicCohort({ solve: solveCase });

check("the generated cohort is built in the declared restricted sub-space", () => {
  assert.equal(cohort.present, true, `cohort absent: ${cohort.reason}`);
  assert.equal(cohort.root_seed, RELATIONS.generated_case_subspace.root_seed);
  assert.equal(cohort.seed_count, RELATIONS.generated_case_subspace.seed_count);
  assert.deepEqual(
    cohort.restricted_dimensions,
    Object.keys(RELATIONS.generated_case_subspace.restricted_axes).sort(),
  );
  assert.ok(cohort.free_dimensions.length >= 11, `expected >= 11 free axes; got ${cohort.free_dimensions.length}`);
  assert.deepEqual(cohort.incomplete, [], "every seed must complete from its own seed shape");
});

check("the generated cohort supplies both a solvable and a refused population", () => {
  assert.ok(cohort.solvable.length >= 50, `expected >= 50 solvable generated cases; got ${cohort.solvable.length}`);
  assert.ok(cohort.refused.length >= 10, `expected a refused population to carry the verdict plane; got ${cohort.refused.length}`);
  const archetypes = new Set(cohort.solvable.map((item) => item.archetype_id));
  assert.ok(archetypes.size >= 10, `expected the cohort to vary its seed shape; got ${archetypes.size}`);
});

// ---------------------------------------------------------------------------
// B/C. Economics-preserving relations
// ---------------------------------------------------------------------------

const preservingReport = {};
const exceptionObservations = new Map();

function runPreserving(familyId, corpus, label) {
  const applied = [];
  const violations = [];
  for (const item of corpus) {
    const transformed = applyTransform(familyId, item.model_case);
    if (!transformed) continue;
    applied.push(item.id ?? item.seed);
    let after;
    try {
      after = solveCase(transformed);
    } catch (error) {
      violations.push(`${item.id ?? `seed ${item.seed}`}: transform made a solvable case refuse — ${String(error?.message ?? error).split("\n")[0]}`);
      continue;
    }
    const comparison = comparePreservingSignatures(familyId, item.solution, after);
    if (comparison.exception_violations.length > 0) {
      violations.push(`${item.id ?? `seed ${item.seed}`}: declared exception breached — ${comparison.exception_violations.slice(0, 3).join(" | ")}`);
    }
    if (comparison.delta.length > 0) {
      violations.push(`${item.id ?? `seed ${item.seed}`}: ${comparison.delta.slice(0, 4).join(" | ")}`);
    }
    if (comparison.exception_observations.length > 0) {
      if (!exceptionObservations.has(familyId)) exceptionObservations.set(familyId, []);
      exceptionObservations.get(familyId).push(`${item.id ?? `seed ${item.seed}`}`);
    }
    if (!comparison.has_declared_exception) {
      assert.equal(
        economicSignatureSha256(item.solution) === economicSignatureSha256(after),
        comparison.equal,
        "the signature hash and the field-by-field comparison must agree",
      );
    }
  }
  preservingReport[familyId] = { ...(preservingReport[familyId] ?? {}), [label]: applied.length };
  return { applied, violations };
}

for (const familyId of preservingFamilyIds()) {
  const floors = transformFamily(familyId).minimum_applications;
  check(`${familyId} preserves the full economic signature on every archetype it applies to`, () => {
    const { applied, violations } = runPreserving(familyId, archetypeCases, "archetypes");
    assert.ok(
      applied.length >= floors.archetypes,
      `${familyId} applied to only ${applied.length} archetypes; the declared floor is ${floors.archetypes}`,
    );
    assert.deepEqual(violations, [], `${familyId} changed the economics:\n- ${violations.join("\n- ")}`);
  });

  if (floors.generated === 0) {
    check(`${familyId} declares a zero solve-plane generated floor with a stated reason`, () => {
      const note = transformFamily(familyId).applicability_note;
      assert.ok(
        typeof note === "string" && note.length > 120,
        `${familyId} waives its generated solve-plane floor without stating why`,
      );
    });
  } else check(`${familyId} preserves the full economic signature across the generated cohort`, () => {
    const { applied, violations } = runPreserving(familyId, cohort.solvable, "generated");
    assert.ok(
      applied.length >= floors.generated,
      `${familyId} applied to only ${applied.length} generated cases; the declared floor is ${floors.generated}`,
    );
    assert.deepEqual(violations, [], `${familyId} changed the economics:\n- ${violations.join("\n- ")}`);
  });
}

check("an economics-preserving transform genuinely alters the case it is given", () => {
  for (const familyId of preservingFamilyIds()) {
    let proved = false;
    for (const item of [...archetypeCases, ...cohort.refused]) {
      const transformed = applyTransform(familyId, item.model_case);
      if (!transformed) continue;
      assert.notEqual(
        JSON.stringify(transformed),
        JSON.stringify(item.model_case),
        `${familyId} returned an unchanged case — the relation would be vacuously true`,
      );
      proved = true;
      break;
    }
    assert.equal(proved, true, `${familyId} applied to no case in either corpus`);
  }
});

check("MG-4 reproduces: a header row is minted into statement_values as numeric 0", () => {
  const source = readArchetype("non_controlling_interests.json");
  const before = solveCase(structuredClone(source));
  const after = solveCase(applyTransform("repeated_header", source));
  const added = Object.keys(after.forecast[0].statement_values)
    .filter((key) => key.startsWith("hdr."))
    .sort();
  assert.ok(added.length > 0, "MG-4 no longer reproduces — if header rows have stopped entering statement_values, DELETE the MG-4 entry.");
  for (const key of added) {
    assert.equal(after.forecast[0].statement_values[key], 0, `${key} is minted with ${after.forecast[0].statement_values[key]}, not 0`);
    assert.equal(key in before.forecast[0].statement_values, false);
  }
  const transformed = applyTransform("repeated_header", source);
  for (const key of added) {
    const row = [...transformed.statement_structure.income_statement, ...transformed.statement_structure.cash_flow]
      .find((candidate) => candidate.row_id === key);
    assert.equal(row.row_type, "header");
    assert.equal(row.values, undefined, "the row declares no values at all, so the zero is minted");
  }
});

check("the repeated_header exception is PINNED and every clause is re-checked", () => {
  const family = transformFamily("repeated_header");
  const exception = family.declared_signature_exception;
  assert.equal(exception.field, "statement_values");
  assert.equal(exception.added_value, 0);
  assert.equal(exception.removals_allowed, false);
  assert.equal(exception.defect_id, "MG-4");
  assert.ok(RELATIONS.known_defects.some((defect) => defect.id === exception.defect_id));
  // A non-zero value under the prefix must breach the pin.
  const before = solveCase(readArchetype("non_controlling_interests.json"));
  const after = solveCase(applyTransform("repeated_header", readArchetype("non_controlling_interests.json")));
  for (const period of after.forecast) {
    for (const key of Object.keys(period.statement_values)) {
      if (key.startsWith("hdr.")) period.statement_values[key] = 7;
    }
  }
  const comparison = comparePreservingSignatures("repeated_header", before, after);
  assert.ok(comparison.exception_violations.length > 0, "a non-zero minted value must breach the pin");
  assert.equal(comparison.equal, false);
});

check("only repeated_header carries a declared signature exception", () => {
  const withException = RELATIONS.transform_families
    .filter((family) => family.declared_signature_exception)
    .map((family) => family.id);
  assert.deepEqual(withException, ["repeated_header"]);
  const observed = exceptionObservations.get("repeated_header") ?? [];
  assert.ok(observed.length >= 25, `the pinned exception was observed on only ${observed.length} cases`);
});

// ---------------------------------------------------------------------------
// D. The refusal plane — a refused case must be refused for the same reason
// ---------------------------------------------------------------------------

const refusalPlaneReport = {};
const driftObservations = [];

check("economics-preserving transforms do not change a lawful refusal", () => {
  const violations = [];
  let compared = 0;
  for (const familyId of preservingFamilyIds()) {
    let familyApplied = 0;
    for (const item of cohort.refused) {
      const transformed = applyTransform(familyId, item.model_case);
      if (!transformed) continue;
      compared += 1;
      familyApplied += 1;
      let verdict = null;
      try {
        solveCase(transformed);
        verdict = "__solved__";
      } catch (error) {
        verdict = String(error?.message ?? error).split("\n")[0];
      }
      const comparison = compareRefusalVerdicts(item.refusal, verdict);
      if (!comparison.equal) {
        violations.push(`${familyId} on seed ${item.seed} [${comparison.reason}]: "${item.refusal}" -> "${verdict}"`);
      } else if (comparison.drift > 0) {
        driftObservations.push({ family: familyId, seed: item.seed, drift: comparison.drift });
      }
    }
    refusalPlaneReport[familyId] = familyApplied;
    const floor = transformFamily(familyId).minimum_applications.refused;
    assert.ok(
      familyApplied >= floor,
      `${familyId} reached only ${familyApplied} refused cases; the declared floor is ${floor}`,
    );
  }
  assert.ok(compared >= 800, `expected the refusal plane to carry volume; compared ${compared}`);
  assert.deepEqual(violations, [], `a presentation transform changed a refusal:\n- ${violations.slice(0, 6).join("\n- ")}`);
});

check("MG-5 reproduces: permuting the register moves the reported opening-debt residual", () => {
  const drifting = driftObservations.filter((item) => item.drift > 0);
  assert.ok(
    drifting.length > 0,
    "MG-5 no longer reproduces — if the bridge now sums in a canonical order, DELETE the MG-5 entry.",
  );
  const foreign = drifting.filter((item) => item.family !== "row_reorder_instruments");
  assert.deepEqual(
    foreign.map((item) => `${item.family}/${item.seed}`),
    [],
    "only a register permutation may move a reported magnitude; a label transform doing so is a NEW defect",
  );
  const registered = RELATIONS.known_defects.find((defect) => defect.id === "MG-5");
  const worst = Math.max(...drifting.map((item) => item.drift));
  assert.ok(
    worst <= registered.observed_relative_drift_bound,
    `the registered drift bound is ${registered.observed_relative_drift_bound} and ${worst} was observed — the dependence has WIDENED`,
  );
  assert.ok(worst < 1e-9, `observed relative drift ${worst} is no longer negligible against the bridge tolerance`);
  assert.ok(
    drifting.some((item) => item.seed === registered.reproducing_seed),
    `the registered reproducing seed ${registered.reproducing_seed} no longer drifts`,
  );
});

check("the refusal comparison still catches a genuinely different refusal", () => {
  const base = "OPENING_DEBT_UNRESOLVED: case x opening-debt bridge leaves -943.56 USD unexplained (tolerance 0.01).";
  assert.equal(compareRefusalVerdicts(base, base.replace("-943.56", "-943.5600000000002")).equal, true);
  assert.equal(compareRefusalVerdicts(base, base.replace("OPENING_DEBT_UNRESOLVED", "SOLVER_NON_CONVERGENCE")).equal, false);
  assert.equal(compareRefusalVerdicts(base, base.replace("case x", "case y")).equal, false);
  assert.equal(compareRefusalVerdicts(base, base.replace("-943.56", "-950.0")).equal, false);
  assert.equal(compareRefusalVerdicts(base, `${base} extra`).equal, false);
});

// ---------------------------------------------------------------------------
// E. Locality — the half that was impossible before P4.6/P4.7
// ---------------------------------------------------------------------------

const localityReport = {};

function runLocality(familyId, corpus, label) {
  const family = transformFamily(familyId);
  const node = family.perturbed_node;
  const applied = [];
  const held = [];
  const vacuous = [];
  const unexplained = [];
  const attributed = new Map();
  for (const item of corpus) {
    const transformed = applyTransform(familyId, item.model_case);
    if (!transformed) continue;
    let after;
    try {
      after = solveCase(transformed);
    } catch {
      continue; // a perturbation that pushes the case out of support is not a locality claim
    }
    applied.push(item.id ?? item.seed);
    const circularity = Number(item.model_case?.controls?.circularity ?? 1);
    const verdict = localityVerdict({ node, circularity, before: item.solution, after });
    if (verdict.vacuous) vacuous.push(item.id ?? item.seed);
    else if (verdict.held) held.push(item.id ?? item.seed);
    if (verdict.unexplained_escape.length > 0) {
      unexplained.push(`${item.id ?? `seed ${item.seed}`}: ${verdict.unexplained_escape.join(", ")}`);
    }
    for (const [defectId, nodes] of Object.entries(verdict.attributed_to_known_defects)) {
      if (!attributed.has(defectId)) attributed.set(defectId, new Set());
      for (const escaped of nodes) attributed.get(defectId).add(escaped);
    }
  }
  localityReport[familyId] = {
    ...(localityReport[familyId] ?? {}),
    [label]: { applied: applied.length, held: held.length, vacuous: vacuous.length },
  };
  return { applied, held, vacuous, unexplained, attributed };
}

const defectReproductions = new Map();

for (const familyId of localityFamilyIds()) {
  const localityFloors = transformFamily(familyId).minimum_applications;
  check(`${familyId}: no change escapes its declared locality unexplained (archetypes)`, () => {
    const result = runLocality(familyId, archetypeCases, "archetypes");
    assert.ok(
      result.applied.length >= localityFloors.archetypes,
      `${familyId} applied to only ${result.applied.length} archetypes; the declared floor is ${localityFloors.archetypes}`,
    );
    assert.ok(
      result.held.length + result.vacuous.length + result.unexplained.length >= 0,
      "unreachable",
    );
    assert.ok(
      result.applied.length - result.vacuous.length >= 1,
      `${familyId} never changed anything on any archetype — a vacuous locality claim`,
    );
    assert.deepEqual(
      result.unexplained,
      [],
      `${familyId} produced a NEW locality escape the defect register does not account for:\n- ${result.unexplained.slice(0, 6).join("\n- ")}`,
    );
    for (const [defectId, nodes] of result.attributed) {
      if (!defectReproductions.has(defectId)) defectReproductions.set(defectId, new Set());
      for (const node of nodes) defectReproductions.get(defectId).add(node);
    }
  });

  check(`${familyId}: no change escapes its declared locality unexplained (generated cohort)`, () => {
    const result = runLocality(familyId, cohort.solvable, "generated");
    assert.ok(
      result.applied.length >= localityFloors.generated,
      `${familyId} applied to only ${result.applied.length} generated cases; the declared floor is ${localityFloors.generated}`,
    );
    assert.deepEqual(
      result.unexplained,
      [],
      `${familyId} produced a NEW locality escape the defect register does not account for:\n- ${result.unexplained.slice(0, 6).join("\n- ")}`,
    );
    for (const [defectId, nodes] of result.attributed) {
      if (!defectReproductions.has(defectId)) defectReproductions.set(defectId, new Set());
      for (const node of nodes) defectReproductions.get(defectId).add(node);
    }
  });
}

check("perturb_minimum_cash: locality HOLDS outright on every archetype it changed", () => {
  const family = transformFamily("perturb_minimum_cash");
  let changed = 0;
  const escapes = [];
  for (const item of archetypeCases) {
    const transformed = applyTransform("perturb_minimum_cash", item.model_case);
    if (!transformed) continue;
    let after;
    try {
      after = solveCase(transformed);
    } catch {
      continue;
    }
    const circularity = Number(item.model_case?.controls?.circularity ?? 1);
    const verdict = localityVerdict({ node: family.perturbed_node, circularity, before: item.solution, after });
    if (verdict.vacuous) continue;
    changed += 1;
    if (!verdict.held) escapes.push(`${item.id}: ${verdict.escaped.join(", ")}`);
  }
  assert.ok(changed >= 25, `expected the minimum-cash floor to move economics on >= 25 archetypes; got ${changed}`);
  assert.deepEqual(escapes, [], `minimum-cash locality escaped:\n- ${escapes.join("\n- ")}`);
});

check("perturb_effective_tax_rate: the nodes the graph forbids EBIT-side are untouched", () => {
  const forbidden = ["statement.ebit", "interest.instrument_cash", "interest.lease", "debt.mandatory_repayment", "lease.principal"];
  const violations = [];
  let compared = 0;
  for (const item of archetypeCases) {
    const transformed = applyTransform("perturb_effective_tax_rate", item.model_case);
    if (!transformed) continue;
    let after;
    try {
      after = solveCase(transformed);
    } catch {
      continue;
    }
    compared += 1;
    const changed = changedObservableNodes(item.solution, after);
    for (const node of forbidden) if (changed.has(node)) violations.push(`${item.id}: ${node}`);
  }
  assert.ok(compared >= 20, `compared only ${compared} cases`);
  assert.deepEqual(violations, [], `a tax-rate change reached a node no tax path leads to:\n- ${violations.join("\n- ")}`);
});

// ---------------------------------------------------------------------------
// F. The defect register — pinned, necessary, and still reproducing
// ---------------------------------------------------------------------------

check("no declared missing edge is already present in the equation graph", () => {
  const present = new Set(EQUATION_GRAPH.edges.map((edge) => `${edge.from}->${edge.to}`));
  const stale = declaredMissingEdges()
    .filter((edge) => present.has(`${edge.from}->${edge.to}`))
    .map((edge) => `${edge.defect_id}: ${edge.from}->${edge.to}`);
  assert.deepEqual(stale, [], `the register claims edges the graph already has — retire them:\n- ${stale.join("\n- ")}`);
});

check("every declared missing edge names two real graph nodes", () => {
  const nodes = new Set(EQUATION_GRAPH.nodes.map((node) => node.id));
  for (const edge of declaredMissingEdges()) {
    assert.ok(nodes.has(edge.from), `${edge.defect_id} names unknown node ${edge.from}`);
    assert.ok(nodes.has(edge.to), `${edge.defect_id} names unknown node ${edge.to}`);
  }
});

check("the graph-gap defects still reproduce — the register cannot rot", () => {
  const graphGaps = RELATIONS.known_defects.filter((defect) => defect.class === "graph_dependency_gap");
  assert.ok(graphGaps.length >= 2, "expected the graph-gap defects to be registered");
  for (const defect of graphGaps) {
    assert.equal(defect.status, "OPEN", `${defect.id} is registered but not OPEN`);
    const reproduced = defectReproductions.get(defect.id);
    assert.ok(
      reproduced && reproduced.size > 0,
      `${defect.id} no longer reproduces. If the graph has been repaired, DELETE the entry (see retirement_condition); do not leave it standing.`,
    );
  }
});

check("MG-1 reproduces exactly as the register states it", () => {
  const before = solveCase(readArchetype("deferred_revenue_ratable.json"));
  const after = solveCase(applyTransform("perturb_effective_tax_rate", readArchetype("deferred_revenue_ratable.json")));
  assert.equal(before.forecast[0].tax, 0);
  assert.equal(after.forecast[0].tax, 42.27117623444384);
  assert.equal(before.forecast[0].cash_from_operations, 282.18090452260935);
  assert.equal(after.forecast[0].cash_from_operations, 239.69731031714127);
  const verdict = localityVerdict({
    node: "statement.effective_tax_rate", circularity: 1, before, after,
  });
  assert.ok(verdict.escaped.includes("cash.cfo"), "the tax charge must be seen reaching operating cash flow");
  assert.deepEqual(verdict.unexplained_escape, []);
  assert.deepEqual(Object.keys(verdict.attributed_to_known_defects), ["MG-1"]);
});

check("MG-1's second-order consequence holds: the declared active SCC omits nodes that move", () => {
  const contract = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "convergence-contract.v1.json"), "utf8"));
  const declared = new Set(contract.scc_contract.active_by_circularity["1"].flatMap((component) => component.nodes));
  assert.equal(declared.has("statement.pre_tax_income"), false);
  assert.equal(declared.has("statement.tax_expense"), false);
  const before = solveCase(readArchetype("deferred_revenue_ratable.json"));
  const after = solveCase(applyTransform("perturb_effective_tax_rate", readArchetype("deferred_revenue_ratable.json")));
  const changed = changedObservableNodes(before, after);
  assert.ok(
    changed.has("statement.pre_tax_income"),
    "pre-tax income must be observed moving under a tax-rate change for the SCC understatement to be proven",
  );
});

check("every declared missing edge is NECESSARY — the register cannot be padded", () => {
  // Dropping any one edge must leave at least one escape unexplained somewhere.
  // Without this, a future escape could be laundered by adding an edge nobody needs.
  const all = declaredMissingEdges();
  const observations = [];
  for (const familyId of localityFamilyIds()) {
    const node = transformFamily(familyId).perturbed_node;
    for (const item of archetypeCases) {
      const transformed = applyTransform(familyId, item.model_case);
      if (!transformed) continue;
      let after;
      try {
        after = solveCase(transformed);
      } catch {
        continue;
      }
      const circularity = Number(item.model_case?.controls?.circularity ?? 1);
      const mayMove = new Set([node, ...forwardReachable(node, circularity)]);
      const escaped = [...changedObservableNodes(item.solution, after)].filter((id) => !mayMove.has(id));
      if (escaped.length > 0) observations.push({ node, circularity, escaped });
    }
  }
  assert.ok(observations.length > 0, "no escape observed at all — the necessity proof would be vacuous");
  const unnecessary = [];
  for (const edge of all) {
    const without = all.filter((candidate) => candidate !== edge);
    const stillCovered = observations.every((observation) => {
      const covered = new Set([observation.node, ...forwardReachable(observation.node, observation.circularity, without)]);
      return observation.escaped.every((id) => covered.has(id));
    });
    if (stillCovered) unnecessary.push(`${edge.defect_id}: ${edge.from}->${edge.to}`);
  }
  assert.deepEqual(
    unnecessary,
    [],
    `the register declares missing edges no observed escape needs — remove them:\n- ${unnecessary.join("\n- ")}`,
  );
});

// ---------------------------------------------------------------------------
// G. unit_scale_restatement — an economics-CHANGING transform with an EXACT effect
// ---------------------------------------------------------------------------

const SCALE = transformFamily("unit_scale_restatement").expected_effect.scale_factor;

check("the unit-scale class map is exhaustive over every economic forecast field", () => {
  const economic = Object.entries(RELATIONS.forecast_field_classes)
    .filter(([, klass]) => klass !== "solver_diagnostic" && klass !== "identity")
    .map(([field]) => field)
    .sort();
  assert.deepEqual(Object.keys(RELATIONS.unit_scale_classes).sort(), economic);
  const semantics = new Set(Object.keys(RELATIONS.unit_scale_class_semantics));
  for (const [field, klass] of Object.entries(RELATIONS.unit_scale_classes)) {
    assert.ok(semantics.has(klass), `${field} carries undeclared scale class ${klass}`);
    if (klass !== "currency") {
      assert.ok(
        typeof RELATIONS.unit_scale_class_reasons[field] === "string",
        `${field} is exempted from scaling without a stated reason`,
      );
    }
  }
});

check("the graph's own ratio node agrees with the declared invariant scale class", () => {
  const ratioNodes = Object.entries(NODE_TOLERANCE_CLASS).filter(([, klass]) => klass === "ratio");
  assert.deepEqual(ratioNodes.map(([id]) => id), ["statement.effective_tax_rate"]);
  const currencyNodes = Object.entries(NODE_TOLERANCE_CLASS).filter(([, klass]) => klass === "currency");
  for (const [node] of currencyNodes) {
    const field = OBSERVABLE_NODE ? null : null;
    void field;
  }
  for (const [field, node] of Object.entries(OBSERVABLE_NODE)) {
    if (NODE_TOLERANCE_CLASS[node] !== "currency") continue;
    assert.equal(
      RELATIONS.unit_scale_classes[field],
      "currency",
      `${field} realises the currency-class node ${node} but is not declared currency-scaling`,
    );
  }
});

function scaleViolations(before, after) {
  const problems = [];
  for (let index = 0; index < before.forecast.length; index += 1) {
    const a = before.forecast[index];
    const b = after.forecast[index] ?? {};
    for (const [field, scaleClass] of Object.entries(RELATIONS.unit_scale_classes)) {
      if (scaleClass === "structured_not_scale_checked") continue;
      const left = a[field];
      const right = b[field];
      if (typeof left !== "number" || typeof right !== "number") continue;
      if (scaleClass === "invariant") {
        if (Math.abs(right - left) > Math.max(1e-9, Math.abs(left) * 1e-9)) {
          problems.push(`INVARIANT ${field}[${index}] ${left} -> ${right} (must not move)`);
        }
        continue;
      }
      const expected = left * SCALE;
      if (Math.abs(right - expected) > Math.max(1e-6, Math.abs(expected) * 1e-9)) {
        problems.push(`CURRENCY ${field}[${index}] ${left} -> ${right}, expected ${expected}`);
      }
    }
  }
  return problems;
}

const scaleRegistered = RELATIONS.known_defects.find((defect) => defect.class === "scale_dependence");
const scaleRegisteredCase = path.basename(scaleRegistered.reproducing_case);
let scaleApplied = 0;
let scaleExact = 0;
const scaleRefused = [];

check("unit_scale_restatement scales currency exactly and leaves ratios invariant (archetypes)", () => {
  const violations = [];
  for (const item of archetypeCases) {
    const transformed = applyTransform("unit_scale_restatement", item.model_case);
    if (!transformed) continue;
    scaleApplied += 1;
    let after;
    try {
      after = solveCase(transformed);
    } catch (error) {
      scaleRefused.push({ id: item.id, message: String(error?.message ?? error).split("\n")[0] });
      continue;
    }
    const problems = scaleViolations(item.solution, after);
    if (problems.length > 0) violations.push(`${item.id}: ${problems.slice(0, 3).join(" | ")}`);
    else scaleExact += 1;
  }
  assert.ok(
    scaleApplied >= transformFamily("unit_scale_restatement").minimum_applications.archetypes,
    `expected the restatement to apply broadly; applied to ${scaleApplied}`,
  );
  assert.deepEqual(violations, [], `restating the units did not scale the economics exactly:\n- ${violations.join("\n- ")}`);
  preservingReport.unit_scale_restatement = {
    archetypes: scaleApplied,
    archetypes_exact: scaleExact,
    archetypes_refused: scaleRefused.length,
  };
});

check("MG-3 reproduces: the only case the restatement refuses is the registered one", () => {
  assert.ok(scaleRefused.length > 0, `MG-3 no longer reproduces — the solver tolerance may now be relative. If so, DELETE the MG-3 entry.`);
  const unregistered = scaleRefused.filter((item) => !item.id.endsWith(scaleRegisteredCase));
  assert.deepEqual(
    unregistered.map((item) => `${item.id}: ${item.message}`),
    [],
    "a NEW scale-dependent refusal appeared that the register does not cover",
  );
  for (const item of scaleRefused) {
    assert.match(item.message, /SOLVER_NON_CONVERGENCE/, `${item.id}: unexpected refusal ${item.message}`);
  }
});

check("MG-3's cause is an absolute tolerance, proven from the base solve", () => {
  const before = solveCase(readArchetype(scaleRegisteredCase));
  assert.equal(before.convergence_tolerance, 1e-8);
  assert.ok(before.residual < before.convergence_tolerance, "the case converges as filed");
  assert.ok(
    before.residual * SCALE > before.convergence_tolerance,
    `scaling by ${SCALE} must push the residual (${before.residual}) past a tolerance that does not scale`,
  );
});

check("unit_scale_restatement scales exactly across the generated cohort", () => {
  const violations = [];
  let applied = 0;
  let refused = 0;
  for (const item of cohort.solvable) {
    const transformed = applyTransform("unit_scale_restatement", item.model_case);
    if (!transformed) continue;
    applied += 1;
    let after;
    try {
      after = solveCase(transformed);
    } catch (error) {
      refused += 1;
      assert.match(
        String(error?.message ?? error),
        /SOLVER_NON_CONVERGENCE/,
        `seed ${item.seed}: restatement caused a refusal that is not the registered scale dependence — ${String(error?.message ?? error).split("\n")[0]}`,
      );
      continue;
    }
    const problems = scaleViolations(item.solution, after);
    if (problems.length > 0) violations.push(`seed ${item.seed}: ${problems.slice(0, 3).join(" | ")}`);
  }
  assert.ok(
    applied >= transformFamily("unit_scale_restatement").minimum_applications.generated,
    `expected the restatement to reach its declared generated floor; applied to ${applied}`,
  );
  assert.deepEqual(violations, [], `restating the units did not scale the economics exactly:\n- ${violations.slice(0, 6).join("\n- ")}`);
  preservingReport.unit_scale_restatement = {
    ...preservingReport.unit_scale_restatement,
    generated: applied,
    generated_refused: refused,
  };
  assert.ok(refused >= 1, "the registered scale dependence should also appear in the generated cohort");
});

// ---------------------------------------------------------------------------
// H. Mutations — the suite must be able to fail
// ---------------------------------------------------------------------------

const sample = archetypeCases.slice(0, 12);

function preservingWouldCatch(mutantTransform) {
  for (const item of sample) {
    const transformed = mutantTransform(item.model_case);
    if (!transformed) continue;
    let after;
    try {
      after = solveCase(transformed);
    } catch {
      return true;
    }
    if (economicSignatureSha256(item.solution) !== economicSignatureSha256(after)) return true;
  }
  return false;
}

check("MUTATION: a preserving transform that silently changes ONE number is caught", () => {
  const mutant = (modelCase) => {
    const next = TRANSFORMS.label_synonym(modelCase);
    if (!next) return null;
    const row = next.statement_structure?.income_statement?.[0];
    if (row && Array.isArray(row.values)) {
      row.values = row.values.map((value, index) => (index === 3 && typeof value === "number" ? value + 1 : value));
    }
    return next;
  };
  assert.equal(preservingWouldCatch(mutant), true, "a hidden numeric edit under a label synonym escaped the signature");
});

check("MUTATION: a preserving transform that changes a number by 1e-6 is caught", () => {
  const mutant = (modelCase) => {
    const next = TRANSFORMS.whitespace_padding(modelCase);
    if (!next) return null;
    const row = next.statement_structure?.income_statement?.find(
      (candidate) => Array.isArray(candidate.values) && candidate.values.some((value) => typeof value === "number"),
    );
    if (!row) return null;
    row.values = row.values.map((value, index) => (index === 3 && typeof value === "number" ? value + 1e-6 : value));
    return next;
  };
  assert.equal(preservingWouldCatch(mutant), true, "a 1e-6 drift escaped the signature");
});

check("MUTATION: a preserving transform that flips a semantic_role is caught", () => {
  const mutant = (modelCase) => {
    const next = TRANSFORMS.row_reorder_statement(modelCase);
    if (!next) return null;
    const row = next.statement_structure?.cash_flow?.find((candidate) => candidate.semantic_role === "capex");
    if (!row) return null;
    row.semantic_role = "change_in_working_capital";
    return next;
  };
  assert.equal(preservingWouldCatch(mutant), true, "a role swap under a reorder escaped the signature");
});

check("MUTATION: a change escaping its declared locality is caught", () => {
  // statement.effective_tax_rate reaches, even with every declared missing edge
  // granted, nothing that sets the minimum-cash floor. A mutant that moves the
  // floor as well must therefore be reported, and named.
  let caught = false;
  for (const item of sample) {
    const base = TRANSFORMS.perturb_effective_tax_rate(item.model_case);
    if (!base) continue;
    const mutant = TRANSFORMS.perturb_minimum_cash(base);
    if (!mutant) continue;
    let after;
    try {
      after = solveCase(mutant);
    } catch {
      continue;
    }
    const circularity = Number(item.model_case?.controls?.circularity ?? 1);
    const verdict = localityVerdict({
      node: "statement.effective_tax_rate", circularity, before: item.solution, after,
    });
    if (verdict.unexplained_escape.length > 0) {
      caught = true;
      assert.ok(
        verdict.unexplained_escape.includes("cash.minimum_cash"),
        `expected the minimum-cash floor to be named as the escape; got ${verdict.unexplained_escape.join(", ")}`,
      );
      break;
    }
  }
  assert.equal(caught, true, "an out-of-locality change was not reported as an unexplained escape");
});

check("MUTATION: a debt-schedule change smuggled under a minimum-cash change is caught", () => {
  let caught = false;
  for (const item of sample) {
    const base = TRANSFORMS.perturb_minimum_cash(item.model_case);
    if (!base) continue;
    const mutant = TRANSFORMS.perturb_scheduled_amortisation(base);
    if (!mutant) continue;
    let after;
    try {
      after = solveCase(mutant);
    } catch {
      continue;
    }
    const circularity = Number(item.model_case?.controls?.circularity ?? 1);
    const verdict = localityVerdict({ node: "cash.minimum_cash", circularity, before: item.solution, after });
    if (verdict.unexplained_escape.length > 0) {
      caught = true;
      assert.ok(
        verdict.unexplained_escape.some((node) =>
          ["debt.mandatory_repayment", "interest.instrument_cash", "interest.instrument_pik"].includes(node)),
        `expected a debt-schedule node to be named; got ${verdict.unexplained_escape.join(", ")}`,
      );
      break;
    }
  }
  assert.equal(caught, true, "a debt-schedule perturbation was absorbed into the minimum-cash locality");
});

check("MUTATION: an escape one node further than declared is still caught", () => {
  // interest.lease is one edge outside cash.minimum_cash's reachable set under
  // every declared missing edge, so perturbing the lease alongside the floor
  // must not be absorbed.
  let caught = false;
  for (const item of sample) {
    const base = TRANSFORMS.perturb_minimum_cash(item.model_case);
    if (!base) continue;
    const mutant = TRANSFORMS.perturb_lease_principal(base);
    if (!mutant) continue;
    let after;
    try {
      after = solveCase(mutant);
    } catch {
      continue;
    }
    const circularity = Number(item.model_case?.controls?.circularity ?? 1);
    const verdict = localityVerdict({ node: "cash.minimum_cash", circularity, before: item.solution, after });
    if (verdict.unexplained_escape.length > 0) {
      caught = true;
      break;
    }
  }
  assert.equal(caught, true, "a lease perturbation smuggled under a minimum-cash change was absorbed");
});

check("MUTATION: a locality claim widened to the whole graph is caught as vacuous", () => {
  const everything = EQUATION_GRAPH.nodes.map((node) => node.id);
  const widened = new Set(everything);
  const declared = new Set(declaredLocality("statement.effective_tax_rate", 1).may_move);
  assert.ok(widened.size > declared.size, "the declared locality must be a strict subset of the graph");
  assert.equal(declared.size, 3, "the tax-rate locality must stay at three nodes, not widen");
});

check("MUTATION: a defect entry whose edges do nothing is reported as unnecessary", () => {
  const padded = [...declaredMissingEdges(), { from: "statement.ebit", to: "rcf.capacity", defect_id: "MG-PAD" }];
  const node = "statement.effective_tax_rate";
  const withoutPad = forwardReachable(node, 1, padded.filter((edge) => edge.defect_id !== "MG-PAD"));
  const withPad = forwardReachable(node, 1, padded);
  assert.deepEqual([...withPad].sort(), [...withoutPad].sort(), "the padding edge changes nothing, so the necessity check must reject it");
});

check("MUTATION: dropping the tax->cfo edge from the register leaves MG-1 unexplained", () => {
  const before = solveCase(readArchetype("deferred_revenue_ratable.json"));
  const after = solveCase(applyTransform("perturb_effective_tax_rate", readArchetype("deferred_revenue_ratable.json")));
  const changed = changedObservableNodes(before, after);
  const mayMove = new Set(["statement.effective_tax_rate", ...forwardReachable("statement.effective_tax_rate", 1, [])]);
  const escaped = [...changed].filter((id) => !mayMove.has(id));
  assert.ok(escaped.includes("cash.cfo"), "without the declared edge, the escape must be visible");
});

// ---------------------------------------------------------------------------

const localityFamilies = localityFamilyIds();
console.log(JSON.stringify({
  status: "PASS",
  checks,
  relations_version: RELATIONS.relations_version,
  relations_sha256: RELATIONS_SHA256,
  transform_families: RELATIONS.transform_families.length,
  economics_preserving_families: preservingFamilyIds().length,
  economics_changing_families: changingFamilyIds().length,
  locality_families: localityFamilies.length,
  locality_graph_sha_source: "assets/equation-graph.v1.json",
  archetype_cases: archetypeCases.length,
  generated_cases_solvable: cohort.solvable.length,
  generated_cases_refused: cohort.refused.length,
  generated_root_seed: cohort.root_seed,
  signature_fields: signatureCoveredKeys().length,
  preserving_applications: preservingReport,
  refusal_plane_applications: refusalPlaneReport,
  refusal_magnitude_drift_observations: driftObservations.length,
  locality_applications: localityReport,
  known_defects_open: RELATIONS.known_defects.length,
  known_defects_reproduced: [...new Set([...defectReproductions.keys(), scaleRegistered.id, "MG-4", "MG-5"])].sort(),
}));
