#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assessCoverage } from "./lib/coverage.mjs";
import { acknowledgeSyntheticLiquidityStress } from "./lib/plausibility_acknowledgements.mjs";
import { solveCase, validateCaseShape } from "./lib/solver.mjs";
import {
  compileBrokerConsensusMetric,
  sealBrokerConsensusMembership,
} from "./lib/broker_consensus.mjs";

export const COMPILER_VERSION = "dmu-synthetic-cohort/1.0.0";
const EXPECTED_IDS = Array.from({ length: 32 }, (_, index) => `C${index + 1}`);

export const SYNTHETIC_CASE_RECIPES = Object.freeze({
  C1: ["profile:maximal", "accounting:ifrs", "statement:segments", "cashflow:long", "debt:large-book", "fx:multi-currency"],
  C2: ["profile:maximal", "accounting:ifrs", "statement:nature", "cashflow:standard", "debt:amortising", "liquidity:deficit-with-capacity"],
  C3: ["profile:maximal", "accounting:ifrs", "statement:gross-profit", "cashflow:working-capital", "debt:mixed", "lease:simple-roll-forward"],
  C4: ["profile:net-cash", "accounting:ifrs", "statement:services", "cashflow:deferred-revenue", "debt:simple", "lease:exclude"],
  C5: ["profile:maximal", "accounting:us-gaap", "statement:function", "cashflow:acquisitive", "debt:mixed", "acquisition:year-2-month-1"],
  C6: ["profile:maximal", "accounting:us-gaap", "statement:adjusted-ebitda", "cashflow:cash-sweep", "debt:levfin-pik-floor", "liquidity:deficit-capacity-bind"],
  C7: ["profile:maximal", "accounting:ifrs", "statement:minimal", "cashflow:short", "debt:sparse", "lease:flat-replacement"],
  C8: ["profile:maximal", "accounting:ifrs", "statement:operating-profit", "cashflow:capex-heavy", "debt:long-dated", "liquidity:mandatory-maturity-deficit"],
  C9: ["profile:maximal", "accounting:ifrs", "statement:function", "cashflow:standard", "debt:mixed"],
  C10: ["profile:maximal", "accounting:ifrs", "statement:nature", "cashflow:working-capital", "debt:mixed"],
  C11: ["profile:maximal", "accounting:ifrs", "statement:segments", "cashflow:standard", "debt:large-book", "fx:multi-currency"],
  C12: ["profile:maximal", "accounting:us-gaap", "statement:adjusted-ebitda", "cashflow:non-cash-stack", "debt:mixed"],
  C13: ["profile:maximal", "accounting:ifrs", "statement:ebit-only", "cashflow:da-outside-is", "debt:simple"],
  C14: ["profile:maximal", "accounting:ifrs", "statement:services", "cashflow:deferred-revenue", "debt:low"],
  C15: ["profile:maximal", "accounting:ifrs", "statement:jv-impairment-restructuring", "cashflow:classification-stress", "debt:mixed"],
  C16: ["profile:maximal", "accounting:ifrs", "statement:loss-restatement", "cashflow:discontinued", "debt:mixed", "liquidity:deficit-with-capacity"],
  C17: ["profile:maximal", "accounting:ifrs", "statement:compact", "cashflow:wc-reported-parent", "debt:simple"],
  C18: ["profile:maximal", "accounting:us-gaap", "statement:function", "cashflow:non-cash-stack", "debt:mixed"],
  C19: ["profile:maximal", "accounting:ifrs", "statement:function", "cashflow:wc-parent-three-children", "debt:mixed"],
  C20: ["profile:maximal", "accounting:ifrs", "statement:services", "cashflow:wc-derived-unusual", "debt:low"],
  C21: ["profile:maximal", "accounting:ifrs", "statement:nature", "cashflow:wc-interleaved", "debt:mixed"],
  C22: ["profile:maximal", "accounting:ifrs", "statement:operating-profit", "cashflow:multi-category-capex", "debt:long-dated"],
  C23: ["profile:maximal", "accounting:us-gaap", "statement:function", "cashflow:long-investing-financing", "debt:mixed", "acquisition:year-3-month-12"],
  C24: ["profile:maximal", "accounting:ifrs", "statement:segments", "cashflow:cash-buckets", "debt:large-book", "fx:multi-currency"],
  C25: ["profile:net-cash", "accounting:ifrs", "statement:function", "cashflow:standard", "debt:simple", "liquidity:surplus-no-opening-rcf"],
  C26: ["profile:maximal", "accounting:ifrs", "statement:nature", "cashflow:financing-detail", "debt:amortising"],
  C27: ["profile:maximal", "accounting:ifrs", "statement:segments", "cashflow:long", "debt:large-book", "fx:four-currency-foreign-rcf"],
  C28: ["profile:maximal", "accounting:ifrs", "statement:compact", "cashflow:standard", "debt:mixed", "liquidity:all-states"],
  C29: ["profile:maximal", "accounting:us-gaap", "statement:function", "cashflow:short-term-financing", "debt:commercial-paper-backstop"],
  C30: ["profile:maximal", "accounting:us-gaap", "statement:adjusted-ebitda", "cashflow:cash-sweep", "debt:levfin-pik-floor", "liquidity:surplus-with-opening-rcf"],
  C31: ["profile:maximal", "accounting:ifrs", "statement:function", "cashflow:refinancing", "debt:refinancing", "acquisition:year-1-month-6"],
  C32: ["profile:maximal", "accounting:ifrs", "statement:nature", "cashflow:debt-parent-children", "debt:all-movement-classes", "fx:translation-without-cash"],
});

const SUPPORTED_RECIPE_TOKENS = new Set(Object.values(SYNTHETIC_CASE_RECIPES).flat());

