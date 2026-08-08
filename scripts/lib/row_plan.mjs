import {
  describeStatementRow,
  inferMovementType,
} from "./semantic_graph.mjs";
export { inferMovementType } from "./semantic_graph.mjs";
import { resolveAnchorPlanDecision } from "./broker_anchor.mjs";
import {
  activeDesignContractSha256,
  activeDesignRuntimeSha256,
  presentationEpoch,
  selectStandardisedProfile,
  STANDARDISED_DESIGN_CONTRACT_SHA256,
  STANDARDISED_DESIGN_RUNTIME_SHA256,
  standardisedProfile,
} from "./design_contract.mjs";
import { isBalancingRcf } from "./rcf_policy.mjs";
import { resolvedLeaseInterestBasis } from "./lease_policy.mjs";
import { classifyStatementLine } from "./statement_classifier.mjs";
import {
  forecastRowMateriality,
  isScheduleOwnedForecastRole,
} from "./forecast_authority.mjs";
import {
  assertStatementTopology,
  deriveStatementIndentMap,
  materializeStatementPresentationTree,
  repairStatementSourceOrder,
} from "./statement_topology.mjs";

/**
 * THREE RANKS OF TOTAL — RESOLVED FROM SEMANTIC ROLE *AND SECTION*, NEVER FROM A
 * ROW NUMBER.
 *
 * A model with one rank of total has no hierarchy: `Total Bonds`,
 * `Gross debt (incl. leases)` and `Net debt (excl. leases)` are three different
 * kinds of statement and used to be visually identical. Rank is carried by line
 * weight, so the fill is freed to mean exactly one thing (see `style-tokens.json`
 * → `total_ranks` / `fill_semantics`):
 *
 *   component_sum   closes a run of like items      thin top rule, NO FILL
 *   block_subtotal  closes a block of the model     thin top rule, #EFF5F9
 *   answer          the figure the reader came for  thin top rule, DOUBLE bottom
 *                                                   rule, #D9EAF7
 *
 * RANK IS CONTEXTUAL, BECAUSE THE SAME LINE IS TWO DIFFERENT THINGS IN TWO
 * PLACES. `net_interest_expense` is the ANSWER of the interest schedule — the
 * whole schedule exists to arrive at it — and a STEP on the income statement, on
 * the way from operating profit to profit before tax. Keyed on `row_id` alone it
 * could only be one of the two, and it was declared an answer globally: the
 * income statement then gave the reader a double-ruled, answer-filled interest
 * line with net income two rows below it in a lighter treatment. The set had
 * been written from the debt overlay's point of view and the income statement
 * inherited it, so `adjusted_ebitda`, `ebit` and `net_income` were not in it at
 * all. Rank now resolves through `(row_id | semantic_role, section)`.
 *
 * `style-tokens.json` used to carry `total_rows` / `subsection_rows` as PHYSICAL
 * ROW NUMBERS, which contradicts the architecture rule that physical rows are
 * compiled output and never canonical: insert one instrument and every number in
 * those arrays is wrong while still looking authoritative. Rank is therefore
 * keyed on the row's own identity — `row_id`, `semantic_role`, or the structural
 * kind of a dynamically allocated group subtotal — and the physical row is only
 * ever looked up through the compiled plan.
 */
export const TOTAL_RANK = {
  COMPONENT: "component_sum",
  BLOCK: "block_subtotal",
  ANSWER: "answer",
};

/**
 * The sections rank resolves against. These are the compiled section names, so
 * a caller cannot invent one: `totalRank` throws on anything not listed, which
 * is what stops a new emitter block from silently falling back to the old
 * section-blind behaviour.
 */
export const RANK_SECTION = {
  INCOME_STATEMENT: "income_statement",
  CASH_FLOW: "cash_flow",
  DEBT_SCHEDULE: "debt_schedule",
  RCF_WATERFALL: "rcf_waterfall",
  INTEREST_SCHEDULE: "interest_schedule",
};
const RANK_SECTIONS = new Set(Object.values(RANK_SECTION));

// Closes a run of like items. Every debt-group and interest-group subtotal is a
// component sum too; those rows are allocated dynamically, so they are resolved
// through `groupSubtotalRank()` rather than named here.
const COMPONENT_SUM_IDS = new Set([
  "total_acquisition_debt",
  "total_lease_liabilities",
  "rcf_total_fees",
]);

// Closes a block of the model. Named explicitly where the plan names them; any
// other row that carries the total treatment falls through to this rank, which
// is the conservative default — a block subtotal keeps a fill, so an unclassified
// total can never silently lose its weight.
const BLOCK_SUBTOTAL_IDS = new Set([
  "adjusted_ebitda",
  "cash_from_operations",
  "cash_from_investing",
  "cash_from_financing",
  "net_change_in_cash",
  "gross_debt_excluding_leases",
  "gross_debt_including_leases",
  "gross_interest_expense",
  "cash_before_rcf",
  "gross_profit",
  "operating_profit",
  "ebit",
]);

/**
 * THE ANSWER OF EACH SECTION, DECLARED PER SECTION.
 *
 * `answers` are rows that already carry the total treatment; a row named here is
 * promoted from the block-subtotal default to the answer rank. `ratio_answers`
 * are the exemption to "a ratio row is a READING of the rows above it and stays
 * italic": a leverage multiple is not a step to anything, it is what the reader
 * opened the model for, so it takes the answer rank even though it is not a
 * total. Both are scoped to a section, so nothing here can leak into a statement
 * that merely happens to reuse the id.
 */
const SECTION_RANKS = {
  [RANK_SECTION.INCOME_STATEMENT]: {
    // The bottom line, and nothing above it. `net_income_common` is an
    // attribution split BENEATH the answer, not a second answer: the model's own
    // cash flow reads `net_income`, which is the independent evidence for which
    // of the two the rest of the model treats as the figure.
    answers: new Set(["net_income"]),
    // NOT an answer here. It is a step between operating profit and profit
    // before tax; the interest schedule below is where it concludes something.
    blocks: new Set(["net_interest_expense", "pre_tax_income"]),
    // NOTHING on the income statement closes a block. Revenue, gross profit,
    // Adjusted EBITDA, EBIT and profit before taxation are all steps down one
    // continuous ladder to the bottom line, and the bottom line is the answer.
    bands: new Set(),
    ratio_answers: new Set(),
  },
  [RANK_SECTION.CASH_FLOW]: {
    answers: new Set(["ending_cash"]),
    blocks: new Set(["free_cash_flow"]),
    // The waterfall's own close, and the memo conclusion beneath it. The three
    // activity subtotals are deliberately NOT here: they are steps, and giving
    // them the band made the statement read as four conclusions.
    bands: new Set(["net_change_in_cash", "free_cash_flow"]),
    ratio_answers: new Set(),
  },
  [RANK_SECTION.DEBT_SCHEDULE]: {
    answers: new Set([
      "net_debt_excluding_leases",
      "net_debt_including_leases",
      // EQUAL TREATMENT OF THE TWO BASES. The company-reported figure used to
      // fall through to the block-subtotal default while its model-basis
      // counterpart took the answer rank, so the formatting asserted that one
      // basis is the real number and the other a footnote. They are two answers
      // to the same question and they terminate identically.
      "net_debt_company_reported",
      "total_liquidity",
    ]),
    blocks: new Set(),
    // Gross debt and cash-before-RCF are steps toward net debt; net debt and
    // liquidity are already answers.
    bands: new Set(),
    ratio_answers: new Set([
      "net_debt_excluding_leases_to_adjusted_ebitda",
      "net_debt_to_adjusted_ebitda",
      // ...and the same equal treatment for the multiple the company basis
      // lands on. The COVERAGE multiple is deliberately absent: it is a reading
      // of two rows above it and stays an ordinary italic ratio row.
      "net_debt_company_reported_to_adjusted_ebitda",
    ]),
  },
  [RANK_SECTION.RCF_WATERFALL]: {
    answers: new Set(["ending_rcf"]),
    blocks: new Set(),
    bands: new Set(),
    ratio_answers: new Set(),
  },
  [RANK_SECTION.INTEREST_SCHEDULE]: {
    // Here it IS the answer: the entire schedule builds to it.
    answers: new Set(["net_interest_expense"]),
    blocks: new Set(),
    bands: new Set(),
    ratio_answers: new Set(),
  },
};

/**
 * THE HEADLINE SET — EXTRA NARRATIVE PROMINENCE FOR NON-TOTAL ROWS.
 *
 * Semantic totals and subtotals are bold by contract. This smaller ladder is
 * retained for a prominent issuer row that is not itself classified as a total
 * (for example an EBIT anchor in a bespoke presentation). The channels remain:
 *
 *   rules (single / double / box)  arithmetic closure — where a sum ends
 *   bold                           every semantic total, plus this list
 *   fill                           rank hierarchy
 *   font colour                    provenance (never touched by any of this)
 *
 * Each entry is a LADDER, not a row id: the first id present in the compiled
 * section wins and the rest are ignored. That is what "adapt to what the company
 * actually reports" means in code — a case that states `operating_profit` gets
 * that line bolded, a case that states only `ebit` gets that one, and neither is
 * forced onto a company that presents neither.
 */
const SECTION_HEADLINES = {
  [RANK_SECTION.INCOME_STATEMENT]: [
    ["revenue"],
    ["adjusted_ebitda"],
    ["operating_profit", "ebit"],
    ["net_income"],
  ],
  [RANK_SECTION.CASH_FLOW]: [
    ["cash_from_operations"],
    ["cash_from_investing"],
    ["cash_from_financing"],
    ["net_change_in_cash"],
    ["ending_cash"],
  ],
  [RANK_SECTION.DEBT_SCHEDULE]: [
    ["gross_debt_excluding_leases"],
    ["gross_debt_including_leases"],
    ["net_debt_excluding_leases"],
    ["net_debt_including_leases"],
    ["net_debt_excluding_leases_to_adjusted_ebitda"],
    ["net_debt_to_adjusted_ebitda"],
    // The company panel is a peer of the model panel, so its two terminal rows
    // are headlines on the same footing as the model panel's.
    ["net_debt_company_reported"],
    ["net_debt_company_reported_to_adjusted_ebitda"],
    ["total_liquidity"],
  ],
  [RANK_SECTION.RCF_WATERFALL]: [["ending_rcf"]],
  [RANK_SECTION.INTEREST_SCHEDULE]: [["net_interest_expense"]],
};

/**
 * A row that exists to separate two panels and carries nothing.
 *
 * A Symbol, not a string: a string sentinel could collide with a row id, and
 * could be written into `debtSummaryRows` by a future loop that forgot to skip
 * it. This cannot be indexed by accident.
 */
const PANEL_SPACER = Symbol("panel_spacer");

function assertSection(section) {
  if (!RANK_SECTIONS.has(section)) {
    throw new Error(
      `Rank and headline resolution need a section. Got ${JSON.stringify(
        section,
      )}; expected one of ${[...RANK_SECTIONS].join(", ")}.`,
    );
  }
}

/**
 * Rank for a row identified by `row_id` and/or `semantic_role`, WITHIN A
 * SECTION. Returns null when the row is not a total at all, so the caller can
 * leave it alone.
 *
 * `isTotal` says whether the row carries the total treatment in the first place
 * (`style_role === "total"`, a `subtotal` row type, or a summary row the emitter
 * has already decided is a subtotal). Rank only refines a row that is already a
 * total; it never promotes an ordinary row. The one exception is a
 * `ratio_answers` row, which is not a total and is promoted deliberately.
 */
export function totalRank(identity, isTotal = true, section = undefined) {
  assertSection(section);
  const table = SECTION_RANKS[section];
  const explicitConclusion =
    identity &&
    typeof identity === "object" &&
    !Array.isArray(identity) &&
    identity.section_conclusion_owner === true;
  const keys = (
    Array.isArray(identity)
      ? identity
      : identity && typeof identity === "object"
        ? [identity.row_id, identity.semantic_role]
        : [identity]
  ).filter((key) => typeof key === "string" && key.length > 0);
  // Statement conclusions come from the compiled dependency graph.  The legacy
  // per-section answer table remains only for mechanical schedules whose rows
  // are the graph's fixed outputs; it is never allowed to override a statement
  // compiler decision.
  if (
    explicitConclusion &&
    [RANK_SECTION.INCOME_STATEMENT, RANK_SECTION.CASH_FLOW].includes(section)
  ) {
    return TOTAL_RANK.ANSWER;
  }
  for (const key of keys) {
    if (table.ratio_answers.has(key)) return TOTAL_RANK.ANSWER;
  }
  if (!isTotal) return null;
  for (const key of keys) {
    if (COMPONENT_SUM_IDS.has(key)) return TOTAL_RANK.COMPONENT;
  }
  if (![RANK_SECTION.INCOME_STATEMENT, RANK_SECTION.CASH_FLOW].includes(section)) {
    for (const key of keys) {
      if (table.answers.has(key)) return TOTAL_RANK.ANSWER;
    }
  }
  // EPOCH 3 INVERTS THE DEFAULT, AND THAT IS THE WHOLE DESIGN CHANGE.
  //
  // Epoch 2 banded every total it could not otherwise classify, on the theory
  // that a band is the safe outcome because an unfamiliar total can never
  // silently lose its weight. In practice the unclassified case is the COMMON
  // case — an issuer's own `Cash generated from operations` carries no semantic
  // role at all — so the safe default became the universal one, and a real
  // filing rendered as a wall of identical bands. Three declared ranks came out
  // as two, and the row each section exists to produce sat one shade away from
  // four rows that merely pass through it. Filling everything is the same as
  // filling nothing.
  //
  // So under epoch 3 the band is DECLARED, never inherited: `bands` names the
  // rows that close a block, `answers` names the one row the section produces,
  // and everything else that closes arithmetic is a STEP — bold, with a thin
  // rule under its own label, and no fill. An unfamiliar issuer total is still
  // unmistakably a total; it simply is not also a conclusion. That makes the
  // default degrade toward quiet rather than toward noise, which is the only
  // direction that survives contact with an arbitrary filing.
  if (presentationEpoch() >= 3) {
    for (const key of keys) {
      if (table.bands.has(key)) return TOTAL_RANK.BLOCK;
    }
    return TOTAL_RANK.COMPONENT;
  }
  for (const key of keys) {
    if (table.blocks.has(key)) return TOTAL_RANK.BLOCK;
  }
  for (const key of keys) {
    if (BLOCK_SUBTOTAL_IDS.has(key)) return TOTAL_RANK.BLOCK;
  }
  return TOTAL_RANK.BLOCK;
}

/**
 * The declared headline rows of a section, narrowed to what this case actually
 * presents. `presentIds` is every id the compiled section carries; the ladder
 * resolves against it so a row a company does not report is never forced.
 */
export function headlineIds(section, presentIds) {
  assertSection(section);
  const present =
    presentIds instanceof Set ? presentIds : new Set(presentIds ?? []);
  const resolved = new Set();
  for (const ladder of SECTION_HEADLINES[section] ?? []) {
    const chosen = ladder.find((id) => present.has(id));
    if (chosen) resolved.add(chosen);
  }
  return resolved;
}

/**
 * A debt-group or interest-group subtotal — `Total Bonds`, `Total Bank Debt`,
 * `Total Other Debt`, and the per-group interest subtotals. Structurally a
 * component sum in every case: it closes a run of instruments and nothing else.
 */
/**
 * Roles whose rows carry the total treatment by identity, whatever row_type
 * the classifier or case author gave them. Gross profit compiled as a plain
 * `calculation` row rendered indistinguishable from the expense lines around
 * it; a key subtotal's weight comes from what the row IS, never from how its
 * arithmetic happened to be typed. This is a role list, not a formula-shape
 * heuristic: a SUM alone still earns nothing.
 */
const RANKED_TOTAL_ROLES = new Set([
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
  "free_cash_flow",
]);

export function isRankedTotalIdentity(identity) {
  const keys = (Array.isArray(identity) ? identity : [identity]).filter(
    (key) => typeof key === "string" && key.length > 0,
  );
  return keys.some((key) => RANKED_TOTAL_ROLES.has(key));
}

export function groupSubtotalRank() {
  return TOTAL_RANK.COMPONENT;
}

