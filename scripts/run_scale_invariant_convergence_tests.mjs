#!/usr/bin/env node
/**
 * P4.9 — SCALE-INVARIANT CONVERGENCE (defect D30 / MG-3), and the measured
 * escalation for D28 / MG-1.
 *
 * Two high-severity defects were handed to this package. One is repaired here;
 * the other is proved un-landable inside any one package's file allowance, and
 * that proof is the deliverable rather than a half-repair.
 *
 *   D30 / MG-3 — convergence was judged against an ABSOLUTE tolerance in the
 *   issuer's declared reporting unit, so the verdict was a function of a
 *   presentation choice. Section B lands the repair: the criterion is now
 *   proportional to the magnitudes it judges and is floored by an IEEE754
 *   bound. Section A also records a finding the register does not contain: the
 *   two REPRODUCTIONS the register cites are contaminated by a defect in the
 *   transform that found them, and with that removed neither reproduces.
 *
 *   D28 / MG-1 — the missing `statement.tax_expense -> cash.cfo` edge. Section
 *   E adds the edge to an IN-MEMORY copy of the graph and re-runs, with the
 *   repository's own validators, every proof that was computed on the
 *   incomplete graph. Nothing is written to any asset: the edge cannot land
 *   without five artefacts moving together, four of which are forbidden here.
 *
 * Emits one line: {"status":"PASS","checks":N}
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  convergenceCriterion,
  convergenceFloatNoiseFloor,
  convergenceStateScale,
  solveCase,
} from "./lib/solver.mjs";
import {
  CONVERGENCE_CONTRACT,
  EQUATION_GRAPH,
  activeEquationEdges,
  deriveStronglyConnectedComponents,
  validateEffectiveTaxRatePathAcyclicity,
  validateEquationGraph,
} from "./lib/equation_graph.mjs";
import { ECONOMIC_SOLVE_POLICY } from "./lib/economic_solve_policy.mjs";
import { validateFixedPointSolution } from "./lib/fixed_point_constitution.mjs";
// READ ONLY. P4.4 and P4.7 own these; this suite asks them what they say about
// a repaired graph and never edits them.
import { validateModuleContractConformance } from "./lib/canonical_model_modules.mjs";
import { checkSolveOrderAgreement, deriveSolveOrder } from "./lib/solve_order.mjs";
// READ ONLY. P7.4 owns the transform register; this suite uses the very
// transform that found MG-3 rather than inventing a second one.
import { applyTransform, transformFamily } from "./lib/metamorphic_relations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ARCHETYPES = path.join(ROOT, "test-fixtures", "archetypes", "economics");
const CASES = path.join(ROOT, "test-fixtures", "cases");

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

const readCase = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const archetype = (name) => readCase(path.join(ARCHETYPES, name));
function certified(name) {
  const modelCase = readCase(path.join(CASES, `${name}.json`));
  modelCase.execution_profile = "reference_parity";
  return modelCase;
}

const ABSOLUTE_TOLERANCE = ECONOMIC_SOLVE_POLICY.solver.absolute_tolerance;
const REGISTERED_CASE = "revolver_undrawn_commitment_fee_only.json";
const SCALE = 1000;

// ---------------------------------------------------------------------------
// Faithful unit restatement. P7.4's transform is the authority for WHICH paths
// are monetary; the one correction below is D33, proved in section A.
// ---------------------------------------------------------------------------
const RATE_FEE_CONVENTIONS = new Set([
  "bps_on_undrawn",
  "percent_on_undrawn",
  "bps_on_capacity",
]);

function leafPaths(value, prefix = "", into = []) {
  if (value === null || typeof value !== "object") {
    into.push(prefix);
    return into;
  }
  for (const key of Object.keys(value)) {
    leafPaths(value[key], prefix ? `${prefix}.${key}` : key, into);
  }
  return into;
}
const readPath = (object, p) =>
  p.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), object);
function writePath(object, p, value) {
  const keys = p.split(".");
  const last = keys.pop();
  keys.reduce((acc, key) => acc[key], object)[last] = value;
}

/** The monetary paths P7.4's own transform moves, minus the D33 contamination. */
function monetaryPathsOf(modelCase) {
  const once = applyTransform("unit_scale_restatement", modelCase);
  if (!once) return null;
  if (
    RATE_FEE_CONVENTIONS.has(modelCase?.rcf_policy?.commitment_fee_convention) &&
    typeof modelCase?.rcf_policy?.commitment_fee_value === "number"
  ) {
    once.rcf_policy.commitment_fee_value = modelCase.rcf_policy.commitment_fee_value;
  }
  return leafPaths(modelCase).filter(
    (p) =>
      typeof readPath(modelCase, p) === "number" &&
      typeof readPath(once, p) === "number" &&
      readPath(once, p) !== readPath(modelCase, p),
  );
}