function clone(value) {
  return structuredClone(value);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function row(caseData, section, rowId) {
  return caseData.statement_structure[section].find((item) => item.row_id === rowId);
}

function insertBefore(caseData, section, beforeId, rows) {
  const list = caseData.statement_structure[section];
  const index = list.findIndex((item) => item.row_id === beforeId);
  if (index < 0) throw new Error(`Cannot insert before missing ${section} row ${beforeId}.`);
  list.splice(index, 0, ...rows);
}

function addStatementStressRows(caseData, kind, seed) {
  // These cases are not label stresses. They receive a genuinely different
  // statement graph in applyStructuralStatementTopology(): operating profit
  // is the reported authority and EBITDA appears only in the later bridge.
  // Adding the old one-line stress row here would recreate the shallow,
  // canonical skeleton these cases are intended to challenge.
  if (["gross-profit", "operating-profit", "jv-impairment-restructuring"].includes(kind)) {
    return;
  }
  const labelsByKind = {
    function: ["Cost of sales", "Selling, general and administrative expenses"],
    nature: ["Raw materials and consumables", "Employee benefit expense", "Other operating costs"],
    services: ["Employee and contractor costs", "Technology and occupancy costs"],
    segments: ["Operating segment result", "Corporate costs and eliminations"],
    "gross-profit": ["Cost of merchandise sold", "Store and distribution costs"],
    "adjusted-ebitda": ["Share-based compensation adjustment", "Restructuring and transaction adjustment"],
    "ebit-only": ["Depreciation and amortisation disclosed outside the income statement"],
    "jv-impairment-restructuring": ["Share of JV and associate result", "Impairment and restructuring charge"],
    "loss-restatement": ["Restated continuing operations", "Discontinued operations"],
    minimal: ["Other operating expenses"],
    "operating-profit": ["Regulated operating costs"],
    compact: ["Other operating costs"],
  };
  const labels = labelsByKind[kind] ?? [];
  if (!labels.length) return;
  const rows = labels.map((label, index) => ({
    row_id: `stress_is_${kind.replaceAll("-", "_")}_${index + 1}`,
    label,
    row_type: "uncalculated",
    values: [
      -round((seed % 41 + 20) * (index + 1), 3),
      -round((seed % 43 + 22) * (index + 1), 3),
      -round((seed % 47 + 24) * (index + 1), 3),
      null,
      null,
      null,
    ],
    forecast_treatment: "uncalculated",
    classification_status: "accepted",
    classification_confidence: 1,
    operation_scope: kind === "loss-restatement" && index === 1 ? "discontinued" : "continuing",
    indent: 1,
  }));
  if (kind === "loss-restatement") {
    const parentId = "stress_is_loss_restatement_combined";
    rows.forEach((item, index) => {
      item.row_type = "input";
      item.parent_row_id = parentId;
      item.aggregation_role = "contributing_child";
      item.economic_class = "other_operating";
      item.operation_scope = index === 0 ? "continuing" : "discontinued";
      // The combined parent owns its forecast as the exact sum of these
      // children (derived_from_children), and forecast-authority validation
      // refuses an identity parent whose children stand down ("incomplete
      // children-owned forecast authority"). Leave each component live with a
      // revenue-scaled roll-forward so the family's forecast stays child-owned
      // and the combined restated total keeps reconciling exactly.
      item.forecast_treatment = "formula";
      item.forecast_calculation = {
        operator: "prior_period_scaled_by",
        refs: [item.row_id, "revenue"],
      };
    });
    const childRefs = rows.map((item) => item.row_id);
    rows.unshift({
      row_id: parentId,
      label: "Restated combined operating result",
      row_type: "calculation",
      calculation: { operator: "sum", refs: childRefs },
      aggregation_authority: "derived_from_children",
      operation_scope: "combined",
      scope_reconciliation_note: "Continuing and discontinued synthetic components reconcile exactly to this combined restated authority.",
      style_role: "total",
    });
  }
  insertBefore(caseData, "income_statement", "operating_profit", rows);
}

function historicalSeries(source, fallback = 0) {
  return Array.from({ length: 3 }, (_, index) => {
    const value = source?.[index];
    return value == null ? Number(fallback) : Number(value);
  });
}

function scaledHistorical(source, factor) {
  return historicalSeries(source).map((value) => round(value * factor, 3));
}

function workingInput({ rowId, label, values, forecast = "scaled" }) {
  const definition = {
    row_id: rowId,
    label,
    row_type: "input",
    values: [...historicalSeries(values), ...(forecast === "zero" ? [0, 0, 0] : [null, null, null])],
    aggregation_role: "standalone",
    aggregation_authority: "standalone",
    economic_class: "other_operating",
    classification_status: "accepted",
    classification_confidence: 1,
    indent: 1,
  };
  if (forecast === "zero") {
    definition.forecast_treatment = "hardcode";
  } else {
    definition.forecast_treatment = "formula";
    definition.forecast_calculation = {
      operator: "prior_period_scaled_by",
      refs: [rowId, "revenue"],
    };
  }
  return definition;
}

/**
 * Turn the selected synthetic cases into genuine statement-topology tests.
 *
 * The former cohort inserted one differently worded row into an otherwise
 * identical Revenue -> Adjusted EBITDA -> EBIT skeleton. That tested labels,
 * not universality. These cases now present issuer-style operating detail and
 * a REPORTED operating-profit authority. The detail is deliberately working
 * detail beneath that authority; one formula-driven residual makes it
 * reconcile in every period without pretending every issuer forecasts every
 * disclosed expense line. Adjusted EBITDA appears only in the bridge below
 * net income and is assembled from operating profit and D&A.
 */
function applyStructuralStatementTopology(caseData, kind, seed) {
  if (!["gross-profit", "operating-profit", "jv-impairment-restructuring"].includes(kind)) return;

  const existing = new Map(
    caseData.statement_structure.income_statement.map((item) => [item.row_id, clone(item)]),
  );
  const revenue = existing.get("revenue");
  const revenueGrowth = existing.get("revenue_growth");
  const operatingProfit = existing.get("operating_profit");
  const da = existing.get("depreciation_and_amortisation");
  const adjustedEbitda = existing.get("adjusted_ebitda");
  const adjustedMargin = existing.get("adjusted_ebitda_margin");
  if (!revenue || !operatingProfit || !da || !adjustedEbitda) {
    throw new Error(`Structural ${kind} topology requires revenue, operating profit, D&A and adjusted EBITDA authorities.`);
  }

  const revenueHist = historicalSeries(revenue.values);
  const operatingHist = historicalSeries(operatingProfit.values);
  const costOfSalesHist = scaledHistorical(revenueHist, kind === "gross-profit" ? -0.58 : -0.52);
  const operatingCostsHist = scaledHistorical(revenueHist, kind === "operating-profit" ? -0.31 : -0.24);
  const associateHist = kind === "jv-impairment-restructuring"
    ? scaledHistorical(revenueHist, 0.018)
    : [0, 0, 0];
  const impairmentHist = kind === "jv-impairment-restructuring"
    ? [-round(seed % 37 + 18, 3), -round(seed % 41 + 11, 3), -round(seed % 43 + 7, 3)]
    : [0, 0, 0];
  const leaseDepreciationHist = kind === "gross-profit"
    ? scaledHistorical(da.values, -0.22)
    : [0, 0, 0];
  const grossProfitHist = revenueHist.map((value, index) => round(value + costOfSalesHist[index], 3));
  const residualHist = operatingHist.map((value, index) => round(
    value - grossProfitHist[index] - operatingCostsHist[index] - associateHist[index]
      - impairmentHist[index] - leaseDepreciationHist[index],
    3,
  ));

  revenue.label = kind === "gross-profit" ? "Revenue from contracts with customers" : "Revenue and operating income";
  revenue.semantic_role = "revenue";
  revenue.broker_metric_id = "revenue";
  revenue.style_role = "total";

  const costOfSales = workingInput({
    rowId: `stress_is_${kind.replaceAll("-", "_")}_cost_of_sales`,
    label: kind === "gross-profit" ? "Cost of sales" : "Direct operating costs",
    values: costOfSalesHist,
  });
  const grossProfit = {
    row_id: `stress_is_${kind.replaceAll("-", "_")}_gross_profit`,
    label: kind === "gross-profit" ? "Gross profit" : "Operating contribution",
    row_type: "calculation",
    calculation: { operator: "sum", refs: ["revenue", costOfSales.row_id] },
    aggregation_role: "standalone",
    aggregation_authority: "derived_from_children",
    economic_class: "other_operating",
    style_role: "total",
  };
  const operatingCosts = workingInput({
    rowId: `stress_is_${kind.replaceAll("-", "_")}_operating_costs`,
    label: kind === "gross-profit"
      ? "Distribution, administrative and occupancy costs"
      : "Regulated, employee and other operating costs",
    values: operatingCostsHist,
  });
  const associate = workingInput({
    rowId: `stress_is_${kind.replaceAll("-", "_")}_associates`,
    label: "Share of results of associates and joint ventures",
    values: associateHist,
    forecast: kind === "jv-impairment-restructuring" ? "scaled" : "zero",
  });
  const impairment = workingInput({
    rowId: `stress_is_${kind.replaceAll("-", "_")}_impairment`,
    label: "Impairment, restructuring and exceptional operating items",
    values: impairmentHist,
    forecast: "zero",
  });
  impairment.economic_class = "restructuring";
  const leaseDepreciation = workingInput({
    rowId: `stress_is_${kind.replaceAll("-", "_")}_lease_depreciation`,
    label: "Depreciation of right-of-use assets included in operating costs",
    values: leaseDepreciationHist,
    forecast: kind === "gross-profit" ? "scaled" : "zero",
  });
  const detailRows = [costOfSales, grossProfit, operatingCosts];
  if (kind === "gross-profit") detailRows.push(leaseDepreciation);
  if (kind === "jv-impairment-restructuring") detailRows.push(associate, impairment);

  const detailResidual = {
    row_id: `stress_is_${kind.replaceAll("-", "_")}_other_operating`,
    label: "Other operating income / (costs) — reconciliation to reported operating profit",
    row_type: "calculation",
    values: [...residualHist, null, null, null],
    calculation: {
      operator: "subtract",
      refs: ["operating_profit", grossProfit.row_id, operatingCosts.row_id,
        ...(kind === "gross-profit" ? [leaseDepreciation.row_id] : []),
        ...(kind === "jv-impairment-restructuring" ? [associate.row_id, impairment.row_id] : [])],
    },
    aggregation_role: "standalone",
    aggregation_authority: "derived_from_children",
    economic_class: "other_operating",
    classification_status: "accepted",
    classification_confidence: 1,
    indent: 1,
  };
  detailRows.push(detailResidual);

  operatingProfit.label = kind === "jv-impairment-restructuring"
    ? "Reported operating profit after associates and exceptional items"
    : "Reported operating profit";
  operatingProfit.row_type = "input";
  operatingProfit.semantic_role = "ebit";
  operatingProfit.broker_metric_id = "ebit";
  operatingProfit.forecast_treatment = "broker";
  operatingProfit.aggregation_authority = "reported_parent";
  operatingProfit.style_role = "total";
  delete operatingProfit.calculation;
  delete operatingProfit.forecast_calculation;
  delete operatingProfit.forecast_period_calculations;

  const bridgeOperatingProfit = {
    row_id: "bridge_operating_profit",
    label: "Reported operating profit",
    row_type: "calculation",
    calculation: { operator: "link", refs: ["operating_profit"] },
    indent: 1,
  };
  adjustedEbitda.row_type = "calculation";
  adjustedEbitda.calculation = {
    operator: "sum",
    refs: [bridgeOperatingProfit.row_id, "depreciation_and_amortisation"],
  };
  adjustedEbitda.semantic_role = "adjusted_ebitda";
  adjustedEbitda.broker_metric_id = "adjusted_ebitda";
  adjustedEbitda.style_role = "total";
  adjustedMargin.calculation = { operator: "ratio", refs: ["adjusted_ebitda", "revenue"] };
  adjustedMargin.style_role = "subsection";

  caseData.statement_structure.income_statement = [
    revenue,
    revenueGrowth,
    ...detailRows,
    operatingProfit,
    existing.get("interest_income"),
    existing.get("interest_expense"),
    existing.get("pre_tax_income"),
    existing.get("effective_tax_rate"),
    existing.get("tax_expense"),
    existing.get("net_income"),
    {
      row_id: "adjusted_ebitda_bridge",
      label: "Adjusted EBITDA bridge",
      row_type: "header",
      style_role: "subsection",
    },
    bridgeOperatingProfit,
    da,
    adjustedEbitda,
    adjustedMargin,
  ].filter(Boolean);
}

export function addCashFlowStressRow(caseData, kind, seed) {
  const alreadyStructured = new Set([
    "working-capital", "wc-parent-three-children", "wc-derived-unusual",
    "wc-interleaved", "non-cash-stack", "classification-stress", "long",
    "multi-category-capex", "cash-buckets",
  ]);
  if (!kind || kind === "standard" || alreadyStructured.has(kind)) return;
  if (kind === "cash-sweep") {
    const canonical = row(caseData, "cash_flow", "rcf_repayment");
    if (!canonical) throw new Error("The cash-sweep overlay requires the canonical RCF repayment row.");
    canonical.label = "Excess cash applied to revolving credit facility";
    return;
  }
  const canonicalDebtRows = {
    "financing-detail": ["debt_repayment", "Other cash repayment of borrowings"],
    "short-term-financing": ["debt_issuance", "Commercial paper issuance/(repayment)"],
    refinancing: ["debt_issuance", "Standalone refinancing proceeds"],
  };
  if (canonicalDebtRows[kind]) {
    const [rowId, label] = canonicalDebtRows[kind];
    const canonical = row(caseData, "cash_flow", rowId);
    if (!canonical) {
      throw new Error(`${kind} requires the canonical ${rowId} cash-flow row.`);
    }
    canonical.label = label;
    return;
  }
  // This overlay builds a reported parent and two disclosed workings in
  // addDebtParentChildren(). A third unattached movement would be a second,
  // unauthorised debt story rather than additional topology coverage.
  if (kind === "debt-parent-children") return;
  const definitions = {
    "deferred-revenue": ["Movement in deferred revenue and contract liabilities", "working_capital_movement", "deferred_revenue", "operating"],
    acquisitive: ["Business acquisitions, net of cash acquired", "investing_cash_flow", "investing", "investing"],
    short: ["Other operating cash movement", "operating_cash_flow", "other_operating", "operating"],
    "capex-heavy": ["Growth and maintenance capital programme", "investing_cash_flow", "investing", "investing"],
    "da-outside-is": ["Depreciation and amortisation sourced from cash-flow reconciliation", "operating_cash_flow", "other_operating", "operating"],
    discontinued: ["Net cash flows from discontinued operations", "operating_cash_flow", "other_operating", "operating"],
    "wc-reported-parent": ["Reported aggregate change in working capital", "working_capital_movement", "working_capital", "operating"],
    "long-investing-financing": ["Purchase of non-controlling interests and treasury shares", "non_debt_financing", "financing", "financing"],
    "financing-detail": ["Other cash repayment of borrowings", "other_cash_debt_movement", "financing", "financing"],
    "short-term-financing": ["Commercial paper issuance/(repayment)", "other_cash_debt_movement", "financing", "financing"],
    refinancing: ["Standalone refinancing proceeds", "debt_issuance", "financing", "financing"],
    "debt-parent-children": ["Disclosed debt movement children (working detail)", "other_cash_debt_movement", "financing", "financing"],
  };
  const definition = definitions[kind];
  if (!definition) return;
  const [label, movementType, economicClass, classification] = definition;
  const stressRow = {
    row_id: `stress_cf_${kind.replaceAll("-", "_")}`,
    label,
    row_type: "uncalculated",
    values: [round(seed % 19 + 1), round(seed % 23 + 2), round(seed % 29 + 3), null, null, null],
    forecast_treatment: "uncalculated",
    movement_type: movementType,
    economic_class: economicClass,
    cash_flow_classification: classification,
    classification_status: "accepted",
    classification_confidence: 1,
    operation_scope: kind === "discontinued" ? "discontinued" : "continuing",
    indent: 1,
  };
  const subtotalByClassification = {
    operating: "cash_from_operations",
    investing: "cash_from_investing",
    financing: "cash_from_financing",
  };
  const subtotalId = subtotalByClassification[classification];
  const isStandaloneCashComponent = ![
    "working_capital_movement",
    "debt_issuance",
    "scheduled_amortisation",
    "maturity_repayment",
    "debt_issuance_cost",
    "other_cash_debt_movement",
  ].includes(movementType);
  if (subtotalId && isStandaloneCashComponent) {
    const subtotal = row(caseData, "cash_flow", subtotalId);
    if (!subtotal?.calculation?.refs) {
      throw new Error(`${kind} requires a declared ${subtotalId} subtotal.`);
    }
    stressRow.row_type = "input";
    stressRow.forecast_treatment = "formula";
    stressRow.forecast_calculation = {
      operator: "prior_period",
      refs: [stressRow.row_id],
    };
    subtotal.calculation.refs.push(stressRow.row_id);
    subtotal.aggregation_authority = "derived_from_children";
    applySyntheticHistoricalCashFlowDelta(caseData, stressRow.values.slice(0, 3));
    insertBefore(caseData, "cash_flow", subtotalId, [stressRow]);
    return;
  }
  if (kind === "long-investing-financing") {
    const subtotal = row(caseData, "cash_flow", "cash_from_financing");
    if (!subtotal?.calculation?.refs) {
      throw new Error("The long financing overlay requires a declared cash-from-financing subtotal.");
    }
    const forecast = [-round(seed % 31 + 9), -round(seed % 37 + 11), -round(seed % 41 + 13)];
    stressRow.row_type = "input";
    stressRow.values = [...stressRow.values.slice(0, 3), ...forecast];
    stressRow.forecast_treatment = "hardcode";
    // `cash_from_financing` is a conventional subtotal shown after its inputs,
    // not a collapsible presentation parent shown before them. Preserve the
    // exact calculation membership without manufacturing a visual hierarchy.
    subtotal.calculation.refs.push(stressRow.row_id);
    subtotal.aggregation_authority = "derived_from_children";
    applySyntheticHistoricalCashFlowDelta(caseData, stressRow.values.slice(0, 3));
  }
  insertBefore(caseData, "cash_flow", "net_change_in_cash", [stressRow]);
}

function addWorkingChildren(caseData, parentId, definitions, { derived = false } = {}) {
  const parent = row(caseData, "cash_flow", parentId);
  if (!parent) throw new Error(`Missing cash-flow parent ${parentId}.`);
  const parentValues = parent.values ?? caseData.operating_metrics.change_in_working_capital.values;
  const count = definitions.length;
  const children = definitions.map((definition, childIndex) => ({
    row_id: definition.id,
    label: definition.label,
    row_type: "input",
    values: parentValues.map((value, periodIndex) => {
      if (value == null) return null;
      if (childIndex === count - 1) {
        const prior = Array.from({ length: count - 1 }, (_, index) =>
          round(Number(value) * (0.18 + index * 0.07), 3),
        );
        return round(Number(value) - prior.reduce((sum, item) => sum + item, 0), 3);
      }
      return round(Number(value) * (0.18 + childIndex * 0.07), 3);
    }),
    forecast_treatment: parent.forecast_treatment ?? "formula",
    parent_row_id: parentId,
    aggregation_role: derived ? "contributing_child" : "working_child",
    economic_class: definition.economicClass,
    classification_status: "accepted",
    classification_confidence: 1,
    indent: 1,
  }));
  if (derived) {
    parent.row_type = "calculation";
    delete parent.values;
    delete parent.forecast_treatment;
    delete parent.forecast_calculation;
    parent.calculation = { operator: "sum", refs: children.map((item) => item.row_id) };
    parent.aggregation_authority = "derived_from_children";
  } else {
    // The parent keeps independent forecast ownership (reported total; its
    // broker metric or declared series carries the forecast), so the visible
    // children must stand down. Leaving their forecast cells unstated is NOT
    // neutral here: the legacy inference mints each blank child into an
    // explicit_zero live forecast, and forecast-authority validation refuses a
    // broker_consensus parent coexisting with live children as mixed aggregate
    // forecast ownership. Declare the stand-down explicitly instead.
    // (Frozen-cohort defect 2, quarantine frozen-cohort-compiler-membership-order
    // in assets/ci-gate-tiers-v1.json.)
    parent.aggregation_authority = "reported_parent";
    for (const child of children) {
      child.forecast_period_authorities = [0, 1, 2].map(() => ({
        method: "not_applicable",
        source_kind: "none",
        note: `${child.row_id} is presentation detail of the reported ${parentId} total, which carries the forecast once.`,
      }));
    }
  }
  // Source order is parent first, then its visible children. The presentation
  // compiler preserves that semantic hierarchy and must not have to move a
  // later parent ahead of earlier source rows.
  const cashFlowRows = caseData.statement_structure.cash_flow;
  const parentIndex = cashFlowRows.findIndex((item) => item.row_id === parentId);
  cashFlowRows.splice(parentIndex + 1, 0, ...children);
}

function addCashFlowWorkings(caseData, kind) {
  const wcStandard = [
    { id: "wc_receivables", label: "Movement in trade receivables", economicClass: "working_capital" },
    { id: "wc_inventory", label: "Movement in inventories", economicClass: "working_capital" },
    { id: "wc_payables", label: "Movement in trade payables", economicClass: "working_capital" },
  ];
  if (["working-capital", "wc-parent-three-children"].includes(kind)) {
    addWorkingChildren(caseData, "change_in_working_capital", wcStandard);
  } else if (kind === "wc-derived-unusual") {
    addWorkingChildren(caseData, "change_in_working_capital", [
      { id: "wc_contract_assets", label: "Movement in contract assets", economicClass: "working_capital" },
      { id: "wc_contract_liabilities", label: "Movement in contract liabilities", economicClass: "working_capital" },
      // Deferred revenue is an unusual *label*, but when the issuer declares it
      // inside the working-capital bridge it shares the parent's economic class.
      // Its cash-flow classification must not split the declared family.
      { id: "wc_deferred_revenue", label: "Movement in deferred revenue", economicClass: "working_capital" },
    ], { derived: true });
  } else if (kind === "wc-interleaved") {
    addWorkingChildren(caseData, "change_in_working_capital", wcStandard);
    // The interleaved case deliberately includes nearby operating adjustments
    // that are *not* working-capital children. Keep them as standalone rows;
    // assigning them to the WC parent would misstate both the subtotal and the
    // presentation hierarchy merely because they are displayed nearby.
    const standaloneAdjustments = [
      ["wc_provisions_working", "Movement in provisions (shown, excluded from working capital)", "provision", 0.08],
      ["wc_pensions_working", "Pension funding movement (shown, excluded from working capital)", "pension", 0.06],
      ["wc_restructuring_working", "Restructuring accrual movement (shown, excluded from working capital)", "restructuring", 0.04],
    ].map(([rowId, label, economicClass, factor]) => ({
      ...workingInput({
        rowId,
        label,
        values: scaledHistorical(caseData.operating_metrics.change_in_working_capital.values, factor),
      }),
      economic_class: economicClass,
      indent: 0,
    }));
    const cashFlowRows = caseData.statement_structure.cash_flow;
    const lastWorkingChildIndex = cashFlowRows.findIndex((item) => item.row_id === "wc_payables");
    cashFlowRows.splice(lastWorkingChildIndex + 1, 0, ...standaloneAdjustments);
  } else if (kind === "wc-reported-parent") {
    const parent = row(caseData, "cash_flow", "change_in_working_capital");
    parent.aggregation_authority = "standalone";
  }

  const stacks = {
    "non-cash-stack": [
      ["cf_impairment", "Impairment and asset write-downs", "provision"],
      ["cf_share_comp", "Share-based compensation", "other_operating"],
      ["cf_deferred_tax", "Deferred tax movement", "tax"],
      ["cf_pension_noncash", "Non-cash pension movement", "pension"],
    ],
    "classification-stress": [
      ["cf_jv_result", "Share of profit from joint ventures and associates", "other_operating"],
      ["cf_disposal_gain", "Gain on disposal of businesses", "investing"],
      ["cf_impairment_reversal", "Impairment reversal", "other_operating"],
      ["cf_restructuring_noncash", "Non-cash restructuring charge", "restructuring"],
    ],
    "long": [
      ["cf_fair_value", "Fair-value and mark-to-market movements", "other_operating"],
      ["cf_pension", "Pension and post-employment movement", "pension"],
      ["cf_provisions", "Provisions movement", "provision"],
    ],
  };
  const stack = stacks[kind];
  if (stack) {
    const cashGenerated = row(caseData, "cash_flow", "cash_generated_from_operations");
    if (cashGenerated) {
      cashGenerated.calculation.refs.push(...stack.map(([id]) => id));
    }
    const values = caseData.operating_metrics.other_non_cash.values;
    const stackRows = stack.map(([id, label, economicClass], index) => ({
      row_id: id,
      label,
      row_type: "input",
      values: values.map((value, period) => period < 3 ? round((index + 1) * (period + 1) * 1.125, 3) : value),
      forecast_treatment: "hardcode",
      economic_class: economicClass,
      classification_status: "accepted",
      classification_confidence: 1,
      indent: 1,
    }));
    insertBefore(caseData, "cash_flow", "change_in_working_capital", stackRows);
    applySyntheticHistoricalCashFlowDelta(
      caseData,
      [0, 1, 2].map((periodIndex) =>
        stackRows.reduce(
          (sum, item) => sum + Number(item.values[periodIndex] ?? 0),
          0,
        ),
      ),
    );
  }

  if (kind === "multi-category-capex") {
    const capex = row(caseData, "cash_flow", "capex");
    const values = capex.values;
    const children = [
      ["capex_maintenance", "Maintenance capital expenditure", 0.45],
      ["capex_growth", "Growth capital expenditure", 0.35],
      ["capex_intangible", "Capitalised software and intangibles", 0.2],
    ].map(([id, label, share]) => ({
      row_id: id,
      label,
      row_type: "input",
      values: values.map((value) => value == null ? null : round(Number(value) * share, 3)),
      forecast_treatment: "formula",
      parent_row_id: "capex",
      aggregation_role: "working_child",
      economic_class: "investing",
      classification_status: "accepted",
      classification_confidence: 1,
      indent: 1,
    }));
    // Same shape as the working-capital reported-parent family above: the
    // reported `capex` total keeps independent forecast ownership (its broker
    // metric carries the forecast once), so these presentation children must
    // stand down. Leaving their forecast cells unstated is NOT neutral — the
    // legacy inference mints each blank child into an explicit_zero live
    // forecast, and forecast-authority validation refuses a broker_consensus
    // parent coexisting with live children as mixed aggregate forecast
    // ownership. Declare the stand-down explicitly instead.
    // (Frozen-cohort defect 4, quarantine frozen-cohort-compiler-membership-order
    // in assets/ci-gate-tiers-v1.json.)
    capex.aggregation_authority = "reported_parent";
    for (const child of children) {
      child.forecast_period_authorities = [0, 1, 2].map(() => ({
        method: "not_applicable",
        source_kind: "none",
        note: `${child.row_id} is presentation detail of the reported ${capex.row_id} total, which carries the forecast once.`,
      }));
    }
    insertBefore(caseData, "cash_flow", "capex", children);
  }
}

/**
 * Apply the exact historical cash effect of a synthetic overlay to every later
 * closing balance. An FY1 constituent changes FY1 closing cash, FY2 opening
 * cash and therefore every later closing balance, so the effect is cumulative.
 *
 * Production evidence never uses this compiler. The helper prevents generated
 * statement rows and the generated legacy cash-policy authority from making
 * contradictory claims after an overlay joins a live subtotal.
 */
export function applySyntheticHistoricalCashFlowDelta(caseData, deltas) {
  if (Array.isArray(caseData.cash_policy?.buckets)) {
    throw new Error(
      "Synthetic cash-flow deltas must be applied before explicit buckets are compiled.",
    );
  }
  const rows = caseData.statement_structure?.cash_flow ?? [];
  const opening = rows.find((item) => item.semantic_role === "opening_cash");
  const ending = rows.find((item) => item.semantic_role === "ending_cash");
  if (!opening || !ending || !Array.isArray(ending.values)) return caseData;
  let cumulative = 0;
  const closedEnding = ending.values.slice(0, 3).map((value, periodIndex) => {
    cumulative += Number(deltas?.[periodIndex] ?? 0);
    return round(Number(value ?? 0) + cumulative, 6);
  });
  const closedOpening = [
    Number(opening.values?.[0] ?? 0),
    closedEnding[0],
    closedEnding[1],
  ];
  opening.values = [...closedOpening, ...(opening.values ?? []).slice(3, 6)];
  ending.values = [...closedEnding, ...(ending.values ?? []).slice(3, 6)];
  caseData.cash_policy.historical_year_end_cash = [...closedEnding];
  caseData.cash_policy.opening_cash = closedEnding[2];
  if (Array.isArray(caseData.historical_supplement?.prior_cash_and_cash_equivalents)) {
    caseData.historical_supplement.prior_cash_and_cash_equivalents = closedEnding.slice(0, 2);
  }
  return caseData;
}

function relabelStatement(caseData, kind) {
  const labels = {
    services: { revenue: "Service and subscription revenue" },
    segments: { revenue: "Group revenue", operating_profit: "Consolidated operating profit" },
    "adjusted-ebitda": { revenue: "Net revenue" },
    "ebit-only": { operating_profit: "EBIT" },
    "jv-impairment-restructuring": { operating_profit: "Operating profit before exceptional items" },
    "loss-restatement": { revenue: "Revenue (restated)", operating_profit: "Operating loss (restated)", pre_tax_income: "Loss before taxation", net_income: "Loss for the period" },
    minimal: { revenue: "Turnover", net_income: "Profit for the financial year" },
  };
  for (const [id, label] of Object.entries(labels[kind] ?? {})) {
    const target = row(caseData, "income_statement", id);
    if (target) target.label = label;
  }
  if (kind === "loss-restatement") {
    caseData.modules.historical_normalisation = false;
    caseData.operating_metrics.ebit.values = caseData.operating_metrics.ebit.values.map((value) => value == null ? null : -Math.abs(value));
  }
}

function splitLargeBook(caseData) {
  const source = caseData.instruments.filter((item) => item.class !== "rcf");
  const rcf = caseData.instruments.find((item) => item.class === "rcf");
  const expanded = [];
  for (const instrument of source) {
    for (let part = 1; part <= 2; part += 1) {
      const copy = clone(instrument);
      copy.instrument_id = `${instrument.instrument_id}_part_${part}`;
      copy.name = `${instrument.name} — synthetic tranche ${part}`;
      copy.display_order = instrument.display_order * 2 + part - 1;
      copy.opening_balance = round(instrument.opening_balance / 2, 6);
      for (const field of ["scheduled_amortisation", "new_issuance", "other_non_cash_movement"]) {
        if (Array.isArray(copy[field])) copy[field] = copy[field].map((value) => round(Number(value) / 2, 6));
      }
      if (copy.non_cash_movement_components) {
        for (const key of Object.keys(copy.non_cash_movement_components)) {
          copy.non_cash_movement_components[key] = copy.non_cash_movement_components[key].map((value) => round(Number(value) / 2, 6));
        }
      }
      expanded.push(copy);
    }
  }
  caseData.instruments = [...expanded, rcf];
}

function reportingAmount(caseData, instrument) {
  if (instrument.currency === caseData.issuer.reporting_currency) return Number(instrument.opening_balance);
  const curve = caseData.fx?.[instrument.currency];
  const rate = Number(curve?.period_end_rates?.[2]);
  if (!Number.isFinite(rate)) throw new Error(`Missing last-historical FX rate for ${instrument.currency}.`);
  return curve.quote === "native_per_reporting"
    ? Number(instrument.opening_balance) / rate
    : Number(instrument.opening_balance) * rate;
}

function resetOpeningDebtAuthority(caseData) {
  const reported = round(caseData.instruments
    .filter((instrument) => instrument.include_in_gross_debt)
    .reduce((sum, instrument) => sum + reportingAmount(caseData, instrument), 0), 6);
  caseData.debt_reconciliation.reported_opening_gross_debt = reported;
  caseData.debt_reconciliation.note = "Deterministic synthetic instrument register equals the reported opening gross-debt authority.";
  caseData.historical_supplement.prior_gross_debt_excluding_leases = [round(reported * 0.94, 6), round(reported * 0.97, 6)];
}

function simplifyDebtBook(caseData, { low = false } = {}) {
  const rcf = caseData.instruments.find((item) => item.class === "rcf");
  const fixed = clone(caseData.instruments.find((item) => item.class === "bond_fixed"));
  const floating = clone(caseData.instruments.find((item) => item.class === "term_loan_floating"));
  if (!rcf || !fixed || !floating) throw new Error("The maximal authority cannot supply a simple synthetic debt book.");
  if (low) {
    fixed.opening_balance = round(fixed.opening_balance * 0.12, 6);
    floating.opening_balance = round(floating.opening_balance * 0.08, 6);
    rcf.opening_balance = 0;
    caseData.rcf_policy.opening_draw = 0;
  }
  fixed.display_order = 1;
  floating.display_order = 2;
  rcf.display_order = 99;
  caseData.instruments = [fixed, floating, rcf];
  resetOpeningDebtAuthority(caseData);
}

function addFourthCurrency(caseData) {
  const source = caseData.instruments.find((item) => item.currency === caseData.issuer.reporting_currency && item.class === "bond_fixed");
  if (!source) throw new Error("A fourth-currency overlay needs a reporting-currency fixed instrument to split.");
  const chf = clone(source);
  source.opening_balance = round(source.opening_balance / 2, 6);
  chf.opening_balance = source.opening_balance;
  chf.instrument_id = `${source.instrument_id}_chf`;
  chf.name = `CHF ${chf.opening_balance}m synthetic fixed notes`;
  chf.currency = "CHF";
  chf.display_order = source.display_order + 1;
  caseData.instruments.push(chf);
  caseData.fx ??= {};
  caseData.fx.CHF = {
    quote: "reporting_per_native",
    average_rates: [1.071, 1.086, 1.102, 1.094, 1.081, 1.067],
    period_end_rates: [1.079, 1.093, 1.111, 1.087, 1.074, 1.059],
  };
  const rcf = caseData.instruments.find((item) => item.class === "rcf");
  if (!rcf) throw new Error("The four-currency foreign-RCF overlay requires an RCF instrument.");
  rcf.currency = "CHF";
  caseData.modules.multi_currency = true;
  resetOpeningDebtAuthority(caseData);
}

function addDebtParentChildren(caseData) {
  const parent = {
    row_id: "stress_cf_debt_movement_parent",
    label: "Reported change in borrowings",
    row_type: "input",
    values: [-120, 85, -45, null, null, null],
    forecast_treatment: "uncalculated",
    aggregation_authority: "reported_parent",
    economic_class: "financing",
    cash_flow_classification: "none",
    classification_status: "accepted",
    classification_confidence: 1,
  };
  const children = [
    ["stress_cf_debt_issuance_child", "Gross proceeds from borrowings", "debt_issuance", [180, 240, 150]],
    ["stress_cf_debt_repayment_child", "Repayment and maturity of borrowings", "maturity_repayment", [-300, -155, -195]],
  ].map(([id, label, movementType, values]) => ({
    row_id: id,
    label,
    row_type: "input",
    values: [...values, null, null, null],
    forecast_treatment: "uncalculated",
    parent_row_id: parent.row_id,
    aggregation_role: "working_child",
    economic_class: "financing",
    cash_flow_classification: "none",
    classification_status: "accepted",
    classification_confidence: 1,
    indent: 1,
  }));
  insertBefore(caseData, "cash_flow", "net_change_in_cash", [parent, ...children]);
}

function applyDebtOverlay(caseData, kind) {
  if (kind === "large-book") splitLargeBook(caseData);
  if (kind === "simple" && caseData.instruments.length > 3) simplifyDebtBook(caseData);
  if (kind === "sparse") simplifyDebtBook(caseData, { low: true });
  if (kind === "low") simplifyDebtBook(caseData, { low: true });
  if (kind === "levfin-pik-floor") {
    const floating = caseData.instruments.find((item) => item.class === "term_loan_floating");
    if (floating) {
      floating.benchmark_floor = [0.02, 0.02, 0.02];
      floating.pik_rate = [0.0125, 0.0125, 0.0125];
      floating.assumption_note = "Synthetic leveraged-finance tranche with a contractual benchmark floor and separately visible PIK accretion.";
    }
  }
  if (kind === "all-movement-classes") {
    const target = caseData.instruments.find((item) => item.class === "term_loan_floating");
    if (target) {
      delete target.other_non_cash_movement;
      target.non_cash_movement_components = {
        fair_value: [11.25, -7.5, 4.375],
        other: [3.125, 2.5, -1.875],
      };
      target.pik_rate = [0.0075, 0.0075, 0.0075];
    }
  }
  if (kind === "amortising") {
    const target = caseData.instruments.find((item) => item.class === "term_loan_floating");
    if (target) target.scheduled_amortisation = [round(target.opening_balance * 0.08), round(target.opening_balance * 0.08), round(target.opening_balance * 0.08)];
  }
  if (kind === "refinancing") {
    const target = caseData.instruments.find((item) => item.class === "bond_fixed");
    if (target) target.new_issuance = [350, 0, 0];
  }
}

function applyLeaseOverlay(caseData, kind) {
  if (kind === "exclude") {
    caseData.lease_policy.mode = "exclude";
    caseData.lease_policy.include_in_gross_debt = false;
    caseData.lease_policy.include_in_net_debt = false;
    caseData.lease_policy.include_in_leverage = false;
  } else if (kind === "simple-roll-forward") {
    caseData.lease_policy.mode = "simple_roll_forward";
    caseData.lease_policy.additions = caseData.lease_policy.principal_repayment.map((value) => round(Number(value) * 1.04, 3));
  } else if (kind === "flat-replacement") {
    caseData.lease_policy.mode = "flat_replacement";
    caseData.lease_policy.additions = clone(caseData.lease_policy.principal_repayment);
  }
}

function applyLeaseInterestAccounting(caseData, seed) {
  const policy = caseData.lease_policy;
  delete policy.historical_interest_bearing_liabilities;
  delete policy.forecast_interest_bearing_liabilities;
  delete policy.operating_lease_interest_separately_reclassified;
  if (policy.mode === "exclude") {
    policy.interest_basis = "none";
    return;
  }
  if (caseData.issuer.accounting_basis === "IFRS") {
    policy.interest_basis = "total_liability";
    return;
  }
  // Split the US GAAP cohort between cases whose operating-lease cost remains
  // wholly above EBIT and cases that separately identify a finance-lease base.
  // Neither path silently applies an interest rate to total operating leases.
  if (Number(seed) % 2 === 0) {
    policy.interest_basis = "none";
    return;
  }
  policy.interest_basis = "separately_supplied";
  const historicalTotal = policy.historical_liabilities ?? [
    0,
    0,
    Number(policy.opening_liability ?? 0),
  ];
  policy.historical_interest_bearing_liabilities = historicalTotal.map(
    (value) => round(Number(value) * 0.25, 3),
  );
  const principal = policy.principal_repayment ?? [0, 0, 0];
  const additions = policy.additions ?? [0, 0, 0];
  let total = Number(historicalTotal[2] ?? 0);
  policy.forecast_interest_bearing_liabilities = principal.map(
    (repayment, index) => {
      const addition =
        policy.mode === "flat_replacement"
          ? Number(repayment)
          : Number(additions[index] ?? 0);
      total = Math.max(0, total + addition - Number(repayment));
      return round(total * 0.25, 3);
    },
  );
}

function applyLiquidityOverlay(caseData, kind) {
  if (!kind) return;
  const history = caseData.cash_policy.historical_year_end_cash;
  if (kind === "surplus-no-opening-rcf") {
    caseData.rcf_policy.opening_draw = 0;
    const rcf = caseData.instruments.find((item) => item.class === "rcf");
    if (rcf) rcf.opening_balance = 0;
    caseData.cash_policy.minimum_cash_override = Math.min(...history) * 0.25;
  } else if (kind === "surplus-with-opening-rcf") {
    caseData.cash_policy.minimum_cash_override = Math.min(...history) * 0.2;
  } else if (kind === "deficit-with-capacity") {
    caseData.cash_policy.minimum_cash_override = Math.max(...history) * 1.05;
  } else if (kind === "deficit-capacity-bind") {
    caseData.cash_policy.minimum_cash_override = Math.max(...history) * 2.5;
    caseData.rcf_policy.capacity = Math.max(caseData.rcf_policy.opening_draw + 50, caseData.rcf_policy.opening_draw);
    const rcf = caseData.instruments.find((item) => item.class === "rcf");
    if (rcf) rcf.facility_capacity = caseData.rcf_policy.capacity;
  } else if (kind === "mandatory-maturity-deficit") {
    caseData.cash_policy.minimum_cash_override = Math.max(...history) * 1.5;
    const maturity = caseData.instruments.find((item) => item.class !== "rcf");
    if (maturity) maturity.maturity_date = caseData.periods[3].date;
  } else if (kind === "all-states") {
    caseData.cash_policy.minimum_cash_override = Math.max(...history) * 1.1;
    const maturity = caseData.instruments.find((item) => item.class !== "rcf");
    if (maturity) maturity.maturity_date = caseData.periods[4].date;
  }
}

function applyCashBuckets(caseData) {
  const historical = caseData.cash_policy.historical_year_end_cash;
  const opening = caseData.cash_policy.opening_cash;
  const minimum = caseData.cash_policy.minimum_cash_override;
  delete caseData.cash_policy.opening_cash;
  delete caseData.cash_policy.historical_year_end_cash;
  delete caseData.cash_policy.eligible_cash_percentage;
  delete caseData.cash_policy.cash_yield;
  caseData.cash_policy.minimum_cash_override = minimum;
  caseData.cash_policy.buckets = [
    {
      bucket_id: "unrestricted_cash",
      label: "Cash and cash equivalents",
      historical_year_end: historical.map((value) => round(Number(value) * 0.78, 3)),
      forecast_treatment: "balancing",
      available_for_liquidity: true,
      net_debt_eligible_percentage: 1,
      interest_eligible_percentage: 1,
      cash_yield: [0.0325, 0.031, 0.029],
      source_line_ids: ["cf.ending_cash"],
    },
    {
      bucket_id: "restricted_cash",
      label: "Restricted cash",
      historical_year_end: historical.map((value) => round(Number(value) * 0.14, 3)),
      forecast_treatment: "flat",
      available_for_liquidity: false,
      net_debt_eligible_percentage: 0,
      interest_eligible_percentage: 0.25,
      cash_yield: [0.015, 0.014, 0.013],
      source_line_ids: ["cf.restricted_cash"],
    },
    {
      bucket_id: "held_for_sale_cash",
      label: "Cash classified as held for sale",
      historical_year_end: historical.map((value) => round(Number(value) * 0.08, 3)),
      forecast_treatment: "hardcode",
      forecast_values: [round(opening * 0.06, 3), round(opening * 0.04, 3), 0],
      available_for_liquidity: false,
      net_debt_eligible_percentage: 0,
      interest_eligible_percentage: 0,
      cash_yield: [0, 0, 0],
      source_line_ids: ["cf.held_for_sale_cash"],
    },
  ];
}

function applyFxOverlay(caseData, kind) {
  if (["four-currency", "four-currency-foreign-rcf"].includes(kind)) addFourthCurrency(caseData);
  if (kind === "translation-without-cash") {
    const foreign = caseData.instruments.find((item) => item.currency !== caseData.issuer.reporting_currency);
    if (!foreign) throw new Error("Translation-without-cash needs a foreign-currency instrument.");
    foreign.new_issuance = [0, 0, 0];
    foreign.scheduled_amortisation = [0, 0, 0];
    foreign.other_non_cash_movement = [0, 0, 0];
  }
}

function applyAcquisitionOverlay(caseData, value) {
  if (!value || value === "off") {
    caseData.acquisition.enabled = 0;
    return;
  }
  const match = /^year-(\d)-month-(\d+)$/.exec(value);
  if (!match) throw new Error(`Unsupported acquisition overlay ${value}.`);
  caseData.acquisition.enabled = 1;
  caseData.modules.acquisition = true;
  caseData.acquisition.close_year = Number(caseData.periods[2 + Number(match[1])].date.slice(0, 4));
  caseData.acquisition.close_month = Number(match[2]);
  caseData.acquisition.transaction_enterprise_value = 1200;
  caseData.acquisition.entry_ev_to_ebitda = 10;
  caseData.acquisition.acquisition_debt_amount = 600;
  caseData.acquisition.incremental_rate = 0.0525;
}

function makeThreeHouseBrokerPack(caseData, seed) {
  const rng = mulberry32(seed ^ 0xa5a5a5a5);
  // The roster is written in house order for readability, but sealed membership
  // must satisfy scripts/lib/broker_consensus.mjs verifyBrokerConsensusMembership,
  // which requires contributor names to be unique AND canonically sorted. Sort
  // once here so metric.brokers keys and the sealed contributor list share that
  // canonical order; consensus maths averages the included houses, so ordering
  // never moves a synthesised value. (Frozen-cohort defect 1, quarantine
  // frozen-cohort-compiler-membership-order in assets/ci-gate-tiers-v1.json.)
  const names = [
    "Northstar Securities",
    "Harbour Lane Research",
    "Moorland Capital",
  ].sort();
  for (const [metricId, metric] of Object.entries(caseData.broker_pack.metrics)) {
    const compiled = compileBrokerConsensusMetric(caseData, metricId);
    const consensus = compiled.periods.map((period, index) => {
      if (!Number.isFinite(period.model_consensus)) {
        throw new Error(
          `Cannot synthesise ${metricId} period ${index + 1}: ` +
            "no compatible named-house Model Consensus is available.",
        );
      }
      return Number(period.model_consensus);
    });
    metric.brokers = Object.fromEntries(names.map((name, houseIndex) => {
      const offset = (houseIndex - 1) * (0.0125 + rng() * 0.0075);
      return [name, consensus.map((value) => round(value * (1 + offset), Math.abs(value) < 1 ? 4 : 3))];
    }));
    metric.consensus_membership = sealBrokerConsensusMembership({
      schema_version: "broker-consensus-membership/1.0",
      metric_id: metricId,
      contributors: names.map((houseName) => ({
        house_name: houseName,
        status: "included",
        reasons: [],
        definition_signature: structuredClone(metric.definition_signature ?? {}),
        period_status: ["included", "included", "included"],
        period_reasons: [[], [], []],
      })),
    });
  }
  caseData.broker_pack.source_label = "SYNTHETIC TEST DATA — three fictional broker houses generated solely for deterministic Debt Model Unified stress testing. No licensed research or real broker forecast is reproduced or implied.";
}

function rebuildSyntheticEvidence(caseData) {
  const document = `${caseData.issuer.name} deterministic synthetic specification ${COMPILER_VERSION}`;
  const sourceCoverage = {
    status: "complete",
    reviewed_at: "2026-08-02",
    review_evidence: `${document}. The generated specification is the complete source; there is no real issuer, filing or broker research behind any figure.`,
    income_statement: [],
    cash_flow: [],
  };
  const provenance = {};
  for (const section of ["income_statement", "cash_flow"]) {
    for (const [position, statementRow] of caseData.statement_structure[section].entries()) {
      const sourceLineId = `${section === "income_statement" ? "is" : "cf"}.${statementRow.row_id}`;
      statementRow.source_line_ids = [sourceLineId];
      sourceCoverage[section].push({
        source_line_id: sourceLineId,
        label: statementRow.label,
        document,
        page_or_note: `Generated ${section} row ${statementRow.row_id}`,
        face_statement: true,
        material: statementRow.row_type !== "header",
        disposition: "mapped",
        mapped_row_ids: [statementRow.row_id],
        mapping_method: statementRow.row_type === "calculation" ? "derived" : "exact",
        source_position: position,
        classification_status: "accepted",
        classified_role: statementRow.semantic_role ?? statementRow.economic_class ?? null,
        classification_confidence: 1,
        classification_review_status: "auto_accepted",
        classifier_version: COMPILER_VERSION,
      });
      if (Array.isArray(statementRow.values)) {
        const entries = statementRow.values.slice(0, 3).flatMap((value, periodIndex) => value == null ? [] : [{
          period_index: periodIndex,
          document,
          publication_date: "2026-08-02",
          page_or_note: `Generated ${section} row ${statementRow.row_id}`,
          units: `${caseData.issuer.reporting_currency} ${caseData.issuer.units}`,
          source_label: statementRow.label,
          transformation: "Deterministic synthetic fixture; no public-company fact or licensed broker datum.",
        }]);
        if (entries.length) provenance[statementRow.row_id] = entries;
      }
    }
  }
  caseData.source_coverage = sourceCoverage;
  caseData.provenance = provenance;
}

function profileFromRecipe(recipe) {
  return recipe.includes("profile:net-cash") ? "net-cash" : "maximal";
}

function overlayValue(recipe, prefix) {
  return recipe.find((item) => item.startsWith(`${prefix}:`))?.slice(prefix.length + 1) ?? null;
}

export function syntheticCaseId(descriptor) {
  return `synthetic_${descriptor.id.toLowerCase()}_${descriptor.seed}`;
}

function compileCase(descriptor, base, recipe, batch) {
  const caseData = clone(base);
  // This compiler produces deterministic synthetic economic fixtures, not
  // file-led production evidence envelopes. Keep the strict production
  // ingress contract for real runs and exercise the model architecture here
  // through the explicit reference-parity profile.
  caseData.execution_profile = "reference_parity";
  caseData.case_id = syntheticCaseId(descriptor);
  caseData.issuer.name = `Synthetic Batch ${batch} ${descriptor.id} Seed ${descriptor.seed} — ${descriptor.name} (NOT A REAL COMPANY)`;
  caseData.issuer.accounting_basis = descriptor.accounting === "US GAAP" ? "US_GAAP" : "IFRS";
  caseData.modules.historical_normalisation = false;
  delete caseData.historical_entities;
  caseData.acquisition.enabled = 0;
  makeThreeHouseBrokerPack(caseData, descriptor.seed);
  const statementKind = overlayValue(recipe, "statement");
  const cashFlowKind = overlayValue(recipe, "cashflow");
  if (statementKind === "adjusted-ebitda") delete caseData.broker_pack.metrics.ebit;
  if (statementKind === "ebit-only") delete caseData.broker_pack.metrics.adjusted_ebitda;
  for (const statementRow of [
    ...(caseData.statement_structure?.income_statement ?? []),
    ...(caseData.statement_structure?.cash_flow ?? []),
  ]) {
    const brokerMetric =
      statementRow.broker_metric_id ?? statementRow.semantic_role;
    if (
      !brokerMetric ||
      caseData.broker_pack.metrics?.[brokerMetric]
    ) continue;
    delete statementRow.broker_metric_id;
    if (
      (statementRow.forecast_period_authorities ?? []).some(
        (authority) => authority?.method === "broker_consensus",
      )
    ) {
      delete statementRow.forecast_period_authorities;
    }
    if (statementRow.calculation) {
      statementRow.forecast_treatment = "formula";
    }
  }
  const syntheticIncomeRows = caseData.statement_structure?.income_statement ?? [];
  const syntheticEbit = syntheticIncomeRows.find(
    (row) => row.semantic_role === "ebit",
  );
  const syntheticEbitda = syntheticIncomeRows.find(
    (row) => row.semantic_role === "adjusted_ebitda",
  );
  const syntheticDa = syntheticIncomeRows.find(
    (row) => row.semantic_role === "depreciation_and_amortisation",
  );
  if (statementKind === "ebit-only" && syntheticEbit && syntheticEbitda && syntheticDa) {
    syntheticEbit.broker_metric_id = "ebit";
    syntheticEbit.forecast_treatment = "broker";
    delete syntheticEbit.forecast_calculation;
    delete syntheticEbit.forecast_period_calculations;
    syntheticEbitda.forecast_treatment = "formula";
    syntheticEbitda.forecast_calculation = {
      operator: "sum",
      refs: [syntheticEbit.row_id, syntheticDa.row_id],
    };
  }
  if (
    statementKind === "adjusted-ebitda" &&
    syntheticEbit &&
    syntheticEbitda &&
    syntheticDa
  ) {
    syntheticEbitda.broker_metric_id = "adjusted_ebitda";
    syntheticEbitda.forecast_treatment = "broker";
    delete syntheticEbitda.forecast_calculation;
    delete syntheticEbitda.forecast_period_calculations;
    syntheticEbit.forecast_treatment = "formula";
    syntheticEbit.forecast_calculation = {
      operator: "subtract",
      refs: [syntheticEbitda.row_id, syntheticDa.row_id],
    };
  }
  relabelStatement(caseData, statementKind);
  addStatementStressRows(caseData, statementKind, descriptor.seed);
  applyStructuralStatementTopology(caseData, statementKind, descriptor.seed);
  addCashFlowWorkings(caseData, cashFlowKind);
  addCashFlowStressRow(caseData, cashFlowKind, descriptor.seed);
  if (cashFlowKind === "debt-parent-children") addDebtParentChildren(caseData);
  applyDebtOverlay(caseData, overlayValue(recipe, "debt"));
  applyLeaseOverlay(caseData, overlayValue(recipe, "lease"));
  applyLeaseInterestAccounting(caseData, descriptor.seed);
  applyLiquidityOverlay(caseData, overlayValue(recipe, "liquidity"));
  if (recipe.includes("cashflow:cash-buckets")) applyCashBuckets(caseData);
  applyFxOverlay(caseData, overlayValue(recipe, "fx"));
  applyAcquisitionOverlay(caseData, overlayValue(recipe, "acquisition"));
  rebuildSyntheticEvidence(caseData);
  return caseData;
}

function latestEligibleCash(caseData) {
  if (Array.isArray(caseData.cash_policy.buckets)) {
    return caseData.cash_policy.buckets.reduce((sum, bucket) =>
      sum + Number(bucket.historical_year_end[2]) * Number(bucket.net_debt_eligible_percentage), 0);
  }
  return Number(caseData.cash_policy.historical_year_end_cash[2]) * Number(caseData.cash_policy.eligible_cash_percentage);
}

function totalOpeningGrossDebt(caseData) {
  return caseData.instruments
    .filter((instrument) => instrument.include_in_gross_debt)
    .reduce((sum, instrument) => sum + reportingAmount(caseData, instrument), 0);
}

function realisedLiquidityStates(solution, tolerance = 1e-8) {
  const states = [];
  for (const period of solution.forecast ?? []) {
    const opening = Number(period.rcf_opening_native ?? period.opening_rcf ?? 0);
    const capacity = Number(period.rcf_capacity_native ?? 0);
    const draw = Number(period.rcf_draw_native ?? period.rcf_draw ?? 0);
    const repayment = Number(period.rcf_repayment_native ?? period.rcf_repayment ?? 0);
    const ending = Number(period.rcf_ending_native ?? period.ending_rcf ?? 0);
    const shortfall = Number(period.liquidity_shortfall ?? 0);
    const maturity = (period.instrument_results ?? []).reduce(
      (sum, instrument) => sum + Number(instrument.maturity_repayment_native ?? 0),
      0,
    );
    const periodStates = [];
    if (opening <= tolerance && draw <= tolerance && repayment <= tolerance && shortfall <= tolerance) {
      periodStates.push("surplus_no_opening_rcf");
    }
    if (opening > tolerance && repayment > tolerance && shortfall <= tolerance) {
      periodStates.push("surplus_with_opening_rcf");
    }
    if (draw > tolerance && shortfall <= tolerance && ending < capacity - tolerance) {
      periodStates.push("deficit_with_capacity");
    }
    if (shortfall > tolerance && Math.abs(ending - capacity) <= tolerance * Math.max(1, capacity)) {
      periodStates.push("deficit_capacity_bind");
    }
    if (maturity > tolerance && (draw > tolerance || shortfall > tolerance)) {
      periodStates.push("mandatory_maturity_deficit");
    }
    states.push({ period: period.period, states: periodStates });
  }
  return states;
}

function materialConformance(caseData, descriptor, recipe, batch, solution) {
  const checks = [];
  const check = (id, passed, evidence) => checks.push({ id, status: passed ? "PASS" : "FAIL", evidence });
  const statementRows = caseData.statement_structure.income_statement;
  const cashRows = caseData.statement_structure.cash_flow;
  const rowIds = new Set([...statementRows, ...cashRows].map((item) => item.row_id));
  const nonRcf = caseData.instruments.filter((item) => item.class !== "rcf");
  const classes = new Set(caseData.instruments.map((item) => item.class));
  const statement = overlayValue(recipe, "statement");
  const cashFlow = overlayValue(recipe, "cashflow");
  const debt = overlayValue(recipe, "debt");
  const profile = overlayValue(recipe, "profile");
  const accounting = overlayValue(recipe, "accounting");
  const lease = overlayValue(recipe, "lease");
  const liquidity = overlayValue(recipe, "liquidity");
  const fx = overlayValue(recipe, "fx");
  const acquisition = overlayValue(recipe, "acquisition");

  check("identity.seed", caseData.case_id.endsWith(`_${descriptor.seed}`), { case_id: caseData.case_id, seed: descriptor.seed });
  check("identity.batch", caseData.issuer.name.includes(`Synthetic Batch ${batch} `), { issuer: caseData.issuer.name, batch });
  check("identity.accounting", caseData.issuer.accounting_basis === (accounting === "us-gaap" ? "US_GAAP" : "IFRS"), { declared: accounting, emitted: caseData.issuer.accounting_basis });
  check("identity.synthetic", caseData.issuer.name.includes("NOT A REAL COMPANY") && caseData.broker_pack.source_label.startsWith("SYNTHETIC TEST DATA"), { issuer: caseData.issuer.name, broker_label: caseData.broker_pack.source_label });

  const openingNetDebt = totalOpeningGrossDebt(caseData) - latestEligibleCash(caseData);
  check("profile", profile === "net-cash"
    ? caseData.instruments.length <= 2 && caseData.acquisition.enabled === 0 && openingNetDebt < 0
    : caseData.instruments.length > 2 || caseData.acquisition.enabled === 1,
  { profile, instruments: caseData.instruments.length, opening_net_debt: round(openingNetDebt, 6) });

  const statementPrefix = `stress_is_${statement.replaceAll("-", "_")}_`;
  const emittedStatementRows = statementRows.filter((item) => item.row_id.startsWith(statementPrefix));
  let statementPassed = emittedStatementRows.length > 0;
  if (statement === "loss-restatement") {
    const combined = row(caseData, "income_statement", "stress_is_loss_restatement_combined");
    const scopes = new Set(emittedStatementRows.map((item) => item.operation_scope));
    statementPassed = statementPassed && combined?.aggregation_authority === "derived_from_children" && combined.calculation?.refs?.length === 2 && ["continuing", "discontinued", "combined"].every((scope) => scopes.has(scope));
  }
  check("statement", statementPassed, { overlay: statement, row_ids: emittedStatementRows.map((item) => item.row_id) });
  if (["gross-profit", "operating-profit", "jv-impairment-restructuring"].includes(statement)) {
    const operatingRow = row(caseData, "income_statement", "operating_profit");
    const ebitdaRow = row(caseData, "income_statement", "adjusted_ebitda");
    const netIncomeIndex = statementRows.findIndex((item) => item.row_id === "net_income");
    const ebitdaIndex = statementRows.findIndex((item) => item.row_id === "adjusted_ebitda");
    const residual = emittedStatementRows.find((item) => item.row_id.endsWith("_other_operating"));
    const grossProfit = emittedStatementRows.find((item) => item.row_id.endsWith("_gross_profit"));
    const structuralPassed =
      operatingRow?.semantic_role === "ebit" &&
      operatingRow?.aggregation_authority === "reported_parent" &&
      operatingRow?.forecast_treatment === "broker" &&
      !statementRows.some((item) => item.row_id === "ebit") &&
      netIncomeIndex >= 0 &&
      ebitdaIndex > netIncomeIndex &&
      ebitdaRow?.calculation?.operator === "sum" &&
      ebitdaRow.calculation.refs.includes("bridge_operating_profit") &&
      ebitdaRow.calculation.refs.includes("depreciation_and_amortisation") &&
      grossProfit?.calculation?.operator === "sum" &&
      residual?.calculation?.operator === "subtract" &&
      residual.calculation.refs[0] === "operating_profit";
    check("statement.structural_topology", structuralPassed, {
      overlay: statement,
      operating_profit_authority: operatingRow?.aggregation_authority ?? null,
      operating_profit_forecast: operatingRow?.forecast_treatment ?? null,
      ebitda_position: ebitdaIndex,
      net_income_position: netIncomeIndex,
      legacy_ebit_row_present: statementRows.some((item) => item.row_id === "ebit"),
      detail_rows: emittedStatementRows.map((item) => item.row_id),
      residual_refs: residual?.calculation?.refs ?? [],
    });
  }
  const headlineRules = {
    revenue: /revenue|turnover/i,
    operating_profit: /operating profit|operating loss|\bebit\b/i,
    pre_tax_income: /profit before|loss before/i,
    net_income: /profit after|profit for|loss for/i,
  };
  const incompatibleHeadlines = Object.entries(headlineRules).flatMap(([rowId, pattern]) => {
    const target = row(caseData, "income_statement", rowId);
    return target && !pattern.test(target.label) ? [{ row_id: rowId, label: target.label }] : [];
  });
  check("statement.headline_semantics", incompatibleHeadlines.length === 0, { incompatible: incompatibleHeadlines });

  let cashFlowPassed = false;
  let cashFlowEvidence = {};
  if (cashFlow === "standard") {
    const required = ["cash_from_operations", "cash_from_investing", "cash_from_financing", "ending_cash"];
    cashFlowPassed = required.every((id) => rowIds.has(id));
    cashFlowEvidence = { row_ids: required };
  } else if (["working-capital", "wc-parent-three-children"].includes(cashFlow)) {
    const required = ["wc_receivables", "wc_inventory", "wc_payables"];
    cashFlowPassed = required.every((id) => rowIds.has(id));
    cashFlowEvidence = { row_ids: required };
  } else if (cashFlow === "wc-derived-unusual") {
    const parent = row(caseData, "cash_flow", "change_in_working_capital");
    cashFlowPassed = parent?.aggregation_authority === "derived_from_children" && parent.calculation?.refs?.length === 3;
    cashFlowEvidence = { parent: parent?.row_id, refs: parent?.calculation?.refs };
  } else if (cashFlow === "wc-interleaved") {
    const workingChildren = cashRows.filter((item) => item.parent_row_id === "change_in_working_capital");
    const nearbyAdjustments = ["wc_provisions_working", "wc_pensions_working", "wc_restructuring_working"]
      .map((id) => row(caseData, "cash_flow", id));
    cashFlowPassed =
      workingChildren.length === 3 &&
      workingChildren.every((item) => item.economic_class === "working_capital") &&
      nearbyAdjustments.every((item) => item && !item.parent_row_id && item.aggregation_role === "standalone");
    cashFlowEvidence = {
      working_children: workingChildren.map((item) => item.row_id),
      nearby_standalone_adjustments: nearbyAdjustments.map((item) => item?.row_id ?? null),
    };
  } else if (cashFlow === "wc-reported-parent") {
    const parent = row(caseData, "cash_flow", "change_in_working_capital");
    cashFlowPassed = parent?.aggregation_authority === "standalone" && Array.isArray(parent.values);
    cashFlowEvidence = { parent: parent?.row_id, authority: parent?.aggregation_authority };
  } else if (["non-cash-stack", "classification-stress", "long"].includes(cashFlow)) {
    const detail = cashRows.filter((item) => item.row_id.startsWith("cf_"));
    const cashGenerated = row(caseData, "cash_flow", "cash_generated_from_operations");
    cashFlowPassed =
      detail.length >= 3 &&
      detail.every((item) =>
        cashGenerated?.calculation?.refs?.includes(item.row_id)
      );
    cashFlowEvidence = {
      row_ids: detail.map((item) => item.row_id),
      cash_generated_refs: cashGenerated?.calculation?.refs ?? [],
    };
  } else if (cashFlow === "multi-category-capex") {
    const required = ["capex_maintenance", "capex_growth", "capex_intangible"];
    cashFlowPassed = required.every((id) => rowIds.has(id));
    cashFlowEvidence = { row_ids: required };
  } else if (cashFlow === "cash-buckets") {
    const reportedHistory = caseData.cash_policy.buckets?.reduce(
      (totals, bucket) => totals.map((value, index) => round(value + Number(bucket.historical_year_end[index]), 3)),
      [0, 0, 0],
    );
    const ending = row(caseData, "cash_flow", "ending_cash");
    cashFlowPassed = caseData.cash_policy.buckets?.length === 3 &&
      JSON.stringify(ending?.values?.slice(0, 3)) === JSON.stringify(reportedHistory);
    cashFlowEvidence = {
      buckets: caseData.cash_policy.buckets?.map((bucket) => bucket.bucket_id),
      reported_history: reportedHistory,
      cfs_ending_cash_history: ending?.values?.slice(0, 3),
    };
  } else if (cashFlow === "cash-sweep") {
    const canonical = row(caseData, "cash_flow", "rcf_repayment");
    const duplicates = cashRows.filter((item) =>
      item.row_id !== "rcf_repayment" &&
      (item.semantic_role === "rcf_repayment" || item.movement_type === "rcf_repayment"),
    );
    cashFlowPassed = canonical?.label === "Excess cash applied to revolving credit facility" && duplicates.length === 0;
    cashFlowEvidence = { canonical_row: canonical?.row_id, duplicates: duplicates.map((item) => item.row_id) };
  } else if (cashFlow === "financing-detail") {
    const canonical = row(caseData, "cash_flow", "debt_repayment");
    cashFlowPassed = canonical?.label === "Other cash repayment of borrowings";
    cashFlowEvidence = { canonical_row: canonical?.row_id, label: canonical?.label };
  } else if (cashFlow === "short-term-financing") {
    const canonical = row(caseData, "cash_flow", "debt_issuance");
    cashFlowPassed = canonical?.label === "Commercial paper issuance/(repayment)";
    cashFlowEvidence = { canonical_row: canonical?.row_id, label: canonical?.label };
  } else if (cashFlow === "refinancing") {
    const canonical = row(caseData, "cash_flow", "debt_issuance");
    cashFlowPassed = canonical?.label === "Standalone refinancing proceeds";
    cashFlowEvidence = { canonical_row: canonical?.row_id, label: canonical?.label };
  } else if (cashFlow === "debt-parent-children") {
    const parent = row(caseData, "cash_flow", "stress_cf_debt_movement_parent");
    const children = cashRows.filter((item) => item.parent_row_id === parent?.row_id);
    cashFlowPassed = parent?.aggregation_authority === "reported_parent" && children.length === 2 && children.every((item) => item.aggregation_role === "working_child");
    cashFlowEvidence = { parent: parent?.row_id, children: children.map((item) => item.row_id) };
  } else {
    const marker = `stress_cf_${cashFlow.replaceAll("-", "_")}`;
    cashFlowPassed = rowIds.has(marker);
    cashFlowEvidence = { row_id: marker };
  }
  check("cash_flow", cashFlowPassed, { overlay: cashFlow, ...cashFlowEvidence });

  const lastForecast = caseData.periods[5].date;
  const debtPredicates = {
    "large-book": () => caseData.instruments.length >= 20,
    amortising: () => nonRcf.some((item) => item.scheduled_amortisation?.some((value) => Number(value) > 0)),
    "levfin-pik-floor": () => nonRcf.some((item) => item.pik_rate?.some((value) => Number(value) > 0) && item.benchmark_floor?.some((value) => Number(value) > 0)),
    simple: () => caseData.instruments.length <= 3,
    sparse: () => caseData.instruments.length <= 3 && totalOpeningGrossDebt(caseData) < 1000,
    low: () => totalOpeningGrossDebt(caseData) < 1000,
    mixed: () => classes.size >= 4,
    "long-dated": () => nonRcf.some((item) => item.rate_type === "fixed" && item.maturity_date > lastForecast) && nonRcf.some((item) => item.rate_type === "floating" && item.maturity_date > lastForecast),
    "commercial-paper-backstop": () => classes.has("commercial_paper") && caseData.instruments.some((item) => item.class === "rcf" && Number(item.facility_capacity) > 0),
    refinancing: () => nonRcf.some((item) => item.new_issuance?.some((value) => Number(value) > 0)),
    "all-movement-classes": () => nonRcf.some((item) => item.pik_rate && item.non_cash_movement_components?.fair_value && item.non_cash_movement_components?.other),
  };
  check("debt", Boolean(debtPredicates[debt]?.()), { overlay: debt, instruments: caseData.instruments.length, classes: [...classes].sort(), opening_gross_debt: round(totalOpeningGrossDebt(caseData), 6) });

  if (lease) check("lease", caseData.lease_policy.mode === lease.replaceAll("-", "_"), { overlay: lease, mode: caseData.lease_policy.mode });
  if (liquidity) {
    const history = caseData.cash_policy.historical_year_end_cash ?? caseData.cash_policy.buckets?.[0]?.historical_year_end ?? [0, 0, 0];
    const maximumHistory = Math.max(...history);
    const predicates = {
      "surplus-no-opening-rcf": () => Number(caseData.rcf_policy.opening_draw) === 0 && Number(caseData.cash_policy.minimum_cash_override) < maximumHistory,
      "surplus-with-opening-rcf": () => Number(caseData.rcf_policy.opening_draw) > 0 && Number(caseData.cash_policy.minimum_cash_override) < maximumHistory,
      "deficit-with-capacity": () => Number(caseData.cash_policy.minimum_cash_override) > maximumHistory && Number(caseData.rcf_policy.capacity) > Number(caseData.rcf_policy.opening_draw),
      "deficit-capacity-bind": () => Number(caseData.cash_policy.minimum_cash_override) > maximumHistory * 2 && Number(caseData.rcf_policy.capacity) - Number(caseData.rcf_policy.opening_draw) <= 50,
      "mandatory-maturity-deficit": () => Number(caseData.cash_policy.minimum_cash_override) > maximumHistory && nonRcf.some((item) => item.maturity_date === caseData.periods[3].date),
      "all-states": () => {
        const realised = new Set(realisedLiquidityStates(solution).flatMap((period) => period.states));
        return ["deficit_with_capacity", "deficit_capacity_bind", "mandatory_maturity_deficit"]
          .every((state) => realised.has(state));
      },
    };
    check("liquidity", Boolean(predicates[liquidity]?.()), {
      overlay: liquidity,
      minimum_cash: caseData.cash_policy.minimum_cash_override,
      capacity: caseData.rcf_policy.capacity,
      opening_draw: caseData.rcf_policy.opening_draw,
      realised_states: realisedLiquidityStates(solution),
    });
  }
  if (fx) {
    const currencies = new Set(caseData.instruments.map((item) => item.currency));
    let passed = fx === "multi-currency" && currencies.size >= 3;
    if (fx === "four-currency") passed = currencies.size >= 4 && Boolean(caseData.fx?.CHF);
    if (fx === "four-currency-foreign-rcf") {
      const rcf = caseData.instruments.find((item) => item.class === "rcf");
      const curve = caseData.fx?.[rcf?.currency];
      const nonUnit = [...(curve?.average_rates ?? []), ...(curve?.period_end_rates ?? [])].some((rate) => Math.abs(Number(rate) - 1) > 1e-9);
      const changing = new Set(curve?.period_end_rates ?? []).size > 1;
      const distinctBases = (curve?.average_rates ?? []).some((rate, index) => Math.abs(Number(rate) - Number(curve?.period_end_rates?.[index])) > 1e-9);
      const solvedMovement = solution?.forecast?.some((period) => Math.abs(Number(period.rcf_fx_non_cash_movement)) > 1e-9);
      passed = currencies.size >= 4 && rcf?.currency !== caseData.issuer.reporting_currency && curve?.average_rates?.length === 6 && curve?.period_end_rates?.length === 6 && nonUnit && changing && distinctBases && solvedMovement;
    }
    if (fx === "translation-without-cash") passed = nonRcf.some((item) => item.currency !== caseData.issuer.reporting_currency && item.new_issuance.every((value) => Number(value) === 0) && item.scheduled_amortisation.every((value) => Number(value) === 0) && new Set(caseData.fx[item.currency].period_end_rates).size > 1);
    check("fx", passed, { overlay: fx, currencies: [...currencies].sort() });
  }
  if (acquisition) {
    const expected = acquisition === "off" ? 0 : 1;
    check("acquisition", caseData.acquisition.enabled === expected && (expected === 0 || caseData.periods.some((period) => Number(period.date.slice(0, 4)) === caseData.acquisition.close_year)), { overlay: acquisition, enabled: caseData.acquisition.enabled, close_year: caseData.acquisition.close_year, close_month: caseData.acquisition.close_month });
  }
  const brokerNames = new Set(Object.values(caseData.broker_pack.metrics).flatMap((metric) => Object.keys(metric.brokers)));
  check("broker_ledger", brokerNames.size === 3 && [...brokerNames].every((name) => ["Northstar Securities", "Harbour Lane Research", "Moorland Capital"].includes(name)), { brokers: [...brokerNames].sort() });
  check("source_ledger", caseData.source_coverage.status === "complete" && Object.values(caseData.provenance).flat().every((entry) => entry.transformation?.includes("synthetic fixture")), { source_status: caseData.source_coverage.status, provenance_rows: Object.keys(caseData.provenance).length });
  return { status: checks.every((item) => item.status === "PASS") ? "PASS" : "FAIL", checks };
}

function validateManifest(manifest, recipeMap) {
  const errors = [];
  if (manifest?.schema !== "debt-model-unified/synthetic-stress-manifest/1") {
    errors.push("Unsupported or missing synthetic stress manifest schema.");
  }
  const cases = Array.isArray(manifest?.cases) ? manifest.cases : [];
  const ids = cases.map((item) => item.id);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
  if (duplicates.length) errors.push(`Duplicate case IDs: ${duplicates.join(", ")}.`);
  const missing = EXPECTED_IDS.filter((id) => !ids.includes(id));
  const unexpected = ids.filter((id) => !EXPECTED_IDS.includes(id));
  if (missing.length) errors.push(`Missing case IDs: ${missing.join(", ")}.`);
  if (unexpected.length) errors.push(`Unexpected case IDs: ${unexpected.join(", ")}.`);
  const seeds = cases.map((item) => item.seed);
  const duplicateSeeds = [...new Set(seeds.filter((seed, index) => seeds.indexOf(seed) !== index))].sort((a, b) => a - b);
  if (duplicateSeeds.length) errors.push(`Duplicate case seeds: ${duplicateSeeds.join(", ")}.`);
  for (const item of cases) {
    if (!Number.isInteger(item.seed)) errors.push(`${item.id ?? "unknown"} needs an integer seed.`);
    if (!recipeMap[item.id]) errors.push(`${item.id ?? "unknown"} has no compiler recipe.`);
  }
  const batchIds = (manifest.batches ?? []).flatMap((batch) => batch.cases ?? []);
  for (const id of EXPECTED_IDS) {
    const count = batchIds.filter((candidate) => candidate === id).length;
    if (count !== 1) errors.push(`${id} must appear in exactly one batch; found ${count}.`);
  }
  for (const id of EXPECTED_IDS) {
    const recipe = recipeMap[id] ?? [];
    const unknown = recipe.filter((token) => !SUPPORTED_RECIPE_TOKENS.has(token));
    if (unknown.length) errors.push(`${id} has unsupported recipe token(s): ${unknown.join(", ")}.`);
    for (const prefix of ["profile", "accounting", "statement", "cashflow", "debt"]) {
      const count = recipe.filter((token) => token.startsWith(`${prefix}:`)).length;
      if (count !== 1) errors.push(`${id} must declare exactly one ${prefix} overlay; found ${count}.`);
    }
  }
  return errors;
}

export async function compileSyntheticCohort({ manifestPath, basesDirectory, outputDirectory, recipeMap = SYNTHETIC_CASE_RECIPES }) {
  if (!basesDirectory) throw new Error("basesDirectory is required; deterministic compilation never guesses an authority input.");
  const manifestBytes = await fs.readFile(path.resolve(manifestPath));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const manifestErrors = validateManifest(manifest, recipeMap);
  if (manifestErrors.length) throw new Error(manifestErrors.join("\n"));

  const maximalPath = path.join(path.resolve(basesDirectory), "standard-maximal-v2.json");
  const netCashPath = path.join(path.resolve(basesDirectory), "standard-net-cash-v2.json");
  const schemaPath = fileURLToPath(new URL("../assets/model-case-v2.schema.json", import.meta.url));
  const [maximalBytes, netCashBytes, schemaBytes] = await Promise.all([fs.readFile(maximalPath), fs.readFile(netCashPath), fs.readFile(schemaPath)]);
  const bases = {
    maximal: JSON.parse(maximalBytes.toString("utf8")),
    "net-cash": JSON.parse(netCashBytes.toString("utf8")),
  };
  if (bases.maximal.case_id !== "standard_maximal" || bases["net-cash"].case_id !== "standard_net_cash") {
    throw new Error("Authority identity mismatch: expected standard_maximal and standard_net_cash base cases.");
  }
  const out = path.resolve(outputDirectory);
  const batchByCase = Object.fromEntries((manifest.batches ?? []).flatMap((batch) => (batch.cases ?? []).map((id) => [id, batch.id])));
  const entries = [];
  const caseArtifacts = [];

  for (const descriptor of [...manifest.cases].sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)))) {
    const recipe = recipeMap[descriptor.id];
    const profile = profileFromRecipe(recipe);
    const caseData = compileCase(descriptor, bases[profile], recipe, batchByCase[descriptor.id]);
    const shapeErrors = validateCaseShape(caseData);
    if (shapeErrors.length) throw new Error(`${descriptor.id} failed case validation:\n${shapeErrors.join("\n")}`);
    const coverage = assessCoverage(caseData);
    if (!coverage.ready_to_build) {
      throw new Error(`${descriptor.id} is not coverage-ready:\n${JSON.stringify(coverage, null, 2)}`);
    }
    const solution = solveCase(caseData);
    if (!solution.converged || !solution.all_checks_pass) {
      throw new Error(
        `${descriptor.id} failed the independent economic solve:\n${JSON.stringify({
          converged: solution.converged,
          all_checks_pass: solution.all_checks_pass,
          iterations: solution.iterations,
          residual: solution.residual,
        }, null, 2)}`,
      );
    }
    const liquidityOverlay = overlayValue(recipe, "liquidity");
    if (
      ["deficit-capacity-bind", "mandatory-maturity-deficit", "all-states"]
        .includes(liquidityOverlay)
    ) {
      acknowledgeSyntheticLiquidityStress(caseData, solution);
    }
    const conformance = materialConformance(caseData, descriptor, recipe, batchByCase[descriptor.id], solution);
    if (conformance.status !== "PASS") {
      throw new Error(`${descriptor.id} failed descriptor/recipe conformance:\n${JSON.stringify(conformance, null, 2)}`);
    }
    const filename = `${descriptor.id.toLowerCase()}-${descriptor.seed}.json`;
    const bytes = Buffer.from(stableJson(caseData));
    const realisedStates = realisedLiquidityStates(solution);
    caseArtifacts.push({ filename, bytes, caseData, solution, realisedStates });
    entries.push({
      id: descriptor.id,
      case_id: caseData.case_id,
      seed: descriptor.seed,
      batch: batchByCase[descriptor.id],
      filename: `cases/${filename}`,
      sha256: sha256(bytes),
      bytes: bytes.length,
      profile,
      accounting: descriptor.accounting,
      overlays: recipe.filter((item) => !item.startsWith("profile:") && !item.startsWith("accounting:")),
      coverage_status: coverage.status,
      selected_forecast_anchor: coverage.selected_forecast_anchor,
      ready_to_build: coverage.ready_to_build,
      solver_pass: true,
      descriptor_conformance: conformance,
      realised_liquidity_states: realisedStates,
    });
  }

  const requiredLiquidity = (manifest.scenario_overlays?.liquidity ?? []).map((item) => item.replaceAll("_", "-"));
  const emittedLiquidity = new Set(Object.values(recipeMap).map((recipe) => overlayValue(recipe, "liquidity")).filter(Boolean));
  const missingLiquidity = requiredLiquidity.filter((item) => !emittedLiquidity.has(item));
  if (missingLiquidity.length) throw new Error(`Cohort omits required liquidity overlay(s): ${missingLiquidity.join(", ")}.`);
  const acquisitionCases = caseArtifacts.filter(({ caseData }) => caseData.acquisition.enabled === 1).map(({ caseData }) => caseData.acquisition);
  const missingCloseYears = (manifest.scenario_overlays?.acquisition?.close_years ?? []).filter((yearIndex) => !acquisitionCases.some((item) => item.close_year === Number(caseArtifacts[0].caseData.periods[2 + yearIndex].date.slice(0, 4))));
  const missingCloseMonths = (manifest.scenario_overlays?.acquisition?.close_months ?? []).filter((month) => !acquisitionCases.some((item) => item.close_month === month));
  if (missingCloseYears.length || missingCloseMonths.length) throw new Error(`Cohort omits acquisition close dimensions: years ${missingCloseYears.join(",") || "none"}; months ${missingCloseMonths.join(",") || "none"}.`);

  const brokerLedger = {
    schema: "debt-model-unified/synthetic-broker-ledger/1",
    compiler_version: COMPILER_VERSION,
    cases: caseArtifacts.map(({ caseData }) => ({
      case_id: caseData.case_id,
      source_label: caseData.broker_pack.source_label,
      houses: [...new Set(Object.values(caseData.broker_pack.metrics).flatMap((metric) => Object.keys(metric.brokers)))].sort(),
      metrics: Object.keys(caseData.broker_pack.metrics).sort(),
    })),
  };
  const sourceLedger = {
    schema: "debt-model-unified/synthetic-source-ledger/1",
    compiler_version: COMPILER_VERSION,
    cases: caseArtifacts.map(({ caseData }) => ({
      case_id: caseData.case_id,
      source_status: caseData.source_coverage.status,
      source_document: caseData.source_coverage.review_evidence,
      income_statement_lines: caseData.source_coverage.income_statement.length,
      cash_flow_lines: caseData.source_coverage.cash_flow.length,
      provenance_rows: Object.keys(caseData.provenance).length,
    })),
  };
  const brokerLedgerBytes = Buffer.from(stableJson(brokerLedger));
  const sourceLedgerBytes = Buffer.from(stableJson(sourceLedger));
  const emittedCases = caseArtifacts.map((item) => item.caseData);
  const emittedInstruments = emittedCases.flatMap((item) => item.instruments.map((instrument) => ({ caseData: item, instrument })));
  const realisedLiquidityEvidence = Object.fromEntries(requiredLiquidity.map((state) => [
    state.replaceAll("-", "_"),
    caseArtifacts.flatMap(({ caseData, realisedStates }) => realisedStates.flatMap((period) =>
      period.states.includes(state.replaceAll("-", "_"))
        ? [{ case_id: caseData.case_id, period: period.period }]
        : [],
    )),
  ]));
  const missingRealisedLiquidity = Object.entries(realisedLiquidityEvidence)
    .filter(([, evidence]) => evidence.length === 0)
    .map(([state]) => state);
  if (missingRealisedLiquidity.length) {
    throw new Error(`Cohort assigns but does not economically realise liquidity state(s): ${missingRealisedLiquidity.join(", ")}.`);
  }
  const manifestConformance = {
    status: "ACCOUNTED",
    case_material_status: "PASS",
    dimensions: {
      liquidity: Object.fromEntries(requiredLiquidity.map((overlay) => [overlay, emittedLiquidity.has(overlay)])),
      liquidity_realised: realisedLiquidityEvidence,
      leases: Object.fromEntries((manifest.scenario_overlays?.leases ?? []).map((mode) => [mode, emittedCases.some((item) => item.lease_policy.mode === mode)])),
      fx: {
        foreign_fixed_debt: emittedInstruments.some(({ caseData, instrument }) => instrument.currency !== caseData.issuer.reporting_currency && instrument.rate_type === "fixed"),
        foreign_floating_debt: emittedInstruments.some(({ caseData, instrument }) => instrument.currency !== caseData.issuer.reporting_currency && instrument.rate_type === "floating"),
        foreign_rcf_capacity: emittedInstruments.some(({ caseData, instrument }) => instrument.class === "rcf" && instrument.currency !== caseData.issuer.reporting_currency && caseData.fx?.[instrument.currency]?.average_rates?.length === 6 && caseData.fx?.[instrument.currency]?.period_end_rates?.length === 6),
        translation_without_cash_movement: emittedInstruments.some(({ caseData, instrument }) => instrument.currency !== caseData.issuer.reporting_currency && instrument.class !== "rcf" && instrument.new_issuance.every((value) => Number(value) === 0) && instrument.scheduled_amortisation.every((value) => Number(value) === 0) && new Set(caseData.fx[instrument.currency].period_end_rates).size > 1),
        at_least_four_currencies: emittedCases.some((item) => new Set(item.instruments.map((instrument) => instrument.currency)).size >= 4),
      },
      acquisition: {
        enabled_states: [0, 1].every((state) => emittedCases.some((item) => item.acquisition.enabled === state)),
        close_years: Object.fromEntries((manifest.scenario_overlays?.acquisition?.close_years ?? []).map((yearIndex) => [yearIndex, acquisitionCases.some((item) => item.close_year === Number(emittedCases[0].periods[2 + yearIndex].date.slice(0, 4)))])),
        close_months: Object.fromEntries((manifest.scenario_overlays?.acquisition?.close_months ?? []).map((month) => [month, acquisitionCases.some((item) => item.close_month === month)])),
      },
      broker_anchor: {
        majority_basis: entries.some((item) => item.selected_forecast_anchor === "adjusted_ebitda"),
        exact_tie_falls_back_to_ebit: entries.some((item) => item.selected_forecast_anchor === "ebit"),
        unsupported_anchor_rejected: "negative_test_required",
      },
      opening_debt_reconciliation: {
        identified_below_reported: emittedCases.some((item) => item.instruments.some((instrument) => instrument.is_residual_pool && Number(instrument.opening_balance) > 0)),
        identified_above_reported: "negative_test_required",
      },
      restoration_sequences: "controller_and_native_excel_required",
      invalid_acquisition_inputs: "negative_test_required",
    },
    unproven: [
      {
        descriptor: "scenario_overlays.restoration_sequences",
        reason: "Case JSON can carry the controls, but only the frozen cohort controller and native Excel can execute and prove state restoration sequences.",
      },
    ],
  };

  const index = {
    schema: "debt-model-unified/synthetic-cohort-index/1",
    compiler_version: COMPILER_VERSION,
    manifest: { filename: path.basename(manifestPath), sha256: sha256(manifestBytes) },
    bases: {
      maximal: { filename: "standard-maximal-v2.json", sha256: sha256(maximalBytes) },
      net_cash: { filename: "standard-net-cash-v2.json", sha256: sha256(netCashBytes) },
    },
    case_schema: { filename: "model-case-v2.schema.json", sha256: sha256(schemaBytes) },
    ledgers: {
      broker: { filename: "synthetic-broker-ledger.json", sha256: sha256(brokerLedgerBytes) },
      source: { filename: "synthetic-source-ledger.json", sha256: sha256(sourceLedgerBytes) },
    },
    manifest_conformance: manifestConformance,
    generation_policy: {
      deterministic: true,
      fixed_publication_date: "2026-08-02",
      fictional_broker_houses: ["Northstar Securities", "Harbour Lane Research", "Moorland Capital"],
      source_edits_during_cohort: "forbidden",
      raw_xlsx_byte_identity_claimed: false,
    },
    summary: {
      expected_cases: 32,
      emitted_cases: entries.length,
      schema_valid: entries.length,
      coverage_ready: entries.filter((item) => item.ready_to_build).length,
      solver_pass: entries.filter((item) => item.solver_pass).length,
      descriptor_conformance: entries.filter((item) => item.descriptor_conformance.status === "PASS").length,
      manifest_case_material_unproven: 0,
      profiles: Object.fromEntries(["maximal", "net-cash"].map((profile) => [profile, entries.filter((item) => item.profile === profile).length])),
    },
    cases: entries,
    negative_contracts: [
      { id: "duplicate_case_id", expected: "compiler refuses before writing cases" },
      { id: "missing_case_id", expected: "compiler refuses before writing cases" },
      { id: "unsupported_acquisition_anchor", expected: "coverage or case gate blocks" },
      { id: "identified_debt_above_reported", expected: "opening-debt reconciliation blocks" },
    ],
  };
  const indexBytes = Buffer.from(stableJson(index));
  await fs.mkdir(path.join(out, "cases"), { recursive: true });
  for (const artifact of caseArtifacts) await fs.writeFile(path.join(out, "cases", artifact.filename), artifact.bytes);
  await fs.writeFile(path.join(out, "synthetic-broker-ledger.json"), brokerLedgerBytes);
  await fs.writeFile(path.join(out, "synthetic-source-ledger.json"), sourceLedgerBytes);
  await fs.writeFile(path.join(out, "cohort-index.json"), indexBytes);
  const [manifestAfter, maximalAfter, netCashAfter, schemaAfter] = await Promise.all([
    fs.readFile(path.resolve(manifestPath)),
    fs.readFile(maximalPath),
    fs.readFile(netCashPath),
    fs.readFile(schemaPath),
  ]);
  if (sha256(manifestAfter) !== sha256(manifestBytes) || sha256(maximalAfter) !== sha256(maximalBytes) || sha256(netCashAfter) !== sha256(netCashBytes) || sha256(schemaAfter) !== sha256(schemaBytes)) {
    throw new Error("A frozen compiler input changed during cohort generation; emitted output is invalid.");
  }
  return { index, indexBytes };
}

function usage() {
  process.stderr.write("Usage: compile_synthetic_cohort.mjs <manifest.json> --bases <case-dir> --out <output-dir>\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const manifestPath = args[0];
  const basesIndex = args.indexOf("--bases");
  const outputIndex = args.indexOf("--out");
  if (!manifestPath || basesIndex < 0 || !args[basesIndex + 1] || outputIndex < 0 || !args[outputIndex + 1]) {
    usage();
    process.exitCode = 2;
  } else {
    try {
      const result = await compileSyntheticCohort({
        manifestPath,
        basesDirectory: args[basesIndex + 1],
        outputDirectory: args[outputIndex + 1],
      });
      process.stdout.write(`${JSON.stringify({ status: "PASS", ...result.index.summary }, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error.stack ?? String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
