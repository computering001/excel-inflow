import { createHash } from "node:crypto";
import fs from "node:fs";

import { validateJsonSchema } from "./json_schema.mjs";

const ROOT = new URL("../../", import.meta.url);
const DEMAND_SCHEMA = JSON.parse(
  fs.readFileSync(new URL("assets/model-demand-graph-v1.schema.json", ROOT), "utf8"),
);
const AUTHORITY_SCHEMA = JSON.parse(
  fs.readFileSync(new URL("assets/selected-authority-contract-v1.schema.json", ROOT), "utf8"),
);
const CONSTITUTION_SCHEMA = JSON.parse(
  fs.readFileSync(new URL("assets/run-constitution-graph-v1.schema.json", ROOT), "utf8"),
);
const PRODUCT_CONSTITUTION = JSON.parse(
  fs.readFileSync(new URL("assets/product-constitution-v1.json", ROOT), "utf8"),
);
const PRODUCT_CONSTITUTION_SCHEMA = JSON.parse(
  fs.readFileSync(new URL("assets/product-constitution-v1.schema.json", ROOT), "utf8"),
);

const INDEPENDENT_AUTHORITY_LADDER = Object.freeze([
  "actual_plus_remainder",
  "contractual_commitment",
  "company_guidance",
  "company_indication",
  "selected_broker",
  "user_assumption",
  "driver_formula",
  "roll_forward",
  "seasonal_run_rate",
  "historical_average",
  "historical_trend",
  "carry_forward",
  "explicit_zero",
]);