function restate(modelCase, factor, units) {
  const paths = monetaryPathsOf(modelCase);
  if (!paths) return null;
  const out = structuredClone(modelCase);
  for (const p of paths) writePath(out, p, readPath(modelCase, p) * factor);
  out.issuer.units = units;
  return out;
}

const CURRENCY_OBSERVABLES = [
  "cash_from_operations",
  "ending_cash",
  "gross_interest",
  "interest_income",
  "rcf_commitment_fee",
  "rcf_interest",
  "net_income",
  "pre_tax_income",
  "tax",
  "ebit",
];

// ===========================================================================
// A. RED PROOF for D30 / MG-3 — and the mis-attribution the register does not
//    contain.
// ===========================================================================

const registeredBase = archetype(REGISTERED_CASE);
const registeredSolved = solveCase(structuredClone(registeredBase));

check("RED — the retired criterion was scale-dependent by construction", () => {
  // The register's own arithmetic: the residual scales with the magnitudes and
  // an absolute threshold does not, so the same economics restated into a
  // smaller unit is judged against a criterion 1000x stricter.
  assert.ok(registeredSolved.residual < ABSOLUTE_TOLERANCE, "converges as filed");
  assert.ok(
    registeredSolved.residual * SCALE > ABSOLUTE_TOLERANCE,
    `restating by ${SCALE} must push the residual (${registeredSolved.residual}) past a threshold that does not scale`,
  );
});

check("D33 — the transform that found MG-3 scales a RATE it declares fixed", () => {
  const family = transformFamily("unit_scale_restatement");
  assert.ok(
    family.non_monetary_paths_held_fixed.some((entry) =>
      entry.includes("rcf_policy.commitment_fee_value when commitment_fee_convention is a rate"),
    ),
    "the transform declares the rate-convention fee is held fixed",
  );
  assert.equal(registeredBase.rcf_policy.commitment_fee_convention, "bps_on_undrawn");
  const transformed = applyTransform("unit_scale_restatement", registeredBase);
  assert.equal(registeredBase.rcf_policy.commitment_fee_value, 35);
  assert.equal(
    transformed.rcf_policy.commitment_fee_value,
    35000,
    "the transform scales the bps fee anyway — a 35bp commitment fee becomes 350%",
  );
});

check("D33's cause is a NAME test standing in for a semantic one, and it never fires", () => {
  // `metamorphic_relations.mjs:733` guards the fee with
  // `!/rate/i.test(commitment_fee_convention)`. The repository declares exactly
  // three conventions and not one of them contains the letters r-a-t-e, so the
  // guard is dead code and the fee is scaled unconditionally.
  const source = fs.readFileSync(path.join(ROOT, "scripts", "lib", "metamorphic_relations.mjs"), "utf8");
  assert.ok(
    source.includes('!/rate/i.test(String(rcfPolicy.commitment_fee_convention ?? ""))'),
    "the guard this finding is about must still be the one in the tree",
  );
  const conventions = ["bps_on_undrawn", "captured_in_residual", "none"];
  for (const convention of conventions) {
    assert.equal(/rate/i.test(convention), false, `${convention} would fire the guard`);
  }
  assert.equal(registeredBase.rcf_policy.commitment_fee_convention, conventions[0]);
});

check("MG-3's registered reproduction is explained by D33, not by the tolerance", () => {
  const contaminated = applyTransform("unit_scale_restatement", registeredBase);
  assert.throws(
    () => solveCase(structuredClone(contaminated)),
    /SOLVER_NON_CONVERGENCE/,
    "the register's transform does refuse, as recorded",
  );
  const faithful = structuredClone(contaminated);
  faithful.rcf_policy.commitment_fee_value = registeredBase.rcf_policy.commitment_fee_value;
  const solved = solveCase(faithful);
  assert.equal(solved.converged, true, "with the bps rate held fixed it converges");
  const expected = registeredSolved.forecast[0].cash_from_operations * SCALE;
  assert.ok(
    Math.abs(solved.forecast[0].cash_from_operations - expected) <= Math.abs(expected) * 1e-12,
    `and the economics scale: ${solved.forecast[0].cash_from_operations} vs ${expected}`,
  );
});

