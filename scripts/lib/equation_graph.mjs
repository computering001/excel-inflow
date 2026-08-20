import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ECONOMIC_SOLVE_POLICY,
  validateEconomicSolvePolicy,
} from "./economic_solve_policy.mjs";
import { validateJsonSchema } from "./json_schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, "../../assets");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ASSETS, name), "utf8"));
}

function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]),
    );
  }
  return value;
}

export function canonicalJsonSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalise(value)))
    .digest("hex");
}

function duplicates(values) {
  const seen = new Set();
  const duplicate = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}

function componentKey(nodes) {
  return [...nodes].sort().join("\u0000");
}

function normalisedComponents(components) {
  return components
    .map((component) => [...component].sort())
    .sort((left, right) => componentKey(left).localeCompare(componentKey(right)));
}

function componentSetsEqual(left, right) {
  return JSON.stringify(normalisedComponents(left)) === JSON.stringify(normalisedComponents(right));
}

function exactJsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function declaredComponents(entries) {
  return entries.map((entry) => entry.nodes);
}

function edgeMatches(edge, declaration) {
  return ["id", "from", "to", "type", "activation"]
    .every((field) => edge?.[field] === declaration[field]);
}

function activationIsLive(activation, circularity) {
  if (activation === "always") return true;
  if (activation === "circularity_on") return circularity === 1;
  if (activation === "circularity_off") return circularity === 0;
  return false;
}

export function activeEquationEdges(graph, circularity) {
  if (circularity !== 0 && circularity !== 1) {
    throw new Error(`circularity must be 0 or 1; received ${circularity}.`);
  }
  return graph.edges
    .filter((edge) => activationIsLive(edge.activation, circularity))
    .map((edge) => structuredClone(edge));
}

/**
 * Deterministic Tarjan SCC derivation. Node and adjacency order are sorted, so
 * neither input array order nor object insertion order can change the result.
 */
export function deriveStronglyConnectedComponents(
  graph,
  { circularity = null, includeSingletons = false } = {},
) {
  if (circularity !== null && circularity !== 0 && circularity !== 1) {
    throw new Error(`circularity must be null, 0 or 1; received ${circularity}.`);
  }
  const nodeIds = [...new Set((graph.nodes ?? []).map((node) => node.id))].sort();
  const nodeSet = new Set(nodeIds);
  const selectedEdges = circularity === null
    ? (graph.edges ?? [])
    : activeEquationEdges(graph, circularity);
  const adjacency = new Map(nodeIds.map((nodeId) => [nodeId, []]));
  const selfLoops = new Set();
  for (const edge of selectedEdges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
    adjacency.get(edge.from).push({ to: edge.to, id: edge.id });
    if (edge.from === edge.to) selfLoops.add(edge.from);
  }
  for (const edges of adjacency.values()) {
    edges.sort((left, right) => left.to.localeCompare(right.to) || left.id.localeCompare(right.id));
  }

  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(nodeId) {
    indices.set(nodeId, nextIndex);
    lowLinks.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const edge of adjacency.get(nodeId)) {
      if (!indices.has(edge.to)) {
        visit(edge.to);
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId), lowLinks.get(edge.to)));
      } else if (onStack.has(edge.to)) {
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId), indices.get(edge.to)));
      }
    }

    if (lowLinks.get(nodeId) !== indices.get(nodeId)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== nodeId);
    component.sort();
    if (includeSingletons || component.length > 1 || selfLoops.has(component[0])) {
      components.push(component);
    }
  }

  for (const nodeId of nodeIds) {
    if (!indices.has(nodeId)) visit(nodeId);
  }
  return normalisedComponents(components);
}

export const deriveSccs = deriveStronglyConnectedComponents;

function labelledComponents(components, declarations) {
  const ids = new Map(declarations.map((entry) => [componentKey(entry.nodes), entry.id]));
  return normalisedComponents(components).map((nodes) => ({
    id: ids.get(componentKey(nodes)) ?? `undeclared.${canonicalJsonSha256(nodes).slice(0, 12)}`,
    nodes,
  }));
}

function validateContractSemantics(contract, graph, policy, errors) {
  for (const id of duplicates(contract.required_edges.map((edge) => edge.id))) {
    errors.push(`convergence contract duplicates required edge ${id}.`);
  }
  for (const id of duplicates(contract.rcf_sweep_contract.edge_ids)) {
    errors.push(`convergence contract duplicates RCF sweep edge ${id}.`);
  }
  for (const state of ["structural", "0", "1"]) {
    const entries = state === "structural"
      ? contract.scc_contract.structural
      : contract.scc_contract.active_by_circularity[state];
    for (const id of duplicates(entries.map((entry) => entry.id))) {
      errors.push(`convergence contract duplicates ${state} SCC id ${id}.`);
    }
    for (const entry of entries) {
      for (const nodeId of duplicates(entry.nodes)) {
        errors.push(`SCC ${entry.id} duplicates node ${nodeId}.`);
      }
    }
  }

  if (contract.graph_binding.schema_version !== graph.schema_version) {
    errors.push("convergence contract graph schema binding does not match the equation graph.");
  }
  if (contract.graph_binding.graph_id !== graph.graph_id) {
    errors.push("convergence contract graph_id binding does not match the equation graph.");
  }
  if (contract.policy_binding.schema_version !== policy.schema_version) {
    errors.push("convergence contract policy schema binding does not match the economic solve policy.");
  }
  const policyHash = canonicalJsonSha256(policy);
  if (contract.policy_binding.canonical_sha256 !== policyHash) {
    errors.push(`economic solve policy hash mismatch: expected ${contract.policy_binding.canonical_sha256}, derived ${policyHash}.`);
  }
  if (JSON.stringify(contract.role_contract.zero_when_off) !== JSON.stringify(policy.circularity_roles.zero_when_off)) {
    errors.push("convergence contract zero_when_off roles must exactly match the canonical economic solve policy roles.");
  }
  if (JSON.stringify(contract.role_contract.live_when_off) !== JSON.stringify(policy.circularity_roles.live_when_off)) {
    errors.push("convergence contract live_when_off roles must exactly match the canonical economic solve policy roles.");
  }

  const graphHash = canonicalJsonSha256(graph);
  if (contract.graph_binding.canonical_sha256 !== graphHash) {
    errors.push(`equation graph hash mismatch: expected ${contract.graph_binding.canonical_sha256}, derived ${graphHash}.`);
  }
}

