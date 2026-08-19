#!/usr/bin/env node
/**
 * P3.3 — ETR DAG SAFETY.
 *
 * The invariant: the effective-tax-rate computation is PROVABLY acyclic inside
 * the equation graph the case's own solve is bound to, and the tax policy's
 * three operators are DECLARED members of the formula operator vocabulary
 * rather than recognised by a string prefix.
 *
 * The three red proofs this suite replaces (all reproduced against the
 * pre-P3.3 tree):
 *
 *   (a) `assets/equation-graph.v1.json` held 35 nodes and NOT ONE tax node —
 *       zero nodes for `pre_tax_income`, `effective_tax_rate`, `tax_expense`
 *       or `net_income`, and zero edges naming any of them. The tax rate
 *       policy refuses the ETR identity because `tax = PBT × rate` beside
 *       `rate = tax ÷ PBT` is a cycle; with no tax node in the graph, the
 *       claim that its replacement is acyclic could not be checked at all.
 *   (b) `formulaOperatorSupport("tax_rate_policy_median")` answered "unknown",
 *       and the same for the other two. Neither `FORMULA_OPERATORS` nor either
 *       P4.5 classification list contained them; two consumers recognised them
 *       with `operator.startsWith("tax_rate_policy")`, which admits any
 *       undeclared string sharing the prefix.
 *   (c) `equation_graph.mjs` exported nothing naming tax or ETR: no validator,
 *       no proof, no acyclicity statement anywhere in the repository.
 *
 * What this suite proves now:
 *   1. PRESENCE — the four ETR roles each bind to exactly one node, with the
 *      six declared edges wired exactly as declared.
 *   2. ACYCLICITY — independently recomputed here, not read off the proof: a
 *      topological order exists in all three activation states, no ETR node
 *      lies inside ANY strongly connected component of the whole graph, and
 *      no edge leaves the ETR set.
 *   3. NON-VACUITY — the path is connected: rate and base both reach the
 *      charge, the charge reaches the sink.
 *   4. DECLARATION — the three operators are enumerable members of the
 *      declared vocabulary, and an undeclared string sharing their prefix is
 *      now REFUSED by both former prefix-detection sites.
 *   5. MUTATION — a tax cycle, a missing edge, a missing node and a duplicated
 *      role are each caught, at the load-bearing validator.
 *   6. CASE BINDING — the graph proved here is the graph both certified
 *      fixtures actually solved against, and the solver iterates no tax node.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONVERGENCE_CONTRACT,
  EFFECTIVE_TAX_RATE_PATH,
  EQUATION_GRAPH,
  activeEquationEdges,
  canonicalJsonSha256,
  compileEffectiveTaxRatePathProof,
  deriveEffectiveTaxRatePath,
  deriveStronglyConnectedComponents,
  validateEffectiveTaxRatePathAcyclicity,
  validateEquationGraph,
} from "./lib/equation_graph.mjs";
import {
  DECLARED_FORMULA_OPERATORS,
  FORMULA_OPERATORS,
  ROLE_POLICY_FORMULA_OPERATORS,
  SUPPORTED_FORMULA_OPERATORS,
  UNSUPPORTED_FORMULA_OPERATORS,
  formulaOperatorSupport,
  isRolePolicyFormulaOperator,
  validateFormulaRule,
} from "./lib/formula_dsl.mjs";
import {
  TAX_RATE_POLICY_OPERATORS,
  TAX_RATE_POLICY_OPERATOR_LIST,
  TAX_RATE_POLICY_OWNED_ROLE,
  isTaxRatePolicyOperator,
  taxRatePolicyCandidate,
} from "./lib/tax_rate_policy.mjs";
import { compileForecastCompletionCensus } from "./lib/forecast_completion_constitution.mjs";
import { forecastCellProducerWitness } from "./lib/forecast_producer_contract.mjs";
import { solveCase } from "./lib/solver.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}
const clone = (value) => structuredClone(value);
/** A mutable deep copy of the canonical graph (the export is frozen). */
const mutableGraph = () => clone({
  schema_version: EQUATION_GRAPH.schema_version,
  graph_id: EQUATION_GRAPH.graph_id,
  period_scope: EQUATION_GRAPH.period_scope,
  edge_direction: EQUATION_GRAPH.edge_direction,
  nodes: EQUATION_GRAPH.nodes,
  edges: EQUATION_GRAPH.edges,
});