// ===========================================================================
// B. THE REPAIR — the criterion is relative to the magnitudes it judges.
// ===========================================================================

const LADDER = [
  [1, "millions"],
  [1e3, "thousands"],
  [1e6, "units"],
  [1e9, "units"],
];

const ladderSolved = LADDER.map(([factor, units]) => {
  const modelCase =
    factor === 1 ? structuredClone(registeredBase) : restate(registeredBase, factor, units);
  return { factor, units, solution: solveCase(modelCase) };
});

check("the thousands and millions pair BOTH converge, to the same economics", () => {
  const millions = ladderSolved[0].solution;
  const thousands = ladderSolved[1].solution;
  assert.equal(millions.converged, true);
  assert.equal(thousands.converged, true);
  // The sweep COUNTS differ by one, and the criterion says exactly why: a
  // thousands state is above the declared reference magnitude, so the envelope
  // ceiling — not the scale-free term — decided when to stop. That is the
  // limitation this package declares rather than hides; inside the envelope the
  // counts are identical (see the 1000x-smaller-issuer check below).
  assert.deepEqual(millions.forecast.map((p) => p.iterations), [6, 6, 6]);
  assert.deepEqual(thousands.forecast.map((p) => p.iterations), [7, 7, 7]);
  for (const period of thousands.forecast) {
    assert.equal(
      period.graph_driven_solve.convergence_criterion.within_declared_envelope,
      false,
    );
  }
  for (const period of millions.forecast) {
    assert.equal(
      period.graph_driven_solve.convergence_criterion.within_declared_envelope,
      true,
    );
  }
});

check("every currency observable scales by exactly 1000 and ratios do not move", () => {
  const millions = ladderSolved[0].solution;
  const thousands = ladderSolved[1].solution;
  for (const [index, period] of millions.forecast.entries()) {
    const scaled = thousands.forecast[index];
    for (const field of CURRENCY_OBSERVABLES) {
      const expected = Number(period[field] ?? 0) * SCALE;
      const actual = Number(scaled[field] ?? 0);
      const bound = Math.max(Math.abs(expected), 1) * 1e-11;
      assert.ok(
        Math.abs(actual - expected) <= bound,
        `${field} period ${index}: ${actual} is not ${expected} within ${bound}`,
      );
    }
    if (period.net_leverage !== null && period.net_leverage !== undefined) {
      const bound = Math.max(Math.abs(Number(period.net_leverage)), 1) * 1e-11;
      assert.ok(
        Math.abs(Number(scaled.net_leverage) - Number(period.net_leverage)) <= bound,
        `net_leverage moved under a pure restatement in period ${index}`,
      );
    }
  }
});

check("every scale on the ladder CONVERGES — no unit is refused for being a unit", () => {
  for (const entry of ladderSolved) {
    assert.equal(entry.solution.converged, true, `scale x${entry.factor} must converge`);
  }
});

check("outside the declared envelope the criterion SAYS SO rather than hiding it", () => {
  // Within the envelope the criterion is scale-free. Above it the declared
  // absolute ceiling binds — and every period whose verdict the ceiling decided
  // carries `within_declared_envelope: false` and names the ceiling as the
  // binding term, so a reader can see exactly where the scale-freeness stops.
  const within = ladderSolved[0].solution.forecast[0].graph_driven_solve.convergence_criterion;
  assert.equal(within.within_declared_envelope, true);
  assert.equal(within.binding_term, "relative");
  for (const entry of ladderSolved.filter((item) => item.factor >= 1e3)) {
    for (const period of entry.solution.forecast) {
      const criterion = period.graph_driven_solve.convergence_criterion;
      assert.equal(
        criterion.within_declared_envelope,
        false,
        `scale x${entry.factor}: a state this large is outside the declared envelope and must say so`,
      );
      assert.equal(criterion.binding_term, "declared_absolute_ceiling");
      assert.equal(criterion.applied_tolerance, criterion.envelope_ceiling);
      assert.ok(criterion.scale_free_tolerance > criterion.envelope_ceiling);
    }
  }
});