/**
 * THE EFFECTIVE-TAX-RATE PATH (P3.3).
 *
 * The effective tax rate is the one driver the candidate compiler refuses to
 * forecast from its own historical identity, because `tax = PBT × rate` beside
 * `rate = tax ÷ PBT` is a two-equation cycle. `tax_rate_policy.mjs` breaks it
 * by making the rate an INPUT computed from filed history outside the equation
 * system. That refusal is only sound if the resulting path is genuinely
 * acyclic in the graph the solve is bound to — and until P3.3 the graph
 * contained no tax node at all, so the claim was unprovable rather than true.
 *
 * These four nodes and six edges are that path. The rate enters as an input;
 * pre-tax income consumes EBIT and (when circularity is on) net interest; tax
 * expense consumes the pair; net income closes it.
 *
 * P4.10 — CORRECTED. P3.3 proved two further obligations here: that no ETR node
 * lies inside any strongly connected component, and that no edge leaves the ETR
 * node set. It predicted, in this comment, that "a future edit wiring net income
 * into the cash-flow bridge" would violate them and warned that it "must fail
 * loudly here, not converge quietly". The prediction was right and the warning
 * fired — but the edit was not in the future. The solver has always computed
 * `taxCharge` inside the period sweep from a `preTaxIncome` that consumes the
 * iterated net interest, and has always seeded operating cash flow from
 * `netIncome`. Tax was ALREADY iterated; the graph simply did not declare the
 * edge. So P3.3's obligations 5 and 6 were true statements about an incomplete
 * graph and FALSE statements about the running system, which is the worse of
 * the two failure modes: a sealed proof of a property the artefact under proof
 * did not have.
 *
 * They are not deleted and not loosened. They are replaced by the properties
 * that are actually true, actually protective, and strictly more informative:
 * the RATE is exogenous (which is what breaks `tax = PBT x rate` beside
 * `rate = tax / PBT`); the charge never reaches the rate; the path is acyclic
 * with circularity OFF, where the old obligation still holds exactly; and every
 * ETR node that IS inside a component must be DECLARED in the convergence
 * contract's fixed point and in the solver's iteration vector. That last one is
 * the obligation that would have caught this defect on the day it was
 * introduced, and it is the one this file was missing.
 */
export const EFFECTIVE_TAX_RATE_PATH = Object.freeze({
  schema_version: "effective-tax-rate-path/1.0",
  policy_module: "tax_rate_policy",
  /** The rate the policy owns; the reason this path exists. */
  rate_role: "effective_tax_rate",
  /** The base the rate is applied to. */
  base_role: "pre_tax_income",
  /** The charge the rate and the base produce. */
  charge_role: "tax_expense",
  /** The path's terminal consumer. */
  sink_role: "net_income",
  roles: Object.freeze([
    "pre_tax_income",
    "effective_tax_rate",
    "tax_expense",
    "net_income",
  ]),
  required_edges: Object.freeze([
    Object.freeze({
      id: "edge.ebit_to_pre_tax_income",
      from: "statement.ebit",
      to: "statement.pre_tax_income",
      type: "statement_dependency",
      activation: "always",
    }),
    Object.freeze({
      id: "edge.net_interest_to_pre_tax_income",
      from: "interest.net_expense",
      to: "statement.pre_tax_income",
      type: "schedule_to_statement",
      activation: "circularity_on",
    }),
    Object.freeze({
      id: "edge.pre_tax_income_to_tax_expense",
      from: "statement.pre_tax_income",
      to: "statement.tax_expense",
      type: "statement_dependency",
      activation: "always",
    }),
    Object.freeze({
      id: "edge.effective_tax_rate_to_tax_expense",
      from: "statement.effective_tax_rate",
      to: "statement.tax_expense",
      type: "statement_dependency",
      activation: "always",
    }),
    Object.freeze({
      id: "edge.pre_tax_income_to_net_income",
      from: "statement.pre_tax_income",
      to: "statement.net_income",
      type: "statement_dependency",
      activation: "always",
    }),
    Object.freeze({
      id: "edge.tax_expense_to_net_income",
      from: "statement.tax_expense",
      to: "statement.net_income",
      type: "statement_dependency",
      activation: "always",
    }),
  ]),
});

