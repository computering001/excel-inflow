# Convergence dossier — net-cash [2,2,2] → [6,6,6] across 488ea00

Analytical record, not normative. Companion to the pin in
`scripts/run_declared_fixed_point_completeness_tests.mjs` ("both certified
fixtures converge in exactly the sweeps they always did"). Question answered
here: why the `standard-net-cash-v2` certified case went from two solver
sweeps per period to six when 488ea00 (parent 64a24a8, the B1/B3/B6/B7
economic-conventions batch) landed — and why that change is lawful rather
than a regression.

## TL;DR

The batch's **B3** — excluding the lease leg from `cash_interest_paid` —
rewired the calculated cash-interest row feeding declared CFO. Before B3 the
circular map was exactly one-shot (loop gain zero). After B3 the
interest-income ↔ CFO ↔ cash path carries a small per-sweep gain,
**ρ ≈ 0.0125**, so the solver contracts geometrically instead of landing in
one update, needing ⌈log(tol/r₀)/log(ρ)⌉+1 ≈ 6 sweeps at this fixture's
applied tolerance (4.01e-9). Single-fix reverts exonerate B1; B7 touches
published rows only. Declared outputs at convergence are identical either
side of the boundary (**oracle Δ = 0**) — the batch changed the path length,
not the destination. Damping and bisection mechanics are untouched.

## 1. The pin

Reproduced by a scratch tracer reading each solver build's own published
`graph_driven_solve.convergence_trace`; fixtures are byte-identical across
the bisect boundary, so the effect is code, not data.

| Certified case | 64a24a8 (pre-batch) | 488ea00 (post-batch) | Moved? |
| --- | --- | --- | --- |
| `standard-net-cash-v2` | [2, 2, 2] | [6, 6, 6] | yes — the subject |
| `standard-maximal-v2` | [8, 8, 8] | [8, 8, 8] | no |
| `loss_making_no_nol_stock` archetype | [6, 6, 6] | [6, 6, 6] | no |

Only net-cash moved, and every period moved identically.

## 2. Residual traces (old loop vs new loop)

**Old loop (64a24a8)** — exactly stationary after one update; zero loop gain:

| Sweep | Worst-node residual |
| --- | --- |
| 1 | update lands |
| 2 | **0** (literally zero) ⇒ exit |

**New loop (488ea00)** — geometric contraction at ρ ≈ 0.0125 per sweep;
residuals below are the recorded worst-node values from the published trace:

| Sweep | Worst-node residual |
| --- | --- |
| r₀ | 1.25e-2 |
| next | 1.56e-4 |
| next | 1.95e-6 |
| next | 2.44e-8 |
| next | 3.05e-10 |

Each value is the previous multiplied by ≈0.0125; the applied tolerance is
4.01e-9 and the published iteration count is 6 — matching the closed-form
prediction ⌈log(tol/r₀)/log(ρ)⌉+1 ≈ 6 for these endpoints. The worst node
alternates `cash.ending_balance ↔ cash.cfo ↔ interest.cash_income`, and the
shape is identical in all three periods — consistent with a single loop
mechanism, not per-period noise.

## 3. Causal attribution — single-fix reverts

Surgical single-fix reverts were built at the boundary and re-run:

| Variant | Net-cash sweeps | Verdict |
| --- | --- | --- |
| 64a24a8 (no fixes) | [2, 2, 2] | baseline |
| 488ea00 (all fixes) | [6, 6, 6] | the move |
| **B3 only reverted** (`cash_interest_paid`: `−(gross−lease−nonCash…)` back to `−(gross−nonCash…)`) | **[2, 2, 2]** | **B3 is the necessary cause** |
| B1 only reverted (declared-tax canonicalisation) | [6, 6, 6] | B1 exonerated |
| B7 | — | published-row-only per diff; no solver-path effect |

A probe confirmed the B3 override fires for this fixture on **every** sweep
(the row is reached via statement-role normalisation aliasing), so the gain
is exercised continuously, not on a single pass.

## 4. Mechanism

B3 changes the composition of the calculated cash-interest row that feeds
declared CFO. That rewiring turns what was an exactly-one-shot fixed-point
map into one with per-sweep gain ≈ 0.0125 propagated around the
interest-income ↔ CFO ↔ cash path; convergence then requires the geometric
run of Section 2 instead of one confirming sweep. The count is therefore
**structural, not accidental**: it follows from the loop gain and the
tolerance, and it will sit at ≈6 for any fixture of this shape until the
gain or the tolerance moves.

Confidence is high; the one unproven link is the edge-by-edge derivation of
the 0.0125 constant (measured, not yet derived from the graph weights).

## 5. Oracle cross-check — Δ = 0

Declared outputs at convergence are identical on both sides of the boundary:
the oracle comparison across 488ea00 returns **Δ = 0**. The batch changed how
many sweeps the solver takes to reach the fixed point, not the fixed point
itself — which is why this dossier records a lawful convergence-path change
and the completeness pin still holds.
