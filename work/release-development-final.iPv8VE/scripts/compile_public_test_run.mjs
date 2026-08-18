#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validatePublicTestRun } from "./lib/public_test_run.mjs";
import { assertWriteTargetOutsideSkill } from "./lib/runtime_isolation.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function usage() {
  process.stderr.write("Usage: compile_public_test_run.mjs <source-spec.json> --out <folder>\n");
  process.exit(2);
}

function requireValue(value, label) {
  if (value === null || value === undefined || value === "") throw new Error(`${label} is required.`);
  return value;
}

export function reportingCarryingToNative(modelCase, instrument, carrying) {
  const amount = Number(carrying);
  if (!Number.isFinite(amount)) {
    throw new Error(`Invalid reporting-currency carrying value for ${instrument.instrument_id}.`);
  }
  if (instrument.currency === modelCase.issuer.reporting_currency) return amount;
  const pair = modelCase.fx?.[instrument.currency];
  const quoted = Number(pair?.period_end_rates?.[2]);
  if (!pair || !Number.isFinite(quoted) || quoted <= 0) {
    throw new Error(`Missing last-historical FX for ${instrument.currency}.`);
  }
  if (pair.quote === "native_per_reporting") return amount * quoted;
  if (pair.quote === "reporting_per_native") return amount / quoted;
  throw new Error(`Unsupported FX quote convention for ${instrument.currency}: ${pair.quote}.`);
}

function applyInstrumentChanges(modelCase, spec) {
  const byId = new Map(modelCase.instruments.map((instrument) => [instrument.instrument_id, instrument]));
  for (const [instrumentId, patch] of Object.entries(spec.instrument_overrides ?? {})) {
    const instrument = byId.get(instrumentId);
    if (!instrument) throw new Error(`Instrument override points to absent ${instrumentId}.`);
    Object.assign(instrument, structuredClone(patch));
  }
  for (const split of spec.split_instruments ?? []) {
    const sourceIndex = modelCase.instruments.findIndex((instrument) => instrument.instrument_id === split.source_instrument_id);
    if (sourceIndex < 0) throw new Error(`Split source ${split.source_instrument_id} is absent.`);
    const source = modelCase.instruments[sourceIndex];
    const replacements = split.parts.map((part) => ({
      ...structuredClone(source),
      ...structuredClone(part),
    }));
    modelCase.instruments.splice(sourceIndex, 1, ...replacements);
  }
  modelCase.instruments.sort((left, right) => left.display_order - right.display_order);
  for (const instrument of modelCase.instruments) {
    const carrying = spec.carrying_values_reporting?.[instrument.instrument_id];
    if (!Number.isFinite(carrying)) throw new Error(`Missing reporting-currency carrying value for ${instrument.instrument_id}.`);
    instrument.opening_balance = reportingCarryingToNative(modelCase, instrument, carrying);
  }
  const rcf = modelCase.instruments.find((instrument) => instrument.instrument_id === modelCase.rcf_policy.instrument_id);
  if (rcf) {
    modelCase.rcf_policy.capacity = rcf.facility_capacity;
    modelCase.rcf_policy.opening_draw = rcf.opening_balance;
  }
}

function applySyntheticBrokers(modelCase, sourceId, sourceName, publicationDate) {
  const oldNames = Array.from(
    new Set(
      Object.values(modelCase.broker_pack.metrics ?? {}).flatMap((metric) => Object.keys(metric.brokers ?? {})),
    ),
  );
  if (oldNames.length < 3 || oldNames.length > 10) {
    throw new Error(`Base case requires 3–10 broker identities; found ${oldNames.length}.`);
  }
  const newNames = oldNames.map((_, index) => `Indicative ${String.fromCharCode(65 + index)}`);
  const houses = newNames.map((houseName, index) => ({
    house_id: `synthetic_${String.fromCharCode(97 + index)}`,
    house_name: houseName,
    estimates: {},
  }));
  for (const [metricId, metric] of Object.entries(modelCase.broker_pack.metrics ?? {})) {
    const old = metric.brokers ?? {};
    metric.brokers = Object.fromEntries(
      newNames.map((newName, index) => [newName, structuredClone(old[oldNames[index]] ?? metric.provider_consensus)]),
    );
    houses.forEach((house, index) => {
      house.estimates[metricId] = structuredClone(metric.brokers[newNames[index]]);
    });
  }
  const sourceLabel = "SYNTHETIC TEST DATA — indicative forecasts for autonomous public-company testing only; no broker research is represented.";
  modelCase.broker_pack.source_label = sourceLabel;
  modelCase.broker_pack.house_metadata = Object.fromEntries(
    newNames.map((name) => [name, {
      published_date: publicationDate,
      document: sourceName,
      source_id: sourceId,
    }]),
  );
  return {
    schema_version: "public-test-broker-pack/1.0",
    source_label: sourceLabel,
    reporting_currency: modelCase.issuer.reporting_currency,
    units: modelCase.issuer.units,
    forecast_periods: structuredClone(modelCase.broker_pack.forecast_periods),
    houses,
  };
}

function remapStatementEvidence(modelCase, sourceId, publicationDate) {
  for (const section of ["income_statement", "cash_flow"]) {
    for (const line of modelCase.source_coverage?.[section] ?? []) line.document = sourceId;
  }
  for (const entries of Object.values(modelCase.provenance ?? {})) {
    for (const entry of entries) {
      entry.document = sourceId;
      entry.publication_date = publicationDate;
    }
  }
}

