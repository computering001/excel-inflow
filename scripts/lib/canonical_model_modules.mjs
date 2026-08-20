/**
 * P4.4 — THE NINE-MODULE CANONICAL MODEL GRAPH, MADE REAL AS A CHECKED
 * STRUCTURE OVER THE EXISTING SOLVER.
 *
 * `assets/canonical-model-graph-v2.json` has declared nine modules, an
 * eight-field `module_contract` and six graph invariants since v2.0. Before
 * this module NOTHING implemented any of it: the only reader in the repository
 * is `policy_registry.mjs:34`, which consumes `.modules` as an opaque list of
 * strings to validate a policy's `owned_assumption.module`. `module_version`,
 * `read_set`, `write_set`, `iteration_state`, `nodes`, `edges` and every one of
 * the six invariant names had ZERO producers and ZERO consumers anywhere.
 *
 * The v3.7.7 pack forbids decomposing `scripts/lib/solver.mjs` before the
 * freeze, so this module does NOT extract `solveCase`. It makes the declared
 * contract REAL in the only other way that can be honest: every module's
 * boundary — its nodes, its edges, what it reads, what it writes, what iterates
 * inside it and what it promises — is DECLARED here and VALIDATED against what
 * the solver actually produces. Phase 9's extraction then has a contract to
 * extract against rather than an opinion.
 *
 * WHAT THIS MODULE IS NOT: it computes no economics, it is imported by no
 * production path, and it repairs nothing. It is a validator. Every function
 * either returns typed errors or throws; none of them writes a number.
 *
 * The three registers this package builds ON rather than duplicates:
 *   - P4.6 (`layered_graph_constitution.mjs`) owns the equation-node ->
 *     statement-row relation. Every `statement_row` carrier below is RESOLVED
 *     through P4.6's compiled artifact, never re-declared here, and the two
 *     registers' dispositions are checked for exact set equality.
 *   - P4.3 (`schedule_typed_states.mjs`) owns the typed RCF / acquisition /
 *     cash states; they are bound here as module outputs.
 *   - P4.1 (the opening-debt bridge on the solved artifact) owns opening
 *     instrument provenance; it is bound here as `historical_statements`'
 *     output and consumed as `debt_instruments`' declared cross-module read.
 *   - P4.8 (`scripts/verify/solver_fixed_point_oracle.py`) independently
 *     recomputes the fixed point, the RCF sweep from cash need and the
 *     seven-term roll-forward. Module invariants that the oracle also
 *     recomputes carry `independent_confirmation`, and the suite PINS the
 *     oracle's declared domains so a dropped domain turns this package red
 *     rather than silently downgrading a confirmation to an assertion.
 */
import crypto from "node:crypto";
import fs from "node:fs";

import {
  EQUATION_GRAPH,
  activeEquationEdges,
  deriveStronglyConnectedComponents,
} from "./equation_graph.mjs";
import {
  ECONOMIC_STATEMENT_BINDING,
  economicStatementBindings,
} from "./layered_graph_constitution.mjs";
import { solverIterationDeclaration } from "./solver.mjs";

export const CANONICAL_MODEL_MODULE_SCOPE = "canonical-model-modules/1.0";

export const CANONICAL_MODEL_GRAPH = Object.freeze(
  JSON.parse(
    fs.readFileSync(
      new URL("../../assets/canonical-model-graph-v2.json", import.meta.url),
      "utf8",
    ),
  ),
);

/** The eight fields the asset's own `module_contract` demands of a module. */
export const MODULE_CONTRACT_REQUIRED_FIELDS = Object.freeze([
  ...CANONICAL_MODEL_GRAPH.module_contract.required_fields,
]);

/** The six invariant names the asset declares and nothing validated. */
export const DECLARED_GRAPH_INVARIANTS = Object.freeze([
  ...CANONICAL_MODEL_GRAPH.invariants,
]);

export const MODULE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// Node ownership
// ---------------------------------------------------------------------------

/**
 * The rule, declared once so it can be checked rather than argued: a node is
 * owned by the module its equation-graph `domain` maps to, EXCEPT where a
 * domain genuinely spans modules, in which case the exception is named with a
 * basis. `income_statement` is the only spanning domain — the income statement
 * is where three different modules publish (operating, interest, tax) — and
 * every one of its seven nodes is listed below with its reason.
 */
export const DOMAIN_TO_MODULE = Object.freeze({
  cash_flow_statement: "cash_rcf",
  cash_waterfall: "cash_rcf",
  debt_schedule: "debt_instruments",
  interest_schedule: "interest",
  lease_schedule: "leases",
});

export const NODE_OWNER_EXCEPTIONS = Object.freeze({
  "statement.ebit": Object.freeze({
    module_id: "operating_forecast",
    basis:
      "EBIT is the operating forecast's terminal output; the EBITDA-less-D&A " +
      "bridge that produces it is validated as an operating_forecast invariant",
  }),
  "statement.finance_expense": Object.freeze({
    module_id: "interest",
    basis:
      "the income statement's finance-cost line is the interest module's " +
      "statement realisation (P4.6 join_basis model_ir_crosswalk)",
  }),
  "statement.finance_income": Object.freeze({
    module_id: "interest",
    basis:
      "the income statement's finance-income line is the interest module's " +
      "statement realisation (P4.6 join_basis model_ir_crosswalk)",
  }),
  "statement.pre_tax_income": Object.freeze({
    module_id: "tax_and_working_capital",
    basis: "P3.3 effective-tax-rate path (P4.6 join_basis etr_path)",
  }),
  "statement.effective_tax_rate": Object.freeze({
    module_id: "tax_and_working_capital",
    basis: "P3.3 effective-tax-rate path (P4.6 join_basis etr_path)",
  }),
  "statement.tax_expense": Object.freeze({
    module_id: "tax_and_working_capital",
    basis: "P3.3 effective-tax-rate path (P4.6 join_basis etr_path)",
  }),
  "statement.net_income": Object.freeze({
    module_id: "tax_and_working_capital",
    basis: "P3.3 effective-tax-rate path (P4.6 join_basis etr_path)",
  }),
});

/**
 * DECLARED, not overlooked: the nine-module contract has no module that can own
 * the solver control. `control.circularity` is a kill switch over the whole
 * model, not an economic output of any one module, and P4.6 already types it
 * `solver_control` rather than a row realisation. It is therefore declared
 * unowned WITH a reason, and the totality obligation below requires
 * owned ∪ unowned to equal the graph's node set exactly, so this can never
 * become a silent omission.
 */
export const UNOWNED_EQUATION_NODES = Object.freeze([
  Object.freeze({
    node_id: "control.circularity",
    reason:
      "the circularity kill switch is a model-level solver control, not an " +
      "economic output; none of the nine declared modules can own it without " +
      "claiming authority over the other eight",
    carried_by: "solution.equation_graph_evidence.active_circularity_state",
  }),
]);

// ---------------------------------------------------------------------------
// Carriers — where a declared node's value actually lives on a solved artifact
// ---------------------------------------------------------------------------

/**
 * Mirror expressions. Deliberately a four-operator toy language rather than a
 * callback: a carrier's relationship to the solver's own scalars is DATA, so a
 * validator can print it, hash it and refuse to let it drift, and so a future
 * reader can see that `cash.cash_interest_paid` is minus (gross interest less
 * the non-cash part) rather than take it on trust.
 */
function evaluateMirror(expression, period) {
  if (expression === null || expression === undefined) return null;
  switch (expression.op) {
    case "field": {
      const value = Number(period?.[expression.name]);
      return Number.isFinite(value) ? value : null;
    }
    case "neg": {
      const inner = evaluateMirror(expression.of, period);
      return inner === null ? null : -inner;
    }
    case "sub": {
      const left = evaluateMirror(expression.left, period);
      const right = evaluateMirror(expression.right, period);
      return left === null || right === null ? null : left - right;
    }
    case "div": {
      const left = evaluateMirror(expression.left, period);
      const right = evaluateMirror(expression.right, period);
      if (left === null || right === null || right === 0) return null;
      return left / right;
    }
    default:
      throw new Error(`Unknown mirror operator ${JSON.stringify(expression?.op)}.`);
  }
}
export { evaluateMirror };

const field = (name) => Object.freeze({ op: "field", name });
const neg = (of) => Object.freeze({ op: "neg", of });
const sub = (left, right) => Object.freeze({ op: "sub", left, right });
const div = (left, right) => Object.freeze({ op: "div", left, right });

/**
 * Every owned node's carrier on the solved artifact.
 *
 * `channel`:
 *   statement_row        the value lives on a declared statement row; the row is
 *                        RESOLVED through P4.6's compiled binding, never named
 *                        here, so the two registers cannot drift apart.
 *   period_field         a scalar on `solution.forecast[i]`.
 *   instrument_aggregate the sum of a field over `forecast[i].instrument_results`.
 *
 * `denomination` is the unit slice this package CAN check (see the
 * `unit_compatible_edges` declaration): `reporting`, `native` or `ratio`.
 * A module invariant may not mix denominations.
 */
export const NODE_CARRIERS = Object.freeze({
  // --- interest -----------------------------------------------------------
  "interest.acquisition": Object.freeze({
    channel: "period_field", field: "acquisition_interest", denomination: "reporting",
  }),
  "interest.cash_income": Object.freeze({
    channel: "period_field", field: "interest_income", denomination: "reporting",
  }),
  "interest.commitment_fee": Object.freeze({
    channel: "period_field", field: "rcf_commitment_fee", denomination: "reporting",
  }),
  "interest.gross_expense": Object.freeze({
    channel: "period_field", field: "gross_interest", denomination: "reporting",
  }),
  "interest.income": Object.freeze({
    channel: "period_field", field: "interest_income", denomination: "reporting",
  }),
  "interest.instrument_cash": Object.freeze({
    channel: "instrument_aggregate", field: "cash_coupon_interest_reporting",
    denomination: "reporting",
  }),
  "interest.instrument_pik": Object.freeze({
    channel: "instrument_aggregate", field: "pik_interest_reporting",
    denomination: "reporting",
  }),
  "interest.lease": Object.freeze({
    channel: "period_field", field: "lease_interest", denomination: "reporting",
  }),
  "interest.net_expense": Object.freeze({
    channel: "period_field", field: "net_interest", denomination: "reporting",
  }),
  "interest.noncash": Object.freeze({
    channel: "period_field", field: "non_cash_interest", denomination: "reporting",
  }),
  "interest.other": Object.freeze({
    channel: "period_field", field: "other_interest", denomination: "reporting",
  }),
  "interest.rcf": Object.freeze({
    channel: "period_field", field: "rcf_interest", denomination: "reporting",
  }),
  "statement.finance_expense": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: neg(field("gross_interest")),
  }),
  "statement.finance_income": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: field("interest_income"),
  }),

  // --- debt_instruments ---------------------------------------------------
  "debt.issuance": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: field("non_rcf_debt_issuance"),
  }),
  "debt.mandatory_repayment": Object.freeze({
    channel: "period_field", field: "mandatory_repayment", denomination: "reporting",
  }),
  "debt.maturity_repayment": Object.freeze({
    channel: "instrument_aggregate", field: "maturity_repayment_native",
    denomination: "native",
  }),
  "debt.pik_accretion": Object.freeze({
    channel: "instrument_aggregate", field: "pik_interest_native",
    denomination: "native",
  }),
  "debt.scheduled_amortisation": Object.freeze({
    channel: "instrument_aggregate", field: "amortisation_native",
    denomination: "native",
  }),

  // --- leases -------------------------------------------------------------
  "lease.principal": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: neg(field("lease_principal")),
  }),

  // --- cash_rcf -----------------------------------------------------------
  "cash.cash_interest_paid": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: neg(sub(field("gross_interest"), field("non_cash_interest"))),
  }),
  "cash.cash_interest_received": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: field("interest_income"),
  }),
  "cash.cfo": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: field("cash_from_operations"),
  }),
  "cash.ending_balance": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: field("ending_cash"),
  }),
  "cash.minimum_cash": Object.freeze({
    channel: "period_field", field: "minimum_cash", denomination: "reporting",
  }),
  "cash.net_finance_addback": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: field("net_interest"),
  }),
  // P4.6 records this as the one statement_row node that is `row_absent` on
  // both certified fixtures: neither files a non-cash interest addback row.
  // Its presence class is NOT re-declared here — see `carrierPresence`.
  "cash.noncash_interest_addback": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: field("non_cash_interest"),
  }),
  "rcf.capacity": Object.freeze({
    channel: "period_field", field: "rcf_capacity_native", denomination: "native",
  }),
  "rcf.draw": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: field("rcf_draw"),
  }),
  "rcf.ending_balance": Object.freeze({
    channel: "period_field", field: "ending_rcf", denomination: "reporting",
  }),
  "rcf.liquidity_shortfall": Object.freeze({
    channel: "period_field", field: "liquidity_shortfall", denomination: "reporting",
  }),
  "rcf.repayment": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: neg(field("rcf_repayment")),
  }),
  "statement.cash_flow_start": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: field("net_income"),
  }),

  // --- operating_forecast -------------------------------------------------
  "statement.ebit": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: field("ebit"),
  }),

  // --- tax_and_working_capital -------------------------------------------
  "statement.pre_tax_income": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: field("pre_tax_income"),
  }),
  "statement.effective_tax_rate": Object.freeze({
    channel: "statement_row", denomination: "ratio",
    mirror: div(field("tax"), field("pre_tax_income")),
  }),
  "statement.tax_expense": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: neg(field("tax")),
  }),
  "statement.net_income": Object.freeze({
    channel: "statement_row", denomination: "reporting",
    mirror: field("net_income"),
  }),
});

