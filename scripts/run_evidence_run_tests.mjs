#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  historicalBridgeDigest,
  validateEvidenceRun,
} from "./lib/evidence_run.mjs";
import { runIntake as runFlow } from "./lib/flow.mjs";
import { classifyStatementLine } from "./lib/statement_classifier.mjs";
import { faceStatementManifestDigest } from "./lib/face_statement_manifest.mjs";
import { deriveCaseSourceAndEvidence } from "./run_case_compiler_equivalence.mjs";
import { proposeCaseSource } from "./lib/case_source_proposer.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const casesDirectory = path.resolve(
  process.argv[2] ??
    process.env.DEBT_OVERLAY_CASES_DIR ??
    "fixtures/external/Codex/2026-07-24/ok/work/v2-certification/cases",
);

const clone = (value) => structuredClone(value);
const hash = (character) => character.repeat(64);
const normalizeLabel = (value) =>
  String(value ?? "").normalize("NFKC").replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function merge(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const next = { ...(target ?? {}) };
  for (const [key, value] of Object.entries(patch)) next[key] = merge(next[key], value);
  return next;
}

async function loadFlowFixture(fixtureId) {
  const fixture = JSON.parse(
    await fs.readFile(path.join(HERE, "flow-fixtures", `${fixtureId}.json`), "utf8"),
  );
  if (!fixture.extends) return fixture;
  const parent = await loadFlowFixture(fixture.extends);
  const { extends: _extends, ...patch } = fixture;
  return merge(parent, patch);
}

function buildDraftCase(baseCase, fixture) {
  let modelCase = clone(baseCase);
  if (fixture.case_patch) modelCase = merge(modelCase, fixture.case_patch);
  for (const [instrumentId, patch] of Object.entries(fixture.instrument_patch ?? {})) {
    const index = modelCase.instruments.findIndex((item) => item.instrument_id === instrumentId);
    if (index >= 0) modelCase.instruments[index] = merge(modelCase.instruments[index], patch);
  }
  if (fixture.instruments_add?.length) {
    modelCase.instruments = [...modelCase.instruments, ...clone(fixture.instruments_add)];
  }
  for (const [section, patches] of Object.entries(fixture.statement_row_patch ?? {})) {
    for (const [rowId, patch] of Object.entries(patches ?? {})) {
      const rowIndex = (modelCase.statement_structure?.[section] ?? [])
        .findIndex((row) => row.row_id === rowId);
      if (rowIndex < 0) throw new Error(`Statement fixture patch row is absent: ${section}.${rowId}`);
      modelCase.statement_structure[section][rowIndex] = merge(
        modelCase.statement_structure[section][rowIndex],
        patch,
      );
    }
  }
  for (const [section, additions] of Object.entries(fixture.statement_rows_add ?? {})) {
    for (const addition of additions ?? []) {
      const row = clone(addition.row ?? addition);
      const afterRowId = addition.after_row_id ?? null;
      const rows = modelCase.statement_structure?.[section] ?? [];
      const insertionIndex = afterRowId
        ? rows.findIndex((candidate) => candidate.row_id === afterRowId) + 1
        : rows.length;
      if (afterRowId && insertionIndex === 0) {
        throw new Error(`Statement fixture insertion anchor is absent: ${section}.${afterRowId}`);
      }
      rows.splice(insertionIndex, 0, row);
    }
  }
  for (const [section, additions] of Object.entries(fixture.source_coverage_add ?? {})) {
    const disclosures = modelCase.source_coverage?.[section] ?? [];
    for (const addition of additions ?? []) {
      const disclosure = clone(addition.coverage ?? addition);
      const afterSourceLineId = addition.after_source_line_id ?? null;
      delete disclosure.after_source_line_id;
      const insertionIndex = afterSourceLineId
        ? disclosures.findIndex((candidate) => candidate.source_line_id === afterSourceLineId) + 1
        : disclosures.length;
      if (afterSourceLineId && insertionIndex === 0) {
        throw new Error(`Source-coverage fixture insertion anchor is absent: ${section}.${afterSourceLineId}`);
      }
      disclosures.splice(insertionIndex, 0, disclosure);
    }
  }
  return modelCase;
}

function brokerCasePack(pack) {
  const metrics = {};
  for (const [metricId, descriptor] of Object.entries(pack.metrics ?? {})) {
    const brokers = Object.fromEntries(
      (pack.houses ?? [])
        .filter((house) => Array.isArray(house.estimates?.[metricId]))
        .map((house) => [house.house_name, house.estimates[metricId]]),
    );
    metrics[metricId] = {
      label: descriptor.label,
      ...(Array.isArray(pack.provider_consensus?.[metricId])
        ? { provider_consensus: pack.provider_consensus[metricId] }
        : {}),
      brokers,
    };
  }
  return {
    source_label: pack.source_label,
    forecast_periods: pack.forecast_periods,
    metrics,
    house_metadata: Object.fromEntries(
      (pack.houses ?? []).map((house, index) => [
        house.house_name,
        {
          published_date: house.published_date,
          document: house.document.file_name,
          source_id: `broker_${index + 1}`,
        },
      ]),
    ),
  };
}

