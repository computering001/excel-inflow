# Blocker replay corpus (P0.2)

Invariant: **every known blocker reproduces deterministically or is explicitly
classified as non-reproducible with its missing evidence named.**

The single registry for this corpus is `corpus_manifest.json`. The verifier is
`scripts/run_blocker_corpus_tests.mjs` (registered as `blocker-replay-corpus`).
It hash-verifies every fixture BEFORE any replay executes, refuses a tampered
fixture with the typed error `BLOCKER_CORPUS_FIXTURE_REJECTED` (proven by a
built-in negative self-test), executes the fast deterministic replays, and
reports custody-bound fixtures as typed `CUSTODY_ABSENT` on hosts without the
private custody store. Never use a later repaired workbook as the raw fixture
for an original failure; hashes here were computed before any normalisation.

## Cases

### astrazeneca-tax-schema-blocker — MINIMISED_ONLY
The 2026-08-11 corrupted AstraZeneca live delivery (tax schema, identity,
statement-role, policy-totality, debt-bridge defects). **Evidence gap, named:**
the raw live-run bytes existed only inside the Rogo host and were never
exported. The sealed `astrazeneca-v2.json` certification case (external
custody symlink, sha `877724f8…`) is the minimised reproducer; replay =
`run_case_compiler_equivalence.mjs <cases-dir> astrazeneca`, expecting clean.

### apple-us-gaap-raw-canary — FULL
Raw SEC Form 10-K bytes (custody, sha `10859005…`) driven black-box to a
delivered workbook. Historically failed through the signatures listed in the
manifest (duplicate answer owner, scope-capture, SCC split, cycle containment,
fiscal contract, provenance comments) — all resolved by `e745176`; at the
frozen baseline the canary DELIVERS. Heavy replay owned by
`run_raw_input_black_box_canary.mjs`; this suite hash-verifies the raw inputs.

### working-capital-capture-blocker — FULL
The general capture-parent defect family probed by Apple (parent identity
formula captured its own children; self-carry rewired into a parent link).
Fast replay = the decisions-stage user-flow run asserting the WC family is
children-owned with self-referential carries.

### etr-recursion-normalisation — FULL (synthetic reproducer)
Historical ETR recursion/normalisation receipt failures. Original live bytes
(v57-era Rogo) not exported — gap named. Deterministic reproducer:
`run_tax_rate_policy_tests.mjs`, signature `{"checks":24,"status":"PASS"}`.

### package-identity-discrepancy — FULL, KNOWN FAILING AT BASELINE
`run_release_identity_governance_tests.mjs` pins skill_version `3.7.5` and
fails `ERR_ASSERTION "'3.7.6' !== '3.7.5'"` at line 29 against the 3.7.6
runtime manifest — the registered CI gate is untruthful at exact head. The
corpus asserts this exact signature reproduces. **Repair is owned by P0.3**;
sealing P0.3 flips this case's expectation to PASS in the same commit.

### runtime-deadline-overrun — FULL (synthetic reproducer)
Historical live stalls/overruns (2026-08-12 era, Rogo logs not exported — gap
named). Deterministic reproducer: `run_run_deadline_tests.mjs`, signature
`{"checks":17,"status":"PASS"}`.

## Verification commands

```bash
node scripts/run_blocker_corpus_tests.mjs
```

Latest frozen result: `programme/P0.2_reproduction_report.json`.
