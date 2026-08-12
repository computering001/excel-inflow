#!/usr/bin/env node
/**
 * The β safety keel: for every certification-cohort case, derive the
 * case-source + sealed evidence lanes that WOULD have produced it, run
 * compile_case, and diff the compiled model-case against the certified one.
 *
 * The derivation is the inverse of the compiler's projection:
 *   - face-statement manifests from source_coverage + row historicals
 *     (hierarchy reconstructed from the certified subtotal calculations)
 *   - statement_map from source_coverage dispositions + row roles
 *   - policy selections split out of the certified policy objects; numeric
 *     assumptions become receipted `derived.*` answers
 *   - every other lane passes through sealed.
 *
 * Equality target: the compiled case must equal the certified case, or differ
 * only in named, justified ways (the harness prints every path difference so
 * nothing differs silently).
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { compileCase } from "./lib/case_compiler.mjs";
import { faceStatementManifestDigest } from "./lib/face_statement_manifest.mjs";
import { compileRowPlan } from "./lib/row_plan.mjs";
import { solveCase } from "./lib/solver.mjs";
import { hashValue } from "./lib/run_store.mjs";

const casesDirectory = path.resolve(
  process.argv[2] ?? "/Users/archiepreston/Documents/Codex/2026-07-24/ok/work/v2-certification/cases",
);
const onlyCase = process.argv[3] ?? null;
const clone = (value) => structuredClone(value);
const hash = (character) => character.repeat(64);

/** filed lines for one section, with hierarchy recovered from subtotal refs */
function deriveFiledLines(modelCase, section) {
  // Cross-section index: CF recipe rows (links to IS quantities) must resolve
  // through the whole graph when reconstructing filed values.
  const rowsById = new Map(
    [
      ...modelCase.statement_structure.income_statement,
      ...modelCase.statement_structure.cash_flow,
    ].map((row) => [row.row_id, row]),
  );
  const sectionRowIds = new Set(
    modelCase.statement_structure[section].map((row) => row.row_id),
  );
  const coverage = modelCase.source_coverage[section];
  const lineByRowId = new Map();
  for (const entry of coverage) {
    const primary = entry.mapped_row_ids?.[0];
    if (primary && !lineByRowId.has(primary)) lineByRowId.set(primary, entry.source_line_id);
  }
  // Parent linkage: a mapped sum-subtotal's filed children are found by
  // flattening its refs THROUGH unmapped intermediate rows (the model may
  // interpose derived aggregates like change_in_working_capital between a
  // filed total and its filed children — the filings themselves are flat).
  const flattenChildren = (row, seen = new Set()) => {
    if (!row?.calculation?.refs || seen.has(row.row_id)) return [];
    seen.add(row.row_id);
    return row.calculation.refs.flatMap((ref) => {
      if (lineByRowId.has(ref)) return [ref];
      if (!sectionRowIds.has(ref)) return [];
      const child = rowsById.get(ref);
      if (child?.calculation?.operator === "sum") return flattenChildren(child, seen);
      return [];
    });
  };
  const parentOfLine = new Map();
  // Aggregation stamps carry parentage the calculation graph does not: a
  // reported-parent aggregate (e.g. the WC block) has no formula, but its
  // children name it via parent_row_id.
  for (const entry of coverage) {
    const row = rowsById.get(entry.mapped_row_ids?.[0]);
    if (row?.aggregation_role !== "working_child") continue;
    const parentLine = row?.parent_row_id ? lineByRowId.get(row.parent_row_id) : null;
    if (parentLine && parentLine !== entry.source_line_id && !parentOfLine.has(entry.source_line_id)) {
      parentOfLine.set(entry.source_line_id, parentLine);
    }
  }
  for (const entry of coverage) {
    const row = rowsById.get(entry.mapped_row_ids?.[0]);
    if (row?.calculation?.operator !== "sum" || !row.calculation.refs?.length) continue;
    // A filed EBITDA memo's refs are COMPILED bridge members, not filed
    // parentage — the filings print it above operating profit without
    // enclosing anything.  Treating it as a hierarchy parent would steal
    // operating profit from the PBT subtotal that really encloses it.
    if (row.semantic_role === "adjusted_ebitda") continue;
    for (const childRowId of flattenChildren(row)) {
      const childLine = lineByRowId.get(childRowId);
      if (childLine && childLine !== entry.source_line_id && !parentOfLine.has(childLine)) {
        parentOfLine.set(childLine, entry.source_line_id);
      }
    }
  }
  // Historical values for filed subtotals: the filings print them, but the
  // certified case dropped them in favour of the formula — reconstruct by
  // evaluating the certified graph over the historical columns.
  const histCache = new Map();
  const historicalOf = (rowId, period, seen = new Set()) => {
    const key = `${rowId}:${period}`;
    if (histCache.has(key)) return histCache.get(key);
    if (seen.has(rowId)) return null;
    seen.add(rowId);
    const row = rowsById.get(rowId);
    if (!row) return null;
    let result = null;
    const raw = row.values?.[period];
    if (raw !== null && raw !== undefined && Number.isFinite(Number(raw))) {
      result = Number(raw);
    } else if (row.calculation?.refs) {
      const parts = row.calculation.refs.map((ref) => historicalOf(ref, period, seen));
      const nums = parts.map((value) => Number(value ?? 0));
      switch (row.calculation.operator) {
        case "sum": result = nums.reduce((total, value) => total + value, 0); break;
        case "link": result = nums[0] ?? null; break;
        case "negate": result = -(nums[0] ?? 0); break;
        case "negate_sum": result = -nums.reduce((total, value) => total + value, 0); break;
        case "subtract": result = nums.slice(1).reduce((value, item) => value - item, nums[0] ?? 0); break;
        default: result = null;
      }
      if (result !== null && parts.every((value) => value === null)) result = null;
    }
    histCache.set(key, result);
    return result;
  };
  const aggregatedSeen = new Set();
  const parentLineIds = new Set(parentOfLine.values());
  const lines = coverage.map((entry) => {
    // An expansion-group line prints the GROUP TOTAL — its last row.
    const valueRowId = (entry.mapped_row_ids ?? []).length > 1
      ? entry.mapped_row_ids.at(-1)
      : entry.mapped_row_ids?.[0];
    const row = rowsById.get(valueRowId);
    let values = (row?.values ?? [null, null, null]).slice(0, 3);
    if (row?.calculation && values.every((value) => value === null || value === undefined)) {
      values = [0, 1, 2].map((period) => historicalOf(row.row_id, period));
    }
    if (entry.disposition === "aggregated") {
      // The certified case carries only the aggregate series; the synthetic
      // manifest puts it on the first filed line of the group and zeros on
      // the rest so the filed sum still equals the aggregate.
      const groupKey = (entry.mapped_row_ids ?? []).join(",");
      if (aggregatedSeen.has(groupKey)) values = [0, 0, 0];
      else aggregatedSeen.add(groupKey);
    }
    return {
      source_line_id: entry.source_line_id,
      raw_label: entry.label,
      values,
      page_or_note: entry.page_or_note,
      material: entry.material,
      ...(parentOfLine.has(entry.source_line_id)
        ? { parent_source_line_id: parentOfLine.get(entry.source_line_id) }
        : {}),
      ...(row?.calculation && lineByRowId.get(row.row_id) === entry.source_line_id &&
        parentLineIds.has(entry.source_line_id)
        ? { is_subtotal: true }
        : {}),
    };
  });
  return { lines, parentLineIds };
}

