import { canonicalJsonSha256, EQUATION_GRAPH } from "./equation_graph.mjs";
import { resolveForecastAuthority } from "./forecast_authority.mjs";
import { hashValue } from "./run_store.mjs";

export const LAYERED_GRAPH_CONSTITUTION_VERSION =
  "layered-graph-constitution/1.1";

export const ROW_PLAN_PROJECTION_SCOPE =
  "statement-row-projection/1.0";

const STATEMENT_SECTIONS = Object.freeze(["income_statement", "cash_flow"]);

function portableCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

function sorted(values, key = (value) => value.id) {
  return [...values].sort((left, right) => portableCompare(key(left), key(right)));
}

function stablePart(value) {
  return encodeURIComponent(String(value ?? ""));
}

export function stableLayerNodeId(layer, ...parts) {
  return [layer, ...parts.map(stablePart)].join(":");
}

function finding(code, message, context = {}) {
  return { code, message, ...context };
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return sorted(duplicates, (value) => value);
}

const FORMULA_AUTHORITY_METHODS = new Set([
  "accounting_identity",
  "driver_formula",
  "roll_forward",
  "historical_average",
  "historical_trend",
  "seasonal_run_rate",
  "carry_forward",
  "schedule_link",
  "actual_plus_remainder",
  "full_year_authority_less_reported",
]);

function periodFormulaRefs(row) {
  const authorities = row.forecast_period_authorities ?? [];
  return (row.forecast_period_calculations ?? []).flatMap((calculation, index) => {
    const authority = authorities[index];
    if (
      authority &&
      !FORMULA_AUTHORITY_METHODS.has(authority.method) &&
      authority.source_kind !== "formula" &&
      authority.source_kind !== "schedule"
    ) {
      return [];
    }
    return calculation?.refs ?? [];
  });
}

export function canonicalStatementDependencies(row) {
  const hasFormulaAuthority = (row.forecast_period_authorities ?? [])
    .filter(Boolean)
    .some(
      (authority) =>
        FORMULA_AUTHORITY_METHODS.has(authority.method) ||
        authority.source_kind === "formula" ||
        authority.source_kind === "schedule",
    );
  const declared = [...new Set([
    ...(row.dependency_refs ?? []),
    ...(row.calculation?.refs ?? []),
    ...(hasFormulaAuthority ? row.forecast_calculation?.refs ?? [] : []),
    ...periodFormulaRefs(row),
  ])].sort(portableCompare);
  if (
    declared.length === 0 &&
    (row.semantic_role === "ending_cash" || row.row_id === "ending_cash")
  ) {
    return ["fx_effect_on_cash", "net_change_in_cash", "opening_cash"];
  }
  if (
    declared.length === 0 &&
    (row.semantic_role === "opening_cash" || row.row_id === "opening_cash")
  ) {
    return ["ending_cash"];
  }
  return declared;
}

/**
 * Dependencies that the forecast workbook must physically emit.
 *
 * Historical calculations remain part of the source/statement constitution,
 * but a forecast-specific formula or direct forecast authority supersedes
 * them in J:L. Unioning both graphs manufactured false forecast paths (for
 * example a formula-derived EBIT forecast was still declared dependent on
 * every historical operating component).
 */
export function canonicalForecastStatementDependencies(row) {
  const periodRules = (row.forecast_period_calculations ?? []).filter(Boolean);
  if (periodRules.length > 0) {
    // Historical inference formulas read G:I directly. Their row-id ref is
    // provenance for the historical observation series, not a dependency on
    // the prior forecast cell. Treating it as a forecast self-edge made the
    // physical oracle demand K->J and L->K paths that the deliberately
    // anchored G:I formula must not contain.
    const forecastRefs = periodRules.flatMap((rule) =>
      ["historical_average", "historical_trend"].includes(rule?.operator)
        ? []
        : rule?.refs ?? [],
    );
    return [...new Set(forecastRefs)]
      .sort(portableCompare);
  }
  if (row.forecast_calculation) {
    return [...new Set(row.forecast_calculation.refs ?? [])].sort(portableCompare);
  }
  const declaredFormulaAuthority = (row.forecast_period_authorities ?? [])
    .filter(Boolean)
    .some((authority) =>
      ["accounting_identity", "driver_formula", "roll_forward"].includes(
        authority.method,
      ) || authority.source_kind === "formula",
    );
  if (
    ["broker", "hardcode", "zero", "uncalculated"].includes(
      row.forecast_treatment,
    ) && !declaredFormulaAuthority ||
    row.forecast_capture_parent_id
  ) {
    return [];
  }
  const declared = [...new Set([
    ...(row.calculation?.refs ?? []),
  ])].sort(portableCompare);
  if (
    declared.length === 0 &&
    (row.semantic_role === "ending_cash" || row.row_id === "ending_cash")
  ) {
    return ["fx_effect_on_cash", "net_change_in_cash", "opening_cash"];
  }
  if (
    declared.length === 0 &&
    (row.semantic_role === "opening_cash" || row.row_id === "opening_cash")
  ) {
    return ["ending_cash"];
  }
  return declared;
}

