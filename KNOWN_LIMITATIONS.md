# Excel Inflow development candidate — known limitations

(This file deliberately carries NO version literal. Freeze criterion 9 is closed: the skill
version is declared exactly once, at `assets/runtime-manifest.json#/skill_version`, and every
other site derives it through `scripts/lib/skill_version_declaration.mjs`. A version flip is
now a one-field edit to that manifest, and the registered `skill-version-declaration` suite
fails if a second literal is introduced anywhere in the shipped or checked surface. Before
P8.9 the version was stated independently in this heading and in four suite "tripwires"; the
blocker corpus records the previous flip going red at exact head for missing one of them, and
the same failure reproduced at head for the next flip.)

- This is a development candidate. Its package identity is `development / not_installed`; it is not production-certified or production-promoted.
- Citrix/Rogo installation and activation have not been performed for these bytes.
- Installed-host custody remains external and pending for the current candidate. No Rogo installation receipt, installed-package identity, active-pointer readback, or second-fresh-session evidence exists for these bytes.
- Native Microsoft Excel control-matrix execution, full recalculation/save/reopen evidence and the native all-cell error scan remain pending.
- Portable automated workbook inventory and rendered-review evidence are release-custody evidence only; native Excel visual review remains pending and must be bound to the installed bytes.
- The public filing corpus outcome was restated on 2026-08-21 after repairs `0401fb4`,
  `af0e522`, `71a8c82` and `16d36e0`: the corpus now extracts 8 of 8 documents at
  `EXTRACTION_PASS` with zero blocked documents (6 PDFs through the production filing
  extractor; 2 HTML filings through the Inline XBRL structured lane), superseding the
  earlier honest-but-stale state of one pass / five review / two unsupported. The custody
  receipt is `test-fixtures/real-filings-custody-v1/corpus-extraction-outcomes.json`.
  The iXBRL lane passes inside its harness and probe suites while its production wiring is
  still in progress elsewhere; no installed-host claim rests on it yet.
- The reviewed five-house broker pack reaches `PASS_DEGRADED`: stale responses are quarantined, and no broker authority or mappings are silently retained.
- `broker_case: "Forecast Waterfall"` has no per-row waterfall composition to draw on, so its broker rows compose from the compatible-house consensus basis; the selection discloses this as `source_kind: forecast_waterfall` with a DEGRADE finding rather than posing as Model Consensus (mp2-E5).
- The source branch is intentionally not merged to `main`; `main` remains on the prior v3.7.0 line until the held Rogo/native gates are completed.
- Existing published source tags, package branches, assets and package bytes remain immutable and have not been overwritten. The audited installed-filings repair remains preserved; this hardening tree is a new development candidate with a separately derived identity.
- The Rogo installer must verify the actual retained rollback route and identities at installation time. No installed rollback hash is inferred from local package evidence.
- The broad architecture-shortening programme is intentionally deferred until after the installed/native behaviour baseline is frozen; this candidate changes only the bounded bootstrap, installed-capability, identity, session, CI-custody and package-remediation surfaces.


## Declared limitations carried INTO the v3.7.7 freeze (owner decision, 2026-08-20)

These are limits on what the product can REPRESENT, not incorrect behaviour, and they are
declared rather than blocking. Each is reproducible and recorded with anchors in
`programme/gap-reports/DEFECT_REGISTER.md`; the freeze pins them as known, so Phase 9's
refactor must preserve behaviour WITHOUT being obliged to preserve these gaps as correct.

### Contract vocabulary the case cannot express (D15-D19)
- No NOL / tax-loss-stock vocabulary: after forecast loss years, the recovery year is taxed in
  full rather than sheltered.
- No IAS 23 capitalised-borrowing-cost field: the whole coupon is expensed and capex is
  understated. The only capitalisation vocabulary is `pik_rate`, which capitalises into
  principal inside interest expense — a different thing.
- No period-length, stub-period or changed-year-end vocabulary: both shapes surface only as a
  per-period fiscal-year mismatch, mapped to no terminal reason code.
- A genuine reported ZERO tax rate is classified as a tax credit, so a tax holiday is
  indistinguishable from a credit in the tax ledger.
- Cross-contract spelling split: the case says `52_53_week`, the envelope says `week_52_53`.

### Support-envelope claims the contract cannot satisfy (D4, D7)
- The taxonomy declares no direct-method operating roles, yet the envelope classifies
  `cash_flow_method: direct` as EXPERIMENTAL. Every direct-method operating line is unmapped.