// ---------------------------------------------------------------------------
// 1. PRESENCE — the tax nodes exist, with declared edges.
// ---------------------------------------------------------------------------

const declaration = EFFECTIVE_TAX_RATE_PATH;
const { errors: bindingErrors, nodeByRole, nodeIds } =
  deriveEffectiveTaxRatePath(EQUATION_GRAPH, declaration);
check(bindingErrors.length === 0, `every ETR role must bind: ${bindingErrors.join("; ")}`);
check(nodeIds.length === 4, "the ETR path is four nodes");

for (const role of declaration.roles) {
  check(
    EQUATION_GRAPH.nodes.filter((node) => node.role === role).length === 1,
    `red proof (a): role ${role} must bind to exactly one equation node`,
  );
}
for (const role of declaration.roles) {
  const node = nodeByRole.get(role);
  check(node.domain === "income_statement", `${node.id} is an income-statement node`);
  check(
    node.circularity_behavior === "uncontrolled",
    `${node.id} is uncontrolled: the tax path is not gated by the circularity switch, ` +
      "because it is not part of the circular block",
  );
}
check(
  nodeByRole.get(declaration.rate_role).kind === "input",
  "the effective tax rate enters the equation system as an INPUT — that is how the " +
    "tax/rate cycle is broken, and the node kind must say so",
);
check(
  nodeByRole.get(declaration.rate_role).tolerance_class === "ratio",
  "the rate carries the ratio tolerance class, not currency",
);

const edgesById = new Map(EQUATION_GRAPH.edges.map((edge) => [edge.id, edge]));
check(declaration.required_edges.length === 6, "the ETR path declares six edges");
for (const required of declaration.required_edges) {
  const edge = edgesById.get(required.id);
  check(edge !== undefined, `red proof (a): edge ${required.id} must exist in the graph`);
  check(
    edge.from === required.from && edge.to === required.to &&
      edge.type === required.type && edge.activation === required.activation,
    `edge ${required.id} must match its declared direction, type and activation`,
  );
}
check(
  edgesById.get("edge.net_interest_to_pre_tax_income").activation === "circularity_on",
  "net interest reaches pre-tax income only while circularity is ON: with the switch off " +
    "the interest block is zeroed, and a tax base that consumed it unconditionally would " +
    "read a value the kill switch had already suppressed",
);

// ---------------------------------------------------------------------------
// 2. ACYCLICITY — recomputed here, independently of the proof object.
// ---------------------------------------------------------------------------

check(
  validateEffectiveTaxRatePathAcyclicity(EQUATION_GRAPH).length === 0,
  "the canonical graph's ETR path validates clean",
);
check(
  validateEquationGraph(EQUATION_GRAPH, CONVERGENCE_CONTRACT).length === 0,
  "the ETR proof is wired into the load-bearing graph validator and the canonical graph passes it",
);

const proof = compileEffectiveTaxRatePathProof(EQUATION_GRAPH);
check(proof.schema_version === "effective-tax-rate-path/1.0", "the proof is versioned");
check(
  proof.graph_sha256 === canonicalJsonSha256(EQUATION_GRAPH),
  "the proof is bound to the hash of the graph it was derived from",
);

const members = new Set(nodeIds);
/** Verify a claimed order really is topological over the induced subgraph. */
function isTopological(order, edges) {
  if (order.length !== nodeIds.length) return false;
  const position = new Map(order.map((id, index) => [id, index]));
  return edges.every(
    (edge) =>
      !members.has(edge.from) || !members.has(edge.to) ||
      position.get(edge.from) < position.get(edge.to),
  );
}
for (const [label, edges] of [
  ["structural", EQUATION_GRAPH.edges],
  ["circularity_off", activeEquationEdges(EQUATION_GRAPH, 0)],
  ["circularity_on", activeEquationEdges(EQUATION_GRAPH, 1)],
]) {
  check(
    isTopological(proof.topological_order[label], edges),
    `the ${label} topological order is a real topological order — a certificate of acyclicity, ` +
      "re-verified here rather than trusted",
  );
}

