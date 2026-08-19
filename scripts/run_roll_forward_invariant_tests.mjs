#!/usr/bin/env node
/**
 * P4.4a — D10: the release-grade `debt.instrument_roll_forward` invariant must
 * account for EVERY movement that lawfully changes an instrument's balance.
 *
 * Defect (DEFECT_REGISTER.md D10): `validateSolutionInvariants` computed the
 * expected ending balance as
 *
 *     opening + issuance + other_non_cash - amortisation - maturity
 *
 * omitting `pik_interest_native` and `fair_value_movement_native`. Every PIK or
 * accreting instrument therefore failed a RELEASE-GRADE invariant even though
 * the solver's own roll-forward was correct — the reported discrepancy equalled
 * the accretion exactly. Unexercised on the certified fixtures because neither
 * carries a PIK instrument.
 *
 * The lawful movement set — read off the solver's own balance construction at
 * scripts/lib/solver.mjs (ending_native) and its self-check `debt_roll_forward`
 * — is SEVEN terms:
 *
 *     ending = opening
 *            + issuance
 *            + fair_value_movement
 *            + other_non_cash_movement
 *            + pik_interest
 *            - amortisation
 *            - maturity_repayment
 *
 * This suite is a VALIDATOR suite: it never repairs a solution and never widens
 * a tolerance. Every check runs the invariant at its shipped default tolerance
 * (1e-8). It proves three things:
 *
 *   1. REPRODUCTION — the two accreting archetype cases (read-only fixtures
 *      authored by P7.1b) satisfy the invariant, and the solver independently
 *      agrees with the seven-term identity on them.
 *   2. STILL HAS TEETH — a materially wrong ending balance still fails, and a
 *      wrong PIK AMOUNT (ending left at the solver's value) still fails with a
 *      discrepancy equal to the PIK error, which is only true once the pik term
 *      is inside the identity.
 *   3. NO TERM CAN BE SILENTLY LOST AGAIN — for each of the seven terms, a
 *      solution whose ending honours the term PASSES and the same solution with
 *      that one term's contribution removed from the ending FAILS. Passing and
 *      failing together pin every term's presence AND its sign; dropping any
 *      term from the identity turns its FAIL case green and is caught here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateCaseShape, solveCase } from "./lib/solver.mjs";
import { validateSolutionInvariants } from "./lib/validation_invariants.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const ARCHETYPES = path.join(REPO, "test-fixtures/archetypes/economics");
const ROLL_FORWARD = "debt.instrument_roll_forward";
/** The invariant's shipped default. Never relaxed anywhere in this suite. */
const TOLERANCE = 1e-8;

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};
const near = (left, right, tolerance = 1e-9) =>
  Number.isFinite(Number(left)) &&
  Number.isFinite(Number(right)) &&
  Math.abs(Number(left) - Number(right)) <= tolerance;

const readCase = (file) =>
  JSON.parse(fs.readFileSync(path.join(ARCHETYPES, file), "utf8"));

const rollForwardErrors = (solution) =>
  validateSolutionInvariants(solution, TOLERANCE).filter(
    (error) => error.id === ROLL_FORWARD,
  );

/** The seven-term lawful movement set, recomputed here independently. */
const sevenTermEnding = (item) =>
  Number(item.opening_native ?? 0) +
  Number(item.issuance_native ?? 0) +
  Number(item.fair_value_movement_native ?? 0) +
  Number(item.other_non_cash_movement_native ?? 0) +
  Number(item.pik_interest_native ?? 0) -
  Number(item.amortisation_native ?? 0) -
  Number(item.maturity_repayment_native ?? 0);

function solveArchetype(file) {
  const modelCase = readCase(file);
  const shapeErrors = validateCaseShape(modelCase);
  check(
    shapeErrors.length === 0,
    `${file}: the archetype case must be shape-valid, got ${JSON.stringify(shapeErrors)}`,
  );
  return solveCase(modelCase);
}

