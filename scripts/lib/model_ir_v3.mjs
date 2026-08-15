import { createHash } from "node:crypto";

import {
  CONVERGENCE_CONTRACT,
  EQUATION_GRAPH,
  canonicalJsonSha256,
} from "./equation_graph.mjs";
import { ECONOMIC_SOLVE_POLICY } from "./economic_solve_policy.mjs";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function portableCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

function conceptId(manifest, node) {
  const basis = manifest.accounting_basis ?? "unspecified_basis";
  const scope = node.operation_scope ?? "unspecified_scope";
  const role = node.semantic_role ?? node.semantic_id ?? node.row_id;
  return `${basis}:${scope}:${node.section}:${role}`;
}

function definitionSignature(manifest, node) {
  return {
    accounting_basis: manifest.accounting_basis ?? null,
    operation_scope: node.operation_scope ?? null,
    section: node.section,
    semantic_role: node.semantic_role ?? null,
    economic_class: node.economic_class ?? null,
    movement_type: node.movement_type ?? null,
    cash_flow_classification: node.cash_flow_classification ?? null,
    aggregation_authority: node.aggregation_authority ?? null,
  };
}

function producerType(authority, node) {
  if (
    node.forecast_capture_parent_id &&
    ["not_separately_forecast", "not_applicable"].includes(authority.method)
  ) return "CapturedBy";
  switch (authority.method) {
    case "broker_consensus":
      return "BrokerInput";
    case "schedule_link":
      return "ScheduleLink";
    case "accounting_identity":
    case "driver_formula":
    case "roll_forward":
      return "Derived";
    case "explicit_zero":
      return "ExplicitZero";
    case "not_applicable":
    case "not_separately_forecast":
      return node.forecast_capture_parent_id ? "CapturedBy" : "NotApplicable";
    case "actual_plus_remainder":
    case "contractual_commitment":
    case "company_guidance":
    case "company_indication":
      return "FiledInput";
    case "user_assumption":
    case "seasonal_run_rate":
    case "historical_average":
    case "historical_trend":
    case "carry_forward":
      return "UserInput";
    default:
      return "Unresolved";
  }
}

function displayRole(node) {
  if (node.display_role) return node.display_role;
  if (node.row_type === "header") return "header";
  if (node.projection_status !== "rendered") return "memo";
  if (node.formula_authority === "compiler") return "consumer";
  if (node.parent_row_id || node.aggregation_role === "contributing_child") {
    return "component";
  }
  if (node.row_type === "subtotal" || node.style_role === "total") return "answer";
  return node.semantic_role ? "answer" : "component";
}

function depthFor(node, byId) {
  let depth = 0;
  let cursor = node;
  const seen = new Set([node.row_id]);
  while (cursor?.parent_row_id && byId.has(cursor.parent_row_id)) {
    if (seen.has(cursor.parent_row_id)) return 0;
    seen.add(cursor.parent_row_id);
    depth += 1;
    cursor = byId.get(cursor.parent_row_id);
  }
  return depth;
}

function finding(code, message, extra = {}) {
  return { code, message, ...extra };
}

/**
 * Compile the proof-carrying, workbook-independent model representation.
 *
 * The existing semantic manifest remains a diagnostic graph.  This IR is the
 * executable contract between evidence, economic ownership, formulas and
 * presentation.  It deliberately gives a displayed row and its economic
 * concept separate identities so one economic answer cannot be written twice
 * merely because two labels happen to be visible.
 */
