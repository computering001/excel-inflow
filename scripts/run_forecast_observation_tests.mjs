#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  forecastObservationLedgerDigest,
  normalizeForecastObservationLedger,
  observationsForConcept,
  validateForecastObservationLedger,
} from "./lib/forecast_observation.mjs";
import { validateEvidenceRun } from "./lib/evidence_run.mjs";

const forecastPeriods = ["2026-12-31", "2027-12-31", "2028-12-31"];
const sourceInventory = [
  { source_id: "annual-2026", kind: "company_annual_report", status: "used" },
  { source_id: "interim-2026", kind: "company_interim_update", status: "used" },
  { source_id: "guidance-2026", kind: "company_interim_update", status: "used" },
  { source_id: "broker-alpha", kind: "user_broker_research", status: "used" },
  { source_id: "answer-1", kind: "user_answer", status: "used" },
];

const observation = (overrides = {}) => ({
  observation_id: "obs-annual",
  economic_concept_id: "income_statement:revenue",
  definition_id: "reported_revenue",
  units: "GBP_million",
  sign_convention: "positive_is_income",
  period_basis: "annual",
  period_start: "2026-01-01",
  period_end: "2026-12-31",
  reported_through: null,
  value: 100,
  observation_kind: "company_actual",
  source_id: "annual-2026",
  ...overrides,
});

const cleanLedger = {
  schema_version: "forecast-observation-ledger/1.0",
  ledger_id: "phase1-positive",
  observations: [
    observation(),
    observation({
      observation_id: "obs-h1",
      period_basis: "h1_ytd",
      period_end: "2026-06-30",
      reported_through: "2026-06-30",
      value: 48,
      source_id: "interim-2026",
    }),
    observation({
      observation_id: "obs-q3",
      period_basis: "q3_ytd",
      period_end: "2026-09-30",
      reported_through: "2026-09-30",
      value: 76,
      source_id: "interim-2026",
    }),
    observation({
      observation_id: "obs-quarterly",
      period_basis: "quarterly",
      period_start: "2026-07-01",
      period_end: "2026-09-30",
      value: 28,
      source_id: "interim-2026",
    }),
    observation({
      observation_id: "obs-guidance",
      value: 105,
      observation_kind: "company_guidance",
      source_id: "guidance-2026",
    }),
    observation({
      observation_id: "obs-broker",
      period_start: "2027-01-01",
      period_end: "2027-12-31",
      value: 111,
      observation_kind: "broker_estimate",
      source_id: "broker-alpha",
    }),
    observation({
      observation_id: "obs-user",
      period_start: "2028-01-01",
      period_end: "2028-12-31",
      value: 118,
      observation_kind: "user_input",
      source_id: "answer-1",
    }),
  ],
};

const clone = (value) => structuredClone(value);
const validate = (ledger) => validateForecastObservationLedger(ledger, {
  sourceInventory,
  forecastPeriods,
});
const hasCode = (result, code) => result.errors.some((entry) => entry.code === code);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("annual, H1, Q3, quarterly, guidance, broker and user observations pass", () => {
  const result = validate(cleanLedger);
  assert.equal(result.ok, true, result.errors.map((entry) => entry.message).join("\n"));
  assert.equal(result.receipt.status, "PASS");
  assert.equal(result.receipt.observation_count, 7);
});

test("normalization and digest are independent of source record order", () => {
  const reversed = clone(cleanLedger);
  reversed.observations.reverse();
  assert.deepEqual(
    normalizeForecastObservationLedger(reversed),
    normalizeForecastObservationLedger(cleanLedger),
  );
  assert.equal(
    forecastObservationLedgerDigest(reversed),
    forecastObservationLedgerDigest(cleanLedger),
  );
});

test("observationsForConcept supports period end and forecast index selectors", () => {
  assert.equal(
    observationsForConcept(cleanLedger, "income_statement:revenue", "2026-06-30").length,
    1,
  );
  assert.equal(
    observationsForConcept(cleanLedger, "income_statement:revenue", {
      forecastIndex: 1,
      forecastPeriods,
    })[0].observation_id,
    "obs-broker",
  );
});

test("unknown source id blocks", () => {
  const mutant = clone(cleanLedger);
  mutant.observations[0].source_id = "absent-source";
  assert(hasCode(validate(mutant), "source_unknown"));
});

