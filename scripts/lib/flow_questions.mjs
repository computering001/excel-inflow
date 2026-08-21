// Stage 3 — the only stop.
//
// This module decides what gets asked. It does not render anything and it does
// not build anything; it turns an intake bundle plus the draft case into either
// a list of at most five questions, a list of stated assumptions, or the message
// that says the inputs are wrong.
//
// The five rules from USER-FLOW-20260726.md, and where each one lives:
//
//   1. THE BAR. A question qualifies only if the model cannot resolve it from
//      its sources AND the two plausible answers produce materially different
//      output. Both halves are mechanical here. "Cannot resolve" is the detector
//      firing: every detector fires on a field the sources left null and stays
//      silent when the sources settle it. "Materially different" is measured, in
//      `flow_impact.differentialImpact` — the case is solved twice, once under
//      each answer, and the headline series are differenced against the declared
//      thresholds in MATERIALITY_POLICY. Anything that fails either half becomes
//      a stated assumption printed at the end, never a question.
//
//   2. COMPANY LANGUAGE. Enforced, not trusted: `lintQuestion` rejects a prompt
//      containing a snake_case identifier or any instrument_id from the case.
//
//   3. CONSEQUENCE IN MONEY. Generated from the differential solve. If no
//      headline metric clears its threshold there is no money to state, and the
//      question is not asked — rule 3 and rule 1 are the same rule seen twice.
//
//   4. FIVE QUESTION CARDS PER ROUND, reached by pruning and deterministic
//      batching. A complex issuer may legitimately need another round; the
//      card cap is a presentation constraint, never evidence that the upload
//      is defective.
//
//   5. ONE-WORD ANSWERS. Enforced: exactly two options, each a single lowercase
//      token, checked by `lintQuestion`.
//
// ── G6, the decision graph ─────────────────────────────────────────────────
//
// Questions are not independent. If a facility is uncommitted, whether the
// commercial paper draws on it is moot. If notes are refinanced at maturity,
// their call date is moot. Each detected ambiguity therefore declares its
// parents and the parent answers that make it moot.
//
// Pruning has two forms, and the difference matters:
//
//   MOOT — the parent is already resolved (defaulted below the bar, or settled
//     by the reconciliation stop) with an answer that makes this child
//     irrelevant. The child is dropped entirely. It is not an assumption,
//     because there is nothing left to assume.
//
//   DEFERRED — the parent is itself being asked. The flow has one stop, so the
//     child cannot be asked in the same breath as a parent whose answer may
//     delete it. It is held back, and once the answers come in it is either moot
//     or falls to its default as a stated assumption.
//
// Only roots of the surviving graph are asked. The first five form one sealed
// round; subsequent roots remain pending and are replanned after those answers
// are recorded. Nothing is discarded, defaulted or relabelled as missing
// evidence merely because the company has more than five real decisions.

import {
  compileImpactGraph,
  consequenceOf,
  crossCheckReachability,
  deepClone,
  differentialImpact,
  HEADLINE_METRICS,
  MATERIALITY_POLICY,
} from "./flow_impact.mjs";
import {
  forecastRowMateriality,
  resolveForecastAuthority,
} from "./forecast_authority.mjs";
import {
  exportInstruments,
  outstandingAmount,
} from "./flow_reconcile.mjs";
import { formatMoney, formatTurns } from "./flow_screens.mjs";
import { plausibilityFindingIds } from "./plausibility_acknowledgements.mjs";
import { normalisedCashBuckets, solveCase } from "./solver.mjs";

export const QUESTION_LIMIT = 5;

// ── one vocabulary ─────────────────────────────────────────────────────────
//
// The detectors below read `assets/dcs-export.schema.json`'s own names —
// `instruments`, `outstanding_amount`, `next_call_date`, `facility_limit`,
// `instrument_type`, `margin_bps`, `reference_rate`. There is no adapter and no
// second internal shape. Two names for one field is two places for a rename to
// be missed, and a detector reading the name the export does NOT use fires on
// `undefined` — which is indistinguishable, here, from the export genuinely
// leaving the field unresolved. That failure mode manufactures questions out of
// a spelling mistake, which is exactly what the cap of five cannot absorb.
//
// The two things the adapter did that were not renames are still done, by name,
// in flow_reconcile.mjs: `outstandingAmount` (a revolver contributes its drawn
// amount, not its limit) and `includedInGrossDebt` (the debt_classification
// override).

/** Facility size. `facility_limit` is the export's name for it. */
function facilityLimit(row) {
  return Number(row?.facility_limit ?? 0);
}

function yearOf(date) {
  return date ? String(date).slice(0, 4) : null;
}

function instrumentOf(modelCase, instrumentId) {
  return (modelCase.instruments ?? []).find(
    (instrument) => instrument.instrument_id === instrumentId,
  );
}

function applyFacilityCommitment(modelCase, row, committed) {
  if (committed) return modelCase;
  const capacity = facilityLimit(row);
  // Uncommitted capacity is not liquidity. Keep the aggregate RCF policy and
  // the model-driving facility in lockstep; a stated source value must have the
  // same economics as the equivalent stage-3 answer.
  if (modelCase.rcf_policy) {
    modelCase.rcf_policy.capacity = Math.max(
      0,
      Number(modelCase.rcf_policy.capacity) - capacity,
    );
    const revolver = instrumentOf(
      modelCase,
      modelCase.rcf_policy.instrument_id,
    );
    if (revolver) revolver.facility_capacity = modelCase.rcf_policy.capacity;
  }
  const instrument = instrumentOf(modelCase, row.instrument_id);
  if (instrument && instrument.class !== "rcf") {
    instrument.facility_capacity = 0;
  }
  return modelCase;
}

function applyCommercialPaperBackstop(modelCase, backstopped) {
  // Backstop eligibility changes liquidity, never the instrument's economic
  // class. Commercial paper remains commercial paper in either answer.
  if (!backstopped && modelCase.rcf_policy) {
    modelCase.rcf_policy.commercial_paper_backstopped = false;
  } else if (backstopped && modelCase.rcf_policy) {
    modelCase.rcf_policy.commercial_paper_backstopped = true;
  }
  return modelCase;
}

export function applyRefinancingIntent(modelCase, row, intent) {
  const instrument = instrumentOf(modelCase, row.instrument_id);
  if (!instrument) return modelCase;
  const normalised = String(intent ?? "").toLowerCase();
  if (normalised === "refinanced") {
    const maturityYear = yearOf(row.maturity_date);
    instrument.maturity_treatment = "non_maturing_within_forecast";
    instrument.maturity_date = null;
    instrument.assumption_note = `Refinanced at its ${maturityYear} maturity and carried across the forecast, per source-backed refinancing intent.`;
  } else if (normalised === "repaid") {
    instrument.maturity_treatment = "contractual";
  }
  return modelCase;
}

/**
 * Apply decisions that the source evidence has already settled.
 *
 * A populated DCS field must not merely suppress its corresponding question:
 * it must drive exactly the same case mutation as that question's answer. This
 * function is deliberately small and semantic; it knows instrument IDs and
 * declared policy fields, never workbook rows or issuer names.
 */
