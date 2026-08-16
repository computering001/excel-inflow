# Canonical model intent

Status: production intent contract
Authority: use this reference to decide what the model must do. Use the workbook and formula contracts to decide how the approved intent is implemented.

## 1. Product question

Answer:

> How do the issuer's operating outlook and cash generation translate into debt balances, interest, liquidity and leverage across three historical and three forecast years?

Build a debt-overlay operating model. Do not build a full forecast balance sheet, ratings model or unrelated valuation module.

## 2. Precedence

Apply this order:

1. explicit user instructions;
2. this economic and modelling-intent contract;
3. company-specific source evidence;
4. the canonical formula and scenario contracts;
5. the selected workbook and style profile;
6. reference-workbook mechanics.

Select one execution profile:

- `production_model`: the default. Economic invariants override reference defects, while the selected presentation profile controls layout and styling.
- `reference_parity`: use only for forensic reconstruction. Preserve literal evidenced source behaviour, including anomalies, and flag every known defect or unproven area.

Do not claim that one workbook satisfies both profiles when a source formula conflicts with an economic invariant. Use CRH as the preferred visual, geometric and interaction benchmark for `production_model`. Do not reproduce a literal CRH formula when it repeats a transaction, introduces an unsupported hardcode or prevents a control from performing its stated purpose.

Record every material departure in the QA certificate and delivery summary. Keep forensic detail outside the user-facing workbook unless the user requests it.

### Evidence-to-model boundary

Preserve raw evidence losslessly, but prove only observations the model may
consume. Full-document capture and model authority are different products. A
bad unused broker cell, an unmapped valuation table or an evidence-only page
cannot stop a debt model. Quarantine it by source cell and continue. A selected
broker observation that cannot be verified is removed from authority and the
same concept-period falls through the company-guidance, commitment, user-
assumption and historical rungs. The model may consume zero broker values while
still retaining every supplied report as evidence.

The resulting workbook carries a quality mode: `VERIFIED` when every selected
authority is verified, `DEGRADED` when optional evidence was quarantined or a
lower rung was used, and `INPUT_REQUIRED` only when a material economic node
remains unresolved. DCS price, YTW, OAS and other market metadata remain
supplemental evidence unless a model equation explicitly declares them; they
never silently substitute for coupon or benchmark-plus-margin terms.

## 3. Fixed scope

Always include:

- exactly three historical and three forecast years on the main sheet;
- visible controls;
- the operating lines required to derive earnings, cash and leverage;
- adjusted EBITDA bridge;
- operating, investing and financing cash flow;
- free cash flow;
- one row per material debt instrument or defensible homogeneous pool;
- debt, lease, cash and RCF roll-forwards;
- instrument, RCF, lease, other and non-cash interest;
- cash-linked interest income;
- gross debt, net debt, liquidity and leverage;
- external process QA and compact local checks only where they improve traceability.

Exclude unless the user explicitly expands scope:

- ratings;
- a forecast balance sheet;
- a dedicated central checks or audit sheet;
- a central source register;
- detailed working-capital forecasting;
- covenant modelling;
- a detailed debt-issuance-cost roll-forward;
- acquisition sources and uses, target net debt or cash, purchase accounting, synergies, fees or multiple financing tranches;
- external workbook links in the delivered file.

## 4. Flexibility boundary

Keep the following fixed:

- section order and visual hierarchy;
- 3H/3F main-sheet horizon;
- selected sign profile;
- control semantics;
- debt, cash, RCF, interest, lease, acquisition, liquidity and leverage invariants;
- formula/input/link colour roles;
- release QA gates.

Allow the following to vary:

- company-specific operating and cash-flow rows;
- number and type of debt instruments;
- currencies and rate benchmarks;
- forecast source mix;
- lease mode;
- company-specific broker, forward-curve, FX and historical-normalisation inputs;
- acquisition activation;
- materiality-based instrument grouping.

Do not simplify a material disclosed driver merely to force every company into identical rows.

## 5. Main-sheet architecture

Use one consolidated `Operating Model` sheet. The canonical new-build presentation profile is `crh_consolidated`, with this geometry:

- column `A`: narrow gutter;
- column `B`: row labels;
- columns `C:F`: local metadata, assumptions or instrument terms where the applicable section needs them;
- columns `G:L`: standalone three historical plus three forecast years;
- column `M`: spacer;
- columns `N:P`: optional acquisition adjustment for the three forecast years;
- column `Q`: spacer;
- columns `R:U`: optional pro forma, using the latest historical/reference column plus three forecast years.

