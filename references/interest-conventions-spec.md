# Interest conventions specification

Normative. Where `calculation-rules.md` summarises, this document governs.
Engine of record: the instrument state compiler
(`scripts/lib/instrument_period_state.mjs`), the solver interest block
(`scripts/lib/solver.mjs`) and the revolver binding module
(`scripts/lib/solve_order.mjs`).

## Purpose

Codify how the engine prices every interest leg: the day-weighted average
balance, PIK accretion, benchmark floors, the commitment fee, the circularity
kill switch, and the pricing vocabulary that is designed but not yet live. The
controlling idea: **one average-balance convention, applied to every leg, with
every convention that changes a number declared — never inferred.**

## Average-balance convention

### Rules

- **MUST** compute the interest-bearing base day-weighted within the period:

```text
weighted base
  = opening balance            × active fraction
  + new issuance               × dated issuance fraction
  + (fair value + other non-cash movement) × active fraction / 2
  − capped amortisation        × dated amortisation fraction
```

- The **active fraction** is the instrument's live share of the period. It
  shortens only when the instrument contractually matures inside the period
  and `debt_maturities_roll` is on; otherwise it is 1.
- **Dated fractions** come from the supplied movement date: the share of the
  period from the movement date to the active end, inclusive of both endpoints.
  When no date is supplied the movement is assumed at mid-active-period, i.e.
  fraction `active fraction / 2` (the historic average-balance behaviour).
- **Capped amortisation** is the scheduled amortisation limited to the balance
  actually available: `MIN(amortisation, MAX(0, opening + issuance + fair
  value + other))`. An amortisation larger than the balance amortises the
  balance, never creates a negative base.
- **MUST** apply the identical convention to every leg, including the
  acquisition leg and the RCF (drawn balance averaged opening/ending). No leg
  is priced on its closing balance alone.
- **MUST** apply the stated annual rate directly to the average balance. The
  engine does **not** gross a stated coupon up to an effective annual rate;
  compounding vocabulary was deliberately removed and must not return through
  a side door.

```text
average balance = weighted base + PIK accretion × active fraction / 2
cash interest   = MAX(0, average balance × cash rate)
```

### Worked example 1 — fixed bond, undated amortisation (December FYE)

Term loan: opening 400, scheduled amortisation 40 (no dates), coupon 6.0%,
full year active.

```text
weighted base   = 400 × 1 − 40 × 1/2            = 380
average balance = 380                            = 380
cash interest   = 380 × 6.0%                     = 22.8
ending balance  = 400 − 40                       = 360
```

The amortisation is half-weighted because it is undated: on average, only half
of it was outstanding during the year.

## Floating rate and floors

### Rules

- **MUST** build the floating all-in rate per period as

```text
cash rate = MAX(benchmark, benchmark floor) + spread bps / 10 000
```

  The floor applies to the benchmark **before** the spread is added — a floor
  belongs to the reference leg, not to the all-in rate.
- **MUST** declare the benchmark floor explicitly per period for every floating
  instrument. Omission preserves the historic zero-floor behaviour but is a
  declared gap: the engine keeps pricing with floor 0 and records the gap.
- **MUST** keep benchmark, spread and any manual all-in rate visible as
  assumptions. Never bury a rate inside an instrument subtotal.
- **MUST NOT** reinterpret a percentage-of-margin fee convention as basis
  points, and never convert units silently.

### Worked example 2 — dated maturity and issuance, day-weighted (September FYE)

Fiscal year 1 October 2025 – 30 September 2026 (365 days, both endpoints
counted). Two instruments:

- Term Loan A: opening 240, matures 31 March 2026, no amortisation, coupon 6.0%.
  Active fraction = 1 Oct 2025 → 31 Mar 2026 inclusive = 182 days → 182/365.
- Senior notes draw: issuance 150 dated 1 April 2026, coupon 5.5%. Dated
  fraction = 1 Apr 2026 → 30 Sep 2026 inclusive = 183 days → 183/365.

```text
TLA:    240 × 6.0%  × 182/365 = 14.40 × 0.498630 = 7.18
Notes:  150 × 5.5%  × 183/365 =  8.25 × 0.501370 = 4.14
identified cash interest                          = 11.32
```

The fractions sum to exactly 1: the facility that left and the facility that
arrived together cover the year, each priced only for the days it was live.
Ending TLA balance 0 (maturity roll), ending notes 150.

## PIK and zero-coupon instruments

### Rules

- **MUST** compute PIK accretion in closed form, **before** cash interest, on
  the day-weighted principal outstanding before PIK:

```text
PIK = weighted base × r / (1 − r × f / 2)
```

  where `r` is the period PIK rate and `f` the active fraction. The accretion
  is assumed to build evenly across the instrument's active part of the period,
  so the closed form is the fixed point of that build-up. Full-year undated
  cases reduce exactly to the historic average-balance convention.
- **MUST** add the period PIK to principal (non-cash) and price any cash
  coupon on the average balance including half the accretion.
- **MUST** refuse a PIK rate whose denominator is not positive — `r × f / 2 ≥ 1`
  (in effect r at or above 200% on a full year) has no fixed point under this
  convention and is a case error, not a large number.