const DEFAULT_INCOME_ROWS = [
  {
    row_id: "revenue",
    label: "Revenue",
    row_type: "input",
    semantic_role: "revenue",
    broker_metric_id: "revenue",
    style_role: "total",
  },
  {
    row_id: "revenue_growth",
    label: "Revenue growth %",
    row_type: "calculation",
    calculation: { operator: "growth", refs: ["revenue"] },
    style_role: "subsection",
  },
  {
    row_id: "ebit",
    label: "Operating profit / EBIT",
    row_type: "input",
    semantic_role: "ebit",
    broker_metric_id: "ebit",
    style_role: "total",
  },
  {
    row_id: "interest_income",
    label: "Interest income",
    row_type: "calculation",
    semantic_role: "interest_income",
    style_role: "body",
  },
  {
    row_id: "interest_expense",
    label: "Interest expense",
    row_type: "calculation",
    semantic_role: "interest_expense",
    style_role: "body",
  },
  {
    row_id: "other_non_operating",
    label: "Other non-operating income / (expense)",
    row_type: "input",
    style_role: "body",
  },
  {
    row_id: "pre_tax_income",
    label: "Pre-tax income",
    row_type: "calculation",
    calculation: {
      operator: "sum",
      refs: ["ebit", "interest_income", "interest_expense", "other_non_operating"],
    },
    style_role: "total",
  },
  {
    row_id: "effective_tax_rate",
    label: "Effective tax rate",
    row_type: "input",
    semantic_role: "effective_tax_rate",
    broker_metric_id: "effective_tax_rate",
    style_role: "subsection",
    number_format: "percentage",
  },
  {
    row_id: "tax_expense",
    label: "Income tax expense",
    row_type: "calculation",
    calculation: {
      operator: "tax",
      refs: ["pre_tax_income", "effective_tax_rate"],
    },
    style_role: "body",
  },
  {
    row_id: "net_income",
    label: "Net income",
    row_type: "calculation",
    calculation: { operator: "sum", refs: ["pre_tax_income", "tax_expense"] },
    style_role: "total",
  },
  {
    row_id: "adjusted_ebitda_bridge",
    label: "Adjusted EBITDA bridge",
    row_type: "header",
    style_role: "subsection",
  },
  {
    row_id: "bridge_ebit",
    label: "Operating profit / EBIT",
    row_type: "calculation",
    calculation: { operator: "link", refs: ["ebit"] },
    indent: 1,
  },
  {
    row_id: "depreciation_and_amortisation",
    label: "Depreciation and amortisation",
    row_type: "input",
    semantic_role: "depreciation_and_amortisation",
    broker_metric_id: "depreciation_and_amortisation",
    indent: 1,
  },
  {
    row_id: "recurring_disclosed_adjustments",
    label: "Recurring disclosed adjustments",
    row_type: "input",
    semantic_role: "recurring_disclosed_adjustments",
    indent: 1,
  },
  {
    row_id: "adjusted_ebitda",
    label: "Adjusted EBITDA",
    row_type: "input",
    semantic_role: "adjusted_ebitda",
    broker_metric_id: "adjusted_ebitda",
    style_role: "total",
  },
  {
    row_id: "adjusted_ebitda_margin",
    label: "Adjusted EBITDA margin",
    row_type: "calculation",
    calculation: { operator: "ratio", refs: ["adjusted_ebitda", "revenue"] },
    style_role: "subsection",
    number_format: "percentage",
  },
];

const DEFAULT_CASH_FLOW_ROWS = [
  {
    row_id: "cash_flow_net_income",
    label: "Net income",
    row_type: "calculation",
    calculation: { operator: "link", refs: ["net_income"] },
  },
  {
    row_id: "cash_flow_da",
    label: "Depreciation and amortisation",
    row_type: "calculation",
    calculation: { operator: "link", refs: ["depreciation_and_amortisation"] },
    indent: 1,
  },
  {
    row_id: "other_non_cash",
    label: "Other non-cash adjustments",
    row_type: "input",
    semantic_role: "other_non_cash",
    indent: 1,
  },
  {
    row_id: "change_in_working_capital",
    label: "Change in working capital",
    row_type: "input",
    semantic_role: "change_in_working_capital",
    style_role: "subsection",
  },
  {
    row_id: "cash_from_operations",
    label: "Cash from operations",
    row_type: "calculation",
    calculation: {
      operator: "sum",
      refs: [
        "cash_flow_net_income",
        "cash_flow_da",
        "other_non_cash",
        "change_in_working_capital",
      ],
    },
    style_role: "total",
  },
  {
    row_id: "capex",
    label: "Capital expenditure",
    row_type: "input",
    semantic_role: "capex",
    broker_metric_id: "capex",
  },
  {
    row_id: "other_investing",
    label: "Other investing cash flow",
    row_type: "input",
    semantic_role: "other_investing",
  },
  {
    row_id: "cash_from_investing",
    label: "Cash from investing",
    row_type: "calculation",
    calculation: { operator: "sum", refs: ["capex", "other_investing"] },
    style_role: "total",
  },
  {
    row_id: "debt_issuance",
    label: "Debt issuance",
    row_type: "calculation",
    semantic_role: "debt_issuance",
  },
  {
    row_id: "debt_repayment",
    label: "Debt repayment",
    row_type: "calculation",
    semantic_role: "debt_repayment",
  },
  {
    row_id: "rcf_draw",
    label: "RCF draw",
    row_type: "calculation",
    semantic_role: "rcf_draw",
  },
  {
    row_id: "rcf_repayment",
    label: "RCF repayment",
    row_type: "calculation",
    semantic_role: "rcf_repayment",
  },
  {
    row_id: "lease_principal",
    label: "Lease principal repayment",
    row_type: "input",
    semantic_role: "lease_principal",
  },
  {
    row_id: "dividends",
    label: "Dividends",
    row_type: "input",
    semantic_role: "dividends",
    broker_metric_id: "dividends",
  },
  {
    row_id: "share_buybacks",
    label: "Share buybacks",
    row_type: "input",
    semantic_role: "share_buybacks",
    broker_metric_id: "share_buybacks",
  },
  {
    row_id: "cash_from_financing",
    label: "Cash from financing",
    row_type: "calculation",
    calculation: {
      operator: "sum",
      refs: [
        "debt_issuance",
        "debt_repayment",
        "rcf_draw",
        "rcf_repayment",
        "lease_principal",
        "dividends",
        "share_buybacks",
      ],
    },
    style_role: "total",
  },
  {
    row_id: "fx_effect_on_cash",
    label: "FX effect on cash",
    row_type: "input",
    semantic_role: "fx_effect_on_cash",
  },
  {
    row_id: "net_change_in_cash",
    label: "Net change in cash",
    row_type: "calculation",
    calculation: {
      operator: "sum",
      refs: [
        "cash_from_operations",
        "cash_from_investing",
        "cash_from_financing",
        "fx_effect_on_cash",
      ],
    },
    style_role: "total",
  },
  {
    row_id: "opening_cash",
    label: "Opening cash",
    row_type: "calculation",
    semantic_role: "opening_cash",
    style_role: "total",
  },
  {
    row_id: "ending_cash",
    label: "Ending cash",
    row_type: "calculation",
    semantic_role: "ending_cash",
    style_role: "total",
  },
  {
    row_id: "free_cash_flow_header",
    label: "Free cash flow",
    row_type: "header",
    style_role: "subsection",
  },
  {
    row_id: "free_cash_flow",
    label: "Free cash flow",
    row_type: "calculation",
    calculation: { operator: "sum", refs: ["cash_from_operations", "capex"] },
    style_role: "total",
  },
  {
    row_id: "free_cash_flow_conversion",
    label: "Free cash flow conversion",
    row_type: "calculation",
    calculation: { operator: "ratio", refs: ["free_cash_flow", "adjusted_ebitda"] },
    style_role: "subsection",
    number_format: "percentage",
  },
];

function cloneRows(rows) {
  // Deep, not shallow. A shallow copy shares each row's `calculation` object
  // with the case, so normalising twice — the coverage gate asks for the
  // compiled roles before the build compiles the row plan — mutated the case
  // and appended the same dependency ref twice.
  return rows.map((row) => structuredClone(row));
}

function resetCompiledPresentationMetadata(rows) {
  for (const row of rows) {
    row.indent = 0;
    row.outline_level = 0;
    delete row.projection_origin;
    delete row.projection_required_by;
    delete row.presentation_parent_id;
    delete row.presentation_depth;
    delete row.presentation_role;
  }
}

// ---------------------------------------------------------------------------
// CONSOLIDATION DYNAMICS
//
// A company reports its cash flow at whatever granularity it chooses. A broker
// forecasts at a consolidated level. Where the company publishes only the
// constituents, the model must ADD the consolidated line and SUM them —
// otherwise the historic and forecast presentations do not match and the
// forecast has nothing to attach to. The constituents STAY VISIBLE exactly as
// the company reported them, indented beneath the consolidated line.
//
// Two sections need this, and they are the same shape:
//   - operating:  Change in Working Capital over receivables, inventories,
//                 other assets, payables, income taxes, accrued liabilities …
//   - financing:  Change in Debt over additions, repayments, issuance costs,
//                 commercial paper and other debt movements.
// ---------------------------------------------------------------------------

/**
 * A working-capital constituent is an operating-section input the company
 * reported as one of the movements a broker would net into one line. Detection
 * is semantic only: high-impact cash-flow classification must be declared by
 * the evidence adapter and must never be inferred from a convenient caption.
 */
function isWorkingCapitalConstituent(row) {
  if (
    row.semantic_role &&
    row.semantic_role !== "change_in_working_capital"
  ) return false;
  if (row.semantic_role === "change_in_working_capital") return false;
  if (row.economic_class !== undefined) {
    return row.economic_class === "working_capital";
  }
  if (row.movement_type === "working_capital_movement") return true;
  if (/^working_capital[_.]/.test(String(row.row_id ?? ""))) return true;
  const classification = classifyStatementLine({
    label: row.label,
    section: "cash_flow",
  });
  // A declared WC parent supplies the missing context for a caption-level
  // candidate.  Use the taxonomy's strongest candidate only when it is WC;
  // unrelated operating adjustments whose strongest candidate is another
  // class remain outside the narrower group.
  if (
    classification.candidates?.[0]?.role === "change_in_working_capital" &&
    Number(classification.candidates[0].score) >= 0.34
  ) return true;
  return false;
}

/**
 * Move a row into the one legal "captured by parent" forecast state.
 *
 * Several compiler passes used to set only `forecast_treatment`, leaving an
 * earlier `forecast_period_authorities` array behind.  The style pass then saw
 * an uncalculated row while the formula pass saw an explicit zero.  Centralise
 * the transition so no pass can create that split-brain state again.
 */
// The post-anchor profit spine and the cash-flow spine may never be captured
// into a parent: each is the visible authoritative answer other rows consume
// (tax reads PBT, the cash flow reads PAT, the sweep reads CFO). Capturing one
// silently zeroes every consumer while formula/cache parity still passes —
// the shipped dead-PBT defect. Pre-anchor subtotals (gross profit, product
// revenue) remain capturable inside the anchored slim-forecast band.
const CAPTURE_PROTECTED_SPINE_ROLES = new Set([
  "pre_tax_income",
  "tax_expense",
  "net_income",
  "cash_from_operations",
  "cash_from_investing",
  "cash_from_financing",
  "net_change_in_cash",
  "opening_cash",
  "ending_cash",
]);

function markForecastCapturedBy(
  row,
  parentRowId,
  note,
  mode = "semantic_scope",
  modelCase = null,
) {
  if (CAPTURE_PROTECTED_SPINE_ROLES.has(row?.semantic_role)) return false;
  const explicit = row.forecast_period_authorities;
  const hasDirectAuthority =
    row.broker_metric_id ||
    row.forecast_calculation ||
    (row.forecast_period_calculations ?? []).some(Boolean) ||
    (row.values ?? []).slice(3, 6).some(
      (value) => value !== null && value !== undefined && Number.isFinite(Number(value)),
    ) ||
    (Array.isArray(explicit) &&
      explicit.some(
        (authority) =>
          authority &&
          !["not_separately_forecast", "not_applicable", "unresolved"].includes(
            authority.method,
          ),
      ));
  if (hasDirectAuthority) return false;
  const material = modelCase ? forecastRowMateriality(modelCase, row) : null;
  row.forecast_treatment = "uncalculated";
  row.formula_authority = "intentionally_blank";
  row.forecast_capture_parent_id = parentRowId;
  row.forecast_capture_mode = mode;
  row.forecast_capture_note = note;
  // Remove only stale absence declarations. Genuine direct authorities have
  // already returned above and are never deleted.
  delete row.forecast_period_authorities;
  row.forecast_capture_certificates = [0, 1, 2].map((forecastIndex) => ({
    forecast_index: forecastIndex,
    parent_row_id: parentRowId,
    mode,
    material,
    proof:
      mode === "formula_membership"
        ? "Parent formula contains this row exactly once."
        : "The row's forecast scope is represented by the declared parent authority while this child remains intentionally blank.",
  }));
  return true;
}

function clearCompiledForecastOverride(row) {
  delete row.forecast_period_authorities;
  delete row.forecast_capture_parent_id;
  delete row.forecast_capture_mode;
  delete row.forecast_capture_note;
  delete row.forecast_capture_certificates;
  if (row.formula_authority === "intentionally_blank") {
    delete row.formula_authority;
  }
}

/**
 * A reported parent can legitimately combine working capital with unrelated
 * non-cash operating adjustments.  It cannot then be re-labelled and forecast
 * from the narrower broker "change in working capital" metric.  Split the
 * economic scopes before hierarchy suppression runs: the reported broad total
 * becomes a derived total, and the working-capital subset receives its own
 * homogeneous compiler parent later in `consolidateConstituents`.
 */
function splitHeterogeneousWorkingCapitalParents(rows) {
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  for (const parent of rows) {
    if (parent.semantic_role !== "change_in_working_capital") continue;
    const declaredIds = rows
      .filter((row) => row.parent_row_id === parent.row_id)
      .map((row) => row.row_id);
    const childIds = declaredIds.length > 0
      ? declaredIds
      : [...(parent.calculation?.refs ?? [])];
    const children = childIds.map((id) => byId.get(id)).filter(Boolean);
    const workingCapital = children.filter(isWorkingCapitalConstituent);
    const other = children.filter((row) => !isWorkingCapitalConstituent(row));
    if (workingCapital.length === 0 || other.length === 0) continue;

    parent.semantic_role = "operating_adjustments_total";
    parent.row_type = "subtotal";
    parent.historical_authority = "reported_total_reconciled";
    parent.aggregation_authority = "derived_from_children";
    parent.forecast_treatment = "formula";
    parent.style_role = "subsection";
    parent.calculation = { operator: "sum", refs: [...childIds] };
    delete parent.broker_metric_id;
    delete parent.forecast_calculation;
    delete parent.forecast_period_calculations;
    clearCompiledForecastOverride(parent);
    for (const child of children) {
      child.aggregation_role = "contributing_child";
    }
  }
}

/**
 * Apply the declared statement hierarchy before any consolidation dynamics.
 * A reported parent owns the amount; its working children remain visible
 * historical workings and are deliberately uncalculated in forecast years.
 * A derived parent instead keeps contributing children live because its own
 * formula is their authority.  This pass changes presentation metadata only;
 * coverage validates the declaration and refuses malformed hierarchies.
 */
function applyStatementHierarchy(rows) {
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  for (const row of rows) {
    if (!row.parent_row_id) continue;
    const parent = byId.get(row.parent_row_id);
    if (!parent) continue;
    row.indent = Math.max(1, Number(row.indent ?? 0));
    row.outline_level = Math.max(1, Number(row.outline_level ?? 0));
    if (
      parent.aggregation_authority === "reported_parent" &&
      row.aggregation_role === "working_child"
    ) {
      markForecastCapturedBy(
        row,
        parent.row_id,
        `Forecast detail is captured by reported parent ${parent.label}.`,
      );
    }
  }
}

const DEBT_MOVEMENT_TYPES = new Set([
  "debt_issuance",
  "scheduled_amortisation",
  "maturity_repayment",
  "debt_issuance_cost",
  "other_cash_debt_movement",
]);

