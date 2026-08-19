import { deterministicCaseHash } from "./validation_invariants.mjs";
import {
  forecastCandidateLedger,
  forecastRowMateriality,
  resolveForecastAuthority,
} from "./forecast_authority.mjs";
import { compileStatementTopology } from "./statement_topology.mjs";
import { resolveHistoricalInterestAuthority } from "./historical_interest_authority.mjs";
import {
  compileInstrumentPeriodState,
  instrumentPeriodStateByKey,
} from "./instrument_period_state.mjs";
import {
  canonicalStatementDependencies,
  canonicalForecastStatementDependencies,
  compileLayeredGraphConstitution,
} from "./layered_graph_constitution.mjs";
import { balancingRcfMode } from "./rcf_policy.mjs";

const MOVEMENT_DEFINITIONS = {
  operating_cash_flow: {
    cash_flow_classification: "operating",
    waterfall_stage: "pre_debt",
    cash_effect: "variable",
    debt_effect: "none",
  },
  investing_cash_flow: {
    cash_flow_classification: "investing",
    waterfall_stage: "pre_debt",
    cash_effect: "variable",
    debt_effect: "none",
  },
  non_debt_financing: {
    cash_flow_classification: "financing",
    waterfall_stage: "pre_debt",
    cash_effect: "variable",
    debt_effect: "none",
  },
  debt_issuance: {
    cash_flow_classification: "financing",
    waterfall_stage: "non_rcf_debt",
    cash_effect: "inflow",
    debt_effect: "increase",
  },
  scheduled_amortisation: {
    cash_flow_classification: "financing",
    waterfall_stage: "non_rcf_debt",
    cash_effect: "outflow",
    debt_effect: "decrease",
  },
  maturity_repayment: {
    cash_flow_classification: "financing",
    waterfall_stage: "non_rcf_debt",
    cash_effect: "outflow",
    debt_effect: "decrease",
  },
  debt_issuance_cost: {
    cash_flow_classification: "financing",
    waterfall_stage: "non_rcf_debt",
    cash_effect: "outflow",
    debt_effect: "none",
  },
  other_cash_debt_movement: {
    cash_flow_classification: "financing",
    waterfall_stage: "non_rcf_debt",
    cash_effect: "variable",
    debt_effect: "variable",
  },
  working_capital_movement: {
    cash_flow_classification: "operating",
    waterfall_stage: "within_operating_subtotal",
    cash_effect: "variable",
    debt_effect: "none",
  },
  non_cash_debt_movement: {
    cash_flow_classification: "none",
    waterfall_stage: "excluded",
    cash_effect: "none",
    debt_effect: "variable",
  },
  pik_accretion: {
    cash_flow_classification: "none",
    waterfall_stage: "excluded",
    cash_effect: "none",
    debt_effect: "increase",
  },
  fair_value_debt_movement: {
    cash_flow_classification: "none",
    waterfall_stage: "excluded",
    cash_effect: "none",
    debt_effect: "variable",
  },
  other_non_cash_debt_movement: {
    cash_flow_classification: "none",
    waterfall_stage: "excluded",
    cash_effect: "none",
    debt_effect: "variable",
  },
  lease_principal: {
    cash_flow_classification: "financing",
    waterfall_stage: "non_rcf_debt",
    cash_effect: "outflow",
    debt_effect: "decrease",
  },
  rcf_draw: {
    cash_flow_classification: "financing",
    waterfall_stage: "rcf_balance",
    cash_effect: "inflow",
    debt_effect: "increase",
  },
  rcf_repayment: {
    cash_flow_classification: "financing",
    waterfall_stage: "rcf_balance",
    cash_effect: "outflow",
    debt_effect: "decrease",
  },
  fx_on_cash: {
    cash_flow_classification: "cash_reconciliation",
    waterfall_stage: "pre_debt",
    cash_effect: "variable",
    debt_effect: "none",
  },
  non_balancing_cash_bucket_movement: {
    cash_flow_classification: "cash_reconciliation",
    waterfall_stage: "excluded",
    cash_effect: "variable",
    debt_effect: "none",
  },
  cash_balance: {
    cash_flow_classification: "cash_reconciliation",
    waterfall_stage: "cash_balance",
    cash_effect: "balance",
    debt_effect: "none",
  },
};

const ROLE_MOVEMENT_TYPES = {
  cash_from_operations: "operating_cash_flow",
  cash_taxes: "operating_cash_flow",
  cash_from_investing: "investing_cash_flow",
  dividends: "non_debt_financing",
  share_buybacks: "non_debt_financing",
  debt_issuance: "debt_issuance",
  debt_repayment: "maturity_repayment",
  lease_principal: "lease_principal",
  rcf_draw: "rcf_draw",
  rcf_repayment: "rcf_repayment",
  fx_effect_on_cash: "fx_on_cash",
  non_balancing_cash_bucket_movement:
    "non_balancing_cash_bucket_movement",
  opening_cash: "cash_balance",
  ending_cash: "cash_balance",
  change_in_working_capital: "working_capital_movement",
};

const MECHANICAL_MOVEMENT_TYPES = {
  cash_before_debt: "cash_balance",
  non_rcf_debt_proceeds: "debt_issuance",
  pre_rcf_debt_cash_flow: "other_cash_debt_movement",
  lease_principal_waterfall: "lease_principal",
  cash_before_rcf: "cash_balance",
  minimum_cash: "cash_balance",
  cash_surplus_deficit: "cash_balance",
  opening_rcf: "cash_balance",
  rcf_draw_waterfall: "rcf_draw",
  rcf_repayment_waterfall: "rcf_repayment",
  ending_rcf: "cash_balance",
  ending_cash_waterfall: "cash_balance",
  liquidity_shortfall: "cash_balance",
};

const COMPILER_CALCULATED_ROLES = new Set([
  "interest_income",
  "interest_expense",
  "cash_interest_paid",
  "cash_interest_received",
  "debt_issuance",
  "debt_repayment",
  "non_balancing_cash_bucket_movement",
  "rcf_draw",
  "rcf_repayment",
  "opening_cash",
  "ending_cash",
  "non_cash_interest_addback",
]);

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    String(left).localeCompare(String(right)),
  );
}