test("incompatible definition and units block", () => {
  const mutant = clone(cleanLedger);
  const broker = mutant.observations.find((entry) => entry.observation_id === "obs-broker");
  broker.definition_id = "adjusted_revenue";
  broker.units = "GBP_thousand";
  const result = validate(mutant);
  assert(hasCode(result, "definition_incompatible"));
  assert(hasCode(result, "units_incompatible"));
});

test("strict schema rejects unknown ledger and record fields", () => {
  const mutant = clone(cleanLedger);
  mutant.unexpected = true;
  mutant.observations[0].unexpected = true;
  const result = validate(mutant);
  assert(hasCode(result, "schema"));
  assert(result.errors.some((entry) => entry.message.includes("unexpected")));
});

test("YTD evidence without reported_through blocks", () => {
  const mutant = clone(cleanLedger);
  mutant.observations.find((entry) => entry.observation_id === "obs-h1").reported_through = null;
  assert(hasCode(validate(mutant), "ytd_reported_through_missing"));
});

test("duplicate writer blocks", () => {
  const mutant = clone(cleanLedger);
  const duplicate = clone(mutant.observations.find((entry) => entry.observation_id === "obs-broker"));
  duplicate.observation_id = "obs-broker-duplicate";
  duplicate.value = 112;
  mutant.observations.push(duplicate);
  assert(hasCode(validate(mutant), "duplicate_writer"));
});

test("observation outside the fiscal forecast horizon blocks", () => {
  const mutant = clone(cleanLedger);
  const broker = mutant.observations.find((entry) => entry.observation_id === "obs-broker");
  broker.period_start = "2029-01-01";
  broker.period_end = "2029-12-31";
  assert(hasCode(validate(mutant), "outside_horizon"));
});

test("partial period misclassified as annual blocks", () => {
  const mutant = clone(cleanLedger);
  mutant.observations.find((entry) => entry.observation_id === "obs-h1").period_basis = "annual";
  mutant.observations.find((entry) => entry.observation_id === "obs-h1").reported_through = null;
  assert(hasCode(validate(mutant), "annual_period_mismatch"));
});

test("evidence-run validator invokes the optional ledger contract", () => {
  const partialRun = {
    forecast_observation_ledger: clone(cleanLedger),
    source_inventory: clone(sourceInventory),
    model_case: {
      periods: [
        { status: "historical", date: "2023-12-31" },
        { status: "historical", date: "2024-12-31" },
        { status: "historical", date: "2025-12-31" },
        ...forecastPeriods.map((date) => ({ status: "forecast", date })),
      ],
    },
    filings: { forecast_periods: forecastPeriods },
  };
  partialRun.forecast_observation_ledger.observations[0].source_id = "absent-source";
  const result = validateEvidenceRun(partialRun);
  assert(result.findings.some((entry) => entry.id === "evidence.forecast_observation.source_unknown"));
  assert.equal(result.forecast_observation_ledger.receipt.status, "BLOCK");
});

test("evidence-run validator rejects a receipt not bound to its ledger", () => {
  const partialRun = {
    forecast_observation_ledger: clone(cleanLedger),
    forecast_observation_ledger_receipt: {
      schema_version: "forecast-observation-ledger-receipt/1.0",
      status: "PASS",
      ledger_sha256: "0".repeat(64),
      observation_count: 7,
      violation_count: 0,
    },
    source_inventory: clone(sourceInventory),
    model_case: {
      periods: [
        { status: "historical", date: "2023-12-31" },
        { status: "historical", date: "2024-12-31" },
        { status: "historical", date: "2025-12-31" },
        ...forecastPeriods.map((date) => ({ status: "forecast", date })),
      ],
    },
    filings: { forecast_periods: forecastPeriods },
  };
  const result = validateEvidenceRun(partialRun);
  assert(result.findings.some((entry) => entry.id === "evidence.forecast_observation.receipt_mismatch"));
});

test("deployment profile includes the ledger schema and runtime library", () => {
  const profile = JSON.parse(fs.readFileSync(
    new URL("../assets/deployment-profile.json", import.meta.url),
    "utf8",
  ));
  assert(profile.asset_allowlist.includes("forecast-observation-ledger-v1.schema.json"));
  assert(profile.script_allowlist.includes("lib/forecast_observation.mjs"));
  assert(profile.script_entry_points.includes("run_forecast_observation_tests.mjs"));
  assert(profile.script_allowlist.includes("run_forecast_observation_tests.mjs"));
});

let passed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack ?? error.message);
  }
}

console.log(`\n${passed}/${tests.length} forecast-observation tests pass`);
if (passed !== tests.length) process.exitCode = 1;