Use this geometry for the canonical template. When a supplied user template is preserved, keep the same semantic standalone, adjustment and pro-forma blocks even if their columns differ; record the selected presentation profile and range map in the case configuration.

Place controls at the upper left and the adjustment-columns block — the single adjustment switch plus the acquisition inputs that populate those columns — at the upper right. Do not add a generic visible `currency mm` column. Show reporting currency and units in the title or period band.

Keep these major sections in order:

1. Control.
2. Income Statement, including the Adjusted EBITDA sub-bridge.
3. Cash Flow, including Free Cash Flow Metrics.
4. Debt Schedule, including Leverage and Liquidity.
5. Cash Sweep / RCF Waterfall.
6. Interest Schedule.

Treat the Adjusted EBITDA bridge, Free Cash Flow Metrics and Leverage and Liquidity as sub-sections inside their relevant major blocks. Show the adjustment-columns block (the switch and the acquisition inputs behind it) as an optional control block, not as an extra main operating section. Validators and contracts must use these six major semantic sections; they must not retain the obsolete nine-section rule.

## 6. Periods, units and signs

Use issuer reporting currency in millions unless instructed otherwise.

- Revenue, EBITDA, EBIT, cash, debt and liquidity: positive balances.
- Expenses inside summed P&L rows: negative.
- Cash inflows: positive; cash outflows: negative.
- Working-capital release: positive; investment: negative.
- Debt issuance: positive financing cash flow; repayment: negative financing cash flow.
- Mandatory repayment in the waterfall: positive requirement, subtracted once.
- Interest expense: negative on the P&L.
- Interest income: positive on the P&L.
- Gross debt and net debt: positive credit balances.
- Net debt: included debt less eligible cash.

Use the sign profile above for a new build. Preserve a supplied workbook's opposite convention only through an explicitly selected `source_template_sign_profile` with formula and validation mappings for every affected section.

## 7. Inputs and evidence hierarchy

Require or derive:

- issuer, fiscal year-end, reporting currency and units;
- three historical years;
- three forecast years or visible drivers sufficient to derive them;
- latest cash;
- debt instruments, balances, maturities and rates;
- RCF capacity and drawn balance when a balancing facility exists, otherwise an
  explicit `none` balancing-facility policy;
- minimum cash;
- lease definition;
- optional acquisition inputs.

Apply the forecast authority waterfall per semantic row and per forecast
period.  Row role resolves before evidence: formula subtotals remain identities;
interest, debt, lease, RCF, acquisition and cash mechanics link from their
owning schedules; deliberately unforecast detail is blank and grey; and only an
independent input selects evidence.  Its order is reported-to-date actual plus
forecast remainder; contractual or committed amount; formal company guidance;
clear numeric company indication; compatible broker value; user assumption;
driver or roll-forward; seasonal run-rate; historical average; trend/CAGR;
carry-forward; explicit supported zero; unresolved.

No clear path is never itself evidence for zero.  A material unresolved line
blocks or produces one targeted question.  An immaterial child may be not
separately forecast only where a forecast parent captures it.  Record the
selected method and source for FY1, FY2 and FY3 separately; a partial first year
may therefore use actual plus broker remainder while later years use broker or
driver paths.

Never silently invent a material maturity, currency, rate, facility capacity,
repayment term or acquisition transaction amount. Keep source or assumption
notes in cell comments or adjacent operating support, not in a central source
register.

Treat the FactSet DCS as build evidence, never as a workbook link surface. Its
selected instrument terms populate the visible debt schedule as blue hardcodes;
the complete raw export and cell-level receipt remain outside the workbook.
Month-only and year-only maturities use visible `month_end` and `year_end`
timing conventions without changing their disclosed precision. If pricing is
unavailable, retain debt and liquidity, leave individual rate cells blank, and
capture interest through the visible residual bridge rather than a fabricated
rate.

Record a case-level materiality and grouping decision. Unless the user or disclosure indicates otherwise, show an instrument separately when it represents at least 5% of opening gross debt or has a distinct currency, rate type, maturity, ranking or facility constraint that materially changes interest or liquidity. Group only truly homogeneous residual balances and label the pool.

