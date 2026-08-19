import {
  assertValidEquationGraphRowBinding,
  canonicalJsonSha256,
  EQUATION_GRAPH,
} from "./equation_graph.mjs";
import { resolveForecastAuthority } from "./forecast_authority.mjs";
import { hashValue } from "./run_store.mjs";

export const LAYERED_GRAPH_CONSTITUTION_VERSION =
  "layered-graph-constitution/1.1";

export const ROW_PLAN_PROJECTION_SCOPE =
  "statement-row-projection/1.0";

export const ECONOMIC_STATEMENT_BINDING_SCOPE =
  "economic-statement-binding/1.0";

const STATEMENT_SECTIONS = Object.freeze(["income_statement", "cash_flow"]);

/**
 * The canonical relation between the equation graph and the statement layer.
 *
 * Before this register the economic layer minted one `economic:<node>` node per
 * equation-graph node and NOT ONE edge leaving the layer, so the four sealed
 * graphs (equation graph, semantic manifest, layered constitution, run
 * constitution) could disagree about a shared node in silence: renaming
 * `statement.net_income`'s role, deleting `cash.ending_balance` outright, or
 * drifting a statement row's `semantic_role` away from the equation role all
 * left the constitution PASS with a byte-identical economic layer hash.
 *
 * Every equation-graph node MUST appear here exactly once. The disposition says
 * how the node reaches a physical row:
 *
 * - `statement_row`   — realised by one row of `statement_rows.{income_statement,
 *                       cash_flow}`, joined on the declared (section,
 *                       semantic_role) pair and EDGE-BOUND in the economic
 *                       layer. `presence: "required"` marks the nodes whose
 *                       statement row is already mandatory downstream (the
 *                       convergence contract's active SCC members that
 *                       `model_ir_v3` binds through `statementRowFor`, where a
 *                       missing row throws at proof-contract compile time);
 *                       every other statement row is a lawful case variant and
 *                       its absence is recorded, not blocked.
 * - `solver_control`  — the circularity control. It carries no economic
 *                       quantity and owns no row by construction.
 * - `schedule_row`    — realised in a schedule row (`interest_summary_rows`,
 *                       `waterfall_rows`, `debt_summary_rows`, `instruments[]`)
 *                       that the layered constitution carries NO layer for.
 *                       This is the declared coverage gap, not silence: each
 *                       entry names the row family that owns it.
 *
 * `join_basis` records where the pairing comes from so the register is auditable
 * rather than asserted: `model_ir_crosswalk` reproduces the binding
 * `model_ir_v3.mjs:1315-1412` already uses for the workbook proof contract,
 * `role_identity` means the equation role and the statement `semantic_role` are
 * the same declared token, and `etr_path` are P3.3's four tax nodes.
 *
 * `role_collision_owner` is required wherever a `schedule_row` node's role is
 * ALSO a statement `semantic_role` owned by a different equation node — the one
 * live case is `interest.income` (role `interest_income`), whose income-statement
 * row is realised by `statement.finance_income`. Declaring the owner is what
 * stops a name coincidence from being mistaken for a binding.
 */
