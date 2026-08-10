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
  const declared = String(
    instrument?.instrument_type ?? instrument?.type ?? "",
  ).trim();
  if (declared) return declared;
  const known = CLASS_GENERIC_TYPE[String(instrument?.class ?? "").toLowerCase()];
  return known ?? "Debt instrument";
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
  let name = compactInstrumentName(instrument);

  // A reporting-currency carrying value may state its amount in the
  // reporting currency — "$80m" on a USD-reporting issuer is honest — but it
  // must never wear a FOREIGN currency prefix, which would read as native
  // nominal. Only the foreign-claim form is stripped.
  const amountToken = name.match(CURRENCY_AMOUNT_TOKEN);
  if (
    instrument?.balance_basis === "reporting_currency_carrying_value" &&
    amountToken
  ) {
    const symbolCurrency = amountToken[0].includes("€")
      ? "EUR"
      : amountToken[0].includes("£")
        ? "GBP"
        : amountToken[0].includes("$")
          ? "USD"
          : null;
    const tokenCurrency = (amountToken[1] ?? symbolCurrency ?? "").toUpperCase();
    const claimsForeign =
      tokenCurrency &&
      reportingCurrency &&
      tokenCurrency !== String(reportingCurrency).toUpperCase();
    if (claimsForeign) {
      name = name.replace(CURRENCY_AMOUNT_TOKEN, "").trim();
    }
  }

  // Verify, never reformat: an authored token that AGREES with the
  // structured field keeps its exact authored spelling (the authority
  // replay depends on byte-stable labels); only a token proved wrong by
  // the audited fields is replaced.
  const structuredPercent =
    ["floating", "unpriced"].includes(instrument?.rate_type)
      ? null
      : Number(instrument?.coupon_or_all_in_rate?.[0]) * 100;
  if (
    Number.isFinite(structuredPercent) &&
    structuredPercent !== 0 &&
    RATE_TOKEN.test(name)
  ) {
    const authoredPercent = parseAuthoredPercent(name.match(RATE_TOKEN)[0]);
    if (
      authoredPercent !== null &&
      Math.abs(authoredPercent - structuredPercent) > 0.0005
    ) {
      name = name.replace(
        RATE_TOKEN,
        formatRatePercentCorrection(instrument?.coupon_or_all_in_rate?.[0]),
      );
    }
  }

  const structuredMaturity = formatMaturity(instrument?.maturity_date);
  const maturityDateMatch = String(instrument?.maturity_date ?? "").match(
    /^(\d{4})-(\d{2})/,
  );
  if (structuredMaturity && maturityDateMatch && MATURITY_TOKEN.test(name)) {
    const authored = parseAuthoredMaturity(name.match(MATURITY_TOKEN)[0]);
    const structuredYear = Number(maturityDateMatch[1]);
    const structuredMonth = Number(maturityDateMatch[2]);
    const agrees =
      authored !== null &&
      authored.year === structuredYear &&
      (authored.month === null || authored.month === structuredMonth);
    // The machine-ordered "due 2027-03" spelling never appears in an
    // authority label; even when it agrees it normalises to the analyst
    // form. Every other agreeing spelling is preserved byte-for-byte.
    const machineOrdered = /due\s+\d{4}[-/]\d{1,2}/i.test(
      name.match(MATURITY_TOKEN)[0],
    );
    if (!agrees || machineOrdered) {
      name = name.replace(MATURITY_TOKEN, `due ${structuredMaturity}`);
    }
  }

  // The contract is TYPE + RATE + MATURITY, in that order. An appended rate
  // must therefore land BEFORE a bare trailing year the name already carries,
  // or an identifier-derived label reads "Senior notes 2030 4.35%".
  const trailingYear = name.match(/\s(\d{4})$/);
  if (trailingYear && !RATE_TOKEN.test(name) && !/\d\s*bps/i.test(name)) {
    name = name.slice(0, trailingYear.index).trim();
    const rate =
      instrument?.rate_type === "floating" && instrument?.benchmark
        ? Number(instrument.spread_bps ?? 0)
          ? `${instrument.benchmark}+${instrument.spread_bps}bps`
          : String(instrument.benchmark)
        : instrument?.rate_type === "unpriced"
          ? null
          : formatRatePercent(instrument?.coupon_or_all_in_rate?.[0]);
    name = [name, rate, trailingYear[1]].filter(Boolean).join(" ");
  }
  const parts = [name];
  const hasRate = RATE_TOKEN.test(name) || /\d\s*bps/i.test(name);
  if (!hasRate) {
    if (instrument?.rate_type === "unpriced") {
      // Pricing is deliberately absent and captured by the visible residual
      // interest bridge; never manufacture a 0% token in the instrument name.
    } else if (instrument?.rate_type === "floating" && instrument?.benchmark) {
      const spread = Number(instrument.spread_bps ?? 0);
      parts.push(
        spread
          ? `${instrument.benchmark}+${spread}bps`
          : String(instrument.benchmark),
      );
    } else {
      const rate = formatRatePercent(instrument?.coupon_or_all_in_rate?.[0]);
      if (rate) parts.push(rate);
    }
  }

  const maturityYear = instrument?.maturity_date
    ? String(instrument.maturity_date).slice(0, 4)
    : null;
  const maturityYearShort = maturityYear?.slice(-2);
  const hasMaturity =
    MATURITY_TOKEN.test(name) ||
    Boolean(maturityYear && name.includes(maturityYear)) ||
    Boolean(
      maturityYearShort &&
        new RegExp(`(?:^|\\D)\\d{1,2}[/-]${maturityYearShort}(?:\\D|$)`).test(
          name,
        ),
    );
  if (maturityYear && !hasMaturity) parts.push(maturityYear);
  return parts.join(" ");
}