function isForecastLiveStatementRow(row) {
  return !(
    row.row_type === "uncalculated" ||
    row.forecast_treatment === "uncalculated" ||
    row.formula_authority === "intentionally_blank"
  );
}

/**
 * A change-in-debt constituent is a financing movement that changes gross debt
 * other than the revolver (which is the cash sweep) and leases (which the debt
 * schedule presents separately).
 */
function isDebtMovementConstituent(row) {
  if (row.row_type === "header" || row.row_type === "subtotal") return false;
  return (
    isForecastLiveStatementRow(row) &&
    DEBT_MOVEMENT_TYPES.has(inferMovementType(row))
  );
}

const REVOLVER_MOVEMENT_TYPES = new Set(["rcf_draw", "rcf_repayment"]);

/**
 * The revolver legs are debt movements, not a financing category of their own.
 * Presented as face lines beside Change in Debt they read as a second, parallel
 * debt story; the reviewer asked for one. Fold them INTO Change in Debt: move
 * the rows into the run beneath it, add them to its refs, and re-point whatever
 * total used to carry them at the consolidated line so nothing is double
 * counted. The cash sweep still drives their values — only the presentation
 * moves.
 */
function foldRevolverIntoChangeInDebt(rows, consolidated) {
  const revolver = rows.filter(
    (row) =>
      isForecastLiveStatementRow(row) &&
      REVOLVER_MOVEMENT_TYPES.has(inferMovementType(row)),
  );
  if (revolver.length === 0) return;
  const revolverIds = new Set(revolver.map((row) => row.row_id));
  for (const row of revolver) rows.splice(rows.indexOf(row), 1);
  // Land them after the last constituent the consolidated line already
  // carries, so the run directly beneath it stays contiguous.
  const refs = consolidated.calculation?.refs ?? [];
  const landAfter = refs.reduce(
    (last, ref) =>
      Math.max(
        last,
        rows.findIndex((row) => row.row_id === ref),
      ),
    rows.indexOf(consolidated),
  );
  rows.splice(landAfter + 1, 0, ...revolver);
  consolidated.calculation = {
    ...consolidated.calculation,
    operator: "sum",
    // An adopted issuer parent can already contain the RCF legs. Remove every
    // existing occurrence, then append the physical revolver run once. This
    // makes the fold idempotent without hiding duplicates in unrelated refs.
    refs: [
      ...refs.filter((ref) => !revolverIds.has(ref)),
      ...revolverIds,
    ],
  };
  for (const row of revolver) {
    row.indent = Math.max(1, Number(row.indent ?? 0));
  }
  for (const row of rows) {
    if (row === consolidated) continue;
    const parentRefs = row.calculation?.refs;
    if (
      !Array.isArray(parentRefs) ||
      !parentRefs.some((ref) => revolverIds.has(ref))
    ) {
      continue;
    }
    const rewired = [];
    for (const ref of parentRefs) {
      const next = revolverIds.has(ref) ? consolidated.row_id : ref;
      if (!rewired.includes(next)) rewired.push(next);
    }
    row.calculation = { ...row.calculation, refs: rewired };
  }
}

export function assertUniqueStatementDependencies(rows, section = "statement") {
  for (const row of rows) {
    const rules = [
      ["calculation", row.calculation],
      ["forecast_calculation", row.forecast_calculation],
      ...(row.forecast_period_calculations ?? []).map((rule, index) => [
        `forecast_period_calculations[${index}]`,
        rule,
      ]),
    ];
    for (const [field, rule] of rules) {
      if (!Array.isArray(rule?.refs)) continue;
      const seen = new Set();
      const duplicates = new Set();
      for (const ref of rule.refs) {
        if (seen.has(ref)) duplicates.add(ref);
        seen.add(ref);
      }
      if (duplicates.size > 0) {
        throw new Error(
          `${section} row ${row.row_id} ${field} contains duplicate dependency refs: ${[
            ...duplicates,
          ].join(", ")}.`,
        );
      }
    }
  }
}

/**
 * INDENT EVERY CHILD, not just the ones a case author happened to space in.
 *
 * The level a row reads at is a fact about the arithmetic, so it is derived
 * from the arithmetic rather than carried as a literal in the case file:
 *
 *   level 0  an anchor — a section or subsection HEADING, or a row the model
 *            adds up TO (`style_role: "total"`). Anchors are the spine; they
 *            never move right no matter how deep the sum that names them.
 *   level 1  an ordinary child: a row named in the refs of an anchor.
 *   level 2  a constituent beneath a DECLARED consolidated line — Change in
 *            Working Capital or Change in Debt. Those lines are themselves
 *            ordinary body parents (level 1), so their explicit children land
 *            one further in. Forecast debt children remain live schedule links;
 *            WC children may be blank and grey only when the forecast parent
 *            carries their full economic scope.
 *
 * A ref that is itself an anchor is skipped, so `Adjusted EBITDA = Operating
 * Profit + ...` does not push Operating Profit — a total in its own right —
 * one level in. The case's own `indent` survives as a FLOOR, so a hand-placed
 * ratio row keeps the level its author chose.
 *
 * Levels are consumed as `alignment indent`, never as leading spaces in the
 * label: spaces are invisible to the style layer, impossible to restyle
 * globally, and they corrupt column-width measurement.
 */
function deriveIndentLevels(rows, section) {
  const levels = deriveStatementIndentMap(rows, section);
  for (const row of rows) row.indent = levels.get(row.row_id) ?? 0;
}

/**
 * Leading spaces are not indentation, they are content, and they compound with
 * the real thing. A case that spaced its own labels in gets them stripped here
 * so `deriveIndentLevels` is the only voice on the subject and the row plan,
 * the semantic manifest and the emitted cell all agree on what the label says.
 */
function stripLabelIndentSpaces(rows) {
  for (const row of rows) {
    if (typeof row.label !== "string") continue;
    row.label = row.label
      .replace(/^\s+/, "")
      .replace(/^(?:[\u2022\u00b7\u25aa\u25e6]|[\u2013\u2014-])\s+/u, "");
  }
}

/**
 * Insert — or adopt, where the company already reports one — a consolidated
 * line above a run of constituent rows, and re-point every parent subtotal at
 * the consolidated line so nothing is counted twice.
 */
function consolidateConstituents(rows, spec) {
  const scoped = spec.scope ? rows.filter((row) => spec.scope(row)) : rows;
  // Adopt an explicitly declared parent BEFORE classifier discovery. This is
  // critical for unusual issuer wording: the filing's own parent/refs are
  // stronger evidence than whether every child caption matched a taxonomy.
  let consolidated = rows.find(
    (row) => row.semantic_role === spec.semantic_role,
  ) ?? null;
  const explicitChildIds = consolidated
    ? [
        ...rows
          .filter((row) => row.parent_row_id === consolidated.row_id)
          .map((row) => row.row_id),
        ...(consolidated.calculation?.refs ?? []),
      ]
    : [];
  const explicitChildSet = new Set(explicitChildIds);
  let constituents = explicitChildSet.size > 0
    ? scoped.filter((row) => explicitChildSet.has(row.row_id))
    : scoped.filter((row) => spec.isConstituent(row));
  if (constituents.length === 0) {
    if (consolidated) {
      // Preserve the semantic identity of an issuer-reported aggregate even
      // where its detail is not separately disclosed.  It remains a numbered
      // body line, not a label-only header and not an invented answer.
      consolidated.display_role = "group_parent";
      consolidated.formula_role = consolidated.calculation
        ? "derived_total"
        : "input";
    }
    return consolidated;
  }
  let constituentIdSet = new Set(constituents.map((row) => row.row_id));

  // The company already reports the consolidated line: adopt it rather than
  // adding a second one. Either it declares the role, or it is a sum whose
  // refs are exactly this run of constituents.
  consolidated =
    consolidated ??
    rows.find((row) => {
      const refs = row.calculation?.refs ?? [];
      return (
        !constituentIdSet.has(row.row_id) &&
        row.calculation?.operator === "sum" &&
        refs.length > 0 &&
        refs.every((ref) => constituentIdSet.has(ref))
      );
    }) ??
    null;
  const adoptedIssuerParent = consolidated !== null;

  if (consolidated) {
    consolidated.semantic_role = spec.semantic_role;
    // The reported line is the authority on what it consolidates. Narrowing to
    // its own refs keeps a label heuristic from silently reclassifying a row
    // the company deliberately left outside the consolidation.
    const hierarchyChildren = rows
      .filter((row) => row.parent_row_id === consolidated.row_id)
      .map((row) => row.row_id);
    const declaredRefs = hierarchyChildren.length > 0
      ? hierarchyChildren
      : consolidated.calculation?.refs;
    if (Array.isArray(declaredRefs) && declaredRefs.length > 0) {
      const declared = new Set(declaredRefs);
      constituents = rows.filter((row) => declared.has(row.row_id));
      constituentIdSet = new Set(constituents.map((row) => row.row_id));
    }
  } else {
    const constituentIds = constituents.map((row) => row.row_id);
    const occupiedIds = new Set(rows.map((row) => row.row_id));
    let compiledRowId = spec.row_id;
    let suffix = 1;
    while (occupiedIds.has(compiledRowId)) {
      compiledRowId = `${spec.row_id}_compiled${suffix === 1 ? "" : `_${suffix}`}`;
      suffix += 1;
    }
    consolidated = {
      row_id: compiledRowId,
      label: spec.label,
      row_type: "subtotal",
      calculation: { operator: "sum", refs: [...constituentIds] },
      semantic_role: spec.semantic_role,
      style_role: "subsection",
      ...(spec.extra ?? {}),
    };
    rows.splice(rows.indexOf(constituents[0]), 0, consolidated);
  }

  // Whether adopted from the filing or inserted by the compiler, a
  // consolidated parent is a subtotal because its declared child graph—not a
  // caption-specific headline list—owns its prominence and indentation.
  consolidated.row_type = "subtotal";
  consolidated.display_role = "group_parent";
  consolidated.formula_role = "derived_total";

  // Presentation rank is a compiler decision, not a property inherited from
  // whichever issuer row happened to be adopted. This keeps an adopted Change
  // in Debt visually equivalent to an inserted one and prevents a reported
  // parent from acquiring answer-row fill merely because its source called it
  // a total.
  if (spec.presentation_style_role) {
    consolidated.style_role = spec.presentation_style_role;
  }
  if (
    spec.aggregation_authority &&
    (!adoptedIssuerParent || !consolidated.aggregation_authority)
  ) {
    consolidated.aggregation_authority = spec.aggregation_authority;
  }

  // A consolidated line is the parent of its workings, so present it before
  // them and keep the entire family contiguous.  This is semantic ordering,
  // not a label or row-number exception: an issuer may disclose the total
  // after its constituents, but the standardised model always reads parent
  // first and lets Excel collapse the children beneath it.  Preserve the
  // issuer's relative order both within the child run and for every unrelated
  // row around it.
  const family = new Set([consolidated, ...constituents]);
  const familyIndexes = rows
    .map((row, index) => (family.has(row) ? index : -1))
    .filter((index) => index >= 0);
  if (familyIndexes.length > 0) {
    const insertAt = Math.min(...familyIndexes);
    const orderedChildren = rows.filter((row) => constituents.includes(row));
    const withoutFamily = rows.filter((row) => !family.has(row));
    rows.splice(
      0,
      rows.length,
      ...withoutFamily.slice(0, insertAt),
      consolidated,
      ...orderedChildren,
      ...withoutFamily.slice(insertAt),
    );
  }

  // Constituents stay on the face, one level in from the consolidated line.
  for (const row of constituents) {
    row.indent = Math.max(1, Number(row.indent ?? 0));
    row.display_role = "component";
    if (spec.captureForecastInParent) {
      row.parent_row_id = consolidated.row_id;
      row.aggregation_role =
        consolidated.aggregation_authority === "reported_parent"
          ? "working_child"
          : "contributing_child";
      markForecastCapturedBy(
        row,
        consolidated.row_id,
        `Forecast detail is captured by ${consolidated.label}.`,
      );
    }
  }

  // Any other total that summed the constituents directly now sums the
  // consolidated line instead.
  for (const row of rows) {
    if (row === consolidated) continue;
    const refs = row.calculation?.refs;
    if (!Array.isArray(refs) || !refs.some((ref) => constituentIdSet.has(ref))) {
      continue;
    }
    const rewired = [];
    for (const ref of refs) {
      const next = constituentIdSet.has(ref) ? consolidated.row_id : ref;
      if (!rewired.includes(next)) rewired.push(next);
    }
    row.calculation = { ...row.calculation, refs: rewired };
  }
  return consolidated;
}

function sourceOwnedRowIds(modelCase, section) {
  return new Set(
    (modelCase.source_coverage?.[section] ?? []).flatMap(
      (source) => source.mapped_row_ids ?? [],
    ),
  );
}

function statementRules(row) {
  return [
    row.calculation,
    row.forecast_calculation,
    ...(row.forecast_period_calculations ?? []),
  ].filter(Boolean);
}

/**
 * Remove a compiler-only pass-through row when it carries no economic fact of
 * its own. Two source-owned rows remain evidence and therefore block as an
 * ambiguity; an unsourced one-reference alias can be substituted by its target
 * without changing history, forecast mechanics or meaning.
 *
 * This closes the generic failure that left a second EBIT, PBT or cash-flow
 * root on the face merely because a reconciliation block happened to contain
 * it. The rule has no metric names, issuer captions or physical row numbers.
 */
function collapseRedundantStatementAliases(modelCase, section, rows) {
  const sourceOwned = sourceOwnedRowIds(modelCase, section);
  const isSourceOwned = (row) =>
    sourceOwned.has(row.row_id) ||
    (Array.isArray(row.source_line_ids) && row.source_line_ids.length > 0);
  const history = (row) => (row.values ?? []).slice(0, 3);
  const sameHistory = (left, right) => {
    const leftHistory = history(left);
    if (!leftHistory.some((value) => Number.isFinite(Number(value)))) return true;
    const rightHistory = history(right);
    return leftHistory.every((value, index) => {
      if (!Number.isFinite(Number(value))) return true;
      return (
        Number.isFinite(Number(rightHistory[index])) &&
        Math.abs(Number(value) - Number(rightHistory[index])) <= 1e-9
      );
    });
  };
  const replaceReference = (fromId, toId) => {
    for (const row of rows) {
      for (const rule of statementRules(row)) {
        if (!Array.isArray(rule.refs)) continue;
        rule.refs = rule.refs.map((ref) => (ref === fromId ? toId : ref));
      }
      if (row.parent_row_id === fromId) row.parent_row_id = toId;
      if (row.forecast_capture_parent_id === fromId) {
        row.forecast_capture_parent_id = toId;
      }
    }
  };

  let changed = true;
  while (changed) {
    changed = false;
    const byId = new Map(rows.map((row) => [row.row_id, row]));
    for (const row of rows) {
      if (
        row.row_type === "header" ||
        isSourceOwned(row) ||
        rows.some((candidate) => candidate.parent_row_id === row.row_id)
      ) {
        continue;
      }
      const link = row.calculation;
      if (link?.operator !== "link" || link.refs?.length !== 1) continue;
      const target = byId.get(link.refs[0]);
      if (!target || target === row || !sameHistory(row, target)) continue;
      if (
        row.semantic_role &&
        target.semantic_role &&
        row.semantic_role !== target.semantic_role
      ) {
        continue;
      }
      const forecastRules = [
        row.forecast_calculation,
        ...(row.forecast_period_calculations ?? []),
      ].filter(Boolean);
      if (
        forecastRules.some(
          (rule) =>
            rule.operator !== "link" ||
            rule.refs?.length !== 1 ||
            rule.refs[0] !== target.row_id,
        ) ||
        row.broker_metric_id ||
        ["broker", "hardcode", "zero"].includes(row.forecast_treatment)
      ) {
        continue;
      }
      replaceReference(row.row_id, target.row_id);
      rows.splice(rows.indexOf(row), 1);
      changed = true;
      break;
    }
  }
}

/**
 * One visible EBIT. When the issuer's operating profit and the compiled EBIT
 * row are the same number in every filed period, they are one economic
 * answer wearing two labels, and the statement may not print it twice. The
 * operating-profit row (the issuer's own caption) survives; every reference
 * to the EBIT row is retargeted onto it. Rows whose histories genuinely
 * differ — non-trading items between the two — are both kept.
 */