/**
 * Resolve the declared ETR roles to nodes of `graph`. Roles, never id prefixes:
 * a node id starting "tax" proves nothing and the validator already enforces
 * role uniqueness, so a role is an identifier the graph guarantees is single.
 */
export function deriveEffectiveTaxRatePath(graph, declaration = EFFECTIVE_TAX_RATE_PATH) {
  const errors = [];
  const nodeByRole = new Map();
  for (const role of declaration.roles) {
    const matches = (graph?.nodes ?? []).filter((node) => node.role === role);
    if (matches.length !== 1) {
      errors.push(
        `effective-tax-rate path role ${role} must bind to exactly one equation node; found ${matches.length}.`,
      );
      continue;
    }
    nodeByRole.set(role, matches[0]);
  }
  const nodeIds = declaration.roles
    .map((role) => nodeByRole.get(role)?.id)
    .filter((id) => id !== undefined)
    .sort();
  return { errors, nodeByRole, nodeIds };
}

/**
 * Deterministic Kahn topological order over an induced subgraph. A returned
 * order IS the acyclicity certificate: Kahn terminates with every node placed
 * exactly when the subgraph has no directed cycle, so the caller does not have
 * to trust a separate claim.
 */
function topologicalOrder(nodeIds, edges) {
  const members = new Set(nodeIds);
  const ordered = [...nodeIds].sort();
  const outgoing = new Map(ordered.map((id) => [id, []]));
  const indegree = new Map(ordered.map((id) => [id, 0]));
  for (const edge of edges) {
    if (!members.has(edge.from) || !members.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }
  for (const targets of outgoing.values()) targets.sort();
  const ready = ordered.filter((id) => indegree.get(id) === 0);
  const order = [];
  while (ready.length > 0) {
    ready.sort();
    const id = ready.shift();
    order.push(id);
    for (const target of outgoing.get(id)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) ready.push(target);
    }
  }
  return {
    order,
    complete: order.length === ordered.length,
    unplaced: ordered.filter((id) => !order.includes(id)),
  };
}

