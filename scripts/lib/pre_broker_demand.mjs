import { createHash } from "node:crypto";

export const CANONICAL_PRE_BROKER_DEMAND_VERSION =
  "canonical-pre-broker-demand/1.0";

const SUPPORTED_SOURCE_VERSIONS = new Set([
  "pre-broker-model-demand/1.0",
  "pre-broker-model-demand/2.0",
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

function digest(value) {
  return createHash("sha256")
    .update(`${JSON.stringify(canonical(value))}\n`)
    .digest("hex");
}

/** Normalize both public demand contracts to one runtime-owned node shape. */
export function normalizePreBrokerDemand(graph) {
  if (!graph || typeof graph !== "object") {
    throw new Error("Pre-broker demand graph is absent.");
  }
  if (!SUPPORTED_SOURCE_VERSIONS.has(graph.schema_version)) {
    throw new Error(`Unsupported pre-broker demand version ${graph.schema_version ?? "<missing>"}.`);
  }
  const body = Object.fromEntries(
    Object.entries(graph).filter(([key]) => key !== "graph_sha256"),
  );
  if (graph.graph_sha256 !== digest(body)) {
    throw new Error("Pre-broker demand has a stale canonical graph hash.");
  }
  const forecastPeriods = [...(graph.forecast_periods ?? [])];
  if (forecastPeriods.length !== 3) {
    throw new Error("Pre-broker demand requires exactly three forecast periods.");
  }
  const v2 = graph.schema_version === "pre-broker-model-demand/2.0";
  const nodes = (graph.nodes ?? []).map((node) => {
    const sourceLineId = node.source_line_id ?? null;
    const allowedAuthorities = [...(node.allowed_authorities ?? [])];
    return {
      node_id: String(node.node_id ?? ""),
      node_kind: v2 ? String(node.node_kind ?? "model_demand") : "filed_observation",
      section: String(node.section ?? ""),
      source_line_ids: sourceLineId ? [String(sourceLineId)] : [],
      metric_id: v2 && node.metric_id ? String(node.metric_id) : null,
      label: String(node.label ?? ""),
      period_end: String(node.period_end ?? ""),
      material: node.material !== false,
      broker_demand_eligible: v2
        ? node.broker_demand_eligible === true
        : allowedAuthorities.includes("selected_broker"),
      allowed_authorities: allowedAuthorities,
      definition_signature_sha256:
        String(node.definition_signature_sha256 ?? ""),
      consumer_ids: v2
        ? [...(node.consumer_ids ?? [])].map(String).sort()
        : [],
    };
  }).sort((left, right) => left.node_id.localeCompare(right.node_id));
  return Object.freeze({
    schema_version: CANONICAL_PRE_BROKER_DEMAND_VERSION,
    source_schema_version: graph.schema_version,
    source_graph_sha256: graph.graph_sha256,
    run_id: String(graph.run_id ?? ""),
    forecast_periods: forecastPeriods,
    reporting_currency: String(graph.reporting_currency ?? ""),
    units: String(graph.units ?? ""),
    nodes,
  });
}