- `historical_periods = three_or_more` is CERTIFIED but the case contract admits exactly three.
- A functional currency distinct from the presentation currency is unrepresentable.
- A per-statement unit scale is unrepresentable (`issuer.units` is one scalar), so a filing
  printing thousands in one statement and millions in another has no lawful representation.

### Graph and convergence gaps (D29/MG-2, D31/MG-4, D32/MG-5)
- No debt or lease BALANCE node, so six balance-to-interest edges are undeclared.
- A `row_type: "header"` row carrying no values is minted into statement values as numeric 0.
- RESOLVED (P7.9/P7.10, completed by E9): no reported opening-debt magnitude is
  order-dependent any more. The bridge residual, `reporting_total` and its
  provenance replay all accumulate through `canonical_sum.mjs`; mechanism and
  receipts in `references/order-dependence-root-cause.md`. Remaining latent
  same-class sites inside the solver (`mandatoryRepaymentForPeriod`,
  definition-basis sums) are declared open there — canonicalising them moves
  certified economic signatures and needs re-certification authority.

### Test-infrastructure defects (D21, D22, D24, D25)
- RESOLVED 2026-08-21 on `agent/mp-C-quarantine-truth`: the four frozen-cohort compiler
  defects (unsorted consensus seal; blank working-capital children minted into live
  `explicit_zero` forecasts; the loss-restatement identity parent standing its component
  children down; the multi-category-capex family with mixed ownership) are repaired in
  `scripts/compile_synthetic_cohort.mjs`, the 32-recipe cohort compiles clean end to end,
  and the quarantine `frozen-cohort-compiler-membership-order` is retired with a receipt in
  `assets/ci-gate-tiers-v1.json`. The nightly verdict returns to blocking.
- The mutation-adequacy compiler can register its own measuring suite as a survivor when that
  suite is transiently red. Self-correcting on recompile; can manufacture a false survivor.
- `compileBrokerPreview` throws on the CLEAN fixture and a catch installs the forecast-waterfall
  fallback. Behaviour is lawful; the throw on clean input is not explained.

### Measurement coverage that is honest rather than complete
- Mutation adequacy: score 1.0 over what is measured, but measurement coverage is 0.338 — only
  24 of 69 mutation-class suites report a count, so a suite that stopped mutating would pass.
  Six of seven P0 invariants have no mutation-class prover.
- Runtime SLO cohort coverage is LOWER_BOUND_ONLY: end-to-end delivery is not producible at the
  freeze commit, so p50/p95 are measured on the reachable portion.
- The custody-cohort equivalence run is a KNOWN RED with pinned totals (55/98/1/0/0); the frozen
  pre-contract packs need migration adapters, which is the P1.2/P1.3 remainder.

### Undeclared contract-vocabulary gaps (declared 2026-08-21)

Beyond D15-D19 above, corpus review found real filing constructs the case contract can neither
express nor classify. They are NOT modelled, NOT mapped to terminal reason codes, and were not
declared before now; they are recorded here so Phase 9's refactor inherits an honest list rather
than silent holes:

- Day-count conventions (30/360, actual/365, actual/actual) are not representable; interest
  accrues on a single implicit convention.
- Payment frequency (annual / semi-annual / quarterly coupons) has no field; schedules cannot
  distinguish them.
- Swapped or hedged interest rates (fixed-for-floating swaps, caps, collars) have no vocabulary;
  only a single declared coupon rate is representable.
- Convertible debt (conversion features, diluted-share interaction, beneficial conversion
  features) is unmapped.
- Subordination tiers inside a capital structure (senior / mezzanine / junior ranking) have no
  representation.
- Export-credit facilities and agency-backed financing (ECA guarantees, tied-support terms)
  are unmapped.
- Private placements (restricted covenants, PIPE terms) are indistinguishable from ordinary
  bank debt.
- Debtor-in-possession and super-priority financing (Chapter 11 constructs) have no vocabulary.
- Deferred tax and valuation allowances are not separable in the tax ledger beyond the
  non-cash `cf_deferred_tax` presentation row.
- Section 163(j) interest-limitation disallowance has no field; full deductibility is assumed
  whenever a rate exists.
- Restricted cash and its reconciliation to reported ending cash are unrepresentable.
- IAS 38 development-cost capitalisation (and its amortisation) has no vocabulary distinct from
  generic capex.
