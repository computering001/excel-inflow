# Defect register — found by archetype breadth testing (P7.1c wave, 2026-08-19)

Every entry below was found by a synthetic archetype case, is reproducible, and is
NOT yet fixed. Each needs its own package with a failing proof first. Ordered by
real-world severity. Anchors verified at f412160.

## D1 — the standard IFRS 15 revenue caption cannot classify (SEVERITY: HIGH)
`Revenue from contracts with customers` classifies as `unmapped`: top candidates
`cost_of_sales` and `revenue` TIE at 0.51/0.51, margin 0.00. Acceptance requires a
>=0.15 separation margin, so **a tie is structurally unbreakable** — no amount of
structural, numeric or hierarchy evidence can separate it. `Group revenue` fails
identically. Consequence: the most common modern IFRS revenue caption always forces
a clarification stop on a real filing.
Owner surface: scripts/lib/statement_classifier.mjs (scoring + margin rule) and the
role alias table in scripts/lib/semantic_roles.mjs.
Fix shape (proposal, not yet decided): a tie between a family-parent role and a
family-member role is not a genuine ambiguity — the parent should win when the row's
structural position is the family head. Alternatively add the caption to the alias
table. EITHER WAY the repair must not lower the 0.15 margin (that would weaken the
validator); it must break the tie on evidence.

## D2 — "Net revenues" leads with net_income (SEVERITY: HIGH)
The `net` token pulls the top line toward the bottom line: sole leading candidate
`net_income` at 0.44. A near-miss that would silently mis-anchor an entire model
rather than refusing. Same owner surface as D1.

## D3 — one-word variant of the standard IFRS cash-flow subtotal becomes a 3-way tie (SEVERITY: HIGH)
`Net cash generated from operating activities` ties at 0.72 across
`cash_from_financing` / `cash_from_investing` / `cash_from_operations` (margin 0.00),
while the aliased `Net cash from operating activities` accepts at 0.95. The WRONG
sections tie with the right one. Same owner surface as D1.

## D4 — the taxonomy has no direct-method roles, but the envelope claims direct-method support
assets/statement-semantic-taxonomy.v1.json declares 46 roles, NONE for gross
operating receipts/payments; assets/support-envelope-v377.json nonetheless classifies
`cash_flow_method: direct` as EXPERIMENTAL (a supported value, runnable in a ring).
Every direct-method operating line is therefore unmapped and material-blocking.
Fix: either add the roles (taxonomy work) or demote the envelope claim. This is the
same claim-vs-evidence dishonesty class P7.1a's grid measures.

## D5 — two footing oracles disagree on identical printed figures
scripts/lib/model_ir_v3.mjs:508 `footingTolerance` documents itself as mirroring
`case_compiler.sourceTolerance`, but case_compiler.mjs:176 returns EXACTLY 0 with no
declared precision while footingTolerance adds `1e-9 * max(1,|target|) + 1e-12`.
Proven: members 12.3 + 45.6 vs printed 57.9, no declared precision →
`sourceHistoricalSumMatches` FALSE but `compileModelIrV3` PASS with 0 findings.
Fix: one tolerance function, one home, both callers consuming it.

## D6 — a printed dash left ABSENT escapes the footing pass entirely
`filedNumber(null)` skips the period ("a filed dash asserts nothing"). Proven: total
`[null,null,null]` vs members summing to 30 → PASS, 0 findings; the same dash
classified `reported_zero` → BLOCK on all three periods. The never-zero invariant
correctly stops absence becoming zero, but NOTHING forces a printed dash to be
classified, so a genuine reported nil escapes verification. Fix: require a printed
cell to carry a classification (zero vs absent), and treat an unclassified printed
glyph as a typed finding.