const SCHEDULE_OWNED_ROLES = new Set([
  "interest_income",
  "interest_expense",
  "cash_interest_paid",
  "cash_interest_received",
  "debt_issuance",
  "debt_repayment",
  "rcf_draw",
  "rcf_repayment",
  "lease_principal",
  "opening_cash",
  "ending_cash",
  "net_change_in_cash",
  "non_balancing_cash_bucket_movement",
]);

const HISTORICAL_SCHEDULE_OWNED_ROLES = new Set([
  "interest_income",
  "interest_expense",
  "cash_interest_paid",
  "cash_interest_received",
  "debt_issuance",
  "debt_repayment",
  "rcf_draw",
  "rcf_repayment",
  "lease_principal",
]);

function finite(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function rowForecastValue(modelCase, row, forecastIndex) {
  const periodIndex = forecastIndex + 3;
  if (finite(row.values?.[periodIndex])) return Number(row.values[periodIndex]);
  const directMetric = row.semantic_role
    ? modelCase.operating_metrics?.[row.semantic_role]
    : null;
  if (finite(directMetric?.values?.[periodIndex])) {
    return Number(directMetric.values[periodIndex]);
  }
  const alias = row.semantic_role === "dividends"
    ? modelCase.operating_metrics?.dividends_and_buybacks
    : row.semantic_role === "cash_flow_da"
      ? modelCase.operating_metrics?.depreciation_and_amortisation
      : null;
  return finite(alias?.values?.[periodIndex])
    ? Number(alias.values[periodIndex])
    : null;
}

function formulaOwned(row) {
  if (SCHEDULE_OWNED_ROLES.has(row.semantic_role)) return true;
  if (row.forecast_calculation) return true;
  if ((row.forecast_period_calculations ?? []).some(Boolean)) return true;
  return Boolean(
    row.calculation &&
    !["broker", "hardcode", "zero", "uncalculated"].includes(
      row.forecast_treatment,
    ),
  );
}

/** Upgrade the synthetic evidence fixture to the same strict contracts a real run must satisfy. */
function installProductionAuthorityContracts(modelCase) {
  modelCase.statement_authority_contract_version = "authority_v1";
  modelCase.forecast_authority_contract_version = "waterfall_v1";
  // Legacy cohort cases predate the explicit historical-interest basis. This
  // source-owned synthetic adapter must perform that migration before it
  // emits production evidence; the production validator is intentionally not
  // allowed to infer the basis downstream.
  if (
    modelCase.historical_interest_reconciliation &&
    !modelCase.historical_interest_reconciliation.reported_interest_basis
  ) {
    modelCase.historical_interest_reconciliation.reported_interest_basis =
      "filed_finance_expense_including_lease_interest";
  }
  for (const instrument of modelCase.instruments ?? []) {
    instrument.balance_basis ??= "native_principal";
  }
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of modelCase.statement_structure?.[section] ?? []) {
      if (row.row_type === "header") continue;
      const historical = (row.values ?? []).slice(0, 3);
      const mappedCoverage = (modelCase.source_coverage?.[section] ?? []).filter(
        (entry) =>
          (entry.mapped_row_ids ?? []).includes(row.row_id) ||
          (row.source_line_ids ?? []).includes(entry.source_line_id),
      );
      const material = mappedCoverage.some((entry) => entry.material === true)
        ? true
        : mappedCoverage.length > 0 &&
            mappedCoverage.every((entry) => entry.material === false)
          ? false
          : historical.some((value) => finite(value) && Math.abs(Number(value)) > 1e-9);
      if (HISTORICAL_SCHEDULE_OWNED_ROLES.has(row.semantic_role)) {
        row.historical_authority = "schedule_link";
      } else if ((row.calculation?.refs ?? []).length > 0) {
        row.historical_authority = "derived_formula";
      } else if (historical.length === 3 && historical.every(finite)) {
        row.historical_authority = "source_input";
      } else if (row.row_type === "uncalculated") {
        row.historical_authority = "not_applicable";
      } else {
        throw new Error(
          `Synthetic evidence row ${row.row_id} has no valid historical authority.`,
        );
      }

      if (formulaOwned(row) || row.broker_metric_id || row.forecast_treatment === "broker") {
        continue;
      }
      if (
        row.row_type === "uncalculated" ||
        row.forecast_treatment === "uncalculated" ||
        row.operation_scope === "not_applicable"
      ) {
        const hasHistory = historical.some(
          (value) => finite(value) && Math.abs(Number(value)) > 1e-9,
        );
        row.forecast_period_authorities = [0, 1, 2].map(() =>
          row.parent_row_id
            ? {
                method: "not_separately_forecast",
                source_kind: "none",
                material,
                note: `Synthetic evidence fixture: forecast captured by parent ${row.parent_row_id}.`,
              }
            : hasHistory
              ? {
                  method: "explicit_zero",
                  source_kind: "historical_inference",
                  value: 0,
                  material,
                  note: "Synthetic evidence fixture: the historical item is treated as non-recurring for the forecast.",
                }
              : {
                  method: "not_applicable",
                  source_kind: "none",
                  material: false,
                  note: "Synthetic evidence fixture: the row has no historical activity and is outside the forecast scope.",
                },
        );
        continue;
      }
      row.forecast_period_authorities = [0, 1, 2].map((forecastIndex) => {
        const value = rowForecastValue(modelCase, row, forecastIndex);
        if (!finite(value) || Number(value) === 0) {
          return {
            method: "explicit_zero",
            source_kind: "historical_inference",
            value: 0,
            material,
            note: "Synthetic evidence fixture: the absence of a non-zero forecast is explicitly authorised.",
          };
        }
        return {
          method: "historical_trend",
          source_kind: "historical_inference",
          value: Number(value),
          material,
          note: "Synthetic evidence fixture: the existing deterministic forecast is treated as a visible historical-trend assumption.",
        };
      });
    }
  }
  return modelCase;
}

