# Calculation rules

Normative companions: `cash-waterfall-spec.md` (cash/RCF waterfall, shortfall
and RCF-exhaustion contract), `interest-conventions-spec.md` (average-balance,
PIK, floors, commitment fee) and `tax-and-earnings-spec.md` (ETR normalisation,
loss flooring). Where this document summarises, those documents govern.

## Instrument register

Create one row for each material instrument or homogeneous debt pool.

Require:

- name and class;
- native currency;
- opening balance;
- maturity or expected repayment year;
- rate type;
- fixed coupon or floating spread.

Add facility capacity, benchmark, amortisation, commitment fee, FX basis and cash/non-cash interest treatment when relevant.

Reconcile total opening instruments to the disclosed debt balance before
forecasting debt, and show the reconciliation on the face of the schedule:
reported gross debt per the filing, total identified instrument by instrument,
and the difference on its own line.

The difference is **signed**. Instruments exceeding reported gross debt fails in
exactly the way instruments falling short does; never clamp the residual at zero.
Multi-currency balances translate at the declared period-end rate before summing,
with the rate stated on the face.

When disclosure supports only an aggregate residual, use a clearly labelled
`Other debt` pool rather than inventing an instrument — but never absorb an
unexplained reconciling difference into that pool. A pool the disclosure supports
and a residual the disclosure does not explain are different things and must stay
on different rows.

## Debt roll-forward

For each instrument:

```text
ending debt
= opening debt
+ cash draws / issuance
- scheduled amortisation
- maturity repayment
+ acquisition additions
+ FX / other non-cash movement
```

Carry ending debt into the next period’s opening debt.

- Roll a maturing balance to zero in its maturity year.
- Do not assume refinancing unless instructed.
- Hold non-amortising debt flat before maturity.
- Separate cash repayment from FX and other non-cash movement.
- Include scheduled amortisation, maturity repayment and selected lease principal in mandatory repayment.

## Fixed and floating interest

When exact timing is unavailable:

```text
average balance = (opening balance + ending balance) / 2
fixed interest = average balance × coupon
floating all-in rate = forecast benchmark + spread
floating interest = average balance × floating all-in rate
```

When maturity or close timing is supplied and material:

```text
interest = applicable balance × annual rate × period fraction outstanding
```

**Every leg uses the average of opening and closing balance, including the
acquisition leg.** The acquisition leg was once priced on its closing balance in
the workbook and on a different basis in the solver; opening equals closing
whenever a tranche never amortises, which is true of every case in the current
suite, so the two conventions were indistinguishable until real amortisation
appeared. One convention, applied everywhere.

Keep benchmark, spread and manual all-in rate assumptions visible. Do not require source dates for manual benchmark forecasts.

When circularity is on, calculate RCF interest on the average drawn balance.
When circularity is off, the persistent RCF-interest formula returns zero.
Keep the raw RCF rate assumptions unchanged in both states.

Add an undrawn commitment fee only when the convention is supplied and unambiguous:

```text
undrawn RCF = MAX(0, capacity - average drawn balance)
commitment fee = undrawn RCF × fee rate
```

Do not reinterpret a percentage-of-margin convention as basis points.

## Other and non-cash interest

Keep historical reconciliation and the forecast plug economically distinct.

Every historical case declares `reported_interest_basis`. Use
`filed_finance_expense_including_lease_interest` when the reported and identified
series already include lease interest; use
`reported_debt_interest_excluding_separately_disclosed_lease_interest` when both
series exclude a separately disclosed lease charge; and use
`identified_components_only` only where no filed total exists. Legacy cases
without the field retain the first meaning, but new evidence runs must be
explicit. Canonicalise the selected basis before any residual is calculated.

For historical periods with a reported total, calculate `Other / unallocated
interest` as the visible residual between canonical filed total finance expense
and canonical identified components. Add separately disclosed lease interest
exactly once when—and only when—the declared basis excludes it:

```text
other interest
= filed total finance expense
- identified instrument interest
- RCF interest
- commitment fee
- lease interest
```

**Show the historical residual as a reconciliation on the face, never as a
typed number.** Emit the
two derivation rows — reported gross interest, and interest identified
instrument by instrument — grouped beneath the residual they produce, so the
residual falls out as a difference rather than arriving as a constant. Gross
interest expense **skips both derivation rows**: they are a derivation and not a
component, and summing them in would count reported interest twice.

For forecast periods, permit one visible `Other / unallocated interest` plug
using one declared method: a visible manual amount assumption, a visible rate
applied to an identifiable average unmodelled debt base, or a formula bridge to
a supplied forecast total-interest authority. The assumption is an input; the
interest-schedule output is a formula. Never carry the historical residual
forward merely because it reconciled history, never bury the forecast plug in
instrument rows, and never hardcode a forecast interest subtotal.

An instrument whose DCS balance and maturity are reliable but whose pricing is
not must remain in the debt and liquidity schedules with
`pricing_treatment=residual_interest_plug`. Its individual rate cells are blank
and intentionally uncalculated, its individual calculated interest is zero, and
the missing cost is captured only by the bridge to the selected forecast
total-interest authority. `rate_type=unpriced` describes missing evidence; it is
not a 0% economic assumption. Apply the same treatment to an unavailable RCF
margin or commitment fee while retaining committed capacity and drawn balance.

Allow a simple flat non-cash-interest assumption when detail is limited. Do not build a detailed issuance-cost roll-forward unless scope is expanded.

```text
gross interest expense
= identified instrument cash interest
+ RCF interest
+ commitment fee
+ lease interest
+ other interest
+ non-cash interest

net P&L interest
= gross interest expense
- interest income
```

Do not double-count RCF or lease interest inside an instrument subtotal and again as separate lines.

## Interest income

Never hold forecast interest income flat merely because history was flat.

When circularity is on:

```text
average eligible cash = (opening eligible cash + ending eligible cash) / 2
interest income = average eligible cash × visible cash yield
```

When circularity is off, the persistent forecast interest-income formula
returns zero. Keep the visible eligible-cash percentage and cash-yield
assumptions unchanged.

Use total cash as eligible unless restricted, trapped or non-interest-bearing cash is separately available and material. Keep any eligible-cash percentage and yield visible.

Do not assume that cash-flow-statement cash, liquidity cash and cash used in net
debt are always the same balance. If the cash-flow statement nets a debt item
(for example an on-demand overdraft) while gross debt presents that item
separately, declare two cash buckets:

- the balancing bucket holds cash-flow-statement cash and drives opening cash,
  ending cash, liquidity and interest income; and
- a `linked_debt_addback` bucket restores gross cash only for reported cash and
  net debt, with its forecast balance linked to the named debt instrument rows.

Standalone, adjustment and pro-forma opening cash always roll from the prior
cash-flow-statement ending-cash row. Gross reported cash is a net-debt
presentation balance and must never become an opening-cash source merely
because explicit cash buckets are present.

The linked add-back is never independently forecast, never earns interest and
never funds the RCF sweep. Its latest historical amount must equal the translated
opening balance of the linked gross/net-debt instruments. This makes the debt
and cash add-back neutral in net debt and prevents double counting.

## Circularity

When cash, net income, RCF and interest depend on one another, use a visible
binary breaker:

- **Off / breaker:** every model-generated forecast interest-expense and
  interest-income output returns formula-driven zero.
- **On:** instrument, RCF, lease, acquisition, other/unallocated, non-cash and
  cash-income interest calculate through the approved timing and
  average-balance mechanics, using controlled iteration or an equivalent
  auditable closed-form solution where required.

The breaker never removes or overwrites formulas and never changes raw
assumptions. Historical interest and all non-interest debt, cash, RCF,
operating and acquisition schedules remain active. Because interest is absent
from forecast net income when the breaker is off, the cash-flow bridge must not
add back non-cash interest in that state. The workbook must remain stable in
both positions and restore the calculated baseline after a full recalculation.
Do not leave an uncontrolled circular reference.