function collapseEquivalentEbitOperatingProfit(rows) {
  const operatingProfit = rows.find(
    (row) => row.semantic_role === "operating_profit",
  );
  const ebit = rows.find((row) => row.semantic_role === "ebit");
  if (!operatingProfit || !ebit || operatingProfit === ebit) return;
  const historyOf = (row) =>
    (row.values ?? []).slice(0, 3).map((value) => Number(value));
  const left = historyOf(operatingProfit);
  const right = historyOf(ebit);
  const identical =
    left.length === 3 &&
    left.every(
      (value, index) =>
        Number.isFinite(value) &&
        Number.isFinite(right[index]) &&
        Math.abs(value - right[index]) <= 1e-9,
    );
  if (!identical) return;
  for (const row of rows) {
    for (const rule of statementRules(row)) {
      if (!Array.isArray(rule.refs)) continue;
      rule.refs = rule.refs.map((ref) =>
        ref === ebit.row_id ? operatingProfit.row_id : ref,
      );
    }
    if (row.parent_row_id === ebit.row_id) {
      row.parent_row_id = operatingProfit.row_id;
    }
    if (row.forecast_capture_parent_id === ebit.row_id) {
      row.forecast_capture_parent_id = operatingProfit.row_id;
    }
  }
  // Retargeting can turn the survivor's own link-to-EBIT into a link to
  // itself; where that happens the survivor adopts the collapsed row's rule
  // for the same named slot, so the one visible answer keeps a real
  // calculation instead of a self-reference.
  const selfLink = (rule) =>
    rule?.operator === "link" &&
    rule.refs?.length === 1 &&
    rule.refs[0] === operatingProfit.row_id;
  const adopt = (rule, replacement) => {
    if (!replacement || replacement === rule) return;
    rule.operator = replacement.operator;
    rule.refs = [...(replacement.refs ?? [])];
  };
  if (selfLink(operatingProfit.calculation)) {
    adopt(operatingProfit.calculation, ebit.calculation);
  }
  if (selfLink(operatingProfit.forecast_calculation)) {
    adopt(
      operatingProfit.forecast_calculation,
      ebit.forecast_calculation ?? ebit.calculation,
    );
  }
  for (const [index, rule] of (
    operatingProfit.forecast_period_calculations ?? []
  ).entries()) {
    if (selfLink(rule)) {
      adopt(
        rule,
        ebit.forecast_period_calculations?.[index] ??
          ebit.forecast_calculation ??
          ebit.calculation,
      );
    }
  }
  // A collapsed row with no rule of its own leaves nothing to adopt; the
  // survivor then simply stops being a formula row — its sourced values
  // already carry the identical history — rather than keeping a self-link.
  if (selfLink(operatingProfit.calculation)) delete operatingProfit.calculation;
  if (selfLink(operatingProfit.forecast_calculation)) {
    delete operatingProfit.forecast_calculation;
  }
  if (Array.isArray(operatingProfit.forecast_period_calculations)) {
    operatingProfit.forecast_period_calculations =
      operatingProfit.forecast_period_calculations.map((rule) =>
        selfLink(rule) ? null : rule,
      );
  }
  // The surviving row owns both identities: solver and emitters that resolve
  // by the ebit role must land on the one visible answer.
  operatingProfit.role_aliases = [
    ...new Set([...(operatingProfit.role_aliases ?? []), "ebit"]),
  ];
  rows.splice(rows.indexOf(ebit), 1);
}

/**
 * A derived row that no formula references and no child declares as parent
 * is display noise: it repeats an answer that already has a visible owner
 * (a profit alias at the top of the cash flow, a manufactured negation twin
 * beside a filed finance line). Removing it changes no total, because
 * nothing consumes it. Source-owned rows, headers, spine roles for the
 * section, and rows carrying their own sourced values are never touched.
 */
function removeOrphanDerivedStatementRows(section, rows) {
  const protectedRoles = new Set(
    section === "cash_flow"
      ? [
          "cash_from_operations",
          "cash_from_investing",
          "cash_from_financing",
          "net_change_in_cash",
          "opening_cash",
          "ending_cash",
          "free_cash_flow",
        ]
      : [
          "revenue",
          "gross_profit",
          "operating_profit",
          "ebit",
          "adjusted_ebitda",
          "pre_tax_income",
          "tax_expense",
          "net_income",
        ],
  );
  let changed = true;
  while (changed) {
    changed = false;
    const referenced = new Set();
    for (const row of rows) {
      for (const rule of statementRules(row)) {
        for (const ref of rule.refs ?? []) referenced.add(ref);
      }
      if (row.parent_row_id) referenced.add(row.parent_row_id);
      if (row.forecast_capture_parent_id) {
        referenced.add(row.forecast_capture_parent_id);
      }
    }
    for (const row of rows) {
      if (row.row_type === "header") continue;
      if (referenced.has(row.row_id)) continue;
      if (protectedRoles.has(row.semantic_role)) continue;
      if (Array.isArray(row.source_line_ids) && row.source_line_ids.length > 0) {
        continue;
      }
      const derived =
        row.calculation &&
        ["link", "sum", "subtract", "negate"].includes(row.calculation.operator);
      if (!derived) continue;
      rows.splice(rows.indexOf(row), 1);
      changed = true;
      break;
    }
  }
}

/**
 * The EBITDA bridge is a reconciliation, not a second income statement. A
 * bare run of EBITDA, margin and D&A sitting mid-statement reads as more
 * P&L; a title bar in front of it declares the block for what it is. Purely
 * presentational: no calculation, no values, no authority.
 */
function badgeAdjustedEbitdaBridge(rows) {
  if (presentationEpoch() < 3) return;
  const ebitda = rows.find((row) => row.semantic_role === "adjusted_ebitda");
  if (!ebitda) return;
  // A bridge title anywhere in the section — the issuer's own or a prior
  // compile's — means the block is already badged; matching by label, not
  // row id, because the existing header may be case-authored.
  const alreadyBadged = rows.some(
    (row) =>
      row.row_type === "header" &&
      /ebitda\s+bridge/i.test(String(row.label ?? "")),
  );
  if (alreadyBadged) return;
  const index = rows.indexOf(ebitda);
  const previous = rows[index - 1];
  if (previous?.row_type === "header") return;
  rows.splice(index, 0, {
    row_id: "adjusted_ebitda_bridge_header",
    label: "Adjusted EBITDA bridge",
    row_type: "header",
    // The bridge can sit below net income; a block header there is exactly
    // the declared necessity the projection gate demands.
    projection_origin: "required_block_header",
  });
}

function cashFlowIncomeRootKind(row) {
  const refs = row.calculation?.operator === "link"
    ? row.calculation.refs ?? []
    : [];
  if (refs.includes("pre_tax_income")) return "pre_tax_income";
  if (refs.includes("net_income")) return "net_income";
  return null;
}

function dependencyClosure(rows, rootId) {
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const closure = new Set();
  const visit = (rowId) => {
    if (closure.has(rowId)) return;
    closure.add(rowId);
    const row = byId.get(rowId);
    for (const ref of row?.calculation?.refs ?? []) {
      if (byId.has(ref)) visit(ref);
    }
  };
  visit(rootId);
  return closure;
}

/**
 * An indirect cash-flow bridge has exactly one visible P&L starting point.
 * A generic scaffold row may coexist with the issuer's sourced PBT or net-
 * income row during evidence mapping; keep the source-owned authority and
 * remove only the unsourced scaffold.  Two source-owned roots are ambiguous
 * and block rather than being guessed.
 */
function selectSingleCashFlowRoot(modelCase, rows) {
  const cfo = rows.find(
    (row) =>
      row.semantic_role === "cash_from_operations" ||
      row.row_id === "cash_from_operations",
  );
  if (!cfo) return;
  const closure = dependencyClosure(rows, cfo.row_id);
  const candidates = rows.filter(
    (row) => closure.has(row.row_id) && cashFlowIncomeRootKind(row),
  );
  if (candidates.length <= 1) return;

  const sourceOwned = sourceOwnedRowIds(modelCase, "cash_flow");
  const sourced = candidates.filter(
    (row) =>
      sourceOwned.has(row.row_id) ||
      (Array.isArray(row.source_line_ids) && row.source_line_ids.length > 0),
  );
  if (sourced.length !== 1) {
    throw new Error(
      `cash_flow has ${candidates.length} visible income roots (${candidates
        .map((row) => `${row.row_id}:${cashFlowIncomeRootKind(row)}`)
        .join(", ")}); declare exactly one source-owned PBT or net-income root.`,
    );
  }

  const selected = sourced[0];
  const rejected = new Set(
    candidates.filter((row) => row !== selected).map((row) => row.row_id),
  );
  for (const row of rows) {
    for (const rule of [
      row.calculation,
      row.forecast_calculation,
      ...(row.forecast_period_calculations ?? []),
    ]) {
      if (!Array.isArray(rule?.refs)) continue;
      rule.refs = rule.refs.filter((ref) => !rejected.has(ref));
    }
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rejected.has(rows[index].row_id)) rows.splice(index, 1);
  }
  selected.cash_flow_root_kind = cashFlowIncomeRootKind(selected);
}

/**
 * The consolidated Change in Debt line must LINK DOWN to the debt schedule, not
 * carry its own hardcode. It does that through its constituents: the compiler
 * drives the `debt_issuance` and `debt_repayment` roles off the instrument
 * issuance and repayment rows in the debt schedule. If the company's own
 * presentation has neither, add them so the linkage is structural rather than
 * incidental.
 */
function ensureDebtScheduleLinkage(rows, consolidated) {
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  let insertAt = rows.indexOf(consolidated) + 1;
  for (const [role, label, movementType] of [
    ["debt_issuance", "Additions to debt", "debt_issuance"],
    ["debt_repayment", "Repayments of debt", "maturity_repayment"],
  ]) {
    const refs = consolidated.calculation?.refs ?? [];
    const linked = refs.some(
      (ref) => byId.get(ref)?.semantic_role === role,
    );
    if (linked || byId.has(role)) continue;
    const row = {
      row_id: role,
      label,
      row_type: "calculation",
      semantic_role: role,
      movement_type: movementType,
      cash_flow_classification: "financing",
      indent: 1,
    };
    rows.splice(insertAt, 0, row);
    byId.set(row.row_id, row);
    insertAt += 1;
    consolidated.calculation = {
      ...consolidated.calculation,
      operator: "sum",
      refs: [...refs, row.row_id],
    };
  }
}

/**
 * Acquisition consideration belongs in the company's OWN "Acquisitions, net of
 * cash acquired" line — a separate overlay row is duplication. Identify that
 * line so the acquisition adjustment columns can land on it.
 */

/**
 * Strip acquisition-overlay rows a case declared for itself. The reviewer
 * called them bloat: the consideration belongs in the company's own
 * acquisitions line and the debt legs belong inside Change in Debt, so the
 * architecture removes them wherever they appear rather than relying on every
 * case being rewritten.
 */
function stripAcquisitionOverlayRows(rows) {
  const overlay = new Set([
    "acquisition_consideration",
    "acquisition_debt_proceeds",
    "acquisition_debt_repayment",
  ]);
  const removed = new Set(
    rows
      .filter(
        (row) =>
          overlay.has(row.semantic_role) || overlay.has(row.movement_type),
      )
      .map((row) => row.row_id),
  );
  if (removed.size === 0) return;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (removed.has(rows[index].row_id)) rows.splice(index, 1);
  }
  for (const row of rows) {
    const refs = row.calculation?.refs;
    if (!Array.isArray(refs) || !refs.some((ref) => removed.has(ref))) continue;
    row.calculation = {
      ...row.calculation,
      refs: refs.filter((ref) => !removed.has(ref)),
    };
  }
}

/**
 * Project the filing's complete income ledger onto the debt-overlay face.
 *
 * The evidence graph retains every filed line.  The visible Operating Model is
 * a different artifact: it needs the issuer's path to consolidated net income
 * plus any later block the debt model actually consumes (normally the EBITDA
 * bridge).  OCI, attribution, EPS and dividend-per-share blocks do not become
 * useful merely because they appeared between those two things in the filing.
 *
 * This projection is semantic and dependency based.  It never names an issuer,
 * caption or physical row.  A post-net-income block survives when it contains a
 * declared debt-overlay role or an income row referenced by the cash-flow graph;
 * the calculation closure then preserves every dependency that makes that block
 * work.  Headers survive only with their surviving block.  The complete source
 * ledger remains in `modelCase.statement_structure` and the evidence artifacts.
 */
function projectIncomeStatementToDebtOverlay(modelCase, rows) {
  const netIncomeIndex = rows.findIndex(
    (row) => row.semantic_role === "net_income",
  );
  if (netIncomeIndex < 0 || netIncomeIndex === rows.length - 1) return;

  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const required = new Set();
  const representedBeforeNet = new Set(
    rows
      .slice(0, netIncomeIndex + 1)
      .map((row) => row.semantic_role)
      .filter(Boolean),
  );
  // Economic outputs are retained only when the issuer's main statement path
  // has not already supplied them. Contributors and aliases are then pulled in
  // strictly through dependency closure; resembling a familiar bridge line is
  // not, by itself, a reason to render a row.
  const requiredOutputRoles = new Set([
    "adjusted_ebitda",
    "depreciation_and_amortisation",
  ]);
  for (const row of rows.slice(netIncomeIndex + 1)) {
    if (
      requiredOutputRoles.has(row.semantic_role) &&
      !representedBeforeNet.has(row.semantic_role)
    ) {
      required.add(row.row_id);
      row.projection_origin = "required_economic_output";
      row.projection_required_by = "debt_overlay_contract";
    }
  }
  for (const row of modelCase.statement_structure?.cash_flow ?? []) {
    for (const rule of [
      row.calculation,
      row.forecast_calculation,
      ...(row.forecast_period_calculations ?? []),
    ]) {
      for (const ref of rule?.refs ?? []) {
        if (byId.has(ref)) {
          required.add(ref);
          const dependency = byId.get(ref);
          dependency.projection_origin ??= "downstream_dependency";
          dependency.projection_required_by ??= row.row_id;
        }
      }
    }
  }

  // Backward dependency closure: if a surviving row is calculated from another
  // income row, that contributor survives too, however unusual its label.
  const queue = [...required];
  while (queue.length > 0) {
    const row = byId.get(queue.pop());
    if (!row) continue;
    for (const rule of [
      row.calculation,
      row.forecast_calculation,
      ...(row.forecast_period_calculations ?? []),
    ]) {
      for (const ref of rule?.refs ?? []) {
        if (!byId.has(ref) || required.has(ref)) continue;
        required.add(ref);
        const dependency = byId.get(ref);
        dependency.projection_origin ??= "dependency_closure";
        dependency.projection_required_by ??= row.row_id;
        queue.push(ref);
      }
    }
  }

  // Keep reviewer-facing ratios or growth rows that are pure dependants of a
  // required post-net bridge answer.  This is a forward display closure, not a
  // license to retain the source block: every reference must already survive,
  // and at least one must be a required post-net node.
  const preNetIds = new Set(
    rows.slice(0, netIncomeIndex + 1).map((row) => row.row_id),
  );
  let addedDisplayDependent = true;
  while (addedDisplayDependent) {
    addedDisplayDependent = false;
    for (const row of rows.slice(netIncomeIndex + 1)) {
      if (required.has(row.row_id)) continue;
      const calculation = row.calculation;
      const refs = calculation?.refs ?? [];
      if (
        !["ratio", "negated_ratio", "growth"].includes(calculation?.operator) ||
        refs.length === 0 ||
        !refs.some((ref) => required.has(ref)) ||
        !refs.every((ref) => required.has(ref) || preNetIds.has(ref))
      ) {
        continue;
      }
      required.add(row.row_id);
      row.projection_origin = "derived_display";
      row.projection_required_by = refs.find((ref) => required.has(ref)) ?? null;
      addedDisplayDependent = true;
    }
  }

  const beforeAndIncludingNetIncome = rows.slice(0, netIncomeIndex + 1);
  const tail = rows.slice(netIncomeIndex + 1);
  const retainedTail = [];
  for (let index = 0; index < tail.length; ) {
    const hasHeader = tail[index].row_type === "header";
    let end = index + 1;
    while (end < tail.length && tail[end].row_type !== "header") end += 1;
    const block = tail.slice(index, end);
    const requiredRows = block.filter((row) => required.has(row.row_id));
    if (requiredRows.length > 0) {
      // A header owns presentation only.  Retaining one required bridge row
      // must not drag every unrelated row in the same source block (OCI,
      // attribution, EPS, dividends) back onto the debt-overlay face.
      if (hasHeader) {
        block[0].projection_origin = "required_block_header";
        block[0].projection_required_by = requiredRows[0].row_id;
        retainedTail.push(block[0]);
      }
      retainedTail.push(...requiredRows);
    }
    index = end;
  }
  rows.splice(
    0,
    rows.length,
    ...beforeAndIncludingNetIncome,
    ...retainedTail,
  );
}

