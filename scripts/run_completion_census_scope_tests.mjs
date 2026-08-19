#!/usr/bin/env node
/**
 * P3.2 — forecast completion census SCOPE regression.
 *
 * Invariant: the forecast completion census covers EVERY economically-owned
 * cell — both statements AND the debt, interest, lease, RCF, acquisition and
 * leverage/liquidity schedule families; ownership is established by an
 * EXECUTABLE PRODUCER WITNESS (the producer that computes the cell, not a
 * method label); the period count derives from the case rather than a
 * hard-wired 3; and the parity receipt is VERIFIED after Build, not merely
 * sealed before it.
 *
 * Adversarial mutations proven caught:
 *   - a schedule cell DROPPED from the census;
 *   - an ownership label its producer CONTRADICTS (a schedule claim with no
 *     registered producer, a hardcode usurping a schedule role, an evidence
 *     claim with no value, a formula claim with no formula, a policy receipt
 *     under a schedule label);
 *   - a DUPLICATE census key (two writers, one cell);
 *   - a case that changed between the parity seal and Build.
 */

import assert from "node:assert/strict";

import {
  SCHEDULE_FAMILIES,
  assertEconomicStageParityAfterBuild,
  compileForecastCompletionCensus,
  declaredScheduleFamilies,
  forecastPeriodScope,
  scheduleFamilyOf,
  sealEconomicStageParity,
  verifyEconomicStageParityAfterBuild,
  verifyForecastCompletionCoverage,
} from "./lib/forecast_completion_constitution.mjs";
import {
  SCHEDULE_PRODUCER_BY_ROLE,
  SCHEDULE_REGION_WRITERS,
} from "./lib/forecast_producer_contract.mjs";

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

const clone = (value) => structuredClone(value);
const authority = (method, extra = {}) => ({ method, ...extra });

function periods(forecastCount) {
  const historical = ["2023-12-31", "2024-12-31", "2025-12-31"].map((date) => ({
    date, status: "historical",
  }));
  const forecast = Array.from({ length: forecastCount }, (unused, index) => ({
    date: `${2026 + index}-12-31`, status: "forecast",
  }));
  return [...historical, ...forecast];
}

/** A case with a FULL economic surface: debt, an RCF, leases, an acquisition. */
function economicCase(forecastCount = 3) {
  const strip = (method, extra = {}) =>
    Array.from({ length: forecastCount }, () => authority(method, extra));
  return {
    case_id: "p32-scope",
    periods: periods(forecastCount),
    instruments: [
      { instrument_id: "bond_2031", class: "bond_fixed" },
      { instrument_id: "rcf", class: "rcf" },
    ],
    lease_policy: { mode: "flat_replacement", include_in_gross_debt: true },
    rcf_policy: { capacity: 100, instrument_id: "rcf", mode: "balancing_rcf" },
    acquisition: { enabled: 1, acquisition_debt_amount: 250 },
    statement_structure: {
      income_statement: [
        { row_id: "operating_section", row_type: "header", label: "Operating" },
        {
          row_id: "revenue", row_type: "input", values: [10, 11, 12, null, null, null],
          forecast_period_authorities: strip("broker_consensus", {
            value: 13, source_kind: "broker", source_id: "consensus.revenue",
          }),
        },
        {
          row_id: "ebitda", row_type: "calculation",
          calculation: { operator: "sum", refs: ["revenue"] },
          values: [4, 5, 6, null, null, null],
          forecast_period_authorities: strip("accounting_identity"),
        },
        {
          row_id: "interest_expense", row_type: "input", semantic_role: "interest_expense",
          values: [-2, -2, -2, null, null, null],
          forecast_period_authorities: strip("schedule_link"),
        },
      ],
      cash_flow: [
        {
          row_id: "wc_detail", row_type: "input",
          forecast_capture_parent_id: "change_in_working_capital",
          values: [1, 1, 1, null, null, null],
          forecast_period_authorities: strip("not_separately_forecast"),
        },
        {
          row_id: "dividends", row_type: "input", values: [-1, -1, -1, null, null, null],
          forecast_period_authorities: strip("historical_average"),
        },
      ],
    },
  };
}

const STATEMENT_ROWS = 5; // six rows, one of them a header the census skips
const SCHEDULE_DEFINITIONS = 25; // 2 instrument balances + 14 schedule rows + 1 instrument interest + 8 leverage

const key = (cell) => `${cell.section}:${cell.row_id}:${cell.forecast_index}`;
const cellsFor = (census, rowId) => census.cells.filter((cell) => cell.row_id === rowId);
const codes = (census) => census.escalations.map((escalation) => escalation.code);