function sectionDocumentTitle(modelCase, section) {
  return modelCase.source_coverage[section]?.[0]?.document ?? "annual_report";
}

function buildManifest(section, lines, sourceId) {
  const manifest = {
    schema_version: "face-statement-manifest/1.0",
    statement: section,
    statement_order: 1,
    source_id: sourceId,
    document_sha256: hash("f"),
    page_or_note: "face statement",
    periods: ["FY1", "FY2", "FY3"],
    complete_face_statement: true,
    row_count: lines.length,
    rows: lines.map((line, index) => ({ ...line, ordinal: index + 1 })),
  };
  manifest.rows_sha256 = faceStatementManifestDigest(manifest);
  return manifest;
}

/**
 * Expansion groups: a filed line the model expands into several declared rows
 * (values from the filings' notes).  The group's rows travel as a sealed
 * evidence lane; the map only records the disposition.
 */
function deriveExpansions(modelCase, section) {
  const coverage = modelCase.source_coverage[section];
  const rowsById = new Map(
    modelCase.statement_structure[section].map((row) => [row.row_id, row]),
  );
  const groups = new Map();
  for (const entry of coverage) {
    if ((entry.mapped_row_ids ?? []).length <= 1) continue;
    const key = entry.mapped_row_ids.join(",");
    if (!groups.has(key)) {
      const rows = entry.mapped_row_ids
        .map((id) => clone(rowsById.get(id)))
        .filter(Boolean)
        .map((row) => {
          for (const field of [
            "forecast_treatment", "forecast_calculation",
            "forecast_period_calculations", "forecast_period_authorities",
            "forecast_capture_parent_id", "forecast_capture_mode",
            "forecast_capture_note", "broker_metric_id", "forecast_decision",
          ]) delete row[field];
          return row;
        });
      groups.set(key, { section, source_line_ids: [], rows });
    }
    groups.get(key).source_line_ids.push(entry.source_line_id);
  }
  return [...groups.values()];
}

const DOCTRINE_CONVERTED = new Set([
  "cash_flow_net_income", "cash_flow_finance_result", "cash_flow_da",
  "cash_flow_da_continuing", "cash_flow_finance_income",
  "cash_flow_finance_costs", "cash_flow_finance_expense",
  "cash_flow_tax_addback", "cash_flow_tax_expense", "net_finance_result",
  "net_change_in_cash", "ending_cash", "opening_cash", "interest_income",
  "interest_expense", "debt_issuance", "debt_repayment", "rcf_draw",
  "rcf_repayment", "is_da_expense", "operating_profit", "tax_expense",
  "interest_paid", "interest_received", "tax_paid", "income_taxes_paid",
  "income_tax_paid",
]);

function deriveStatementMap(modelCase, section, parentLineIds = new Set()) {
  const rowsById = new Map(
    modelCase.statement_structure[section].map((row) => [row.row_id, row]),
  );
  const memberClassByParent = new Map();
  const stampedParents = new Set();
  for (const row of modelCase.statement_structure[section]) {
    if (!row.parent_row_id) continue;
    if (["contributing_child", "working_child"].includes(row.aggregation_role ?? "")) {
      stampedParents.add(row.parent_row_id);
    }
    if (row.economic_class && !memberClassByParent.has(row.parent_row_id)) {
      memberClassByParent.set(row.parent_row_id, row.economic_class);
    }
  }
  const coverage = modelCase.source_coverage[section];
  const keeperByRow = new Map();
  const entries = [];
  for (const entry of coverage) {
    if ((entry.mapped_row_ids ?? []).length > 1) {
      entries.push({ source_line_id: entry.source_line_id, disposition: "expand" });
      continue;
    }
    const targetRowId = entry.mapped_row_ids?.[0];
    const row = rowsById.get(targetRowId);
    if (entry.disposition === "aggregated" && keeperByRow.has(targetRowId)) {
      entries.push({
        source_line_id: entry.source_line_id,
        disposition: "absorb",
        absorb_into: keeperByRow.get(targetRowId),
      });
      continue;
    }
    keeperByRow.set(targetRowId, entry.source_line_id);
    entries.push({
      source_line_id: entry.source_line_id,
      row_id: targetRowId,
      disposition: "keep",
      ...(row && row.label !== entry.label ? { label_override: row.label } : {}),
      ...(row?.row_type === "header" ? { header: true } : {}),
      ...(row?.row_type === "uncalculated" ? { uncalculated: true } : {}),
      ...(row?.movement_type ? { movement_type: row.movement_type } : {}),
      ...(row?.acquisition_driver_role
        ? { acquisition_driver_role: row.acquisition_driver_role }
        : {}),
      ...(row?.forecast_calculation
        ? { forecast_derive_as: { operator: row.forecast_calculation.operator, refs: [...row.forecast_calculation.refs] } }
        : {}),
      ...((row?.forecast_period_calculations ?? []).some(Boolean)
        ? {
            forecast_period_derive_as: row.forecast_period_calculations.map((rule) =>
              rule ? { operator: rule.operator, refs: [...rule.refs] } : null,
            ),
          }
        : {}),
      ...(row?.cash_flow_classification
        ? { cash_flow_classification: row.cash_flow_classification }
        : {}),
      ...(row?.semantic_role ? { role: row.semantic_role } : {}),
      ...(row?.calculation?.operator === "sum" && row.calculation.refs?.length &&
        parentLineIds.has(entry.source_line_id)
        ? { reported_parent: true }
        : {}),
      ...(row?.row_type === "subtotal"
        ? { reported_form: "reconciled" }
        : row?.aggregation_authority === "derived_from_children" &&
            stampedParents.has(row?.row_id)
          ? { reported_form: "derived" }
          : {}),
      ...(row?.aggregation_authority === "reported_parent" && !row?.calculation
        ? { aggregation: "reported_parent" }
        : {}),
      ...(memberClassByParent.has(row?.row_id)
        ? { member_class: memberClassByParent.get(row.row_id) }
        : {}),
      ...(row?.calculation &&
        row.calculation.refs?.length > 0 &&
        !(row.calculation.operator === "sum" && parentLineIds.has(entry.source_line_id)) &&
        // Rows the doctrine converts itself never need a declaration — the
        // declaration channel exists for genuinely issuer-specific
        // derivations only.  Temporal self-carries are the exception: no
        // recipe can author a prior_period identity, so a certified one is
        // always a declaration regardless of who owns the row name.
        (["prior_period", "prior_period_scaled_by"].includes(row.calculation.operator) ||
          ((!DOCTRINE_OWNED.has(row.row_id) || row.row_id === "adjusted_ebitda") &&
            !DOCTRINE_CONVERTED.has(row.row_id) &&
            !["interest_income", "interest_expense", "rcf_draw", "rcf_repayment",
              "opening_cash", "ending_cash", "net_change_in_cash",
              "fx_effect_on_cash", "cash_from_operations", "cash_from_investing",
              "cash_from_financing"].includes(row.semantic_role ?? "")))
        ? { derive_as: { operator: row.calculation.operator, refs: [...row.calculation.refs] } }
        : {}),
      ...(row?.broker_metric_id ? { broker_metric_id: row.broker_metric_id } : {}),
    });
  }
  return entries;
}