export function rowPlanConstitutionProjection(rowPlan) {
  return {
    scope: ROW_PLAN_PROJECTION_SCOPE,
    statement_rows: rowPlan.statement_rows ?? {},
  };
}

function historicalWriter(row) {
  const authority = row.historical_authority ?? null;
  if (authority) return authority;
  if (row.row_type === "header") return "presentation_only";
  if (row.calculation) return "derived_formula";
  if (
    row.semantic_role === "non_balancing_cash_bucket_movement" ||
    row.row_id === "non_balancing_cash_bucket_movement"
  ) {
    // This compiler-owned reconciliation is generated from the visible cash
    // bucket roll-forward in historical columns.  It intentionally has no
    // source-row calculation refs, but it still has one deterministic writer.
    return "compiler_semantic_formula";
  }
  if (row.row_type === "uncalculated") return "not_applicable";
  if (row.row_type === "input") return "source_input";
  if (
    (row.values ?? [])
      .slice(0, 3)
      .some((value) =>
        value !== null &&
        value !== undefined &&
        Number.isFinite(Number(value)),
      )
  ) {
    // A filed subtotal remains source-owned even when its presentation row
    // type is `subtotal` rather than `input` (for example a reported working-
    // capital parent with optional supporting children).
    return "source_input";
  }
  return null;
}

function layer(layerId, nodes, edges = []) {
  const value = {
    layer_id: layerId,
    nodes: sorted(nodes),
    edges: sorted(edges, (edge) => edge.id),
  };
  return { ...value, graph_sha256: hashValue(value) };
}

function canonicalStatementRows(modelCase, rowPlan) {
  return Object.fromEntries(STATEMENT_SECTIONS.map((section) => {
    const projected = rowPlan.statement_rows?.[section] ?? [];
    const projectedIds = new Set(projected.map((row) => row.row_id));
    return [section, [
      ...projected,
      ...(modelCase.statement_structure?.[section] ?? []).filter(
        (row) => !projectedIds.has(row.row_id),
      ),
    ]];
  }));
}

function statementIndex(statementRows) {
  const bySection = new Map();
  const global = new Map();
  for (const section of STATEMENT_SECTIONS) {
    const local = new Map();
    for (const row of statementRows[section] ?? []) {
      const list = local.get(row.row_id) ?? [];
      list.push(row);
      local.set(row.row_id, list);
      const globalList = global.get(row.row_id) ?? [];
      globalList.push({ section, row });
      global.set(row.row_id, globalList);
    }
    bySection.set(section, local);
  }
  return { bySection, global };
}

function resolveStatementReference(index, fromSection, reference) {
  const local = index.bySection.get(fromSection)?.get(reference) ?? [];
  if (local.length === 1) return { section: fromSection, row: local[0], cross_section: false };
  if (local.length > 1) return { ambiguous: true, matches: local.length };
  const global = index.global.get(reference) ?? [];
  if (global.length !== 1) return {
    ambiguous: global.length > 1,
    orphan: global.length === 0,
    matches: global.length,
  };
  return { ...global[0], cross_section: global[0].section !== fromSection };
}