function alignCaseToEvidence(modelCase, intake) {
  const next = clone(modelCase);
  next.issuer.name = intake.filings.entity_name;
  next.source_coverage.classification_contract_version = "evidence_v1";
  const statementRows = [
    ...(next.statement_structure?.income_statement ?? []),
    ...(next.statement_structure?.cash_flow ?? []),
  ];
  for (const section of ["income_statement", "cash_flow"]) {
    for (const disclosure of next.source_coverage?.[section] ?? []) {
      const classified = classifyStatementLine({ ...disclosure, section });
      const mappedRoles = (disclosure.mapped_row_ids ?? [])
        .map((rowId) => statementRows.find((row) => row.row_id === rowId)?.semantic_role)
        .filter(Boolean);
      const safeAutomatic = classified.status === "accepted" &&
        (mappedRoles.length === 0 || mappedRoles.includes(classified.classified_role));
      if (safeAutomatic) {
        Object.assign(disclosure, {
          classification_status: "accepted",
          classified_role: classified.classified_role,
          classification_confidence: classified.confidence,
          classification_evidence: classified.evidence,
          classification_candidates: classified.candidates,
          classification_review_status: "auto_accepted",
          classifier_version: `statement-semantic-taxonomy.v${classified.taxonomy_version}`,
        });
      } else {
        Object.assign(disclosure, {
          classification_status: "manual_reviewed",
          classified_role: mappedRoles.length === 1 ? mappedRoles[0] : null,
          classification_confidence: classified.confidence,
          classification_evidence: classified.evidence.length > 0
            ? classified.evidence
            : [{ channel: "hierarchy", detail: "Reviewed against the preserved filing line and destination row.", score: 1 }],
          classification_candidates: classified.candidates.length > 0
            ? classified.candidates
            : [{ role: mappedRoles[0] ?? "issuer_specific", score: 1 }],
          classification_review_status: "reviewed",
          classifier_version: `statement-semantic-taxonomy.v${classified.taxonomy_version}`,
          reason: disclosure.reason ?? "Reviewed source evidence supports the preserved issuer-specific destination mapping.",
        });
      }
      for (const rowId of disclosure.mapped_row_ids ?? []) {
        const row = next.statement_structure?.[section]?.find(
          (candidate) => candidate.row_id === rowId,
        );
        if (row && normalizeLabel(row.label) === normalizeLabel(disclosure.label)) {
          row.source_line_ids = [...new Set([
            ...(row.source_line_ids ?? []),
            disclosure.source_line_id,
          ])];
        }
      }
    }
  }
  next.broker_pack = brokerCasePack(intake.broker_pack);
  const exported = new Map(
    intake.export.instruments.map((instrument) => [
      instrument.instrument_id,
      instrument,
    ]),
  );
  for (const instrument of next.instruments) {
    const source = exported.get(instrument.instrument_id);
    assert(source, `Test fixture is missing export instrument ${instrument.instrument_id}.`);
    instrument.name = source.description;
    instrument.class = source.instrument_type;
    instrument.currency = source.currency;
    instrument.opening_balance = source.outstanding_amount;
    instrument.maturity_date = source.maturity_date;
    instrument.maturity_precision = source.maturity_precision ?? "day";
    instrument.maturity_treatment = source.maturity_treatment;
    instrument.rate_type = source.rate_type;
    if (source.rate_type === "fixed") {
      instrument.coupon_or_all_in_rate = [
        source.coupon_rate,
        source.coupon_rate,
        source.coupon_rate,
      ];
      delete instrument.benchmark;
      delete instrument.benchmark_rate;
      delete instrument.spread_bps;
    } else if (source.rate_type === "floating") {
      instrument.benchmark = source.reference_rate;
      instrument.benchmark_rate = source.benchmark_curve.resolved;
      instrument.spread_bps = source.margin_bps;
      delete instrument.coupon_or_all_in_rate;
    }
    if (source.instrument_type === "rcf") {
      instrument.facility_capacity = source.facility_limit;
      next.rcf_policy.instrument_id = source.instrument_id;
      next.rcf_policy.capacity = source.facility_limit;
      next.rcf_policy.opening_draw = source.drawn_amount;
    }
  }
  next.debt_reconciliation.reported_opening_gross_debt =
    intake.filings.reported_gross_debt;

  for (const section of ["income_statement", "cash_flow"]) {
    for (const line of next.source_coverage[section]) {
      line.document = "annual_report";
      line.page_or_note ||= "face statement";
    }
  }
  for (const entries of Object.values(next.provenance ?? {})) {
    for (const entry of entries) entry.document = "annual_report";
  }
  return installProductionAuthorityContracts(next);
}

