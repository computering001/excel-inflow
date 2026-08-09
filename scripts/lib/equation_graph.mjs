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
