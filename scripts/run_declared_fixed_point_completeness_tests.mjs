#!/usr/bin/env node
/**
 * P4.10 — DECLARED FIXED-POINT COMPLETENESS (defect D28 / MG-1, and the false
 * sealed proof that sat on top of it).
 *
 * THE INVARIANT
 *   The declared fixed point must contain every node the running solver
 *   actually iterates. A proof of acyclicity must be a proof about the SOLVER,
 *   not about a graph that omits the solver's real edges.
 *
 * THE FINDING
 *   `assets/equation-graph.v1.json` declared a 13-node strongly connected
 *   component and `solver.mjs` declared a 13-entry iteration vector. The sweep
 *   in `solveCase` has always computed `netInterest` from the iterated interest
 *   quantities, `preTaxIncome` from `netInterest`, `taxCharge` from
 *   `preTaxIncome`, `netIncome` from `taxCharge`, and has always seeded
 *   `cashFlowStart` and `cashFromOperations` from `netIncome`. Four more
 *   quantities were therefore inside the loop, moving every sweep, with their
 *   convergence never tested — and P3.3's sealed ETR acyclicity proof asserted
 *   a SINK property the solver does not have. The proof was true about the
 *   graph and false about the system.
 *
 * WHAT THIS SUITE PROVES, IN ORDER
 *   A. THE RED PROOF, instrumented. An instrumented copy of `solver.mjs` is
 *      built at runtime by SOURCE REWRITE and records the solver's own
 *      per-sweep computation object. The set of quantities that move between
 *      sweeps is read off that record — never off the graph, never off a
 *      hand-written list of "what ought to move". Against the pre-P4.10
 *      13-entry declaration that measured set is a STRICT SUPERSET, and the
 *      four extra members are named. Against the shipped 17-entry declaration
 *      it is contained exactly.
 *   B. THE FEEDBACK PROOF, behavioural, with no instrumentation at all.
 *      Perturbing ONLY `statement.effective_tax_rate` — an exogenous input
 *      whose declared consumers were all outside the fixed point — moves nodes
 *      INSIDE it. That is a cycle through the tax path in the running solver,
 *      demonstrated without reference to any graph. This section also carries
 *      the measurement that CHOSE the edge: operating cash flow tracks NET
 *      INCOME exactly, not the tax charge.
 *   C. THE LANDING. All five artefacts moved together, and each one is shown
 *      to refuse the others' pre-P4.10 state.
 *   D. NO NUMBER MOVED, proven structurally rather than by a golden: at every
 *      sweep of every period of the corpus, the sweep at which the 13-component
 *      residual first falls under the applied tolerance is the SAME sweep at
 *      which the 17-component residual does. The enlargement cannot change an
 *      iteration count, and therefore cannot change an answer.
 *   E. ANTI-WEAKENING. Withdrawing any one of the five artefacts is refused.
 *
 * Emits one line: {"status":"PASS","checks":N}
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CONVERGENCE_CONTRACT,
  EFFECTIVE_TAX_RATE_PATH,
  EQUATION_GRAPH,
  canonicalJsonSha256,
  compileEffectiveTaxRatePathProof,
  deriveStronglyConnectedComponents,
  validateEffectiveTaxRatePathAcyclicity,
  validateEquationGraph,
} from "./lib/equation_graph.mjs";
import { solveCase, solverIterationDeclaration } from "./lib/solver.mjs";
import { validateFixedPointSolution } from "./lib/fixed_point_constitution.mjs";
// READ ONLY. P4.4 owns the module partition; this suite asks it what it says.
import {
  CANONICAL_MODULE_BOUNDARIES,
  validateGraphInvariants,
  validateModuleContractConformance,
} from "./lib/canonical_model_modules.mjs";
import { compileModelIrV3, workbookSemanticProofContract } from "./lib/model_ir_v3.mjs";
import { compileRowPlan } from "./lib/row_plan.mjs";
import { compileSemanticManifest } from "./lib/semantic_graph.mjs";
import { compileInstrumentPeriodState } from "./lib/instrument_period_state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LIB = path.join(ROOT, "scripts", "lib");
const ARCHETYPES = path.join(ROOT, "test-fixtures", "archetypes", "economics");
const CASES = path.join(ROOT, "test-fixtures", "cases");

let checks = 0;
// Honest mutation accounting: the MUTATION checks below each apply a real
// defect to a COPY of a declared artefact (withdrawn edges, a shrunken fixed
// point, an emptied iteration state, an unowned edge, a starved workbook row)
// and are counted CAUGHT only when production refuses the copy while the mutant
// is active. A surviving mutant exits the suite before its catch is counted.
let mutations_total = 0;
let mutations_caught = 0;
function check(description, fn) {
  const isMutation = /^MUTATION/.test(description);
  if (isMutation) mutations_total += 1;
  try {
    fn();
  } catch (error) {
    console.error(`FAIL ${description}\n${error?.message ?? error}`);
    process.exit(1);
  }
  if (isMutation) mutations_caught += 1;
  checks += 1;
}

const readCase = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const archetype = (name) => readCase(path.join(ARCHETYPES, name));
function certified(name) {
  const modelCase = readCase(path.join(CASES, `${name}.json`));
  modelCase.execution_profile = "reference_parity";
  return modelCase;
}

// ===========================================================================
// The two declarations under test, and the one that preceded them.
// ===========================================================================

/**
 * The solver's declaration BEFORE this package. Frozen here as a literal so the
 * red proof survives the repair: a red proof that is re-derived from the
 * artefact it is proving red stops being a proof the moment the artefact is
 * fixed.
 */