// (The label-normalising group-key helper that used to live here is gone on
// purpose: group joins bind on the minted display_group_key, never on a
// re-derivation of the human label.)

function dependencies(definition) {
  return canonicalForecastStatementDependencies(definition);
}

function declaredSources(modelCase, rowId) {
  const result = [];
  for (const section of ["income_statement", "cash_flow"]) {
    for (const disclosure of modelCase.source_coverage?.[section] ?? []) {
      if ((disclosure.mapped_row_ids ?? []).includes(rowId)) {
        result.push(disclosure.source_line_id);
      }
    }
  }
  return result;
}

function formulaAuthority(definition) {
  if (definition.formula_authority) return definition.formula_authority;
  const periodCalculations = (definition.forecast_period_calculations ?? []).filter(Boolean);
  if (
    periodCalculations.length > 0 &&
    periodCalculations.every((calculation) =>
      ["historical_average", "historical_trend"].includes(calculation.operator),
    )
  ) {
    // These formulas read the sealed historical observation window directly.
    // They deliberately have no forecast-node dependency edge, but they are
    // still compiler-authored formulas rather than presentation-only rows.
    return "compiler";
  }
  if (
    definition.forecast_capture_parent_id ||
    definition.forecast_treatment === "uncalculated"
  ) {
    return "intentionally_blank";
  }
  if (["broker", "hardcode", "zero"].includes(definition.forecast_treatment)) {
    return "case_input";
  }
  if (definition.row_type === "input") return "case_input";
  if (COMPILER_CALCULATED_ROLES.has(definition.semantic_role)) {
    return "compiler";
  }
  if (
    definition.calculation ||
    definition.forecast_calculation ||
    (definition.forecast_period_calculations ?? []).some(Boolean)
  ) {
    return "declared_dependency";
  }
  if (definition.row_type === "uncalculated") return "intentionally_blank";
  return "presentation_only";
}

export const MOVEMENT_TYPES = Object.freeze(
  Object.keys(MOVEMENT_DEFINITIONS),
);

export function movementDefinition(movementType) {
  return movementType ? MOVEMENT_DEFINITIONS[movementType] ?? null : null;
}

export function inferMovementType(definition) {
  return (
    definition.movement_type ??
    (definition.economic_class === "working_capital"
      ? "working_capital_movement"
      : null) ??
    ROLE_MOVEMENT_TYPES[definition.semantic_role] ??
    null
  );
}

export function describeStatementRow(definition, section) {
  const movementType = inferMovementType(definition);
  const movement = movementDefinition(movementType);
  return {
    semantic_id: definition.semantic_id ?? definition.row_id,
    section,
    // Keep the source identity and the emitted forecast graph separate.  The
    // former proves the filed statement; the latter is what J:L must
    // physically reference after a direct forecast writer or capture stands
    // the historical identity down.
    historical_dependency_refs: canonicalStatementDependencies(definition),
    dependency_refs: dependencies(definition),
    movement_type: movementType,
    cash_flow_classification:
      definition.cash_flow_classification ??
      movement?.cash_flow_classification ??
      null,
    formula_authority: formulaAuthority(definition),
  };
}

function semanticForecastAuthorities(modelCase, row) {
  if (row.row_type === "header") return [];
  return [0, 1, 2].map((forecastIndex) => {
    const authority = resolveForecastAuthority(modelCase, row, forecastIndex);
    const formula = Array.isArray(row.forecast_period_calculations)
      ? row.forecast_period_calculations[forecastIndex] ?? null
      : row.forecast_calculation ?? row.calculation ?? null;
    return {
      forecast_index: forecastIndex,
      method: authority.method,
      mechanism: authority.mechanism,
      source_kind: authority.source_kind ?? null,
      source_id: authority.source_id ?? null,
      as_of_date: authority.as_of_date ?? null,
      confidence: authority.confidence ?? null,
      value: authority.mechanism === "hardcode" ? authority.value : null,
      partial_period: authority.partial_period ?? null,
      guidance_range: authority.guidance_range ?? null,
      note: authority.note ?? authority.reason ?? null,
      broker_metric_id:
        authority.mechanism === "broker"
          ? row.broker_metric_id ?? row.semantic_role ?? null
          : null,
      inferred: authority.inferred === true,
      material: forecastRowMateriality(modelCase, row),
      candidates: forecastCandidateLedger(modelCase, row, forecastIndex),
      capture_certificate:
        row.forecast_capture_certificates?.[forecastIndex] ?? null,
      formula_operator:
        authority.mechanism === "formula" ? formula?.operator ?? null : null,
      formula_refs:
        authority.mechanism === "formula" ? [...(formula?.refs ?? [])] : [],
      period_relation:
        authority.mechanism === "formula" && formula?.operator === "prior_period"
          ? "prior_period"
          : "same_period",
    };
  });
}

