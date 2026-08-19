# Phase 7 work orders — Global corpus, independent oracles, behavioural freeze
(Discovery agent 2026-08-19 @ e0618e2. Pack register rows 58-65; playbook :4781-6028.)

## Baseline reality
Blocker corpus 6 cases (tamper refusal working). Repo fixtures: 2 synthetic. Custody: 5 families,
29 files, ≈17 real issuers / ≈25 combinations vs the required 150-200; skewed UK/IE large-cap +
UK-smallcap notes; ZERO airline/US-utility/telecom/52-53-week-retailer/loss-making-biotech/
deferred-revenue-software/natural-resources; no direct-method CF, no restatement, no discontinued
ops. Registry 160 (148 portable / 12 custody). Synthetic cohort: 32 FIXED recipes, not a generator,
and run_frozen_cohort.mjs is dispositioned PIPELINE_ENTRYPOINT — never runs in CI. Oracle matrix 15
domains (10 artifact / 5 synthetic_unit_only).

- **P7.1** GAP: no coverage grid, no global corpus, no custody register beyond two family manifests;
  support-envelope-v377.json declares 11 dimensions (~40 values) consumed only by the classifier —
  nothing joins dimension values to corpus evidence, so the support-claim-vs-evidence gap test has
  no producer. Absolute host path hardcoded in corpus manifest :7 (runner correctly takes
  --custody-root). Public filing bytes cached+hashed (URL risk closed for what exists).
- **P7.2** GAP (greenfield): NO goldens anywhere; registry doctrine declares golden_actions_performed
  false; only committed expected-contract is the custody-gated real-filings classification receipt.
  ORDERING TRAP: the phase wants canonical-Economic-IR goldens but no Economic IR exists (P3.1) —
  freezing today would pin the workbook, the exact brittle golden the register warns against.
  Either wait for P3.1 or declare a workbook-manifest-only golden layer as a versioned narrowing.
- **P7.3** GAP: fixed 32-recipe cohort, seeds are constants (mulberry32 decorates, never explores);
  no property framework, no shrinker, no seed registry; volumes 32 vs 2-3k PR / 10k nightly / 25k
  weekly; cohort runner unregistered.
- **P7.4** GAP (greenfield): one localised metamorphic block in the custody-gated broker matrix
  (6 checks, BLOCKED on CI); zero label-synonym/legal-suffix/ticker-market/row-reorder/whitespace/
  unit-wording transforms; locality assertions impossible until P4.6/P3.6 give a canonical graph.
  Nearest primitive: economic_signature_sha256 equality (phase9 e2e :501-514).
- **P7.5** GAP: 38 mutation-class suites, mechanics good, but (a) NO mutation score / survivor
  register / gate; (b) run_critical_invariant_oracle_matrix_tests.py:141,176 write detection_rate
  1.0 as LITERAL CONSTANTS and 5 of 15 domains are hand-written tautologies touching no production
  code; (c) no runtime/package mutation class; (d) no zero-survivor gate on P0 invariants;
  (e) no PR-vs-nightly split.
- **P7.6** GAP (best surface, 3 holes): 12,379 lines of genuinely independent stdlib/openpyxl
  Python — BUT (a) the independence AST scan covers exactly ONE file and
  FORBIDDEN_PRODUCTION_IMPORTS is an EMPTY LIST published as evidence
  (verify/emitted_candidate_artifact_oracle.py:28,:383); (b) run_ci_census_tests.mjs:125-129 reads
  scripts/ NON-RECURSIVELY so scripts/verify/run_*.py are invisible — six oracle harnesses neither
  registered nor dispositioned; (c) no oracle coverage matrix; no independent oracle for: solver
  fixed point, debt roll-forward, opening-debt bridge, ETR, RCF from cash need, policy selection,
  authority ranking, classification, stitching, XBRL, capture transactions, SCC construction.
- **P7.7** GAP: ONE CI tier (PR + main push; no schedule:, no nightly/weekly/release gates); PR gate
  runs 148 portable tests against 2 synthetic fixtures + 1 representative; no sharding, no
  quarantine (owner/expiry), no trend reports.
- **P7.8** GAP: freeze target absent — programme/checkpoints/ missing (template ready), index
  current_phase stale, NO behavioural freeze hash (attestation binds source identity, never
  behaviour; the only behavioural digest is the unregistered cohort report). Blocker replay: 3 of 6
  cases never executed (hash-verified only). Terminal-outcome census has vocabulary and no counter.
  KNOWN RED baseline to freeze as declared totals: 55/90/1/0/0 (EQUIVALENCE_COHORT_BASELINE.md).
  Must produce items 1, 2, 4 of PHASE8_WORK_ORDERS.md "What Phases 9-10 need".

## Sequencing (code-implied; differs from the pack's linear order)
P7.6-scan-widening + P7.7-tier-split FIRST (cheap, pure infra) → P7.1 coverage-grid → corpus-fill →
P7.2 goldens (after P3.1 or declared narrowing) → P7.4 metamorphic (needs P7.3 generator) →
P7.5 mutation score (needs P7.6 scans or scores are decorative) → P7.7 gate composition → P7.8
freeze (needs programme/checkpoints/).

## Cheapest high-value close (~40 lines, 3 files, zero in-flight conflicts) — P7.6a
1. run_ci_census_tests.mjs recursive scan → surfaces six dark verify/ harnesses as UNCLASSIFIED
   (existing negative self-test already makes that a hard failure); register/disposition each.
2. Lift the AST import scan to a shared helper over EVERY scripts/verify/ file; populate
   FORBIDDEN_PRODUCTION_IMPORTS instead of publishing an empty list.
3. Replace the two literal 1.0s with computed kill ratios; re-scope or mark the 5
   synthetic_unit_only domains NOT_INDEPENDENTLY_PROVEN in the matrix asset.
Runner-up (parallel): register run_frozen_cohort.mjs as a cohort-phase suite + nightly schedule:
trigger (32 dark cases → nightly, no new test code). NOTE ci-governance pins regex the workflow —
check run_ci_governance_tests.mjs before workflow edits.

## Overlap holds (as of e0618e2)
- forecast_candidate_compiler/ownership_resolver mid-edit (P3.4): ownership contract moves the
  KNOWN RED totals — record deltas or the P7.8 baseline is unpinnable.
- extract_inline_xbrl + run_filings_pipeline mid-edit (P2.2): P7.1 consumes the wired lane, don't race.
- compile_skill_release/runtime_isolation/source_identity mid-edit (P8.2a): freeze tag + release
  gate terminate there; do not open a second closure definition from the P7 side.
- funded_acquisition_plan/plan_builder/build_dynamic_model mid-edit (P5.1a): defer golden minting
  on acquisition/workbook surfaces until it lands.