export function applyExplicitSourcePolicies({ modelCase, intake }) {
  let next = modelCase;
  const applied = new Map();
  for (const row of exportInstruments(intake)) {
    if (row.committed === true || row.committed === false) {
      next = applyFacilityCommitment(next, row, row.committed);
      applied.set(
        `facility_commitment:${row.instrument_id}`,
        row.committed ? "yes" : "no",
      );
    }
    if (
      row.is_backstop_for_paper === true ||
      row.is_backstop_for_paper === false
    ) {
      next = applyCommercialPaperBackstop(
        next,
        row.is_backstop_for_paper,
      );
      applied.set(
        `commercial_paper_backstop:${row.instrument_id}`,
        row.is_backstop_for_paper ? "yes" : "no",
      );
    }
    const intent = String(row.refinancing_intent ?? "").toLowerCase();
    if (intent === "refinanced" || intent === "repaid") {
      next = applyRefinancingIntent(next, row, intent);
      applied.set(`refinance_at_maturity:${row.instrument_id}`, intent);
    }
  }
  return { modelCase: next, applied };
}

function forecastYears(modelCase) {
  return (modelCase.periods ?? [])
    .filter((period) => period.status === "forecast")
    .map((period) => Number(String(period.date).slice(0, 4)));
}

function series3(value) {
  return [value, value, value];
}

// ── the registry ───────────────────────────────────────────────────────────
//
// Every kind declares: how it is detected (only from a field the sources left
// unresolved), the two answers, how each answer changes the case, which answer
// is taken when the question is not asked, the sentence printed when it is
// defaulted, the G2 seeds used for the reachability cross-check, and which
// parents make it moot.
//
// Adding a kind here is the only way to add a question. There is no path by
// which a build invents one.