// No ETR node inside ANY strongly connected component of the WHOLE graph.
// This is the DAG-safety statement itself: a node inside an SCC is solved by
// iteration, which is what the tax/rate pair must never require.
for (const [label, options] of [
  ["structural", {}],
  ["circularity-off", { circularity: 0 }],
  ["circularity-on", { circularity: 1 }],
]) {
  const trapped = deriveStronglyConnectedComponents(EQUATION_GRAPH, options)
    .flat()
    .filter((id) => members.has(id));
  check(
    trapped.length === 0,
    `no ETR node may lie inside a ${label} strongly connected component; found ${trapped.join(", ")}`,
  );
}
// Nor may the ETR set feed anything outside itself.
const escaping = EQUATION_GRAPH.edges.filter(
  (edge) => members.has(edge.from) && !members.has(edge.to),
);
check(
  escaping.length === 0,
  `the ETR path must terminate; ${escaping.map((edge) => edge.id).join(", ")} leaves the set`,
);
check(
  proof.outside_every_strongly_connected_component === true && proof.acyclic === true &&
    proof.terminates === true,
  "the compiled proof affirms exactly the three properties recomputed above",
);

// ---------------------------------------------------------------------------
// 3. NON-VACUITY — the path is connected, so 2 is not true by absence.
// ---------------------------------------------------------------------------

function reaches(fromId, toId, edges) {
  const seen = new Set([fromId]);
  const queue = [fromId];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const edge of edges) {
      if (edge.from !== id || seen.has(edge.to)) continue;
      if (edge.to === toId) return true;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return false;
}
const rateId = nodeByRole.get(declaration.rate_role).id;
const baseId = nodeByRole.get(declaration.base_role).id;
const chargeId = nodeByRole.get(declaration.charge_role).id;
const sinkId = nodeByRole.get(declaration.sink_role).id;
check(reaches(rateId, chargeId, EQUATION_GRAPH.edges), "the rate reaches the tax charge");
check(reaches(baseId, chargeId, EQUATION_GRAPH.edges), "the tax base reaches the tax charge");
check(reaches(chargeId, sinkId, EQUATION_GRAPH.edges), "the tax charge reaches the sink");
check(
  reaches("statement.ebit", baseId, EQUATION_GRAPH.edges),
  "EBIT reaches the tax base: the path is attached to the economics, not free-floating",
);
check(
  !reaches(chargeId, "cash.ending_balance", EQUATION_GRAPH.edges) &&
    !reaches(sinkId, "cash.cfo", EQUATION_GRAPH.edges),
  "the tax charge reaches neither the cash waterfall nor CFO: this graph's cash flow starts " +
    "at EBIT, which is exactly WHY the ETR path is acyclic — a tax line inside the cash " +
    "bridge would close the loop back through cash interest into net interest",
);

// ---------------------------------------------------------------------------
// 4. DECLARATION, not prefix detection.
// ---------------------------------------------------------------------------

check(
  TAX_RATE_POLICY_OPERATOR_LIST.length === 3,
  "the tax policy declares exactly three operators",
);
for (const operator of TAX_RATE_POLICY_OPERATOR_LIST) {
  check(isTaxRatePolicyOperator(operator), `${operator} is declared by the policy`);
  check(
    DECLARED_FORMULA_OPERATORS.includes(operator),
    `red proof (b): ${operator} must be a member of the declared formula operator vocabulary`,
  );
  check(isRolePolicyFormulaOperator(operator), `${operator} is a registered role-policy operator`);
  check(
    formulaOperatorSupport(operator) === "role_policy",
    `red proof (b): formulaOperatorSupport(${operator}) answered "unknown" before P3.3`,
  );
  const entry = ROLE_POLICY_FORMULA_OPERATORS[operator];
  check(
    entry.reason_code === "formula_operator_owned_by_role_policy" &&
      entry.owned_role === TAX_RATE_POLICY_OWNED_ROLE && entry.policy === "tax_rate_policy",
    `${operator} carries a typed role-policy registration`,
  );
  check(
    validateFormulaRule({ operator, refs: [] }).some((error) =>
      error.includes("renders no statement expression")),
    `${operator} is refused as a statement expression by NAME, not as an unknown operator`,
  );
}
check(
  Object.keys(ROLE_POLICY_FORMULA_OPERATORS).sort().join(",") ===
    [...TAX_RATE_POLICY_OPERATOR_LIST].sort().join(","),
  "the role-policy registry names exactly the policy's declared operators",
);
check(
  TAX_RATE_POLICY_OPERATOR_LIST.every((operator) => !FORMULA_OPERATORS.includes(operator)),
  "the role-policy vocabulary stays DISJOINT from the statement-expression vocabulary: an " +
    "operator in both would owe an Excel emitter it must never have",
);
check(
  [...FORMULA_OPERATORS].sort().join(",") ===
    [...SUPPORTED_FORMULA_OPERATORS, ...Object.keys(UNSUPPORTED_FORMULA_OPERATORS)].sort().join(","),
  "P4.5's statement-vocabulary completeness invariant is untouched by this registration",
);
check(
  DECLARED_FORMULA_OPERATORS.length === FORMULA_OPERATORS.length + 3,
  "the declared vocabulary is the statement set plus exactly the three role-policy operators",
);