function debtSchedule(modelCase, spec) {
  const defaultSources = spec.debt_source_ids ?? [];
  return {
    as_of: spec.filings.historical_periods.at(-1),
    reporting_currency: spec.filings.reporting_currency,
    units: spec.filings.units,
    reported_gross_debt: spec.filings.reported_gross_debt,
    instruments: modelCase.instruments.map((instrument) => ({
      instrument_id: instrument.instrument_id,
      description: instrument.name,
      instrument_type: instrument.class,
      outstanding_amount: instrument.opening_balance,
      reporting_currency_carrying_amount: spec.carrying_values_reporting[instrument.instrument_id],
      currency: instrument.currency,
      maturity_date: instrument.maturity_date ?? null,
      rate_type: instrument.rate_type,
      coupon_rate: instrument.rate_type === "fixed" ? instrument.coupon_or_all_in_rate?.[0] ?? null : null,
      reference_rate: instrument.rate_type === "floating" ? instrument.benchmark ?? null : null,
      margin_bps: instrument.rate_type === "floating" ? instrument.spread_bps ?? null : null,
      all_in_rate: instrument.rate_type === "manual_all_in" ? instrument.coupon_or_all_in_rate?.[0] ?? null : null,
      facility_limit: instrument.class === "rcf" ? instrument.facility_capacity ?? null : null,
      drawn_amount: instrument.class === "rcf" ? instrument.opening_balance : null,
      source_ids: structuredClone(spec.instrument_source_ids?.[instrument.instrument_id] ?? defaultSources),
    })),
  };
}

async function main() {
  const specPath = process.argv[2];
  const outIndex = process.argv.indexOf("--out");
  if (!specPath || outIndex < 0 || !process.argv[outIndex + 1]) usage();
  const out = await assertWriteTargetOutsideSkill({
    skillRoot: SKILL_ROOT,
    target: process.argv[outIndex + 1],
  });
  const spec = JSON.parse(await fs.readFile(path.resolve(specPath), "utf8"));
  if (spec.schema_version !== "public-test-source-spec/1.0") throw new Error("Unsupported source spec.");

  const basePath = path.resolve(requireValue(spec.base_case?.path, "base_case.path"));
  const baseBytes = await fs.readFile(basePath);
  if (sha256(baseBytes) !== spec.base_case.sha256) throw new Error("Base-case hash mismatch.");
  const modelCase = JSON.parse(baseBytes);
  modelCase.case_id = requireValue(spec.case_id, "case_id");
  modelCase.issuer.name = requireValue(spec.company_name, "company_name");
  if (spec.accounting_basis) modelCase.issuer.accounting_basis = spec.accounting_basis;
  applyInstrumentChanges(modelCase, spec);
  modelCase.debt_reconciliation.reported_opening_gross_debt = spec.filings.reported_gross_debt;
  modelCase.debt_reconciliation.note = spec.debt_reconciliation_note;

  const sources = [];
  for (const source of spec.public_sources ?? []) {
    const bytes = await fs.readFile(path.resolve(source.path));
    const digest = sha256(bytes);
    if (digest !== source.sha256) throw new Error(`Source hash mismatch for ${source.source_id}.`);
    sources.push({
      source_id: source.source_id,
      kind: source.kind,
      name: source.name,
      origin: "retrieved",
      media_type: source.media_type,
      publication_date: source.publication_date ?? null,
      as_of_date: source.as_of_date ?? null,
      entity_name: spec.company_name,
      content_sha256: digest,
      text_extractable: true,
      status: "used",
    });
  }
  const statementSource = sources.find((source) => source.source_id === spec.statement_source_id);
  if (!statementSource) throw new Error("statement_source_id is not a public source.");
  remapStatementEvidence(modelCase, statementSource.source_id, statementSource.publication_date);

  const brokerSourceId = "synthetic_brokers";
  const brokerSourceName = "synthetic-public-test-broker-pack.json";
  const syntheticBrokerPack = applySyntheticBrokers(modelCase, brokerSourceId, brokerSourceName, spec.created_at.slice(0, 10));
  const brokerBytes = Buffer.from(canonical(syntheticBrokerPack));
  sources.push({
    source_id: brokerSourceId,
    kind: "synthetic_broker_fixture",
    name: brokerSourceName,
    origin: "generated",
    media_type: "application/json",
    publication_date: spec.created_at.slice(0, 10),
    as_of_date: null,
    entity_name: spec.company_name,
    content_sha256: sha256(brokerBytes),
    text_extractable: true,
    status: "used",
  });

  const run = {
    schema_version: "public-test-run/1.0",
    purpose: "autonomous_public_company_test",
    promotion_status: "TEST_ONLY_NOT_PRODUCTION_EVIDENCE",
    run_id: spec.run_id,
    created_at: spec.created_at,
    company_name: spec.company_name,
    source_inventory: sources,
    filings: structuredClone(spec.filings),
    public_debt_schedule: debtSchedule(modelCase, spec),
    synthetic_broker_pack: syntheticBrokerPack,
    model_case: modelCase,
    restatement_decisions: spec.filings.historical_periods.map((period) => ({
      period,
      basis: "as_reported",
      source_ids: [statementSource.source_id],
      bridge_status: "not_required",
      reason: "The selected annual report supplies the comparative basis used in this autonomous test.",
    })),
  };
  const result = validatePublicTestRun(run);
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, "synthetic-public-test-broker-pack.json"), brokerBytes);
  await fs.writeFile(path.join(out, "public-test-run.json"), canonical(run));
  await fs.writeFile(path.join(out, "case.json"), canonical(modelCase));
  await fs.writeFile(path.join(out, "validation.json"), canonical(result));
  if (!result.ok) {
    process.stderr.write(`${result.status}: ${result.errors.length} violation(s)\n`);
    for (const entry of result.errors) process.stderr.write(`  ${entry.id}: ${entry.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${result.status}: ${result.errors.length} violations; production_eligible=${result.production_eligible}\n`);
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) await main();