const KINDS = [
  {
    kind: "facility_commitment",
    detect(context) {
      const { intake } = context;
      return exportInstruments(intake)
        .filter(
          (row) =>
            facilityLimit(row) > 0 &&
            (row.committed === null || row.committed === undefined),
        )
        .map((row) => {
          const capacity = facilityLimit(row);
          const money = formatMoney(capacity, row.currency);
          const maturity = yearOf(row.maturity_date);
          return {
            id: `facility_commitment:${row.instrument_id}`,
            kind: "facility_commitment",
            subject_line: `${money} facility${maturity ? ` maturing ${maturity}` : ""} — commitment not stated in the export`,
            prompt: `Is the ${money} facility${maturity ? ` maturing ${maturity}` : ""} committed?`,
            context_line: "Your export doesn't say.",
            other_phrase: "it isn't",
            seeds: ["mechanical.undrawn_rcf", "mechanical.ending_rcf"],
            options: [
              {
                id: "yes",
                word: "yes",
                apply: (modelCase) => modelCase,
              },
              {
                id: "no",
                word: "no",
                apply: (modelCase) =>
                  applyFacilityCommitment(modelCase, row, false),
              },
            ],
            // A facility carried in a DCS debt export with a stated capacity is
            // ordinarily committed; the uncommitted ones are the exception. So
            // the default counts it, and the question exists to catch the
            // exception. Defaulting the other way would silently delete real
            // headroom from every export whose commitment column is blank,
            // which is the larger and quieter error.
            default_option: "yes",
            assumption: (option) =>
              option === "no"
                ? `The ${money} facility is treated as uncommitted and excluded from liquidity. The export did not state its commitment status.`
                : `The ${money} facility is treated as committed and counted in liquidity.`,
          };
        });
    },
  },

  {
    kind: "commercial_paper_backstop",
    detect(context) {
      const { intake } = context;
      const rows = exportInstruments(intake);
      const paper = rows.filter(
        (row) => row.instrument_type === "commercial_paper",
      );
      if (paper.length === 0) return [];
      const outstanding = paper.reduce(
        (total, row) => total + outstandingAmount(row),
        0,
      );
      if (outstanding <= 0) return [];
      return rows
        .filter(
          (row) =>
            facilityLimit(row) > 0 &&
            (row.is_backstop_for_paper === null ||
              row.is_backstop_for_paper === undefined),
        )
        .map((row) => {
          const capacity = facilityLimit(row);
          const facilityMoney = formatMoney(capacity, row.currency);
          const paperMoney = formatMoney(outstanding, paper[0].currency);
          return {
            id: `commercial_paper_backstop:${row.instrument_id}`,
            kind: "commercial_paper_backstop",
            subject_line: `whether the ${paperMoney} of commercial paper is backstopped by the ${facilityMoney} facility`,
            prompt: `Is the ${paperMoney} of commercial paper backstopped by the ${facilityMoney} facility?`,
            context_line:
              "If it is, the same capacity cannot be counted twice.",
            other_phrase: "it isn't",
            seeds: ["mechanical.drawn_commercial_paper"],
            options: [
              { id: "yes", word: "yes", apply: (modelCase) => modelCase },
              {
                id: "no",
                word: "no",
                apply: (modelCase) =>
                  applyCommercialPaperBackstop(modelCase, false),
              },
            ],
            default_option: "yes",
            assumption: (option) =>
              option === "yes"
                ? `The ${paperMoney} of commercial paper is netted against the facility in liquidity, on the basis that the facility backstops the programme.`
                : `The ${paperMoney} of commercial paper is treated as standalone borrowing and is not netted against facility capacity.`,
            parents: [
              {
                parent_id: `facility_commitment:${row.instrument_id}`,
                moot_when: ["no"],
                reason: `the ${facilityMoney} facility is not committed, so nothing can be backstopped by it`,
              },
            ],
          };
        });
    },
  },

  {
    kind: "refinance_at_maturity",
    detect(context) {
      const { intake, draftCase } = context;
      // Contractual maturity treatment is an execution toggle on the model,
      // not an intake ambiguity.  Source-backed refinancing still overrides
      // the default through applyExplicitSourcePolicies, but absent/ask/
      // unclear/unknown evidence must never create one question per bond.
      if (draftCase?.controls?.debt_maturities_roll !== undefined) return [];
      const years = forecastYears(draftCase);
      const lastYear = years[years.length - 1];
      return exportInstruments(intake)
        .filter((row) => {
          const maturityYear = Number(yearOf(row.maturity_date));
          return (
            Number.isFinite(maturityYear) &&
            maturityYear <= lastYear &&
            maturityYear >= years[0] &&
            (row.refinancing_intent === null ||
              row.refinancing_intent === undefined ||
              ["ask", "unclear", "unknown"].includes(
                String(row.refinancing_intent).toLowerCase(),
              )) &&
            outstandingAmount(row) > 0
          );
        })
        .map((row) => {
          const money = formatMoney(outstandingAmount(row), row.currency);
          const maturityYear = yearOf(row.maturity_date);
          const noun = describeRow(row);
          return {
            id: `refinance_at_maturity:${row.instrument_id}`,
            kind: "refinance_at_maturity",
            subject_line: `whether the ${money} ${noun} maturing ${maturityYear} is refinanced or repaid`,
            prompt: `The ${money} ${noun} matures in ${maturityYear}. Refinanced, or repaid from cash?`,
            context_line: null,
            seeds: [`instrument.${row.instrument_id}.balance`],
            options: [
              {
                id: "refinanced",
                word: "refinanced",
                apply: (modelCase) =>
                  applyRefinancingIntent(modelCase, row, "refinanced"),
              },
              {
                id: "repaid",
                word: "repaid",
                apply: (modelCase) =>
                  applyRefinancingIntent(modelCase, row, "repaid"),
              },
            ],
            // Contractual terms are what the filings evidence. A refinancing
            // nobody has announced is an invention.
            default_option: "repaid",
            assumption: (option) =>
              option === "repaid"
                ? `The ${money} ${noun} is repaid at its ${maturityYear} contractual maturity. No refinancing was disclosed, and none is assumed.`
                : `The ${money} ${noun} is assumed refinanced at its ${maturityYear} maturity and carried across the forecast.`,
          };
        });
    },
  },

  {
    kind: "call_date",
    detect(context) {
      const { intake } = context;
      return exportInstruments(intake)
        .filter(
          (row) =>
            row.next_call_date &&
            row.maturity_date &&
            String(row.next_call_date) < String(row.maturity_date),
        )
        .map((row) => {
          const money = formatMoney(outstandingAmount(row), row.currency);
          const callYear = yearOf(row.next_call_date);
          const maturityYear = yearOf(row.maturity_date);
          const noun = describeRow(row);
          return {
            id: `call_date:${row.instrument_id}`,
            kind: "call_date",
            subject_line: `whether the ${money} ${noun} is called in ${callYear} or held to ${maturityYear}`,
            prompt: `The ${money} ${noun} matures ${maturityYear} but is callable ${callYear}. Should I use the ${callYear} call date?`,
            context_line: null,
            other_phrase: "I do",
            seeds: [`instrument.${row.instrument_id}.balance`],
            options: [
              {
                id: "yes",
                word: "yes",
                apply: (modelCase) => {
                  const instrument = instrumentOf(modelCase, row.instrument_id);
                  if (instrument) {
                    instrument.maturity_date = row.next_call_date;
                    instrument.maturity_treatment = "contractual";
                  }
                  return modelCase;
                },
              },
              { id: "no", word: "no", apply: (modelCase) => modelCase },
            ],
            default_option: "no",
            assumption: (option) =>
              option === "no"
                ? `The ${money} ${noun} is held to its ${maturityYear} legal maturity. The ${callYear} call is disclosed but not assumed exercised.`
                : `The ${money} ${noun} is assumed called at the first call date in ${callYear}.`,
            parents: [
              {
                parent_id: `refinance_at_maturity:${row.instrument_id}`,
                moot_when: ["refinanced"],
                reason:
                  "the notes are refinanced rather than repaid, so no repayment date is used",
              },
            ],
          };
        });
    },
  },

  {
    kind: "trapped_cash",
    detect(context) {
      const { intake, draftCase } = context;
      const restricted = intake.filings?.restricted_cash;
      if (!restricted || !Number(restricted.amount)) return [];
      if (
        restricted.available_to_repay_debt !== null &&
        restricted.available_to_repay_debt !== undefined
      ) {
        return [];
      }
      const currency = draftCase.issuer?.reporting_currency;
      const money = formatMoney(restricted.amount, currency);
      const where = restricted.jurisdiction ?? "restricted jurisdictions";
      const openingCash = Number(draftCase.cash_policy?.opening_cash ?? 0);
      return [
        {
          id: "trapped_cash",
          kind: "trapped_cash",
          subject_line: `whether the ${money} held in ${where} is available to repay debt`,
          prompt: `Is the ${money} of cash held in ${where} available to repay debt?`,
          context_line: "The accounts disclose it but do not say.",
          // The eligible-cash percentage scales interest income as well as net
          // debt, so it reaches the cash waterfall too. The reachability
          // cross-check is what surfaced the second edge.
          seeds: [
            "mechanical.cash_for_net_debt",
            "mechanical.interest_income_schedule",
          ],
          options: [
            { id: "yes", word: "yes", apply: (modelCase) => modelCase },
            {
              id: "no",
              word: "no",
              apply: (modelCase) => {
                const share =
                  openingCash > 0
                    ? Math.max(
                        0,
                        Math.min(
                          1,
                          (openingCash - Number(restricted.amount)) /
                            openingCash,
                        ),
                      )
                    : 1;
                modelCase.cash_policy.eligible_cash_percentage = share;
                return modelCase;
              },
            },
          ],
          default_option: "yes",
          assumption: (option) =>
            option === "yes"
              ? `All cash is treated as available for net debt, including the ${money} held in ${where}.`
              : `The ${money} held in ${where} is excluded from net debt, applied as a constant share of the cash balance across the forecast.`,
        },
      ];
    },
  },

  {
    kind: "lease_in_leverage",
    detect(context) {
      const { intake, draftCase } = context;
      // A typed model control is already an answered policy decision. Asking
      // the user to restate it makes a resumable run stop on a question whose
      // economic mutation has already been applied.
      if (typeof draftCase.lease_policy?.include_in_leverage === "boolean") {
        return [];
      }
      if (
        intake.filings?.leverage_basis !== null &&
        intake.filings?.leverage_basis !== undefined
      ) {
        return [];
      }
      const leases = Array.isArray(draftCase.lease_policy?.historical_liabilities)
        ? Number(
            draftCase.lease_policy.historical_liabilities[
              draftCase.lease_policy.historical_liabilities.length - 1
            ],
          )
        : Number(draftCase.lease_policy?.opening_liability ?? 0);
      if (!(leases > 0)) return [];
      const money = formatMoney(leases, draftCase.issuer?.reporting_currency);
      return [
        {
          id: "lease_in_leverage",
          kind: "lease_in_leverage",
          subject_line: `whether the company's leverage measure includes ${money} of lease liabilities`,
          prompt: `Does the company's own leverage measure include the ${money} of lease liabilities?`,
          context_line: "The accounts quote a ratio but not its basis.",
          other_phrase: "it doesn't",
          seeds: ["mechanical.total_lease_liabilities"],
          options: [
            { id: "yes", word: "yes", apply: (modelCase) => modelCase },
            {
              id: "no",
              word: "no",
              apply: (modelCase) => {
                modelCase.lease_policy.include_in_leverage = false;
                return modelCase;
              },
            },
          ],
          default_option: "yes",
          assumption: (option) =>
            option === "yes"
              ? `Leverage is stated including ${money} of lease liabilities, the reported balance-sheet basis.`
              : `Leverage is stated excluding lease liabilities, and the ${money} lease balance is shown separately.`,
        },
      ];
    },
  },

  {
    kind: "minimum_cash_floor",
    detect(context) {
      const { intake, draftCase } = context;
      if (
        Object.prototype.hasOwnProperty.call(
          draftCase.cash_policy ?? {},
          "minimum_cash_override",
        )
      ) {
        return [];
      }
      if (
        intake.filings?.minimum_operating_cash !== null &&
        intake.filings?.minimum_operating_cash !== undefined
      ) {
        return [];
      }
      const declaredFloor = draftCase.cash_policy?.minimum_cash_override;
      const balancingBucket = normalisedCashBuckets(draftCase).find(
        (bucket) => bucket.forecast_treatment === "balancing",
      );
      const floor = Number(
        declaredFloor ??
          Math.min(...(balancingBucket?.historical_year_end ?? [0, 0, 0])),
      );
      if (!(floor > 0)) return [];
      const money = formatMoney(floor, draftCase.issuer?.reporting_currency);
      return [
        {
          id: "minimum_cash_floor",
          kind: "minimum_cash_floor",
          subject_line: `the ${money} operating cash floor, which the filings do not state`,
          prompt: `Should I hold a ${money} operating cash floor, or let cash run to zero before drawing?`,
          context_line: null,
          other_phrase: "cash can run to zero",
          seeds: ["mechanical.minimum_cash"],
          options: [
            {
              id: "floor",
              word: "floor",
              apply: (modelCase) => {
                // Persist the selected policy as a case fact.  Leaving it as an
                // implicit compiler fallback made the same run display a floor
                // without any saved answer proving where it came from.
                modelCase.cash_policy.minimum_cash_override = floor;
                return modelCase;
              },
            },
            {
              id: "zero",
              word: "zero",
              apply: (modelCase) => {
                modelCase.cash_policy.minimum_cash_override = 0;
                return modelCase;
              },
            },
          ],
          default_option: "floor",
          assumption: (option) =>
            option === "floor"
              ? `A ${money} operating cash floor is held before the revolver is repaid. The filings do not disclose a target, so this is the working-capital balance implied by the last three years.`
              : `No operating cash floor is held; surplus cash repays the revolver in full.`,
        },
      ];
    },
  },

  {
    kind: "floating_rate_basis",
    detect(context) {
      const { intake } = context;
      return exportInstruments(intake)
        .filter(
          (row) =>
            row.rate_type === "floating" &&
            Number(row.margin_bps ?? 0) > 0 &&
            // `benchmark_curve.resolved` is what settles the basis. A curve
            // block carrying only spot and forward states the two branches
            // without choosing between them, which is still an ambiguity.
            !Array.isArray(row.benchmark_curve?.resolved) &&
            row.reference_rate,
        )
        .map((row) => {
          const money = formatMoney(outstandingAmount(row), row.currency);
          const noun = describeRow(row);
          const spot = Number(row.benchmark_curve?.spot ?? 0);
          const forward = Array.isArray(row.benchmark_curve?.forward)
            ? row.benchmark_curve.forward.map(Number)
            : series3(spot);
          const spotText = `${(spot * 100).toFixed(1)}%`;
          return {
            id: `floating_rate_basis:${row.instrument_id}`,
            kind: "floating_rate_basis",
            subject_line: `whether the ${money} ${noun} is priced off spot ${row.reference_rate} or the forward curve`,
            prompt: `The ${money} ${noun} is priced at ${row.reference_rate} plus ${row.margin_bps}bp. Hold ${row.reference_rate} at today's ${spotText}, or use the forward curve?`,
            context_line: null,
            other_phrase: "I hold the rate where it is today",
            seeds: [`instrument.${row.instrument_id}.interest`],
            options: [
              {
                id: "today",
                word: "today",
                apply: (modelCase) => {
                  const instrument = instrumentOf(modelCase, row.instrument_id);
                  if (instrument) instrument.benchmark_rate = series3(spot);
                  return modelCase;
                },
              },
              {
                id: "forward",
                word: "forward",
                apply: (modelCase) => {
                  const instrument = instrumentOf(modelCase, row.instrument_id);
                  if (instrument) instrument.benchmark_rate = forward;
                  return modelCase;
                },
              },
            ],
            default_option: "forward",
            assumption: (option) =>
              option === "forward"
                ? `The ${money} ${noun} is priced off the ${row.reference_rate} forward curve. The export gave the spread but no settled curve.`
                : `The ${money} ${noun} is priced off ${row.reference_rate} held flat at today's ${spotText}.`,
          };
        });
    },
  },

  {
    kind: "acquisition_funding",
    detect(context) {
      const { intake, draftCase } = context;
      const deal = intake.filings?.announced_acquisition;
      if (!deal || !Number(deal.consideration)) return [];
      if (deal.funding !== null && deal.funding !== undefined) return [];
      const money = formatMoney(
        deal.consideration,
        draftCase.issuer?.reporting_currency,
      );
      return [
        {
          id: "acquisition_funding",
          kind: "acquisition_funding",
          subject_line: `how the announced ${money} acquisition of ${deal.target} is funded`,
          prompt: `Is the announced ${money} acquisition of ${deal.target} funded with debt or equity?`,
          context_line: "The announcement does not say.",
          seeds: ["mechanical.acquisition_debt"],
          options: [
            {
              id: "debt",
              word: "debt",
              apply: (modelCase) => {
                modelCase.acquisition = {
                  ...(modelCase.acquisition ?? {}),
                  enabled: 1,
                  acquisition_debt_amount: Number(deal.consideration),
                };
                return modelCase;
              },
            },
            {
              id: "equity",
              word: "equity",
              apply: (modelCase) => {
                // An equity-funded deal raises no debt, and the case contract
                // will not accept an enabled acquisition sized at zero, so the
                // block is switched off rather than emptied.
                modelCase.acquisition = {
                  ...(modelCase.acquisition ?? {}),
                  enabled: 0,
                  acquisition_debt_amount: 0,
                };
                return modelCase;
              },
            },
          ],
          default_option: "debt",
          assumption: (option) =>
            option === "debt"
              ? `The ${money} acquisition of ${deal.target} is funded entirely with debt. No equity issuance was announced.`
              : `The ${money} acquisition of ${deal.target} is funded with equity and adds no debt.`,
        },
      ];
    },
  },

];

