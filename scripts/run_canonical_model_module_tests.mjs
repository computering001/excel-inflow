#!/usr/bin/env node
/**
 * P4.4 — THE NINE-MODULE CANONICAL MODEL GRAPH.
 *
 * Invariant under test: every one of the nine modules
 * `assets/canonical-model-graph-v2.json` declares has a CHECKED boundary — its
 * nodes, its edges, its inputs, its outputs and its declared invariants are
 * validated against what `solveCase` actually produces — and each of the six
 * declared graph invariants is either proven or declared unprovable with a
 * specific reason that cannot be relabelled away.
 *
 * Reproduced RED against the tree before this package, and re-reproduced live
 * below so the gap cannot reopen in silence:
 *   R1  the shipped asset declares `module_contract.required_fields` including
 *       `module_version` and carries NO per-module structure of any kind: nine
 *       bare strings, no versions, no seal.
 *   R2  none of the eight contract field names and none of the six invariant
 *       names has a single producer or consumer anywhere in `scripts/` or
 *       `assets/` outside the asset itself. The only two textual near-misses
 *       (`iteration_state_size` in the equation-graph suite,
 *       `single_writer_groups` in `model_ir_v3`) are different concepts about
 *       different objects, and the scan proves the contract's own tokens are
 *       absent.
 *   R3  the asset's ONLY reader in the repository is `policy_registry.mjs`,
 *       which consumes `.modules` as an opaque string list to validate a
 *       policy's `owned_assumption.module`. Nothing reads anything else.
 *   R4  BEHAVIOURAL: run the conformance validator against the asset as it
 *       shipped and it reports `MODULE_VERSION_SEAL_ABSENT` — the contract as
 *       published cannot validate itself.
 *
 * This suite does not touch `scripts/lib/solver.mjs`. It reads a solved
 * artifact and checks the declared boundaries against it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import {
  CANONICAL_MODEL_GRAPH,
  CANONICAL_MODEL_MODULE_SCOPE,
  CANONICAL_MODULE_BOUNDARIES,
  DECLARED_DENOMINATIONS,
  DECLARED_GRAPH_INVARIANTS,
  EDGE_TOLERANCE_RULE,
  GRAPH_INVARIANT_DECLARATIONS,
  MODULE_CONTRACT_REQUIRED_FIELDS,
  MODULE_INVARIANTS,
  NODE_CARRIERS,
  SHARED_ARTIFACT_CHANNELS,
  SOLVER_FRAME_FIELDS,
  UNOWNED_EQUATION_NODES,
  auditInvariantDeclarations,
  bindCanonicalModules,
  canonicalModuleContractDigest,
  carrierPresence,
  graphCarriesUnitAnnotation,
  moduleBoundaryDigest,
  ownedNodeIndex,
  quotientSccs,
  solverFieldCensusErrors,
  statementBindingsFor,
  validateCanonicalModuleBinding,
  validateGraphInvariants,
  validateModuleContractConformance,
  validateModuleInvariants,
} from "./lib/canonical_model_modules.mjs";
import {
  ECONOMIC_STATEMENT_BINDING,
  compileLayeredGraphConstitution,
} from "./lib/layered_graph_constitution.mjs";
import { EQUATION_GRAPH, deriveStronglyConnectedComponents } from "./lib/equation_graph.mjs";
import { compileRowPlan } from "./lib/row_plan.mjs";
import { solveCase, solverIterationDeclaration } from "./lib/solver.mjs";

// The red proofs below assert what the asset looked like BEFORE this package.
// They must read a PINNED commit, not HEAD: once P4.4 is committed HEAD carries
// the register and a HEAD-relative proof inverts itself, which is exactly what
// happened on first integration. 9008f5e is the last commit to touch this asset
// before P4.4 (`git log --oneline -- assets/canonical-model-graph-v2.json`).
const PRE_P44_BASELINE = "9008f5e";

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const CERTIFIED = ["standard-maximal-v2", "standard-net-cash-v2"];

let checks = 0;
const failures = [];
function check(condition, label) {
  checks += 1;
  if (!condition) failures.push(label);
}

const loadCase = (file) => {
  const modelCase = JSON.parse(fs.readFileSync(file, "utf8"));
  // Maintained fixtures are production-shaped custody inputs; every scenario
  // in this suite is forensic and identifies itself as such.
  modelCase.execution_profile = "reference_parity";
  return modelCase;
};
const certifiedCase = (name) =>
  loadCase(path.join(root, "test-fixtures", "cases", `${name}.json`));

const cloneBoundaries = () =>
  JSON.parse(JSON.stringify(CANONICAL_MODULE_BOUNDARIES));

// ===========================================================================
// A. RED PROOF — the contract was implemented by nothing
// ===========================================================================

let shippedAsset = null;
try {
  shippedAsset = JSON.parse(
    execFileSync("git", ["show", `${PRE_P44_BASELINE}:assets/canonical-model-graph-v2.json`], {
      cwd: root,
      encoding: "utf8",
    }),
  );
} catch (error) {
  failures.push(`R1: cannot read the shipped asset from HEAD (${error.message})`);
}

check(
  shippedAsset !== null && !Object.hasOwn(shippedAsset, "module_versions"),
  "R1: the shipped asset already carried module_versions",
);
check(
  shippedAsset !== null && !Object.hasOwn(shippedAsset, "module_boundary_register"),
  "R1: the shipped asset already named a boundary register",
);
check(
  shippedAsset !== null &&
    Array.isArray(shippedAsset.modules) &&
    shippedAsset.modules.length === 9 &&
    shippedAsset.modules.every((entry) => typeof entry === "string"),
  "R1: the shipped asset's modules were not nine bare strings",
);
check(
  shippedAsset !== null &&
    shippedAsset.module_contract.required_fields.includes("module_version"),
  "R1: the shipped contract did not name module_version",
);

// R2 — static scan. The contract's own tokens have no producer.
const scanRoots = [path.join(root, "scripts"), path.join(root, "assets")];
const EXCLUDED_FROM_SCAN = new Set([
  path.join(root, "assets", "canonical-model-graph-v2.json"),
  path.join(root, "scripts", "lib", "canonical_model_modules.mjs"),
  path.join(root, "scripts", "run_canonical_model_module_tests.mjs"),
  // P4.10 — a READER, not a producer. It asks the module contract whether the
  // union of the declared iteration states equals the solver's own state
  // vector, which is this package's own invariant seen from the other side.
  // The allowance is not a hole: the production-side check below is computed
  // over the FULL scan set, exclusions included, and no allow-list can satisfy
  // it.
  path.join(root, "scripts", "run_declared_fixed_point_completeness_tests.mjs"),
]);
function walk(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__pycache__") continue;
      walk(full, out);
    } else if (/\.(mjs|js|py|json)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}
const scanFiles = scanRoots
  .flatMap((directory) => walk(directory))
  .filter((file) => !EXCLUDED_FROM_SCAN.has(file));
const CONTRACT_TOKENS = [
  "module_version",
  "read_set",
  "write_set",
  "iteration_state",
  ...DECLARED_GRAPH_INVARIANTS,
];
const producers = new Map();
for (const file of scanFiles) {
  const text = fs.readFileSync(file, "utf8");
  for (const token of CONTRACT_TOKENS) {
    // Whole-token match: `iteration_state_size` and `single_writer_groups` are
    // different identifiers about different objects and must not be counted.
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${token}(?![A-Za-z0-9_])`);
    if (pattern.test(text)) {
      if (!producers.has(token)) producers.set(token, []);
      producers.get(token).push(path.relative(root, file));
    }
  }
}
// R2b (P4.10) — the production-side statement, computed over EVERY file in the
// scan roots INCLUDING the exclusions. A suite may READ the contract's fields;
// only the owning module and the sealed asset may declare them. This cannot be
// satisfied by adding a file to `EXCLUDED_FROM_SCAN`, so the allowance above
// buys nothing here.
{
  const OWNERS = new Set([
    path.join("scripts", "lib", "canonical_model_modules.mjs"),
    path.join("assets", "canonical-model-graph-v2.json"),
  ]);
  const productionProducers = [];
  for (const file of scanRoots.flatMap((directory) => walk(directory))) {
    const relative = path.relative(root, file);
    if (OWNERS.has(relative)) continue;
    if (/^scripts[/\\]run_/.test(relative)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (
      CONTRACT_TOKENS.some((token) =>
        new RegExp(`(?<![A-Za-z0-9_])${token}(?![A-Za-z0-9_])`).test(text),
      )
    ) {
      productionProducers.push(relative);
    }
  }
  check(
    productionProducers.length === 0,
    `R2b: a non-suite file outside the owning package declares a contract token: ${JSON.stringify(
      productionProducers,
    )}`,
  );
}

for (const token of CONTRACT_TOKENS) {
  check(
    !producers.has(token),
    `R2: ${token} now has producers outside this package: ${JSON.stringify(producers.get(token) ?? [])}`,
  );
}
check(
  fs.readFileSync(path.join(root, "scripts", "run_equation_graph_tests.mjs"), "utf8")
    .includes("iteration_state_size"),
  "R2: the iteration_state_size near-miss witness moved",
);
check(
  fs.readFileSync(path.join(root, "scripts", "lib", "model_ir_v3.mjs"), "utf8")
    .includes("single_writer_groups"),
  "R2: the single_writer_groups near-miss witness moved",
);

// R3 — the asset's only reader, and what it reads.
const assetReaders = scanFiles.filter((file) =>
  fs.readFileSync(file, "utf8").includes("canonical-model-graph-v2.json"),
);
const readerNames = assetReaders.map((file) => path.relative(root, file)).sort();
check(
  readerNames.every((name) =>
    [
      "assets/architecture-ownership-v2.json",
      "assets/deployment-profile.json",
      // P7.4's register CITES the asset as its boundary-register provenance
      // ("boundary_register": "assets/canonical-model-graph-v2.json ...").
      // R3 detects readers by scanning for the filename, so a provenance
      // citation is indistinguishable from a read here. It is a citation, not
      // a read: nothing in the metamorphic layer loads or parses the asset.
      "assets/metamorphic-relations-v1.json",
      "assets/policy-registry-v1.schema.json",
      "scripts/lib/policy_registry.mjs",
      "scripts/run_policy_registry_tests.mjs",
    ].includes(name),
  ),
  `R3: an unexpected reader of the asset appeared: ${JSON.stringify(readerNames)}`,
);
const policyRegistrySource = fs.readFileSync(
  path.join(root, "scripts", "lib", "policy_registry.mjs"),
  "utf8",
);
check(
  policyRegistrySource.includes(
    'readJson("canonical-model-graph-v2.json").modules',
  ),
  "R3: policy_registry no longer reads only .modules off the asset",
);
for (const field of MODULE_CONTRACT_REQUIRED_FIELDS) {
  if (field === "nodes" || field === "edges" || field === "invariants") continue;
  check(
    !policyRegistrySource.includes(field),
    `R3: policy_registry started reading ${field}`,
  );
}

// R4 — behavioural red: the contract as shipped cannot validate itself.
const shippedConformance =
  shippedAsset === null
    ? []
    : validateModuleContractConformance({ contract: shippedAsset });
check(
  shippedConformance.some((error) => error.startsWith("MODULE_VERSION_SEAL_ABSENT")),
  "R4: the shipped asset did not report MODULE_VERSION_SEAL_ABSENT",
);

// ===========================================================================
// B. CONTRACT CONFORMANCE
// ===========================================================================

check(
  validateModuleContractConformance().length === 0,
  `B: conformance errors ${JSON.stringify(validateModuleContractConformance())}`,
);
check(
  MODULE_CONTRACT_REQUIRED_FIELDS.length === 8,
  "B: the contract no longer names eight required fields",
);
check(
  Object.keys(CANONICAL_MODULE_BOUNDARIES).length === 9 &&
    CANONICAL_MODEL_GRAPH.modules.length === 9,
  "B: the module count moved",
);
for (const [moduleId, boundary] of Object.entries(CANONICAL_MODULE_BOUNDARIES)) {
  check(
    MODULE_CONTRACT_REQUIRED_FIELDS.every((fieldName) =>
      Object.hasOwn(boundary, fieldName),
    ),
    `B: ${moduleId} is missing a required contract field`,
  );
  check(
    /^\d+\.\d+\.\d+$/.test(boundary.module_version),
    `B: ${moduleId} has no well-formed module_version`,
  );
  check(
    CANONICAL_MODEL_GRAPH.module_versions[moduleId].boundary_sha256 ===
      moduleBoundaryDigest(boundary),
    `B: ${moduleId} boundary digest is not the sealed one`,
  );
  check(boundary.invariants.length > 0, `B: ${moduleId} declares no invariant`);
}

// Node partition totality.
const owned = ownedNodeIndex();
check(owned.size === 38, `B: ${owned.size} owned nodes, expected 38`);
check(
  UNOWNED_EQUATION_NODES.length === 1 &&
    UNOWNED_EQUATION_NODES[0].node_id === "control.circularity" &&
    Boolean(UNOWNED_EQUATION_NODES[0].reason),
  "B: the declared-unowned set is not exactly the solver control with a reason",
);
check(
  owned.size + UNOWNED_EQUATION_NODES.length === EQUATION_GRAPH.nodes.length,
  "B: the node partition is not total",
);
check(
  [...owned.values()].every((moduleId) => !moduleId.includes("+")),
  "B: a node is claimed by more than one module",
);

// Edge partition totality.
const declaredEdgeCount = Object.values(CANONICAL_MODULE_BOUNDARIES).reduce(
  (total, boundary) => total + boundary.edges.length,
  0,
);
check(
  declaredEdgeCount === EQUATION_GRAPH.edges.length,
  `B: ${declaredEdgeCount} declared edges vs ${EQUATION_GRAPH.edges.length} in the graph`,
);
for (const edge of EQUATION_GRAPH.edges) {
  const ownerId = owned.get(edge.to);
  check(
    CANONICAL_MODULE_BOUNDARIES[ownerId].edges.includes(edge.id),
    `B: ${edge.id} is not declared by ${ownerId}, which owns its dependent`,
  );
}

// Carriers, and exact agreement with P4.6's dispositions.
check(
  Object.keys(NODE_CARRIERS).length === 38,
  "B: the carrier register does not cover every owned node",
);
const statementChannel = Object.entries(NODE_CARRIERS)
  .filter(([, carrier]) => carrier.channel === "statement_row")
  .map(([nodeId]) => nodeId)
  .sort();
const p46StatementRows = Object.entries(ECONOMIC_STATEMENT_BINDING)
  .filter(([, entry]) => entry.disposition === "statement_row")
  .map(([nodeId]) => nodeId)
  .sort();
check(
  JSON.stringify(statementChannel) === JSON.stringify(p46StatementRows),
  "B: the statement-row channel is not exactly P4.6's statement_row disposition",
);
check(statementChannel.length === 18, "B: P4.6's statement_row count moved from 18");
const scheduleChannel = Object.entries(NODE_CARRIERS)
  .filter(([, carrier]) => carrier.channel !== "statement_row")
  .map(([nodeId]) => nodeId)
  .sort();
const p46ScheduleRows = Object.entries(ECONOMIC_STATEMENT_BINDING)
  .filter(([, entry]) => entry.disposition === "schedule_row")
  .map(([nodeId]) => nodeId)
  .sort();
check(
  JSON.stringify(scheduleChannel) === JSON.stringify(p46ScheduleRows),
  "B: the schedule channel is not exactly P4.6's schedule_row disposition",
);
check(scheduleChannel.length === 20, "B: P4.6's schedule_row count moved from 20");
check(
  ECONOMIC_STATEMENT_BINDING["control.circularity"].disposition === "solver_control",
  "B: P4.6 no longer types control.circularity as a solver control",
);
check(
  Object.keys(NODE_CARRIERS).every((nodeId) =>
    DECLARED_DENOMINATIONS.includes(NODE_CARRIERS[nodeId].denomination),
  ),
  "B: a carrier declares an undeclared denomination",
);
check(
  carrierPresence("cash.cfo") === "required" &&
    carrierPresence("cash.noncash_interest_addback") === "case_optional" &&
    carrierPresence("interest.rcf") === "always",
  "B: carrier presence is not being read off P4.6's register",
);

// The invariant register.
check(
  MODULE_INVARIANTS.length === 26,
  `B: ${MODULE_INVARIANTS.length} module invariants, expected 26`,
);
check(
  new Set(MODULE_INVARIANTS.map((entry) => entry.invariant_id)).size ===
    MODULE_INVARIANTS.length,
  "B: a module invariant id is duplicated",
);
for (const entry of MODULE_INVARIANTS) {
  check(
    Boolean(entry.statement) && entry.operands.length > 0,
    `B: ${entry.invariant_id} has no statement or no operands`,
  );
}
check(
  SHARED_ARTIFACT_CHANNELS.length === 1 &&
    SHARED_ARTIFACT_CHANNELS[0].path === "forecast[].statement_values" &&
    Boolean(SHARED_ARTIFACT_CHANNELS[0].single_writer_authority),
  "B: the shared statement-values channel is not declared with its authority",
);
check(
  /^[0-9a-f]{64}$/.test(canonicalModuleContractDigest()) &&
    canonicalModuleContractDigest() === canonicalModuleContractDigest(),
  "B: the contract digest is not a stable sha256",
);

// ===========================================================================
// C. THE SIX DECLARED GRAPH INVARIANTS
// ===========================================================================

check(
  DECLARED_GRAPH_INVARIANTS.length === 6,
  "C: the asset no longer declares six invariants",
);
check(
  auditInvariantDeclarations().length === 0,
  `C: declaration audit ${JSON.stringify(auditInvariantDeclarations())}`,
);
const statusCount = { proven: 0, proven_partial: 0, unprovable: 0 };
for (const name of DECLARED_GRAPH_INVARIANTS) {
  const declaration = GRAPH_INVARIANT_DECLARATIONS[name];
  check(Boolean(declaration), `C: ${name} has no declaration`);
  statusCount[declaration.status] += 1;
}
check(
  statusCount.proven === 5 && statusCount.proven_partial === 1,
  `C: status mix ${JSON.stringify(statusCount)}, expected five proven and one partial`,
);
check(
  !graphCarriesUnitAnnotation(),
  "C: the equation graph gained a unit annotation — unit_compatible_edges can now be promoted",
);
check(
  GRAPH_INVARIANT_DECLARATIONS.unit_compatible_edges.why.includes(
    "additionalProperties",
  ) &&
    GRAPH_INVARIANT_DECLARATIONS.unit_compatible_edges.why.includes(
      "derived_number",
    ),
  "C: the unit remainder no longer names both concrete blockers",
);
check(
  Object.keys(EDGE_TOLERANCE_RULE).length === 10,
  "C: the edge-type rule no longer covers all ten declared edge types",
);

// Solve both certified fixtures, on and off.
const solved = new Map();
const solvedOff = [];
for (const name of CERTIFIED) {
  const modelCase = certifiedCase(name);
  solved.set(name, { modelCase, solution: solveCase(modelCase) });
  const off = certifiedCase(name);
  off.controls.circularity = 0;
  solvedOff.push(solveCase(off));
}

const graphErrors = validateGraphInvariants({
  circularity_off_solutions: solvedOff,
});
check(graphErrors.length === 0, `C: graph invariants ${JSON.stringify(graphErrors)}`);

// cycles_only_in_declared_iteration_subgraphs, recomputed rather than trusted.
const activeSccs = deriveStronglyConnectedComponents(EQUATION_GRAPH, {
  circularity: 1,
});
const sccNodes = activeSccs.flatMap((component) => component.nodes ?? component);
// P4.10 — 13 -> 17. The tax path is inside the fixed point because the sweep
// has always iterated it; the graph now declares the edges that make it so.
check(activeSccs.length === 1 && sccNodes.length === 17, "C: the active SCC moved");
const sccModules = [...new Set(sccNodes.map((nodeId) => owned.get(nodeId)))].sort();
check(
  JSON.stringify(sccModules) ===
    JSON.stringify(["cash_rcf", "interest", "tax_and_working_capital"]),
  `C: the node-level cycle spans ${JSON.stringify(sccModules)}`,
);
const declaredIteration = Object.values(CANONICAL_MODULE_BOUNDARIES)
  .flatMap((boundary) => boundary.iteration_state)
  .sort();
const solverVector = solverIterationDeclaration(1)
  .state_vector.map((component) => component.node_id)
  .sort();
check(
  JSON.stringify(declaredIteration) === JSON.stringify(solverVector),
  "C: the declared iteration states are not exactly the solver's state vector",
);
check(declaredIteration.length === 17, "C: the state vector is no longer 17 nodes");
// The declared quotient coarsening, proven benign.
const quotientOn = quotientSccs(1);
check(
  quotientOn.length === 1 &&
    JSON.stringify(quotientOn[0]) ===
      JSON.stringify([
        "cash_rcf",
        "debt_instruments",
        "interest",
        "tax_and_working_capital",
      ]),
  `C: the quotient component moved to ${JSON.stringify(quotientOn)}`,
);
check(
  CANONICAL_MODULE_BOUNDARIES.debt_instruments.nodes.every(
    (nodeId) => !sccNodes.includes(nodeId),
  ),
  "C: a debt_instruments node entered the node-level cycle, so the coarsening is no longer benign",
);
check(
  CANONICAL_MODULE_BOUNDARIES.debt_instruments.iteration_state.length === 0,
  "C: debt_instruments declares an iteration state it does not need",
);
check(
  Boolean(
    GRAPH_INVARIANT_DECLARATIONS.cycles_only_in_declared_iteration_subgraphs
      .declared_coarsening,
  ),
  "C: the quotient coarsening is no longer declared",
);

// circularity_off_has_no_active_scc, on the graph and on real solves.
check(
  deriveStronglyConnectedComponents(EQUATION_GRAPH, { circularity: 0 }).length === 0,
  "C: circularity=0 still has a node-level component",
);
check(quotientSccs(0).length === 0, "C: the quotient graph is cyclic with circularity off");
for (const solution of solvedOff) {
  check(
    solution.equation_graph_evidence.active_circularity_state === 0 &&
      solution.equation_graph_evidence.active_sccs.length === 0 &&
      solution.equation_graph_evidence.solver_declaration.required === false &&
      solution.equation_graph_evidence.solver_declaration.state_vector.length === 0 &&
      Number(solution.residual) === 0,
    `C: ${solution.case_id} does not evidence a cycle-free solve with circularity off`,
  );
}

// ===========================================================================
// D. BINDING THE NINE BOUNDARIES TO A REAL SOLVED ARTIFACT
// ===========================================================================

const bound = new Map();
for (const name of CERTIFIED) {
  const { modelCase, solution } = solved.get(name);
  const constitution = compileLayeredGraphConstitution(
    modelCase,
    compileRowPlan(modelCase),
  );
  const artifact = bindCanonicalModules({
    modelCase,
    solution,
    statementBindings: statementBindingsFor(constitution),
  });
  bound.set(name, artifact);
  const errors = validateCanonicalModuleBinding(artifact, { modelCase, solution });
  check(errors.length === 0, `D: ${name} binding ${JSON.stringify(errors.slice(0, 5))}`);
  check(
    artifact.schema_version === CANONICAL_MODEL_MODULE_SCOPE &&
      artifact.modules.length === 9,
    `D: ${name} did not bind nine modules`,
  );
  const carriers = artifact.modules.flatMap((module) => module.carriers);
  check(carriers.length === 38, `D: ${name} bound ${carriers.length} carriers`);
  check(
    carriers.filter((carrier) => carrier.bound).length === 37,
    `D: ${name} resolved ${carriers.filter((c) => c.bound).length} carriers; 37 expected (cash.noncash_interest_addback is P4.6 row_absent on both certified fixtures)`,
  );
  const writes = artifact.modules.flatMap((module) => module.writes);
  check(writes.length === 94, `D: ${name} declared ${writes.length} write paths`);
  check(
    writes
      .filter((write) => write.presence === "always")
      .every((write) => write.resolved),
    `D: ${name} has an unconditional write path the solver does not carry`,
  );
  check(
    writes
      .filter((write) => write.presence === "case_conditional")
      .every((write) => Boolean(write.note)),
    `D: ${name} has an unexplained conditional write path`,
  );
  check(
    artifact.modules.every((module) =>
      module.invariants.every((result) => result.failures.length === 0),
    ),
    `D: ${name} has a failing module invariant`,
  );
  // Every module carries a checked boundary — none is bound vacuously.
  for (const module of artifact.modules) {
    check(
      module.invariants.length > 0 && module.writes.length > 0,
      `D: ${name} module ${module.module_id} has an empty boundary`,
    );
  }
  check(
    solverFieldCensusErrors(solution).length === 0,
    `D: ${name} census ${JSON.stringify(solverFieldCensusErrors(solution).slice(0, 4))}`,
  );
}

// The three node-less modules are DECLARED, not silently empty.
for (const moduleId of ["historical_statements", "acquisition_overlay", "outputs_and_ratios"]) {
  check(
    CANONICAL_MODULE_BOUNDARIES[moduleId].nodes.length === 0 &&
      CANONICAL_MODULE_BOUNDARIES[moduleId].write_set.length > 0 &&
      CANONICAL_MODULE_BOUNDARIES[moduleId].invariants.length > 0,
    `D: ${moduleId} has neither equation nodes nor a checked artifact boundary`,
  );
}

// ===========================================================================
// E. ARCHETYPE SWEEP — the module invariants on every case that solves
// ===========================================================================

const archetypeDirectory = path.join(
  root,
  "test-fixtures",
  "archetypes",
  "economics",
);
let swept = 0;
const typedRefusals = [];
for (const file of fs.readdirSync(archetypeDirectory).sort()) {
  if (!file.endsWith(".json")) continue;
  const modelCase = loadCase(path.join(archetypeDirectory, file));
  let solution;
  try {
    solution = solveCase(modelCase);
  } catch (error) {
    typedRefusals.push([file, error.code ?? null]);
    continue;
  }
  swept += 1;
  const invariantFailures = validateModuleInvariants({ modelCase, solution });
  check(
    invariantFailures.length === 0,
    `E: ${file} ${JSON.stringify(invariantFailures.slice(0, 3))}`,
  );
  check(
    solverFieldCensusErrors(solution).length === 0,
    `E: ${file} census ${JSON.stringify(solverFieldCensusErrors(solution).slice(0, 3))}`,
  );
}
check(swept === 31, `E: swept ${swept} archetypes, expected 31`);
check(
  typedRefusals.length === 2 && typedRefusals.every(([, code]) => Boolean(code)),
  `E: refusals are not both typed: ${JSON.stringify(typedRefusals)}`,
);

// ===========================================================================
// F. P4.8 WITNESS PIN — the independent confirmations are still independent
// ===========================================================================

const oracleSource = fs.readFileSync(
  path.join(root, "scripts", "verify", "solver_fixed_point_oracle.py"),
  "utf8",
);
const citedDomains = [
  ...new Set(
    MODULE_INVARIANTS.filter((entry) => entry.independent_confirmation)
      .map((entry) => entry.independent_confirmation.split(":")[1]),
  ),
].sort();
check(citedDomains.length === 5, `F: ${citedDomains.length} cited oracle domains`);
for (const domain of citedDomains) {
  check(
    new RegExp(`"${domain}"`).test(oracleSource),
    `F: P4.8's oracle no longer declares the ${domain} domain this package cites`,
  );
}
check(
  oracleSource.includes("DECLARED_DOMAINS"),
  "F: P4.8's declared-domain register moved",
);

// ===========================================================================
// G. MUTATIONS — one per module boundary, plus the relabelling guard
// ===========================================================================

function mutationCatches(label, mutate, expectedCode, mode = "conformance") {
  const boundaries = cloneBoundaries();
  mutate(boundaries);
  let errors;
  if (mode === "conformance") {
    errors = validateModuleContractConformance({ boundaries });
  } else if (mode === "graph") {
    errors = validateGraphInvariants({
      boundaries,
      circularity_off_solutions: solvedOff,
    });
  } else {
    errors = solverFieldCensusErrors(solved.get(CERTIFIED[0]).solution, boundaries);
  }
  check(
    errors.some((error) => error.includes(expectedCode)),
    `G/${label}: expected ${expectedCode}, got ${JSON.stringify(errors.slice(0, 3))}`,
  );
}

// One mutation per module boundary.
mutationCatches(
  "historical_statements",
  (boundaries) => {
    boundaries.historical_statements.write_set =
      boundaries.historical_statements.write_set.filter(
        (entry) => entry.path !== "solution.opening_debt_bridge",
      );
  },
  "CENSUS_SOLUTION_FIELD_UNCLAIMED",
  "census",
);
mutationCatches(
  "operating_forecast",
  (boundaries) => {
    boundaries.operating_forecast.nodes = [];
    boundaries.cash_rcf.nodes.push("statement.ebit");
  },
  "MODULE_NODE_OWNER_BASIS_DISAGREEMENT",
);
mutationCatches(
  "tax_and_working_capital",
  (boundaries) => {
    boundaries.tax_and_working_capital.edges =
      boundaries.tax_and_working_capital.edges.filter(
        (edgeId) => edgeId !== "edge.effective_tax_rate_to_tax_expense",
      );
  },
  "MODULE_EDGE_OWNER_DISAGREEMENT",
);
mutationCatches(
  "debt_instruments",
  (boundaries) => {
    boundaries.debt_instruments.read_set =
      boundaries.debt_instruments.read_set.filter(
        (entry) => entry.detail !== "interest.instrument_pik",
      );
  },
  "declared_cross_module_reads_and_writes: undeclared cross-module read",
  "graph",
);
mutationCatches(
  "leases",
  (boundaries) => {
    boundaries.leases.nodes.push("interest.lease");
  },
  "MODULE_NODE_CONTESTED",
);
mutationCatches(
  "cash_rcf",
  (boundaries) => {
    boundaries.cash_rcf.iteration_state =
      boundaries.cash_rcf.iteration_state.filter((nodeId) => nodeId !== "rcf.draw");
  },
  "cycles_only_in_declared_iteration_subgraphs",
  "graph",
);
mutationCatches(
  "interest",
  (boundaries) => {
    boundaries.interest.write_set.push({
      path: "forecast[].ending_cash",
      presence: "always",
      note: null,
    });
  },
  "single_writer",
  "graph",
);
mutationCatches(
  "acquisition_overlay",
  (boundaries) => {
    boundaries.acquisition_overlay.write_set =
      boundaries.acquisition_overlay.write_set.filter(
        (entry) => entry.path !== "forecast[].acquisition_debt",
      );
  },
  "CENSUS_PERIOD_FIELD_UNCLAIMED",
  "census",
);
mutationCatches(
  "outputs_and_ratios",
  (boundaries) => {
    boundaries.outputs_and_ratios.read_set.push({
      from_module: "interest",
      channel: "equation_edge",
      detail: "cash.ending_balance",
    });
  },
  "declared_cross_module_reads_and_writes",
  "graph",
);

// module_version — the field nothing implemented, now with teeth.
mutationCatches(
  "module_version_unbumped",
  (boundaries) => {
    boundaries.leases.write_set.push({
      path: "forecast[].lease_interest_rate",
      presence: "always",
      note: null,
    });
  },
  "MODULE_VERSION_UNBUMPED",
);
{
  const boundaries = cloneBoundaries();
  boundaries.leases.module_version = "2.0.1";
  const errors = validateModuleContractConformance({ boundaries });
  check(
    errors.some((error) => error.includes("MODULE_VERSION_DISAGREEMENT")),
    "G/module_version_bumped_without_reseal: a bare version bump was accepted",
  );
}

// The relabelling guard: an unvalidated invariant cannot be marked proven.
{
  const relabelled = JSON.parse(JSON.stringify(GRAPH_INVARIANT_DECLARATIONS));
  relabelled.unit_compatible_edges = {
    status: "proven",
    what_is_proven: "every edge joins compatible units",
  };
  const errors = auditInvariantDeclarations(relabelled);
  check(
    errors.some((error) =>
      error.includes("INVARIANT_PROVEN_AGAINST_A_LIVE_BLOCKER"),
    ),
    "G/relabel_proven: unit_compatible_edges was silently promoted to proven",
  );
}
{
  const stripped = JSON.parse(JSON.stringify(GRAPH_INVARIANT_DECLARATIONS));
  delete stripped.unit_compatible_edges.why;
  check(
    auditInvariantDeclarations(stripped).some((error) =>
      error.includes("INVARIANT_REMAINDER_UNEXPLAINED"),
    ),
    "G/strip_reason: a partial invariant kept its status with no reason",
  );
}
{
  const contradictory = JSON.parse(JSON.stringify(GRAPH_INVARIANT_DECLARATIONS));
  contradictory.single_writer.what_is_unprovable = "some of it, actually";
  check(
    auditInvariantDeclarations(contradictory).some((error) =>
      error.includes("INVARIANT_PROVEN_WITH_REMAINDER"),
    ),
    "G/proven_with_remainder: a proven invariant kept an undeclared remainder",
  );
}
{
  const dropped = JSON.parse(JSON.stringify(GRAPH_INVARIANT_DECLARATIONS));
  delete dropped.single_writer;
  check(
    auditInvariantDeclarations(dropped).some((error) =>
      error.includes("INVARIANT_UNDECLARED"),
    ),
    "G/drop_declaration: a contract invariant with no status was accepted",
  );
}

// No vacuous pass: the circularity-off invariant refuses without evidence.
check(
  validateGraphInvariants().some((error) =>
    error.includes("no circularity-off solved artifact supplied"),
  ),
  "G/vacuous: the circularity-off invariant passed with no evidence",
);

// The carrier binding has teeth against a moved number.
{
  const { modelCase, solution } = solved.get("standard-maximal-v2");
  const tampered = JSON.parse(JSON.stringify(solution));
  tampered.forecast[0].gross_interest += 1;
  const failures = validateModuleInvariants({ modelCase, solution: tampered });
  check(
    failures.some((failure) => failure.includes("gross_expense_decomposes")),
    "G/moved_number: a perturbed gross interest did not break the interest boundary",
  );
}
{
  const { modelCase, solution } = solved.get("standard-maximal-v2");
  const tampered = JSON.parse(JSON.stringify(solution));
  tampered.forecast[1].instrument_results[0].ending_native += 0.5;
  check(
    validateModuleInvariants({ modelCase, solution: tampered }).some((failure) =>
      failure.includes("seven_term_roll_forward"),
    ),
    "G/moved_instrument: a broken roll-forward did not break the debt boundary",
  );
}
{
  const { modelCase, solution } = solved.get("standard-maximal-v2");
  const tampered = JSON.parse(JSON.stringify(solution));
  tampered.forecast[0].rcf_draw = 10;
  check(
    validateModuleInvariants({ modelCase, solution: tampered }).some((failure) =>
      failure.includes("sweep_answers_cash_need"),
    ),
    "G/sweep: a draw with cash above the floor did not break the cash boundary",
  );
}
{
  const { modelCase, solution } = solved.get("standard-maximal-v2");
  const tampered = JSON.parse(JSON.stringify(solution));
  tampered.opening_debt_bridge.lines[0].source_ref = "";
  check(
    validateModuleInvariants({ modelCase, solution: tampered }).some((failure) =>
      failure.includes("opening_instrument_provenance_is_declared"),
    ),
    "G/provenance: an opening balance without provenance was accepted",
  );
}
{
  // A carrier retargeted onto another real row must disagree with its mirror.
  const { modelCase, solution } = solved.get("standard-maximal-v2");
  const artifact = JSON.parse(JSON.stringify(bound.get("standard-maximal-v2")));
  const module = artifact.modules.find((entry) => entry.module_id === "interest");
  const carrier = module.carriers.find(
    (entry) => entry.node_id === "statement.finance_expense",
  );
  carrier.statement_row = { row_id: "net_income", section: "income_statement", semantic_role: "net_income" };
  check(
    validateCanonicalModuleBinding(artifact, { modelCase, solution }).some((error) =>
      error.includes("BINDING_CARRIER_MIRROR_DISAGREEMENT"),
    ),
    "G/retarget: a carrier moved onto a foreign row was accepted",
  );
}
{
  // Two nodes claiming one statement row — the delegated single-writer channel.
  const { modelCase, solution } = solved.get("standard-maximal-v2");
  const artifact = JSON.parse(JSON.stringify(bound.get("standard-maximal-v2")));
  const taxModule = artifact.modules.find(
    (entry) => entry.module_id === "tax_and_working_capital",
  );
  taxModule.carriers.find(
    (entry) => entry.node_id === "statement.net_income",
  ).statement_row = {
    row_id: "pre_tax_income",
    section: "income_statement",
    semantic_role: "pre_tax_income",
  };
  check(
    validateCanonicalModuleBinding(artifact, { modelCase, solution }).some((error) =>
      error.includes("BINDING_STATEMENT_ROW_CONTESTED"),
    ),
    "G/contested_row: two economic nodes claimed one statement row",
  );
}
{
  // A new solver field must be classified, not absorbed.
  const { solution } = solved.get("standard-maximal-v2");
  const extended = JSON.parse(JSON.stringify(solution));
  extended.forecast[0].brand_new_economic_quantity = 1;
  check(
    solverFieldCensusErrors(extended).some((error) =>
      error.includes("CENSUS_PERIOD_FIELD_UNCLAIMED"),
    ),
    "G/new_field: a new solver output slipped past the census",
  );
}
{
  // A boundary digest that drifts under a binding artifact is reported.
  const { modelCase, solution } = solved.get("standard-net-cash-v2");
  const artifact = JSON.parse(JSON.stringify(bound.get("standard-net-cash-v2")));
  artifact.modules[0].boundary_sha256 = "0".repeat(64);
  check(
    validateCanonicalModuleBinding(artifact, { modelCase, solution }).some((error) =>
      error.includes("BINDING_BOUNDARY_DIGEST_DRIFT"),
    ),
    "G/digest_drift: a drifted boundary digest was accepted on a binding",
  );
}

// ===========================================================================

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(JSON.stringify({ status: "FAIL", checks, failures: failures.length }));
  process.exit(1);
}
assert.equal(failures.length, 0);
console.log(JSON.stringify({ status: "PASS", checks }));
