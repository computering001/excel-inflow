#!/usr/bin/env node
/**
 * P7.10 — two invariants, one suite.
 *
 *   INVARIANT 1 (never-zero). An absent value stays absent. No path may mint a
 *   number for a row that carried none, and a header that declares no values
 *   must not acquire one.
 *
 *   INVARIANT 2 (order-independence). A residual is a function of its inputs.
 *   Two accumulations of the same set must produce the same result.
 *
 * INVARIANT 2 is REPAIRED here (D32 / MG-5) and proved green below: the
 * opening-debt bridge and the opening instrument register now accumulate
 * through scripts/lib/canonical_sum.mjs, whose order-invariance is a proof
 * (see that file's header) and is exercised here by shuffling.
 *
 * INVARIANT 1 is NOT repaired here (D31 / MG-4). Its only mint site is
 * scripts/lib/solver.mjs, which this work package is forbidden to edit. What
 * this suite carries instead is a REPRODUCTION LOCK: the defect's exact
 * present extent, pinned so it cannot silently widen, plus the asymmetry that
 * explains where the coercion sits. Each lock names its own retirement
 * condition — when solver.mjs stops minting, these checks fail loudly and must
 * be replaced by the closure assertions written in their comments, NOT deleted.
 *
 * Emits one line: {"status":"PASS","checks":N}
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalAddendOrder,
  canonicalSum,
  compareCanonicalAddend,
} from "./lib/canonical_sum.mjs";
import { compileOpeningDebtBridge } from "./lib/opening_debt_bridge.mjs";
import { compileOpeningInstrumentState } from "./lib/instrument_period_state.mjs";
import { normaliseStatementRows } from "./lib/row_plan.mjs";
import { resolveForecastAuthority } from "./lib/forecast_authority.mjs";
import { solveCase } from "./lib/solver.mjs";
import {
  NEVER_ZERO_STATES,
  VALUE_BEARING_STATES,
} from "./lib/typed_financial_value.mjs";
import {
  applyTransform,
  buildMetamorphicCohort,
} from "./lib/metamorphic_relations.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARCHETYPES = path.join(ROOT, "test-fixtures", "archetypes", "economics");

let checks = 0;
function check(description, fn) {
  try {
    fn();
  } catch (error) {
    console.error(`FAIL ${description}\n${error?.stack ?? error}`);
    process.exit(1);
  }
  checks += 1;
}

const clone = (value) => structuredClone(value);
const readArchetype = (name) =>
  JSON.parse(fs.readFileSync(path.join(ARCHETYPES, name), "utf8"));

/** Deterministic PRNG — a shuffle proof that cannot be reproduced is no proof. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// INVARIANT 2 — canonical_sum.mjs: the accumulator itself
// ---------------------------------------------------------------------------

check("canonicalSum is bit-identical over 500 shuffles of an adversarial multiset", () => {
  // Magnitudes spanning ~16 decades: exactly the regime where associativity
  // fails. A naive left fold over these permutations spreads over many ULPs.
  const addends = [
    1e16, -1e16, 1.0, 0.1, 0.2, 0.3, -0.7, 1e-16, -1e-16, 1234.5678,
    -1234.5677, 9.87e-9, 3.3333333333333335, -3.3333333333333330, 5e15, -5e15,
  ];
  const canonical = canonicalSum(addends);
  const naive = new Set();
  const random = mulberry32(700577);
  for (let trial = 0; trial < 500; trial += 1) {
    const permutation = shuffled(addends, random);
    assert.ok(
      Object.is(canonicalSum(permutation), canonical),
      `canonicalSum moved under permutation ${trial}`,
    );
    naive.add(permutation.reduce((total, value) => total + value, 0));
  }
  assert.ok(
    naive.size > 1,
    "the multiset is not adversarial enough — a naive fold must disagree with itself, " +
      "otherwise this check would pass vacuously",
  );
});

check("canonicalSum's order is a pure function of the values, not of arrival", () => {
  const values = [3, -1, 2.5, -1, 0, 7];
  const random = mulberry32(11);
  const reference = canonicalAddendOrder(values);
  for (let trial = 0; trial < 100; trial += 1) {
    assert.deepEqual(canonicalAddendOrder(shuffled(values, random)), reference);
  }
});

check("the comparator's equality class holds only BIT-IDENTICAL doubles", () => {
  // This is the load-bearing clause of the invariance proof: if two distinct
  // bit patterns ever compared equal, the sorted sequence would stop being
  // unique and order-invariance would not follow.
  assert.equal(compareCanonicalAddend(-0, 0), -1);
  assert.equal(compareCanonicalAddend(0, -0), 1);
  assert.equal(compareCanonicalAddend(0, 0), 0);
  assert.equal(compareCanonicalAddend(-0, -0), 0);
  assert.equal(compareCanonicalAddend(1, 2), -1);
  assert.equal(compareCanonicalAddend(2, 1), 1);
  // NaN is pinned to a fixed end so the order stays total.
  assert.equal(compareCanonicalAddend(NaN, 1), 1);
  assert.equal(compareCanonicalAddend(1, NaN), -1);
  assert.equal(compareCanonicalAddend(NaN, NaN), 0);
  assert.ok(Number.isNaN(canonicalSum([1, NaN, 2])));
});

check("canonicalSum REFUSES a non-number addend rather than coercing it to zero", () => {
  // Invariant 1 defends invariant 2's entry point: an order-invariant sum that
  // silently reads absent as 0 would just be a deterministic never-zero bug.
  for (const absent of [null, undefined, "", " ", false, [], {}, "12"]) {
    assert.throws(
      () => canonicalSum([1, absent, 2], "test addend"),
      /never coerced to zero/,
      `canonicalSum accepted ${JSON.stringify(absent)}`,
    );
  }
  assert.equal(canonicalSum([]), 0, "an EMPTY multiset legitimately sums to 0");
});

// ---------------------------------------------------------------------------
// INVARIANT 2 — D32 / MG-5 at the defect's own reproducing seed
// ---------------------------------------------------------------------------

const cohort = buildMetamorphicCohort({ solve: solveCase, rootSeed: 700577, count: 1 });
const seed700577 = [...cohort.refused, ...cohort.solvable][0] ?? null;

check("D32 red proof is now green: seed 700577's residual survives 200 register shuffles", () => {
  assert.ok(seed700577, "seed 700577 could not be generated — the proof cannot run");
  const baseline = compileOpeningDebtBridge(clone(seed700577.model_case));
  assert.ok(
    Array.isArray(seed700577.model_case.instruments) &&
      seed700577.model_case.instruments.length > 1,
    "a single-instrument register cannot prove order-independence",
  );
  const random = mulberry32(4577);
  const residuals = new Set();
  const totals = new Set();
  for (let trial = 0; trial < 200; trial += 1) {
    const permuted = clone(seed700577.model_case);
    permuted.instruments = shuffled(permuted.instruments, random);
    const bridge = compileOpeningDebtBridge(permuted);
    residuals.add(bridge.totals.unexplained_residual);
    totals.add(bridge.totals.identified_instrument_total);
  }
  assert.deepEqual([...residuals], [baseline.totals.unexplained_residual]);
  assert.deepEqual([...totals], [baseline.totals.identified_instrument_total]);
  // The registered value, unchanged by the repair: the fix canonicalises the
  // order, it does NOT round to the tolerance.
  assert.equal(baseline.totals.unexplained_residual, -943.56);
  assert.equal(baseline.tolerance, 0.01);
});

check("D32: the reversal that originally reproduced MG-5 no longer moves the refusal", () => {
  assert.ok(seed700577);
  const asFiled = clone(seed700577.model_case);
  const reordered = applyTransform("row_reorder_instruments", clone(seed700577.model_case));
  const verdict = (modelCase) => {
    try {
      solveCase(clone(modelCase));
      return "__solved__";
    } catch (error) {
      return String(error?.message ?? error).split("\n")[0];
    }
  };
  const before = verdict(asFiled);
  assert.match(before, /OPENING_DEBT_UNRESOLVED/);
  assert.match(before, /-943\.56 USD unexplained/);
  assert.equal(
    verdict(reordered),
    before,
    "the refusal text must be BYTE-identical under a register permutation",
  );
});

check("D32 sibling lock: the opening register's reporting_total is STILL order-dependent", () => {
  // A FOURTH site of the same class, found by this package's sweep and NOT
  // registered anywhere: instrument_period_state.mjs's `reporting_total`
  // reduces `rows.filter(include_in_gross_debt).map(reporting_amount)` in
  // register order. It sums the SAME multiset the bridge does, so it drifts on
  // the same seeds (700563, 700569, 700577 of the 700560+24 cohort).
  //
  // It is deliberately NOT repaired here. Routing it through canonicalSum is a
  // two-line change and it works — but it moves a MAINTAINED FIXTURE value in
  // its last place (run_opening_instrument_provenance_tests.mjs:563 asserts
  // reporting_total === 9335.506; canonical order yields 9335.505999999998).
  // Moving a maintained number to make a repair land is out of this package's
  // authority, so the drift is locked here and reported instead.
  //
  // RETIREMENT: when reporting_total is canonicalised (and the fixture figure
  // is re-agreed by its owner), `drifted` becomes 0, this check fails, and it
  // should be inverted to assert order-invariance.
  const wide = buildMetamorphicCohort({ solve: solveCase, rootSeed: 700560, count: 24 });
  let checked = 0;
  const drifted = [];
  for (const item of [...wide.refused, ...wide.solvable]) {
    const instruments = item.model_case.instruments;
    if (!Array.isArray(instruments) || instruments.length < 2) continue;
    const baseline = compileOpeningInstrumentState(clone(item.model_case));
    if (baseline.status !== "PASS") continue;
    const reversed = clone(item.model_case);
    reversed.instruments = [...instruments].reverse();
    checked += 1;
    if (!Object.is(compileOpeningInstrumentState(reversed).reporting_total, baseline.reporting_total)) {
      drifted.push(item.seed);
    }
  }
  assert.ok(checked >= 10, `only ${checked} multi-instrument registers inspected`);
  assert.deepEqual(drifted, [700563, 700569, 700577], "the sibling drift set has CHANGED");
});

check("D32: order-invariance holds across a 24-seed cohort, not just the registered seed", () => {
  const wide = buildMetamorphicCohort({ solve: solveCase, rootSeed: 700560, count: 24 });
  assert.equal(wide.present, true);
  const random = mulberry32(2026);
  let exercised = 0;
  for (const item of [...wide.refused, ...wide.solvable]) {
    const instruments = item.model_case.instruments;
    if (!Array.isArray(instruments) || instruments.length < 2) continue;
    const baseline = compileOpeningDebtBridge(clone(item.model_case));
    if (baseline.totals.unexplained_residual === null) continue;
    for (let trial = 0; trial < 8; trial += 1) {
      const permuted = clone(item.model_case);
      permuted.instruments = shuffled(permuted.instruments, random);
      assert.ok(
        Object.is(
          compileOpeningDebtBridge(permuted).totals.unexplained_residual,
          baseline.totals.unexplained_residual,
        ),
        `seed ${item.seed} residual moved under permutation ${trial}`,
      );
    }
    exercised += 1;
  }
  assert.ok(exercised >= 10, `only ${exercised} multi-instrument cases exercised`);
});

// ---------------------------------------------------------------------------
// INVARIANT 1 — D31 / MG-4 reproduction locks (NOT repaired; solver.mjs is
// forbidden to this package). Each lock names its retirement condition.
// ---------------------------------------------------------------------------

check("the typed value model still names the state a presentation-only row belongs in", () => {
  // The repair for D31 is to keep an absent header value in its correct typed
  // state — `not_applicable` — not to substitute a different number or invent
  // a sentinel. This check exists so a future repair has a named target and so
  // the 12 states cannot quietly shrink underneath it.
  assert.equal(VALUE_BEARING_STATES.length + NEVER_ZERO_STATES.length, 12);
  assert.ok(NEVER_ZERO_STATES.includes("not_applicable"));
  assert.ok(!VALUE_BEARING_STATES.includes("not_applicable"));
});

check("D31 red proof: a presentation-only header is minted into statement_values as 0", () => {
  // Wider than the register states: this reproduces on the UNTRANSFORMED
  // archetype. `adjusted_ebitda_bridge` is a header the income-statement
  // normaliser INSERTS, so the defect is present in the baseline solve and the
  // metamorphic transform merely made it visible as a delta.
  //
  // RETIREMENT: when solver.mjs stops materialising presentation-only rows,
  // this check fails. Replace its body with the closure assertion —
  //   assert.equal("adjusted_ebitda_bridge" in values, false)
  // — do not delete it.
  const source = readArchetype("non_controlling_interests.json");
  const solved = solveCase(clone(source));
  const values = solved.forecast[0].statement_values;
  const rows = [
    ...normaliseStatementRows(clone(source), "income_statement"),
    ...normaliseStatementRows(clone(source), "cash_flow"),
  ];
  const headers = rows.filter((row) => row.row_type === "header");
  assert.ok(headers.length > 0, "the archetype carries no header row to test");
  for (const header of headers) {
    assert.equal(header.values, undefined, `${header.row_id} declares no values`);
    const authority = resolveForecastAuthority(clone(source), header, 0);
    assert.equal(authority.mechanism, "uncalculated");
    assert.equal(authority.value, null, "the authority itself resolves NO number");
    assert.equal(authority.declared_value, null);
    // ...and yet:
    assert.equal(
      values[header.row_id],
      0,
      `${header.row_id} is minted with ${values[header.row_id]}`,
    );
    assert.equal(typeof values[header.row_id], "number");
  }
});

check("D31 asymmetry: the mint is universal; only header SURVIVAL is asymmetric", () => {
  // The registered reproduction says "the LEADING header appears and the
  // trailing one does not". That is true of the income statement and FALSE of
  // the cash flow, and the difference is not in the coercion at all:
  //
  //   income_statement runs projectIncomeStatementToDebtOverlay, which splits
  //   everything AFTER net income into header-led blocks and drops any block
  //   holding no required row. The trailing header is a block of one header
  //   and no required rows, so it is pruned before the solver ever sees it.
  //   The leading header sits in the un-pruned slice at or before net income.
  //   cash_flow runs no such projection, so BOTH its headers survive — and
  //   both are minted.
  //
  // So survival is asymmetric, minting is not: every header that reaches the
  // solver's statement graph gets a 0. RETIREMENT: same as the check above.
  const source = readArchetype("non_controlling_interests.json");
  const transformed = applyTransform("repeated_header", clone(source));

  const declared = Object.values(transformed.statement_structure)
    .filter(Array.isArray)
    .flat()
    .filter((row) => String(row?.row_id ?? "").startsWith("hdr."))
    .map((row) => row.row_id);
  assert.deepEqual(declared.sort(), [
    "hdr.cash-flow",
    "hdr.cash-flow-repeat",
    "hdr.income-statement",
    "hdr.income-statement-repeat",
  ]);

  const survivingIncome = normaliseStatementRows(clone(transformed), "income_statement")
    .map((row) => row.row_id);
  const survivingCash = normaliseStatementRows(clone(transformed), "cash_flow")
    .map((row) => row.row_id);
  assert.ok(survivingIncome.includes("hdr.income-statement"), "leading IS header survives");
  assert.equal(
    survivingIncome.includes("hdr.income-statement-repeat"),
    false,
    "the trailing income-statement header is PRUNED by the debt-overlay projection",
  );
  assert.ok(survivingCash.includes("hdr.cash-flow"), "leading CF header survives");
  assert.ok(
    survivingCash.includes("hdr.cash-flow-repeat"),
    "the trailing CASH-FLOW header survives — so 'trailing headers vanish' is not the rule",
  );

  const values = solveCase(clone(transformed)).forecast[0].statement_values;
  const minted = Object.keys(values).filter((key) => key.startsWith("hdr.")).sort();
  assert.deepEqual(minted, ["hdr.cash-flow", "hdr.cash-flow-repeat", "hdr.income-statement"]);
  // Every SURVIVING header is minted; none escapes. The mint is universal.
  for (const rowId of [...survivingIncome, ...survivingCash]) {
    const row = [
      ...normaliseStatementRows(clone(transformed), "income_statement"),
      ...normaliseStatementRows(clone(transformed), "cash_flow"),
    ].find((candidate) => candidate.row_id === rowId);
    if (row?.row_type !== "header") continue;
    assert.equal(values[rowId], 0, `surviving header ${rowId} escaped the mint`);
  }
});

check("D31 extent lock: EVERY header that reaches the solver is minted; none escapes", () => {
  // Pins the CLASS across the whole solvable archetype corpus and the
  // generated cohort. The claim is not "some headers are minted" — it is that
  // the escape rate is exactly ZERO, which is what makes this a structural
  // coercion in the solver rather than an archetype quirk.
  //
  // RETIREMENT: when the mint is closed, `minted` drops to 0 and this check
  // fails. Replace `minted > 0` with `minted === 0` and keep `escaped === 0`
  // — that pair is the closure assertion. Do not delete the check.
  const sources = fs
    .readdirSync(ARCHETYPES)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ id: name, model_case: readArchetype(name) }));
  const generated = buildMetamorphicCohort({ solve: solveCase, rootSeed: 700560, count: 24 });
  for (const item of generated.solvable) {
    sources.push({ id: `seed_${item.seed}`, model_case: item.model_case });
  }

  let inspected = 0;
  let minted = 0;
  const escaped = [];
  for (const { id, model_case: source } of sources) {
    let solved;
    try {
      solved = solveCase(clone(source));
    } catch {
      continue; // a refused case produces no statement_values
    }
    const rows = [
      ...normaliseStatementRows(clone(source), "income_statement"),
      ...normaliseStatementRows(clone(source), "cash_flow"),
    ];
    const values = solved.forecast[0]?.statement_values ?? {};
    for (const row of rows) {
      if (row.row_type !== "header") continue;
      if (row.values !== undefined) continue; // declares values: out of scope
      inspected += 1;
      if (values[row.row_id] === 0) minted += 1;
      else escaped.push(`${id}/${row.row_id}=${JSON.stringify(values[row.row_id])}`);
    }
  }
  assert.ok(inspected > 0, "no valueless header row reached the solver at all");
  assert.deepEqual(escaped, [], "a header escaped the mint — the extent has CHANGED");
  assert.ok(minted > 0, `expected the mint to still reproduce; ${inspected} inspected`);
  assert.equal(minted, inspected, "the mint is universal over valueless headers");
});

console.log(JSON.stringify({ status: "PASS", checks }));
