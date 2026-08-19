# Custody-cohort equivalence: known baseline divergence (2026-08-19)

## Finding
`node scripts/run_case_compiler_equivalence.mjs` (full run, custody root present) exits 1 with
stable totals. **CURRENT PIN (from P2.10, defect D5): 55 economic path diffs / 98 compile blocks /
1 failed compiled solve / 0 hard plan diffs / 0 failed plan compiles.** The compile-block count was
90 before P2.10 unified the footing tolerance; see "Baseline movement" below for the traced cause.
The divergence is concentrated in the frozen custody packs (astrazeneca-v2, kerry-v2 variants,
kingspan-v2). Verified in PRISTINE worktrees:

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

## Baseline movement — 90 -> 98 compile blocks (P2.10 / defect D5, 2026-08-19)
Investigated end to end as this document requires, and independently re-verified by the
coordinator (55/98/1/0/0; kingspan-v2 33 -> 41 blocks, every other pack unchanged).

Cause: P2.10 replaced two disagreeing footing tolerances with one IEEE754-derived bound
(rounding tolerance for the declared precision + a recursive-summation float-noise bound).
Both prior forms were wrong in opposite directions: case_compiler's exact-0 REJECTED
arithmetic that is correct to the printed precision, while model_ir_v3's `1e-9 * max(1,|target|)`
ACCEPTED a genuine one-printed-unit break at a 500,000,000 total (tolerance 1.0). The footing
pass was the LOOSER oracle, not merely the more permissive one.

kingspan-v2's own filed values are float-contaminated (cf.ending = 584.6999999999997,
is.gross_profit = 2339.7000000000007). The movement decomposes exactly:
- MINUS 1: a FALSE face_additivity block on cf.ending disappears — a 3.4e-13 residue on 584.7
  had been reported as a mis-footed subtotal.
- PLUS 9: operating_profit (filed 835.2 / 862.1 / 903.5) now reconstructs as
  trading_profit + intangible_amortisation (residues 7.9e-13 / 4.5e-13 / 1.1e-13, all of which
  exact-0 rejected). Recovering that real identity makes trading_profit a source-visible
  aggregate, so the frozen pack's missing children-owned forecast authority is refused across
  3 channels x 3 periods.

Direction: STRICTER. One false refusal removed; nine real refusals gained. The newly refused
thing is precisely the pre-contract migration debt this document already names as the cohort's
disposition (P1.2/P1.3 remainder). Nothing was weakened to reach it, and no golden or frozen
pack was regenerated.

Side effect, recorded: bridge_operating_profit / reported_ebitda history shifts by ~7e-13
(835.2 -> 835.2000000000007) because a recovered filed subtotal trades filed values for the
minted formula.