/**
 * Strip a trailing "(residual to …)" note from a label. The row it sits on is
 * about to stop being a residual, and a line that still calls itself the plug
 * would be the most misleading thing on the sheet.
 */
function stripResidualNote(label) {
  return String(label ?? "")
    .replace(
      /\s*\((?=[^()]*\b(?:residual|plug|balancing|balance to)\b)[^()]*\)\s*$/i,
      "",
    )
    .replace(/\s+$/, "");
}

/**
 * APPLY THE BROKER ANCHOR RULE TO THE INCOME STATEMENT.
 *
 * Exactly one of EBIT / Adjusted EBITDA becomes the headline broker input,
 * D&A is the bridge driver, and the other headline becomes a calculation off
 * the EBITDA bridge. The row the case was using to
 * absorb the difference between three unreconciled broker series stops being a
 * plug. Where the derived metric HAS a broker series it is restated below the
 * bridge as a memo, with its variance against the derived line on the row
 * under it, so the disagreement is on the face of the model instead of buried
 * inside the bridge.
 *
 * Everything is resolved from the case — broker pack, semantic roles, the
 * EBITDA subtotal's own refs. No row numbers, no issuer-specific labels. The
 * lower-coverage broker series remains visible on the Brokers sheet, not as
 * model metadata on the face of the operating model.
 */
function applyBrokerAnchorRule(modelCase, rows) {
  // Row planning is also used by intake diagnostics and question planning.
  // It must therefore be inspectable even when the declared broker authority
  // is incomplete. The production coverage gate below is what fails closed;
  // this compiler pass applies only a fully resolved decision.
  const plan = resolveAnchorPlanDecision(modelCase, rows);
  if (plan.status !== "applied") return null;
  const { selection, bridge, residualPlugRowIds } = plan;
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const canonicalEbitRow =
    rows.find((row) => row.semantic_role === "ebit") ?? bridge.ebitRow;
  const rowForMetric = {
    ebit: canonicalEbitRow,
    adjusted_ebitda: bridge.ebitdaRow,
    depreciation_and_amortisation: bridge.daRow,
  };

  // 1. THE HEADLINE ANCHOR AND D&A DRIVER ARE BROKER INPUTS, and say so.
  //    EBIT and Adjusted EBITDA are never both inputs. Setting the metric id here
  //    rather than trusting the case is what makes the rule general: a case
  //    that only ever mapped one of the three to its pack still anchors on two.
  for (const metricId of selection.anchors) {
    const row = rowForMetric[metricId];
    clearCompiledForecastOverride(row);
    row.forecast_treatment = "broker";
    row.broker_metric_id = metricId;
    delete row.forecast_calculation;
    delete row.forecast_period_calculations;
  }

  // 2. THE OTHER HEADLINE IS DERIVED — a calculation, in black, off the
  //    bridge. EBITDA is the bridge subtotal; EBIT is the bridge rearranged,
  //    "Adjusted EBITDA less D&A and every disclosed addback".
  const derivedMetricRow = rowForMetric[selection.derived];
  clearCompiledForecastOverride(derivedMetricRow);
  delete derivedMetricRow.broker_metric_id;
  derivedMetricRow.forecast_treatment = "formula";
  if (selection.derived === "adjusted_ebitda") {
    delete derivedMetricRow.forecast_calculation;
    delete derivedMetricRow.forecast_period_calculations;
  } else {
    // The statement EBIT row is the canonical economic authority. Solve it
    // directly from the selected broker EBITDA anchor and D&A; any repeated
    // bridge presentation links back to that statement answer. The reverse
    // path (statement -> bridge -> EBITDA) was arithmetically sound but made a
    // reader follow the model in a circle to understand one number.
    derivedMetricRow.forecast_calculation = {
      operator: "subtract",
      refs: [
        bridge.ebitdaRow.row_id,
        ...bridge.ebitdaRow.calculation.refs.filter(
          (ref) => ref !== bridge.ebitTerm,
        ),
      ],
    };
    delete derivedMetricRow.forecast_period_calculations;
    const bridgeTerm = byId.get(bridge.ebitTerm);
    if (bridgeTerm && bridgeTerm.row_id !== derivedMetricRow.row_id) {
      clearCompiledForecastOverride(bridgeTerm);
      delete bridgeTerm.broker_metric_id;
      bridgeTerm.forecast_treatment = "formula";
      bridgeTerm.forecast_calculation = {
        operator: "link",
        refs: [derivedMetricRow.row_id],
      };
      delete bridgeTerm.forecast_period_calculations;
    }
  }

  // A filing can repeat EBIT in the statement and again in the EBITDA bridge.
  // There is one economic answer: the earliest visible EBIT row. Every later
  // presentation links to it, regardless of which headline broker series won.
  for (const repeatedEbit of rows.filter(
    (row) =>
      row.semantic_role === "ebit" && row.row_id !== canonicalEbitRow.row_id,
  )) {
    clearCompiledForecastOverride(repeatedEbit);
    delete repeatedEbit.broker_metric_id;
    repeatedEbit.forecast_treatment = "formula";
    repeatedEbit.forecast_calculation = {
      operator: "link",
      refs: [canonicalEbitRow.row_id],
    };
    delete repeatedEbit.forecast_period_calculations;
  }

  // 3. THE PLUG GOES BACK TO BEING AN INPUT. The row keeps its history and its
  //    declared forecast — on the Smurfit reference those are the source
  //    workbook's own 13 / 0 / 0 — it simply stops absorbing the broker
  //    disagreement, which now has nowhere to hide.
  for (const rowId of residualPlugRowIds) {
    const row = rows.find((item) => item.row_id === rowId);
    if (!row) continue;
    delete row.forecast_calculation;
    delete row.forecast_period_calculations;
    row.forecast_treatment = "hardcode";
    row.label = stripResidualNote(row.label);
  }

  // 4. SAY WHICH COMBINATION IS LIVE — OFF THE FACE OF THE MODEL.
  //
  //    This used to be a visible row reading "Broker anchor: EBIT (7 brokers) +
  //    Adj. EBITDA (7 brokers) — D&A derived, broker D&A (5 brokers) shown as
  //    memo". Every word of that is true and none of it is about the company:
  //    it explains how the forecast was assembled, in a section otherwise made
  //    entirely of the issuer's own P&L. A reader scanning the income statement
  //    met a sentence about broker counts between Adjusted EBITDA and its
  //    margin.
  //
  //    It is not deleted, because a reader who asks "why is D&A a formula?"
  //    needs exactly this answer. It moves to a CELL COMMENT on the Adjusted
  //    EBITDA label — the row the anchoring is about — where it is one hover
  //    away and never in the way. The label is carried on the row definition so
  //    the emitter attaches it without re-deriving the selection.
  bridge.ebitdaRow.anchor_note = selection.label;

  return selection;
}

/**
 * Keep the issuer's full filed P&L in history, but do not manufacture forecast
 * detail between the key Revenue and EBIT answers when a supported headline
 * anchor already supplies the operating result. Revenue components and
 * intermediate operating lines become intentionally blank forecast workings;
 * the total Revenue line, its growth calculation and the EBIT/EBITDA identity
 * remain live. Cases without a resolvable anchor retain their authored detail.
 */
function applyAnchoredSlimForecast(modelCase, rows, anchorSelection) {
  if (!anchorSelection) return;
  const revenueIndex = rows.findIndex((row) => row.semantic_role === "revenue");
  const ebitIndex = rows.findIndex((row) => row.semantic_role === "ebit");
  if (revenueIndex < 0 || ebitIndex < 0 || revenueIndex >= ebitIndex) return;
  const revenueId = rows[revenueIndex].row_id;
  const ebitId = rows[ebitIndex].row_id;
  const keepLive = new Set([revenueId, ebitId]);
  for (const row of rows) {
    if (
      [
        "ebit",
        "adjusted_ebitda",
        "depreciation_and_amortisation",
        "recurring_disclosed_adjustments",
      ].includes(row.semantic_role)
    ) {
      keepLive.add(row.row_id);
    }
  }
  // Preserve the complete dependency closure of the selected headline
  // identity even when an issuer lays its EBITDA bridge above statement EBIT.
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  // Walk the FORECAST graph, not the historical calculation graph. Revenue's
  // filed component sum is historical evidence; traversing it here kept every
  // product/geography line live in forecast and defeated the slim overlay.
  const queue = [...keepLive].filter((rowId) => rowId !== revenueId);
  while (queue.length > 0) {
    const row = byId.get(queue.pop());
    const periodRules = (row?.forecast_period_calculations ?? []).filter(Boolean);
    const forecastRules = periodRules.length > 0
      ? periodRules
      : row?.forecast_calculation
        ? [row.forecast_calculation]
        : row?.forecast_treatment === "formula"
          ? [row.calculation]
          : [];
    for (const ref of forecastRules.flatMap((rule) => rule?.refs ?? [])) {
      if (!byId.has(ref) || keepLive.has(ref)) continue;
      keepLive.add(ref);
      queue.push(ref);
    }
  }
  for (const row of rows) {
    if (
      row.semantic_role === "revenue_growth" ||
      (row.calculation?.operator === "growth" &&
        row.calculation.refs?.includes(revenueId))
    ) {
      keepLive.add(row.row_id);
    }
  }
  // Keep every pure derived output whose complete dependency set is already
  // live.  This is a graph-closure rule, not a caption list: margins, growth
  // rates and other ratios remain calculated when their inputs survive the
  // slim forecast, while detailed operating workings whose inputs were
  // intentionally suppressed remain blank.  It also prevents a ratio from
  // being nonsensically described as "captured by EBIT".
  let addedDerivedRow = true;
  while (addedDerivedRow) {
    addedDerivedRow = false;
    for (const row of rows) {
      if (keepLive.has(row.row_id) || row.row_type === "header") continue;
      const rules = (row.forecast_period_calculations ?? []).filter(Boolean);
      const rule = rules.length > 0
        ? rules[0]
        : row.forecast_calculation ?? row.calculation;
      const refs = rule?.refs ?? [];
      if (
        row.row_type === "calculation" &&
        refs.length > 0 &&
        refs.every((ref) => keepLive.has(ref))
      ) {
        keepLive.add(row.row_id);
        addedDerivedRow = true;
      }
    }
  }
  for (let index = 0; index < ebitIndex; index += 1) {
    const row = rows[index];
    if (row.row_type === "header" || keepLive.has(row.row_id)) continue;
    const parentId = index < revenueIndex ? revenueId : ebitId;
    const parent = byId.get(parentId);
    markForecastCapturedBy(
      row,
      parentId,
      `Forecast detail is captured by ${parent?.label ?? parentId}.`,
      "semantic_scope",
      modelCase,
    );
  }
}

function removeRedundantDuplicateHeaders(rows) {
  const normalise = (value) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  for (let index = rows.length - 2; index >= 0; index -= 1) {
    const header = rows[index];
    if (header.row_type !== "header") continue;
    const next = rows[index + 1];
    if (next?.row_type === "header") continue;
    if (normalise(header.label) === normalise(next?.label)) {
      rows.splice(index, 1);
    }
  }
}

/**
 * Final non-destructive forecast fallback.  It runs only after broker,
 * schedule, accounting-identity and declared capture decisions have been made.
 * A reported line with no stronger path remains visible and formula-driven:
 * zero stays zero; otherwise the last reported value carries forward.  This is
 * the last rung of the waterfall, never a replacement for guidance or broker
 * evidence, and it avoids both unexplained blue hardcodes and grey material
 * rows.
 */
function applyDefaultForecastWaterfall(modelCase, rows) {
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  for (const row of rows) {
    if (
      row.row_type === "header" ||
      row.operation_scope === "not_applicable" ||
      isScheduleOwnedForecastRole(row.semantic_role) ||
      row.forecast_capture_parent_id ||
      row.broker_metric_id ||
      row.forecast_calculation ||
      (row.forecast_period_calculations ?? []).some(Boolean) ||
      (row.forecast_period_authorities ?? []).some(
        (authority) =>
          authority &&
          !["not_separately_forecast", "not_applicable", "unresolved"].includes(
            authority.method,
          ),
      ) ||
      (row.values ?? []).slice(3, 6).some(
        (value) => value !== null && value !== undefined && Number.isFinite(Number(value)),
      )
    ) continue;
    const parent = row.parent_row_id ? byId.get(row.parent_row_id) : null;
    if (parent?.broker_metric_id || parent?.forecast_calculation) continue;
    const history = (row.values ?? []).slice(0, 3).map((value) =>
      value === null || value === undefined || !Number.isFinite(Number(value))
        ? null
        : Number(value),
    );
    if (!history.some((value) => value !== null)) continue;
    const last = history[2] ?? history[1] ?? history[0];
    clearCompiledForecastOverride(row);
    if (Math.abs(Number(last ?? 0)) <= 1e-12) {
      row.forecast_treatment = "zero";
      row.values = [...history, 0, 0, 0];
      row.forecast_decision = {
        method: "explicit_zero",
        reason: "Latest reported value is zero and no stronger forecast evidence exists.",
      };
    } else {
      row.forecast_treatment = "formula";
      row.forecast_calculation = {
        operator: "prior_period",
        refs: [row.row_id],
      };
      row.forecast_decision = {
        method: "carry_forward",
        reason: "Last-resort formula carry from the latest reported value.",
      };
    }
  }
}

function captureChildrenOfDirectForecastParents(modelCase, rows) {
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const accountingIdentityParents = new Set([
    "gross_profit",
    "operating_profit",
    "ebit",
    "adjusted_ebitda",
    "pre_tax_income",
    "tax_expense",
    "net_income",
    "cash_from_operations",
    "cash_from_investing",
    "cash_from_financing",
    "net_change_in_cash",
    "ending_cash",
  ]);
  for (const parent of rows) {
    // Change in Debt is the visible sum of four live schedule producers:
    // issuance, mandatory repayment, RCF draw and RCF repayment.  Capturing
    // those children in the parent would grey the very audit trail the row is
    // meant to expose and would make the financing statement bypass its own
    // components.
    if (parent.semantic_role === "change_in_debt") continue;
    const refs = parent.calculation?.refs ?? [];
    const hasDirectForecast =
      parent.broker_metric_id ||
      parent.forecast_calculation ||
      (parent.forecast_period_calculations ?? []).some(Boolean) ||
      (parent.forecast_period_authorities ?? []).some(
        (authority) =>
          authority &&
          !["not_separately_forecast", "not_applicable", "unresolved"].includes(
            authority.method,
          ),
      );
    const aggregationParent =
      !accountingIdentityParents.has(parent.semantic_role) &&
      (hasDirectForecast ||
        parent.forecast_capture_mode === "formula_membership");
    if (
      parent.calculation?.operator !== "sum" ||
      refs.length === 0 ||
      !aggregationParent
    ) continue;
    for (const childId of refs) {
      const child = byId.get(childId);
      if (!child || child === parent) continue;
      const presentAsGroup =
        parent.style_role === "subsection" ||
        ["change_in_working_capital", "capex", "change_in_debt"].includes(
          parent.semantic_role,
        );
      if (presentAsGroup) {
        child.parent_row_id ??= parent.row_id;
        child.aggregation_role ??= "contributing_child";
      }
      markForecastCapturedBy(
        child,
        parent.row_id,
        `Forecast detail is captured by directly forecast parent ${parent.label}.`,
        "semantic_scope",
        modelCase,
      );
    }
  }
}