function statementNodes(modelCase, rowPlan) {
  const nodes = [];
  const emittedRowIds = new Set();
  const pushStatementNode = (row, section, physicalRow, projectionStatus) => {
    const description = describeStatementRow(row, section);
    const movement = movementDefinition(description.movement_type);
    nodes.push({
      node_id: `statement.${row.row_id}`,
      node_kind: "statement_row",
      semantic_id: description.semantic_id,
      row_id: row.row_id,
      label: row.label,
      section,
      physical_row: physicalRow,
      projection_status: projectionStatus,
      projection_origin: row.projection_origin ?? null,
      projection_required_by: row.projection_required_by ?? null,
      row_type: row.row_type,
      semantic_role: row.semantic_role ?? null,
      accounting_basis: modelCase.issuer?.accounting_basis ?? null,
      operation_scope: row.operation_scope ?? null,
      aggregation_authority: row.aggregation_authority ?? null,
      parent_row_id: row.parent_row_id ?? null,
      presentation_parent_id: row.presentation_parent_id ?? null,
      presentation_depth: row.presentation_depth ?? 0,
      presentation_role: row.presentation_role ?? null,
      presentation_rank: row.presentation_rank ?? null,
      section_conclusion_owner: row.section_conclusion_owner === true,
      section_conclusion_id: row.section_conclusion_id ?? null,
      in_section_conclusion_closure:
        row.in_section_conclusion_closure === true,
      forecast_capture_parent_id: row.forecast_capture_parent_id ?? null,
      forecast_capture_mode: row.forecast_capture_mode ?? null,
      forecast_capture_note: row.forecast_capture_note ?? null,
      forecast_capture_certificates:
        row.forecast_capture_certificates ?? null,
      aggregation_role: row.aggregation_role ?? null,
      economic_class: row.economic_class ?? null,
      acquisition_driver_role: row.acquisition_driver_role ?? null,
      style_role: row.style_role ?? null,
      display_role: row.display_role ?? null,
      formula_role: row.formula_role ?? null,
      formula_authority: description.formula_authority,
      historical_dependencies: description.historical_dependency_refs,
      dependencies: description.dependency_refs,
      forecast_authorities: semanticForecastAuthorities(modelCase, row),
      source_line_ids: uniqueSorted([
        ...(row.source_line_ids ?? []),
        ...declaredSources(modelCase, row.row_id),
      ]),
      movement_type: description.movement_type,
      cash_flow_classification: description.cash_flow_classification,
      waterfall_stage: movement?.waterfall_stage ?? null,
      cash_effect: movement?.cash_effect ?? null,
      debt_effect: movement?.debt_effect ?? null,
    });
    emittedRowIds.add(row.row_id);
  };
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of rowPlan.statement_rows[section] ?? []) {
      pushStatementNode(row, section, row.row, "rendered");
    }
  }
  // The visible debt-overlay projection intentionally stops at consolidated
  // net income and omits irrelevant post-net-income blocks.  Those filed rows
  // are still evidence and remain first-class graph nodes: they retain source
  // mappings and dependencies but have no workbook coordinate.  This is what
  // lets the source crosswalk prove complete coverage without forcing OCI,
  // attribution or per-share material back onto the Operating Model.
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase.statement_structure?.[section] ?? []) {
      if (emittedRowIds.has(row.row_id)) continue;
      pushStatementNode(row, section, null, "evidence_only");
    }
  }
  return nodes;
}

function mechanicalNodes(rowPlan) {
  const nodes = [];
  for (const group of rowPlan.debt_groups ?? []) {
    nodes.push(
      {
        node_id: `debt_group.${group.group_id}.header`,
        node_kind: "debt_group_header",
        semantic_id: `debt_group.${group.group_id}.header`,
        row_id: `debt_group.${group.group_id}.header`,
        label: group.label,
        section: "debt_schedule",
        physical_row: group.header_row,
        formula_authority: "presentation_only",
        instrument_ids: [...group.instrument_ids],
      },
      {
        node_id: `debt_group.${group.group_id}.subtotal`,
        node_kind: "debt_group_subtotal",
        semantic_id: `debt_group.${group.group_id}.subtotal`,
        row_id: `debt_group.${group.group_id}.subtotal`,
        label: `${group.label} — subtotal`,
        section: "debt_schedule",
        physical_row: group.subtotal_row,
        formula_authority: "compiler",
        instrument_ids: [...group.instrument_ids],
      },
      {
        node_id: `interest_group.${group.group_id}.header`,
        node_kind: "interest_group_header",
        semantic_id: `interest_group.${group.group_id}.header`,
        row_id: `interest_group.${group.group_id}.header`,
        label: group.label,
        section: "interest_schedule",
        physical_row: group.interest_header_row,
        formula_authority: "presentation_only",
        instrument_ids: [...group.instrument_ids],
      },
      {
        node_id: `interest_group.${group.group_id}.subtotal`,
        node_kind: "interest_group_subtotal",
        semantic_id: `interest_group.${group.group_id}.subtotal`,
        row_id: `interest_group.${group.group_id}.subtotal`,
        label: `${group.label} — subtotal`,
        section: "interest_schedule",
        physical_row: group.interest_subtotal_row,
        formula_authority: "compiler",
        instrument_ids: [...group.instrument_ids],
      },
    );
  }
  for (const [rowId, physicalRow] of Object.entries(
    rowPlan.debt_summary_rows ?? {},
  )) {
    nodes.push({
      node_id: `mechanical.${rowId}`,
      node_kind: "debt_summary",
      semantic_id: rowId,
      row_id: rowId,
      section: "debt_schedule",
      physical_row: physicalRow,
      formula_authority: "compiler",
    });
  }
  for (const [rowId, physicalRow] of Object.entries(
    rowPlan.waterfall_rows ?? {},
  )) {
    const movementType = MECHANICAL_MOVEMENT_TYPES[rowId] ?? null;
    const movement = movementDefinition(movementType);
    nodes.push({
      node_id: `mechanical.${rowId}`,
      node_kind: "cash_waterfall",
      semantic_id: rowId,
      row_id: rowId,
      section: "rcf_waterfall",
      physical_row: physicalRow,
      formula_authority: "compiler",
      movement_type: movementType,
      cash_flow_classification: movement?.cash_flow_classification ?? null,
      waterfall_stage: movement?.waterfall_stage ?? null,
      cash_effect: movement?.cash_effect ?? null,
      debt_effect: movement?.debt_effect ?? null,
    });
  }
  for (const [rowId, physicalRow] of Object.entries(
    rowPlan.interest_summary_rows ?? {},
  )) {
    nodes.push({
      node_id: `mechanical.${rowId}`,
      node_kind: "interest_summary",
      semantic_id: rowId,
      row_id: rowId,
      section: "interest_schedule",
      physical_row: physicalRow,
      formula_authority: "compiler",
    });
  }
  return nodes;
}

