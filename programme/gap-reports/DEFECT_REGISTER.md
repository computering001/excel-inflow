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

## D33 — a metamorphic guard tests a convention's NAME for its MEANING (FIXED by P7.9)
`scripts/lib/metamorphic_relations.mjs:733` guarded the commitment fee with
`!/rate/i.test(commitment_fee_convention)`. P7.9's red proof enumerated the conventions from
their DECLARED sources rather than by hand, and found FIVE, not the three the register
recorded: `none`, `bps_on_undrawn`, `captured_in_residual` (model-case-v2), `percent_of_margin`
(the legacy model-case schema) and `bps_on_committed` (the case-source schema). Not one
contains the letters r-a-t-e, so the guard fired on nothing and the transform scaled the fee
unconditionally — 35 to 35,000 on both revolver archetypes, a 35bp fee restated as 350%. Four
of the five conventions are rates and the fifth is a declared zero placeholder, so there was no
value at all on which the retired guard's behaviour was correct.

REPAIRED by dispatch on a declaration. `assets/metamorphic-relations-v1.json` now carries
`unit_restatement_dimensions`: each quantity names its discriminator and the SCHEMA POINTER
that admits its values, and classifies every admitted value as `monetary` (scale-covariant),
`rate` (scale-invariant), `declared_zero_placeholder` or `non_numeric`, each with a stated
reason citing the reader that consumes it. `validateUnitRestatementDimensionTotality()` runs at
IMPORT on the same channel as the node-observable totality check: it resolves each declared
schema pointer, requires every admitted value to be classified and every classification to be
admitted by some schema, and throws if not. So adding a convention to the schema enum does not
give it a default — it makes the whole metamorphic layer refuse to load until a human
classifies it. At the call site an unclassified or absent convention raises
`UNIT_DIMENSION_UNCLASSIFIED_CONVENTION`; there is no fallback branch to fall into.

## D33's SIBLINGS inside the same transform — three more names standing in for meanings
P7.9 swept the layer rather than fixing the one instance, on the view that this is a class.

- **`NON_MONETARY_RECONCILIATION_KEY = /percentage|_rate|ratio|tolerance_bps/` (`:558`), tested
  against `debt_reconciliation` KEY names.** Correct today only by a coincidence of spelling:
  rename `maximum_residual_percentage` and a tolerance starts being multiplied by 1000; rename
  `reported_opening_gross_debt` to end in `_ratio` and a balance stops restating. Neither
  rename touches what the field means. FIXED: the schema closes the container
  (`additionalProperties: false`, three keys), so the classification is total and a fourth key
  throws.
- **`key !== "eligible_percentage"` in the cash-bucket loop — a DENYLIST OF ONE KEY THAT DOES
  NOT EXIST.** `$defs/cashBucket` declares no property called `eligible_percentage`; the string
  appears nowhere else in the repository. The real keys are `net_debt_eligible_percentage` and
  `interest_eligible_percentage` (both bounded by the schema to [0,1]) and `cash_yield` (a rate
  series). The guard was unconditionally true, so the transform multiplied all three by the
  unit factor, producing a case violating its own schema `maximum: 1`. It never fired in anger
  only because NO case in the corpus carries `cash_policy.buckets` — dead code guarding a live
  branch, which is D33 exactly. FIXED against the closed `$defs/cashBucket` key set, with the
  branch exercised directly by a mutation since no fixture reaches it.
- **`RATIO_SEMANTIC_ROLES = new Set(["effective_tax_rate"])` (`:557`).** A hand-written set
  standing in for "the roles that are ratios". `assets/statement-semantic-taxonomy.v1.json`
  declares that set — roles carrying `numeric_types: ["percentage"]` — and it has TWO members:
  `margin` was missing, so a sourced margin row would have been multiplied by 1000. FIXED by
  deriving the set from the taxonomy. The RESIDUAL cannot be closed in this layer and is
  registered as MG-7 (below).

Self-mutation, so the repair has provable bite: `run_metamorphic_tests.mjs` now renames each
discriminator value and each container key through eight spellings that inject or remove the
words the retired regexes matched on, and requires a NAMED throw for every one. It also replays
both retired predicates over the same renames and asserts they disagree with the declared
dimension — so the suite proves not only that the new guard is strict but that the old one was
wrong. Two further checks prove the totality validator bites in six directions (unclassified
value, orphan classification, undeclared dimension, unreasoned classification, unclosed
container, unresolvable authority).

## MG-6 (NEW, LOW) — `operating_metrics` is scaled with no dimension test at all
`operating_metrics` is declared `additionalProperties: {$ref: metricSeries}` — an OPEN key
space — and the transform scales `metric.values` for every key. All eleven keys the corpus
carries are magnitudes, so nothing misfires; a margin, a yield or a headcount added under that
open space would be multiplied by 1000 with no guard and no error. The same failure mode as
D33, reached by having NO test rather than a wrong one, and NOT repairable here: a total
classification needs a closed key set, and closing it is a schema change with compiler, solver
and golden readers. Registered, with the reproduction, rather than papered over with a default.

