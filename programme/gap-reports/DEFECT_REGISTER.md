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

## D20 — a gate mutates a tracked artifact as a side effect
**ATTRIBUTION CORRECTED (P0.9).** My original entry blamed
`scripts/run_programme_control_tests.mjs`; that file is side-effect free across all 803
tracked files. The actual writer is `scripts/run_ci_census_tests.mjs` — `:28` defaults
`--out` to `ci/test_registry_census.json`, INSIDE the tracked tree, and `:229` writes it
unconditionally with no flag and no verify mode. P7.2 saw the census change while running
programme-control because programme-control's run had invoked it; the reverted file was
census output, not programme-control's. A validator must not mutate the tree it validates:
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

### D20 root cause (P0.9's finding)
`source_commit` / `source_tree` are recomputed from git HEAD, so a COMMITTED census can never
match a later run — which is precisely why the generator was made to overwrite rather than
verify. Any fix must therefore compare the SUBSTANTIVE payload (script rows, checks, registry
digest, critical requirements) and treat those three fields as declared-volatile, rather than
demanding byte equality it can never achieve.

### D20 sweep result
All 192 registered suites run individually in a detached worktree: EXACTLY ONE offender
(`ci-census`). All 192 declare `mutates_product_tree: false`, so this is a declared-contract
violation rather than untidiness.

### Method note worth keeping (P0.9)
A digest-only side-effect sweep is INSUFFICIENT — it goes blind exactly when the committed
artifact is already current, which is the CI case. The manifest now stamps `sha256:mtimeMs`
so a byte-identical rewrite is still caught as `rewritten-identical`. Two of P0.9's six
mutations survive a digest-only sweep.
Also: an attribution sweep must never run in a SHARED tree. P0.9's auto-restore reverted a
concurrent agent's in-flight edit once before it moved to a detached worktree.

## D23 — RESOLVED at 102ada3 (heading kept for history; see the P5.9 correction in Wave 5)
**ESCALATED from a fixture curiosity to a delivery blocker.** My first assessment scoped this
to one fixture; it is not. Independently found again by P8.7, then verified by me:
- `node scripts/run_phase9_broker_e2e_scenarios.mjs` was GREEN earlier this session and now
  FAILS with this refusal. It compiles real cases and builds workbooks.
- P8.7 proved the same case bytes PLAN successfully at `73c3401`, the parent of `bd1b973`
  (P5.3), and `git log -S refuseContradictedProvenance` returns exactly `bd1b973`.
- Consequence: every one of P8.7's five portable evidence classes is unproducible, so the
  release dossier cannot be assembled and the freeze cannot proceed.
Introduced by P5.3, which I committed. Its own gate passed because it exercised the archived
`reference_parity` fixtures, not a compiled `production_model` case — the refusal fires on the
latter.

## D23 detail — the contradiction as reported
Surfaced by P5.3's new emitter refusal, and confirmed as the single OPEN survivor in P7.5's
mutation-adequacy register (`cash-fx-identity-workbook::suite-failure`, owner release-proof,
reproduced serially and independently red in a clean worktree).

`node scripts/run_cash_fx_identity_workbook_tests.mjs` now fails at
`refuseContradictedProvenance` (build_dynamic_model.mjs:784):
  Operating Model!G64 / H64 / I64 — ending_cash is a DERIVED row in the case, but the cell
  ships as a blue hardcode claiming a filed source.

This is the exact class of contradiction P5.3 exists to refuse, so the refusal is correct and
must NOT be relaxed. The open question is which side is wrong: either the emitter should ship
a formula for a derived row (and the hardcode is the defect), or the case declares the row
derived while supplying a filed value (and the case is the defect). Determine which before
repairing — do not silence the refusal.

IMPORTANT SCOPE NOTE: P5.3 reported "no real mis-colouring found" and that was TRUE for the
two certified fixtures its gate covered. It was not a claim about the whole cohort. A gate
scoped to two fixtures cannot speak for every workbook-producing suite — worth remembering
when reading any "none found" result in this programme.

