import fs from "node:fs";

import { assessCoverage } from "./coverage.mjs";
import { matchEntities } from "./flow_entity.mjs";
import { validateJsonSchema } from "./json_schema.mjs";
import { validateCaseShape } from "./solver.mjs";

const SCHEMA = JSON.parse(
  fs.readFileSync(
    new URL("../../assets/public-test-run-v1.schema.json", import.meta.url),
    "utf8",
  ),
);

const PUBLIC_SOURCE_KINDS = new Set([
  "company_annual_report",
  "company_interim_update",
  "company_debt_document",
  "company_transaction_announcement",
]);

const approximate = (left, right, tolerance = 1e-6) =>
  Math.abs(Number(left) - Number(right)) <= tolerance;

export function publicTestReportingFxRate(modelCase, currency) {
  const reporting = modelCase?.issuer?.reporting_currency;
  if (!currency || currency === reporting) return 1;
  const pair = modelCase?.fx?.[currency];
  const quoted = Number(pair?.period_end_rates?.[2]);
  if (!pair || !Number.isFinite(quoted) || quoted <= 0) return null;
  if (pair.quote === "reporting_per_native") return quoted;
  if (pair.quote === "native_per_reporting") return 1 / quoted;
  return null;
}

const periods = (modelCase, status) =>
  (modelCase?.periods ?? [])
    .filter((period) => period.status === status)
    .map((period) => period.date);

const sameArray = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

function finding(id, message, evidence = null) {
  return { id, severity: "BLOCK", message, evidence };
}

function compareEntity(findings, id, left, right) {
  const result = matchEntities(left, right);
  if (result.verdict !== "match") {
    findings.push(
      finding(
        id,
        `Entity identity is ${result.verdict}: ${JSON.stringify(left)} versus ${JSON.stringify(right)}.`,
        result,
      ),
    );
  }
}

function validateSources(run, findings) {
  const used = (run.source_inventory ?? []).filter((source) => source.status === "used");
  const ids = new Set();
  for (const source of run.source_inventory ?? []) {
    if (ids.has(source.source_id)) {
      findings.push(finding("public_test.source.duplicate", `Source id ${source.source_id} appears more than once.`));
    }
    ids.add(source.source_id);
    if (source.status === "used" && source.text_extractable === false) {
      findings.push(finding("public_test.source.not_extractable", `Used source ${source.source_id} has no extractable text.`));
    }
    compareEntity(findings, "public_test.source.entity_mismatch", run.company_name, source.entity_name);
  }

  const publicSources = used.filter((source) => PUBLIC_SOURCE_KINDS.has(source.kind));
  if (publicSources.length === 0) {
    findings.push(finding("public_test.source.public_absent", "At least one used public company filing or debt document is required."));
  }
  if (!publicSources.some((source) => ["company_annual_report", "company_interim_update"].includes(source.kind))) {
    findings.push(finding("public_test.source.filing_absent", "At least one annual report or interim filing is required for the historical statements."));
  }
  const synthetic = used.filter((source) => source.kind === "synthetic_broker_fixture");
  if (synthetic.length !== 1 || synthetic[0]?.origin !== "generated") {
    findings.push(finding("public_test.source.synthetic_broker_count", `Exactly one generated synthetic broker fixture is required; found ${synthetic.length}.`));
  }
  return { ids, publicIds: new Set(publicSources.map((source) => source.source_id)), synthetic };
}

