# Archetype fixtures

Adversarial accounting/economic archetypes bound to typed expectations.
Each subdirectory holds v2 model cases for one catalogue group:

- `economics/` — economic-shape archetypes (catalogue:
  `assets/archetype-catalogue-economics-v1.json`, runner:
  `scripts/run_archetype_economics_tests.mjs`).
- `presentation/` — presentation-group archetypes.

## mp-L adversarial economic archetypes (8 fixtures)

These eight cases are **not yet catalogue entries** (the catalogue and its
runner are owned separately); each one stands alone and was verified in one
batch pass through `validateCaseShape` + `solveCase` from
`scripts/lib/solver.mjs`, mimicking the archetype runner's compile→solve
pattern. Degenerate economics assert TERMINAL LEGALITY — the solve converges
with deficits disclosed as typed `liquidity_shortfall` values, no crash, no
silent zero — never commercial solvency. Recipe-token vocabulary for these
shapes lives in `scripts/compile_synthetic_cohort.mjs`
(`ADVERSARIAL_ECONOMIC_RECIPE_TOKENS`, folded into
`SUPPORTED_RECIPE_TOKENS`; no C1–C32 recipe uses the tokens yet).

| fixture | token | verified outcome |
| --- | --- | --- |
| `zero_revenue_bridge_year.json` | `economics:zero-revenue-year` | validates; solves (6 iters, residual 9.8e-10). FY1 revenue is exactly 0 end-to-end (bridge financing), EBITDA −220 flows through, burn disclosed as liquidity_shortfall 285.6 / 448.5 / 321.7 — no crash, no silent substitution of the zero. |
| `negative_equity_covenant_breach.json` | `economics:negative-equity` | validates; solves (9 iters). Accumulated losses exceed capital from FY1: net debt balloons 1291.6 → 1625.3 → 2016.1 on deeply negative EBITDA, RCF exhausts its 500 capacity, residual deficit disclosed as liquidity_shortfall 0 / 190.3 / 581.1. Leverage is negative/not-meaningful every year; no equity plug exists or is invented. |
| `extreme_leverage_20x.json` | `leverage:net-debt-gt-20x` | validates; solves (6 iters). Net leverage 23.11x / 22.63x / 22.59x — above 20x in every forecast year while EBITDA stays positive, so leverage stays meaningful; cash deficits disclosed (shortfall 64.5 / 131.7 / 197.5). |
| `hyperinflationary_subsidiary.json` | — (reuses existing `fx:*` vocabulary) | validates; solves (7 iters). IAS 29 shape mirroring `hyperinflationary_reporting.json`: restated series grow ~170%/yr (revenue 500 → 60 000) while volume-driven lines grow slowly. |
| `multi_currency_debt_stack_eur_gbp_jpy.json` | `fx:multi-currency-stack` | validates; solves (6 iters). Instruments in EUR/GBP/JPY under `modules.multi_currency` with declared period-end/average rate arrays; translated openings 220 + 200 + 136 = 556 reconcile against `reported_opening_gross_debt`; FX movement stays a non-cash translation row. |
| `pik_accrual_capitalised_interest.json` | `debt:pik-capitalised-hook` | validates; solves (6 iters). PIK construction note (9% accretion, cash_interest false) funding heavy capex. The D16-shaped IAS 23 hook is DECLARED and marked PLANNED: the v2 schema has no capitalisation field, so 100% of accretion sits in interest expense and capex is understated by the capitalisable amount — pinned honestly, not silently pretended away. |
| `sale_leaseback_proceeds.json` | `debt:sale-leaseback-proceeds` | validates; solves (6 iters). 320 restructuring inflow declared as `other_investing` in FY1 — an investing receipt, not revenue and not debt repayment. |
| `mid_year_fye_september.json` | `fiscal:mid-year-end-sep` | validates; solves (6 iters). Parity fixture for the corrected convention: Sep-30 FYE, PIK note maturing mid-year (2028-03-31); engine accrues day-weighted closed-form PIK to min(periodEnd, maturityDate). Engine vs closed form, exact: y0 f=1 pik 42.10526315789474; y1 f=1 pik 46.53739612188367; y2 f=183/366=0.5, base 244.321330, pik 25.058597911783508, maturity repayment 513.7012571915619 at 2028-03-31, ending 0. |

### Terminal-reason registry

No registry extension was made: none of the eight cases produced a refusal,
so no new reason code is registered (`assets/terminal-reason-registry-v1.json`
vocabulary was grepped first; every degenerate outcome above is a converged
solve with typed shortfall disclosure, which the existing contract already
covers).

### Verification (one batch pass)

```
node --check scripts/compile_synthetic_cohort.mjs
node scripts/run_archetype_economics_tests.mjs   # PASS 604 checks / 33 archetypes
node scripts/run_generated_cohort_tests.mjs      # PASS 333 checks
node scripts/run_ci_gate_tier_tests.mjs          # PASS 396 checks (exercises recipes)
```

plus a dedicated harness running all 8 fixtures through
`validateCaseShape` (0 errors each) and `solveCase` (converged,
`all_checks_pass` true each).
