import { createHash } from "node:crypto";
import fs from "node:fs";

import { validateJsonSchema } from "./json_schema.mjs";

const FORECAST_OBSERVATION_SCHEMA = JSON.parse(
  fs.readFileSync(
    new URL("../../assets/forecast-observation-ledger-v1.schema.json", import.meta.url),
    "utf8",
  ),
);

const RECORD_KEYS = Object.freeze([
  "observation_id",
  "economic_concept_id",
  "definition_id",
  "units",
  "sign_convention",
  "period_basis",
  "period_start",
  "period_end",
  "reported_through",
  "value",
  "observation_kind",
  "source_id",
]);

const KIND_SOURCE_KINDS = Object.freeze({
  company_actual: new Set(["company_annual_report", "company_interim_update"]),
  company_guidance: new Set([
    "company_annual_report",
    "company_interim_update",
    "company_transaction_announcement",
  ]),
  broker_estimate: new Set(["user_broker_research"]),
  user_input: new Set(["user_answer"]),
});

function recordFinding(code, message, observationId = null) {
  return {
    id: `forecast_observation.${code}`,
    code,
    severity: "BLOCK",
    message,
    observation_id: observationId,
  };
}

function dateValue(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : parsed;
}

function isoDate(value) {
  return value.toISOString().slice(0, 10);
}

function dayAfter(value) {
  const next = new Date(value.getTime());
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function priorFiscalEnd(value) {
  const prior = new Date(Date.UTC(
    value.getUTCFullYear() - 1,
    value.getUTCMonth(),
    value.getUTCDate(),
  ));
  // 29 February normalises to 1 March in a non-leap year. A clamped prior
  // fiscal end must remain in February so the next fiscal year starts on 1 March.
  if (prior.getUTCMonth() !== value.getUTCMonth()) prior.setUTCDate(0);
  return prior;
}

function inclusiveDays(start, end) {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function compareText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), "en", {
    sensitivity: "variant",
    numeric: false,
  });
}

function compareRecords(left, right) {
  for (const key of [
    "economic_concept_id",
    "period_end",
    "period_start",
    "period_basis",
    "observation_kind",
    "source_id",
    "definition_id",
    "units",
    "sign_convention",
    "observation_id",
  ]) {
    const comparison = compareText(left?.[key], right?.[key]);
    if (comparison !== 0) return comparison;
  }
  return compareText(JSON.stringify(left?.value), JSON.stringify(right?.value));
}

function normalizeString(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim() : value;
}

function normalizeRecord(record) {
  const output = {};
  for (const key of RECORD_KEYS) {
    const value = record?.[key];
    output[key] = typeof value === "string" ? normalizeString(value) : value;
  }
  for (const key of Object.keys(record ?? {}).filter((key) => !RECORD_KEYS.includes(key)).sort(compareText)) {
    output[key] = record[key];
  }
  return output;
}

/**
 * Return a fresh ledger whose record keys and record ordering are stable. No
 * numeric coercion is performed: a numeric string remains a schema failure.
 */
export function normalizeForecastObservationLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return ledger;
  const normalized = {
    schema_version: normalizeString(ledger.schema_version),
    ledger_id: normalizeString(ledger.ledger_id),
    observations: Array.isArray(ledger.observations)
      ? ledger.observations.map(normalizeRecord).sort(compareRecords)
      : ledger.observations,
  };
  for (const key of Object.keys(ledger).filter((key) => ![
    "schema_version",
    "ledger_id",
    "observations",
  ].includes(key)).sort(compareText)) {
    normalized[key] = ledger[key];
  }
  return normalized;
}

export const canonicalizeForecastObservationLedger =
  normalizeForecastObservationLedger;

export function canonicalForecastObservationRecords(ledger) {
  return normalizeForecastObservationLedger(ledger)?.observations ?? [];
}