check("INSIDE the envelope the verdict is exactly scale-free — a 1000x smaller issuer", () => {
  // `issuer.units` bottoms out at millions, so the downward direction is tested
  // by shrinking the economics themselves: an issuer a thousand times smaller,
  // same shape. A scale-free criterion must take the same number of sweeps; the
  // retired absolute one would simply have accepted the first sweep that landed
  // under 1e-8, which at this magnitude is a far weaker claim.
  const smaller = restate(registeredBase, 1e-3, "millions");
  const solved = solveCase(smaller);
  assert.equal(solved.converged, true);
  assert.deepEqual(
    solved.forecast.map((p) => p.iterations),
    ladderSolved[0].solution.forecast.map((p) => p.iterations),
  );
  const criterion = solved.forecast[0].graph_driven_solve.convergence_criterion;
  const baseline = ladderSolved[0].solution.forecast[0].graph_driven_solve.convergence_criterion;
  assert.equal(criterion.within_declared_envelope, true);
  assert.ok(
    criterion.applied_tolerance < ABSOLUTE_TOLERANCE / 1e2,
    "a thousandth of the reference magnitude must be judged far more strictly than the constant",
  );
  const expected = baseline.applied_tolerance * 1e-3;
  assert.ok(
    Math.abs(criterion.applied_tolerance - expected) <= expected * 1e-12,
    `the criterion did not scale with the state: ${criterion.applied_tolerance} vs ${expected}`,
  );
});

check("the SCALE-FREE tolerance scales exactly with the state, at every scale", () => {
  // `scale_free_tolerance` is the criterion before the declared ceiling is
  // applied. It is the quantity the repair is really about, and it tracks the
  // magnitudes exactly across four decades — which is what makes the ceiling a
  // declared limitation rather than a hidden threshold.
  for (const entry of ladderSolved) {
    for (const [index, period] of entry.solution.forecast.entries()) {
      const criterion = period.graph_driven_solve.convergence_criterion;
      const baseline =
        ladderSolved[0].solution.forecast[index].graph_driven_solve.convergence_criterion;
      const expected = baseline.scale_free_tolerance * entry.factor;
      const bound = Math.max(expected, Number.MIN_VALUE) * 1e-12;
      assert.ok(
        Math.abs(criterion.scale_free_tolerance - expected) <= bound,
        `scale x${entry.factor} period ${index}: ${criterion.scale_free_tolerance} is not ${expected}`,
      );
      assert.equal(criterion.form, "relative_below_declared_reference_magnitude");
    }
  }
});

check("the criterion is derived from the policy, not from a literal", () => {
  const criterion = ladderSolved[0].solution.forecast[0].graph_driven_solve.convergence_criterion;
  assert.equal(criterion.reference_state_magnitude, 1e3);
  assert.equal(
    criterion.relative_tolerance,
    ABSOLUTE_TOLERANCE / criterion.reference_state_magnitude,
    "the relative tolerance IS the retired absolute tolerance restated at the reference magnitude",
  );
  assert.equal(criterion.envelope_ceiling, ABSOLUTE_TOLERANCE);
});

check("at the reference magnitude the criterion reproduces the retired one exactly", () => {
  const state = new Array(13).fill(1e3);
  const criterion = convergenceCriterion(state, state, { absoluteTolerance: ABSOLUTE_TOLERANCE });
  assert.equal(criterion.state_scale, 1e3);
  assert.equal(criterion.relative_term, ABSOLUTE_TOLERANCE);
  assert.equal(criterion.binding_term, "relative");
});

// ===========================================================================
// B2. THE FLOOR — derived from IEEE754, never chosen, and never binding on the
//     corpus (so the relative term is what actually decides).
// ===========================================================================

const UNIT_ROUNDOFF = Number.EPSILON / 2;

check("the float-noise floor is the declared recursive-summation bound", () => {
  // (n-1) * u * SUM|xi| + u * |target|, safety factor 4, with SUM taken over
  // BOTH iterates being compared — the conservative side, since either one
  // could be the chain that accumulated the rounding.
  const state = [3, -4, 5];
  const termSum = 2 * (3 + 4 + 5);
  const expected = 4 * UNIT_ROUNDOFF * ((3 - 1) * termSum + 5);
  assert.equal(convergenceFloatNoiseFloor(state, state), expected);
  assert.equal(convergenceFloatNoiseFloor(null, state), 4 * UNIT_ROUNDOFF * (2 * 12 + 5));
  assert.equal(convergenceStateScale(state, state), 5);
  assert.equal(convergenceStateScale(null, state), 5);
  assert.equal(convergenceStateScale(null, null), 0);
});

