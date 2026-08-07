const SECTIONS = new Set(["income_statement", "cash_flow"]);

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

function isIndentAnchor(row) {
  return (
    row.row_type === "header" ||
    row.style_role === "header" ||
    row.style_role === "total"
  );
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
  const parentOf = new Map();

  for (const row of rows) {
    if (!row.parent_row_id || !byId.has(row.parent_row_id)) continue;
    parentOf.set(row.row_id, row.parent_row_id);
  }
  for (const parent of rows) {
    if (parent.calculation?.operator !== "sum") continue;
    for (const ref of parent.calculation.refs ?? []) {
      const child = byId.get(ref);
      if (
        !child ||
        ref === parent.row_id ||
        parentOf.has(ref) ||
        isIndentAnchor(child)
      ) {
        continue;
      }
      parentOf.set(ref, parent.row_id);
    }
  }

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
    const graphDepth = parentId ? resolve(parentId, next) + 1 : 0;
    const incomeComponentDepth =
      section === "income_statement" && row.style_role !== "subsection" ? 1 : 0;
    const value = Math.max(graphDepth, incomeComponentDepth);
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
  }));
  const errors = [];

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
