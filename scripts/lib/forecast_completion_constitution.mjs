import { hashValue } from "./run_store.mjs";
import { isTaxRatePolicyOperator } from "./tax_rate_policy.mjs";
import { methodAt, ownershipClass, sourceOwnedMateriality } from "./capture_transition.mjs";
import { economicRegionDefinitions } from "./ownership_census.mjs";
import {
  forecastCellProducerWitness,
  scheduleProducerForRole,
  scheduleRegionProducerWitness,
} from "./forecast_producer_contract.mjs";

/**
 * The Forecast Completion Constitution (Phase 2) and the economic
 * stage-parity seal (Phase 5).
 *
 * The census answers ONE question the pipeline previously answered only
 * implicitly, gate by gate, failure by failure: for every material statement
 * row and forecast period, which LAWFUL disposition owns it? `unresolved` is
 * not a lawful final state for a supported company — a residual unresolved
 * model-owned cell is either escalated as a genuine batched user decision
 * (when the row is askable) or reported as the compiler totality defect it
 * is, BEFORE expensive downstream work begins.
 *
 * P3.2 closes four holes that let the census pass while the model was
 * incomplete:
 *
 *  1. SCOPE. The census covered the two statements only. Every economically
 *     owned cell OUTSIDE them — debt, interest, lease, RCF, acquisition,
 *     leverage/liquidity — was invisible: an entire schedule family could
 *     vanish and the census still read PASS. The census now enumerates the
 *     same schedule surface the ownership census does
 *     (`economicRegionDefinitions`), one inventory for both views.
 *  2. WITNESS. Ownership was read off the method LABEL. A cell could claim
 *     `schedule_owned` with no schedule producer behind it, or
 *     `direct_evidence_owned` with no value anywhere. Every cell now carries
 *     an EXECUTABLE PRODUCER WITNESS — the registered schedule writer, the
 *     concrete formula, the named evidence selection, the tax-rate policy
 *     receipt — and a claim its producer cannot support is an escalation, not
 *     a pass.
 *  3. PERIODS. `forecastIndex < 3` was hard-wired: a fourth forecast period
 *     was silently uncounted. The period scope now derives from the case.
 *  4. VERIFICATION. The parity receipt was minted before Build and never
 *     read again. `verifyEconomicStageParityAfterBuild` re-verifies it
 *     against the case Build actually consumed.
 *
 * The parity seal binds the census, the authority ledger, the ownership
 * receipts and the case identity into one receipt minted BEFORE Build.
 * Build consumes the sealed graph; it may not select evidence, invent a
 * fallback, capture a child or repair ownership. A Build-stage discovery of
 * an unresolved economic path is a violated contract, not a user problem.
 *
 * This module VALIDATES. It never repairs a cell, never fills a missing
 * producer, and never reads a missing, blank or nil quantity as zero: an
 * absent producer is reported as absent.
 */

export const FORECAST_COMPLETION_SCHEMA = "forecast-completion-census/1.1";
export const ECONOMIC_STAGE_PARITY_SCHEMA = "economic-stage-parity/1.1";

export const LAWFUL_DISPOSITIONS = Object.freeze([
  "schedule_owned",
  "accounting_identity",
  "direct_evidence_owned",
  "role_policy_owned",
  "historical_fallback_owned",
  "captured_by_parent",
  "not_applicable",
  "genuine_user_decision",
  "unsupported_block",
]);

/**
 * The producer kinds that can lawfully witness each disposition. A cell whose
 * witness is of another kind is claiming an ownership its producer contradicts.
 * The two empty lists are deliberate: a declared pending user decision and an
 * unsupported block have no producer YET, and the census says so instead of
 * pretending one exists.
 */
export const WITNESS_KINDS_BY_DISPOSITION = Object.freeze({
  schedule_owned: Object.freeze(["schedule"]),
  accounting_identity: Object.freeze(["formula", "temporal_roll_forward"]),
  direct_evidence_owned: Object.freeze(["evidence_value", "broker_value", "evidence_formula"]),
  role_policy_owned: Object.freeze(["role_policy", "formula", "temporal_roll_forward"]),
  historical_fallback_owned: Object.freeze(["formula", "temporal_roll_forward", "explicit_zero"]),
  captured_by_parent: Object.freeze(["captured"]),
  not_applicable: Object.freeze(["not_applicable"]),
  genuine_user_decision: Object.freeze([]),
  unsupported_block: Object.freeze([]),
});