// ---------------------------------------------------------------------------
// 1. SCOPE — the whole economic surface is enumerated, not just the statements
// ---------------------------------------------------------------------------
{
  const census = compileForecastCompletionCensus(economicCase());
  check(census.status === "PASS", "a complete economic case passes the scoped census");
  check(census.coverage.statement_cells === STATEMENT_ROWS * 3,
    `statement coverage is ${STATEMENT_ROWS} rows x 3 periods, got ${census.coverage.statement_cells}`);
  check(census.coverage.schedule_cells === SCHEDULE_DEFINITIONS * 3,
    `schedule coverage is ${SCHEDULE_DEFINITIONS} definitions x 3 periods, got ${census.coverage.schedule_cells}`);
  check(census.cell_count === census.cells.length &&
    census.cell_count === (STATEMENT_ROWS + SCHEDULE_DEFINITIONS) * 3,
    "the declared cardinality equals the enumeration");
  check(SCHEDULE_FAMILIES.every((family) => (census.coverage.by_family[family] ?? 0) > 0),
    `every schedule family is covered: ${JSON.stringify(census.coverage.by_family)}`);
  for (const rowId of [
    "rcf_draw", "ending_rcf", "liquidity_shortfall", "lease_liability", "lease_interest",
    "acquisition_debt", "gross_interest_expense", "rcf_commitment_fee",
    "instrument.bond_2031.ending_balance", "instrument.bond_2031.interest_expense",
    "net_debt_including_leases_to_adjusted_ebitda",
  ]) {
    check(cellsFor(census, rowId).length === 3,
      `${rowId} is owned by the model and must appear once per forecast period`);
  }
  check(cellsFor(census, "lease_interest")[0].family === "lease" &&
    cellsFor(census, "rcf_commitment_fee")[0].family === "rcf" &&
    cellsFor(census, "instrument.bond_2031.ending_balance")[0].family === "debt",
    "each schedule cell is attributed to the schedule that owns it");
  check(scheduleFamilyOf("net_debt_including_leases", "leverage_liquidity") === "leverage_liquidity" &&
    scheduleFamilyOf("lease_interest", "interest_schedule") === "lease",
    "family attribution reads the region first, so a leverage row is not mistaken for a lease row");
  check(census.cells.filter((cell) => cell.cell_class !== "statement_amount")
    .every((cell) => cell.disposition === "schedule_owned"),
    "every declared-family schedule cell is schedule owned");
  check(verifyForecastCompletionCoverage(economicCase(), census).length === 0,
    "the independently re-derived key set matches the census exactly");
}

// ---------------------------------------------------------------------------
// 2. A DECLARED-ABSENT family is typed not_applicable — never dropped, never
//    zeroed. Missing/blank/nil is never a fabricated zero balance.
// ---------------------------------------------------------------------------
{
  const noExtras = economicCase();
  noExtras.acquisition = { enabled: 0 };
  delete noExtras.lease_policy;
  noExtras.instruments = [{ instrument_id: "bond_2031", class: "bond_fixed" }];
  delete noExtras.rcf_policy;
  const census = compileForecastCompletionCensus(noExtras);
  const families = declaredScheduleFamilies(noExtras);
  check(families.acquisition === false && families.lease === false && families.rcf === false,
    "the case's own declarations decide which families are live");
  const absent = census.cells.filter((cell) => ["acquisition", "lease", "rcf"].includes(cell.family));
  check(absent.length > 0 && absent.every((cell) => cell.disposition === "not_applicable"),
    "an undeclared family is typed not_applicable");
  check(absent.every((cell) => !Object.hasOwn(cell, "value") && cell.ownership_class === "absent"),
    "an absent facility carries no value and no zero — absence is typed, not numeric");
  check(cellsFor(census, "acquisition_debt").length === 3 && cellsFor(census, "ending_rcf").length === 3,
    "an absent family is still ENUMERATED: the cells exist and are accounted for");
  check(census.status === "PASS", "a declared-absent family is a lawful census, not an escalation");
  // The rcf instrument still declares the family even with no policy block.
  const rcfByInstrument = clone(noExtras);
  rcfByInstrument.instruments.push({ instrument_id: "rcf", class: "rcf" });
  check(declaredScheduleFamilies(rcfByInstrument).rcf === true,
    "an RCF instrument declares the family even when the policy block is absent");
}