check("the floor scales with the magnitudes, so it cannot reintroduce scale dependence", () => {
  const small = [1, 2, 3];
  const large = small.map((v) => v * 1e6);
  const ratio =
    convergenceFloatNoiseFloor(large, large) / convergenceFloatNoiseFloor(small, small);
  assert.ok(Math.abs(ratio - 1e6) <= 1e-6 * 1e6, `floor ratio ${ratio} is not 1e6`);
});

const archetypeFiles = fs
  .readdirSync(ARCHETYPES)
  .filter((name) => name.endsWith(".json"))
  .sort();
const corpus = [];
for (const name of archetypeFiles) {
  try {
    corpus.push({ name, solution: solveCase(archetype(name)) });
  } catch {
    // A case the pipeline lawfully refuses has no fixed point to judge.
  }
}

check("the corpus is broad enough for the claims below to mean something", () => {
  assert.ok(corpus.length >= 25, `only ${corpus.length} archetypes solved`);
});

check("the applied tolerance is NEVER below the derived float-noise floor", () => {
  for (const item of corpus) {
    for (const [index, period] of item.solution.forecast.entries()) {
      const criterion = period.graph_driven_solve.convergence_criterion;
      assert.ok(
        criterion.applied_tolerance >= criterion.float_noise_floor,
        `${item.name} period ${index}: tolerance below the arithmetic's own resolution`,
      );
    }
  }
});

check("the float-noise floor NEVER binds on the corpus, at any period", () => {
  let worstMargin = Infinity;
  for (const item of corpus) {
    for (const period of item.solution.forecast) {
      const criterion = period.graph_driven_solve.convergence_criterion;
      assert.notEqual(
        criterion.binding_term,
        "float_noise_floor",
        `${item.name}: the float floor bound the criterion — the relative tolerance is too tight to be meaningful`,
      );
      const margin = criterion.relative_term / criterion.float_noise_floor;
      if (margin < worstMargin) worstMargin = margin;
    }
  }
  assert.ok(
    worstMargin > 100,
    `the relative tolerance sits only ${worstMargin}x above the noise floor; it must not ask the iteration to chase rounding`,
  );
});

check("the declared envelope is the ONLY reason the criterion is ever not scale-free", () => {
  const outside = [];
  for (const item of corpus) {
    for (const period of item.solution.forecast) {
      const criterion = period.graph_driven_solve.convergence_criterion;
      if (criterion.within_declared_envelope) continue;
      outside.push(item.name);
      assert.ok(
        criterion.state_scale > criterion.reference_state_magnitude,
        `${item.name}: only a state above the reference magnitude may leave the envelope`,
      );
      assert.equal(criterion.applied_tolerance, ABSOLUTE_TOLERANCE);
    }
  }
  // Named, so the envelope's reach is a declared fact and not a later surprise.
  assert.deepEqual(
    [...new Set(outside)].sort(),
    ["hyperinflationary_reporting.json", "net_cash_interest_income_dominant.json", "standard-maximal-v2.json"].filter(
      (name) => corpus.some((item) => item.name === name),
    ),
  );
});

check("every solved period's residual is inside the criterion that accepted it", () => {
  for (const item of corpus) {
    for (const [index, period] of item.solution.forecast.entries()) {
      const criterion = period.graph_driven_solve.convergence_criterion;
      assert.ok(
        Number(period.residual) <= criterion.applied_tolerance,
        `${item.name} period ${index}: residual ${period.residual} exceeds the applied ${criterion.applied_tolerance}`,
      );
    }
  }
});

// ===========================================================================
// C. A GENUINE NON-CONVERGENCE IS STILL CAUGHT — at every scale.
// ===========================================================================

/** Loop gain above 1: cash -> cash interest income -> CFO -> cash. */
function divergentCase(modelCase) {
  const out = structuredClone(modelCase);
  out.cash_policy.cash_yield = out.cash_policy.cash_yield.map(() => 5);
  return out;
}

check("a divergent fixed point is refused at every scale, large and small", () => {
  const scales = [
    [1, "millions"],
    [1e3, "thousands"],
    [1e6, "units"],
    [1e-3, "millions"],
  ];
  for (const [factor, units] of scales) {
    const base = factor === 1 ? structuredClone(registeredBase) : restate(registeredBase, factor, units);
    assert.throws(
      () => solveCase(divergentCase(base)),
      /SOLVER_NON_CONVERGENCE/,
      `a loop gain of 5 must still be refused at ${units} (x${factor})`,
    );
  }
});