function describeRow(row) {
  // Keyed on the export's `instrument_type`, whose enum is deliberately
  // identical to model-case-v2's instrument.class.
  const byType = {
    bond_fixed: "fixed-rate notes",
    bond_floating: "floating-rate notes",
    term_loan_fixed: "fixed-rate term loan",
    term_loan_floating: "floating-rate term loan",
    commercial_paper: "commercial paper",
    securitisation: "securitisation",
    rcf: "facility",
    lease_liability: "lease liability",
    overdraft: "overdraft",
    other_explicit: "other borrowings",
    unclassified: "unclassified borrowing",
  };
  return byType[row.instrument_type] ?? "borrowings";
}

// ── assumption topics: the forecast plan's own defaults, as cards ──────────
//
// Stage 3 used to end at the debt-side decision graph. Everything the
// FORECAST side would assume on the user's behalf was printed afterwards on
// the material forecast plan receipt, where reading it was the only way to
// challenge it. This section converts those printed defaults into the same
// instrument as everything else at this stop: a card with a marked default.
//
// The card taxonomy at the decisions stop is one queue, three classes:
//
//   DECISION CARDS     G6-surviving registered ambiguities (the registry
//                      above), priority by measured exceedance.
//   ASSUMPTION CARDS   one per material independent forecast row whose
//                      authority is an assumption-class default -- a policy
//                      zero, a standing convention, trend or carry-forward
//                      inference, guidance or indication. Never formula,
//                      schedule or captured legs: those calculate.
//   PLAUSIBILITY CARD  ONE consolidated card for every liquidity-stress
//                      finding the default baseline produces, replacing the
//                      silent acknowledgement the build used to apply on the
//                      user's behalf.
//
// Skipping a card records nothing anywhere: skipping IS accepting the
// default, and an accepted default leaves the case-source byte-identical to
// a run that never showed the card. An override is receipted in
// case-source.answers through the lawful channel the compiler already
// consumes -- `derived.forecast.<row_id>`, or the translation-effect row's
// dedicated `derived.fx.effect` -- and the mutation happens at compile time,
// never here. Skipped defaults therefore remain lawful deferred defaults.