function validateSourceStatementClosure(modelCase, violations) {
  const sourceRows = Object.fromEntries(
    STATEMENT_SECTIONS.map((section) => [
      section,
      modelCase.statement_structure?.[section] ?? [],
    ]),
  );
  const index = statementIndex(sourceRows);
  for (const section of STATEMENT_SECTIONS) {
    for (const row of sourceRows[section]) {
      for (const reference of canonicalStatementDependencies(row)) {
        const resolved = resolveStatementReference(index, section, reference);
        if (!resolved.row) {
          violations.push(finding(
            resolved.ambiguous ? "STATEMENT_AMBIGUOUS_DEPENDENCY" : "STATEMENT_ORPHAN_DEPENDENCY",
            `${section}.${row.row_id} cannot resolve source dependency ${reference} uniquely.`,
            { section, row_id: row.row_id, reference, matches: resolved.matches ?? 0 },
          ));
        } else if (
          resolved.cross_section &&
          !(section === "cash_flow" && resolved.section === "income_statement")
        ) {
          violations.push(finding(
            "STATEMENT_ILLEGAL_CROSS_SECTION_DEPENDENCY",
            `${section}.${row.row_id} has an illegal source cross-section dependency on ${resolved.section}.${reference}.`,
            { section, row_id: row.row_id, target_section: resolved.section, reference },
          ));
        }
      }
      for (const [edgeType, parentId] of [
        ["presentation_parent", row.parent_row_id],
        ["forecast_capture", row.forecast_capture_parent_id],
      ]) {
        if (!parentId) continue;
        const parents = index.bySection.get(section)?.get(parentId) ?? [];
        if (parents.length !== 1) {
          violations.push(finding(
            "STATEMENT_CROSS_SECTION_OR_ORPHAN_PARENT",
            `${section}.${row.row_id} source ${edgeType} ${parentId} is not one unique section-local row.`,
            { section, row_id: row.row_id, parent_row_id: parentId, edge_type: edgeType },
          ));
        }
      }
    }
  }
}

function compileEvidenceLayer(modelCase, statementNodeIds, violations) {
  const nodes = [];
  const edges = [];
  const occurrences = new Map();
  for (const section of STATEMENT_SECTIONS) {
    for (const source of modelCase.source_coverage?.[section] ?? []) {
      const key = `${section}\u0000${source.source_line_id ?? ""}`;
      const ordinal = occurrences.get(key) ?? 0;
      occurrences.set(key, ordinal + 1);
      if (!source.source_line_id || ordinal > 0) {
        violations.push(finding(
          "EVIDENCE_INVALID_STABLE_ID",
          source.source_line_id
            ? `${section} duplicates source line ${source.source_line_id}.`
            : `${section} contains a source line without an ID.`,
          { section, source_line_id: source.source_line_id ?? null },
        ));
      }
      const id = stableLayerNodeId("evidence", section, source.source_line_id, ordinal);
      nodes.push({
        id,
        section,
        source_line_id: source.source_line_id,
        material: source.material === true,
        disposition: source.disposition ?? null,
        writer: "sealed_source",
      });
      for (const rowId of source.mapped_row_ids ?? []) {
        const target = statementNodeIds.get(`${section}\u0000${rowId}`);
        if (!target) {
          violations.push(finding(
            "EVIDENCE_ORPHAN_DESTINATION",
            `${source.source_line_id} maps to missing ${section} row ${rowId}.`,
            { section, source_line_id: source.source_line_id, row_id: rowId },
          ));
          continue;
        }
        edges.push({
          id: stableLayerNodeId("edge", "evidence_supplies", section, source.source_line_id, ordinal, rowId),
          type: "supplies",
          from: id,
          to: target,
        });
      }
    }
  }
  return layer("evidence", nodes, edges);
}

