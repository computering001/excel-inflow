#!/usr/bin/env node
/**
 * P4.6 — CANONICAL GRAPH BINDING
 *
 * Invariant: the four separately-sealed graphs are bound into ONE canonical
 * relation. Every equation-graph node that corresponds to a statement row is
 * EDGE-BOUND to it, so a change in one graph cannot silently disagree with
 * another; and the layered constitution's economic layer carries real cross-layer
 * edges rather than an isolated node set.
 *
 * Reproduced RED, against the tree before this package (all five verified by
 * direct execution on `standard-maximal-v2`):
 *   R1  the economic layer had 0 cross-layer edges out of 71 — every edge ran
 *       `economic:*` -> `economic:*` and the layer touched nothing.
 *   R2  renaming `statement.net_income`'s role in the equation graph left the
 *       constitution PASS with 0 violations while the statement layer still
 *       carried its own `income_statement/net_income` row.
 *   R3  deleting `cash.ending_balance` from the equation graph outright left the
 *       constitution PASS with 0 violations while the `cash_flow/ending_cash`
 *       row remained.
 *   R4  drifting the statement row's `semantic_role` away from the equation role
 *       `cash_from_operations` left the constitution PASS with 0 violations AND
 *       a byte-identical economic layer hash.
 *   R5  the economic layer hash was byte-identical across two structurally
 *       different certified cases — the layer was not a function of the case at
 *       all.
 *
 * Every obligation below is recomputed here from the compiled artifact rather
 * than read off a claim the compiler made.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import {
  EQUATION_GRAPH,
  validateEquationGraphRowBinding,
} from "./lib/equation_graph.mjs";
import {
  ECONOMIC_BINDING_DISPOSITIONS,
  ECONOMIC_BINDING_FIELDS,
  ECONOMIC_BINDING_STATUSES,
  ECONOMIC_IDENTITY_FIELDS,
  ECONOMIC_STATEMENT_BINDING,
  ECONOMIC_STATEMENT_BINDING_SCOPE,
  ECONOMIC_STATUS_BY_DISPOSITION,
  EQUATION_GRAPH_UNCOVERED_NODE_FAMILIES,
  compileLayeredGraphConstitution,
  economicCoverageLedger,
  economicStatementBindings,
  validateLayeredGraphConstitution,
} from "./lib/layered_graph_constitution.mjs";
import { hashValue } from "./lib/run_store.mjs";
import { compileRowPlan } from "./lib/row_plan.mjs";
import {
  compileSemanticManifest,
  compileSourceCrosswalk,
} from "./lib/semantic_graph.mjs";
import { validateSemanticArtifacts } from "./lib/validation_invariants.mjs";

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const FIXTURES = ["standard-maximal-v2", "standard-net-cash-v2"];

let checks = 0;
// Honest mutation accounting: every MUTATION below applies a real defect to a
// COPY of the subject (a dropped register entry, a corrupted role, a flipped
// binding status, a tampered seal) and is counted CAUGHT only when production's
// own validators refuse the copy while the mutant is active. A mutant that
// survives throws before its catch is counted, so this count can never claim a
// kill the suite did not observe.
let mutations_total = 0;
let mutations_caught = 0;
function mutation(label, fn) {
  mutations_total += 1;
  fn();
  mutations_caught += 1;
}
const failures = [];
function check(condition, label) {
  checks += 1;
  if (!condition) failures.push(label);
}

function loadCase(fixture) {
  return JSON.parse(
    fs.readFileSync(path.join(root, "test-fixtures", "cases", `${fixture}.json`), "utf8"),
  );
}

const layerOf = (artifact, id) =>
  artifact.layers.find((item) => item.layer_id === id);
const crossLayerEdges = (artifact) =>
  (layerOf(artifact, "economic").edges ?? []).filter(
    (edge) => edge.cross_layer === true,
  );

const compiled = new Map();
for (const fixture of FIXTURES) {
  const modelCase = loadCase(fixture);
  const plan = compileRowPlan(modelCase);
  compiled.set(fixture, {
    modelCase,
    plan,
    artifact: compileLayeredGraphConstitution(modelCase, plan),
  });
}

// ---------------------------------------------------------------------------
// 1. TOTALITY — the register covers the canonical graph exactly, at the graph's
//    own seam. This runs at import of layered_graph_constitution.mjs, so the
//    repository cannot load against a graph the relation does not cover.
// ---------------------------------------------------------------------------

check(
  validateEquationGraphRowBinding(ECONOMIC_STATEMENT_BINDING, EQUATION_GRAPH).length === 0,
  "the canonical row binding is total over the equation graph",
);
check(
  Object.keys(ECONOMIC_STATEMENT_BINDING).length === EQUATION_GRAPH.nodes.length,
  "the register declares exactly one entry per equation-graph node",
);
for (const node of EQUATION_GRAPH.nodes) {
  const declared = ECONOMIC_STATEMENT_BINDING[node.id] ?? null;
  check(
    declared !== null &&
      declared.role === node.role &&
      ECONOMIC_BINDING_DISPOSITIONS.includes(declared.disposition),
    `${node.id} carries a declared disposition and its role agrees with the graph`,
  );
}

// ---------------------------------------------------------------------------
// 2. R1/R2/R3/R4/R5 CLOSED — real cross-layer edges, independently re-derived.
// ---------------------------------------------------------------------------

for (const fixture of FIXTURES) {
  const { artifact } = compiled.get(fixture);
  const economic = layerOf(artifact, "economic");
  const statement = layerOf(artifact, "statement");
  const cross = crossLayerEdges(artifact);
  check(artifact.status === "PASS", `${fixture} compiles clean`);
  check(cross.length > 0, `${fixture} economic layer carries cross-layer edges (R1)`);

  const statementById = new Map(statement.nodes.map((node) => [node.id, node]));
  const economicById = new Map(economic.nodes.map((node) => [node.id, node]));
  const roleIndex = new Map();
  for (const node of statement.nodes) {
    if (!node.semantic_role) continue;
    const key = `${node.section}/${node.semantic_role}`;
    roleIndex.set(key, [...(roleIndex.get(key) ?? []), node]);
  }

  // Every cross-layer edge lands on a real statement node that genuinely carries
  // the section and semantic role the economic node declared.
  check(
    cross.every((edge) => {
      const from = economicById.get(edge.from);
      const to = statementById.get(edge.to);
      return (
        edge.type === "realises_statement_row" &&
        from &&
        to &&
        from.binding_status === "bound" &&
        from.bound_statement_node_id === edge.to &&
        to.section === from.bound_section &&
        to.semantic_role === from.bound_semantic_role
      );
    }),
    `${fixture} every cross-layer edge lands on the statement node it declares`,
  );

  // Symmetric over the intersection: a declared statement realisation that the
  // statement layer contains MUST be bound, and one it does not contain must be
  // recorded absent. Recomputed from the register and the layer, not the node.
  let expectedBound = 0;
  let expectedAbsent = 0;
  for (const [nodeId, declared] of Object.entries(ECONOMIC_STATEMENT_BINDING)) {
    if (declared.disposition !== "statement_row") continue;
    const present = roleIndex.get(`${declared.section}/${declared.semantic_role}`) ?? [];
    const node = economicById.get(`economic:${nodeId}`);
    if (present.length === 1) {
      expectedBound += 1;
      check(
        node.binding_status === "bound" &&
          node.bound_statement_node_id === present[0].id &&
          cross.some((edge) => edge.from === node.id && edge.to === present[0].id),
        `${fixture} ${nodeId} is edge-bound to its present statement row`,
      );
    } else if (present.length === 0) {
      expectedAbsent += 1;
      check(
        node.binding_status === "row_absent" &&
          !cross.some((edge) => edge.from === node.id),
        `${fixture} ${nodeId} records its absent statement row and claims no edge`,
      );
    }
  }
  check(
    cross.length === expectedBound,
    `${fixture} the cross-layer edge count equals the independently derived bound count`,
  );
  check(
    expectedBound > 0 && expectedAbsent > 0,
    `${fixture} exercises both the bound and the absent leg of the relation`,
  );

  // No economic node is undeclared, and the layer invents no node of its own.
  check(
    economic.nodes.every((node) => node.binding_status !== "undeclared"),
    `${fixture} no economic node is undeclared`,
  );
  check(
    JSON.stringify([...economic.nodes.map((node) => node.equation_node_id)].sort()) ===
      JSON.stringify([...EQUATION_GRAPH.nodes.map((node) => node.id)].sort()),
    `${fixture} the economic layer node set is exactly the equation graph node set`,
  );

  // The seal covers the binding, and the ledger is re-derivable.
  check(
    artifact.economic_binding_scope === ECONOMIC_STATEMENT_BINDING_SCOPE &&
      artifact.economic_binding_sha256 === hashValue(ECONOMIC_STATEMENT_BINDING),
    `${fixture} the closure seals the binding register it actually used`,
  );
  check(
    JSON.stringify(artifact.economic_coverage) ===
      JSON.stringify(economicCoverageLedger(economic.nodes)) &&
      artifact.economic_coverage_sha256 === hashValue(artifact.economic_coverage),
    `${fixture} the coverage ledger is re-derivable from the economic layer`,
  );
  check(
    validateLayeredGraphConstitution(artifact).length === 0,
    `${fixture} the persisted artifact satisfies every binding obligation`,
  );

  // CONNECTED — a bound economic node reaches the physical projection and the
  // forecast writers through the statement hub. Without this the cross-layer
  // edges would be adjacency rather than a relation.
  const inbound = new Map();
  for (const item of artifact.layers) {
    for (const edge of item.edges ?? []) {
      inbound.set(edge.to, [...(inbound.get(edge.to) ?? []), edge]);
    }
  }
  check(
    cross.every((edge) => {
      const feeders = inbound.get(edge.to) ?? [];
      return (
        feeders.some((item) => item.type === "projects") &&
        feeders.filter((item) => item.type === "writes_period").length === 3
      );
    }),
    `${fixture} every bound statement row also carries its projection and three forecast writers`,
  );
}

// ---------------------------------------------------------------------------
// 3. THE MANIFEST LEG — the semantic manifest and the layered constitution agree
//    about the rows the equation graph claims to realise.
// ---------------------------------------------------------------------------

for (const fixture of FIXTURES) {
  const { modelCase, plan, artifact } = compiled.get(fixture);
  const manifest = compileSemanticManifest(modelCase, plan);
  const crosswalk = compileSourceCrosswalk(modelCase, plan, manifest);
  const bindings = economicStatementBindings(artifact);
  check(
    bindings.length === crossLayerEdges(artifact).length && bindings.length > 0,
    `${fixture} the binding accessor reports exactly the edge-bound nodes`,
  );
  const manifestRoles = new Set(
    manifest.nodes
      .filter((node) => node.node_kind === "statement_row" && node.semantic_role)
      .map((node) => `${node.section}/${node.semantic_role}`),
  );
  check(
    bindings.every((item) => manifestRoles.has(`${item.section}/${item.semantic_role}`)),
    `${fixture} the manifest carries a statement row for every bound equation node`,
  );
  const layeredRoles = new Set(
    layerOf(artifact, "statement")
      .nodes.filter((node) => node.semantic_role)
      .map((node) => `${node.section}/${node.semantic_role}`),
  );
  check(
    [...layeredRoles].every((key) => manifestRoles.has(key)) &&
      [...manifestRoles].every((key) => layeredRoles.has(key)),
    `${fixture} the manifest and the layered statement layer describe the same rows`,
  );
  check(
    manifest.layered_graph_constitution.closure_sha256 === artifact.closure_sha256,
    `${fixture} the manifest embeds the very constitution this proof covers`,
  );

  // THE RELEASE GATE ITSELF. `semantic-artifact-completeness` in
  // `validate_dynamic_model` is this function, and P4.6's first cut moved the
  // manifest without moving the validators' expectation of it — 57 violations on
  // the Python half. The gate belongs in this suite, not only in the release
  // lane, because it is this package's own artifact that it judges.
  const completeness = validateSemanticArtifacts(manifest, crosswalk);
  check(
    completeness.length === 0,
    `${fixture} semantic-artifact-completeness is clean: ${JSON.stringify(completeness.slice(0, 4))}`,
  );
}

// ---------------------------------------------------------------------------
// 4. DECLARED COVERAGE GAP — what the equation graph still does NOT cover, said
//    out loud and proven, not left to silence.
// ---------------------------------------------------------------------------

const maximal = compiled.get("standard-maximal-v2");
const netCash = compiled.get("standard-net-cash-v2");
const ledger = maximal.artifact.economic_coverage;

check(
  ledger.uncovered_node_families.length ===
    EQUATION_GRAPH_UNCOVERED_NODE_FAMILIES.length &&
    ledger.uncovered_node_families.length === 7,
  "the ledger declares all seven uncovered node families",
);
for (const family of [
  "instrument",
  "lease",
  "acquisition",
  "cash_bucket",
  "statement_row",
  "schedule_row",
  "period",
]) {
  check(
    EQUATION_GRAPH_UNCOVERED_NODE_FAMILIES.some(
      (item) => item.family === family && typeof item.reason === "string" && item.reason.length > 0,
    ),
    `the uncovered node family ${family} is declared with a reason`,
  );
}
for (const family of [
  "acquisition",
  "cash_waterfall",
  "debt_schedule",
  "instrument",
  "interest_schedule",
  "lease",
]) {
  check(
    (ledger.uncovered_row_families[family] ?? []).length > 0,
    `the ledger names the equation nodes whose row family ${family} has no layer`,
  );
}

// PROVEN, not asserted: the graph holds no per-instrument node. Twelve
// instruments and two instruments compile the same economic node set.
check(
  (maximal.modelCase.instruments ?? []).length !==
    (netCash.modelCase.instruments ?? []).length,
  "the two certified fixtures genuinely differ in instrument count",
);
check(
  layerOf(maximal.artifact, "economic").nodes.length ===
    layerOf(netCash.artifact, "economic").nodes.length &&
    layerOf(maximal.artifact, "economic").nodes.length === 39,
  "the economic node count is invariant to instrument count — the graph is a role template",
);
check(
  EQUATION_GRAPH.period_scope === "single_forecast_period_template" &&
    EQUATION_GRAPH.nodes.every((node) => !/[0-9]/.test(node.role)) &&
    (EQUATION_GRAPH.edges ?? []).every((edge) => !/period/.test(edge.type)),
  "the graph declares a single-period scope and carries no per-period node or edge",
);
check(
  ledger.cross_layer_bound_node_ids.length <
    layerOf(maximal.artifact, "statement").nodes.filter((node) => node.semantic_role)
      .length,
  "the bound nodes are a strict subset of the statement rows — the row gap is real",
);
// The one live role-name collision is declared rather than mistaken for a join:
// the income-statement `interest_income` row is realised by
// `statement.finance_income`, not by the equally named `interest.income`.
check(
  ECONOMIC_STATEMENT_BINDING["interest.income"].role_collision_owner ===
    "statement.finance_income" &&
    ECONOMIC_STATEMENT_BINDING["statement.finance_income"].semantic_role ===
      "interest_income",
  "the interest_income role-name collision names its true economic realiser",
);
for (const fixture of FIXTURES) {
  const { artifact } = compiled.get(fixture);
  const statementRoles = new Set(
    layerOf(artifact, "statement")
      .nodes.filter((node) => node.semantic_role)
      .map((node) => node.semantic_role),
  );
  const owned = new Set(
    Object.values(ECONOMIC_STATEMENT_BINDING)
      .filter((item) => item.disposition === "statement_row")
      .map((item) => item.semantic_role),
  );
  check(
    Object.entries(ECONOMIC_STATEMENT_BINDING).every(
      ([, item]) =>
        item.disposition !== "schedule_row" ||
        !statementRoles.has(item.role) ||
        Boolean(item.role_collision_owner),
    ),
    `${fixture} no schedule-only node's role collides with a statement row unowned`,
  );
  check(owned.size > 0, `${fixture} the statement-owned role set is non-empty`);
}

// ---------------------------------------------------------------------------
// 5. DRIFT — every way one graph can disagree with another, and the code that
//    catches it. Compile-channel mutations must BLOCK with the named violation;
//    artifact-channel mutations must be refused by the validator.
// ---------------------------------------------------------------------------

const base = maximal.artifact;
const caught = [];

function compileMutation(name, mutate, expectedCode) {
  const modelCase = structuredClone(maximal.modelCase);
  const plan = structuredClone(maximal.plan);
  const graph = structuredClone(EQUATION_GRAPH);
  const binding = structuredClone(ECONOMIC_STATEMENT_BINDING);
  mutate({ modelCase, plan, graph, binding });
  const artifact = compileLayeredGraphConstitution(modelCase, plan, {
    equationGraph: graph,
    economicStatementBinding: binding,
  });
  check(artifact.status === "BLOCK", `${name} blocks`);
  check(
    artifact.violations.some((violation) => violation.code === expectedCode),
    `${name} emits ${expectedCode}`,
  );
  check(
    artifact.closure_sha256 !== base.closure_sha256,
    `${name} moves the graph closure seal`,
  );
  caught.push(name);
}

function artifactMutation(name, mutate, expectedFragment) {
  const artifact = structuredClone(base);
  mutate(artifact);
  const errors = validateLayeredGraphConstitution(artifact);
  check(
    errors.some((message) => message.includes(expectedFragment)),
    `${name} is refused by the validator (${expectedFragment}): ${JSON.stringify(errors)}`,
  );
  caught.push(name);
}

const economicNodeIndex = (artifact, equationNodeId) =>
  layerOf(artifact, "economic").nodes.findIndex(
    (node) => node.equation_node_id === equationNodeId,
  );

// D1 — a node present in one graph and ABSENT from its bound counterpart: the
// equation graph loses `cash.ending_balance` while the register and the
// statement row both still name it. R3's exact object.
compileMutation(
  "equation node deleted while the canonical relation still declares it",
  ({ graph }) => {
    graph.nodes = graph.nodes.filter((node) => node.id !== "cash.ending_balance");
    graph.edges = graph.edges.filter(
      (edge) => edge.from !== "cash.ending_balance" && edge.to !== "cash.ending_balance",
    );
  },
  "ECONOMIC_BINDING_DECLARATION_ORPHAN",
);

// D2 — the mirror: a node appears in the equation graph with no declared
// realisation, so nothing knows which row it reaches.
compileMutation(
  "equation node added with no declared row realisation",
  ({ graph }) => {
    graph.nodes.push({
      id: "statement.undeclared_addition",
      role: "undeclared_addition",
      domain: "income_statement",
      kind: "statement_output",
      tolerance_class: "currency",
      circularity_behavior: "uncontrolled",
    });
  },
  "ECONOMIC_BINDING_UNDECLARED_NODE",
);

// D3 — two graphs disagreeing about a SHARED node: the equation graph renames
// the role the canonical relation binds. R2's exact object.
compileMutation(
  "equation graph renames a shared node's role",
  ({ graph }) => {
    graph.nodes.find((node) => node.id === "statement.net_income").role =
      "net_income_renamed";
  },
  "ECONOMIC_BINDING_ROLE_DISAGREEMENT",
);

// D4 — the same disagreement driven from the statement side: the row's
// semantic_role drifts away from the equation role. R4's exact object.
compileMutation(
  "statement row semantic_role drifts away from a required equation role",
  ({ modelCase, plan }) => {
    for (const bag of [modelCase.statement_structure, plan.statement_rows]) {
      for (const row of bag.cash_flow ?? []) {
        if (row.semantic_role === "cash_from_operations") {
          row.semantic_role = "cash_from_operations_drifted";
        }
      }
    }
  },
  "ECONOMIC_BINDING_REQUIRED_ROW_ABSENT",
);

// D5 — one statement row claimed by two economic nodes.
compileMutation(
  "two economic nodes claim the same statement row",
  ({ binding }) => {
    binding["cash.minimum_cash"] = {
      role: "minimum_cash",
      disposition: "statement_row",
      section: "cash_flow",
      semantic_role: "ending_cash",
      presence: "case_optional",
      join_basis: "role_identity",
    };
  },
  "ECONOMIC_BINDING_ROW_CONTESTED",
);

// D6 — a declared realisation that resolves to more than one statement row.
compileMutation(
  "a declared statement realisation resolves ambiguously",
  ({ modelCase, plan }) => {
    const twin = {
      row_id: "ending_cash_twin",
      label: "Ending cash (twin)",
      row_type: "input",
      semantic_role: "ending_cash",
      historical_authority: "source_input",
    };
    modelCase.statement_structure.cash_flow.push(structuredClone(twin));
    plan.statement_rows.cash_flow.push({ ...structuredClone(twin), row: 900 });
  },
  "ECONOMIC_BINDING_AMBIGUOUS_ROW",
);

// D7 — a role-name collision whose declared owner does not actually own the row.
compileMutation(
  "a role-name collision names an owner that binds no such row",
  ({ binding }) => {
    binding["interest.rcf"] = {
      ...binding["interest.rcf"],
      role_collision_owner: "cash.minimum_cash",
    };
  },
  "ECONOMIC_BINDING_COLLISION_OWNER_INVALID",
);

// D8 — a cross-layer edge pointing at a node that does not exist.
artifactMutation(
  "a cross-layer edge points at a non-existent statement node",
  (artifact) => {
    const economic = layerOf(artifact, "economic");
    economic.edges.find((edge) => edge.cross_layer === true).to =
      "statement:cash_flow:node_that_does_not_exist:0";
  },
  "points at non-existent statement node",
);

// D9 — a cross-layer edge silently retargeted onto a real but different row.
artifactMutation(
  "a cross-layer edge is retargeted onto a different real statement node",
  (artifact) => {
    const economic = layerOf(artifact, "economic");
    const statement = layerOf(artifact, "statement");
    const edge = economic.edges.find((item) => item.cross_layer === true);
    const other = statement.nodes.find((node) => node.id !== edge.to);
    edge.to = other.id;
  },
  "but its edge reaches",
);

// D10 — the binding claim itself tampered: the node declares a realisation its
// statement node does not carry.
artifactMutation(
  "an economic node's declared realisation disagrees with its statement node",
  (artifact) => {
    const economic = layerOf(artifact, "economic");
    economic.nodes[economicNodeIndex(artifact, "cash.cfo")].bound_semantic_role =
      "not_the_row_role";
  },
  "but statement node",
);

// D11 — fabricated absence: a node downgrades itself to row_absent while the row
// is right there in the statement layer. Absence must be earned.
artifactMutation(
  "a node claims its statement row is absent while the layer contains it",
  (artifact) => {
    const economic = layerOf(artifact, "economic");
    const index = economicNodeIndex(artifact, "cash.cfo");
    const node = economic.nodes[index];
    economic.edges = economic.edges.filter((edge) => edge.from !== node.id);
    economic.nodes[index] = {
      ...node,
      binding_status: "row_absent",
      bound_statement_node_id: null,
    };
  },
  "claims row_absent for cash_flow.cash_from_operations but the statement layer derives bound",
);

// D17 — a binding field removed from a node row: neither validator may let a
// node row travel with a field set it does not fully account for.
artifactMutation(
  "a binding field is dropped from an economic node row",
  (artifact) => {
    const economic = layerOf(artifact, "economic");
    delete economic.nodes[economicNodeIndex(artifact, "cash.cfo")].bound_semantic_role;
  },
  "carries an unchecked binding field set",
);

// D18 — an unaccounted field smuggled onto a node row.
artifactMutation(
  "an unaccounted field is smuggled onto an economic node row",
  (artifact) => {
    const economic = layerOf(artifact, "economic");
    economic.nodes[economicNodeIndex(artifact, "cash.cfo")].secretly_added = true;
  },
  "carries an unchecked binding field set",
);

// D19 — a statement-bound node relabelled as a covered schedule node to escape
// every row obligation.
artifactMutation(
  "a statement_row node relabels its status to escape the row obligations",
  (artifact) => {
    const economic = layerOf(artifact, "economic");
    const index = economicNodeIndex(artifact, "cash.cfo");
    const node = economic.nodes[index];
    economic.edges = economic.edges.filter((edge) => edge.from !== node.id);
    economic.nodes[index] = {
      ...node,
      binding_status: "schedule_row_uncovered",
      bound_statement_node_id: null,
    };
  },
  "inadmissible status",
);

// D20 — two realisation edges onto one statement row: the relation must be a
// function.
artifactMutation(
  "two economic nodes carry realisation edges onto one statement row",
  (artifact) => {
    const economic = layerOf(artifact, "economic");
    const cfo = economic.nodes[economicNodeIndex(artifact, "cash.cfo")];
    const index = economicNodeIndex(artifact, "cash.minimum_cash");
    economic.nodes[index] = {
      ...economic.nodes[index],
      binding_disposition: "statement_row",
      binding_row_family: null,
      binding_status: "bound",
      bound_section: cfo.bound_section,
      bound_semantic_role: cfo.bound_semantic_role,
      bound_statement_node_id: cfo.bound_statement_node_id,
    };
    economic.edges.push({
      id: "edge:economic_realises_row:cash.minimum_cash",
      type: "realises_statement_row",
      from: economic.nodes[index].id,
      to: cfo.bound_statement_node_id,
      activation: "always",
      cross_layer: true,
    });
  },
  "is realised by both",
);

// D12 — the edge deleted while the node still claims to be bound.
artifactMutation(
  "the realisation edge is deleted while the node still claims bound",
  (artifact) => {
    const economic = layerOf(artifact, "economic");
    const node = economic.nodes[economicNodeIndex(artifact, "cash.cfo")];
    economic.edges = economic.edges.filter((edge) => edge.from !== node.id);
  },
  "carries no cross-layer edge",
);

// D13 — the coverage ledger understates a gap it must declare.
artifactMutation(
  "the coverage ledger hides an uncovered row family",
  (artifact) => {
    artifact.economic_coverage.uncovered_row_families.instrument = [];
    artifact.economic_coverage_sha256 = hashValue(artifact.economic_coverage);
  },
  "does not match the economic layer it describes",
);

// D14 — the declared node-family gap emptied altogether.
artifactMutation(
  "the declared uncovered node families are emptied",
  (artifact) => {
    artifact.economic_coverage.uncovered_node_families = [];
    artifact.economic_coverage_sha256 = hashValue(artifact.economic_coverage);
  },
  "declares no uncovered node families",
);

// D15 — the binding seal stripped from the closure.
artifactMutation(
  "the binding register seal is stripped from the closure",
  (artifact) => {
    artifact.economic_binding_sha256 = null;
  },
  "does not seal the economic binding register",
);

// D16 — an undeclared binding status smuggled into the layer.
artifactMutation(
  "an undeclared binding status is smuggled into the economic layer",
  (artifact) => {
    const economic = layerOf(artifact, "economic");
    economic.nodes[economicNodeIndex(artifact, "cash.cfo")].binding_status =
      "probably_fine";
  },
  "undeclared binding status",
);

check(caught.length === 20, "every declared drift path is exercised");

// ---------------------------------------------------------------------------
// 6. CROSS-LANGUAGE AGREEMENT — the independent Python oracle
//    (`scripts/verify/invariants.py`) re-declares this vocabulary because it may
//    not import production JavaScript. Re-declaration is what makes a
//    disagreement detectable, but only if something compares the two: a field
//    added on one side and not the other would otherwise travel unchecked
//    through the release gate, which is the defect class this package exists to
//    close. Parsed as text, never imported, so the scan cannot launder
//    independence.
// ---------------------------------------------------------------------------

const oracleSource = fs.readFileSync(
  path.join(root, "scripts", "verify", "invariants.py"),
  "utf8",
);
function pythonTuple(name) {
  const match = oracleSource.match(
    new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, "m"),
  );
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort();
}
function pythonMappingEntry(mapping, key) {
  const block = oracleSource.match(
    new RegExp(`^${mapping}\\s*=\\s*\\{([\\s\\S]*?)^\\}`, "m"),
  );
  if (!block) return null;
  const row = block[1].match(new RegExp(`"${key}":\\s*\\(([^)]*)\\)`));
  if (!row) return null;
  return [...row[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort();
}
for (const [pythonName, jsValue, label] of [
  ["_ECONOMIC_BINDING_FIELDS", ECONOMIC_BINDING_FIELDS, "binding field set"],
  [
    "_ECONOMIC_BINDING_DISPOSITIONS",
    ECONOMIC_BINDING_DISPOSITIONS,
    "disposition vocabulary",
  ],
  ["_ECONOMIC_BINDING_STATUSES", ECONOMIC_BINDING_STATUSES, "status vocabulary"],
]) {
  const fromPython = pythonTuple(pythonName);
  check(
    fromPython !== null &&
      JSON.stringify(fromPython) === JSON.stringify([...jsValue].sort()),
    `the Python oracle re-declares the same ${label} (${pythonName}): ${JSON.stringify(fromPython)}`,
  );
}
for (const disposition of Object.keys(ECONOMIC_STATUS_BY_DISPOSITION)) {
  const fromPython = pythonMappingEntry(
    "_ECONOMIC_STATUS_BY_DISPOSITION",
    disposition,
  );
  check(
    fromPython !== null &&
      JSON.stringify(fromPython) ===
        JSON.stringify([...ECONOMIC_STATUS_BY_DISPOSITION[disposition]].sort()),
    `the Python oracle admits the same statuses for ${disposition}: ${JSON.stringify(fromPython)}`,
  );
}
check(
  ECONOMIC_IDENTITY_FIELDS.every((field) =>
    oracleSource.includes(`"${field}"`),
  ) &&
    /_ECONOMIC_IDENTITY_FIELDS\s*=\s*\(/.test(oracleSource),
  "the Python oracle declares the same economic identity field set",
);
check(
  oracleSource.includes('"economic_binding_scope": artifact.get("economic_binding_scope")') &&
    oracleSource.includes('"economic_binding_sha256": artifact.get("economic_binding_sha256")') &&
    oracleSource.includes('"economic_coverage_sha256": artifact.get("economic_coverage_sha256")'),
  "the Python oracle rebuilds the closure core with the three binding seal fields",
);
check(
  oracleSource.includes('"realises_statement_row"') &&
    oracleSource.includes('"cross_layer": True'),
  "the Python oracle expects the cross-layer realisation edges",
);
check(
  !/from\s+(scripts\.)?lib|import\s+(scripts\.)?lib\b|solver|row_plan|case_compiler|build_dynamic_model/.test(
    oracleSource.split("\n").filter((line) => /^\s*(from|import)\s/.test(line)).join("\n"),
  ),
  "the Python oracle imports no production module (independence preserved)",
);

// ---------------------------------------------------------------------------
// 7. DETERMINISM — the binding adds no instability to the seal.
// ---------------------------------------------------------------------------

for (const fixture of FIXTURES) {
  const { modelCase, plan, artifact } = compiled.get(fixture);
  const again = compileLayeredGraphConstitution(
    structuredClone(modelCase),
    structuredClone(plan),
  );
  check(
    again.closure_sha256 === artifact.closure_sha256 &&
      again.economic_coverage_sha256 === artifact.economic_coverage_sha256,
    `${fixture} the bound constitution recompiles to an identical seal`,
  );
}
check(
  compiled.get("standard-maximal-v2").artifact.economic_binding_sha256 ===
    compiled.get("standard-net-cash-v2").artifact.economic_binding_sha256,
  "both certified cases are bound by the same canonical register",
);

// ---------------------------------------------------------------------------
// 8. MUTATION — real defects applied to copies, each refused by production.
// ---------------------------------------------------------------------------

mutation("a dropped register entry is refused", () => {
  const mutant = { ...ECONOMIC_STATEMENT_BINDING };
  delete mutant[EQUATION_GRAPH.nodes[0].id];
  check(
    validateEquationGraphRowBinding(mutant, EQUATION_GRAPH).some((error) =>
      error.includes(EQUATION_GRAPH.nodes[0].id) && error.includes("no declared row binding"),
    ),
    "the binding validator refuses a register missing an equation-graph node",
  );
});

mutation("a corrupted role is refused", () => {
  const node = EQUATION_GRAPH.nodes[0];
  const mutant = { ...ECONOMIC_STATEMENT_BINDING, [node.id]: { ...ECONOMIC_STATEMENT_BINDING[node.id], role: "mutated_role" } };
  check(
    validateEquationGraphRowBinding(mutant, EQUATION_GRAPH).some((error) =>
      error.includes(node.id) && error.includes(node.role),
    ),
    "the binding validator refuses a register whose role disagrees with the graph",
  );
});

mutation("a statement_row binding without a section is refused", () => {
  const [nodeId, declared] = Object.entries(ECONOMIC_STATEMENT_BINDING)
    .find(([, entry]) => entry.disposition === "statement_row");
  const mutant = {
    ...ECONOMIC_STATEMENT_BINDING,
    [nodeId]: { ...declared, section: "", semantic_role: "" },
  };
  check(
    validateEquationGraphRowBinding(mutant, EQUATION_GRAPH).some((error) =>
      error.includes(nodeId) && error.includes("without a section and semantic role"),
    ),
    "the binding validator refuses a realisation that names no row",
  );
});

const mutationArtifact = compiled.get("standard-maximal-v2").artifact;
mutation("a flipped binding status is refused", () => {
  const mutant = structuredClone(mutationArtifact);
  const economicLayer = mutant.layers.find((layer) => layer.layer_id === "economic");
  const boundNode = economicLayer.nodes.find((node) => node.binding_status === "bound");
  boundNode.binding_status = "row_absent";
  check(
    validateLayeredGraphConstitution(mutant).length > 0,
    "the constitution validator refuses an economic node that silently abandons its row",
  );
});

mutation("a withdrawn cross-layer edge is refused", () => {
  const mutant = structuredClone(mutationArtifact);
  const economicLayer = mutant.layers.find((layer) => layer.layer_id === "economic");
  economicLayer.edges = (economicLayer.edges ?? []).filter(
    (edge) => !(edge.cross_layer === true && edge.type === "realises_statement_row"),
  );
  check(
    validateLayeredGraphConstitution(mutant).length > 0,
    "the constitution validator refuses an economic layer that claims bindings it no longer carries",
  );
});

mutation("a tampered closure seal is refused", () => {
  const mutant = structuredClone(mutationArtifact);
  mutant.closure_sha256 = "0".repeat(64);
  check(
    validateLayeredGraphConstitution(mutant).length > 0,
    "the constitution validator refuses a closure hash that does not match its bindings",
  );
});

if (failures.length > 0) {
  console.error(failures.map((item) => `- ${item}`).join("\n"));
  assert.fail(`${failures.length} canonical graph binding checks failed`);
}
console.log(JSON.stringify({ status: "PASS", checks, mutations_total, mutations_caught }));