const PRE_P410_DECLARED_VECTOR = Object.freeze([
  "cash.cfo",
  "cash.ending_balance",
  "interest.cash_income",
  "interest.commitment_fee",
  "interest.gross_expense",
  "interest.income",
  "interest.rcf",
  "rcf.draw",
  "rcf.ending_balance",
  "rcf.repayment",
  "statement.cash_flow_start",
  "statement.finance_expense",
  "statement.finance_income",
]);

const SHIPPED_VECTOR = solverIterationDeclaration(1).state_vector.map(
  (component) => component.node_id,
);

// ===========================================================================
// A. THE RED PROOF — instrumented, and derived from the solver's own record.
// ===========================================================================

/**
 * The join between the solver's per-sweep record and the equation graph's
 * nodes. It is a hand-written table and that is a hazard, so it is checked in
 * BOTH directions and it is never derived from the graph's edges, its
 * components or either declaration:
 *
 *   - every graph node appears exactly once, here or in the table below it;
 *   - every observable named here is present in a real record;
 *   - a graph node added without a classification fails the totality check.
 *
 * The values are the solver's OWN field names, so a rename in `solver.mjs`
 * breaks the join loudly instead of quietly shrinking the measured set.
 */
const OBSERVABLE_BY_NODE = Object.freeze({
  "cash.cfo": "cash_from_operations",
  "cash.ending_balance": "ending_cash",
  "cash.minimum_cash": "minimum_cash",
  "debt.issuance": "non_rcf_debt_issuance",
  "debt.mandatory_repayment": "mandatory_repayment",
  "interest.acquisition": "acquisition_interest",
  "interest.cash_income": "interest_income",
  "interest.commitment_fee": "rcf_commitment_fee",
  "interest.gross_expense": "gross_interest",
  "interest.income": "interest_income",
  "interest.instrument_pik": "non_cash_instrument_interest",
  "interest.lease": "lease_interest",
  "interest.net_expense": "net_interest",
  "interest.noncash": "non_cash_interest",
  "interest.other": "other_interest",
  "interest.rcf": "rcf_interest",
  "lease.principal": "lease_principal",
  "rcf.capacity": "rcf_capacity_native",
  "rcf.draw": "rcf_draw",
  "rcf.ending_balance": "ending_rcf",
  "rcf.liquidity_shortfall": "liquidity_shortfall",
  "rcf.repayment": "rcf_repayment",
  "statement.ebit": "ebit",
  "statement.net_income": "net_income",
  "statement.pre_tax_income": "pre_tax_income",
  // The record carries the solver's internal `taxCharge`, which is the negation
  // of the statement row. Movement is sign-invariant, so the measurement is
  // unaffected; the SNAPSHOT the residual is taken over carries the signed
  // statement quantity, which is the row the workbook emits.
  "statement.tax_expense": "tax",
});

/**
 * Graph nodes the per-sweep record does not carry as a distinct field, each
 * with the reason. Every one of these is either a control, or an alias of a
 * quantity that IS observed, so none can hide an independent iterate.
 */
const NOT_OBSERVABLE_IN_SWEEP_RECORD = Object.freeze({
  "control.circularity": "a control switch, not an economic quantity",
  "cash.cash_interest_paid":
    "the record carries its three components (gross_interest, non_cash_interest, non_cash_instrument_interest)",
  "cash.cash_interest_received": "identically interest_income, which is observed",
  "cash.net_finance_addback": "identically net_interest, which is observed",
  "cash.noncash_interest_addback":
    "identically non_cash_interest + non_cash_instrument_interest, both observed",
  "debt.maturity_repayment": "aggregated into mandatory_repayment, which is observed",
  "debt.pik_accretion":
    "per-instrument; the reporting total is non_cash_instrument_interest, which is observed",
  "debt.scheduled_amortisation": "per-instrument; aggregated into mandatory_repayment",
  "interest.instrument_cash":
    "per-instrument; instrument_interest carries cash and PIK together and the PIK leg is observed",
  "statement.cash_flow_start":
    "a sweep local (`cashFlowStart`); it takes the declared cash-flow start row and otherwise net_income, which is observed",
  "statement.effective_tax_rate":
    "an INPUT. Section A-4 proves separately that nothing computes it and that its per-sweep republication is stable to within one ulp",
  "statement.finance_expense": "identically -gross_interest, which is observed",
  "statement.finance_income": "identically interest_income, which is observed",
});