export const ASSUMPTION_DEFAULT_METHODS = Object.freeze([
  "user_assumption",
  "explicit_zero",
  "seasonal_run_rate",
  "historical_average",
  "historical_trend",
  "carry_forward",
  "company_guidance",
  "company_indication",
]);

// The consolidated plausibility card's id. Per-finding acknowledgements are
// receipted as `plausibility.<finding>` answers -- exactly the keys
// explicitPlausibilityAcknowledgements already reads off stage_three_answers.
export const PLAUSIBILITY_TOPIC_ID = "plausibility.findings";

function assumptionTopicId(row) {
  return row.semantic_role === "fx_effect_on_cash"
    ? "derived.fx.effect"
    : `derived.forecast.${row.row_id}`;
}

function assumptionMethodLabel(method) {
  switch (method) {
    case "user_assumption":
      return "a declared default";
    case "explicit_zero":
      return "the standing zero convention";
    case "seasonal_run_rate":
      return "the seasonal run-rate";
    case "historical_average":
      return "the historical average";
    case "historical_trend":
      return "the historical trend";
    case "carry_forward":
      return "the last reported year carried forward";
    case "company_guidance":
      return "company guidance";
    case "company_indication":
      return "a company indication";
    default:
      return method.replaceAll("_", " ");
  }
}

function describePlausibilityFindings(findings, maxParts = 4) {
  const parts = [];
  const seen = new Set();
  for (const finding of findings ?? []) {
    const body = /^(?:standalone|pro_forma)_(.+)$/.exec(String(finding))?.[1] ??
      String(finding);
    const periodMatch = /period_(\d+)$/.exec(body);
    const kind = body.replace(/_period_\d+$/, "").replaceAll("_", " ");
    const label = periodMatch
      ? `${kind} in forecast year ${Number(periodMatch[1])}`
      : kind;
    if (!seen.has(label)) {
      seen.add(label);
      parts.push(label);
    }
  }
  const shown = parts.slice(0, maxParts);
  const hidden = parts.length - shown.length;
  if (hidden > 0) shown.push(`${hidden} more`);
  return shown.join(", ");
}

/**
 * Build the ONE consolidated plausibility card from a findings list, or null
 * when there is nothing to acknowledge. Exported so fixtures can assert on
 * consolidation without solving anything.
 */
export function buildPlausibilityTopic(findings) {
  const unique = [...new Set(findings ?? [])].sort();
  if (unique.length === 0) return null;
  const described = describePlausibilityFindings(unique);
  return {
    id: PLAUSIBILITY_TOPIC_ID,
    kind: "plausibility_acknowledgement",
    instrument: "plausibility",
    subject_line: `liquidity stress the defaults produce (${described})`,
    prompt: `On today's defaults the model projects ${described}. These figures are plausible, not confirmed. Acknowledge them, or raise them for review?`,
    context_line: null,
    other_phrase: "raise them",
    seeds: [],
    parents: [],
    findings: unique,
    options: [
      {
        id: "acknowledge",
        word: "acknowledge",
        // Acknowledging is receipted per finding -- exactly the keys the
        // build's economic-plausibility validator reads -- so the answer
        // survives recompilation instead of living only on this round.
        apply: (modelCase) => {
          if (!modelCase) return modelCase;
          modelCase.stage_three_answers = {
            ...(modelCase.stage_three_answers ?? {}),
            ...Object.fromEntries(
              unique.map((finding) => [`plausibility.${finding}`, "acknowledged"]),
            ),
          };
          return modelCase;
        },
      },
      { id: "raise", word: "raise", apply: (modelCase) => modelCase },
    ],
    default_option: "acknowledge",
    assumption: (option) =>
      option === "acknowledge"
        ? `Liquidity stress (${described}) is acknowledged as plausible rather than confirmed.`
        : `Liquidity stress (${described}) is left unacknowledged for review at delivery.`,
  };
}

/**
 * Enumerate the material forecast rows that would otherwise be silently
 * assumed. Detection reads the same authority machinery the forecast-plan
 * screen prints under, so a card exists exactly where the receipt would have
 * shown an independent assumption-class producer.
 *
 * `presentedIds` suppresses topics already served in an earlier decision
 * round of this run: a topic answered at its default must not resurface, and
 * one answered with an override is carried by its own receipt.
 */
export function detectAssumptionTopics({ draftCase, presentedIds = [] }) {
  const presented =
    presentedIds instanceof Set ? presentedIds : new Set(presentedIds ?? []);
  const topics = [];
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of draftCase?.statement_structure?.[section] ?? []) {
      if (row.row_type === "header") continue;
      const authorities = [0, 1, 2].map((index) =>
        resolveForecastAuthority(draftCase, row, index),
      );
      // The same independence test the material forecast plan prints under:
      // formula and schedule legs calculate and are never cards.
      const independent = authorities.every((authority) =>
        ["broker", "hardcode", "zero", "uncalculated", "block"].includes(
          authority.mechanism,
        ),
      );
      if (!independent) continue;
      const methods = [
        ...new Set(authorities.map((authority) =>
          String(authority.method ?? "unresolved"),
        )),
      ];
      if (
        !methods.every((method) => ASSUMPTION_DEFAULT_METHODS.includes(method))
      ) {
        continue;
      }
      // A figure the user already authored is a receipted decision, not a
      // default; re-asking would downgrade their own answer back into a card.
      if (
        authorities.some(
          (authority) =>
            authority.method === "user_assumption" &&
            String(authority.source_id ?? "").startsWith("derived."),
        )
      ) {
        continue;
      }
      const material =
        authorities.some((authority) => authority.material === true) ||
        forecastRowMateriality(draftCase, row) === true;
      if (!material) continue;
      const id = assumptionTopicId(row);
      if (presented.has(id)) continue;
      const label = String(row.label ?? row.row_id);
      const values = authorities.map((authority, index) => {
        if (Number.isFinite(Number(authority.value))) {
          return Number(authority.value);
        }
        const seriesValue = Number(row.values?.[index + 3]);
        return Number.isFinite(seriesValue) ? seriesValue : null;
      });
      const methodText = assumptionMethodLabel(methods[0]);
      const valuesText = values
        .map((value) =>
          value === null ? "n/a" : formatMoney(value, draftCase?.issuer?.reporting_currency),
        )
        .join(", ");
      topics.push({
        id,
        kind: "assumption_topic",
        instrument: "assumption",
        section,
        row_id: row.row_id,
        methods,
        current_values: values,
        subject_line: `whether ${label} stays at ${methodText}`,
        prompt: `${label} is held at ${valuesText} a year, from ${methodText}. Accept that default, or supply your own three figures?`,
        context_line: "This is a stated model default, not filed evidence.",
        other_phrase: "supply figures",
        seeds: [],
        parents: [],
        material,
        options: [
          { id: "default", word: "default", apply: (modelCase) => modelCase },
          // The override mutates nothing here: it is receipted into
          // case-source.answers and applied when the case recompiles.
          { id: "override", word: "override", apply: null },
        ],
        default_option: "default",
        // An override either arrives as the bare option (the answer file then
        // carries the three figures under the same id) or as the three
        // figures themselves; both are receipted into case-source.answers and
        // applied when the case recompiles -- never mutated here.
        assumption: (option) =>
          option === "override" || Array.isArray(option)
            ? `Your own figures replace ${methodText} for all three forecast years of ${label}, recorded against the case.`
            : `${label} stays at ${methodText} across the forecast.`,
      });
    }
  }
  return topics.sort((left, right) => left.id.localeCompare(right.id));
}