/**
 * Rows the compiler's fixed recipe engine owns.  Anything else that is
 * derived in a certified case is a MODELING DECISION and round-trips as a
 * case-source derived_rows declaration — never as a new compiler recipe.
 */
const DOCTRINE_OWNED = new Set([
  "revenue_growth", "effective_tax_rate", "attribution_header",
  "ebitda_bridge_header", "adjusted_ebitda_bridge", "bridge_operating_profit",
  "non_trading_addback", "depreciation_and_amortisation", "adjusted_ebitda",
  "adjusted_ebitda_margin", "adjusted_ebitda_bridge_total",
  "adjusted_ebitda_reconciliation", "ebit", "is_da_expense",
  "change_in_working_capital", "capex", "investing_activities",
  "financing_activities", "share_buybacks", "rcf_draw", "rcf_repayment",
  "free_cash_flow_header", "free_cash_flow", "free_cash_flow_conversion",
]);

function deriveDeclaredRows(modelCase) {
  const declarations = [];
  for (const section of ["income_statement", "cash_flow"]) {
    const rows = modelCase.statement_structure[section];
    const mapped = new Set();
    for (const entry of modelCase.source_coverage[section]) {
      for (const id of entry.mapped_row_ids ?? []) mapped.add(id);
    }
    const parents = rows.filter((row) => row.calculation?.refs?.length);
    rows.forEach((row, index) => {
      if (mapped.has(row.row_id) || DOCTRINE_OWNED.has(row.row_id)) return;
      const previous = rows[index - 1]?.row_id ?? null;
      if (row.row_type === "header") {
        declarations.push({
          row_id: row.row_id, section, label: row.label,
          operator: "header", insert_after: previous,
        });
        return;
      }
      if (!row.calculation) return;
      const referenced = parents.some(
        (parent) => parent !== row && parent.calculation.refs.includes(row.row_id),
      );
      const membersDeclareParent = row.calculation.refs.every((ref) => {
        const member = rows.find((candidate) => candidate.row_id === ref);
        return member?.parent_row_id === row.row_id;
      });
      const parentRow = parents.find(
        (parent) => parent !== row && parent.calculation.refs.includes(row.row_id),
      );
      declarations.push({
        row_id: row.row_id, section, label: row.label,
        operator: row.calculation.operator,
        refs: [...row.calculation.refs],
        insert_after: previous,
        ...(row.semantic_role ? { role: row.semantic_role } : {}),
        ...(referenced && row.calculation.operator === "sum" && row.calculation.refs.length
          ? { replace_in_parent: true }
          : {}),
        ...(referenced && row.calculation.refs.length === 0 && parentRow
          ? { add_to_parent: parentRow.row_id }
          : {}),
        ...(membersDeclareParent && row.calculation.refs.length > 0
          ? { members_declare_parent: true }
          : {}),
        ...(row.indent ? { indent: true } : {}),
      });
    });
  }
  return declarations;
}