export function forecastObservationLedgerCanonicalJson(ledger) {
  return `${JSON.stringify(normalizeForecastObservationLedger(ledger))}\n`;
}

export function forecastObservationLedgerDigest(ledger) {
  return createHash("sha256")
    .update(forecastObservationLedgerCanonicalJson(ledger))
    .digest("hex");
}

function normalizedForecastPeriods(forecastPeriods) {
  if (!Array.isArray(forecastPeriods)) return [];
  return forecastPeriods.map((period) =>
    typeof period === "string"
      ? normalizeString(period)
      : normalizeString(period?.date ?? period?.period_end ?? period?.end),
  );
}

function fiscalWindows(forecastPeriods) {
  const periodEnds = normalizedForecastPeriods(forecastPeriods);
  const parsed = periodEnds.map(dateValue);
  if (
    periodEnds.length !== 3 ||
    parsed.some((value) => value === null) ||
    parsed.some((value, index) => index > 0 && value <= parsed[index - 1])
  ) return null;
  return parsed.map((end, index) => {
    const previousEnd = index === 0 ? priorFiscalEnd(end) : parsed[index - 1];
    return {
      index,
      start: dayAfter(previousEnd),
      end,
      period_end: periodEnds[index],
    };
  });
}

function inventoryMap(sourceInventory) {
  if (sourceInventory instanceof Map) return new Map(sourceInventory);
  return new Map((sourceInventory ?? []).map((source) =>
    typeof source === "string"
      ? [source, { source_id: source }]
      : [source?.source_id, source],
  ).filter(([sourceId]) => typeof sourceId === "string"));
}

function matchingWindow(windows, start, end) {
  return windows.filter((window) => start >= window.start && end <= window.end);
}

function validatePeriod(record, windows, findings) {
  const observationId = record.observation_id ?? null;
  const start = dateValue(record.period_start);
  const end = dateValue(record.period_end);
  if (!start || !end) return;
  if (start > end) {
    findings.push(recordFinding(
      "period_order",
      `${observationId} period_start must not be after period_end.`,
      observationId,
    ));
    return;
  }
  const matches = matchingWindow(windows, start, end);
  if (matches.length !== 1) {
    findings.push(recordFinding(
      "outside_horizon",
      `${observationId} period ${record.period_start}..${record.period_end} is not contained in exactly one fiscal forecast period.`,
      observationId,
    ));
    return;
  }

  const window = matches[0];
  const elapsed = inclusiveDays(window.start, end);
  const fullYear = inclusiveDays(window.start, window.end);
  const span = inclusiveDays(start, end);
  if (record.period_basis === "annual") {
    if (start.getTime() !== window.start.getTime() || end.getTime() !== window.end.getTime()) {
      findings.push(recordFinding(
        "annual_period_mismatch",
        `${observationId} is classified annual but does not span the complete fiscal period ${isoDate(window.start)}..${window.period_end}.`,
        observationId,
      ));
    }
  } else if (record.period_basis === "h1_ytd") {
    if (start.getTime() !== window.start.getTime() || elapsed / fullYear < 0.40 || elapsed / fullYear > 0.60) {
      findings.push(recordFinding(
        "h1_period_mismatch",
        `${observationId} h1_ytd must run from fiscal-year start through approximately half of the fiscal year.`,
        observationId,
      ));
    }
  } else if (record.period_basis === "q3_ytd") {
    if (start.getTime() !== window.start.getTime() || elapsed / fullYear < 0.65 || elapsed / fullYear > 0.85) {
      findings.push(recordFinding(
        "q3_period_mismatch",
        `${observationId} q3_ytd must run from fiscal-year start through approximately three quarters of the fiscal year.`,
        observationId,
      ));
    }
  } else if (record.period_basis === "quarterly" && (span < 70 || span > 110)) {
    findings.push(recordFinding(
      "quarterly_period_mismatch",
      `${observationId} quarterly period must contain between 70 and 110 inclusive days.`,
      observationId,
    ));
  }

  if (["h1_ytd", "q3_ytd"].includes(record.period_basis)) {
    if (!record.reported_through) {
      findings.push(recordFinding(
        "ytd_reported_through_missing",
        `${observationId} ${record.period_basis} requires reported_through.`,
        observationId,
      ));
    } else if (record.reported_through !== record.period_end) {
      findings.push(recordFinding(
        "ytd_reported_through_mismatch",
        `${observationId} reported_through must equal period_end for YTD evidence.`,
        observationId,
      ));
    }
  } else if (record.reported_through !== null) {
    findings.push(recordFinding(
      "reported_through_not_ytd",
      `${observationId} reported_through must be null unless period_basis is h1_ytd or q3_ytd.`,
      observationId,
    ));
  }
}