// The emitted operators are the declared ones — checked by driving the policy.
const policyCase = (taxes, pbts) => ({
  statement_structure: {
    income_statement: [
      { row_id: "pre_tax_income", semantic_role: "pre_tax_income", values: pbts },
      { row_id: "tax_expense", semantic_role: "tax_expense", values: taxes },
      { row_id: "etr", semantic_role: "effective_tax_rate", values: [null, null, null] },
    ],
    cash_flow: [],
  },
});
const rateRow = { row_id: "etr", semantic_role: "effective_tax_rate" };
for (const [label, modelCase, expected] of [
  ["median", policyCase([-25, -24, -26], [100, 100, 100]), TAX_RATE_POLICY_OPERATORS.median],
  ["latest", policyCase([-25, null, null], [100, null, null]), TAX_RATE_POLICY_OPERATORS.latest],
  ["loss case", policyCase([5, 5, 5], [-100, -100, -100]), TAX_RATE_POLICY_OPERATORS.loss_case],
]) {
  const candidate = taxRatePolicyCandidate(modelCase, rateRow, 0);
  check(
    candidate?.formula_spec?.operator === expected,
    `the ${label} rung emits the declared operator ${expected}`,
  );
  check(
    isTaxRatePolicyOperator(candidate.formula_spec.operator),
    `the ${label} rung's emitted operator is a member of the declared vocabulary`,
  );
}

// An UNDECLARED string sharing the prefix is now refused. Under
// `startsWith("tax_rate_policy")` every one of these passed as a tax operator.
const IMPOSTORS = [
  "tax_rate_policy",
  "tax_rate_policy_",
  "tax_rate_policy_mean",
  "tax_rate_policy_median_v2",
  "tax_rate_policyX",
];
for (const impostor of IMPOSTORS) {
  check(
    !isTaxRatePolicyOperator(impostor) && !isRolePolicyFormulaOperator(impostor),
    `red proof (b): ${impostor} shares the prefix and is NOT a declared operator`,
  );
  check(
    impostor.startsWith("tax_rate_policy") === true,
    `${impostor} would have been admitted by the string-prefix test it replaces`,
  );
}
check(!isTaxRatePolicyOperator(undefined) && !isTaxRatePolicyOperator(null) &&
  !isTaxRatePolicyOperator(42), "membership is total over non-strings");

// BEHAVIOURAL proof at both former prefix sites.
const censusCase = (operator) => ({
  case_id: "etr-dag-safety",
  statement_structure: {
    income_statement: [
      {
        row_id: "etr",
        row_type: "input",
        semantic_role: "effective_tax_rate",
        values: [0.25, 0.25, 0.25, null, null, null],
        forecast_period_authorities: [0, 1, 2].map(() => ({
          method: "role_policy",
          formula_spec: { operator, row_id: "etr" },
        })),
      },
    ],
    cash_flow: [],
  },
});
const declaredCensus = compileForecastCompletionCensus(
  censusCase(TAX_RATE_POLICY_OPERATORS.median),
);
check(
  (declaredCensus.disposition_counts.role_policy_owned ?? 0) === 3,
  "the completion census still types a DECLARED tax operator role_policy_owned",
);
const impostorCensus = compileForecastCompletionCensus(censusCase("tax_rate_policy_mean"));
check(
  (impostorCensus.disposition_counts.role_policy_owned ?? 0) === 0,
  "red proof (b), behavioural: an undeclared prefix-sharing operator can no longer claim " +
    "role-policy ownership of a completion cell — the prefix test would have granted it",
);

const witnessFor = (operator) =>
  forecastCellProducerWitness({
    section: "income_statement",
    row: { row_id: "etr", semantic_role: "effective_tax_rate" },
    authority: { method: "role_policy", formula_spec: { operator, row_id: "etr" } },
    forecast_index: 0,
    historical_count: 3,
  });
