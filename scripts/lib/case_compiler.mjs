/**
 * The case compiler — the v3 organ that makes the model case a DERIVED
 * artifact.  Stage 3 authors a case-source (declarations only: identity,
 * evidence references, a statement map over filed line ids, consumption
 * elections, policy selections, receipted answers).  This module projects the
 * model-case-v2 from that case-source plus the sealed evidence lanes, and
 * reports EVERY finding at once in a case-compile-report — never serially,
 * never as a raw throw.
 *
 * workbook = f(sealed evidence, receipted decisions).  Nothing here invents a
 * row the filings cannot justify; nothing here accepts a value or a formula
 * from the author.  FR-1 (input twins), FR-3 (materiality vs evidence) and
 * FR-9 (authority without rules) are unwritable rather than detectable,
 * because the authorship surface simply has no field for them.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./json_schema.mjs";
import {
  FACE_STATEMENT_SECTIONS,
  faceStatementManifestDigest,
} from "./face_statement_manifest.mjs";
import { classifyStatementLine } from "./statement_classifier.mjs";
import { validateCaseShape } from "./solver.mjs";
import { assessCoverage } from "./coverage.mjs";
import { validateForecastAuthorities } from "./forecast_authority.mjs";
import { isRankedTotalIdentity } from "./row_plan.mjs";
import { applyTier1AnchorOwnership } from "./broker_anchor.mjs";
import {
  ALLOWED_METHODS_BY_BEHAVIOR,
  classifyForecastBehavior,
} from "./forecast_behavior.mjs";
import {
  compileForecastPlan,
  materializeForecastPlan,
  validateForecastPlan,
  validateForecastPlanCaseParity,
} from "./forecast_candidate_compiler.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASE_SOURCE_SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(HERE, "..", "..", "assets", "case-source.schema.json"), "utf8"),
);

export const CASE_COMPILE_REPORT_VERSION = "case-compile-report-v1";

/**
 * Every lane the β compiler projects mechanically (an identity projection of
 * a sealed evidence object).  Each of these becomes a real projection from
 * raw evidence lane-by-lane in later phases; the compiler's contract — the
 * author cannot write these — holds from day one either way.
 */
export const PASSTHROUGH_LANES = Object.freeze([
  "periods",
  "modules",
  "controls",
  "coverage_policy",
  "operating_metrics",
  "forecast_assumptions",
  "instruments",
  "instrument_authority_contract_version",
  "instrument_term_authorities",
  "debt_reconciliation",
  "historical_interest_reconciliation",
  "historical_supplement",
  "other_interest",
  "non_cash_interest",
  "acquisition",
  "fx",
  "historical_entities",
  "broker_pack",
  "provenance",
  "stage_three_answers",
]);

const clone = (value) => structuredClone(value);

function findingCollector() {
  const findings = [];
  return {
    findings,
    add(id, severity, message, remedy, context = undefined) {
      findings.push({
        id,
        severity,
        message,
        remedy,
        ...(context === undefined ? {} : { context }),
      });
    },
  };
}