export function deriveCaseSourceAndEvidence(modelCase) {
  const manifests = {};
  const statementMap = {};
  const expansions = [];
  for (const section of ["income_statement", "cash_flow"]) {
    const { lines, parentLineIds } = deriveFiledLines(modelCase, section);
    manifests[section] = [buildManifest(section, lines, sectionDocumentTitle(modelCase, section))];
    statementMap[section] = deriveStatementMap(modelCase, section, parentLineIds);
    expansions.push(...deriveExpansions(modelCase, section));
  }
  const answers = [];
  const policies = { rcf: {}, cash: {}, lease: {} };
  const policyEvidence = { rcf: {}, cash: {}, lease: {} };
  const rcf = modelCase.rcf_policy ?? {};
  for (const key of Object.keys(rcf)) {
    if (key === "commitment_fee_convention") policies.rcf.commitment_fee_convention = rcf[key];
    else policyEvidence.rcf[key] = clone(rcf[key]);
  }
  const cash = modelCase.cash_policy ?? {};
  for (const key of Object.keys(cash)) {
    if (key === "interest_income_cash_flow_classification") {
      policies.cash.interest_income_cash_flow_classification = cash[key];
    } else if (key === "minimum_cash_override" && cash[key] !== null && cash[key] !== undefined) {
      answers.push({ question_id: "derived.cash.minimum_cash", round: "derived", answer: clone(cash[key]) });
      policies.cash.minimum_cash_question_id = "derived.cash.minimum_cash";
    } else if (key === "eligible_cash_percentage" && cash[key] !== undefined) {
      answers.push({ question_id: "derived.cash.eligible", round: "derived", answer: clone(cash[key]) });
      policies.cash.eligible_cash_question_id = "derived.cash.eligible";
    } else if (key === "cash_yield" && cash[key] !== undefined) {
      answers.push({ question_id: "derived.cash.yield", round: "derived", answer: clone(cash[key]) });
      policies.cash.cash_yield_question_id = "derived.cash.yield";
    } else {
      policyEvidence.cash[key] = clone(cash[key]);
    }
  }
  const lease = modelCase.lease_policy ?? {};
  const leaseBasis = {};
  for (const key of Object.keys(lease)) {
    if (["mode", "include_in_gross_debt", "include_in_net_debt", "include_in_leverage"].includes(key)) {
      policies.lease[key] = lease[key];
    } else if (["additions", "principal_repayment", "effective_rate"].includes(key)) {
      leaseBasis[key] = clone(lease[key]);
    } else {
      policyEvidence.lease[key] = clone(lease[key]);
    }
  }
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase.statement_structure[section]) {
      const temporalSelfCarry =
        ["prior_period", "prior_period_scaled_by"].includes(row.calculation?.operator) &&
        row.calculation?.refs?.[0] === row.row_id;
      // A null period inside authored wiring means "this period's figure is
      // receipted, not wired" — the wiring cannot invent it.
      const fpc = row.forecast_period_calculations ?? [];
      const partialWiring = fpc.length > 0 && fpc.some((rule) => !rule) && fpc.some(Boolean);
      // A self-carry chain whose sealed anchor exists is a receipted anchor
      // assumption — the chain itself cannot invent its first value.
      if (row.broker_metric_id || (row.calculation && !temporalSelfCarry && !partialWiring)) continue;
      if (!temporalSelfCarry && !partialWiring && row.row_type !== "input") continue;
      if (row.semantic_role === "fx_effect_on_cash") continue;
      const forecast = (row.values ?? []).slice(3, 6);
      if (forecast.length === 3 && forecast.every((value) => Number.isFinite(Number(value)) && value !== null)) {
        answers.push({
          question_id: `derived.forecast.${row.row_id}`,
          round: "derived",
          answer: forecast.map(Number),
        });
      }
    }
  }
  const certifiedFx = [
    ...modelCase.statement_structure.income_statement,
    ...modelCase.statement_structure.cash_flow,
  ].find((row) => row.semantic_role === "fx_effect_on_cash");
  const fxForecast = (certifiedFx?.values ?? []).slice(3, 6);
  if (fxForecast.some((value) => Number(value ?? 0) !== 0)) {
    answers.push({ question_id: "derived.fx.effect", round: "derived", answer: fxForecast.map(Number) });
  }
  if (Object.keys(leaseBasis).length > 0) {
    answers.push({ question_id: "derived.lease.forecast_basis", round: "derived", answer: leaseBasis });
    policies.lease.forecast_basis_question_id = "derived.lease.forecast_basis";
  }

  const caseSource = {
    schema_version: "case-source-v1",
    identity: {
      case_id: modelCase.case_id,
      issuer_name: modelCase.issuer?.name,
      ...(modelCase.issuer?.ticker ? { ticker: modelCase.issuer.ticker } : {}),
      reporting_currency: modelCase.issuer?.reporting_currency,
      ...(modelCase.issuer?.accounting_framework
        ? { accounting_framework: modelCase.issuer.accounting_framework }
        : {}),
      ...(!modelCase.issuer?.accounting_framework && modelCase.issuer?.accounting_basis
        ? { accounting_framework: /us[\s_]*gaap/i.test(modelCase.issuer.accounting_basis) ? "us_gaap" : "ifrs" }
        : {}),
      ...(modelCase.issuer?.units ? { units: modelCase.issuer.units } : {}),
      ...(modelCase.issuer?.fiscal_year_end
        ? { fiscal_year_end: modelCase.issuer.fiscal_year_end }
        : {}),
      ...(modelCase.presentation_profile
        ? { presentation_profile: modelCase.presentation_profile }
        : {}),
      ...(modelCase.execution_profile && modelCase.execution_profile !== "production_model"
        ? { execution_profile: modelCase.execution_profile }
        : {}),
    },
    evidence_refs: {
      face_statement_manifests: Object.fromEntries(
        ["income_statement", "cash_flow"].map((section) => [
          section,
          manifests[section].map((manifest) => ({
            source_id: manifest.source_id,
            digest: manifest.rows_sha256,
          })),
        ]),
      ),
    },
    statement_map: statementMap,
    derived_rows: deriveDeclaredRows(modelCase),
    consumption: {},
    policies,
    answers,
  };
  const lanes = {
    statement_expansions: expansions,
    policy_evidence: policyEvidence,
    source_coverage_review: Object.fromEntries(
      Object.entries(modelCase.source_coverage).filter(
        ([key]) => !["income_statement", "cash_flow", "classification_contract_version"].includes(key),
      ),
    ),
  };
  for (const lane of [
    "periods", "modules", "controls", "coverage_policy", "operating_metrics",
    "forecast_assumptions", "instruments", "instrument_term_authorities",
    "debt_reconciliation", "historical_interest_reconciliation",
    "historical_supplement", "other_interest", "non_cash_interest",
    "acquisition", "fx", "historical_entities", "broker_pack", "provenance",
    "stage_three_answers",
  ]) {
    if (modelCase[lane] !== undefined) lanes[lane] = clone(modelCase[lane]);
  }
  return { caseSource, evidence: { face_statement_manifests: manifests, lanes } };
}

/**
 * Named, justified differences: the compiler emits MORE than the legacy
 * cohort carried.  Everything matching here is a deliberate v3 addition, not
 * a divergence — anything else must reach zero.
 */
const JUSTIFIED = [
  // Full classification receipts on coverage entries (evidence_v1 standard).
  /^source_coverage\.(income_statement|cash_flow)\[\d+\]\.(classifier_version|classification_candidates|classification_evidence|classification_confidence|classification_status|classification_review_status|classified_role|reason|mapping_method)\b/,
  // waterfall_v1 + authority_v1 receipts and capture certificates on rows —
  // the compiled case carries the full production contract the legacy cohort
  // predates.  Only absent-in-certified paths qualify; a VALUE disagreement
  // on any of these is a real divergence.
  /^statement_structure\.(income_statement|cash_flow)\[[^\]]+\]\.(historical_authority|forecast_period_authorities|forecast_period_calculations|forecast_capture_parent_id|forecast_capture_mode|forecast_capture_note|forecast_capture_certificates|formula_authority|aggregation_authority|source_line_ids)\b/,
  /^statement_structure_compiled_version$/,
  // Named default for legacy DCS lanes without a balance-basis declaration.
  /^instruments\[\d+\]\.balance_basis$/,
];

