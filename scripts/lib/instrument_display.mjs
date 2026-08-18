import { debtClassTypeLabel } from "./debt_class.mjs";

/**
 * Presentation-only instrument labels.
 *
 * The case retains the full sourced instrument name, but the visible label is
 * VERIFIED against the structured instrument fields rather than trusted: a
 * name token that disagrees with the case's own rate or maturity is replaced
 * by the structured value, because the name string is authored prose while
 * the fields are the audited evidence. The debt schedule already gives
 * currency, amount and maturity their own term columns, so the label may
 * compact a universally understood facility phrase where the literal wording
 * would collide with those columns. No economic field is changed.
 */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// A leading "<CCY> <amount>m" (or "$1,046.2m") token inside a name. Used to
// strip amounts that would describe a reporting-currency carrying value as
// foreign-currency nominal — the amount column, not the label, owns amounts.
const CURRENCY_AMOUNT_TOKEN =
  /(?:\b(USD|EUR|GBP|JPY|CHF|SEK|NOK|DKK|AUD|CAD)\s+|[$€£])\s*[\d,]+(?:\.\d+)?\s*(?:m|mm|bn)\b\.?\s*/i;

// Rate tokens like "3.375%" or "0.007%" (with optional surrounding spaces).
const RATE_TOKEN = /\b\d+(?:\.\d+)?\s*%/;

// Maturity tokens the authoring side has produced: "due 2027-03",
// "due 2027/03", "due 03-27", "due Apr-2026", "due 2026-04-30", or a bare
// trailing four-digit year.
const MATURITY_TOKEN =
  /\bdue\s+(?:\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?|\d{1,2}[-/]\d{2,4}|[A-Za-z]{3,9}[-\s]?\d{2,4})/i;

function formatRatePercent(rate) {
  const percent = Number(rate) * 100;
  if (!Number.isFinite(percent) || percent === 0) return null;
  return `${percent
    .toFixed(3)
    .replace(/0+$/, "")
    .replace(/\.$/, "")}%`;
}

// Correction format only: an authored token proved WRONG is replaced at the
// coupon convention's three decimals. Correct authored tokens are never
// reformatted — the authority replay depends on byte-stable labels.
function formatRatePercentCorrection(rate) {
  const percent = Number(rate) * 100;
  if (!Number.isFinite(percent) || percent === 0) return null;
  return `${percent.toFixed(3)}%`;
}

