# Custody-cohort equivalence: known baseline divergence (2026-08-19)

## Finding
`node scripts/run_case_compiler_equivalence.mjs` (full run, custody root present) exits 1 with
stable totals: **55 economic path diffs / 90 compile blocks / 1 failed compiled solve / 0 hard plan
diffs / 0 failed plan compiles**, concentrated in the frozen custody packs (astrazeneca-v2,
kerry-v2 variants). Verified in PRISTINE worktrees:

- at `30a6d50` (committed head, no working changes): exit 1, totals above;
- with the P2.3+P2.5+P4.2 working tree applied: exit 1, IDENTICAL totals — the three packages
  introduce zero new divergence (each agent also verified byte-identical case output pre/post);
- at tag `excel-inflow-v376-evidence-baseline` (433bd237): the harness does not reach the report —
  it CRASHES in `resolveBrokerConsensusSelection` on the frozen packs' pre-contract broker shape.

## Interpretation
The session's legacy broker adapter (provider_consensus_source custody declaration +
sealBrokerConsensusMembership) made the custody cohort RUNNABLE for the first time. The reported
divergences are the frozen pre-contract packs failing the v3.7.7 typed contracts the programme
added deliberately (case.shape, forecast_authority coverage, classification destinations). They are
not regressions introduced by any single package: the packs were previously un-comparable, not
equivalent.

## Custody of the claim
- Earlier receipts citing "equivalence 0 diffs" for FULL cohort runs were exit-code-masked
  (`… | tail -N` returns tail's exit). The AZ replay "0 diffs" claim applied to the AZ replay
  subset at adapter time, not the full cohort under later contract tightenings.
- CI is unaffected and stays truthful: the registered portable equivalence tests run without
  custody and are green; custody tests are explicit-BLOCKED-allowed on CI.

## Disposition (named owner, not silent)
The frozen custody packs need contract-migration adapters (the P1.2/P1.3 core-only remainder —
named migration owners) or a recorded refusal treatment per pack. Until then this harness's full
custody run is a KNOWN RED with the totals pinned above; a change to these totals in either
direction requires investigation. Never "fix" this by weakening compile blocks or regenerating
frozen packs.