/** The economic schedule families the census must account for. */
export const SCHEDULE_FAMILIES = Object.freeze([
  "debt",
  "interest",
  "lease",
  "rcf",
  "acquisition",
  "leverage_liquidity",
]);

/** Dispositions that lawfully coexist with a schedule-owned semantic role. */
const SCHEDULE_ROLE_COMPATIBLE = Object.freeze([
  "schedule_owned",
  "accounting_identity",
  "captured_by_parent",
  "not_applicable",
  "historical_fallback_owned",
  "genuine_user_decision",
  "unsupported_block",
]);

const DIRECT_EVIDENCE_METHODS = new Set([
  "actual_plus_remainder", "contractual_commitment", "company_guidance",
  "company_indication", "broker_consensus", "user_assumption",
]);
const FALLBACK_METHODS = new Set([
  "historical_average", "historical_trend", "seasonal_run_rate",
  "carry_forward", "explicit_zero", "driver_formula", "roll_forward",
]);

/** The single row-topology predicate this validator uses. */
function isHeaderRow(row) {
  return row?.row_type === "header";
}

function dispositionFor(row, forecastIndex) {
  const authority = row?.forecast_period_authorities?.[forecastIndex] ?? null;
  const method = authority?.method ?? methodAt(row, forecastIndex);
  if (row?.forecast_waterfall_pending === true && !authority) {
    // A declared broker-waterfall transition: the next compile mints the
    // fallback. At census time this is a lawful pending state only when the
    // census runs BEFORE that recompile; the parity seal refuses it.
    return "genuine_user_decision";
  }
  if (method === "schedule_link") return "schedule_owned";
  if (method === "accounting_identity") return "accounting_identity";
  if (method === "not_separately_forecast") return "captured_by_parent";
  if (method === "not_applicable") return "not_applicable";
  if (
    authority?.tax_rate_normalization ||
    authority?.tax_rate_normalization_ref ||
    // P3.3: MEMBERSHIP of the tax policy's declared operator vocabulary, not
    // `startsWith("tax_rate_policy")`. A prefix test admitted any undeclared
    // string that happened to share the prefix, so a typo or an invented
    // operator could claim role-policy ownership of a cell.
    isTaxRatePolicyOperator(authority?.formula_spec?.operator)
  ) {
    return "role_policy_owned";
  }
  if (DIRECT_EVIDENCE_METHODS.has(method)) return "direct_evidence_owned";
  if (FALLBACK_METHODS.has(method)) return "historical_fallback_owned";
  return "unresolved";
}

function statementRowsOf(modelCase) {
  return ["income_statement", "cash_flow"].flatMap((section) =>
    (modelCase?.statement_structure?.[section] ?? []).map((row) => ({ section, row })),
  );
}

/**
 * The case's forecast period scope. Derived from the declared periods when the
 * case has them, else from the widest declared authority strip — NEVER from a
 * hard-wired 3. A case with material rows and no derivable scope is a defect
 * the census reports rather than silently enumerating zero cells.
 */
export function forecastPeriodScope(modelCase) {
  const periods = modelCase?.periods ?? [];
  const forecast = periods.filter((period) => period?.status === "forecast");
  if (forecast.length > 0) {
    return {
      count: forecast.length,
      dates: forecast.map((period) => (period?.date === undefined || period?.date === null
        ? null
        : String(period.date))),
      historical_count: periods.filter((period) => period?.status === "historical").length,
      source: "case_periods",
    };
  }
  const widest = statementRowsOf(modelCase).reduce(
    (widestSoFar, { row }) => Math.max(widestSoFar, (row?.forecast_period_authorities ?? []).length),
    0,
  );
  if (widest > 0) {
    return {
      count: widest,
      dates: Array.from({ length: widest }, () => null),
      historical_count: null,
      source: "declared_authority_strip",
    };
  }
  return { count: 0, dates: [], historical_count: null, source: "undetermined" };
}

/**
 * Which schedule families the CASE declares. An undeclared family is typed
 * not_applicable — an absent facility is never a fabricated zero balance, and
 * never a silently missing cell either.
 */
export function declaredScheduleFamilies(modelCase) {
  const instruments = modelCase?.instruments ?? [];
  const debt = instruments.some((instrument) => instrument?.class !== "rcf");
  const leaseMode = modelCase?.lease_policy?.mode ?? null;
  const lease = Boolean(modelCase?.lease_policy) && leaseMode !== "none";
  const rcf = instruments.some((instrument) => instrument?.class === "rcf") ||
    Number(modelCase?.rcf_policy?.capacity) > 0;
  const enabled = modelCase?.acquisition?.enabled;
  const acquisition = enabled === true || Number(enabled) === 1;
  const anyBalanceSheetFinance = debt || lease || rcf;
  return Object.freeze({
    debt,
    interest: anyBalanceSheetFinance,
    lease,
    rcf,
    acquisition,
    leverage_liquidity: anyBalanceSheetFinance,
  });
}