// ---------------------------------------------------------------------------
// 1. REPRODUCTION — the PIK archetype.
//
// pik_only_debt: 300 of PIK-only principal accreting at 8% for three forecast
// years, no maturity inside the forecast. Against the DEFECTIVE invariant this
// block reports three violations, each exactly the omitted accretion.
// ---------------------------------------------------------------------------
function pikOnlyReproduction() {
  const solution = solveArchetype("pik_only_debt.json");
  check(solution.forecast.length === 3, "the PIK archetype must solve three forecast years");

  let accretingPeriods = 0;
  for (const period of solution.forecast) {
    const item = period.instrument_results.find(
      (entry) => entry.instrument_id === "pik_note",
    );
    check(Boolean(item), `${period.period}: the pik_note instrument must be solved`);
    check(
      Number(item.pik_interest_native) > 0,
      `${period.period}: the reproduction requires a live PIK accretion, got ${item.pik_interest_native}`,
    );
    accretingPeriods += 1;
    // The solver's own construction, recomputed independently of its self-check.
    check(
      near(item.ending_native, sevenTermEnding(item), TOLERANCE),
      `${period.period}: the solver's ending balance must satisfy the seven-term identity`,
    );
    // And the balance genuinely compounds, so the omitted term is material.
    check(
      Number(item.ending_native) - Number(item.opening_native) > 20,
      `${period.period}: the accretion must be material (${item.ending_native} vs ${item.opening_native})`,
    );
  }
  check(accretingPeriods === 3, "all three forecast years must carry accretion");

  const violations = rollForwardErrors(solution);
  check(
    violations.length === 0,
    `a correct PIK roll-forward must raise NO ${ROLL_FORWARD} violation, got ${JSON.stringify(violations)}`,
  );
  // Nothing else in the solution invariant set may be disturbed either.
  check(
    validateSolutionInvariants(solution, TOLERANCE).length === 0,
    "the PIK archetype must be clean across every solution invariant",
  );
  return solution;
}

// ---------------------------------------------------------------------------
// 2. REPRODUCTION — accreting to par, redeemed at the ACCRETED amount.
//
// zero_coupon_accreting_to_par: 200 accreting at 6%, maturing in forecast year
// two at its accreted carrying amount. This exercises accretion and a maturity
// repayment in the SAME period — the case where an omitted pik term and a
// present maturity term could cancel by accident.
// ---------------------------------------------------------------------------
function accretingToParReproduction() {
  const solution = solveArchetype("zero_coupon_accreting_to_par.json");
  const periods = solution.forecast;
  const instrument = (period) =>
    period.instrument_results.find((entry) => entry.instrument_id === "zero_note");

  const maturityIndex = periods.findIndex(
    (period) => Number(instrument(period).maturity_repayment_native) > 0,
  );
  check(maturityIndex === 1, `the note must mature in forecast year two, got index ${maturityIndex}`);

  const maturing = instrument(periods[maturityIndex]);
  check(
    Number(maturing.pik_interest_native) > 0,
    "the maturity year must still carry accretion (accretion and repayment in one period)",
  );
  check(
    Number(maturing.maturity_repayment_native) > 200,
    `the repayment must be the accreted amount, not the 200 face, got ${maturing.maturity_repayment_native}`,
  );
  check(near(maturing.ending_native, 0, TOLERANCE), "the ending balance must be exactly zero");
  check(
    near(maturing.ending_native, sevenTermEnding(maturing), TOLERANCE),
    "accretion and maturity repayment must reconcile in the same period",
  );

  const accreting = periods.filter(
    (period) => Number(instrument(period).pik_interest_native) > 0,
  );
  check(accreting.length === 2, `exactly two years must accrete, got ${accreting.length}`);

  const violations = rollForwardErrors(solution);
  check(
    violations.length === 0,
    `the accreting-to-par archetype must raise NO ${ROLL_FORWARD} violation, got ${JSON.stringify(violations)}`,
  );
  return solution;
}

