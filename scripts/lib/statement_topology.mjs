const SECTIONS = new Set(["income_statement", "cash_flow"]);

// A statement has one economic conclusion even when its forecast happens to be
// solved from a lower or higher anchor.  The conclusion is identified by the
// section's required output concept, then proved through the compiled dependency
// graph; it is never inferred from a physical row, a label or formula fan-out.
// Attribution, EPS, discontinued-operation detail and analytical appendices may
// follow the conclusion in source evidence, but none of them silently becomes a
// second owner merely because another part of the workbook reads it more often.
const SECTION_CONCLUSION_ROLE = Object.freeze({
  income_statement: "net_income",
  cash_flow: "ending_cash",
});

const UNIQUE_VISIBLE_ROLES = Object.freeze({
  income_statement: new Set([
    "revenue",
    "ebit",
    "interest_income",
    "interest_expense",
    "pre_tax_income",
    "tax_expense",
    "net_income",
    "adjusted_ebitda",
  ]),
  cash_flow: new Set([
    "cash_from_operations",
    "cash_from_investing",
    "cash_from_financing",
    "net_change_in_cash",
    "opening_cash",
    "ending_cash",
  ]),
});

// These are deliberate presentation consolidations: their disclosed children
// are brought together even when another immaterial filing line originally sat
// between them. Exempt only the named children from the global source-order
// sequence; the parent and every unrelated issuer line remain ordered and the
// ordinary formula/dependency gates still prove the consolidation.
const SOURCE_ORDER_CONSOLIDATIONS = new Set([
  "change_in_working_capital",
  "capex",
  "change_in_debt",
]);

// Analytical display rows are derived from statement authorities and are
// positioned by dependency anchors, not by the filing line from which their
// numerator or denominator was sourced. Treating a growth, margin or rate row
// as a face-statement authority creates a false inversion when (for example)
// effective tax rate is deliberately shown between PBT and tax expense.
const DERIVED_PRESENTATION_OPERATORS = new Set([
  "growth",
  "ratio",
  "negated_ratio",
]);

// Stable headline economic identities remain level-zero even when an imported
// authority described their visual style as a subsection rather than a total.
// This is semantic, not issuer- or row-specific: EBIT / operating profit is a
// statement result, never an indented component of itself.
const HEADLINE_TOTAL_ROLES = new Set([
  "revenue",
  "gross_profit",
  "operating_profit",
  "ebit",
  "adjusted_ebitda",
  "pre_tax_income",
  "net_income",
  "cash_from_operations",
  "cash_from_investing",
  "cash_from_financing",
  "net_change_in_cash",
  "ending_cash",
]);

function isIndentAnchor(row) {
  return (
    row.row_type === "header" ||
    row.style_role === "header" ||
    row.style_role === "total" ||
    HEADLINE_TOTAL_ROLES.has(row.semantic_role) ||
    DERIVED_PRESENTATION_OPERATORS.has(row.calculation?.operator)
  );
}

function rootIndentDepth(row) {
  // The standardised statement grammar has one visible body level beneath
  // its level-zero headers, totals and ratio readings.  A declared parent at
  // that body level owns level-two constituents.  This is still a projection
  // of semantic role and hierarchy; no physical row or issuer caption is used.
  return isIndentAnchor(row) ? 0 : 1;
}

function dependencyClosure(rows, rootId) {
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const closure = new Set();
  const visit = (rowId) => {
    if (!rowId || closure.has(rowId) || !byId.has(rowId)) return;
    closure.add(rowId);
    for (const ref of byId.get(rowId)?.calculation?.refs ?? []) visit(ref);
  };
  visit(rootId);
  return closure;
}

/**
 * Compile the presentation conclusion from the statement dependency graph.
 *
 * `semantic_role` names the economic concept; the graph proves which displayed
 * node owns it and what feeds it.  Forecast direction is irrelevant: a PBT-led
 * or net-income-led case still presents the same statement conclusion, while an
 * EBITDA appendix remains outside the conclusion closure unless the statement
 * answer genuinely depends on it.
 */