function instrumentNodes(modelCase, rowPlan, instrumentPeriodState = null) {
  const instrumentsById = new Map(
    (modelCase.instruments ?? []).map((instrument) => [
      instrument.instrument_id,
      instrument,
    ]),
  );
  const stateIndex = instrumentPeriodState
    ? instrumentPeriodStateByKey(instrumentPeriodState)
    : null;
  const nodes = [];
  for (const plan of rowPlan.instruments ?? []) {
    const instrument = instrumentsById.get(plan.instrument_id) ?? {};
    const periodStates = [0, 1, 2].map((periodIndex) =>
      stateIndex?.get(`${plan.instrument_id}\u0000${periodIndex}`) ?? null,
    );
    nodes.push({
      node_id: `instrument.${plan.instrument_id}.balance`,
      node_kind: "debt_instrument",
      semantic_id: `debt.${plan.instrument_id}`,
      instrument_id: plan.instrument_id,
      label: instrument.name ?? plan.instrument_id,
      instrument_class: instrument.class ?? null,
      display_group: plan.display_group ?? null,
      // The group KEY is the join identity; the label above is presentation
      // only. Joining on a normalised label silently orphaned the
      // unclassified-review group (label normalises to a different token).
      display_group_key: plan.display_group_key ?? null,
      maturity_treatment: instrument.maturity_treatment ?? "contractual",
      repayment_state_by_period: [
        ...(plan.repayment_state_by_period ?? ["zero", "zero", "zero"]),
      ],
      instrument_period_state_ids: periodStates.map(
        (state) => state?.state_id ?? null,
      ),
      instrument_period_membership: periodStates.map((state) =>
        state ? structuredClone(state.inclusion) : null,
      ),
      section: "debt_schedule",
      physical_row: plan.debt_row,
      formula_authority: "compiler",
      source_line_ids: uniqueSorted(instrument.source_line_ids ?? []),
    });
    if (plan.issuance_row) {
      nodes.push({
        node_id: `instrument.${plan.instrument_id}.issuance`,
        node_kind: "debt_movement",
        semantic_id: `debt.${plan.instrument_id}.issuance`,
        instrument_id: plan.instrument_id,
        section: "debt_schedule",
        physical_row: plan.issuance_row,
        formula_authority: "case_input",
        movement_type: "debt_issuance",
        ...MOVEMENT_DEFINITIONS.debt_issuance,
      });
    }
    if (plan.amortisation_row) {
      nodes.push({
        node_id: `instrument.${plan.instrument_id}.amortisation`,
        node_kind: "debt_movement",
        semantic_id: `debt.${plan.instrument_id}.amortisation`,
        instrument_id: plan.instrument_id,
        section: "debt_schedule",
        physical_row: plan.amortisation_row,
        formula_authority: "case_input",
        movement_type: "scheduled_amortisation",
        ...MOVEMENT_DEFINITIONS.scheduled_amortisation,
      });
    }
    if (plan.pik_row) {
      nodes.push({
        node_id: `instrument.${plan.instrument_id}.pik_accretion`,
        node_kind: "debt_movement",
        semantic_id: `debt.${plan.instrument_id}.pik_accretion`,
        instrument_id: plan.instrument_id,
        section: "debt_schedule",
        physical_row: plan.pik_row,
        formula_authority: "compiler",
        movement_type: "pik_accretion",
        ...MOVEMENT_DEFINITIONS.pik_accretion,
      });
    }
    if (plan.fair_value_row) {
      nodes.push({
        node_id: `instrument.${plan.instrument_id}.fair_value`,
        node_kind: "debt_movement",
        semantic_id: `debt.${plan.instrument_id}.fair_value`,
        instrument_id: plan.instrument_id,
        section: "debt_schedule",
        physical_row: plan.fair_value_row,
        formula_authority: "case_input",
        movement_type: "fair_value_debt_movement",
        ...MOVEMENT_DEFINITIONS.fair_value_debt_movement,
      });
    }
    if (plan.other_non_cash_row) {
      nodes.push({
        node_id: `instrument.${plan.instrument_id}.other_non_cash`,
        node_kind: "debt_movement",
        semantic_id: `debt.${plan.instrument_id}.other_non_cash`,
        instrument_id: plan.instrument_id,
        section: "debt_schedule",
        physical_row: plan.other_non_cash_row,
        formula_authority: "case_input",
        movement_type: "other_non_cash_debt_movement",
        ...MOVEMENT_DEFINITIONS.other_non_cash_debt_movement,
      });
    }
    nodes.push({
      node_id: `instrument.${plan.instrument_id}.interest`,
      node_kind: "interest_component",
      semantic_id: `interest.${plan.instrument_id}`,
      instrument_id: plan.instrument_id,
      section: "interest_schedule",
      physical_row: plan.interest_row,
      formula_authority: "compiler",
    });
    if (plan.pik_interest_row) {
      nodes.push({
        node_id: `instrument.${plan.instrument_id}.pik_interest`,
        node_kind: "interest_component",
        semantic_id: `interest.${plan.instrument_id}.pik`,
        instrument_id: plan.instrument_id,
        section: "interest_schedule",
        physical_row: plan.pik_interest_row,
        formula_authority: "compiler",
        cash_interest: false,
      });
    }
  }
  return nodes;
}

function cashBucketNodes(rowPlan) {
  const nodes = [];
  for (const plan of rowPlan.cash_buckets ?? []) {
    nodes.push({
      node_id: `cash_bucket.${plan.bucket_id}.balance`,
      node_kind: "cash_bucket",
      semantic_id: `cash.${plan.bucket_id}`,
      bucket_id: plan.bucket_id,
      label: plan.label,
      section: "debt_schedule",
      physical_row: plan.balance_row,
      formula_authority:
        plan.forecast_treatment === "hardcode" ? "case_input" : "compiler",
      forecast_treatment: plan.forecast_treatment,
      included_in_cash_flow_cash:
        plan.included_in_cash_flow_cash !== false,
      linked_instrument_ids: uniqueSorted(plan.linked_instrument_ids ?? []),
      available_for_liquidity: Boolean(plan.available_for_liquidity),
      net_debt_eligible_percentage: plan.net_debt_eligible_percentage,
      interest_eligible_percentage: plan.interest_eligible_percentage,
      source_line_ids: uniqueSorted(plan.source_line_ids ?? []),
    });
    if (Number.isInteger(plan.interest_row)) {
      nodes.push({
        node_id: `cash_bucket.${plan.bucket_id}.interest`,
        node_kind: "interest_component",
        semantic_id: `interest.cash.${plan.bucket_id}`,
        bucket_id: plan.bucket_id,
        label: `${plan.label} — interest income`,
        section: "interest_schedule",
        physical_row: plan.interest_row,
        rate_row: plan.rate_row,
        formula_authority: "compiler",
        cash_interest: true,
      });
    }
  }
  return nodes;
}

