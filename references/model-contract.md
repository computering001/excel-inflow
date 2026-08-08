# Model contract

## Purpose

Use one common schema for every issuer, then vary only company-specific row detail and optional support modules. The model is a debt and cash-flow overlay, not a full three-statement forecast.

## Horizon and columns

Display exactly three historical and three forecast years on the consolidated
`Operating Model` sheet. Use the canonical CRH geometry:

```text
B       row labels
C:E     local terms and visible assumptions
G:I     standalone historical
J:L     standalone forecast
N:P     adjustment forecast (acquisition overlay)
R       latest historical pro-forma reference
S:U     pro-forma forecast
```

Columns A, F, M and Q are narrow gutters, but only A, M and Q are **breaks**.
A, M and Q stay white and unbordered; F carries fills and rules through, because
both sides of it belong to the same line item on the same basis. See
`template-and-formatting.md`.

Keep standalone formulas independent of the adjustment-columns switch. Calculate
linear pro-forma rows as standalone plus adjustment and solve the combined
pro-forma cash/RCF waterfall before deriving its non-linear adjustment.

## Source authority

Three inputs cannot all be authoritative for the same thing.

- **The DCS debt export**, taken at last fiscal year end, is authoritative for
  instrument-level detail: amounts, coupons, maturities, currencies.
- **The filings** are authoritative for audited totals — reported gross debt, net
  debt, cash, reported gross interest — and for **all** historic movements.
- **The broker set** is authoritative for the forecast anchor and consensus lines
  **only. Never historic.**

Reporting currency, fiscal calendar, units and the period range follow the
company. Resolve them from the filings; never ask the user to confirm them.

## Units and signs

Use the issuer reporting currency in millions unless instructed otherwise.

- Revenue, EBITDA, EBIT, cash, debt and liquidity: positive balances.
- P&L expenses: negative where summed into profit.
- Cash-flow inflows: positive; outflows: negative.
- Working-capital release: positive; investment: negative.
- Debt draws: positive financing cash flow; repayments: negative.
- Mandatory repayment: positive requirement in the waterfall, then subtract it from cash.
- Interest expense: negative on the P&L; interest income: positive.
- Gross debt and net debt: positive credit balances.
- Net debt: gross debt less eligible cash.

Preserve a supplied template’s opposite convention only when the whole section is internally consistent. Never mix conventions within a section.

## Main `Operating Model` sheet

Keep these sections in order.

### 1. Controls

Include only relevant controls:

- selected forecast or broker case;
- circularity breaker;
- minimum cash;
- historical basis;
- FX assumptions;
- lease mode;
- one adjustment-columns switch (there is no separate acquisition switch),
  plus acquisition debt / transaction value, entry multiple, incremental rate,
  close year and close month.

### 2. Income Statement

At minimum:

- Revenue
- Operating profit / EBIT
- Net interest expense
- Pre-tax income
- Tax
- Net income

Add only the company-specific operating lines required to derive EBIT, EBITDA or cash flow.

#### Adjusted EBITDA Bridge

- Operating profit / EBIT
- D&A
- Recurring disclosed adjustments
- Adjusted EBITDA

Keep material reported-to-adjusted add-backs visible.

### 3. Cash Flow

- Net income
- D&A and other non-cash adjustments
- Aggregate change in working capital
- Cash from operations
- Capex and other investing
- Cash from investing
- Debt draws and repayments
- Lease principal
- Dividends and buybacks when relevant
- Cash from financing
- Opening cash
- FX effect on cash when relevant
- Ending cash

The debt schedule owns mandatory repayment; the financing-statement repayment
line consumes it; the pre-RCF sweep consumes that visible statement line. The
waterfall owns RCF draw and repayment and the corresponding financing children
consume them. `Change in Debt` is a compact parent that sums the visible debt
children. Each movement reaches ending cash exactly once.