/**
 * Validate and normalize a ledger against the selected source inventory and
 * the exact three-period fiscal forecast horizon.
 */
export function validateForecastObservationLedger(
  ledger,
  { sourceInventory = [], forecastPeriods = [] } = {},
) {
  const normalized = normalizeForecastObservationLedger(ledger);
  const findings = validateJsonSchema(normalized, FORECAST_OBSERVATION_SCHEMA)
    .map((message) => recordFinding("schema", message));
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    const errors = findings.filter((entry) => entry.severity === "BLOCK");
    return {
      ok: false,
      status: "BLOCK",
      findings,
      errors,
      ledger: normalized,
      canonical_json: null,
      sha256: null,
      receipt: null,
    };
  }

  const windows = fiscalWindows(forecastPeriods);
  if (!windows) {
    findings.push(recordFinding(
      "forecast_horizon_invalid",
      "forecastPeriods must contain exactly three strictly increasing valid fiscal period ends.",
    ));
  }
  const sources = inventoryMap(sourceInventory);
  const observationIds = new Set();
  const writerKeys = new Set();
  const conceptSignatures = new Map();
  const definitionSignatures = new Map();

  for (const record of normalized.observations ?? []) {
    const observationId = record.observation_id ?? null;
    if (observationIds.has(observationId)) {
      findings.push(recordFinding(
        "duplicate_observation_id",
        `Observation id ${observationId} appears more than once.`,
        observationId,
      ));
    }
    observationIds.add(observationId);

    const source = sources.get(record.source_id);
    if (!source) {
      findings.push(recordFinding(
        "source_unknown",
        `${observationId} cites unknown source ${record.source_id}.`,
        observationId,
      ));
    } else {
      if (source.status && source.status !== "used") {
        findings.push(recordFinding(
          "source_not_used",
          `${observationId} cites source ${record.source_id}, whose status is ${source.status}.`,
          observationId,
        ));
      }
      const allowedKinds = KIND_SOURCE_KINDS[record.observation_kind];
      if (source.kind && allowedKinds && !allowedKinds.has(source.kind)) {
        findings.push(recordFinding(
          "source_kind_incompatible",
          `${observationId} kind ${record.observation_kind} is incompatible with source ${record.source_id} kind ${source.kind}.`,
          observationId,
        ));
      }
    }

    const writerKey = [
      record.economic_concept_id,
      record.period_start,
      record.period_end,
      record.observation_kind,
      record.source_id,
    ].join("\u0000");
    if (writerKeys.has(writerKey)) {
      findings.push(recordFinding(
        "duplicate_writer",
        `${observationId} duplicates writer ${record.source_id} for ${record.economic_concept_id} and ${record.period_start}..${record.period_end}.`,
        observationId,
      ));
    }
    writerKeys.add(writerKey);

    const signature = JSON.stringify({
      definition_id: record.definition_id,
      units: record.units,
      sign_convention: record.sign_convention,
    });
    const conceptSignature = conceptSignatures.get(record.economic_concept_id);
    if (conceptSignature && conceptSignature !== signature) {
      const prior = JSON.parse(conceptSignature);
      for (const [field, label] of [
        ["definition_id", "definition"],
        ["units", "units"],
        ["sign_convention", "sign convention"],
      ]) {
        if (prior[field] !== record[field]) {
          findings.push(recordFinding(
            `${label.replace(" ", "_")}_incompatible`,
            `${observationId} has ${label} incompatible with other observations for ${record.economic_concept_id}.`,
            observationId,
          ));
        }
      }
    } else if (!conceptSignature) {
      conceptSignatures.set(record.economic_concept_id, signature);
    }
    const definitionSignature = JSON.stringify({
      units: record.units,
      sign_convention: record.sign_convention,
    });
    const priorDefinition = definitionSignatures.get(record.definition_id);
    if (priorDefinition && priorDefinition !== definitionSignature) {
      findings.push(recordFinding(
        "definition_signature_incompatible",
        `${observationId} reuses definition ${record.definition_id} with incompatible units or sign convention.`,
        observationId,
      ));
    } else if (!priorDefinition) {
      definitionSignatures.set(record.definition_id, definitionSignature);
    }

    if (windows) validatePeriod(record, windows, findings);
  }

  findings.sort((left, right) =>
    compareText(left.id, right.id) ||
    compareText(left.observation_id, right.observation_id) ||
    compareText(left.message, right.message));
  const errors = findings.filter((entry) => entry.severity === "BLOCK");
  const canonicalJson = forecastObservationLedgerCanonicalJson(normalized);
  const sha256 = createHash("sha256").update(canonicalJson).digest("hex");
  const receipt = {
    schema_version: "forecast-observation-ledger-receipt/1.0",
    status: errors.length === 0 ? "PASS" : "BLOCK",
    ledger_sha256: sha256,
    observation_count: Array.isArray(normalized.observations)
      ? normalized.observations.length
      : 0,
    violation_count: errors.length,
  };
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "PASS" : "BLOCK",
    findings,
    errors,
    ledger: normalized,
    canonical_json: canonicalJson,
    sha256,
    receipt,
  };
}