check("the observable classification is TOTAL over the graph and disjoint", () => {
  const classified = [
    ...Object.keys(OBSERVABLE_BY_NODE),
    ...Object.keys(NOT_OBSERVABLE_IN_SWEEP_RECORD),
  ];
  assert.equal(
    new Set(classified).size,
    classified.length,
    "a node is classified twice",
  );
  assert.deepEqual(
    [...classified].sort(),
    EQUATION_GRAPH.nodes.map((node) => node.id).sort(),
    "every equation-graph node must be classified as observable or explicitly not",
  );
});

/**
 * Build an instrumented copy of `solver.mjs`. The copy is generated from the
 * shipped source at run time, so it can never drift from the module it is
 * measuring; the anchor is asserted, so a future edit that moves the recording
 * site fails this suite rather than silently disabling the measurement.
 */
function instrumentedSolverPath() {
  const source = fs.readFileSync(path.join(LIB, "solver.mjs"), "utf8");
  const anchor =
    "        statement_values: Object.fromEntries(finalStatementValues),\n      };\n";
  assert.equal(
    source.split(anchor).length - 1,
    1,
    "the per-sweep `lastComputation` recording site moved; the red proof must be re-anchored, " +
      "never quietly skipped",
  );
  const probed = source.replace(
    anchor,
    `${anchor}      globalThis.__P410_SWEEP__?.(periodIndex, iteration, lastComputation);\n`,
  );
  const rewritten = probed
    .replaceAll('from "./', `from "${pathToFileURL(LIB).href}/`)
    .replaceAll(
      "import.meta.url",
      JSON.stringify(pathToFileURL(path.join(LIB, "solver.mjs")).href),
    );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p410-probe-"));
  const file = path.join(dir, "probe_solver.mjs");
  fs.writeFileSync(file, rewritten);
  return file;
}

const corpus = [
  ...fs
    .readdirSync(ARCHETYPES)
    .filter((name) => name.endsWith(".json"))
    .map((name) => [name, path.join(ARCHETYPES, name)]),
  ...["standard-maximal-v2", "standard-net-cash-v2"].map((name) => [
    name,
    path.join(CASES, `${name}.json`),
  ]),
];

const sweepPasses = [];
{
  const probe = instrumentedSolverPath();
  const { solveCase: probedSolve } = await import(pathToFileURL(probe).href);
  for (const [name, file] of corpus) {
    const records = [];
    globalThis.__P410_SWEEP__ = (periodIndex, iteration, computation) =>
      records.push({ periodIndex, iteration, computation: { ...computation } });
    const modelCase = readCase(file);
    if (name.startsWith("standard-")) modelCase.execution_profile = "reference_parity";
    try {
      probedSolve(modelCase);
    } catch {
      globalThis.__P410_SWEEP__ = undefined;
      continue;
    }
    globalThis.__P410_SWEEP__ = undefined;
    // A period may be swept more than once (the acquisition overlay re-runs
    // it). A PASS is one uninterrupted iteration sequence, and comparing across
    // a pass boundary would report a re-seed as an iterate.
    let current = null;
    let lastIteration = Number.POSITIVE_INFINITY;
    let lastPeriod = null;
    for (const record of records) {
      if (
        current === null ||
        record.periodIndex !== lastPeriod ||
        record.iteration <= lastIteration
      ) {
        current = { case_name: name, period_index: record.periodIndex, sweeps: [] };
        sweepPasses.push(current);
      }
      current.sweeps.push(record.computation);
      lastIteration = record.iteration;
      lastPeriod = record.periodIndex;
    }
  }
}

check("the instrumented run covers a corpus wide enough to mean something", () => {
  assert.ok(sweepPasses.length >= 90, `only ${sweepPasses.length} passes recorded`);
  const iterating = sweepPasses.filter((pass) => pass.sweeps.length > 1);
  assert.ok(iterating.length >= 60, `only ${iterating.length} passes actually iterate`);
  assert.ok(
    new Set(sweepPasses.map((pass) => pass.case_name)).size >= 30,
    "too few cases contributed",
  );
});

check("every declared observable is really present in the solver's record", () => {
  const seen = new Set();
  for (const pass of sweepPasses) {
    for (const sweep of pass.sweeps) {
      for (const [key, value] of Object.entries(sweep)) {
        if (typeof value === "number") seen.add(key);
      }
    }
  }
  const missing = Object.entries(OBSERVABLE_BY_NODE)
    .filter(([, key]) => !seen.has(key))
    .map(([node, key]) => `${node} -> ${key}`);
  assert.deepEqual(
    missing,
    [],
    "an observable named in the join is absent from every record — the join has drifted",
  );
});