// ---------------------------------------------------------------------------
// Module invariants
// ---------------------------------------------------------------------------

const TOLERANCE = 1e-6;

/**
 * A statement-row carrier's presence class is P4.6's, not a second opinion.
 * P4.6 declares exactly five equation nodes whose statement row is already
 * mandatory downstream (`presence: "required"`); every other realisation is
 * `case_optional`, because a case that files no cash-flow statement row for a
 * role is a lawful variant P4.6 records as `row_absent` rather than blocks.
 * Re-declaring these here would create a second authority for one fact.
 */
export function carrierPresence(nodeId) {
  const carrier = NODE_CARRIERS[nodeId];
  if (!carrier) return null;
  if (carrier.channel !== "statement_row") return "always";
  return ECONOMIC_STATEMENT_BINDING[nodeId]?.presence ?? "case_optional";
}

/**
 * The unit slice this repository can actually check. `native` is an
 * instrument's or a facility's own currency, `reporting` the case's reporting
 * currency, `ratio` a dimensionless quotient, `identity` a non-numeric
 * structural claim, and `mixed_translation` the ONE lawful crossing — an FX
 * translation, which must name both a native operand and the rate that carries
 * it across.
 */
export const DECLARED_DENOMINATIONS = Object.freeze([
  "reporting",
  "native",
  "ratio",
  "identity",
  "mixed_translation",
]);

const near = (left, right, tolerance = TOLERANCE) =>
  Number.isFinite(Number(left)) &&
  Number.isFinite(Number(right)) &&
  Math.abs(Number(left) - Number(right)) <= tolerance;

const sumOver = (rows, name) =>
  (rows ?? []).reduce((total, row) => total + Number(row?.[name] ?? 0), 0);

function statementRowsOf(modelCase) {
  return [
    ...(modelCase?.statement_structure?.income_statement ?? []),
    ...(modelCase?.statement_structure?.cash_flow ?? []),
  ];
}