function filingLines(modelCase, section) {
  const rows = new Map(
    modelCase.statement_structure[section].map((row) => [row.row_id, row]),
  );
  return modelCase.source_coverage[section].map((coverage) => {
    const mapped = rows.get(coverage.mapped_row_ids?.[0]);
    return {
      source_line_id: coverage.source_line_id,
      label: coverage.label,
      values: (mapped?.values ?? [null, null, null]).slice(0, 3),
      source_id: "annual_report",
      page_or_note: coverage.page_or_note,
      face_statement: coverage.face_statement,
      material: coverage.material,
      ...(coverage.parent_label ? { parent_label: coverage.parent_label } : {}),
      ...(coverage.neighbouring_labels
        ? { neighbouring_labels: coverage.neighbouring_labels }
        : {}),
      ...(coverage.table_context
        ? { table_context: coverage.table_context }
        : {}),
    };
  });
}

function buildFaceStatementManifest({
  section,
  lines,
  periods,
  sourceId = "annual_report",
  documentSha256 = hash("f"),
  pageOrNote = "face statement",
}) {
  const manifest = {
    schema_version: "face-statement-manifest/1.0",
    statement: section,
    statement_order: 1,
    source_id: sourceId,
    document_sha256: documentSha256,
    page_or_note: pageOrNote,
    periods,
    complete_face_statement: true,
    row_count: lines.length,
    rows_sha256: hash("0"),
    rows: lines.map((line, index) => ({
      source_line_id: line.source_line_id,
      ordinal: index + 1,
      raw_label: line.label,
      values: clone(line.values),
      page_or_note: line.page_or_note,
      material: line.material,
    })),
  };
  manifest.rows_sha256 = faceStatementManifestDigest(manifest);
  return manifest;
}

function manifestFor(run, section) {
  return run.filings.face_statement_manifests[section][0];
}

function refreshManifest(manifest) {
  manifest.row_count = manifest.rows.length;
  manifest.rows_sha256 = faceStatementManifestDigest(manifest);
}

function removeSyntheticBridgeDuplicates(manifest) {
  const byId = new Map(
    (manifest.rows ?? []).map((row) => [row.source_line_id, row]),
  );
  const belongsToSyntheticBridge = (row) => {
    const seen = new Set();
    let current = row;
    while (current && !seen.has(current.source_line_id)) {
      seen.add(current.source_line_id);
      if (/(?:^|[._-])bridge(?:[._-]|$)/i.test(current.source_line_id)) {
        return true;
      }
      current = current.parent_source_line_id
        ? byId.get(current.parent_source_line_id)
        : null;
    }
    return false;
  };
  manifest.rows = (manifest.rows ?? []).filter(
    (row) => !belongsToSyntheticBridge(row),
  );
  const key = (row) =>
    `${normalizeLabel(row.raw_label)}|${JSON.stringify(row.values ?? [])}`;
  const groups = new Map();
  for (const row of manifest.rows ?? []) {
    (groups.get(key(row)) ?? groups.set(key(row), []).get(key(row))).push(row);
  }
  const retained = new Set();
  for (const rows of groups.values()) {
    const preferred = rows.find(
      (row) => !/(?:^|[._-])bridge(?:[._-]|$)/i.test(row.source_line_id),
    ) ?? rows[0];
    retained.add(preferred.source_line_id);
  }
  manifest.rows = (manifest.rows ?? [])
    .filter((row) => retained.has(row.source_line_id))
    .map((row, index) => ({ ...row, ordinal: index + 1 }));
  refreshManifest(manifest);
}