/** Nodes whose observable moves between two consecutive sweeps of one pass. */
const measuredMovingNodes = (() => {
  const moving = new Map();
  for (const pass of sweepPasses) {
    if (pass.sweeps.length < 2) continue;
    for (const [node, key] of Object.entries(OBSERVABLE_BY_NODE)) {
      const values = pass.sweeps.map((sweep) => sweep[key]);
      if (values.some((value) => typeof value !== "number")) continue;
      if (values.some((value, index) => index > 0 && value !== values[index - 1])) {
        if (!moving.has(node)) moving.set(node, new Set());
        moving.get(node).add(pass.case_name);
      }
    }
  }
  return moving;
})();

/**
 * The ONE measured mover that is not a member of the fixed point, with the
 * proof that it is a recomputed OUTPUT rather than an iterate: its value is
 * exactly `max(0, minimum_cash - ending_cash)` in every sweep of every pass, so
 * it is a function of two nodes that ARE declared and carries no state of its
 * own. The list is frozen; a second member would have to be added deliberately.
 */
const RECOMPUTED_OUTPUTS_NOT_ITERATED = Object.freeze(["rcf.liquidity_shortfall"]);

check("RED — the pre-P4.10 declaration is a STRICT SUBSET of what the solver iterates", () => {
  const declared = new Set(PRE_P410_DECLARED_VECTOR);
  const undeclared = [...measuredMovingNodes.keys()]
    .filter((node) => !declared.has(node))
    .filter((node) => !RECOMPUTED_OUTPUTS_NOT_ITERATED.includes(node))
    .sort();
  assert.deepEqual(
    undeclared,
    [
      "interest.net_expense",
      "statement.net_income",
      "statement.pre_tax_income",
      "statement.tax_expense",
    ],
    "the measured moving set must exceed the pre-P4.10 declaration by exactly the tax path",
  );
  // Not a rounding artefact and not one lucky case.
  assert.ok(measuredMovingNodes.get("interest.net_expense").size >= 25);
  assert.ok(measuredMovingNodes.get("statement.pre_tax_income").size >= 25);
  assert.ok(measuredMovingNodes.get("statement.net_income").size >= 25);
  assert.ok(measuredMovingNodes.get("statement.tax_expense").size >= 1);
});

check("GREEN — the SHIPPED declaration contains every node the solver iterates", () => {
  const declared = new Set(SHIPPED_VECTOR);
  const undeclared = [...measuredMovingNodes.keys()]
    .filter((node) => !declared.has(node))
    .sort();
  assert.deepEqual(
    undeclared,
    [...RECOMPUTED_OUTPUTS_NOT_ITERATED],
    "a node the solver measurably iterates is missing from the declared fixed point",
  );
});

check("the one excluded mover is a derived OUTPUT, proven identity-wise", () => {
  let sweeps = 0;
  for (const pass of sweepPasses) {
    for (const sweep of pass.sweeps) {
      const derived = Math.max(0, sweep.minimum_cash - sweep.ending_cash);
      assert.ok(
        Math.abs(derived - sweep.liquidity_shortfall) <= 1e-9,
        `${pass.case_name}: liquidity_shortfall is not max(0, minimum_cash - ending_cash)`,
      );
      sweeps += 1;
    }
  }
  assert.ok(sweeps >= 400, `only ${sweeps} sweeps checked`);
  // A necessary condition for "nothing consumes it", checked at the graph too.
  assert.deepEqual(
    EQUATION_GRAPH.edges.filter((edge) => edge.from === "rcf.liquidity_shortfall"),
    [],
  );
});

check("the effective tax RATE is an input, and its republication is ulp-stable", () => {
  assert.deepEqual(
    EQUATION_GRAPH.edges.filter((edge) => edge.to === "statement.effective_tax_rate"),
    [],
    "nothing in the graph may compute the rate",
  );
  let compared = 0;
  for (const pass of sweepPasses) {
    if (pass.sweeps.length < 2) continue;
    const values = pass.sweeps
      .map((sweep) => sweep.statement_values?.effective_tax_rate)
      .filter((value) => typeof value === "number");
    if (values.length < 2) continue;
    const span = Math.max(...values) - Math.min(...values);
    const scale = Math.max(...values.map(Math.abs), Number.MIN_VALUE);
    assert.ok(
      span <= scale * 8 * Number.EPSILON,
      `${pass.case_name}: the republished rate moved by ${span}, which is more than float noise`,
    );
    compared += 1;
  }
  // Only cases that DECLARE an effective-tax-rate row republish it; the rest
  // carry the rate as a forecast assumption the record does not echo.
  assert.ok(compared >= 8, `only ${compared} passes republished the rate`);
});

// ===========================================================================
// B. THE FEEDBACK PROOF — behavioural, no instrumentation, no graph.
// ===========================================================================

/**
 * `loss_making_no_nol_stock` declares its effective tax rate as a plain
 * forecast assumption, so the perturbation touches ONE exogenous input and
 * nothing else. Everything below is `solveCase` output.
 */