export function compileModelIrV3({
  modelCase,
  rowPlan,
  semanticManifest,
  sourceCrosswalk = [],
}) {
  const blockers = [];
  const warnings = [];
  const statementNodes = semanticManifest.nodes.filter(
    (node) => node.node_kind === "statement_row",
  );
  const statementById = new Map(statementNodes.map((node) => [node.row_id, node]));

  const sourceIds = new Set();
  const evidence = semanticManifest.source_inventory.map((source) => {
    const duplicate = sourceIds.has(source.source_line_id);
    sourceIds.add(source.source_line_id);
    const missingDestinations = (source.mapped_row_ids ?? []).filter(
      (rowId) => !statementById.has(rowId),
    );
    const requiresDestination = ["mapped", "aggregated"].includes(source.disposition);
    const unresolved =
      duplicate ||
      (requiresDestination && (source.mapped_row_ids ?? []).length === 0) ||
      missingDestinations.length > 0;
    if (duplicate) {
      blockers.push(
        finding("EVIDENCE_DUPLICATE_ID", `Source line ${source.source_line_id} occurs more than once.`, {
          source_line_ids: [source.source_line_id],
        }),
      );
    }
    if (unresolved && source.material) {
      blockers.push(
        finding(
          "EVIDENCE_MATERIAL_UNRESOLVED",
          `Material source line ${source.source_line_id} does not resolve to exactly declared statement destinations.`,
          { source_line_ids: [source.source_line_id], display_ids: source.mapped_row_ids ?? [] },
        ),
      );
    } else if (unresolved) {
      warnings.push(
        finding("EVIDENCE_UNRESOLVED", `Source line ${source.source_line_id} is unresolved.`, {
          source_line_ids: [source.source_line_id],
        }),
      );
    }
    return {
      source_line_id: source.source_line_id,
      section: source.section,
      label: source.label ?? "",
      document: source.document ?? null,
      page_or_note: source.page_or_note ?? null,
      material: source.material === true,
      disposition: unresolved ? "unresolved" : source.disposition,
      mapped_display_ids: [...(source.mapped_row_ids ?? [])],
      resolution: unresolved
        ? "unresolved"
        : source.disposition === "not_applicable"
          ? "documented_exclusion"
          : "resolved",
      reason: source.reason ?? null,
    };
  });

  const concepts = new Map();
  for (const node of statementNodes) {
    const id = conceptId(semanticManifest, node);
    concepts.set(id, (concepts.get(id) ?? 0) + 1);
  }
  const statement = statementNodes.map((node) => ({
    display_id: node.row_id,
    economic_concept_id: conceptId(semanticManifest, node),
    semantic_role: node.semantic_role ?? null,
    label: node.label ?? "",
    section: node.section,
    projection_status: node.projection_status ?? "rendered",
    definition_signature: definitionSignature(semanticManifest, node),
    source_line_ids: unique(node.source_line_ids).sort(),
    forecast_capture_parent_id: node.forecast_capture_parent_id ?? null,
    forecast_capture_mode: node.forecast_capture_mode ?? null,
  }));

  const authority = statementNodes.flatMap((node) =>
    (node.forecast_authorities ?? []).map((item) => {
      const producer = producerType(item, node);
      const unresolved = producer === "Unresolved" || item.mechanism === "block";
      if (unresolved && node.projection_status === "rendered") {
        blockers.push(
          finding(
            "AUTHORITY_UNRESOLVED",
            `${node.row_id} has no forecast authority in period ${item.forecast_index}.`,
            { display_ids: [node.row_id], forecast_index: item.forecast_index },
          ),
        );
      }
      return {
        display_id: node.row_id,
        forecast_index: item.forecast_index,
        producer_type: producer,
        status: unresolved ? "unresolved" : "resolved",
        method: item.method,
        source_kind: item.source_kind ?? null,
        source_id: item.source_id ?? null,
        capture_parent_display_id: node.forecast_capture_parent_id ?? null,
        reason: item.note ?? null,
        material: item.material ?? null,
        candidates: item.candidates ?? [],
        capture_certificate: item.capture_certificate ?? null,
        formula_operator: item.formula_operator ?? null,
        formula_refs: item.formula_refs ?? [],
        period_relation: item.period_relation ?? "same_period",
      };
    }),
  );

  const statementConceptByDisplay = new Map(
    statement.map((node) => [node.display_id, node.economic_concept_id]),
  );
  const authorityOwners = new Map();
  for (const owner of authority.filter(
    (item) =>
      item.status === "resolved" &&
      !["CapturedBy", "NotApplicable"].includes(item.producer_type),
  )) {
    const concept = statementConceptByDisplay.get(owner.display_id);
    const key = `${concept}\u0000${owner.forecast_index}`;
    const owners = authorityOwners.get(key) ?? [];
    owners.push(owner.display_id);
    authorityOwners.set(key, owners);
  }
  for (const [key, displayIds] of authorityOwners) {
    const distinct = unique(displayIds);
    if (distinct.length > 1) {
      const [economicConceptId, forecastIndex] = key.split("\u0000");
      blockers.push(
        finding(
          "AUTHORITY_MULTIPLE_WRITERS",
          `${economicConceptId} has ${distinct.length} live writers in forecast period ${forecastIndex}.`,
          { display_ids: distinct, forecast_index: Number(forecastIndex) },
        ),
      );
    }
  }

  const presentation = [];
  const bySection = new Map();
  for (const node of statementNodes) {
    const rows = bySection.get(node.section) ?? [];
    rows.push(node);
    bySection.set(node.section, rows);
  }
  for (const [section, nodes] of bySection) {
    const sorted = [...nodes].sort(
      (left, right) =>
        Number(left.physical_row ?? Number.MAX_SAFE_INTEGER) -
          Number(right.physical_row ?? Number.MAX_SAFE_INTEGER) ||
        left.row_id.localeCompare(right.row_id),
    );
    sorted.forEach((node, order) => {
      const depth = Number.isInteger(node.presentation_depth)
        ? node.presentation_depth
        : depthFor(node, statementById);
      const presentationParentId =
        node.presentation_parent_id ?? node.parent_row_id ?? null;
      const parent = presentationParentId
        ? statementById.get(presentationParentId)
        : null;
      if (parent && parent.section === section) {
        const parentOrder = sorted.findIndex((candidate) => candidate.row_id === parent.row_id);
        if (parentOrder > order) {
          blockers.push(
            finding(
              "PRESENTATION_CHILD_BEFORE_PARENT",
              `${node.row_id} is displayed before parent ${parent.row_id}.`,
              { display_ids: [node.row_id, parent.row_id] },
            ),
          );
        }
      }
      presentation.push({
        display_id: node.row_id,
        section,
        order,
        physical_row: Number.isInteger(node.physical_row) ? node.physical_row : null,
        parent_display_id: presentationParentId,
        depth,
        display_role:
          node.presentation_role === "standalone"
            ? displayRole(node)
            : node.presentation_role ?? displayRole(node),
        style_role: node.style_role ?? null,
        presentation_rank: node.presentation_rank ?? null,
        section_conclusion_owner: node.section_conclusion_owner === true,
        section_conclusion_id: node.section_conclusion_id ?? null,
        in_section_conclusion_closure:
          node.in_section_conclusion_closure === true,
        indent: depth,
      });
    });
  }

  const renderedAnswers = new Map();
  for (const item of presentation.filter((entry) => entry.display_role === "answer")) {
    const node = statement.find((candidate) => candidate.display_id === item.display_id);
    const ids = renderedAnswers.get(node.economic_concept_id) ?? [];
    ids.push(item.display_id);
    renderedAnswers.set(node.economic_concept_id, ids);
  }
  for (const [economicConceptId, displayIds] of renderedAnswers) {
    if (displayIds.length > 1) {
      blockers.push(
        finding(
          "STATEMENT_DUPLICATE_ANSWER_OWNER",
          `${economicConceptId} has ${displayIds.length} visible answer owners.`,
          { display_ids: displayIds },
        ),
      );
    }
  }

  const uniqueFormulaMembershipPath = (childId, parentId, section) => {
    const parentsByChild = new Map();
    for (const candidate of statementNodes.filter((item) => item.section === section)) {
      for (const dependency of candidate.dependencies ?? []) {
        const parents = parentsByChild.get(dependency) ?? [];
        parents.push(candidate.row_id);
        parentsByChild.set(dependency, parents);
      }
    }
    const paths = [];
    const queue = [[childId]];
    while (queue.length > 0 && paths.length < 2) {
      const path = queue.shift();
      const current = path.at(-1);
      for (const next of parentsByChild.get(current) ?? []) {
        if (path.includes(next)) continue;
        const candidate = [...path, next];
        if (next === parentId) paths.push(candidate);
        else queue.push(candidate);
      }
    }
    return paths.length === 1 ? paths[0] : null;
  };
  const scheduleOwnedRoles = new Set([
    "interest_income",
    "interest_expense",
    "cash_interest_paid",
    "cash_interest_received",
    "debt_issuance",
    "debt_repayment",
    "rcf_draw",
    "rcf_repayment",
    "lease_principal",
    "opening_cash",
    "ending_cash",
  ]);
  for (const node of statementNodes.filter((item) => item.forecast_capture_parent_id)) {
    const parent = statementById.get(node.forecast_capture_parent_id);
    const mode = node.forecast_capture_mode;
    const parentAuthorities = authority.filter(
      (item) => item.display_id === node.forecast_capture_parent_id,
    );
    const membershipPath = mode === "formula_membership"
      ? uniqueFormulaMembershipPath(
          node.row_id,
          node.forecast_capture_parent_id,
          node.section,
        )
      : null;
    const formulaProven =
      mode === "formula_membership" &&
      Boolean(membershipPath) &&
      parentAuthorities.length === 3 &&
      authority
        .filter((item) => item.display_id === node.row_id)
        .every(
          (item) =>
            item.status === "resolved" &&
            item.producer_type === "CapturedBy" &&
            JSON.stringify(item.capture_certificate?.membership_path ?? null) ===
              JSON.stringify(membershipPath),
        );
    const semanticScopeProven =
      mode === "semantic_scope" &&
      parent?.section === node.section &&
      parentAuthorities.length === 3 &&
      parentAuthorities.every((item) => item.status === "resolved") &&
      ((node.source_line_ids ?? []).length > 0 ||
        scheduleOwnedRoles.has(node.semantic_role));
    if (!formulaProven && !semanticScopeProven) {
      blockers.push(
        finding(
          "COVERAGE_CAPTURE_UNPROVEN",
          `${node.row_id} is declared captured by ${node.forecast_capture_parent_id}, but its ${mode ?? "missing"} certificate does not prove exclusive forecast coverage.`,
          { display_ids: [node.row_id, node.forecast_capture_parent_id] },
        ),
      );
    }
  }

  const calculationEdges = semanticManifest.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    edge_type: edge.edge_type,
  }));
  const nodeByNodeId = new Map(
    semanticManifest.nodes.map((node) => [node.node_id, node]),
  );
  for (const edge of calculationEdges) {
    const from = nodeByNodeId.get(edge.from);
    const to = nodeByNodeId.get(edge.to);
    if (
      from?.node_kind === "mechanical" &&
      to?.node_kind === "statement_row" &&
      scheduleOwnedRoles.has(to.semantic_role)
    ) {
      blockers.push(
        finding(
          "CALCULATION_SCHEDULE_DIRECTION_REVERSED",
          `${to.row_id} feeds ${from.node_id}; schedule-owned statement rows must consume the schedule, never drive it.`,
          { display_ids: [to.row_id] },
        ),
      );
    }
  }
  const evidenceEpoch = {
    epoch_sha256: sha256(evidence),
    sealed: blockers.every((item) => !item.code.startsWith("EVIDENCE_")),
    source_line_count: evidence.length,
  };
  const metrics = {
    evidence_lines: evidence.length,
    statement_nodes: statement.length,
    authority_nodes: authority.length,
    calculation_edges: calculationEdges.length,
    presentation_nodes: presentation.length,
    source_crosswalk_rows: sourceCrosswalk.length,
  };
  return {
    schema_version: 3,
    case_id: semanticManifest.case_id,
    case_sha256: semanticManifest.case_sha256,
    evidence_epoch: evidenceEpoch,
    planes: {
      evidence,
      statement,
      authority,
      calculation: {
        nodes: semanticManifest.nodes.map((node) => node.node_id),
        edges: calculationEdges,
      },
      presentation,
    },
    proof: {
      status: blockers.length === 0 ? "PASS" : "BLOCK",
      blocking_findings: blockers,
      warnings,
      metrics,
    },
  };
}