## D24 — the mutation-adequacy compiler can register its own measuring suite as a survivor
Observed during P7.5's integration. The compiler sweeps every mutation-class suite INCLUDING
`mutation-adequacy` itself. While its own suite was transiently red (its artifact claimed 69
mutation-class suites after integration had registered 71), the sweep recorded
`mutation-adequacy` as a survivor — so the register asserted a survivor that existed only
because the register was stale. Recompiling cleared it (score returned to 0.9919, one real
survivor).

This is the same self-reference class the programme has closed three times now (P7.6a's empty
forbidden-import list published as evidence, P5.3's validator deriving its expectation from
the artifact under test, D20's gate rewriting what it verifies). A measuring instrument should
either exclude itself from its own measurement or declare the self-measurement explicitly.
Low severity — it is self-correcting on recompile and cannot hide a real survivor — but it can
manufacture a false one, which is the direction that wastes an owner's time.

### D23 — coordinator's independent determination: this is (a), the emitter is wrong
Established from the codebase's own declarations while the repair was in flight, so the
returning verdict can be checked rather than taken:

- The convention is stated at `scripts/build_dynamic_model.mjs:595`:
  "blue = hardcode, black = same-sheet formula, green = cross-sheet link, white = section
  title". Blue therefore asserts the number was ENTERED, not computed.
- P5.3's own comment at `:661` names this exact shape as the lie the package exists to catch:
  "A derived subtotal shipped as a typed-in number and painted blue satisfies it perfectly —
  no formula, therefore blue — while asserting to the reader that a computed figure was read
  off a filed page."
- P5.3 also proved the certified workbooks are BYTE-IDENTICAL before and after its change.
  So it did not repaint anything: `ending_cash` was ALREADY shipping as a blue hardcode. The
  refusal is new; the misrepresentation is old.

Conclusion: the refusal is CORRECT and must not be relaxed. `ending_cash` is a derived row
whose value is materialised into the sheet as a typed-in number, which tells a reader it was
read off a source. The underlying defect is in the emitter (or in whatever decided that row
renders as a cached value rather than a formula), and it predates P5.3 by an unknown margin.

Consequences accepted deliberately: the compiled-case build stays BLOCKED, no workbook is
produced, the five portable evidence classes stay unproducible and the freeze waits. That is
the correct trade — the alternative is shipping a workbook that misrepresents where a number
came from, which is the single thing this programme's constitution refuses most explicitly.
Unblocking delivery is a separate, properly-scoped repair on the emitter, NOT a relaxation of
the check that found it.

## D25 — compileBrokerPreview throws on the clean fixture and a catch installs a fallback
Surfaced incidentally by P6.3's work graph, which now records `invalid.node_threw` on the
`broker_preview` node. On the clean synthetic fixture `compileBrokerPreview` THROWS, and the
surrounding catch installs the forecast-waterfall fallback. Behaviour is unchanged by P6.3 (the
node rethrows and the fallback still applies), but what was previously visible only as the
PRESENCE of a fallback artifact is now recorded as a thrown node with a reason.

Why it matters: a silent degradation that reaches a lawful-looking outcome is the shape this
programme repeatedly finds. The fallback may well be correct, but a throw on the CLEAN fixture
means the preview path fails on input it should handle, and nothing named that until now.
Open question for the owner: is the throw expected for a broker pack of this shape (then the
catch should be a declared branch, not an exception), or is it a real preview defect?

## D26 — the change-invalidation map licensed reuse of work a change had already invalidated (FIXED by P6.4)
`CHANGE_INVALIDATION` in `scripts/lib/flow_runtime.mjs` was a 12-entry literal with ZERO
callers. P6.4 gave it a caller and recomputed it from P6.3's measured node graph: it
DISAGREED on 8 of 12 entries, and every single disagreement was `later_than_measured` —
declaring a change invalidates from a LATER stage than it actually does, i.e. licensing reuse
of work the change had already invalidated.

  source_file / filing / debt_export / broker_forecast / prior_case
      declared evidence_review, measured inputs
  user_answer / assumption / transaction_input
      declared build_checks, measured decisions

Verified empirically rather than by inspection: a probe under `broker_pack` moves
`files.evidence_run` and misses an `inputs` node; one changed answer misses exactly the eight
`decisions` nodes and nothing above. The literal is retained but no longer trusted — the
disagreement count is recomputed from the graph and pinned at zero, with the historical map
kept so the suite pins the eight failures rather than asserting the corrections.

Why it was invisible: with zero callers the map was never exercised, so being wrong cost
nothing until something tried to use it. A dead literal that looks authoritative is worse than
an absent one.

## D27 — reused_stages claimed reuse the run did not perform (FIXED by P6.4)
A warm answered run reported `["inputs","evidence_review","decisions"]` while FIVE nodes
re-executed for 1260.5ms inside those stages. P6.4 made the claim true rather than narrowing
it — narrowing would have turned six assertions across four registered suites red, which is
its own signal that the claim was load-bearing. `decisions` is now genuinely enacted (all 8
nodes reused, 228.3ms → 0); `evidence_review` CANNOT be enacted (its key includes an artifact
its own work produces, and its intake plan carries live option handlers no artifact can hold)
and now says so, reporting mode "verified" with its 884.5ms cost visible.

# Wave 3 defects — metamorphic relations (P7.4). All five REPRODUCE and are pinned.

## D28 / MG-1 — the equation graph omits statement.tax_expense -> cash.cfo (SEVERITY: HIGH)
Perturbing tax moves CFO, but the graph does not declare the edge, so locality "escapes" on
24 of 31 archetypes and 66 of 92 generated cases — and EVERY escape is accounted for by that
one missing edge (proved necessary: dropping any declared missing edge leaves an escape
unexplained, so the register cannot be padded to launder future escapes).
Example: deferred_revenue_ratable.json, tax 0 -> 42.271, CFO 282.181 -> 239.697.

SECOND-ORDER, AND THIS IS THE PART THAT MATTERS: the missing edge CLOSES A CYCLE. So
assets/convergence-contract.v1.json's declared 13-node active SCC UNDERSTATES the real fixed
point — pre_tax_income and tax_expense both move and neither is declared.

Consequence for work already sealed, which I must state plainly: P4.7 proved the hand-written
solve order agrees with the graph-derived order, and P3.3 proved the ETR path acyclic — BOTH
were computed on this incomplete graph. Neither conclusion is wrong about the graph as
declared; both are unproven about the graph as it should be. Re-running those proofs is
required after MG-1 is repaired, and their issue cards should say so.

## D29 / MG-2 — no debt or lease BALANCE node, so six balance->interest edges are absent
The graph carries interest nodes but no balance node for the instrument that generates it, so
the dependency of interest on the balance it accrues over is undeclared.

## D30 / MG-3 — convergence is NOT scale-invariant (SEVERITY: HIGH)
`revolver_undrawn_commitment_fee_only` converges with residual 6.04e-10 against an ABSOLUTE
tolerance of 1e-8. Restate the identical economics in thousands and the solver throws
SOLVER_NON_CONVERGENCE. In plain terms: an issuer reporting in thousands is REFUSED for
economics an issuer reporting in millions is served. This is a real-world defect, not a
synthetic curiosity — reporting scale is an issuer's presentation choice, not an economic one.
Fix direction: the convergence tolerance must be relative to the magnitudes it judges, or
declared scale-dependent and the envelope narrowed accordingly. Do NOT simply widen it.

## D31 / MG-4 — a header row with no values is minted into statement_values as numeric 0
A `row_type: "header"` row carrying no `values` becomes a real 0. This is a NEVER-ZERO
violation of exactly the class the programme has closed twice already (D11 in opening
provenance, D6 in printed dashes). Asymmetric and therefore diagnostic: the LEADING header
appears and the trailing one does not.

## D32 / MG-5 — the opening-debt bridge residual is order-dependent (latent)
Seed 700577: -943.56 vs -943.5600000000002 depending on accumulation order; 26 drifts observed,
all ~1e-13 relative against a 0.01 tolerance. Latent today, but it means the bridge's residual
is not a function of the inputs alone.

# Wave 4 — P4.9's corrections. Two defects were WRONG as registered.

## D33 — a metamorphic guard tests a convention's NAME for its MEANING (NEW)
`scripts/lib/metamorphic_relations.mjs:733` guards the commitment fee with
`!/rate/i.test(commitment_fee_convention)`. The three conventions that exist in the repo —
`bps_on_undrawn`, `captured_in_residual`, `none` — contain no "rate", so the guard has NEVER
fired. The unit-scale transform therefore scales `rcf_policy.commitment_fee_value` from 35 to
35,000 while the convention is `bps_on_undrawn`: a 350% commitment fee.

## D30/MG-3 — CORRECTED: overstated, and its reproduction was contaminated by D33
As registered, MG-3 claimed convergence is not scale-invariant and that "an issuer reporting in
thousands is refused for economics an issuer in millions is served". That reproduction was the
350% fee, not the tolerance. Held at a faithful rate, the thousands restatement CONVERGES on
the shipped tree (3.019e-9 < 1e-8, CFO scaling exactly x1000), and a faithful sweep at
x1e3/1e6/1e9/1e12 across every archetype produced NOT ONE refusal.

The mechanism is real but far milder: the worst faithful x1000 restatement lands at 9.903e-9
against 1e-8 — a 1% margin. Severity HIGH -> MEDIUM. P4.9 built the relative criterion anyway
(P2.10's recursive-summation bound, reference magnitude 10^3, reproducing 1e-8 exactly at that
scale and strictly stricter below) with the absolute ceiling DECLARED rather than silently
applied: every period it decides carries `binding_term: "declared_absolute_ceiling"` and the
uncapped scale-free tolerance beside it. Removing the ceiling is a joint change with three
other readers and is specified, not attempted.

## D28/MG-1 — NOT LANDED, and it exposed a FALSE sealed proof (SEVERITY: HIGH)
Landing the edge requires FIVE artefacts to move together: the graph edge; the convergence
contract's SCC and state vector 13 -> 16 with a rehash; solver.mjs's iteration vector;
canonical_model_modules.mjs (refuses at load: the new edge is owned by cash_rcf and declared by
nobody); and model_ir_v3.mjs (cannot bind the three new fixed-point nodes to workbook rows).
Three were outside P4.9's remit, so nothing landed. NO NUMBER MOVES — it is a pure declaration
gap.

THE SERIOUS PART, and it corrects sealed work: P3.3's ETR acyclicity conclusion is not merely
unproven on the repaired graph — it is FALSE about the RUNNING SOLVER. `taxCharge` is computed
inside the period sweep from `preTaxIncome` <- `netInterest` <- the iterated interest, and CFO
is seeded from `netIncome` <- `taxCharge`. **Tax is already iterated today.** The graph simply
never declared it. So the declared 13-node fixed point understates the real one, and P3.3's
proof asserts a sink property the solver does not have.

P3.3 predicted this in its own comment ("a future edit wiring net income into the cash-flow
bridge would violate [the sink property] ... It must fail loudly here") — and it does fail
loudly, which is the validator working. What it could not know was that the solver had already
crossed the line the graph forbade.

P4.7 is UNAFFECTED: re-derived against the repaired graph the solve order still agrees, zero
violations. Absorbing three nodes into the SCC moves edges from inter- to intra-component, a
strictly weaker obligation the hand-written order satisfies.

## D34 — policy.solver.relative_tolerance is declared, schema-validated, hash-bound, and read by NOBODY
The D20/D26 class again. It is the principled reference magnitude, but adopting its 1e-12 moves
25 of 99 forecast periods including a certified fixture and the phase-9 receipt, so it is a
golden-regeneration package rather than a free fix.

# Wave 5 — P5.9. The register was STALE, and the stale entry produced a wrong brief.

## D23 — RESOLVED, and the coordinator's "delivery is blocked" claim was WRONG
The repair landed in commit `102ada3` ("P5.3 D23 repair ... the build is unblocked"), an
ancestor of HEAD. `git log -S filedHistoricalObservation` returns exactly that commit, and
`node scripts/run_cash_fx_identity_workbook_tests.mjs` is GREEN at HEAD. Nothing was relaxed to
reach green; it was green on arrival.

The coordinator asserted to the owner that the compiled-case build was blocked and that no
workbook was produced. That was FALSE. It was read from P8.1's and P8.7's issue cards, which
said so truthfully WHEN WRITTEN and were never revised after 102ada3 landed. **A sealed card is
a statement about its own moment, not a live status.** Anything read from a card must be
re-verified against the running tree before it is acted on — this cost a full package's brief.

## The doctrine the brief got wrong (recorded so it is not "repaired" again later)
`ending_cash` renders as a cached value by DESIGN, at `build_dynamic_model.mjs:4649`
(`sourcedHistoricalEndingCash`). Under the legacy single-bucket cash policy the historical
closing-cash balance is a FILED OBSERVATION the workbook "is not entitled to replace with a
reconstructed cash-flow identity" — reported cash-flow components differ from the filed balance
by presentation, translation and source rounding.

So the correct shape is historical = filed value (blue), forecast = formula (black), verified in
a built workbook:
    G64 815.593 FF0000FF      J64 =SUM(J63,J62,J61) FF000000
    H64 528.104 FF0000FF      K64 =SUM(K63,K62,K61) FF000000
    I64 585.671 FF0000FF      L64 =SUM(L63,L62,L61) FF000000
(rows 61/62/63 = fx_effect_on_cash / net_change_in_cash / opening_cash — a genuine footing
chain.) Forcing a formula onto G64/H64/I64, which the P5.9 brief instructed, would have made the
workbook state a RECONSTRUCTED number in place of the filed one. The agent refused the brief and
was right to.

Class scope, measured rather than assumed: 51 blue+derived+case-declared historical cells across
5 cases and 12 workbook-producing suites — ALL ending_cash, all legitimately exempt, zero
unexempted. The exemption is exactly one semantic role, not a general escape hatch.

## D35 — the provenance exemption tested for a filed record's EXISTENCE, not its VALUE (FIXED)
The exemption landed at `refuseContradictedProvenance` (`build_dynamic_model.mjs:812`) admits a
blue derived cell where `reported_historical_values[period]` or
`cash_policy.historical_year_end_cash[period]` declares a filed figure. It never asked whether
the cell STATES that figure.

Proven exploitable: a case declaring `historical_year_end_cash = [815.593, ...]` with row values
`[999.111, ...]` BUILT CLEAN, shipping `G64 = 999.111` in blue — asserting a filed source that
says something else. This is the same misrepresentation D23 exists to refuse, displaced one
level up into the exemption itself.

The shipped Python oracle already caught it (`PROV_HARDCODE_VALUE_NOT_FILED`, `999.111 vs
815.593`), so the emitter was shipping packages a shipped oracle would block — two validators
disagreeing about the same artifact, the D5 pattern again.

Repair: the refusal now compares the stated figure to the filed one within
`1e-6 * max(1, |filed|)`. Refusal-only — nothing repainted, no exemption widened, no formula
given a colour it has not earned. Blank/nil/non-finite is SKIPPED, never coerced to zero.
Certified fixtures byte-identical (model.xlsx, .plan.json, .provenance-authority.json,
.row-map.json, .model-ir-v3.json all hash-identical). A real workbook builds end to end
(JS plan -> emit/__main__.py -> .xlsx), opens in openpyxl, 3 sheets, foots per the independent
finance proof.

Not closed: the value-equality check covers the HISTORICAL HARDCODE channel only. The
forecast-authority channel remains oracle-only.