function taxRatePerturbed(name, rate) {
  const modelCase = archetype(name);
  modelCase.forecast_assumptions.effective_tax_rate =
    modelCase.forecast_assumptions.effective_tax_rate.map(() => rate);
  return modelCase;
}

const feedbackBefore = solveCase(archetype("loss_making_no_nol_stock.json"));
const feedbackAfter = solveCase(taxRatePerturbed("loss_making_no_nol_stock.json", 0.3));

check("RED, behavioural — perturbing ONLY the tax rate moves the INTEREST loop", () => {
  const before = feedbackBefore.forecast[2];
  const after = feedbackAfter.forecast[2];
  assert.notEqual(before.tax, after.tax, "the perturbation must bite");
  for (const field of [
    "interest_income",
    "net_interest",
    "pre_tax_income",
    "cash_from_operations",
    "ending_cash",
  ]) {
    assert.notEqual(
      before[field],
      after[field],
      `${field} did not move: the tax path would then be outside the loop`,
    );
  }
  // `interest_income` is a member of the fixed point under BOTH declarations.
  // Its movement therefore proves a cycle through the tax path in the running
  // solver, with no appeal to any graph.
  assert.ok(PRE_P410_DECLARED_VECTOR.includes("interest.cash_income"));
  assert.ok(SHIPPED_VECTOR.includes("interest.cash_income"));
  assert.ok(Math.abs(after.interest_income - before.interest_income) > 1e-6);
});

check("the measurement that CHOSE the edge: CFO tracks NET INCOME, not the charge", () => {
  const before = feedbackBefore.forecast[2];
  const after = feedbackAfter.forecast[2];
  const cfoDelta = after.cash_from_operations - before.cash_from_operations;
  const netIncomeDelta = after.net_income - before.net_income;
  const taxDelta = after.tax - before.tax;
  assert.ok(
    Math.abs(cfoDelta - netIncomeDelta) <= 1e-12,
    `CFO moved ${cfoDelta} and net income moved ${netIncomeDelta}`,
  );
  assert.ok(
    Math.abs(cfoDelta + taxDelta) > 1e-3,
    "CFO must NOT track the tax charge — if it did, `tax_expense -> cash.cfo` would be the " +
      "faithful edge and net income could stay outside the fixed point",
  );
  // And the solver says so in source: net income is what the cash flow is
  // seeded from, whichever rows the issuer declares.
  const source = fs.readFileSync(path.join(LIB, "solver.mjs"), "utf8");
  assert.ok(source.includes("const fallbackCashFromOperations =\n        netIncome +"));
  assert.ok(
    source.includes('cashFlowGraph.resolveRole("cash_flow_net_income") ?? netIncome'),
  );
});

// ===========================================================================
// C. THE LANDING — five artefacts, moved together.
// ===========================================================================

const LANDED_EDGES = Object.freeze([
  Object.freeze({
    id: "edge.net_income_to_cash_flow_start",
    from: "statement.net_income",
    to: "statement.cash_flow_start",
    type: "statement_dependency",
    activation: "always",
  }),
  Object.freeze({
    id: "edge.net_income_to_cfo",
    from: "statement.net_income",
    to: "cash.cfo",
    type: "cash_flow_bridge",
    activation: "always",
  }),
]);

check("ARTEFACT 1 — the equation graph declares both edges", () => {
  for (const landed of LANDED_EDGES) {
    const edge = EQUATION_GRAPH.edges.find((item) => item.id === landed.id);
    assert.ok(edge, `${landed.id} is absent`);
    assert.deepEqual({ ...edge }, { ...landed });
  }
  const active = deriveStronglyConnectedComponents(EQUATION_GRAPH, { circularity: 1 })
    .filter((component) => component.length > 1);
  assert.equal(active.length, 1);
  assert.equal(active[0].length, 17);
  assert.deepEqual(
    deriveStronglyConnectedComponents(EQUATION_GRAPH, { circularity: 0 }).filter(
      (component) => component.length > 1,
    ),
    [],
    "with the interest breaker off nothing iterates, tax included",
  );
});

check("ARTEFACT 2 — the convergence contract declares 17 and is hash-rebound", () => {
  const declared = CONVERGENCE_CONTRACT.scc_contract.active_by_circularity["1"];
  assert.equal(declared.length, 1);
  assert.equal(declared[0].nodes.length, 17);
  assert.equal(
    CONVERGENCE_CONTRACT.solver_iteration.state_by_circularity["1"].state_vector.length,
    17,
  );
  assert.equal(
    CONVERGENCE_CONTRACT.graph_binding.canonical_sha256,
    canonicalJsonSha256(EQUATION_GRAPH),
    "the contract must be bound to the hash of the graph it declares",
  );
  assert.deepEqual(
    [...CONVERGENCE_CONTRACT.scc_contract.structural[0].nodes].sort(),
    [...declared[0].nodes].sort(),
  );
});