// ---------------------------------------------------------------------------
// 3. WITNESS — ownership rests on an executable producer, not a method label
// ---------------------------------------------------------------------------
{
  const census = compileForecastCompletionCensus(economicCase());
  check(census.producer_witness_counts.unwitnessed === 0 &&
    census.producer_witness_counts.executable === census.cell_count,
    "every cell in a complete case carries an executable producer witness");
  check(census.cells.every((cell) => cell.producer_witness.producer_id !== null),
    "every witness NAMES its producer");
  const allowedSources = new Set([
    "declared_row_formula", "intrinsic_row_history", "schedule_role_registry",
    "declared_schedule_producer", "instrument_schedule_writer",
    "declared_schedule_region_writer", "declared_absent_family", "declared_absence",
    "authority_value", "row_forecast_column", "tax_rate_normalization_payload",
    "tax_rate_normalization_ref",
  ]);
  check(census.cells.every((cell) => allowedSources.has(cell.producer_witness.binding_source)),
    "every witness binding source comes from the declared vocabulary");
  const scheduleCell = cellsFor(census, "interest_expense")[0];
  check(scheduleCell.producer_witness.producer_id === SCHEDULE_PRODUCER_BY_ROLE.interest_expense &&
    scheduleCell.producer_witness.binding_source === "schedule_role_registry",
    "a schedule-linked statement row is witnessed by its REGISTERED schedule producer");
  const instrumentCell = cellsFor(census, "instrument.bond_2031.ending_balance")[0];
  check(instrumentCell.producer_witness.producer_id === "instrument:bond_2031:ending_balance",
    "an instrument balance is witnessed by the instrument-scoped writer");
  const regionCell = cellsFor(census, "gross_debt_excluding_leases")
    .find((cell) => cell.section === "debt_schedule");
  check(SCHEDULE_REGION_WRITERS.includes("debt_schedule") &&
    regionCell.producer_witness.producer_id === "debt_schedule.gross_debt_excluding_leases",
    "a region cell is witnessed by the DECLARED region writer");
}

// MUTATION: a schedule claim whose producer is not registered anywhere.
{
  const mutated = economicCase();
  mutated.statement_structure.income_statement[3].semantic_role = "interest";
  const census = compileForecastCompletionCensus(mutated);
  check(census.status === "ESCALATE" &&
    codes(census).filter((code) => code === "schedule_claim_without_registered_producer").length === 3,
    "a schedule label with no registered producer escalates every period");
  check(census.escalations[0].row_id === "interest_expense" &&
    census.escalations[0].period_end === "2026-12-31" &&
    /claimed by label only/.test(census.escalations[0].reason),
    "the escalation names the cell, its period date and the label-only claim");
}

// MUTATION: a hardcode usurping a role a schedule producer owns.
{
  const mutated = economicCase();
  mutated.statement_structure.income_statement[3].forecast_period_authorities =
    [0, 1, 2].map(() => authority("user_assumption", { value: -3 }));
  const census = compileForecastCompletionCensus(mutated);
  check(codes(census).filter((code) => code === "schedule_role_usurped_by_direct_claim").length === 3,
    "a direct hardcode over a schedule-owned role is caught as a contradicted claim");
  check(/schedule producer interest_schedule\.interest_expense owns semantic role/.test(
    census.escalations[0].reason), "the escalation names the producer that actually owns the role");
}

// MUTATION: an evidence label with no value anywhere.
{
  const mutated = economicCase();
  for (const entry of mutated.statement_structure.income_statement[1].forecast_period_authorities) {
    delete entry.value;
  }
  const census = compileForecastCompletionCensus(mutated);
  check(codes(census).filter((code) => code === "unwitnessed_ownership_claim").length === 3,
    "direct_evidence_owned with no finite value anywhere is unwitnessed, not owned");
}

// MUTATION: a formula label with no formula and no intrinsic history operator.
{
  const mutated = economicCase();
  mutated.statement_structure.cash_flow[1].forecast_period_authorities =
    [0, 1, 2].map(() => authority("driver_formula"));
  const census = compileForecastCompletionCensus(mutated);
  check(codes(census).filter((code) => code === "unwitnessed_ownership_claim").length === 3,
    "a driver formula with no referencing formula names no producer");
  const intrinsic = compileForecastCompletionCensus(economicCase());
  check(cellsFor(intrinsic, "dividends")[0].producer_witness.binding_source === "intrinsic_row_history",
    "an intrinsic row-history operator IS a producer: the row and the operator reproduce the number");
}

