/**
 * INTAKE — node N0. The only N0.
 *
 * Stage 1 of the user flow supplies three things: a company name, a debt
 * export and a broker set. This module validates their integrity. Broker
 * sufficiency is intentionally NOT decided here: the forecast compiler owns
 * one cross-source waterfall and may resolve a missing broker value from
 * company guidance, actual-plus-remainder, formulas or historical inference.
 *
 * Two other implementations of N0 existed alongside this one and have been
 * collapsed into it:
 *
 *   flow_reconcile.mjs::validateIntakeShape — a presence-only check on a
 *     differently-named copy of the same upload. Its as_of check asked only
 *     whether a date was there, which lets a stale export straight through;
 *     the gate below asserts as_of EQUALS the last historical period end. Its
 *     company-name check was the one thing it had that this did not, and is
 *     now here. Its filings checks were never stage-1 checks at all and moved
 *     to N2 (flow_reconcile.mjs::validateFilings).
 *
 *   g1_nodes.mjs node N0 — validated a model-case JSON, i.e. the OUTPUT of the
 *     intake path rather than its input. It now calls runIntake for the
 *     uploads and keeps only the case-structure checks that its own downstream
 *     nodes depend on.
 *
 * WHAT THIS VALIDATES AGAINST
 * ---------------------------
 * assets/dcs-export.schema.json and assets/broker-pack.schema.json. Both are
 * REQUIREMENTS, not descriptions of any vendor's output — see the description
 * block in each. No real FactSet DCS export was available when they were
 * written. If a real export does not conform, the fix is an adapter, not an
 * edit to the contract or to this file.
 *
 * THE MALFORMED / INCOMPLETE SPLIT
 * --------------------------------
 * An incomplete upload is a QUESTION. A malformed one is a RE-SUPPLY. The
 * flow treats them differently — stage 3 can ask whether a facility is
 * committed, but no answer the user can give converts an export struck at
 * today's date into one struck at year end. Every finding therefore carries
 * an explicit `remedy`:
 *
 *   re_supply         — the user must fetch a different file. Blocking.
 *   answer            — resolvable by a one-word answer at stage 3.
 *   proceed_with_note — the model proceeds; the treatment is printed in the
 *                       stated assumptions at stage 5.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * Entity matching. "The export and the filings are the same reporting entity"
 * belongs to N2's gate, not N0's: filings are not a stage-1 input, so N0 sits
 * upstream of the node that reads them. The export's declared entity is
 * carried out of here untouched, in `handoff.entity`, for N2 to check.
 * See ARCHITECTURE-20260726.md §2 and SHIP-PLAN-20260726.md §1a.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { validateJsonSchema } from "./json_schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, "..", "..", "assets");

export const NODE_ID = "N0";

/** Where entity matching actually lives. N0 reports, N2 decides. */
export const ENTITY_MATCH_NODE = "N2";

export const SEVERITY = Object.freeze({
  ERROR: "error",
  QUESTION: "question",
  WARNING: "warning",
  INFO: "info",
});

export const REMEDY = Object.freeze({
  RE_SUPPLY: "re_supply",
  ANSWER: "answer",
  PROCEED_WITH_NOTE: "proceed_with_note",
  NONE: "none",
});

/** Metrics the broker preview reports when absent; none is broker-mandatory. */
export const REQUIRED_BROKER_METRICS = Object.freeze([
  "revenue",
  "depreciation_and_amortisation",
  "effective_tax_rate",
  "capex",
  "change_in_working_capital",
  "dividends",
]);

/** One of EBIT/EBITDA is selected; D&A is always the bridge driver. */
export const ANCHOR_METRICS = Object.freeze([
  "ebit",
  "adjusted_ebitda",
  "depreciation_and_amortisation",
]);

export const MIN_BROKER_HOUSES = 3;
export const MAX_BROKER_HOUSES = 10;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const finite = (value) => typeof value === "number" && Number.isFinite(value);

function money(value) {
  if (!finite(value)) return String(value);
  return value.toLocaleString("en-GB", { maximumFractionDigits: 1 });
}

function loadSchema(name) {
  return JSON.parse(readFileSync(join(ASSETS, name), "utf8"));
}

let cachedExportSchema = null;
let cachedBrokerSchema = null;

export function dcsExportSchema() {
  cachedExportSchema ??= loadSchema("dcs-export.schema.json");
  return cachedExportSchema;
}

export function brokerPackSchema() {
  cachedBrokerSchema ??= loadSchema("broker-pack.schema.json");
  return cachedBrokerSchema;
}

function finding(code, severity, category, remedy, target, message, detail) {
  const entry = { code, severity, category, remedy, target, message };
  if (detail !== undefined) entry.detail = detail;
  return entry;
}

/**
 * Input 1 of the three. Cheap, and the flow cannot address the user's company
 * by name without it — the stage-3 questions and the stage-5 read are both
 * written in company language.
 *
 * Only checked when the caller declares it is supplying one. A caller
 * validating two uploads in isolation (the fixture harness, an adapter smoke
 * test) has no company name to give and should not be told it is missing one.
 */
function checkCompanyName(input, findings) {
  if (!Object.hasOwn(input, "companyName")) return null;
  const name = input.companyName;
  if (typeof name === "string" && name.trim() !== "") return name.trim();
  findings.push(
    finding(
      "company_name_absent",
      SEVERITY.ERROR,
      "incomplete",
      REMEDY.RE_SUPPLY,
      "company_name",
      "No company name was given. Stage 1 requires all three inputs, and the " +
        "company name is the one the questions and the plain-English read are " +
        "written in — a model that cannot name its subject is not deliverable.",
    ),
  );
  return null;
}

/**
 * Accepts an object, a JSON string, or a Buffer. A parse failure is its own
 * finding class: an unparseable upload is not a shape problem, it is not a
 * file the model can say anything about at all.
 */