function isJustified(diff) {
  return diff.certifiedAbsent === true && JUSTIFIED.some((rx) => rx.test(diff.path));
}

/** flat path diff; statement row arrays are aligned by row_id, others by index */
function diffPaths(expected, actual, prefix = "", out = [], limit = 4000) {
  if (out.length >= limit) return out;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    const a = expected ?? [];
    const b = actual ?? [];
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push({ path: prefix, expected: summarize(expected), actual: summarize(actual), certifiedAbsent: expected === undefined });
      return out;
    }
    const keyed = a.every((x) => x && typeof x === "object" && x.row_id) &&
      b.every((x) => x && typeof x === "object" && x.row_id);
    if (keyed) {
      const byIdA = new Map(a.map((x) => [x.row_id, x]));
      const byIdB = new Map(b.map((x) => [x.row_id, x]));
      for (const id of new Set([...byIdA.keys(), ...byIdB.keys()])) {
        if (!byIdB.has(id)) {
          out.push({ path: `${prefix}[${id}]`, expected: "(row)", actual: "(MISSING ROW)" });
        } else if (!byIdA.has(id)) {
          out.push({ path: `${prefix}[${id}]`, expected: "(NO SUCH ROW)", actual: "(extra row)" });
        } else {
          diffPaths(byIdA.get(id), byIdB.get(id), `${prefix}[${id}]`, out, limit);
        }
      }
      const orderA = a.map((x) => x.row_id).filter((id) => byIdB.has(id));
      const orderB = b.map((x) => x.row_id).filter((id) => byIdA.has(id));
      if (JSON.stringify(orderA) !== JSON.stringify(orderB)) {
        out.push({ path: `${prefix}(order)`, expected: orderA.join(","), actual: orderB.join(",") });
      }
      return out;
    }
    if (a.length !== b.length) {
      out.push({ path: prefix, expected: summarize(expected), actual: summarize(actual), certifiedAbsent: expected === undefined });
      return out;
    }
    for (let i = 0; i < a.length; i += 1) diffPaths(a[i], b[i], `${prefix}[${i}]`, out, limit);
    return out;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      diffPaths(expected[key], actual[key], prefix ? `${prefix}.${key}` : key, out, limit);
    }
    return out;
  }
  if (!Object.is(expected ?? null, actual ?? null)) {
    out.push({
      path: prefix,
      expected: summarize(expected),
      actual: summarize(actual),
      certifiedAbsent: expected === undefined,
    });
  }
  return out;
}