// ---------------------------------------------------------------------------
// 3. INDEPENDENT SOLVER AGREEMENT.
//
// D10 asserts the solver is right and the invariant is wrong. Verified here
// rather than taken on trust: the solver's own per-period self-check must agree
// with the corrected invariant on every instrument of both accreting archetypes.
// ---------------------------------------------------------------------------
function solverAgreesWithCorrectedInvariant(solutions) {
  for (const [label, solution] of solutions) {
    for (const period of solution.forecast) {
      check(
        period.checks.debt_roll_forward === true,
        `${label}/${period.period}: the solver's own debt_roll_forward self-check must hold`,
      );
      for (const item of period.instrument_results ?? []) {
        check(
          near(item.ending_native, sevenTermEnding(item), TOLERANCE),
          `${label}/${period.period}/${item.instrument_id}: solver balance vs seven-term identity`,
        );
        // The solver's published total_non_cash_movement_native must be the sum
        // of the three non-cash terms the invariant now consumes; a divergence
        // here would mean solver and invariant read different movement sets.
        check(
          near(
            Number(item.total_non_cash_movement_native ?? 0),
            Number(item.fair_value_movement_native ?? 0) +
              Number(item.other_non_cash_movement_native ?? 0) +
              Number(item.pik_interest_native ?? 0),
            TOLERANCE,
          ),
          `${label}/${period.period}/${item.instrument_id}: the solver's non-cash total must be fair value + other + PIK`,
        );
      }
    }
    check(
      solution.all_checks_pass === true,
      `${label}: the solver must report all of its own checks passing`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. CONTROL — a materially wrong ending balance MUST STILL FAIL.
//
// The strengthened invariant is not a looser invariant. The solution is cloned
// and corrupted in memory; nothing on disk is touched and no solution is
// repaired.
// ---------------------------------------------------------------------------
function materialBreakStillFails(pikSolution) {
  const BREAK = 137.5; // material against a ~325 balance
  const corrupted = structuredClone(pikSolution);
  const target = corrupted.forecast[1];
  const item = target.instrument_results.find(
    (entry) => entry.instrument_id === "pik_note",
  );
  const honest = Number(item.ending_native);
  item.ending_native = honest + BREAK;

  const violations = rollForwardErrors(corrupted);
  check(
    violations.length === 1,
    `a material ending-balance break must raise exactly one ${ROLL_FORWARD} violation, got ${violations.length}`,
  );
  check(
    violations[0].period === target.period && violations[0].instrument_id === "pik_note",
    "the violation must name the broken period and instrument",
  );
  check(
    near(Number(violations[0].actual) - Number(violations[0].expected), BREAK, TOLERANCE),
    `the reported discrepancy must be the injected break ${BREAK}, got ${
      Number(violations[0].actual) - Number(violations[0].expected)
    }`,
  );
  check(
    near(Number(violations[0].expected), sevenTermEnding(item), TOLERANCE),
    "the expected balance the invariant reports must be the seven-term identity",
  );
  // A break just above tolerance must fail too: the check is exact, not lenient.
  const hairline = structuredClone(pikSolution);
  const hairlineItem = hairline.forecast[1].instrument_results.find(
    (entry) => entry.instrument_id === "pik_note",
  );
  hairlineItem.ending_native = Number(hairlineItem.ending_native) + 1e-7;
  check(
    rollForwardErrors(hairline).length === 1,
    "a break of 1e-7 — ten times the tolerance — must still fail",
  );
}

// ---------------------------------------------------------------------------
// 5. CONTROL — a WRONG PIK AMOUNT must still fail.
//
// This is the control the defective invariant could never run: it ignored
// pik_interest_native entirely, so a corrupted accretion was invisible to it.
// The ending balance is left at the solver's honest value and the accretion is
// halved; the invariant must fail by exactly the PIK error.
// ---------------------------------------------------------------------------
function wrongPikAmountStillFails(pikSolution) {
  const corrupted = structuredClone(pikSolution);
  const target = corrupted.forecast[0];
  const item = target.instrument_results.find(
    (entry) => entry.instrument_id === "pik_note",
  );
  const honestPik = Number(item.pik_interest_native);
  check(honestPik > 0, "the control needs a non-zero accretion to corrupt");
  const understated = honestPik / 2;
  item.pik_interest_native = understated;

  const violations = rollForwardErrors(corrupted);
  check(
    violations.length === 1,
    `an understated PIK accretion must raise exactly one ${ROLL_FORWARD} violation, got ${violations.length}`,
  );
  check(
    near(
      Number(violations[0].actual) - Number(violations[0].expected),
      honestPik - understated,
      TOLERANCE,
    ),
    `the discrepancy must be the PIK error ${honestPik - understated}, got ${
      Number(violations[0].actual) - Number(violations[0].expected)
    } (the defective invariant reported the whole accretion ${honestPik})`,
  );

  // The mirror: an OVERSTATED accretion must fail in the other direction.
  const overstated = structuredClone(pikSolution);
  const overItem = overstated.forecast[0].instrument_results.find(
    (entry) => entry.instrument_id === "pik_note",
  );
  overItem.pik_interest_native = honestPik * 2;
  const overViolations = rollForwardErrors(overstated);
  check(overViolations.length === 1, "an overstated PIK accretion must fail too");
  check(
    near(
      Number(overViolations[0].actual) - Number(overViolations[0].expected),
      -honestPik,
      TOLERANCE,
    ),
    "an overstated accretion must be reported with the opposite sign",
  );
}

// ---------------------------------------------------------------------------
// 6. MUTATION PROOF — the movement set cannot silently lose a term again.
//
// Every term gets a distinct magnitude, so no sign error, swap or omission can
// pass by arithmetic coincidence. For each term: the honest ending PASSES, and
// the ending with that one term's contribution removed FAILS. A term dropped
// from the identity would make its removed-case PASS and be caught here.
// ---------------------------------------------------------------------------
const MOVEMENTS = [
  { field: "opening_native", amount: 1000, sign: +1 },
  { field: "issuance_native", amount: 137, sign: +1 },
  { field: "fair_value_movement_native", amount: 29, sign: +1 },
  { field: "other_non_cash_movement_native", amount: 53, sign: +1 },
  { field: "pik_interest_native", amount: 71, sign: +1 },
  { field: "amortisation_native", amount: 41, sign: -1 },
  { field: "maturity_repayment_native", amount: 17, sign: -1 },
];

const HONEST_ENDING = MOVEMENTS.reduce(
  (total, term) => total + term.sign * term.amount,
  0,
);

/**
 * A minimal forecast period carrying one instrument and nothing else. Every
 * other field the invariant reads defaults to zero, so only the roll-forward
 * identity can speak.
 */
const syntheticSolution = (ending) => ({
  forecast: [
    {
      period: "2026-12-31",
      instrument_results: [
        {
          instrument_id: "mutation_probe",
          ...Object.fromEntries(
            MOVEMENTS.map((term) => [term.field, term.amount]),
          ),
          ending_native: ending,
        },
      ],
    },
  ],
});

function movementSetIsLoadBearing() {
  check(HONEST_ENDING === 1232, `the probe's honest ending must be 1232, got ${HONEST_ENDING}`);

  const honest = rollForwardErrors(syntheticSolution(HONEST_ENDING));
  check(
    honest.length === 0,
    `the seven-term probe must pass, got ${JSON.stringify(honest)}`,
  );

  const seen = new Set();
  for (const term of MOVEMENTS) {
    const contribution = term.sign * term.amount;
    // Distinct magnitudes: no two term-drops can produce the same ending.
    check(!seen.has(Math.abs(contribution)), `${term.field}: term magnitudes must be distinct`);
    seen.add(Math.abs(contribution));

    // The ending an invariant that had DROPPED this term would expect.
    const withoutTerm = HONEST_ENDING - contribution;
    const violations = rollForwardErrors(syntheticSolution(withoutTerm));
    check(
      violations.length === 1,
      `dropping ${term.field} from the ending must FAIL — if it passes, the invariant has lost that term`,
    );
    check(
      near(
        Number(violations[0].actual) - Number(violations[0].expected),
        -contribution,
        TOLERANCE,
      ),
      `${term.field}: the discrepancy must be exactly its signed contribution ${-contribution}, got ${
        Number(violations[0].actual) - Number(violations[0].expected)
      }`,
    );
  }
  check(seen.size === 7, `all seven terms must be probed, saw ${seen.size}`);

  // A term present with the WRONG SIGN is also caught: flipping amortisation
  // into an addition moves the ending by twice its amount.
  const flipped = rollForwardErrors(syntheticSolution(HONEST_ENDING + 2 * 41));
  check(flipped.length === 1, "a sign-flipped amortisation term must fail");

  // Absent (undefined) movement fields must be read as zero, not as NaN — an
  // instrument with no accretion at all must still pass cleanly.
  const bare = rollForwardErrors({
    forecast: [
      {
        period: "2026-12-31",
        instrument_results: [
          { instrument_id: "bare", opening_native: 500, ending_native: 500 },
        ],
      },
    ],
  });
  check(bare.length === 0, `an instrument with no movements must pass, got ${JSON.stringify(bare)}`);
}

// ---------------------------------------------------------------------------
// 7. REGRESSION — the certified fixture stays clean.
//
// standard-maximal-v2 carries 12 instruments and NO PIK, which is exactly why
// D10 went unexercised. The maintained fixture is a production-shaped custody
// input; this is a forensic read of it, so it identifies itself as such rather
// than impersonating production evidence (the same convention as
// run_acquisition_solver_case_tests.mjs). The contract-version stamps the
// evidence/compile lane supplies are NOT forged here — see the DEFECT_REGISTER
// "Observation" note on fixtures as they sit on disk.
// ---------------------------------------------------------------------------
function certifiedFixtureStaysClean() {
  const modelCase = JSON.parse(
    fs.readFileSync(path.join(REPO, "test-fixtures/cases/standard-maximal-v2.json"), "utf8"),
  );
  modelCase.execution_profile = "reference_parity";
  check(
    validateCaseShape(modelCase).length === 0,
    "the certified fixture must be shape-valid as a forensic regression read",
  );
  // Why D10 stayed unexercised here: 12 declared instruments, none accreting.
  check(
    modelCase.instruments.length === 12,
    `the certified fixture must declare 12 instruments, got ${modelCase.instruments.length}`,
  );
  const accreting = modelCase.instruments.filter((instrument) =>
    [].concat(instrument.pik_rate ?? []).some((rate) => Number(rate) > 0),
  );
  check(
    accreting.length === 0,
    `no certified instrument may carry pik_rate>0 (that is why D10 hid), got ${accreting.length}`,
  );

  const solution = solveCase(modelCase);
  const instruments = new Set();
  for (const period of solution.forecast) {
    for (const item of period.instrument_results ?? []) {
      instruments.add(item.instrument_id);
      check(
        near(item.ending_native, sevenTermEnding(item), TOLERANCE),
        `standard-maximal/${period.period}/${item.instrument_id}: seven-term identity must hold`,
      );
    }
  }
  // The RCF rolls on its own facility path, so 11 of the 12 reach
  // instrument_results — the surface this invariant governs.
  check(
    instruments.size === 11,
    `11 non-RCF instruments must reach instrument_results, got ${instruments.size}`,
  );
  check(
    rollForwardErrors(solution).length === 0,
    `the certified fixture must raise no ${ROLL_FORWARD} violation, got ${JSON.stringify(rollForwardErrors(solution))}`,
  );
  // The fixture DOES carry one unrelated pre-existing finding
  // (acquisition.direct_cash_flow_forbidden, present identically before this
  // package). It is pinned rather than hidden: if the strengthened roll-forward
  // ever adds to this set, or that finding disappears, this fails.
  check(
    JSON.stringify(
      validateSolutionInvariants(solution, TOLERANCE).map((error) => error.id),
    ) === JSON.stringify(["acquisition.direct_cash_flow_forbidden"]),
    `the certified fixture's invariant set must be unchanged by this package, got ${JSON.stringify(
      validateSolutionInvariants(solution, TOLERANCE).map((error) => error.id),
    )}`,
  );
}

// ---------------------------------------------------------------------------
const pikSolution = pikOnlyReproduction();
const accretingSolution = accretingToParReproduction();
solverAgreesWithCorrectedInvariant([
  ["pik_only_debt", pikSolution],
  ["zero_coupon_accreting_to_par", accretingSolution],
]);
materialBreakStillFails(pikSolution);
wrongPikAmountStillFails(pikSolution);
movementSetIsLoadBearing();
certifiedFixtureStaysClean();

process.stdout.write(`${JSON.stringify({ status: "PASS", checks })}\n`);