export const ECONOMIC_STATEMENT_BINDING = Object.freeze({
  "cash.cash_interest_paid": Object.freeze({
    role: "cash_interest_paid",
    disposition: "statement_row",
    section: "cash_flow",
    semantic_role: "cash_interest_paid",
    presence: "case_optional",
    join_basis: "role_identity",
  }),
  "cash.cash_interest_received": Object.freeze({
    role: "cash_interest_received",
    disposition: "statement_row",
    section: "cash_flow",
    semantic_role: "cash_interest_received",
    presence: "case_optional",
    join_basis: "role_identity",
  }),
  "cash.cfo": Object.freeze({
    role: "cash_from_operations",
    disposition: "statement_row",
    section: "cash_flow",
    semantic_role: "cash_from_operations",
    presence: "required",
    join_basis: "model_ir_crosswalk",
  }),
  "cash.ending_balance": Object.freeze({
    role: "ending_cash",
    disposition: "statement_row",
    section: "cash_flow",
    semantic_role: "ending_cash",
    presence: "required",
    join_basis: "model_ir_crosswalk",
  }),
  "cash.minimum_cash": Object.freeze({
    role: "minimum_cash",
    disposition: "schedule_row",
    row_family: "cash_waterfall",
    schedule_row: "waterfall_rows.minimum_cash",
  }),
  "cash.net_finance_addback": Object.freeze({
    role: "net_finance_addback",
    disposition: "statement_row",
    section: "cash_flow",
    semantic_role: "net_finance_addback",
    presence: "case_optional",
    join_basis: "model_ir_crosswalk",
  }),
  "cash.noncash_interest_addback": Object.freeze({
    role: "noncash_interest_addback",
    disposition: "statement_row",
    section: "cash_flow",
    semantic_role: "non_cash_interest_addback",
    presence: "case_optional",
    join_basis: "model_ir_crosswalk",
  }),
  "control.circularity": Object.freeze({
    role: "circularity_control",
    disposition: "solver_control",
  }),
  "debt.issuance": Object.freeze({
    role: "debt_issuance",
    disposition: "statement_row",
    section: "cash_flow",
    semantic_role: "debt_issuance",
    presence: "case_optional",
    join_basis: "model_ir_crosswalk",
  }),
  "debt.mandatory_repayment": Object.freeze({
    role: "mandatory_repayment",
    disposition: "schedule_row",
    row_family: "debt_schedule",
    schedule_row: "debt_summary_rows.mandatory_debt_repayments",
  }),
  "debt.maturity_repayment": Object.freeze({
    role: "maturity_repayment",
    disposition: "schedule_row",
    row_family: "instrument",
    schedule_row: "instruments[].repayment_row",
  }),
  "debt.pik_accretion": Object.freeze({
    role: "instrument_pik_principal_accretion",
    disposition: "schedule_row",
    row_family: "instrument",
    schedule_row: "instruments[].pik_row",
  }),
  "debt.scheduled_amortisation": Object.freeze({
    role: "scheduled_amortisation",
    disposition: "schedule_row",
    row_family: "instrument",
    schedule_row: "instruments[].amortisation_row",
  }),
  "interest.acquisition": Object.freeze({
    role: "acquisition_interest",
    disposition: "schedule_row",
    row_family: "acquisition",
    schedule_row: "interest_summary_rows.acquisition_interest",
  }),
  "interest.cash_income": Object.freeze({
    role: "cash_interest_income",
    disposition: "schedule_row",
    row_family: "interest_schedule",
    schedule_row: "interest_summary_rows.interest_income_schedule",
  }),
  "interest.commitment_fee": Object.freeze({
    role: "rcf_commitment_fee",
    disposition: "schedule_row",
    row_family: "interest_schedule",
    schedule_row: "interest_summary_rows.rcf_commitment_fee",
  }),
  "interest.gross_expense": Object.freeze({
    role: "gross_interest_expense",
    disposition: "schedule_row",
    row_family: "interest_schedule",
    schedule_row: "interest_summary_rows.gross_interest_expense",
  }),
  "interest.income": Object.freeze({
    role: "interest_income",
    disposition: "schedule_row",
    row_family: "interest_schedule",
    schedule_row: "interest_summary_rows.interest_income_schedule",
    role_collision_owner: "statement.finance_income",
  }),
  "interest.instrument_cash": Object.freeze({
    role: "instrument_cash_interest",
    disposition: "schedule_row",
    row_family: "instrument",
    schedule_row: "instruments[].interest_row",
  }),
  "interest.instrument_pik": Object.freeze({
    role: "instrument_pik_interest",
    disposition: "schedule_row",
    row_family: "instrument",
    schedule_row: "instruments[].pik_interest_row",
  }),
  "interest.lease": Object.freeze({
    role: "lease_interest",
    disposition: "schedule_row",
    row_family: "lease",
    schedule_row: "interest_summary_rows.lease_interest",
  }),
  "interest.net_expense": Object.freeze({
    role: "net_interest_expense",
    disposition: "schedule_row",
    row_family: "interest_schedule",
    schedule_row: "interest_summary_rows.net_interest_expense",
  }),
  "interest.noncash": Object.freeze({
    role: "noncash_interest",
    disposition: "schedule_row",
    row_family: "interest_schedule",
    schedule_row: "interest_summary_rows.non_cash_interest",
  }),
  "interest.other": Object.freeze({
    role: "other_interest",
    disposition: "schedule_row",
    row_family: "interest_schedule",
    schedule_row: "interest_summary_rows.other_unallocated_interest",
  }),
  "interest.rcf": Object.freeze({
    role: "rcf_interest",
    disposition: "schedule_row",
    row_family: "interest_schedule",
    schedule_row: "interest_summary_rows.rcf_interest",
  }),
  "lease.principal": Object.freeze({
    role: "lease_principal",
    disposition: "statement_row",
    section: "cash_flow",
    semantic_role: "lease_principal",
    presence: "case_optional",
    join_basis: "model_ir_crosswalk",
  }),
  "rcf.capacity": Object.freeze({
    role: "rcf_capacity",
    disposition: "schedule_row",
    row_family: "cash_waterfall",
    schedule_row: "unbound_in_model_ir_live_when_off_bindings",
  }),
  "rcf.draw": Object.freeze({
    role: "rcf_draw",
    disposition: "statement_row",
    section: "cash_flow",
    semantic_role: "rcf_draw",
    presence: "case_optional",
    join_basis: "role_identity",
  }),
  "rcf.ending_balance": Object.freeze({
    role: "ending_rcf",
    disposition: "schedule_row",
    row_family: "cash_waterfall",
    schedule_row: "waterfall_rows.ending_rcf",
  }),
  "rcf.liquidity_shortfall": Object.freeze({
    role: "liquidity_shortfall",
    disposition: "schedule_row",
    row_family: "cash_waterfall",
    schedule_row: "waterfall_rows.liquidity_shortfall",
  }),
  "rcf.repayment": Object.freeze({
    role: "rcf_repayment",
    disposition: "statement_row",
    section: "cash_flow",
    semantic_role: "rcf_repayment",
    presence: "case_optional",
    join_basis: "role_identity",
  }),
  "statement.cash_flow_start": Object.freeze({
    role: "cash_flow_start",
    disposition: "statement_row",
    section: "cash_flow",
    semantic_role: "cash_flow_net_income",
    presence: "required",
    join_basis: "model_ir_crosswalk",
  }),
  "statement.ebit": Object.freeze({
    role: "ebit",
    disposition: "statement_row",
    section: "income_statement",
    semantic_role: "ebit",
    presence: "case_optional",
    join_basis: "role_identity",
  }),
  "statement.effective_tax_rate": Object.freeze({
    role: "effective_tax_rate",
    disposition: "statement_row",
    section: "income_statement",
    semantic_role: "effective_tax_rate",
    presence: "case_optional",
    join_basis: "etr_path",
  }),
  "statement.finance_expense": Object.freeze({
    role: "income_statement_finance_expense",
    disposition: "statement_row",
    section: "income_statement",
    semantic_role: "interest_expense",
    presence: "required",
    join_basis: "model_ir_crosswalk",
  }),
  "statement.finance_income": Object.freeze({
    role: "income_statement_finance_income",
    disposition: "statement_row",
    section: "income_statement",
    semantic_role: "interest_income",
    presence: "required",
    join_basis: "model_ir_crosswalk",
  }),
  "statement.net_income": Object.freeze({
    role: "net_income",
    disposition: "statement_row",
    section: "income_statement",
    semantic_role: "net_income",
    presence: "case_optional",
    join_basis: "etr_path",
  }),
  "statement.pre_tax_income": Object.freeze({
    role: "pre_tax_income",
    disposition: "statement_row",
    section: "income_statement",
    semantic_role: "pre_tax_income",
    presence: "case_optional",
    join_basis: "etr_path",
  }),
  "statement.tax_expense": Object.freeze({
    role: "tax_expense",
    disposition: "statement_row",
    section: "income_statement",
    semantic_role: "tax_expense",
    presence: "case_optional",
    join_basis: "etr_path",
  }),
});