function assignDisplayAndFormulaRoles(rows) {
  const referencedAsChild = new Set(
    rows.flatMap((row) => row.calculation?.refs ?? []),
  );
  for (const row of rows) {
    if (row.row_type === "header") {
      row.display_role = "header";
      row.formula_role = "presentation";
      continue;
    }
    const hasDeclaredChildren = rows.some(
      (candidate) =>
        candidate.parent_row_id === row.row_id ||
        candidate.presentation_parent_id === row.row_id,
    );
    row.formula_role = row.formula_authority === "intentionally_blank"
      ? "uncalculated"
      : row.calculation || row.forecast_calculation
        ? "derived"
        : "input";
    if (row.display_role === "group_parent" || hasDeclaredChildren) {
      row.display_role =
        row.style_role === "total" && !referencedAsChild.has(row.row_id)
          ? "answer"
          : "group_parent";
    } else if (row.style_role === "total") {
      row.display_role = "answer";
    } else {
      row.display_role = "component";
    }
  }
}

export function normaliseStatementRows(modelCase, section) {
  const supplied = modelCase.statement_structure?.[section];
  const rows =
    Array.isArray(supplied) && supplied.length > 0
      ? cloneRows(supplied)
      : cloneRows(
    section === "income_statement" ? DEFAULT_INCOME_ROWS : DEFAULT_CASH_FLOW_ROWS,
      );
  resetCompiledPresentationMetadata(rows);
  repairStatementSourceOrder(modelCase, section, rows);
  splitHeterogeneousWorkingCapitalParents(rows);
  applyStatementHierarchy(rows);
  // Older mapped cases may preserve a source label but carry no semantic role.
  // Adopt only the classifier's high-confidence cash-interest roles here; an
  // ambiguous finance label remains unassigned and is handled by the normal
  // coverage/question flow.  This is taxonomy-driven and therefore works for
  // any issuer wording the accepted alias set covers without a case exception.
  if (section === "cash_flow") {
    for (const row of rows) {
      if (row.semantic_role || row.row_type === "header") continue;
      const classification = classifyStatementLine({
        label: row.label,
        section,
      });
      if (
        classification.status === "accepted" &&
        [
          "cash_interest_paid",
          "cash_interest_received",
          "net_finance_addback",
          "cash_taxes",
        ].includes(
          classification.classified_role,
        )
      ) {
        row.semantic_role = classification.classified_role;
      }
    }
  }
  if (section === "income_statement") {
    collapseRedundantStatementAliases(modelCase, section, rows);
    projectIncomeStatementToDebtOverlay(modelCase, rows);
    const anchorSelection = applyBrokerAnchorRule(modelCase, rows);
    applyAnchoredSlimForecast(modelCase, rows, anchorSelection);
  }
  if (section === "cash_flow") {
    selectSingleCashFlowRoot(modelCase, rows);
    stripAcquisitionOverlayRows(rows);
    // Explicit cash-bucket cases distinguish the one balancing liquidity
    // bucket from reported cash that is not available to the sweep.  The
    // latter still moves reported opening-to-ending cash, so expose that
    // movement as its own formula-driven reconciliation row.  Positive means
    // the non-balancing buckets increased; negative means they decreased.
    // It is deliberately a cash-reconciliation movement, not a sweep input.
    const nonBalancingBuckets = (modelCase.cash_policy?.buckets ?? []).filter(
      (bucket) =>
        bucket.forecast_treatment !== "balancing" &&
        bucket.included_in_cash_flow_cash !== false,
    );
    if (
      nonBalancingBuckets.length > 0 &&
      !rows.some((row) => row.row_id === "non_balancing_cash_bucket_movement")
    ) {
      const netChangeIndex = rows.findIndex(
        (row) => row.row_id === "net_change_in_cash",
      );
      const openingCashIndex = rows.findIndex(
        (row) => row.row_id === "opening_cash",
      );
      const insertAt =
        netChangeIndex >= 0
          ? netChangeIndex
          : openingCashIndex >= 0
            ? openingCashIndex
            : rows.length;
      rows.splice(insertAt, 0, {
        row_id: "non_balancing_cash_bucket_movement",
        label: "Movement in non-balancing cash buckets",
        row_type: "calculation",
        semantic_role: "non_balancing_cash_bucket_movement",
        style_role: "subsection",
      });
      const netChange = rows.find((row) => row.row_id === "net_change_in_cash");
      if (
        Array.isArray(netChange?.calculation?.refs) &&
        !netChange.calculation.refs.includes(
          "non_balancing_cash_bucket_movement",
        )
      ) {
        netChange.calculation.refs.push(
          "non_balancing_cash_bucket_movement",
        );
      }
    }
    // Never manufacture a non-cash-interest line on the issuer's cash-flow
    // statement.  P&L interest versus cash interest reconciles inside the
    // interest schedule.  A cash-flow add-back remains visible only when it is
    // present in the issuer-supplied statement graph, where its original label,
    // provenance and position are preserved.

    // DYNAMIC 1 — Change in Working Capital. Scoped to the operating section so
    // a label heuristic cannot reach into investing or financing.
    const operatingSubtotal = rows.findIndex(
      (row) =>
        row.semantic_role === "cash_from_operations" ||
        row.row_id === "cash_from_operations",
    );
    consolidateConstituents(rows, {
      row_id: "change_in_working_capital",
      label: "Change in Working Capital",
      semantic_role: "change_in_working_capital",
      isConstituent: isWorkingCapitalConstituent,
      scope: (row) =>
        operatingSubtotal < 0 || rows.indexOf(row) < operatingSubtotal,
      extra: {
        broker_metric_id: "change_in_working_capital",
        forecast_treatment: "broker",
        aggregation_authority: "derived_from_children",
      },
      presentation_style_role: "subsection",
      aggregation_authority: "derived_from_children",
      captureForecastInParent: true,
    });

    // DYNAMIC 2 — Change in Debt. Same shape: additions, repayments, issuance
    // costs, commercial paper and other debt movements stay on the face; the
    // consolidated line sums them and links down to the debt schedule.
    const changeInDebt = consolidateConstituents(rows, {
      row_id: "change_in_debt",
      label: "Change in Debt",
      semantic_role: "change_in_debt",
      isConstituent: isDebtMovementConstituent,
      presentation_style_role: "subsection",
    });
    if (changeInDebt) {
      ensureDebtScheduleLinkage(rows, changeInDebt);
      // The revolver legs join the run.  Every child remains a visible
      // schedule-linked producer and the parent sums the children; the old
      // parent-bypass made the forecast impossible to audit line by line.
      foldRevolverIntoChangeInDebt(rows, changeInDebt);
    }
  }
  // The acquisition case is a debt-overlay balance-sheet module. It never
  // injects, stamps or fabricates cash-flow rows; issuer-reported acquisition
  // lines remain only when the issuer's own statement contains them.
  // Last, so it sees the final row order. The presentation-tree compiler is
  // the single writer for parentage, indentation and outline levels.
  removeRedundantDuplicateHeaders(rows);
  if (section === "income_statement") {
    collapseEquivalentEbitOperatingProfit(rows);
  }
  removeOrphanDerivedStatementRows(section, rows);
  if (section === "income_statement") {
    badgeAdjustedEbitdaBridge(rows);
  }
  captureChildrenOfDirectForecastParents(modelCase, rows);
  applyDefaultForecastWaterfall(modelCase, rows);
  materializeStatementPresentationTree(rows, section);
  assignDisplayAndFormulaRoles(rows);
  // Later still, so every row the consolidation dynamics added or re-pointed is
  // levelled off the FINAL ref graph, and no label is left carrying its indent
  // as content.
  deriveIndentLevels(rows, section);
  stripLabelIndentSpaces(rows);
  assertUniqueStatementDependencies(rows, section);
  return rows;
}

/**
 * The semantic roles the cash-flow section will actually carry once the
 * consolidation dynamics have run. A company that reports only the constituents
 * still ends up with a consolidated working-capital and change-in-debt line, so
 * coverage gates must ask the compiler, not the raw case.
 */
export function compiledCashFlowRoles(modelCase) {
  return new Set(
    normaliseStatementRows(modelCase, "cash_flow")
      .map((row) => row.semantic_role)
      .filter(Boolean),
  );
}

function allocateRows(rows, startRow, rowsById, section) {
  let row = startRow;
  const allocated = [];
  for (const definition of rows) {
    if (!definition.row_id) {
      throw new Error("Every statement row needs a stable row_id.");
    }
    if (rowsById[definition.row_id]) {
      throw new Error(`Duplicate semantic row_id: ${definition.row_id}.`);
    }
    const item = {
      ...definition,
      ...describeStatementRow(definition, section),
      row,
    };
    rowsById[item.row_id] = row;
    allocated.push(item);
    row += 1;
  }
  return { rows: allocated, nextRow: row };
}

function semanticSlug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
}

// CRH groups the debt register by INSTRUMENT KIND, never by currency:
// Bonds -> Bank Debt -> Other Debt, each closed by a "Total ..." subtotal.
// `display_group` in the case files splits USD/EUR notes apart, so it is
// deliberately ignored here; an explicit `debt_group` override still wins.
const CRH_DEBT_GROUPS = [
  { key: "bonds", label: "Bonds" },
  { key: "bank_debt", label: "Bank Debt" },
  { key: "other_debt", label: "Other Debt" },
];

export function crhDebtGroupKey(instrument) {
  const explicit = String(instrument?.debt_group ?? "").trim().toLowerCase();
  const token = explicit || String(instrument?.class ?? "").toLowerCase();
  if (!token) return "other_debt";
  if (
    token.includes("bond") ||
    token.includes("note") ||
    token.includes("debenture")
  ) {
    return "bonds";
  }
  if (
    token.includes("loan") ||
    token.includes("bank") ||
    token.includes("term") ||
    token.includes("overdraft") ||
    token.includes("securiti")
  ) {
    return "bank_debt";
  }
  return "other_debt";
}

export function crhDebtGroupLabel(instrument) {
  const key = crhDebtGroupKey(instrument);
  return (
    CRH_DEBT_GROUPS.find((group) => group.key === key)?.label ?? "Other Debt"
  );
}

/**
 * Does the period-end rate for this currency actually move across the forecast?
 * The three forecast entries are indices 3..5 of the curve. If they are equal
 * the translation is a constant: every balance formula would multiply and then
 * divide by the same number, so no balance can move because of FX and a visible
 * rate row would be three copies of one figure.
 */
export function forecastFxRateMoves(modelCase, currency) {
  const rates = modelCase?.fx?.[currency]?.period_end_rates;
  if (!Array.isArray(rates)) return false;
  const forecast = rates.slice(3, 6).map(Number);
  if (forecast.length === 0 || forecast.some((rate) => !(rate > 0))) return false;
  return forecast.some((rate) => Math.abs(rate - forecast[0]) > 1e-12);
}

/**
 * Does the period-end rate for this currency move anywhere the DEBT SCHEDULE
 * can see it? That window is wider than `forecastFxRateMoves`: the schedule
 * opens on the LAST ACTUAL period end (index 2) and closes on the third
 * forecast period end (index 5). A curve that is flat across 3..5 but steps
 * between the actual and the first forecast — Smurfit's EUR/USD 1.175 -> 1.15
 * is exactly that — still retranslates the whole native-currency book in FY1.
 * That retranslation is real, it is NOT cash, and it is the movement the
 * cash-vs-translation split has to isolate.
 */
export function debtFxTranslationMoves(modelCase, currency) {
  const rates = modelCase?.fx?.[currency]?.period_end_rates;
  if (!Array.isArray(rates)) return false;
  const window = rates.slice(2, 6).map(Number);
  if (window.length < 2 || window.some((rate) => !(rate > 0))) return false;
  return window.some((rate) => Math.abs(rate - window[0]) > 1e-12);
}

/**
 * Is there any instrument whose translated balance can move without cash
 * moving? A foreign RCF is solved in its facility currency, while its cash
 * draw/repayment translates at average FX and its closing balance translates
 * at period-end FX. It therefore earns the same visible non-cash FX line when
 * either the period-end rate moves or average and period-end rates differ.
 */
export function hasDebtFxTranslation(modelCase) {
  const reporting = modelCase?.issuer?.reporting_currency;
  return (modelCase?.instruments ?? []).some(
    (instrument) => {
      const currency = instrument.currency;
      if (!currency || currency === reporting) return false;
      if (!isBalancingRcf(modelCase, instrument)) {
        return debtFxTranslationMoves(modelCase, currency);
      }
      const pair = modelCase?.fx?.[currency];
      const periodEnd = pair?.period_end_rates?.slice(2, 6).map(Number);
      const average = pair?.average_rates?.slice(3, 6).map(Number);
      if (
        periodEnd?.length !== 4 ||
        average?.length !== 3 ||
        [...periodEnd, ...average].some((rate) => !(rate > 0))
      ) {
        return false;
      }
      return (
        periodEnd.slice(1).some(
          (rate, index) => Math.abs(rate - periodEnd[index]) > 1e-12,
        ) ||
        average.some(
          (rate, index) => Math.abs(rate - periodEnd[index + 1]) > 1e-12,
        )
      );
    },
  );
}

/**
 * The bridge from the model's standardised net debt to the issuer's own
 * reported figure, as a list of NAMED reconciling items.
 *
 * Each component is a thing the company does that the model does not: an
 * unamortised fair-value adjustment, a debt derivative, a class of lease the
 * issuer leaves out. Naming each one is the whole point — a single anonymous
 * "(+/-) reported adjustments" row tells the reader that a difference exists
 * and nothing about what it is, and in practice sat at zero in every case,
 * which is worse than saying nothing at all.
 *
 * A component that is zero in every period reconciles nothing and is dropped.
 * When no component survives, the model basis IS the company basis and the
 * whole company-reported block is suppressed: the model-basis header says so
 * in one row instead of the block spending six on a column of zeros.
 */
export function reportedNetDebtBridgeComponents(modelCase) {
  const supplied = modelCase?.historical_supplement?.reported_net_debt_adjustment;
  if (!Array.isArray(supplied)) return [];
  return supplied
    .filter(
      (component) =>
        component &&
        typeof component === "object" &&
        !Array.isArray(component) &&
        typeof component.label === "string" &&
        component.label.trim() !== "" &&
        Array.isArray(component.values) &&
        component.values.some((value) => Math.abs(Number(value ?? 0)) > 1e-9),
    )
    .map((component) => ({
      label: component.label.trim(),
      values: Array.from({ length: 6 }, (_, index) =>
        Number(component.values[index] ?? 0),
      ),
      note: typeof component.note === "string" ? component.note : null,
    }));
}

export function reportedNetDebtBasisStatus(modelCase) {
  const declared =
    modelCase?.historical_supplement?.reported_net_debt_basis_status;
  const bridge = reportedNetDebtBridgeComponents(modelCase);
  if (bridge.length > 0) return "reconciled_difference";
  if (
    ["proven_same", "reported_unreconciled", "not_disclosed"].includes(
      declared,
    )
  ) return declared;
  return "not_disclosed";
}

/**
 * THE REFERENCE RATES THE FORECAST ACTUALLY PRICES OFF.
 *
 * A benchmark NAME is not a curve. Two instruments can both say "SOFR" and
 * still reprice off different rates — a swap-adjusted bond carries the swapped
 * leg, not the raw index — and the case says so by declaring `benchmark_rate`
 * on the instrument itself. The solver has always honoured that declaration;
 * the formula emitter used to hardwire one curve row per benchmark NAME, so
 * every instrument sharing a name was priced off whichever one happened to be
 * listed first. The cached interest was then right and the formula beneath it
 * wrong — the number moved on recalculation.
 *
 * The curve identity is therefore (benchmark name, declared rate series), and
 * each distinct curve earns its OWN visible row in the "Reference rates" block
 * where the reader can see all three forecast rates. Nothing is buried in a
 * formula: the instrument's interest line multiplies by that row, exactly as
 * it always did, and column E names the row it points at.
 *
 * The first series declared under a name keeps the bare name, so a book whose
 * instruments all agree on a curve is laid out byte-for-byte as before.
 */