check("the refusal carries the criterion it judged against", () => {
  let thrown = null;
  try {
    solveCase(divergentCase(structuredClone(registeredBase)));
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "expected a refusal");
  assert.equal(thrown.code, "SOLVER_NON_CONVERGENCE");
  assert.equal(thrown.convergence_criterion.form, "relative_below_declared_reference_magnitude");
  assert.ok(thrown.residual > thrown.convergence_criterion.applied_tolerance);
});

check("MUTATION — at SMALL scale the retired absolute tolerance would have lied", () => {
  // A state vector of magnitude 1 (an issuer reporting in billions, or a small
  // subsidiary) moving by 5e-9 per sweep: the retired 1e-8 calls that a fixed
  // point; the relative criterion, correctly, does not.
  const state = new Array(13).fill(1);
  const criterion = convergenceCriterion(state, state, { absoluteTolerance: ABSOLUTE_TOLERANCE });
  const movement = 5e-9;
  assert.ok(movement <= ABSOLUTE_TOLERANCE, "the retired threshold accepts this movement");
  assert.ok(
    movement > criterion.applied_tolerance,
    `the relative criterion (${criterion.applied_tolerance}) must reject it`,
  );
  assert.ok(
    criterion.applied_tolerance < ABSOLUTE_TOLERANCE,
    "the repair must be STRICTER below the reference magnitude, not looser",
  );
});

check("MUTATION — inside the envelope, a restatement cannot change the verdict", () => {
  // Two states 100x apart, both inside the declared envelope, with residuals
  // in the same ratio: the criterion must reach the same verdict for both,
  // where a constant would have accepted one and refused the other.
  const small = new Array(13).fill(1);
  const large = small.map((value) => value * 1e2);
  const smallCriterion = convergenceCriterion(small, small, {});
  const largeCriterion = convergenceCriterion(large, large, {});
  assert.equal(smallCriterion.within_declared_envelope, true);
  assert.equal(largeCriterion.within_declared_envelope, true);
  const residualSmall = smallCriterion.applied_tolerance * 0.9;
  const residualLarge = residualSmall * 1e2;
  assert.ok(residualSmall <= smallCriterion.applied_tolerance, "relative: converged");
  assert.ok(residualLarge <= largeCriterion.applied_tolerance, "relative: same verdict");
  assert.ok(
    residualSmall < ABSOLUTE_TOLERANCE && residualLarge < ABSOLUTE_TOLERANCE,
    "and both sit under the constant, so the constant cannot tell them apart at all",
  );
  assert.ok(
    largeCriterion.applied_tolerance / smallCriterion.applied_tolerance - 1e2 < 1e-9,
    "the criterion itself must scale with the states",
  );
});

// ===========================================================================
// D. WHAT MOVED — declared, not discovered later.
// ===========================================================================

// Only P4.7's observation containers and the graph evidence are excluded. The
// published `residual` and `convergence_tolerance` are deliberately INSIDE the
// signature: this package could plausibly have moved either, so the proof is
// worth nothing if it looks away from them.
const DIAGNOSTIC_KEYS = new Set([
  "graph_driven_solve",
  "equation_graph_evidence",
  "solve_order_evidence",
  "convergence_trace",
  "scc_residuals",
]);
function economicsOnly(value) {
  if (Array.isArray(value)) return value.map(economicsOnly);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => !DIAGNOSTIC_KEYS.has(key))
        .map((key) => [key, economicsOnly(value[key])]),
    );
  }
  return value;
}
const economicSignature = (solution) =>
  createHash("sha256").update(JSON.stringify(economicsOnly(solution))).digest("hex");

/**
 * Measured on the tree immediately BEFORE this package's edit, and unchanged
 * after it. Every forecast field, every instrument result, every statement
 * value, plus `residual`, `iterations`, `converged` and
 * `convergence_tolerance`.
 */
const CERTIFIED_ECONOMIC_SIGNATURES = Object.freeze({
  "standard-maximal-v2":
    "e5a5b35338643623bc4371e88e5ce161b92ca23e105d35d3cfa3ae296b5f3b8c",
  "standard-net-cash-v2":
    "0d89110a30f37f491bbd0747433b5e2f24a93937b0a10fd57c7c38d847555693",
});

check("HASH EQUALITY — neither certified fixture's economics moved", () => {
  for (const name of ["standard-maximal-v2", "standard-net-cash-v2"]) {
    const solution = solveCase(certified(name));
    assert.equal(
      economicSignature(solution),
      CERTIFIED_ECONOMIC_SIGNATURES[name],
      `${name}: an emitted number moved`,
    );
  }
});