const STRUCTURAL_METHODS = new Set([
  "accounting_identity",
  "schedule_link",
  "not_applicable",
]);
const FALLBACK_METHODS = new Set([
  "driver_formula",
  "roll_forward",
  "seasonal_run_rate",
  "historical_average",
  "historical_trend",
  "carry_forward",
  "explicit_zero",
]);
const REACHABLE_OUTPUTS = Object.freeze([
  "adjusted_ebitda",
  "free_cash_flow",
  "ending_cash",
  "gross_debt",
  "net_debt",
  "liquidity",
  "leverage",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonical(value))}\n`;
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const PRODUCT_CONSTITUTION_ERRORS = validateJsonSchema(
  PRODUCT_CONSTITUTION,
  PRODUCT_CONSTITUTION_SCHEMA,
);
if (
  JSON.stringify(PRODUCT_CONSTITUTION.visible_milestones) !==
  JSON.stringify(["company", "filings", "brokers", "debt", "build", "deliver"])
) {
  PRODUCT_CONSTITUTION_ERRORS.push(
    "Product constitution visible milestones are not the canonical ordered journey.",
  );
}
if (PRODUCT_CONSTITUTION_ERRORS.length > 0) {
  throw new Error(
    `Product constitution is invalid: ${PRODUCT_CONSTITUTION_ERRORS[0]}`,
  );
}
export const PRODUCT_CONSTITUTION_SHA256 = digest(PRODUCT_CONSTITUTION);

export function causalFindingDisposition({
  unresolved,
  reachable_to_material_output,
  alternative_authority_path,
  user_resolvable = false,
}) {
  if (!unresolved || !reachable_to_material_output) return "LOG";
  if (alternative_authority_path) return "DEGRADE";
  if (user_resolvable) return "ASK_ONCE";
  return "BLOCK";
}

export function authorityQualitySummary(contract) {
  return {
    quality_mode: contract?.quality_mode ?? "INPUT_REQUIRED",
    quarantined_evidence_count: (contract?.quarantines ?? []).length,
    fallback_count: (contract?.authorities ?? []).filter(
      (item) =>
        FALLBACK_METHODS.has(item.method) ||
        (item.fallback_trace ?? []).length > 0,
    ).length,
    unresolved_count: (contract?.authorities ?? []).filter(
      (item) => item.status === "INPUT_REQUIRED",
    ).length,
  };
}

function withoutHash(value, field) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

function forecastPeriods(modelCase) {
  return (modelCase?.periods ?? [])
    .filter((period) => period?.status === "forecast")
    .map((period) => period.date);
}

function rowAuthorityClass(row) {
  const method = row?.forecast_treatment;
  if (method === "schedule_link" || row?.historical_authority === "schedule_link") return "schedule";
  if (method === "not_separately_forecast") return "captured";
  if (["calculation", "subtotal"].includes(row?.row_type) || row?.forecast_calculation) return "identity";
  return "independent_input";
}

function allowedAuthorities(authorityClass) {
  if (authorityClass === "identity") return ["accounting_identity"];
  if (authorityClass === "schedule") return ["schedule_link"];
  if (authorityClass === "captured") return ["not_separately_forecast"];
  if (authorityClass === "contractual") return ["contractual_source"];
  return [...INDEPENDENT_AUTHORITY_LADDER];
}

function rowDependencies(row) {
  const declared = [
    ...(row?.dependencies ?? []),
    ...(row?.forecast_calculation?.refs ?? []),
    ...(row?.calculation?.refs ?? []),
  ];
  return [...new Set(declared.filter((value) => typeof value === "string" && value))].sort();
}

export function compileModelDemandGraph(modelCase) {
  const periods = forecastPeriods(modelCase);
  if (periods.length !== 3) throw new Error("Model demand requires exactly three forecast periods.");
  const nodes = [];
  const edges = [];
  const rowNodeIds = new Set();
  for (const section of ["income_statement", "cash_flow"]) {
    const rows = modelCase?.statement_structure?.[section] ?? [];
    for (const row of rows) {
      if (!row?.row_id || row.row_type === "header") continue;
      const authorityClass = rowAuthorityClass(row);
      const material = row.material !== false;
      for (let index = 0; index < periods.length; index += 1) {
        const nodeId = `${section}.${row.row_id}.fy${index + 1}`;
        rowNodeIds.add(nodeId);
        nodes.push({
          node_id: nodeId,
          node_kind: "forecast_state",
          section,
          concept_id: row.semantic_role ?? row.row_id,
          source_line_ids: [...new Set(row.source_line_ids ?? [])].sort(),
          period_end: periods[index],
          required: material && authorityClass !== "captured",
          material,
          authority_class: authorityClass,
          allowed_authorities: allowedAuthorities(authorityClass),
          reachable_outputs: material ? [...REACHABLE_OUTPUTS] : [],
        });
      }
    }
  }
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase?.statement_structure?.[section] ?? []) {
      if (!row?.row_id || row.row_type === "header") continue;
      for (let index = 0; index < periods.length; index += 1) {
        const to = `${section}.${row.row_id}.fy${index + 1}`;
        for (const dependency of rowDependencies(row)) {
          const candidates = [
            `${section}.${dependency}.fy${index + 1}`,
            `income_statement.${dependency}.fy${index + 1}`,
            `cash_flow.${dependency}.fy${index + 1}`,
          ];
          const from = candidates.find((candidate) => rowNodeIds.has(candidate));
          if (from && from !== to) edges.push({ from, to, kind: "depends_on" });
        }
      }
    }
  }
  for (const authority of modelCase?.instrument_term_authorities ?? []) {
    if (!authority?.instrument_id || !authority?.model_field) continue;
    nodes.push({
      node_id: `debt_schedule.${authority.instrument_id}.${authority.model_field}`,
      node_kind: "contractual_term",
      section: "debt_schedule",
      concept_id: authority.model_field,
      source_line_ids: [],
      instrument_id: authority.instrument_id,
      period_end: null,
      required: true,
      material: true,
      authority_class: "contractual",
      allowed_authorities: ["contractual_source"],
      reachable_outputs: ["gross_debt", "net_debt", "liquidity", "leverage"],
    });
  }
  nodes.sort((left, right) => left.node_id.localeCompare(right.node_id));
  const uniqueEdges = [...new Map(edges.map((edge) => [`${edge.from}\0${edge.to}`, edge])).values()]
    .sort((left, right) => left.to.localeCompare(right.to) || left.from.localeCompare(right.from));
  const body = {
    schema_version: "model-demand-graph/1.0",
    product_constitution_sha256: PRODUCT_CONSTITUTION_SHA256,
    case_id: String(modelCase?.case_id ?? "unknown"),
    forecast_periods: periods,
    nodes,
    edges: uniqueEdges,
    counts: {
      forecast_states: nodes.filter((node) => node.node_kind === "forecast_state").length,
      contractual_terms: nodes.filter((node) => node.node_kind === "contractual_term").length,
      required_material: nodes.filter((node) => node.required && node.material).length,
      edges: uniqueEdges.length,
    },
  };
  return Object.freeze({ ...body, graph_sha256: digest(body) });
}

export function validatePreBrokerDemandCoverage(preBrokerDemand, modelDemandGraph) {
  const errors = [];
  if (preBrokerDemand?.schema_version !== "pre-broker-model-demand/1.0") {
    errors.push("Pre-broker demand has the wrong schema version.");
    return { valid: false, errors, matched_nodes: 0 };
  }
  const preBody = withoutHash(preBrokerDemand, "graph_sha256");
  if (preBrokerDemand.graph_sha256 !== digest(preBody)) {
    errors.push("Pre-broker demand has a stale canonical graph hash.");
  }
  if (
    JSON.stringify(preBrokerDemand.forecast_periods ?? []) !==
    JSON.stringify(modelDemandGraph?.forecast_periods ?? [])
  ) {
    errors.push("Pre-broker and final model demand use different forecast periods.");
  }
  const preKeys = new Set((preBrokerDemand.nodes ?? []).map(
    (node) => `${node.section}\0${node.source_line_id}\0${node.period_end}`,
  ));
  const finalKeys = new Set();
  for (const node of modelDemandGraph?.nodes ?? []) {
    if (node.node_kind !== "forecast_state") continue;
    for (const sourceLineId of node.source_line_ids ?? []) {
      finalKeys.add(`${node.section}\0${sourceLineId}\0${node.period_end}`);
    }
  }
  for (const key of preKeys) {
    if (!finalKeys.has(key)) {
      errors.push(`Filed model demand disappeared before final authority resolution: ${key.replaceAll("\0", ".")}.`);
    }
  }
  for (const key of finalKeys) {
    if (!preKeys.has(key)) {
      errors.push(`Final filed demand was absent from the pre-broker graph: ${key.replaceAll("\0", ".")}.`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    matched_nodes: [...preKeys].filter((key) => finalKeys.has(key)).length,
  };
}

function demandQuarantines(evidenceRun) {
  const result = [];
  const terminal = evidenceRun?.broker_crosswalk_receipt?.terminal_recovery ??
    evidenceRun?.case_evidence?.lanes?.broker_evidence?.controller_state?.summary?.terminal_recovery ??
    null;
  for (const item of terminal?.quarantined_candidates ?? []) {
    result.push({
      scope: String(item.candidate_id ?? item.table_id ?? "broker_candidate"),
      reason: String(item.rationale ?? "Broker evidence was preserved but excluded from model authority."),
      model_use: "prohibited",
    });
  }
  const brokerState = evidenceRun?.case_evidence?.lanes?.broker_evidence?.controller_state;
  if (brokerState?.pipeline_status === "PASS_DEGRADED" && result.length === 0) {
    result.push({
      scope: "broker.degraded_close",
      reason: "The broker lane closed with optional evidence excluded from model authority.",
      model_use: "prohibited",
    });
  }
  return result.sort((left, right) => left.scope.localeCompare(right.scope));
}

export function compileSelectedAuthorityContract({ modelCase, forecastPlan, modelDemandGraph, evidenceRun = null }) {
  const demandById = new Map((modelDemandGraph?.nodes ?? []).map((node) => [node.node_id, node]));
  const candidatesByState = new Map();
  for (const candidate of forecastPlan?.candidate_ledger ?? []) {
    const entries = candidatesByState.get(candidate.state_id) ?? [];
    entries.push(candidate);
    candidatesByState.set(candidate.state_id, entries);
  }
  const stateById = new Map((forecastPlan?.states ?? []).map((state) => [state.state_id, state]));
  const authorities = [];
  for (const demand of modelDemandGraph?.nodes ?? []) {
    if (demand.node_kind === "contractual_term") {
      authorities.push({
        node_id: demand.node_id,
        method: "contractual_source",
        selected_candidate_id: demand.node_id,
        selected_state: null,
        selected_candidate: null,
        source_bindings: [],
        fallback_trace: [],
        status: "SELECTED",
      });
      continue;
    }
    const state = stateById.get(demand.node_id);
    const candidates = candidatesByState.get(demand.node_id) ?? [];
    const rejected = candidates.filter((candidate) => !candidate.selected);
    const method = state?.method ?? "unresolved";
    const selectedCandidate = candidates.find(
      (candidate) => candidate.candidate_id === state?.selected_candidate_id,
    ) ?? null;
    const status = !state || state.status !== "RESOLVED"
      ? "INPUT_REQUIRED"
      : method === "not_separately_forecast"
        ? "CAPTURED"
        : STRUCTURAL_METHODS.has(method)
          ? "STRUCTURAL"
          : "SELECTED";
    authorities.push({
      node_id: demand.node_id,
      method,
      selected_candidate_id: state?.selected_candidate_id ?? null,
      selected_state: state ? structuredClone(state) : null,
      selected_candidate: selectedCandidate ? structuredClone(selectedCandidate) : null,
      source_bindings: [...new Set(state?.source_bindings ?? [])].sort(),
      fallback_trace: rejected.map((candidate) =>
        `${candidate.candidate_id}:${candidate.rejection_reason ?? "not_selected"}`),
      status,
    });
  }
  authorities.sort((left, right) => left.node_id.localeCompare(right.node_id));
  const quarantines = demandQuarantines(evidenceRun);
  const unresolved = authorities.filter((authority) => authority.status === "INPUT_REQUIRED").length;
  const fallbackCount = authorities.filter((authority) =>
    FALLBACK_METHODS.has(authority.method) || authority.fallback_trace.length > 0).length;
  const qualityMode = unresolved > 0
    ? "INPUT_REQUIRED"
    : quarantines.length > 0 || fallbackCount > 0
      ? "DEGRADED"
      : "VERIFIED";
  const body = {
    schema_version: "selected-authority-contract/1.0",
    product_constitution_sha256: PRODUCT_CONSTITUTION_SHA256,
    case_id: String(modelCase?.case_id ?? "unknown"),
    model_demand_graph_sha256: modelDemandGraph.graph_sha256,
    forecast_plan_sha256: digest(forecastPlan),
    quality_mode: qualityMode,
    authorities,
    quarantines,
    counts: {
      demand_nodes: authorities.length,
      selected: authorities.filter((authority) => authority.status === "SELECTED").length,
      structural: authorities.filter((authority) => authority.status === "STRUCTURAL").length,
      captured: authorities.filter((authority) => authority.status === "CAPTURED").length,
      unresolved,
      fallbacks: fallbackCount,
    },
  };
  return Object.freeze({ ...body, contract_sha256: digest(body) });
}

export function compileRunConstitutionGraph({
  evidenceRun,
  modelCase,
  forecastPlan,
  modelDemandGraph,
  selectedAuthorityContract,
  laneStates = {},
}) {
  const nodes = new Map();
  const edges = [];
  const addNode = (node_id, node_type, status) => nodes.set(node_id, { node_id, node_type, status });
  for (const source of evidenceRun?.source_inventory ?? []) {
    addNode(`source.${source.source_id}`, "source", source.status ?? "unknown");
  }
  for (const demand of modelDemandGraph.nodes) addNode(demand.node_id, "model_state", demand.required ? "required" : "optional");
  for (const candidate of forecastPlan?.candidate_ledger ?? []) {
    addNode(candidate.candidate_id, "candidate", candidate.selected ? "selected" : "alternate");
    edges.push({ from: candidate.candidate_id, to: candidate.state_id, kind: "candidate_for" });
    for (const source of candidate.source_bindings ?? []) {
      const sourceId = `source.${source}`;
      if (!nodes.has(sourceId)) addNode(sourceId, "source", "referenced");
      edges.push({ from: sourceId, to: candidate.candidate_id, kind: "supports" });
    }
  }
  for (const authority of selectedAuthorityContract.authorities) {
    if (authority.selected_candidate_id && nodes.has(authority.selected_candidate_id)) {
      edges.push({ from: authority.selected_candidate_id, to: authority.node_id, kind: "selected_for" });
    }
  }
  for (const edge of modelDemandGraph.edges) edges.push({ ...edge, kind: "depends_on" });
  for (const output of REACHABLE_OUTPUTS) addNode(`economic.${output}`, "economic_state", "declared");
  for (const demand of modelDemandGraph.nodes.filter((node) => node.material)) {
    for (const output of demand.reachable_outputs) {
      edges.push({ from: demand.node_id, to: `economic.${output}`, kind: "depends_on" });
    }
  }
  for (const [lane, state] of Object.entries(laneStates ?? {})) {
    for (const task of state?.tasks ?? []) {
      const taskId = `obligation.${lane}.${task.task_id ?? task.task_kind ?? "task"}`;
      addNode(taskId, "obligation", state.pipeline_status ?? "open");
    }
  }
  const uniqueEdges = [...new Map(edges.map((edge) => [
    `${edge.from}\0${edge.to}\0${edge.kind}`,
    edge,
  ])).values()].sort((left, right) =>
    left.to.localeCompare(right.to) || left.from.localeCompare(right.from) || left.kind.localeCompare(right.kind));
  const selectedAuthorities = selectedAuthorityContract.authorities.filter((authority) =>
    authority.selected_candidate_id !== null && authority.status === "SELECTED");
  const orphanSelected = selectedAuthorities.filter((authority) =>
    !uniqueEdges.some((edge) => edge.kind === "selected_for" && edge.to === authority.node_id)).length;
  const sortedNodes = [...nodes.values()].sort((left, right) => left.node_id.localeCompare(right.node_id));
  const body = {
    schema_version: "run-constitution-graph/1.0",
    product_constitution_sha256: PRODUCT_CONSTITUTION_SHA256,
    case_id: String(modelCase?.case_id ?? "unknown"),
    model_demand_graph_sha256: modelDemandGraph.graph_sha256,
    selected_authority_contract_sha256: selectedAuthorityContract.contract_sha256,
    nodes: sortedNodes,
    edges: uniqueEdges,
    counts: {
      nodes: sortedNodes.length,
      edges: uniqueEdges.length,
      selected_paths: selectedAuthorities.length - orphanSelected,
      orphan_selected_authorities: orphanSelected,
    },
  };
  return Object.freeze({ ...body, graph_sha256: digest(body) });
}

export function validateModelDemandGraph(graph) {
  const errors = validateJsonSchema(graph, DEMAND_SCHEMA);
  if (graph?.graph_sha256 !== digest(withoutHash(graph ?? {}, "graph_sha256"))) {
    errors.push("Model-demand graph hash does not bind its complete body.");
  }
  if (graph?.product_constitution_sha256 !== PRODUCT_CONSTITUTION_SHA256) {
    errors.push("Model-demand graph is detached from the product constitution.");
  }
  const ids = (graph?.nodes ?? []).map((node) => node.node_id);
  if (new Set(ids).size !== ids.length) errors.push("Model-demand graph has duplicate node ids.");
  const idSet = new Set(ids);
  for (const edge of graph?.edges ?? []) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) errors.push(`Demand edge ${edge.from} -> ${edge.to} has an absent endpoint.`);
  }
  return { valid: errors.length === 0, errors };
}

export function validateSelectedAuthorityContract(contract, { modelDemandGraph, forecastPlan } = {}) {
  const errors = validateJsonSchema(contract, AUTHORITY_SCHEMA);
  if (contract?.contract_sha256 !== digest(withoutHash(contract ?? {}, "contract_sha256"))) {
    errors.push("Selected-authority contract hash does not bind its complete body.");
  }
  if (contract?.product_constitution_sha256 !== PRODUCT_CONSTITUTION_SHA256) {
    errors.push("Selected-authority contract is detached from the product constitution.");
  }
  if (modelDemandGraph && contract?.model_demand_graph_sha256 !== modelDemandGraph.graph_sha256) {
    errors.push("Selected-authority contract is detached from the model-demand graph.");
  }
  if (forecastPlan && contract?.forecast_plan_sha256 !== digest(forecastPlan)) {
    errors.push("Selected-authority contract is detached from the forecast plan.");
  }
  const demandIds = new Set((modelDemandGraph?.nodes ?? []).map((node) => node.node_id));
  const authorityIds = (contract?.authorities ?? []).map((authority) => authority.node_id);
  if (new Set(authorityIds).size !== authorityIds.length) errors.push("Selected-authority contract has duplicate node writers.");
  if (modelDemandGraph && (authorityIds.length !== demandIds.size || authorityIds.some((id) => !demandIds.has(id)))) {
    errors.push("Selected-authority contract does not cover the exact model-demand node set.");
  }
  for (const authority of contract?.authorities ?? []) {
    const demand = (modelDemandGraph?.nodes ?? []).find(
      (node) => node.node_id === authority.node_id,
    );
    if (demand?.node_kind === "contractual_term") {
      if (authority.selected_state !== null || authority.selected_candidate !== null) {
        errors.push(`${authority.node_id} is contractual and must not carry a forecast state or candidate.`);
      }
      continue;
    }
    if (!authority.selected_state || authority.selected_state.state_id !== authority.node_id) {
      errors.push(`${authority.node_id} does not own its complete resolved forecast state.`);
    }
    if (
      authority.selected_candidate_id !== null &&
      (!authority.selected_candidate ||
        authority.selected_candidate.candidate_id !== authority.selected_candidate_id ||
        authority.selected_candidate.state_id !== authority.node_id)
    ) {
      errors.push(`${authority.node_id} does not own the selected candidate required for materialisation.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateRunConstitutionGraph(graph) {
  const errors = validateJsonSchema(graph, CONSTITUTION_SCHEMA);
  if (graph?.graph_sha256 !== digest(withoutHash(graph ?? {}, "graph_sha256"))) {
    errors.push("Run constitution graph hash does not bind its complete body.");
  }
  if (graph?.product_constitution_sha256 !== PRODUCT_CONSTITUTION_SHA256) {
    errors.push("Run constitution graph is detached from the product constitution.");
  }
  if (graph?.counts?.orphan_selected_authorities !== 0) {
    errors.push("Run constitution graph contains an orphan selected authority.");
  }
  return { valid: errors.length === 0, errors };
}

export function runConstitutionCanonicalJson(value) {
  return canonicalJson(value);
}

export default {
  authorityQualitySummary,
  causalFindingDisposition,
  compileModelDemandGraph,
  compileRunConstitutionGraph,
  compileSelectedAuthorityContract,
  runConstitutionCanonicalJson,
  validateModelDemandGraph,
  validateRunConstitutionGraph,
  validateSelectedAuthorityContract,
};