function installProposerNativeProvenance({ caseSource, caseEvidence, currency, units }) {
  const proposed = new Map(
    ["income_statement", "cash_flow"].flatMap((section) =>
      (caseSource.statement_map?.[section] ?? []).map((entry) => [entry.source_line_id, entry]),
    ),
  );
  const provenance = { ...(caseEvidence.lanes?.provenance ?? {}) };
  for (const section of ["income_statement", "cash_flow"]) {
    for (const manifest of caseEvidence.face_statement_manifests?.[section] ?? []) {
      for (const line of manifest.rows ?? []) {
        const entry = proposed.get(line.source_line_id);
        if (!entry || !Array.isArray(line.values)) continue;
        const receipts = line.values.slice(0, 3).map((value, periodIndex) =>
          value === null || value === "" || !Number.isFinite(Number(value))
            ? null
            : {
                period_index: periodIndex,
                document: manifest.source_id,
                publication_date: "2026-03-01",
                page_or_note: line.page_or_note ?? manifest.page_or_note ?? "face statement",
                units: `${currency} ${units}`,
                source_label: line.raw_label,
                transformation: "Exact filed value retained by the proposer-native evidence fixture.",
              },
        ).filter(Boolean);
        if (receipts.length > 0) provenance[entry.row_id] = receipts;
      }
    }
  }
  caseEvidence.lanes ??= {};
  caseEvidence.lanes.provenance = provenance;
}