// MUTATION: a policy receipt carried under a schedule label — the witness and
// the label disagree about who computed the cell.
{
  const mutated = economicCase();
  mutated.statement_structure.income_statement[3].forecast_period_authorities =
    [0, 1, 2].map(() => authority("schedule_link", {
      tax_rate_normalization: { policy_id: "tax_rate_policy" },
    }));
  const census = compileForecastCompletionCensus(mutated);
  check(codes(census).includes("witness_kind_contradicts_disposition"),
    "a producer of the wrong KIND for the disposition is a contradiction, not a pass");
}

// ---------------------------------------------------------------------------
// 4. PERIOD SCOPE — derived from the case, never a hard-wired 3
// ---------------------------------------------------------------------------
{
  const four = economicCase(4);
  const scope = forecastPeriodScope(four);
  check(scope.count === 4 && scope.source === "case_periods" && scope.historical_count === 3,
    "the period scope derives from the case's declared periods");
  const census = compileForecastCompletionCensus(four);
  check(census.cell_count === (STATEMENT_ROWS + SCHEDULE_DEFINITIONS) * 4,
    `a four-period case enumerates four columns, got ${census.cell_count}`);
  check(cellsFor(census, "rcf_draw").length === 4 && cellsFor(census, "revenue").length === 4,
    "the fourth period is visible in BOTH halves of the census");
  check(census.cells.every((cell) => cell.period_end === `${2026 + cell.forecast_index}-12-31`),
    "every cell binds its period DATE alongside the period index");
  check(census.status === "PASS", "a four-period case is lawful");

  const stripOnly = economicCase();
  delete stripOnly.periods;
  const stripScope = forecastPeriodScope(stripOnly);
  check(stripScope.count === 3 && stripScope.source === "declared_authority_strip" &&
    stripScope.dates.every((date) => date === null),
    "with no declared periods the scope falls back to the widest authority strip, with null dates");
  check(compileForecastCompletionCensus(stripOnly).status === "PASS",
    "the authority-strip fallback is a lawful census");

  const scopeless = { case_id: "no-scope", statement_structure: {
    income_statement: [{ row_id: "revenue", row_type: "input", values: [1, 2, 3] }], cash_flow: [],
  } };
  const scopelessCensus = compileForecastCompletionCensus(scopeless);
  check(codes(scopelessCensus).includes("undetermined_forecast_period_scope") &&
    scopelessCensus.status === "ESCALATE",
    "a case with material rows and no derivable period scope escalates instead of enumerating nothing");
}

// ---------------------------------------------------------------------------
// 5. INJECTIVITY — one key, one cell
// ---------------------------------------------------------------------------
{
  const duplicateRow = economicCase();
  duplicateRow.statement_structure.income_statement.push(
    clone(duplicateRow.statement_structure.income_statement[1]),
  );
  const census = compileForecastCompletionCensus(duplicateRow);
  check(codes(census).filter((code) => code === "duplicate_census_key").length === 3 &&
    census.status === "ESCALATE",
    "two statement rows with one row_id are two writers of one cell");
  check(verifyForecastCompletionCoverage(duplicateRow, census)
    .some((finding) => /duplicate key/.test(finding)),
    "the coverage verifier independently sees the duplicate");

  const duplicateInstrument = economicCase();
  duplicateInstrument.instruments.push({ instrument_id: "bond_2031", class: "bond_fixed" });
  const instrumentCensus = compileForecastCompletionCensus(duplicateInstrument);
  check(codes(instrumentCensus).filter((code) => code === "duplicate_census_key").length >= 3,
    "a duplicated instrument duplicates its schedule cells and is caught");
}

// ---------------------------------------------------------------------------
// 6. COVERAGE MUTATIONS — a dropped or invented census cell is caught
// ---------------------------------------------------------------------------
{
  const modelCase = economicCase();
  const census = compileForecastCompletionCensus(modelCase);
  const dropped = clone(census);
  const victim = dropped.cells.find((cell) => cell.row_id === "rcf_draw" && cell.forecast_index === 1);
  dropped.cells = dropped.cells.filter((cell) => key(cell) !== key(victim));
  const droppedFindings = verifyForecastCompletionCoverage(modelCase, dropped);
  check(droppedFindings.some((finding) => /missing census cell rcf_waterfall:rcf_draw:1/.test(finding)),
    "a schedule cell dropped from the census is named as missing");
  check(droppedFindings.some((finding) => /declared cell_count/.test(finding)),
    "the dropped cell also breaks the cardinality claim");

  const lease = clone(census);
  lease.cells = lease.cells.filter((cell) => cell.family !== "lease");
  check(verifyForecastCompletionCoverage(modelCase, lease)
    .filter((finding) => /missing census cell/.test(finding)).length === 6,
    "dropping an entire lease family names every missing cell");

  const invented = clone(census);
  invented.cells.push({ ...victim, row_id: "phantom_row" });
  invented.cell_count = invented.cells.length;
  check(verifyForecastCompletionCoverage(modelCase, invented)
    .some((finding) => /unexpected census cell rcf_waterfall:phantom_row:1/.test(finding)),
    "a cell the case does not own is named as unexpected");

  const lied = clone(census);
  lied.cell_count = 18;
  check(verifyForecastCompletionCoverage(modelCase, lied)
    .some((finding) => /declared cell_count 18/.test(finding)),
    "a cardinality literal that disagrees with the enumeration is caught");
}