/** The schedule that OWNS a region cell, by row id and region. */
export function scheduleFamilyOf(rowId, section) {
  const id = String(rowId ?? "");
  if (section === "leverage_liquidity") return "leverage_liquidity";
  if (section === "rcf_waterfall") return "rcf";
  if (id.includes("acquisition")) return "acquisition";
  if (id.startsWith("lease") || id.includes("lease_")) return "lease";
  if (id.includes("rcf")) return "rcf";
  if (section === "interest_schedule" || id.includes("interest")) return "interest";
  return "debt";
}

function censusKeyOf(cell) {
  return `${cell.section} ${cell.row_id} ${cell.forecast_index}`;
}

/**
 * Enumerate every economically-owned cell — both statements AND every schedule
 * family — × forecast period, and prove exactly one lawful disposition backed
 * by one executable producer. Residual unresolved or unwitnessed MATERIAL
 * cells make the census status ESCALATE (a batched decision or a compiler
 * repair is owed) — never a silent pass and never, by itself, a terminal block.
 */
export function compileForecastCompletionCensus(modelCase) {
  const cells = [];
  const escalations = [];
  const scope = forecastPeriodScope(modelCase);
  const families = declaredScheduleFamilies(modelCase);
  const escalate = (entry) => escalations.push(entry);
  // P1.5: every tax-rate normalisation reference must resolve to the sealed
  // case receipt BEFORE completion may pass — a dangling or mismatched ref is
  // an internal defect, never a deliverable state.
  const receiptSha = modelCase?.tax_rate_normalization_receipt?.receipt_sha256 ?? null;
  for (const { section, row } of statementRowsOf(modelCase)) {
    for (const [index, authority] of (row?.forecast_period_authorities ?? []).entries()) {
      const ref = authority?.tax_rate_normalization_ref;
      if (ref && ref !== receiptSha) {
        escalate({
          code: receiptSha === null
            ? "tax_rate_normalization_ref_unresolved"
            : "tax_rate_normalization_ref_mismatch",
          section,
          row_id: row.row_id,
          forecast_index: index,
          period_end: scope.dates[index] ?? null,
          reason: receiptSha === null
            ? "tax_rate_normalization_ref does not resolve: the case carries no sealed receipt"
            : "tax_rate_normalization_ref does not match the sealed case receipt hash",
        });
      }
    }
  }
  const statementRows = statementRowsOf(modelCase);
  if (scope.count === 0 && statementRows.some(({ row }) => !isHeaderRow(row))) {
    escalate({
      code: "undetermined_forecast_period_scope",
      section: null,
      row_id: null,
      forecast_index: null,
      period_end: null,
      reason: "the case declares neither forecast periods nor a forecast authority strip: " +
        "the completion census cannot enumerate a period scope",
    });
  }
  for (const { section, row } of statementRows) {
    if (isHeaderRow(row)) continue;
    const historicalCount = scope.historical_count ??
      Math.max(0, (row?.values?.length ?? 0) - scope.count);
    const scheduleRole = scheduleProducerForRole(row?.semantic_role ?? null);
    for (let forecastIndex = 0; forecastIndex < scope.count; forecastIndex += 1) {
      const disposition = dispositionFor(row, forecastIndex);
      const material = sourceOwnedMateriality(modelCase, row);
      const lawful = LAWFUL_DISPOSITIONS.includes(disposition);
      const authority = row?.forecast_period_authorities?.[forecastIndex] ?? null;
      const method = methodAt(row, forecastIndex);
      const witness = forecastCellProducerWitness({
        section,
        row,
        authority,
        method: authority?.method ?? method,
        forecast_index: forecastIndex,
        historical_count: historicalCount,
      });
      const periodEnd = scope.dates[forecastIndex] ?? null;
      const site = { section, row_id: row.row_id, forecast_index: forecastIndex, period_end: periodEnd };
      if (!lawful && material) {
        escalate({
          code: "no_lawful_disposition",
          ...site,
          reason: `no lawful forecast disposition (method=${method})`,
        });
      } else if (material) {
        const allowedKinds = WITNESS_KINDS_BY_DISPOSITION[disposition] ?? [];
        if (allowedKinds.length > 0 && !allowedKinds.includes(witness.producer_kind)) {
          escalate({
            code: "witness_kind_contradicts_disposition",
            ...site,
            reason: `disposition ${disposition} claims an ownership its producer contradicts ` +
              `(producer_kind=${witness.producer_kind}, producer_id=${witness.producer_id ?? "none"})`,
          });
        } else if (allowedKinds.length > 0 && !witness.executable) {
          escalate({
            code: disposition === "schedule_owned"
              ? "schedule_claim_without_registered_producer"
              : "unwitnessed_ownership_claim",
            ...site,
            reason: `${disposition} is claimed by label only: ${witness.reason ?? "no executable producer witness"}`,
          });
        }
        if (scheduleRole && !SCHEDULE_ROLE_COMPATIBLE.includes(disposition)) {
          escalate({
            code: "schedule_role_usurped_by_direct_claim",
            ...site,
            reason: `schedule producer ${scheduleRole} owns semantic role ${row.semantic_role}; ` +
              `this cell claims ${disposition} instead`,
          });
        }
      }
      cells.push({
        section,
        row_id: row.row_id,
        forecast_index: forecastIndex,
        period_end: periodEnd,
        cell_class: "statement_amount",
        family: section,
        disposition: lawful ? disposition : "unresolved",
        material,
        ownership_class: ownershipClass(method),
        producer_witness: {
          producer_kind: witness.producer_kind,
          producer_id: witness.producer_id ?? null,
          executable: witness.executable === true,
          binding_source: witness.binding_source ?? null,
          reason: witness.reason ?? null,
        },
      });
    }
  }
  for (const definition of economicRegionDefinitions(modelCase)) {
    const family = scheduleFamilyOf(definition.row_id, definition.section);
    const active = families[family] === true;
    const witness = scheduleRegionProducerWitness({
      row_id: definition.row_id,
      region: definition.visible_region ?? definition.section,
      schedule_owner: definition.formula_schedule_owner ?? null,
      model_node_id: definition.model_node_id ?? null,
      active,
    });
    const disposition = active ? "schedule_owned" : "not_applicable";
    for (let forecastIndex = 0; forecastIndex < scope.count; forecastIndex += 1) {
      const periodEnd = scope.dates[forecastIndex] ?? null;
      if (active && !witness.executable) {
        escalate({
          code: "schedule_claim_without_registered_producer",
          section: definition.section,
          row_id: definition.row_id,
          forecast_index: forecastIndex,
          period_end: periodEnd,
          reason: `${family} schedule cell is owned by no executable producer: ${witness.reason}`,
        });
      }
      cells.push({
        section: definition.section,
        row_id: definition.row_id,
        forecast_index: forecastIndex,
        period_end: periodEnd,
        cell_class: definition.cell_class ?? "schedule_amount",
        family,
        disposition,
        material: true,
        ownership_class: active ? "schedule" : "absent",
        producer_witness: {
          producer_kind: witness.producer_kind,
          producer_id: witness.producer_id ?? null,
          executable: witness.executable === true,
          binding_source: witness.binding_source ?? null,
          reason: witness.reason ?? null,
        },
      });
    }
  }
  // Injectivity: the census key must identify exactly one cell. A duplicate
  // key means two producers write one cell, or one cell was enumerated twice
  // and a third is missing — either way the census is not a census.
  const seenKeys = new Set();
  for (const cell of cells) {
    const key = censusKeyOf(cell);
    if (seenKeys.has(key)) {
      escalate({
        code: "duplicate_census_key",
        section: cell.section,
        row_id: cell.row_id,
        forecast_index: cell.forecast_index,
        period_end: cell.period_end,
        reason: `duplicate completion census key ${cell.section}:${cell.row_id}:${cell.forecast_index}`,
      });
    }
    seenKeys.add(key);
  }
  const coverageByFamily = {};
  for (const cell of cells) {
    coverageByFamily[cell.family] = (coverageByFamily[cell.family] ?? 0) + 1;
  }
  const witnessCounts = cells.reduce((counts, cell) => {
    const bucket = cell.producer_witness.executable ? "executable" : "unwitnessed";
    counts[bucket] += 1;
    if (cell.producer_witness.producer_id !== null) counts.named_producer += 1;
    const source = cell.producer_witness.binding_source ?? "none";
    counts.by_binding_source[source] = (counts.by_binding_source[source] ?? 0) + 1;
    return counts;
  }, { executable: 0, unwitnessed: 0, named_producer: 0, by_binding_source: {} });
  const body = {
    schema_version: FORECAST_COMPLETION_SCHEMA,
    case_id: modelCase?.case_id ?? null,
    period_scope: scope,
    cell_count: cells.length,
    coverage: {
      statement_cells: cells.filter((cell) => cell.cell_class === "statement_amount").length,
      schedule_cells: cells.filter((cell) => cell.cell_class !== "statement_amount").length,
      by_family: coverageByFamily,
      declared_families: families,
    },
    producer_witness_counts: witnessCounts,
    disposition_counts: cells.reduce((counts, cell) => {
      counts[cell.disposition] = (counts[cell.disposition] ?? 0) + 1;
      return counts;
    }, {}),
    escalations,
    status: escalations.length === 0 ? "PASS" : "ESCALATE",
    cells,
  };
  return { ...body, census_sha256: hashValue(body) };
}

