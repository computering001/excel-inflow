import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  CONVERGENCE_CONTRACT,
  EQUATION_GRAPH,
  canonicalJsonSha256,
} from "./equation_graph.mjs";
import { ECONOMIC_SOLVE_POLICY } from "./economic_solve_policy.mjs";
import {
  attachShadowEconomicIr,
  economicIrReceiptBinding,
} from "./economic_ir.mjs";
import {
  declaredUnitMagnitude,
  filedCellAssertion,
  filedNumber,
  printedUnitMagnitude,
  rowSourceTolerance,
} from "./source_tolerance.mjs";

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
 * The protected-identity role set is a declared asset, not a literal buried in
 * the contract compiler: every rendered statement row carrying one of these
 * semantic roles must have its formula identity bound and proven in the
 * emitted workbook. Membership is pinned by
 * scripts/run_statement_family_residual_tests.mjs — roles may be added, never
 * removed, so the check can only strengthen.
 */
export const PROTECTED_IDENTITY_ROLES = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../../assets/protected-identity-roles-v1.json", import.meta.url),
      "utf8",
    ),
  ).protected_identity_roles,
);

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
  // ---- Statement-family footing (P2.5) -----------------------------------
  // A statement-family total that carries an independently filed series —
  // source_input on the face, or the retained reported series behind a
  // reconciled total — must foot against its members. This is a validator:
  // it refuses (material) or records (immaterial / unverifiable), it never
  // repairs a number, and a missing member value is never coerced to zero.
  const planStatementRows = ["income_statement", "cash_flow"].flatMap(
    (section) => rowPlan?.statement_rows?.[section] ?? [],
  );
  const planRowById = new Map(planStatementRows.map((row) => [row.row_id, row]));
  const familyMemberIds = new Map();
  for (const row of planStatementRows) {
    if (!row.parent_row_id) continue;
    const members = familyMemberIds.get(row.parent_row_id) ?? [];
    members.push(row.row_id);
    familyMemberIds.set(row.parent_row_id, members);
  }
  const materialDisplayIds = new Set(
    authority
      .filter((item) => item.material === true)
      .map((item) => item.display_id),
  );
  // `filedNumber`, `filedCellAssertion` and the footing tolerance all come
  // from source_tolerance.mjs (P2.10). This comment used to CLAIM the tolerance
  // mirrored the case compiler's `sourceTolerance` while in fact adding
  // `1e-9 * max(1, |target|)` the compiler did not have: on 12.3 + 45.6 against
  // a printed 57.9 the compiler reported a mis-footing and this pass reported
  // none, and at a printed total of 500,000,000 with precision 0 the same
  // epsilon doubled the half-unit allowance so a genuine ONE-UNIT break passed
  // here. There is now one tolerance, in one home, and both oracles consume it
  // — see defect register D5.
  const footingTolerance = (row, period, target, terms) =>
    rowSourceTolerance(row, period, { target, terms });
  for (const row of planStatementRows) {
    const declaredFamilyTotal =
      ["reported_parent", "derived_from_children"].includes(
        row.aggregation_authority,
      ) ||
      row.historical_authority === "reported_total_reconciled" ||
      familyMemberIds.has(row.row_id);
    if (!declaredFamilyTotal) continue;
    const memberIds =
      familyMemberIds.get(row.row_id) ??
      (row.calculation?.operator === "sum"
        ? (row.calculation.refs ?? []).filter((id) => id !== row.row_id)
        : []);
    if (memberIds.length === 0) {
      warnings.push(
        finding(
          "STATEMENT_FAMILY_EMPTY_MEMBER_SET",
          `${row.row_id} declares a statement family but names no members; nothing can foot it.`,
          { display_ids: [row.row_id] },
        ),
      );
      continue;
    }
    const filedTarget =
      row.historical_authority === "reported_total_reconciled"
        ? row.reported_historical_values
        : row.historical_authority === "source_input" ||
            ["input", "uncalculated"].includes(row.row_type)
          ? row.values
          : null;
    // Formula-owned totals (derived_formula) assert no independent filed
    // series — the minted sum IS the total, so there is nothing to foot.
    if (!Array.isArray(filedTarget)) continue;
    const material = materialDisplayIds.has(row.row_id);
    // A member contributes to face footing only through its FILED series:
    // source_input rows carry it in values, reconciled totals in
    // reported_historical_values. Schedule-owned (schedule_link) and
    // formula-owned (derived_formula & friends) member caches are model
    // projections — the waterfall lane restates interest history to the
    // reconciled reported-interest basis, and derived rows cache evaluated
    // identities — so they are never summed as if filed; their footing is
    // delegated to the owning schedule/derivation contract and RECORDED.
    const memberFiledState = (memberId, period) => {
      const member = planRowById.get(memberId);
      if (!member) return { state: "missing" };
      const memberAuthority = member.historical_authority ?? null;
      if (memberAuthority === "reported_total_reconciled") {
        const value = filedNumber(member.reported_historical_values?.[period]);
        return value === null ? { state: "missing" } : { state: "filed", value };
      }
      const faceOwned =
        memberAuthority === "source_input" ||
        (memberAuthority === null &&
          !member.calculation &&
          ["input", "uncalculated"].includes(member.row_type));
      if (!faceOwned) return { state: "non_face" };
      const value = filedNumber(member.values?.[period]);
      return value === null ? { state: "missing" } : { state: "filed", value };
    };
    // Which of the row's two filed series the target came from decides which
    // classification the cell must carry.
    const targetRow =
      row.historical_authority === "reported_total_reconciled"
        ? { value_states: row.reported_historical_value_states }
        : { value_states: row.historical_value_states ?? row.value_states };
    for (let period = 0; period < 3; period += 1) {
      const target = filedNumber(filedTarget[period]);
      if (target === null) {
        // A DECLARED absence asserts nothing and stays silent — that is the
        // never-zero invariant working, and it must not become a failure.
        // An UNCLASSIFIED cell is a different thing: nothing forced the case to
        // say whether the glyph was a reported nil or a blank, so a genuine
        // reported nil used to escape the footing pass entirely (a total filed
        // as three dashes against members summing to 30 compiled PASS with
        // zero findings). The absence of a classification is itself the defect
        // — typed here, never resolved to zero and never guessed. Defect
        // register D6.
        const assertion = filedCellAssertion(
          targetRow,
          period,
          filedTarget[period],
        );
        if (assertion.kind === "declared_absent") continue;
        const unclassified = finding(
          "STATEMENT_FAMILY_UNCLASSIFIED_FILED_CELL",
          assertion.reason === "printed_glyph_unclassified"
            ? `${row.row_id} carries a printed cell in historical period ${period + 1} whose state ${assertion.state} declares no numeric reading; a printed glyph must be classified as a reported nil or a declared absence before its family can be footed.`
            : assertion.reason === "value_bearing_state_over_empty_cell"
              ? `${row.row_id} classifies historical period ${period + 1} as ${assertion.state}, but the cell carries no number; the classification contradicts the filed series.`
              : `${row.row_id} files no value in historical period ${period + 1} and declares no classification for it; an unclassified cell is neither a reported nil nor a declared absence, so its family cannot be footed (it is never read as zero).`,
          {
            display_ids: [row.row_id, ...memberIds],
            period,
            declared_state: assertion.state,
            reason: assertion.reason,
          },
        );
        (material ? blockers : warnings).push(unclassified);
        continue;
      }
      const memberStates = memberIds.map((memberId) =>
        memberFiledState(memberId, period),
      );
      if (memberStates.some((item) => item.state !== "filed")) {
        if (material) {
          const nonFace = memberStates.some((item) => item.state === "non_face");
          warnings.push(
            finding(
              "STATEMENT_FAMILY_UNFOOTABLE_PERIOD",
              nonFace
                ? `${row.row_id} asserts a material filed total in historical period ${period + 1}, but member history is schedule- or formula-owned; face footing is delegated to the owning schedule/derivation contract (compiled caches are never treated as the filed series).`
                : `${row.row_id} asserts a material filed total in historical period ${period + 1}, but a member value is missing; the footing cannot be verified (missing values are never treated as zero).`,
              {
                display_ids: [row.row_id, ...memberIds],
                period,
                reason: nonFace
                  ? "non_face_member_history"
                  : "missing_member_value",
              },
            ),
          );
        }
        continue;
      }
      const memberTerms = memberStates.map((item) => item.value);
      const membersSum = memberTerms.reduce((sum, value) => sum + value, 0);
      if (
        Math.abs(membersSum - target) >
        footingTolerance(row, period, target, memberTerms)
      ) {
        const unfooted = finding(
          "STATEMENT_FAMILY_UNFOOTED_TOTAL",
          `${row.row_id} prints ${target} in historical period ${period + 1}, but its ${memberIds.length} members sum to ${Number(membersSum.toFixed(6))}; a ${material ? "material" : "immaterial"} family total must foot against its members.`,
          {
            display_ids: [row.row_id, ...memberIds],
            period,
            filed: target,
            members_sum: membersSum,
          },
        );
        (material ? blockers : warnings).push(unfooted);
      }
    }
  }
  // ---- Declared-vs-printed unit scale (P2.10 / D9) -----------------------
  // A PARTIAL unit mis-scale mis-foots, so the pass above refuses it. A UNIFORM
  // one is invisible to footing BY CONSTRUCTION: every member and its total are
  // in the same wrong scale, so every identity holds exactly and the whole
  // model is out by 1000x. Rewriting standard-maximal-v2's printed unit
  // witnesses from "USD millions" to "USD thousands" changed not one finding.
  //
  // P2.1 landed the reconciliation on the extraction side
  // (scripts/extract_filing_statements.py reconcile_unit_labels ->
  // UNIT_LABEL_MISMATCH / UNIT_LABEL_UNPARSED), but that pass only sees a
  // filing it extracted itself; a case that reached the compiler by any other
  // route has never been reconciled. The compile boundary therefore reconciles
  // the witness the CASE carries — provenance[row][].units, which the contract
  // requires on every provenance entry — against the single declared basis
  // issuer.units, reading a label with the same vocabulary the Python side uses.
  //
  // This is a validator: it keeps the declaration and refuses. It never rescales
  // a number, never rewrites issuer.units, and never invents a witness a case
  // does not carry.
  const declaredUnits = declaredUnitMagnitude(modelCase?.issuer?.units);
  const printedUnitWitnesses = new Map();
  const unparsedUnitWitnesses = new Map();
  for (const [rowId, entries] of Object.entries(modelCase?.provenance ?? {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const label = entry?.units;
      if (typeof label !== "string" || label.trim() === "") continue;
      const printed = printedUnitMagnitude(label);
      const bucket = printed === null ? unparsedUnitWitnesses : printedUnitWitnesses;
      const key = printed ?? label;
      if (!bucket.has(key)) bucket.set(key, { labels: new Set(), rows: new Set() });
      bucket.get(key).labels.add(label);
      bucket.get(key).rows.add(rowId);
    }
  }
  const printedMagnitudes = [...printedUnitWitnesses.keys()];
  if (printedMagnitudes.length > 1) {
    // The honest refusal: `issuer.units` is ONE enumerated scalar, so a filing
    // printing two magnitudes has no lawful representation in the case contract
    // (defect register D7c). Naming the limitation is the correct treatment —
    // inventing a per-statement unit field here, or silently electing one of
    // the printed magnitudes as the winner, would both be worse.
    blockers.push(
      finding(
        "UNIT_SCALE_PER_STATEMENT_UNREPRESENTABLE",
        `The case's printed unit witnesses assert ${printedMagnitudes.length} different magnitudes (${printedMagnitudes.join(", ")}), but issuer.units is a single scalar for the whole case; a per-statement unit scale is UNREPRESENTABLE in the case contract, so no scale can be elected here.`,
        {
          printed_magnitudes: printedMagnitudes,
          declared_units: declaredUnits,
          contract_limitation: "issuer.units_is_a_single_scalar",
          display_ids: [
            ...new Set(
              printedMagnitudes.flatMap((magnitude) => [
                ...printedUnitWitnesses.get(magnitude).rows,
              ]),
            ),
          ].sort(portableCompare),
        },
      ),
    );
  }
  if (declaredUnits !== null) {
    for (const magnitude of printedMagnitudes) {
      if (magnitude === declaredUnits) continue;
      const witness = printedUnitWitnesses.get(magnitude);
      const rows = [...witness.rows].sort(portableCompare);
      blockers.push(
        finding(
          "DECLARED_UNIT_SCALE_CONTRADICTED",
          `${rows.length} row(s) carry a printed unit witness in ${magnitude} (${[...witness.labels].sort(portableCompare).join(", ")}) while the case declares issuer.units ${declaredUnits}; a uniform scale contradiction foots perfectly and can never be caught by footing. The declaration is kept, not repaired.`,
          {
            printed_units: magnitude,
            declared_units: declaredUnits,
            display_ids: rows,
          },
        ),
      );
    }
  }
  for (const [label, witness] of unparsedUnitWitnesses) {
    // Inability to verify RECORDS; only a proven contradiction refuses. A
    // provenance unit witness is free text, so an unreadable label proves
    // nothing about the scale — the fail-closed reading of a printed unit
    // HEADER belongs to extraction, which can see the page.
    warnings.push(
      finding(
        "PRINTED_UNIT_WITNESS_UNPARSED",
        `The printed unit witness "${label}" does not parse to a magnitude, so it cannot be reconciled against the declared basis ${declaredUnits ?? "(undeclared)"}; the scale is unverified, never assumed.`,
        {
          label,
          declared_units: declaredUnits,
          display_ids: [...witness.rows].sort(portableCompare),
        },
      ),
    );
  }
  // A rendered row carrying a protected identity role with an EMPTY member
  // set would silently receive no workbook identity protection; record it.
  const protectedRoles = new Set(PROTECTED_IDENTITY_ROLES);
  const statementMemberEdges = new Map();
  for (const edge of calculationEdges) {
    let consumerNodeId;
    let dependencyNodeId;
    if (edge.edge_type === "depends_on") {
      consumerNodeId = edge.from;
      dependencyNodeId = edge.to;
    } else if (edge.edge_type === "contributes_to") {
      consumerNodeId = edge.to;
      dependencyNodeId = edge.from;
    } else {
      continue;
    }
    if (
      !consumerNodeId.startsWith("statement.") ||
      !dependencyNodeId.startsWith("statement.") ||
      consumerNodeId === dependencyNodeId
    ) continue;
    const consumer = consumerNodeId.slice("statement.".length);
    statementMemberEdges.set(
      consumer,
      (statementMemberEdges.get(consumer) ?? 0) + 1,
    );
  }
  for (const node of statementNodes) {
    if (node.projection_status !== "rendered") continue;
    if (!protectedRoles.has(node.semantic_role)) continue;
    if ((statementMemberEdges.get(node.row_id) ?? 0) > 0) continue;
    warnings.push(
      finding(
        "PROTECTED_IDENTITY_EMPTY_MEMBER_SET",
        `${node.row_id} carries protected identity role ${node.semantic_role} but its member set is empty; the workbook identity check cannot bind it.`,
        { display_ids: [node.row_id] },
      ),
    );
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
  const proofProjection = {
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
  // ---- Economic IR, SHADOW (P3.1) ----------------------------------------
  // The canonical economic object — one node per economic concept, every value
  // slot a TYPED financial value, plus the typed schedule state this projection
  // omits — is compiled, sealed and hashed here, beside the proof projection.
  // It is attached NON-ENUMERABLY: JSON.stringify skips it, so the emitted
  // .model-ir-v3.json sidecar, transformationReceipt().output_sha256 and the
  // workbook proof contract's model_ir_sha256/closure_sha256 are byte-identical
  // to the tree before P3.1. It changes no decision, no finding and no emitted
  // number, and a shadow that cannot compile is recorded, never thrown.
  attachShadowEconomicIr(proofProjection, {
    modelCase,
    rowPlan,
    semanticManifest,
  });
  return proofProjection;
}

export function transformationReceipt(modelIr, outputKind = "model_ir_v3") {
  const pass = (pass_name, input_hash, output, detail = {}) => ({
    pass_name,
    input_hash,
    output_hash: sha256(output),
    ...detail,
  });
  // P3.1: the shadow Economic IR's seal is RECORDED here. output_sha256 above
  // still hashes the proof projection alone (the shadow is non-enumerable), so
  // the two hashes are independent statements about two different objects.
  const economicIr = economicIrReceiptBinding(modelIr);
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
    economic_ir_sha256: economicIr.sha256,
    economic_ir: economicIr,
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
  // Uniqueness must be judged with the SAME normalisation the oracle uses to
  // resolve labels (verify/workbook_semantic_oracle.py normalise_label), or a
  // punctuation-differing pair — "Net income $" on the income statement and
  // "Net income" opening a US indirect cash flow — counts as two unique names
  // here while resolving to one name there, minting a rule no workbook can
  // satisfy.
  const normalisedLabel = (node) =>
    String(node?.label ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const labelCounts = new Map();
  for (const node of modelIr.planes.statement) {
    const key = normalisedLabel(node);
    if (key) labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  const uniquelyNamed = (node) =>
    node && labelCounts.get(normalisedLabel(node)) === 1;

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
  const graphNodeById = new Map(
    graphNodes.map((node) => [node.display_id, node]),
  );
  const protectedIdentityRoles = new Set(PROTECTED_IDENTITY_ROLES);
  const roleProtectedFormulaIdentities = graphNodes.flatMap((node) => {
    if (!protectedIdentityRoles.has(node.semantic_role)) return [];
    const memberRows = authorisedDependencyEdges
      .filter(
        (edge) =>
          edge.consumer_display_id === node.display_id &&
          edge.dependency_display_id !== node.display_id,
      )
      .map((edge) => graphNodeById.get(edge.dependency_display_id)?.row)
      .filter(Number.isInteger);
    const uniqueMemberRows = [...new Set(memberRows)].sort((a, b) => a - b);
    if (uniqueMemberRows.length === 0) return [];
    return [{
      concept_id: node.semantic_role,
      owner_row: node.row,
      member_rows: uniqueMemberRows,
      columns: ["J", "K", "L"],
      period_relation: "same_period",
    }];
  });
  const physicalStatementRows = ["income_statement", "cash_flow"].flatMap(
    (section) => rowPlan.statement_rows?.[section] ?? [],
  );
  const physicalStatementById = new Map(
    physicalStatementRows.map((row) => [row.row_id, row]),
  );
  const historicalColumns = rowPlan.columns?.historical ?? ["G", "H", "I"];
  const reconciledHistoricalIdentities = graphNodes.flatMap((node) => {
    const row = physicalStatementById.get(node.display_id);
    const refs = row?.calculation?.refs ?? [];
    if (
      row?.historical_authority !== "reported_total_reconciled" ||
      row?.calculation?.operator !== "sum" ||
      refs.length === 0
    ) return [];
    const memberRows = refs.map((ref) => physicalRow(ref));
    if (memberRows.some((memberRow) => !Number.isInteger(memberRow))) return [];
    return [{
      concept_id: `reported_total_reconciled:${node.display_id}`,
      owner_row: node.row,
      member_rows: [...new Set(memberRows)].sort((a, b) => a - b),
      columns: [...historicalColumns],
      period_relation: "same_period",
    }];
  });
  const protectedFormulaIdentities = [
    ...roleProtectedFormulaIdentities,
    ...reconciledHistoricalIdentities,
  ].sort((left, right) => portableCompare(left.concept_id, right.concept_id));
  const authorityByDisplayPeriod = new Map(
    modelIr.planes.authority.map((item) => [
      `${item.display_id}\u0000${item.forecast_index}`,
      item,
    ]),
  );
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
    protected_formula_identities: protectedFormulaIdentities,
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