function buildCleanEvidenceRun(baseCase, fixture) {
  const modelCase = alignCaseToEvidence(baseCase, fixture.intake);
  modelCase.execution_profile = "reference_parity";
  // Free-cash-flow conversion is a model ratio in this synthetic case, not an
  // issuer-labelled face-statement line. The legacy fixture incorrectly put
  // the derived ratio in source coverage; retaining that claim would require
  // inventing a second visible filing row solely to satisfy lineage.
  modelCase.source_coverage.cash_flow = modelCase.source_coverage.cash_flow.filter(
    (entry) => entry.source_line_id !== "cf.free_cash_flow_conversion",
  );
  modelCase.provenance ??= {};
  for (const section of ["income_statement", "cash_flow"]) {
    const rowsById = new Map(
      (modelCase.statement_structure?.[section] ?? []).map((row) => [row.row_id, row]),
    );
    // The synthetic case inventory predates the visible exact-lineage gate.
    // Install only edges the fixture itself already declares: same section,
    // mapped row id and issuer label. This exercises the production gate with
    // complete evidence rather than bypassing it.
    for (const coverage of modelCase.source_coverage?.[section] ?? []) {
      for (const rowId of coverage.mapped_row_ids ?? []) {
        const row = rowsById.get(rowId);
        if (!row || normalizeLabel(row.label) !== normalizeLabel(coverage.label)) continue;
        row.source_line_ids = [
          ...new Set([...(row.source_line_ids ?? []), coverage.source_line_id]),
        ];
      }
    }
    for (const row of modelCase.statement_structure?.[section] ?? []) {
      const historicalScheduleValues = (row.values ?? []).slice(0, 3);
      if (
        HISTORICAL_SCHEDULE_OWNED_ROLES.has(row.semantic_role) &&
        (historicalScheduleValues.length !== 3 || !historicalScheduleValues.every(finite))
      ) {
        row.values = [0, 0, 0, ...(row.values ?? []).slice(3, 6)];
        modelCase.provenance[row.row_id] = [0, 1, 2].map((periodIndex) => ({
          period_index: periodIndex,
          document: "annual_report",
          publication_date: "2026-03-01",
          page_or_note: `Synthetic face-statement history for ${row.label}`,
          units: `${modelCase.issuer.reporting_currency} ${modelCase.issuer.units}`,
          source_label: row.label,
          transformation: "Reference-parity fixture value; no production evidence exemption is implied.",
        }));
      }
    }
  }
  // Keep the synthetic filing internally coherent.  The legacy bracket case
  // predates the executable cash roll-forward and supplied a zero FX row even
  // though opening cash + the three activity buckets did not equal filed
  // ending cash.  A "clean evidence" fixture must not depend on that
  // contradiction being silently tolerated; put the residual in the explicit
  // translation line, exactly where a real face cash-flow statement carries
  // it.
  const cashRows = modelCase.statement_structure?.cash_flow ?? [];
  const cashRole = (semanticRole) =>
    cashRows.find((row) => row.semantic_role === semanticRole);
  const openingCash = cashRole("opening_cash");
  const endingCash = cashRole("ending_cash");
  const fxEffect = cashRole("fx_effect_on_cash");
  const netCashMovement = cashRole("net_change_in_cash");
  const statementRowsById = new Map(
    [
      ...(modelCase.statement_structure?.income_statement ?? []),
      ...cashRows,
    ].map((row) => [row.row_id, row]),
  );
  const resolveSyntheticHistory = (row, periodIndex, visiting = new Set()) => {
    if (!row || visiting.has(row.row_id)) return null;
    if (finite(row.values?.[periodIndex])) return Number(row.values[periodIndex]);
    const refs = row.calculation?.refs ?? [];
    if (refs.length === 0) return null;
    const next = new Set(visiting).add(row.row_id);
    const values = refs.map((ref) => {
      const dependency = statementRowsById.get(ref) ?? modelCase.operating_metrics?.[ref];
      return resolveSyntheticHistory(
        dependency ? { row_id: dependency.row_id ?? ref, ...dependency } : null,
        periodIndex,
        next,
      );
    });
    if (!values.every(finite)) return null;
    switch (row.calculation.operator) {
      case "sum": return values.reduce((total, value) => total + Number(value), 0);
      case "subtract": return values.slice(1).reduce(
        (total, value) => total - Number(value),
        Number(values[0]),
      );
      case "link": return Number(values[0]);
      case "negate": return -Number(values[0]);
      case "negate_sum": return -values.reduce(
        (total, value) => total + Number(value),
        0,
      );
      default: return null;
    }
  };
  const netCashMovementHistory = [0, 1, 2].map((periodIndex) =>
    resolveSyntheticHistory(netCashMovement, periodIndex),
  );
  if (
    openingCash && endingCash && fxEffect && netCashMovement &&
    [openingCash, endingCash].every((row) =>
      (row.values ?? []).slice(0, 3).length === 3 &&
      (row.values ?? []).slice(0, 3).every(finite),
    ) && netCashMovementHistory.every(finite)
  ) {
    fxEffect.values = [0, 1, 2].map(
      (periodIndex) =>
        Number(endingCash.values[periodIndex]) -
        Number(openingCash.values[periodIndex]) -
        Number(netCashMovementHistory[periodIndex]),
    ).concat((fxEffect.values ?? []).slice(3, 6));
  }
  const historical = modelCase.periods
    .filter((period) => period.status === "historical")
    .map((period) => period.date);
  const forecast = modelCase.periods
    .filter((period) => period.status === "forecast")
    .map((period) => period.date);
  const incomeStatement = filingLines(modelCase, "income_statement");
  const cashFlow = filingLines(modelCase, "cash_flow");
  const annualReportHash = hash("f");
  const run = {
    schema_version: "evidence-run/1.0",
    run_id: "standard_net_cash_evidence_test",
    created_at: "2026-08-02T12:00:00Z",
    mode: "first_run",
    company_name: fixture.intake.filings.entity_name,
    source_inventory: [
      {
        source_id: "factset_export",
        kind: "user_factset_export",
        name: "factset-debt.xlsx",
        origin: "uploaded",
        media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        publication_date: null,
        as_of_date: historical.at(-1),
        entity_name: fixture.intake.filings.entity_name,
        content_sha256: hash("a"),
        text_extractable: true,
        status: "used",
      },
      ...fixture.intake.broker_pack.houses.map((house, index) => ({
        source_id: `broker_${index + 1}`,
        kind: "user_broker_research",
        name: house.document.file_name,
        origin: "uploaded",
        media_type: house.document.media_type,
        publication_date: house.published_date,
        as_of_date: null,
        entity_name: fixture.intake.filings.entity_name,
        content_sha256: hash(String(index + 1)),
        text_extractable: true,
        status: "used",
      })),
      {
        source_id: "annual_report",
        kind: "company_annual_report",
        name: "FY25 annual report",
        origin: "retrieved",
        media_type: "application/pdf",
        publication_date: "2026-03-01",
        as_of_date: historical.at(-1),
        entity_name: fixture.intake.filings.entity_name,
        content_sha256: annualReportHash,
        text_extractable: true,
        status: "used",
      },
    ],
    retrieval_log: [
      {
        fact_id: "latest_audited_filing",
        selected_source_id: "annual_report",
        precedence_rank: 1,
        reason: "Latest audited annual filing for the selected entity and period.",
        supersedes_source_ids: [],
      },
    ],
    filings: {
      entity_name: fixture.intake.filings.entity_name,
      reporting_currency: modelCase.issuer.reporting_currency,
      units: modelCase.issuer.units,
      fiscal_calendar_kind: modelCase.issuer.fiscal_calendar_kind ?? "fixed_date",
      historical_periods: historical,
      forecast_periods: forecast,
      reported_gross_debt: fixture.intake.filings.reported_gross_debt,
      reported_cash: modelCase.cash_policy.opening_cash,
      reported_gross_interest: null,
      reported_lease_liability:
        modelCase.lease_policy.opening_liability ?? null,
      fiscal_label: fixture.intake.filings.fiscal_label ?? null,
      maximum_residual_percentage:
        fixture.intake.filings.maximum_residual_percentage ?? 0.01,
      restricted_cash: fixture.intake.filings.restricted_cash ?? null,
      leverage_basis: fixture.intake.filings.leverage_basis ?? null,
      minimum_operating_cash:
        fixture.intake.filings.minimum_operating_cash ?? null,
      announced_acquisition:
        fixture.intake.filings.announced_acquisition ?? null,
      face_statement_manifests: {
        income_statement: [
          buildFaceStatementManifest({
            section: "income_statement",
            lines: incomeStatement,
            periods: historical,
            documentSha256: annualReportHash,
          }),
        ],
        cash_flow: [
          buildFaceStatementManifest({
            section: "cash_flow",
            lines: cashFlow,
            periods: historical,
            documentSha256: annualReportHash,
          }),
        ],
      },
      income_statement: incomeStatement,
      cash_flow: cashFlow,
    },
    dcs_export: fixture.intake.export,
    broker_pack: fixture.intake.broker_pack,
    forecast_context: {
      contract_version: "forecast-evidence/1.0",
      reviewed_at: "2026-08-02",
      public_results_source_ids: ["annual_report"],
      latest_public_results_source_id: "annual_report",
      guidance_status: "reviewed_none",
      guidance_source_ids: [],
      guidance_review_note:
        "The fixture annual report was reviewed and contains no separate forecast guidance used by this synthetic case.",
    },
    decisions: {
      restatements: historical.map((period) => ({
        period,
        basis: "as_reported",
        source_ids: ["annual_report"],
        bridge_status: "not_required",
        reason: "No restatement or predecessor bridge is required in the fixture.",
      })),
      groupings: [],
      manual_debt_supplements: [],
      stated_assumptions: [],
    },
  };
  const authored = deriveCaseSourceAndEvidence(modelCase);
  run.source_inventory.push(
    {
      source_id: "broker-pack", kind: "user_broker_research", name: "Reference broker pack",
      origin: "generated", media_type: "application/json", publication_date: "2025-12-31",
      as_of_date: null, entity_name: fixture.intake.filings.entity_name,
      content_sha256: hash("b"), text_extractable: true, status: "used",
    },
    ...[
      ["policy.acquisitions_default", "Reference acquisition policy", "c"],
      ["policy.fx_translation", "Reference FX policy", "d"],
    ].map(([source_id, name, hashCharacter]) => ({
      source_id, kind: "user_answer", name, origin: "generated",
      media_type: "application/json", publication_date: null, as_of_date: null,
      entity_name: fixture.intake.filings.entity_name,
      content_sha256: hash(hashCharacter), text_extractable: true, status: "used",
    })),
  );
  for (const section of ["income_statement", "cash_flow"]) {
    for (const manifest of authored.evidence.face_statement_manifests[section]) {
      manifest.source_id = "annual_report";
      manifest.document_sha256 = annualReportHash;
      manifest.periods = historical;
      manifest.statement_order = 1;
      manifest.rows.forEach((row, index) => {
        row.ordinal = index + 1;
        row.page_or_note ||= "face statement";
      });
      removeSyntheticBridgeDuplicates(manifest);
    }
    authored.caseSource.evidence_refs.face_statement_manifests[section] =
      authored.evidence.face_statement_manifests[section].map((manifest) => ({
        source_id: manifest.source_id,
        digest: manifest.rows_sha256,
      }));
    run.filings.face_statement_manifests[section] =
      clone(authored.evidence.face_statement_manifests[section]);
    run.filings[section] = authored.evidence.face_statement_manifests[section]
      .flatMap((manifest) => manifest.rows.map((row) => ({
        source_line_id: row.source_line_id,
        label: row.raw_label,
        values: clone(row.values),
        source_id: manifest.source_id,
        page_or_note: row.page_or_note,
        face_statement: true,
        material: row.material,
      })));
  }
  authored.caseSource.evidence_refs.filings = [{
    source_id: "annual_report",
    document_sha256: annualReportHash,
  }];
  run.case_source = proposeCaseSource({
    declarations: authored.caseSource,
    caseEvidence: authored.evidence,
  });
  installProposerNativeProvenance({
    caseSource: run.case_source,
    caseEvidence: authored.evidence,
    currency: modelCase.issuer.reporting_currency,
    units: modelCase.issuer.units,
  });
  run.case_evidence = authored.evidence;
  return run;
}