function validateDebtSchedule(run, sourceState, findings) {
  const schedule = run.public_debt_schedule ?? {};
  const historical = run.filings?.historical_periods ?? [];
  if (schedule.as_of !== historical.at(-1)) {
    findings.push(finding("public_test.debt.as_of_mismatch", `Public debt schedule date ${schedule.as_of ?? "missing"} must equal the last historical period end ${historical.at(-1) ?? "missing"}.`));
  }
  for (const field of ["reporting_currency", "units", "reported_gross_debt"]) {
    if (!approximate(schedule[field], run.filings?.[field]) && schedule[field] !== run.filings?.[field]) {
      findings.push(finding(`public_test.debt.${field}_mismatch`, `Public debt schedule ${field} does not match the filings authority.`));
    }
  }

  const caseById = new Map((run.model_case?.instruments ?? []).map((instrument) => [instrument.instrument_id, instrument]));
  const scheduleIds = new Set();
  let carryingTotal = 0;
  for (const instrument of schedule.instruments ?? []) {
    scheduleIds.add(instrument.instrument_id);
    for (const sourceId of instrument.source_ids ?? []) {
      if (!sourceState.publicIds.has(sourceId)) {
        findings.push(finding("public_test.debt.non_public_source", `${instrument.instrument_id} cites ${sourceId}, which is not a used public company source.`));
      }
    }
    const target = caseById.get(instrument.instrument_id);
    if (!target) {
      findings.push(finding("public_test.debt.instrument_dropped", `Publicly disclosed instrument ${instrument.instrument_id} is absent from the model case.`));
      continue;
    }
    for (const [field, actual, expected] of [
      ["opening_balance", target.opening_balance, instrument.outstanding_amount],
      ["class", target.class, instrument.instrument_type],
      ["currency", target.currency, instrument.currency],
      ["maturity_date", target.maturity_date ?? null, instrument.maturity_date ?? null],
      ["rate_type", target.rate_type, instrument.rate_type],
    ]) {
      const equal = typeof actual === "number" && typeof expected === "number"
        ? approximate(actual, expected)
        : actual === expected;
      if (!equal) findings.push(finding("public_test.debt.field_mismatch", `${instrument.instrument_id}.${field} differs between the public schedule and model case.`));
    }
    const carrying = Number(instrument.reporting_currency_carrying_amount);
    if (!Number.isFinite(carrying)) {
      findings.push(finding("public_test.debt.carrying_amount_absent", `${instrument.instrument_id} has no reporting-currency carrying amount for the opening reconciliation.`));
    } else {
      carryingTotal += carrying;
      const rate = publicTestReportingFxRate(run.model_case, target.currency);
      if (!Number.isFinite(rate) || !approximate(target.opening_balance * rate, carrying)) {
        findings.push(finding("public_test.debt.carrying_translation_mismatch", `${instrument.instrument_id} native opening balance does not translate to its declared reporting-currency carrying amount.`));
      }
    }
  }
  for (const instrument of run.model_case?.instruments ?? []) {
    if (!scheduleIds.has(instrument.instrument_id) && instrument.is_residual_pool !== true) {
      findings.push(finding("public_test.debt.case_only_instrument", `Case instrument ${instrument.instrument_id} is not supported by the public debt schedule.`));
    }
  }
  if (!approximate(run.model_case?.debt_reconciliation?.reported_opening_gross_debt, run.filings?.reported_gross_debt)) {
    findings.push(finding("public_test.debt.reported_total_mismatch", "The case opening gross-debt authority does not equal the public filing total."));
  }
  if (!approximate(carryingTotal, run.filings?.reported_gross_debt)) {
    findings.push(finding("public_test.debt.carrying_total_mismatch", `Instrument carrying values total ${carryingTotal}, not the public filing gross-debt authority ${run.filings?.reported_gross_debt}.`));
  }
}

function validateStatementSources(run, sourceState, findings) {
  const modelCase = run.model_case ?? {};
  for (const section of ["income_statement", "cash_flow"]) {
    for (const line of modelCase.source_coverage?.[section] ?? []) {
      if (!sourceState.publicIds.has(line.document)) {
        findings.push(
          finding(
            "public_test.statement.non_public_source",
            `${section}.${line.source_line_id} cites ${line.document}, which is not a used public company source.`,
          ),
        );
      }
    }
  }
  for (const [rowId, entries] of Object.entries(modelCase.provenance ?? {})) {
    for (const entry of entries) {
      if (!sourceState.publicIds.has(entry.document)) {
        findings.push(
          finding(
            "public_test.provenance.non_public_source",
            `Provenance for ${rowId} cites ${entry.document}, which is not a used public company source.`,
          ),
        );
      }
    }
  }
}

