# Release smoke case — the declared input to the release build

`production-model-smoke-case-v2.json` is the case
`scripts/compile_skill_release.mjs` compiles when no `--smoke-case` is passed.
It is named and hash-pinned in `assets/deployment-profile.json` under
`release_smoke_case`, the same way the Python entry points name their smoke
commands. Before P8.10 the one input that decides whether a release can be
built was passed ad hoc on a command line and written down nowhere.

## Why this case and not a fixture from `test-fixtures/cases/`

Both cases in `test-fixtures/cases/` declare `execution_profile:
"production_model"` and carry NONE of the three contract versions that profile
requires, so neither can enter the builder at all (defect D44). They are
pre-compiler artefacts: the contracts are minted by the compiler
(`scripts/lib/case_compiler.mjs`, "Contract stamps: compiled cases are
production cases by construction"), and feeding a hand-authored case to the
builder skips the stage that would make it conformant.

This case is the compiler's own output, so it carries them by construction:

    execution_profile                                production_model
    statement_authority_contract_version             authority_v1
    forecast_authority_contract_version              waterfall_v1
    source_coverage.classification_contract_version  evidence_v1

## Provenance — it is a real pipeline product, not a stamped fixture

It was compiled by `compileCase` from the evidence run the raw black-box canary
produces from raw filing bytes. `execution_profile` is DECLARED at the
case-source (`run_raw_input_black_box_canary.mjs`, `declarations.identity`) and
propagated by the compiler; it is not stamped onto a finished case afterwards.

That distinction is the whole point. `run_evidence_run_tests.mjs
--emit-compiled-case --production` will also produce a case that satisfies the
builder's `production_model` gate, but it does so by overwriting
`execution_profile` on the compiler's output. Declaring `production_model` at
the SOURCE of that synthetic fixture instead makes the evidence run refuse it:

    evidence.dcs.production_authority_missing
    evidence.broker.ingress_missing

The synthetic fixture is a reference-parity fixture and cannot satisfy those two
production gates. Using its stamped output here would have put a case in the
release gate that declares a mode whose entry conditions it never met.

## Regenerating it

The canary is a registered suite (`raw-input-black-box-canary`) and needs a
quiet tree; prefer an isolated `git worktree`.

    node scripts/run_evidence_run_tests.mjs test-fixtures/cases --emit-clean <tmp>/donor.json
    node scripts/run_raw_input_black_box_canary.mjs <tmp>/donor.json <python> <soffice>

The donor is digest-pinned by `scripts/lib/raw_canary_fixture.mjs`
(`RAW_CANARY_EVIDENCE_SHA256`); regenerate it rather than editing it. The case
is then `validateEvidenceRun(...).handoff.model_case` taken from the run's
`evidence/compiled-evidence/evidence-run.json`.

Update the `sha256` in `assets/deployment-profile.json#/release_smoke_case`
whenever this file is regenerated — the release compiler verifies it and refuses
a stale or foreign case.

## What this case does and does not prove

It proves the shipped package can compile a contract-complete production case,
render its workbook and pass the independent validator without reaching back
into the source tree. It is a single-issuer, IFRS, USD, two-instrument case with
the broker lane in `explicit_skip`; it is a build gate, not a corpus.