function compileStatementLayer(modelCase, statementRows, violations) {
  const nodes = [];
  const edges = [];
  const index = statementIndex(statementRows);
  const nodeIds = new Map();
  for (const section of STATEMENT_SECTIONS) {
    for (const duplicate of duplicateValues(
      (modelCase.statement_structure?.[section] ?? []).map((row) => row.row_id),
    )) {
      violations.push(finding(
        "STATEMENT_DUPLICATE_STABLE_ID",
        `${section} contains more than one source row with id ${duplicate}.`,
        { section, row_id: duplicate },
      ));
    }
    for (const [rowId, matches] of index.bySection.get(section)) {
      if (matches.length !== 1) {
        violations.push(finding(
          "STATEMENT_DUPLICATE_STABLE_ID",
          `${section} contains ${matches.length} rows with id ${rowId}.`,
          { section, row_id: rowId },
        ));
      }
      matches.forEach((row, ordinal) => {
        const id = stableLayerNodeId("statement", section, rowId, ordinal);
        if (ordinal === 0) nodeIds.set(`${section}\u0000${rowId}`, id);
        const writer = historicalWriter(row);
        if (!writer) {
          violations.push(finding(
            "STATEMENT_MISSING_HISTORICAL_WRITER",
            `${section}.${rowId} has no historical writer.`,
            { section, row_id: rowId },
          ));
        }
        nodes.push({
          id,
          section,
          row_id: rowId,
          semantic_role: row.semantic_role ?? null,
          row_type: row.row_type,
          historical_writer: writer,
          source_line_ids: [...new Set(row.source_line_ids ?? [])].sort(portableCompare),
        });
      });
    }
  }

  for (const section of STATEMENT_SECTIONS) {
    const edgeRowsSeen = new Set();
    for (const row of statementRows[section] ?? []) {
      if (edgeRowsSeen.has(row.row_id)) continue;
      edgeRowsSeen.add(row.row_id);
      const from = nodeIds.get(`${section}\u0000${row.row_id}`);
      // The persisted statement layer describes the physical forecast graph.
      // Historical/source identities are validated separately above by
      // `validateSourceStatementClosure`; unioning them back here creates
      // dependencies that intentionally blank or directly forecast rows do
      // not emit in J:L.
      for (const reference of canonicalForecastStatementDependencies(row)) {
        const resolved = resolveStatementReference(index, section, reference);
        if (!resolved.row) {
          violations.push(finding(
            resolved.ambiguous ? "STATEMENT_AMBIGUOUS_DEPENDENCY" : "STATEMENT_ORPHAN_DEPENDENCY",
            `${section}.${row.row_id} cannot resolve dependency ${reference} uniquely.`,
            { section, row_id: row.row_id, reference, matches: resolved.matches ?? 0 },
          ));
          continue;
        }
        // Cross-statement flows are one-way: the cash-flow bridge may consume
        // income-statement conclusions. An income-statement formula may never
        // reach down into cash flow, and parent/capture edges are always local.
        if (
          resolved.cross_section &&
          !(section === "cash_flow" && resolved.section === "income_statement")
        ) {
          violations.push(finding(
            "STATEMENT_ILLEGAL_CROSS_SECTION_DEPENDENCY",
            `${section}.${row.row_id} has an illegal cross-section dependency on ${resolved.section}.${reference}.`,
            { section, row_id: row.row_id, target_section: resolved.section, reference },
          ));
          continue;
        }
        edges.push({
          id: stableLayerNodeId("edge", "statement_dependency", section, row.row_id, resolved.section, reference),
          type: resolved.cross_section ? "cross_section_dependency" : "depends_on",
          from,
          to: nodeIds.get(`${resolved.section}\u0000${reference}`),
        });
      }
      for (const [edgeType, parentId] of [
        ["presentation_parent", row.parent_row_id],
        ["forecast_capture", row.forecast_capture_parent_id],
      ]) {
        if (!parentId) continue;
        const parent = index.bySection.get(section)?.get(parentId) ?? [];
        if (parent.length !== 1) {
          violations.push(finding(
            "STATEMENT_CROSS_SECTION_OR_ORPHAN_PARENT",
            `${section}.${row.row_id} ${edgeType} ${parentId} is not one unique section-local row.`,
            { section, row_id: row.row_id, parent_row_id: parentId, edge_type: edgeType },
          ));
          continue;
        }
        edges.push({
          id: stableLayerNodeId("edge", edgeType, section, row.row_id, parentId),
          type: edgeType,
          from,
          to: nodeIds.get(`${section}\u0000${parentId}`),
        });
      }
    }
  }
  return { graph: layer("statement", nodes, edges), nodeIds };
}

function compileForecastLayer(modelCase, statementRows, statementNodeIds, violations) {
  const nodes = [];
  const edges = [];
  const writerClaims = [];
  for (const section of STATEMENT_SECTIONS) {
    const seenRows = new Set();
    for (const row of statementRows[section] ?? []) {
      if (seenRows.has(row.row_id)) continue;
      seenRows.add(row.row_id);
      if (row.row_type === "header") continue;
      const statementId = statementNodeIds.get(`${section}\u0000${row.row_id}`);
      for (let forecastIndex = 0; forecastIndex < 3; forecastIndex += 1) {
        const authority = resolveForecastAuthority(modelCase, row, forecastIndex);
        const id = stableLayerNodeId("forecast", section, row.row_id, forecastIndex);
        const writer = authority.method === "unresolved" || authority.mechanism === "block"
          ? null
          : `${authority.mechanism}:${authority.method}`;
        if (!writer) {
          violations.push(finding(
            "FORECAST_MISSING_WRITER",
            `${section}.${row.row_id} period ${forecastIndex} has no forecast writer.`,
            { section, row_id: row.row_id, forecast_index: forecastIndex },
          ));
        } else {
          writerClaims.push({
            state_id: id,
            writer,
          });
        }
        nodes.push({
          id,
          section,
          row_id: row.row_id,
          forecast_index: forecastIndex,
          method: authority.method,
          mechanism: authority.mechanism,
          writer,
        });
        edges.push({
          id: stableLayerNodeId("edge", "forecast_writes", section, row.row_id, forecastIndex),
          type: "writes_period",
          from: id,
          to: statementId,
        });
      }
    }
  }
  for (const stateId of duplicateValues(writerClaims.map((claim) => claim.state_id))) {
    violations.push(finding(
      "FORECAST_MULTIPLE_WRITERS",
      `${stateId} has more than one writer claim.`,
      { state_id: stateId },
    ));
  }
  return layer("forecast", nodes, edges);
}