// ── the discipline checks ──────────────────────────────────────────────────

const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;

// Rules 2 and 5, enforced rather than trusted. A registry entry that violates
// either fails the build of the question, not the review of it.
export function lintQuestion(question, modelCase) {
  const problems = [];
  if (SNAKE_CASE.test(question.prompt)) {
    problems.push(
      `prompt uses model language, not company language: "${SNAKE_CASE.exec(question.prompt)[0]}"`,
    );
  }
  for (const instrument of modelCase.instruments ?? []) {
    if (question.prompt.includes(instrument.instrument_id)) {
      problems.push(`prompt names an internal id: "${instrument.instrument_id}"`);
    }
  }
  if (question.options.length !== 2) {
    problems.push(`must offer exactly two options, has ${question.options.length}`);
  }
  for (const option of question.options) {
    if (!/^[a-z][a-z0-9]*$/.test(option.word)) {
      problems.push(`option "${option.word}" is not a single word`);
    }
    if (!option.consequence_text) {
      problems.push(`option "${option.word}" states no consequence in money`);
    }
  }
  if (!question.consequence) {
    problems.push("question states no consequence in money");
  }
  if (question.prompt.length > 200) {
    problems.push("prompt is long enough to need a paragraph answer");
  }
  return problems;
}

// ── the money sentence ─────────────────────────────────────────────────────

function moneyPhrase(consequence) {
  const { metric, delta, currency } = consequence;
  const magnitude =
    HEADLINE_METRICS[metric].unit === "turns"
      ? formatTurns(Math.abs(delta))
      : formatMoney(Math.abs(delta), currency);
  switch (metric) {
    case "total_liquidity":
      return delta < 0
        ? `${magnitude} drops out of liquidity`
        : `${magnitude} is added to liquidity`;
    case "net_debt":
      return `net debt is ${magnitude} ${delta > 0 ? "higher" : "lower"}`;
    case "gross_debt":
      return `gross debt is ${magnitude} ${delta > 0 ? "higher" : "lower"}`;
    case "gross_interest":
      return `interest is ${magnitude} a year ${delta > 0 ? "higher" : "lower"}`;
    case "ending_cash":
      return `year-end cash is ${magnitude} ${delta > 0 ? "higher" : "lower"}`;
    case "net_leverage":
      return `leverage is ${magnitude} ${delta > 0 ? "higher" : "lower"}`;
    default:
      return `${HEADLINE_METRICS[metric].noun} moves by ${magnitude}`;
  }
}

function optionConsequenceText(metric, value, currency) {
  const spec = HEADLINE_METRICS[metric];
  const stated =
    spec.unit === "turns" ? formatTurns(value) : formatMoney(value, currency);
  return `${spec.noun} ${stated}`;
}

// ── detection, measurement, pruning ────────────────────────────────────────

function detectAll(context) {
  const found = [];
  for (const kind of KINDS) {
    for (const instance of kind.detect(context)) {
      found.push({ parents: [], ...instance });
    }
  }
  // Deterministic order: registry order, then id. Nothing downstream may depend
  // on Map or object iteration order.
  const kindOrder = new Map(KINDS.map((kind, index) => [kind.kind, index]));
  return found.sort(
    (left, right) =>
      kindOrder.get(left.kind) - kindOrder.get(right.kind) ||
      left.id.localeCompare(right.id),
  );
}

function applyOption(modelCase, instance, optionId) {
  const option = instance.options.find((candidate) => candidate.id === optionId);
  if (!option) return modelCase;
  return option.apply(modelCase) ?? modelCase;
}

/**
 * Reapply receipted decisions to a freshly compiled case.
 *
 * Answers are not merely question-suppression metadata. A new compile starts
 * from sealed evidence and doctrine, so every carried answer must replay the
 * same registered economic mutation before question planning or solving.
 * Unknown or stale answer IDs are reported, never silently treated as applied.
 */
export function applyRecordedAnswers({
  modelCase,
  intake,
  reconciliation = null,
  answers = new Map(),
}) {
  const recorded = answers instanceof Map
    ? new Map(answers)
    : new Map(Object.entries(answers ?? {}));
  const instances = detectAll({ draftCase: modelCase, intake, reconciliation });
  const byId = new Map(instances.map((instance) => [instance.id, instance]));
  let next = deepClone(modelCase);
  const applied = [];
  const unknown = [];
  const invalid = [];
  for (const [questionId, answer] of recorded) {
    const instance = byId.get(questionId);
    if (!instance) {
      unknown.push({ question_id: questionId, answer });
      continue;
    }
    if (!instance.options.some((option) => option.id === answer)) {
      invalid.push({
        question_id: questionId,
        answer,
        allowed_answers: instance.options.map((option) => option.id),
      });
      continue;
    }
    next = applyOption(next, instance, answer);
    applied.push({ question_id: questionId, answer });
  }
  return { modelCase: next, applied, unknown, invalid };
}

// The baseline every candidate is measured against: the draft case with every
// detected ambiguity taken at its default. Measuring one ambiguity against a
// baseline that already assumes the others is what keeps the measurement
// independent of the order the detectors happen to run in.
function defaultBaseline(draftCase, instances) {
  let working = deepClone(draftCase);
  for (const instance of instances) {
    working = applyOption(working, instance, instance.default_option);
  }
  return working;
}

function exceedance(impact) {
  let best = 0;
  for (const [metric, entry] of Object.entries(impact.metrics ?? {})) {
    if (!entry.material) continue;
    const policy = MATERIALITY_POLICY[metric];
    const denominator =
      policy.kind === "absolute" ? policy.threshold : entry.scale * policy.threshold;
    if (denominator > 0) best = Math.max(best, Math.abs(entry.delta) / denominator);
  }
  return best;
}

