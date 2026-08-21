# Cash waterfall specification

Normative. Where `calculation-rules.md` summarises, this document governs.
Engine of record: the cash loop in `scripts/lib/solver.mjs` (`rcf.draw`,
`rcf.repayment`, `cash.ending_balance`, `rcf.liquidity_shortfall`) and the
visible waterfall rows in `scripts/build_dynamic_model.mjs`.

## Purpose

Codify the one cash mechanism the model runs in every forecast period and in
every basis column (standalone, adjustment, pro-forma): how cash arrives, what
the revolver may fund, what it may never fund, and what becomes visible when
committed capacity is not enough. The controlling idea: **the RCF is the only
balancing facility; a liquidity shortfall is a result, never something the
engine makes disappear.**

## Waterfall order

Evaluate once per period, in this order. Each stage feeds exactly the next;
no movement may enter ending cash twice.

```text
cash before debt
  = opening cash
  + cash from operations
  + cash from investing          (net of acquisition cash consideration)
  + FX effect on cash
  + non-debt financing           (dividends, buybacks, other financing)

cash before mandatory repayment = cash before debt + non-RCF issuance (+ acquisition debt proceeds)

cash after mandatory repayment  = cash before mandatory repayment − mandatory repayment

deficit = MAX(0, minimum cash − cash after mandatory repayment)
surplus = MAX(0, cash after mandatory repayment − minimum cash)

available RCF capacity = MAX(0, facility capacity − opening RCF)
RCF draw    = MIN(deficit, available RCF capacity)
RCF repayment = IF(draw > tolerance, 0, MIN(surplus, opening RCF))

ending RCF = opening RCF + RCF draw − RCF repayment
ending cash = cash after mandatory repayment + RCF draw − RCF repayment

visible liquidity shortfall = MAX(0, minimum cash − ending cash)
```

### Rules

- **MUST** compute mandatory repayment once per period from the visible debt
  schedule (scheduled amortisation plus instruments whose contractual maturity
  falls inside the period, when `debt_maturities_roll` is on). Membership is
  semantic: every eligible non-RCF instrument qualifies regardless of its
  physical row. The balancing RCF is always excluded from the pool; a balancing
  RCF that carries scheduled amortisation is a case error, not a repayment.
- **MUST** keep draw and repayment mutually exclusive within a period. A period
  with a deficit may draw; a period with a surplus may repay only opening drawn
  RCF. A draw made this period is never repaid this period. The two legs are
  compared at solver tolerance (1e-8), not at zero.
- **MUST** cap every draw at remaining commitment: `capacity − opening RCF`,
  floored at zero. The facility is never upsized by need, and no bond,
  acquisition debt or other facility is ever auto-swept to balance cash.
- **MUST** retain surplus above the floor once the RCF is repaid. Excess cash
  stays cash; there is no sweep to term debt and no discretionary prepayment.
- **MUST** show any residual shortfall as its own visible row:
  `Residual liquidity shortfall = MAX(0, minimum cash − ending cash)`. Ending
  cash is stated once on the cash-flow statement; the shortfall row states what
  the committed structure could not fund. Never net the shortfall away, fund it
  from an undeclared source, or let ending cash go silently negative.
- **MUST** state the minimum-cash floor as `minimum_cash_override` when
  supplied, otherwise as the **minimum of the three historical year-end
  balances** of the balancing cash bucket (legacy cases: `historical_year_end_cash`).
  An override must be null or non-negative; a negative floor is a case error.
- **MUST** apply the same floor and the same waterfall in standalone, adjustment
  and pro-forma columns. The deal does not change the floor: the adjustment
  column carries the floor as a structural zero difference and draws against
  incremental capacity only.
- **MUST** gate every forecast interest leg on the circularity breaker
  (`controls.circularity`). Breaker off: instrument, RCF, commitment fee, lease,
  acquisition, other/unallocated and non-cash interest, and interest income all
  return formula-driven zero, and the operating-cash-flow bridge adds back no
  non-cash interest (there is none in net income to add). Raw rate assumptions
  are untouched in both states.
- **SHOULD** present deficit/surplus as one signed row (`cash before RCF −
  minimum cash`) rather than two guarded rows, so the reader reads headroom or
  shortfall without reconciling which MAX() fired.
- **SHOULD** record, per period, which constraint bound the revolver: the draw
  side names `cash_need` or `undrawn_capacity`; the repayment side names
  `cash_surplus` or `opening_balance` (or `suppressed_by_draw`); ties at
  tolerance are named `tie`. Both candidate values travel with the period.

## Worked examples

Amounts in reporting currency millions. Tolerance effects ignored (all example
differences are far larger than 1e-8).

### Example 1 — draw year, floor restored (December FYE)

Opening cash 40; CFO 210; CFI −120; FX on cash −5; dividends −60; non-RCF
issuance 0; mandatory repayment 50; minimum cash 30; RCF capacity 250; opening
RCF 20.