function selectorPeriodEnd(ledger, selector) {
  if (typeof selector === "string") return selector;
  if (selector && typeof selector === "object" && typeof selector.periodEnd === "string") {
    return selector.periodEnd;
  }
  const forecastIndex = typeof selector === "number"
    ? selector
    : selector?.forecastIndex;
  if (!Number.isInteger(forecastIndex) || forecastIndex < 0) return null;
  const suppliedPeriods = normalizedForecastPeriods(selector?.forecastPeriods ?? []);
  if (suppliedPeriods.length > forecastIndex) return suppliedPeriods[forecastIndex];
  const annualEnds = [...new Set(
    canonicalForecastObservationRecords(ledger)
      .filter((record) => record.period_basis === "annual")
      .map((record) => record.period_end),
  )].sort(compareText);
  return annualEnds[forecastIndex] ?? null;
}

/**
 * Return canonical records for one economic concept. selector may be a period
 * end string, a zero-based forecast index, or {periodEnd}/{forecastIndex,
 * forecastPeriods}. With no selector, every record for the concept is returned.
 */
export function observationsForConcept(ledger, conceptId, selector = undefined) {
  const normalizedConceptId = normalizeString(conceptId);
  const periodEnd = selector === undefined ? null : selectorPeriodEnd(ledger, selector);
  if (selector !== undefined && periodEnd === null) return [];
  return canonicalForecastObservationRecords(ledger).filter((record) =>
    record.economic_concept_id === normalizedConceptId &&
    (periodEnd === null || record.period_end === periodEnd));
}

export default {
  canonicalForecastObservationRecords,
  canonicalizeForecastObservationLedger,
  forecastObservationLedgerCanonicalJson,
  forecastObservationLedgerDigest,
  normalizeForecastObservationLedger,
  observationsForConcept,
  validateForecastObservationLedger,
};