function sanitizeRowId(sourceLineId) {
  return String(sourceLineId)
    .replace(/^(is|cf|income_statement|cash_flow)\./, "")
    .replace(/[^a-z0-9_]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function flattenManifests(manifests) {
  const lines = [];
  for (const manifest of manifests ?? []) {
    for (const row of manifest.rows ?? []) {
      lines.push({ manifest, row });
    }
  }
  return lines;
}

/**
 * Derive the statement skeleton for one section: filed lines from the sealed
 * manifests, dispositions/roles/parentage from the statement map.  The map may
 * only speak about line ids the manifests carry; the manifests may not leave a
 * line unaccounted for.  Subtotal calculations are minted from manifest
 * hierarchy (parent_source_line_id / is_subtotal), never from formula text.
 */
function compileStatementSection({ section, manifests, mapEntries, report, expansions = [] }) {
  const lines = flattenManifests(manifests);
  const linesById = new Map(lines.map((entry) => [entry.row.source_line_id, entry]));
  const entriesById = new Map();
  for (const entry of mapEntries ?? []) {
    if (entriesById.has(entry.source_line_id)) {
      report.add(
        "statement_map.duplicate_entry",
        "BLOCK",
        `${section}: statement_map declares ${entry.source_line_id} more than once.`,
        "Remove the duplicate declaration; one filed line takes exactly one disposition.",
        { section, source_line_id: entry.source_line_id },
      );
      continue;
    }
    entriesById.set(entry.source_line_id, entry);
    if (!linesById.has(entry.source_line_id)) {
      report.add(
        "statement_map.unknown_source_line",
        "BLOCK",
        `${section}: statement_map speaks about ${entry.source_line_id}, but no sealed manifest carries that line.`,
        "Point the entry at a filed line id from the face-statement manifests, or delete it.",
        { section, source_line_id: entry.source_line_id },
      );
    }
  }
  for (const { row } of lines) {
    if (!entriesById.has(row.source_line_id)) {
      report.add(
        "statement_map.unmapped_filed_line",
        "BLOCK",
        `${section}: the filings print ${row.source_line_id} (“${row.raw_label}”) but the statement map does not dispose of it.`,
        "Add a keep/absorb/alias entry for the line; every filed line must be accounted for.",
        { section, source_line_id: row.source_line_id, raw_label: row.raw_label },
      );
    }
  }

  // Row minting — first pass: kept lines become rows carrying manifest values
  // (historicals only; forecasts belong to the forecast plan) and manifest
  // materiality.  Absorbed lines fold their identity into their absorber.
  const rows = [];
  const rowsBySourceLine = new Map();
  for (const { manifest, row: line } of lines) {
    const entry = entriesById.get(line.source_line_id);
    if (!entry || ["absorb", "alias", "expand"].includes(entry.disposition)) continue;
    const rowId = entry.row_id ?? sanitizeRowId(line.source_line_id);
    const classified = classifyStatementLine({
      label: line.raw_label,
      section,
    });
    const declaredRole = entry.role ?? null;
    const inferredRole = classified?.role ?? classified?.id ?? null;
    if (declaredRole && inferredRole && declaredRole !== inferredRole && classified?.high_impact) {
      report.add(
        "statement_map.role_conflict",
        "WARN",
        `${section}.${line.source_line_id}: the map declares role ${declaredRole} but the classifier reads “${line.raw_label}” as ${inferredRole}.`,
        "Confirm the declared role or adopt the classified one; a confirmed declaration wins.",
        { section, source_line_id: line.source_line_id, declared: declaredRole, classified: inferredRole },
      );
    }
    // Rows stay minimal by convention: materiality and classification
    // receipts live on source_coverage (the evidence side), and a row carries
    // a semantic_role only when the map declares one — the classifier's
    // opinion is recorded in the coverage receipt, never silently promoted.
    const minted = entry.header
      ? {
          row_id: rowId,
          label: entry.label_override ?? line.raw_label,
          row_type: "header",
          source_line_ids: [line.source_line_id],
        }
      : {
          row_id: rowId,
          label: entry.label_override ?? line.raw_label,
          // A line declared uncalculated prints its history and is
          // deliberately never modeled — the third disposition besides
          // input and calculation.
          row_type: entry.uncalculated ? "uncalculated" : "input",
          ...(entry.uncalculated ? { forecast_treatment: "uncalculated" } : {}),
          values: [...(line.values ?? []).slice(0, 3), null, null, null],
          ...(declaredRole ? { semantic_role: declaredRole } : {}),
          ...(entry.movement_type ? { movement_type: entry.movement_type } : {}),
          ...(entry.acquisition_driver_role
            ? { acquisition_driver_role: entry.acquisition_driver_role }
            : {}),
          ...(entry.cash_flow_classification
            ? { cash_flow_classification: entry.cash_flow_classification }
            : {}),
          // A declared reported-parent aggregate is one even when its
          // members were absorbed rather than kept as filed children.
          ...(entry.aggregation === "reported_parent"
            ? { aggregation_authority: "reported_parent" }
            : {}),
          source_line_ids: [line.source_line_id],
        };
    rows.push(minted);
    rowsBySourceLine.set(line.source_line_id, minted);
    void manifest;
  }

  // Absorption: the absorbed line's identity joins its absorber.
  for (const { row: line } of lines) {
    const entry = entriesById.get(line.source_line_id);
    if (entry?.disposition !== "absorb") continue;
    const absorber = entry.absorb_into ? rowsBySourceLine.get(entry.absorb_into) : null;
    if (!absorber) {
      report.add(
        "statement_map.absorb_target_missing",
        "BLOCK",
        `${section}.${line.source_line_id} is absorbed into ${entry.absorb_into ?? "(unset)"}, which is not a kept filed line.`,
        "Absorb into a kept line of the same section, or keep the line.",
        { section, source_line_id: line.source_line_id, absorb_into: entry.absorb_into ?? null },
      );
      continue;
    }
    rowsBySourceLine.set(line.source_line_id, absorber);
  }

  // Expansion groups: a filed line the model expands into several declared
  // rows whose contents travel as a sealed evidence lane.  The rows enter at
  // the filed line's position; the coverage record binds every involved line
  // to the whole group.
  const expansionRowsByLine = new Map();
  for (const expansion of expansions.filter((entry) => entry.section === section)) {
    const involved = (expansion.source_line_ids ?? []).filter((id) => linesById.has(id));
    if (involved.length === 0) continue;
    const expansionRows = (expansion.rows ?? []).map((row) => clone(row));
    const firstLineIndex = lines.findIndex(
      ({ row: line }) => line.source_line_id === involved[0],
    );
    let insertAt = 0;
    for (let index = firstLineIndex - 1; index >= 0; index -= 1) {
      const prior = rowsBySourceLine.get(lines[index].row.source_line_id);
      if (prior) {
        insertAt = rows.indexOf(prior) + 1;
        break;
      }
    }
    rows.splice(insertAt, 0, ...expansionRows);
    for (const id of involved) {
      rowsBySourceLine.set(id, expansionRows.at(-1));
      expansionRowsByLine.set(id, expansionRows.map((row) => row.row_id));
    }
  }

  // Subtotal minting from manifest hierarchy: a filed line that other filed
  // lines name as parent — or that the manifest marks is_subtotal — is a
  // reported parent.  Its calculation is minted here, summing its children,
  // and its own filed values remain as the reconciliation target.
  const childrenByParent = new Map();
  for (const { row: line } of lines) {
    const parent = line.parent_source_line_id;
    if (!parent) continue;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(line.source_line_id);
  }
  for (const [parentLineId, childLineIds] of childrenByParent) {
    const parentRow = rowsBySourceLine.get(parentLineId);
    if (!parentRow) continue;
    const refs = childLineIds
      .map((id) => rowsBySourceLine.get(id)?.row_id)
      .filter(Boolean);
    if (refs.length === 0) continue;
    // Face additivity — a hoisted Stage-4 check: the filed subtotal must equal
    // the sum of its filed children before the compiler is allowed to replace
    // its filed values with a derived formula.  The net-change identity is
    // exempt: it references every activity subtotal at once, which the
    // single-parent manifest tree cannot carry — its recipe owns the
    // reconciliation and the solver re-checks the identity at build.
    const parentEntry = entriesById.get(parentLineId);
    const spineRecipeTarget =
      (parentEntry?.role ?? parentEntry?.row_id ?? sanitizeRowId(parentLineId)) ===
      "net_change_in_cash";
    if (spineRecipeTarget) {
      parentRow.row_type = "calculation";
      parentRow.calculation = { operator: "sum", refs: [] };
      continue;
    }
    // Declared reported-parent aggregates (the WC block, the capex block, a
    // debt-movement group): the filed total is FORECAST as one block, so it
    // keeps its filed values and its filed movements stay informational
    // working children — never a minted subtotal formula.  The known
    // broker-consumed roles imply the scheme without a declaration.
    const AGGREGATE_CHILD_CLASS = {
      change_in_working_capital: "working_capital",
      capex: "investing",
    };
    const impliedClass = AGGREGATE_CHILD_CLASS[parentEntry?.role];
    const reportedParentAggregate =
      parentEntry?.aggregation === "reported_parent" ||
      (impliedClass && !parentEntry?.reported_parent);
    if (reportedParentAggregate) {
      parentRow.aggregation_authority = "reported_parent";
      const memberClass = parentEntry?.member_class ?? impliedClass ?? null;
      for (const childLineId of childLineIds) {
        const child = rowsBySourceLine.get(childLineId);
        if (!child) continue;
        child.parent_row_id = parentRow.row_id;
        child.aggregation_role = "working_child";
        if (memberClass) child.economic_class = memberClass;
        // A member with authored wiring forecasts through it; otherwise the
        // block covers it — under the strict waterfall that is capture, and
        // a share pseudo-formula would only wire a cycle.
        child.forecast_treatment =
          child.forecast_calculation ||
          (child.forecast_period_calculations ?? []).some(Boolean)
            ? "formula"
            : "uncalculated";
        child.indent = Math.max(1, Number(child.indent ?? 0));
      }
      continue;
    }
    // The reconciliation reads the FILED lines on both sides: a child that is
    // itself a subtotal has already traded its minted values for a formula,
    // so the manifest is the only stable witness.
    const parentLine = linesById.get(parentLineId)?.row;
    const filed = (parentLine?.values ?? []).slice(0, 3);
    const childLines = childLineIds.map((id) => linesById.get(id)?.row);
    for (let period = 0; period < 3; period += 1) {
      const target = Number(filed[period]);
      if (!Number.isFinite(target)) continue;
      if (
        childLines.some(
          (child) => child?.values?.[period] === null || child?.values?.[period] === undefined,
        )
      ) continue;
      const total = childLines.reduce(
        (sum, child) => sum + Number(child?.values?.[period] ?? 0),
        0,
      );
      if (Math.abs(total - target) > 0.51) {
        report.add(
          "statement_map.face_additivity",
          "BLOCK",
          `${section}.${parentLineId}: the filed subtotal prints ${target} in historical period ${period + 1}, but its filed children sum to ${Number(total.toFixed(2))}.`,
          "Fix the manifest transcription or the parentage; a reported parent must reconcile to its filed children.",
          { section, source_line_id: parentLineId, period: period + 1, filed: target, children_sum: total },
        );
      }
    }
    parentRow.row_type = "calculation";
    parentRow.calculation = { operator: "sum", refs };
    delete parentRow.values;
    parentRow.style_role = totalStyle(parentRow) ? "total" : "subsection";
    // The DERIVED variant: a total summed live from its filed members
    // declares them as contributing children.  (The reconciled-subtotal
    // variant keeps its vintage shape untouched.)
    if (parentEntry?.reported_form === "derived") {
      // Stamped children make the hierarchy validator demand a declared
      // parent authority; a live sum over its members IS derived-from-children.
      parentRow.aggregation_authority = "derived_from_children";
      const memberClass =
        parentEntry?.member_class ??
        (parentEntry?.role === "change_in_working_capital" ? "working_capital" : null);
      for (const childLineId of childLineIds) {
        const child = rowsBySourceLine.get(childLineId);
        if (!child) continue;
        child.parent_row_id = parentRow.row_id;
        child.aggregation_role = "contributing_child";
        if (memberClass) child.economic_class = memberClass;
        child.forecast_treatment =
          child.forecast_calculation ||
          (child.forecast_period_calculations ?? []).some(Boolean)
            ? "formula"
            : "uncalculated";
        child.indent = Math.max(1, Number(child.indent ?? 0));
      }
    }
  }
  // Broker bindings and historical authority receipts.  Every non-header row
  // states where its history comes from: filed values are source_input,
  // minted subtotal formulas are derived_formula.  This is the authority_v1
  // half of filings symmetry — a value without a named source cannot exist.
  for (const { row: line } of lines) {
    const entry = entriesById.get(line.source_line_id);
    const row = rowsBySourceLine.get(line.source_line_id);
    if (!row) continue;
    if (entry?.broker_metric_id && rowsBySourceLine.get(line.source_line_id) === row) {
      row.broker_metric_id = entry.broker_metric_id;
    }
  }
  for (const row of rows) {
    if (row.row_type === "header") continue;
    if (row.row_type === "calculation") {
      row.historical_authority = "derived_formula";
      continue;
    }
    const historicals = (row.values ?? []).slice(0, 3);
    if (historicals.length === 3 && historicals.every((value) => Number.isFinite(Number(value)) && value !== null)) {
      row.historical_authority = "source_input";
    }
  }

  // Declared derivations: a filed line represented as an identity over other
  // rows (inverted derivations included).  The declaration names rows only;
  // the filed values retire to the manifests as reconciliation evidence.
  for (const { row: line } of lines) {
    const entry = entriesById.get(line.source_line_id);
    const row = rowsBySourceLine.get(line.source_line_id);
    if (!entry?.derive_as || !row) continue;
    row.row_type = "calculation";
    row.calculation = {
      operator: entry.derive_as.operator,
      refs: [...entry.derive_as.refs],
    };
    row.historical_authority = "derived_formula";
    if (["ratio", "negated_ratio", "growth"].includes(entry.derive_as.operator)) {
      row.number_format ??= "percentage";
      row.style_role ??= "subsection";
    }
    if (["prior_period", "prior_period_scaled_by"].includes(entry.derive_as.operator)) {
      row.forecast_treatment = "formula";
      // A temporal identity reads ACROSS periods — the filed history is its
      // seed, not a retired reconciliation target.
      row.values = [...(row.values ?? []).slice(0, 3), null, null, null];
    } else {
      delete row.values;
    }
  }
  // Authored forecast wiring declarations.
  for (const { row: line } of lines) {
    const entry = entriesById.get(line.source_line_id);
    const row = rowsBySourceLine.get(line.source_line_id);
    if (!row) continue;
    if (entry?.forecast_derive_as && !row.forecast_calculation) {
      row.forecast_treatment = "formula";
      row.forecast_calculation = {
        operator: entry.forecast_derive_as.operator,
        refs: [...entry.forecast_derive_as.refs],
      };
    }
    if (
      Array.isArray(entry?.forecast_period_derive_as) &&
      !(row.forecast_period_calculations ?? []).some(Boolean)
    ) {
      row.forecast_treatment = "formula";
      row.forecast_period_calculations = entry.forecast_period_derive_as.map(
        (rule, index) =>
          rule
            ? { operator: rule.operator, refs: [...rule.refs], forecast_index: index }
            : null,
      );
    }
    void line;
  }

  // Reconciled reported parents keep their filed series as the target the
  // formula must tie to.
  for (const { row: line } of lines) {
    const entry = entriesById.get(line.source_line_id);
    const row = rowsBySourceLine.get(line.source_line_id);
    if (!row || entry?.reported_form !== "reconciled") continue;
    if (row.row_type === "calculation") {
      row.row_type = "subtotal";
    }
  }

  for (const { row: line } of lines) {
    const entry = entriesById.get(line.source_line_id);
    if (!entry?.reported_parent) continue;
    const row = rowsBySourceLine.get(line.source_line_id);
    if (row && !["calculation", "subtotal"].includes(row.row_type)) {
      report.add(
        "statement_map.reported_parent_without_children",
        "BLOCK",
        `${section}.${line.source_line_id} is declared reported_parent but no filed line names it as parent, so no calculation can be minted.`,
        "Declare parent_source_line_id on its children in the manifests/crosswalk, or drop the reported_parent declaration.",
        { section, source_line_id: line.source_line_id },
      );
    }
  }

  return { rows, rowsBySourceLine, entriesById, lines, expansionRowsByLine };
}

/**
 * Mint the section's source_coverage from the same crosswalk that minted the
 * rows, including the FULL classification receipt the evidence_v1 contract
 * demands: the classifier's verdict, candidates and evidence, accepted when
 * it reproduces cleanly, manual-reviewed with a recorded rationale when the
 * map's declaration is what settles the role.
 */
function compileSourceCoverage({ section, lines, entriesById, rowsBySourceLine, expansionRowsByLine = new Map() }) {
  return lines.map(({ manifest, row: line }) => {
    const entry = entriesById.get(line.source_line_id);
    const target = entry?.disposition === "absorb"
      ? rowsBySourceLine.get(entry.absorb_into)
      : rowsBySourceLine.get(line.source_line_id);
    const disclosure = {
      source_line_id: line.source_line_id,
      label: line.raw_label,
      document: manifest.source_id,
      page_or_note: line.page_or_note ?? manifest.page_or_note ?? "face statement",
      face_statement: true,
      material: line.material ?? null,
      disposition: ["absorb", "expand"].includes(entry?.disposition) ? "aggregated" : "mapped",
      mapped_row_ids: expansionRowsByLine.get(line.source_line_id) ?? (target ? [target.row_id] : []),
    };
    const classification = classifyStatementLine({ ...disclosure, section });
    disclosure.mapping_method = "exact";
    const declaredRole = entry?.role ?? null;
    disclosure.classifier_version = `statement-taxonomy/${classification.taxonomy_version}`;
    disclosure.classification_candidates = classification.candidates.length
      ? classification.candidates
      : [{ role: "unmapped", score: 0 }];
    disclosure.classification_evidence = classification.evidence.length
      ? classification.evidence
      : [{ channel: "label", detail: "no taxonomy candidate cleared zero", score: 0 }];
    disclosure.classification_confidence = classification.confidence;
    if (
      classification.status === "accepted" &&
      (!declaredRole || declaredRole === classification.classified_role)
    ) {
      disclosure.classification_status = "accepted";
      disclosure.classification_review_status = "auto_accepted";
      disclosure.classified_role = classification.classified_role;
    } else {
      disclosure.classification_status = "manual_reviewed";
      disclosure.classification_review_status = "reviewed";
      disclosure.classified_role = declaredRole ?? classification.classified_role ?? null;
      disclosure.reason = declaredRole
        ? "Role confirmed by statement_map declaration."
        : "The disclosed line is represented through the identified visible model rows.";
    }
    return disclosure;
  });
}

/**
 * Role-driven recipes over mapped rows.  These are the compiled artifacts a
 * filed line implies but does not print — the CF opening link to the income
 * statement is the first; the derived stratum (bridges, margins, FCF block)
 * joins this table as the equivalence keel drives it out.
 */
function applyRoleRecipes(statementStructure) {
  const isRows = statementStructure.income_statement ?? [];
  const cfRows = statementStructure.cash_flow ?? [];
  const isByRole = new Map(
    isRows.filter((row) => row.semantic_role).map((row) => [row.semantic_role, row]),
  );
  for (const row of cfRows) {
    if (row.semantic_role === "cash_flow_net_income" && !row.calculation) {
      const source = /before tax/i.test(row.label ?? "")
        ? isByRole.get("pre_tax_income") ?? isByRole.get("net_income")
        : isByRole.get("net_income") ?? isByRole.get("pre_tax_income");
      if (source) {
        row.row_type = "calculation";
        row.calculation = { operator: "link", refs: [source.row_id] };
        row.historical_authority = "derived_formula";
        delete row.values;
      }
    }
  }
  // Filed ranked totals kept as inputs (operating profit, net income…) carry
  // the total style even without a minted formula.
  for (const row of [...isRows, ...cfRows]) {
    if (row.row_type === "header" || row.style_role) continue;
    if (row.semantic_role && totalStyle(row)) {
      row.style_role = "total";
    }
  }
}

/**
 * The derived stratum: rows the filings never print but the model requires —
 * ratios, the EBITDA bridge, consumption aggregates, schedule shells and the
 * FCF block.  All of it is minted from roles and the broker pack; none of it
 * is authorable.  Returns the set of minted row ids so the capture pass can
 * tell filed economics (capturable) from compiled presentation (never
 * captured — their own formulas own them).
 */
function applyDerivedStratum(modelCase, evidence = {}) {
  const derived = new Set();
  const sections = modelCase.statement_structure ?? {};
  const isRows = sections.income_statement ?? [];
  const cfRows = sections.cash_flow ?? [];
  const roleIndex = new Map();
  for (const section of ["income_statement", "cash_flow"]) {
    for (const disclosure of modelCase.source_coverage?.[section] ?? []) {
      const rows = section === "income_statement" ? isRows : cfRows;
      const row = rows.find((entry) => entry.row_id === disclosure.mapped_row_ids?.[0]);
      if (row && disclosure.classified_role && !roleIndex.has(disclosure.classified_role)) {
        roleIndex.set(disclosure.classified_role, row);
      }
    }
  }
  for (const row of [...isRows, ...cfRows]) {
    if (row.semantic_role) roleIndex.set(row.semantic_role, row);
  }
  const rowIdIndex = new Map(
    [...isRows, ...cfRows].map((row) => [row.row_id, row]),
  );
  // The taxonomy deliberately carries only high-impact roles; below it, the
  // statement_map's row_id naming IS the declaration.  A row named
  // receivables_movement is the receivables movement — the name is the
  // structural channel, exactly as it was under hand authorship, but now the
  // stratum recipes consume it instead of prose doctrine.
  const role = (id) => roleIndex.get(id) ?? rowIdIndex.get(id) ?? null;
  const packHas = (metricId) => Boolean(modelCase.broker_pack?.metrics?.[metricId]);
  const insertAfter = (rows, anchorId, newRows) => {
    const index = rows.findIndex((row) => row.row_id === anchorId);
    if (index < 0) return false;
    rows.splice(index + 1, 0, ...newRows);
    for (const row of newRows) {
      derived.add(row.row_id);
      if (row.semantic_role) roleIndex.set(row.semantic_role, row);
    }
    return true;
  };
  const insertBefore = (rows, anchorId, newRows) => {
    const index = rows.findIndex((row) => row.row_id === anchorId);
    if (index < 0) return false;
    rows.splice(index, 0, ...newRows);
    for (const row of newRows) {
      derived.add(row.row_id);
      if (row.semantic_role) roleIndex.set(row.semantic_role, row);
    }
    return true;
  };

  // Schedule shells: schedule-owned filed rows keep their filed history but
  // hand their forecast to the schedules through an empty formula shell.
  for (const shellRole of [
    "interest_income",
    "interest_expense",
    "debt_issuance",
    "debt_repayment",
    "opening_cash",
    "rcf_draw",
    "rcf_repayment",
  ]) {
    const row = role(shellRole);
    if (row && !row.calculation) {
      row.row_type = "calculation";
      row.calculation = { operator: "sum", refs: [] };
      row.semantic_role ??= shellRole;
      // A filed finance line has one visible statement location but the
      // Interest Schedule is its calculation authority in history and
      // forecast.  Keep the filed values as evidence on the row; declare the
      // schedule ownership explicitly even when those values are already
      // usable, so source-parity validation does not mistake the schedule
      // shell for a second hardcoded model authority.
      row.historical_authority = "schedule_link";
      if (shellRole === "opening_cash") row.style_role ??= "subsection";
      const usableHistory = (row.values ?? [])
        .slice(0, 3)
        .every((value) => value !== null && Number.isFinite(Number(value)));
      if (!usableHistory) {
        delete row.values;
      }
    }
  }

  // Netted interest presentation: a single filed net-interest line splits
  // into the two schedule shells the model wires.
  {
    const netInterest =
      rowIdIndex.get("net_interest_expense") ??
      isRows.find((row) => /net interest/i.test(row.label ?? "") && row.row_type !== "header");
    if (netInterest && !role("interest_expense") && !role("interest_income")) {
      const shells = [
        {
          row_id: "interest_expense",
          label: "Interest expense",
          row_type: "calculation",
          calculation: { operator: "sum", refs: [] },
          semantic_role: "interest_expense",
          historical_authority: "schedule_link",
          indent: 1,
        },
        {
          row_id: "interest_income",
          label: "Interest income",
          row_type: "calculation",
          calculation: { operator: "sum", refs: [] },
          semantic_role: "interest_income",
          historical_authority: "schedule_link",
          indent: 1,
        },
      ];
      insertBefore(isRows, netInterest.row_id, shells);
      netInterest.row_type = netInterest.row_type === "subtotal" ? "subtotal" : "calculation";
      netInterest.calculation = { operator: "sum", refs: ["interest_expense", "interest_income"] };
      netInterest.historical_authority = "derived_formula";
      delete netInterest.values;
    }
  }

  // Income statement ratios.
  const revenue = role("revenue");
  if (revenue && !role("revenue_growth") && !isRows.some((row) => row.row_id === "revenue_growth")) {
    insertAfter(isRows, revenue.row_id, [{
      row_id: "revenue_growth",
      label: "Revenue growth %",
      row_type: "calculation",
      calculation: { operator: "growth", refs: [revenue.row_id] },
      number_format: "percentage",
      style_role: "subsection",
    }]);
  }
  const taxExpense = role("tax_expense");
  const preTax = role("pre_tax_income");
  if (taxExpense && preTax && !role("effective_tax_rate")) {
    insertAfter(isRows, preTax.row_id, [{
      row_id: "effective_tax_rate",
      label: "Effective tax rate",
      row_type: "calculation",
      calculation: { operator: "negated_ratio", refs: [taxExpense.row_id, preTax.row_id] },
      semantic_role: "effective_tax_rate",
      number_format: "percentage",
      style_role: "subsection",
    }]);
  }
  const attributionRows = isRows.filter(
    (row) =>
      row.row_type !== "header" &&
      /equity holders|owners of the parent|non-controlling/i.test(row.label ?? ""),
  );
  const owners = role("owners_of_parent") ?? attributionRows[0] ?? null;
  if (owners && !isRows.some((row) => row.row_id === "attribution_header")) {
    insertBefore(isRows, owners.row_id, [{
      row_id: "attribution_header",
      label: /continuing/i.test(owners.label ?? "") ? "Attributable to" : "Profit attributable to",
      row_type: "header",
      style_role: "subsection",
    }]);
    for (const row of new Set([owners, role("non_controlling_interests"), ...attributionRows])) {
      if (row) row.indent = Math.max(1, Number(row.indent ?? 0));
    }
  }

  // Cross-statement recipes on mapped CF adjustment lines: the filed finance
  // result and D&A add-backs restate income-statement quantities, so their
  // model form is a formula over the IS rows, not a second set of inputs.
  const financeResult = role("cash_flow_finance_result");
  const interestIncome = role("interest_income");
  const interestExpense = role("interest_expense");
  if (financeResult && interestIncome && interestExpense && !financeResult.calculation) {
    financeResult.row_type = "calculation";
    financeResult.calculation = {
      operator: "negate_sum",
      refs: [interestIncome.row_id, interestExpense.row_id],
    };
    financeResult.historical_authority = "derived_formula";
    delete financeResult.values;
  }

  // The EBITDA bridge: minted whenever the pack can price a headline anchor
  // and the operating-profit level exists to bridge from.
  const operatingProfit = role("ebit") ?? role("operating_profit");
  // The bridge's D&A evidence is the cash-flow statement's filed D&A line;
  // where the issuer splits continuing/discontinued, the model's stated basis
  // is continuing operations.
  const cfDaCandidates = cfRows.filter(
    (row) =>
      /depreciat|amortis|amortiz/i.test(row.label ?? "") &&
      !/grant/i.test(row.label ?? "") &&
      row.row_type === "input" &&
      (row.values ?? []).slice(0, 3).some((value) => Number.isFinite(Number(value))),
  );
  const preferredCfDa =
    cfDaCandidates.find((row) => /continuing/i.test(row.label ?? "")) ??
    (cfDaCandidates.length === 1 ? cfDaCandidates[0] : null);
  const cfDa =
    role("cash_flow_da") ?? role("cash_flow_depreciation_amortisation") ?? preferredCfDa;
  // Where the issuer splits depreciation and amortisation across lines, the
  // bridge input is their sum; a single filed line becomes a link.
  const cfDaGroup = preferredCfDa ? [preferredCfDa] : cfDaCandidates;
  const cfDaGroupValues =
    cfDaGroup.length > 0 &&
    cfDaGroup.every((row) =>
      (row.values ?? []).slice(0, 3).every((value) => Number.isFinite(Number(value))),
    )
      ? [0, 1, 2].map((period) =>
          Number(
            cfDaGroup
              .reduce((total, row) => total + Number(row.values[period]), 0)
              .toFixed(6),
          ),
        )
      : null;
  if (
    operatingProfit &&
    !role("adjusted_ebitda") &&
    (packHas("adjusted_ebitda") || packHas("depreciation_and_amortisation"))
  ) {
    const daValues = cfDaGroupValues
      ? [...cfDaGroupValues, null, null, null]
      : [null, null, null, null, null, null];
    const bridgeRows = [
      {
        row_id: "ebitda_bridge_header",
        label: "EBITDA bridge",
        row_type: "header",
        style_role: "subsection",
      },
      {
        row_id: "bridge_operating_profit",
        label: operatingProfit.label,
        row_type: "calculation",
        calculation: { operator: "link", refs: [operatingProfit.row_id] },
        indent: 1,
      },
      {
        row_id: "depreciation_and_amortisation",
        label: cfDa?.label ?? "Depreciation and amortisation",
        row_type: "input",
        values: daValues,
        semantic_role: "depreciation_and_amortisation",
        indent: 1,
      },
      {
        row_id: "adjusted_ebitda",
        label: "EBITDA proxy",
        row_type: "calculation",
        calculation: { operator: "sum", refs: ["bridge_operating_profit", "depreciation_and_amortisation"] },
        semantic_role: "adjusted_ebitda",
        style_role: "total",
      },
      {
        row_id: "adjusted_ebitda_margin",
        label: "EBITDA proxy margin",
        row_type: "calculation",
        calculation: { operator: "ratio", refs: ["adjusted_ebitda", revenue?.row_id ?? operatingProfit.row_id] },
        number_format: "percentage",
        style_role: "subsection",
      },
    ];
    isRows.push(...bridgeRows);
    for (const row of bridgeRows) {
      derived.add(row.row_id);
      if (row.semantic_role) roleIndex.set(row.semantic_role, row);
    }
    if (daValues.slice(0, 3).every((value) => Number.isFinite(Number(value)))) {
      bridgeRows[2].historical_authority = "source_input";
    }
    // A SINGLE CF filed D&A line now restates the bridge input rather than
    // carrying a second copy of the same filed numbers; split lines keep
    // their filed identity and aggregate through a declared cash_flow_da.
    if (cfDa && cfDaGroup.length === 1 && cfRows.includes(cfDa)) {
      cfDa.row_type = "calculation";
      cfDa.calculation = { operator: "link", refs: ["depreciation_and_amortisation"] };
      cfDa.historical_authority = "derived_formula";
      cfDa.style_role = "subsection";
      delete cfDa.values;
    }
  } else if (
    operatingProfit &&
    role("adjusted_ebitda") &&
    role("adjusted_ebitda") !== operatingProfit &&
    (role("depreciation_and_amortisation") || cfDa)
  ) {
    // Variant B — the issuer PRINTS an EBITDA line on the face.  The filed
    // memo becomes the bridge identity (its refs are compiled, never filed
    // parentage), the filed D&A expense restates the D&A input, and the
    // bridge block closes with a reconciliation row attesting the two forms
    // agree.
    const adjEbitda = role("adjusted_ebitda");
    let daRow = role("depreciation_and_amortisation");
    if (!daRow && cfDaGroupValues) {
      daRow = {
        row_id: "depreciation_and_amortisation",
        label: cfDaGroup.length === 1 ? cfDaGroup[0].label : "Depreciation and amortisation",
        row_type: "input",
        values: [...cfDaGroupValues, null, null, null],
        semantic_role: "depreciation_and_amortisation",
        historical_authority: "source_input",
      };
      isRows.push(daRow);
      derived.add(daRow.row_id);
      roleIndex.set("depreciation_and_amortisation", daRow);
      if (cfDaGroup.length === 1 && cfRows.includes(cfDaGroup[0])) {
        const single = cfDaGroup[0];
        single.row_type = "calculation";
        single.calculation = { operator: "link", refs: ["depreciation_and_amortisation"] };
        single.historical_authority = "derived_formula";
        delete single.values;
      }
    }
    const expansionDaLink = !daRow && !cfDa
      ? cfRows.find(
          (row) =>
            row.calculation?.operator === "link" &&
            row.calculation.refs?.[0] === "depreciation_and_amortisation",
        )
      : null;
    if (!daRow && expansionDaLink) {
      const expansion = (evidence?.lanes?.statement_expansions ?? []).find((entry) =>
        (entry.rows ?? []).some((row) => row.row_id === expansionDaLink.row_id),
      );
      const involvedLines = flattenManifests(
        evidence?.face_statement_manifests?.cash_flow ?? [],
      ).filter(({ row: line }) =>
        (expansion?.source_line_ids ?? []).includes(line.source_line_id),
      );
      if (involvedLines.length > 0) {
        const summed = [0, 1, 2].map((period) =>
          involvedLines.reduce(
            (total, { row: line }) => total + Number(line.values?.[period] ?? 0),
            0,
          ),
        );
        daRow = {
          row_id: "depreciation_and_amortisation",
          label: "Depreciation and amortisation",
          row_type: "input",
          values: [...summed, null, null, null],
          semantic_role: "depreciation_and_amortisation",
          historical_authority: "source_input",
        };
        isRows.push(daRow);
        derived.add(daRow.row_id);
        roleIndex.set("depreciation_and_amortisation", daRow);
      }
    }
    if (!daRow && cfDa) {
      daRow = {
        row_id: "depreciation_and_amortisation",
        label: "Depreciation and amortisation",
        row_type: "input",
        values: [...(cfDa.values ?? [null, null, null]).slice(0, 3), null, null, null],
        semantic_role: "depreciation_and_amortisation",
      };
      if (daRow.values.slice(0, 3).every((value) => Number.isFinite(Number(value)))) {
        daRow.historical_authority = "source_input";
      }
      isRows.push(daRow);
      derived.add(daRow.row_id);
      roleIndex.set("depreciation_and_amortisation", daRow);
      // The CF filed line restates the bridge input from here on.
      cfDa.row_type = "calculation";
      cfDa.calculation = { operator: "link", refs: ["depreciation_and_amortisation"] };
      cfDa.historical_authority = "derived_formula";
      delete cfDa.values;
    }
    if (
      daRow && cfDa && cfDa !== daRow &&
      cfDaGroup.length === 1 && cfRows.includes(cfDa) && !cfDa.calculation
    ) {
      cfDa.row_type = "calculation";
      cfDa.calculation = { operator: "link", refs: [daRow.row_id] };
      cfDa.historical_authority = "derived_formula";
      delete cfDa.values;
    }
    const nti = role("non_trading_items");
    const isDaExpense = role("is_da_expense");
    const bridgeBase = rowIdIndex.get("operating_profit") ?? operatingProfit;
    if (!adjEbitda.calculation) {
      adjEbitda.row_type = "calculation";
      adjEbitda.calculation = {
        operator: "sum",
        refs: [
          bridgeBase.row_id,
          ...(nti ? ["non_trading_addback"] : []),
          daRow.row_id,
        ],
      };
      delete adjEbitda.values;
    }
    adjEbitda.historical_authority = "derived_formula";
    adjEbitda.style_role ??= "total";
    // A declared inline bridge carries members BEYOND the doctrine trio —
    // the face is the bridge, so no separate attest block is minted.
    const doctrineMembers = new Set([
      (rowIdIndex.get("operating_profit") ?? operatingProfit).row_id,
      "non_trading_addback",
      daRow?.row_id,
    ]);
    const declaredInlineBridge = Boolean(
      adjEbitda.calculation &&
        adjEbitda.calculation.refs.some((ref) => !doctrineMembers.has(ref)),
    );
    if (isDaExpense && !isDaExpense.calculation && !declaredInlineBridge) {
      isDaExpense.row_type = "calculation";
      isDaExpense.calculation = { operator: "negate", refs: [daRow.row_id] };
      isDaExpense.historical_authority = "derived_formula";
      delete isDaExpense.values;
    }
    if (!isRows.some((row) => row.row_id === "adjusted_ebitda_margin") && revenue) {
      insertAfter(isRows, adjEbitda.row_id, [{
        row_id: "adjusted_ebitda_margin",
        label: "Adjusted EBITDA margin",
        row_type: "calculation",
        calculation: { operator: "ratio", refs: [adjEbitda.row_id, revenue.row_id] },
        number_format: "percentage",
        style_role: "subsection",
      }]);
    }
    const ebitAnchor = nti ?? isDaExpense ?? adjEbitda;
    if (!role("ebit") && isDaExpense && !declaredInlineBridge) {
      insertAfter(isRows, ebitAnchor.row_id, [{
        row_id: "ebit",
        label: "Operating profit before non-trading items",
        row_type: "calculation",
        semantic_role: "ebit",
        calculation: { operator: "sum", refs: [adjEbitda.row_id, isDaExpense.row_id] },
        style_role: "subsection",
        historical_authority: "derived_formula",
      }]);
    }
    const ebitRow = role("ebit");
    // When the filed operating-profit line IS the ebit row, there is nothing
    // to bridge from — the level forecasts by broker, never from itself.
    if (ebitRow && ebitRow !== operatingProfit &&
        !operatingProfit.forecast_calculation && !operatingProfit.calculation) {
      operatingProfit.forecast_treatment = "formula";
      operatingProfit.forecast_calculation = {
        operator: "sum",
        refs: [ebitRow.row_id, ...(nti ? [nti.row_id] : [])],
      };
    }
    if (declaredInlineBridge) {
      // The issuer's face carries the whole bridge inline (declared refs);
      // no separate attest block is minted.
    } else {
    // The bridge block: filed D&A moves in beside the minted members.
    // Recipes are ensure-idempotent — a member the issuer FILES (synthetic
    // maximal cases print the whole bridge) is reused, never duplicated.
    const existingIds = new Set(isRows.map((row) => row.row_id));
    const daIndex = isRows.indexOf(daRow);
    if (daIndex >= 0) isRows.splice(daIndex, 1);
    daRow.indent = 1;
    const bridgeRows = [
      {
        row_id: "adjusted_ebitda_bridge",
        label: "Adjusted EBITDA bridge",
        row_type: "header",
        style_role: "subsection",
      },
      {
        row_id: "bridge_operating_profit",
        label: operatingProfit.label,
        row_type: "calculation",
        calculation: { operator: "link", refs: [operatingProfit.row_id] },
        indent: 1,
        historical_authority: "derived_formula",
      },
      ...(nti
        ? [{
            row_id: "non_trading_addback",
            label: nti.label,
            row_type: "calculation",
            calculation: { operator: "negate", refs: [nti.row_id] },
            indent: 1,
            historical_authority: "derived_formula",
          }]
        : []),
      daRow,
      {
        row_id: "adjusted_ebitda_bridge_total",
        label: "Adjusted EBITDA",
        row_type: "calculation",
        calculation: {
          operator: "sum",
          refs: [
            "bridge_operating_profit",
            ...(nti ? ["non_trading_addback"] : []),
            daRow.row_id,
          ],
        },
        style_role: "total",
        historical_authority: "derived_formula",
      },
      {
        row_id: "adjusted_ebitda_reconciliation",
        label: "Adjusted EBITDA reconciliation",
        row_type: "calculation",
        calculation: {
          operator: "subtract",
          refs: [adjEbitda.row_id, "adjusted_ebitda_bridge_total"],
        },
        indent: 1,
        historical_authority: "derived_formula",
      },
    ];
    const newBridgeRows = bridgeRows.filter(
      (row) => row !== daRow && !existingIds.has(row.row_id),
    );
    isRows.push(...newBridgeRows);
    // Reinsert the filed D&A row at its bridge position.
    const totalIndex = isRows.findIndex((row) => row.row_id === "adjusted_ebitda_bridge_total");
    isRows.splice(totalIndex < 0 ? isRows.length : totalIndex, 0, daRow);
    for (const row of newBridgeRows) {
      derived.add(row.row_id);
      if (row.semantic_role) roleIndex.set(row.semantic_role, row);
    }
    }
  }

  // Ensure-recipes for identities the issuer may either file or omit: when
  // the row exists it is converted to its identity form; when absent and its
  // ingredients exist, doctrine elsewhere mints it.
  {
    const netFinance = role("net_finance_result") ?? rowIdIndex.get("net_finance_result");
    const interestIncomeRow = role("interest_income");
    const interestExpenseRow = role("interest_expense");
    if (netFinance && interestIncomeRow && interestExpenseRow && !netFinance.calculation) {
      netFinance.row_type = "calculation";
      netFinance.calculation = {
        operator: "sum",
        refs: [interestIncomeRow.row_id, interestExpenseRow.row_id],
      };
      netFinance.historical_authority = "derived_formula";
      delete netFinance.values;
    }
    const fcf = rowIdIndex.get("free_cash_flow");
    const cfoForFcf = role("cash_from_operations");
    const capexForFcf = role("capex") ?? rowIdIndex.get("capex");
    if (fcf && cfoForFcf && capexForFcf && !fcf.calculation) {
      fcf.row_type = "calculation";
      fcf.calculation = { operator: "sum", refs: [cfoForFcf.row_id, capexForFcf.row_id] };
      fcf.historical_authority = "derived_formula";
      fcf.style_role = "total";
      delete fcf.values;
    }
  }

  // Consumption aggregates interpose between filed children and their filed
  // parent: the aggregate consumes the broker series, the parent's formula is
  // rewired to reference it.
  const interpose = (rows, aggregate, childIds) => {
    if (childIds.length < (aggregate.min_children ?? 2)) return;
    if (rows.some((row) => row.row_id === aggregate.row_id)) return;
    const minted = {
      row_id: aggregate.row_id,
      label: aggregate.label,
      row_type: "calculation",
      calculation: { operator: "sum", refs: childIds },
      semantic_role: aggregate.role,
      style_role: "subsection",
    };
    // The aggregate's children read as one contiguous block: hoist them
    // together at the first child's position (filed order within the block),
    // with the aggregate closing it.
    const firstIndex = rows.findIndex((row) => childIds.includes(row.row_id));
    if (firstIndex >= 0) {
      const block = childIds
        .map((id) => rows.find((row) => row.row_id === id))
        .filter(Boolean);
      const remaining = rows.filter((row) => !childIds.includes(row.row_id));
      const insertAt = remaining.findIndex(
        (row) => rows.indexOf(row) > firstIndex,
      );
      rows.length = 0;
      rows.push(
        ...remaining.slice(0, insertAt < 0 ? remaining.length : insertAt),
        ...block,
        ...remaining.slice(insertAt < 0 ? remaining.length : insertAt),
      );
    }
    if (!insertAfter(rows, childIds[childIds.length - 1], [minted])) return;
    if (aggregate.indent_children) {
      for (const childId of childIds) {
        const child = rows.find((row) => row.row_id === childId);
        if (child) child.indent = Math.max(1, Number(child.indent ?? 0));
      }
    }
    for (const parent of rows) {
      if (!parent.calculation?.refs || parent.row_id === aggregate.row_id) continue;
      if (childIds.every((id) => parent.calculation.refs.includes(id))) {
        // The aggregate takes the children's place IN PLACE — the parent's
        // reading order is filed order, and the interposition must not
        // reshuffle it.
        let placed = false;
        parent.calculation.refs = parent.calculation.refs.flatMap((ref) => {
          if (!childIds.includes(ref)) return [ref];
          if (placed) return [];
          placed = true;
          return [aggregate.row_id];
        });
      }
    }
  };
  const WC_MEMBER_IDS = new Set([
    "receivables_movement", "inventory_movement",
    "payables_provisions_movement", "payables_movement",
    "provisions_movement", "working_capital_other_movement",
  ]);
  const wcChildren = cfRows
    .filter((row) => WC_MEMBER_IDS.has(row.row_id))
    .map((row) => row.row_id);
  if (!role("change_in_working_capital")) {
    interpose(cfRows, {
      row_id: "change_in_working_capital",
      label: "Change in working capital",
      role: "change_in_working_capital",
      indent_children: true,
    }, wcChildren);
  }
  const CAPEX_MEMBER_IDS = new Set([
    "ppe_purchases", "ppe_additions",
    "intangible_purchases", "intangible_additions",
  ]);
  const capexChildren = cfRows
    .filter((row) => CAPEX_MEMBER_IDS.has(row.row_id))
    .map((row) => row.row_id);
  if (!role("capex")) {
    interpose(cfRows, {
      row_id: "capex",
      label: "Capital expenditure",
      role: "capex",
      min_children: 1,
    }, capexChildren);
  }

  // Section headers and the financing shells.
  const cfo = role("cash_from_operations");
  if (cfo && !cfRows.some((row) => row.row_id === "investing_activities")) {
    insertAfter(cfRows, cfo.row_id, [{
      row_id: "investing_activities",
      label: "Investing activities",
      row_type: "header",
      style_role: "subsection",
    }]);
  }
  const financingAnchor = role("cash_before_financing") ?? role("cash_from_investing");
  if (financingAnchor && !cfRows.some((row) => row.row_id === "financing_activities")) {
    insertAfter(cfRows, financingAnchor.row_id, [{
      row_id: "financing_activities",
      label: "Financing activities",
      row_type: "header",
      style_role: "subsection",
    }]);
  }
  const cff = role("cash_from_financing");
  if (cff) {
    const shells = [];
    if (packHas("share_buybacks") && !role("share_buybacks")) {
      shells.push({
        row_id: "share_buybacks",
        label: "Share buybacks",
        row_type: "input",
        values: [0, 0, 0, null, null, null],
        semantic_role: "share_buybacks",
        historical_authority: "source_input",
      });
    }
    if (!role("rcf_draw")) {
      shells.push({
        row_id: "rcf_draw",
        label: "RCF draw",
        row_type: "calculation",
        calculation: { operator: "sum", refs: [] },
        semantic_role: "rcf_draw",
        movement_type: "rcf_draw",
        cash_flow_classification: "financing",
      });
    }
    if (!role("rcf_repayment")) {
      shells.push({
        row_id: "rcf_repayment",
        label: "RCF repayment",
        row_type: "calculation",
        calculation: { operator: "sum", refs: [] },
        semantic_role: "rcf_repayment",
        movement_type: "rcf_repayment",
        cash_flow_classification: "financing",
      });
    }
    if (shells.length > 0) {
      insertBefore(cfRows, cff.row_id, shells);
      if (cff.calculation?.refs) {
        for (const shell of shells) {
          if (!cff.calculation.refs.includes(shell.row_id)) {
            cff.calculation.refs = [...cff.calculation.refs, shell.row_id];
          }
        }
      }
    }
  }

  // The net-change identity references all three activity subtotals — a
  // triple reference no single-parent manifest tree can carry, so the
  // compiler owns it as a recipe.
  const netChange = role("net_change_in_cash");
  const cfoRow = role("cash_from_operations");
  const cfiRow = role("cash_from_investing");
  if (netChange && cfoRow && cfiRow && cff) {
    netChange.row_type = "calculation";
    netChange.calculation = {
      operator: "sum",
      refs: [cfoRow.row_id, cfiRow.row_id, cff.row_id],
    };
    netChange.historical_authority = "derived_formula";
    netChange.style_role = "total";
    delete netChange.values;
  }
  // The cash roll-forward reads opening → movement → translation.
  const endingCash2 = role("ending_cash");
  const openingCash = role("opening_cash");
  const fxRow = role("fx_effect_on_cash");
  if (endingCash2 && openingCash && netChange) {
    const hadFx = Boolean(
      fxRow &&
        (endingCash2.calculation?.refs?.includes(fxRow.row_id) ??
          cfRows.includes(fxRow)),
    );
    endingCash2.row_type = "calculation";
    endingCash2.calculation = {
      operator: "sum",
      refs: [openingCash.row_id, netChange.row_id, ...(hadFx ? [fxRow.row_id] : [])],
    };
    endingCash2.historical_authority = "derived_formula";
    // The filed historical balances stay: the bucket-tie check reconciles
    // the ending-cash HISTORY against the explicit cash buckets, and a
    // formula cannot witness a filed balance.
    if (Array.isArray(endingCash2.values)) {
      endingCash2.values = [...endingCash2.values.slice(0, 3), null, null, null];
      if (endingCash2.values.slice(0, 3).every((value) => value === null)) {
        delete endingCash2.values;
      }
    }
  }

  // The free-cash-flow block closes the statement.
  const endingCash = role("ending_cash");
  const capexRow = role("capex");
  const adjustedEbitda = role("adjusted_ebitda");
  if (endingCash && cfo && capexRow && !cfRows.some((row) => row.row_id === "free_cash_flow")) {
    const block = [
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
        calculation: { operator: "sum", refs: [cfo.row_id, capexRow.row_id] },
        style_role: "total",
      },
      ...(adjustedEbitda
        ? [{
            row_id: "free_cash_flow_conversion",
            label: "Free cash flow conversion",
            row_type: "calculation",
            calculation: { operator: "ratio", refs: ["free_cash_flow", adjustedEbitda.row_id] },
            number_format: "percentage",
            style_role: "subsection",
          }]
        : []),
    ];
    insertAfter(cfRows, endingCash.row_id, block);
  }

  // Module-conditional rows: with the acquisition module disabled, the
  // acquisitions line is a declared zero with its investing classification.
  {
    const acquisitions = rowIdIndex.get("acquisitions_net_of_cash");
    if (acquisitions && !acquisitions.calculation) {
      acquisitions.movement_type ??= "investing_cash_flow";
      acquisitions.cash_flow_classification ??= "investing";
      if (
        !(acquisitions.values ?? []).slice(3).some((value) => value !== null && value !== undefined) &&
        !acquisitions.forecast_period_authorities
      ) {
        const acqDate = (modelCase.periods ?? [])
          .filter((period) => period?.status === "historical")
          .map((period) => period.date)
          .at(-1) ?? null;
        acquisitions.forecast_period_authorities = [0, 1, 2].map(() => ({
          method: "user_assumption",
          source_kind: "user_supplied",
          source_id: "policy.acquisitions_default",
          ...(acqDate ? { as_of_date: acqDate } : {}),
          value: 0,
          material: false,
          note: "No acquisition programme is modeled; the line holds at zero unless the acquisition module supplies it.",
        }));
      }
    }
  }

  // Ensure-identities: rows the issuer FILES that the doctrine also owns are
  // converted to their identity forms in place — mint-or-convert, never
  // duplicate, never leave a doctrine row as a dead input.
  {
    const ensure = (rowId, spec) => {
      const target = rowIdIndex.get(rowId) ?? roleIndex.get(rowId);
      if (!target) return;
      // A proposed source row can already carry the canonical row ID without
      // carrying the semantic role.  Formula identity alone is not enough:
      // downstream acquisition, forecast and proof graphs resolve economic
      // authorities by semantic role.  Preserve the identity whenever this
      // doctrine owns it, even if the row already has its calculation.
      if (spec.semantic_role && !target.semantic_role) {
        target.semantic_role = spec.semantic_role;
        roleIndex.set(spec.semantic_role, target);
      }
      if (target.calculation) return;
      if ((spec.refs ?? []).some((ref) => !rowIdIndex.has(ref) && !roleIndex.has(ref))) return;
      target.row_type = "calculation";
      target.calculation = { operator: spec.operator, refs: spec.refs };
      target.historical_authority = "derived_formula";
      if (spec.number_format) target.number_format ??= spec.number_format;
      if (spec.style_role) target.style_role ??= spec.style_role;
      delete target.values;
    };
    const revenueRow = role("revenue");
    const adjRow = role("adjusted_ebitda");
    const taxRow = role("tax_expense");
    const preTaxRow = role("pre_tax_income");
    const ntiRow = role("non_trading_items");
    const daBridgeRow = roleIndex.get("depreciation_and_amortisation");
    const opBase = rowIdIndex.get("operating_profit") ?? role("ebit");
    if (revenueRow) {
      ensure("revenue_growth", { operator: "growth", refs: [revenueRow.row_id], number_format: "percentage", style_role: "subsection" });
      if (adjRow) ensure("adjusted_ebitda_margin", { operator: "ratio", refs: [adjRow.row_id, revenueRow.row_id], number_format: "percentage", style_role: "subsection" });
    }
    if (taxRow && preTaxRow) {
      ensure("effective_tax_rate", {
        operator: "negated_ratio",
        refs: [taxRow.row_id, preTaxRow.row_id],
        semantic_role: "effective_tax_rate",
        number_format: "percentage",
        style_role: "subsection",
      });
    }
    if (opBase) ensure("bridge_operating_profit", { operator: "link", refs: [opBase.row_id] });
    if (ntiRow) ensure("non_trading_addback", { operator: "negate", refs: [ntiRow.row_id] });
    if (daBridgeRow) {
      const bridgeMembers = [
        rowIdIndex.get("bridge_operating_profit") ? "bridge_operating_profit" : null,
        rowIdIndex.get("non_trading_addback") ? "non_trading_addback" : null,
        daBridgeRow.row_id,
      ].filter(Boolean);
      if (bridgeMembers.length >= 2) {
        ensure("adjusted_ebitda_bridge_total", { operator: "sum", refs: bridgeMembers, style_role: "total" });
      }
      if (adjRow && rowIdIndex.get("adjusted_ebitda_bridge_total")) {
        ensure("adjusted_ebitda_reconciliation", { operator: "subtract", refs: [adjRow.row_id, "adjusted_ebitda_bridge_total"] });
      }
    }
    const fcfRow = rowIdIndex.get("free_cash_flow");
    if (fcfRow && adjRow) {
      ensure("free_cash_flow_conversion", { operator: "ratio", refs: [fcfRow.row_id, adjRow.row_id], number_format: "percentage", style_role: "subsection" });
    }
    if (fcfRow && !cfRows.some((row) => row.row_id === "free_cash_flow_header")) {
      insertBefore(cfRows, fcfRow.row_id, [{
        row_id: "free_cash_flow_header",
        label: "Free cash flow",
        row_type: "header",
        style_role: "subsection",
      }]);
    }
  }

  // Every minted calculation owns its history by formula; schedule shells
  // own theirs through the schedule link.
  for (const row of [...isRows, ...cfRows]) {
    if (!derived.has(row.row_id) || row.row_type !== "calculation") continue;
    if (SCHEDULE_ROLES.has(row.semantic_role) && (row.calculation?.refs ?? []).length === 0) {
      row.historical_authority ??= "schedule_link";
    } else {
      row.historical_authority ??= "derived_formula";
    }
  }
  return derived;
}

/**
 * Declared derived rows — the universal mechanism for modeling decisions the
 * doctrine cannot infer (an aggregate over declared members, a memo identity,
 * a presentation header).  Each declaration is a receipted decision in the
 * case-source; the compiler mints the row, wires it, and refuses anything the
 * closed operator vocabulary or the existing rows cannot justify.  This is
 * what keeps issuer-specific modeling out of the recipe engine: company #9
 * declares, the compiler projects, nothing is hand-authored.
 */
function applyDeclaredDerivedRows(modelCase, caseSource, report) {
  const minted = new Set();
  const sections = modelCase.statement_structure ?? {};
  const allIds = () =>
    new Set(
      [...(sections.income_statement ?? []), ...(sections.cash_flow ?? [])].map(
        (row) => row.row_id,
      ),
    );
  for (const declaration of caseSource.derived_rows ?? []) {
    const rows = sections[declaration.section];
    if (!rows) continue;
    if (allIds().has(declaration.row_id)) {
      report.add(
        "derived_rows.collision",
        "WARN",
        `${declaration.section}.${declaration.row_id} is declared but the doctrine already mints a row by that name; the declaration is ignored.`,
        "Remove the redundant declaration.",
        { row_id: declaration.row_id },
      );
      continue;
    }
    let row;
    if (declaration.operator === "header") {
      row = {
        row_id: declaration.row_id,
        label: declaration.label ?? declaration.row_id,
        row_type: "header",
        style_role: "subsection",
      };
    } else {
      const known = allIds();
      const missing = (declaration.refs ?? []).filter((ref) => !known.has(ref));
      const shellDeclaration =
        declaration.operator === "sum" && (declaration.refs ?? []).length === 0;
      if ((!declaration.refs?.length && !shellDeclaration) || missing.length > 0) {
        report.add(
          "derived_rows.unknown_ref",
          "BLOCK",
          `${declaration.section}.${declaration.row_id} references ${missing.join(", ") || "(no refs)"}, which no mapped or minted row provides.`,
          "Point the declaration at declared row names, or drop it.",
          { row_id: declaration.row_id, missing },
        );
        continue;
      }
      row = {
        row_id: declaration.row_id,
        label: declaration.label ?? declaration.row_id,
        row_type: "calculation",
        calculation: {
          operator: declaration.operator,
          refs: [...(declaration.refs ?? [])],
        },
        // An empty-member shell derives nothing itself: schedule-owned roles
        // link to the schedule that fills them; anything else carries no
        // historical authority to declare.
        ...(shellDeclaration
          ? SCHEDULE_ROLES.has(declaration.role ?? "")
            ? { historical_authority: "schedule_link" }
            : {}
          : { historical_authority: "derived_formula" }),
        ...(declaration.role ? { semantic_role: declaration.role } : {}),
        ...(declaration.indent ? { indent: 1 } : {}),
        ...(["ratio", "negated_ratio", "growth"].includes(declaration.operator)
          ? { number_format: "percentage", style_role: "subsection" }
          : {}),
        ...(declaration.operator === "sum" && (declaration.refs ?? []).length > 0
          ? { style_role: "subsection" }
          : {}),
      };
    }
    const anchorId = declaration.insert_after ?? declaration.refs?.at(-1) ?? null;
    const anchorIndex = anchorId
      ? rows.findIndex((candidate) => candidate.row_id === anchorId)
      : -1;
    if (anchorIndex >= 0) rows.splice(anchorIndex + 1, 0, row);
    else rows.push(row);
    minted.add(row.row_id);
    if (declaration.add_to_parent) {
      const parent = rows.find(
        (candidate) => candidate.row_id === declaration.add_to_parent,
      );
      if (parent?.calculation?.refs) {
        const orderOf = new Map(rows.map((r, i) => [r.row_id, i]));
        const myOrder = orderOf.get(row.row_id) ?? Infinity;
        const refs = parent.calculation.refs;
        // Membership follows statement order: the row joins its parent's
        // identity where it prints, never at the end by accident.
        let at = refs.findIndex((ref) => (orderOf.get(ref) ?? -1) > myOrder);
        if (at < 0) at = refs.length;
        if (!refs.includes(row.row_id)) refs.splice(at, 0, row.row_id);
      } else {
        report.add(
          "derived_rows.parent",
          "BLOCK",
          `${declaration.section}.${declaration.row_id} declares membership in ${declaration.add_to_parent}, which is not a calculating row.`,
          "Point add_to_parent at a row that carries a calculation, or drop it.",
          { row_id: declaration.row_id },
        );
      }
    }
    if (declaration.member_indent) {
      for (const ref of declaration.refs ?? []) {
        const member = rows.find((candidate) => candidate.row_id === ref);
        if (member) member.indent = Math.max(1, Number(member.indent ?? 0));
      }
    }
    if (declaration.members_declare_parent) {
      for (const ref of declaration.refs ?? []) {
        const member = rows.find((candidate) => candidate.row_id === ref);
        if (member) {
          member.parent_row_id = row.row_id;
          member.aggregation_role = "contributing_child";
        }
      }
    }
    if (declaration.replace_in_parent && declaration.refs?.length) {
      for (const parent of rows) {
        if (!parent.calculation?.refs || parent.row_id === row.row_id) continue;
        if (declaration.refs.every((ref) => parent.calculation.refs.includes(ref))) {
          let placed = false;
          parent.calculation.refs = parent.calculation.refs.flatMap((ref) => {
            if (!declaration.refs.includes(ref)) return [ref];
            if (placed) return [];
            placed = true;
            return [row.row_id];
          });
        }
      }
    }
  }
  return minted;
}

/** The major statement identities carry the total style; every other minted
 * subtotal reads as a subsection. Derived from the certified cohort's own
 * conventions, anchored on the ranked-total identities. */
const TOTAL_STYLE_ROLES = new Set([
  "revenue",
  "gross_profit",
  "operating_profit",
  "trading_profit",
  "profit_continuing",
  "pre_tax_income",
  "net_income",
  "net_income_common",
  "adjusted_ebitda",
  "adjusted_ebitda_bridge_total",
  "cash_flow_profit_before_tax",
  "cash_from_operations",
  "cash_generated_from_operations",
  "cash_from_investing",
  "cash_from_financing",
  "net_change_in_cash",
  "ending_cash",
  "free_cash_flow",
  "net_interest_expense",
]);

function totalStyle(row) {
  const identity = row.semantic_role ?? row.row_id;
  return TOTAL_STYLE_ROLES.has(identity) || isRankedTotalIdentity(identity);
}

/** Mirrors CAPTURE_PROTECTED_SPINE_ROLES in row_plan.mjs — the statement spine
 * is never captured; its forecasts belong to the economic solve. */
const SPINE_ROLES = new Set([
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

/** Schedule-owned roles: their forecasts come from the debt/lease/cash
 * schedules, so the consumption pass leaves them untouched. */
const SCHEDULE_ROLES = new Set([
  "interest_income",
  "interest_expense",
  "cash_interest_paid",
  "cash_interest_received",
  "net_finance_addback",
  "debt_issuance",
  "debt_repayment",
  "rcf_draw",
  "rcf_repayment",
  "lease_principal",
  "non_balancing_cash_bucket_movement",
  "fx_effect_on_cash",
  // The solver computes the non-cash interest add-back from the debt
  // schedule (PIK, fee amortisation) — the row is schedule-owned exactly
  // like the RCF legs, whichever channel declares it.
  "non_cash_interest_addback",
]);

// Forecast capture follows only additive statement membership. A ratio or tax
// formula consumes an input, but it does not economically contain it; using
// those edges to grey a row would remove the input from its real statement
// owner. `link`/`negate` are retained because they are transparent restatements
// of one amount, while sum/subtract/negate_sum are the additive identities that
// form a face statement.
const CAPTURE_MEMBERSHIP_OPERATORS = new Set([
  "sum",
  "subtract",
  "negate_sum",
  "negate",
  "link",
]);

// Growth and ratio rows are visible derived displays. They consume statement
// amounts but are not themselves additive statement detail, so a headline
// forecast may never capture/blank them. This also repairs stale compiled
// cases that still carry capture metadata from an older doctrine pass.
const DERIVED_DISPLAY_OPERATORS = new Set([
  "growth",
  "ratio",
  "negated_ratio",
]);

function restoreDerivedDisplayIdentity(row) {
  if (
    row?.semantic_role === "effective_tax_rate" ||
    !DERIVED_DISPLAY_OPERATORS.has(row?.calculation?.operator)
  ) {
    return false;
  }
  delete row.forecast_capture_parent_id;
  delete row.forecast_capture_mode;
  delete row.forecast_capture_note;
  delete row.forecast_capture_certificates;
  if (row.formula_authority === "intentionally_blank") {
    delete row.formula_authority;
  }
  if (row.forecast_treatment === "uncalculated") {
    delete row.forecast_treatment;
  }
  return true;
}

const CAPTURE_HEADLINE_ROLES = new Set([
  "revenue",
  "ebit",
  "ebitda",
  "adjusted_ebitda",
  "depreciation_and_amortisation",
]);

// These rows are economic spine or bridge inputs, never expendable detail.
// The list is semantic rather than issuer- or row-position-specific.
const CAPTURE_REQUIRED_ROLES = new Set([
  ...SPINE_ROLES,
  ...SCHEDULE_ROLES,
  ...CAPTURE_HEADLINE_ROLES,
  // These are transparent accounting bridges, not company-specific detail.
  // Capturing them breaks the visible EBIT/EBITDA and cash-flow D&A
  // identities even when their headline is independently forecast.
  "is_da_expense",
  "cash_flow_da",
  "cash_flow_depreciation_amortisation",
  "cash_flow_profit_before_tax",
  "recurring_disclosed_adjustments",
  "effective_tax_rate",
]);

const DIRECT_FORECAST_METHODS = new Set([
  "actual_plus_remainder",
  "contractual_commitment",
  "company_guidance",
  "company_indication",
  "broker_consensus",
  "user_assumption",
  "historical_average",
  "historical_trend",
  "seasonal_run_rate",
  "carry_forward",
  "explicit_zero",
]);

const STRUCTURAL_EVENT_ROLES = new Set([
  "acquisition_cost",
  "business_combination",
  "disposal",
  "litigation",
  "legal_settlement",
  "restructuring",
  "impairment_loss",
  "exceptional_item",
  "discontinued_operation",
]);

function carriesStructuralEventSemantics(row) {
  return (
    ["debt_issuance_cost", "other_cash_debt_movement"].includes(
      row.movement_type,
    ) ||
    STRUCTURAL_EVENT_ROLES.has(row.semantic_role)
  );
}

function hasDirectForecastAuthority(row) {
  if (!row) return false;
  if (row.broker_metric_id) return true;
  if (["broker", "hardcode", "zero"].includes(row.forecast_treatment)) {
    return true;
  }
  if (
    (row.values ?? []).slice(3, 6).some(
      (value) =>
        value !== null &&
        value !== undefined &&
        Number.isFinite(Number(value)),
    )
  ) {
    return true;
  }
  return (row.forecast_period_authorities ?? []).some(
    (authority) => authority && DIRECT_FORECAST_METHODS.has(authority.method),
  );
}

function hasLiveHeadlineForecastAuthority(row) {
  return (
    hasDirectForecastAuthority(row) ||
    (CAPTURE_HEADLINE_ROLES.has(row?.semantic_role) &&
      (Boolean(row.forecast_calculation?.refs?.length) ||
        (row.forecast_period_calculations ?? []).some(
          (calculation) => Boolean(calculation?.refs?.length),
        )))
  );
}

function mayResolveAsAggregate(row) {
  if (!row) return false;
  if (hasDirectForecastAuthority(row)) return true;
  // A filed total with no formula is a single economic series and may resolve
  // through the ordinary evidence waterfall. This remains useful for direct
  // reported-parent captures (especially working capital), but it is NOT a
  // terminal for the multi-hop slim-income-statement rule below.
  return !(row.calculation?.refs ?? []).length && !row.forecast_calculation;
}

function captureCertificates(row, targetId, mode, path, modelCase) {
  const material = (() => {
    const mapped = ["income_statement", "cash_flow"]
      .flatMap((section) => modelCase.source_coverage?.[section] ?? [])
      .filter((entry) =>
        (entry.mapped_row_ids ?? []).includes(row.row_id) ||
        (row.source_line_ids ?? []).includes(entry.source_line_id),
      );
    if (mapped.some((entry) => entry.material === true)) return true;
    if (mapped.length > 0 && mapped.every((entry) => entry.material === false)) {
      return false;
    }
    return null;
  })();
  return [0, 1, 2].map((forecastIndex) => ({
    forecast_index: forecastIndex,
    parent_row_id: targetId,
    mode,
    material,
    membership_path: [...path],
    proof:
      mode === "formula_membership"
        ? `Unique section-local additive membership path: ${path.join(" -> ")}.`
        : `Unique section-local declared semantic scope: ${path.join(" -> ")}.`,
  }));
}

function markCompilerCapture(modelCase, row, targetId, mode, path) {
  row.forecast_treatment = "uncalculated";
  row.formula_authority = "intentionally_blank";
  row.forecast_capture_parent_id = targetId;
  row.forecast_capture_mode = mode;
  row.forecast_capture_note =
    `Forecast detail is captured by ${targetId} through the certified ` +
    `${path.length - 1}-edge section-local membership path.`;
  row.forecast_capture_certificates = captureCertificates(
    row,
    targetId,
    mode,
    path,
    modelCase,
  );
}

function formulaMembershipIndex(sectionRows) {
  const localIds = new Set(sectionRows.map((row) => row.row_id));
  const byChild = new Map();
  for (const parent of sectionRows) {
    if (!CAPTURE_MEMBERSHIP_OPERATORS.has(parent.calculation?.operator)) {
      continue;
    }
    const counts = new Map();
    for (const ref of parent.calculation?.refs ?? []) {
      if (!localIds.has(ref)) continue;
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
    for (const [childId, membershipCount] of counts) {
      const parents = byChild.get(childId) ?? [];
      parents.push({ parent_row_id: parent.row_id, membership_count: membershipCount });
      byChild.set(childId, parents);
    }
  }
  return byChild;
}

/**
 * Find every shortest additive path from `startId` to a directly forecast
 * terminal. Stopping at the first terminal prevents a product row from being
 * claimed by both Revenue and the EBIT that consumes Revenue. More than one
 * shortest path is still double ownership and blocks rather than selecting by
 * source order.
 */
function shortestCapturePaths(startId, rowsById, parentsByChild, isTerminal) {
  const queue = [[startId]];
  const matches = [];
  let shortestEdges = null;
  let cycleDetected = false;
  while (queue.length > 0) {
    const path = queue.shift();
    const childId = path.at(-1);
    const edgeCount = path.length - 1;
    if (shortestEdges !== null && edgeCount >= shortestEdges) continue;
    for (const parentMembership of parentsByChild.get(childId) ?? []) {
      if (parentMembership.membership_count !== 1) continue;
      const parentId = parentMembership.parent_row_id;
      if (path.includes(parentId)) {
        cycleDetected = true;
        continue;
      }
      const parent = rowsById.get(parentId);
      if (!parent) continue;
      const nextPath = [...path, parentId];
      if (isTerminal(parent)) {
        const nextEdges = nextPath.length - 1;
        if (shortestEdges === null) shortestEdges = nextEdges;
        if (nextEdges === shortestEdges) matches.push(nextPath);
      } else {
        queue.push(nextPath);
      }
    }
  }
  return { paths: matches, cycle_detected: cycleDetected };
}

/**
 * Compile the forecast-capture subgraph. This is deliberately exported for
 * graph mutation tests: a valid capture is a unique, additive, section-local
 * path to one live forecast terminal; ambiguity is evidence of double
 * ownership, not permission to pick a convenient parent.
 */
export function compileForecastCaptureTopology(
  modelCase,
  { derivedRowIds = new Set() } = {},
) {
  const sections = modelCase.statement_structure ?? {};
  const findings = [];
  const behaviorByKey = new Map();
  const addBehavior = (section, rowId, behavior, allowedMethods) => {
    behaviorByKey.set(`${section}\u0000${rowId}`, {
      section,
      row_id: rowId,
      behavior,
      allowed_methods: [...allowedMethods],
    });
  };
  const rowSections = new Map();
  for (const [section, sectionRows] of Object.entries(sections)) {
    for (const row of sectionRows ?? []) {
      const locations = rowSections.get(row.row_id) ?? [];
      locations.push(section);
      rowSections.set(row.row_id, locations);
    }
  }

  for (const [section, sectionRows] of Object.entries(sections)) {
    const rows = sectionRows ?? [];
    const rowsById = new Map(rows.map((row) => [row.row_id, row]));
    const parentsByChild = formulaMembershipIndex(rows);

    // Run before validating pre-existing capture declarations. A compiler
    // upgrade must not leave a ratio/growth row blank merely because an older
    // case artifact incorrectly stamped it as captured detail.
    for (const row of rows) restoreDerivedDisplayIdentity(row);

    // Compiler-authored capture may never point outside its own statement.
    for (const row of rows) {
      if (!row.forecast_capture_parent_id) continue;
      if (!rowsById.has(row.forecast_capture_parent_id)) {
        findings.push({
          id: "forecast_capture.cross_section",
          severity: "BLOCK",
          message:
            `${section}.${row.row_id} points to capture parent ` +
            `${row.forecast_capture_parent_id} outside its statement section.`,
          context: {
            section,
            row_id: row.row_id,
            parent_row_id: row.forecast_capture_parent_id,
            parent_sections: rowSections.get(row.forecast_capture_parent_id) ?? [],
          },
        });
      }
    }

    for (const row of rows) {
      if (row.row_type === "header") continue;
      if (restoreDerivedDisplayIdentity(row)) continue;
      if (derivedRowIds.has(row.row_id)) continue;
      if (CAPTURE_REQUIRED_ROLES.has(row.semantic_role)) continue;
      if (row.broker_metric_id || row.forecast_calculation) continue;
      if ((row.forecast_period_calculations ?? []).some(Boolean)) continue;
      if (
        ["broker", "hardcode", "zero"].includes(row.forecast_treatment)
      ) continue;
      const explicitAuthorities = (row.forecast_period_authorities ?? []).filter(
        (authority) => authority && DIRECT_FORECAST_METHODS.has(authority.method),
      );
      if (explicitAuthorities.length === 3) continue;
      const hasUnreceiptedForecastValue = (row.values ?? [])
        .slice(3, 6)
        .some((value, index) =>
          value !== null &&
          value !== undefined &&
          Number.isFinite(Number(value)) &&
          !DIRECT_FORECAST_METHODS.has(
            row.forecast_period_authorities?.[index]?.method,
          ),
        );
      if (hasUnreceiptedForecastValue) continue;

      let selectedPath = null;
      if (section === "income_statement") {
        const result = shortestCapturePaths(
          row.row_id,
          rowsById,
          parentsByChild,
          (candidate) =>
            candidate.row_id !== row.row_id &&
            hasLiveHeadlineForecastAuthority(candidate) &&
            (CAPTURE_HEADLINE_ROLES.has(candidate.semantic_role) ||
              !candidate.calculation?.refs?.length ||
              candidate.broker_metric_id ||
              (candidate.forecast_period_authorities ?? []).some(Boolean)),
        );
        if (result.cycle_detected) {
          findings.push({
            id: "forecast_capture.cycle",
            severity: "BLOCK",
            message: `${section}.${row.row_id} reaches a cycle in the additive capture graph.`,
            context: { section, row_id: row.row_id },
          });
          continue;
        }
        if (result.paths.length > 1) {
          const targets = new Set(result.paths.map((path) => path.at(-1)));
          findings.push({
            id:
              targets.size > 1
                ? "forecast_capture.ambiguous_path"
                : "forecast_capture.double_ownership",
            severity: "BLOCK",
            message:
              `${section}.${row.row_id} has ${result.paths.length} equally short ` +
              "additive paths to directly forecast authority; capture cannot choose one.",
            context: { section, row_id: row.row_id, paths: result.paths },
          });
          continue;
        }
        selectedPath = result.paths[0] ?? null;
      }

      // Cash flow deliberately does not get multi-hop slim-statement capture.
      // It may only use a direct, independently forecast aggregate (for
      // example broker working capital or capex); every other cash-flow line
      // stays in the full evidence/inference waterfall.
      if (!selectedPath) {
        const directFormulaParents = (parentsByChild.get(row.row_id) ?? [])
          .filter(
            (parent) =>
              parent.membership_count === 1 &&
              (section === "income_statement"
                ? mayResolveAsAggregate(rowsById.get(parent.parent_row_id))
                : hasDirectForecastAuthority(rowsById.get(parent.parent_row_id))),
          )
          .map((parent) => parent.parent_row_id);
        const hierarchyParent = row.parent_row_id && rowsById.has(row.parent_row_id)
          ? rowsById.get(row.parent_row_id)
          : null;
        const hierarchyEligible =
          hierarchyParent &&
          (section === "income_statement"
            ? mayResolveAsAggregate(hierarchyParent)
            : hasDirectForecastAuthority(hierarchyParent));
        const directTargets = new Set([
          ...directFormulaParents,
          ...(hierarchyEligible ? [hierarchyParent.row_id] : []),
        ]);
        if (directTargets.size > 1) {
          findings.push({
            id: "forecast_capture.double_ownership",
            severity: "BLOCK",
            message:
              `${section}.${row.row_id} belongs directly to more than one live ` +
              "forecast aggregate.",
            context: { section, row_id: row.row_id, parents: [...directTargets] },
          });
          continue;
        }
        if (directTargets.size === 1) {
          selectedPath = [row.row_id, [...directTargets][0]];
        }
      }

      // Some face statements disclose intermediate operating lines without a
      // subtotal formula tying each one to EBIT. When Revenue and EBIT are
      // directly forecast, the ordered section band is itself a bounded
      // semantic scope: pre-Revenue detail belongs to Revenue; detail strictly
      // between Revenue and EBIT belongs to EBIT. This is the same graph rule
      // as the visible-successor statement topology, not a caption or issuer
      // exception. It never applies after EBIT and never applies to cash flow.
      let statementBandCapture = false;
      if (!selectedPath && section === "income_statement") {
        const revenueIndex = rows.findIndex(
          (candidate) => candidate.semantic_role === "revenue",
        );
        const ebitIndex = rows.findIndex(
          (candidate) => candidate.semantic_role === "ebit",
        );
        const rowIndex = rows.indexOf(row);
        const revenue = revenueIndex >= 0 ? rows[revenueIndex] : null;
        const ebit = ebitIndex >= 0 ? rows[ebitIndex] : null;
        if (
          revenue &&
          hasLiveHeadlineForecastAuthority(revenue) &&
          rowIndex >= 0 &&
          rowIndex < revenueIndex
        ) {
          selectedPath = [row.row_id, revenue.row_id];
          statementBandCapture = true;
        } else if (
          ebit &&
          hasLiveHeadlineForecastAuthority(ebit) &&
          rowIndex > revenueIndex &&
          rowIndex < ebitIndex
        ) {
          selectedPath = [row.row_id, ebit.row_id];
          statementBandCapture = true;
        }
      }

      if (!selectedPath || selectedPath.at(-1) === row.row_id) continue;
      const targetId = selectedPath.at(-1);
      // Captured rows are intentionally blank in forecast. Their membership
      // path is certified from the statement graph, but it is not a physical
      // forecast formula path: the direct headline owns the forecast and the
      // whole detail/intermediate chain stands down. Mark it semantic-scope so
      // the OOXML proof asks for exactly that physical consequence (live
      // parent, blank child) while `membership_path` retains the full graph
      // proof for independent validation.
      const mode = "semantic_scope";
      markCompilerCapture(modelCase, row, targetId, mode, selectedPath);
      addBehavior(
        section,
        row.row_id,
        "captured_detail",
        ALLOWED_METHODS_BY_BEHAVIOR.captured_detail,
      );
    }

    // Specialized cash-flow/event semantics must reach their own waterfall.
    // The generic candidate compiler defaults formula-less rows to recurring;
    // carrying a transaction cost forever is therefore prevented here using
    // the same semantic classifier that the standalone behavior gate tests.
    for (const row of rows) {
      const key = `${section}\u0000${row.row_id}`;
      if (behaviorByKey.has(key) || row.row_type === "header") continue;
      const classified = classifyForecastBehavior(modelCase, row, {
        section,
        rows,
      });
      if (
        [
          "contractual_flow",
          "lumpy_discretionary_flow",
          "seasonal_flow",
          ...(carriesStructuralEventSemantics(row)
            ? ["non_recurring_event"]
            : []),
        ].includes(classified.behavior) &&
        !classified.blocking
      ) {
        addBehavior(
          section,
          row.row_id,
          classified.behavior,
          ALLOWED_METHODS_BY_BEHAVIOR[classified.behavior],
        );
      }
    }
  }

  return {
    behavior_map: [...behaviorByKey.values()].sort(
      (left, right) =>
        left.section.localeCompare(right.section) ||
        left.row_id.localeCompare(right.row_id),
    ),
    findings,
  };
}

/**
 * The consumption doctrine as a compiler pass.  Broker consumables get their
 * links; the anchor is stamped; the economic wiring rows get their minted
 * forecast formulas (FR-2: interest and tax wiring cannot be plugged, because
 * the compiler owns it); everything else that is neither spine nor schedule
 * is CAPTURED — not separately forecast — which is exactly the doctrine the
 * old Stage 3 restated by hand in every case.
 */
function applyConsumptionDoctrine(modelCase, report, derivedRowIds = new Set(), caseSourceAnswers = []) {
  const sections = modelCase.statement_structure ?? {};
  const allRows = [
    ...(sections.income_statement ?? []),
    ...(sections.cash_flow ?? []),
  ];
  const rowsById = new Map(allRows.map((row) => [row.row_id, row]));
  const byRole = new Map();
  // Declared roles bind strongest; the classifier's accepted verdicts on the
  // coverage receipts fill the gaps (a filed “Interest paid” line is the
  // cash_interest_paid consumer whether or not the map spelled it out).
  for (const section of ["income_statement", "cash_flow"]) {
    for (const disclosure of modelCase.source_coverage?.[section] ?? []) {
      const row = rowsById.get(disclosure.mapped_row_ids?.[0]);
      if (!row || !disclosure.classified_role) continue;
      if (!byRole.has(disclosure.classified_role)) {
        byRole.set(disclosure.classified_role, row);
      }
    }
  }
  for (const row of allRows) {
    if (row.semantic_role) byRole.set(row.semantic_role, row);
  }
  const brokerDisabled = modelCase.controls?.broker_case === "Forecast Waterfall";
  let filedProfitLevel = null;
  if (brokerDisabled) {
    // A sealed preview with no selectable broker authority is an affirmative
    // model decision, not a missing-input state. Remove inherited broker
    // ownership before compiling the ordinary evidence/history waterfall;
    // retaining the marker would make a null broker series outrank usable
    // company history and could recreate a profit-bridge cycle.
    for (const row of allRows) {
      delete row.broker_metric_id;
      if (row.forecast_treatment === "broker") {
        delete row.forecast_treatment;
      }
    }
    const profitRoles = new Set([
      "operating_profit",
      "ebit",
      "ebitda",
      "adjusted_ebitda",
    ]);
    filedProfitLevel = allRows.find(
      (row) =>
        profitRoles.has(row.semantic_role) &&
        row.historical_authority === "source_input" &&
        (row.values ?? []).slice(0, 3).every(
          (value) => value !== null && value !== undefined && Number.isFinite(Number(value)),
        ),
    );
    if (
      filedProfitLevel?.forecast_calculation?.operator === "link" &&
      (filedProfitLevel.forecast_calculation.refs ?? []).some((rowId) =>
        profitRoles.has(rowsById.get(rowId)?.semantic_role),
      )
    ) {
      delete filedProfitLevel.forecast_calculation;
      delete filedProfitLevel.forecast_period_calculations;
      if (filedProfitLevel.forecast_treatment === "formula") {
        delete filedProfitLevel.forecast_treatment;
      }
    }
  }
  // 1. Broker links: a pack metric whose id names a statement role is
  // consumed there.  Calculation rows consume as treatment overrides;
  // input rows only carry the link.
  const packMetrics = Object.keys(modelCase.broker_pack?.metrics ?? {});
  const CONSUMABLE_ROLES = new Set([
    "revenue",
    "adjusted_ebitda",
    "effective_tax_rate",
    "depreciation_and_amortisation",
    "change_in_working_capital",
    "capex",
    "dividends",
    "share_buybacks",
  ]);
  for (const metricId of brokerDisabled ? [] : packMetrics) {
    if (!CONSUMABLE_ROLES.has(metricId)) continue;
    const row = byRole.get(metricId);
    if (!row || row.row_type === "header") continue;
    row.broker_metric_id ??= metricId;
    if (["calculation", "subtotal"].includes(row.row_type)) row.forecast_treatment = "broker";
  }
  try {
    applyTier1AnchorOwnership(modelCase);
  } catch (error) {
    report.add(
      "consumption.anchor",
      "BLOCK",
      `Anchor ownership could not be resolved: ${error.message}`,
      "Confirm the broker pack carries a compatible headline anchor, or elect one in consumption.",
    );
  }
  // 2. Economic wiring recipes (role-driven; minted only when the
  // ingredients exist).
  const wire = (row, calculation) => {
    row.forecast_treatment = "formula";
    row.forecast_calculation = calculation;
  };
  const ebit = byRole.get("ebit");
  const adjustedEbitda = byRole.get("adjusted_ebitda");
  const da = byRole.get("depreciation_and_amortisation");
  const statOp = rowsById.get("operating_profit");
  const ntiForOp = rowsById.get("non_trading_items");
  if (
    statOp && ebit && statOp !== ebit &&
    (!brokerDisabled || statOp !== filedProfitLevel) &&
    !statOp.calculation && !statOp.forecast_calculation
  ) {
    wire(
      statOp,
      ntiForOp
        ? { operator: "sum", refs: [ebit.row_id, ntiForOp.row_id] }
        : { operator: "link", refs: [ebit.row_id] },
    );
  }
  const adjRefsIncludeEbit = Boolean(
    ebit && adjustedEbitda?.calculation?.refs?.includes(ebit.row_id),
  );
  if (
    ebit && adjustedEbitda && da &&
    !ebit.calculation &&
    !ebit.forecast_calculation &&
    ebit.forecast_treatment !== "broker" &&
    // A reported-parent level is forecast as its own block (broker-pinned);
    // nothing derives it from the bridge.
    ebit.aggregation_authority !== "reported_parent" &&
    // A declared inline bridge makes ebit = adjE − … circular; the level is
    // then broker-pinned instead.
    !adjRefsIncludeEbit
  ) {
    wire(ebit, { operator: "subtract", refs: [adjustedEbitda.row_id, da.row_id] });
  }
  if (
    ebit && adjRefsIncludeEbit &&
    !ebit.forecast_calculation &&
    Object.hasOwn(modelCase.broker_pack?.metrics ?? {}, "ebit") &&
    !brokerDisabled
  ) {
    ebit.broker_metric_id ??= "ebit";
    ebit.forecast_treatment = "broker";
  }
  const taxExpense = byRole.get("tax_expense");
  const preTax = byRole.get("pre_tax_income");
  const etr = byRole.get("effective_tax_rate");
  if (taxExpense && preTax && etr && !taxExpense.forecast_calculation) {
    wire(taxExpense, { operator: "tax", refs: [preTax.row_id, etr.row_id] });
  }
  // The taxonomy carries only high-impact roles; where a CF payment line has
  // no classified role, its conventional map-declared row_id is the binding.
  for (const [cfRole, fallbackRowIds, isRole] of [
    ["cash_interest_paid", ["interest_paid"], "interest_expense"],
    ["cash_interest_received", ["interest_received"], "interest_income"],
    ["cash_tax_paid", ["tax_paid", "income_taxes_paid", "income_tax_paid", "taxes_paid"], "tax_expense"],
  ]) {
    const cfRow =
      byRole.get(cfRole) ??
      fallbackRowIds.map((id) => rowsById.get(id)).find(Boolean);
    const isRow = byRole.get(isRole);
    if (cfRow && isRow && !cfRow.forecast_calculation) {
      wire(cfRow, { operator: "link", refs: [isRow.row_id] });
    }
  }
  // CGFO restatement add-backs: the CF tax add-back restates the IS tax
  // charge, the finance add-back restates the net finance result.
  const taxAddback =
    byRole.get("cash_flow_tax_addback") ??
    rowsById.get("cash_flow_tax_addback") ??
    rowsById.get("cash_flow_tax_expense");
  const taxExpenseRow = byRole.get("tax_expense");
  if (taxAddback && taxExpenseRow && !taxAddback.forecast_calculation && !taxAddback.calculation) {
    wire(taxAddback, { operator: "negate", refs: [taxExpenseRow.row_id] });
  }
  // Single-sided CF finance restatements mirror the IS shells directly.
  for (const [cfRowId, isRoleName] of [
    ["cash_flow_finance_income", "interest_income"],
    ["cash_flow_finance_costs", "interest_expense"],
    ["cash_flow_finance_expense", "interest_expense"],
  ]) {
    const cfRow = rowsById.get(cfRowId);
    const isRow = byRole.get(isRoleName);
    if (cfRow && isRow && !cfRow.calculation) {
      cfRow.row_type = "calculation";
      cfRow.calculation = { operator: "negate", refs: [isRow.row_id] };
      cfRow.historical_authority = "derived_formula";
      delete cfRow.values;
    }
  }
  // The CF D&A aggregate forecasts by linking the bridge input.
  const cfDaAggregate = rowsById.get("cash_flow_da");
  const bridgeDa = byRole.get("depreciation_and_amortisation");
  if (
    cfDaAggregate?.calculation?.operator === "sum" &&
    bridgeDa &&
    !cfDaAggregate.forecast_calculation &&
    // Only when no member forecasts itself — an aggregate of live members is
    // its own identity.
    cfDaAggregate.calculation.refs.every((ref) => {
      const member = rowsById.get(ref);
      return member && !member.calculation && !member.forecast_calculation && !member.broker_metric_id;
    })
  ) {
    wire(cfDaAggregate, { operator: "link", refs: [bridgeDa.row_id] });
  }
  // A filed CF D&A line beside a FILED IS D&A line is one quantity printed
  // twice — the cash-flow copy restates the filed line, never re-inputs it.
  // (A minted bridge input is different: there the CF line IS the evidence.)
  if (
    cfDaAggregate && bridgeDa &&
    cfDaAggregate !== bridgeDa &&
    !cfDaAggregate.calculation &&
    cfDaAggregate.row_type === "input" &&
    (bridgeDa.source_line_ids ?? []).length > 0
  ) {
    cfDaAggregate.row_type = "calculation";
    cfDaAggregate.calculation = { operator: "link", refs: [bridgeDa.row_id] };
    cfDaAggregate.historical_authority = "derived_formula";
    cfDaAggregate.forecast_treatment = "formula";
    delete cfDaAggregate.values;
  }
  // The CGFO finance add-back and the income-statement finance lines are
  // independent consumers of the Interest Schedule.  They must not be linked
  // through one another merely because their values are arithmetically
  // related: that would invert the schedule authority and publish a false
  // statement-to-statement dependency.
  const netFinanceRow = rowsById.get("net_finance_result");
  const financeAddback =
    rowsById.get("finance_costs_net_addback") ??
    allRows.find((row) => /finance costs \(net\)|net finance costs/i.test(row.label ?? ""));
  if (netFinanceRow && financeAddback) {
    // The cash-flow add-back and the income-statement finance lines are all
    // consumers of the Interest Schedule. Linking the add-back through another
    // statement row is arithmetically equivalent but creates a false semantic
    // dependency and a roundabout audit trail. Stamp the schedule-owned role
    // and remove the legacy intermediate forecast rule; the emitter and
    // independent graph now agree on the direct schedule path.
    financeAddback.semantic_role = "net_finance_addback";
    financeAddback.forecast_treatment = "formula";
    delete financeAddback.forecast_calculation;
    delete financeAddback.forecast_period_calculations;
  }
  const fx = byRole.get("fx_effect_on_cash");
  if (
    fx &&
    !(fx.values ?? [])
      .slice(3)
      .some((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
  ) {
    // Translation effects are never forecast: the standing convention is an
    // explicit, receipted zero — declared so the waterfall selects it over a
    // carry-forward of the last translation swing.
    // stage_three_answers is an array in the certified vintages but some
    // sealed lanes carry it as a keyed object — read both, crash on neither.
    const stageThreeAnswers = Array.isArray(modelCase.stage_three_answers)
      ? modelCase.stage_three_answers
      : [];
    const fxAnswer = stageThreeAnswers
      .concat(caseSourceAnswers ?? [])
      .find((answer) => answer?.question_id === "derived.fx.effect");
    const conventionDate = (modelCase.periods ?? [])
      .filter((period) => period?.status === "historical")
      .map((period) => period.date)
      .at(-1) ?? null;
    if (Array.isArray(fxAnswer?.answer) && fxAnswer.answer.length === 3) {
      fx.forecast_period_authorities = fxAnswer.answer.map((value) => ({
        method: "user_assumption",
        source_kind: "user_supplied",
        source_id: "derived.fx.effect",
        ...(conventionDate ? { as_of_date: conventionDate } : {}),
        value: Number(value),
        material: false,
        note: "Receipted translation-effect assumption from the question round.",
      }));
    } else {
    fx.values = [...(fx.values ?? [null, null, null]).slice(0, 3), 0, 0, 0];
    fx.forecast_period_authorities = [0, 1, 2].map(() => ({
      method: "explicit_zero",
      source_kind: "user_supplied",
      source_id: "policy.fx_translation",
      ...(conventionDate ? { as_of_date: conventionDate } : {}),
      value: 0,
      material: false,
      note: "Exchange-rate effects on cash are a translation artefact, held at zero for forecasts by standing convention as of the last audited period end.",
    }));
    }
  }
  // Receipted per-row forecast assumptions: any answer recorded as
  // derived.forecast.<row_id> mints dated user assumptions on that row —
  // the universal channel for authored non-recurring forecasts.
  const assumptionDate = (modelCase.periods ?? [])
    .filter((period) => period?.status === "historical")
    .map((period) => period.date)
    .at(-1) ?? null;
  for (const answer of caseSourceAnswers ?? []) {
    const match = /^derived\.forecast\.([a-z0-9_]+)$/.exec(answer?.question_id ?? "");
    if (!match) continue;
    const row = rowsById.get(match[1]);
    if (!row || row.forecast_period_authorities) continue;
    if (!Array.isArray(answer.answer) || answer.answer.length !== 3) continue;
    row.forecast_period_authorities = answer.answer.map((value) => ({
      method: "user_assumption",
      source_kind: "user_supplied",
      source_id: answer.question_id,
      ...(assumptionDate ? { as_of_date: assumptionDate } : {}),
      value: Number(value),
      material: false,
      note: "Receipted forecast assumption from the question round.",
    }));
    // The receipted numbers ARE the row's forecast series — sealed on the
    // row so downstream authority selection can never orphan them.  A
    // formula row that retired its filed values gets its historical side
    // back by evaluating its own identity — never by transcription.
    let historicals = (row.values ?? [null, null, null]).slice(0, 3);
    if (historicals.every((value) => value === null || value === undefined) && row.calculation?.refs?.length) {
      historicals = [0, 1, 2].map((period) => {
        const parts = row.calculation.refs.map(
          (ref) => rowsById.get(ref)?.values?.[period],
        );
        if (parts.some((value) => value === null || value === undefined || !Number.isFinite(Number(value)))) return null;
        const nums = parts.map(Number);
        switch (row.calculation.operator) {
          case "link": return nums[0];
          case "sum": return nums.reduce((total, value) => total + value, 0);
          case "negate": return -nums[0];
          case "negate_sum": return -nums.reduce((total, value) => total + value, 0);
          case "subtract": return nums.slice(1).reduce((value, item) => value - item, nums[0]);
          default: return null;
        }
      });
    }
    row.values = [...historicals, ...answer.answer.map(Number)];
  }

  // 3. Forecast topology: capture is compiled as a graph certificate, never
  // inferred from source order or a generic EBITDA fallback.
  const captureTopology = compileForecastCaptureTopology(modelCase, {
    derivedRowIds,
  });
  for (const finding of captureTopology.findings) {
    report.add(
      finding.id,
      finding.severity,
      finding.message,
      "Repair the section-local statement membership graph; never select a capture path by row order.",
      finding.context,
    );
  }
  // Ensure every material rate driver participates in the same executable
  // waterfall even when it was historically derived and therefore absent
  // from capture topology. This is most visible for ETR: in forecast it is an
  // input to tax, not an identity derived back from the tax it calculates.
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase.statement_structure?.[section] ?? []) {
      if (row.semantic_role !== "effective_tax_rate") continue;
      const existing = captureTopology.behavior_map.find(
        (entry) => entry.section === section && entry.row_id === row.row_id,
      );
      if (!existing) {
        captureTopology.behavior_map.push({
          section,
          row_id: row.row_id,
          behavior: "driver_linked_flow",
          allowed_methods: [...ALLOWED_METHODS_BY_BEHAVIOR.driver_linked_flow],
        });
      }
    }
  }
  return captureTopology.behavior_map;
}

function verifyManifestSeals(caseSource, manifestsBySection, report) {
  for (const section of FACE_STATEMENT_SECTIONS) {
    const declared = caseSource.evidence_refs?.face_statement_manifests?.[section] ?? [];
    const supplied = manifestsBySection?.[section] ?? [];
    const suppliedDigests = new Map(
      supplied.map((manifest) => [manifest.source_id, faceStatementManifestDigest(manifest)]),
    );
    for (const reference of declared) {
      const digest = suppliedDigests.get(reference.source_id);
      if (!digest) {
        report.add(
          "evidence.seal.manifest_missing",
          "BLOCK",
          `${section}: case-source references manifest ${reference.source_id}, but the evidence bundle does not carry it.`,
          "Supply the sealed manifest, or remove the stale reference.",
          { section, source_id: reference.source_id },
        );
        continue;
      }
      if (digest !== reference.digest) {
        report.add(
          "evidence.seal.manifest_digest_mismatch",
          "BLOCK",
          `${section}: manifest ${reference.source_id} hashes to ${digest.slice(0, 12)}…, not the sealed ${String(reference.digest).slice(0, 12)}….`,
          "Re-seal the lane; a case-source may only build against the evidence it was authored on.",
          { section, source_id: reference.source_id },
        );
      }
    }
    if (supplied.length > 0 && declared.length === 0) {
      report.add(
        "evidence.seal.manifest_unreferenced",
        "WARN",
        `${section}: the evidence bundle carries ${supplied.length} manifest(s) the case-source never references.`,
        "Reference every manifest the case builds from; unreferenced evidence cannot influence the model.",
        { section, supplied: supplied.length },
      );
    }
  }

}

function synchronizeDerivedHistoricalForecastCaches(modelCase) {
  const rows = [
    ...(modelCase.statement_structure?.income_statement ?? []),
    ...(modelCase.statement_structure?.cash_flow ?? []),
  ];
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const evaluate = (row, periodIndex, visiting = new Set()) => {
    if (!row || visiting.has(row.row_id)) return null;
    const rule = row.calculation;
    if (!rule || (rule.refs ?? []).length === 0) {
      const literal = row.values?.[periodIndex];
      return literal === null || literal === undefined || !Number.isFinite(Number(literal))
        ? null
        : Number(literal);
    }
    const next = new Set(visiting).add(row.row_id);
    const values = rule.refs.map((ref) => evaluate(byId.get(ref), periodIndex, next));
    if (values.some((value) => value === null)) return null;
    switch (rule.operator) {
      case "link": return values[0];
      case "sum": return values.reduce((sum, value) => sum + value, 0);
      case "subtract": return values.slice(1).reduce((value, item) => value - item, values[0]);
      case "negate": return -values[0];
      case "negate_sum": return -values.reduce((sum, value) => sum + value, 0);
      case "ratio": return Math.abs(values[1]) > 1e-12 ? values[0] / values[1] : 0;
      case "negated_ratio": return Math.abs(values[1]) > 1e-12 ? -values[0] / values[1] : 0;
      default: return null;
    }
  };
  for (const row of rows) {
    if (!row.calculation || (row.calculation.refs ?? []).length === 0) continue;
    const history = [0, 1, 2].map((index) => evaluate(row, index));
    if (!history.every((value) => value !== null && Number.isFinite(value))) continue;
    row.values ??= [null, null, null, null, null, null];
    history.forEach((value, index) => { row.values[index] = value; });
    for (let forecastIndex = 0; forecastIndex < 3; forecastIndex += 1) {
      const rule = row.forecast_period_calculations?.[forecastIndex];
      if (rule?.operator === "historical_average") {
        row.values[forecastIndex + 3] = history.reduce((sum, value) => sum + value, 0) / 3;
      } else if (rule?.operator === "historical_trend") {
        const slope = ((history[1] - history[0]) + (history[2] - history[1])) / 2;
        row.values[forecastIndex + 3] = history[2] + slope * (forecastIndex + 1);
      }
    }
  }
}

/** Assemble the three policy objects from evidence-determined terms + selections. */
function compilePolicies(caseSource, lanes, report) {
  const selections = caseSource.policies ?? {};
  const evidence = lanes.policy_evidence ?? {};
  const rcf = { ...clone(evidence.rcf ?? {}) };
  if (rcf.mode === "none" || Object.keys(rcf).length === 0) {
    delete rcf.instrument_id;
    Object.assign(rcf, {
      mode: "none",
      capacity: 0,
      opening_draw: 0,
      commitment_fee_convention: "none",
      commitment_fee_value: 0,
    });
  } else {
    rcf.mode = "balancing_rcf";
  }
  if (selections.rcf?.commitment_fee_convention !== undefined) {
    if (rcf.mode === "none") {
      report.add(
        "policies.rcf.none_has_fee_selection",
        "BLOCK",
        "A commitment-fee convention was selected even though sealed evidence declares no balancing facility.",
        "Remove the stale RCF fee selection; ordinary revolvers remain instrument-level debt.",
      );
    } else {
      rcf.commitment_fee_convention = selections.rcf.commitment_fee_convention;
    }
  }
  const cash = { ...clone(evidence.cash ?? {}) };
  if (selections.cash?.interest_income_cash_flow_classification !== undefined) {
    cash.interest_income_cash_flow_classification =
      selections.cash.interest_income_cash_flow_classification;
  }
  const lease = { ...clone(evidence.lease ?? {}) };
  for (const key of [
    "mode",
    "include_in_gross_debt",
    "include_in_net_debt",
    "include_in_leverage",
  ]) {
    if (selections.lease?.[key] !== undefined) lease[key] = selections.lease[key];
  }
  // Numeric selections arrive only through receipted answers.
  const answersById = new Map(
    (caseSource.answers ?? []).map((answer) => [answer.question_id, answer]),
  );
  const numericFromAnswer = (questionId, findingId, label) => {
    if (!questionId) return undefined;
    const answer = answersById.get(questionId);
    if (!answer) {
      report.add(
        findingId,
        "BLOCK",
        `${label} points at answer ${questionId}, but no such answer is recorded.`,
        "Record the question-round answer, or drop the selection.",
        { question_id: questionId },
      );
      return undefined;
    }
    return answer.answer;
  };
  const minimumCash = numericFromAnswer(
    selections.cash?.minimum_cash_question_id,
    "policies.cash.answer_missing",
    "cash.minimum_cash_override",
  );
  if (minimumCash !== undefined) cash.minimum_cash_override = minimumCash;
  const eligible = numericFromAnswer(
    selections.cash?.eligible_cash_question_id,
    "policies.cash.answer_missing",
    "cash.eligible_cash_percentage",
  );
  if (eligible !== undefined) cash.eligible_cash_percentage = eligible;
  const cashYield = numericFromAnswer(
    selections.cash?.cash_yield_question_id,
    "policies.cash.answer_missing",
    "cash.cash_yield",
  );
  if (cashYield !== undefined) cash.cash_yield = cashYield;
  const leaseBasis = numericFromAnswer(
    selections.lease?.forecast_basis_question_id,
    "policies.lease.answer_missing",
    "lease.forecast_basis",
  );
  if (leaseBasis !== undefined && typeof leaseBasis === "object") {
    for (const key of ["additions", "principal_repayment", "effective_rate"]) {
      if (leaseBasis[key] !== undefined) lease[key] = clone(leaseBasis[key]);
    }
  }
  return { rcf_policy: rcf, cash_policy: cash, lease_policy: lease };
}

/**
 * compile_case: case-source + sealed evidence -> model-case-v2 + full report.
 *
 * The report is COMPLETE by construction: every phase records its findings and
 * the pipeline keeps going wherever it safely can, so authorship sees the
 * whole landscape at once instead of tonight's serial drip.
 */
export function compileCase(caseSource, evidence = {}) {
  const report = findingCollector();
  const lanes = evidence.lanes ?? {};
  const manifestsBySection = evidence.face_statement_manifests ?? {};

  // Phase A — the contract itself.
  const schemaErrors = validateJsonSchema(caseSource, CASE_SOURCE_SCHEMA);
  for (const error of schemaErrors ?? []) {
    report.add(
      "schema.case_source",
      "BLOCK",
      typeof error === "string" ? error : error.message ?? JSON.stringify(error),
      "Amend the case-source to satisfy assets/case-source.schema.json; the schema is the doctrine.",
    );
  }

  // Phase B — seals.
  verifyManifestSeals(caseSource, manifestsBySection, report);

  // Phase C — statement skeleton (filings symmetry).
  const statementStructure = {};
  const sourceCoverage = {};
  for (const section of FACE_STATEMENT_SECTIONS) {
    const compiled = compileStatementSection({
      section,
      manifests: manifestsBySection[section] ?? [],
      mapEntries: caseSource.statement_map?.[section] ?? [],
      report: report,
      expansions: lanes.statement_expansions ?? [],
    });
    statementStructure[section] = compiled.rows;
    sourceCoverage[section] = compileSourceCoverage({ section, ...compiled });
  }
  applyRoleRecipes(statementStructure);

  // Phase D — mechanical lane projection.
  const modelCase = {
    contract_version: 2,
    execution_profile:
      caseSource.identity?.execution_profile ?? "production_model",
    case_id: caseSource.identity?.case_id ?? `${sanitizeRowId(caseSource.identity?.issuer_name ?? "case")}-v2`,
    issuer: {
      name: caseSource.identity?.issuer_name,
      ...(caseSource.identity?.ticker ? { ticker: caseSource.identity.ticker } : {}),
      ...(caseSource.identity?.identifiers ? { identifiers: clone(caseSource.identity.identifiers) } : {}),
      ...(caseSource.identity?.aliases ? { aliases: clone(caseSource.identity.aliases) } : {}),
      ...(caseSource.identity?.consolidation_level
        ? { consolidation_level: caseSource.identity.consolidation_level }
        : {}),
      reporting_currency: caseSource.identity?.reporting_currency,
      ...(caseSource.identity?.accounting_framework
        ? {
            accounting_basis:
              caseSource.identity.accounting_framework === "us_gaap"
                ? "US_GAAP"
                : "IFRS",
          }
        : {}),
      ...(caseSource.identity?.units ? { units: caseSource.identity.units } : {}),
      ...(caseSource.identity?.fiscal_year_end
        ? { fiscal_year_end: caseSource.identity.fiscal_year_end }
        : {}),
    },
    ...(caseSource.identity?.presentation_profile
      ? { presentation_profile: caseSource.identity.presentation_profile }
      : {}),
    statement_structure: statementStructure,
    source_coverage: {
      ...(lanes.source_coverage_review ? clone(lanes.source_coverage_review) : {}),
      ...sourceCoverage,
    },
  };
  for (const lane of PASSTHROUGH_LANES) {
    if (lanes[lane] !== undefined) modelCase[lane] = clone(lanes[lane]);
  }
  // Legacy DCS lanes predate the balance-basis declaration.  The default is
  // NAMED here — a visible finding, never a silent mask — and disappears once
  // the lane itself carries the declaration.
  for (const instrument of modelCase.instruments ?? []) {
    if (!instrument.balance_basis) {
      instrument.balance_basis = "native_principal";
      report.add(
        "instruments.balance_basis_defaulted",
        "WARN",
        `${instrument.instrument_id}: the evidence lane declares no balance basis; defaulted to native_principal.`,
        "Re-extract the DCS lane with an explicit balance basis declaration.",
        { instrument_id: instrument.instrument_id },
      );
    }
  }
  Object.assign(modelCase, compilePolicies(caseSource, lanes, report));

  // Answer completeness (the card-round gate's compiler half): every
  // question id a declaration points at must have a recorded answer, and a
  // recorded answer nothing points at is flagged — an answer the compiler
  // silently ignores is a decision the user believes they made.
  {
    const answerIds = new Set(
      (caseSource.answers ?? []).map((answer) => answer?.question_id).filter(Boolean),
    );
    const referenced = new Set();
    const collect = (value, origin) => {
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (/question_id$/.test(key) && typeof entry === "string" && entry) {
          referenced.add(entry);
          if (!answerIds.has(entry)) {
            report.add(
              "answers.missing",
              "BLOCK",
              `${origin}.${key} points at answer ${entry}, which the answers lane does not carry.`,
              "Record the answer under that question id, or drop the reference.",
              { question_id: entry },
            );
          }
        } else if (entry && typeof entry === "object") {
          collect(entry, `${origin}.${key}`);
        }
      }
    };
    collect(caseSource.policies ?? {}, "policies");
    collect(caseSource.consumption ?? {}, "consumption");
    for (const declaration of caseSource.derived_rows ?? []) {
      if (declaration?.question_id) {
        referenced.add(declaration.question_id);
        if (!answerIds.has(declaration.question_id)) {
          report.add(
            "answers.missing",
            "BLOCK",
            `derived_rows.${declaration.row_id} points at answer ${declaration.question_id}, which the answers lane does not carry.`,
            "Record the answer under that question id, or drop the reference.",
            { question_id: declaration.question_id },
          );
        }
      }
    }
    for (const id of answerIds) {
      if (referenced.has(id)) continue;
      // derived.* answers are consumed positionally by the derived stratum.
      if (/^derived\./.test(id)) continue;
      report.add(
        "answers.unconsumed",
        "WARN",
        `Answer ${id} is recorded but nothing in the case-source references it.`,
        "Point a declaration or policy at it, or remove it.",
        { question_id: id },
      );
    }
  }

  // Contract stamps: compiled cases are production cases by construction.
  modelCase.forecast_authority_contract_version = "waterfall_v1";
  modelCase.statement_authority_contract_version = "authority_v1";
  if (modelCase.source_coverage && typeof modelCase.source_coverage === "object") {
    modelCase.source_coverage.classification_contract_version = "evidence_v1";
  }

  // Phase F — the consumption doctrine decides which rows the model forecasts
  // and which the anchor captures, before any forecast is minted.
  // Historical finance expense is carried by its dedicated reconciliation
  // contract because instrument-level rows do not necessarily reproduce the
  // filed P&L total. Seed the filed statement authority before the derived
  // stratum evaluates PBT and ETR.
  const forecastWaterfallSelected =
    modelCase.controls?.broker_case === "Forecast Waterfall";
  const derivedRowIds = applyDerivedStratum(modelCase, evidence);
  for (const rowId of applyDeclaredDerivedRows(modelCase, caseSource, report)) {
    derivedRowIds.add(rowId);
  }
  // Late reconciled naming: rows the map declares reconciled read as
  // subtotals once their identity exists, whatever pass minted it.
  for (const section of FACE_STATEMENT_SECTIONS) {
    const sectionRows = modelCase.statement_structure?.[section] ?? [];
    for (const entry of caseSource.statement_map?.[section] ?? []) {
      if (entry.reported_form !== "reconciled") continue;
      const rowId = entry.row_id ?? sanitizeRowId(entry.source_line_id);
      const row = sectionRows.find((candidate) => candidate.row_id === rowId);
      if (row?.calculation && row.row_type === "calculation") {
        row.row_type = "subtotal";
      }
    }
  }
  const behaviorMap = applyConsumptionDoctrine(modelCase, report, derivedRowIds, caseSource.answers ?? []);

  // Phase G — the forecast lane is MINTED, never authored.  One call creates
  // authorities and their rules together, which is what makes FR-9 (an
  // authority without its formula) structurally impossible.
  let materialized = modelCase;
  try {
    const plan = compileForecastPlan(modelCase, modelCase.statement_structure, { behaviorMap });
    for (const message of validateForecastPlan(plan, modelCase.statement_structure) ?? []) {
      report.add("forecast_plan", "BLOCK", message, "Amend the declarations the plan compiles from; the plan itself is not editable.");
    }
    materialized = materializeForecastPlan(modelCase, plan);
    for (const message of validateForecastPlanCaseParity(materialized, plan) ?? []) {
      report.add("forecast_plan.parity", "BLOCK", message, "Report this as a compiler defect; a minted plan must always be in parity with its case.");
    }
  } catch (error) {
    report.add(
      "forecast_plan.crash",
      "BLOCK",
      `compileForecastPlan failed: ${error.message}`,
      "Resolve the declaration gaps the message names; the forecast compiler needs a complete broker and answers surface.",
    );
  }
  Object.assign(modelCase, materialized);
  if (forecastWaterfallSelected) {
    synchronizeDerivedHistoricalForecastCaches(modelCase);
  }

  // Cross-statement restatements have one legal direction: the cash-flow
  // bridge may consume an income-statement row.  If an authored mixed-period
  // rule points the income statement back down to that same CF restatement,
  // remove only that reverse-period rule (its independently receipted period
  // authority remains live) and complete the CF link across all periods.
  // This is graph-shaped, not caption-shaped: it applies to any transparent
  // CF link paired with the same IS row and prevents both an illegal authority
  // direction and the FY1-null-rule renderer failure.
  const incomeRows = modelCase.statement_structure?.income_statement ?? [];
  const cashFlowRows = modelCase.statement_structure?.cash_flow ?? [];
  const cashFlowIds = new Set(cashFlowRows.map((row) => row.row_id));
  for (const cfRow of cashFlowRows) {
    if (cfRow.calculation?.operator !== "link" || cfRow.calculation.refs?.length !== 1) {
      continue;
    }
    const incomeRow = incomeRows.find(
      (row) => row.row_id === cfRow.calculation.refs[0],
    );
    if (!incomeRow) continue;
    const periodRules = incomeRow.forecast_period_calculations;
    if (!Array.isArray(periodRules)) continue;
    const reversePeriods = periodRules
      .map((rule, index) =>
        rule?.refs?.some((reference) => cashFlowIds.has(reference)) ? index : -1,
      )
      .filter((index) => index >= 0);
    if (reversePeriods.length === 0) continue;
    for (const index of reversePeriods) {
      const authority = incomeRow.forecast_period_authorities?.[index];
      if (!authority || ["accounting_identity", "driver_formula", "roll_forward"].includes(authority.method)) {
        report.add(
          "forecast_direction.reverse_cross_statement_without_authority",
          "BLOCK",
          `${incomeRow.row_id} forecast period ${index + 1} points down to cash flow without an independent replacement authority.`,
          "Provide a period-level income-statement authority; the cash-flow restatement must link from income statement, never vice versa.",
          { row_id: incomeRow.row_id, cash_flow_row_id: cfRow.row_id, forecast_index: index },
        );
        continue;
      }
      periodRules[index] = null;
    }
    cfRow.forecast_treatment = "formula";
    cfRow.forecast_period_calculations = [0, 1, 2].map((forecastIndex) => ({
      operator: "link",
      refs: [incomeRow.row_id],
      forecast_index: forecastIndex,
    }));
  }

  // Normalisation: the sealed case records links and treatments, never a
  // cached copy of broker numbers — the build resolves those live.  An input
  // row's broker treatment is implied by its link.
  //
  // The materialiser stamps semantic-statements/1.0, which tells
  // normaliseStatementRows the semantic projection (post-net-income pruning,
  // projection_origin receipts) has already run.  In β the compiler leaves
  // that projection to the build, so the stamp would be a false claim — the
  // topology gate rightly rejects it.  γ may move the projection into the
  // compiler and restore the stamp.
  delete modelCase.statement_structure_compiled_version;
  // A declared inline bridge (adjusted EBITDA reconciling FROM the ebit row)
  // is the one shape that makes the subtract-recipe circular and pins the
  // ebit level to the pack; only there is the ebit link a real consumption.
  const inlineBridgePinned = new Set(
    [...(modelCase.statement_structure?.income_statement ?? [])]
      .filter((row) => row.semantic_role === "adjusted_ebitda")
      .flatMap((row) => row.calculation?.refs ?? []),
  );
  const authoredForecastRows = new Set(
    ["income_statement", "cash_flow"].flatMap((section) =>
      (caseSource.statement_map?.[section] ?? [])
        .filter(
          (entry) =>
            entry.forecast_derive_as ||
            (entry.forecast_period_derive_as ?? []).some(Boolean),
        )
        .map((entry) => entry.row_id ?? sanitizeRowId(entry.source_line_id)),
    ),
  );
  for (const section of FACE_STATEMENT_SECTIONS) {
    for (const row of modelCase.statement_structure?.[section] ?? []) {
      if (row.forecast_treatment === "broker") {
        if (Array.isArray(row.values)) {
          row.values = [...row.values.slice(0, 3), null, null, null];
        }
        if (row.row_type === "input") delete row.forecast_treatment;
      }
      if (row.forecast_treatment === "zero" && row.row_type === "input") {
        delete row.forecast_treatment;
      }
      // Build-time Tier-1 anchor stamping is not a declared consumption: the
      // sealed case carries broker links only on the consumable set.
      if (
        row.broker_metric_id &&
        !["revenue", "adjusted_ebitda", "effective_tax_rate",
          "depreciation_and_amortisation", "change_in_working_capital",
          "capex", "dividends", "share_buybacks"].includes(row.broker_metric_id) &&
        // ebit is a real consumption in exactly three shapes: a declared
        // inline bridge pins the level (subtract-recipe circularity), the
        // pack is ebit-led (no adjusted_ebitda metric to anchor on), or the
        // row is a formula-less reported level nothing else can forecast.
        !(row.broker_metric_id === "ebit" &&
          (inlineBridgePinned.has(row.row_id) ||
            !Object.hasOwn(modelCase.broker_pack?.metrics ?? {}, "adjusted_ebitda") ||
            !row.calculation))
      ) {
        delete row.broker_metric_id;
        if (row.forecast_treatment === "broker") delete row.forecast_treatment;
      }
      // Build-time capture metadata; not a sealed-case property.
      delete row.formula_authority;
      // An identity row's authority IS its calculation — sealing a redundant
      // accounting_identity declaration makes presentation passes read the
      // row as a live aggregation parent and reshuffle its family.
      if (
        row.calculation &&
        Array.isArray(row.forecast_period_authorities) &&
        row.forecast_period_authorities.every(
          (authority) => authority?.method === "accounting_identity",
        )
      ) {
        delete row.forecast_period_authorities;
        if ((row.forecast_period_calculations ?? []).every((rule) => !rule)) {
          delete row.forecast_period_calculations;
        }
        if (
          row.forecast_treatment === "formula" &&
          !row.forecast_calculation &&
          !(row.forecast_period_calculations ?? []).some(Boolean)
        ) {
          delete row.forecast_treatment;
        }
      }
      if (Array.isArray(row.values) && row.values.every((value) => value === null)) {
        delete row.values;
      }
      // A source row may arrive with the legacy/presentation row_type
      // `uncalculated`, but the sealed waterfall is the economic authority.
      // Preserve a blank only when all three period authorities explicitly
      // declare absence.  If the waterfall found an executable forecast,
      // promote the row to an input so neither the solver nor renderer can
      // silently discard the newly minted formula/value.
      if (row.row_type === "uncalculated") {
        const periodAuthorities = row.forecast_period_authorities ?? [];
        const deliberatelyBlank =
          periodAuthorities.length === 3 &&
          periodAuthorities.every((authority) =>
            ["not_separately_forecast", "not_applicable"].includes(
              authority?.method,
            ),
          );
        if (deliberatelyBlank) {
          if (Array.isArray(row.values)) {
            row.values = [...row.values.slice(0, 3), null, null, null];
          }
          delete row.forecast_period_calculations;
          delete row.forecast_calculation;
          row.forecast_treatment = "uncalculated";
        } else if (
          periodAuthorities.some(
            (authority) =>
              authority &&
              !["unresolved", "not_separately_forecast", "not_applicable"].includes(
                authority.method,
              ),
          )
        ) {
          row.row_type = "input";
        }
      }
      // Aggregate members forecast as formula SHARES of their block at
      // solve — cached drafts are not sealed.
      if (
        (row.aggregation_role === "working_child" ||
          (row.aggregation_role === "contributing_child" &&
            row.economic_class === "working_capital")) &&
        Array.isArray(row.values)
      ) {
        row.values = [...row.values.slice(0, 3), null, null, null];
        delete row.forecast_period_authorities;
      }
      // Authored forecast wiring IS the forecast — whatever authority the
      // materialiser chose for the numbers, the treatment stays formula.
      if (
        (row.forecast_calculation ||
          (row.forecast_period_calculations ?? []).some(Boolean)) &&
        authoredForecastRows.has(row.row_id)
      ) {
        row.forecast_treatment = "formula";
      }
      // A member-less shell without a schedule identity has no forecast
      // authority to declare — the owning schedule fills it at solve time.
      // accounting_identity over zero refs is a contradiction, not a rule.
      if (
        row.calculation &&
        (row.calculation.refs ?? []).length === 0 &&
        !SCHEDULE_ROLES.has(row.semantic_role ?? "") &&
        modelCase.forecast_authority &&
        Object.hasOwn(modelCase.forecast_authority, row.row_id) &&
        (modelCase.forecast_authority[row.row_id]?.forecast_period_authorities ?? []).every(
          (authority) => authority?.method === "accounting_identity",
        )
      ) {
        modelCase.forecast_authority[row.row_id] = null;
      }
    }
  }

  // Phase H — the verification battery, folded into the same report.  These
  // run against whatever was compiled, even when earlier phases found blocks,
  // because the author is owed the WHOLE landscape in one pass.
  try {
    for (const message of validateCaseShape(modelCase) ?? []) {
      report.add("case.shape", "BLOCK", message, "Amend the declarations that project into this field and recompile.");
    }
  } catch (error) {
    report.add("case.shape.crash", "BLOCK", `validateCaseShape failed: ${error.message}`, "Report this as a compiler defect; validators must not throw.");
  }
  try {
    const rows = [
      ...(modelCase.statement_structure?.income_statement ?? []),
      ...(modelCase.statement_structure?.cash_flow ?? []),
    ];
    for (const message of validateForecastAuthorities(modelCase, rows) ?? []) {
      report.add("forecast_authority", "BLOCK", message, "Amend the mapped declarations or the recorded answers; forecasts are minted, never hand-repaired.");
    }
  } catch (error) {
    report.add("forecast_authority.crash", "BLOCK", `validateForecastAuthorities failed: ${error.message}`, "Report this as a compiler defect; validators must not throw.");
  }
  try {
    const coverage = assessCoverage(modelCase);
    for (const check of coverage?.checks ?? []) {
      if (check.status === "BLOCK") {
        report.add(
          `coverage.${check.id}`,
          "BLOCK",
          check.message ?? check.id,
          "Resolve at the declaration or evidence lane named by the check id, then recompile.",
          check.detail ?? check.context,
        );
      }
    }
  } catch (error) {
    report.add("coverage.crash", "BLOCK", `assessCoverage failed: ${error.message}`, "Report this as a compiler defect; validators must not throw.");
  }

  const blocks = report.findings.filter((finding) => finding.severity === "BLOCK");
  const compileReport = {
    schema_version: CASE_COMPILE_REPORT_VERSION,
    status: blocks.length === 0 ? "clean" : "findings",
    counts: {
      total: report.findings.length,
      block: blocks.length,
      warn: report.findings.length - blocks.length,
    },
    findings: report.findings,
  };
  return { model_case: modelCase, report: compileReport };
}

export default { compileCase, CASE_COMPILE_REPORT_VERSION, PASSTHROUGH_LANES };