function summarize(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return "(absent)";
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

async function main() {
const files = (await fs.readdir(casesDirectory))
  .filter((name) => name.endsWith(".json"))
  .filter((name) => !onlyCase || name.includes(onlyCase))
  .sort();

let totalDiffs = 0;
let totalBlocks = 0;
let failedSolveCount = 0;
let hardPlanDiffCount = 0;
let failedPlanCompileCount = 0;
for (const name of files) {
  const certified = JSON.parse(await fs.readFile(path.join(casesDirectory, name), "utf8"));
  const { caseSource, evidence } = deriveCaseSourceAndEvidence(certified);
  if (process.env.KEEL_WRITE_SOURCE) {
    await fs.writeFile(
      path.join(process.env.KEEL_WRITE_SOURCE, `source-${name}`),
      JSON.stringify({ caseSource, evidence }, null, 2),
    );
  }
  const { model_case: compiled, report } = compileCase(caseSource, evidence);

  // The certified cohort predates the v3 stamps; ignore stamp-only deltas.
  const expected = clone(certified);
  expected.forecast_authority_contract_version = "waterfall_v1";
  expected.statement_authority_contract_version = "authority_v1";
  expected.source_coverage.classification_contract_version = "evidence_v1";

  if (process.env.KEEL_WRITE_COMPILED) {
    await fs.writeFile(
      path.join(process.env.KEEL_WRITE_COMPILED, `compiled-${name}`),
      JSON.stringify(compiled, null, 2),
    );
  }
  const allDiffs = diffPaths(expected, compiled);
  // Receipts authored by a fixture generator are process stamps, not
  // production provenance: a fixture that certifies its own classifier at
  // confidence 1 is not an authority the compiler must impersonate.  Only
  // fires when the certified artifact itself declares the fixture
  // classifier; the certification cohort is untouched by this class.
  const fixtureAuthority = [
    ...(expected.source_coverage?.income_statement ?? []),
    ...(expected.source_coverage?.cash_flow ?? []),
  ].some((entry) => /^dmu-synthetic-cohort\//.test(entry?.classifier_version ?? ""));
  const FIXTURE_RECEIPTS = [
    /^source_coverage\.(income_statement|cash_flow)\[\d+\]\.(classifier_version|classification_candidates|classification_evidence|classification_confidence|classification_status|classification_review_status|classified_role|reason|mapping_method|source_position|operation_scope)\b/,
    /^statement_structure\.(income_statement|cash_flow)\[[^\]]+\]\.(classification_status|classification_confidence|classification_review_status|operation_scope|scope_reconciliation_note)$/,
  ];
  const isFixtureReceipt = (diff) =>
    fixtureAuthority && FIXTURE_RECEIPTS.some((rx) => rx.test(diff.path));
  const isJustifiedAll = (diff) => isJustified(diff) || isFixtureReceipt(diff);
  const justified = allDiffs.filter(isJustifiedAll);
  // Presentation is compiler-owned convention, verified post-canonicalisation
  // by the plan clause; sealed-level presentation drift in the hand-authored
  // cohort is NAMED here, never chased into the recipes (that way lies
  // overfitting) and never silently ignored.
  const compiledRowsById = new Map(
    [
      ...(compiled.statement_structure?.income_statement ?? []),
      ...(compiled.statement_structure?.cash_flow ?? []),
    ].map((row) => [row.row_id, row]),
  );
  // uncalculated-vs-absent forecast_treatment on identity rows is inert
  // vintage noise: with no capture certificate, the waterfall resolves the
  // row's own calculation either way.
  const isInertTreatment = (diff) => {
    if (!/\.forecast_treatment$/.test(diff.path)) return false;
    const pairs = ['"uncalculated"', '"hardcode"', '"broker"', '"formula"', "(absent)"];
    if (!pairs.includes(diff.expected) || !pairs.includes(diff.actual)) return false;
    const rowMatch = /\[([^\]]+)\]\.forecast_treatment$/.exec(diff.path);
    const row = rowMatch ? compiledRowsById.get(rowMatch[1]) : null;
    const hasForecastNumbers = (row?.values ?? [])
      .slice(3, 6)
      .some((value) => value !== null && value !== undefined);
    // Treatment naming is inert when the row's actual forecast surface
    // (links, wiring, declared authorities) agrees and no cached numbers
    // disagree — the build derives treatment from those, not the label.
    if (diff.expected === '"broker"' || diff.actual === '"broker"') {
      return Boolean(row?.broker_metric_id) && !hasForecastNumbers;
    }
    if (diff.expected === '"formula"' || diff.actual === '"formula"') {
      return Boolean(
        row?.forecast_calculation ||
          (row?.forecast_period_calculations ?? []).some(Boolean) ||
          // A live calculation IS the row's formula — treatment naming on
          // top of it is derived at build, whatever the vintage wrote.
          row?.calculation ||
          // An aggregate member with no wiring of its own is covered by its
          // block; formula-vs-uncalculated is contract-era naming.
          (["working_child", "contributing_child"].includes(row?.aggregation_role ?? "") &&
            !hasForecastNumbers),
      );
    }
    return (
      (diff.expected === "(absent)" || diff.actual === "(absent)") ||
      !hasForecastNumbers
    );
  };
  const SCHEDULE_CACHE_ROWS = new Set([
    "lease_principal", "debt_issuance", "debt_repayment", "rcf_draw",
    "rcf_repayment", "interest_paid", "interest_received",
  ]);
  const isInertShellValues = (diff) =>
    /\[(debt_issuance|debt_repayment)\]\.(row_type|calculation)$/.test(diff.path) ||
    /\[(rcf_draw|rcf_repayment)\]\.values/.test(diff.path) ||
    // The legacy cohort sometimes sealed ending_cash as an empty schedule
    // shell; the compiler seals the roll-forward identity.  The solver
    // computes the same series either way.
    /\[ending_cash\]\.calculation\.refs$/.test(diff.path) ||
    (/\[(interest_income|interest_expense|opening_cash|ending_cash)\]\.values/.test(diff.path));
  const isExtraDisplayRow = (diff) => {
    const match = /^statement_structure\.(?:income_statement|cash_flow)\[([^\]]+)\]$/.exec(diff.path);
    if (!match || diff.expected !== "(NO SUCH ROW)") return false;
    const row = compiledRowsById.get(match[1]);
    return ["ratio", "negated_ratio", "growth"].includes(row?.calculation?.operator);
  };
  // Display strata the doctrine prints unconditionally (section banners, the
  // FCF memo block); a vintage sealed before a stratum existed differs only
  // in presentation, provided nothing certified computes from those rows.
  const DOCTRINE_DISPLAY_ROWS = new Set([
    "investing_activities", "financing_activities",
    "free_cash_flow_header", "free_cash_flow", "free_cash_flow_conversion",
  ]);
  const certifiedRefsAll = new Set(
    [
      ...(expected.statement_structure?.income_statement ?? []),
      ...(expected.statement_structure?.cash_flow ?? []),
    ].flatMap((row) => [
      ...(row.calculation?.refs ?? []),
      ...(row.forecast_calculation?.refs ?? []),
      ...(row.forecast_period_calculations ?? []).flatMap((rule) => rule?.refs ?? []),
    ]),
  );
  const isDoctrineDisplayStratum = (diff) => {
    const match = /^statement_structure\.(?:income_statement|cash_flow)\[([^\]]+)\]$/.exec(diff.path);
    if (!match || diff.expected !== "(NO SUCH ROW)") return false;
    return DOCTRINE_DISPLAY_ROWS.has(match[1]) && !certifiedRefsAll.has(match[1]);
  };
  // Addition commutes: two vintages ordering the same members differently
  // inside one sum print differently and compute identically.
  const isCommutativePermutation = (diff) => {
    const match = /^(statement_structure\.(?:income_statement|cash_flow))\[([^\]]+)\]\.calculation\.refs\[\d+\]$/.exec(diff.path);
    if (!match) return false;
    const row = compiledRowsById.get(match[2]);
    const certRow = [
      ...(expected.statement_structure?.income_statement ?? []),
      ...(expected.statement_structure?.cash_flow ?? []),
    ].find((candidate) => candidate.row_id === match[2]);
    if (row?.calculation?.operator !== "sum" || certRow?.calculation?.operator !== "sum") return false;
    const a = [...(row.calculation.refs ?? [])].sort();
    const b = [...(certRow.calculation.refs ?? [])].sort();
    return a.length === b.length && a.every((ref, index) => ref === b[index]);
  };
  const isPresentation = (diff) =>
    isExtraDisplayRow(diff) ||
    isDoctrineDisplayStratum(diff) ||
    isCommutativePermutation(diff) ||
    /\.(label|style_role|indent|number_format)$/.test(diff.path) ||
    /^source_coverage\.(income_statement|cash_flow)\[\d+\]\.reason$/.test(diff.path) ||
    /\(order\)$/.test(diff.path);
  const presentation = allDiffs.filter((d) => !isJustifiedAll(d) && isPresentation(d));
  // Broker-linked rows resolve their forecasts from the pack at build; a
  // vintage that cached the numbers into the sealed case differs inertly
  // from one that did not.
  const isInertBrokerCache = (diff) => {
    const match = /^statement_structure\.(?:income_statement|cash_flow)\[([^\]]+)\]\.values\[[345]\]$/.exec(diff.path);
    if (!match) return false;
    const row = compiledRowsById.get(match[1]);
    return Boolean(row?.broker_metric_id) && diff.actual === "null";
  };
  const isInertSolverCache = (diff) => {
    const match = /^statement_structure\.(?:income_statement|cash_flow)\[([^\]]+)\]\.values(\[[345]\])?$/.exec(diff.path);
    if (!match) return false;
    const row = compiledRowsById.get(match[1]);
    if (!row) return false;
    const livePath = Boolean(
      row.forecast_calculation ||
        (row.forecast_period_calculations ?? []).some(Boolean) ||
        row.broker_metric_id ||
        row.calculation ||
        SCHEDULE_CACHE_ROWS.has(row.row_id) ||
        SCHEDULE_CACHE_ROWS.has(row.semantic_role ?? ""),
    );
    return livePath && (diff.actual === "null" || diff.actual === "(absent)");
  };
  // Movement metadata on schedule shells is doctrine enrichment the solver
  // never reads — it keys these rows off semantic_role.  A vintage that
  // sealed no metadata differs inertly from one the doctrine annotates.
  const isInertShellMetadata = (diff) => {
    const match = /\[([^\]]+)\]\.(movement_type|cash_flow_classification)$/.exec(diff.path);
    if (!match) return false;
    const row = compiledRowsById.get(match[1]);
    if (!SCHEDULE_CACHE_ROWS.has(row?.semantic_role ?? "")) return false;
    return diff.expected === "(absent)" || diff.expected === "null";
  };
  // "standalone" is the explicit spelling of no-aggregation: the hierarchy
  // validator accepts absent and standalone identically on parentless rows,
  // and an economic_class on a row outside every aggregate is read by
  // nothing at solve.
  const isInertStandalone = (diff) => {
    const match = /\[([^\]]+)\]\.(aggregation_role|aggregation_authority|economic_class)$/.exec(diff.path);
    if (!match) return false;
    const row = compiledRowsById.get(match[1]);
    if (row?.parent_row_id) return false;
    if (match[2] === "economic_class") {
      // On a reported parent the class is implied by its role and children,
      // and on a deliberately uncalculated row nothing ever reads it;
      // elsewhere working_capital naming is real WC scope and stays hard.
      if (row?.aggregation_authority === "reported_parent" || row?.row_type === "uncalculated") {
        return diff.expected === "(absent)" || diff.actual === "(absent)";
      }
      return diff.expected !== '"working_capital"' &&
        (diff.expected === "(absent)" || diff.actual === "(absent)");
    }
    return ['"standalone"', "(absent)"].includes(diff.expected) &&
      ['"standalone"', "(absent)"].includes(diff.actual);
  };
  // "derived_from_children" names what a minted sum already IS — the
  // calculation is the authority; the stamp is redundant vocabulary.
  const isInertDerivedFromChildren = (diff) => {
    const match = /\[([^\]]+)\]\.aggregation_authority$/.exec(diff.path);
    if (!match) return false;
    const row = compiledRowsById.get(match[1]);
    const absent = (side) => side === "(absent)" || side === "null";
    return (
      (diff.expected === '"derived_from_children"' && absent(diff.actual)) ||
      (diff.actual === '"derived_from_children"' && absent(diff.expected))
    ) && (row?.calculation?.refs ?? []).length > 0;
  };
  const isInertAll = (d) =>
    isInertTreatment(d) || isInertShellValues(d) || isInertBrokerCache(d) ||
    isInertSolverCache(d) || isInertShellMetadata(d) || isInertStandalone(d) ||
    isInertDerivedFromChildren(d);
  const inert = allDiffs.filter(
    (d) => !isJustifiedAll(d) && !isPresentation(d) && isInertAll(d),
  );
  const diffs = allDiffs.filter(
    (diff) => !isJustifiedAll(diff) && !isPresentation(diff) && !isInertAll(diff),
  );
  totalDiffs += diffs.length;
  const blocks = report.findings.filter((f) => f.severity === "BLOCK");
  totalBlocks += blocks.length;
  console.log(`\n=== ${name}: ${diffs.length} economic diffs (+${presentation.length} presentation, +${inert.length} inert-ft, +${justified.length} justified), ${blocks.length} compile blocks (${report.status})`);
  if (process.env.KEEL_DUMP_PRESENTATION) {
    for (const d of presentation.slice(0, 20)) console.log(`    pres· ${d.path}: ${d.expected} -> ${d.actual}`);
  }
  const byHead = new Map();
  for (const diff of diffs) {
    const head = diff.path.split(/[.[]/)[0];
    byHead.set(head, (byHead.get(head) ?? 0) + 1);
  }
  for (const [head, count] of [...byHead.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(count).padStart(5)}  ${head}`);
  }
  for (const diff of diffs.slice(0, Number(process.env.KEEL_DUMP_DIFFS ?? 12))) {
    console.log(`    · ${diff.path}\n        certified: ${diff.expected}\n        compiled:  ${diff.actual}`);
  }
  // The keel's final clause: the compiled case must BUILD the same workbook.
  // Plan equality (row plan digest) and solution equality (economic solve)
  // are compared only when the case-level diff is already at zero — a case
  // that differs in JSON always differs downstream too.
  if (diffs.length === 0) {
    // Legacy-projection equality (the zero diff above) already implies the
    // certified build reproduces byte-for-byte from the compiled case's
    // legacy view.  Two further clauses:
    //   B: the RICHER compiled case must itself solve under the full
    //      production contract;
    //   C: its workbook plan may differ from the certified plan only in the
    //      named capture-vs-legacy-carry way (a compiled capture certificate
    //      replaces the legacy last-resort carry that authored-grey rows
    //      used to receive) plus the justified receipt fields.
    try {
      const solved = solveCase(compiled);
      console.log(`  SOLVE(compiled): OK (${solved.forecast?.length ?? 0} periods)`);
    } catch (error) {
      failedSolveCount += 1;
      console.log(`  SOLVE(compiled): FAILED — ${error.message.slice(0, 160)}`);
    }
    try {
      const stripJustified = (rows) => rows.map((row) => {
        const copy = { ...row };
        for (const key of [
          "historical_authority", "forecast_period_authorities",
          "forecast_period_calculations", "forecast_capture_parent_id",
          "forecast_capture_mode", "forecast_capture_note",
          "forecast_capture_certificates", "formula_authority",
          "aggregation_authority", "classification_status",
          "classification_source_line_ids", "classification_confidence",
          "label", "style_role", "indent", "number_format", "outline_level",
          "display_role", "formula_role", "presentation_parent_id",
          "presentation_depth", "presentation_role",
          "in_section_conclusion_closure", "row",
          // Semantic-projection bookkeeping: WHO demanded a row's projection
          // is decided by the projection pass, which β defers to the build.
          "projection_origin", "projection_required_by",
          // Classifier/fixture receipts — never plan economics.
          "operation_scope", "scope_reconciliation_note",
        ]) delete copy[key];
        // Broker-linked forecast cells resolve from the pack at build; a
        // vintage that cached the numbers into its plan differs inertly.
        if (copy.broker_metric_id && Array.isArray(copy.values)) {
          copy.values = [...copy.values.slice(0, 3), null, null, null];
        }
        // Addition commutes — compare sum memberships as sets.
        if (copy.calculation?.operator === "sum" && Array.isArray(copy.calculation.refs)) {
          copy.calculation = { ...copy.calculation, refs: [...copy.calculation.refs].sort() };
        }
        return copy;
      });
      const certPlan = compileRowPlan(certified).statement_rows;
      const compPlan = compileRowPlan(compiled).statement_rows;
      let named = 0;
      let hard = 0;
      for (const section of ["income_statement", "cash_flow"]) {
        const a = new Map(stripJustified(certPlan[section]).map((row) => [row.row_id, row]));
        const b = new Map(stripJustified(compPlan[section]).map((row) => [row.row_id, row]));
        for (const id of new Set([...a.keys(), ...b.keys()])) {
          const certRow = a.get(id);
          const compRow = b.get(id);
          if (certRow?.row_type === "header" || compRow?.row_type === "header") continue;
          // Compiler-extra display ratios are presentation-canonical rows a
          // sparser vintage simply omitted.
          if (!certRow && ["ratio", "negated_ratio", "growth"].includes(compRow?.calculation?.operator)) continue;
          // Doctrine display strata (section banners, FCF memo) a sparser
          // vintage omitted — same class the case clause names.
          if (!certRow && ["investing_activities", "financing_activities",
            "free_cash_flow_header", "free_cash_flow", "free_cash_flow_conversion"].includes(id)) continue;
          let rowDiffs = diffPaths(certRow, compRow, id, [], 200);
          rowDiffs = rowDiffs.filter(
            (d) =>
              !(/\.forecast_treatment$/.test(d.path) &&
                (d.expected === "(absent)" || d.actual === "(absent)") &&
                ['"uncalculated"', '"hardcode"', "(absent)"].includes(d.expected) &&
                ['"uncalculated"', '"hardcode"', "(absent)"].includes(d.actual)) &&
              // Broker treatment naming follows the link, resolved at build.
              !(/\.forecast_treatment$/.test(d.path) &&
                compRow?.broker_metric_id &&
                (d.expected === '"broker"' || d.actual === '"broker"')) &&
              // Formula naming on a row whose wiring exists is derived at
              // build — same rule the case clause applies.
              !(/\.forecast_treatment$/.test(d.path) &&
                (d.expected === '"formula"' || d.actual === '"formula"') &&
                (compRow?.calculation ||
                  compRow?.forecast_calculation ||
                  (compRow?.forecast_period_calculations ?? []).some(Boolean))) &&
              // Standalone/no-aggregation naming and non-WC class labels on
              // parentless rows — same classes the case clause names.
              !(/\.(aggregation_role|aggregation_authority)$/.test(d.path) &&
                !compRow?.parent_row_id &&
                ['"standalone"', "(absent)"].includes(d.expected) &&
                ['"standalone"', "(absent)"].includes(d.actual)) &&
              !(/\.economic_class$/.test(d.path) &&
                !compRow?.parent_row_id &&
                d.expected !== '"working_capital"' &&
                (d.expected === "(absent)" || d.actual === "(absent)")) &&
              // A formula row's history is evaluated at build; a vintage
              // that cached the numbers into its plan differs inertly.
              !(/\.values(\[\d+\])?$/.test(d.path) &&
                compRow?.calculation &&
                (d.actual === "(absent)" || d.actual === "null")),
          );
          if (rowDiffs.length === 0) continue;
          const shellClass = rowDiffs.every((d) =>
            /\.(values(\[\d+\])?|calculation(\.refs(\[\d+\])?)?|dependency_refs|row_type|forecast_treatment)$/.test(d.path) &&
            /^(rcf_draw|rcf_repayment|ending_cash|opening_cash|debt_issuance|debt_repayment)\b/.test(d.path),
          );
          if (shellClass) { named += 1; continue; }
          const legacyDefault =
            ["carry_forward", "explicit_zero"].includes(
              certRow?.forecast_decision?.method,
            ) && compRow?.forecast_treatment === "uncalculated";
          if (legacyDefault) named += 1;
          else {
            hard += rowDiffs.length;
            if (process.env.KEEL_PLAN_DIFF) {
              for (const d of rowDiffs.slice(0, 4)) {
                console.log(`    plan· ${section}[${d.path}]\n        cert: ${d.expected}\n        comp: ${d.actual}`);
              }
            }
          }
        }
      }
      hardPlanDiffCount += hard;
      console.log(`  PLAN: ${hard === 0 ? "EQUAL" : `${hard} hard diffs`} (+${named} named capture-vs-legacy-default rows)`);
    } catch (error) {
      failedPlanCompileCount += 1;
      console.log(`  PLAN: failed to compile (${error.message.slice(0, 140)})`);
    }
  }
  const blockIds = new Map();
  for (const f of blocks) blockIds.set(f.id, (blockIds.get(f.id) ?? 0) + 1);
  for (const [id, count] of blockIds) console.log(`  BLOCK ${count}× ${id}`);
  if (process.env.KEEL_DUMP_FINDINGS) {
    for (const f of blocks) {
      console.log(`  · [${f.id}] ${f.message}`);
      if (f.context && process.env.KEEL_DUMP_CONTEXT) {
        const diagnosticContext = Array.isArray(f.context?.errors)
          ? { errors: f.context.errors }
          : f.context;
        console.log(`      ${JSON.stringify(diagnosticContext).slice(0, 1500)}`);
      }
    }
  }
}
console.log(`\nTOTAL path diffs across cohort: ${totalDiffs}`);
console.log(`TOTAL compile blocks across cohort: ${totalBlocks}`);
console.log(`TOTAL failed compiled solves: ${failedSolveCount}`);
console.log(`TOTAL hard plan diffs: ${hardPlanDiffCount}`);
console.log(`TOTAL failed plan compiles: ${failedPlanCompileCount}`);
if (
  totalBlocks > 0 ||
  failedSolveCount > 0 ||
  hardPlanDiffCount > 0 ||
  failedPlanCompileCount > 0
) {
  process.exitCode = 1;
}
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