## MG-7 (NEW, LOW) — a row's dimension rests on a role the schema leaves an open string
`statementRow.semantic_role` is `{"type": "string"}`, and the statement taxonomy types only
some of its roles: of the 32 distinct roles the corpus uses, 13 carry no `numeric_types` and 4
are absent from the taxonomy entirely. Those are scaled by omission. All 32 are magnitudes
today. Same class as MG-6, same reason it cannot close inside this layer, and the suite asserts
the residual rather than assuming it: a row with an untyped `gross_margin` role IS still scaled
by 1000, and that assertion is pinned to this entry.

## D30/MG-3 — CORRECTED (P4.9 found it, P7.9 landed it): HIGH -> MEDIUM, reproduction contaminated by D33
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

P7.9 landed the register change P4.9 could not reach. MG-3 keeps `status: OPEN` — its mechanism
is real — but its `severity` is now `medium`, its `title`, `reproduction`, `consequence`,
`repair_owner` and `retirement_condition` state the corrected finding, and its suite pins are
inverted: `run_metamorphic_tests.mjs` used to assert "MG-3 reproduces: the only case the
restatement refuses is the registered one", and now asserts that a FAITHFUL restatement refuses
NOTHING, across 31 archetypes and 92 generated cases alike (`archetypes_refused` 1 -> 0,
`generated_refused` 1 -> 0, `archetypes_exact` 30 -> 31). What survives is pinned as a MEASURED
margin rather than as prose: the worst faithfully restated period —
`lease_only_no_funded_debt.json` period 0 at x1000 — lands at residual 9.9035e-9 against the
declared 1e-8 ceiling, a margin of 0.97%, reporting `binding_term:
"declared_absolute_ceiling"` and `within_declared_envelope: false`. The pin fails if that margin
either WIDENS (the mechanism was repaired without retiring the entry) or CLOSES (it became a
refusal). MG-3 is deliberately absent from the suite's `known_defects_reproduced` list and
appears instead under `known_defects_corrected_not_reproduced`, so no reader can take the old
attribution from the receipt. The historical reproduction is not deleted: the contamination is
re-injected by hand in both suites, and a 350% commitment fee is still shown to be correctly
refused.

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

# Wave 6 — P7.10's corrections. One defect CLOSED, one restated, one NEW sibling.

## D32 / MG-5 — CLOSED (P7.10)
The opening-debt bridge now accumulates its three register totals through
`scripts/lib/canonical_sum.mjs`, which sums a multiset of doubles in an order derived only from
the values themselves. Order-invariance is a written proof (a total order whose equality class
holds only bit-identical doubles ⇒ the sorted sequence is unique ⇒ permuting bit-identical
addends cannot change a partial sum), corroborated by a non-vacuous 500-shuffle test and a
200-shuffle end-to-end test on seed 700577. The reported residual is UNCHANGED at -943.56; the
reversed register now reports -943.56 too. The fix is a canonicalisation, not a rounding — the
0.01 tolerance was not touched and no digit was snapped to it.

RETIREMENT PENDING in files P7.10 may not edit: `run_metamorphic_tests.mjs`'s MG-5 reproduction
assertion now fails BY DESIGN (its own retirement condition), and the MG-5 entry in
`assets/metamorphic-relations-v1.json` must be deleted along with the 1e-9 relative epsilon at
lines 32/34, whose only justification was MG-5. The verified patch is in P7.10's issue card.

## D31 / MG-4 — RESTATED, still OPEN (blocked on a forbidden file)
Two corrections to the registered description.

(1) "The LEADING header appears and the trailing one does not" is true of the income statement
and FALSE of the cash flow, whose trailing header also appears. Survival is decided by
`projectIncomeStatementToDebtOverlay` (`row_plan.mjs:2711-2725`), which prunes header-led blocks
after net income that hold no required row; the cash flow runs no such projection. The
asymmetry is a row-pruning artefact, NOT a property of the coercion.

(2) The mint is universal and PRE-EXISTS the transform. `normaliseStatementRows` inserts its own
header (`adjusted_ebitda_bridge`, `row_plan.mjs:2420`) into the untransformed archetype and it
is minted as 0 in the baseline solve. Across the solvable archetype corpus and a 24-seed
generated cohort the escape rate is exactly zero: every valueless header reaching the solver is
minted. `repeated_header` only made a standing mint visible as a delta.

