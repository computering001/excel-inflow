# Advanced history and FX

Read only for material multi-currency debt, predecessor entities, mergers, carve-outs, calendarisation or material FX translation.

## Historical entity map

For each source entity, record in the normalized v2 case and build evidence:

- entity name;
- source period and fiscal year-end;
- target reporting period;
- source currency and units;
- source-label mapping to common model lines;
- combination or elimination treatment;
- selected historical basis.

Keep only the support required to explain the mapping. Do not create a central
source register or an extra entity sheet in the production workbook.

For a structured case, `historical_entities[*].metrics` and metric-specific
eliminations must be the formula-derived, calendarised values in the issuer
reporting currency. Preserve native inputs, period mapping and FX transformations
in build evidence and provenance comments; do not pass raw native-currency
amounts into deterministic combination. Set `metrics_basis` to
`reporting_currency_calendarised` and provide one `calendarisation_notes` entry
for each target historical period.

The production compiler must apply this entity graph before coverage, solving,
row planning or rendering. It replaces only the three historical elements of a
matched semantic metric and preserves the three forecast elements. Every entity
metric must resolve to an `operating_metrics` key, an exact statement `row_id`,
or a statement `semantic_role`; an unmapped metric blocks. Write the resulting
entity IDs, combined values and destinations to the
`historical-normalisation.json` run sidecar.

For `restated_comparative`, `predecessor_combined` or `calendarised` history,
the evidence run also carries a hash-bound numeric bridge. For every selected
metric and period it proves:

```text
reported value + named sourced adjustments = selected canonical value
```

The selected value must equal the exact historical model-case path within an
explicit tolerance no looser than `1e-6`. A prose note or `bridge_status` flag
without that arithmetic is not a completed bridge.

## Calendarisation

Use reported quarterly or interim data when available.

```text
target fiscal-year flow
= source quarters or interim periods inside the target year
```

Use the balance reported at or closest to the target period-end for point-in-time items. Avoid prorating annual flows when actual interim data exists. Label any time- or seasonality-based approximation.

Do not average debt or cash balances across unrelated year-ends.

## Predecessor combinations

Map each entity to the common taxonomy before combining.

```text
combined flow in reporting currency
= calendarised and translated entity A
+ calendarised and translated entity B
- evidenced reporting-currency eliminations
```

Combine underlying amounts before calculating ratios. Combine debt and cash as translated period-end balances. Keep transaction financing and refinancing separate from operating history.

When both as-reported and combined history are useful, show a basis control and use one selected basis for forecast drivers.

## Fiscal calendar

The fiscal calendar follows the company and is never asked. Declare which kind it
is: a **fixed date** year-end, or a **52/53-week** calendar whose year-end moves.

A moving year-end must not be checked against a fixed month-and-day. Comparing
`MM-DD` alone hard-fails every 52/53-week filer on a promise they were never
asked to make. Branch the check on the declared calendar kind.

## FX and forward rates are a gate input, not an emit-time surprise

Every non-reporting currency in the book needs a period-end FX row, and every
floating instrument needs a forward benchmark row. Where the case supplies
neither, hold them flat at the latest period-end, type them blue and print them
in the stated assumptions.

**A missing FX or curve row must block at the coverage gate.** It must never
reach the emitter and throw there: a gate-placement failure hands the user a
stack trace where they needed a named missing input. Multi-currency itself works
— this is a placement defect, not a missing capability.

## Currency conventions

Identify:

- native currency;
- reporting currency;
- quote convention;
- average FX for P&L and cash-flow translation;
- period-end FX for cash and debt.

If the quote is reporting-currency units per one foreign-currency unit:

```text
translated flow = foreign-currency flow × average FX
translated balance = foreign-currency balance × period-end FX
```

Invert formulas consistently for the opposite quote convention. Manual FX forecasts are permitted and do not require source dates.

## Debt and interest

Keep instrument balances in native currency when practical.

```text
ending reporting-currency debt
= ending native-currency debt × period-end FX

reporting-currency interest
= native-currency interest × average FX
```

Use the benchmark for the instrument currency. Test RCF capacity in the facility currency before translating outputs.

## Separate cash movement from translation

Do not treat changes in translated debt as cash draws or repayments.

```text
cash debt movement in reporting currency
= native-currency cash movement × applicable FX

FX / non-cash movement
= ending translated debt
- opening translated debt
- translated cash debt movement
- other identified non-cash movement
```

Put only cash movement in financing cash flow. For cash:

```text
ending cash
= opening cash
+ translated cash flows
+ FX effect on cash
```

## Advanced checks

Confirm:

- source periods cover each target year once;
- entity combinations do not double-count;
- average and period-end FX are not interchanged;
- debt cash movement is separated from translation;
- interest uses the correct currency benchmark;
- RCF capacity is tested in the correct currency;
- **the debt reconciliation translates before it sums.** Adding native USD, EUR
  and GBP balances together produces a figure that is not a currency, and it then
  reconciles against a reported total that is. State the rate used on the face;
- a missing FX or forward-rate row was caught at the coverage gate, not at emit;
- the main sheet still displays only three historical and three forecast years.