export const ECONOMIC_BINDING_DISPOSITIONS = Object.freeze([
  "schedule_row",
  "solver_control",
  "statement_row",
]);

export const ECONOMIC_BINDING_STATUSES = Object.freeze([
  "bound",
  "not_row_realised",
  // An ambiguous realisation is neither bound nor absent, and it must not be
  // recorded as either: calling it absent would let a duplicated row manufacture
  // the very silence this binding exists to remove.
  "row_ambiguous",
  // A second claimant on a row another node already realises. The claim is
  // refused rather than honoured, so the artifact never carries two realisation
  // edges onto one statement row while the violation reports the contest.
  "row_contested",
  "row_absent",
  "schedule_row_uncovered",
  "undeclared",
]);

/**
 * The two halves of an economic node row, declared so that BOTH validators can
 * insist the row is exactly these fields. The independent Python oracle
 * (`scripts/verify/invariants.py`) re-declares the same two lists, because it
 * may not import this module; a field added to one side and not the other is
 * therefore a detectable disagreement rather than an unchecked field.
 *
 * The identity half is what the canonical equation-graph asset predicts, and the
 * Python oracle still compares it EXACTLY against that asset. The binding half
 * is what the asset cannot predict, and both validators re-derive it from the
 * artifact's own statement layer.
 */