- **MUST** treat a zero-coupon instrument as coupon 0% plus its `pik_rate`:
  `cash_interest = false` prices the cash leg at exactly zero while PIK still
  accretes. An `unpriced` instrument is missing evidence, not a 0% economic
  assumption — it belongs in the residual-interest-plug lane with blank rate
  cells, never in a priced row.
- **MUST** gate PIK on the circularity breaker like every other interest leg.

### Worked example 3 — PIK mezzanine plus floored floating loan (December FYE)

- Mezzanine: opening 100, PIK rate 12%, no cash coupon (zero-coupon), full year.

```text
PIK             = 100 × 0.12 / (1 − 0.12 × 1/2) = 12 / 0.94 = 12.77
average balance = 100 + 12.77 × 1/2             = 106.38
cash interest   = 106.38 × 0%                    = 0
ending balance  = 100 + 12.77                    = 112.77   (non-cash accretion)
```

- Floating term loan: opening 300, benchmark forecast 2.0%, declared floor
  3.0%, spread 400 bps, amortisation 30 (undated).

```text
all-in rate     = MAX(2.0%, 3.0%) + 4.0%        = 7.0%
weighted base   = 300 × 1 − 30 × 1/2            = 285
cash interest   = 285 × 7.0%                    = 19.95
```

The floor binds because the benchmark is below it; the spread is added after
the floor. Order matters: flooring the all-in rate instead would give
MAX(2.0% + 4.0%, 3.0%) = 6.0%, one point light.

## Commitment fee and the kill switch

### Rules

- **MUST** compute the commitment fee on the average **undrawn** balance, only
  under the declared convention:

```text
average undrawn = MAX(0, capacity − (opening drawn + ending drawn) / 2)
commitment fee  = average undrawn × fee value bps / 10 000
```

- Declared conventions are exactly `bps_on_undrawn`, `none` (sourced no-fee
  facility) and `captured_in_residual` (only for an explicitly unpriced
  facility). **Any other or ambiguous convention must refuse**: a balancing
  facility without an explicit convention and value — including an explicit
  zero — is a case error, and `bps_on_undrawn` with a zero value is refused in
  favour of `none`. The fee is an interest leg, not a cash movement.
- **MUST** treat `controls.circularity` as a kill switch. Off: every
  model-generated forecast interest leg — instrument cash, PIK, RCF,
  commitment fee, lease, acquisition, other/unallocated, non-cash — and
  interest income return formula-driven zero; net interest is zero; raw
  assumptions are untouched; the CFO bridge adds back no non-cash interest.
  On: all legs calculate through the conventions above. The breaker never
  deletes formulas and never edits assumptions.
- **MUST** keep gross and net interest as visible sums of their declared legs:
  `gross = identified instrument + RCF + commitment fee + lease + acquisition
  + other + non-cash`; `net = gross − interest income`. No leg may be counted
  twice, and no subtotal may arrive as a typed number.

## Designed vocabulary — planned, not live

The following are **DESIGN decisions recorded here; they are not implemented**.
Do not build on them and do not claim them in a delivered model until the
engine ships them:

- **Day-count enum**: `ACT/ACT` (annual, current behaviour), `ACT/360`,
  `ACT/365`, `30/360`. Until live, the stated annual rate applies directly to
  the average balance and no day-count conversion is performed.
- **Payment-frequency enum**: `annual` (current behaviour), `semi-annual`,
  `quarterly`. Until live, every coupon is treated as annual on the average
  balance.
- **IAS 23 / ASC 835 capitalised borrowing costs hook (D16)**: a designed field
  for borrowing costs capitalised into qualifying assets. Until live, the whole
  coupon is expensed and capitalised interest is out of scope; flag the gap
  where it is material rather than silently misstating capex.

## Refusal conditions

- **BLOCK** — PIK denominator not positive (`r × f / 2 ≥ 1`); a balancing RCF
  without explicit commitment-fee convention and value; `bps_on_undrawn`
  declared with a zero fee; `captured_in_residual` on a priced facility; a
  sourced ending balance that does not reconcile to the compiled roll-forward;
  an instrument class routed to the wrong lane (for example `lease_liability`
  on the debt register).
- **ASK** — a material instrument whose pricing is unknown (choose
  residual-plug lane versus a supplied rate); a commitment-fee disclosure
  without a stated basis; a request to model semi-annual or quarterly payment
  frequency or a non-ACT/ACT day count today (planned vocabulary, not live).
- **DEGRADE** — a floating instrument with no declared floor (zero-floor
  preserved and recorded); an `unpriced` instrument carried in the residual
  lane; a rate assumption that only reconciles history and cannot be sourced.

## Open questions

- Adopt dated day-count conventions per instrument when shipped — default
  `ACT/ACT` for existing cases, or re-baseline the certified fixtures?
- Should the commitment fee support bps-on-total-commitment and
  letters-of-credit-fee variants alongside bps-on-undrawn?
- Does PIK on the RCF (rare but seen in stressed credits) need the same
  closed-form treatment on the drawn balance?
- D16 capitalisation: which denominator policy (qualifying-asset capex share
  versus declared amount) and which statement lane for the capitalised portion?