function graphEdges(nodes, rowPlan) {
  const edges = [];
  const statementNodeByRowId = new Map(
    nodes
      .filter((node) => node.node_kind === "statement_row")
      .map((node) => [node.row_id, node.node_id]),
  );
  for (const node of nodes) {
    for (const reference of node.dependencies ?? []) {
      edges.push({
        edge_type: "depends_on",
        from: node.node_id,
        to: statementNodeByRowId.get(reference) ?? `unresolved.${reference}`,
      });
    }
    for (const sourceLineId of node.source_line_ids ?? []) {
      edges.push({
        edge_type: "sourced_from",
        from: node.node_id,
        to: `source.${sourceLineId}`,
      });
    }
    if (node.node_kind === "statement_row" && node.parent_row_id) {
      const parentNodeId = statementNodeByRowId.get(node.parent_row_id);
      if (parentNodeId) {
        edges.push({
          edge_type:
            node.aggregation_role === "working_child"
              ? "working_detail_of"
              : "contributes_to",
          from: node.node_id,
          to: parentNodeId,
          origin: "statement_hierarchy",
        });
      }
    }
    if (
      node.node_kind === "statement_row" &&
      node.forecast_capture_parent_id
    ) {
      const parentNodeId = statementNodeByRowId.get(
        node.forecast_capture_parent_id,
      );
      if (parentNodeId) {
        edges.push({
          edge_type: "forecast_captured_by",
          from: node.node_id,
          to: parentNodeId,
          origin: "forecast_authority",
        });
      }
    }
  }
  for (const plan of rowPlan.instruments ?? []) {
    edges.push({
      edge_type: "accrues_interest_to",
      from: `instrument.${plan.instrument_id}.balance`,
      to: `instrument.${plan.instrument_id}.interest`,
    });
    edges.push({
      edge_type: "depends_on",
      from: `instrument.${plan.instrument_id}.interest`,
      to: `instrument.${plan.instrument_id}.balance`,
      origin: "economic_graph",
    });
    if (plan.issuance_row) {
      edges.push({
        edge_type: "changes_balance",
        from: `instrument.${plan.instrument_id}.issuance`,
        to: `instrument.${plan.instrument_id}.balance`,
      });
      edges.push({
        edge_type: "depends_on",
        from: `instrument.${plan.instrument_id}.balance`,
        to: `instrument.${plan.instrument_id}.issuance`,
        origin: "economic_graph",
      });
    }
    if (plan.amortisation_row) {
      edges.push({
        edge_type: "changes_balance",
        from: `instrument.${plan.instrument_id}.amortisation`,
        to: `instrument.${plan.instrument_id}.balance`,
      });
      edges.push({
        edge_type: "depends_on",
        from: `instrument.${plan.instrument_id}.balance`,
        to: `instrument.${plan.instrument_id}.amortisation`,
        origin: "economic_graph",
      });
    }
    if (plan.pik_row) {
      edges.push({
        edge_type: "changes_balance",
        from: `instrument.${plan.instrument_id}.pik_accretion`,
        to: `instrument.${plan.instrument_id}.balance`,
      });
      edges.push({
        edge_type: "depends_on",
        from: `instrument.${plan.instrument_id}.balance`,
        to: `instrument.${plan.instrument_id}.pik_accretion`,
        origin: "economic_graph",
      });
    }
    if (plan.pik_interest_row) {
      edges.push({
        edge_type: "capitalises_to",
        from: `instrument.${plan.instrument_id}.pik_interest`,
        to: `instrument.${plan.instrument_id}.pik_accretion`,
      });
      edges.push({
        edge_type: "depends_on",
        from: `instrument.${plan.instrument_id}.pik_interest`,
        to: `instrument.${plan.instrument_id}.pik_accretion`,
        origin: "economic_graph",
      });
    }
    if (plan.fair_value_row) {
      edges.push({
        edge_type: "changes_balance",
        from: `instrument.${plan.instrument_id}.fair_value`,
        to: `instrument.${plan.instrument_id}.balance`,
      });
      edges.push({
        edge_type: "depends_on",
        from: `instrument.${plan.instrument_id}.balance`,
        to: `instrument.${plan.instrument_id}.fair_value`,
        origin: "economic_graph",
      });
    }
    if (plan.other_non_cash_row) {
      edges.push({
        edge_type: "changes_balance",
        from: `instrument.${plan.instrument_id}.other_non_cash`,
        to: `instrument.${plan.instrument_id}.balance`,
      });
      edges.push({
        edge_type: "depends_on",
        from: `instrument.${plan.instrument_id}.balance`,
        to: `instrument.${plan.instrument_id}.other_non_cash`,
        origin: "economic_graph",
      });
    }
  }

  // Mechanical schedules are part of the same economic graph as the issuer's
  // statements. Declare their arithmetic here, in the manifest authority,
  // rather than rebuilding a second partial graph inside a downstream user-flow
  // module. A link is emitted only when both nodes exist, so optional modules
  // naturally produce a smaller graph without dangling edges.
  const present = new Set(nodes.map((node) => node.node_id));
  const link = (consumer, precedent) => {
    if (!consumer || !precedent || consumer === precedent) return;
    if (!present.has(consumer) || !present.has(precedent)) return;
    edges.push({
      edge_type: "depends_on",
      from: consumer,
      to: precedent,
      origin: "economic_graph",
    });
  };
  const statementByRole = new Map(
    nodes
      .filter(
        (node) =>
          node.node_kind === "statement_row" && node.semantic_role,
      )
      .map((node) => [node.semantic_role, node.node_id]),
  );
  const statement = (role) => statementByRole.get(role) ?? null;
  const explicitCashBuckets = (rowPlan.cash_buckets ?? []).length > 0;
  // Instruments join their presentation-group subtotals on the GROUP KEY the
  // row plan minted, never on a normalisation of the human label: the
  // unclassified-review label normalises to a different token than its key,
  // which silently orphaned every instrument in that group. A declared group
  // whose subtotal node is missing is a manifest defect and must surface as a
  // typed violation, not a silently dropped edge.
  const groupByInstrument = new Map(
    nodes
      .filter(
        (node) =>
          node.node_kind === "debt_instrument" && node.instrument_id,
      )
      .map((node) => [
        node.instrument_id,
        node.display_group_key ?? null,
      ]),
  );
  const requireGroupNode = (nodeId, plan, groupKey) => {
    if (present.has(nodeId)) return nodeId;
    const error = new Error(
      `ECONOMIC_GRAPH_GROUP_NODE_ABSENT: instrument ${plan.instrument_id} ` +
        `declares presentation group ${groupKey} but node ${nodeId} is ` +
        `absent from the manifest.`,
    );
    error.violation_code = "ECONOMIC_GRAPH_GROUP_NODE_ABSENT";
    throw error;
  };
  for (const plan of rowPlan.instruments ?? []) {
    const groupKey = groupByInstrument.get(plan.instrument_id) ?? null;
    if (!groupKey) continue;
    link(
      requireGroupNode(`debt_group.${groupKey}.subtotal`, plan, groupKey),
      `instrument.${plan.instrument_id}.balance`,
    );
    link(
      requireGroupNode(`interest_group.${groupKey}.subtotal`, plan, groupKey),
      `instrument.${plan.instrument_id}.interest`,
    );
    if (plan.pik_interest_row) {
      link(
        requireGroupNode(
          `interest_group.${groupKey}.subtotal`,
          plan,
          groupKey,
        ),
        `instrument.${plan.instrument_id}.pik_interest`,
      );
    }
  }
  for (const plan of rowPlan.cash_buckets ?? []) {
    const balance = `cash_bucket.${plan.bucket_id}.balance`;
    const interest = `cash_bucket.${plan.bucket_id}.interest`;
    link("mechanical.reported_cash", balance);
    if (plan.available_for_liquidity) {
      link("mechanical.liquidity_cash", balance);
    }
    if (Number(plan.net_debt_eligible_percentage) !== 0) {
      link("mechanical.cash_for_net_debt", balance);
    }
    if (Number(plan.interest_eligible_percentage) !== 0) {
      link("mechanical.interest_bearing_cash", balance);
      link(interest, balance);
      link("mechanical.interest_income_schedule", interest);
    }
  }
  for (const group of rowPlan.debt_groups ?? []) {
    link(
      "mechanical.gross_debt_excluding_leases",
      `debt_group.${group.group_id}.subtotal`,
    );
    link(
      "mechanical.instrument_interest",
      `interest_group.${group.group_id}.subtotal`,
    );
  }

  for (const [consumer, precedent] of [
    ["mechanical.total_acquisition_debt", "mechanical.acquisition_debt"],
    ["mechanical.gross_debt_excluding_leases", "mechanical.total_acquisition_debt"],
    ["mechanical.total_lease_liabilities", "mechanical.lease_liability"],
    ["mechanical.gross_debt_including_leases", "mechanical.gross_debt_excluding_leases"],
    ["mechanical.gross_debt_including_leases", "mechanical.total_lease_liabilities"],
    ["mechanical.net_debt_excluding_leases", "mechanical.gross_debt_excluding_leases"],
    ["mechanical.net_debt_excluding_leases", "mechanical.cash_for_net_debt"],
    ["mechanical.net_debt_including_leases", "mechanical.gross_debt_including_leases"],
    ["mechanical.net_debt_including_leases", "mechanical.cash_for_net_debt"],
    ...(!explicitCashBuckets
      ? [["mechanical.cash_for_net_debt", "mechanical.year_end_cash"]]
      : []),
    ["mechanical.net_debt_to_adjusted_ebitda", "mechanical.net_debt_including_leases"],
    ["mechanical.net_debt_to_adjusted_ebitda", "mechanical.leverage_adjusted_ebitda"],
    ["mechanical.net_debt_excluding_leases_to_adjusted_ebitda", "mechanical.net_debt_excluding_leases"],
    ["mechanical.net_debt_excluding_leases_to_adjusted_ebitda", "mechanical.leverage_adjusted_ebitda"],
    ["mechanical.leverage_net_interest", "mechanical.net_interest_expense"],
    ["mechanical.adjusted_ebitda_to_net_interest", "mechanical.leverage_adjusted_ebitda"],
    ["mechanical.adjusted_ebitda_to_net_interest", "mechanical.leverage_net_interest"],
    ["mechanical.total_change_in_debt", "mechanical.gross_debt_excluding_leases"],
    ["mechanical.undrawn_rcf", "mechanical.ending_rcf"],
    ["mechanical.total_liquidity", "mechanical.undrawn_rcf"],
    [
      "mechanical.total_liquidity",
      explicitCashBuckets
        ? "mechanical.liquidity_cash"
        : "mechanical.year_end_cash",
    ],
    ["mechanical.total_liquidity", "mechanical.drawn_commercial_paper"],
    ["mechanical.ending_rcf", "mechanical.rcf_draw_waterfall"],
    ["mechanical.ending_rcf", "mechanical.rcf_repayment_waterfall"],
    ["mechanical.ending_rcf", "mechanical.opening_rcf"],
    ["mechanical.rcf_draw_waterfall", "mechanical.cash_surplus_deficit"],
    ["mechanical.rcf_repayment_waterfall", "mechanical.cash_surplus_deficit"],
    ["mechanical.cash_surplus_deficit", "mechanical.cash_before_rcf"],
    ["mechanical.cash_surplus_deficit", "mechanical.minimum_cash"],
    ["mechanical.liquidity_shortfall", "mechanical.minimum_cash"],
    ["mechanical.liquidity_shortfall", "mechanical.cash_before_rcf"],
    ["mechanical.liquidity_shortfall", "mechanical.rcf_draw_waterfall"],
    ["mechanical.liquidity_shortfall", "mechanical.rcf_repayment_waterfall"],
    ["mechanical.cash_before_rcf", "mechanical.pre_rcf_debt_cash_flow"],
    ["mechanical.cash_before_rcf", "mechanical.non_rcf_debt_proceeds"],
    ["mechanical.cash_before_rcf", "mechanical.lease_principal_waterfall"],
    ["mechanical.pre_rcf_debt_cash_flow", "mechanical.cash_before_debt"],
    ...(!explicitCashBuckets
      ? [
          ["mechanical.year_end_cash", "mechanical.ending_rcf"],
          ["mechanical.year_end_cash", "mechanical.cash_before_rcf"],
        ]
      : [["mechanical.year_end_cash", "mechanical.liquidity_cash"]]),
    ["mechanical.rcf_total_fees", "mechanical.rcf_interest"],
    ["mechanical.rcf_total_fees", "mechanical.rcf_commitment_fee"],
    ["mechanical.rcf_interest", "mechanical.ending_rcf"],
    ["mechanical.rcf_commitment_fee", "mechanical.ending_rcf"],
    ["mechanical.lease_interest", "mechanical.lease_liability"],
    ["mechanical.acquisition_interest", "mechanical.acquisition_debt"],
    ["mechanical.gross_interest_expense", "mechanical.interest_identified_total"],
    ...(!explicitCashBuckets
      ? [
          ["mechanical.interest_income_schedule", "mechanical.year_end_cash"],
          ["mechanical.interest_income_schedule", "mechanical.cash_for_net_debt"],
        ]
      : []),
    ["mechanical.net_interest_expense", "mechanical.gross_interest_expense"],
    ["mechanical.net_interest_expense", "mechanical.interest_income_schedule"],
    ["mechanical.cash_interest_paid", "mechanical.gross_interest_expense"],
    ["mechanical.cash_interest_received", "mechanical.interest_income_schedule"],
    ["mechanical.cash_before_debt", "mechanical.net_interest_expense"],
    ["mechanical.cash_before_debt", "mechanical.interest_identified_total"],
  ]) {
    link(consumer, precedent);
  }
  link(
    "mechanical.leverage_adjusted_ebitda",
    statement("adjusted_ebitda") ?? statement("reported_ebitda"),
  );
  link(statement("interest_expense"), "mechanical.gross_interest_expense");
  link(statement("interest_income"), "mechanical.interest_income_schedule");
  link(statement("cash_interest_paid"), "mechanical.cash_interest_paid");
  link(statement("cash_interest_received"), "mechanical.cash_interest_received");
  link("mechanical.cash_before_debt", statement("cash_from_operations"));
  link("mechanical.cash_before_debt", statement("cash_from_investing"));
  link("mechanical.cash_before_debt", statement("fx_effect_on_cash"));

  for (const component of [
    "mechanical.instrument_interest",
    "mechanical.acquisition_interest",
    "mechanical.rcf_total_fees",
    "mechanical.lease_interest",
    "mechanical.other_unallocated_interest",
    "mechanical.non_cash_interest",
  ]) {
    link("mechanical.interest_identified_total", component);
  }
  const deduplicated = new Map();
  for (const edge of edges) {
    const key = `${edge.edge_type}\u0000${edge.from}\u0000${edge.to}`;
    if (!deduplicated.has(key)) deduplicated.set(key, edge);
  }
  return [...deduplicated.values()].sort(
    (left, right) =>
      left.edge_type.localeCompare(right.edge_type) ||
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to),
  );
}