export function benchmarkCurvePlan(modelCase) {
  const byName = new Map();
  const keyByInstrumentId = new Map();
  for (const instrument of modelCase?.instruments ?? []) {
    if (instrument.rate_type !== "floating" || !instrument.benchmark) continue;
    const rates = Array.from({ length: 3 }, (_, index) =>
      Number(
        Array.isArray(instrument.benchmark_rate)
          ? (instrument.benchmark_rate[index] ?? 0)
          : (instrument.benchmark_rate ?? 0),
      ),
    );
    const signature = rates.join("|");
    if (!byName.has(instrument.benchmark)) byName.set(instrument.benchmark, []);
    const curves = byName.get(instrument.benchmark);
    let curve = curves.find((item) => item.signature === signature);
    if (!curve) {
      curve = {
        benchmark: instrument.benchmark,
        signature,
        rates,
        ordinal: curves.length,
        instrument_ids: [],
        // The bare name for the first curve declared under it; anything after
        // that is numbered, because a number is the only distinguishing mark
        // that fits where the mark has to be read.
        key:
          curves.length === 0
            ? instrument.benchmark
            : `${instrument.benchmark}#${curves.length + 1}`,
        // TWO LABELS, BECAUSE THE TWO PLACES HAVE DIFFERENT ROOM.
        //
        // `label` is what column E of the instrument's interest row shows, and
        // column E is 12 characters — 66.6pt. This used to be
        // `${benchmark} — ${instrument.name}`, which on AstraZeneca produced
        // `SOFR — €750m bond due Aug-2033 (SOFR swap-adjusted)`: 51 characters,
        // centred, in a 12-character column. Centred text spills BOTH ways, so
        // it ran left across D — which holds that instrument's own rate — and
        // the render showed `0.95%nd due Aug-2033 (SOFR swap-adjusted)`, two
        // values printed on top of one another. Numbering the curve instead
        // bounds the string at the benchmark name plus three characters.
        //
        // `row_label` is what column B of the reference-rate row shows, and
        // column B is 45 characters with C, D, E and F empty beside it on that
        // row, so it can legally spill to 79 characters. The instrument name
        // that distinguishes the curve therefore keeps a home; it just stops
        // being repeated into a cell an eighth its width. The row_label STARTS
        // with the label, so `column E names the row it points at` still holds
        // literally: the reader matches `SOFR #2` in E against `SOFR #2 — …`
        // in B.
        label:
          curves.length === 0
            ? instrument.benchmark
            : `${instrument.benchmark} #${curves.length + 1}`,
        row_label:
          curves.length === 0
            ? instrument.benchmark
            : `${instrument.benchmark} #${curves.length + 1} — ${
                instrument.name ?? instrument.instrument_id
              }`,
      };
      curves.push(curve);
    }
    curve.instrument_ids.push(instrument.instrument_id);
    keyByInstrumentId.set(instrument.instrument_id, curve.key);
  }
  const curves = [...byName.keys()]
    .sort()
    .flatMap((benchmark) => byName.get(benchmark));
  return { curves, keyByInstrumentId };
}

