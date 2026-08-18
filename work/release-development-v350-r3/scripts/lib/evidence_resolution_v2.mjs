import { createHash } from "node:crypto";
import fs from "node:fs";

import { validateJsonSchema } from "./json_schema.mjs";

const SCHEMA = JSON.parse(
  fs.readFileSync(
    new URL("../../assets/evidence-resolution-v2.schema.json", import.meta.url),
    "utf8",
  ),
);

const SUPPLEMENTAL_DCS_FIELDS = new Set([
  "issue_date",
  "clean_price",
  "dirty_price",
  "price",
  "yield_to_worst",
  "ytw",
  "option_adjusted_spread",
  "oas",
  "cusip",
  "isin",
  "sedol",
]);

const MODEL_DRIVING_DCS_FIELDS = new Set([
  "description",
  "instrument_type",
  "currency",
  "balance_basis",
  "outstanding_amount",
  "native_principal",
  "fx_rate",
  "maturity_date",
  "maturity_precision",
  "maturity_treatment",
  "rate_type",
  "coupon_rate",
  "reference_rate",
  "benchmark_curve",
  "margin_bps",
  "all_in_rate",
  "amortisation_schedule",
  "refinancing_intent",
  "next_call_date",
  "is_backstop_for_paper",
  "facility_limit",
  "drawn_amount",
  "committed",
  "commitment_fee_convention",
  "commitment_fee_value",
]);