/** Every node reachable from `startId` along `edges`, deterministically. */
function reachableFrom(startId, edges) {
  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  for (const targets of outgoing.values()) targets.sort();
  const seen = new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const target of outgoing.get(id) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

/**
 * PROVE the effective-tax-rate path is DAG-safe inside the graph the solve is
 * bound to. Six independent obligations, none of which any other validator
 * covered:
 *
 *   1. PRESENT — every declared role binds to exactly one node.
 *   2. WIRED — every declared edge exists with exactly its declared direction,
 *      type and activation (an absent edge would make 3-6 vacuously true).
 *   3. CONNECTED — the rate and the base each reach the charge, and the charge
 *      reaches the sink. This is what stops the proof passing on four isolated
 *      nodes.
 *   4. ACYCLIC INTERNALLY — a topological order exists over the induced
 *      subgraph, in the structural graph and in both circularity states.
 *   5. THE RATE IS EXOGENOUS — `statement.effective_tax_rate` has no incoming
 *      edge at all, and lies in no strongly connected component, structurally
 *      or in either circularity state. This is the DAG-safety statement in its
 *      true form: `tax = PBT x rate` is circular only if something computes the
 *      RATE from inside the system, and the tax rate policy exists precisely to
 *      make the rate an input derived from filed history OUTSIDE it.
 *   6. THE CHARGE NEVER REACHES THE RATE — no path from any ETR node other than
 *      the rate leads back to the rate. P3.3 approximated this with a blanket
 *      "no edge may leave the ETR set", which forbade far more than the cycle
 *      it was aiming at — including the cash-flow bridge the solver has always
 *      walked. This is the exact statement: the `tax`/`rate` pair may never
 *      close, whatever else the tax path feeds.
 *   7. ACYCLIC WITH CIRCULARITY OFF — with the interest breaker off, no ETR
 *      node lies in any component. P3.3's obligation 5 survives verbatim in the
 *      state where it is still true, and this is what proves the tax path joins
 *      the fixed point only through the interest loop.
 *   8. ANY ITERATED ETR NODE IS DECLARED — every ETR node that DOES lie inside
 *      a circularity-on component must appear in the convergence contract's
 *      declared SCC for that state AND in the solver's declared iteration state
 *      vector. Tax may be solved by iteration; it may never be solved by
 *      iteration that the fixed point does not admit to. This obligation is the
 *      one that turns "the graph forbids it" into "the graph and the solver
 *      must agree about it", and it is what makes an undeclared future edit
 *      fail loudly rather than converge quietly — the outcome P3.3 wanted and
 *      could not express while its own graph omitted the solver's real edges.
 */
export function validateEffectiveTaxRatePathAcyclicity(
  graph,
  declaration = EFFECTIVE_TAX_RATE_PATH,
  contract = CONVERGENCE_CONTRACT,
) {
  const { errors, nodeByRole, nodeIds } = deriveEffectiveTaxRatePath(graph, declaration);
  if (errors.length > 0) return errors;

  const edgesById = new Map((graph.edges ?? []).map((edge) => [edge.id, edge]));
  for (const required of declaration.required_edges) {
    const edge = edgesById.get(required.id);
    if (!edge) {
      errors.push(`effective-tax-rate path edge ${required.id} is missing.`);
    } else if (!edgeMatches(edge, required)) {
      errors.push(
        `effective-tax-rate path edge ${required.id} does not match its declared direction, type and activation.`,
      );
    }
  }
  if (errors.length > 0) return errors;

  const members = new Set(nodeIds);
  const rateId = nodeByRole.get(declaration.rate_role).id;
  const baseId = nodeByRole.get(declaration.base_role).id;
  const chargeId = nodeByRole.get(declaration.charge_role).id;
  const sinkId = nodeByRole.get(declaration.sink_role).id;

  // 3. CONNECTED.
  const allEdges = graph.edges ?? [];
  for (const [fromId, toId, label] of [
    [rateId, chargeId, "the rate must reach the tax charge"],
    [baseId, chargeId, "the tax base must reach the tax charge"],
    [chargeId, sinkId, "the tax charge must reach the path's terminal consumer"],
  ]) {
    if (!reachableFrom(fromId, allEdges).has(toId)) {
      errors.push(
        `effective-tax-rate path is not connected: ${label} (${fromId} does not reach ${toId}).`,
      );
    }
  }

  // 4. ACYCLIC INTERNALLY, in every activation state.
  for (const [label, edges] of [
    ["structural", allEdges],
    ["circularity-off", activeEquationEdges(graph, 0)],
    ["circularity-on", activeEquationEdges(graph, 1)],
  ]) {
    const { complete, unplaced } = topologicalOrder(nodeIds, edges);
    if (!complete) {
      errors.push(
        `effective-tax-rate path has no ${label} topological order: ${unplaced.join(", ")} lie on a cycle.`,
      );
    }
  }

  // 5. THE RATE IS EXOGENOUS. Nothing may compute the rate; that is the whole
  //    mechanism by which the tax/rate pair is broken.
  for (const edge of allEdges) {
    if (edge.to !== rateId) continue;
    errors.push(
      `effective-tax-rate node ${rateId} is computed by edge ${edge.id} from ${edge.from}: the ` +
        "rate must enter the equation system as an INPUT, because a rate derived inside the " +
        "system is exactly the circular tax/rate pair the tax rate policy exists to break.",
    );
  }
  for (const [label, options] of [
    ["structural", {}],
    ["circularity-off", { circularity: 0 }],
    ["circularity-on", { circularity: 1 }],
  ]) {
    for (const component of deriveStronglyConnectedComponents(graph, options)) {
      if (!component.includes(rateId)) continue;
      errors.push(
        `effective-tax-rate rate node ${rateId} lies inside a ${label} strongly connected ` +
          `component [${component.join(", ")}]: the rate would be solved by iteration.`,
      );
    }
  }

  // 6. THE CHARGE NEVER REACHES THE RATE.
  for (const id of nodeIds) {
    if (id === rateId) continue;
    if (!reachableFrom(id, allEdges).has(rateId)) continue;
    errors.push(
      `effective-tax-rate node ${id} reaches the rate ${rateId}: the tax/rate pair must never ` +
        "close, because a charge that determines the rate that determines the charge is the " +
        "two-equation cycle the tax rate policy exists to break.",
    );
  }

  // 7. ACYCLIC WITH CIRCULARITY OFF. P3.3's original obligation 5, kept
  //    verbatim in the state where it is still true of the running solver.
  for (const component of deriveStronglyConnectedComponents(graph, { circularity: 0 })) {
    const trapped = component.filter((id) => members.has(id));
    if (trapped.length > 0) {
      errors.push(
        `effective-tax-rate node(s) ${trapped.join(", ")} lie inside a circularity-off strongly ` +
          `connected component [${component.join(", ")}]: with the interest breaker off nothing ` +
          "in the tax path may be solved by iteration.",
      );
    }
  }

  // 8. ANY ITERATED ETR NODE IS DECLARED. Membership of the fixed point is
  //    permitted; UNDECLARED membership is not.
  const declaredScc = new Set(
    (contract?.scc_contract?.active_by_circularity?.["1"] ?? []).flatMap(
      (component) => component.nodes ?? [],
    ),
  );
  const declaredVector = new Set(
    (contract?.solver_iteration?.state_by_circularity?.["1"]?.state_vector ?? []).map(
      (component) => component.node_id,
    ),
  );
  for (const component of deriveStronglyConnectedComponents(graph, { circularity: 1 })) {
    for (const id of component.filter((item) => members.has(item))) {
      if (!declaredScc.has(id)) {
        errors.push(
          `effective-tax-rate node ${id} is iterated inside a circularity-on strongly connected ` +
            "component but the convergence contract does not declare it a member of the fixed " +
            "point: the declared fixed point must contain every node the solver iterates.",
        );
      }
      if (!declaredVector.has(id)) {
        errors.push(
          `effective-tax-rate node ${id} is iterated inside a circularity-on strongly connected ` +
            "component but the solver's declared iteration state vector omits it: its convergence " +
            "would never be tested.",
        );
      }
    }
  }
  return errors;
}

/**
 * Hash-bound evidence that the ETR path is DAG-safe in THIS graph. Carries the
 * topological order (the certificate), so a consumer can re-derive it rather
 * than trust a boolean.
 */
export function compileEffectiveTaxRatePathProof(
  graph = EQUATION_GRAPH,
  declaration = EFFECTIVE_TAX_RATE_PATH,
  contract = CONVERGENCE_CONTRACT,
) {
  const errors = validateEffectiveTaxRatePathAcyclicity(graph, declaration, contract);
  if (errors.length > 0) {
    throw new Error(`Effective-tax-rate path is not DAG-safe:\n- ${errors.join("\n- ")}`);
  }
  const { nodeByRole, nodeIds } = deriveEffectiveTaxRatePath(graph, declaration);
  const orders = Object.fromEntries(
    [
      ["structural", graph.edges ?? []],
      ["circularity_off", activeEquationEdges(graph, 0)],
      ["circularity_on", activeEquationEdges(graph, 1)],
    ].map(([label, edges]) => [label, topologicalOrder(nodeIds, edges).order]),
  );
  return {
    schema_version: declaration.schema_version,
    policy_module: declaration.policy_module,
    graph_id: graph.graph_id,
    graph_sha256: canonicalJsonSha256(graph),
    nodes_by_role: Object.fromEntries(
      declaration.roles.map((role) => [role, nodeByRole.get(role).id]),
    ),
    edge_ids: declaration.required_edges.map((edge) => edge.id),
    topological_order: orders,
    acyclic: true,
    // P4.10 — these three replace `outside_every_strongly_connected_component`
    // and `terminates`, which named properties the running solver does not have.
    // A proof object must not affirm what its validator no longer proves.
    rate_is_exogenous: true,
    charge_never_reaches_the_rate: true,
    acyclic_with_circularity_off: true,
    // The ETR nodes that ARE iterated, and are therefore required to be members
    // of the declared fixed point. Empty means the tax path is outside the loop.
    iterated_and_declared_in_fixed_point: deriveStronglyConnectedComponents(graph, {
      circularity: 1,
    })
      .flat()
      .filter((id) => nodeIds.includes(id))
      .sort(),
  };
}

/**
 * Totality of the canonical node/row binding, checked at the graph's own seam.
 *
 * The binding register lives in `layered_graph_constitution.mjs` (which imports
 * this module, so the register cannot be imported back without a cycle) and is
 * passed in. The obligation is exact set equality plus per-node role agreement:
 * a node added to the graph without a declared realisation, a node removed while
 * a declaration still names it, and a renamed role are each errors here. Called
 * at the register's own module load, this is what makes a silent divergence
 * between the equation graph and the statement layer impossible rather than
 * merely unlikely.
 *
 * This validates. It never repairs, and it never invents a default disposition
 * for an undeclared node.
 */
export function validateEquationGraphRowBinding(binding, graph = EQUATION_GRAPH) {
  const errors = [];
  if (!binding || typeof binding !== "object") {
    return ["equation graph row binding register is absent or not an object."];
  }
  const declaredIds = new Set(Object.keys(binding));
  for (const node of graph.nodes ?? []) {
    const declared = binding[node.id] ?? null;
    if (!declared) {
      errors.push(
        `equation graph node ${node.id} (role ${node.role}) has no declared row binding.`,
      );
      continue;
    }
    declaredIds.delete(node.id);
    if (declared.role !== node.role) {
      errors.push(
        `equation graph node ${node.id} declares role ${node.role} but its row binding declares ${declared.role}.`,
      );
    }
    if (declared.disposition === "statement_row") {
      if (!declared.section || !declared.semantic_role) {
        errors.push(
          `equation graph node ${node.id} declares a statement_row binding without a section and semantic role.`,
        );
      }
      if (!["required", "case_optional"].includes(declared.presence)) {
        errors.push(
          `equation graph node ${node.id} declares a statement_row binding without a declared presence.`,
        );
      }
    } else if (declared.disposition === "schedule_row") {
      if (!declared.row_family || !declared.schedule_row) {
        errors.push(
          `equation graph node ${node.id} declares a schedule_row binding without a row family and schedule row.`,
        );
      }
    } else if (declared.disposition !== "solver_control") {
      errors.push(
        `equation graph node ${node.id} declares unknown row binding disposition ${declared.disposition}.`,
      );
    }
  }
  for (const id of [...declaredIds].sort()) {
    errors.push(
      `equation graph row binding declares node ${id}, which the graph does not contain.`,
    );
  }
  return errors;
}

export function assertValidEquationGraphRowBinding(
  binding,
  graph = EQUATION_GRAPH,
) {
  const errors = validateEquationGraphRowBinding(binding, graph);
  if (errors.length > 0) {
    throw new Error(
      `Equation graph row binding is not total:\n- ${errors.join("\n- ")}`,
    );
  }
}

export function validateEquationGraph(
  graph,
  contract = CONVERGENCE_CONTRACT,
  policy = ECONOMIC_SOLVE_POLICY,
) {
  const errors = [
    ...validateJsonSchema(graph, EQUATION_GRAPH_SCHEMA),
    ...validateJsonSchema(contract, CONVERGENCE_CONTRACT_SCHEMA),
    ...validateEconomicSolvePolicy(policy).map((error) => `economic solve policy: ${error}`),
  ];
  if (errors.length > 0) return errors;

  const nodesById = new Map();
  for (const id of duplicates(graph.nodes.map((node) => node.id))) {
    errors.push(`equation graph duplicates node id ${id}.`);
  }
  for (const node of graph.nodes) nodesById.set(node.id, node);
  for (const role of duplicates(graph.nodes.map((node) => node.role))) {
    errors.push(`equation graph duplicates semantic role ${role}.`);
  }
  const edgesById = new Map();
  for (const id of duplicates(graph.edges.map((edge) => edge.id))) {
    errors.push(`equation graph duplicates edge id ${id}.`);
  }
  for (const edge of graph.edges) {
    edgesById.set(edge.id, edge);
    if (!nodesById.has(edge.from)) errors.push(`edge ${edge.id} has missing source node ${edge.from}.`);
    if (!nodesById.has(edge.to)) errors.push(`edge ${edge.id} has missing target node ${edge.to}.`);
  }
  if (errors.length > 0) return errors;

  validateContractSemantics(contract, graph, policy, errors);

  const policyBehaviors = [
    ["zero_when_off", policy.circularity_roles.zero_when_off],
    ["live_when_off", policy.circularity_roles.live_when_off],
  ];
  for (const [behavior, roles] of policyBehaviors) {
    for (const role of roles) {
      const matches = graph.nodes.filter((node) => node.role === role);
      if (matches.length !== 1) {
        errors.push(`canonical economic solve policy role ${role} must bind to exactly one equation node.`);
      } else if (matches[0].circularity_behavior !== behavior) {
        errors.push(`node ${matches[0].id} must declare circularity_behavior ${behavior} for policy role ${role}.`);
      }
    }
  }
  const policyRoles = new Set([
    ...policy.circularity_roles.zero_when_off,
    ...policy.circularity_roles.live_when_off,
  ]);
  for (const node of graph.nodes) {
    if (node.circularity_behavior !== "uncontrolled" && !policyRoles.has(node.role)) {
      errors.push(`node ${node.id} declares ${node.circularity_behavior} without a canonical economic solve policy role.`);
    }
  }

  const circularityControlNodes = graph.nodes.filter(
    (node) => node.role === "circularity_control" && node.kind === "control",
  );
  if (circularityControlNodes.length !== 1) {
    errors.push("equation graph must contain exactly one circularity control node.");
  } else {
    const controlNodeId = circularityControlNodes[0].id;
    for (const node of graph.nodes.filter(
      (item) => item.circularity_behavior === "zero_when_off",
    )) {
      const gates = graph.edges.filter(
        (edge) =>
          edge.type === "control_gate" &&
          edge.from === controlNodeId &&
          edge.to === node.id &&
          edge.activation === "always",
      );
      if (gates.length !== 1) {
        errors.push(
          `zero_when_off node ${node.id} must have exactly one always-active circularity control gate.`,
        );
      }
    }
  }

  for (const declaration of contract.required_edges) {
    const edge = edgesById.get(declaration.id);
    if (!edge) {
      errors.push(`required economic edge ${declaration.id} is missing.`);
    } else if (!edgeMatches(edge, declaration)) {
      errors.push(`required economic edge ${declaration.id} does not match its declared direction, type and activation.`);
    }
  }

  for (const edge of graph.edges) {
    if (edge.type !== contract.authority_contract.edge_type) continue;
    const source = nodesById.get(edge.from);
    const target = nodesById.get(edge.to);
    if (
      source.domain !== contract.authority_contract.owner_domain ||
      target.domain !== contract.authority_contract.consumer_domain
    ) {
      errors.push(`schedule-to-statement authority direction is reversed or invalid on edge ${edge.id}.`);
    }
  }

  for (const edgeId of contract.rcf_sweep_contract.edge_ids) {
    const edge = edgesById.get(edgeId);
    if (!edge) {
      errors.push(`RCF sweep edge ${edgeId} is missing.`);
    } else if (edge.activation !== contract.rcf_sweep_contract.activation) {
      errors.push(`RCF sweep edge ${edgeId} must remain active when circularity is off.`);
    }
  }

  for (const edge of graph.edges) {
    if (edge.type === "control_gate") continue;
    const source = nodesById.get(edge.from);
    const target = nodesById.get(edge.to);
    if (
      (source.circularity_behavior === "zero_when_off" || target.circularity_behavior === "zero_when_off") &&
      edge.activation !== "circularity_on"
    ) {
      errors.push(`interest kill-switch edge ${edge.id} must activate only when circularity is on.`);
    }
  }

  const structural = deriveStronglyConnectedComponents(graph);
  const activeOff = deriveStronglyConnectedComponents(graph, { circularity: 0 });
  const activeOn = deriveStronglyConnectedComponents(graph, { circularity: 1 });
  if (!componentSetsEqual(structural, declaredComponents(contract.scc_contract.structural))) {
    errors.push("derived structural SCCs do not match the declared convergence contract.");
  }
  if (!componentSetsEqual(activeOff, declaredComponents(contract.scc_contract.active_by_circularity["0"]))) {
    errors.push("circularity-off active SCCs do not match the declared convergence contract.");
  }
  if (!componentSetsEqual(activeOn, declaredComponents(contract.scc_contract.active_by_circularity["1"]))) {
    errors.push("circularity-on active SCCs do not match the declared convergence contract.");
  }

  const offState = contract.solver_iteration.state_by_circularity["0"];
  if (offState.required || offState.state_vector.length !== 0 || activeOff.length !== 0) {
    errors.push("circularity-off solver state must be empty because the interest SCC is inactive.");
  }
  const onState = contract.solver_iteration.state_by_circularity["1"];
  const vectorIds = onState.state_vector.map((component) => component.node_id);
  for (const nodeId of duplicates(vectorIds)) errors.push(`solver iteration state vector duplicates ${nodeId}.`);
  const activeOnNodes = activeOn.flat().sort();
  if (JSON.stringify([...vectorIds].sort()) !== JSON.stringify(activeOnNodes)) {
    errors.push("solver iteration state vector must contain exactly the circularity-on active SCC nodes.");
  }
  for (const component of onState.state_vector) {
    const node = nodesById.get(component.node_id);
    if (!node) {
      errors.push(`solver iteration state references missing node ${component.node_id}.`);
      continue;
    }
    if (node.tolerance_class !== component.tolerance_class) {
      errors.push(`solver iteration state ${component.node_id} tolerance class does not match its equation node.`);
    }
    if (!Object.hasOwn(policy.native_tolerances, component.tolerance_class)) {
      errors.push(`solver iteration state ${component.node_id} uses unknown policy tolerance class ${component.tolerance_class}.`);
    }
  }
  if (contract.solver_iteration.non_convergence !== policy.solver.non_convergence) {
    errors.push("convergence non-convergence policy must match the economic solve policy.");
  }
  // P3.3 — the effective-tax-rate path is proved DAG-safe here, at the same
  // seam that proves the interest SCC, so no case can be solved against a
  // graph in which the tax path is absent, disconnected or circular.
  errors.push(...validateEffectiveTaxRatePathAcyclicity(graph));
  return errors;
}

export function assertValidEquationGraph(
  graph = EQUATION_GRAPH,
  contract = CONVERGENCE_CONTRACT,
  policy = ECONOMIC_SOLVE_POLICY,
) {
  const errors = validateEquationGraph(graph, contract, policy);
  if (errors.length > 0) throw new Error(`Invalid equation graph / convergence contract:\n- ${errors.join("\n- ")}`);
  return true;
}

export function compileEquationGraphState(options = {}) {
  const normalized = typeof options === "number" ? { circularity: options } : options;
  const {
    circularity = 1,
    graph = EQUATION_GRAPH,
    contract = CONVERGENCE_CONTRACT,
    policy = ECONOMIC_SOLVE_POLICY,
  } = normalized;
  if (circularity !== 0 && circularity !== 1) {
    throw new Error(`circularity must be 0 or 1; received ${circularity}.`);
  }
  assertValidEquationGraph(graph, contract, policy);
  const structural = deriveStronglyConnectedComponents(graph);
  const active = deriveStronglyConnectedComponents(graph, { circularity });
  const declared = contract.scc_contract.structural;
  const state = contract.solver_iteration.state_by_circularity[String(circularity)];
  return {
    graph_schema_version: graph.schema_version,
    convergence_contract_version: contract.schema_version,
    graph_id: graph.graph_id,
    circularity,
    graph_sha256: canonicalJsonSha256(graph),
    economic_solve_policy_sha256: canonicalJsonSha256(policy),
    structural_sccs: labelledComponents(structural, declared),
    active_sccs: labelledComponents(active, contract.scc_contract.active_by_circularity[String(circularity)]),
    solver_iteration: {
      required: state.required,
      method: contract.solver_iteration.method,
      max_iterations: policy.solver.max_iterations,
      absolute_tolerance: policy.solver.absolute_tolerance,
      relative_tolerance: policy.solver.relative_tolerance,
      non_convergence: policy.solver.non_convergence,
      state_vector: state.state_vector.map((component) => ({
        node_id: component.node_id,
        tolerance_class: component.tolerance_class,
        certification_tolerance: policy.native_tolerances[component.tolerance_class],
      })),
    },
  };
}

export const compileEquationGraph = compileEquationGraphState;

/**
 * Compare the iteration declaration owned by the solver with expectations
 * independently compiled from the canonical equation graph and convergence
 * contract.  The solver deliberately owns its own literal declaration: if it
 * merely copied this module's state vector, graph/solver drift would be true by
 * construction and this seam would prove nothing.
 */
export function validateSolverIterationDeclaration(
  declaration,
  {
    graph = EQUATION_GRAPH,
    contract = CONVERGENCE_CONTRACT,
    policy = ECONOMIC_SOLVE_POLICY,
  } = {},
) {
  const errors = [];
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    return ["solver iteration declaration is absent or invalid."];
  }
  const circularity = Number(declaration.active_circularity_state);
  if (circularity !== 0 && circularity !== 1) {
    return [`solver active_circularity_state must be 0 or 1; received ${declaration.active_circularity_state}.`];
  }
  let expected;
  try {
    expected = compileEquationGraphState({ circularity, graph, contract, policy });
  } catch (error) {
    return [`independent equation graph compilation failed: ${error.message}`];
  }
  if (declaration.method !== expected.solver_iteration.method) {
    errors.push(`solver iteration method ${declaration.method ?? "[absent]"} does not match independently compiled method ${expected.solver_iteration.method}.`);
  }
  if (declaration.required !== expected.solver_iteration.required) {
    errors.push(`solver iteration required=${declaration.required} does not match independently compiled required=${expected.solver_iteration.required}.`);
  }
  const actualVector = Array.isArray(declaration.state_vector)
    ? declaration.state_vector
    : null;
  const expectedVector = expected.solver_iteration.state_vector.map(({ node_id, tolerance_class }) => ({
    node_id,
    tolerance_class,
  }));
  if (!actualVector) {
    errors.push("solver iteration state_vector is absent or invalid.");
  } else if (!exactJsonEqual(actualVector, expectedVector)) {
    errors.push("solver iteration state_vector does not match the independently compiled active SCC expectation.");
  }
  const activeNodes = expected.active_sccs.flatMap((component) => component.nodes).sort();
  const declaredNodes = (actualVector ?? []).map((component) => component.node_id).sort();
  if (!exactJsonEqual(declaredNodes, activeNodes)) {
    errors.push("solver iteration node membership does not exactly match the independently compiled active SCC nodes.");
  }
  return errors;
}