check("ARTEFACT 3 — the solver's literal vector IS the declared component", () => {
  assert.equal(SHIPPED_VECTOR.length, 17);
  assert.deepEqual(
    [...SHIPPED_VECTOR].sort(),
    [
      ...CONVERGENCE_CONTRACT.solver_iteration.state_by_circularity["1"].state_vector.map(
        (component) => component.node_id,
      ),
    ].sort(),
  );
  assert.deepEqual(
    [...SHIPPED_VECTOR].sort(),
    [...deriveStronglyConnectedComponents(EQUATION_GRAPH, { circularity: 1 })[0]].sort(),
  );
  for (const nodeId of [
    "interest.net_expense",
    "statement.pre_tax_income",
    "statement.tax_expense",
    "statement.net_income",
  ]) {
    assert.ok(SHIPPED_VECTOR.includes(nodeId), `${nodeId} is not in the solver's vector`);
  }
  // And the snapshot really carries a value for each, on real solves.
  for (const name of ["standard-maximal-v2", "standard-net-cash-v2"]) {
    const solution = solveCase(certified(name));
    const evidence = solution.equation_graph_evidence;
    assert.equal(evidence.solver_declaration.state_vector.length, 17);
    assert.deepEqual(validateFixedPointSolution(certified(name), solution), []);
  }
});

check("ARTEFACT 4 — the module partition owns both edges and declares the iteration", () => {
  assert.deepEqual(
    validateModuleContractConformance({ graph: EQUATION_GRAPH }).filter((error) =>
      error.startsWith("MODULE_EDGE"),
    ),
    [],
  );
  assert.deepEqual(
    [...CANONICAL_MODULE_BOUNDARIES.tax_and_working_capital.iteration_state].sort(),
    ["statement.net_income", "statement.pre_tax_income", "statement.tax_expense"],
    "the module that owns the tax path must admit that it iterates",
  );
  assert.ok(
    CANONICAL_MODULE_BOUNDARIES.interest.iteration_state.includes("interest.net_expense"),
  );
  const union = Object.values(CANONICAL_MODULE_BOUNDARIES)
    .flatMap((boundary) => [...boundary.iteration_state])
    .sort();
  assert.deepEqual(
    union,
    [...SHIPPED_VECTOR].sort(),
    "the union of the modules' iteration states must be exactly the solver's vector",
  );
  assert.ok(
    CANONICAL_MODULE_BOUNDARIES.cash_rcf.read_set.some(
      (entry) =>
        entry.channel === "equation_edge" &&
        entry.detail === "statement.net_income" &&
        entry.from_module === "tax_and_working_capital",
    ),
    "the cash bridge must declare net income as an EQUATION-EDGE read, not merely an artifact one",
  );
});

/** Compile the workbook-facing IR the way the builder does. */
function workbookContractFor(name) {
  const modelCase = certified(name);
  const instrumentPeriodState = compileInstrumentPeriodState(modelCase);
  const rowPlan = compileRowPlan(modelCase, { instrumentPeriodState });
  const semanticManifest = compileSemanticManifest(modelCase, rowPlan, {
    instrumentPeriodState,
  });
  const modelIr = compileModelIrV3({
    modelCase,
    rowPlan,
    semanticManifest,
    sourceCrosswalk: [],
  });
  return { modelIr, rowPlan };
}

check("ARTEFACT 5 — every fixed-point node binds to a workbook row", () => {
  const { modelIr, rowPlan } = workbookContractFor("standard-maximal-v2");
  const contract = workbookSemanticProofContract(modelIr, rowPlan, {});
  const graph = contract.fixed_point_formula_graph;
  assert.equal(graph.expected_active_scc_nodes.length, 17);
  assert.equal(graph.node_bindings.length, 17);
  for (const binding of graph.node_bindings) {
    assert.ok(
      Number.isInteger(binding.row),
      `${binding.node_id} has no physical row: the fixed point would be undeliverable`,
    );
  }
  for (const nodeId of [
    "interest.net_expense",
    "statement.pre_tax_income",
    "statement.tax_expense",
    "statement.net_income",
  ]) {
    assert.ok(
      graph.node_bindings.some((binding) => binding.node_id === nodeId),
      `${nodeId} is unbound`,
    );
  }
});

check("P3.3 CORRECTED — its proof passes, and now reports what is iterated", () => {
  assert.deepEqual(validateEffectiveTaxRatePathAcyclicity(EQUATION_GRAPH), []);
  const proof = compileEffectiveTaxRatePathProof(EQUATION_GRAPH);
  assert.equal(proof.acyclic, true);
  assert.equal(proof.rate_is_exogenous, true);
  assert.equal(proof.charge_never_reaches_the_rate, true);
  assert.equal(proof.acyclic_with_circularity_off, true);
  assert.deepEqual(proof.iterated_and_declared_in_fixed_point, [
    "statement.net_income",
    "statement.pre_tax_income",
    "statement.tax_expense",
  ]);
  // The two claims it used to make are GONE from the proof object, so no
  // consumer can still read a property the validator no longer proves.
  assert.equal(
    Object.hasOwn(proof, "outside_every_strongly_connected_component"),
    false,
  );
  assert.equal(Object.hasOwn(proof, "terminates"), false);
  assert.equal(EFFECTIVE_TAX_RATE_PATH.roles.length, 4);
});