export const ECONOMIC_IDENTITY_FIELDS = Object.freeze([
  "domain",
  "equation_node_id",
  "id",
  "role",
  "writer",
]);

export const ECONOMIC_BINDING_FIELDS = Object.freeze([
  "binding_disposition",
  "binding_join_basis",
  "binding_row_family",
  "binding_status",
  "bound_section",
  "bound_semantic_role",
  "bound_statement_node_id",
]);

export const ECONOMIC_STATUS_BY_DISPOSITION = Object.freeze({
  schedule_row: Object.freeze(["schedule_row_uncovered"]),
  solver_control: Object.freeze(["not_row_realised"]),
  statement_row: Object.freeze([
    "bound",
    "row_absent",
    "row_ambiguous",
    "row_contested",
  ]),
});

/**
 * Node families the equation graph does NOT contain, declared rather than left
 * to be discovered. The graph is ONE single-forecast-period role template with
 * a fixed node count: it holds `interest.instrument_cash`, not one node per
 * instrument, so a twelve-instrument case and a two-instrument case compile the
 * same 39 economic nodes. Making it per-case or per-period is a different work
 * package; pretending it is already covered is the failure this declaration
 * exists to prevent.
 */
export const EQUATION_GRAPH_UNCOVERED_NODE_FAMILIES = Object.freeze([
  Object.freeze({
    family: "instrument",
    reason:
      "one role-template node stands for every instrument; the graph has no " +
      "per-instrument node and its node count is invariant to instrument count",
  }),
  Object.freeze({
    family: "lease",
    reason:
      "leases contribute exactly two template nodes (lease.principal, " +
      "interest.lease); individual lease contracts have no node",
  }),
  Object.freeze({
    family: "acquisition",
    reason:
      "acquisitions contribute one template node (interest.acquisition); " +
      "acquisition-funded debt and its cash bucket have no node",
  }),
  Object.freeze({
    family: "cash_bucket",
    reason:
      "cash buckets are aggregated into cash.ending_balance; no per-bucket node",
  }),
  Object.freeze({
    family: "statement_row",
    reason:
      "only the 18 statement-bound roles in ECONOMIC_STATEMENT_BINDING reach a " +
      "statement row; the remaining statement rows have no equation node",
  }),
  Object.freeze({
    family: "schedule_row",
    reason:
      "interest/debt/waterfall schedule rows are realised in row-plan row " +
      "families the layered constitution carries no layer for",
  }),
  Object.freeze({
    family: "period",
    reason:
      "period_scope is single_forecast_period_template; the graph has no " +
      "per-period node and no inter-period edge",
  }),
]);

// The register is total over the canonical graph at import time, so no module in
// the repository can load against an equation graph whose node set the canonical
// relation does not cover.
assertValidEquationGraphRowBinding(ECONOMIC_STATEMENT_BINDING, EQUATION_GRAPH);

const ECONOMIC_UNCOVERED_ROW_FAMILIES = Object.freeze([
  "acquisition",
  "cash_waterfall",
  "debt_schedule",
  "instrument",
  "interest_schedule",
  "lease",
]);

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

/**
 * The one spelling of the (section, semantic_role) join key. Both the compiler
 * and the validator derive it from here: two sites spelling the same join two
 * different ways is precisely how a binding comes to look satisfied on one side
 * and absent on the other.
 */
function statementRoleKey(section, semanticRole) {
  return [section, semanticRole].join("::");
}

function statementRoleIndex(statementNodes) {
  const index = new Map();
  for (const node of statementNodes) {
    if (!node.semantic_role) continue;
    const key = statementRoleKey(node.section, node.semantic_role);
    const list = index.get(key) ?? [];
    list.push(node);
    index.set(key, list);
  }
  return index;
}