check("the published convergence_tolerance still names the DECLARED policy tolerance", () => {
  for (const name of ["standard-maximal-v2", "standard-net-cash-v2"]) {
    const modelCase = certified(name);
    const solution = solveCase(modelCase);
    assert.equal(solution.convergence_tolerance, ABSOLUTE_TOLERANCE);
    // The two readers outside this package's mandate are therefore untouched.
    assert.deepEqual(validateFixedPointSolution(modelCase, solution), []);
  }
});

/**
 * ONE archetype changes its sweep count, and it is named here so the movement
 * is a declared consequence rather than a later surprise. It is a small case
 * (state magnitude ~76) that the absolute constant accepted at 8.9e-11 relative
 * movement; under a criterion proportional to its own magnitude it works one
 * sweep harder and lands at 3.44e-10 absolute instead of 6.76e-9. The change is
 * a strengthening, in the direction the register warned must not be lost.
 */
const DECLARED_SWEEP_CHANGES = Object.freeze({
  "loss_making_no_nol_stock.json": { before: [6, 6, 5], after: [6, 6, 6] },
});

check("exactly the one declared archetype changed its sweep count", () => {
  for (const [name, expected] of Object.entries(DECLARED_SWEEP_CHANGES)) {
    const solution = solveCase(archetype(name));
    assert.deepEqual(
      solution.forecast.map((p) => p.iterations),
      expected.after,
      `${name}: sweep count is not the declared ${expected.after.join(",")}`,
    );
    assert.notDeepEqual(expected.before, expected.after);
  }
});

// ===========================================================================
// E. D28 / MG-1 — the escape reproduces, the repair is measured, and the five
//    artefacts it needs are named. NOTHING is written to any asset.
// ===========================================================================

const MISSING_EDGE = Object.freeze({
  id: "edge.tax_expense_to_cfo",
  from: "statement.tax_expense",
  to: "cash.cfo",
  type: "cash_flow_bridge",
  activation: "always",
});

const REPAIRED_SCC = Object.freeze([
  "cash.cfo",
  "cash.ending_balance",
  "interest.cash_income",
  "interest.commitment_fee",
  "interest.gross_expense",
  "interest.income",
  "interest.net_expense",
  "interest.rcf",
  "rcf.draw",
  "rcf.ending_balance",
  "rcf.repayment",
  "statement.cash_flow_start",
  "statement.finance_expense",
  "statement.finance_income",
  "statement.pre_tax_income",
  "statement.tax_expense",
]);

const repairedGraph = (() => {
  const graph = JSON.parse(JSON.stringify(EQUATION_GRAPH));
  graph.edges.push({ ...MISSING_EDGE });
  return graph;
})();

function forwardReachable(startId, graph, circularity) {
  const edges = activeEquationEdges(graph, circularity);
  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  const seen = new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const target of (outgoing.get(id) ?? []).sort()) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

check("the shipped asset is UNREPAIRED — this package wrote nothing to it", () => {
  assert.equal(
    EQUATION_GRAPH.edges.some(
      (edge) => edge.from === MISSING_EDGE.from && edge.to === MISSING_EDGE.to,
    ),
    false,
    "the graph must still lack the edge; landing it is proved impossible below",
  );
  assert.equal(
    CONVERGENCE_CONTRACT.scc_contract.active_by_circularity["1"][0].nodes.length,
    13,
    "the contract must still declare the 13-node SCC",
  );
  assert.deepEqual(validateEquationGraph(EQUATION_GRAPH), []);
});

check("RED — the tax charge reaches operating cash flow, and the graph denies it", () => {
  const before = solveCase(archetype("deferred_revenue_ratable.json"));
  const after = solveCase(
    applyTransform("perturb_effective_tax_rate", archetype("deferred_revenue_ratable.json")),
  );
  assert.equal(before.forecast[0].tax, 0);
  assert.equal(after.forecast[0].tax, 42.27117623444384);
  assert.equal(before.forecast[0].cash_from_operations, 282.18090452260935);
  assert.equal(after.forecast[0].cash_from_operations, 239.69731031714127);
  const reachable = forwardReachable("statement.effective_tax_rate", EQUATION_GRAPH, 1);
  assert.equal(reachable.has("cash.cfo"), false, "the shipped graph declares no path");
  assert.equal(reachable.has("statement.tax_expense"), true);
});