function coerceUpload(value, target, findings) {
  if (value == null) {
    findings.push(
      finding(
        `${target}_absent`,
        SEVERITY.ERROR,
        "unparseable",
        REMEDY.RE_SUPPLY,
        target,
        `No ${target.replace("_", " ")} was supplied. Stage 1 requires all three inputs.`,
      ),
    );
    return null;
  }
  if (typeof value === "object" && !Buffer.isBuffer(value)) return value;
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      findings.push(
        finding(
          `${target}_wrong_shape`,
          SEVERITY.ERROR,
          "malformed",
          REMEDY.RE_SUPPLY,
          target,
          `The ${target.replace("_", " ")} parsed as ${Array.isArray(parsed) ? "an array" : typeof parsed}, not an object. Expected a document with a header block and rows.`,
        ),
      );
      return null;
    }
    return parsed;
  } catch (error) {
    findings.push(
      finding(
        `${target}_unparseable`,
        SEVERITY.ERROR,
        "unparseable",
        REMEDY.RE_SUPPLY,
        target,
        `The ${target.replace("_", " ")} could not be parsed as JSON: ${error.message}. If this is a raw CSV or XLSX export, it must be run through an adapter first.`,
      ),
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// house-name normalisation
// ---------------------------------------------------------------------------

/**
 * Suffixes are stripped from the END of the name only, never from the middle.
 * That distinction matters: "Bank of America" and "Deutsche Bank" both contain
 * the token "bank", but it is load-bearing in one and a trailing descriptor in
 * the other. Stripping token-wise from anywhere would collapse "Bank of
 * America" to "america", which then matches nothing.
 */
const LEGAL_SUFFIXES = new Set([
  "plc", "ltd", "limited", "llc", "llp", "inc", "incorporated", "corp",
  "corporation", "company", "co", "sa", "nv", "ag", "ab", "as", "gmbh", "spa",
  "kgaa", "group", "holdings", "holding",
]);

/** Everything above, plus the business-line descriptors houses append. */
const DESCRIPTOR_SUFFIXES = new Set([
  ...LEGAL_SUFFIXES,
  "securities", "security", "research", "capital", "markets", "market",
  "bank", "banking", "international", "europe", "european", "global",
  "equity", "equities", "partners", "us", "usa", "uk", "and", "the",
]);

/**
 * Houses that publish under more than one banner. Keyed on the compacted
 * form so that both "Bank of America" and "BofA" land on the same identity.
 * Not exhaustive and not meant to be — it exists so that the commonest
 * double-counting is caught, and anything it misses still gets caught by the
 * punctuation- and suffix-insensitive comparison below.
 */
const HOUSE_ALIASES = new Map(
  Object.entries({
    bofa: "bank_of_america",
    bofasecurities: "bank_of_america",
    bankofamerica: "bank_of_america",
    bankofamericamerrilllynch: "bank_of_america",
    merrilllynch: "bank_of_america",
    jpm: "jp_morgan",
    jpmorgan: "jp_morgan",
    jpmorganchase: "jp_morgan",
    jpmorgancazenove: "jp_morgan",
    bnp: "bnp_paribas",
    bnpexane: "bnp_paribas",
    exane: "bnp_paribas",
    exanebnpparibas: "bnp_paribas",
    bnpparibas: "bnp_paribas",
    bnpparibasexane: "bnp_paribas",
    gs: "goldman_sachs",
    goldmansachs: "goldman_sachs",
    ms: "morgan_stanley",
    morganstanley: "morgan_stanley",
    db: "deutsche_bank",
    deutschebank: "deutsche_bank",
    rbc: "rbc",
    rbccapitalmarkets: "rbc",
    royalbankofcanada: "rbc",
    citi: "citigroup",
    citigroup: "citigroup",
    citibank: "citigroup",
    wellsfargo: "wells_fargo",
    keplercheuvreux: "kepler_cheuvreux",
    kepler: "kepler_cheuvreux",
  }),
);

function tokenise(name) {
  const tokens = String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
  if (tokens[0] === "the") tokens.shift();
  return tokens;
}

function stripTrailing(tokens, suffixes) {
  const kept = [...tokens];
  while (kept.length > 1 && suffixes.has(kept[kept.length - 1])) kept.pop();
  return kept.join("");
}

/**
 * Exported because the same identity rule has to be applied wherever a house
 * name is keyed — if the case builder normalises differently from N0 the
 * duplicate check is decorative.
 */
export function normaliseHouseName(name) {
  const tokens = tokenise(name);
  if (tokens.length === 0) return "";
  const compact = tokens.join("");
  const legal = stripTrailing(tokens, LEGAL_SUFFIXES);
  const descriptor = stripTrailing(tokens, DESCRIPTOR_SUFFIXES);
  for (const candidate of [compact, legal, descriptor]) {
    if (HOUSE_ALIASES.has(candidate)) return HOUSE_ALIASES.get(candidate);
  }
  return descriptor || legal || compact;
}

// ---------------------------------------------------------------------------
// debt export
// ---------------------------------------------------------------------------

/** Instrument fields audited individually below, so the generic schema error
 *  for them is suppressed in favour of a message that names the instrument. */
const AUDITED_INSTRUMENT_FIELDS = new Set([
  "maturity_date",
  "maturity_precision",
  "maturity_treatment",
  "coupon_rate",
  "reference_rate",
  "margin_bps",
  "all_in_rate",
  "committed",
  "facility_limit",
  "drawn_amount",
]);

function schemaFindings(errors, target, code, suppressAudited) {
  return errors
    .filter((message) => {
      if (!suppressAudited) return true;
      const match = /^\$\.instruments\[\d+\]\.([a-z_]+)/.exec(message);
      return !(match && AUDITED_INSTRUMENT_FIELDS.has(match[1]));
    })
    .map((message) =>
      finding(
        code,
        SEVERITY.ERROR,
        "malformed",
        REMEDY.RE_SUPPLY,
        target,
        message,
      ),
    );
}

function checkExportHeader(exp, expected, findings) {
  // --- as_of: the stale-export assertion -----------------------------------
  const asOf = exp.as_of;
  const periodEnd = expected?.last_historical_period_end ?? null;
  if (typeof asOf === "string" && periodEnd && asOf !== periodEnd) {
    findings.push(
      finding(
        "export_as_of_mismatch",
        SEVERITY.ERROR,
        "stale",
        REMEDY.RE_SUPPLY,
        "dcs_export.as_of",
        `The export is struck at ${asOf}; the last reported period ends ${periodEnd}. ` +
          `Balances at ${asOf} will not foot to the ${periodEnd} accounts. ` +
          `Set the FactSet date toggle to LAST FISCAL YEAR END (${periodEnd}) and re-export.`,
        { as_of: asOf, expected_period_end: periodEnd },
      ),
    );
  }

  const basis = exp.source?.date_basis;
  if (basis && basis !== "last_fiscal_year_end") {
    const mismatched =
      typeof asOf === "string" && periodEnd && asOf !== periodEnd;
    findings.push(
      finding(
        "export_date_basis_not_year_end",
        mismatched ? SEVERITY.ERROR : SEVERITY.WARNING,
        "stale",
        mismatched ? REMEDY.RE_SUPPLY : REMEDY.PROCEED_WITH_NOTE,
        "dcs_export.source.date_basis",
        `The export declares date_basis "${basis}" rather than "last_fiscal_year_end".` +
          (mismatched
            ? ""
            : ` Its as_of does match ${periodEnd}, so it is being accepted, but the toggle should be set to last fiscal year end.`),
      ),
    );
  }

  // --- currency ------------------------------------------------------------
  const reportingCurrency = exp.reporting_currency;
  if (
    expected?.reporting_currency &&
    reportingCurrency &&
    reportingCurrency !== expected.reporting_currency
  ) {
    findings.push(
      finding(
        "export_reporting_currency_mismatch",
        SEVERITY.ERROR,
        "malformed",
        REMEDY.RE_SUPPLY,
        "dcs_export.reporting_currency",
        `The export is stated in ${reportingCurrency}; ${expected.issuer_name ?? "the company"} reports in ${expected.reporting_currency}. ` +
          `Reporting currency follows the company and is never converted here — re-export in ${expected.reporting_currency}.`,
      ),
    );
  }

  // --- units ---------------------------------------------------------------
  if (expected?.units && exp.units && exp.units !== expected.units) {
    findings.push(
      finding(
        "export_units_mismatch",
        SEVERITY.ERROR,
        "malformed",
        REMEDY.RE_SUPPLY,
        "dcs_export.units",
        `The export declares amounts in ${exp.units}; the model reports in ${expected.units}. ` +
          `Re-export in ${expected.units}, or run it through an adapter that rescales every amount column.`,
      ),
    );
  }

  // --- per-column declarations --------------------------------------------
  const columns = Array.isArray(exp.columns) ? exp.columns : [];
  if (columns.length > 0 && !columns.some((c) => c?.field === "outstanding_amount")) {
    findings.push(
      finding(
        "export_column_outstanding_undeclared",
        SEVERITY.ERROR,
        "malformed",
        REMEDY.RE_SUPPLY,
        "dcs_export.columns",
        "No column declaration for outstanding_amount. Every amount column must declare its currency and scale; that declaration is what makes a units or FX error detectable here rather than at the reconciliation.",
      ),
    );
  }
  for (const column of columns) {
    if (!column || typeof column !== "object") continue;
    if (column.currency && reportingCurrency && column.currency !== reportingCurrency) {
      findings.push(
        finding(
          "export_column_currency_mismatch",
          SEVERITY.ERROR,
          "malformed",
          REMEDY.RE_SUPPLY,
          `dcs_export.columns.${column.field}`,
          `Column "${column.field}" is stated in ${column.currency}, but the export reports in ${reportingCurrency}. ` +
            `A native-currency column cannot be summed into a ${reportingCurrency} total. Translate it at the ${exp.as_of ?? "as_of"} rate, or re-export the column in ${reportingCurrency}.`,
        ),
      );
    }
    if (column.units && exp.units && column.units !== exp.units) {
      findings.push(
        finding(
          "export_column_units_mismatch",
          SEVERITY.ERROR,
          "malformed",
          REMEDY.RE_SUPPLY,
          `dcs_export.columns.${column.field}`,
          `Column "${column.field}" is declared in ${column.units} while the export header declares ${exp.units}. ` +
            `Mixed scales inside one file cannot be resolved by inspection — the two disagree by a factor of 1,000 and both readings look plausible. Re-export with a single scale.`,
        ),
      );
    }
  }
}

function checkExportScale(exp, expected, instruments, findings) {
  const reported = expected?.reported_gross_debt;
  if (!finite(reported) || reported === 0) return;
  const total = instruments.reduce(
    (sum, row) => sum + (finite(row?.outstanding_amount) ? row.outstanding_amount : 0),
    0,
  );
  if (total === 0) return;
  const ratio = total / reported;
  const near = (value, target) => value > target * 0.9 && value < target * 1.1;
  if (near(ratio, 1000)) {
    findings.push(
      finding(
        "export_units_scale_mismatch",
        SEVERITY.ERROR,
        "ambiguous",
        REMEDY.RE_SUPPLY,
        "dcs_export.units",
        `Instruments total ${money(total)} against reported gross debt of ${money(reported)} — a factor of about 1,000. ` +
          `The export declares ${exp.units} but the amounts read as ${exp.units === "millions" ? "thousands" : "units"}. Re-export at the model's scale (${expected?.units ?? exp.units}).`,
        { instruments_total: total, reported_gross_debt: reported, ratio },
      ),
    );
  } else if (near(ratio, 0.001)) {
    findings.push(
      finding(
        "export_units_scale_mismatch",
        SEVERITY.ERROR,
        "ambiguous",
        REMEDY.RE_SUPPLY,
        "dcs_export.units",
        `Instruments total ${money(total)} against reported gross debt of ${money(reported)} — smaller by a factor of about 1,000. ` +
          `The export declares ${exp.units} but the amounts read as a coarser scale. Re-export at the model's scale (${expected?.units ?? exp.units}).`,
        { instruments_total: total, reported_gross_debt: reported, ratio },
      ),
    );
  }
}

function auditInstrument(row, index, exp, expected, findings) {
  const label = row?.description || row?.instrument_id || `row ${index + 1}`;
  const where = `dcs_export.instruments[${index}]`;
  const has = (key) =>
    row != null && Object.hasOwn(row, key) && row[key] !== null && row[key] !== undefined;

  // --- maturity ------------------------------------------------------------
  if (!has("maturity_date")) {
    if (row?.maturity_treatment === "non_maturing_within_forecast") {
      findings.push(
        finding(
          "instrument_non_maturing",
          SEVERITY.INFO,
          "incomplete",
          REMEDY.PROCEED_WITH_NOTE,
          `${where}.maturity_date`,
          `${label} has no maturity date and is declared non-maturing within the forecast. It will sit flat across all three forecast years and that treatment is printed in the stated assumptions.`,
        ),
      );
    } else {
      findings.push(
        finding(
          "instrument_maturity_missing",
          SEVERITY.ERROR,
          "incomplete",
          REMEDY.RE_SUPPLY,
          `${where}.maturity_date`,
          `${label} has no maturity date. The maturity schedule and the refinancing logic both read it, and it is not something the user can supply in one word. ` +
            `Either re-export with the maturity column populated, or declare maturity_treatment "non_maturing_within_forecast" if the instrument genuinely does not mature inside the forecast.`,
          { instrument_id: row?.instrument_id },
        ),
      );
    }
  } else if (!has("maturity_precision")) {
    findings.push(
      finding(
        "instrument_maturity_precision_absent",
        SEVERITY.WARNING,
        "incomplete",
        REMEDY.PROCEED_WITH_NOTE,
        `${where}.maturity_precision`,
        `${label} gives a maturity date (${row.maturity_date}) but does not say how precisely it was disclosed. Treated as day precision and printed as a stated assumption.`,
      ),
    );
  }

  // --- rate ----------------------------------------------------------------
  if (row?.rate_type === "unpriced") {
    const validTreatment =
      row.pricing_treatment === "residual_interest_plug" &&
      String(row.pricing_treatment_reason ?? "").trim();
    findings.push(
      finding(
        validTreatment
          ? "instrument_pricing_captured_by_residual"
          : "instrument_unpriced_without_treatment",
        validTreatment ? SEVERITY.INFO : SEVERITY.ERROR,
        validTreatment ? "complete" : "incomplete",
        validTreatment ? REMEDY.PROCEED_WITH_NOTE : REMEDY.RE_SUPPLY,
        `${where}.pricing_treatment`,
        validTreatment
          ? `${label} has no sourced instrument pricing. It remains in debt and liquidity, while forecast interest is captured through the visible Other / unallocated interest bridge.`
          : `${label} is unpriced but has no declared residual-interest treatment and reason.`,
        { instrument_id: row?.instrument_id },
      ),
    );
  }
  if (row?.rate_type === "fixed" && !has("coupon_rate")) {
    findings.push(
      finding(
        "instrument_coupon_missing",
        SEVERITY.ERROR,
        "incomplete",
        REMEDY.RE_SUPPLY,
        `${where}.coupon_rate`,
        `${label} is a fixed-rate instrument with no coupon. Interest expense cannot be computed for it, and a guess would flow straight into leverage and coverage.`,
        { instrument_id: row?.instrument_id },
      ),
    );
  }
  if (row?.rate_type === "floating") {
    const missing = ["reference_rate", "margin_bps"].filter((key) => !has(key));
    if (missing.length > 0) {
      findings.push(
        finding(
          "instrument_floating_rate_incomplete",
          SEVERITY.ERROR,
          "incomplete",
          REMEDY.RE_SUPPLY,
          `${where}.${missing[0]}`,
          `${label} is floating-rate but is missing ${missing.join(" and ")}. A floating instrument needs both a named benchmark and a margin in basis points; neither can be inferred from the other.`,
          { instrument_id: row?.instrument_id, missing },
        ),
      );
    }
  }
  if (row?.rate_type === "manual_all_in" && !has("all_in_rate")) {
    findings.push(
      finding(
        "instrument_all_in_rate_missing",
        SEVERITY.ERROR,
        "incomplete",
        REMEDY.RE_SUPPLY,
        `${where}.all_in_rate`,
        `${label} declares a blended all-in rate but does not give one.`,
        { instrument_id: row?.instrument_id },
      ),
    );
  }
  // Percent-vs-decimal is the schema's own named scale hazard, and the
  // production failure it produces is silent: a 0.700% coupon divided by 100
  // a second time prices the bond's interest at zero while every internal
  // parity gate still agrees with itself. A rate strictly between zero and
  // five basis points, or above 25%, is treated as mis-scaled evidence to be
  // re-supplied; an exact zero remains a legal zero-coupon.
  for (const key of ["coupon_rate", "all_in_rate"]) {
    if (!has(key)) continue;
    const value = Number(row[key]);
    if (!Number.isFinite(value)) continue;
    if ((value > 0 && value < 0.0005) || value > 0.25) {
      findings.push(
        finding(
          "instrument_rate_mis_scaled",
          SEVERITY.ERROR,
          "inconsistent",
          REMEDY.RE_SUPPLY,
          `${where}.${key}`,
          `${label} gives ${key} = ${value}. The contract unit is a decimal ` +
            `(0.04 for 4.0%), so this is below five basis points or above ` +
            `25% — almost certainly a percent divided by 100 twice, or a ` +
            `percent left undivided. Re-supply the export with the decimal ` +
            `rate, or state explicitly that the instrument genuinely ` +
            `carries this rate.`,
          { instrument_id: row?.instrument_id, value },
        ),
      );
    }
  }

  // --- revolver mechanics --------------------------------------------------
  if (row?.instrument_type === "rcf") {
    if (!has("facility_limit")) {
      findings.push(
        finding(
          "instrument_facility_limit_missing",
          SEVERITY.ERROR,
          "incomplete",
          REMEDY.RE_SUPPLY,
          `${where}.facility_limit`,
          `${label} is a revolving facility with no facility limit. Headroom and liquidity are the facility limit less the drawn amount; without the limit the liquidity block cannot be built at all.`,
          { instrument_id: row?.instrument_id },
        ),
      );
    }
    if (!has("drawn_amount")) {
      findings.push(
        finding(
          "instrument_drawn_amount_missing",
          SEVERITY.ERROR,
          "incomplete",
          REMEDY.RE_SUPPLY,
          `${where}.drawn_amount`,
          `${label} is a revolving facility with no drawn amount. Opening debt, available capacity and interest all depend on that balance, so it cannot be inferred from the facility limit.`,
          { instrument_id: row?.instrument_id },
        ),
      );
    }
    if (
      has("drawn_amount") &&
      has("outstanding_amount") &&
      finite(row.drawn_amount) &&
      finite(row.outstanding_amount) &&
      Math.abs(row.drawn_amount - row.outstanding_amount) > 1e-9
    ) {
      findings.push(
        finding(
          "instrument_drawn_outstanding_mismatch",
          SEVERITY.ERROR,
          "malformed",
          REMEDY.RE_SUPPLY,
          `${where}.drawn_amount`,
          `${label} shows ${money(row.drawn_amount)} drawn but ${money(row.outstanding_amount)} outstanding. Those are the same opening principal for an RCF; re-export or correct the adapter rather than choosing one silently.`,
          { instrument_id: row?.instrument_id },
        ),
      );
    }
    if (
      has("undrawn_amount") &&
      has("facility_limit") &&
      has("drawn_amount") &&
      finite(row.undrawn_amount) &&
      finite(row.facility_limit) &&
      finite(row.drawn_amount) &&
      Math.abs(row.undrawn_amount - (row.facility_limit - row.drawn_amount)) > 1e-9
    ) {
      findings.push(
        finding(
          "instrument_undrawn_capacity_mismatch",
          SEVERITY.ERROR,
          "malformed",
          REMEDY.RE_SUPPLY,
          `${where}.undrawn_amount`,
          `${label} shows ${money(row.undrawn_amount)} undrawn, but its ${money(row.facility_limit)} limit less ${money(row.drawn_amount)} drawn is ${money(row.facility_limit - row.drawn_amount)}. Liquidity cannot use contradictory capacity figures.`,
          { instrument_id: row?.instrument_id },
        ),
      );
    }
    if (
      has("facility_limit") &&
      has("drawn_amount") &&
      finite(row.facility_limit) &&
      finite(row.drawn_amount) &&
      row.drawn_amount > row.facility_limit
    ) {
      findings.push(
        finding(
          "instrument_drawn_exceeds_limit",
          SEVERITY.ERROR,
          "malformed",
          REMEDY.RE_SUPPLY,
          `${where}.drawn_amount`,
          `${label} shows ${money(row.drawn_amount)} drawn against a ${money(row.facility_limit)} limit. One of the two columns is wrong or the file mixes scales.`,
        ),
      );
    }
  }

  // --- commitment: the deliberate hole ------------------------------------
  // Only asked where it changes a number. Commitment governs whether UNDRAWN
  // capacity counts toward liquidity, so it is a real question for a facility
  // and a nonsense one for a drawn bond — "is the 2028 senior note committed?"
  // is not something an analyst would ask, and on a thirty-instrument export
  // asking it per row would blow the stage-3 cap of five on its own.
  const isFacility =
    row?.instrument_type === "rcf" || finite(row?.facility_limit);
  if (isFacility && (!Object.hasOwn(row ?? {}, "committed") || row.committed === null)) {
    findings.push(
      finding(
        "instrument_commitment_unknown",
        SEVERITY.QUESTION,
        "incomplete",
        REMEDY.ANSWER,
        `${where}.committed`,
        `Is ${label} committed? Your export doesn't say. If it isn't, ${
          finite(row?.facility_limit)
            ? money(row.facility_limit)
            : finite(row?.outstanding_amount)
              ? money(row.outstanding_amount)
              : "the facility"
        } drops out of liquidity.`,
        {
          instrument_id: row?.instrument_id,
          amount_at_stake: finite(row?.facility_limit)
            ? row.facility_limit
            : row?.outstanding_amount ?? null,
          answer_shape: "yes/no",
        },
      ),
    );
  }

  // --- call date before maturity ------------------------------------------
  // Only where the call falls INSIDE the forecast window. A 2035 call on a
  // 2040 bond changes nothing across three forecast years, and a question
  // whose two answers produce the same output does not clear stage 3's bar.
  const forecastEnd = Array.isArray(expected?.forecast_period_ends)
    ? expected.forecast_period_ends[expected.forecast_period_ends.length - 1]
    : null;
  if (
    typeof row?.next_call_date === "string" &&
    typeof row?.maturity_date === "string" &&
    row.next_call_date < row.maturity_date &&
    (!forecastEnd || row.next_call_date <= forecastEnd)
  ) {
    findings.push(
      finding(
        "instrument_call_before_maturity",
        SEVERITY.QUESTION,
        "ambiguous",
        REMEDY.ANSWER,
        `${where}.next_call_date`,
        `${label} matures ${row.maturity_date} but is callable ${row.next_call_date}. Should I use the ${row.next_call_date.slice(0, 4)} call date?`,
        {
          instrument_id: row?.instrument_id,
          options: [row.next_call_date.slice(0, 4), row.maturity_date.slice(0, 4)],
          answer_shape: "yes/no",
        },
      ),
    );
  }
}

function checkExportInstruments(exp, expected, findings) {
  const instruments = Array.isArray(exp.instruments) ? exp.instruments : [];
  // The schema's minItems already rejects an empty array, but only with the
  // generic "$.instruments has 0 items". The specific reading — that the user
  // has almost certainly uploaded deployment host's own FactSet summary instead of the
  // full DCS debt detail — is the one that tells them what to do next.
  if (Array.isArray(exp.instruments) && instruments.length === 0) {
    findings.push(
      finding(
        "export_has_no_instrument_rows",
        SEVERITY.ERROR,
        "malformed",
        REMEDY.RE_SUPPLY,
        "dcs_export.instruments",
        "The debt export has no instrument rows. deployment host's native FactSet source is a summary and is NOT a substitute for the full DCS debt export — a summary has no instrument-level detail, and instrument-level detail is the only thing the export is authoritative for.",
      ),
    );
  }
  const seen = new Map();
  instruments.forEach((row, index) => {
    if (row == null || typeof row !== "object") return;
    const id = row.instrument_id;
    if (typeof id === "string") {
      if (seen.has(id)) {
        findings.push(
          finding(
            "instrument_duplicate_id",
            SEVERITY.ERROR,
            "malformed",
            REMEDY.RE_SUPPLY,
            `dcs_export.instruments[${index}].instrument_id`,
            `instrument_id "${id}" appears twice (rows ${seen.get(id) + 1} and ${index + 1}). Two rows sharing a key are either a duplicated position — which would double-count in gross debt — or two different instruments that need distinct ids.`,
          ),
        );
      } else {
        seen.set(id, index);
      }
    }
    auditInstrument(row, index, exp, expected, findings);
  });
  return instruments;
}

function checkExportTotals(exp, instruments, findings) {
  const declared = exp.totals;
  if (!declared) return;
  if (finite(declared.total_outstanding)) {
    const total = instruments.reduce(
      (sum, row) => sum + (finite(row?.outstanding_amount) ? row.outstanding_amount : 0),
      0,
    );
    const gap = Math.abs(total - declared.total_outstanding);
    if (gap > Math.max(0.5, Math.abs(declared.total_outstanding) * 0.0001)) {
      findings.push(
        finding(
          "export_totals_disagree",
          SEVERITY.ERROR,
          "malformed",
          REMEDY.RE_SUPPLY,
          "dcs_export.totals.total_outstanding",
          `The export declares a total of ${money(declared.total_outstanding)} but its rows sum to ${money(total)} (difference ${money(gap)}). The file was filtered or truncated in transit.`,
        ),
      );
    }
  }
  if (
    Number.isInteger(declared.instrument_count) &&
    declared.instrument_count !== instruments.length
  ) {
    findings.push(
      finding(
        "export_row_count_disagrees",
        SEVERITY.ERROR,
        "malformed",
        REMEDY.RE_SUPPLY,
        "dcs_export.totals.instrument_count",
        `The export declares ${declared.instrument_count} instruments but carries ${instruments.length} rows.`,
      ),
    );
  }
}

function validateDcsExport(raw, expected, findings) {
  const exp = coerceUpload(raw, "dcs_export", findings);
  if (!exp) return null;

  const schemaErrors = validateJsonSchema(exp, dcsExportSchema());
  findings.push(
    ...schemaFindings(schemaErrors, "dcs_export", "export_schema_violation", true),
  );

  // The header checks run even when the schema complained: a file that is
  // both stale and malformed should say so once for each, not stop at the
  // first. They are guarded individually against missing fields.
  checkExportHeader(exp, expected, findings);
  const instruments = checkExportInstruments(exp, expected, findings);
  checkExportTotals(exp, instruments, findings);
  checkExportScale(exp, expected, instruments, findings);

  if (exp.entity?.name) {
    findings.push(
      finding(
        "entity_match_deferred",
        SEVERITY.INFO,
        "deferred",
        REMEDY.NONE,
        "dcs_export.entity",
        `Export entity is "${exp.entity.name}". Matching it against the filings is ${ENTITY_MATCH_NODE}'s gate, not ${NODE_ID}'s — the filings are not a stage-1 input, so this node sits upstream of the one that reads them.`,
        { entity: exp.entity, owner: ENTITY_MATCH_NODE },
      ),
    );
  }

  return exp;
}

// ---------------------------------------------------------------------------
// broker pack
// ---------------------------------------------------------------------------

function contributes(series) {
  return (
    Array.isArray(series) &&
    series.some((value) => value !== null && value !== undefined && finite(Number(value)))
  );
}

function checkBrokerHouses(pack, findings) {
  const houses = Array.isArray(pack.houses) ? pack.houses : [];

  if (houses.length < MIN_BROKER_HOUSES) {
    findings.push(
      finding(
        "broker_house_count_below_minimum",
        SEVERITY.ERROR,
        "out_of_range",
        REMEDY.RE_SUPPLY,
        "broker_pack.houses",
        `Broker set contains ${houses.length} contributor${houses.length === 1 ? "" : "s"}, minimum ${MIN_BROKER_HOUSES}. ` +
          `Three is the fewest that lets a disagreement between houses be settled by majority; with ${houses.length} the forecast anchor cannot resolve.`,
        { house_count: houses.length, minimum: MIN_BROKER_HOUSES },
      ),
    );
  } else if (houses.length > MAX_BROKER_HOUSES) {
    findings.push(
      finding(
        "broker_house_count_above_maximum",
        SEVERITY.ERROR,
        "out_of_range",
        REMEDY.RE_SUPPLY,
        "broker_pack.houses",
        `Broker set contains ${houses.length} contributors, maximum ${MAX_BROKER_HOUSES}. Drop ${houses.length - MAX_BROKER_HOUSES} and re-supply.`,
        { house_count: houses.length, maximum: MAX_BROKER_HOUSES },
      ),
    );
  }

  // --- duplicate identities ------------------------------------------------
  const byId = new Map();
  const byIdentity = new Map();
  houses.forEach((house, index) => {
    if (house == null || typeof house !== "object") return;
    const id = house.house_id;
    if (typeof id === "string") {
      if (byId.has(id)) {
        findings.push(
          finding(
            "broker_house_duplicate_id",
            SEVERITY.ERROR,
            "malformed",
            REMEDY.RE_SUPPLY,
            `broker_pack.houses[${index}].house_id`,
            `house_id "${id}" appears twice (entries ${byId.get(id).index + 1} and ${index + 1}).`,
          ),
        );
      } else {
        byId.set(id, { index, house });
      }
    }
    const identity = normaliseHouseName(house.house_name ?? id ?? "");
    if (!identity) return;
    if (byIdentity.has(identity)) {
      const first = byIdentity.get(identity);
      findings.push(
        finding(
          "broker_house_duplicate_identity",
          SEVERITY.ERROR,
          "malformed",
          REMEDY.RE_SUPPLY,
          `broker_pack.houses[${index}].house_name`,
          `"${first.house.house_name}" (entry ${first.index + 1}) and "${house.house_name}" (entry ${index + 1}) are the same house under different spellings. ` +
            `Two notes from one house is one contributor, not two — counted twice it would carry a majority the pack does not actually have. Merge them, or correct the name if they really are different houses.`,
          {
            normalised: identity,
            spellings: [first.house.house_name, house.house_name],
          },
        ),
      );
    } else {
      byIdentity.set(identity, { index, house });
    }
  });

  // --- documents -----------------------------------------------------------
  const acceptedTypes = new Set(
    brokerPackSchema().$defs.house.properties.document.properties.media_type.enum,
  );
  houses.forEach((house, index) => {
    const doc = house?.document;
    if (!doc || typeof doc !== "object") return;
    if (doc.media_type && !acceptedTypes.has(doc.media_type)) {
      findings.push(
        finding(
          "broker_document_type_unaccepted",
          SEVERITY.ERROR,
          "malformed",
          REMEDY.RE_SUPPLY,
          `broker_pack.houses[${index}].document.media_type`,
          `${house.house_name ?? `Entry ${index + 1}`}: "${doc.file_name ?? "note"}" is ${doc.media_type}, which is not an accepted broker research format. Accepted types are listed in broker-pack.schema.json (x_contract_notes.accepted_file_types).`,
        ),
      );
    }
    if (
      doc.text_extractable === false &&
      !(
        ["verified_image_transcription", "mixed_verified"].includes(doc.extraction_method) &&
        /^[a-f0-9]{64}$/.test(String(doc.extraction_evidence_sha256 ?? ""))
      )
    ) {
      findings.push(
        finding(
          "broker_document_not_text_extractable",
          SEVERITY.ERROR,
          "malformed",
          REMEDY.RE_SUPPLY,
          `broker_pack.houses[${index}].document.text_extractable`,
          `${house.house_name ?? `Entry ${index + 1}`}: "${doc.file_name ?? "note"}" has no native text layer and lacks a hash-bound verified image transcription. Supply two agreeing cell-addressed passes (or a reviewed resolution), or re-supply a native-text PDF/spreadsheet.`,
        ),
      );
    }
  });

  // --- note age ------------------------------------------------------------
  if (typeof pack.as_of === "string") {
    houses.forEach((house, index) => {
      if (typeof house?.published_date !== "string") return;
      const days =
        (Date.parse(`${pack.as_of}T00:00:00Z`) -
          Date.parse(`${house.published_date}T00:00:00Z`)) /
        86400000;
      if (Number.isFinite(days) && days > 365) {
        findings.push(
          finding(
            "broker_note_stale",
            SEVERITY.WARNING,
            "ambiguous",
            REMEDY.PROCEED_WITH_NOTE,
            `broker_pack.houses[${index}].published_date`,
            `${house.house_name ?? `Entry ${index + 1}`}'s note is dated ${house.published_date}, ${Math.round(days / 30)} months before the pack date. It is being used, and its age is printed in the stated assumptions.`,
          ),
        );
      }
    });
  }

  return houses;
}

function checkBrokerMetrics(pack, houses, findings) {
  const catalogue = pack.metrics && typeof pack.metrics === "object" ? pack.metrics : {};
  const declared = new Set(Object.keys(catalogue));

  for (const metricId of REQUIRED_BROKER_METRICS) {
    if (!declared.has(metricId)) {
      findings.push(
        finding(
          "broker_metric_undeclared",
          SEVERITY.WARNING,
          "incomplete",
          REMEDY.PROCEED_WITH_NOTE,
          `broker_pack.metrics.${metricId}`,
          `The broker pack does not carry ${metricId}. That broker authority is unavailable; the sealed forecast waterfall must resolve each material row-period from another evidenced source.`,
        ),
      );
    }
  }

  const contributorCount = {};
  const contributorCountByPeriod = {};
  for (const metricId of declared) contributorCount[metricId] = 0;
  for (const metricId of declared) contributorCountByPeriod[metricId] = [0, 0, 0];
  houses.forEach((house, index) => {
    const estimates = house?.estimates;
    if (!estimates || typeof estimates !== "object") return;
    for (const [metricId, series] of Object.entries(estimates)) {
      if (!declared.has(metricId)) {
        findings.push(
          finding(
            "broker_metric_not_in_catalogue",
            SEVERITY.ERROR,
            "malformed",
            REMEDY.RE_SUPPLY,
            `broker_pack.houses[${index}].estimates.${metricId}`,
            `${house?.house_name ?? `Entry ${index + 1}`} supplies "${metricId}", which is not declared in the pack's metrics catalogue. An undeclared metric has no label and no unit kind, so it cannot be read.`,
          ),
        );
        continue;
      }
      if (contributes(series)) contributorCount[metricId] += 1;
      for (let periodIndex = 0; periodIndex < 3; periodIndex += 1) {
        const value = series?.[periodIndex];
        if (value !== null && value !== undefined && finite(Number(value))) {
          contributorCountByPeriod[metricId][periodIndex] += 1;
        }
      }
    }
  });

  for (const metricId of REQUIRED_BROKER_METRICS) {
    if (!declared.has(metricId)) continue;
    if (contributorCount[metricId] === 0) {
      const severity = SEVERITY.WARNING;
      findings.push(
        finding(
          "broker_metric_unsupported",
          severity,
          "incomplete",
          REMEDY.PROCEED_WITH_NOTE,
          `broker_pack.metrics.${metricId}`,
          `${metricId} is declared but no house supplies a usable figure. The broker candidate is unavailable; the forecast waterfall must select another evidenced authority and disclose it.`,
          { metric: metricId },
        ),
      );
    }
  }

  if (declared.has("revenue")) {
    const missingPeriods = contributorCountByPeriod.revenue
      .map((count, index) => (count === 0 ? index + 1 : null))
      .filter((index) => index !== null);
    if (missingPeriods.length > 0) {
      findings.push(
        finding(
          "broker_revenue_period_unsupported",
          SEVERITY.WARNING,
          "incomplete",
          REMEDY.PROCEED_WITH_NOTE,
          "broker_pack.metrics.revenue",
          `Revenue has no named-house estimate for forecast period${missingPeriods.length === 1 ? "" : "s"} ${missingPeriods.join(", ")}. Those periods remain unavailable from brokers and must be resolved by the forecast waterfall without borrowing another house.`,
          { missing_periods: missingPeriods, contributors_by_period: contributorCountByPeriod.revenue },
        ),
      );
    }
  }

  const anchorCounts = ANCHOR_METRICS.map((metricId) => ({
    metricId,
    contributors: contributorCount[metricId] ?? 0,
  }));
  if (anchorCounts[0].contributors === 0 && anchorCounts[1].contributors === 0) {
    findings.push(
      finding(
        "broker_anchor_unresolvable",
        SEVERITY.WARNING,
        "incomplete",
        REMEDY.PROCEED_WITH_NOTE,
        "broker_pack.metrics",
        "Neither EBIT nor Adj. EBITDA has a usable broker contributor. No broker headline anchor will be selected; the forecast waterfall must resolve the issuer statement graph from other evidence.",
        { anchor_contributors: anchorCounts },
      ),
    );
  }

  const fullPeriodHeadline = ["ebit", "adjusted_ebitda"].some(
    (metricId) => Math.min(...(contributorCountByPeriod[metricId] ?? [0, 0, 0])) > 0,
  );
  const fullPeriodDa = Math.min(
    ...(contributorCountByPeriod.depreciation_and_amortisation ?? [0, 0, 0]),
  ) > 0;
  if (!fullPeriodHeadline || !fullPeriodDa) {
    findings.push(
      finding(
        "broker_anchor_periods_unresolvable",
        SEVERITY.WARNING,
        "incomplete",
        REMEDY.PROCEED_WITH_NOTE,
        "broker_pack.metrics",
        "No single broker house supplies a complete compatible headline plus D&A bridge across all forecast periods. Broker authority will not be mixed across houses; the forecast waterfall must resolve the missing periods from other evidence.",
        { contributors_by_period: Object.fromEntries(ANCHOR_METRICS.map((metricId) => [metricId, contributorCountByPeriod[metricId] ?? [0, 0, 0]])) },
      ),
    );
  }

  return { contributorCount, contributorCountByPeriod, anchorCounts };
}

function validateBrokerPack(raw, expected, findings) {
  const pack = coerceUpload(raw, "broker_pack", findings);
  if (!pack) return null;

  findings.push(
    ...schemaFindings(
      validateJsonSchema(pack, brokerPackSchema()),
      "broker_pack",
      "broker_pack_schema_violation",
      false,
    ),
  );

  if (
    expected?.reporting_currency &&
    pack.reporting_currency &&
    pack.reporting_currency !== expected.reporting_currency
  ) {
    findings.push(
      finding(
        "broker_currency_mismatch",
        SEVERITY.ERROR,
        "malformed",
        REMEDY.RE_SUPPLY,
        "broker_pack.reporting_currency",
        `The broker set is stated in ${pack.reporting_currency}; ${expected.issuer_name ?? "the company"} reports in ${expected.reporting_currency}. Estimates in two currencies cannot be averaged into one consensus.`,
      ),
    );
  }
  if (expected?.units && pack.units && pack.units !== expected.units) {
    findings.push(
      finding(
        "broker_units_mismatch",
        SEVERITY.ERROR,
        "malformed",
        REMEDY.RE_SUPPLY,
        "broker_pack.units",
        `The broker set declares ${pack.units}; the model reports in ${expected.units}. Rescale on extraction.`,
      ),
    );
  }
  if (
    Array.isArray(expected?.forecast_period_ends) &&
    Array.isArray(pack.forecast_periods) &&
    pack.forecast_periods.length === 3 &&
    expected.forecast_period_ends.length === 3 &&
    pack.forecast_periods.join("|") !== expected.forecast_period_ends.join("|")
  ) {
    findings.push(
      finding(
        "broker_forecast_periods_mismatch",
        SEVERITY.ERROR,
        "malformed",
        REMEDY.RE_SUPPLY,
        "broker_pack.forecast_periods",
        `The broker set is aligned to ${pack.forecast_periods.join(", ")}; the model forecasts ${expected.forecast_period_ends.join(", ")}. ` +
          `Estimates are read by position, so a misaligned pack would put each house's first forecast year in the wrong column.`,
      ),
    );
  }

  const houses = checkBrokerHouses(pack, findings);
  const metrics = checkBrokerMetrics(pack, houses, findings);
  return { pack, houses, metrics };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {string} [input.companyName] Stage-1 input 1. Checked only when the
 *   key is present, so a caller validating the two uploads alone is not told
 *   it is missing a name it never claimed to have.
 * @param {object|string|Buffer} input.dcsExport
 * @param {object|string|Buffer} input.brokerPack
 * @param {object} [input.expected] Everything N0 checks the uploads AGAINST.
 *   All optional; each absent field simply disables its own check, so N0 can
 *   run on the uploads alone before the fiscal calendar is known.
 *   - last_historical_period_end : periods[2].date. Gates as_of.
 *   - forecast_period_ends       : the three forecast period ends.
 *   - reporting_currency, units  : the issuer's, from the filings profile.
 *   - reported_gross_debt        : enables the scale cross-check.
 *   - issuer_name                : for message wording only.
 */
export function runIntake(input = {}) {
  const findings = [];
  const expected = input.expected ?? {};

  const companyName = checkCompanyName(input, findings);
  const exp = validateDcsExport(input.dcsExport, expected, findings);
  const broker = validateBrokerPack(input.brokerPack, expected, findings);

  const bySeverity = (severity) => findings.filter((f) => f.severity === severity);
  const errors = bySeverity(SEVERITY.ERROR);
  const questions = bySeverity(SEVERITY.QUESTION);

  return {
    node: NODE_ID,
    ok: errors.length === 0,
    gate: {
      passed: errors.length === 0,
      reason:
        errors.length === 0
          ? "Both uploads parse. Broker count in range. Export as_of matches the last reported period end."
          : `${errors.length} blocking finding${errors.length === 1 ? "" : "s"} at intake.`,
    },
    findings,
    errors,
    questions,
    warnings: bySeverity(SEVERITY.WARNING),
    info: bySeverity(SEVERITY.INFO),
    remedies: {
      re_supply: findings.filter(
        (f) => f.remedy === REMEDY.RE_SUPPLY && f.severity === SEVERITY.ERROR,
      ),
      answer: questions,
      proceed_with_note: findings.filter(
        (f) => f.remedy === REMEDY.PROCEED_WITH_NOTE,
      ),
    },
    summary: {
      company_name: companyName,
      instrument_count: Array.isArray(exp?.instruments) ? exp.instruments.length : 0,
      house_count: broker?.houses?.length ?? 0,
      export_as_of: exp?.as_of ?? null,
      expected_period_end: expected.last_historical_period_end ?? null,
      anchor_contributors: broker?.metrics?.anchorCounts ?? null,
    },
    /**
     * Carried forward untouched, in the export's own vocabulary. `entity` is
     * N2's problem, not N0's; `export` is the whole validated document, handed
     * on unrenamed so that stage 2 and stage 3 read the same names the
     * contract declares rather than a second internal shape.
     */
    handoff: exp
      ? {
          company_name: companyName,
          entity: exp.entity ?? null,
          entity_match_owner: ENTITY_MATCH_NODE,
          as_of: exp.as_of ?? null,
          reporting_currency: exp.reporting_currency ?? null,
          units: exp.units ?? null,
          export: exp,
          broker_pack: broker?.pack ?? null,
        }
      : null,
  };
}

/** Plain-text rendering for the stage-1 screen. */
export function formatIntakeReport(result) {
  const lines = [];
  const push = (entry) =>
    lines.push(`  [${entry.severity}/${entry.remedy}] ${entry.code}`, `      ${entry.message}`);

  lines.push(
    result.ok ? "INTAKE PASSED" : "INTAKE FAILED — the uploads cannot be used as supplied",
  );
  lines.push(
    `  instruments ${result.summary.instrument_count}  ·  broker houses ${result.summary.house_count}  ·  export as_of ${result.summary.export_as_of ?? "—"}`,
  );

  if (result.errors.length > 0) {
    lines.push("", "MUST BE RE-SUPPLIED — no answer from you fixes these:");
    result.errors.forEach(push);
  }
  if (result.questions.length > 0) {
    lines.push("", "WILL BE ASKED AT STAGE 3 — one word each:");
    result.questions.forEach(push);
  }
  if (result.warnings.length > 0) {
    lines.push("", "PROCEEDING, PRINTED IN STATED ASSUMPTIONS:");
    result.warnings.forEach(push);
  }
  return lines.join("\n");
}

export default { runIntake, formatIntakeReport, normaliseHouseName, NODE_ID };
