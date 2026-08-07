/**
 * Presentation-only instrument labels.
 *
 * The case retains the full sourced instrument name. The debt schedule already
 * gives currency, nominal amount and maturity their own term columns, so the
 * label may compact a universally understood facility phrase where the literal
 * wording would collide with those columns. No economic field is changed.
 */

function formatRatePercent(rate) {
  const percent = Number(rate) * 100;
  if (!Number.isFinite(percent) || percent === 0) return null;
  return `${percent
    .toFixed(3)
    .replace(/0+$/, "")
    .replace(/\.$/, "")}%`;
}

export function compactInstrumentName(instrument) {
  const source = String(
    instrument?.name ?? instrument?.instrument_id ?? "",
  ).trim();
  if (!source) return "Debt instrument";
  if (instrument?.class !== "rcf") return source;
  return source.replace(/\brevolving\s+credit\s+facilit(?:y|ies)\b/gi, "RCF");
}

// Debt-schedule label contract: TYPE + RATE + MATURITY, e.g.
// "Senior Notes 3.375% 2027". Most case files already carry that shape in
// `name`; anything missing the rate or the maturity year gets it appended so
// the schedule never shows a bare instrument type.
export function instrumentDisplayLabel(instrument) {
  const name = compactInstrumentName(instrument);
  const parts = [name];
  const hasRate = /\d\s*%/.test(name) || /\d\s*bps/i.test(name);
  if (!hasRate) {
    if (instrument?.rate_type === "floating" && instrument?.benchmark) {
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