check("the one edge WOULD close the locality escape", () => {
  const reachable = forwardReachable("statement.effective_tax_rate", repairedGraph, 1);
  for (const node of [
    "cash.cfo",
    "cash.ending_balance",
    "interest.income",
    "interest.net_expense",
    "interest.gross_expense",
    "interest.rcf",
    "rcf.ending_balance",
    "rcf.repayment",
    "rcf.liquidity_shortfall",
    "statement.pre_tax_income",
  ]) {
    assert.ok(reachable.has(node), `${node} is still unreachable with the edge added`);
  }
});

check("the edge CLOSES A CYCLE: the active SCC grows from 13 nodes to 16", () => {
  for (const options of [{}, { circularity: 1 }]) {
    const components = deriveStronglyConnectedComponents(repairedGraph, options)
      .filter((component) => component.length > 1)
      .map((component) => [...component].sort());
    assert.equal(components.length, 1);
    assert.deepEqual(components[0], [...REPAIRED_SCC]);
  }
  assert.deepEqual(
    deriveStronglyConnectedComponents(repairedGraph, { circularity: 0 }).filter(
      (component) => component.length > 1,
    ),
    [],
    "circularity off must stay acyclic — the tax charge is not iterated there",
  );
});

check("P3.3 RE-RUN — the ETR path is no longer DAG-safe, in exactly three ways", () => {
  assert.deepEqual(
    validateEffectiveTaxRatePathAcyclicity(EQUATION_GRAPH),
    [],
    "P3.3 holds on the graph as shipped",
  );
  const errors = validateEffectiveTaxRatePathAcyclicity(repairedGraph);
  assert.equal(errors.length, 3, `expected exactly three obligations to fail:\n- ${errors.join("\n- ")}`);
  assert.ok(errors[0].includes("structural strongly connected component"));
  assert.ok(errors[1].includes("circularity-on strongly connected component"));
  assert.ok(errors[2].includes("the tax path must terminate"));
  for (const error of errors.slice(0, 2)) {
    assert.ok(error.includes("statement.pre_tax_income"));
    assert.ok(error.includes("statement.tax_expense"));
  }
});

check("the repaired graph does not load: the solver's iteration vector is coupled to the SCC", () => {
  const errors = validateEquationGraph(repairedGraph, CONVERGENCE_CONTRACT);
  const expected = [
    "equation graph hash mismatch",
    "derived structural SCCs do not match",
    "circularity-on active SCCs do not match",
    "solver iteration state vector must contain exactly the circularity-on active SCC nodes",
  ];
  for (const fragment of expected) {
    assert.ok(
      errors.some((error) => error.includes(fragment)),
      `expected a failure naming "${fragment}"; got:\n- ${errors.join("\n- ")}`,
    );
  }
});

check("P4.4 RE-RUN — the module partition refuses an edge no module owns", () => {
  assert.deepEqual(
    validateModuleContractConformance({ graph: EQUATION_GRAPH }).filter((error) =>
      error.startsWith("MODULE_EDGE"),
    ),
    [],
    "the shipped 71-edge partition is total",
  );
  assert.deepEqual(
    validateModuleContractConformance({ graph: repairedGraph }).filter((error) =>
      error.startsWith("MODULE_EDGE"),
    ),
    [
      "MODULE_EDGE_OWNER_DISAGREEMENT: edge.tax_expense_to_cfo -> cash.cfo owned by cash_rcf, declared by nobody",
    ],
  );
});

check("P4.7 RE-RUN — the hand-written solve order STILL agrees with the repaired graph", () => {
  const solution = solveCase(certified("standard-maximal-v2"));
  const observed = solution.solve_order_evidence.observed_orders[0].order;
  assert.equal(solution.solve_order_evidence.observed_orders[0].agreement.agrees, true);
  const repairedOrder = deriveSolveOrder(repairedGraph, 1);
  const agreement = checkSolveOrderAgreement(observed, repairedOrder);
  assert.equal(
    agreement.agrees,
    true,
    `the observed order disagrees with the repaired graph: ${JSON.stringify(agreement.violations)}`,
  );
  assert.deepEqual(agreement.violations, []);
  assert.ok(
    agreement.inter_component_edges_checked <
      solution.solve_order_evidence.observed_orders[0].agreement.inter_component_edges_checked,
    "absorbing three nodes into the SCC must move edges from inter- to intra-component",
  );
});

console.log(JSON.stringify({ status: "PASS", checks }));