export function transformationReceipt(modelIr, outputKind = "model_ir_v3") {
  const pass = (pass_name, input_hash, output, detail = {}) => ({
    pass_name,
    input_hash,
    output_hash: sha256(output),
    ...detail,
  });
  return {
    receipt_version: 1,
    case_id: modelIr.case_id,
    case_sha256: modelIr.case_sha256,
    evidence_epoch_sha256: modelIr.evidence_epoch.epoch_sha256,
    output_kind: outputKind,
    output_sha256: sha256(modelIr),
    status: modelIr.proof.status,
    blocking_finding_codes: unique(
      modelIr.proof.blocking_findings.map((item) => item.code),
    ).sort(),
    metrics: modelIr.proof.metrics,
    passes: [
      pass(
        "sealed_evidence",
        modelIr.case_sha256,
        modelIr.planes.evidence,
        {
          objects_added: modelIr.planes.evidence.length,
          source_line_conservation:
            modelIr.evidence_epoch.sealed ? "PASS" : "BLOCK",
        },
      ),
      pass(
        "economic_identity",
        modelIr.evidence_epoch.epoch_sha256,
        modelIr.planes.statement,
        { objects_added: modelIr.planes.statement.length },
      ),
      pass(
        "forecast_authority",
        sha256(modelIr.planes.statement),
        modelIr.planes.authority,
        {
          objects_added: modelIr.planes.authority.length,
          new_unresolved_items: modelIr.planes.authority.filter(
            (item) => item.status === "unresolved",
          ).length,
        },
      ),
      pass(
        "calculation_graph",
        sha256(modelIr.planes.authority),
        modelIr.planes.calculation,
        { objects_added: modelIr.planes.calculation.edges.length },
      ),
      pass(
        "presentation_tree",
        sha256(modelIr.planes.calculation),
        modelIr.planes.presentation,
        { objects_added: modelIr.planes.presentation.length },
      ),
    ],
  };
}