/**
 * Independently re-derive the census KEY SET from the case and compare it with
 * the census's own cells. Catches a dropped schedule cell, an extra cell, a
 * cardinality claim that disagrees with the enumeration, and a census compiled
 * against a different period scope than the case now declares.
 */
export function verifyForecastCompletionCoverage(modelCase, census) {
  const errors = [];
  const scope = forecastPeriodScope(modelCase);
  const expected = new Set();
  const add = (section, rowId) => {
    for (let forecastIndex = 0; forecastIndex < scope.count; forecastIndex += 1) {
      expected.add(censusKeyOf({ section, row_id: rowId, forecast_index: forecastIndex }));
    }
  };
  for (const { section, row } of statementRowsOf(modelCase)) {
    if (isHeaderRow(row)) continue;
    add(section, row.row_id);
  }
  for (const definition of economicRegionDefinitions(modelCase)) {
    add(definition.section, definition.row_id);
  }
  const actual = new Set((census?.cells ?? []).map((cell) => censusKeyOf(cell)));
  for (const key of expected) {
    if (!actual.has(key)) errors.push(`missing census cell ${key.replaceAll(" ", ":")}`);
  }
  for (const key of actual) {
    if (!expected.has(key)) errors.push(`unexpected census cell ${key.replaceAll(" ", ":")}`);
  }
  if ((census?.cells ?? []).length !== actual.size) {
    errors.push("the census enumerates a duplicate key: cells outnumber distinct keys");
  }
  if (census?.cell_count !== (census?.cells ?? []).length) {
    errors.push(`declared cell_count ${census?.cell_count} disagrees with ${(census?.cells ?? []).length} enumerated cells`);
  }
  if (census?.period_scope?.count !== scope.count) {
    errors.push(`census period scope ${census?.period_scope?.count} disagrees with the case's ${scope.count}`);
  }
  return errors;
}