function compileEconomicLayer(equationGraph, violations) {
  for (const id of duplicateValues((equationGraph.nodes ?? []).map((node) => node.id))) {
    violations.push(finding("ECONOMIC_DUPLICATE_NODE", `Economic graph duplicates node ${id}.`, { node_id: id }));
  }
  for (const role of duplicateValues((equationGraph.nodes ?? []).map((node) => node.role))) {
    violations.push(finding("ECONOMIC_MULTIPLE_WRITERS", `Economic role ${role} has multiple equation writers.`, { role }));
  }
  const ids = new Set((equationGraph.nodes ?? []).map((node) => node.id));
  const nodes = (equationGraph.nodes ?? []).map((node) => ({
    id: stableLayerNodeId("economic", node.id),
    equation_node_id: node.id,
    role: node.role,
    domain: node.domain,
    writer: "canonical_solver_equation",
  }));
  const edges = [];
  for (const edge of equationGraph.edges ?? []) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      violations.push(finding(
        "ECONOMIC_ORPHAN_EDGE",
        `Economic edge ${edge.id} has an orphan endpoint.`,
        { edge_id: edge.id, from: edge.from, to: edge.to },
      ));
      continue;
    }
    edges.push({
      id: stableLayerNodeId("edge", "economic", edge.id),
      type: edge.type,
      from: stableLayerNodeId("economic", edge.from),
      to: stableLayerNodeId("economic", edge.to),
      activation: edge.activation,
    });
  }
  return layer("economic", nodes, edges);
}

function compileProjectionLayer(rowPlan, statementNodeIds, violations) {
  const nodes = [];
  const edges = [];
  const rowClaims = new Map();
  const projectionOccurrences = new Map();
  for (const section of STATEMENT_SECTIONS) {
    for (const row of rowPlan.statement_rows?.[section] ?? []) {
      const target = statementNodeIds.get(`${section}\u0000${row.row_id}`);
      if (!target) {
        violations.push(finding(
          "ROW_PLAN_ORPHAN_PROJECTION",
          `Row plan projects missing ${section}.${row.row_id}.`,
          { section, row_id: row.row_id },
        ));
        continue;
      }
      const projectionKey = `${section}\u0000${row.row_id}`;
      const ordinal = projectionOccurrences.get(projectionKey) ?? 0;
      projectionOccurrences.set(projectionKey, ordinal + 1);
      if (ordinal > 0) {
        violations.push(finding(
          "ROW_PLAN_MULTIPLE_WRITERS",
          `${section}.${row.row_id} has more than one physical projection writer.`,
          { section, row_id: row.row_id },
        ));
      }
      const id = stableLayerNodeId("row_plan", section, row.row_id, ordinal);
      const physicalRow = Number(row.row);
      if (!Number.isInteger(physicalRow) || physicalRow < 1) {
        violations.push(finding(
          "ROW_PLAN_INVALID_PHYSICAL_ROW",
          `${section}.${row.row_id} has no valid physical row.`,
          { section, row_id: row.row_id, physical_row: row.row ?? null },
        ));
      } else {
        const key = `Operating Model\u0000${physicalRow}`;
        const claims = rowClaims.get(key) ?? [];
        claims.push(id);
        rowClaims.set(key, claims);
      }
      nodes.push({
        id,
        section,
        row_id: row.row_id,
        sheet: "Operating Model",
        physical_row: Number.isInteger(physicalRow) ? physicalRow : null,
        writer: "row_plan",
      });
      edges.push({
        id: stableLayerNodeId("edge", "projects", section, row.row_id, ordinal),
        type: "projects",
        from: id,
        to: target,
      });
    }
  }
  for (const [physicalKey, claims] of rowClaims) {
    if (claims.length <= 1) continue;
    violations.push(finding(
      "ROW_PLAN_MULTIPLE_WRITERS",
      `${physicalKey.replace("\u0000", " row ")} has ${claims.length} statement projections.`,
      { physical_key: physicalKey, projection_ids: sorted(claims, (value) => value) },
    ));
  }
  return layer("row_plan", nodes, edges);
}

