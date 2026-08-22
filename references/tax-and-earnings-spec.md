# Tax and earnings specification

Normative. Where `calculation-rules.md` summarises, this document governs.
Engine of record: `scripts/lib/tax_rate_policy.mjs` and the tax block of
`scripts/lib/solver.mjs`.

## Purpose

Codify how the engine turns a filed tax history into a forecast effective tax
rate (ETR), how the rate prices earnings, what happens in loss years, and which
tax vocabulary is designed but not yet live. The controlling idea: **the ETR is
normalised from filed rows under a declared sign convention, kept inside a
usable window, and never silently becomes zero, a trend, or an identity.**

## Sign canonicalisation

### Rules

- **MUST** treat the canonical presentation as **expense-negative against
  positive PBT**: the emitted statement row carries tax expense as a signed
  negative quantity; the internal charge (`PBT × rate`) is a positive number;
  a usable rate is a positive fraction.
- **MUST** infer a filing's convention from its whole history, never one
  period: only profit periods anchor the inference (a loss period's tax sign is
  the benefit question itself). Majority expense-positive anchors declare
  `positive_expense_convention` and are normalised with that convention
  recorded on the ledger; with no profit period, canonical expense-negative is
  assumed.
- **MUST** classify a value on the wrong side of the declared convention
  against positive PBT as a credit year (`tax_credit_on_profit`) — not a rate —
  and exclude it from inference.
- **MUST NOT** rewrite a negative pre-tax income to zero. Losses are economic
  outputs; the flooring rule below governs the charge, not the loss.

## ETR normalisation

### Rules

- **MUST** normalise from the **filed** `tax_expense` and `pre_tax_income`
  rows directly, evaluating through the accounting calculation when a cell is
  materialised empty. The derived display ratio is evidence of last resort,
  not first resort.
- **MUST** keep every usable historical rate inside the window **(0, 0.60]**:

```text
rate = |normalised filed tax expense| / PBT      (profit periods only)
```

  Exclusions, each recorded on the ledger with its reason:
  - `rate ≤ 0` → `tax_credit_on_profit`;
  - `rate > 0.60` → `distorted_rate` (one-off settlements, valuation
    allowances);
  - `|PBT| < 2%` of the largest observed `|PBT|` → `near_zero_pbt` (arithmetic
    noise, not an economic rate);
  - `PBT < 0` → `loss_tax_benefit` or `loss_with_tax_charge`, owned by the
    loss policy, never by rate inference.
- **MUST** select the forecast ETR by rung, below guidance, broker and user
  authorities: median of usable rates when two or more survive; latest usable
  rate when exactly one survives; explicit loss-case treatment otherwise. The
  rate is deliberately stable — **no trend extrapolation is ever applied to a
  tax rate**.
- **MUST** apply the same usability window to **forecast-declared** rates:
  guidance, broker or user authorities outside `[0, 0.60]` are clamped to the
  nearest edge with the clamp recorded on the authority. *(New decision: the
  ceiling was previously a historical-inference filter only. It now binds
  forecast declarations too — a 68% broker ETR is a distortion entering the
  model, not a view.)*
- **MUST NOT** let the rate row become an identity: `tax = PBT × rate` paired
  with `rate = tax ÷ PBT` is the circularity the policy exists to break, and a
  candidate that recreates it is refused wherever it appears.

### Worked example 1 — expense-positive filing, median selection

Filed history (expense-positive issuer): PBT 100 / 120 / 110; tax +25 / +33 /
+24.2. All anchors positive → convention `positive_expense_convention`.

```text
rates = 25/100, 33/120, 24.2/110 = 0.250, 0.275, 0.220   all inside (0, 0.60]
forecast ETR = median(0.220, 0.250, 0.275)               = 0.250
```

Forecast PBT 140 → internal charge 140 × 0.25 = 35 → statement tax expense
−35, net income 105.

### Worked example 2 — exclusion ledger and forecast clamp

Filed history: (PBT 200, tax −40); (PBT 150, tax −105); (PBT 4, tax −1);
(PBT −80, tax +8).

```text
period 1: rate 40/200  = 0.200  usable
period 2: rate 105/150 = 0.700  > 0.60        → distorted_rate, excluded
period 3: |PBT| 4 < 2% × 200 = 4 threshold    → near_zero_pbt, excluded
period 4: PBT < 0, tax positive vs expense-negative → loss_tax_benefit, excluded
exactly one usable rate → carry forward 0.200
```