export function compileRowPlan(modelCase) {
  const authorityProfile = selectStandardisedProfile(modelCase);
  const authority = standardisedProfile(authorityProfile);
  const rowsById = {};
  const sectionHeaders = {};
  // The title occupies row 1 and row 2 is the blank that separates it from the
  // first section. There is no subtitle row: the control block starts at 3.
  const controls = {
    header: 3,
    broker_case: 4,
    circularity: 5,
    debt_maturities_roll: 6,
    // One editable minimum-cash row (was calculated / override / effective).
    effective_minimum_cash: 7,
    // ONE switch governs the adjustment columns (N/O/P) and, through them, the
    // pro-forma columns. There is no separate acquisition switch: the
    // acquisition IS what populates the adjustments, so a second control only
    // ever gave the reader two places to look for the same answer.
    adjustments_header: 3,
    adjustments_enabled: 4,
    transaction_enterprise_value: 5,
    entry_ev_to_ebitda: 6,
    target_ebitda: 7,
    // Enterprise value infers target operating economics. Acquisition debt is
    // a separately supplied absolute amount and alone drives debt, interest
    // and leverage; there is no implied consideration/equity or RCF funding.
    acquisition_debt_amount: 8,
    incremental_rate: 9,
    close_year: 10,
    close_month: 11,
    // Growth, margin, D&A, tax, capex and working-capital ratios are DERIVED
    // from the standalone case in the adjustment columns — a ratio line
    // beneath the row it drives — so declaring them again as transaction
    // inputs would duplicate the model against itself.
  };
  // Rows 12-13 remain blank. Acquisition timing and target growth are compiled
  // inline from the visible controls, so helper workings never intrude between
  // the control block and the period header.
  const controlBlockEndRow = Math.max(
    ...Object.values(controls).map(Number).filter(Number.isFinite),
  );
  const BLANK_ROWS_BEFORE_PERIOD_HEADER = 2;
  const periodGroupRow = controlBlockEndRow + BLANK_ROWS_BEFORE_PERIOD_HEADER + 1;
  const periodRow = periodGroupRow + 1;
  // One blank row separates the period header from the first section band.
  let cursor = periodRow + 2;

  sectionHeaders.income_statement = cursor;
  cursor += 1;
  const incomeDefinitions = normaliseStatementRows(
    modelCase,
    "income_statement",
  );
  assertStatementTopology(modelCase, "income_statement", incomeDefinitions);
  const income = allocateRows(
    incomeDefinitions,
    cursor,
    rowsById,
    "income_statement",
  );
  cursor = income.nextRow + 1;

  sectionHeaders.cash_flow = cursor;
  cursor += 1;
  const cashFlowDefinitions = normaliseStatementRows(modelCase, "cash_flow");
  assertStatementTopology(modelCase, "cash_flow", cashFlowDefinitions);
  const cashFlow = allocateRows(
    cashFlowDefinitions,
    cursor,
    rowsById,
    "cash_flow",
  );
  cursor = cashFlow.nextRow + 1;

  sectionHeaders.debt_schedule = cursor;
  const debtTermHeaderRow = cursor + 1;
  cursor += 2;
  const instrumentPlans = [];
  const sorted = [...(modelCase.instruments ?? [])].sort(
    (left, right) =>
      Number(left.display_order ?? 0) - Number(right.display_order ?? 0) ||
      String(left.instrument_id).localeCompare(String(right.instrument_id)),
  );
  // An FX row earns its place ONLY when the forecast period-end rate actually
  // moves. A row that repeats the same rate three times tells the reader
  // nothing: the balance formula multiplies and divides by the identical
  // constant, so the translation cannot shift a single balance year on year.
  // Where the curve is flat the row is dropped and the balances translate
  // against the one Forward Curves cell that matters, which is both shorter on
  // the face and shorter in the formula. Where the curve genuinely moves the
  // row stays, stated in reporting-currency-per-native terms so the balance
  // formula is a plain multiply with no inversion buried in it.
  const debtFxRows = {};
  for (const currency of [
    ...new Set(
      sorted
        .filter(
          (instrument) =>
            instrument.balance_basis !== "reporting_currency_carrying_value",
        )
        .map((instrument) => instrument.currency)
        .filter(
          (currency) =>
            currency && currency !== modelCase.issuer.reporting_currency,
        ),
    ),
  ].sort()) {
    if (!forecastFxRateMoves(modelCase, currency)) continue;
    debtFxRows[currency] = cursor;
    rowsById[`debt_fx.${currency}`] = cursor;
    cursor += 1;
  }
  const groupedDebtPresentation = sorted.length > 0;
  const debtGroups = [];
  const groupByLabel = new Map();
  if (groupedDebtPresentation) {
    for (const definition of CRH_DEBT_GROUPS) {
      const instrumentIds = sorted
        .filter((instrument) => crhDebtGroupKey(instrument) === definition.key)
        .map((instrument) => instrument.instrument_id);
      if (instrumentIds.length === 0) continue;
      const group = {
        group_id: definition.key,
        label: definition.label,
        header_row: null,
        subtotal_row: null,
        interest_header_row: null,
        interest_subtotal_row: null,
        instrument_ids: instrumentIds,
      };
      groupByLabel.set(definition.label, group);
      debtGroups.push(group);
    }
  }
  const instrumentById = new Map(
    sorted.map((instrument) => [instrument.instrument_id, instrument]),
  );
  const orderedInstruments = groupedDebtPresentation
    ? debtGroups.flatMap((group) =>
        group.instrument_ids.map((instrumentId) =>
          instrumentById.get(instrumentId),
        ),
      )
    : sorted;
  for (const instrument of orderedInstruments) {
    const displayGroup = groupedDebtPresentation
      ? crhDebtGroupLabel(instrument)
      : null;
    const group = displayGroup ? groupByLabel.get(displayGroup) : null;
    if (group && group.header_row === null) {
      group.header_row = cursor;
      rowsById[`debt_group.${group.group_id}.header`] = cursor;
      cursor += 1;
    }
    const plan = {
      instrument_id: instrument.instrument_id,
      display_group: displayGroup,
      // The validator needs the same semantic distinction as the emitter:
      // a contractual term maturity is governed by the roll switch, whereas a
      // documented non-maturing/evergreen balance is deliberately not. Carry
      // the treatment, never infer it later from a row number or label.
      maturity_treatment: instrument.maturity_treatment ?? null,
      debt_row: cursor,
      undrawn_row: null,
      issuance_row: null,
      amortisation_row: null,
      repayment_row: null,
      has_mandatory_repayment: false,
      repayment_state_by_period: ["zero", "zero", "zero"],
      pik_row: null,
      fair_value_row: null,
      other_non_cash_row: null,
      interest_row: null,
      pik_interest_row: null,
    };
    rowsById[`debt.${instrument.instrument_id}`] = cursor;
    cursor += 1;
    // A committed facility gets ONE line in the debt schedule: the drawn
    // balance. The undrawn memo row that used to sit beneath it is gone — it
    // never belonged in a schedule that builds up gross debt (a reader scanning
    // the column saw the full commitment sitting there and read it as debt),
    // and the liquidity block below already states the headroom, now read
    // straight off capacity less drawn.
    if ((instrument.new_issuance ?? []).some((value) => Math.abs(Number(value || 0)) > 0)) {
      plan.issuance_row = cursor;
      rowsById[`debt.${instrument.instrument_id}.issuance`] = cursor;
      cursor += 1;
    }
    if (
      (instrument.scheduled_amortisation ?? []).some(
        (value) => Math.abs(Number(value || 0)) > 0,
      )
    ) {
      plan.amortisation_row = cursor;
      rowsById[`debt.${instrument.instrument_id}.amortisation`] = cursor;
      cursor += 1;
    }
    const lastHistoricalEnd = new Date(modelCase.periods?.[2]?.date ?? 0);
    const lastForecastEnd = new Date(modelCase.periods?.[5]?.date ?? 0);
    const maturity = instrument.maturity_date
      ? new Date(instrument.maturity_date)
      : null;
    const forecastMaturity =
      instrument.class !== "rcf" &&
      instrument.maturity_treatment !== "non_maturing_within_forecast" &&
      maturity &&
      !Number.isNaN(maturity.getTime()) &&
      maturity > lastHistoricalEnd &&
      maturity <= lastForecastEnd;
    plan.repayment_state_by_period = [0, 1, 2].map((index) => {
      if (instrument.class === "rcf") return "discretionary_rcf";
      const periodEnd = new Date(modelCase.periods?.[index + 3]?.date ?? 0);
      const priorPeriodEnd = new Date(
        modelCase.periods?.[index + 2]?.date ?? 0,
      );
      const maturityDue =
        instrument.maturity_treatment !== "non_maturing_within_forecast" &&
        maturity &&
        !Number.isNaN(maturity.getTime()) &&
        maturity > priorPeriodEnd &&
        maturity <= periodEnd;
      const scheduled =
        Math.abs(Number(instrument.scheduled_amortisation?.[index] ?? 0)) > 0;
      if (maturityDue && scheduled) return "scheduled_and_maturity";
      if (maturityDue) return "maturity_due";
      if (scheduled) return "scheduled_amortisation";
      return "zero";
    });
    if (
      instrument.class !== "rcf" &&
      (forecastMaturity || Number.isInteger(plan.amortisation_row))
    ) {
      plan.has_mandatory_repayment = true;
    }
    if (
      (instrument.pik_rate ?? []).some(
        (value) => Math.abs(Number(value || 0)) > 0,
      )
    ) {
      plan.pik_row = cursor;
      rowsById[`debt.${instrument.instrument_id}.pik`] = cursor;
      cursor += 1;
    }
    if (
      (instrument.non_cash_movement_components?.fair_value ?? []).some(
        (value) => Math.abs(Number(value || 0)) > 0,
      )
    ) {
      plan.fair_value_row = cursor;
      rowsById[`debt.${instrument.instrument_id}.fair_value`] = cursor;
      cursor += 1;
    }
    if (
      (
        instrument.non_cash_movement_components?.other ??
        instrument.other_non_cash_movement ??
        []
      ).some(
        (value) => Math.abs(Number(value || 0)) > 0,
      )
    ) {
      plan.other_non_cash_row = cursor;
      rowsById[`debt.${instrument.instrument_id}.other_non_cash`] = cursor;
      cursor += 1;
    }
    instrumentPlans.push(plan);
    if (
      group &&
      group.instrument_ids.at(-1) === instrument.instrument_id
    ) {
      group.subtotal_row = cursor;
      rowsById[`debt_group.${group.group_id}.subtotal`] = cursor;
      cursor += 1;
    }
  }
  const debtSummaryRows = {};
  // The block is split by BASIS, because "what is this number" is the question
  // a reader actually has and the two answers are not interchangeable.
  //
  //   MODEL BASIS      one standardised calculation, stated on both lease
  //                    definitions, comparable across issuers. Always present.
  //   COMPANY REPORTED the issuer's own definition, reached from the model's
  //                    number by named reconciling items. Present only when the
  //                    case supplies at least one item that is genuinely
  //                    non-zero.
  //
  // The model block runs unbroken from gross debt to the coverage ratio:
  // balances, then the denominators, then the multiples that divide them. The
  // two debt-movement memos that used to sit in the middle of it (cash movement
  // and FX translation) now close the block rather than interrupting the run
  // from a balance to the ratio that reads it.
  const bridgeComponents = reportedNetDebtBridgeComponents(modelCase);
  const reportedNetDebtStatus = reportedNetDebtBasisStatus(modelCase);
  const reportedBridge = reportedNetDebtStatus === "reconciled_difference";
  const declaredCashBuckets = Array.isArray(modelCase.cash_policy?.buckets)
    ? modelCase.cash_policy.buckets
    : [];
  const cashBucketSummaryIds = declaredCashBuckets.length
    ? [
        "cash_bucket_header",
        ...declaredCashBuckets.map(
          (bucket) => `cash_bucket.${bucket.bucket_id}`,
        ),
        "reported_cash",
        "liquidity_cash",
        "interest_bearing_cash",
      ]
    : [];
  // With leases switched off entirely the two lease bases are the same number,
  // so the second net-debt row and the second leverage ratio would be exact
  // duplicates of the first. Only state a definition that says something.
  const leasesPresent = modelCase.lease_policy?.mode !== "exclude";
  const leaseInterestBasis = resolvedLeaseInterestBasis(modelCase);
  for (const id of [
    // Acquisition debt and lease liabilities each get their own titled block,
    // as CRH does, rather than sitting inline in the gross-debt build-up.
    "acquisition_debt_header",
    "acquisition_debt",
    "total_acquisition_debt",
    // ---- MODEL BASIS -------------------------------------------------------
    // A BLANK ROW OPENS THE PANEL. The model-basis box used to start on the row
    // immediately after the acquisition block, so a frame that means "this is
    // one thing" began flush against the thing above it. `PANEL_SPACER` is the
    // sentinel: it consumes a row number and lands in no index, so nothing can
    // address it and every downstream row still resolves through the plan.
    PANEL_SPACER,
    "model_basis_header",
    "gross_debt_excluding_leases",
    "lease_header",
    "lease_liability",
    ...(leasesPresent
      ? ["lease_principal_assumption", "lease_additions_assumption"]
      : []),
    ...(leaseInterestBasis === "separately_supplied"
      ? ["lease_interest_bearing_liability"]
      : []),
    "total_lease_liabilities",
    "gross_debt_including_leases",
    ...cashBucketSummaryIds,
    "cash_for_net_debt",
    "net_debt_excluding_leases",
    ...(leasesPresent ? ["net_debt_including_leases"] : []),
    // Every ratio sits directly beneath the figure it divides by, and divides
    // by THAT ROW rather than reaching back into the income statement, so the
    // multiple can be checked by eye without leaving the block.
    "leverage_adjusted_ebitda",
    ...(leasesPresent
      ? ["net_debt_excluding_leases_to_adjusted_ebitda"]
      : []),
    "net_debt_to_adjusted_ebitda",
    "leverage_net_interest",
    "adjusted_ebitda_to_net_interest",
    "mandatory_debt_repayments",
    // The line the cash flow reads, closing the model-basis block: the reader
    // still shuts the balance-sheet movement and the cash flow against each
    // other without leaving the block, but it no longer stands between a
    // balance and the multiple that divides it. It carries CASH ONLY.
    "total_change_in_debt",
    // ...and, where the book is genuinely multi-currency, the translation that
    // moved the balances without moving cash. Two rows, because they are two
    // different facts: one is a cash flow, the other is a restatement. Only
    // the first is allowed into the cash flow; the second is here so the
    // reader can still add opening + cash + FX and land on closing.
    ...(hasDebtFxTranslation(modelCase) ? ["debt_fx_translation"] : []),
    // ---- COMPANY REPORTED --------------------------------------------------
    // Restate the model's number, name what the company does to it, land on
    // the published figure, then divide it by a denominator on the row above.
    // Nothing here is inferred: every step is a row.
    ...(reportedBridge
      ? [
          // ...and a blank row BETWEEN the two panels. Without it the two boxes
          // share an edge, and two frames touching read as one region with a
          // line through the middle rather than as two statements of the same
          // figure on two bases.
          PANEL_SPACER,
          "company_reported_header",
          "net_debt_model_basis_restated",
          ...bridgeComponents.map(
            (_, index) => `reported_net_debt_adjustment_${index}`,
          ),
          "net_debt_company_reported",
          "company_reported_adjusted_ebitda",
          "net_debt_company_reported_to_adjusted_ebitda",
        ]
      : []),
    "liquidity_header",
    "undrawn_rcf",
    "drawn_commercial_paper",
    "year_end_cash",
    "total_liquidity",
  ]) {
    // The spacer takes a row and gets no identity, so it is invisible to every
    // emitter that walks `debtSummaryRows` — no label, no formula, no fill.
    if (id === PANEL_SPACER) {
      cursor += 1;
      continue;
    }
    debtSummaryRows[id] = cursor;
    rowsById[id] = cursor;
    cursor += 1;
  }
  cursor += 1;

  const cashBucketPlans = declaredCashBuckets.map((bucket) => ({
    bucket_id: bucket.bucket_id,
    label: bucket.label,
    forecast_treatment: bucket.forecast_treatment,
    included_in_cash_flow_cash:
      bucket.included_in_cash_flow_cash !== false,
    linked_instrument_ids: [...(bucket.linked_instrument_ids ?? [])],
    available_for_liquidity: bucket.available_for_liquidity,
    net_debt_eligible_percentage: Number(
      bucket.net_debt_eligible_percentage,
    ),
    interest_eligible_percentage: Number(
      bucket.interest_eligible_percentage,
    ),
    historical_year_end: bucket.historical_year_end.map(Number),
    forecast_values:
      bucket.forecast_values === null ||
      bucket.forecast_values === undefined
        ? null
        : bucket.forecast_values.map(Number),
    cash_yield: bucket.cash_yield.map(Number),
    source_line_ids: [...(bucket.source_line_ids ?? [])],
    balance_row: debtSummaryRows[`cash_bucket.${bucket.bucket_id}`],
    rate_row: null,
    interest_row: null,
  }));

  sectionHeaders.rcf_waterfall = cursor;
  cursor += 1;
  const waterfallRows = {};
  // The sweep is a column of numbers that adds up, then a four-line revolver
  // roll-forward. Two rows that were only ever MAX(0, +/- the same difference)
  // collapse into ONE signed surplus / (deficit) line — which is what the
  // source model itself shows — and the revolver's spare capacity is read
  // inside the draw formula rather than parked on a row of its own next to the
  // undrawn-RCF line that already states it.
  //
  // Every structural row is allocated unconditionally. The issuance waterfall
  // row used to exist only when an instrument carried sourced issuance, which
  // left the statement's Change in Debt issuance child with no schedule row
  // to reference and collapsed it to a literal zero — a dead audit trail on a
  // row the contract requires to stay a live schedule-owned producer. A
  // no-issuance case now simply shows the schedule row summing to nothing.
  for (const id of [
    "cash_before_debt",
    "non_rcf_debt_proceeds",
    "pre_rcf_debt_cash_flow",
    "lease_principal_waterfall",
    "cash_before_rcf",
    "minimum_cash",
    "cash_surplus_deficit",
    "opening_rcf",
    "rcf_draw_waterfall",
    "rcf_repayment_waterfall",
    "ending_rcf",
    "liquidity_shortfall",
  ]) {
    waterfallRows[id] = cursor;
    rowsById[id] = cursor;
    cursor += 1;
  }
  cursor += 1;

  sectionHeaders.interest_schedule = cursor;
  const benchmarkRow = cursor + 1;
  cursor += 2;
  const benchmarkRows = {};
  // One row per DISTINCT CURVE, not per benchmark name: an instrument that
  // declares its own `benchmark_rate` prices off its own row, visibly, rather
  // than off whichever same-named instrument happened to be listed first.
  const { curves: benchmarkCurves, keyByInstrumentId: benchmarkCurveKeys } =
    benchmarkCurvePlan(modelCase);
  for (const curve of benchmarkCurves) {
    benchmarkRows[curve.key] = cursor;
    rowsById[`benchmark.${curve.key}`] = cursor;
    cursor += 1;
  }
  const benchmarkFloorRows = {};
  const benchmarkFloors = [];
  const pikRateRows = {};
  const pikRates = [];
  for (const instrument of orderedInstruments) {
    if (
      instrument.rate_type !== "floating" ||
      !Array.isArray(instrument.benchmark_floor)
    ) {
      continue;
    }
    benchmarkFloorRows[instrument.instrument_id] = cursor;
    benchmarkFloors.push({
      instrument_id: instrument.instrument_id,
      label: `${instrument.name} — contractual floor`,
      rates: instrument.benchmark_floor.map(Number),
      row: cursor,
    });
    rowsById[`benchmark_floor.${instrument.instrument_id}`] = cursor;
    cursor += 1;
  }
  for (const instrument of orderedInstruments) {
    if (!Array.isArray(instrument.pik_rate)) continue;
    pikRateRows[instrument.instrument_id] = cursor;
    pikRates.push({
      instrument_id: instrument.instrument_id,
      label: `${instrument.name} — PIK rate`,
      rates: instrument.pik_rate.map(Number),
      row: cursor,
    });
    rowsById[`pik_rate.${instrument.instrument_id}`] = cursor;
    cursor += 1;
  }
  for (const bucket of cashBucketPlans) {
    bucket.rate_row = cursor;
    rowsById[`cash_yield.${bucket.bucket_id}`] = cursor;
    cursor += 1;
  }
  const interestTermHeaderRow = cursor;
  cursor += 1;
  // The revolver is NOT given an instrument row here. Its cost is stated once,
  // in the dedicated "Total RCF fees" block below, which splits drawn interest
  // from the commitment fee. An instrument row as well only ever mirrored the
  // drawn-interest line, so the same facility appeared twice in one schedule.
  const carriesInterestRow = (instrumentId) =>
    !isBalancingRcf(modelCase, instrumentById.get(instrumentId));
  if (groupedDebtPresentation) {
    for (const group of debtGroups) {
      group.interest_header_row = cursor;
      rowsById[`interest_group.${group.group_id}.header`] = cursor;
      cursor += 1;
      for (const instrumentId of group.instrument_ids) {
        if (!carriesInterestRow(instrumentId)) continue;
        const instrumentPlan = instrumentPlans.find(
          (plan) => plan.instrument_id === instrumentId,
        );
        instrumentPlan.interest_row = cursor;
        rowsById[`interest.${instrumentPlan.instrument_id}`] = cursor;
        cursor += 1;
        const instrument = instrumentById.get(instrumentId);
        if (
          (instrument?.pik_rate ?? []).some(
            (value) => Math.abs(Number(value || 0)) > 0,
          )
        ) {
          instrumentPlan.pik_interest_row = cursor;
          rowsById[`interest.${instrumentPlan.instrument_id}.pik`] = cursor;
          cursor += 1;
        }
      }
      group.interest_subtotal_row = cursor;
      rowsById[`interest_group.${group.group_id}.subtotal`] = cursor;
      cursor += 1;
    }
  } else {
    for (const instrumentPlan of instrumentPlans) {
      if (!carriesInterestRow(instrumentPlan.instrument_id)) continue;
      instrumentPlan.interest_row = cursor;
      rowsById[`interest.${instrumentPlan.instrument_id}`] = cursor;
      cursor += 1;
      const instrument = instrumentById.get(instrumentPlan.instrument_id);
      if (
        (instrument?.pik_rate ?? []).some(
          (value) => Math.abs(Number(value || 0)) > 0,
        )
      ) {
        instrumentPlan.pik_interest_row = cursor;
        rowsById[`interest.${instrumentPlan.instrument_id}.pik`] = cursor;
        cursor += 1;
      }
    }
  }
  if (cashBucketPlans.length) {
    rowsById.cash_bucket_interest_header = cursor;
    cursor += 1;
    for (const bucket of cashBucketPlans) {
      bucket.interest_row = cursor;
      rowsById[`cash_interest.${bucket.bucket_id}`] = cursor;
      cursor += 1;
    }
  }
  const interestSummaryRows = {};
  // "Total RCF fees" is a SUBTOTAL and therefore sits ABOVE its two
  // constituents: the drawn interest and the commitment fee are grouped
  // beneath it (outline level 1, summaryBelow="0"). Gross interest expense
  // must consequently skip the two constituent rows and pick up the subtotal
  // instead — see the two-range SUM in the interest emitter.
  //
  // "Other / unallocated interest" is the SECOND row to take that shape, and
  // for the same reason. It is a RESIDUAL — reported gross interest less the
  // interest the schedule can attribute to a named instrument — and it used to
  // be a typed number with nothing on the face to check it against. The two
  // rows that derive it are therefore grouped beneath it exactly as the RCF's
  // two constituents are: the answer first, its workings collapsible below.
  // Gross interest skips them, because they are a derivation and not a
  // component: adding them in would count reported interest twice.
  for (const id of [
    "instrument_interest",
    "acquisition_interest",
    "rcf_total_fees",
    "rcf_interest",
    "rcf_commitment_fee",
    "lease_interest",
    "other_unallocated_interest",
    "interest_reported_total",
    "interest_identified_total",
    "non_cash_interest",
    "gross_interest_expense",
    "cash_interest_paid",
    "cash_interest_received",
    "interest_income_schedule",
    "net_interest_expense",
  ]) {
    interestSummaryRows[id] = cursor;
    rowsById[id] = cursor;
    cursor += 1;
  }

  // There is no hidden support block any more. Every mechanical row the model
  // needs — balance roll-forward, interest, repayment — is emitted on the face
  // of the schedule it belongs to, so the last allocated row IS the last row of
  // the model.
  const visibleEndRow = cursor - 1;

  return {
    schema_version: 2,
    semantic_graph_version: 1,
    profile: "standardised_dynamic",
    authority_profile: authorityProfile,
    authority_contract_sha256: activeDesignContractSha256(),
    authority_runtime_contract_sha256: activeDesignRuntimeSha256(),
    // Bind every generated row map to the exact immutable workbook authority
    // selected for this profile.  The projection validator must be able to
    // prove that a maximal plan was measured against maximal (and net-cash
    // against net-cash), not merely that both used the same abstract contract.
    authority_source_sha256: authority.immutable_authority_sha256,
    authority_profile_fingerprint_sha256:
      authority.exact_replay_fingerprint_sha256,
    // Carried so the validators can size a MONEY tolerance without re-reading
    // the case: the contract states the currency floor in currency units and
    // the model states its numbers in the issuer's units, so one cannot be
    // turned into the other without knowing which. See DEFECT 0.2 and the
    // `tolerances` block in assets/production-contract-v2.json.
    issuer_units: modelCase.issuer?.units ?? null,
    reporting_currency: modelCase.issuer?.reporting_currency ?? null,
    columns: {
      labels: "B",
      terms: ["C", "D", "E"],
      historical: ["G", "H", "I"],
      forecast: ["J", "K", "L"],
      adjustment: ["N", "O", "P"],
      pro_forma_reference: "R",
      pro_forma: ["S", "T", "U"],
    },
    controls,
    period_group_row: periodGroupRow,
    period_row: periodRow,
    section_headers: sectionHeaders,
    statement_rows: {
      income_statement: income.rows,
      cash_flow: cashFlow.rows,
    },
    section_conclusions: Object.fromEntries(
      [income, cashFlow].map((allocation) => {
        const owner = allocation.rows.find(
          (definition) => definition.section_conclusion_owner === true,
        );
        const section = allocation.rows[0]?.section;
        return [
          section,
          owner
            ? {
                owner_row_id: owner.row_id,
                owner_row: owner.row,
                semantic_role: owner.semantic_role,
                dependency_closure: allocation.rows
                  .filter((definition) => definition.in_section_conclusion_closure)
                  .map((definition) => definition.row_id),
              }
            : null,
        ];
      }),
    ),
    debt_term_header_row: debtTermHeaderRow,
    debt_fx_rows: debtFxRows,
    debt_groups: debtGroups,
    instruments: instrumentPlans,
    debt_summary_rows: debtSummaryRows,
    // The surviving named reconciling items, in the order their rows were
    // allocated, so the emitters and the cache writer walk the same list the
    // row plan walked.
    reported_net_debt_bridge: bridgeComponents,
    reported_net_debt_basis_status: reportedNetDebtStatus,
    cash_buckets: cashBucketPlans,
    waterfall_rows: waterfallRows,
    benchmark_row: benchmarkRow,
    benchmark_rows: benchmarkRows,
    // The curve each row states, and which instrument prices off which row.
    // Emitters must resolve an instrument to its curve KEY — never to its
    // benchmark NAME — or a per-instrument rate silently reverts to the shared
    // curve in the formula while the solver keeps using the declared one.
    benchmark_curves: benchmarkCurves.map((curve) => ({
      key: curve.key,
      // `label` is the short form column E can hold; `row_label` is the long
      // form column B has room for. See benchmarkCurvePlan().
      label: curve.label,
      row_label: curve.row_label ?? curve.label,
      benchmark: curve.benchmark,
      rates: curve.rates,
      instrument_ids: curve.instrument_ids,
      row: benchmarkRows[curve.key],
    })),
    benchmark_curve_keys: Object.fromEntries(benchmarkCurveKeys),
    benchmark_floor_rows: benchmarkFloorRows,
    benchmark_floors: benchmarkFloors,
    pik_rate_rows: pikRateRows,
    pik_rates: pikRates,
    interest_term_header_row: interestTermHeaderRow,
    interest_summary_rows: interestSummaryRows,
    // Sections outside the statement blocks declare their Excel row groups
    // here; patchRowOutlines() in build_dynamic_model.mjs writes them straight
    // into the worksheet part, because the writer's outlineLevel format API is
    // silently dropped. Appended to, never replaced, so other sections can add
    // their own groups without fighting over the key.
    outline_rows: [
      { row: interestSummaryRows.rcf_interest, level: 1 },
      { row: interestSummaryRows.rcf_commitment_fee, level: 1 },
      // The two rows that derive the unallocated-interest residual, grouped
      // beneath the residual itself.
      { row: interestSummaryRows.interest_reported_total, level: 1 },
      { row: interestSummaryRows.interest_identified_total, level: 1 },
    ],
    rows_by_id: rowsById,
    visible_end_row: visibleEndRow,
  };
}