function allLayerNodeIds(layers) {
  return new Set(layers.flatMap((item) => item.nodes.map((node) => node.id)));
}

export function validateLayeredGraphConstitution(artifact) {
  const errors = [];
  if (artifact?.schema_version !== LAYERED_GRAPH_CONSTITUTION_VERSION) {
    errors.push("layered graph constitution schema version is absent or invalid.");
    return errors;
  }
  const layers = artifact.layers ?? [];
  const expectedIds = ["evidence", "statement", "forecast", "economic", "row_plan"];
  if (JSON.stringify(layers.map((item) => item.layer_id)) !== JSON.stringify(expectedIds)) {
    errors.push("layered graph constitution does not contain the canonical ordered layers.");
  }
  const nodeIds = allLayerNodeIds(layers);
  for (const duplicate of duplicateValues(layers.flatMap((item) => item.nodes.map((node) => node.id)))) {
    errors.push(`layered graph constitution duplicates stable node id ${duplicate}.`);
  }
  for (const item of layers) {
    const core = { layer_id: item.layer_id, nodes: item.nodes, edges: item.edges };
    if (item.graph_sha256 !== hashValue(core)) {
      errors.push(`${item.layer_id} graph hash does not match its canonical content.`);
    }
    for (const edge of item.edges ?? []) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        errors.push(`${item.layer_id} edge ${edge.id} has an orphan endpoint.`);
      }
    }
  }
  const closureCore = {
    schema_version: artifact.schema_version,
    case_id: artifact.case_id,
    case_sha256: artifact.case_sha256,
    row_plan_projection_scope: artifact.row_plan_projection_scope,
    row_plan_projection_sha256: artifact.row_plan_projection_sha256,
    layer_hashes: artifact.layer_hashes,
    violation_sha256: artifact.violation_sha256,
  };
  if (artifact.closure_sha256 !== hashValue(closureCore)) {
    errors.push("layered graph closure hash does not match its canonical bindings.");
  }
  if ((artifact.violations ?? []).length === 0 && artifact.status !== "PASS") {
    errors.push("clean layered graph constitution does not report PASS.");
  }
  if ((artifact.violations ?? []).length > 0 && artifact.status !== "BLOCK") {
    errors.push("violating layered graph constitution does not report BLOCK.");
  }
  return errors;
}

export function compileLayeredGraphConstitution(
  modelCase,
  rowPlan,
  { equationGraph = EQUATION_GRAPH } = {},
) {
  const violations = [];
  validateSourceStatementClosure(modelCase, violations);
  const statementRows = canonicalStatementRows(modelCase, rowPlan);
  const { graph: statement, nodeIds } = compileStatementLayer(
    modelCase,
    statementRows,
    violations,
  );
  const layers = [
    compileEvidenceLayer(modelCase, nodeIds, violations),
    statement,
    compileForecastLayer(modelCase, statementRows, nodeIds, violations),
    compileEconomicLayer(equationGraph, violations),
    compileProjectionLayer(rowPlan, nodeIds, violations),
  ];
  const layerHashes = Object.fromEntries(
    layers.map((item) => [item.layer_id, item.graph_sha256]),
  );
  const sortedViolations = sorted(
    violations,
    (item) => `${item.code}\u0000${item.message}`,
  );
  const closureCore = {
    schema_version: LAYERED_GRAPH_CONSTITUTION_VERSION,
    case_id: modelCase.case_id,
    case_sha256: canonicalJsonSha256(modelCase),
    row_plan_projection_scope: ROW_PLAN_PROJECTION_SCOPE,
    row_plan_projection_sha256: hashValue(rowPlanConstitutionProjection(rowPlan)),
    layer_hashes: layerHashes,
    violation_sha256: hashValue(sortedViolations),
  };
  const artifact = {
    ...closureCore,
    layer_hashes: layerHashes,
    layers,
    closure_sha256: hashValue(closureCore),
    status: violations.length === 0 ? "PASS" : "BLOCK",
    violations: sortedViolations,
  };
  const internalErrors = validateLayeredGraphConstitution(artifact);
  if (internalErrors.length > 0) {
    throw new Error(`Layered graph constitution self-validation failed:\n- ${internalErrors.join("\n- ")}`);
  }
  return artifact;
}