/** Compile hash-bound solve evidence only after the independent declaration
 * comparison passes. */
export function compileSolverEquationGraphEvidence(
  declaration,
  options = {},
) {
  const errors = validateSolverIterationDeclaration(declaration, options);
  if (errors.length > 0) {
    throw new Error(`Solver/equation-graph mismatch:\n- ${errors.join("\n- ")}`);
  }
  const expected = compileEquationGraphState({
    circularity: Number(declaration.active_circularity_state),
    ...(options.graph ? { graph: options.graph } : {}),
    ...(options.contract ? { contract: options.contract } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
  });
  return {
    schema_version: "solver-equation-graph-evidence/1.0",
    graph_schema_version: expected.graph_schema_version,
    convergence_contract_version: expected.convergence_contract_version,
    graph_id: expected.graph_id,
    graph_sha256: expected.graph_sha256,
    economic_solve_policy_sha256: expected.economic_solve_policy_sha256,
    active_circularity_state: expected.circularity,
    structural_sccs: expected.structural_sccs,
    active_sccs: expected.active_sccs,
    solver_declaration: structuredClone(declaration),
    declaration_matches_compiled_scc: true,
  };
}

/**
 * Recompile expectations when consuming solve evidence.  This prevents a
 * self-consistent mutation of the declaration and its cached SCC list or
 * hashes from crossing N8.
 */
export function validateSolverEquationGraphEvidence(
  evidence,
  options = {},
) {
  const errors = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return ["solver equation-graph evidence is absent or invalid."];
  }
  if (evidence.schema_version !== "solver-equation-graph-evidence/1.0") {
    errors.push(`solver equation-graph evidence schema is ${evidence.schema_version ?? "[absent]"}, expected solver-equation-graph-evidence/1.0.`);
  }
  const declarationErrors = validateSolverIterationDeclaration(
    evidence.solver_declaration,
    options,
  );
  errors.push(...declarationErrors);
  const circularity = Number(evidence.solver_declaration?.active_circularity_state);
  if (circularity !== 0 && circularity !== 1) return errors;
  if (
    options.circularity !== undefined &&
    options.circularity !== null &&
    Number(options.circularity) !== circularity
  ) {
    errors.push(`solver active circularity state ${circularity} does not match the solved case control ${options.circularity}.`);
  }
  let expected;
  try {
    expected = compileEquationGraphState({
      circularity,
      ...(options.graph ? { graph: options.graph } : {}),
      ...(options.contract ? { contract: options.contract } : {}),
      ...(options.policy ? { policy: options.policy } : {}),
    });
  } catch (error) {
    errors.push(`independent equation graph compilation failed: ${error.message}`);
    return errors;
  }
  for (const [field, expectedValue] of [
    ["graph_schema_version", expected.graph_schema_version],
    ["convergence_contract_version", expected.convergence_contract_version],
    ["graph_id", expected.graph_id],
    ["graph_sha256", expected.graph_sha256],
    ["economic_solve_policy_sha256", expected.economic_solve_policy_sha256],
    ["active_circularity_state", expected.circularity],
  ]) {
    if (evidence[field] !== expectedValue) {
      errors.push(`solver equation-graph evidence ${field} does not match the independently compiled value.`);
    }
  }
  if (!exactJsonEqual(evidence.structural_sccs, expected.structural_sccs)) {
    errors.push("solver equation-graph evidence structural_sccs do not match independent compilation.");
  }
  if (!exactJsonEqual(evidence.active_sccs, expected.active_sccs)) {
    errors.push("solver equation-graph evidence active_sccs do not match independent compilation.");
  }
  if (evidence.declaration_matches_compiled_scc !== true) {
    errors.push("solver equation-graph evidence does not affirm declaration_matches_compiled_scc=true.");
  }
  return errors;
}

export const EQUATION_GRAPH_SCHEMA = Object.freeze(readJson("equation-graph.v1.schema.json"));
export const CONVERGENCE_CONTRACT_SCHEMA = Object.freeze(readJson("convergence-contract.v1.schema.json"));
export const EQUATION_GRAPH = Object.freeze(readJson("equation-graph.v1.json"));
export const CONVERGENCE_CONTRACT = Object.freeze(readJson("convergence-contract.v1.json"));

assertValidEquationGraph(EQUATION_GRAPH, CONVERGENCE_CONTRACT, ECONOMIC_SOLVE_POLICY);