const STRUCTURAL_METHODS = new Set([
  "accounting_identity",
  "schedule_link",
  "not_separately_forecast",
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

function safeId(value, fallback = "unknown") {
  const normalized = String(value ?? fallback)
    .normalize("NFKC")
    .trim()
    .replace(/[^A-Za-z0-9_.:/-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validSha(value) {
  return /^[a-f0-9]{64}$/.test(String(value ?? "")) ? value : null;
}

function emptyProvenance(overrides = {}) {
  return {
    document: null,
    page: null,
    table: null,
    row: null,
    column: null,
    cell: null,
    crop_sha256: null,
    ...overrides,
  };
}

function pageFromSourceRef(value) {
  const match = String(value ?? "").match(/(?:#|;)page=(\d+)/i);
  return match ? Number(match[1]) : null;
}

function mappingComponent(component = {}) {
  const sourceRef = typeof component.source_ref === "string"
    ? component.source_ref
    : typeof component.cell_id === "string" ? component.cell_id : null;
  return {
    table: component.table_id ?? null,
    page: component.page ?? pageFromSourceRef(sourceRef),
    row: component.row ?? null,
    column: component.column ?? null,
    cell: component.cell ?? sourceRef,
    source_ref: sourceRef,
    raw_value: component.raw_value === undefined ? null : component.raw_value,
    coefficient: finite(component.coefficient) ? Number(component.coefficient) : null,
    contribution: finite(component.contribution) ? Number(component.contribution) : null,
    crop_sha256: validSha(component.crop_sha256),
  };
}

function brokerMappingIndex(evidenceRun) {
  return new Map(
    (evidenceRun?.broker_crosswalk_receipt?.mappings ?? []).map((mapping) => [
      `${mapping.house_id}\u0000${mapping.metric_id}\u0000${mapping.period_index}`,
      mapping,
    ]),
  );
}

function dcsAuthorityIndex(evidenceRun) {
  const authorities =
    evidenceRun?.case_evidence?.lanes?.dcs?.term_authorities ??
    evidenceRun?.case_evidence?.lanes?.instrument_term_authorities ??
    [];
  return new Map(authorities.map((authority) => [
    `${authority.instrument_id}\u0000${authority.model_field}`,
    authority,
  ]));
}

function sourceLane(kind) {
  const value = String(kind ?? "").toLowerCase();
  if (value.includes("broker")) return "broker";
  if (value.includes("factset") || value.includes("dcs") || value.includes("debt_export")) return "dcs";
  if (value.includes("user_answer") || value.includes("user_input")) return "user";
  if (value.includes("annual") || value.includes("interim") || value.includes("filing") || value.includes("company_")) return "filings";
  return "runtime";
}

function sourceStatus(value) {
  if (value === "used") return "used";
  if (["quarantined", "unavailable"].includes(value)) return value;
  return "supplemental";
}

function compileSourceStore(evidenceRun, laneStates = {}) {
  const sources = new Map();
  for (const source of evidenceRun?.source_inventory ?? []) {
    const sourceId = safeId(source?.source_id);
    sources.set(sourceId, {
      source_id: sourceId,
      lane: sourceLane(source?.kind),
      kind: String(source?.kind ?? "unknown"),
      status: sourceStatus(source?.status),
      sha256: validSha(source?.content_sha256),
      path: null,
    });
  }
  for (const [lane, state] of Object.entries(laneStates ?? {})) {
    for (const [name, path] of Object.entries(state?.artifacts ?? {})) {
      const sourceId = safeId(`${lane}.artifact.${name}`);
      sources.set(sourceId, {
        source_id: sourceId,
        lane: ["filings", "broker", "dcs"].includes(lane) ? lane : "runtime",
        kind: `controller_artifact:${name}`,
        status: state?.pipeline_status === "PASS_DEGRADED" ? "supplemental" : "used",
        sha256: validSha(state?.artifact_sha256?.[name]),
        path: typeof path === "string" ? path : null,
      });
    }
  }
  return [...sources.values()].sort((left, right) =>
    left.source_id.localeCompare(right.source_id));
}

function sourceIndex(sourceStore) {
  return new Map(sourceStore.map((source) => [source.source_id, source]));
}

function findSource(sourceStore, predicate, fallback) {
  return sourceStore.find(predicate) ?? sourceStore.find((entry) => entry.source_id === fallback) ?? null;
}

function brokerGradeConfidence(grade) {
  if (grade === "adjudicated") return 1;
  if (grade === "dual_read") return 0.98;
  if (grade === "native") return 0.92;
  if (grade === "derived") return 0.85;
  return 0.75;
}

function brokerObservations(evidenceRun, sourceStore) {
  const pack = evidenceRun?.broker_pack;
  if (!pack || !Array.isArray(pack?.houses)) return [];
  const periods = pack.forecast_periods ?? [];
  const mappingByValue = brokerMappingIndex(evidenceRun);
  const observations = [];
  for (const house of pack.houses) {
    const documentName = house?.document?.file_name ?? null;
    const source = findSource(
      sourceStore,
      (entry) => entry.lane === "broker" && (
        entry.source_id === safeId(house.house_id) ||
        (documentName && evidenceRun.source_inventory?.some((raw) =>
          safeId(raw.source_id) === entry.source_id && raw.name === documentName))
      ),
      "broker-pack",
    );
    const digestByMetric = new Map((house.digest ?? []).map((entry) => [entry.metric_id, entry]));
    for (const [metricId, values] of Object.entries(house.estimates ?? {})) {
      const declaration = pack.metrics?.[metricId] ?? {};
      const digestEntry = digestByMetric.get(metricId) ?? {};
      for (let index = 0; index < periods.length; index += 1) {
        const value = values?.[index] ?? null;
        const grade = digestEntry.grades?.[index] ?? null;
        const location = digestEntry.source_locations?.[index] ?? digestEntry.source_locations?.[0] ?? null;
        const mapping = mappingByValue.get(`${house.house_id}\u0000${metricId}\u0000${index}`) ?? null;
        const components = (mapping?.components ?? []).map(mappingComponent);
        const available = finite(value);
        observations.push({
          observation_id: safeId(`broker.${house.house_id}.${metricId}.fy${index + 1}`),
          lane: "broker",
          concept_id: safeId(metricId),
          definition_id: safeId(digestEntry.definition_id ?? `broker.${metricId}`),
          period_basis: "annual",
          period_start: null,
          period_end: periods[index] ?? null,
          value: available ? Number(value) : null,
          units: String(declaration.unit_kind ?? pack.units ?? "unknown"),
          sign_convention: String(declaration.sign_convention ?? "model_case"),
          source_id: source?.source_id ?? safeId(`broker.${house.house_id}`),
          source_sha256: source?.sha256 ?? validSha(house.document?.extraction_evidence_sha256),
          confidence: available ? brokerGradeConfidence(grade) : 0,
          status: available ? "verified" : "unavailable",
          model_driving: digestEntry.consumed === true || declaration.tier === 1,
          provenance: emptyProvenance({
            document: documentName,
            page: components[0]?.page ?? house.document?.page_reference ?? null,
            table: components.length === 1 ? components[0].table : mapping?.mapping_id ?? null,
            row: components.length === 1 ? components[0].row : null,
            column: components.length === 1 ? components[0].column : null,
            cell: components.length === 1 ? components[0].cell : location,
            crop_sha256: components.length === 1 ? components[0].crop_sha256 : null,
          }),
          mapping_components: components,
        });
      }
    }
  }
  return observations;
}

function filingObservations(evidenceRun, sourceStore) {
  const filings = evidenceRun?.filings ?? {};
  const periods = filings.historical_periods ?? [];
  const observations = [];
  for (const [section, rows] of [
    ["income_statement", filings.income_statement],
    ["cash_flow", filings.cash_flow],
  ]) {
    for (const row of rows ?? []) {
      const sourceId = safeId(row.source_id ?? "filings");
      const source = sourceStore.find((entry) => entry.source_id === sourceId) ??
        sourceStore.find((entry) => entry.lane === "filings") ?? null;
      for (let index = 0; index < periods.length; index += 1) {
        const value = row.values?.[index];
        if (!finite(value)) continue;
        observations.push({
          observation_id: safeId(`filings.${section}.${row.source_line_id}.h${index + 1}`),
          lane: "filings",
          concept_id: safeId(row.semantic_role ?? row.source_line_id),
          definition_id: safeId(`filed.${section}.${row.source_line_id}`),
          period_basis: "annual",
          period_start: null,
          period_end: periods[index] ?? null,
          value: Number(value),
          units: String(filings.units ?? "unknown"),
          sign_convention: "filed_statement",
          source_id: source?.source_id ?? sourceId,
          source_sha256: source?.sha256 ?? null,
          confidence: 1,
          status: "verified",
          model_driving: row.material !== false,
          provenance: emptyProvenance({
            document: source?.path ?? null,
            page: row.page_or_note ?? null,
            row: row.source_line_id ?? null,
          }),
          mapping_components: [],
        });
      }
    }
  }
  return observations;
}

function dcsObservations(evidenceRun, sourceStore) {
  const dcs = evidenceRun?.dcs_export;
  if (!dcs || !Array.isArray(dcs?.instruments)) return [];
  const source = sourceStore.find((entry) => entry.lane === "dcs") ?? null;
  const authorityByField = dcsAuthorityIndex(evidenceRun);
  const observations = [];
  for (const instrument of dcs.instruments) {
    for (const [field, value] of Object.entries(instrument ?? {})) {
      if (["instrument_id", "source_row"].includes(field) || value === undefined) continue;
      const modelDriving = MODEL_DRIVING_DCS_FIELDS.has(field);
      const supplemental = SUPPLEMENTAL_DCS_FIELDS.has(field) || !modelDriving;
      const authority = authorityByField.get(`${instrument.instrument_id}\u0000${field}`) ?? null;
      const components = (authority?.source_cells ?? []).map((cellId) =>
        mappingComponent({ cell_id: cellId }));
      observations.push({
        observation_id: safeId(`dcs.${instrument.instrument_id}.${field}`),
        lane: "dcs",
        concept_id: safeId(`debt.instrument.${instrument.instrument_id}.${field}`),
        definition_id: safeId(`dcs.${field}`),
        period_basis: field.includes("date") ? "contractual" : "instant",
        period_start: null,
        period_end: dcs.as_of ?? null,
        value: value === null || ["string", "boolean", "number"].includes(typeof value)
          ? value
          : JSON.stringify(canonical(value)),
        units: String(dcs.units ?? "native_or_reporting_basis"),
        sign_convention: "contractual_source",
        source_id: source?.source_id ?? "factset_export",
        source_sha256: source?.sha256 ?? null,
        confidence: 1,
        status: supplemental ? "supplemental" : "verified",
        model_driving: modelDriving,
        provenance: emptyProvenance({ row: instrument.source_row ?? instrument.instrument_id }),
        mapping_components: components,
      });
    }
  }
  return observations;
}

function suppliedForecastObservations(evidenceRun, sourceStore) {
  const sourceById = sourceIndex(sourceStore);
  return (evidenceRun?.forecast_observation_ledger?.observations ?? []).map((record) => {
    const sourceId = safeId(record.source_id);
    const source = sourceById.get(sourceId) ?? null;
    const lane = record.observation_kind === "broker_estimate"
      ? "broker"
      : record.observation_kind === "user_input" ? "user" : "filings";
    return {
      observation_id: safeId(`forecast.${record.observation_id}`),
      lane,
      concept_id: safeId(record.economic_concept_id),
      definition_id: safeId(record.definition_id),
      period_basis: record.period_basis,
      period_start: record.period_start,
      period_end: record.period_end,
      value: record.value,
      units: record.units,
      sign_convention: record.sign_convention,
      source_id: source?.source_id ?? sourceId,
      source_sha256: source?.sha256 ?? null,
      confidence: 1,
      status: "verified",
      model_driving: true,
      provenance: emptyProvenance(),
      mapping_components: [],
    };
  });
}

function uniqueObservations(observations) {
  const byId = new Map();
  for (const observation of observations) {
    const prior = byId.get(observation.observation_id);
    if (!prior) byId.set(observation.observation_id, observation);
    else if (digest(prior) !== digest(observation)) {
      throw new Error(`Observation id ${observation.observation_id} has two incompatible writers.`);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.observation_id.localeCompare(right.observation_id));
}

function compileAuthorityGraph(forecastPlan, observations) {
  const candidatesByState = new Map();
  for (const candidate of forecastPlan?.candidate_ledger ?? []) {
    if (!candidatesByState.has(candidate.state_id)) candidatesByState.set(candidate.state_id, []);
    candidatesByState.get(candidate.state_id).push(candidate);
  }
  const nodes = [];
  const edges = [];
  for (const state of forecastPlan?.states ?? []) {
    const candidates = candidatesByState.get(state.state_id) ?? [];
    const rejected = candidates.filter((candidate) => !candidate.selected);
    const unresolved = state.status !== "RESOLVED" && state.material === true;
    const structural = STRUCTURAL_METHODS.has(state.method);
    const fallback = FALLBACK_METHODS.has(state.method) || rejected.length > 0;
    const nodeState = unresolved
      ? "INPUT_REQUIRED"
      : structural && ["not_separately_forecast", "not_applicable"].includes(state.method)
        ? "NOT_APPLICABLE"
        : fallback ? "FALLBACK" : "RESOLVED";
    const node = {
      node_id: safeId(state.state_id),
      section: String(state.section ?? "unknown"),
      concept_id: safeId(state.row_id),
      period_end: state.period_end ?? null,
      material: state.material === true,
      state: nodeState,
      method: String(state.method ?? "unresolved"),
      selected_candidate_id: state.selected_candidate_id ?? null,
      candidate_ids: candidates.map((candidate) => candidate.candidate_id).sort(),
      fallback_trace: rejected.map((candidate) =>
        `${candidate.candidate_id}:${candidate.rejection_reason ?? "not_selected"}`),
      source_bindings: [...new Set(state.source_bindings ?? [])].sort(),
    };
    nodes.push(node);
    for (const candidate of candidates) {
      edges.push({ from: safeId(candidate.candidate_id), to: node.node_id, kind: "candidate_for" });
      if (candidate.selected) {
        edges.push({ from: safeId(candidate.candidate_id), to: node.node_id, kind: "selected_for" });
      } else {
        edges.push({ from: safeId(candidate.candidate_id), to: node.node_id, kind: "fallback_from" });
      }
    }
    for (const source of node.source_bindings) {
      edges.push({ from: safeId(`source.${source}`), to: node.node_id, kind: "source_for" });
    }
  }

  // Contractual DCS terms are selected authorities without being forecast
  // writers. Keeping them in the same graph makes debt terms and forecast
  // choices auditable without pretending a price/YTW/OAS field drives cash.
  for (const observation of observations.filter((entry) =>
    entry.lane === "dcs" && entry.model_driving && entry.status === "verified")) {
    const nodeId = safeId(`authority.${observation.concept_id}`);
    nodes.push({
      node_id: nodeId,
      section: "debt_schedule",
      concept_id: observation.concept_id,
      period_end: observation.period_end,
      material: true,
      state: "RESOLVED",
      method: "contractual_source",
      selected_candidate_id: observation.observation_id,
      candidate_ids: [observation.observation_id],
      fallback_trace: [],
      source_bindings: [observation.source_id],
    });
    edges.push({ from: observation.observation_id, to: nodeId, kind: "selected_for" });
    edges.push({ from: safeId(`source.${observation.source_id}`), to: nodeId, kind: "source_for" });
  }

  nodes.sort((left, right) => left.node_id.localeCompare(right.node_id));
  edges.sort((left, right) =>
    left.to.localeCompare(right.to) || left.from.localeCompare(right.from) || left.kind.localeCompare(right.kind));
  return {
    nodes,
    edges,
    unresolved_material_count: nodes.filter((node) => node.state === "INPUT_REQUIRED" && node.material).length,
  };
}

function quarantinesFrom(observations, laneStates) {
  const quarantines = observations
    .filter((entry) => ["quarantined", "unavailable"].includes(entry.status))
    .map((entry) => ({
      quarantine_id: safeId(`quarantine.${entry.observation_id}`),
      lane: entry.lane,
      scope: entry.observation_id,
      reason: entry.status === "unavailable"
        ? "The source did not provide a verified value for this concept and period."
        : "The source region was preserved but prohibited from model use.",
      model_use: "prohibited",
      source_bindings: [entry.source_id],
    }));
  for (const [lane, state] of Object.entries(laneStates ?? {})) {
    if (state?.pipeline_status !== "PASS_DEGRADED") continue;
    quarantines.push({
      quarantine_id: safeId(`quarantine.${lane}.degraded_close`),
      lane,
      scope: "controller_degraded_close",
      reason: "The bounded lane closed with preserved, model-prohibited evidence regions.",
      model_use: "prohibited",
      source_bindings: Object.keys(state.artifacts ?? {}).map((name) => safeId(`${lane}.artifact.${name}`)).sort(),
    });
  }
  return quarantines.sort((left, right) => left.quarantine_id.localeCompare(right.quarantine_id));
}

function findingsFrom({ authorityGraph, laneStates, caseCompileReport, quarantines, sourceStore, observations }) {
  const findings = [];
  const sourceById = sourceIndex(sourceStore);
  for (const source of sourceStore) {
    if (source.status !== "used" || source.sha256) continue;
    const internalArtifact = source.kind.startsWith("controller_artifact:");
    findings.push({
      finding_id: safeId(`${internalArtifact ? "internal" : "fatal"}.source_hash.${source.source_id}`),
      owner: internalArtifact ? "INTERNAL_WORK" : "FATAL_SOURCE",
      severity: "BLOCK",
      message: internalArtifact
        ? `Controller artifact ${source.source_id} has no immutable content hash.`
        : `Used source ${source.source_id} has no immutable content hash.`,
      affected_nodes: [],
    });
  }
  for (const observation of observations) {
    const source = sourceById.get(observation.source_id);
    if (source && (!observation.source_sha256 || observation.source_sha256 === source.sha256)) continue;
    findings.push({
      finding_id: safeId(`internal.observation_source.${observation.observation_id}`),
      owner: "INTERNAL_WORK",
      severity: "BLOCK",
      message: source
        ? `Observation ${observation.observation_id} does not bind its source-store hash.`
        : `Observation ${observation.observation_id} references absent source ${observation.source_id}.`,
      affected_nodes: [],
    });
  }
  for (const [lane, state] of Object.entries(laneStates ?? {})) {
    if (["PASS", "PASS_DEGRADED"].includes(state?.pipeline_status)) {
      if (state.pipeline_status === "PASS_DEGRADED") {
        findings.push({
          finding_id: safeId(`quality.${lane}.degraded`),
          owner: "QUALITY",
          severity: "WARN",
          message: `${lane} evidence closed in degraded mode; quarantined evidence is preserved and excluded from model use.`,
          affected_nodes: [],
        });
      }
      continue;
    }
    const fatal = state?.blocker_class === "FATAL_SOURCE" || state?.user_blocking === true;
    findings.push({
      finding_id: safeId(`${fatal ? "fatal" : "internal"}.${lane}.${state?.pipeline_status ?? "unknown"}`),
      owner: fatal ? "FATAL_SOURCE" : "INTERNAL_WORK",
      severity: "BLOCK",
      message: state?.summary?.message ?? `${lane} lane is not closed.`,
      affected_nodes: [],
    });
  }
  for (const node of authorityGraph.nodes.filter((entry) => entry.state === "INPUT_REQUIRED" && entry.material)) {
    findings.push({
      finding_id: safeId(`decision.${node.node_id}`),
      owner: "USER_DECISION",
      severity: "BLOCK",
      message: `${node.concept_id} for ${node.period_end ?? "the required period"} remains material and unresolved after the complete authority waterfall.`,
      affected_nodes: [node.node_id],
    });
  }
  for (const finding of caseCompileReport?.findings ?? []) {
    if (finding.severity !== "BLOCK") continue;
    const sourceFault = /(?:source|hash|entity|period|opening_debt|reconciliation)/i.test(finding.id ?? "");
    findings.push({
      finding_id: safeId(`case_compile.${finding.id}`),
      owner: sourceFault ? "FATAL_SOURCE" : "INTERNAL_WORK",
      severity: "BLOCK",
      message: finding.message ?? "The case compiler reported a blocking finding.",
      affected_nodes: [],
    });
  }
  if (quarantines.length > 0 && findings.every((finding) => finding.owner !== "QUALITY")) {
    findings.push({
      finding_id: "quality.quarantined_evidence",
      owner: "QUALITY",
      severity: "WARN",
      message: "Optional or unavailable evidence was preserved outside model authority.",
      affected_nodes: [],
    });
  }
  return findings.sort((left, right) => left.finding_id.localeCompare(right.finding_id));
}

function outcome(findings, authorityGraph, quarantines) {
  if (findings.some((finding) => finding.owner === "FATAL_SOURCE" && finding.severity === "BLOCK")) {
    return { status: "BLOCKED", quality_mode: "FATAL", blocker_class: "FATAL_SOURCE", user_blocking: true };
  }
  if (findings.some((finding) => finding.owner === "INTERNAL_WORK" && finding.severity === "BLOCK")) {
    return { status: "NEEDS_INTERNAL_WORK", quality_mode: "INTERNAL_WORK", blocker_class: "INTERNAL_WORK", user_blocking: false };
  }
  if (authorityGraph.unresolved_material_count > 0) {
    return { status: "ACTION_REQUIRED", quality_mode: "INPUT_REQUIRED", blocker_class: "USER_DECISION", user_blocking: true };
  }
  const degraded = quarantines.length > 0 || findings.some((finding) => finding.severity === "WARN");
  return degraded
    ? { status: "PASS_DEGRADED", quality_mode: "DEGRADED", blocker_class: null, user_blocking: false }
    : { status: "PASS", quality_mode: "VERIFIED", blocker_class: null, user_blocking: false };
}

export function compileEvidenceResolutionV2({
  evidenceRun,
  forecastPlan = null,
  laneStates = {},
  caseCompileReport = null,
}) {
  if (!evidenceRun || evidenceRun.schema_version !== "evidence-run/1.0") {
    throw new Error("Evidence resolution v2 requires one evidence-run/1.0 input.");
  }
  const sourceStore = compileSourceStore(evidenceRun, laneStates);
  const observations = uniqueObservations([
    ...filingObservations(evidenceRun, sourceStore),
    ...brokerObservations(evidenceRun, sourceStore),
    ...dcsObservations(evidenceRun, sourceStore),
    ...suppliedForecastObservations(evidenceRun, sourceStore),
  ]);
  const authorityGraph = compileAuthorityGraph(forecastPlan, observations);
  const quarantines = quarantinesFrom(observations, laneStates);
  const findings = findingsFrom({
    authorityGraph,
    laneStates,
    caseCompileReport,
    quarantines,
    sourceStore,
    observations,
  });
  const selectedAuthorityCount = authorityGraph.nodes.filter((node) => node.selected_candidate_id !== null).length;
  const fallbackCount = authorityGraph.nodes.filter((node) => node.state === "FALLBACK").length;
  const result = outcome(findings, authorityGraph, quarantines);
  const body = {
    schema_version: "evidence-resolution/2.0",
    run_id: safeId(evidenceRun.run_id ?? "run"),
    input_bindings: {
      evidence_run_sha256: digest(evidenceRun),
      forecast_plan_sha256: forecastPlan ? digest(forecastPlan) : null,
      case_compile_report_sha256: caseCompileReport ? digest(caseCompileReport) : null,
      lane_states_sha256: digest(laneStates ?? {}),
    },
    source_snapshot_sha256: digest(sourceStore),
    ...result,
    source_store: sourceStore,
    observations,
    authority_graph: authorityGraph,
    quarantines,
    findings,
  };
  const receipt = {
    schema_version: "evidence-resolution-receipt/2.0",
    resolution_sha256: digest(body),
    source_count: sourceStore.length,
    observation_count: observations.length,
    authority_node_count: authorityGraph.nodes.length,
    selected_authority_count: selectedAuthorityCount,
    quarantine_count: quarantines.length,
    fallback_count: fallbackCount,
    finding_count: findings.length,
    quality_mode: result.quality_mode,
  };
  const resolution = { ...body, receipt };
  const validation = validateEvidenceResolutionV2(resolution, {
    evidenceRun,
    forecastPlan,
    laneStates,
    caseCompileReport,
  });
  if (!validation.ok) {
    throw new Error(`Evidence resolution v2 failed validation: ${validation.errors[0]}`);
  }
  return resolution;
}

export function validateEvidenceResolutionV2(
  resolution,
  { evidenceRun, forecastPlan = null, laneStates = {}, caseCompileReport = null } = {},
) {
  const errors = validateJsonSchema(resolution, SCHEMA);
  if (errors.length === 0) {
    const { receipt, ...body } = resolution;
    if (receipt.resolution_sha256 !== digest(body)) {
      errors.push("$.receipt.resolution_sha256 does not bind the complete resolution body.");
    }
    if (resolution.source_snapshot_sha256 !== digest(resolution.source_store)) {
      errors.push("$.source_snapshot_sha256 does not bind the source store.");
    }
    if (receipt.source_count !== resolution.source_store.length) errors.push("$.receipt.source_count is stale.");
    if (receipt.observation_count !== resolution.observations.length) errors.push("$.receipt.observation_count is stale.");
    if (receipt.authority_node_count !== resolution.authority_graph.nodes.length) errors.push("$.receipt.authority_node_count is stale.");
    if (receipt.quarantine_count !== resolution.quarantines.length) errors.push("$.receipt.quarantine_count is stale.");
    if (receipt.finding_count !== resolution.findings.length) errors.push("$.receipt.finding_count is stale.");
    const selectedCount = resolution.authority_graph.nodes.filter(
      (node) => node.selected_candidate_id !== null).length;
    const fallbackCount = resolution.authority_graph.nodes.filter(
      (node) => node.state === "FALLBACK").length;
    const unresolvedCount = resolution.authority_graph.nodes.filter(
      (node) => node.state === "INPUT_REQUIRED" && node.material).length;
    if (receipt.selected_authority_count !== selectedCount) {
      errors.push("$.receipt.selected_authority_count is stale.");
    }
    if (receipt.fallback_count !== fallbackCount) errors.push("$.receipt.fallback_count is stale.");
    if (receipt.quality_mode !== resolution.quality_mode) errors.push("$.receipt.quality_mode disagrees with the resolution.");
    if (resolution.authority_graph.unresolved_material_count !== unresolvedCount) {
      errors.push("$.authority_graph.unresolved_material_count is stale.");
    }

    const unique = (values) => new Set(values).size === values.length;
    if (!unique(resolution.source_store.map((source) => source.source_id))) {
      errors.push("$.source_store has duplicate source_id values.");
    }
    if (!unique(resolution.observations.map((observation) => observation.observation_id))) {
      errors.push("$.observations has duplicate observation_id values.");
    }
    if (!unique(resolution.authority_graph.nodes.map((node) => node.node_id))) {
      errors.push("$.authority_graph.nodes has duplicate node_id values.");
    }
    const edgeKeys = resolution.authority_graph.edges.map(
      (edge) => `${edge.from}\u0000${edge.to}\u0000${edge.kind}`);
    if (!unique(edgeKeys)) errors.push("$.authority_graph.edges has duplicate edges.");

    const sourceById = sourceIndex(resolution.source_store);
    for (const observation of resolution.observations) {
      const source = sourceById.get(observation.source_id);
      if (!source) {
        errors.push(`Observation ${observation.observation_id} references absent source ${observation.source_id}.`);
      } else if (observation.source_sha256 && observation.source_sha256 !== source.sha256) {
        errors.push(`Observation ${observation.observation_id} source hash disagrees with ${observation.source_id}.`);
      }
    }
    const nodeById = new Map(resolution.authority_graph.nodes.map((node) => [node.node_id, node]));
    const observationIds = new Set(resolution.observations.map((entry) => entry.observation_id));
    for (const edge of resolution.authority_graph.edges) {
      const node = nodeById.get(edge.to);
      if (!node) {
        errors.push(`Authority edge targets absent node ${edge.to}.`);
        continue;
      }
      if (["candidate_for", "fallback_from"].includes(edge.kind) && !node.candidate_ids.includes(edge.from)) {
        errors.push(`Authority edge ${edge.kind} uses undeclared candidate ${edge.from}.`);
      }
      if (edge.kind === "selected_for" &&
          edge.from !== node.selected_candidate_id &&
          !observationIds.has(edge.from)) {
        errors.push(`Selected edge ${edge.from} does not match node ${edge.to}.`);
      }
      if (edge.kind === "source_for") {
        const sourceId = edge.from.replace(/^source\./, "");
        if (!edge.from.startsWith("source.") || !sourceById.has(sourceId)) {
          errors.push(`Authority edge references absent source ${edge.from}.`);
        }
      }
    }
    for (const node of resolution.authority_graph.nodes) {
      if (node.selected_candidate_id !== null &&
          !node.candidate_ids.includes(node.selected_candidate_id)) {
        errors.push(`Authority node ${node.node_id} selects an undeclared candidate.`);
      }
    }

    if (evidenceRun && resolution.input_bindings.evidence_run_sha256 !== digest(evidenceRun)) {
      errors.push("$.input_bindings.evidence_run_sha256 does not bind the supplied evidence run.");
    }
    if (evidenceRun && resolution.input_bindings.forecast_plan_sha256 !==
        (forecastPlan ? digest(forecastPlan) : null)) {
      errors.push("$.input_bindings.forecast_plan_sha256 does not bind the supplied forecast plan.");
    }
    if (evidenceRun && resolution.input_bindings.case_compile_report_sha256 !==
        (caseCompileReport ? digest(caseCompileReport) : null)) {
      errors.push("$.input_bindings.case_compile_report_sha256 does not bind the supplied case report.");
    }
    if (evidenceRun && resolution.input_bindings.lane_states_sha256 !== digest(laneStates ?? {})) {
      errors.push("$.input_bindings.lane_states_sha256 does not bind the supplied lane states.");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function evidenceResolutionCanonicalJson(resolution) {
  return canonicalJson(resolution);
}

export default {
  compileEvidenceResolutionV2,
  evidenceResolutionCanonicalJson,
  validateEvidenceResolutionV2,
};