function hasFinding(result, id) {
  return result.findings.some((entry) => entry.id === id);
}

function installNumericBridge(run, {
  basis = "restated_comparative",
  periodIndex = 0,
  metricId = "revenue",
  adjustmentValue = 10,
} = {}) {
  const decision = run.decisions.restatements[periodIndex];
  const selectedValue = Number(
    run.model_case.operating_metrics[metricId].values[periodIndex],
  );
  decision.basis = basis;
  decision.bridge_status = "complete";
  decision.numeric_bridge = {
    schema_version: "historical-numeric-bridge/1.0",
    bridge_sha256: hash("0"),
    metrics: [
      {
        metric_id: metricId,
        canonical_path: `operating_metrics.${metricId}`,
        reported_value: selectedValue - adjustmentValue,
        reported_source_ids: ["annual_report"],
        adjustments: [
          {
            adjustment_id: "filing_restatement",
            label: "Filing restatement adjustment",
            value: adjustmentValue,
            source_ids: ["annual_report"],
          },
        ],
        selected_value: selectedValue,
        tolerance: 0.000001,
      },
    ],
  };
  decision.numeric_bridge.bridge_sha256 = historicalBridgeDigest(run, decision);
  return { decision, metric: decision.numeric_bridge.metrics[0] };
}