function validateSyntheticBrokers(run, sourceState, findings) {
  const pack = run.synthetic_broker_pack ?? {};
  const target = run.model_case?.broker_pack ?? {};
  if (!String(pack.source_label ?? "").startsWith("SYNTHETIC TEST DATA")) {
    findings.push(finding("public_test.broker.label_absent", "The indicative broker pack must be labelled SYNTHETIC TEST DATA."));
  }
  if (!String(target.source_label ?? "").startsWith("SYNTHETIC TEST DATA")) {
    findings.push(finding("public_test.broker.case_label_absent", "The model case must preserve the SYNTHETIC TEST DATA label."));
  }
  const houses = pack.houses ?? [];
  if (houses.length < 3 || houses.length > 10) {
    findings.push(finding("public_test.broker.house_count", `Synthetic test coverage requires 3–10 indicative houses; found ${houses.length}.`));
  }
  for (const house of houses) {
    const identity = `${house.house_id ?? ""} ${house.house_name ?? ""}`;
    if (!/(synthetic|indicative|illustrative)/i.test(identity)) {
      findings.push(finding("public_test.broker.identity_not_synthetic", `Broker fixture identity ${JSON.stringify(house.house_name)} is not visibly synthetic or indicative.`));
    }
  }
  const allowedSourceIds = new Set(sourceState.synthetic.map((source) => source.source_id));
  for (const [houseName, metadata] of Object.entries(target.house_metadata ?? {})) {
    if (!allowedSourceIds.has(metadata.source_id)) {
      findings.push(finding("public_test.broker.metadata_source", `${houseName} metadata does not point to the generated synthetic broker source.`));
    }
  }
  if (!sameArray(pack.forecast_periods, target.forecast_periods)) {
    findings.push(finding("public_test.broker.period_mismatch", "Synthetic broker periods were not preserved in the model case."));
  }
}

function validateRestatements(run, sourceState, findings) {
  for (const period of run.filings?.historical_periods ?? []) {
    const decisions = (run.restatement_decisions ?? []).filter((entry) => entry.period === period);
    if (decisions.length !== 1) {
      findings.push(finding("public_test.restatement.period_decision", `Historical period ${period} requires exactly one basis decision; found ${decisions.length}.`));
      continue;
    }
    const decision = decisions[0];
    for (const sourceId of decision.source_ids ?? []) {
      if (!sourceState.publicIds.has(sourceId)) {
        findings.push(finding("public_test.restatement.non_public_source", `Restatement decision for ${period} cites non-public or absent source ${sourceId}.`));
      }
    }
    if (["predecessor_combined", "calendarised"].includes(decision.basis) && decision.bridge_status !== "complete") {
      findings.push(finding("public_test.restatement.bridge_incomplete", `${period} uses ${decision.basis} without a complete bridge.`));
    }
  }
}

export function validatePublicTestRun(run) {
  const findings = validateJsonSchema(run, SCHEMA).map((message) => finding("public_test.schema", message));
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    return { ok: false, status: "BLOCK", production_eligible: false, findings, errors: findings, test_handoff: null };
  }

  const sourceState = validateSources(run, findings);
  const modelCase = run.model_case ?? {};
  for (const message of validateCaseShape(modelCase)) {
    findings.push(finding("public_test.model_case.schema", message));
  }
  compareEntity(findings, "public_test.entity.case", run.company_name, modelCase.issuer?.name);
  compareEntity(findings, "public_test.entity.filings", run.company_name, run.filings?.entity_name);

  const historical = periods(modelCase, "historical");
  const forecast = periods(modelCase, "forecast");
  if (!sameArray(historical, run.filings?.historical_periods)) {
    findings.push(finding("public_test.periods.historical_mismatch", "Case historical periods do not match the public filings basis."));
  }
  if (!sameArray(forecast, run.filings?.forecast_periods)) {
    findings.push(finding("public_test.periods.forecast_mismatch", "Case forecast periods do not match the public-test envelope."));
  }
  if (modelCase.issuer?.reporting_currency !== run.filings?.reporting_currency || modelCase.issuer?.units !== run.filings?.units) {
    findings.push(finding("public_test.reporting_basis_mismatch", "Case reporting currency or units do not match the filings basis."));
  }

  validateDebtSchedule(run, sourceState, findings);
  validateStatementSources(run, sourceState, findings);
  validateSyntheticBrokers(run, sourceState, findings);
  validateRestatements(run, sourceState, findings);

  const caseErrors = validateCaseShape(modelCase);
  const coverage = caseErrors.length === 0 ? assessCoverage(modelCase) : null;
  if (coverage && !coverage.ready_to_build) {
    for (const check of coverage.checks.filter((entry) => entry.status === "BLOCK")) {
      findings.push(finding(`public_test.coverage.${check.id}`, check.detail ?? check.message ?? "Coverage gate blocked."));
    }
  }

  const errors = findings.filter((entry) => entry.severity === "BLOCK");
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "PASS_TEST_ONLY" : "BLOCK",
    production_eligible: false,
    findings,
    errors,
    coverage,
    test_handoff: errors.length === 0
      ? {
          test_only: true,
          promotion_status: run.promotion_status,
          model_case: modelCase,
          public_debt_schedule: run.public_debt_schedule,
          synthetic_broker_pack: run.synthetic_broker_pack,
        }
      : null,
  };
}

export default { validatePublicTestRun };