// G6. Returns the surviving roots plus a full account of what was removed and
// why, so the fixtures can assert on the pruning rather than only on the count.
export function pruneDecisionGraph(candidates, resolved) {
  const byId = new Map(candidates.map((instance) => [instance.id, instance]));
  const pruned = [];
  const removed = new Set();

  // First pass: parents already resolved with a mooting answer. Iterate to a
  // fixed point, because mooting is transitive — if a parent is moot then its
  // own children are moot too. A single pass would leave a grandchild standing
  // as a root with no parent left to depend on, which is how a cap-of-five
  // reached by pruning would start asking questions that cannot matter.
  const mooted = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const instance of candidates) {
      if (removed.has(instance.id)) continue;
      for (const link of instance.parents ?? []) {
        const answer = resolved.get(link.parent_id);
        const parentIsMoot = mooted.has(link.parent_id);
        if (
          parentIsMoot ||
          (answer !== undefined && link.moot_when.includes(answer))
        ) {
          removed.add(instance.id);
          mooted.add(instance.id);
          pruned.push({
            id: instance.id,
            kind: instance.kind,
            disposition: "moot",
            parent_id: link.parent_id,
            parent_answer: parentIsMoot ? null : answer,
            reason: parentIsMoot
              ? `its parent is itself moot, so ${link.reason}`
              : link.reason,
          });
          changed = true;
          break;
        }
      }
    }
  }

  // Second pass: parents that are themselves still candidates. One stop means a
  // child cannot be asked alongside a parent whose answer may delete it.
  changed = true;
  while (changed) {
    changed = false;
    for (const instance of candidates) {
      if (removed.has(instance.id)) continue;
      for (const link of instance.parents ?? []) {
        const parent = byId.get(link.parent_id);
        if (parent && !removed.has(parent.id)) {
          removed.add(instance.id);
          pruned.push({
            id: instance.id,
            kind: instance.kind,
            disposition: "deferred",
            parent_id: link.parent_id,
            parent_answer: null,
            reason:
              `held back until "${parent.prompt}" is answered: on ` +
              `${link.moot_when.map((option) => `"${option}"`).join(" or ")}, ` +
              `${link.reason}`,
          });
          changed = true;
          break;
        }
      }
    }
  }

  const survivors = candidates.filter((instance) => !removed.has(instance.id));
  pruned.sort((left, right) => left.id.localeCompare(right.id));
  return { survivors, pruned };
}

/**
 * Plan stage 3.
 *
 * @param {object} args
 * @param {object} args.draftCase   the case as assembled from the sources so far
 * @param {object} args.intake      { company_name, export, filings, brokers }
 * @param {object} [args.reconciliation] outcome of the reconciliation stop
 * @param {Map<string,string>} [args.resolved] answers already known (rebuild path)
 * @param {number} [args.limit]
 * @param {string[]|Set<string>} [args.presentedDecisions] assumption or
 *        plausibility topic ids already served in an earlier round of this
 *        run; suppressed so a defaulted topic never resurfaces.
 */