function compileEconomicLayer(
  equationGraph,
  statementNodes,
  binding,
  violations,
) {
  for (const id of duplicateValues((equationGraph.nodes ?? []).map((node) => node.id))) {
    violations.push(finding("ECONOMIC_DUPLICATE_NODE", `Economic graph duplicates node ${id}.`, { node_id: id }));
  }
  for (const role of duplicateValues((equationGraph.nodes ?? []).map((node) => node.role))) {
    violations.push(finding("ECONOMIC_MULTIPLE_WRITERS", `Economic role ${role} has multiple equation writers.`, { role }));
  }
  const ids = new Set((equationGraph.nodes ?? []).map((node) => node.id));
  const roleIndex = statementRoleIndex(statementNodes);
  const claimants = new Map();
  const nodes = (equationGraph.nodes ?? []).map((node) => {
    const declared = binding[node.id] ?? null;
    const base = {
      id: stableLayerNodeId("economic", node.id),
      equation_node_id: node.id,
      role: node.role,
      domain: node.domain,
      writer: "canonical_solver_equation",
      binding_disposition: declared?.disposition ?? null,
      binding_join_basis: declared?.join_basis ?? null,
      binding_row_family: declared?.row_family ?? null,
      bound_section: declared?.section ?? null,
      bound_semantic_role: declared?.semantic_role ?? null,
      bound_statement_node_id: null,
      binding_status: "undeclared",
    };
    if (!declared) {
      violations.push(finding(
        "ECONOMIC_BINDING_UNDECLARED_NODE",
        `Equation node ${node.id} has no declared statement binding; the ` +
          "canonical relation cannot say which row realises it.",
        { node_id: node.id, role: node.role },
      ));
      return base;
    }
    if (declared.role !== node.role) {
      violations.push(finding(
        "ECONOMIC_BINDING_ROLE_DISAGREEMENT",
        `The canonical binding declares role ${declared.role} for equation node ` +
          `${node.id} but the equation graph declares ${node.role}.`,
        { node_id: node.id, declared_role: declared.role, graph_role: node.role },
      ));
    }
    if (declared.disposition === "solver_control") {
      return { ...base, binding_status: "not_row_realised" };
    }
    if (declared.disposition === "schedule_row") {
      return { ...base, binding_status: "schedule_row_uncovered" };
    }
    const matches = roleIndex.get(
      statementRoleKey(declared.section, declared.semantic_role),
    ) ?? [];
    if (matches.length === 0) {
      if (declared.presence === "required") {
        violations.push(finding(
          "ECONOMIC_BINDING_REQUIRED_ROW_ABSENT",
          `Equation node ${node.id} declares the required statement realisation ` +
            `${declared.section}.${declared.semantic_role}, which the statement ` +
            "layer does not contain.",
          {
            node_id: node.id,
            section: declared.section,
            semantic_role: declared.semantic_role,
          },
        ));
      }
      return { ...base, binding_status: "row_absent" };
    }
    if (matches.length > 1) {
      violations.push(finding(
        "ECONOMIC_BINDING_AMBIGUOUS_ROW",
        `Equation node ${node.id} declares statement realisation ` +
          `${declared.section}.${declared.semantic_role}, which resolves to ` +
          `${matches.length} statement nodes.`,
        {
          node_id: node.id,
          section: declared.section,
          semantic_role: declared.semantic_role,
          matches: matches.length,
        },
      ));
      return { ...base, binding_status: "row_ambiguous" };
    }
    const target = matches[0];
    const contesting = claimants.get(target.id);
    if (contesting) {
      violations.push(finding(
        "ECONOMIC_BINDING_ROW_CONTESTED",
        `Statement node ${target.id} is claimed by equation nodes ${contesting} ` +
          `and ${node.id}; a statement row has exactly one economic realiser.`,
        { statement_node_id: target.id, claimants: sorted([contesting, node.id], (v) => v) },
      ));
      // Refuse the second claim rather than honouring it. Emitting a second
      // realisation edge onto the same row would leave the artifact carrying a
      // relation that is not a function, which both validators reject.
      return { ...base, binding_status: "row_contested" };
    }
    claimants.set(target.id, node.id);
    return { ...base, bound_statement_node_id: target.id, binding_status: "bound" };
  });
  const edges = [];
  for (const node of nodes) {
    if (node.binding_status !== "bound") continue;
    edges.push({
      id: stableLayerNodeId("edge", "economic_realises_row", node.equation_node_id),
      type: "realises_statement_row",
      from: node.id,
      to: node.bound_statement_node_id,
      activation: "always",
      cross_layer: true,
    });
  }
  for (const [nodeId, declared] of Object.entries(binding)) {
    if (ids.has(nodeId)) continue;
    violations.push(finding(
      "ECONOMIC_BINDING_DECLARATION_ORPHAN",
      `The canonical binding declares equation node ${nodeId} (role ` +
        `${declared.role}) which the equation graph does not contain.`,
      { node_id: nodeId, declared_role: declared.role },
    ));
  }
  for (const [nodeId, declared] of Object.entries(binding)) {
    if (declared.disposition !== "schedule_row" || !declared.role_collision_owner) {
      continue;
    }
    const owner = binding[declared.role_collision_owner] ?? null;
    if (
      !owner ||
      owner.disposition !== "statement_row" ||
      owner.semantic_role !== declared.role
    ) {
      violations.push(finding(
        "ECONOMIC_BINDING_COLLISION_OWNER_INVALID",
        `${nodeId} names ${declared.role_collision_owner} as the economic ` +
          `realiser of the statement role ${declared.role}, but that node does ` +
          "not declare a statement_row binding on it.",
        { node_id: nodeId, role_collision_owner: declared.role_collision_owner },
      ));
    }
  }
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
  return {
    graph: layer("economic", nodes, edges),
    coverage: economicCoverageLedger(nodes),
  };
}