Mint site, confirmed: `solver.mjs` `statementRowForecastValue` returns literal 0 for
`mechanism === "uncalculated"` — conflating "nothing computed it" with "a declared explicit
zero" — while the forecast-authority layer correctly reports `value: null`,
`declared_value: null`, `reason: "Presentation-only header."`. `statement_values` has exactly
one writer (`solver.mjs:3334`) fed by exactly one producer (`resolveAll`, `solver.mjs:956`), so
no repair exists outside `solver.mjs`. The patch is specified in P7.10's issue card, unapplied.

Root cause of the CLASS (D11, D6, D31): the repository's typed value model is a shadow core.
`typed_financial_value.mjs` is imported by 7 peripheral modules; `typed_arithmetic.mjs` by ZERO
production modules. Neither `solver.mjs`, `row_plan.mjs`, `case_compiler.mjs`,
`canonical_model_modules.mjs`, `fixed_point_constitution.mjs`, `forecast_authority.mjs` nor
`attachment_ingress.mjs` imports any of them. Each instance is repaired where it was found; the
untyped spine that produces them is never touched. 96 further risk sites are enumerated in
P7.10's issue card, including `solver.mjs:923` (`if (!definition) return 0` — a dropped ref
becomes a footed zero), `fixed_point_constitution.mjs:28` (the independent projector fabricates
the zeros it verifies), `row_plan.mjs:3359` (a fabricated zero SEALED into
`forecast_period_authorities` with a note claiming it was reported), and
`solver.mjs:1668-1671` (a coercion that makes its own consistency assertion pass vacuously).

## D36 — `reporting_total` is order-dependent (NEW, same class as D32, NOT repaired)
(Renumbered by the coordinator from the D34 the package proposed: D34 was already taken by
`policy.solver.relative_tolerance` in Wave 4.)
`instrument_period_state.mjs:469-473` reduces `rows.filter(include_in_gross_debt)` in register
order — the same multiset the bridge sums. Drifts on 3 of 13 multi-instrument registers in the
700560+24 cohort: seeds 700563 (1502.9969999999998 -> 1502.997), 700569 (7147.594 ->
7147.594000000001), 700577 (1163.56 -> 1163.5600000000002).

Routing it through `canonicalSum` works, and was reverted: it moves a maintained fixture figure
in its last place (`run_opening_instrument_provenance_tests.mjs:563`, 9335.506 ->
9335.505999999998). Regenerating that number to land the repair is forbidden, and picking a
different canonical order because it reproduces 9335.506 would be fitting the canonicalisation
to the golden. The drift set is LOCKED by
`scripts/run_never_zero_and_order_invariance_tests.mjs` and fails if it changes in either
direction. The decision belongs to the fixture's owner.

# Wave 7 — P7.9. D33 repaired at source, MG-5's retirement landed, and the class swept.

## D32 / MG-5 — RETIREMENT LANDED (P7.9), and the epsilon it justified is GONE
P7.10 closed D32 by construction but could edit neither `assets/metamorphic-relations-v1.json`
nor `scripts/run_metamorphic_tests.mjs`, so it verified a retirement patch and handed it over.
P7.9 owns both files and has applied it: the MG-5 entry is deleted from `known_defects`, the
suite's `known_defects_reproduced` no longer names it, and the reproduction assertion is
INVERTED rather than removed — "MG-5 RETIRED: a register permutation moves no reported magnitude
at all", so a regression is caught by a standing assertion instead of by an absence.

**The part that mattered, and it was checked rather than applied.** The refusal plane compared
embedded magnitudes at a RELATIVE EPSILON of 1e-9, and its own `why_not_exact` field named MG-5
as the sole justification. Leaving it would have left a permanently loosened comparison behind
a repaired defect — the "never weaken a validator" failure arriving by the back door. Two things
were established before removing it:

1. **It has no other reader.** `comparison.relative_epsilon` is read at exactly one place,
   `compareRefusalVerdicts` (`metamorphic_relations.mjs:483`). Nothing else in the repository
   references the field or `observation_planes`.
2. **Nothing depends on it behaviourally.** Measured across the WHOLE refusal plane with
   P7.10's repair present — 8 economics-preserving families over 208 refused cases, **1,658
   comparisons** — there is **not one** comparison that passes only because of the epsilon, and
   **not one** non-zero drift. Exact comparison is strictly stronger and costs nothing.

The comparison is now `"numeric_comparison": "exact"`. The epsilon is not merely deleted: it is
recorded as `retired_relative_epsilon` so the history is legible, and the MODE is declared on
the plane rather than living as a constant in the comparator, so re-loosening it is a visible
change to the register and an undeclared mode THROWS rather than defaulting. That is the same
declared-semantics discipline this package landed for D33, applied to the tolerance.