export function compileSectionConclusionOwnership(rows, section) {
  assertSection(section);
  const requiredRole = SECTION_CONCLUSION_ROLE[section];
  const owners = rows.filter(
    (row) =>
      row.row_type !== "header" &&
      row.projection_status !== "evidence_only" &&
      row.semantic_role === requiredRole,
  );
  const owner = owners.length === 1 ? owners[0] : null;
  const closure = owner ? dependencyClosure(rows, owner.row_id) : new Set();
  const errors = [];
  if (owners.length > 1) {
    errors.push({
      code: "MULTIPLE_SECTION_CONCLUSION_OWNERS",
      section,
      semantic_role: requiredRole,
      row_ids: owners.map((row) => row.row_id),
    });
  }
  for (const row of rows) {
    row.section_conclusion_owner = row === owner;
    row.section_conclusion_id = owner?.row_id ?? null;
    row.in_section_conclusion_closure = closure.has(row.row_id);
    if (row === owner) row.presentation_rank = "answer";
    else if (row.presentation_rank === "answer") delete row.presentation_rank;
  }
  return {
    schema_version: "section-conclusion/1.0",
    section,
    required_semantic_role: requiredRole,
    owner_display_id: owner?.row_id ?? null,
    dependency_closure: [...closure],
    errors,
  };
}

function inferPresentationParents(rows) {
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const parentOf = new Map();
  for (const row of rows) {
    if (row.parent_row_id && byId.has(row.parent_row_id)) {
      parentOf.set(row.row_id, row.parent_row_id);
    }
  }
  // Arithmetic may nominate a presentation family only once, during this
  // dedicated compilation pass.  Renderers and later indent logic consume the
  // materialised edge and never infer hierarchy from formulas themselves. A
  // sum qualifies only when another semantic pass explicitly declared it a
  // display parent and its complete member set is already a contiguous
  // parent-first run.  A convenient parent-first SUM such as "Other investing
  // cash flow" remains an arithmetic subtotal; it cannot invent a collapsible
  // visual family merely because two referenced rows happen to follow it.
  for (const parent of rows) {
    if (parent.calculation?.operator !== "sum") continue;
    if (parent.display_role !== "group_parent") continue;
    const parentIndex = rows.indexOf(parent);
    const eligibleRefs = (parent.calculation.refs ?? []).filter((ref) => {
      const child = byId.get(ref);
      return (
        child &&
        ref !== parent.row_id &&
        !parentOf.has(ref) &&
        !isIndentAnchor(child)
      );
    });
    const indexes = eligibleRefs.map((ref) => rows.indexOf(byId.get(ref))).sort((a, b) => a - b);
    const contiguousParentFirst =
      eligibleRefs.length > 0 &&
      eligibleRefs.length === (parent.calculation.refs ?? []).length &&
      indexes.every((index, offset) => index === parentIndex + offset + 1);
    if (!contiguousParentFirst) continue;
    for (const ref of eligibleRefs) {
      parentOf.set(ref, parent.row_id);
    }
  }
  return parentOf;
}

function presentationDepth(rowId, parentOf, byId, visiting = new Set()) {
  if (visiting.has(rowId)) return null;
  const row = byId.get(rowId);
  if (!row || isIndentAnchor(row)) return 0;
  const parentId = parentOf.get(rowId);
  if (!parentId || !byId.has(parentId)) return rootIndentDepth(row);
  const parentDepth = presentationDepth(
    parentId,
    parentOf,
    byId,
    new Set(visiting).add(rowId),
  );
  return parentDepth === null ? null : 1 + parentDepth;
}

/**
 * Materialise the presentation tree as its own compiler product.
 *
 * Once this runs, indentation, outline grouping and row order are projections
 * of `presentation_parent_id`; changing a formula cannot silently re-indent a
 * workbook.  A stable parent-first repair is applied only where the declared
 * tree would otherwise put a child before its parent.
 */