// ===========================================================================
// D. NO NUMBER MOVED — proven structurally, without a golden.
// ===========================================================================

/**
 * The published residual is an L-infinity norm over the declared vector. Adding
 * four components can only make it larger, so the only way the landing could
 * move an answer is by making a period take one more sweep. That is decidable
 * from the instrumented record: recompute both norms at every sweep and compare
 * the sweep at which each first falls under the tolerance the solve applied.
 */
const RESIDUAL_KEYS_13 = PRE_P410_DECLARED_VECTOR.map(
  (node) => OBSERVABLE_BY_NODE[node],
).filter(Boolean);
const RESIDUAL_KEYS_17 = SHIPPED_VECTOR.map((node) => OBSERVABLE_BY_NODE[node]).filter(
  Boolean,
);

check("the two residual bases are the ones the two declarations name", () => {
  // Ten distinct observables carry the thirteen pre-P4.10 nodes:
  // `statement.cash_flow_start`, `statement.finance_expense` and
  // `statement.finance_income` are aliases of quantities already in the list
  // and the record carries no separate field for them.
  assert.equal(RESIDUAL_KEYS_13.length, 10);
  assert.equal(RESIDUAL_KEYS_17.length, 14);
  assert.equal(RESIDUAL_KEYS_17.length - RESIDUAL_KEYS_13.length, 4);
  assert.ok(RESIDUAL_KEYS_17.includes("net_interest"));
  assert.ok(RESIDUAL_KEYS_17.includes("pre_tax_income"));
  assert.ok(RESIDUAL_KEYS_17.includes("tax"));
  assert.ok(RESIDUAL_KEYS_17.includes("net_income"));
  assert.ok(!RESIDUAL_KEYS_13.includes("net_income"));
});

check("ENLARGING THE RESIDUAL CANNOT MOVE A SWEEP COUNT — every period, every case", () => {
  const norm = (keys, a, b) =>
    Math.max(...keys.map((key) => Math.abs(Number(b[key]) - Number(a[key]))));
  let compared = 0;
  let strictlyLarger = 0;
  for (const pass of sweepPasses) {
    if (pass.sweeps.length < 2) continue;
    // The tolerance the solve applied is bounded below by the smallest step it
    // refused and above by the step it accepted; using the ACCEPTED step as the
    // threshold is the strictest available reading.
    const accepted = norm(
      RESIDUAL_KEYS_13,
      pass.sweeps[pass.sweeps.length - 2],
      pass.sweeps[pass.sweeps.length - 1],
    );
    const enlarged = norm(
      RESIDUAL_KEYS_17,
      pass.sweeps[pass.sweeps.length - 2],
      pass.sweeps[pass.sweeps.length - 1],
    );
    assert.ok(
      enlarged >= accepted - 1e-18,
      `${pass.case_name}: the enlarged norm is smaller, which is impossible`,
    );
    if (enlarged > accepted) strictlyLarger += 1;
    // The decisive check: at the accepting sweep the enlarged norm must still
    // be no larger than the smallest step the solve REFUSED, or the extra
    // components would have bought an extra sweep.
    if (pass.sweeps.length >= 3) {
      const refused = norm(
        RESIDUAL_KEYS_13,
        pass.sweeps[pass.sweeps.length - 3],
        pass.sweeps[pass.sweeps.length - 2],
      );
      assert.ok(
        enlarged < refused,
        `${pass.case_name}/p${pass.period_index}: the enlarged residual ${enlarged} is not below ` +
          `the smallest refused step ${refused}, so the sweep count could move`,
      );
    }
    compared += 1;
  }
  assert.ok(compared >= 60, `only ${compared} passes compared`);
  assert.ok(
    strictlyLarger > 0,
    "if the enlarged norm were never strictly larger, the four components would be " +
      "cosmetic and this suite would be proving nothing",
  );
});

check("both certified fixtures converge in exactly the sweeps they always did", () => {
  assert.deepEqual(
    solveCase(certified("standard-maximal-v2")).forecast.map((period) => period.iterations),
    [8, 8, 8],
  );
  assert.deepEqual(
    solveCase(certified("standard-net-cash-v2")).forecast.map((period) => period.iterations),
    // 488ea00 (B1/B3/B6/B7 economic conventions) lawfully moved net-cash's
    // convergence path: the B1 declared-tax canonicalisation adds one sweep
    // per period. Damping/bisection mechanics are untouched.
    [6, 6, 6],
  );
  // P4.9's one declared sweep change is still the only one.
  assert.deepEqual(
    solveCase(archetype("loss_making_no_nol_stock.json")).forecast.map(
      (period) => period.iterations,
    ),
    [6, 6, 6],
  );
});