ONE dependant that P7.10's patch list did not name was found and inverted:
`run_metamorphic_tests.mjs`'s mutation check asserted `compareRefusalVerdicts(base,
base.replace("-943.56", "-943.5600000000002")).equal === true` — a test asserting the LOOSENING.
It now asserts `false`, plus an explicit equal-compares-equal case so the comparator is not
trivially strict.

## D36 — noted, not touched
P7.10's `reporting_total` order dependence (`instrument_period_state.mjs:469-473`) is locked by
`scripts/run_never_zero_and_order_invariance_tests.mjs`, which fails if the drift moves in
either direction. P7.9 asserts nothing about `reporting_total` and its relations do not
contradict that lock: the metamorphic refusal plane now demands EXACT equality of reported
magnitudes under a register permutation, which is the direction D36's repair would move toward,
never away. The refusal plane observes the opening-debt bridge residual, which P7.10 canonicalised;
`reporting_total` reaches no refusal message the plane compares, which is why the plane is green
at exact comparison while D36 is still open.

## D37..D43 — the sweep for D33's class OUTSIDE the metamorphic layer
D33 is the sixth time this programme has found an expectation taken from a NAME rather than from
the thing named, so P7.9 swept the repository for the class rather than stopping at the instance.
The rule applied: a guard counts when it decides a SEMANTIC class — monetary vs rate, additive
vs not, source-fault vs engineering-fault, one declared role vs another — by pattern-matching a
name, key, label, caption or convention VALUE, while a declared authority (a schema enum, a
`semantic_role`, a `numeric_types`, a `tolerance_class`, a declared `error_class`) exists that
could answer instead. Regexes whose subject IS a name and whose purpose IS naming — slugs, legal
suffixes, tickers, filename globs — do not count, nor does parsing numbers out of free text, nor
a schema `pattern` constraint.

Every guard below was read at the cited line and every count below was RECOMPUTED against the
declared authority — `assets/statement-semantic-taxonomy.v1.json`, the schemas, or the corpus.
NONE is repaired here: all live in files P7.9 is forbidden to touch. They are recorded with
reproductions so the next owner starts from evidence rather than from a hunch.

### D37 — a fixed classifier guard is bypassed on the production path by an unfixed copy (HIGH)
`scripts/lib/statement_classifier.mjs:190` carries the word-bounded
`/\b(?:margins?|rates?|percent(?:age)?s?)\b/i`, fixed under a prior defect (unanchored `rate`
matching inside "gene-RATE-d") and regression-tested by
`scripts/run_classifier_caption_defect_tests.mjs:118-145`. But `scripts/lib/case_compiler.mjs:765`
computes `numeric_type` with the OLD unanchored `/(?:margin|rate|percent|percentage)/i` and
passes it in as a declared field, short-circuiting the fixed guard. The published fix is
unreachable from production.

RECOMPUTED: the unanchored regex labels **9 aliases across 5 roles declared
`numeric_types: ["currency"]`** as percentages — all four `fx_effect_on_cash` aliases, "cash
generated by operating activities", "cash generated from operations", two `cash_from_investing`
aliases, "cash generated by financing activities". The wrong `numeric_type` is sealed into the
artifact as the `source_coverage[]` entry and raises the BLOCK
`source_coverage.classification_unresolved` (`case_compiler.mjs:800`). The declared authority is
`roles[].numeric_types` plus the row's own `number_format`.

Two aggravations. **`scripts/run_case_compiler_equivalence.mjs:841` — the independent
equivalence oracle — replicates the identical unanchored regex**, so producer and checker share
the defect and the repository's own cross-check can never detect the divergence. And the
word-bounded form is not sufficient either: **all four `fx_effect_on_cash` aliases contain the
standalone word "rate"**, so `statement_classifier.mjs:190` still misclassifies a declared
currency role. Boundaries narrowed the defect; only reading `numeric_types` closes it.

### D38 — source-fault vs engineering-fault ownership decided by regexing a finding ID (HIGH)
`scripts/lib/evidence_resolution_v2.mjs:581`:
`const sourceFault = /(?:source|hash|entity|period|opening_debt|reconciliation)/i.test(finding.id ?? "")`
→ `owner: sourceFault ? "FATAL_SOURCE" : "INTERNAL_WORK"`, consumed at
`scripts/run_excel_inflow_vnext.mjs:351,935-937` to choose between a terminal `BLOCKED` with
`user_blocking: true` and `NEEDS_INTERNAL_WORK`.

Wrong in BOTH directions. `evidence.seal.manifest_digest_mismatch`,
`evidence.seal.manifest_missing`, `evidence.seal.manifest_unreferenced`,
`statement_map.face_additivity`, `statement_map.unmapped_filed_line` and
`instruments.balance_basis_defaulted` are unambiguous source faults and none matches, so a
tampered or mismatched source seal is filed as an engineering bug and the user is never told
their evidence is bad. Conversely `source_coverage.classification_resolution_ledger` is an
internal ledger-integrity fault blamed on the user purely because its id begins `source_`. The
declared authority is `assets/evidence-resolution-v2.schema.json`'s four-value `owner` enum with
`scripts/lib/error_classification.mjs`'s `ERROR_CLASSES`, each carrying a `reason_code`
(`SOURCE.*` / `INTERNAL.*` / `USER.*`) and a `terminal_state`.

### D39 — a declared D&A role forecast as a one-off because its LABEL says "impairment" (HIGH)
`scripts/lib/forecast_behavior.mjs:281-285` classifies a row `lumpy_discretionary_flow` when a
descriptor built from its LABEL contains "impairment", guarded only by `DRIVER_ROLES.has(role)`
at `:95`. `DRIVER_ROLES` holds `depreciation_and_amortisation`, `depreciation` and
`amortisation` but NOT the declared role `depreciation_amortisation_and_impairment`, which the
taxonomy declares first-class for `["income_statement","cash_flow"]`. Identical row, identical
label, only the declared role differing: the combined role goes `lumpy_discretionary_flow`
(0.90), the plain one `driver_linked_flow` (0.96). `ALLOWED_METHODS_BY_BEHAVIOR` then forbids
`driver_formula`, `historical_trend`, `carry_forward` and `roll_forward` for the first, so a
recurring D&A add-back loses its driver forecast. The comment at `:231-233` names this exact
outcome as the thing the code exists to prevent.

### D40 — 4 of 4 declared aliases of the combined D&A role dropped from the EBITDA bridge (HIGH)
`scripts/lib/case_compiler.mjs:1306-1308` selects the cash-flow D&A row with
`/depreciat|amortis|amortiz/i.test(row.label) && !/impair/i.test(row.label) && !/grant/i`.
RECOMPUTED: **every one of the four declared aliases of
`depreciation_amortisation_and_impairment` is dropped** by the `impair` exclusion. The declared
escape hatch does not cover it either — `:1315` looks for row ids `cash_flow_da` /
`cash_flow_depreciation_amortisation`, while `case_source_proposer.mjs:325` emits the combined
line as `cash_flow_da_and_impairment`, a row id `case_compiler.mjs` never references. Result:
`cfDa === null`, no EBITDA bridge, for any issuer printing the combined line the taxonomy
explicitly supports.

### D41 — the CFO starting basis (PBT vs PAT) chosen by a label regex over a declared role (HIGH)
`scripts/lib/case_compiler.mjs:920`: `/before tax/i.test(row.label)` decides whether the
indirect-method reconciliation starts from profit before tax or after tax — which determines
whether a tax add-back is required. The taxonomy declares `cash_flow_profit_before_tax` as a
distinct `high_impact` role for exactly this, read at `row_plan.mjs:1102`,
`case_compiler.mjs:2297/2411` and `case_source_proposer.mjs:92/491` — everywhere except here.
RECOMPUTED: **4 of the 7 declared `pre_tax_income` aliases lack the substring "before tax"** —
"income before income taxes", "income before provision for income taxes", "income before income
tax expense and income from equity method investments", "pre tax profit" — so a standard US
filer silently links CFO to `net_income` and starts the reconciliation from PAT.

### D42 — attribution roles matched in one spelling; two declared roles conflated (MEDIUM)
`scripts/lib/case_compiler.mjs:1208` and `:1213`:
`/equity holders|owners of the parent|non-controlling/i`. The classifier's own `normalise()`
strips hyphens precisely so both spellings resolve; this regex reinstates the distinction. 3 of
5 declared `non_controlling_interests` aliases and 1 of 5 `owners_of_parent` aliases miss.
Separately `:1213`'s bare `/non-controlling/i` matches a hyphenated REDEEMABLE caption,
conflating `redeemable_non_controlling_interests` with `non_controlling_interests` — two roles
the taxonomy deliberately separates. Adjacent, same file, `:3227`: the net-finance add-back is
matched by `/finance costs \(net\)|net finance costs/i`, which misses 5 of the 7 declared
aliases of `net_finance_addback` and whose first alternative is not a declared alias at all —
and it then ASSIGNS `semantic_role = "net_finance_addback"`, writing the declared role it failed
to read.

### D43 — three incompatible dimension vocabularies compared as one string (MEDIUM, latent)
`scripts/verify/source_topology_oracle.py:47,54,57` and its duplicate at
`scripts/extract_filing_statements.py:1268,1273` take the first of `unit_class`, `numeric_type`,
`number_format` and test it against `{"percentage","percent","rate","ratio","count"}` to decide
whether a row family is non-additive. The three fields carry three different vocabularies:
`unit_class` (broker metric dictionary) declares `per_share` and `multiple`, both non-additive
and both ABSENT from the guard; `numeric_type` declares only `currency/percentage/text`; and
`number_format` is an Excel format string whose in-tree values are `"0.00%"`,
`"0.0x;(0.0x);…"`, `"#,##0;(#,##0);…"`, `"General"` — **none of which ever equals "percentage"**,
so a row whose only declared dimension is a percent or multiple format is treated as additive
currency. Conversely `len(unit_classes) > 1` rejects a family mixing `unit_class: "currency"`
with a `number_format` as dimensionally incompatible.

### Wave 7, LATENT — correct today, fragile by construction, recorded not repaired
- `scripts/lib/ownership_census.mjs:155` — `cell_class: row_id.includes("_to_") ? "ratio" :
  "schedule_amount"`, re-deriving a declared 6-value enum from a row-id substring. The eight ids
  are hardcoded three lines above so it is right today; renaming one to `leverage_ratio`
  silently reclassifies a ratio as a monetary amount.
- `scripts/lib/evidence_resolution_v2.mjs:348` — `period_basis: field.includes("date") ?
  "contractual" : "instant"` over a declared 7-value enum. Against `assets/dcs-export.schema.json`
  this assigns `instant` to `maturity_source_value`, `maturity_timing_convention` and
  `amortisation_schedule`, and to pure string metadata for which the enum declares
  `non_periodic`; only `maturity_date` and `next_call_date` land correctly. The adjacent
  `units: String(dcs.units ?? …)` takes a document-level default while the export schema declares
  a per-column `{field, currency, units}` binding that is never consulted.
- `scripts/lib/support_coverage_grid.mjs:490` — the direct-method detector NEVER fires: the grid
  scans only `test-fixtures/cases` (2 files, neither direct-method) while the direct-method
  fixture lives under `test-fixtures/archetypes/presentation/`, and the pattern omits four roles
  that ARE in the declared `RECURRING_DIRECT_CASH_ROLES` set. `cash_flow_method: direct` is a
  permanent coverage gap. Its sibling at `:482` requires `semantic_role ===
  "cash_flow_net_income"`, so a case starting from the declared `cash_flow_profit_before_tax` is
  not recognised as indirect either.
- `scripts/lib/case_source_proposer.mjs:370` — the same margin/rate/percent regex, end-anchored,
  so clean against every declared alias today.
- `scripts/lib/forecast_behavior.mjs:213` — `schedule_owned` decided from a substring of the
  SECTION name.
- `scripts/run_filings_pipeline.mjs:445` — blocker ownership from an error MESSAGE string two
  lines after the same block correctly reads the structured `error.code`; HTTP 402/405/409/429
  and any wrapped message fall through to `INTERNAL_WORK`.
- `scripts/broker_terminal_recovery.py:394` — `measurement_basis` from
  `metric_id.startswith("adjusted_")`. Right today (one such id), but a broker's "Adjusted EPS"
  mapped to `eps` is stamped `reported`. The sibling at
  `scripts/verify/broker_consensus_membership_oracle.py:60` shows the correct shape: prefer
  `declared.adjustment_basis`, fall back only after.
- `scripts/lib/mutation_adequacy.mjs:75` — count-vs-rate by field-name SUFFIX. The schema
  explicitly declares the pattern approach and carries an observed-name inventory, so this is
  declared rather than assumed; `_executed$` is the one trap.

### Wave 7, EXAMINED AND CLEARED — named so the sweep's boundary is auditable
- `scripts/lib/row_plan.mjs:1065` — a row-id prefix test, but LAST in a waterfall that consults
  `semantic_role`, `economic_class` and `movement_type` first. Not a defect.
- `scripts/lib/error_classification.mjs:212-222` — message-text recognisers, but a closed,
  documented fallback BEHIND an explicit `error_class` marker, and an error matching nothing is
  refused rather than guessed. Not a defect.
- `scripts/extract_filing_statements.py:1493-1512` — caption regex for subtotal recognition,
  documented as secondary to geometry and explicitly not classifying economic role, at a stage
  where no declared alternative exists. Not a defect.

# Wave 7 — coordinator, during release-package integration.

## D44 — `production_model` is declared, gated, and UNREACHABLE by any case in the repository
Found while trying to build a release package for the push. The release smoke test refuses:

    Invalid v2 case:
    - production_model requires source_coverage.classification_contract_version=evidence_v1
    - production_model requires statement_authority_contract_version=authority_v1
    - production_model requires forecast_authority_contract_version=waterfall_v1

Reproduced OUTSIDE the smoke harness, so it is not a harness artefact:
    node scripts/build_dynamic_model.mjs test-fixtures/cases/standard-maximal-v2.json \
         --out <tmp>/model.xlsx --plan-only

Measured facts, each from the declared source rather than inspection:
- BOTH certified fixtures declare `execution_profile: "production_model"` and carry NONE of the
  three contract versions it requires. They declare a profile they cannot satisfy.
- `waterfall_v1` appears in exactly ONE file in the whole repository —
  `assets/model-case-v2.schema.json`, the schema that DEFINES it. No case anywhere carries it.
- 23 suites set `execution_profile = "reference_parity"` before building (e.g.
  `run_cash_fx_identity_workbook_tests.mjs:41`). Every green workbook proof in this programme is
  a reference_parity proof. The strict production profile is exercised by no end-to-end build.
- `case_compiler.mjs:3813` DOES set `classification_contract_version = "evidence_v1"`, so the
  contracts are minted by the COMPILER. The fixtures in `test-fixtures/cases/` are pre-compiler
  artefacts; feeding one to the builder skips the stage that would make it conformant.

This is the D20/D26/D34 class once more — a declaration that is schema-validated, gated and
satisfied by nothing — but with a sharper consequence: it is a RELEASE BLOCKER. The
`--development` package cannot be compiled with either certified fixture as its smoke case, so no
package can be produced from an in-repo case today.

Also recorded: **the release build's smoke input is undeclared.** `assets/deployment-profile.json`
names 29 Python entry points and their smoke commands, but nothing names which case
`compile_skill_release.mjs --smoke-case` is supposed to receive. The one input that decides
whether a release can be built is passed ad hoc on a command line and written down nowhere.

NOT YET RESOLVED. Two candidate dispositions, and the choice must be made deliberately:
(a) the smoke case should be a COMPILED case produced by the real pipeline
    (`run_raw_input_black_box_canary.mjs:636` builds under production_model, so the pipeline can
    almost certainly mint a conformant case) — in which case the profile must DECLARE it; or
(b) `production_model` genuinely has no conformant case and the profile is over-claiming, exactly
    as D12 asks of `lease_liability`.
Do NOT resolve it by downgrading the smoke case to `reference_parity`: that would make the release
smoke test prove a weaker thing than the mode the fixtures declare, which is how a gate stops
meaning anything.

Deferred to a quiet tree deliberately: the raw canary must not be run while agents hold the
worktree (the ops rule is never to edit the tree mid-run), and two packages were in flight.

# Wave 9 — the full portable gate. THE GATE ITSELF WAS MASKING ITS FAILURES.

## D45 — run_development_gate.mjs EXITS 0 WITH FAILING SUITES (SEVERITY: HIGH)
The first full portable gate run of the 3.7.7 tree reported `exit code 0` while its own log
carried `FAIL coercion-ban`, `FAIL public-state-ownership` and `FAIL portability-contract`.
94 PASS / 3 FAIL / 10 BLOCKED, exit 0.

This is exit-code masking in the gate that decides whether a release is fit to ship, and this
programme has already recorded the pattern once: EQUIVALENCE_COHORT_BASELINE.md notes that
"earlier receipts citing 'equivalence 0 diffs' for FULL cohort runs were exit-code-masked
(`... | tail -N` returns tail's exit)". A gate whose exit code does not reflect its own verdicts
cannot be used in CI, and anything that trusted its exit code has proved nothing.

All three failures PRE-EXIST this wave: red at `8e1a29f` and red at head, so the wave introduced
no regression. They were invisible because nothing ever read the log.

## D46 — an ACTION_REQUIRED result was emitted with NO blocker class (SEVERITY: HIGH, FIXED)
Found by ENFORCING the public-state contract rather than scanning for it. Two sites in
`run_user_flow.mjs` (the question path at the decisions stage, and its replay twin) emitted
`status: "ACTION_REQUIRED"` with no `blocker_class` at all. The user was told to act while
nothing declared who owned the ask or why.

Fixed: both carry `blocker_class: "USER_DECISION"`, which is what they are — the flow is asking
the user to settle displayed questions.

## D47 — the public-state check was a TEXT-PROXIMITY SCAN, and it read the repair as the defect
`run_public_state_ownership_tests.mjs` scanned three controllers for `ACTION_REQUIRED` within 220
characters of `INTERNAL_WORK`. `run_user_flow.mjs:1312` trips it — with the CORRECT ternary, the
one that routes an internal decision-graph failure to BLOCKED/INTERNAL_WORK and only a genuine
user question to ACTION_REQUIRED. A regex cannot see a branch.

This is the name-standing-for-meaning class again (D33, D37, D38, and the `eligible_percentage`
denylist). The answer was NOT to loosen the regex or exempt the file. `run_user_flow.mjs` did not
call `assertPublicStateOwnership` ANYWHERE — the proxy was its only protection. The property is
now ENFORCED at `finish()`, the single boundary all 19 of its result sites exit through, and the
suite requires enforcement-or-absence with a floor of at least one enforcing controller, so the
enforcement cannot be deleted to make the scan pass again. Enforcing it is what found D46.

## D48 — a hard-coded developer home path shipped in scripts/ (FIXED)
`run_bounded_parallelism_tests.mjs:55` fell back to
`/Users/archiepreston/Documents/Codex/excel-inflow-venv/bin/python`. It named ONE developer's
venv, so the suite could only ever run on that machine. Resolved the way
`run_filings_pipeline.mjs` already does it: `EXCEL_INFLOW_PYTHON ?? PYTHON ?? "python3"`.

## Coercion inventory — two entries reviewed rather than left `unreviewed`
`error_classification.mjs:482` (`retry_count ?? 0`) and
`optional_broker_circuit_breaker.mjs:89` (`failure_count ?? 0`) were new to the inventory and
landed as `unreviewed`, which the legend says to treat as suspect. Both read in context and
classified `lawful_counter_or_length`: a retry BUDGET (an unclassified error gets no retries, and
the guard beside it also requires `classification !== null`) and a failure COUNTER (no prior
receipt means no prior failures, and `nonNegativeIntegerOrNull` already refuses a malformed
count). Neither is a financial value and neither can reach a workbook cell.

## D49 — run_gate_side_effect_tests was RED in every gate run, proving nothing (FIXED)
Corrected attribution: the coordinator dismissed this as a race against concurrent agents. It was
not. It failed identically in all three full gate runs on a quiet tree.

Cause: the suite computed an independent census with `run_ci_census_tests.mjs --out <temp>`, on
the stated assumption that "the generator's existing --out redirect IS the lawful verify path: it
computes the census without touching the tree" — and its own comment said "Prove that claim rather
than assuming it." The claim is FALSE. `--out` does not redirect output; it REBINDS which file the
census treats as the committed baseline (`run_ci_census_tests.mjs:248-256`), so an external path
made it refuse "the committed census is absent" before computing anything.

Repair: `--emit <path>` added to the census — compute and write to an external path with NO
baseline comparison and no tree write. The gate suite uses it. 276 checks, green.

Then the STALE QUARANTINE trip fired, correctly: `run_ci_census_tests.mjs` was a quarantined
offender for D20 ("writes ci/test_registry_census.json unconditionally"), anchored to source text
that D20's own repair removed. The quarantine could not outlive the defect, which is what it was
built to guarantee. The entry is retired and the script PROMOTED into SUBJECT_GATES, so it is now
held to the same no-side-effect standard as the other five. The map is left in place and empty:
it is the mechanism, not the list.

## D50 — run_development_gate.mjs silently drops suites AND exits 0 (SEVERITY: HIGH, OPEN)
Beyond D45's exit-code masking, the gate does not run its full set. Measured across three runs of
the same tree: 138 distinct suites, then 123. Fifteen were missing from the third run with no
error and exit 0 — including mutation-adequacy, canonical-model-modules, graph-driven-solve,
scale-invariant-convergence, declared-fixed-point-completeness and never-zero-and-order-invariance.
The second run ended in an unhandled exception inside `runPool` (`run_development_gate.mjs:305`,
`Array.map` at `:237`) and still reported exit 0.

So the gate can report success having executed 15 fewer suites than the run before it. Every one
of the 15 was executed individually on the quiet tree and all 15 pass, so this is a defect in the
HARNESS, not in the product — but a release gate that silently narrows its own coverage is not a
gate. NOT FIXED: the harness repair is out of scope for the freeze and is recorded for v3.8, with
the explicit warning that no green from this gate may be trusted without diffing its suite list
against the registry.

## D51 — external-custody symlinks were TRACKED, leaking a private filesystem layout (FIXED)
Caught at the push boundary, by diffing what would actually be published rather than trusting the
working tree to be clean (`git status` was empty; the problem was in history).

`fixtures/external/Codex` and `fixtures/external/codex-runtimes` were tracked as mode-120000
symlinks to ABSOLUTE paths on one developer's machine:

    fixtures/external/Codex          -> /Users/archiepreston/Documents/Codex
    fixtures/external/codex-runtimes -> /Users/archiepreston/Documents/Codex/excel-inflow-clean-final/scripts/fixtures/external/codex-runtimes

No custody CONTENT was in the repository — the targets are outside it — so the standing rule that
external custody must never ship was not breached in substance. But the LAYOUT of a private
filesystem was tracked, the links are broken on every machine but one, and they sit in the exact
directory the constitution names as never-ship. This is D48's class (a hard-coded home path in a
shipped file) in a form `grep` for `/Users/` inside file CONTENT cannot see, because the path is
the symlink target, not text in a file.

Root cause: `.gitignore` covered `scripts/fixtures/external/` but NOT the top-level
`fixtures/external/`. Introduced long before this programme, in `e49ad07`.

Repair: both untracked with `git rm --cached` (kept on disk — they are the local custody ACCESS
mechanism and several suites reach custody through them) and `fixtures/external/` added to
`.gitignore` with the reason recorded. Verified after: no tracked symlinks remain anywhere, and
nothing matching `private-test-custody` or `fixtures/external` is tracked. The custody-gated
suites behave identically (still BLOCKED without a custody root, exactly as before).