function soleRowForRole(modelCase, role) {
  const matches = statementRowsOf(modelCase).filter(
    (row) => row?.semantic_role === role,
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Every module invariant, declared as data with an evaluator that returns a
 * list of failures. `operands` names the artifact quantities the evaluator
 * touches and `denomination` the unit slice they share — both are checked, so
 * a mixed-denomination identity cannot be added without the unit obligation
 * catching it.
 */
export const MODULE_INVARIANTS = Object.freeze([
  // --- historical_statements ---------------------------------------------
  Object.freeze({
    invariant_id: "historical.period_calendar_is_the_case_calendar",
    module_id: "historical_statements",
    statement:
      "the solved artifact's period calendar is the case's own, unaltered",
    denomination: "identity",
    operands: Object.freeze(["solution.periods", "case.periods"]),
    evaluate({ modelCase, solution }) {
      return JSON.stringify(solution.periods) === JSON.stringify(modelCase.periods)
        ? []
        : ["solution.periods does not equal case.periods"];
    },
  }),
  Object.freeze({
    invariant_id: "historical.opening_instrument_provenance_is_declared",
    module_id: "historical_statements",
    statement:
      "every opening instrument balance the forecast starts from is carried by " +
      "exactly one opening-debt-bridge line with a non-empty source reference " +
      "and a matching amount (P4.1)",
    denomination: "native",
    independent_confirmation: "solver-fixed-point-oracle:opening_debt",
    operands: Object.freeze([
      "solution.opening_debt_bridge.lines[]",
      "forecast[0].instrument_results[].opening_native",
    ]),
    evaluate({ solution }) {
      const failures = [];
      const bridge = solution.opening_debt_bridge;
      if (!bridge || !Array.isArray(bridge.lines)) {
        return ["solution.opening_debt_bridge carries no lines"];
      }
      if (typeof bridge.schema_version !== "string") {
        failures.push("opening_debt_bridge.schema_version absent");
      }
      const openings = solution.forecast?.[0]?.instrument_results ?? [];
      for (const instrument of openings) {
        const lines = bridge.lines.filter(
          (line) =>
            (line.line_kind === "instrument_opening" ||
              line.line_kind === "residual_pool") &&
            line.instrument_id === instrument.instrument_id,
        );
        if (lines.length !== 1) {
          failures.push(
            `${instrument.instrument_id}: ${lines.length} opening bridge lines, expected 1`,
          );
          continue;
        }
        if (!near(lines[0].amount, instrument.opening_native)) {
          failures.push(
            `${instrument.instrument_id}: bridge ${lines[0].amount} != opening_native ${instrument.opening_native}`,
          );
        }
        if (!lines[0].source_ref) {
          failures.push(`${instrument.instrument_id}: bridge line has no source_ref`);
        }
      }
      return failures;
    },
  }),

  // --- operating_forecast -------------------------------------------------
  Object.freeze({
    invariant_id: "operating.ebit_ebitda_bridge_closes",
    module_id: "operating_forecast",
    statement:
      "EBIT equals adjusted EBITDA less D&A, or the residual is exactly the " +
      "sum of the additional rows the case's own EBIT calculation declares",
    denomination: "reporting",
    independent_confirmation: "solver-fixed-point-oracle:convergence",
    operands: Object.freeze([
      "forecast[].ebit",
      "forecast[].adjusted_ebitda",
      "forecast[].depreciation_and_amortisation",
    ]),
    evaluate({ modelCase, solution }) {
      const failures = [];
      const ebitRow = soleRowForRole(modelCase, "ebit");
      const daRowIds = new Set(
        statementRowsOf(modelCase)
          .filter((row) => row?.semantic_role === "depreciation_and_amortisation")
          .map((row) => row.row_id),
      );
      const ebitdaRowIds = new Set(
        statementRowsOf(modelCase)
          .filter((row) => row?.semantic_role === "adjusted_ebitda")
          .map((row) => row.row_id),
      );
      solution.forecast.forEach((period, index) => {
        const residual =
          Number(period.ebit) -
          (Number(period.adjusted_ebitda) -
            Number(period.depreciation_and_amortisation));
        if (Math.abs(residual) <= TOLERANCE) return;
        const refs =
          ebitRow?.forecast_calculation?.refs ?? ebitRow?.calculation?.refs ?? [];
        const extras = refs.filter(
          (ref) =>
            !daRowIds.has(ref) &&
            !ebitdaRowIds.has(ref) &&
            !/da_expense|depreciation/.test(ref),
        );
        const declared = extras.reduce(
          (total, ref) => total + Number(period.statement_values?.[ref] ?? 0),
          0,
        );
        if (!near(declared, residual)) {
          failures.push(
            `p${index}: EBIT bridge residual ${residual} is not the declared extras ${JSON.stringify(extras)} = ${declared}`,
          );
        }
      });
      return failures;
    },
  }),

  // --- tax_and_working_capital -------------------------------------------
  Object.freeze({
    invariant_id: "tax.pre_tax_income_bridge",
    module_id: "tax_and_working_capital",
    statement:
      "profit before tax is EBIT less net interest plus other non-operating " +
      "items, wherever the case does not supply profit before tax as data",
    denomination: "reporting",
    independent_confirmation: "solver-fixed-point-oracle:convergence",
    operands: Object.freeze([
      "forecast[].pre_tax_income",
      "forecast[].ebit",
      "forecast[].net_interest",
      "forecast[].other_non_operating",
    ]),
    evaluate({ modelCase, solution }) {
      const row = soleRowForRole(modelCase, "pre_tax_income");
      if (Array.isArray(row?.values)) return [];
      return solution.forecast.flatMap((period, index) =>
        near(
          period.pre_tax_income,
          Number(period.ebit) -
            Number(period.net_interest) +
            Number(period.other_non_operating),
        )
          ? []
          : [`p${index}: pre_tax_income ${period.pre_tax_income} != ebit - net_interest + other_non_operating`],
      );
    },
  }),
  Object.freeze({
    invariant_id: "tax.net_income_after_tax",
    module_id: "tax_and_working_capital",
    statement:
      "profit after tax is profit before tax less the tax charge, wherever the " +
      "case does not supply profit after tax as data",
    denomination: "reporting",
    operands: Object.freeze([
      "forecast[].net_income",
      "forecast[].pre_tax_income",
      "forecast[].tax",
    ]),
    evaluate({ modelCase, solution }) {
      const row = soleRowForRole(modelCase, "net_income");
      if (Array.isArray(row?.values)) return [];
      return solution.forecast.flatMap((period, index) =>
        near(period.net_income, Number(period.pre_tax_income) - Number(period.tax))
          ? []
          : [`p${index}: net_income ${period.net_income} != pre_tax_income - tax`],
      );
    },
  }),
  Object.freeze({
    invariant_id: "tax.charge_is_the_declared_effective_rate",
    module_id: "tax_and_working_capital",
    statement:
      "the tax charge is the declared effective tax rate applied to profit " +
      "before tax (P3.3's ETR path, read off the statement row it writes)",
    denomination: "reporting",
    independent_confirmation: "solver-fixed-point-oracle:effective_tax_rate",
    operands: Object.freeze([
      "forecast[].tax",
      "forecast[].pre_tax_income",
      "forecast[].statement_values.effective_tax_rate",
    ]),
    evaluate({ modelCase, solution }) {
      const row = soleRowForRole(modelCase, "effective_tax_rate");
      if (!row) return [];
      return solution.forecast.flatMap((period, index) => {
        const rate = period.statement_values?.[row.row_id];
        if (rate === undefined || rate === null) return [];
        return near(period.tax, Number(rate) * Number(period.pre_tax_income))
          ? []
          : [`p${index}: tax ${period.tax} != etr ${rate} x pre_tax_income ${period.pre_tax_income}`];
      });
    },
  }),

  // --- debt_instruments ---------------------------------------------------
  Object.freeze({
    invariant_id: "debt.seven_term_roll_forward",
    module_id: "debt_instruments",
    statement:
      "every instrument-period closes on the seven declared movement terms: " +
      "ending = opening + issuance + fair value + other non-cash + PIK " +
      "- amortisation - maturity",
    denomination: "native",
    independent_confirmation: "solver-fixed-point-oracle:debt_roll_forward",
    operands: Object.freeze([
      "forecast[].instrument_results[].opening_native",
      "forecast[].instrument_results[].issuance_native",
      "forecast[].instrument_results[].fair_value_movement_native",
      "forecast[].instrument_results[].other_non_cash_movement_native",
      "forecast[].instrument_results[].pik_interest_native",
      "forecast[].instrument_results[].amortisation_native",
      "forecast[].instrument_results[].maturity_repayment_native",
      "forecast[].instrument_results[].ending_native",
    ]),
    evaluate({ solution }) {
      const failures = [];
      solution.forecast.forEach((period, index) => {
        for (const item of period.instrument_results ?? []) {
          const expected =
            Number(item.opening_native) +
            Number(item.issuance_native) +
            Number(item.fair_value_movement_native) +
            Number(item.other_non_cash_movement_native) +
            Number(item.pik_interest_native) -
            Number(item.amortisation_native) -
            Number(item.maturity_repayment_native);
          if (!near(item.ending_native, expected)) {
            failures.push(
              `p${index} ${item.instrument_id}: ending_native ${item.ending_native} != seven-term ${expected}`,
            );
          }
        }
      });
      return failures;
    },
  }),
  Object.freeze({
    invariant_id: "debt.period_opening_continuity",
    module_id: "debt_instruments",
    statement:
      "each instrument's opening balance in period n is its ending balance in " +
      "period n-1",
    denomination: "native",
    independent_confirmation: "solver-fixed-point-oracle:debt_roll_forward",
    operands: Object.freeze([
      "forecast[].instrument_results[].opening_native",
      "forecast[].instrument_results[].ending_native",
    ]),
    evaluate({ solution }) {
      const failures = [];
      solution.forecast.forEach((period, index) => {
        if (index === 0) return;
        const previous = solution.forecast[index - 1].instrument_results ?? [];
        for (const item of period.instrument_results ?? []) {
          const prior = previous.find(
            (candidate) => candidate.instrument_id === item.instrument_id,
          );
          if (!prior) continue;
          if (!near(item.opening_native, prior.ending_native)) {
            failures.push(
              `p${index} ${item.instrument_id}: opening ${item.opening_native} != prior ending ${prior.ending_native}`,
            );
          }
        }
      });
      return failures;
    },
  }),
  Object.freeze({
    invariant_id: "debt.solver_roll_forward_check_holds",
    module_id: "debt_instruments",
    statement: "the solver's own debt roll-forward check passes in every period",
    denomination: "identity",
    operands: Object.freeze(["forecast[].checks.debt_roll_forward"]),
    evaluate({ solution }) {
      return solution.forecast.flatMap((period, index) =>
        period.checks?.debt_roll_forward === true
          ? []
          : [`p${index}: checks.debt_roll_forward is not true`],
      );
    },
  }),

  // --- leases -------------------------------------------------------------
  Object.freeze({
    invariant_id: "lease.liability_roll_forward",
    module_id: "leases",
    statement:
      "the lease liability closes on opening + additions + other movements " +
      "+ lease interest - principal paid",
    denomination: "reporting",
    operands: Object.freeze([
      "forecast[].opening_interest_bearing_lease",
      "forecast[].lease_additions",
      "forecast[].lease_other_movements",
      "forecast[].lease_interest",
      "forecast[].lease_principal",
      "forecast[].ending_lease",
    ]),
    evaluate({ solution }) {
      return solution.forecast.flatMap((period, index) =>
        near(
          period.ending_lease,
          Number(period.opening_interest_bearing_lease) +
            Number(period.lease_additions) +
            Number(period.lease_other_movements) +
            Number(period.lease_interest) -
            Number(period.lease_principal),
        )
          ? []
          : [`p${index}: ending_lease ${period.ending_lease} does not close on the declared movements`],
      );
    },
  }),
  Object.freeze({
    invariant_id: "lease.period_opening_continuity",
    module_id: "leases",
    statement:
      "the lease opening balance in period n is the ending balance in n-1, and " +
      "the interest-bearing ending balance is the ending balance",
    denomination: "reporting",
    operands: Object.freeze([
      "forecast[].opening_interest_bearing_lease",
      "forecast[].ending_lease",
      "forecast[].ending_interest_bearing_lease",
    ]),
    evaluate({ solution }) {
      const failures = [];
      solution.forecast.forEach((period, index) => {
        if (!near(period.ending_interest_bearing_lease, period.ending_lease)) {
          failures.push(
            `p${index}: ending_interest_bearing_lease != ending_lease`,
          );
        }
        if (index === 0) return;
        if (
          !near(
            period.opening_interest_bearing_lease,
            solution.forecast[index - 1].ending_lease,
          )
        ) {
          failures.push(`p${index}: lease opening != prior ending`);
        }
      });
      return failures;
    },
  }),

  // --- cash_rcf -----------------------------------------------------------
  Object.freeze({
    invariant_id: "cash.waterfall_closes_on_the_revolver",
    module_id: "cash_rcf",
    statement:
      "ending cash is cash after mandatory repayment plus the draw less the " +
      "repayment — the waterfall has no unexplained term",
    denomination: "reporting",
    independent_confirmation: "solver-fixed-point-oracle:rcf_draw_repay",
    operands: Object.freeze([
      "forecast[].ending_cash",
      "forecast[].cash_after_mandatory_repayment",
      "forecast[].rcf_draw",
      "forecast[].rcf_repayment",
    ]),
    evaluate({ solution }) {
      return solution.forecast.flatMap((period, index) =>
        near(
          period.ending_cash,
          Number(period.cash_after_mandatory_repayment) +
            Number(period.rcf_draw) -
            Number(period.rcf_repayment),
        )
          ? []
          : [`p${index}: ending_cash does not close on the waterfall`],
      );
    },
  }),
  Object.freeze({
    invariant_id: "cash.revolver_roll_forward_and_continuity",
    module_id: "cash_rcf",
    statement:
      "the revolver closes on opening + draw - repayment in its own currency, " +
      "and period n opens where n-1 closed",
    denomination: "native",
    independent_confirmation: "solver-fixed-point-oracle:rcf_draw_repay",
    operands: Object.freeze([
      "forecast[].rcf_opening_native",
      "forecast[].rcf_draw_native",
      "forecast[].rcf_repayment_native",
      "forecast[].rcf_ending_native",
    ]),
    evaluate({ solution }) {
      const failures = [];
      solution.forecast.forEach((period, index) => {
        if (
          !near(
            period.rcf_ending_native,
            Number(period.rcf_opening_native) +
              Number(period.rcf_draw_native) -
              Number(period.rcf_repayment_native),
          )
        ) {
          failures.push(`p${index}: revolver does not roll forward`);
        }
        if (
          index > 0 &&
          !near(
            period.rcf_opening_native,
            solution.forecast[index - 1].rcf_ending_native,
          )
        ) {
          failures.push(`p${index}: revolver opening != prior ending`);
        }
      });
      return failures;
    },
  }),
  Object.freeze({
    invariant_id: "cash.revolver_within_declared_capacity",
    module_id: "cash_rcf",
    statement:
      "the drawn revolver never goes negative and never exceeds the declared " +
      "commitment, in the commitment's own currency",
    denomination: "native",
    operands: Object.freeze([
      "forecast[].rcf_ending_native",
      "forecast[].rcf_capacity_native",
    ]),
    evaluate({ solution }) {
      return solution.forecast.flatMap((period, index) =>
        Number(period.rcf_ending_native) >= -TOLERANCE &&
        Number(period.rcf_ending_native) <=
          Number(period.rcf_capacity_native) + TOLERANCE
          ? []
          : [`p${index}: rcf_ending_native ${period.rcf_ending_native} outside [0, ${period.rcf_capacity_native}]`],
      );
    },
  }),
  Object.freeze({
    invariant_id: "cash.sweep_answers_cash_need",
    module_id: "cash_rcf",
    statement:
      "a draw happens only where cash before the revolver is below the declared " +
      "floor, a repayment only where it is above it, and never both at once " +
      "(the sweep is derived FROM cash need, not merely consistent with itself)",
    denomination: "reporting",
    independent_confirmation: "solver-fixed-point-oracle:rcf_draw_repay",
    operands: Object.freeze([
      "forecast[].rcf_draw",
      "forecast[].rcf_repayment",
      "forecast[].cash_after_mandatory_repayment",
      "forecast[].minimum_cash",
    ]),
    evaluate({ solution }) {
      const failures = [];
      solution.forecast.forEach((period, index) => {
        const draw = Number(period.rcf_draw);
        const repayment = Number(period.rcf_repayment);
        const available = Number(period.cash_after_mandatory_repayment);
        const floor = Number(period.minimum_cash);
        if (draw > TOLERANCE && repayment > TOLERANCE) {
          failures.push(`p${index}: draw and repayment both positive`);
        }
        if (draw > TOLERANCE && !(available < floor - TOLERANCE)) {
          failures.push(
            `p${index}: draw ${draw} with cash ${available} at or above the floor ${floor}`,
          );
        }
        if (repayment > TOLERANCE && !(available > floor + TOLERANCE)) {
          failures.push(
            `p${index}: repayment ${repayment} with cash ${available} at or below the floor ${floor}`,
          );
        }
      });
      return failures;
    },
  }),
  Object.freeze({
    invariant_id: "cash.shortfall_is_the_floor_deficit",
    module_id: "cash_rcf",
    statement:
      "the liquidity shortfall is exactly the unmet part of the declared cash " +
      "floor — never hidden, never invented",
    denomination: "reporting",
    operands: Object.freeze([
      "forecast[].liquidity_shortfall",
      "forecast[].minimum_cash",
      "forecast[].ending_cash",
    ]),
    evaluate({ solution }) {
      return solution.forecast.flatMap((period, index) =>
        near(
          period.liquidity_shortfall,
          Math.max(0, Number(period.minimum_cash) - Number(period.ending_cash)),
        )
          ? []
          : [`p${index}: liquidity_shortfall is not the floor deficit`],
      );
    },
  }),
  Object.freeze({
    invariant_id: "cash.solver_liquidity_checks_hold",
    module_id: "cash_rcf",
    statement: "the solver's own five liquidity checks pass in every period",
    denomination: "identity",
    operands: Object.freeze([
      "forecast[].checks.rcf_within_bounds",
      "forecast[].checks.minimum_cash_or_shortfall",
      "forecast[].checks.liquidity_shortfall_visible",
      "forecast[].checks.rcf_draw_repayment_mutually_exclusive",
      "forecast[].checks.shortfall_only_when_capacity_exhausted",
    ]),
    evaluate({ solution }) {
      const names = [
        "rcf_within_bounds",
        "minimum_cash_or_shortfall",
        "liquidity_shortfall_visible",
        "rcf_draw_repayment_mutually_exclusive",
        "shortfall_only_when_capacity_exhausted",
      ];
      return solution.forecast.flatMap((period, index) =>
        names
          .filter((name) => period.checks?.[name] !== true)
          .map((name) => `p${index}: checks.${name} is not true`),
      );
    },
  }),
  Object.freeze({
    invariant_id: "cash.typed_states_never_read_absence_as_zero",
    module_id: "cash_rcf",
    statement:
      "every RCF and cash typed state P4.3 attaches is a declared state; a " +
      "disabled facility reads not_applicable, never a typed zero",
    denomination: "identity",
    operands: Object.freeze([
      "forecast[].typed_states.rcf",
      "forecast[].typed_states.cash",
    ]),
    evaluate({ solution }) {
      const failures = [];
      solution.forecast.forEach((period, index) => {
        const typed = period.typed_states;
        if (!typed) {
          failures.push(`p${index}: no typed_states shadow`);
          return;
        }
        for (const key of ["opening_balance", "draw", "repayment", "ending_balance"]) {
          const state = typed.rcf?.[key];
          if (!state || typeof state.state !== "string") {
            failures.push(`p${index}: typed_states.rcf.${key} is not a typed value`);
          } else if (state.state === "not_applicable" && "value" in state) {
            failures.push(
              `p${index}: typed_states.rcf.${key} is not_applicable yet carries a value`,
            );
          }
        }
        if (!typed.cash?.ending_cash?.state) {
          failures.push(`p${index}: typed_states.cash.ending_cash is not typed`);
        }
      });
      return failures;
    },
  }),

  // --- interest -----------------------------------------------------------
  Object.freeze({
    invariant_id: "interest.gross_expense_decomposes",
    module_id: "interest",
    statement:
      "gross interest is exactly instrument + revolver + commitment fee + " +
      "lease + acquisition + other + non-cash: the schedule has no residual",
    denomination: "reporting",
    independent_confirmation: "solver-fixed-point-oracle:convergence",
    operands: Object.freeze([
      "forecast[].gross_interest",
      "forecast[].instrument_interest",
      "forecast[].rcf_interest",
      "forecast[].rcf_commitment_fee",
      "forecast[].lease_interest",
      "forecast[].acquisition_interest",
      "forecast[].other_interest",
      "forecast[].non_cash_interest",
    ]),
    evaluate({ solution }) {
      return solution.forecast.flatMap((period, index) =>
        near(
          period.gross_interest,
          Number(period.instrument_interest) +
            Number(period.rcf_interest) +
            Number(period.rcf_commitment_fee) +
            Number(period.lease_interest) +
            Number(period.acquisition_interest) +
            Number(period.other_interest) +
            Number(period.non_cash_interest),
        )
          ? []
          : [`p${index}: gross_interest ${period.gross_interest} is not the sum of its declared terms`],
      );
    },
  }),
  Object.freeze({
    invariant_id: "interest.net_expense_identity",
    module_id: "interest",
    statement: "net interest is gross interest less interest income",
    denomination: "reporting",
    operands: Object.freeze([
      "forecast[].net_interest",
      "forecast[].gross_interest",
      "forecast[].interest_income",
    ]),
    evaluate({ solution }) {
      return solution.forecast.flatMap((period, index) =>
        near(
          period.net_interest,
          Number(period.gross_interest) - Number(period.interest_income),
        )
          ? []
          : [`p${index}: net_interest is not gross less income`],
      );
    },
  }),
  Object.freeze({
    invariant_id: "interest.instrument_leg_aggregates_the_instruments",
    module_id: "interest",
    statement:
      "the instrument interest leg is the sum of the per-instrument interest " +
      "the debt module produced — the two schedules cannot disagree",
    denomination: "reporting",
    operands: Object.freeze([
      "forecast[].instrument_interest",
      "forecast[].instrument_results[].interest_reporting",
    ]),
    evaluate({ solution }) {
      return solution.forecast.flatMap((period, index) =>
        near(
          period.instrument_interest,
          sumOver(period.instrument_results, "interest_reporting"),
        )
          ? []
          : [`p${index}: instrument_interest != sum of instrument interest_reporting`],
      );
    },
  }),

  // --- acquisition_overlay ------------------------------------------------
  Object.freeze({
    invariant_id: "acquisition.debt_roll_forward",
    module_id: "acquisition_overlay",
    statement:
      "acquisition debt closes on prior balance + addition - repayment, and " +
      "the funded proceeds equal the addition",
    denomination: "reporting",
    operands: Object.freeze([
      "forecast[].acquisition_debt",
      "forecast[].acquisition_debt_addition",
      "forecast[].acquisition_debt_repayment",
      "forecast[].acquisition_debt_proceeds",
    ]),
    evaluate({ solution }) {
      const failures = [];
      solution.forecast.forEach((period, index) => {
        const prior =
          index === 0 ? 0 : Number(solution.forecast[index - 1].acquisition_debt);
        if (
          !near(
            period.acquisition_debt,
            prior +
              Number(period.acquisition_debt_addition) -
              Number(period.acquisition_debt_repayment),
          )
        ) {
          failures.push(`p${index}: acquisition debt does not roll forward`);
        }
        if (
          !near(period.acquisition_debt_proceeds, period.acquisition_debt_addition)
        ) {
          failures.push(`p${index}: acquisition proceeds != debt addition`);
        }
      });
      return failures;
    },
  }),
  Object.freeze({
    invariant_id: "acquisition.disabled_overlay_is_not_applicable_not_zero",
    module_id: "acquisition_overlay",
    statement:
      "where the case declares no acquisition, every acquisition typed state " +
      "reads not_applicable — absence is never a typed zero (P4.3)",
    denomination: "identity",
    operands: Object.freeze(["forecast[].typed_states.acquisition"]),
    evaluate({ modelCase, solution }) {
      if (Number(modelCase.acquisition?.enabled ?? 0) === 1) return [];
      const failures = [];
      solution.forecast.forEach((period, index) => {
        const typed = period.typed_states?.acquisition ?? {};
        for (const [key, state] of Object.entries(typed)) {
          if (state?.state !== "not_applicable") {
            failures.push(
              `p${index}: typed_states.acquisition.${key} is ${state?.state}, expected not_applicable`,
            );
          }
        }
      });
      return failures;
    },
  }),

  // --- outputs_and_ratios -------------------------------------------------
  Object.freeze({
    invariant_id: "outputs.debt_definitions_come_from_the_definition_basis",
    module_id: "outputs_and_ratios",
    statement:
      "gross debt and net debt on the artifact are the definition-basis graph's " +
      "own resolved values, not a second arithmetic",
    denomination: "reporting",
    operands: Object.freeze([
      "forecast[].gross_debt",
      "forecast[].net_debt",
      "forecast[].definition_basis.values",
    ]),
    evaluate({ solution }) {
      const failures = [];
      solution.forecast.forEach((period, index) => {
        const values = period.definition_basis?.values;
        if (!values) return;
        if (!near(period.gross_debt, values.model_gross_debt)) {
          failures.push(`p${index}: gross_debt != definition_basis.model_gross_debt`);
        }
        if (!near(period.net_debt, values.model_net_debt)) {
          failures.push(`p${index}: net_debt != definition_basis.model_net_debt`);
        }
      });
      return failures;
    },
  }),
  Object.freeze({
    invariant_id: "outputs.leverage_uses_the_declared_numerator",
    module_id: "outputs_and_ratios",
    statement:
      "net leverage is the definition basis' declared leverage numerator over " +
      "adjusted EBITDA, and is null rather than infinite at zero EBITDA",
    denomination: "ratio",
    operands: Object.freeze([
      "forecast[].net_leverage",
      "forecast[].definition_basis.values.leverage_numerator",
      "forecast[].adjusted_ebitda",
    ]),
    evaluate({ solution }) {
      const failures = [];
      solution.forecast.forEach((period, index) => {
        if (Number(period.adjusted_ebitda) === 0) {
          if (period.net_leverage !== null) {
            failures.push(`p${index}: zero EBITDA did not produce a null leverage`);
          }
          return;
        }
        const numerator = period.definition_basis?.values?.leverage_numerator;
        if (numerator === undefined) return;
        if (
          !near(period.net_leverage, Number(numerator) / Number(period.adjusted_ebitda))
        ) {
          failures.push(`p${index}: net_leverage is not numerator / adjusted_ebitda`);
        }
      });
      return failures;
    },
  }),
  Object.freeze({
    invariant_id: "outputs.undrawn_commitment_is_capacity_less_drawn",
    module_id: "outputs_and_ratios",
    statement:
      "undrawn revolver capacity is the commitment less the drawn balance, " +
      "translated at the declared period-end rate, floored at zero",
    // The one lawful cross-denomination identity in the register: an FX
    // TRANSLATION from the commitment's own currency into the reporting
    // currency. Declared as such, and the unit obligation below requires a
    // mixed_translation identity to name both a native operand and the rate.
    denomination: "mixed_translation",
    operands: Object.freeze([
      "forecast[].undrawn_rcf",
      "forecast[].rcf_capacity_native",
      "forecast[].rcf_ending_native",
      "forecast[].rcf_ending_fx",
    ]),
    evaluate({ solution }) {
      return solution.forecast.flatMap((period, index) =>
        near(
          period.undrawn_rcf,
          Math.max(
            0,
            Number(period.rcf_capacity_native) - Number(period.rcf_ending_native),
          ) * Number(period.rcf_ending_fx ?? 1),
        )
          ? []
          : [`p${index}: undrawn_rcf is not capacity less drawn at the declared rate`],
      );
    },
  }),
]);

// ---------------------------------------------------------------------------
// The nine module boundaries
// ---------------------------------------------------------------------------

const invariantsFor = (moduleId) =>
  Object.freeze(
    MODULE_INVARIANTS.filter((entry) => entry.module_id === moduleId).map(
      (entry) => entry.invariant_id,
    ),
  );

const write = (path, presence = "always", note = null) =>
  Object.freeze({ path, presence, note });

const read = (source, channel, detail) =>
  Object.freeze({ from_module: source, channel, detail });

/**
 * Each boundary carries exactly the eight fields `module_contract` requires.
 * `nodes` and `edges` are the equation-graph subsets the module owns; `edges`
 * is the set of edges whose DEPENDENT the module owns, so the 71 edges
 * partition across the nine modules the same way the 39 nodes do.
 */
export const CANONICAL_MODULE_BOUNDARIES = Object.freeze({
  historical_statements: Object.freeze({
    module_id: "historical_statements",
    module_version: "2.0.0",
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    read_set: Object.freeze([
      read(null, "case", "periods"),
      read(null, "case", "instruments[]"),
      read(null, "case", "statement_structure"),
      read(null, "case", "historical_supplement"),
      read(null, "case", "operating_metrics"),
    ]),
    write_set: Object.freeze([
      write("solution.periods"),
      write("solution.opening_debt_bridge"),
    ]),
    iteration_state: Object.freeze([]),
    invariants: invariantsFor("historical_statements"),
  }),

  operating_forecast: Object.freeze({
    module_id: "operating_forecast",
    module_version: "2.0.0",
    nodes: Object.freeze(["statement.ebit"]),
    edges: Object.freeze([]),
    read_set: Object.freeze([
      read(null, "case", "operating_metrics"),
      read(null, "case", "broker_pack"),
      read(null, "case", "forecast_assumptions"),
    ]),
    write_set: Object.freeze([
      write("forecast[].standalone_revenue"),
      write("forecast[].revenue"),
      write("forecast[].adjusted_ebitda"),
      write("forecast[].depreciation_and_amortisation"),
      write("forecast[].ebit"),
      write("forecast[].other_non_operating"),
      write("forecast[].capex"),
    ]),
    iteration_state: Object.freeze([]),
    invariants: invariantsFor("operating_forecast"),
  }),

  tax_and_working_capital: Object.freeze({
    module_id: "tax_and_working_capital",
    module_version: "2.1.0",
    nodes: Object.freeze([
      "statement.effective_tax_rate",
      "statement.net_income",
      "statement.pre_tax_income",
      "statement.tax_expense",
    ]),
    edges: Object.freeze([
      "edge.ebit_to_pre_tax_income",
      "edge.effective_tax_rate_to_tax_expense",
      "edge.net_interest_to_pre_tax_income",
      "edge.pre_tax_income_to_net_income",
      "edge.pre_tax_income_to_tax_expense",
      "edge.tax_expense_to_net_income",
    ]),
    read_set: Object.freeze([
      read("operating_forecast", "equation_edge", "statement.ebit"),
      read("interest", "equation_edge", "interest.net_expense"),
      read("operating_forecast", "artifact_path", "forecast[].other_non_operating"),
      read(null, "case", "tax_policy"),
    ]),
    write_set: Object.freeze([
      write("forecast[].pre_tax_income"),
      write("forecast[].tax"),
      write("forecast[].net_income"),
      write("forecast[].change_in_working_capital"),
    ]),
    // P4.10 — this module ITERATES. The sweep computes the tax base from the
    // iterated net interest and seeds operating cash flow from net income, so
    // all three quantities are recomputed every sweep and are members of the
    // active component. The empty declaration here was the module-level face of
    // the same missing edge.
    iteration_state: Object.freeze([
      "statement.net_income",
      "statement.pre_tax_income",
      "statement.tax_expense",
    ]),
    invariants: invariantsFor("tax_and_working_capital"),
  }),

  debt_instruments: Object.freeze({
    module_id: "debt_instruments",
    module_version: "2.0.0",
    nodes: Object.freeze([
      "debt.issuance",
      "debt.mandatory_repayment",
      "debt.maturity_repayment",
      "debt.pik_accretion",
      "debt.scheduled_amortisation",
    ]),
    edges: Object.freeze([
      "edge.control_to_pik_accretion",
      "edge.instrument_pik_to_accretion",
      "edge.lease_principal_to_mandatory",
      "edge.maturity_to_mandatory",
      "edge.scheduled_amortisation_to_mandatory",
    ]),
    read_set: Object.freeze([
      read("interest", "equation_edge", "interest.instrument_pik"),
      read("leases", "equation_edge", "lease.principal"),
      read(
        "historical_statements",
        "artifact_path",
        "solution.opening_debt_bridge",
      ),
      read(null, "case", "instruments[]"),
    ]),
    write_set: Object.freeze([
      write("solution.instrument_period_state_schema_version"),
      write("forecast[].instrument_results"),
      write("forecast[].mandatory_repayment"),
      write("forecast[].non_rcf_issuance"),
      write("forecast[].non_rcf_repayment"),
      write("forecast[].non_rcf_debt_issuance"),
      write("forecast[].non_rcf_debt_repayment"),
      write("forecast[].other_cash_debt_movement"),
      write("forecast[].checks.debt_roll_forward"),
    ]),
    iteration_state: Object.freeze([]),
    invariants: invariantsFor("debt_instruments"),
  }),

  leases: Object.freeze({
    module_id: "leases",
    module_version: "2.0.0",
    nodes: Object.freeze(["lease.principal"]),
    edges: Object.freeze([]),
    read_set: Object.freeze([
      read("interest", "artifact_path", "forecast[].lease_interest"),
      read(null, "case", "lease_policy"),
    ]),
    write_set: Object.freeze([
      write("forecast[].lease_principal"),
      write("forecast[].lease_additions"),
      write("forecast[].lease_other_movements"),
      write("forecast[].lease_interest_basis"),
      write("forecast[].ending_lease"),
      write("forecast[].opening_interest_bearing_lease"),
      write("forecast[].ending_interest_bearing_lease"),
    ]),
    iteration_state: Object.freeze([]),
    invariants: invariantsFor("leases"),
  }),

  cash_rcf: Object.freeze({
    module_id: "cash_rcf",
    module_version: "2.1.0",
    nodes: Object.freeze([
      "cash.cash_interest_paid",
      "cash.cash_interest_received",
      "cash.cfo",
      "cash.ending_balance",
      "cash.minimum_cash",
      "cash.net_finance_addback",
      "cash.noncash_interest_addback",
      "rcf.capacity",
      "rcf.draw",
      "rcf.ending_balance",
      "rcf.liquidity_shortfall",
      "rcf.repayment",
      "statement.cash_flow_start",
    ]),
    edges: Object.freeze([
      "edge.cash_flow_start_to_cfo",
      "edge.cfo_to_cash",
      "edge.cfo_to_rcf_draw",
      "edge.cfo_to_rcf_repayment",
      "edge.control_to_cash_interest_paid",
      "edge.control_to_cash_interest_received",
      "edge.control_to_net_finance_addback",
      "edge.control_to_noncash_addback",
      "edge.ebit_to_cash_flow_start",
      "edge.finance_expense_to_cash_flow_start",
      "edge.finance_income_to_cash_flow_start",
      // P4.10 — net income enters the cash-flow bridge. Edge ownership follows
      // the DEPENDENT, and both dependents (`statement.cash_flow_start`,
      // `cash.cfo`) are this module's nodes.
      "edge.net_income_to_cash_flow_start",
      "edge.net_income_to_cfo",
      "edge.gross_to_cash_interest_paid",
      "edge.income_to_cash_interest_received",
      "edge.issuance_to_cash",
      "edge.issuance_to_rcf_draw",
      "edge.issuance_to_rcf_repayment",
      "edge.mandatory_to_cash",
      "edge.mandatory_to_rcf_draw",
      "edge.mandatory_to_rcf_repayment",
      "edge.minimum_cash_to_rcf_draw",
      "edge.minimum_cash_to_rcf_repayment",
      "edge.noncash_addback_to_cfo",
      "edge.noncash_interest_to_addback",
      "edge.rcf_capacity_to_draw",
      "edge.rcf_capacity_to_shortfall",
      "edge.rcf_draw_to_cash",
      "edge.rcf_draw_to_ending_rcf",
      "edge.rcf_draw_to_shortfall",
      "edge.rcf_repayment_to_cash",
      "edge.rcf_repayment_to_ending_rcf",
    ]),
    read_set: Object.freeze([
      read("operating_forecast", "equation_edge", "statement.ebit"),
      read("interest", "equation_edge", "interest.gross_expense"),
      read("interest", "equation_edge", "interest.income"),
      read("interest", "equation_edge", "interest.noncash"),
      read("interest", "equation_edge", "statement.finance_expense"),
      read("interest", "equation_edge", "statement.finance_income"),
      read("debt_instruments", "equation_edge", "debt.issuance"),
      read("debt_instruments", "equation_edge", "debt.mandatory_repayment"),
      // P4.10 — this was declared as an ARTIFACT read while the equation graph
      // denied the dependency existed. It is an equation edge, and the module
      // contract said so before the graph did.
      read("tax_and_working_capital", "equation_edge", "statement.net_income"),
      read("tax_and_working_capital", "artifact_path", "forecast[].net_income"),
      read("leases", "artifact_path", "forecast[].lease_principal"),
      read(null, "case", "cash_policy"),
      read(null, "case", "rcf_policy"),
    ]),
    write_set: Object.freeze([
      write("forecast[].cash_from_operations"),
      write("forecast[].cash_from_investing"),
      write("forecast[].fx_on_cash"),
      write("forecast[].fx_effect_on_cash"),
      write("forecast[].non_debt_financing"),
      write("forecast[].cash_before_debt"),
      write("forecast[].pre_rcf_debt_cash_flow"),
      write("forecast[].cash_before_rcf"),
      write("forecast[].financing_before_mandatory"),
      write("forecast[].cash_before_mandatory_repayment"),
      write("forecast[].cash_after_mandatory_repayment"),
      write("forecast[].minimum_cash"),
      write("forecast[].rcf_draw"),
      write("forecast[].rcf_repayment"),
      write("forecast[].ending_rcf"),
      write("forecast[].rcf_currency"),
      write("forecast[].rcf_opening_native"),
      write("forecast[].rcf_capacity_native"),
      write("forecast[].rcf_draw_native"),
      write("forecast[].rcf_repayment_native"),
      write("forecast[].rcf_ending_native"),
      write("forecast[].rcf_opening_fx"),
      write("forecast[].rcf_average_fx"),
      write("forecast[].rcf_ending_fx"),
      write("forecast[].rcf_fx_non_cash_movement"),
      write("forecast[].ending_cash"),
      write("forecast[].liquidity_shortfall"),
      write("forecast[].typed_states.rcf"),
      write("forecast[].typed_states.cash"),
      write("forecast[].checks.rcf_within_bounds"),
      write("forecast[].checks.minimum_cash_or_shortfall"),
      write("forecast[].checks.liquidity_shortfall_visible"),
      write("forecast[].checks.rcf_draw_repayment_mutually_exclusive"),
      write("forecast[].checks.shortfall_only_when_capacity_exhausted"),
      write(
        "forecast[].reported_cash",
        "case_conditional",
        "emitted only where the case declares explicit cash buckets; neither " +
          "certified fixture nor any economics archetype declares them, so this " +
          "path is DECLARED and unobserved rather than silently missing",
      ),
      write("forecast[].cash_flow_cash", "case_conditional", "as reported_cash"),
      write("forecast[].liquidity_cash", "case_conditional", "as reported_cash"),
      write(
        "forecast[].interest_eligible_cash",
        "case_conditional",
        "as reported_cash",
      ),
      write(
        "forecast[].cash_bucket_balances",
        "case_conditional",
        "as reported_cash",
      ),
    ]),
    iteration_state: Object.freeze([
      "cash.cfo",
      "cash.ending_balance",
      "rcf.draw",
      "rcf.ending_balance",
      "rcf.repayment",
      "statement.cash_flow_start",
    ]),
    invariants: invariantsFor("cash_rcf"),
  }),

  interest: Object.freeze({
    module_id: "interest",
    module_version: "2.1.0",
    nodes: Object.freeze([
      "interest.acquisition",
      "interest.cash_income",
      "interest.commitment_fee",
      "interest.gross_expense",
      "interest.income",
      "interest.instrument_cash",
      "interest.instrument_pik",
      "interest.lease",
      "interest.net_expense",
      "interest.noncash",
      "interest.other",
      "interest.rcf",
      "statement.finance_expense",
      "statement.finance_income",
    ]),
    edges: Object.freeze([
      "edge.acquisition_interest_to_gross",
      "edge.cash_income_to_interest_income",
      "edge.cash_to_interest_income",
      "edge.commitment_fee_to_gross",
      "edge.control_to_acquisition_interest",
      "edge.control_to_cash_interest_income",
      "edge.control_to_gross_interest",
      "edge.control_to_income_statement_finance_expense",
      "edge.control_to_income_statement_finance_income",
      "edge.control_to_instrument_cash_interest",
      "edge.control_to_instrument_pik_interest",
      "edge.control_to_interest_income",
      "edge.control_to_lease_interest",
      "edge.control_to_net_interest",
      "edge.control_to_noncash_interest",
      "edge.control_to_other_interest",
      "edge.control_to_rcf_commitment_fee",
      "edge.control_to_rcf_interest",
      "edge.ending_rcf_to_commitment_fee",
      "edge.ending_rcf_to_rcf_interest",
      "edge.gross_interest_to_finance_statement",
      "edge.gross_to_net_interest",
      "edge.income_to_net_interest",
      "edge.instrument_cash_to_gross",
      "edge.instrument_pik_to_gross",
      "edge.interest_income_to_finance_statement",
      "edge.lease_interest_to_gross",
      "edge.noncash_interest_to_gross",
      "edge.other_interest_to_gross",
      "edge.rcf_interest_to_gross",
    ]),
    read_set: Object.freeze([
      read("cash_rcf", "equation_edge", "cash.ending_balance"),
      read("cash_rcf", "equation_edge", "rcf.ending_balance"),
      read(
        "debt_instruments",
        "artifact_path",
        "forecast[].instrument_results[].interest_reporting",
      ),
      read(
        "leases",
        "artifact_path",
        "forecast[].opening_interest_bearing_lease",
      ),
      read("acquisition_overlay", "artifact_path", "forecast[].acquisition_debt"),
    ]),
    write_set: Object.freeze([
      write("forecast[].gross_interest"),
      write("forecast[].instrument_interest"),
      write("forecast[].non_cash_instrument_interest"),
      write("forecast[].rcf_interest"),
      write("forecast[].rcf_commitment_fee"),
      write("forecast[].lease_interest"),
      write("forecast[].acquisition_interest"),
      write("forecast[].other_interest"),
      write("forecast[].non_cash_interest"),
      write("forecast[].interest_income"),
      write("forecast[].net_interest"),
    ]),
    iteration_state: Object.freeze([
      "interest.cash_income",
      "interest.commitment_fee",
      "interest.gross_expense",
      "interest.income",
      // P4.10 — net interest is the tax base's input and is inside the loop.
      "interest.net_expense",
      "interest.rcf",
      "statement.finance_expense",
      "statement.finance_income",
    ]),
    invariants: invariantsFor("interest"),
  }),

  acquisition_overlay: Object.freeze({
    module_id: "acquisition_overlay",
    module_version: "2.0.0",
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    read_set: Object.freeze([
      read(null, "case", "acquisition"),
      read("interest", "artifact_path", "forecast[].acquisition_interest"),
    ]),
    write_set: Object.freeze([
      write("forecast[].acquisition_debt"),
      write("forecast[].acquisition_debt_addition"),
      write("forecast[].acquisition_debt_proceeds"),
      write("forecast[].acquisition_cash_consideration"),
      write("forecast[].acquisition_debt_repayment"),
      write("forecast[].typed_states.acquisition"),
    ]),
    iteration_state: Object.freeze([]),
    invariants: invariantsFor("acquisition_overlay"),
  }),

  outputs_and_ratios: Object.freeze({
    module_id: "outputs_and_ratios",
    module_version: "2.0.0",
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    read_set: Object.freeze([
      read("debt_instruments", "artifact_path", "forecast[].instrument_results"),
      read("cash_rcf", "artifact_path", "forecast[].ending_cash"),
      read("cash_rcf", "artifact_path", "forecast[].rcf_capacity_native"),
      read("cash_rcf", "artifact_path", "forecast[].rcf_ending_native"),
      read("leases", "artifact_path", "forecast[].ending_lease"),
      read("acquisition_overlay", "artifact_path", "forecast[].acquisition_debt"),
      read("operating_forecast", "artifact_path", "forecast[].adjusted_ebitda"),
    ]),
    write_set: Object.freeze([
      write("solution.definition_basis_graph"),
      write("forecast[].definition_basis"),
      write("forecast[].gross_debt"),
      write("forecast[].net_debt"),
      write("forecast[].eligible_cash"),
      write("forecast[].net_leverage"),
      write("forecast[].undrawn_rcf"),
      write("forecast[].drawn_commercial_paper"),
      write("forecast[].total_liquidity"),
    ]),
    iteration_state: Object.freeze([]),
    invariants: invariantsFor("outputs_and_ratios"),
  }),
});

/**
 * Fields on the solved artifact that belong to the SOLVER FRAME rather than to
 * any economic module: identity, the container, and the convergence
 * diagnostics. Declared so the totality obligation below can be exact — a new
 * solver field must be classified as some module's output or as frame, and
 * cannot simply appear unowned.
 *
 * `solve_order_evidence` and `graph_driven_solve` are P4.7's solve-order and
 * convergence observation. They are frame, not economics: they describe HOW the
 * fixed point was reached, and no module's outputs depend on them. They were
 * classified here because this census caught them the moment P4.7's delta
 * landed in the shared tree — which is what the census is for.
 */
export const SOLVER_FRAME_FIELDS = Object.freeze({
  solution: Object.freeze([
    "case_id",
    "issuer",
    "forecast",
    "converged",
    "iterations",
    "residual",
    "convergence_tolerance",
    "all_checks_pass",
    "equation_graph_evidence",
    "solve_order_evidence",
  ]),
  period: Object.freeze([
    "period",
    "converged",
    "iterations",
    "residual",
    "graph_driven_solve",
  ]),
  typed_states: Object.freeze([
    "schema_version",
    "period_id",
    "period_index",
    "period_count",
  ]),
});

/**
 * `forecast[].statement_values` is written by the declared statement graph,
 * which spans four modules by construction: no single module can claim it and
 * pretending otherwise would be a false single-writer claim. Its
 * single-writership is DELEGATED to P4.6, whose compile-channel obligation
 * `ECONOMIC_BINDING_ROW_CONTESTED` refuses a second claimant on a row, and this
 * package re-proves the resulting relation is injective on every case it binds.
 */
export const SHARED_ARTIFACT_CHANNELS = Object.freeze([
  Object.freeze({
    path: "forecast[].statement_values",
    reason:
      "the declared statement graph is a cross-module projection; four modules " +
      "publish rows into it",
    single_writer_authority: "P4.6 ECONOMIC_BINDING_ROW_CONTESTED",
    reproved_here: "node -> statement row injectivity over the compiled artifact",
  }),
]);

// ---------------------------------------------------------------------------
// module_version — the contract field nothing implemented
// ---------------------------------------------------------------------------

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
export { canonicalJson };

/**
 * The digest a `module_version` is a version OF. Everything in the boundary
 * except the version itself, so a boundary change that leaves the version
 * unbumped is a detectable disagreement with the sealed asset rather than a
 * silent redefinition.
 */
export function moduleBoundaryDigest(boundary) {
  const body = {};
  for (const key of MODULE_CONTRACT_REQUIRED_FIELDS) {
    if (key === "module_version") continue;
    body[key] = boundary[key];
  }
  return crypto.createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export function canonicalModuleContractDigest() {
  const body = Object.keys(CANONICAL_MODULE_BOUNDARIES)
    .sort()
    .map((moduleId) => ({
      module_id: moduleId,
      module_version: CANONICAL_MODULE_BOUNDARIES[moduleId].module_version,
      boundary_sha256: moduleBoundaryDigest(CANONICAL_MODULE_BOUNDARIES[moduleId]),
    }));
  return crypto.createHash("sha256").update(canonicalJson(body)).digest("hex");
}

// ---------------------------------------------------------------------------
// Contract conformance
// ---------------------------------------------------------------------------

export function ownedNodeIndex(boundaries = CANONICAL_MODULE_BOUNDARIES) {
  const index = new Map();
  for (const [moduleId, boundary] of Object.entries(boundaries)) {
    for (const nodeId of boundary.nodes) {
      if (index.has(nodeId)) {
        index.set(nodeId, `${index.get(nodeId)}+${moduleId}`);
      } else {
        index.set(nodeId, moduleId);
      }
    }
  }
  return index;
}

export function expectedModuleForNode(node) {
  const exception = NODE_OWNER_EXCEPTIONS[node.id];
  if (exception) return exception.module_id;
  return DOMAIN_TO_MODULE[node.domain] ?? null;
}

/**
 * Import-time totality, following P4.6's precedent at the graph's own seam: no
 * module in the repository may load against an equation graph or an asset whose
 * module set this register does not cover exactly.
 */
export function validateModuleContractConformance({
  boundaries = CANONICAL_MODULE_BOUNDARIES,
  graph = EQUATION_GRAPH,
  contract = CANONICAL_MODEL_GRAPH,
} = {}) {
  const errors = [];

  // (1) module set equality with the asset.
  const declared = [...contract.modules].sort();
  const implemented = Object.keys(boundaries).sort();
  for (const moduleId of declared) {
    if (!implemented.includes(moduleId)) {
      errors.push(`MODULE_BOUNDARY_ABSENT: ${moduleId} is declared by the asset and has no boundary.`);
    }
  }
  for (const moduleId of implemented) {
    if (!declared.includes(moduleId)) {
      errors.push(`MODULE_BOUNDARY_UNDECLARED: ${moduleId} has a boundary the asset does not declare.`);
    }
  }

  // (2) every boundary carries every required field, module_version included.
  for (const [moduleId, boundary] of Object.entries(boundaries)) {
    for (const fieldName of MODULE_CONTRACT_REQUIRED_FIELDS) {
      if (!Object.hasOwn(boundary, fieldName)) {
        errors.push(`MODULE_CONTRACT_FIELD_MISSING: ${moduleId}.${fieldName}`);
      }
    }
    if (boundary.module_id !== moduleId) {
      errors.push(`MODULE_ID_MISMATCH: ${moduleId} declares module_id ${boundary.module_id}`);
    }
    if (!MODULE_VERSION_PATTERN.test(String(boundary.module_version))) {
      errors.push(`MODULE_VERSION_MALFORMED: ${moduleId} -> ${boundary.module_version}`);
    }
  }

  // (3) node totality and single ownership.
  const owned = ownedNodeIndex(boundaries);
  const unowned = new Map(
    UNOWNED_EQUATION_NODES.map((entry) => [entry.node_id, entry]),
  );
  for (const [nodeId, ownerId] of owned) {
    if (ownerId.includes("+")) {
      errors.push(`MODULE_NODE_CONTESTED: ${nodeId} claimed by ${ownerId}`);
    }
    if (unowned.has(nodeId)) {
      errors.push(`MODULE_NODE_OWNED_AND_UNOWNED: ${nodeId}`);
    }
  }
  for (const node of graph.nodes) {
    const ownerId = owned.get(node.id);
    if (!ownerId && !unowned.has(node.id)) {
      errors.push(
        `MODULE_NODE_UNCLAIMED: equation node ${node.id} is owned by no module and is not declared unowned.`,
      );
      continue;
    }
    if (!ownerId) continue;
    const expected = expectedModuleForNode(node);
    if (expected === null) {
      errors.push(`MODULE_NODE_OWNER_BASIS_ABSENT: ${node.id} (domain ${node.domain})`);
    } else if (expected !== ownerId.split("+")[0]) {
      errors.push(
        `MODULE_NODE_OWNER_BASIS_DISAGREEMENT: ${node.id} owned by ${ownerId}, basis says ${expected}`,
      );
    }
  }
  const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
  for (const nodeId of owned.keys()) {
    if (!graphNodeIds.has(nodeId)) {
      errors.push(`MODULE_NODE_ORPHAN: ${nodeId} is owned but is not in the equation graph.`);
    }
  }
  for (const nodeId of unowned.keys()) {
    if (!graphNodeIds.has(nodeId)) {
      errors.push(`MODULE_UNOWNED_NODE_ORPHAN: ${nodeId} is declared unowned but is not in the graph.`);
    }
  }

  // (4) edge totality: an edge belongs to the module that owns its dependent.
  const declaredEdges = new Map();
  for (const [moduleId, boundary] of Object.entries(boundaries)) {
    for (const edgeId of boundary.edges) {
      if (declaredEdges.has(edgeId)) {
        errors.push(`MODULE_EDGE_CONTESTED: ${edgeId} claimed by ${declaredEdges.get(edgeId)} and ${moduleId}`);
      }
      declaredEdges.set(edgeId, moduleId);
    }
  }
  for (const edge of graph.edges) {
    const ownerId = owned.get(edge.to);
    const claimed = declaredEdges.get(edge.id);
    if (!ownerId) {
      if (claimed) {
        errors.push(`MODULE_EDGE_ON_UNOWNED_TARGET: ${edge.id} claimed by ${claimed} but ${edge.to} is unowned.`);
      }
      continue;
    }
    if (claimed !== ownerId) {
      errors.push(
        `MODULE_EDGE_OWNER_DISAGREEMENT: ${edge.id} -> ${edge.to} owned by ${ownerId}, declared by ${claimed ?? "nobody"}`,
      );
    }
  }
  const graphEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  for (const edgeId of declaredEdges.keys()) {
    if (!graphEdgeIds.has(edgeId)) {
      errors.push(`MODULE_EDGE_ORPHAN: ${edgeId} is declared but is not in the equation graph.`);
    }
  }

  // (5) every owned node has a carrier; every carrier names an owned node.
  for (const nodeId of owned.keys()) {
    if (!NODE_CARRIERS[nodeId]) {
      errors.push(`MODULE_CARRIER_ABSENT: ${nodeId} has no declared solver carrier.`);
    }
  }
  for (const nodeId of Object.keys(NODE_CARRIERS)) {
    if (!owned.has(nodeId)) {
      errors.push(`MODULE_CARRIER_ORPHAN: carrier declared for unowned node ${nodeId}.`);
    }
  }

  // (6) the carrier channel agrees with P4.6's disposition for the same node.
  for (const [nodeId, carrier] of Object.entries(NODE_CARRIERS)) {
    const disposition = ECONOMIC_STATEMENT_BINDING[nodeId]?.disposition;
    if (!disposition) {
      errors.push(`MODULE_CARRIER_UNBOUND_IN_P46: ${nodeId} has no P4.6 binding entry.`);
      continue;
    }
    const expectedChannel =
      disposition === "statement_row" ? "statement_row" : "schedule";
    const actual = carrier.channel === "statement_row" ? "statement_row" : "schedule";
    if (expectedChannel !== actual) {
      errors.push(
        `MODULE_CARRIER_DISPOSITION_DISAGREEMENT: ${nodeId} is P4.6 ${disposition} but carried on ${carrier.channel}.`,
      );
    }
  }
  for (const entry of UNOWNED_EQUATION_NODES) {
    if (ECONOMIC_STATEMENT_BINDING[entry.node_id]?.disposition !== "solver_control") {
      errors.push(
        `MODULE_UNOWNED_NODE_NOT_A_CONTROL: ${entry.node_id} is declared unowned but P4.6 does not type it solver_control.`,
      );
    }
  }

  // (7) invariant register agreement.
  const registered = new Set(MODULE_INVARIANTS.map((entry) => entry.invariant_id));
  if (registered.size !== MODULE_INVARIANTS.length) {
    errors.push("MODULE_INVARIANT_ID_DUPLICATED");
  }
  for (const [moduleId, boundary] of Object.entries(boundaries)) {
    if (boundary.invariants.length === 0) {
      errors.push(`MODULE_INVARIANTS_EMPTY: ${moduleId} declares no invariant.`);
    }
    for (const invariantId of boundary.invariants) {
      if (!registered.has(invariantId)) {
        errors.push(`MODULE_INVARIANT_UNREGISTERED: ${moduleId} -> ${invariantId}`);
      }
    }
  }
  for (const entry of MODULE_INVARIANTS) {
    if (!boundaries[entry.module_id]?.invariants.includes(entry.invariant_id)) {
      errors.push(`MODULE_INVARIANT_UNCLAIMED: ${entry.invariant_id}`);
    }
  }

  // (8) module_version and the sealed boundary digest.
  const seals = contract.module_versions ?? null;
  if (!seals) {
    errors.push(
      "MODULE_VERSION_SEAL_ABSENT: assets/canonical-model-graph-v2.json declares no module_versions.",
    );
  } else {
    for (const [moduleId, boundary] of Object.entries(boundaries)) {
      const seal = seals[moduleId];
      if (!seal) {
        errors.push(`MODULE_VERSION_UNSEALED: ${moduleId} has no entry in module_versions.`);
        continue;
      }
      if (seal.module_version !== boundary.module_version) {
        errors.push(
          `MODULE_VERSION_DISAGREEMENT: ${moduleId} boundary ${boundary.module_version} vs seal ${seal.module_version}`,
        );
      }
      const digest = moduleBoundaryDigest(boundary);
      if (seal.boundary_sha256 !== digest) {
        errors.push(
          `MODULE_VERSION_UNBUMPED: ${moduleId} boundary digest ${digest} does not match the sealed ${seal.boundary_sha256}; a boundary change requires a module_version bump and a re-seal.`,
        );
      }
    }
    for (const moduleId of Object.keys(seals)) {
      if (!boundaries[moduleId]) {
        errors.push(`MODULE_VERSION_SEAL_ORPHAN: ${moduleId} is sealed but has no boundary.`);
      }
    }
  }

  return errors;
}

export function assertCanonicalModuleContract(options = {}) {
  const errors = validateModuleContractConformance(options);
  if (errors.length > 0) {
    throw new Error(
      `canonical model module contract invalid:\n- ${errors.join("\n- ")}`,
    );
  }
}

// Import-time totality (P4.6 precedent). Nothing in the repository can load
// this register against a drifted equation graph or a drifted asset.
assertCanonicalModuleContract();

// ---------------------------------------------------------------------------
// The six declared graph invariants
// ---------------------------------------------------------------------------

export function moduleQuotientEdges(circularity, boundaries = CANONICAL_MODULE_BOUNDARIES) {
  const owned = ownedNodeIndex(boundaries);
  const edges = new Map();
  for (const edge of activeEquationEdges(EQUATION_GRAPH, circularity)) {
    const from = owned.get(edge.from);
    const to = owned.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push(edge);
  }
  return edges;
}

function quotientSccs(circularity) {
  const modules = [...new Set(Object.keys(CANONICAL_MODULE_BOUNDARIES))].sort();
  const adjacency = new Map(modules.map((moduleId) => [moduleId, new Set()]));
  for (const key of moduleQuotientEdges(circularity).keys()) {
    const [from, to] = key.split("->");
    adjacency.get(from).add(to);
  }
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let counter = 0;
  const visit = (vertex) => {
    index.set(vertex, counter);
    low.set(vertex, counter);
    counter += 1;
    stack.push(vertex);
    onStack.add(vertex);
    for (const next of [...adjacency.get(vertex)].sort()) {
      if (!index.has(next)) {
        visit(next);
        low.set(vertex, Math.min(low.get(vertex), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(vertex, Math.min(low.get(vertex), index.get(next)));
      }
    }
    if (low.get(vertex) !== index.get(vertex)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== vertex);
    if (component.length > 1) components.push(component.sort());
  };
  for (const moduleId of modules) if (!index.has(moduleId)) visit(moduleId);
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}
export { quotientSccs };

/**
 * The per-edge-type tolerance-class rule. This is the unit slice the equation
 * graph actually carries; see `GRAPH_INVARIANT_DECLARATIONS` for exactly what
 * it does and does not prove.
 */
export const EDGE_TOLERANCE_RULE = Object.freeze({
  control_gate: Object.freeze({ from: ["control"], to: ["currency", "ratio"] }),
  aggregation: Object.freeze({ from: ["currency"], to: ["currency"] }),
  cash_waterfall: Object.freeze({ from: ["currency"], to: ["currency"] }),
  balance_rollforward: Object.freeze({ from: ["currency"], to: ["currency"] }),
  cash_flow_bridge: Object.freeze({ from: ["currency"], to: ["currency"] }),
  noncash_bridge: Object.freeze({ from: ["currency"], to: ["currency"] }),
  schedule_to_statement: Object.freeze({ from: ["currency"], to: ["currency"] }),
  liquidity_constraint: Object.freeze({ from: ["currency"], to: ["currency"] }),
  interest_base: Object.freeze({ from: ["currency"], to: ["currency"] }),
  statement_dependency: Object.freeze({
    from: ["currency", "ratio"],
    to: ["currency"],
  }),
});

export const GRAPH_INVARIANT_DECLARATIONS = Object.freeze({
  unique_node_ids: Object.freeze({
    status: "proven",
    what_is_proven:
      "the equation graph's node ids are pairwise distinct, the nine modules' " +
      "node sets are pairwise disjoint, and owned union unowned equals the " +
      "graph's node set exactly — so a duplicate cannot hide inside a module",
  }),
  single_writer: Object.freeze({
    status: "proven",
    what_is_proven:
      "each node has exactly one owning module; each declared solver artifact " +
      "path is written by exactly one module; and every field the solver " +
      "actually emits is claimed by exactly one module or declared frame",
    delegated_channel:
      "forecast[].statement_values is a cross-module projection: its " +
      "single-writership is P4.6's ECONOMIC_BINDING_ROW_CONTESTED obligation, " +
      "and node -> row injectivity is re-proven here on every bound case",
  }),
  unit_compatible_edges: Object.freeze({
    status: "proven_partial",
    what_is_proven:
      "all 71 edges satisfy the declared per-edge-type tolerance-class rule " +
      "(the only dimensional annotation the graph carries), and every one of " +
      "the module invariants is denomination-homogeneous — no identity mixes " +
      "native-currency operands with reporting-currency operands except the " +
      "one declared FX translation, which must name both a native operand and " +
      "the rate that carries it across",
    what_is_unprovable:
      "true unit compatibility (currency code, unit scale, stock versus flow) " +
      "cannot be checked from any source in the repository",
    why:
      "no equation-graph node carries a unit: `assets/equation-graph.v1.schema.json` " +
      "declares the node object `additionalProperties: false` with six fixed " +
      "properties, so a unit attribute cannot be added without changing that " +
      "schema asset (not an allowed file here); and the typed-value contract " +
      "offers no second source, because `currency` and `unit_scale` exist only " +
      "on the `reported_number` variant, while every solver quantity is " +
      "`derived_number`, which has neither",
    closes_when:
      "a unit attribute is declared on the equation-graph node schema, or the " +
      "typed-value contract's derived_number variant gains currency/unit_scale",
  }),
  declared_cross_module_reads_and_writes: Object.freeze({
    status: "proven",
    what_is_proven:
      "every equation edge that crosses a module boundary is declared in the " +
      "consuming module's read_set naming the producing module and the exact " +
      "source node, and every declared equation_edge read corresponds to a real " +
      "cross-module edge — neither direction can be one-sided",
  }),
  cycles_only_in_declared_iteration_subgraphs: Object.freeze({
    status: "proven",
    what_is_proven:
      "at node level — the granularity the solver actually iterates — every " +
      "member of every active strongly connected component belongs to a module " +
      "that declares a non-empty iteration_state, and the union of the nine " +
      "declared iteration states equals the solver's own declared state vector " +
      "EXACTLY (17 nodes, no more and no fewer)",
    declared_coarsening:
      "the module QUOTIENT graph at circularity=1 carries a three-module " +
      "component {cash_rcf, debt_instruments, interest} where the node graph " +
      "carries a two-module one. This is a quotient artifact, not a cycle: " +
      "debt_instruments enters only because the quotient merges a pure source " +
      "(debt.issuance, debt.mandatory_repayment, read by the waterfall) with a " +
      "pure sink (debt.pik_accretion, written from interest.instrument_pik) " +
      "into one vertex. Proven benign rather than asserted: no debt_schedule " +
      "node appears in any node-level active component, so debt_instruments " +
      "declares an empty iteration_state and is correct to.",
  }),
  circularity_off_has_no_active_scc: Object.freeze({
    status: "proven",
    what_is_proven:
      "with circularity=0 the equation graph has no active component at node " +
      "level and the module quotient graph is acyclic; and a real solve of both " +
      "certified fixtures with controls.circularity=0 returns active_sccs=[], " +
      "solver_declaration.required=false, an empty state vector, one iteration " +
      "and a zero residual",
  }),
});

/**
 * Does anything in the repository actually annotate an equation-graph node with
 * a unit? This is the blocker behind `unit_compatible_edges`, and it is PROBED
 * rather than asserted, so the declaration below can be audited against the
 * world instead of against its own prose.
 */
export function graphCarriesUnitAnnotation(graph = EQUATION_GRAPH) {
  return (graph.nodes ?? []).some((node) =>
    ["unit", "unit_scale", "currency", "dimension"].some((key) =>
      Object.hasOwn(node, key),
    ),
  );
}

/**
 * The guard against the failure this whole package exists to end: an invariant
 * marked proven by restating it.
 *
 * A status is not a label here, it is a claim with an admissibility condition.
 * `proven` requires a recomputation and forbids a declared remainder;
 * `proven_partial` requires the remainder, a specific reason and the condition
 * that would close it; and for `unit_compatible_edges` specifically, `proven`
 * is admissible ONLY if the graph has actually gained a unit annotation — so
 * relabelling it cannot succeed while the blocker is still real.
 */
export function auditInvariantDeclarations(
  declarations = GRAPH_INVARIANT_DECLARATIONS,
  { graph = EQUATION_GRAPH } = {},
) {
  const errors = [];
  const declaredNames = new Set(DECLARED_GRAPH_INVARIANTS);
  for (const name of declaredNames) {
    if (!declarations[name]) {
      errors.push(`INVARIANT_UNDECLARED: ${name} is in the asset and has no status.`);
    }
  }
  for (const [name, declaration] of Object.entries(declarations)) {
    if (!declaredNames.has(name)) {
      errors.push(`INVARIANT_NOT_IN_CONTRACT: ${name}`);
      continue;
    }
    if (!["proven", "proven_partial", "unprovable"].includes(declaration.status)) {
      errors.push(`INVARIANT_STATUS_UNKNOWN: ${name} -> ${declaration.status}`);
      continue;
    }
    if (declaration.status === "proven") {
      if (!declaration.what_is_proven) {
        errors.push(`INVARIANT_PROVEN_WITHOUT_EVIDENCE: ${name}`);
      }
      if (declaration.what_is_unprovable) {
        errors.push(
          `INVARIANT_PROVEN_WITH_REMAINDER: ${name} claims proven while declaring an unprovable remainder.`,
        );
      }
    }
    if (declaration.status === "proven_partial" || declaration.status === "unprovable") {
      for (const requiredField of ["what_is_unprovable", "why", "closes_when"]) {
        if (!declaration[requiredField]) {
          errors.push(`INVARIANT_REMAINDER_UNEXPLAINED: ${name}.${requiredField}`);
        }
      }
    }
  }
  // The world-check. `unit_compatible_edges` cannot be promoted to `proven`
  // while no node carries a unit; a relabel is refused by the blocker itself.
  const unitDeclaration = declarations.unit_compatible_edges;
  if (
    unitDeclaration?.status === "proven" &&
    !graphCarriesUnitAnnotation(graph)
  ) {
    errors.push(
      "INVARIANT_PROVEN_AGAINST_A_LIVE_BLOCKER: unit_compatible_edges is marked proven, but no equation-graph node carries a unit annotation — the claim is a restatement, not a proof.",
    );
  }
  return errors;
}

/**
 * Every one of the six, recomputed. `context` carries the solved artifacts the
 * invariant needs; an invariant that needs one and is not given it FAILS rather
 * than passing vacuously.
 */
export function validateGraphInvariants(context = {}) {
  const errors = [];
  const graph = context.graph ?? EQUATION_GRAPH;
  const boundaries = context.boundaries ?? CANONICAL_MODULE_BOUNDARIES;
  const owned = ownedNodeIndex(boundaries);

  // --- unique_node_ids ----------------------------------------------------
  const seen = new Set();
  for (const node of graph.nodes) {
    if (seen.has(node.id)) errors.push(`unique_node_ids: duplicate ${node.id}`);
    seen.add(node.id);
  }
  const moduleNodeCount = Object.values(boundaries).reduce(
    (total, boundary) => total + boundary.nodes.length,
    0,
  );
  if (moduleNodeCount !== owned.size) {
    errors.push("unique_node_ids: a node id appears in more than one module");
  }
  if (owned.size + UNOWNED_EQUATION_NODES.length !== seen.size) {
    errors.push(
      `unique_node_ids: owned ${owned.size} + unowned ${UNOWNED_EQUATION_NODES.length} != graph ${seen.size}`,
    );
  }

  // --- single_writer ------------------------------------------------------
  const writers = new Map();
  for (const [moduleId, boundary] of Object.entries(boundaries)) {
    for (const entry of boundary.write_set) {
      if (writers.has(entry.path)) {
        errors.push(
          `single_writer: ${entry.path} written by ${writers.get(entry.path)} and ${moduleId}`,
        );
      }
      writers.set(entry.path, moduleId);
    }
  }
  for (const channel of SHARED_ARTIFACT_CHANNELS) {
    if (writers.has(channel.path)) {
      errors.push(
        `single_writer: shared channel ${channel.path} is also claimed as a module write`,
      );
    }
  }

  // --- unit_compatible_edges ---------------------------------------------
  const toleranceOf = new Map(
    graph.nodes.map((node) => [node.id, node.tolerance_class]),
  );
  for (const edge of graph.edges) {
    const rule = EDGE_TOLERANCE_RULE[edge.type];
    if (!rule) {
      errors.push(`unit_compatible_edges: no declared rule for edge type ${edge.type}`);
      continue;
    }
    const from = toleranceOf.get(edge.from);
    const to = toleranceOf.get(edge.to);
    if (!rule.from.includes(from) || !rule.to.includes(to)) {
      errors.push(
        `unit_compatible_edges: ${edge.id} (${edge.type}) joins ${from} -> ${to}`,
      );
    }
  }
  const denominationsSeen = new Set(
    MODULE_INVARIANTS.map((entry) => entry.denomination),
  );
  for (const denomination of denominationsSeen) {
    if (!DECLARED_DENOMINATIONS.includes(denomination)) {
      errors.push(`unit_compatible_edges: undeclared denomination ${denomination}`);
    }
  }
  for (const entry of MODULE_INVARIANTS) {
    const nativeOperands = entry.operands.filter((operand) =>
      /_native\b/.test(operand),
    ).length;
    const rateOperands = entry.operands.filter((operand) =>
      /_fx\b/.test(operand),
    ).length;
    if (entry.denomination === "native" && nativeOperands === 0) {
      errors.push(
        `unit_compatible_edges: ${entry.invariant_id} declares native but names no native operand`,
      );
    }
    if (entry.denomination === "reporting" && nativeOperands > 0) {
      errors.push(
        `unit_compatible_edges: ${entry.invariant_id} mixes native operands into a reporting identity`,
      );
    }
    if (entry.denomination === "mixed_translation" && (nativeOperands === 0 || rateOperands === 0)) {
      errors.push(
        `unit_compatible_edges: ${entry.invariant_id} declares a translation but names no native operand and rate`,
      );
    }
    if (entry.denomination !== "mixed_translation" && rateOperands > 0) {
      errors.push(
        `unit_compatible_edges: ${entry.invariant_id} names an FX rate without declaring a translation`,
      );
    }
  }

  // --- declared_cross_module_reads_and_writes ----------------------------
  const declaredReads = new Set();
  for (const [moduleId, boundary] of Object.entries(boundaries)) {
    for (const entry of boundary.read_set) {
      if (entry.channel !== "equation_edge") continue;
      if (!entry.from_module) {
        errors.push(
          `declared_cross_module_reads_and_writes: ${moduleId} declares an equation_edge read with no producing module`,
        );
        continue;
      }
      declaredReads.add(`${moduleId}<-${entry.from_module}:${entry.detail}`);
      const producer = owned.get(entry.detail);
      if (producer !== entry.from_module) {
        errors.push(
          `declared_cross_module_reads_and_writes: ${moduleId} reads ${entry.detail} from ${entry.from_module}, but it is owned by ${producer ?? "nobody"}`,
        );
      }
    }
  }
  for (const edge of graph.edges) {
    const from = owned.get(edge.from);
    const to = owned.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${to}<-${from}:${edge.from}`;
    if (!declaredReads.has(key)) {
      errors.push(
        `declared_cross_module_reads_and_writes: undeclared cross-module read — ${to} consumes ${edge.from} from ${from} via ${edge.id}`,
      );
    }
  }
  const realCrossReads = new Set();
  for (const edge of graph.edges) {
    const from = owned.get(edge.from);
    const to = owned.get(edge.to);
    if (from && to && from !== to) realCrossReads.add(`${to}<-${from}:${edge.from}`);
  }
  for (const key of declaredReads) {
    if (!realCrossReads.has(key)) {
      errors.push(
        `declared_cross_module_reads_and_writes: declared read ${key} has no equation edge`,
      );
    }
  }

  // --- cycles_only_in_declared_iteration_subgraphs -----------------------
  const iterating = new Set();
  const declaredIterationNodes = [];
  for (const [moduleId, boundary] of Object.entries(boundaries)) {
    if (boundary.iteration_state.length > 0) iterating.add(moduleId);
    for (const nodeId of boundary.iteration_state) {
      declaredIterationNodes.push(nodeId);
      if (owned.get(nodeId) !== moduleId) {
        errors.push(
          `cycles_only_in_declared_iteration_subgraphs: ${moduleId} declares iteration over ${nodeId}, which it does not own`,
        );
      }
    }
  }
  const nodeSccs = deriveStronglyConnectedComponents(graph, { circularity: 1 });
  const sccMembers = new Set(nodeSccs.flatMap((component) => component.nodes ?? component));
  for (const nodeId of sccMembers) {
    const ownerId = owned.get(nodeId);
    if (!ownerId || !iterating.has(ownerId)) {
      errors.push(
        `cycles_only_in_declared_iteration_subgraphs: ${nodeId} is in an active component but its module ${ownerId ?? "(none)"} declares no iteration state`,
      );
    }
  }
  const solverVector = solverIterationDeclaration(1).state_vector.map(
    (component) => component.node_id,
  );
  const declaredSorted = [...declaredIterationNodes].sort();
  const solverSorted = [...solverVector].sort();
  if (canonicalJson(declaredSorted) !== canonicalJson(solverSorted)) {
    errors.push(
      `cycles_only_in_declared_iteration_subgraphs: declared iteration states ${JSON.stringify(declaredSorted)} != solver state vector ${JSON.stringify(solverSorted)}`,
    );
  }
  // The quotient coarsening is DECLARED; prove the extra modules carry no
  // node-level cycle member, so their empty iteration_state is correct.
  const quotientOn = quotientSccs(1);
  const nodeLevelModules = new Set(
    [...sccMembers].map((nodeId) => owned.get(nodeId)),
  );
  for (const component of quotientOn) {
    for (const moduleId of component) {
      if (nodeLevelModules.has(moduleId)) continue;
      const boundary = boundaries[moduleId];
      const offenders = boundary.nodes.filter((nodeId) => sccMembers.has(nodeId));
      if (offenders.length > 0) {
        errors.push(
          `cycles_only_in_declared_iteration_subgraphs: ${moduleId} is in a quotient component and owns cycle members ${JSON.stringify(offenders)}`,
        );
      }
      if (boundary.iteration_state.length > 0) {
        errors.push(
          `cycles_only_in_declared_iteration_subgraphs: ${moduleId} declares an iteration state but owns no node-level cycle member`,
        );
      }
    }
  }

  // --- circularity_off_has_no_active_scc ---------------------------------
  const offSccs = deriveStronglyConnectedComponents(graph, { circularity: 0 });
  if (offSccs.length !== 0) {
    errors.push(
      `circularity_off_has_no_active_scc: circularity=0 still has ${offSccs.length} component(s)`,
    );
  }
  if (quotientSccs(0).length !== 0) {
    errors.push(
      "circularity_off_has_no_active_scc: the module quotient graph is cyclic with circularity off",
    );
  }
  const offDeclaration = solverIterationDeclaration(0);
  if (offDeclaration.required !== false || offDeclaration.state_vector.length !== 0) {
    errors.push(
      "circularity_off_has_no_active_scc: the solver still declares an iteration vector with circularity off",
    );
  }
  const offSolutions = context.circularity_off_solutions ?? null;
  if (!Array.isArray(offSolutions) || offSolutions.length === 0) {
    errors.push(
      "circularity_off_has_no_active_scc: no circularity-off solved artifact supplied — the invariant is not provable against the graph alone",
    );
  } else {
    for (const solution of offSolutions) {
      const evidence = solution.equation_graph_evidence;
      if (evidence?.active_circularity_state !== 0) {
        errors.push(
          `circularity_off_has_no_active_scc: ${solution.case_id} did not solve with circularity off`,
        );
      }
      if ((evidence?.active_sccs ?? []).length !== 0) {
        errors.push(
          `circularity_off_has_no_active_scc: ${solution.case_id} reports active_sccs with circularity off`,
        );
      }
      if (evidence?.solver_declaration?.required !== false) {
        errors.push(
          `circularity_off_has_no_active_scc: ${solution.case_id} still requires iteration`,
        );
      }
      if (Number(solution.residual) !== 0) {
        errors.push(
          `circularity_off_has_no_active_scc: ${solution.case_id} has a non-zero residual with circularity off`,
        );
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Binding the nine boundaries to a real solved artifact
// ---------------------------------------------------------------------------

function resolveWritePath(path, solution) {
  if (path.startsWith("solution.")) {
    const key = path.slice("solution.".length);
    return {
      kind: "solution",
      present: Object.hasOwn(solution, key),
      values: [solution[key]],
    };
  }
  if (!path.startsWith("forecast[].")) {
    throw new Error(`Unsupported write path ${path}`);
  }
  const rest = path.slice("forecast[].".length).split(".");
  const values = [];
  let present = true;
  for (const period of solution.forecast ?? []) {
    let cursor = period;
    for (const segment of rest) {
      if (cursor === null || cursor === undefined || !Object.hasOwn(cursor, segment)) {
        present = false;
        cursor = undefined;
        break;
      }
      cursor = cursor[segment];
    }
    values.push(cursor);
  }
  return { kind: "period", present, values };
}
export { resolveWritePath };

/**
 * Bind every module boundary to a real solved artifact and report, per module,
 * what resolved and what did not. Returns an artifact; validation is separate,
 * so a caller cannot mistake compilation for proof.
 */
export function bindCanonicalModules({
  modelCase,
  solution,
  statementBindings,
  boundaries = CANONICAL_MODULE_BOUNDARIES,
}) {
  if (!modelCase || typeof modelCase !== "object") {
    throw new Error("bindCanonicalModules requires a model case.");
  }
  if (!solution || !Array.isArray(solution.forecast)) {
    throw new Error("bindCanonicalModules requires a solved artifact with a forecast.");
  }
  const rowByNode = new Map();
  for (const binding of statementBindings ?? []) {
    const parts = String(binding.statement_node_id).split(":");
    rowByNode.set(binding.equation_node_id, {
      row_id: parts[2],
      section: binding.section,
      semantic_role: binding.semantic_role,
    });
  }

  const modules = [];
  for (const [moduleId, boundary] of Object.entries(boundaries)) {
    const writes = boundary.write_set.map((entry) => {
      const resolved = resolveWritePath(entry.path, solution);
      return {
        path: entry.path,
        presence: entry.presence,
        resolved: resolved.present,
        note: entry.note,
      };
    });
    const carriers = boundary.nodes.map((nodeId) => {
      const carrier = NODE_CARRIERS[nodeId];
      const row = rowByNode.get(nodeId) ?? null;
      const samples = [];
      for (const period of solution.forecast) {
        if (carrier.channel === "statement_row") {
          samples.push(row ? period.statement_values?.[row.row_id] : undefined);
        } else if (carrier.channel === "instrument_aggregate") {
          samples.push(sumOver(period.instrument_results, carrier.field));
        } else {
          samples.push(period[carrier.field]);
        }
      }
      return {
        node_id: nodeId,
        channel: carrier.channel,
        denomination: carrier.denomination,
        presence: carrierPresence(nodeId),
        statement_row: row,
        bound: samples.every(
          (value) => value !== undefined && value !== null && Number.isFinite(Number(value)),
        ),
        samples,
      };
    });
    const invariantResults = boundary.invariants.map((invariantId) => {
      const entry = MODULE_INVARIANTS.find(
        (candidate) => candidate.invariant_id === invariantId,
      );
      const failures = entry.evaluate({ modelCase, solution });
      return {
        invariant_id: invariantId,
        denomination: entry.denomination,
        independent_confirmation: entry.independent_confirmation ?? null,
        failures,
      };
    });
    modules.push({
      module_id: moduleId,
      module_version: boundary.module_version,
      boundary_sha256: moduleBoundaryDigest(boundary),
      node_count: boundary.nodes.length,
      edge_count: boundary.edges.length,
      iteration_state: [...boundary.iteration_state],
      writes,
      carriers,
      invariants: invariantResults,
    });
  }

  return {
    schema_version: CANONICAL_MODEL_MODULE_SCOPE,
    case_id: solution.case_id,
    contract_sha256: canonicalModuleContractDigest(),
    modules,
    shared_channels: SHARED_ARTIFACT_CHANNELS.map((channel) => ({ ...channel })),
    unowned_nodes: UNOWNED_EQUATION_NODES.map((entry) => ({ ...entry })),
  };
}

/**
 * Validate the binding artifact. Recomputes rather than trusting: the artifact
 * is only the shape the report takes.
 */
export function validateCanonicalModuleBinding(artifact, { modelCase, solution } = {}) {
  const errors = [];
  if (artifact.schema_version !== CANONICAL_MODEL_MODULE_SCOPE) {
    errors.push(`BINDING_SCOPE_UNEXPECTED: ${artifact.schema_version}`);
  }
  if (artifact.contract_sha256 !== canonicalModuleContractDigest()) {
    errors.push("BINDING_CONTRACT_DIGEST_DRIFT");
  }
  const seen = new Set();
  for (const module of artifact.modules) {
    seen.add(module.module_id);
    const boundary = CANONICAL_MODULE_BOUNDARIES[module.module_id];
    if (!boundary) {
      errors.push(`BINDING_UNDECLARED_MODULE: ${module.module_id}`);
      continue;
    }
    if (module.boundary_sha256 !== moduleBoundaryDigest(boundary)) {
      errors.push(`BINDING_BOUNDARY_DIGEST_DRIFT: ${module.module_id}`);
    }
    for (const write of module.writes) {
      if (!write.resolved && write.presence === "always") {
        errors.push(
          `BINDING_WRITE_UNRESOLVED: ${module.module_id} declares ${write.path} but the solved artifact does not carry it`,
        );
      }
      if (write.resolved && write.presence === "case_conditional" && !write.note) {
        errors.push(
          `BINDING_CONDITIONAL_WRITE_UNEXPLAINED: ${module.module_id} ${write.path}`,
        );
      }
    }
    for (const carrier of module.carriers) {
      if (carrier.channel === "statement_row" && !carrier.statement_row) {
        if (carrier.presence === "required") {
          errors.push(
            `BINDING_REQUIRED_ROW_ABSENT: ${module.module_id} ${carrier.node_id} is P4.6 presence=required and this case files no such row (the same condition P4.6's ECONOMIC_BINDING_REQUIRED_ROW_ABSENT raises at compile)`,
          );
        }
        continue;
      }
      if (!carrier.bound && carrier.presence !== "case_optional") {
        errors.push(
          `BINDING_CARRIER_UNRESOLVED: ${module.module_id} ${carrier.node_id} does not resolve to a finite value in every period`,
        );
      }
    }
    for (const result of module.invariants) {
      for (const failure of result.failures) {
        errors.push(
          `MODULE_INVARIANT_VIOLATED: ${module.module_id}/${result.invariant_id}: ${failure}`,
        );
      }
    }
  }
  for (const moduleId of Object.keys(CANONICAL_MODULE_BOUNDARIES)) {
    if (!seen.has(moduleId)) {
      errors.push(`BINDING_MODULE_MISSING: ${moduleId} was not bound`);
    }
  }

  // Statement-row injectivity — the delegated single-writer channel, re-proven.
  const claimed = new Map();
  for (const module of artifact.modules) {
    for (const carrier of module.carriers) {
      if (!carrier.statement_row) continue;
      const key = `${carrier.statement_row.section}/${carrier.statement_row.row_id}`;
      if (claimed.has(key)) {
        errors.push(
          `BINDING_STATEMENT_ROW_CONTESTED: ${key} claimed by ${claimed.get(key)} and ${carrier.node_id}`,
        );
      }
      claimed.set(key, carrier.node_id);
    }
  }

  // Carrier mirrors: the declared relationship to the solver's own scalars.
  if (solution) {
    for (const module of artifact.modules) {
      for (const carrier of module.carriers) {
        const declaration = NODE_CARRIERS[carrier.node_id];
        if (!declaration?.mirror || !carrier.statement_row) continue;
        solution.forecast.forEach((period, index) => {
          const observed = period.statement_values?.[carrier.statement_row.row_id];
          if (observed === undefined || observed === null) return;
          const expected = evaluateMirror(declaration.mirror, period);
          if (expected === null) return;
          if (!near(observed, expected, 1e-6)) {
            errors.push(
              `BINDING_CARRIER_MIRROR_DISAGREEMENT: ${carrier.node_id} p${index}: row ${observed} != declared mirror ${expected}`,
            );
          }
        });
      }
    }
  }

  // Totality: every field the solver emits is claimed or declared frame.
  if (solution) {
    errors.push(...solverFieldCensusErrors(solution));
  }
  void modelCase;
  return errors;
}

/**
 * TOTALITY. A field the solver emits that no module claims and the frame does
 * not declare is a boundary the contract does not cover — reported, never
 * absorbed. This is what makes the nine boundaries a partition of the solved
 * artifact rather than nine opinions about parts of it.
 */
export function solverFieldCensusErrors(
  solution,
  boundaries = CANONICAL_MODULE_BOUNDARIES,
) {
  const errors = [];
  const solutionClaims = new Set(SOLVER_FRAME_FIELDS.solution);
  const periodClaims = new Set(SOLVER_FRAME_FIELDS.period);
  const checkClaims = new Set();
  const typedClaims = new Set(SOLVER_FRAME_FIELDS.typed_states);
  for (const channel of SHARED_ARTIFACT_CHANNELS) {
    if (channel.path.startsWith("forecast[].")) {
      periodClaims.add(channel.path.slice("forecast[].".length));
    }
  }
  for (const boundary of Object.values(boundaries)) {
    for (const entry of boundary.write_set) {
      if (entry.path.startsWith("solution.")) {
        solutionClaims.add(entry.path.slice("solution.".length).split(".")[0]);
        continue;
      }
      const rest = entry.path.slice("forecast[].".length).split(".");
      if (rest[0] === "checks") {
        periodClaims.add("checks");
        checkClaims.add(rest[1]);
      } else if (rest[0] === "typed_states") {
        periodClaims.add("typed_states");
        typedClaims.add(rest[1]);
      } else {
        periodClaims.add(rest[0]);
      }
    }
  }
  for (const key of Object.keys(solution)) {
    if (!solutionClaims.has(key)) {
      errors.push(
        `CENSUS_SOLUTION_FIELD_UNCLAIMED: solution.${key} is written by no module and is not declared frame`,
      );
    }
  }
  for (const period of solution.forecast ?? []) {
    for (const key of Object.keys(period)) {
      if (!periodClaims.has(key)) {
        errors.push(
          `CENSUS_PERIOD_FIELD_UNCLAIMED: forecast[].${key} is written by no module and is not declared frame`,
        );
      }
    }
    for (const key of Object.keys(period.checks ?? {})) {
      if (!checkClaims.has(key)) {
        errors.push(`CENSUS_CHECK_UNCLAIMED: forecast[].checks.${key}`);
      }
    }
    for (const key of Object.keys(period.typed_states ?? {})) {
      if (!typedClaims.has(key)) {
        errors.push(`CENSUS_TYPED_STATE_UNCLAIMED: forecast[].typed_states.${key}`);
      }
    }
  }
  return [...new Set(errors)];
}

/**
 * The module invariants alone, without the statement-row carrier obligations.
 *
 * DECLARED COVERAGE SPLIT, said out loud rather than left to be discovered: the
 * economics archetypes are minimal synthetic cases that declare only the few
 * statement rows their scenario needs, so most `statement_row` carriers are
 * legitimately absent there — P4.6 types that `row_absent`, a lawful case
 * variant, not a defect. The full boundary binding is therefore validated on
 * the two CERTIFIED fixtures, which declare a complete statement structure, and
 * the archetype corpus sweeps the module invariants, which hold on any case
 * that solves at all.
 */
export function validateModuleInvariants({ modelCase, solution }) {
  const failures = [];
  for (const entry of MODULE_INVARIANTS) {
    for (const failure of entry.evaluate({ modelCase, solution })) {
      failures.push(`${entry.module_id}/${entry.invariant_id}: ${failure}`);
    }
  }
  return failures;
}

export function statementBindingsFor(constitutionArtifact) {
  return economicStatementBindings(constitutionArtifact);
}
