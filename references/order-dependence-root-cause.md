# Order-dependence root cause — the opening-register accumulation (E9)

Audit §5.3 demanded the MECHANISM behind the never-zero-and-order-invariance
suite's pins, not the pins themselves. This document is that mechanism: where
order entered, which operation first produced different outputs, why
canonicalisation (not declared semantics) is the correct closure, and what
same-class work remains deliberately open.

Status after E9: **closed by canonicalisation** for every site that feeds the
suite's assertions. The suite's sibling-drift assertion now expects `[]`, and
the invariant is structural rather than observational.

---

## 1. The defect class

IEEE-754 double addition is not associative: for doubles,
`(a + b) + c` and `a + (b + c)` can differ in the last place, because each
operation rounds its own intermediate result to the nearest representable
double. Any accumulation that walks its addends **in the order the input
happened to list them** therefore computes a result that is a function of the
input's *order*, not of its *value* — a residual that is not a function of its
inputs cannot be reproduced, bisected, or safely re-toleranced.

The opening-debt boundary had four sites of this class:

| # | Site | Status |
|---|------|--------|
| 1 | `scripts/lib/solver.mjs` refusal-path residual (D32/MG-5) | repaired P7.9/P7.10 via `canonical_sum.mjs` |
| 2 | `compileOpeningDebtBridge` totals (`scripts/lib/opening_debt_bridge.mjs:193-197`) | repaired P7.10 (`canonicalSum`) |
| 3 | `compileOpeningInstrumentState().reporting_total` (`scripts/lib/instrument_period_state.mjs:469`) | **repaired E9** (was a naive left fold in register order) |
| 4 | `replayOpeningInstrumentSelection()` replayed total (`scripts/lib/opening_instrument_provenance.mjs:362`) | **repaired E9** (same fold, lockstep) |

Sites 3 and 4 were held open by the "D32 sibling lock"
(`run_never_zero_and_order_invariance_tests.mjs`) pending authority to move a
maintained fixture figure. E9 supplies the mechanism, the repair, and the
re-agreement (§5).

## 2. Differential instrumentation (method)

A scratch harness rebuilt the suite's cases through
`buildMetamorphicCohort({ solveCase, rootSeed })`, compiled
`compileOpeningInstrumentState` under **200 register permutations per case**
(Fisher-Yates over `model_case.instruments`, deterministic `mulberry32`),
and recorded, per permutation:

- every selected row's `reporting_amount` keyed by `instrument_id`
  (per-instrument contribution);
- the full trace of the accumulation: `(running_before, addend, running_after)`
  per operation, ending in the final `reporting_total`;
- IEEE-754 bit patterns (`Buffer.writeDoubleBE`) for every recorded total.

Two runs whose final totals differ were then aligned operation-by-operation to
locate the first operation at which their running totals part company and never
re-converge.

## 3. Findings

### 3.1 Seed 700577 (the registered case) — clean today, mechanism latent

mp-L's archetype expansion changed this case's generator set: the register is
now 3 instruments (`local_bond` 300 × 1.0; `gen_02_other_explicit` 444.6 ×
1.09 = 484.61400000000003; `gen_03_commercial_paper` 454.5 × 1.0), and its
`reporting_total` is bit-stable across all 200 permutations (1239.114,
`40935c74bc6a7efa`). Its pinned refusal residual −939.114 comes from the
BRIDGE, which has accumulated through `canonicalSum` since P7.10
(`opening_debt_bridge.mjs:193-197`) — so the pin the audit asks about is
already structural. What remained unpinned was the register's own
`reporting_total`, exposed below on the live cohort.

### 3.2 Per-instrument contributions are permutation-invariant — the sum is the only order-dependent step

Across every probed case and all 200 permutations, each instrument's
`reporting_amount` never moved (basis amount × translation rate is computed
per candidate at its own ordinal, `instrument_period_state.mjs:357-462`; the
duplicate-id guard and typed-rejection register affect membership and blame,
never amounts). **Every observed divergence therefore enters at the fold**,
`reporting_total`'s `reduce((total, row) => total + row.reporting_amount, 0)`
— nowhere upstream.

### 3.3 The live drift cohort and the first divergent operation

Three registers in the 700560+24 cohort still drifted at E9's start
(`700563, 700569, 700579` — the mp-L-expanded successor of the set the
DEFECT_REGISTER recorded as `700563, 700569, 700577`). Measured traces:

- **700563**, addends `{500, 788.397, 214.6}` (register order):
  - register order: `(500 + 788.397) + 214.6` → `1288.397 + 214.6` =
    **1502.9969999999998** (`40977bfced916872`)
  - reversed / canonical ascending: `(214.6 + 500) + 788.397` →
    `714.6 + 788.397` = **1502.997** (`40977bfced916873`)
  - Exactly **one ULP** apart. Both orders add the same three doubles; the
    outputs diverge at the **final addition**: the register-order execution
    presents the left operand `1288.397` (an intermediate rounded low),
    the canonical execution presents `714.6`, and the two operations round to
    adjacent doubles. There is no earlier divergence: the preceding partial
    sums are simply different subsets, and the final addition is the first
    operation whose two possible outcomes differ.
- **700579**, addends `{500, 619.9, 67.2}`: `(500 + 619.9) + 67.2` =
  **1187.1000000000001** vs `687.1 + 500` = **1187.1** — again one ULP,
  decided entirely by which left operand the final addition receives
  (`1119.9` vs `687.1`).
- **700569**, nine addends: 200 shuffles produced **three** distinct totals
  (`7147.594`, `7147.594000000001`, `7147.594000000002`) — the classic
  random-walk of accumulated last-place roundings under magnitude-spread
  absorption.

### 3.4 Hypotheses eliminated