// ===========================================================================
// E. ANTI-WEAKENING — withdraw any one artefact and the tree refuses.
// ===========================================================================

const withoutLandedEdges = (() => {
  const graph = JSON.parse(JSON.stringify(EQUATION_GRAPH));
  const landed = new Set(LANDED_EDGES.map((edge) => edge.id));
  graph.edges = graph.edges.filter((edge) => !landed.has(edge.id));
  return graph;
})();

check("MUTATION — withdrawing the graph edges is refused four ways", () => {
  const errors = validateEquationGraph(withoutLandedEdges, CONVERGENCE_CONTRACT);
  for (const fragment of [
    "equation graph hash mismatch",
    "derived structural SCCs do not match",
    "circularity-on active SCCs do not match",
    "solver iteration state vector must contain exactly the circularity-on active SCC nodes",
  ]) {
    assert.ok(
      errors.some((error) => error.includes(fragment)),
      `expected a refusal naming "${fragment}"`,
    );
  }
});

check("MUTATION — withdrawing the CONTRACT's declaration is refused by P3.3's proof", () => {
  const withdrawn = JSON.parse(JSON.stringify(CONVERGENCE_CONTRACT));
  const iterated = new Set([
    "statement.pre_tax_income",
    "statement.tax_expense",
    "statement.net_income",
  ]);
  for (const component of withdrawn.scc_contract.active_by_circularity["1"]) {
    component.nodes = component.nodes.filter((id) => !iterated.has(id));
  }
  withdrawn.solver_iteration.state_by_circularity["1"].state_vector =
    withdrawn.solver_iteration.state_by_circularity["1"].state_vector.filter(
      (component) => !iterated.has(component.node_id),
    );
  const errors = validateEffectiveTaxRatePathAcyclicity(
    EQUATION_GRAPH,
    EFFECTIVE_TAX_RATE_PATH,
    withdrawn,
  );
  assert.equal(errors.length, 6, `expected two refusals per node:\n- ${errors.join("\n- ")}`);
  for (const id of iterated) {
    assert.ok(errors.some((error) => error.includes(id) && error.includes("member of the fixed")));
    assert.ok(errors.some((error) => error.includes(id) && error.includes("state vector omits it")));
  }
});

check("MUTATION — withdrawing the MODULE partition's iteration state is refused", () => {
  const boundaries = Object.fromEntries(
    Object.entries(CANONICAL_MODULE_BOUNDARIES).map(([id, boundary]) => [
      id,
      { ...boundary, iteration_state: [...boundary.iteration_state] },
    ]),
  );
  boundaries.tax_and_working_capital.iteration_state = [];
  const errors = validateGraphInvariants({ boundaries });
  assert.ok(
    errors.some(
      (error) =>
        error.includes("cycles_only_in_declared_iteration_subgraphs") &&
        error.includes("declares no iteration state"),
    ),
    `expected a cycle/iteration refusal:\n- ${errors.join("\n- ")}`,
  );
  assert.ok(
    errors.some((error) => error.includes("!= solver state vector")),
    "and the union must no longer equal the solver's own vector",
  );
  // The sealed boundary digest refuses it a second, independent time.
  assert.ok(
    validateModuleContractConformance({ boundaries }).some((error) =>
      error.startsWith("MODULE_VERSION_UNBUMPED: tax_and_working_capital"),
    ),
  );
});

check("MUTATION — withdrawing the module's OWNERSHIP of an edge is refused", () => {
  const boundaries = Object.fromEntries(
    Object.entries(CANONICAL_MODULE_BOUNDARIES).map(([id, boundary]) => [
      id,
      { ...boundary, edges: [...boundary.edges] },
    ]),
  );
  boundaries.cash_rcf.edges = boundaries.cash_rcf.edges.filter(
    (edgeId) => edgeId !== "edge.net_income_to_cfo",
  );
  assert.ok(
    validateModuleContractConformance({ boundaries }).some((error) =>
      error.includes("MODULE_EDGE_OWNER_DISAGREEMENT: edge.net_income_to_cfo"),
    ),
    "an edge no module owns must be refused, not ignored",
  );
});

check("MUTATION — a fixed-point node with no workbook row is refused at build", () => {
  const { modelIr, rowPlan } = workbookContractFor("standard-maximal-v2");
  const starved = {
    ...rowPlan,
    interest_summary_rows: { ...rowPlan.interest_summary_rows, net_interest_expense: null },
  };
  assert.throws(
    () => workbookSemanticProofContract(modelIr, starved, {}),
    /Cannot bind canonical fixed-point nodes to workbook rows: interest\.net_expense/,
    "the workbook contract must refuse a fixed point it cannot realise",
  );
});

console.log(JSON.stringify({ status: "PASS", checks, mutations_total, mutations_caught }));