Allow forecast sources to vary by metric: direct company forecast, broker
consensus, user input or visible inference. The production workbook always
preserves the three calculation-authority sheets: `Operating Model`, `Brokers`
and `Forward Curves`. When a PASS hash-bound broker bundle is supplied, it may
add `B01`-`B10` page-image evidence sheets defined in
`broker-extraction.md`.
`Brokers` retains the selected research metrics and selector; `Forward Curves`
retains only the FX, benchmark and cash-yield inputs actually used and may
otherwise be a clearly labelled minimal support sheet. Each evidence sheet
preserves every source PDF page as a large hash-bound image, arranged
horizontally from left to right. Lossless structured capture remains in the run
artifact and does not dictate workbook layout.
They never become calculation authorities: every
selected broker figure links through `Brokers`, and `Operating Model` may not
reference a `Bxx` sheet directly. Never fabricate observations merely to fill
any sheet. Require a
source comment or equivalent adjacent support only for material
hardcodes and judgemental assumptions; missing exact comment metadata is a
forensic-parity issue, not a production-model failure.

Before broker evidence becomes forecast authority, Stage 2 compiles one
hash-bound internal selection receipt from the pack, source tables and
crosswalk. It automatically selects the recommended coherent house, or the
ordinary forecast waterfall when no clean house exists. A selected conflict
quarantines only that observation and returns the concept/period to the
waterfall; an unused conflict never stops the build. A named house never borrows
a missing period from another house.

## 8. Operating forecast and cash flow

Forecast only the detail needed to drive debt, interest, cash, liquidity and leverage. Preserve additional company detail when it materially explains those outputs.

Compile each visible statement as one ordered semantic tree. Begin with the
complete issuer face-statement order, project out only declared evidence-only
rows, and insert overlay-only calculations at named semantic anchors. Do not
concatenate a canonical summary with an issuer-row remainder. Each visible row
has one economic owner, at most one visible authority may carry a headline
semantic role, and every parent/child family is contiguous. Source-layout
bullets or dashes are removed from labels; genuine hyphenated words remain.

At minimum derive:

- revenue;
- EBIT;
- D&A and recurring disclosed adjustments;
- adjusted EBITDA;
- net interest from the Interest Schedule;
- pre-tax income;
- tax;
- net income;
- aggregate change in working capital;
- cash from operations;
- capex and other material investing;
- dividends, buybacks and other material financing items;
- ending cash.

Use direct supplied forecast values when available. Otherwise use visible drivers and simple copy-across formulas. Do not create a forced generic forecast-input support block; use a broker/support sheet only when it is genuinely required.

For the conventional bridge, select exactly one broker headline authority:
the better-covered of EBIT and adjusted EBITDA by forecast period, with ties
to EBIT. Use D&A as the bridge driver and calculate the other headline through
the visible bridge. Never link both EBIT and adjusted EBITDA independently or
turn their consensus mismatch into a D&A/residual plug.

Forecast direction is issuer-specific.  Treat the declared dependency graph,
not EBITDA, as the authority.  Revenue-led, EBIT-led and EBITDA-led cases are
ordinary paths; PBT-led or net-income-led cases are also valid when every
reverse dependency is explicit.  In a PBT-led case, solved interest feeds the
reverse bridge to EBIT and then D&A/add-backs bridge to EBITDA.  The workbook,
independent solver, cache evaluator and coverage gate must all use that same
path.  A supplied lower-statement authority must not coexist with an unrelated
hardcoded EBIT or EBITDA merely to make the model build.

Working-capital detail is not required. Where a supplied model contains useful components, retain them as supporting rows with the aggregate change calculated as their sum.

Use these default identities unless company-specific source evidence requires a mapped equivalent:

```text
adjusted EBITDA = EBIT + D&A + approved recurring adjustments
pre-tax income = EBIT + interest income + interest expense + other non-operating items
tax expense = pre-tax income × selected tax rate, with the P&L charge shown negative
net income = pre-tax income + tax expense + other after-tax items
cash from operations = net income + D&A + other non-cash adjustments + aggregate change in working capital
free cash flow = cash from operations + capex
```

Treat capex as a negative cash-flow line. Do not recognise an automatic tax benefit in a loss year unless supplied evidence or a visible assumption supports it.