/**
 * Mint the pre-Build parity receipt. Refuses (throws) when the census is not
 * PASS or a waterfall transition is still pending — those states mean the
 * deterministic pre-Build steps have not finished, which is a controller
 * sequencing defect, not a workbook problem.
 */
export function sealEconomicStageParity(modelCase) {
  const census = compileForecastCompletionCensus(modelCase);
  if (census.status !== "PASS") {
    const error = new Error(
      `economic stage parity refused: ${census.escalations.length} model-owned ` +
        `forecast cells lack a lawful disposition (first: ${JSON.stringify(census.escalations[0])})`,
    );
    // P3.7: an internal forecast failure is a typed, resumable outcome —
    // never a bare stack. The terminal catch serialises this payload.
    error.typed_internal_outcome = {
      reason_code: "INTERNAL.forecast_completion_escalated",
      earliest_responsible_layer: "forecast_completion_constitution",
      downstream_invalidation_scope: "forecast_compilation_and_below",
      escalation_count: census.escalations.length,
      first_escalation: census.escalations[0] ?? null,
    };
    throw error;
  }
  const body = {
    schema_version: ECONOMIC_STAGE_PARITY_SCHEMA,
    case_id: modelCase?.case_id ?? null,
    model_case_sha256: hashValue(modelCase),
    completion_census_sha256: census.census_sha256,
    completion_cell_count: census.cell_count,
    completion_period_count: census.period_scope.count,
    completion_schedule_cells: census.coverage.schedule_cells,
    forecast_ledger_sha256: modelCase?.forecast_authority_ledger?.ledger_sha256 ?? null,
    ownership_receipt_sha256:
      modelCase?.forecast_ownership_preflights?.selected?.receipt_sha256 ?? null,
    status: "PASS",
  };
  return { ...body, receipt_sha256: hashValue(body) };
}