check(
  witnessFor(TAX_RATE_POLICY_OPERATORS.latest).producer_kind === "role_policy",
  "the producer contract still recognises a DECLARED tax operator as a role-policy producer",
);
check(
  witnessFor("tax_rate_policy_mean").producer_kind !== "role_policy",
  "red proof (b), behavioural: the producer contract no longer accepts an undeclared " +
    "prefix-sharing operator as a role-policy producer",
);

// Static proof: the prefix test is gone from the library CODE. Comments are
// stripped first — the modules deliberately DOCUMENT the pattern they replaced,
// and a scan that could not tell prose from code would forbid the explanation.
{
  const libDir = path.join(root, "scripts", "lib");
  const stripComments = (text) =>
    text.replaceAll(/\/\*[\s\S]*?\*\//g, " ").replaceAll(/(^|[^:])\/\/[^\n]*/g, "$1");
  const prefixTest = /startsWith(\?\.)?\s*\(\s*["'`]tax_rate_policy/;
  const offenders = fs.readdirSync(libDir)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) =>
      prefixTest.test(stripComments(fs.readFileSync(path.join(libDir, name), "utf8"))));
  check(
    offenders.length === 0,
    `red proof (b), static: no library module may detect a tax operator by string prefix; found ${offenders.join(", ")}`,
  );
  // The scan is real: it finds the pattern when the pattern is there.
  check(
    prefixTest.test(stripComments('const x = operator.startsWith("tax_rate_policy");')) &&
      prefixTest.test(stripComments('a?.operator?.startsWith?.("tax_rate_policy")')) &&
      !prefixTest.test(stripComments('// operator.startsWith("tax_rate_policy") was the old test')),
    "the prefix scan detects the pattern in code and ignores it in comments",
  );
}

// ---------------------------------------------------------------------------
// 5. MUTATION — every way of breaking DAG safety must be caught.
// ---------------------------------------------------------------------------

// (i) The realistic mistake: wire net income into the cash-flow bridge. That
// closes net income -> cash flow start -> CFO -> cash -> cash interest income
// -> interest income -> net interest -> pre-tax income -> tax -> net income.
{
  const mutated = mutableGraph();
  mutated.edges.push({
    id: "edge.net_income_to_cash_flow_start",
    from: "statement.net_income",
    to: "statement.cash_flow_start",
    type: "statement_dependency",
    activation: "circularity_on",
  });
  const errors = validateEffectiveTaxRatePathAcyclicity(mutated);
  check(
    errors.some((error) => error.includes("strongly connected")),
    "MUTATION: a tax cycle through the cash-flow bridge is caught as an SCC trap",
  );
  check(
    errors.some((error) => error.includes("must terminate")),
    "MUTATION: the same edge is independently caught by the sink property",
  );
  check(
    validateEquationGraph(mutated, CONVERGENCE_CONTRACT)
      .some((error) => error.includes("effective-tax-rate")),
    "MUTATION: the load-bearing graph validator refuses the cycle, so no case can be " +
      "solved against a graph in which the tax path is circular",
  );
  let threw = false;
  try {
    compileEffectiveTaxRatePathProof(mutated);
  } catch (error) {
    threw = /not DAG-safe/.test(error.message);
  }
  check(threw, "MUTATION: the proof compiler refuses rather than emitting acyclic: true");
}

// (ii) The bare tax/rate pair: tax expense feeding the tax base back.
{
  const mutated = mutableGraph();
  mutated.edges.push({
    id: "edge.tax_expense_to_pre_tax_income",
    from: "statement.tax_expense",
    to: "statement.pre_tax_income",
    type: "statement_dependency",
    activation: "always",
  });
  const errors = validateEffectiveTaxRatePathAcyclicity(mutated);
  check(
    errors.some((error) => error.includes("no structural topological order")),
    "MUTATION: `tax = PBT x rate` beside a PBT that consumes tax has no topological order",
  );
  check(
    errors.some((error) => error.includes("strongly connected")),
    "MUTATION: the two-node tax cycle is also caught as an SCC",
  );
}

// (iii) A self-loop on the rate node.
{
  const mutated = mutableGraph();
  mutated.edges.push({
    id: "edge.effective_tax_rate_self",
    from: "statement.effective_tax_rate",
    to: "statement.effective_tax_rate",
    type: "statement_dependency",
    activation: "always",
  });
  check(
    validateEffectiveTaxRatePathAcyclicity(mutated).length > 0,
    "MUTATION: a self-referential rate is caught",
  );
}

// (iv) Vacuity guards: a missing edge, a missing node, a duplicated role and a
// tampered activation must each fail — otherwise 2 could pass on a path that
// is not actually there.
{
  const mutated = mutableGraph();
  mutated.edges = mutated.edges.filter((edge) => edge.id !== "edge.pre_tax_income_to_tax_expense");
  const errors = validateEffectiveTaxRatePathAcyclicity(mutated);
  check(
    errors.some((error) => error.includes("edge.pre_tax_income_to_tax_expense") &&
      error.includes("missing")),
    "MUTATION: a removed ETR edge is caught, so acyclicity is never true by absence",
  );
}
{
  const mutated = mutableGraph();
  mutated.nodes = mutated.nodes.filter((node) => node.role !== "tax_expense");
  check(
    validateEffectiveTaxRatePathAcyclicity(mutated)
      .some((error) => error.includes("tax_expense") && error.includes("exactly one")),
    "MUTATION: a removed tax node is caught — this is red proof (a) as a live assertion",
  );
}
{
  const mutated = mutableGraph();
  mutated.nodes.push({
    id: "statement.effective_tax_rate_copy",
    role: "effective_tax_rate",
    domain: "income_statement",
    kind: "input",
    tolerance_class: "ratio",
    circularity_behavior: "uncontrolled",
  });
  check(
    validateEffectiveTaxRatePathAcyclicity(mutated)
      .some((error) => error.includes("effective_tax_rate") && error.includes("exactly one")),
    "MUTATION: two nodes claiming the rate role is caught — the role must identify one node",
  );
}
{
  const mutated = mutableGraph();
  const edge = mutated.edges.find((item) => item.id === "edge.net_interest_to_pre_tax_income");
  edge.activation = "always";
  check(
    validateEffectiveTaxRatePathAcyclicity(mutated)
      .some((error) => error.includes("edge.net_interest_to_pre_tax_income")),
    "MUTATION: relaxing the net-interest activation to always is caught by the declaration",
  );
  check(
    validateEquationGraph(mutated, CONVERGENCE_CONTRACT)
      .some((error) => error.includes("kill-switch")),
    "MUTATION: the pre-existing interest kill-switch validator independently catches it",
  );
}
{
  const mutated = mutableGraph();
  const edge = mutated.edges.find((item) => item.id === "edge.tax_expense_to_net_income");
  const swap = edge.from;
  edge.from = edge.to;
  edge.to = swap;
  check(
    validateEffectiveTaxRatePathAcyclicity(mutated)
      .some((error) => error.includes("edge.tax_expense_to_net_income")),
    "MUTATION: a reversed ETR edge is caught by the declared direction",
  );
}

// ---------------------------------------------------------------------------
// 6. CASE BINDING — the graph proved above is the graph the certified fixtures
//     actually solved against, and no tax node is ever iterated.
// ---------------------------------------------------------------------------

for (const fixture of ["standard-maximal-v2", "standard-net-cash-v2"]) {
  const modelCase = JSON.parse(
    fs.readFileSync(path.join(root, "test-fixtures", "cases", `${fixture}.json`), "utf8"),
  );
  modelCase.execution_profile = "reference_parity";
  const evidence = solveCase(modelCase).equation_graph_evidence;
  check(
    evidence.graph_sha256 === proof.graph_sha256,
    `${fixture} solved against the very graph this proof covers (hash-bound, so the ` +
      "acyclicity result is about the case's own equation graph and not a detached template)",
  );
  const inScc = [
    ...evidence.structural_sccs.flatMap((component) => component.nodes),
    ...evidence.active_sccs.flatMap((component) => component.nodes),
  ].filter((id) => members.has(id));
  check(
    inScc.length === 0,
    `${fixture}: no tax node appears in the solved SCC evidence; found ${inScc.join(", ")}`,
  );
  const iterated = (evidence.solver_declaration?.state_vector ?? [])
    .map((component) => component.node_id)
    .filter((id) => members.has(id));
  check(
    iterated.length === 0,
    `${fixture}: the solver iterates no tax node; found ${iterated.join(", ")}`,
  );
}

process.stdout.write(`${JSON.stringify({ status: "PASS", checks })}\n`);