## D7 — three envelope/contract claim mismatches
(a) `historical_periods=three_or_more` is CERTIFIED but `validateCaseShape` admits
EXACTLY three; a 7-period case is refused with an internal schema string, not a
registered terminal reason.
(b) A functional currency distinct from the presentation currency is
UNREPRESENTABLE: `issuer.functional_currency` is refused as a disallowed property.
(c) A per-statement unit scale is UNREPRESENTABLE: `issuer.units` is one enumerated
scalar, so a filing printing £000 and £m in different statements has no lawful
representation — the mismatch can only be caught later, by footing.

## D8 — split ordering authority (finding, lower severity)
`validateFiscalPeriods` returns ZERO errors on a newest-first period series; only
`validateCaseShape` catches it. A caller running fiscal-period validation alone
passes a fully reversed comparative layout.

## D9 — uniform unit mis-scale is invisible (from archetype 23)
A PARTIAL printed-unit mis-scale blocks, but a UNIFORM mis-scale foots perfectly and
is undetectable by footing. Needs an independent unit-label reconciliation (P2.1
landed the label reconciliation; this is the case that shows why it must be
fail-closed on uniform mismatch too).

## Observation (not a defect, but a trap for test authors)
Both certified fixtures report 3 `validateCaseShape` errors AS THEY SIT ON DISK — the
three `production_model` contract-version stamps are absent and supplied by the
evidence/compile lane. Any test asserting `validateCaseShape(fixture).length === 0`
directly on a fixture file is wrong.

## Naming mirror (recorded, deliberate, not a defect)
The envelope emits `UNSUPPORTED_PROFILE.<suffix>`; the registry registers
`PROFILE.<suffix>`. The terminal-registry suite mirrors this deliberately; the
archetype catalogue names the REGISTERED code and resolves the mirror explicitly.

# Wave 2 defects — economics archetypes (P7.1b) + generated cohort (P7.3)

## D10 — release-grade roll-forward invariant omits PIK and fair-value movements (SEVERITY: HIGH)
`validateSolutionInvariants` / `debt.instrument_roll_forward` computes expected ending as
opening + issuance + other_non_cash - amortisation - maturity, EXCLUDING
`pik_interest_native` and `fair_value_movement_native`. Every PIK or accreting instrument
therefore fails a release-grade invariant while the solver's own roll-forward is correct —
the discrepancy equals the accretion exactly. Unexercised because neither certified fixture
has a PIK instrument (standard-maximal has 12 instruments, 0 with pik_rate>0).

## D11 — never-zero coercions in opening-instrument provenance (SEVERITY: HIGH)
Found by generated seeds 7730022 / 7730012 / 7730034 / 7730000 against
`scripts/lib/opening_instrument_provenance.mjs` `typedDeclaredAmount`:
`" "` -> reported_zero, `false` -> reported_zero, `[]` -> reported_zero, `true` ->
reported_number 1. Worse: all four are then SELECTED into the opening register with a
numeric balance and contribute to `reporting_total` (4 further signatures).
`instrument_period_state.mjs:381-386` carries a NEVER-ZERO comment naming `Number(false)`
as a defended coercion, but the guard only tests the nil / reported_blank states.
NOTE: this is in code sealed as P4.1 earlier in this programme — the seal was premature.
The generator caught what P4.1's own suite did not.