/** Verify a previously minted parity receipt against the case about to Build. */
export function verifyEconomicStageParity(modelCase, receipt) {
  const errors = [];
  if (receipt?.schema_version !== ECONOMIC_STAGE_PARITY_SCHEMA) errors.push("schema_version");
  const { receipt_sha256: declared, ...bodyOnly } = receipt ?? {};
  if (declared !== hashValue(bodyOnly)) errors.push("receipt_sha256");
  if (receipt?.model_case_sha256 !== hashValue(modelCase)) errors.push("model_case_sha256");
  return errors;
}

/**
 * P3.2 — verify the parity receipt AFTER Build against the case Build actually
 * consumed. Sealing a receipt nobody re-reads proves nothing: Build may not
 * select evidence, repair ownership, capture a child, add a period or drop a
 * schedule cell, and this is where that promise is checked. Recompiles the
 * census, re-derives the coverage key set, and rebinds the ledger and
 * ownership receipts the seal claimed.
 *
 * Returns a verdict; it never repairs and never throws. Use
 * `assertEconomicStageParityAfterBuild` for the fail-closed controller call.
 */
export function verifyEconomicStageParityAfterBuild(modelCase, receipt) {
  const errors = verifyEconomicStageParity(modelCase, receipt).map((field) => `receipt:${field}`);
  const census = compileForecastCompletionCensus(modelCase);
  if (census.status !== "PASS") {
    errors.push(`census:status=${census.status} with ${census.escalations.length} escalations`);
  }
  if (census.census_sha256 !== (receipt?.completion_census_sha256 ?? null)) {
    errors.push("census:completion_census_sha256");
  }
  if (census.cell_count !== (receipt?.completion_cell_count ?? null)) {
    errors.push(`census:cell_count ${census.cell_count} != sealed ${receipt?.completion_cell_count ?? null}`);
  }
  if (census.period_scope.count !== (receipt?.completion_period_count ?? null)) {
    errors.push(`census:period_count ${census.period_scope.count} != sealed ${receipt?.completion_period_count ?? null}`);
  }
  if (census.coverage.schedule_cells !== (receipt?.completion_schedule_cells ?? null)) {
    errors.push(
      `census:schedule_cells ${census.coverage.schedule_cells} != sealed ${receipt?.completion_schedule_cells ?? null}`,
    );
  }
  for (const finding of verifyForecastCompletionCoverage(modelCase, census)) {
    errors.push(`coverage:${finding}`);
  }
  const ledger = modelCase?.forecast_authority_ledger?.ledger_sha256 ?? null;
  if (ledger !== (receipt?.forecast_ledger_sha256 ?? null)) errors.push("rebind:forecast_ledger_sha256");
  const ownership = modelCase?.forecast_ownership_preflights?.selected?.receipt_sha256 ?? null;
  if (ownership !== (receipt?.ownership_receipt_sha256 ?? null)) errors.push("rebind:ownership_receipt_sha256");
  return {
    schema_version: ECONOMIC_STAGE_PARITY_SCHEMA,
    verified_at_stage: "post_build",
    case_id: modelCase?.case_id ?? null,
    receipt_sha256: receipt?.receipt_sha256 ?? null,
    completion_census_sha256: census.census_sha256,
    errors,
    status: errors.length === 0 ? "PASS" : "PARITY_BROKEN",
  };
}

/**
 * The fail-closed post-Build call: one line for the controller. A broken
 * parity receipt after Build is a violated internal contract — a typed,
 * resumable internal outcome, never a workbook problem the user can fix.
 */
export function assertEconomicStageParityAfterBuild(modelCase, receipt) {
  const verdict = verifyEconomicStageParityAfterBuild(modelCase, receipt);
  if (verdict.status !== "PASS") {
    const error = new Error(
      `economic stage parity broken after Build: ${verdict.errors.length} findings ` +
        `(first: ${verdict.errors[0]})`,
    );
    error.typed_internal_outcome = {
      reason_code: "INTERNAL.forecast_completion_escalated",
      earliest_responsible_layer: "forecast_completion_constitution",
      downstream_invalidation_scope: "workbook_build_and_below",
      escalation_count: verdict.errors.length,
      first_escalation: verdict.errors[0] ?? null,
    };
    throw error;
  }
  return verdict;
}
