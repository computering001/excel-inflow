/**
 * The workbook's number-format ladder and compiled label vocabulary.
 *
 * Extracted verbatim from `build_dynamic_model.mjs` (decomposition slice 1):
 * these constants are what actually reaches `xl/styles.xml`, and
 * `assets/style-tokens.json` states the same ladder — the two are kept in step
 * deliberately. Pure data and pure functions only; nothing here closes over
 * build state.
 */

// THE NUMBER FORMAT LADDER. One format per class of content, every class
// named, and nothing left on a bare `0` or a raw `0.0000` that says only how
// many digits someone wanted. `assets/style-tokens.json` states this ladder;
// these constants are what actually reaches `xl/styles.xml`, and the two are
// kept in step deliberately.
//
// INVARIANT the zero section protects: a TRUE ZERO renders as an en-dash on a
// WHITE ground, an UNCALCULATED cell renders GREY. Those are the only two
// signals telling a reader which of the two they are looking at, so they must
// never converge — which is why every format that can hold a computed zero
// carries an explicit zero section, and why grey is a fill and never a format.
export const AMOUNT = '#,##0;(#,##0);"–"';
// A policy control must distinguish an intentional zero from an omitted value.
// Body cells keep the authority's dash-for-zero convention; the minimum-cash
// entry alone prints 0 so a reader can see that cash is deliberately allowed
// to run to zero before the RCF draws.
export const CONTROL_AMOUNT = '#,##0;(#,##0);0';
// THE MIDDLE TERM OF A + B = C STATES A MOVEMENT, NOT A LEVEL.
//
// N:P is the ADJUSTMENT block: what the transaction adds to the standalone case,
// column by column. It carried `AMOUNT`, the identical format the standalone
// block G:L and the pro-forma block R:U carry, so a figure in P was
// typographically indistinguishable from a figure in L — and the adjustment
// block read as a third complete statement standing beside the other two rather
// than as the delta between them. Three peers, none of them announcing that one
// of the three is the difference of the other two.
//
// An explicit leading `+` is what distinguishes a bridge column from a balance
// column, and it costs one character on the cells that actually move. Negatives
// keep the parentheses the rest of the model uses, so the pair reads `+1,100` /
// `(48)` and the sign is unmissable in both directions.
//
// THE ZERO SECTION IS DELIBERATELY UNCHANGED, and it is an en-dash rather than a
// blank. See `number_format_rules.zero_and_uncalculated_must_not_converge`: an
// en-dash on white says "this row genuinely does not move", an empty cell says
// "there is nothing here", and a grey fill says "this was never computed".
// Blanking a true zero would collapse the first into the second and destroy the
// distinction the whole format ladder exists to protect — a reader could no
// longer tell an unaffected row from an unpopulated one. The block is sparse
// because a dash is almost no ink, not because the cell is empty.
export const ADJUSTMENT_DELTA = '"+"#,##0;(#,##0);"–"';
export const PERCENT = '0.0%;(0.0%);"–"';
// A COUPON is a contractual all-in rate: quoted to the basis point and read to
// three decimals, because 4.125% and 4.13% are different bonds.
export const COUPON = "0.000%";
// A BENCHMARK or a SPREAD is quoted off a curve and two decimals is the market
// convention. Splitting the two apart is the reason `0.000%` — specified in the
// tokens since the beginning — was missing from every emitted file: one shared
// constant could only be one of them, and it was this one.
export const BENCHMARK = "0.00%";
export const MULTIPLE = '0.0x;(0.0x);"–"';
// A ratio whose denominator is zero (or not numeric) is NOT MEANINGFUL rather
// than zero. Printing `0.0x` over a zero EBITDA asserts a real multiple of
// nothing; the solver emits `net_leverage: null` for exactly that state
// (scripts/lib/solver.mjs:3568-3571), so the workbook degrades to a literal
// `n/m` token instead. Text ignores the number format ladder, which is what
// keeps n/m visibly distinct from a computed zero — the same reason the zero
// section above renders an en-dash rather than 0.
export const NOT_MEANINGFUL = '"n/m"';
// An FX rate is a price, not a percentage, and four decimals is the quoting
// convention. It used to ride a raw `0.0000`, which rendered an unpopulated
// pair as a meaningless `0.0000` — indistinguishable from a rate that really
// is zero-ish. The zero section puts it back on the ladder.
export const FX_RATE = '0.0000;(0.0000);"–"';
// A close year and a close month are date PARTS, not quantities: fixed width,
// never a thousands separator, never a decimal. They used to share a bare `0`
// with nothing to say what they were.
export const YEAR = "0000";
// The close month remains the integer consumed by DATE(). Excel custom number
// formats allow no more than four sections, so a twelve-condition Jan–Dec
// display is not a valid native format: Excel repairs /xl/styles.xml on open.
// The fixed-width numeric month is unambiguous beside the "Close month" label
// and preserves clean native-Excel custody.
export const MONTH = "00";
export const TOGGLE = '[=1]"On";[=0]"Off"';
// COLUMN C OF THE INTEREST SCHEDULE IS A CLOSED VOCABULARY, AND IT IS COMPILED.
//
// Nothing a case author writes reaches this column. `rate_type` is a three-value
// enum in the v2 schema and the commitment-fee row's entry is a literal in this
// file, so what the reader sees here is a rendering decision, not source text —
// which is the whole reason it is fixed HERE rather than by widening the column.
//
// `MANUAL_ALL_IN` was `rate_type.toUpperCase()`, an identifier shown to a human.
// At 56.26pt against 50.58pt of usable column it clipped on seven of the eight
// certification cases, and the underscore was never English in the first place.
// `COMMITMENT FEE` clipped harder — 62.26pt, 23% over — on all eight.
//
// Widening C is the alternative and it is a bad trade: C would have to go from
// 10 characters to 13 to hold `COMMITMENT FEE`, pushing D, E and the entire
// period grid right by 15.75pt on every case, to fit two strings this file
// chooses. Shortening them costs nothing and buys headroom: the widest thing
// column C now carries anywhere is `Eligible cash` at 39.55pt — which was
// always there and always fitted — against 50.58pt of usable width.
//
// `UNDRAWN` rather than `COMMITMENT`: the column answers "on what basis is the
// rate in column D struck", and for the fee that basis is the undrawn
// commitment. Column B on that row already reads "RCF commitment fee", so the
// word is not lost — it is the one thing the row does not need to say twice —
// and `COMMITMENT` would have fitted with 1.6pt to spare, which is not a fit.
// `RESIDUAL` rather than `PLUG`: the column answers "on what basis is the rate
// in column D struck", and for an unpriced instrument the honest answer is that
// no rate is struck at all — its cost is carried by the visible residual
// interest bridge below. "PLUG" is modelling slang that reads to an analyst as
// a fudge factor, which is the opposite of what the row is: a declared,
// reconciled residual. It is the same eight characters as `FLOATING`, so it
// fits the measured column C width unchanged.
export const RATE_TYPE_LABEL = {
  fixed: "FIXED",
  floating: "FLOATING",
  manual_all_in: "ALL-IN",
  unpriced: "RESIDUAL",
};
export const rateTypeLabel = (rateType) =>
  RATE_TYPE_LABEL[String(rateType)] ?? String(rateType).toUpperCase();
export const COMMITMENT_FEE_BASIS_LABEL = "UNDRAWN";
export const HISTORICAL_COLUMNS = ["G", "H", "I"];
export const FORECAST_COLUMNS = ["J", "K", "L"];
export const ADJUSTMENT_COLUMNS = ["N", "O", "P"];
export const PRO_FORMA_COLUMNS = ["S", "T", "U"];