## D12 — instrument class `lease_liability` dies on an untyped throw (SEVERITY: HIGH)
`validateCaseShape` returns ZERO errors (the class is in the model-case schema enum AND the
envelope's declared_matrix), yet compiling throws a bare
`Error: Unsupported debt class lease_liability` with no code, no typed_internal_outcome and
no registered reason. Validator and compiler disagree, and the refusal cannot reach a lawful
terminal.

## D13 — classifySupport returns UNSUPPORTED without stopping (FOUND INDEPENDENTLY TWICE)
A dimension-level UNSUPPORTED verdict yields `support_class: "UNSUPPORTED"` — whose only
legal terminal is UNSUPPORTED_PROFILE — while `early_stop.stopped === false` and
`reason_code === null`. No predicate covers it, so the only legal terminal is UNREACHABLE.
Confirmed cases: `accounting_framework=other_or_unknown`, `accounting_framework` unstated,
`historical_periods` unstated, `filing_language_format=non_english` with a declared adapter.
Corroboration: found separately by the P7.1b archetype agent and the P7.3 generator.

## D14 — EXPERIMENTAL has no lawful terminal for three real outcomes
EXPERIMENTAL's legal terminals exclude SOURCE_REQUIRED and ACTION_REQUIRED, so an
experimental-ring case with unresolvable identity, unreconcilable opening debt, or a genuine
material economic choice has NO lawful terminal at all.

## D15..D18 — contract vocabulary absences (each blocks a real archetype)
D15: no NOL / tax-loss-stock vocabulary — after two forecast loss years totalling >180, the
recovery year is taxed at the full 25%.
D16: no IAS 23 capitalised-borrowing-cost field — the only capitalisation vocabulary is
`pik_rate` (into principal, inside interest expense), so 100% of the coupon is expensed and
capex is understated.
D17: no period-length / stub / changed-year-end vocabulary — both shapes surface only as a
per-period `periods.fiscal_year_end_mismatch` mapped to NO terminal reason code; a period
object can state only `date` and `status`.
D18: a genuine reported zero tax rate is classified as `tax_credit_on_profit`, so a tax
holiday is indistinguishable from a credit in the tax ledger (the row-level vocabulary does
carry reported_zero, so the loss is ledger-local).

## D19 — cross-contract vocabulary split
The case contract says `52_53_week`; the envelope dimension says `week_52_53`. Separately the
envelope emits `UNSUPPORTED_PROFILE.*` while the registry keys are `PROFILE.*`. Both archetype
runners normalise rather than repair, and say so.

## Sampling finding (not a defect, but a test-design lesson worth keeping)
Uniform sampling over the declared space reached **CERTIFIED zero times in 2,500 draws** — the
headline release promise was entirely unsampled — and SUPPORTED_DEGRADED once in 300. 80% of
the budget went to preflight-stopped cases because 5 of 11 entity types are financial
institutions. P7.3 now declares four strata drawn from the seed, so determinism is preserved.
Value coverage alone hid this; LANE coverage is what exposed it.

## D20 — a governance test mutates a tracked artifact as a side effect
`node scripts/run_programme_control_tests.mjs` rewrites `ci/test_registry_census.json`
while running (found by P7.2's re-verification, which had that file on its forbidden list
and had to revert it after every run). A validator must not mutate the tree it validates:
a gate run should be side-effect free, and a census artifact should be regenerated only by
its own generator. Consequence today: any agent forbidden from `ci/**` sees a spurious dirty
file, and a CI run could in principle commit a census it regenerated rather than verified.
Owner surface: scripts/run_programme_control_tests.mjs (the census invocation) and whatever
it calls in the census generator. Fix: verify without writing, or write only under an
explicit --write flag as run_ownership_census_tests.mjs and the coercion inventory already do.

## D21 — the frozen 32-recipe cohort does not merely fail to run in CI, it FAILS
Found by P7.7 while un-darkening it. Its manifest existed nowhere in the tree; once derived,
`scripts/compile_synthetic_cohort.mjs:1041` seals broker consensus contributors in the fixed
order `[Northstar, Harbour Lane, Moorland]` while `scripts/lib/broker_consensus.mjs:85-92`
REQUIRES them sorted. Seed-independent (two seed schemes tried). So the cohort the programme
treats as its frozen behavioural baseline has never passed.

## D22 — C1 of the frozen cohort has mixed aggregate forecast ownership
Exposed once D21 is patched (P7.7 patched it in a throwaway probe, since both files were
forbidden to it): C1 fails `forecast_authority` with "change_in_working_capital has mixed
aggregate forecast ownership… parent broker_consensus coexists with live children
wc_*:explicit_zero". Both D21 and D22 are carried by the `nightly-frozen-cohort` quarantine
entry (owner workbook-oracle, expires 2026-09-17) so the nightly tier fails loudly rather
than silently skipping — but the quarantine EXPIRES, so they cannot sit unfixed.