function sourceInventory(modelCase) {
  const sources = [];
  for (const section of ["income_statement", "cash_flow"]) {
    for (const disclosure of modelCase.source_coverage?.[section] ?? []) {
      sources.push({
        source_line_id: disclosure.source_line_id,
        section,
        label: disclosure.label,
        document: disclosure.document,
        page_or_note: disclosure.page_or_note,
        face_statement: disclosure.face_statement,
        material: disclosure.material,
        disposition: disclosure.disposition,
        mapping_method: disclosure.mapping_method ?? null,
        mapped_row_ids: [...(disclosure.mapped_row_ids ?? [])],
        reason: disclosure.reason ?? null,
      });
    }
  }
  return sources.sort((left, right) =>
    left.source_line_id.localeCompare(right.source_line_id),
  );
}

export function compileSemanticManifest(
  modelCase,
  rowPlan,
  { instrumentPeriodState = null } = {},
) {
  const compiledInstrumentPeriodState = instrumentPeriodState ??
    (Number(modelCase.contract_version) === 2
      ? compileInstrumentPeriodState(modelCase)
      : null);
  const rcfInstrument = (modelCase.instruments ?? []).find(
    (instrument) =>
      instrument.instrument_id === modelCase.rcf_policy?.instrument_id,
  );
  const nodes = [
    ...statementNodes(modelCase, rowPlan),
    ...instrumentNodes(modelCase, rowPlan, compiledInstrumentPeriodState),
    ...cashBucketNodes(rowPlan),
    ...mechanicalNodes(rowPlan),
  ].sort(
    (left, right) =>
      Number(left.physical_row ?? Number.MAX_SAFE_INTEGER) -
        Number(right.physical_row ?? Number.MAX_SAFE_INTEGER) ||
      left.node_id.localeCompare(right.node_id),
  );
  const historicalInterestAuthority =
    resolveHistoricalInterestAuthority(modelCase);
  if (!historicalInterestAuthority.valid) {
    throw new Error(
      `Cannot seal semantic graph with invalid historical interest authority: ${historicalInterestAuthority.errors.join(" ")}`,
    );
  }
  const layeredGraphConstitution = compileLayeredGraphConstitution(
    modelCase,
    rowPlan,
  );
  return {
    schema_version: 1,
    contract_version: Number(modelCase.contract_version),
    case_id: modelCase.case_id,
    case_sha256: deterministicCaseHash(modelCase),
    issuer: modelCase.issuer?.name ?? null,
    accounting_basis: modelCase.issuer?.accounting_basis ?? null,
    fiscal_year_end: modelCase.issuer?.fiscal_year_end ?? null,
    fiscal_calendar: modelCase.issuer?.fiscal_calendar ?? "fixed_date",
    rcf_contract: {
      mode: balancingRcfMode(modelCase),
      instrument_id: modelCase.rcf_policy?.instrument_id ?? null,
      currency: rcfInstrument?.currency ?? null,
      reporting_currency: modelCase.issuer?.reporting_currency ?? null,
      amount_basis: "facility_native_currency",
      fx_quote:
        rcfInstrument?.currency === modelCase.issuer?.reporting_currency
          ? "at_par"
          : modelCase.fx?.[rcfInstrument?.currency]?.quote ?? null,
      policy_opening_draw: modelCase.rcf_policy?.opening_draw ?? null,
      instrument_opening_balance: rcfInstrument?.opening_balance ?? null,
      policy_capacity: modelCase.rcf_policy?.capacity ?? null,
      instrument_capacity: rcfInstrument?.facility_capacity ?? null,
    },
    presentation_profile:
      modelCase.presentation_profile ?? rowPlan.profile ?? "crh_dynamic",
    periods: (modelCase.periods ?? []).map((period, period_index) => ({
      period_index,
      date: period.date,
      status: period.status,
    })),
    movement_contract: MOVEMENT_DEFINITIONS,
    instrument_period_state: compiledInstrumentPeriodState,
    definition_basis_graph:
      compiledInstrumentPeriodState?.definition_basis_graph ?? null,
    historical_interest_authority: historicalInterestAuthority.present
      ? {
          basis: historicalInterestAuthority.basis,
          basis_was_explicit:
            historicalInterestAuthority.basis_was_explicit,
          has_filed_total: historicalInterestAuthority.has_filed_total,
          filed_finance_expense:
            historicalInterestAuthority.filed_finance_expense,
          reported_debt_interest:
            historicalInterestAuthority.reported_debt_interest,
          identified_finance_components:
            historicalInterestAuthority.identified_finance_components,
          identified_debt_components:
            historicalInterestAuthority.identified_debt_components,
          lease_interest: historicalInterestAuthority.lease_interest,
          unallocated_interest:
            historicalInterestAuthority.unallocated_interest,
        }
      : null,
    statement_topology: Object.fromEntries(
      ["income_statement", "cash_flow"].map((section) => [
        section,
        compileStatementTopology(
          modelCase,
          section,
          rowPlan.statement_rows?.[section] ?? [],
        ),
      ]),
    ),
    layered_graph_constitution: layeredGraphConstitution,
    source_inventory: sourceInventory(modelCase),
    nodes,
    edges: graphEdges(nodes, rowPlan),
  };
}