## Lease modes

Select and label one mode.

### Exclude

Use only when immaterial or outside the selected debt definition. Remove lease debt, principal and interest consistently.

### Flat replacement

Default when only a liability and annual lease metrics are available:

```text
ending lease liability = opening lease liability
lease interest = average lease liability × effective rate
new lease additions = lease principal repayment - lease interest - other movements
```

Show repayment as a financing outflow and replacement additions as a non-cash liability movement.

### Simple roll-forward

Use when additions and principal are available:

```text
ending lease liability
= opening lease liability
+ new lease additions
+ lease interest
+ other movements
- principal repayment
```

Do not reduce the liability through repayment while also holding it flat without showing replacement additions.

### Sourced balance

Use when a supplied forecast gives total lease liabilities directly. Keep the
sourced closing balances visible as inputs and derive the implied non-cash
additions bridge:

```text
implied additions = sourced ending liability - opening liability - lease interest - other movements + principal repayment
```

Lease-interest basis is a separate decision from total lease debt. Use
`total_liability` only where lease interest is separately presented in profit or
loss, `separately_supplied` for a distinct finance-/interest-bearing balance,
and `none` where no separate lease-interest charge belongs in the schedule. A
US GAAP case must state this choice explicitly; do not add an implied operating
lease interest charge when operating lease cost is already above EBIT.

## Cash and RCF waterfall

The RCF is the only balancing liquidity source.

```text
cash before mandatory repayment
= opening cash
+ operating and investing cash flow
+ non-RCF financing before mandatory repayment

cash after mandatory repayment
= cash before mandatory repayment
- mandatory repayment

cash deficit = MAX(0, minimum cash - cash after mandatory repayment)
cash surplus = MAX(0, cash after mandatory repayment - minimum cash)

available RCF capacity = MAX(0, capacity - opening RCF)
RCF draw = MIN(cash deficit, available RCF capacity)
RCF repayment = MIN(cash surplus, opening RCF)

ending RCF = opening RCF + RCF draw - RCF repayment
ending cash = cash after mandatory repayment + RCF draw - RCF repayment
```

Retain remaining excess cash after the RCF is repaid. Never auto-sweep bonds, acquisition debt or other facilities. When RCF capacity cannot fund minimum cash, show a liquidity shortfall rather than exceeding capacity.

RCF draw and RCF repayment are mutually exclusive. A period with a cash deficit
may draw; a period with a cash surplus may repay opening drawn RCF only. A draw
made in the current period is never immediately repaid in that same period.

Calculate mandatory repayment once from the instrument repayment states in the
visible debt schedule. Its membership is semantic: every eligible non-RCF
instrument with scheduled amortisation or a maturity inside the period is
included, regardless of its physical row; RCF is excluded because it is the
balancing source. Link the positive schedule requirement into the visible
negative financing-statement repayment line. The pre-RCF sweep then consumes
that visible statement line. Calculate RCF draw and repayment once in the
waterfall and link them back into their visible financing-statement children.
The visible Change in Debt parent sums those children. No schedule or sweep may
bypass the statement and no movement may enter ending cash twice.

Historical reported debt interest and separately reported lease interest are
distinct authorities only when the declared basis says the reported series
excludes leases. When the filed total already includes leases, reconcile to that
total without adding leases again. When only identified components exist, show
their formula total and assert no filed-total residual. Never infer the basis
from an issuer name, a row label or the mere presence of a lease series.

## Credit outputs

```text
gross debt = included debt instruments
net debt = gross debt - eligible cash
undrawn RCF = MAX(0, capacity - ending RCF)
total liquidity = ending cash + undrawn RCF
net leverage = net debt / adjusted EBITDA
```

Show net debt including leases separately when the lease definition requires it. Protect ratios from zero or unavailable denominators without hiding the underlying issue.
