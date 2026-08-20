# Phase 6 — runtime SLO evidence (P6.8)

Every file here is DERIVED. The only writer is
`node scripts/run_runtime_slo_tests.mjs --seal evidence/phase_6`, which measures
the cohort by driving the real `run_user_flow` controller and reading the
ledgers those runs persisted. Nothing in this directory is hand-typed, and a
number here that no longer follows from the declaration or from the samples
beneath it fails the suite rather than passing.

## The one declaration

`assets/performance-policy-v1.json#runtime_slo` is now the single runtime
service-level declaration:

| | ms | minutes |
| --- | --- | --- |
| p50 | 900 000 | 15 |
| p95 | 1 200 000 | 20 |
| hard ceiling | 1 500 000 | 25 |

It replaced two others, and `supersedes` records why each was wrong. The
important one: `service_objectives_minutes.standard_p50 = 35` and
`standard_p95 = 45` were not a rival opinion but UNSATISFIABLE — both exceed
the 25-minute ceiling the runtime enforces, so a run meeting that "objective"
would already have exhausted its only clock.

The declaration is bound BY NAME to the constants the runtime enforces
(`DEFAULT_RUNTIME_BUDGETS_MS.end_to_end_target` and `.end_to_end_hard_ceiling`)
and to `run_deadline.mjs#STAGE_FLOOR_TOTAL_ALLOWANCE_MS`. If any of them drifts
apart, `validateRuntimeSloDeclaration` refuses. No constant in P6.1's files
changed.

## The cohort — `runtime-slo-cohort.json`

Five cold and five warm invocations of the real controller. The measured value
is an INVOCATION DELTA against the persisted run clock, not the ledger total:
P6.1's clock is cumulative on purpose, so reading `compute_elapsed_ms` straight
off a warm ledger reports the warm run as slower than the cold run that seeded
it. The suite pins that inversion as a red.

`slo_coverage` is `LOWER_BOUND_ONLY`. The samples stop at the lawful PAUSED
boundary after `decisions`, because the delivered path does not complete at
this commit — see `certifying-scope-unavailable.json` for the two probes. A
subset scope can REFUTE the objective; it can never certify it.

## Hard-ceiling enforcement — `hard-ceiling-enforcement.json`

The ceiling is enforced as a BOUNDED ENVELOPE on grants with typed disclosure,
which is what P6.1's bounded floor actually produces:

* no grant exceeds what the clock has left plus the floor allowance still
  available at that moment;
* floor debt is drawn from a finite, ledger-recorded allowance (360 000 ms) and
  never reissued;
* once the ceiling AND the allowance are spent every grant collapses to 1 ms —
  proven here on the real controller, which is what makes the ceiling terminal
  rather than advisory at any spawn boundary;
* a grant made past an exhausted ceiling carries the registered
  `INTERNAL.runtime_budget_overrun` receipt;
* work running INSIDE the controller process is not preempted, so compute past
  the ceiling must be DISCLOSED by a typed receipt. Undisclosed overshoot is
  the failure, not overshoot.

Seven mutations of a real ledger are proven to fail the enforcement report.

## Files

| file | what it is |
| --- | --- |
| `runtime-slo-declaration.json` | the single declaration, its validation result, and the enforced constants it is bound to |
| `runtime-slo-cohort.json` | the cold/warm cohort, its p50/p95 aggregation and its verdict |
| `hard-ceiling-enforcement.json` | one enforcement report per measured ledger |
| `certifying-scope-unavailable.json` | why the cohort scope is a lower bound and not the delivered path |
| `phase6-runtime-slo-seal.json` | the seal: declaration + cohort + enforcement, hash-bound |

`seal_status` records what was measured. A cohort that exceeds the objective is
a FINDING recorded in the seal — never a reason to move the objective.