/**
 * The coverage ledger is derived from the compiled economic nodes and re-derived
 * independently by `validateLayeredGraphConstitution`, so it cannot claim
 * coverage the layer does not have and cannot hide a gap the layer does have.
 */
/**
 * The binding a downstream graph must agree with, read off a compiled layered
 * constitution rather than recomputed from the register. The semantic manifest
 * carries its own statement-row nodes; without this accessor it had no way to
 * discover which of its rows the equation graph claims to realise, which is how
 * the manifest and the constitution came to be two separately sealed graphs.
 */
export function economicStatementBindings(layeredGraphConstitution) {
  const economic = (layeredGraphConstitution?.layers ?? []).find(
    (item) => item.layer_id === "economic",
  );
  return (economic?.nodes ?? [])
    .filter((node) => node.binding_status === "bound")
    .map((node) => ({
      equation_node_id: node.equation_node_id,
      role: node.role,
      section: node.bound_section,
      semantic_role: node.bound_semantic_role,
      statement_node_id: node.bound_statement_node_id,
    }));
}

export function economicCoverageLedger(economicNodes) {
  const byStatus = Object.fromEntries(
    ECONOMIC_BINDING_STATUSES.map((status) => [
      status,
      economicNodes.filter((node) => node.binding_status === status).length,
    ]),
  );
  const uncoveredFamilies = Object.fromEntries(
    ECONOMIC_UNCOVERED_ROW_FAMILIES.map((family) => [
      family,
      sorted(
        economicNodes
          .filter(
            (node) =>
              node.binding_status === "schedule_row_uncovered" &&
              node.binding_row_family === family,
          )
          .map((node) => node.equation_node_id),
        (value) => value,
      ),
    ]),
  );
  return {
    scope: ECONOMIC_STATEMENT_BINDING_SCOPE,
    economic_node_count: economicNodes.length,
    nodes_by_binding_status: byStatus,
    cross_layer_bound_node_ids: sorted(
      economicNodes
        .filter((node) => node.binding_status === "bound")
        .map((node) => node.equation_node_id),
      (value) => value,
    ),
    row_absent_node_ids: sorted(
      economicNodes
        .filter((node) => node.binding_status === "row_absent")
        .map((node) => node.equation_node_id),
      (value) => value,
    ),
    uncovered_row_families: uncoveredFamilies,
    uncovered_node_families: EQUATION_GRAPH_UNCOVERED_NODE_FAMILIES,
  };
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

/**
 * Re-checks the persisted binding against the persisted layers, consulting only
 * the artifact. This is what makes the binding a relation rather than a
 * decoration: a claim of `bound` must be carried by a real cross-layer edge onto
 * a real statement node with the declared section and semantic role, and a claim
 * of `row_absent` must be EARNED — the statement layer may not contain the row
 * the node says is missing. Absence therefore cannot be manufactured by drifting
 * a statement row's `semantic_role`, and the compiler cannot certify a binding it
 * did not actually make.
 *
 * The register itself is deliberately NOT consulted here: the compiler accepts an
 * injected binding for adversarial testing, and a validator that reached for the
 * module default would report the injection rather than the artifact.
 */
function economicBindingErrors(layers, artifact) {
  const errors = [];
  const economic = layers.find((item) => item.layer_id === "economic");
  const statement = layers.find((item) => item.layer_id === "statement");
  if (!economic || !statement) return errors;
  const statementById = new Map(statement.nodes.map((node) => [node.id, node]));
  const economicById = new Map(economic.nodes.map((node) => [node.id, node]));
  const statementRoles = statementRoleIndex(statement.nodes);
  const crossLayer = (economic.edges ?? []).filter(
    (edge) => edge.cross_layer === true,
  );
  const boundEdgeBySource = new Map();
  for (const edge of crossLayer) {
    if (edge.type !== "realises_statement_row") {
      errors.push(
        `economic cross-layer edge ${edge.id} declares unknown type ${edge.type}.`,
      );
      continue;
    }
    if (!economicById.has(edge.from)) {
      errors.push(
        `economic cross-layer edge ${edge.id} leaves non-existent economic node ${edge.from}.`,
      );
      continue;
    }
    if (!statementById.has(edge.to)) {
      errors.push(
        `economic cross-layer edge ${edge.id} points at non-existent statement node ${edge.to}.`,
      );
      continue;
    }
    if (boundEdgeBySource.has(edge.from)) {
      errors.push(
        `economic node ${edge.from} carries more than one statement realisation edge.`,
      );
      continue;
    }
    boundEdgeBySource.set(edge.from, edge);
  }
  const claimedStatementNodes = new Map();
  for (const node of economic.nodes) {
    // Field-set exactness, matching the independent Python oracle: a node row
    // may carry the identity half and the binding half and nothing else. A
    // field neither half accounts for would travel through both validators
    // unchecked, which is how the drift this binding closes would return.
    const unaccounted = sorted(
      Object.keys(node).filter(
        (key) =>
          !ECONOMIC_IDENTITY_FIELDS.includes(key) &&
          !ECONOMIC_BINDING_FIELDS.includes(key),
      ),
      (value) => value,
    );
    const missing = ECONOMIC_BINDING_FIELDS.filter((key) => !(key in node));
    if (unaccounted.length > 0 || missing.length > 0) {
      errors.push(
        `economic node ${node.id} carries an unchecked binding field set (missing ${JSON.stringify(missing)}, unaccounted ${JSON.stringify(unaccounted)}).`,
      );
      continue;
    }
    if (
      node.binding_disposition !== null &&
      node.binding_disposition !== undefined &&
      !ECONOMIC_BINDING_DISPOSITIONS.includes(node.binding_disposition)
    ) {
      errors.push(
        `economic node ${node.id} declares undeclared binding disposition ${node.binding_disposition}.`,
      );
    }
    if (!ECONOMIC_BINDING_STATUSES.includes(node.binding_status)) {
      errors.push(
        `economic node ${node.id} declares undeclared binding status ${node.binding_status}.`,
      );
      continue;
    }
    // One disposition admits exactly these statuses. Without this, an unbound
    // node could relabel itself `schedule_row_uncovered` and skip every row
    // obligation below.
    const admissible = ECONOMIC_STATUS_BY_DISPOSITION[node.binding_disposition] ?? null;
    if (admissible && !admissible.includes(node.binding_status)) {
      errors.push(
        `economic node ${node.id} declares disposition ${node.binding_disposition} with inadmissible status ${node.binding_status}.`,
      );
      continue;
    }
    const edge = boundEdgeBySource.get(node.id) ?? null;
    if (node.binding_status === "bound") {
      if (!edge) {
        errors.push(
          `economic node ${node.id} claims a bound statement realisation but carries no cross-layer edge.`,
        );
        continue;
      }
      if (edge.to !== node.bound_statement_node_id) {
        errors.push(
          `economic node ${node.id} claims statement node ${node.bound_statement_node_id} but its edge reaches ${edge.to}.`,
        );
        continue;
      }
      const target = statementById.get(edge.to);
      if (
        target.section !== node.bound_section ||
        target.semantic_role !== node.bound_semantic_role
      ) {
        errors.push(
          `economic node ${node.id} declares realisation ${node.bound_section}.${node.bound_semantic_role} but statement node ${edge.to} is ${target.section}.${target.semantic_role}.`,
        );
        continue;
      }
      // Injectivity, matching the independent Python oracle: one statement row
      // has exactly one economic realiser.
      const contender = claimedStatementNodes.get(edge.to) ?? null;
      if (contender) {
        errors.push(
          `statement node ${edge.to} is realised by both ${contender} and ${node.id}.`,
        );
        continue;
      }
      claimedStatementNodes.set(edge.to, node.id);
      continue;
    }
    if (edge) {
      errors.push(
        `economic node ${node.id} carries a statement realisation edge while claiming ${node.binding_status}.`,
      );
    }
    if (node.binding_disposition !== "statement_row") continue;
    // A contested claim was refused, not resolved: the row exists and would
    // derive `bound`, so the derivation below does not apply. The contest itself
    // is reported by the compile-channel violation and by the injectivity check
    // above, so it is not silence.
    if (node.binding_status === "row_contested") {
      if (node.bound_statement_node_id !== null) {
        errors.push(
          `economic node ${node.id} claims a refused contested realisation ${node.bound_statement_node_id}.`,
        );
      }
      continue;
    }
    const present =
      statementRoles.get(
        statementRoleKey(node.bound_section, node.bound_semantic_role),
      ) ?? [];
    // Absence and ambiguity are both RE-DERIVED from the statement layer, so
    // neither can be asserted into existence: a node may not claim its row is
    // missing while the layer holds it, nor claim ambiguity the layer does not
    // exhibit.
    const derived =
      present.length === 1
        ? "bound"
        : present.length === 0
          ? "row_absent"
          : "row_ambiguous";
    if (derived !== node.binding_status) {
      errors.push(
        `economic node ${node.id} claims ${node.binding_status} for ${node.bound_section}.${node.bound_semantic_role} but the statement layer derives ${derived} (${present.length} matching rows).`,
      );
    }
  }
  if (artifact.economic_binding_scope !== ECONOMIC_STATEMENT_BINDING_SCOPE) {
    errors.push("layered graph constitution does not declare the economic binding scope.");
  }
  if (!/^[0-9a-f]{64}$/.test(String(artifact.economic_binding_sha256 ?? ""))) {
    errors.push("layered graph constitution does not seal the economic binding register.");
  }
  const ledger = artifact.economic_coverage ?? null;
  if (!ledger) {
    errors.push("layered graph constitution carries no economic coverage ledger.");
    return errors;
  }
  if (hashValue(ledger) !== artifact.economic_coverage_sha256) {
    errors.push("economic coverage ledger hash does not match its canonical content.");
  }
  if (
    JSON.stringify(ledger) !== JSON.stringify(economicCoverageLedger(economic.nodes))
  ) {
    errors.push(
      "economic coverage ledger does not match the economic layer it describes.",
    );
  }
  if ((ledger.uncovered_node_families ?? []).length === 0) {
    errors.push(
      "economic coverage ledger declares no uncovered node families; the equation " +
        "graph is a single-period role template and the gap must be declared.",
    );
  }
  return errors;
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
  errors.push(...economicBindingErrors(layers, artifact));
  const closureCore = {
    schema_version: artifact.schema_version,
    case_id: artifact.case_id,
    case_sha256: artifact.case_sha256,
    row_plan_projection_scope: artifact.row_plan_projection_scope,
    row_plan_projection_sha256: artifact.row_plan_projection_sha256,
    layer_hashes: artifact.layer_hashes,
    economic_binding_scope: artifact.economic_binding_scope,
    economic_binding_sha256: artifact.economic_binding_sha256,
    economic_coverage_sha256: artifact.economic_coverage_sha256,
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
  {
    equationGraph = EQUATION_GRAPH,
    economicStatementBinding = ECONOMIC_STATEMENT_BINDING,
  } = {},
) {
  const violations = [];
  validateSourceStatementClosure(modelCase, violations);
  const statementRows = canonicalStatementRows(modelCase, rowPlan);
  const { graph: statement, nodeIds } = compileStatementLayer(
    modelCase,
    statementRows,
    violations,
  );
  const { graph: economic, coverage } = compileEconomicLayer(
    equationGraph,
    statement.nodes,
    economicStatementBinding,
    violations,
  );
  const layers = [
    compileEvidenceLayer(modelCase, nodeIds, violations),
    statement,
    compileForecastLayer(modelCase, statementRows, nodeIds, violations),
    economic,
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
    economic_binding_scope: ECONOMIC_STATEMENT_BINDING_SCOPE,
    economic_binding_sha256: hashValue(economicStatementBinding),
    economic_coverage_sha256: hashValue(coverage),
    violation_sha256: hashValue(sortedViolations),
  };
  const artifact = {
    ...closureCore,
    layer_hashes: layerHashes,
    economic_coverage: coverage,
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