// ---------------------------------------------------------------------------
// 7. PARITY — the receipt is VERIFIED after Build, not merely sealed before it
// ---------------------------------------------------------------------------
{
  const modelCase = economicCase();
  const receipt = sealEconomicStageParity(modelCase);
  check(/^[0-9a-f]{64}$/.test(receipt.receipt_sha256) &&
    receipt.completion_cell_count === (STATEMENT_ROWS + SCHEDULE_DEFINITIONS) * 3 &&
    receipt.completion_period_count === 3 &&
    receipt.completion_schedule_cells === SCHEDULE_DEFINITIONS * 3,
    "the parity receipt binds the census cardinality, period count and schedule coverage");
  const verdict = verifyEconomicStageParityAfterBuild(modelCase, receipt);
  check(verdict.status === "PASS" && verdict.errors.length === 0 &&
    verdict.verified_at_stage === "post_build",
    "the sealed graph re-verifies against the case Build consumed");

  const familyRemoved = clone(modelCase);
  familyRemoved.instruments = familyRemoved.instruments.filter(
    (instrument) => instrument.class !== "rcf",
  );
  delete familyRemoved.rcf_policy;
  const removedVerdict = verifyEconomicStageParityAfterBuild(familyRemoved, receipt);
  check(removedVerdict.status === "PARITY_BROKEN" &&
    removedVerdict.errors.some((error) => /completion_census_sha256/.test(error)),
    "a schedule family that disappeared between the seal and Build breaks parity");

  const periodAdded = economicCase(4);
  const addedVerdict = verifyEconomicStageParityAfterBuild(periodAdded, receipt);
  check(addedVerdict.errors.some((error) => /period_count 4 != sealed 3/.test(error)) &&
    addedVerdict.errors.some((error) => /cell_count/.test(error)),
    "a forecast period added after the seal breaks parity by name");

  const tampered = clone(receipt);
  tampered.completion_census_sha256 = "0".repeat(64);
  check(verifyEconomicStageParityAfterBuild(modelCase, tampered).errors
    .some((error) => /receipt:receipt_sha256/.test(error)),
    "a tampered receipt fails its own integrity check");

  const relabelled = clone(modelCase);
  relabelled.statement_structure.cash_flow[1].forecast_period_authorities[0] =
    authority("unresolved");
  const brokenVerdict = verifyEconomicStageParityAfterBuild(relabelled, receipt);
  check(brokenVerdict.errors.some((error) => /census:status=ESCALATE/.test(error)),
    "an ownership repaired away after the seal is caught by the post-Build census");

  let thrown = null;
  try { assertEconomicStageParityAfterBuild(relabelled, receipt); } catch (error) { thrown = error; }
  check(thrown !== null &&
    thrown.typed_internal_outcome?.reason_code === "INTERNAL.forecast_completion_escalated" &&
    thrown.typed_internal_outcome.downstream_invalidation_scope === "workbook_build_and_below",
    "the fail-closed post-Build assertion throws a TYPED internal outcome, not a bare stack");
  check(assertEconomicStageParityAfterBuild(modelCase, receipt).status === "PASS",
    "the fail-closed assertion returns the verdict when parity holds");
}

// ---------------------------------------------------------------------------
// 8. DETERMINISM — the census hash moves only when the economics move
// ---------------------------------------------------------------------------
{
  const first = compileForecastCompletionCensus(economicCase());
  const second = compileForecastCompletionCensus(economicCase());
  check(first.census_sha256 === second.census_sha256, "the census is deterministic");
  const flipped = economicCase();
  flipped.acquisition = { enabled: 0 };
  const flippedCensus = compileForecastCompletionCensus(flipped);
  check(flippedCensus.census_sha256 !== first.census_sha256 &&
    flippedCensus.disposition_counts.not_applicable === 3,
    "disabling the acquisition moves the census hash and retypes exactly its three cells");
}

console.log(JSON.stringify({ status: "PASS", checks }));