export function materializeStatementPresentationTree(rows, section) {
  assertSection(section);
  const conclusion = compileSectionConclusionOwnership(rows, section);
  const parentOf = inferPresentationParents(rows);
  const initialById = new Map(rows.map((row) => [row.row_id, row]));
  const depths = new Map(
    rows.map((row) => [
      row.row_id,
      presentationDepth(row.row_id, parentOf, initialById),
    ]),
  );
  // A malformed cycle belongs to coverage validation, where it can produce a
  // precise BLOCK result. The presentation compiler must remain bounded and
  // preserve source order so diagnostic and question-flow code can inspect
  // the case instead of spinning while alternately moving two parents.
  const hasCycle = [...depths.values()].some((depth) => depth === null);
  let reordered = false;
  let changed = !hasCycle;
  while (changed) {
    changed = false;
    for (const [childId, parentId] of parentOf) {
      const childIndex = rows.findIndex((row) => row.row_id === childId);
      const parentIndex = rows.findIndex((row) => row.row_id === parentId);
      if (childIndex < 0 || parentIndex < 0 || parentIndex < childIndex) continue;
      const [parent] = rows.splice(parentIndex, 1);
      const nextChildIndex = rows.findIndex((row) => row.row_id === childId);
      rows.splice(nextChildIndex, 0, parent);
      reordered = true;
      changed = true;
      break;
    }
  }
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  for (const row of rows) {
    const parentId = parentOf.get(row.row_id) ?? null;
    row.presentation_parent_id = parentId;
    row.presentation_depth = isIndentAnchor(row)
      ? 0
      : (depths.get(row.row_id) ?? 0);
    // The same materialised edge owns the Excel outline.  No downstream pass
    // may infer grouping from a SUM formula, so arithmetic and presentation
    // cannot drift into competing hierarchies.
    row.outline_level = parentId
      ? Math.max(1, Number(row.presentation_depth ?? 1) - 1)
      : 0;
    row.presentation_role =
      row.row_type === "header"
        ? "header"
        : row.section_conclusion_owner
          ? "answer"
          : row.style_role === "total" || row.row_type === "subtotal"
            ? "subtotal"
          : parentId
            ? "component"
            : row.formula_authority === "compiler"
              ? "consumer"
              : "standalone";
  }
  return {
    section,
    reordered,
    conclusion,
    nodes: rows.map((row, order) => ({
      display_id: row.row_id,
      parent_display_id: row.presentation_parent_id,
      depth: row.presentation_depth,
      display_role: row.presentation_role,
      order,
    })),
  };
}

/**
 * Compile the one presentation hierarchy used by the renderer.
 *
 * Explicit filing hierarchy wins.  Where the filing supplies no parent edge,
 * a visible SUM parent owns its contributing rows.  Physical indentation from
 * an input case is deliberately ignored: indentation is compiled output, not a
 * second source of semantic truth.
 */
export function deriveStatementIndentMap(rows, section) {
  assertSection(section);
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const parentOf = new Map(
    rows
      .filter(
        (row) =>
          row.presentation_parent_id && byId.has(row.presentation_parent_id),
      )
      .map((row) => [row.row_id, row.presentation_parent_id]),
  );

  const depth = new Map();
  const resolve = (rowId, visiting = new Set()) => {
    if (depth.has(rowId)) return depth.get(rowId);
    if (visiting.has(rowId)) {
      // Topology validation reports the malformed parent cycle.  Indentation
      // remains a pure compiler projection and must not pre-empt the coverage
      // gate with an uncaught exception.
      return 0;
    }
    const row = byId.get(rowId);
    if (!row || isIndentAnchor(row)) {
      depth.set(rowId, 0);
      return 0;
    }
    const next = new Set(visiting).add(rowId);
    const parentId = parentOf.get(rowId);
    // Indentation is a projection of the declared hierarchy and the
    // standardised statement grammar.  Level-zero rows are headers, totals and
    // ratio readings; ordinary statement components sit at level one; an
    // explicit parent's children sit one level beneath that parent.
    const value = Number.isInteger(row.presentation_depth)
      ? row.presentation_depth
      : parentId
        ? resolve(parentId, next) + 1
        : rootIndentDepth(row);
    depth.set(rowId, value);
    return value;
  };

  return new Map(rows.map((row) => [row.row_id, resolve(row.row_id)]));
}