export function forecastDecisionReceipt(modelIr) {
  const statement = new Map(
    modelIr.planes.statement.map((node) => [node.display_id, node]),
  );
  return modelIr.planes.authority
    .map((authority) => ({
      display_id: authority.display_id,
      economic_concept_id:
        statement.get(authority.display_id)?.economic_concept_id ?? null,
      label: statement.get(authority.display_id)?.label ?? null,
      forecast_index: authority.forecast_index,
      method: authority.method,
      authority: authority.producer_type,
      source_kind: authority.source_kind,
      source_id: authority.source_id,
      reason: authority.reason,
      captured_by: authority.capture_parent_display_id,
      status: authority.status,
    }))
    .sort(
      (left, right) =>
        left.forecast_index - right.forecast_index ||
        left.display_id.localeCompare(right.display_id),
    );
}

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function forecastDecisionReceiptCsv(rows) {
  const headers = [
    "display_id",
    "economic_concept_id",
    "label",
    "forecast_index",
    "method",
    "authority",
    "source_kind",
    "source_id",
    "reason",
    "captured_by",
    "status",
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(",")),
  ].join("\n") + "\n";
}

/**
 * Compile the small physical-workbook proof contract consumed by the
 * standard-library OOXML oracle. The contract is derived from the sealed IR,
 * never from the emitted workbook, so it remains an independent statement of
 * what the package must contain. It names semantic labels rather than physical
 * row numbers; the oracle resolves and proves those labels from raw OOXML.
 */