Every retained company-specific subtotal must be formula-derived from its visible components and included in dependency perturbation testing. The CRH row set is not the universal economic taxonomy. Use Smurfit as evidence for cross-company cash-flow, debt, lease and interest dynamics, not as a second pixel-layout template; exclude its ratings content.

## 9. Debt and maturity control

For every material instrument:

```text
ending debt
= opening debt
+ issuance or cash draw
- scheduled amortisation
- automatic maturity repayment
+ acquisition addition
+ FX or other non-cash movement
```

Carry ending debt into the next period. Separate cash movement from FX and other non-cash movement.

Use the simplest visible balance-path treatment that preserves the identity:

- for a non-amortising bullet with no forecast issuance or FX movement, keep the persistent copy-across formula and let the maturity control determine automatic roll-off;
- when scheduled amortisation, issuance or FX/non-cash movements are supplied,
  expose them as visible instrument inputs and keep every mechanical
  roll-forward row visible on the face of the relevant schedule; use outlining
  for collapsible workings, never hidden rows;
- a blue forecast balance path is an explicit instrument input, not a calculated subtotal. Reconcile it to opening balance plus disclosed movements, and generate the associated financing cash flow and interest timing from that path;
- never bury an unexplained movement as a constant inside a formula, and never add a detailed debt roll-forward solely for immaterial mechanics.

Store scheduled amortisation and maturity repayment as positive schedule requirements. Map them into financing cash flow once as negative outflows. Do not apply a second sign reversal elsewhere.

Keep gross non-RCF debt proceeds and gross non-RCF debt repayments visible as
separate cash-flow rows. `Cash change in gross debt` equals those two rows plus
RCF draw less RCF repayment. Keep the separate debt-schedule balance-change row
as ending gross debt less opening gross debt. The two measures differ when FX
or another non-cash item moves debt. The waterfall adds the proceeds row before
mandatory repayment and converts the negative repayment row into a positive
mandatory requirement. Do not infer gross proceeds and repayments from a net
balance change when both occur in the same period.

Use an underlying binary `Debt maturity repayments` control:

- `1 / On`: apply automatic repayment in the contractual maturity period.
- `0 / Off`: suppress automatic maturity repayment and carry the pre-maturity balance forward.

The control does not suppress explicit user-entered issuance, scheduled amortisation or repayment. Do not assume refinancing.

Automatic maturity repayment occurs in the first forecast period whose period-end date is on or after the contractual maturity date. When `Debt maturity repayments = 1`, calculate:

- full-year interest when the instrument remains outstanding at period end;
- `opening balance × rate × MONTH(maturity date) / 12` when it begins the period outstanding and matures during the period;
- zero interest when it was already repaid before the period.

When the control is `0`, carry the debt and calculate a full year of interest. Reference the control inside persistent debt and interest formulas; never overwrite either formula range when toggling the control.

## 10. Cash and RCF

When the issuer has a balancing RCF, use it as the only balancing liquidity
source. When no balancing facility is evidenced, compile an explicit `none`
policy: do not invent a dummy facility, keep any ordinary disclosed revolver as
an ordinary contractual instrument, set balancing draw/repayment/interest/fee
mechanics to formula-driven zero, retain the cash waterfall, and show the
remaining minimum-cash deficit as a visible liquidity shortfall.

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

RCF draw and repayment must never both be positive in one period. Show a liquidity shortfall when capacity is insufficient. Retain cash after the RCF reaches zero. Never auto-sweep bonds, acquisition debt or other facilities. Enter mandatory repayment and RCF movements into financing cash flow exactly once.

## 11. Interest and circularity control

Calculate forecast interest from debt, rate and timing. Use average balances in
the calculated state. Historical `Other / unallocated interest` is a visible
reported-total reconciliation; the forecast `Other / unallocated interest` is
a separate visible plug driven by a declared amount assumption, a rate applied
to an identifiable unmodelled debt base, or a supplied forecast total-interest
bridge. Never carry the historical reconciliation forward by default and never
hardcode a forecast interest subtotal.

Historical interest evidence declares one explicit basis before it enters the
graph: filed finance expense including separately presented lease interest;
reported debt interest excluding a separately presented lease charge; or
identified components only where no filed total exists. Canonicalise both the
reported and identified series to total finance expense before computing a
residual. Lease interest is added exactly once only for the excluding basis.
Legacy cases without the field retain the former filed-total-including-lease
meaning, while new evidence runs must state it.