export function planQuestions({
  draftCase,
  intake,
  reconciliation = null,
  resolved = new Map(),
  limit = QUESTION_LIMIT,
  presentedDecisions = [],
}) {
  const context = { draftCase, intake, reconciliation };
  const detected = detectAll(context);
  const graph = compileImpactGraph(draftCase);
  const baseline = defaultBaseline(draftCase, detected);
  const currency = draftCase.issuer?.reporting_currency;

  const assumptions = [];
  const candidates = [];
  const blocked = [];
  const resolvedNow = new Map(resolved);
  if (reconciliation) {
    resolvedNow.set(
      "reconciliation_residual",
      reconciliation.residual_carried ? "carry" : "reexport",
    );
  }
  const measurements = [];

  for (const instance of detected) {
    if (resolvedNow.has(instance.id)) {
      assumptions.push({
        id: instance.id,
        source: "carried_forward",
        option: resolvedNow.get(instance.id),
        text: instance.assumption(resolvedNow.get(instance.id)),
      });
      continue;
    }
    const [optionA, optionB] = instance.options;
    const impact = differentialImpact(baseline, optionA, optionB);
    const check = crossCheckReachability(graph, instance.seeds, impact);
    measurements.push({ id: instance.id, impact, check });

    if (impact.both_infeasible) {
      // Not an ambiguity at all: the draft case does not solve under either
      // answer. Surfacing it as a question would ask the user to choose between
      // two things that cannot happen.
      blocked.push({ id: instance.id, reason: impact.reason });
      continue;
    }
    if (!impact.feasible) {
      // The model already knows: only one branch solves. Not a question.
      const answer = instance.options.find(
        (option) => option.id !== impact.infeasible_option,
      ).id;
      resolvedNow.set(instance.id, answer);
      assumptions.push({
        id: instance.id,
        source: "only_feasible_answer",
        option: answer,
        text: instance.assumption(answer),
        note: `The alternative does not solve: ${impact.reason}`,
      });
      continue;
    }
    if (!impact.material) {
      resolvedNow.set(instance.id, instance.default_option);
      assumptions.push({
        id: instance.id,
        source: "below_the_bar",
        option: instance.default_option,
        text: instance.assumption(instance.default_option),
        note: describeImmateriality(impact, currency),
      });
      continue;
    }

    // Orient the differential so the delta reads from the default answer to the
    // other one, which is the direction the printed sentence describes.
    const defaultIsFirst = instance.default_option === optionA.id;
    const consequenceRaw = consequenceOf(impact, currency);
    if (!consequenceRaw) {
      // Material on nothing that can be stated in money. Rule 3 says that is not
      // worth asking.
      resolvedNow.set(instance.id, instance.default_option);
      assumptions.push({
        id: instance.id,
        source: "no_money_consequence",
        option: instance.default_option,
        text: instance.assumption(instance.default_option),
      });
      continue;
    }
    const consequence = {
      ...consequenceRaw,
      delta: defaultIsFirst ? consequenceRaw.delta : -consequenceRaw.delta,
    };
    const entry = impact.metrics[consequence.metric];
    const optionValues = new Map([
      [optionA.id, entry.value_a],
      [optionB.id, entry.value_b],
    ]);
    const options = instance.options.map((option) => ({
      id: option.id,
      word: option.word,
      consequence_text: optionConsequenceText(
        consequence.metric,
        optionValues.get(option.id),
        currency,
      ),
      consequence_value: optionValues.get(option.id),
    }));

    const otherOption = instance.options.find(
      (option) => option.id !== instance.default_option,
    );
    const defaultOption = instance.options.find(
      (option) => option.id === instance.default_option,
    );
    // The consequence describes the branch that is NOT taken by default, which
    // is the one the user is being asked to confirm or overturn. Registry
    // entries may give the clause in the subject's own words; where they do
    // not, naming both answers is unambiguous if plainer.
    const clause =
      instance.other_phrase ??
      (otherOption.word === "yes"
        ? "it is"
        : otherOption.word === "no"
          ? "it isn't"
          : `${otherOption.word} rather than ${defaultOption.word}`);
    const consequenceSentence = `${instance.context_line ? `${instance.context_line} ` : ""}If ${clause}, ${moneyPhrase(consequence)}.`;

    candidates.push({
      ...instance,
      // The display options carry no `apply`; the registry ones do, and the
      // caller needs them to put an answer back into the case.
      optionsRaw: instance.options,
      options,
      consequence: consequenceSentence,
      consequence_detail: consequence,
      impact,
      reachability: check,
      exceedance: exceedance(impact),
    });
  }

  const { survivors, pruned } = pruneDecisionGraph(candidates, resolvedNow);

  // Anything pruned still has to be settled, and the settlement is stated.
  for (const entry of pruned) {
    const instance = candidates.find((candidate) => candidate.id === entry.id);
    if (!instance) continue;
    if (entry.disposition === "moot") continue; // nothing left to assume
    assumptions.push({
      id: instance.id,
      source: "deferred_behind_parent",
      option: instance.default_option,
      text: instance.assumption(instance.default_option),
      note: entry.reason,
      parent_id: entry.parent_id,
    });
  }

  const ordered = [...survivors].sort(
    (left, right) =>
      right.exceedance - left.exceedance || left.id.localeCompare(right.id),
  );

  const lint = [];
  for (const question of ordered) {
    for (const problem of lintQuestion(question, draftCase)) {
      lint.push({ id: question.id, problem });
    }
  }

  const disagreements = measurements
    .filter((entry) => !entry.check.agrees)
    .map((entry) => ({
      id: entry.id,
      moved_but_unreachable: entry.check.moved_but_unreachable,
    }));

  // The forecast plan's own defaults join the same material-first queue, and
  // the liquidity-stress findings the default baseline produces surface as
  // ONE consolidated card instead of a silent acknowledgement at build time.
  // A baseline that does not solve has no findings to show; infeasibility is
  // handled above as blocked or only-feasible.
  let plausibilityFindings = [];
  try {
    plausibilityFindings = plausibilityFindingIds(solveCase(baseline));
  } catch {
    plausibilityFindings = [];
  }
  const plausibilityTopic = resolved?.has?.(PLAUSIBILITY_TOPIC_ID)
    ? null
    : buildPlausibilityTopic(plausibilityFindings);
  const assumptionTopics = detectAssumptionTopics({
    draftCase,
    presentedIds: presentedDecisions,
    resolved,
  });

  const base = {
    detected: detected.map((instance) => instance.id),
    candidates: candidates.map((instance) => instance.id),
    // Kept so settlement after the answers can re-evaluate a deferred child's
    // mooting condition against the answer that actually came back.
    candidates_detail: candidates,
    pruned,
    assumptions,
    blocked,
    lint,
    graph_disagreements: disagreements,
    graph_stats: {
      manifest_edges: graph.manifest_edge_count,
      augmented_edges: graph.augmented_edge_count,
    },
    assumption_topics: assumptionTopics.map((topic) => topic.id),
    plausibility_findings: plausibilityFindings,
  };

  if (blocked.length > 0) {
    return {
      ...base,
      status: "blocked",
      blocker_class: "INTERNAL_WORK",
      questions: [],
      survivors: ordered,
    };
  }

  // ONE queue at the stop: decision cards first (measured exceedance), then
  // assumption cards, then the consolidated plausibility card. The cap is
  // presentation, never evidence of defect: whatever does not fit stays
  // pending and is replanned once the answers land.
  //
  // The cards ride an EXISTING decision round; they never open one. A case
  // with nothing to decide keeps the ordinary path -- the forecast-plan
  // receipt still prints every material independent row, so no default is
  // silent, and no undeclared pre-build stop appears. A topic answered in an
  // earlier round (default or override) is carried by its receipt and is not
  // served twice.
  const consolidated = plausibilityTopic ? [plausibilityTopic] : [];
  const combined =
    ordered.length === 0
      ? []
      : [...ordered, ...assumptionTopics, ...consolidated];

  if (combined.length === 0) {
    return { ...base, status: "no_questions", questions: [] };
  }

  const questions = combined.slice(0, limit);
  const result = {
    ...base,
    status: "ask",
    questions,
    survivors: ordered,
    pending_topic_count: Math.max(0, combined.length - limit),
  };
  if (combined.length > limit) {
    const groups = Object.entries(
      ordered.reduce((accumulator, question) => {
        (accumulator[question.kind] ??= []).push(question.id);
        return accumulator;
      }, {}),
    )
      .map(([kind, question_ids]) => ({ kind, question_ids }))
      .sort((left, right) => left.kind.localeCompare(right.kind));
    result.pending_questions = combined.slice(limit).map((entry) => entry.id);
    result.remaining_question_count = combined.length - limit;
    result.decision_round = 1;
    result.unresolved_groups = groups;
  }
  return result;
}

function describeImmateriality(impact, currency) {
  const parts = [];
  for (const [metric, entry] of Object.entries(impact.metrics)) {
    if (Math.abs(entry.delta) < 1e-9) continue;
    const spec = HEADLINE_METRICS[metric];
    parts.push(
      `${spec.noun} ${
        spec.unit === "turns"
          ? formatTurns(Math.abs(entry.delta))
          : formatMoney(Math.abs(entry.delta), currency)
      }`,
    );
  }
  return parts.length === 0
    ? "Either answer produces the same model."
    : `Below the bar for asking (${parts.join(", ")}).`;
}

/**
 * After the answers come in, settle everything G6 held back.
 *
 * A deferred question was not asked because its parent was. Now the parent has
 * an answer, so each deferred child is one of two things and never a third:
 *
 *   MOOT    the parent's answer deletes it. Nothing is assumed, because there
 *           is nothing left to assume. It does not appear in the report.
 *   ASSUMED the parent's answer leaves it live. It falls to its declared
 *           default and is printed as a stated assumption.
 *
 * The flow has one stop, so there is no third option in which the child is
 * asked. That is the price of the single stop, and stating it here is what
 * keeps the deferral honest rather than a quiet drop.
 */
export function settleAnswers({ plan, answers }) {
  const resolved = new Map(answers);
  const settled = [];
  const byId = new Map(
    (plan.candidates_detail ?? []).map((instance) => [instance.id, instance]),
  );
  for (const entry of plan.pruned) {
    if (entry.disposition !== "deferred") continue;
    const instance = byId.get(entry.id);
    const link = (instance?.parents ?? []).find(
      (candidate) => candidate.parent_id === entry.parent_id,
    );
    const parentAnswer = resolved.get(entry.parent_id) ?? null;
    const moot =
      parentAnswer !== null && (link?.moot_when ?? []).includes(parentAnswer);
    settled.push({
      id: entry.id,
      parent_id: entry.parent_id,
      parent_answer: parentAnswer,
      became: moot ? "moot" : "assumed",
      option: moot ? null : (instance?.default_option ?? null),
      text: moot ? null : (instance?.assumption(instance.default_option) ?? null),
      reason: moot ? link.reason : null,
    });
  }
  settled.sort((left, right) => left.id.localeCompare(right.id));
  return { resolved, settled };
}

export const REGISTRY_KINDS = KINDS.map((kind) => kind.kind);