export function workbookSemanticProofContract(
  modelIr,
  rowPlan = {},
  { brokerEvidence = null } = {},
) {
  const statements = new Map(
    modelIr.planes.statement.map((node) => [node.display_id, node]),
  );
  const presentation = new Map(
    modelIr.planes.presentation.map((node) => [node.display_id, node]),
  );
  const physicalRow = (displayId) =>
    presentation.get(displayId)?.physical_row ?? null;
  const labelCounts = new Map();
  for (const node of modelIr.planes.statement) {
    const key = String(node.label ?? "").trim().toLowerCase();
    if (key) labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  const uniquelyNamed = (node) =>
    node && labelCounts.get(String(node.label ?? "").trim().toLowerCase()) === 1;

  const uniqueAnswers = [];
  for (const node of modelIr.planes.statement) {
    const display = presentation.get(node.display_id);
    if (
      display?.display_role === "answer" &&
      node.semantic_role &&
      uniquelyNamed(node)
    ) {
      uniqueAnswers.push({
        concept_id: node.economic_concept_id,
        labels: [node.label],
        max_visible: 1,
      });
    }
  }

  const sectionConclusions = [];
  for (const [section, rows] of ["income_statement", "cash_flow"].map(
    (section) => [
      section,
      modelIr.planes.statement.filter(
        (node) =>
          node.section === section &&
          presentation.get(node.display_id)?.section_conclusion_owner === true,
      ),
    ],
  )) {
    if (rows.length !== 1) continue;
    const node = rows[0];
    sectionConclusions.push({
      section,
      concept_id: node.economic_concept_id,
      label: node.label,
      row: physicalRow(node.display_id),
      first_row: rowPlan.section_headers?.[section]
        ? Number(rowPlan.section_headers[section]) + 1
        : null,
      last_row:
        section === "income_statement"
          ? Number(rowPlan.section_headers?.cash_flow ?? 0) - 2
          : Number(rowPlan.section_headers?.debt_schedule ?? 0) - 2,
      body_columns: ["G", "H", "I", "J", "K", "L"],
      answer_fill_rgb: "D9EAF7",
      answer_bottom_border: "double",
      dependency_labels: modelIr.planes.statement
        .filter(
          (candidate) =>
            candidate.section === section &&
            presentation.get(candidate.display_id)
              ?.in_section_conclusion_closure === true,
        )
        .map((candidate) => candidate.label),
    });
  }

  const identityRoles = [
    "ebit",
    "adjusted_ebitda",
    "depreciation_and_amortisation",
  ];
  const identityNodes = identityRoles.map((role) =>
    modelIr.planes.statement.find(
      (node) => node.semantic_role === role && uniquelyNamed(node),
    ),
  );
  const singleWriterGroups = identityNodes.every(Boolean)
    ? [{
        concept_id: "ebit_ebitda_da_identity",
        labels: identityNodes.map((node) => node.label),
        rows: identityNodes.map((node) => physicalRow(node.display_id)),
        columns: ["J", "K", "L"],
        max_independent_writers: 2,
      }]
    : [];

  const captureMemberships = [];
  const semanticScopeCaptures = [];
  const hierarchies = [];
  for (const node of modelIr.planes.statement) {
    const childDisplay = presentation.get(node.display_id);
    const parentId = childDisplay?.parent_display_id;
    const parent = statements.get(parentId);
    if (parent && uniquelyNamed(parent) && uniquelyNamed(node)) {
      hierarchies.push({ parent_label: parent.label, child_label: node.label });
      hierarchies.at(-1).parent_row = physicalRow(parent.display_id);
      hierarchies.at(-1).child_row = physicalRow(node.display_id);
    }
    if (
      node.forecast_capture_mode === "formula_membership" &&
      node.forecast_capture_parent_id &&
      uniquelyNamed(node)
    ) {
      const captureParent = statements.get(node.forecast_capture_parent_id);
      if (captureParent && uniquelyNamed(captureParent)) {
        captureMemberships.push({
          parent_label: captureParent.label,
          child_label: node.label,
          parent_row: physicalRow(captureParent.display_id),
          child_row: physicalRow(node.display_id),
          columns: ["J", "K", "L"],
        });
      }
    }
    if (
      node.forecast_capture_mode === "semantic_scope" &&
      node.forecast_capture_parent_id &&
      uniquelyNamed(node)
    ) {
      const captureParent = statements.get(node.forecast_capture_parent_id);
      if (captureParent && uniquelyNamed(captureParent)) {
        semanticScopeCaptures.push({
          parent_label: captureParent.label,
          child_label: node.label,
          parent_row: physicalRow(captureParent.display_id),
          child_row: physicalRow(node.display_id),
          columns: ["J", "K", "L"],
        });
      }
    }
  }

  const scheduleLabels = {
    interest_expense: "Gross interest expense",
    interest_income: "Interest income",
    cash_interest_paid: "Cash interest paid",
    cash_interest_received: "Cash interest received",
  };
  const scheduleRows = {
    interest_expense: rowPlan.interest_summary_rows?.gross_interest_expense,
    interest_income: rowPlan.interest_summary_rows?.interest_income_schedule,
    cash_interest_paid: rowPlan.interest_summary_rows?.cash_interest_paid,
    cash_interest_received: rowPlan.interest_summary_rows?.cash_interest_received,
  };
  const scheduleLinks = Object.entries(scheduleLabels).flatMap(
    ([semanticRole, scheduleLabel]) => {
      const statement = modelIr.planes.statement.find(
        (node) => node.semantic_role === semanticRole && uniquelyNamed(node),
      );
      return statement
        ? [{
            statement_label: statement.label,
            schedule_label: scheduleLabel,
            statement_row: physicalRow(statement.display_id),
            schedule_row: scheduleRows[semanticRole] ?? null,
            columns: ["J", "K", "L"],
          }]
        : [];
    },
  );

  // Bind the semantic dependency graph to its physical forecast projection.
  // This contract is compiled from the sealed IR, before the workbook exists;
  // the standard-library oracle later reconstructs the formula graph from raw
  // OOXML and proves both directions: every required dependency is reachable,
  // and every direct statement-to-statement formula edge is authorised by the
  // semantic graph's transitive closure.
  const graphNodes = modelIr.planes.statement
    .filter((node) => Number.isInteger(physicalRow(node.display_id)))
    .map((node) => ({
      display_id: node.display_id,
      semantic_role: node.semantic_role ?? null,
      section: node.section,
      label: node.label,
      row: physicalRow(node.display_id),
    }))
    .sort((left, right) => portableCompare(left.display_id, right.display_id));
  const graphNodeIds = new Set(graphNodes.map((node) => node.display_id));
  const dependencyPairs = new Map();
  for (const edge of modelIr.planes.calculation.edges) {
    let consumerNodeId;
    let dependencyNodeId;
    if (edge.edge_type === "depends_on") {
      consumerNodeId = edge.from;
      dependencyNodeId = edge.to;
    } else if (edge.edge_type === "contributes_to") {
      // The graph states component -> aggregate. The physical formula points
      // the other way: the aggregate consumes the component.
      consumerNodeId = edge.to;
      dependencyNodeId = edge.from;
    } else {
      continue;
    }
    if (
      !consumerNodeId.startsWith("statement.") ||
      !dependencyNodeId.startsWith("statement.")
    ) continue;
    const consumer = consumerNodeId.slice("statement.".length);
    const dependency = dependencyNodeId.slice("statement.".length);
    if (!graphNodeIds.has(consumer) || !graphNodeIds.has(dependency)) continue;
    dependencyPairs.set(`${consumer}\u0000${dependency}`, {
      consumer_display_id: consumer,
      dependency_display_id: dependency,
    });
  }
  const authorisedDependencyEdges = [...dependencyPairs.values()].sort(
    (left, right) =>
      portableCompare(left.consumer_display_id, right.consumer_display_id) ||
      portableCompare(left.dependency_display_id, right.dependency_display_id),
  );
  const authorityByDisplayPeriod = new Map(
    modelIr.planes.authority.map((item) => [
      `${item.display_id}\u0000${item.forecast_index}`,
      item,
    ]),
  );
  const graphNodeById = new Map(graphNodes.map((node) => [node.display_id, node]));
  const requiredFormulaPaths = [];
  const forecastColumns = ["J", "K", "L"];
  const priorColumns = ["I", "J", "K"];
  for (const edge of authorisedDependencyEdges) {
    const consumer = graphNodeById.get(edge.consumer_display_id);
    const dependency = graphNodeById.get(edge.dependency_display_id);
    for (let forecastIndex = 0; forecastIndex < 3; forecastIndex += 1) {
      const authority = authorityByDisplayPeriod.get(
        `${edge.consumer_display_id}\u0000${forecastIndex}`,
      );
      if (authority?.producer_type !== "Derived") continue;
      const priorPeriod =
        authority.period_relation === "prior_period" &&
        (authority.formula_refs ?? []).includes(edge.dependency_display_id);
      requiredFormulaPaths.push({
        consumer_display_id: edge.consumer_display_id,
        dependency_display_id: edge.dependency_display_id,
        consumer_cell: `${forecastColumns[forecastIndex]}${consumer.row}`,
        dependency_cell: `${priorPeriod ? priorColumns[forecastIndex] : forecastColumns[forecastIndex]}${dependency.row}`,
        period_relation: priorPeriod ? "prior_period" : "same_period",
      });
    }
  }
  const formulaGraphCore = {
    statement_sheet: "Operating Model",
    model_ir_sha256: sha256(modelIr),
    graph_nodes: graphNodes,
    authorised_dependency_edges: authorisedDependencyEdges,
    required_formula_paths: requiredFormulaPaths,
  };
  const physicalFormulaGraph = {
    schema_version: 1,
    ...formulaGraphCore,
    closure_sha256: sha256(formulaGraphCore),
  };

  // The fixed-point SCC has a deliberately separate physical projection from
  // the general statement graph.  The canonical graph models finance expense
  // and finance income as distinct consumers because that is what the emitted
  // workbook actually contains; the independent OOXML oracle will derive the
  // formula-cell SCC and require these exact semantic nodes in every forecast
  // period.  No cached value or solver assertion is used here.
  const statementRowFor = (...identifiers) => {
    const node = modelIr.planes.statement.find(
      (item) =>
        identifiers.includes(item.semantic_role) ||
        identifiers.includes(item.display_id),
    );
    return node ? physicalRow(node.display_id) : null;
  };
  const fixedPointRowByNode = {
    "statement.cash_flow_start": statementRowFor("cash_flow_net_income"),
    "cash.cfo": statementRowFor("cash_from_operations"),
    "rcf.draw": rowPlan.waterfall_rows?.rcf_draw_waterfall,
    "rcf.repayment": rowPlan.waterfall_rows?.rcf_repayment_waterfall,
    "rcf.ending_balance": rowPlan.waterfall_rows?.ending_rcf,
    "cash.ending_balance": statementRowFor("ending_cash"),
    "interest.rcf": rowPlan.interest_summary_rows?.rcf_interest,
    "interest.commitment_fee":
      rowPlan.interest_summary_rows?.rcf_commitment_fee,
    "interest.cash_income":
      rowPlan.interest_summary_rows?.interest_income_schedule,
    "interest.gross_expense":
      rowPlan.interest_summary_rows?.gross_interest_expense,
    "interest.income":
      rowPlan.interest_summary_rows?.interest_income_schedule,
    "statement.finance_expense": statementRowFor("interest_expense"),
    "statement.finance_income": statementRowFor("interest_income"),
  };
  const expectedFixedPointNodes =
    CONVERGENCE_CONTRACT.scc_contract.active_by_circularity["1"][0].nodes;
  const missingFixedPointRows = expectedFixedPointNodes.filter(
    (nodeId) => !Number.isInteger(fixedPointRowByNode[nodeId]),
  );
  if (missingFixedPointRows.length > 0) {
    throw new Error(
      `Cannot bind canonical fixed-point nodes to workbook rows: ${missingFixedPointRows.join(", ")}`,
    );
  }
  const fixedPointFormulaGraph = {
    schema_version: 1,
    statement_sheet: "Operating Model",
    forecast_columns: ["J", "K", "L"],
    circularity_control_cell: `C${rowPlan.controls?.circularity}`,
    equation_graph_sha256: canonicalJsonSha256(EQUATION_GRAPH),
    convergence_contract_sha256: canonicalJsonSha256(CONVERGENCE_CONTRACT),
    economic_solve_policy_sha256: canonicalJsonSha256(ECONOMIC_SOLVE_POLICY),
    expected_active_scc_nodes: [...expectedFixedPointNodes].sort(portableCompare),
    node_bindings: expectedFixedPointNodes
      .map((nodeId) => ({ node_id: nodeId, row: fixedPointRowByNode[nodeId] }))
      .sort((left, right) => portableCompare(left.node_id, right.node_id)),
    zero_when_off_bindings: [
      {
        role: "instrument_cash_interest",
        rows: (rowPlan.instruments ?? [])
          .map((item) => item.interest_row)
          .filter(Number.isInteger),
      },
      {
        role: "instrument_pik_interest",
        rows: (rowPlan.instruments ?? [])
          .map((item) => item.pik_interest_row)
          .filter(Number.isInteger),
      },
      {
        role: "instrument_pik_principal_accretion",
        rows: (rowPlan.instruments ?? [])
          .map((item) => item.pik_row)
          .filter(Number.isInteger),
      },
      { role: "rcf_interest", rows: [rowPlan.interest_summary_rows?.rcf_interest] },
      { role: "rcf_commitment_fee", rows: [rowPlan.interest_summary_rows?.rcf_commitment_fee] },
      { role: "lease_interest", rows: [rowPlan.interest_summary_rows?.lease_interest] },
      { role: "acquisition_interest", rows: [rowPlan.interest_summary_rows?.acquisition_interest] },
      { role: "other_interest", rows: [rowPlan.interest_summary_rows?.other_unallocated_interest] },
      { role: "noncash_interest", rows: [rowPlan.interest_summary_rows?.non_cash_interest] },
      { role: "cash_interest_income", rows: [rowPlan.interest_summary_rows?.interest_income_schedule] },
      { role: "gross_interest_expense", gate_mode: "closure", rows: [rowPlan.interest_summary_rows?.gross_interest_expense] },
      { role: "interest_income", rows: [rowPlan.interest_summary_rows?.interest_income_schedule] },
      { role: "net_interest_expense", gate_mode: "closure", rows: [rowPlan.interest_summary_rows?.net_interest_expense] },
      { role: "cash_interest_paid", gate_mode: "closure", rows: [rowPlan.interest_summary_rows?.cash_interest_paid] },
      { role: "cash_interest_received", gate_mode: "closure", rows: [rowPlan.interest_summary_rows?.cash_interest_received] },
      { role: "noncash_interest_addback", gate_mode: "closure", rows: [statementRowFor("non_cash_interest_addback")] },
      { role: "net_finance_addback", gate_mode: "closure", rows: [statementRowFor("net_finance_addback", "finance_costs_net_addback")] },
      { role: "income_statement_finance_expense", gate_mode: "closure", rows: [statementRowFor("interest_expense")] },
      { role: "income_statement_finance_income", gate_mode: "closure", rows: [statementRowFor("interest_income")] },
    ].map((item) => ({
      ...item,
      gate_mode: item.gate_mode ?? "direct",
      rows: [...new Set(item.rows.filter(Number.isInteger))].sort((a, b) => a - b),
    })),
    live_when_off_bindings: [
      { role: "debt_issuance", rows: [statementRowFor("debt_issuance"), rowPlan.waterfall_rows?.non_rcf_debt_proceeds] },
      { role: "scheduled_amortisation", rows: (rowPlan.instruments ?? []).map((item) => item.amortisation_row) },
      { role: "maturity_repayment", rows: (rowPlan.instruments ?? []).map((item) => item.repayment_row) },
      { role: "lease_principal", rows: [statementRowFor("lease_principal"), rowPlan.waterfall_rows?.lease_principal_waterfall] },
      { role: "mandatory_repayment", rows: [rowPlan.debt_summary_rows?.mandatory_debt_repayments] },
      { role: "minimum_cash", rows: [rowPlan.waterfall_rows?.minimum_cash] },
      { role: "rcf_capacity", rows: [] },
      { role: "rcf_draw", rows: [rowPlan.waterfall_rows?.rcf_draw_waterfall] },
      { role: "rcf_repayment", rows: [rowPlan.waterfall_rows?.rcf_repayment_waterfall] },
      { role: "ending_rcf", rows: [rowPlan.waterfall_rows?.ending_rcf] },
      { role: "ending_cash", rows: [statementRowFor("ending_cash")] },
      { role: "liquidity_shortfall", rows: [rowPlan.waterfall_rows?.liquidity_shortfall] },
    ].map((item) => ({
      ...item,
      rows: [...new Set(item.rows.filter(Number.isInteger))].sort((a, b) => a - b),
    })),
  };
  fixedPointFormulaGraph.closure_sha256 = sha256(fixedPointFormulaGraph);

  return {
    schema_version: 1,
    kind: "workbook_semantic_proof_contract",
    case_id: modelIr.case_id,
    evidence_epoch_sha256: modelIr.evidence_epoch.epoch_sha256,
    statement_sheet: "Operating Model",
    label_column: "B",
    forecast_columns: ["J", "K", "L"],
    unique_answers: uniqueAnswers,
    section_conclusions: sectionConclusions,
    single_writer_groups: singleWriterGroups,
    capture_memberships: captureMemberships,
    semantic_scope_captures: semanticScopeCaptures,
    hierarchies,
    schedule_links: scheduleLinks,
    physical_formula_graph: physicalFormulaGraph,
    fixed_point_formula_graph: fixedPointFormulaGraph,
    broker_evidence: brokerEvidence,
    max_formula_characters: 8192,
  };
}

export function shadowSemanticComparison(semanticManifest, modelIr) {
  const legacy = new Set(
    semanticManifest.nodes
      .filter((node) => node.node_kind === "statement_row")
      .map((node) => node.row_id),
  );
  const candidate = new Set(
    modelIr.planes.statement.map((node) => node.display_id),
  );
  const missing = [...legacy].filter((id) => !candidate.has(id)).sort();
  const unexpected = [...candidate].filter((id) => !legacy.has(id)).sort();
  const unresolved = modelIr.planes.authority.filter(
    (item) => item.status === "unresolved",
  );
  return {
    schema_version: 1,
    kind: "semantic_shadow_comparison",
    case_id: modelIr.case_id,
    legacy_statement_nodes: legacy.size,
    candidate_statement_nodes: candidate.size,
    missing_display_ids: missing,
    unexpected_display_ids: unexpected,
    unresolved_authorities: unresolved,
    classification:
      missing.length === 0 &&
      unexpected.length === 0 &&
      unresolved.length === 0 &&
      modelIr.proof.status === "PASS"
        ? "compatible"
        : "unknown",
    status:
      missing.length === 0 &&
      unexpected.length === 0 &&
      unresolved.length === 0 &&
      modelIr.proof.status === "PASS"
        ? "PASS"
        : "BLOCK",
  };
}

export function assertModelIrV3Pass(modelIr) {
  if (modelIr.proof.status !== "PASS") {
    throw new Error(
      `Model IR v3 proof blocked:\n- ${modelIr.proof.blocking_findings
        .slice(0, 30)
        .map((item) => `${item.code}: ${item.message}`)
        .join("\n- ")}`,
    );
  }
  return modelIr;
}