Calculate forecast interest income from approved average eligible cash and a visible benchmark-plus-spread or cash-yield assumption. Use pro-forma cash in the pro-forma columns. Never hold interest income flat unless the underlying cash and yield genuinely produce a flat result.

Cash has separate semantic bases where disclosure requires them. The cash-flow
statement opens and closes on buckets explicitly included in cash-flow cash;
the RCF sweep uses only the balancing liquidity bucket; interest uses only the
interest-eligible buckets; and net debt uses the net-debt-eligible buckets. A
debt item netted from cash-flow cash but presented separately in gross debt is
restored through a debt-linked cash add-back. That add-back must mirror the
named instrument balance, must be excluded from cash-flow cash and liquidity,
and must carry zero interest eligibility. Never solve this with a company-name
branch or a fixed forecast plug.

The cash-flow statement calculates its own ending cash from its visible opening
cash, net cash movement and FX line. The balancing cash bucket, liquidity block,
net-debt build and interest schedule consume that answer and reconcile to it;
none may push a same-period closing balance back up into the cash-flow statement.

The same cash-flow basis governs opening cash in standalone and pro-forma
columns. A pro-forma column cannot open on gross reported cash, because that
would reintroduce any debt-linked add-back into liquidity and interest.

The canonical blank template assumes 100% of cash is eligible. A populated case must apply a lower visible eligible-cash percentage when restricted, trapped or non-interest-bearing cash is material. Label the spread generically as `Cash yield spread`; use `SOFR` only when USD SOFR is actually the selected benchmark.

Use an underlying binary `Circularity` control:

- `1 / On`: calculate every model-generated forecast interest-expense and
  interest-income line using the approved timing and average-balance mechanics.
- `0 / Off`: return formula-driven zero from every model-generated forecast
  interest-expense and interest-income output, including instrument, RCF,
  commitment-fee, lease, acquisition, other/unallocated and non-cash interest.

Keep raw manual interest assumptions intact in both states. Apply the control in
persistent calculation formulas so the formulas themselves never disappear or
change. Historical interest is never affected. Debt, cash, RCF, operating and
acquisition schedules continue to calculate in breaker mode. Because forecast
interest is absent from net income when the breaker is off, do not add back
non-cash interest in cash flow in that state.

Toggling must never write values into, remove or replace formula cells. Use
automatic calculation and enable controlled iteration for the `1` state where
average post-waterfall balances create a genuine circularity. Capture the `1`
baseline, switch to `0`, confirm every model-generated forecast interest output
is zero and the non-interest schedules remain coherent, then switch back to
`1`, perform a full calculation and reproduce the baseline within tolerance
with formula text unchanged.

Reflect cash interest expense and interest income in cash flow exactly once through net income under the default CRH-style presentation. Add back non-cash interest once when it is included in net income. Use a different cash-flow classification only when the selected source-template convention explicitly requires it.

The Interest Schedule is the sole workbook authority for finance amounts. Enter
filed historical finance expense, finance income, cash interest paid and cash
interest received there once, with their original provenance, and link the
Income Statement and Cash Flow Statement down to those schedule rows. Forecast
statement finance rows follow the same direction. Never make the schedule read
back from a statement consumer, and never manufacture a non-cash-interest
Cash Flow Statement line merely to display the reconciliation: such a line is
shown only when the issuer-supplied statement graph actually contains it.

Specialise formulas to the active case. Keep automatic maturity logic in each
instrument's visible ending-balance formula and expose one aggregate mandatory-
repayment answer in the debt schedule. Do not render a repeated technical
`Mandatory repayment` line beneath every instrument and do not repeat maturity
logic again in the cash-sweep block. Release validation blocks any visible
formula above 1,600 characters or a 95th-percentile formula length above 750
characters.

Use conditional formatting or a display format to show `On/Off` while retaining the underlying `1/0`.

## 12. Lease policy

Choose and label one evidence-based mode:

1. `simple_roll_forward` when additions and principal repayments are available;
2. `sourced_balance` when forecast closing liabilities are supplied directly;
3. `flat_replacement` when only a liability and annual principal/interest information are available;
4. `exclude` only when leases are immaterial or outside the selected debt definition.

