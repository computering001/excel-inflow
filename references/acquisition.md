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

## Funding and debt

This is a debt overlay, not a sources-and-uses schedule. The overlay has zero
direct transaction cash-flow effect. Enterprise value is
used only to infer the target's operating contribution. Add the supplied
acquisition debt amount directly to the pro-forma debt balance in the close
year and hold it flat for the rest of the three-year forecast. Do not create an
unmatched financing inflow, a purchase-consideration outflow, an equity
residual, financing-proceeds row, acquisition amortisation or an acquisition
maturity. Ordinary target operating contribution and incremental interest may
affect the combined cash/RCF solve through the income statement and operating
cash flow; they are not direct acquisition funding or consideration cash flows.

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
- the acquisition overlay has zero direct cash-flow effect;
- the debt amount enters gross debt, net debt, interest and leverage once;
- close-year operating contribution and interest use the close-month fraction;
- pro-forma net debt includes the dedicated acquisition debt;
- pro-forma leverage uses the selected pro-forma EBITDA;
- the debt remains outstanding after closing;
- no unsupported target ratios, funding fields, repayment terms or instrument-register entry are introduced.