const fixture = await loadFlowFixture("no-questions");
const baseCase = JSON.parse(
  await fs.readFile(path.join(casesDirectory, fixture.base_case), "utf8"),
);
const clean = buildCleanEvidenceRun(buildDraftCase(baseCase, fixture), fixture);
assert(
  clean.case_evidence?.lanes?.historical_interest_reconciliation
    ?.reported_interest_basis ===
    "filed_finance_expense_including_lease_interest",
  "Source-owned clean evidence omitted the explicit historical-interest basis.",
);
const emitCleanIndex = process.argv.indexOf("--emit-clean");
if (emitCleanIndex >= 0) {
  const target = process.argv[emitCleanIndex + 1];
  if (!target) throw new Error("--emit-clean requires an output path.");
  await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await fs.writeFile(path.resolve(target), `${JSON.stringify(clean, null, 2)}\n`, "utf8");
}
const emitCompiledCaseIndex = process.argv.indexOf("--emit-compiled-case");
if (emitCompiledCaseIndex >= 0) {
  const target = process.argv[emitCompiledCaseIndex + 1];
  if (!target) throw new Error("--emit-compiled-case requires an output path.");
  const validation = validateEvidenceRun(clean);
  if (!validation.ok || !validation.handoff?.model_case) {
    throw new Error(
      `Synthetic evidence fixture did not compile: ${validation.errors?.[0]?.message ?? "missing model case"}`,
    );
  }
  const emittedModelCase = clone(validation.handoff.model_case);
  const effectiveTaxRate = emittedModelCase.statement_structure?.income_statement?.find(
    (row) => row.row_id === "effective_tax_rate",
  );
  assert(
    effectiveTaxRate?.semantic_role === "effective_tax_rate",
    "Compiler-owned effective-tax-rate identity lost its semantic role.",
  );
  if (process.argv.includes("--production")) {
    emittedModelCase.execution_profile = "production_model";
  }
  await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await fs.writeFile(
    path.resolve(target),
    `${JSON.stringify(emittedModelCase, null, 2)}\n`,
    "utf8",
  );
}
const emitFixtureIndex = process.argv.indexOf("--emit-fixture");
if (emitFixtureIndex >= 0) {
  const fixtureId = process.argv[emitFixtureIndex + 1];
  const target = process.argv[emitFixtureIndex + 2];
  if (!fixtureId || !target) throw new Error("--emit-fixture requires <fixture-id> <output-path>.");
  const selected = await loadFlowFixture(fixtureId);
  const selectedBase = JSON.parse(
    await fs.readFile(path.join(casesDirectory, selected.base_case), "utf8"),
  );
  const emitted = buildCleanEvidenceRun(buildDraftCase(selectedBase, selected), selected);
  emitted.run_id = `${fixtureId.replaceAll("-", "_")}_evidence_test`;
  await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await fs.writeFile(path.resolve(target), `${JSON.stringify(emitted, null, 2)}\n`, "utf8");
}
const emitAcquisitionIndex = process.argv.indexOf("--emit-acquisition-question");
if (emitAcquisitionIndex >= 0) {
  const target = process.argv[emitAcquisitionIndex + 1];
  if (!target) throw new Error("--emit-acquisition-question requires an output path.");
  const emitted = clone(clean);
  emitted.run_id = "acquisition_question_evidence_test";
  emitted.filings.announced_acquisition = {
    target: "Example Target Ltd",
    consideration: 75,
    funding: null,
  };
  await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await fs.writeFile(path.resolve(target), `${JSON.stringify(emitted, null, 2)}\n`, "utf8");
}