The canonical blank workbook uses `flat_replacement` as its compact default:
forecast operating- and finance-lease liabilities carry from the prior year,
cash principal repayment is a visible forecast input, and the balancing
replacement addition is treated as an implied non-cash item rather than adding
a detailed lease roll-forward. A generated company case may replace the
carry-forward with sourced forecast lease balances or the simple roll-forward
when additions are available. User-entered lease balances, additions and
principal assumptions remain visible. Purely mechanical roll-forward helper
rows must also remain visible on the `Operating Model`; they may be placed in a
collapsible outlined group beneath the visible answer row but may never be
hidden.

Under `simple_roll_forward`:

```text
ending lease liability = MAX(0, opening liability + non-cash additions - cash principal repayment)
```

Under `flat_replacement`, show non-cash replacement additions equal to principal repayment so the liability does not decline without explanation. In both modes, map principal repayment into financing cash flow exactly once and do not treat non-cash additions as cash outflows.

Model finance-lease interest in the Interest Schedule. Do not add operating-lease interest separately when operating lease cost is already included in operating expenses unless the source explicitly separates and reclassifies it.

Total lease liability and interest-bearing lease liability are not assumed to be
the same. `interest_basis` is `total_liability`, `separately_supplied` or `none`.
US GAAP cases must choose explicitly. When separately supplied, show the
interest-bearing balance as its own visible debt-schedule row and calculate
interest from its average opening and closing balance.

The `exclude` mode removes lease liability, principal and finance-lease interest from the debt overlay; it does not remove an operating lease expense already present in EBIT or operating cash flow.

State whether leases are included in gross debt, net debt and leverage. Show leverage both including and excluding leases when the chosen definition or user need requires the comparison.

The net debt and leverage block must reconcile on the face, top to bottom, with
no denominator held off-screen — and it must say which BASIS each number is on,
because a standardised calculation and an issuer's own definition are different
claims about the world. Both matter; conflating them helps nobody.

```text
--- Net debt and leverage — model basis -----------------------------
gross debt (excl. leases)
+ lease liabilities            -> gross debt (incl. leases)
- eligible cash                -> net debt (excl. leases)
                                  net debt (incl. leases)
Adjusted EBITDA                (visible denominator)
net debt (excl. leases) / Adjusted EBITDA
net debt (incl. leases) / Adjusted EBITDA
net interest expense           (visible denominator, shown as a positive cost)
Adjusted EBITDA / net interest expense
total change in debt — cash movement
+/- FX translation on debt (non-cash, multi-currency books only)

--- Net debt and leverage — company reported ------------------------
net debt (model basis)         (restated from the row above)
+/- <named reconciling item>   (one row each, in the issuer's own words)
                               -> net debt (company reported)
Adjusted EBITDA (as above)     (visible denominator)
net debt (company reported) / Adjusted EBITDA
```

Each ratio divides by the row directly above it rather than reaching back into
the income statement, so the multiple can be checked by eye without leaving the
block. Surface the denominator; do not bury it in the ratio formula.

The model block is unconditional. The company block appears only when
`historical_supplement.reported_net_debt_adjustment` supplies at least one named
component that is non-zero in some period. The header follows the explicit
`reported_net_debt_basis_status`: claim the company basis is the same only for
`proven_same`; describe a named bridge as `reconciled_difference`; disclose
`reported_unreconciled` as unresolved; and use neutral standardised-basis wording
for `not_disclosed`. Absence of a bridge is never itself evidence of equality.

Name every reconciling item. A single anonymous "(+/-) reported adjustments" row
is forbidden: it asserts a difference without describing it, and in practice it
sat at zero, which is worse than silence.

The model-basis multiples divide MODEL-basis numerators, always. The independent
solver measures leverage on the model basis, so pointing the model ratio at the
company-reported row would leave the visible formula disagreeing with its own
cached value.

## 13. Adjustment columns and the acquisition overlay

The canonical acquisition mode is `funded_transaction`; `references/acquisition.md` is the detailed authority.  Transaction enterprise value creates one purchase-consideration investing cash outflow at close.  Separately supplied acquisition debt creates one financing cash inflow at close and one persistent debt balance.  Residual consideration is funded from existing cash and, if required, the ordinary RCF waterfall; no equity plug is invented.

Target EBITDA equals transaction value divided by entry EV/EBITDA.  Target revenue and the visible operating statement rows derive from corresponding standalone forecast ratios so gross profit, operating expenses, EBIT, D&A and EBITDA form a visible bridge.  Close-year contribution and interest use `(13 - close month) / 12`; later years use full-year amounts.