| Hypothesis | Verdict |
| --- | --- |
| Float-addition non-associativity | **CONFIRMED** — minimal n=3 reproductions above; associativity identity fails by exactly 1 ULP on the live multisets. |
| Map iteration order | Ruled out — no Map participates in the accumulation path; rows are an array built by an ordinal-indexed `for` loop (`instrument_period_state.mjs:357`); contributions empirically invariant (§3.2). |
| First-match selection | Ruled out — selection is per-candidate at its own register position (`openingInstrumentCandidateRecord`); empirical invariance of per-row values confirms. |
| Sort instability | Ruled out — no sort exists upstream of the fold. Inside `canonical_sum.mjs` the comparator's equality class holds only bit-identical doubles (`canonical_sum.mjs:48-62`), whose additions commute, so tie order provably cannot move a sum (proof at `canonical_sum.mjs:17-33`). |

## 4. Decision: CANONICALISE, do not declare

Declared semantics would require the contract to say "register order is
significant to the penny of every opening total". Nothing does: rows are keyed
by `instrument_id`, inclusion is a per-row predicate, the provenance layer's
whole purpose is that the selection replays from recorded facts alone, and the
metamorphic family `row_reorder_instruments` asserts economics-preserving
behaviour under permutation. An order-defined total contradicts the module's
own validator. Meanwhile the divergence is plain non-associativity on a
summation — exactly the case the mandate names for canonicalisation.

The repository already owns the tool and its proof:
`canonical_sum.mjs` sorts addends under a total order derived only from the
values and folds left from +0, making the result a function of the multiset
alone. E9 routes both remaining sites through it:

- `instrument_period_state.mjs:469` — `reporting_total` now
  `canonicalSum(rows.filter(include_in_gross_debt).map(reporting_amount))`.
- `opening_instrument_provenance.mjs:362` — the REPLAYED total accumulates in
  the same canonical order. This lockstep is load-bearing:
  `run_opening_instrument_provenance_tests.mjs` asserts
  `replay.reporting_total === compiled.reporting_total` by exact equality, so
  repairing only one site would trade an order-dependent number for an
  internal disagreement.

## 5. The maintained fixture, re-agreed toward exactness

The reason the sibling lock existed: canonicalising moves
`standard-maximal-v2`'s `reporting_total` in its last place,
`9335.505999999998` → `9335.506`. E9 measured the direction and found it is a
re-agreement, not a drift:

- the fixture itself declares `"reported_opening_gross_debt": 9335.506`
  (`test-fixtures/cases/standard-maximal-v2.json:4285`);
- the bridge's canonical `explained_total` already equals `9335.506`
  (bisected and certified in `run_scale_invariant_convergence_tests.mjs`,
  comment block "RE-PINNED 2026-08-20");
- only the naive register-order fold produced `…5998`.

Canonicalisation therefore removes a standing inconsistency between the
register total, the declared figure, and the bridge, moving the maintained pin
TO the declared value. The pin
(`run_opening_instrument_provenance_tests.mjs`, "the maintained fixture
opening totals are pinned") is updated accordingly, with provenance in its
comment. `standard-net-cash-v2` (80.0) is unaffected.

Note the general effect measured across the cohort: canonicalisation also
moves the published total of currently NON-drifting registers
(e.g. seeds 700566, 700571, 700572, 700582 shift one ULP toward the canonically
ordered sum). No consumer of `reporting_total` compares it by exact equality
against an independently computed naive fold except the replay pair repaired in
lockstep; gate consumers (`coverage.mjs`, `release_nodes.mjs`,
`run_opening_debt_reconciliation_tests.mjs`' 310/270 pins) use tolerance or
clean sums and are verified green.

## 6. Declared-open remainder (same class, out of E9's authority)

Two further naive folds exist in `instrument_period_state.mjs` and ARE consumed
by the solver:

- `mandatoryRepaymentForPeriod` (`instrument_period_state.mjs:1074-1087`,
  called at `solver.mjs:3458`);
- the definition-basis sums `grossExcludingLeases` / `leaseLiabilities` /
  `leverageDebt` (`instrument_period_state.mjs:1117-1146`, called at
  `solver.mjs:3945`).

They are latent-hazard sites of the identical class (no drift is manifest on
the current corpus — the metamorphic refusal plane compares refusals exactly
and passes). Canonicalising them changes SOLVER-EMITTED economics in the last
place on some inputs, which moves the certified economic signatures pinned in
`run_scale_invariant_convergence_tests.mjs`. Re-certifying those signatures is
coordinator authority, so this repair is DECLARED OPEN here with its exact
prescription (route the three folds through `canonicalSum`, bisect and
diff field-by-field, re-certify both fixtures' signatures), matching the
repository's lock-and-name discipline. They are reachable only through the
period-state artifact whose states follow register order, so the exposure is
real whenever a future corpus widens magnitude spreads.

## 7. Verification receipts (post-E9)

- `run_never_zero_and_order_invariance_tests.mjs` — PASS, run 3× consecutively;
  the inverted D36 check now asserts register reversal moves `reporting_total`
  on NO register in the 24-seed cohort, and stays non-vacuous by requiring ≥1
  multiset a naive fold would still drift (proving a regression remains
  detectable) plus the bit-exact compiled-vs-replay pin in the provenance suite.
- `run_metamorphic_tests.mjs` — PASS (exact refusal-plane comparisons intact).
- `run_opening_instrument_provenance_tests.mjs`,
  `run_opening_debt_bridge_tests.mjs`, `run_opening_amount_typing_defect_tests.mjs`,
  `run_opening_debt_reconciliation_tests.mjs`,
  `run_scale_invariant_convergence_tests.mjs` — PASS.