Presentation hierarchy is separate from calculation authority. A genuine group
parent is bold without an answer band or subtotal rule, appears immediately
above its contiguous indented children and sums only those children. A normal
issuer detail or linked schedule line sits at body level one but does not become
a deeper grouped child without an explicit semantic parent. Do not invent
`Other investing` or `Other financing` parents merely to shorten a formula;
direct issuer lines may flow straight into the disclosed subtotal.

#### Free Cash Flow Metrics

- Cash from operations
- Capex
- Free cash flow
- Cash conversion when useful

State and preserve one free-cash-flow definition.

### 4. Debt Schedule

Use one row per material instrument or homogeneous pool. Show name, class, currency, maturity or repayment timing, opening balance, movements and ending balance.

Head the schedule with one visible period-end FX row per foreign instrument
currency, quoted reporting-currency-per-native. Instrument balances translate by
referencing that row; keep cross-sheet `'Forward Curves'` calls out of the
balance formulas.

Separate fixed-rate bonds, floating loans, commercial paper, securitisation,
RCF, other borrowings and leases. Keep acquisition debt only in the dedicated
acquisition overlay; do not create an `acquisition_debt` instrument-register
class.

**Reconcile the instrument list to reported gross debt, explicitly and on the
face of the schedule.** State reported gross debt per the filing, the total
identified instrument by instrument, and the difference. The residual takes its
own visible line and is never absorbed into an instrument, an "other debt" pool
or a subtotal.

The residual is **signed**. Instruments exceeding reported gross debt is a
failure in exactly the way instruments falling short is, and it has its own named
causes: an export taken after year end, or a facility double-counted as both
tranche and umbrella. Never clamp it at zero — an over-identified book otherwise
passes at any magnitude while overstating gross debt, net debt and every leverage
ratio.

Where the book is multi-currency, translate at the declared period-end rate
**before** summing, and state the rate used on the face of the reconciliation. A
sum of native balances is not a currency.

Tie **each** historical year-end, not only the latest, and show the per-year
residual.

When prior-year instrument registers are unavailable, use the optional
`historical_supplement` for the two earlier reported cash, aggregate borrowings
and lease snapshots. Every field it supplies must be declared in the v2 schema
and typed blue with a source comment; an undeclared field is an invisible
hardcode. Keep the latest year driven by the opening instrument register, cash
policy and lease policy. Never show missing prior debt as zero.

#### Leverage and Liquidity

Split the block by BASIS, because "is this our number or theirs" is the first
question a reader has and the two answers are not interchangeable.

**Model basis — standardised.** Always present. One calculation, stated on both
lease definitions so it is comparable across issuers:

- Gross debt (excluding leases)
- Gross debt including leases
- Less: eligible cash
- Net debt (excl. leases)
- Net debt (incl. leases)
- Adjusted EBITDA
- Net debt (excl. leases) / Adjusted EBITDA
- Net debt (incl. leases) / Adjusted EBITDA
- Net interest expense
- Adjusted EBITDA / net interest expense
- Total change in debt, and FX translation where the book is multi-currency

**Company reported — the issuer's own definition.** Present only when the case
supplies at least one named reconciling item that is genuinely non-zero:

- Net debt (model basis) — restated from the model row above
- (+/-) one row per NAMED reconciling item
- Net debt (company reported)
- Adjusted EBITDA (as above)
- Net debt (company reported) / Adjusted EBITDA

Name each reconciling item in the issuer's own words — "Unamortized FV
adjustments, discounts and issuance costs", "Operating leases excluded from
reported net debt". Never emit a single anonymous "(+/-) reported adjustments"
row: it tells the reader that a difference exists and nothing about what it is,
and where no item exists it is a line of zeros between two identical subtotals.

Where the model basis is independently proven to be the company basis, suppress
the company block and say so in the model-basis header. Where no company basis
is disclosed, use neutral standardised-basis wording; absence of reconciling
items is not proof of equality. A named bridge may be shown only when the case
declares `reconciled_difference`; an unresolved company figure must remain
labelled unreconciled.

The model-basis multiples always divide MODEL-basis numerators. The independent
solver measures leverage on the model basis and knows nothing about reported
adjustments, so a model ratio pointed at a company-reported row would put the
visible formula out of step with its own cached value.