The lightweight case does not add a target balance sheet, purchase accounting, synergies, fees, target net debt/cash, funding percentage, financing tranches or acquisition maturity.  Off state preserves standalone economics exactly.  On state proves consideration, debt proceeds, debt balance, cash/RCF funding, interest, liquidity and leverage each enter once.

## 14. FX and historical normalisation

Activate only when material.

- Use average FX for P&L and cash-flow items.
- Use period-end FX for cash and debt balances.
- Surface the period-end rate as a visible row at the head of the debt schedule,
  one row per foreign instrument currency, stated in reporting-currency-per-
  native terms. Balances reference that on-sheet row; a balance formula must not
  carry a cross-sheet `'Forward Curves'` call, and must not hide an inversion
  inside itself where the case quotes the pair the other way round.
- Convert a reporting-currency RCF requirement into the facility currency at the selected draw-date or period-average cash-flow rate, cap the draw against facility-currency capacity, then translate the executed draw back consistently.
- Use the benchmark for the instrument currency.
- Separate translated debt movement from cash issuance or repayment.
- Combine predecessor entities at the underlying amount level before calculating ratios.
- Cover each target historical period exactly once.

When a currency benchmark is unavailable, use a visible supplied manual all-in rate. Never invent a benchmark or spread. Keep support sufficient to explain the mapping without turning it into a central source archive.

## 15. Formatting semantics

Apply:

- blue font: editable hardcodes and sourced numeric inputs, including historical values;
- black font: formulas, calculations and same-sheet references;
- green font: formulas linking to another sheet in the same workbook;
- red font: external-workbook links, which must be removed before delivery;
- white font: titles and section labels on dark fills.

Do not classify labels, titles or metadata as numeric inputs. A hardcoded numeric zero used as an input is blue. A formula such as `=0`, a sum, division or same-sheet reference is black. Any formula containing a reference to another sheet is green.

Conditional formatting may override the displayed status colour or fill of a binary control, but provenance QA must still classify its underlying value as a hardcode. Do not misclassify an `On/Off` switch from its rendered conditional style.

Use grey fill only when a cell is intentionally not calculated or not applicable. Do not use grey to mask a missing formula, a broken acquisition case or an ordinary zero. Ordinary calculated zeros may display as a dash through the number format while retaining the normal white, subsection or total fill. Do not grey the entire acquisition or pro-forma block.

Use compact Calibri 8-scale formatting, dark navy section bands extending across their applicable blocks, restrained pale-blue subtotal bands, subtle forecast boundaries, intentional indentation and sparse borders/underlines.

## 16. Validation intent

Prove, do not merely assert:

- correct 3H/3F structure and permitted support sheets;
- opening debt reconciliation;
- debt, lease, cash and RCF roll-forwards;
- maturity control in both states, including partial-year interest;
- circularity control through baseline `1`, breaker `0` and restored `1`, with formula text unchanged;
- interest ties and cash-linked interest income;
- RCF bounds and visible capacity shortfall;
- acquisition isolation, timing and standalone-plus-adjustment identity;
- FX cash/non-cash separation;
- formula/input/link colour classification;
- no unexpected hardcodes, formula errors or external links;
- save, close, reopen and recalculate persistence;
- visual review of every user-facing sheet.

For every release case, require:

1. a fresh-copy build or open;
2. structural, formula, style, conditional-format and validation scans;
3. full native Excel calculation, or an explicitly equivalent engine where native Excel is unavailable;
4. baseline reconciliation to an independent solution or approved golden map;
5. dependency perturbations for retained operating subtotals and every material schedule;
6. acquisition, circularity and maturity control states where applicable;
7. debt, lease, cash, RCF, interest, acquisition and FX identities;
8. save, close, reopen and full recalculation;
9. formula/hardcode/link role verification;
10. renders of every user-facing sheet;
11. a hash-bound certificate covering the workbook, template, contracts, validator, scenario inputs and failures.

For `reference_parity`, separately score direct formula-bar evidence, inferred copy patterns, screenshot-only evidence and unavailable source metadata. Do not convert missing evidence into a pass.

Keep the production workbook free of a dedicated central checks sheet. Preserve QA as external, hash-bound release evidence and use compact local check rows only when they improve schedule traceability.