```text
cash before debt            = 40 + 210 − 120 − 5 − 60        =   65
cash after mandatory        = 65 + 0 − 50                    =   15
deficit / surplus           = 30 − 15 = 15 deficit
available capacity          = 250 − 20                       =  230
RCF draw                    = MIN(15, 230)                   =   15
RCF repayment               = 0 (draw active)
ending RCF                  = 20 + 15                        =   35
ending cash                 = 15 + 15                        =   30
shortfall                   = MAX(0, 30 − 30)                =    0
```

Binding classification: draw active, bound by `cash_need`
(slack |15 − 230| = 215). The company ends exactly at its floor.

### Example 2 — surplus year, revolver repaid (December FYE)

Opening cash 80; CFO 260; CFI −90; FX on cash 0; dividends −70; senior-notes
issuance 100; mandatory repayment 75; minimum cash 40; capacity 300; opening
RCF 60; commitment fee 25 bps on undrawn.

```text
cash before debt            = 80 + 260 − 90 + 0 − 70         =  180
cash after mandatory        = 180 + 100 − 75                 =  205
surplus                     = 205 − 40                       =  165
RCF draw                    = MIN(0, 240)                    =    0
RCF repayment               = MIN(165, 60)                   =   60
ending RCF                  = 60 − 60                        =    0
ending cash                 = 205 − 60                       =  145
shortfall                   = MAX(0, 40 − 145)               =    0
```

Binding classification: repayment active, bound by `opening_balance`
(slack |165 − 60| = 105): the whole opening draw repaid, 85 of excess retained.
Commitment fee accrues on average undrawn 300 − (60 + 0)/2 = 270 → 270 ×
0.0025 = 0.675 inside gross interest, hence inside CFO — the fee never appears
as a separate cash movement.

### Example 3 — capacity exhausted, visible shortfall (September FYE)

Fiscal year 1 October 2025 – 30 September 2026. Opening cash 25; CFO −45; CFI
−30; FX on cash +3; dividends −10; non-RCF issuance 0; mandatory repayment 28;
minimum cash 30 (override); RCF capacity 50; opening RCF 45.

```text
cash before debt            = 25 − 45 − 30 + 3 − 10          =  −57
cash after mandatory        = −57 + 0 − 28                   =  −85
deficit                     = 30 − (−85)                     =  115
available capacity          = 50 − 45                        =    5
RCF draw                    = MIN(115, 5)                    =    5
ending RCF                  = 45 + 5                         =   50   (exhausted)
ending cash                 = −85 + 5                        =  −80
shortfall                   = MAX(0, 30 − (−80))             =  110
```

Binding classification: draw active, bound by `undrawn_capacity`
(slack |115 − 5| = 110); shortfall binding `capacity_exhausted`. The engine
draws the last 5, stops, and shows 110. It does not stretch the facility, net
the overdraft against the floor, or skip the dividend to force balance.

## RCF-exhaustion contract

When the visible shortfall is positive in any forecast period:

- **MUST** emit the `Residual liquidity shortfall` row and the plausibility
  finding `liquidity_shortfall_period_N` (plus `negative_ending_cash_period_N`
  when ending cash is below zero, and `rcf_near_exhaustion_period_N` when
  drawn ÷ commitment ≥ 95%).
- **MUST** carry the binding-constraint classification for the period so the
  reader sees *which* constraint bound: need vs capacity on the draw, surplus
  vs opening balance on the repayment.
- **MUST** resolve the shortfall through one of three declared downstream
  outcomes, chosen as an explicit user decision:
  1. **Debt refinancing draw** — add or upsize a named instrument (for example
     a senior-notes issuance) whose proceeds flow through the ordinary
     non-RCF-issuance line of the waterfall;
  2. **Equity injection** — declare an equity input that flows through non-debt
     financing;
  3. **BLOCK** — deliver with a plain-language terminal: "committed RCF
     capacity cannot maintain the minimum-cash floor from FY-N; the shortfall
     is X and no funded resolution was declared."
- **DEFAULT**, when nothing is declared: keep the visible shortfall row and
  raise the ASK finding. The model never picks a refinancing story on the
  user's behalf.

## Refusal conditions

- **BLOCK** — negative or non-numeric `minimum_cash_override`; negative
  facility capacity; a balancing RCF carrying scheduled amortisation into the
  mandatory pool; any candidate whose draw exceeds remaining commitment; any
  path where a cash movement reaches ending cash twice or bypasses the visible
  cash-flow statement; non-convergence of the cash loop beyond policy
  (non_convergence = BLOCK).
- **ASK** — positive shortfall with no declared downstream outcome (default
  state); a balancing bucket missing both override and three historical
  year-end balances, so no lawful floor exists.
- **DEGRADE** — `rcf_near_exhaustion_period_N` (drawn ≥ 95% of commitment);
  foreign-currency RCF where draw measurement depends on the average-rate
  convention (recorded, capacity still enforced in native currency).

## Open questions

- Should intra-year timing ever be modelled, or does the annual waterfall's
  ability to hide an intra-year deficit stay a declared limitation?
- Should the floor accept a percentage-of-revenue convention as a third rung?
- Does the equity-injection outcome warrant its own visible statement line, or
  does it stay inside non-debt financing with a label?
- FX-on-cash enters before mandatory repayment today; confirm no case needs it
  applied to native-capacity measurement instead.