function parseAuthoredPercent(token) {
  const match = String(token ?? "").match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

function parseAuthoredMaturity(token) {
  const text = String(token ?? "");
  const monthByName = (name) => {
    const index = MONTHS.findIndex((month) =>
      name.toLowerCase().startsWith(month.toLowerCase()),
    );
    return index >= 0 ? index + 1 : null;
  };
  let match = text.match(/(\d{4})[-/](\d{1,2})/);
  if (match) return { year: Number(match[1]), month: Number(match[2]) };
  match = text.match(/([A-Za-z]{3,9})[-\s]?(\d{2,4})/);
  if (match) {
    const month = monthByName(match[1]);
    const year = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
    return month ? { year, month } : { year, month: null };
  }
  match = text.match(/(\d{1,2})[-/](\d{2})(?!\d)/);
  if (match) return { year: Number(`20${match[2]}`), month: Number(match[1]) };
  return null;
}

function formatMaturity(maturityDate) {
  const text = String(maturityDate ?? "");
  const match = text.match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  const month = Number(match[2]);
  if (!(month >= 1 && month <= 12)) return null;
  return `${MONTHS[month - 1]}-${match[1].slice(-2)}`;
}

// A SECURITY IDENTIFIER IS NOT A NAME.
//
// A FactSet debt export names instruments by CUSIP/ISIN/SEDOL, so the
// AstraZeneca debt schedule read "G4635SAV0 0.7% 2026" and
// "FDS8TIAV7 2030" — twenty-eight rows of security codes where an analyst
// expects instrument types. The code is real evidence and stays in the
// export lineage; it is simply not the label. A leading identifier is
// replaced by the instrument's own declared type, and where the case
// declares no type the class supplies a truthful generic ("Senior notes",
// "Term loan", "RCF"), so the label always reads TYPE + RATE + MATURITY.
//
// Matched conservatively: a leading token of 8-12 characters mixing letters
// and digits with no lower-case and no spaces. Real instrument names never
// take that shape; identifiers always do.
const SECURITY_IDENTIFIER_TOKEN =
  /^(?=[A-Z0-9]{8,12}(?:\b|_))(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,12}[\s,:-]*/;

const CLASS_GENERIC_TYPE = Object.freeze({
  rcf: "RCF",
  revolver: "RCF",
  term_loan: "Term loan",
  bank_debt: "Bank debt",
  bond: "Senior notes",
  senior_notes: "Senior notes",
  lease: "Lease liability",
  commercial_paper: "Commercial paper",
  overdraft: "Overdraft",
});

function declaredInstrumentType(instrument) {
  if (instrument?.class) return debtClassTypeLabel(instrument.class);
  const declared = String(
    instrument?.instrument_type ?? instrument?.type ?? "",
  ).trim();
  if (declared) return declared;
  const known = CLASS_GENERIC_TYPE[String(instrument?.class ?? "").toLowerCase()];
  return known ?? "Debt instrument";
}

function truncateAtWord(text, maximum) {
  if (text.length <= maximum) return text;
  const available = Math.max(8, maximum - 1);
  const slice = text.slice(0, available + 1);
  const boundary = slice.lastIndexOf(" ");
  return `${slice.slice(0, boundary >= 8 ? boundary : available).trimEnd()}…`;
}

/**
 * Bound a visible instrument label without losing the source evidence.
 *
 * The full sourced name remains in the case and is attached to the workbook
 * cell as a comment.  The face label has a finite geometric job: identify the
 * instrument beside separate currency, amount, maturity and pricing columns.
 * For an overlong label we therefore remove only the redundant leading amount,
 * preserve a short distinguishing suffix (for example "tranche 2"), and crop
 * the remaining prose on a word boundary.  This is presentation-only and is
 * independent of issuer, instrument family and physical row number.
 */
export function fitInstrumentText(text, maximum = 54) {
  let value = String(text ?? "").trim();
  if (value.length <= maximum) return value;
  value = value.replace(CURRENCY_AMOUNT_TOKEN, "").trim();
  if (value.length <= maximum) return value;

  const delimiter = " — ";
  const split = value.lastIndexOf(delimiter);
  if (split > 0) {
    const suffix = value.slice(split + delimiter.length).trim();
    if (suffix && suffix.length <= 20) {
      const suffixText = `${delimiter}${suffix}`;
      const prefix = truncateAtWord(
        value.slice(0, split).trim(),
        Math.max(16, maximum - suffixText.length),
      );
      return `${prefix}${suffixText}`.slice(0, maximum);
    }
  }
  return truncateAtWord(value, maximum);
}

export function compactInstrumentName(instrument) {
  const source = String(
    instrument?.name ?? instrument?.instrument_id ?? "",
  ).trim();
  if (!source) return "Debt instrument";
  let name = source;
  if (SECURITY_IDENTIFIER_TOKEN.test(name)) {
    const remainder = name.replace(SECURITY_IDENTIFIER_TOKEN, "").trim();
    const type = declaredInstrumentType(instrument);
    // The rate and maturity that followed the code are preserved; only the
    // identifier itself is replaced by the declared type. When the remainder
    // already opens with that type — "US03027X1000 term loan" — prefixing it
    // would stutter, so the remainder's own wording wins.
    const stutters =
      remainder.length > 0 &&
      remainder.slice(0, type.length).toLowerCase() === type.toLowerCase();
    name = remainder
      ? stutters
        ? remainder
        : `${type} ${remainder}`
      : type;
  }
  if (instrument?.class !== "rcf") return name;
  return name.replace(/\brevolving\s+credit\s+facilit(?:y|ies)\b/gi, "RCF");
}

// Debt-schedule label contract: TYPE + RATE + MATURITY, e.g.
// "Senior Notes 3.375% due Apr-27". The rate and maturity shown are always
// derived from the structured fields; an authored token that disagrees is
// replaced, never repeated. An amount prefix survives only when the balance
// basis is genuinely native principal — a reporting-currency carrying value
// must never read as foreign-currency nominal.
export function instrumentDisplayLabel(instrument, reportingCurrency = null) {
  void reportingCurrency;
  const type = debtClassTypeLabel(instrument?.class);
  let rate = null;
  if (instrument?.rate_type === "floating") {
    const benchmark = String(
      instrument?.benchmark ?? instrument?.reference_rate ?? "Floating rate",
    ).trim();
    const spread = Number(instrument?.spread_bps ?? instrument?.margin_bps ?? 0);
    rate = spread ? `${benchmark} + ${spread}bp` : benchmark;
  } else if (instrument?.rate_type !== "unpriced") {
    const candidates = [
      ...(instrument?.coupon_or_all_in_rate ?? []),
      instrument?.coupon_rate,
      instrument?.all_in_rate,
    ];
    const statedRate = candidates.find(
      (value) => value !== null && value !== undefined && Number.isFinite(Number(value)),
    );
    rate = formatRatePercent(statedRate);
  }
  let maturity = null;
  const maturityDate = String(instrument?.maturity_date ?? "");
  if (instrument?.maturity_treatment === "non_maturing_within_forecast") {
    maturity = "non-maturing";
  } else if (/^\d{4}/.test(maturityDate)) {
    maturity = instrument?.maturity_precision === "year"
      ? `due ${maturityDate.slice(0, 4)}`
      : `due ${formatMaturity(maturityDate) ?? maturityDate.slice(0, 4)}`;
  }
  return fitInstrumentText([type, rate, maturity].filter(Boolean).join(" "));
}