export function compileSourceCrosswalk(modelCase, rowPlan, manifest = null) {
  const graph = manifest ?? compileSemanticManifest(modelCase, rowPlan);
  const statementByRowId = new Map(
    graph.nodes
      .filter((node) => node.node_kind === "statement_row")
      .map((node) => [node.row_id, node]),
  );
  const rows = [];
  for (const source of graph.source_inventory) {
    const destinations =
      source.mapped_row_ids.length > 0 ? source.mapped_row_ids : [null];
    for (const mappedRowId of destinations) {
      const destination = mappedRowId
        ? statementByRowId.get(mappedRowId)
        : null;
      const normaliseLabel = (value) =>
        String(value ?? "")
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, " ")
          .trim();
      const inferredMappingMethod =
        source.disposition === "not_applicable"
          ? "not_applicable"
          : source.disposition === "aggregated"
            ? source.mapped_row_ids.length > 1
              ? "split"
              : "aggregate"
            : source.mapped_row_ids.length > 1
              ? "split"
              : normaliseLabel(source.label) ===
                  normaliseLabel(destination?.label)
                ? "exact"
                : "renamed";
      rows.push({
        source_line_id: source.source_line_id,
        source_section: source.section,
        source_label: source.label,
        source_document: source.document,
        source_page_or_note: source.page_or_note,
        face_statement: source.face_statement,
        material: source.material,
        disposition: source.disposition,
        mapping_method: source.mapping_method ?? inferredMappingMethod,
        destination_row_id: mappedRowId,
        destination_physical_row: destination?.physical_row ?? null,
        destination_label: destination?.label ?? null,
        destination_semantic_role: destination?.semantic_role ?? null,
        movement_type: destination?.movement_type ?? null,
        mapping_status:
          !mappedRowId
            ? source.disposition === "not_applicable"
              ? "documented_exclusion"
              : "unmapped"
            : destination
              ? "resolved"
              : "unresolved_destination",
        reason: source.reason,
      });
    }
  }
  return rows.sort(
    (left, right) =>
      left.source_line_id.localeCompare(right.source_line_id) ||
      String(left.destination_row_id ?? "").localeCompare(
        String(right.destination_row_id ?? ""),
      ),
  );
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "boolean" ? String(value) : `${value}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function sourceCrosswalkCsv(rows) {
  const columns = [
    "source_line_id",
    "source_section",
    "source_label",
    "source_document",
    "source_page_or_note",
    "face_statement",
    "material",
    "disposition",
    "mapping_method",
    "destination_row_id",
    "destination_physical_row",
    "destination_label",
    "destination_semantic_role",
    "movement_type",
    "mapping_status",
    "reason",
  ];
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
    "",
  ].join("\n");
}