The user then declares a forecast ETR of 0.68 for one year. Forecast clamp:
`MIN(MAX(0.68, 0), 0.60) = 0.600`, clamp recorded. On forecast PBT 90 the year
charges 90 × 0.60 = 54 (statement −54), not 61.2.

## Loss years and earnings

### Rules

- **MUST** floor the current-tax charge at zero on losses: standalone current
  tax = `MAX(0, PBT) × ETR`. A loss year books no current tax charge and —
  absent shipped NOL vocabulary — recognises **no** tax benefit.
- **MUST** emit the DEGRADE finding `loss_benefit_not_realised` for each
  forecast period whose floored loss leaves a realisable benefit unrecognised —
  typically a loss year in an issuer whose history shows profitable
  taxpaying. "Not meaningful" must stay visibly different from "zero": the
  rate cell records the loss-policy state, never a silent 0%.
- **MUST** keep the recovery-year consequence visible: after forecast losses,
  the first profitable year is taxed **in full** at the ETR until NOL
  vocabulary ships (see below). Flag the finding rather than burying the
  distortion.
- **SHOULD** reconcile gross charge to net earnings visibly:
  `net income = pre-tax income − tax charge`, with the charge signed negative
  on the statement face, and the displayed ETR derived as charge ÷ PBT only
  when PBT > 0 (otherwise shown as not meaningful).
- **MUST NOT** hold the forecast ETR flat merely because one historical year
  reconciled; selection follows the rungs above from the usable ledger.

### Worked example 3 — loss flooring across a September FYE

Fiscal years end 30 September. History: FY2024 PBT 64, tax −16 → usable rate
16/64 = 0.250 (single usable → carried forward). Forecast: FY2026 PBT −40;
FY2027 PBT 55.

```text
FY2026: current tax = MAX(0, −40) × 0.25 = 0     net income = −40
        DEGRADE loss_benefit_not_realised (historical payer, benefit unrealised)
FY2027: current tax = 55 × 0.25 = 13.75          net income = 41.25
        taxed in full — no NOL relief until the planned vocabulary ships
```

## Designed vocabulary — planned, not live

Recorded here as design decisions; **do not rely on any of it in a delivered
model until the engine ships it**:

- **NOL / tax-loss stock (D15)**: carried-forward losses, a usage limitation
  per period, and a recovery-year offset. Until live, losses expire silently
  into full-rate recovery years (Example 3).
- **Valuation allowance**: a deferred-tax judgement field distinct from the
  current-charge flooring rule.
- **Interest-limitation reference (US §163(j))**: designed vocabulary so an
  interest-limitation constraint can bind deductible interest; until live, the
  full interest deduction flows through.
- **Holiday versus credit (D18)**: a genuine reported zero rate must be
  classifiable as `reported_zero` (holiday) rather than folded into
  `tax_credit_on_profit`. Until live in the ledger, an apparent holiday is
  ambiguous → ASK, never a booked 0% forecast without challenge.

## Refusal conditions

- **BLOCK** — an ETR forecast-as-identity candidate (`tax = PBT × rate` with
  the rate derived from the same tax and PBT); a negative or non-numeric
  override-style rate declaration where the contract requires a number; a
  normalisation ledger whose selected rate carries no provenance.
- **ASK** — ETR unresolved after every rung (no usable history, no
  classifiable loss shape): the row escalates to a batched user decision, not
  a terminal internal blocker; holiday-versus-credit ambiguity under D18 while
  the vocabulary is unshipped; a material NOL position needing a treatment
  choice ahead of the planned vocabulary.
- **DEGRADE** — `loss_benefit_not_realised`; `distorted_rate` exclusions above
  the 0.60 ceiling (recorded, excluded from the median/latest rungs);
  `display_row_rate` rescue used because filed components were unresolvable;
  forecast clamp applied to an out-of-window declared rate.

## Open questions

- Ceiling configurability: should 0.60 be a policy constant or a per-case
  override with justification?
- Should the acquisition-target column adopt the same loss floor as the
  standalone column (today the target's arithmetic taxes its own PBT without a
  floor)? One convention everywhere argues yes; confirm before changing
  certified fixtures.
- Deferred tax: does the model ever split current versus deferred within the
  charge, or stay a current-tax engine by declared scope?
- Group relief and withholding on cross-border cash flows: out of scope today;
  record whether either blocks a known archetype.
