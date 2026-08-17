# Acquisition overlay

Read only when the lightweight acquisition case is requested.

## Canonical controls

The production overlay accepts only:

- adjustment columns on/off — the single switch over the N:P columns. There is
  no separate acquisition toggle and none may be added: turning the adjustment
  columns off is what turns the acquisition case off;
- transaction enterprise value;
- acquisition debt amount;
- entry EV / EBITDA;
- incremental debt rate;
- close year;
- close month.

Derive target EBITDA visibly:

```text
target EBITDA = transaction value ÷ entry EV / EBITDA
```

Do not add a funding percentage, separate purchase consideration, target net
debt or cash, sources and uses, purchase accounting, synergies, fees, multiple
financing tranches, timing overrides, target-ratio inputs, acquisition
amortisation or an acquisition maturity. A materially different financing
structure is outside the canonical overlay and requires a bespoke extension.

Do not create an `acquisition_debt` instrument in the ordinary instrument
register. The acquisition amount belongs only in the adjustment and pro-forma
rows governed by the single adjustment-columns control.

## Operating inference

Infer the target operating contribution from the standalone forecast ratios
for the corresponding period. Keep the calculation formula-driven and do not
expose a second set of target-ratio assumptions in the canonical control block.

At minimum:

```text
target revenue = target EBITDA ÷ standalone EBITDA margin
target D&A = target revenue × standalone D&A / revenue
target EBIT = target EBITDA - target D&A
target capex = target revenue × standalone capex / revenue
target working capital = target revenue × standalone working-capital cash impact / revenue
```

Derive target tax, net income and operating cash flow without building a target
balance sheet. Guard every inferred ratio against a zero or unavailable
standalone denominator.

## Timing

Use close month to calculate one inclusive close-year fraction:

```text
close-year fraction = (13 - close month) / 12
```

Apply it once to close-year operating contribution and acquisition interest.
Use a full-year contribution and full-year interest after the close year. Add
the full acquisition debt balance at closing; do not prorate the debt balance.

Validate close month as an integer from 1 to 12 and close year as one of the
three forecast years.

The fraction and rolled target EBITDA are formula helpers, not user controls or
visible statement rows. Keep them internal to the compiled formulas; rows 12 and
13 remain blank so the period header retains the authority geometry. For an OFF
illustrative shell with no supplied transaction, prefill a modest example only:
target EBITDA of roughly 1% of first-forecast standalone EBITDA, 10.0x entry
multiple, 50% debt funding, 5.0% incremental rate and a June close in the first
forecast year. The switch remains OFF and supplied or enabled transaction data
is never overwritten.

## Funding and debt

This remains a lightweight debt overlay rather than a full sources-and-uses or purchase-accounting model. Enterprise value is used once as the purchase-consideration proxy and also to infer the target's operating contribution. The close-year acquisition adjustment records the full consideration as an investing cash outflow; the separately supplied acquisition-debt amount records one financing inflow and one persistent debt balance. Any residual consideration is funded through existing cash and the ordinary RCF waterfall. No automatic equity plug is invented.

Add the supplied acquisition debt amount directly to the pro-forma debt balance in the close year and hold it flat for the rest of the three-year forecast. Use the existing Change in Debt / Additions to debt adjustment row for the financing proceeds; do not create a second financing-proceeds line that would duplicate the cash flow. Likewise, record the consideration exactly once in investing cash. Do not create any additional unmatched financing inflow, duplicate purchase-consideration outflow, equity residual, acquisition amortisation or acquisition maturity. Ordinary target operating contribution and incremental interest affect the combined cash/RCF solve through the income statement and operating cash flow alongside those explicit close-date transaction flows.

```text
average acquisition debt = (opening balance + closing balance) / 2

incremental interest
= average acquisition debt
× incremental debt rate
× close-year fraction or full-year factor
```

**Price the acquisition leg on the average of its opening and closing balance,
exactly as every instrument leg is priced.** The workbook once emitted the
closing balance while the solver used a different basis; because the tranche is
held flat after closing, opening equals closing in every existing case and the
two conventions were indistinguishable. With real amortisation they diverge. The
acquisition leg was the odd one out and no longer is.

## Presentation and checks

Show standalone, acquisition adjustment and pro forma:

```text
pro forma = standalone + acquisition adjustment
```

Confirm:

- off state returns an exact zero in every adjustment cell, leaves standalone
  untouched and makes each pro-forma column equal its standalone column;
- formula text is present and unchanged in both the on and off states;
- transaction value enters investing cash once and acquisition debt enters financing cash once;
- the debt amount enters gross debt, net debt, interest and leverage once;
- close-year operating contribution and interest use the close-month fraction;
- pro-forma net debt includes the dedicated acquisition debt;
- pro-forma leverage uses the selected pro-forma EBITDA;
- the debt remains outstanding after closing;
- no unsupported target ratios, funding fields, repayment terms or instrument-register entry are introduced.