Each ratio divides by the row directly above it, not by a cell elsewhere in the
model, so the multiple reconciles on screen. State the lease definition and
protect ratios with zero or unavailable denominators.

Liquidity follows in its own block: undrawn RCF, less drawn commercial paper,
year-end cash, total liquidity.

### 5. Cash Sweep / RCF Waterfall

- Cash before mandatory repayment
- Mandatory debt repayment
- Cash after mandatory repayment
- Minimum cash
- Cash deficit / surplus
- Opening RCF
- Available RCF capacity
- RCF draw
- RCF repayment
- Ending RCF
- Ending cash
- Liquidity shortfall, if any

### 6. Interest Schedule

- Interest by instrument or homogeneous pool
- RCF drawn-balance interest
- RCF commitment fee when applicable
- Lease interest
- Other / unallocated interest
  - Reported gross interest per the filing
  - Interest identified instrument by instrument
- Total cash interest
- Non-cash interest
- Gross interest expense
- Interest income
- Net P&L interest

Link final net interest to the Income Statement.

Historical `Other / unallocated interest` is a reconciliation, never a typed
number. The case explicitly declares whether reported interest is filed total
finance expense including leases, debt interest excluding a separately
disclosed lease charge, or identified components only. The runtime canonicalises
that basis first. Where a filed total exists, the residual is canonical filed
finance expense less canonical identified components. Where it does not, the
reported-total row is a formula sum of identified components and the residual
is formula-driven zero without claiming filing authority. The two derivation
rows are grouped beneath the residual they produce,
collapsible, in the same shape as the RCF's two constituents: the answer first,
its workings below. **Gross interest expense skips both derivation rows** — they
are a derivation, not a component, and adding them in would count reported
interest twice.

Forecast `Other / unallocated interest` is a separate visible plug. Its output
must be formula-driven from a visible model-unit amount assumption, a visible
rate on an identifiable debt base, or a supplied forecast total-interest
bridge. Do not use the historical residual as the forecast assumption and do
not present a typed forecast subtotal as though it were a reconciliation. Use
`historical_supplement` only to retain historical reported debt interest, lease
interest and interest income where instrument detail is unavailable. New cases
must state `historical_interest_reconciliation.reported_interest_basis`;
omission is supported only as a backwards-compatible legacy meaning of filed
total finance expense including lease interest.

## Production sheets

The v2 production workbook always contains these three calculation-authority
sheets:

- `Operating Model`
- `Brokers`
- `Forward Curves`

A PASS hash-bound full-table broker bundle may add only the optional `> Brokers`
divider and `B01`-`B10` values-only evidence sheets defined in
`broker-extraction.md`. Those sheets preserve source tables for review. They
must contain no formulas, `Operating Model` must never reference them directly,
and every selected forecast still enters through `Brokers`. Without full-table
evidence, the workbook remains exactly the three core sheets.

Do not add `Historical Support`, `Legacy Entity`, a central source register or a
dedicated checks sheet. Normalize predecessor, merger and calendarisation inputs
before compilation, then flatten the selected three-year history into the main
sheet with source and transformation comments.

**There is no hidden support block.** Every mechanical row the model needs —
balance roll-forward, interest, repayment — is emitted on the face of the
schedule it belongs to, so the last allocated row is the last row of the model.
No row on the `Operating Model` may be hidden and nothing may be written below
the last visible row; the `hidden-mechanics` check asserts both. Excel row
outlining is not hiding: a collapsible group whose parent shows the answer and
whose children show its workings is visible model.

## Common input contract

Normalise the available evidence into the v2 case:

```text
issuer_profile
periods_and_fiscal_calendar
historical_financials
forecast_source_map
operating_assumptions
instrument_register
rate_and_fx_assumptions
cash_and_financing_policy
lease_policy
transaction_case
statement_structure
provenance
coverage_status
```

Not every build requires every optional field. Missing non-material items may use labelled assumptions; material debt terms must not be invented.