function ownsSourceOrder(row) {
  return !DERIVED_PRESENTATION_OPERATORS.has(row.calculation?.operator);
}

function assertSection(section) {
  if (!SECTIONS.has(section)) {
    throw new Error(`Unsupported statement topology section: ${section}.`);
  }
}

function sourceRanks(modelCase, section) {
  const rankByRowId = new Map();
  const sourceRank = new Map();
  for (const [rank, disclosure] of (
    modelCase.source_coverage?.[section] ?? []
  ).entries()) {
    sourceRank.set(disclosure.source_line_id, rank);
    for (const rowId of disclosure.mapped_row_ids ?? []) {
      if (!rankByRowId.has(rowId)) rankByRowId.set(rowId, rank);
    }
  }
  return { rankByRowId, sourceRank };
}

function rowSourceRank(row, ranks) {
  if (!ownsSourceOrder(row)) return null;
  const candidates = [];
  if (ranks.rankByRowId.has(row.row_id)) {
    candidates.push(ranks.rankByRowId.get(row.row_id));
  }
  for (const sourceLineId of row.source_line_ids ?? []) {
    if (ranks.sourceRank.has(sourceLineId)) {
      candidates.push(ranks.sourceRank.get(sourceLineId));
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function moveRowAfter(rows, rowId, anchorId) {
  const rowIndex = rows.findIndex((row) => row.row_id === rowId);
  const anchorIndex = rows.findIndex((row) => row.row_id === anchorId);
  if (rowIndex < 0 || anchorIndex < 0 || rowIndex === anchorIndex + 1) return;
  const [row] = rows.splice(rowIndex, 1);
  const nextAnchorIndex = rows.findIndex((candidate) => candidate.row_id === anchorId);
  rows.splice(nextAnchorIndex + 1, 0, row);
}

function placeCalculationFamily(rows, parent, parentFirst) {
  const refs = new Set(parent.calculation?.refs ?? []);
  if (refs.size === 0) return;
  const familyRows = rows.filter((row) => refs.has(row.row_id));
  if (familyRows.length !== refs.size) return;
  const indexes = rows
    .map((row, index) =>
      row === parent || refs.has(row.row_id) ? index : -1,
    )
    .filter((index) => index >= 0);
  const insertAt = Math.min(...indexes);
  const withoutFamily = rows.filter(
    (row) => row !== parent && !refs.has(row.row_id),
  );
  const family = parentFirst
    ? [parent, ...familyRows]
    : [...familyRows, parent];
  rows.splice(
    0,
    rows.length,
    ...withoutFamily.slice(0, insertAt),
    ...family,
    ...withoutFamily.slice(insertAt),
  );
}

/**
 * Deterministic remedy for the one safe ordering defect: all mapped issuer
 * rows exist, but their visible list was assembled in a different order from
 * source coverage. The remedy changes no values, formulas, roles or mappings;
 * it only restores the source-backed row sequence and then re-applies the
 * declared overlay anchors.
 */
export function repairStatementSourceOrder(modelCase, section, rows) {
  const before = compileStatementTopology(modelCase, section, rows);
  const originalOrder = rows.map((row) => row.row_id);
  if (before.errors.some((error) => error.code === "SOURCE_ORDER_INVERSION")) {
    const ranks = sourceRanks(modelCase, section);
    const slots = rows
      .map((row, index) =>
        rowSourceRank(row, ranks) === null ? -1 : index,
      )
      .filter((index) => index >= 0);
    const ordered = slots
      .map((index, originalIndex) => ({
        row: rows[index],
        rank: rowSourceRank(rows[index], ranks),
        originalIndex,
      }))
      .sort(
        (left, right) =>
          left.rank - right.rank || left.originalIndex - right.originalIndex,
      )
      .map((entry) => entry.row);
    for (const [index, slot] of slots.entries()) rows[slot] = ordered[index];
  }

  if (section === "income_statement") {
    const revenue = rows.find((row) => row.semantic_role === "revenue");
    const growth = rows.find(
      (row) =>
        row.calculation?.operator === "growth" &&
        row.calculation.refs?.includes(revenue?.row_id),
    );
    if (revenue && growth) moveRowAfter(rows, growth.row_id, revenue.row_id);

    const preTax = rows.find((row) => row.semantic_role === "pre_tax_income");
    const taxRate = rows.find(
      (row) => row.semantic_role === "effective_tax_rate",
    );
    if (preTax && taxRate) moveRowAfter(rows, taxRate.row_id, preTax.row_id);
  }

  if (section === "cash_flow") {
    const capex = rows.find((row) => row.semantic_role === "capex");
    if (capex) placeCalculationFamily(rows, capex, true);

    const endingCash = rows.find((row) => row.semantic_role === "ending_cash");
    const freeCashFlowRows = rows.filter(
      (row) =>
        row.row_id === "free_cash_flow_header" ||
        row.row_id === "free_cash_flow" ||
        row.row_id === "free_cash_flow_conversion",
    );
    if (endingCash && freeCashFlowRows.length > 0) {
      const family = new Set(freeCashFlowRows);
      const withoutFamily = rows.filter((row) => !family.has(row));
      const anchorIndex = withoutFamily.findIndex(
        (row) => row.row_id === endingCash.row_id,
      );
      withoutFamily.splice(anchorIndex + 1, 0, ...freeCashFlowRows);
      rows.splice(0, rows.length, ...withoutFamily);
    }
  }

  return {
    repaired: rows.some((row, index) => row.row_id !== originalOrder[index]),
    before,
    after: compileStatementTopology(modelCase, section, rows),
  };
}

function numericHistory(row) {
  return (row.values ?? [])
    .slice(0, 3)
    .some((value) => typeof value === "number" && Number.isFinite(value));
}

function descendantIndexes(rows, parentId) {
  const byParent = new Map();
  for (const [index, row] of rows.entries()) {
    if (!row.parent_row_id) continue;
    if (!byParent.has(row.parent_row_id)) byParent.set(row.parent_row_id, []);
    byParent.get(row.parent_row_id).push(index);
  }
  const indexes = [];
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const index of byParent.get(id) ?? []) {
      indexes.push(index);
      visit(rows[index].row_id);
    }
  };
  visit(parentId);
  return indexes.sort((left, right) => left - right);
}

/**
 * Compile the visible statement-order graph before physical rows exist.
 *
 * The evidence manifest owns issuer row order. Explicit parent edges may turn a
 * source run into a parent-first collapsible family, but no renderer is allowed
 * to append an earlier filing line after a later one. This closes the seam where
 * a plausible generic statement was emitted first and the issuer's remaining
 * rows were appended after net income or free cash flow.
 */
export function compileStatementTopology(modelCase, section, rows) {
  assertSection(section);
  const ranks = sourceRanks(modelCase, section);
  const nodes = rows.map((row, visibleIndex) => ({
    row_id: row.row_id,
    label: row.label,
    visible_index: visibleIndex,
    source_rank: rowSourceRank(row, ranks),
    parent_row_id: row.parent_row_id ?? null,
    semantic_role: row.semantic_role ?? null,
    row_type: row.row_type ?? null,
    projection_origin: row.projection_origin ?? null,
    projection_required_by: row.projection_required_by ?? null,
  }));
  const errors = [];
  const conclusion = compileSectionConclusionOwnership(rows, section);
  errors.push(...conclusion.errors);

  const expectedIndents = deriveStatementIndentMap(rows, section);
  for (const row of rows) {
    const expected = expectedIndents.get(row.row_id) ?? 0;
    const actual = Number(row.indent ?? 0);
    if (actual !== expected) {
      errors.push({
        code: "INDENT_NOT_GRAPH_DERIVED",
        row_id: row.row_id,
        label: row.label,
        expected_indent: expected,
        actual_indent: actual,
      });
    }
  }

  const sourceOrderExemptRows = new Set();
  for (const row of rows) {
    if (!SOURCE_ORDER_CONSOLIDATIONS.has(row.semantic_role)) continue;
    for (const ref of row.calculation?.refs ?? []) {
      sourceOrderExemptRows.add(ref);
    }
    for (const child of rows) {
      if (child.parent_row_id === row.row_id) {
        sourceOrderExemptRows.add(child.row_id);
      }
    }
    for (const index of descendantIndexes(rows, row.row_id)) {
      sourceOrderExemptRows.add(rows[index].row_id);
    }
  }

  let prior = null;
  for (const node of nodes) {
    if (
      node.source_rank === null ||
      sourceOrderExemptRows.has(node.row_id)
    ) {
      continue;
    }
    if (prior && node.source_rank < prior.source_rank) {
      errors.push({
        code: "SOURCE_ORDER_INVERSION",
        row_id: node.row_id,
        label: node.label,
        source_rank: node.source_rank,
        prior_row_id: prior.row_id,
        prior_label: prior.label,
        prior_source_rank: prior.source_rank,
      });
    }
    prior = node;
  }

  const firstSourceIndex = nodes.findIndex((node) => node.source_rank !== null);
  if (firstSourceIndex > 0) {
    for (let index = 0; index < firstSourceIndex; index += 1) {
      const row = rows[index];
      if (row.row_type === "header" || !numericHistory(row)) continue;
      errors.push({
        code: "ORPHAN_NUMERIC_PREFIX",
        row_id: row.row_id,
        label: row.label,
        message:
          "A visible historical row precedes the first face-statement line without source-order ownership.",
      });
    }
  }

  const uniqueRoles = UNIQUE_VISIBLE_ROLES[section];
  const byRole = new Map();
  for (const node of nodes) {
    if (!uniqueRoles.has(node.semantic_role)) continue;
    if (!byRole.has(node.semantic_role)) byRole.set(node.semantic_role, []);
    byRole.get(node.semantic_role).push(node.row_id);
  }
  for (const [role, rowIds] of byRole.entries()) {
    if (rowIds.length <= 1) continue;
    errors.push({
      code: "DUPLICATE_VISIBLE_AUTHORITY",
      semantic_role: role,
      row_ids: rowIds,
    });
  }

  if (section === "income_statement") {
    const netIncomeIndex = nodes.findIndex(
      (node) => node.semantic_role === "net_income",
    );
    for (const node of nodes.slice(netIncomeIndex + 1)) {
      if (netIncomeIndex < 0 || node.projection_origin) continue;
      errors.push({
        code: "PROJECTION_NECESSITY_UNDECLARED",
        row_id: node.row_id,
        label: node.label,
        message:
          "A post-net-income row is visible without a required economic output, dependency, derived-display or block-header reason.",
      });
    }
    const allStatementRows = [
      ...(modelCase.statement_structure?.income_statement ?? []),
      ...(modelCase.statement_structure?.cash_flow ?? []),
    ];
    const allById = new Map(
      allStatementRows.map((row) => [row.row_id, row]),
    );
    const localById = new Map(rows.map((row) => [row.row_id, row]));
    const rules = (row) => [
      row?.calculation,
      row?.forecast_calculation,
      ...(row?.forecast_period_calculations ?? []),
    ].filter(Boolean);
    for (const node of nodes.slice(netIncomeIndex + 1)) {
      if (!node.projection_origin) continue;
      const row = localById.get(node.row_id);
      const requiredBy = node.projection_required_by;
      let valid = typeof requiredBy === "string" && requiredBy.length > 0;
      if (node.projection_origin === "required_block_header") {
        const ownerIndex = rows.findIndex(
          (candidate) => candidate.row_id === requiredBy,
        );
        valid =
          valid &&
          row?.row_type === "header" &&
          ownerIndex > node.visible_index;
      } else if (node.projection_origin === "required_economic_output") {
        valid =
          valid &&
          row?.row_type !== "header" &&
          Boolean(row?.semantic_role) &&
          requiredBy === "debt_overlay_contract";
      } else if (
        node.projection_origin === "dependency_closure" ||
        node.projection_origin === "downstream_dependency"
      ) {
        const owner = localById.get(requiredBy) ?? allById.get(requiredBy);
        valid =
          valid &&
          rules(owner).some((rule) => rule.refs?.includes(node.row_id));
      } else if (node.projection_origin === "derived_display") {
        valid =
          valid &&
          rules(row).some((rule) => rule.refs?.includes(requiredBy));
      }
      if (!valid) {
        errors.push({
          code: "PROJECTION_NECESSITY_INVALID",
          row_id: node.row_id,
          label: node.label,
          projection_origin: node.projection_origin,
          projection_required_by: requiredBy ?? null,
          message:
            "A post-net-income projection claim is not proved by the declared semantic dependency.",
        });
      }
    }
  }

  const indexById = new Map(rows.map((row, index) => [row.row_id, index]));
  for (const [parentIndex, parent] of rows.entries()) {
    const descendants = descendantIndexes(rows, parent.row_id);
    if (descendants.length === 0) continue;
    if (descendants[0] <= parentIndex) {
      errors.push({
        code: "CHILD_BEFORE_PARENT",
        parent_row_id: parent.row_id,
        child_row_ids: descendants.map((index) => rows[index].row_id),
      });
      continue;
    }
    const expected = Array.from(
      { length: descendants.length },
      (_, offset) => parentIndex + offset + 1,
    );
    if (
      descendants.length !== expected.length ||
      descendants.some((index, offset) => index !== expected[offset])
    ) {
      errors.push({
        code: "NON_CONTIGUOUS_FAMILY",
        parent_row_id: parent.row_id,
        parent_index: parentIndex,
        child_indexes: descendants,
        child_row_ids: descendants.map((index) => rows[index].row_id),
      });
    }
    for (const index of descendants) {
      if (!indexById.has(rows[index].parent_row_id)) {
        errors.push({
          code: "ORPHAN_CHILD",
          row_id: rows[index].row_id,
          parent_row_id: rows[index].parent_row_id,
        });
      }
    }
  }

  const edges = [];
  for (const node of nodes) {
    if (node.parent_row_id) {
      edges.push({
        edge_type: "presented_under",
        from: node.row_id,
        to: node.parent_row_id,
      });
    }
  }
  for (let index = 1; index < nodes.length; index += 1) {
    edges.push({
      edge_type: "visible_successor",
      from: nodes[index - 1].row_id,
      to: nodes[index].row_id,
    });
  }

  return {
    schema_version: "statement-topology/1.0",
    section,
    section_conclusion: conclusion,
    nodes,
    edges,
    errors,
  };
}

export function assertStatementTopology(modelCase, section, rows) {
  const topology = compileStatementTopology(modelCase, section, rows);
  if (topology.errors.length > 0) {
    const summary = topology.errors
      .slice(0, 8)
      .map((error) => `${error.code}:${error.row_id ?? error.semantic_role ?? error.parent_row_id ?? "unknown"}`)
      .join(", ");
    throw new Error(
      `${section} visible statement topology is invalid (${topology.errors.length}): ${summary}.`,
    );
  }
  return topology;
}

export default {
  compileStatementTopology,
  assertStatementTopology,
  repairStatementSourceOrder,
  deriveStatementIndentMap,
};
