# Forecast and input policy

## Historical basis

Map three historical years into the common taxonomy. Preserve disclosed company definitions when consistent, then bridge them visibly to the minimum model lines.

Normalise:

- reporting currency and units;
- fiscal periods;
- continuing and discontinued operations when material;
- reported and adjusted EBIT / EBITDA;
- cash-flow signs;
- debt and lease definitions.

Use the advanced history and FX module for predecessor companies, material calendarisation or multi-currency translation.

## Evidence discipline

Retrieve only the primary documents, workbook ranges and source sections needed for the selected company, periods and modules. Do not load a broad archive by default.

Use supplied company evidence and forecasts. Do not create a central source register. Where useful, place compact source or assumption notes beside material hardcodes or in cell comments.

Never invent a material debt term.

**Reporting currency, fiscal calendar, units and the period range follow the
company and are never asked.** Resolve them from the filings. Asking the user to
confirm them tells them the model does not know what it is looking at.

Ask only when a question clears both bars: the model cannot resolve it from its
sources, **and** the two plausible answers produce materially different output.
Everything else becomes a stated assumption printed at the end. Use company
language, state every option's consequence in money, phrase for a one-word
answer, and **stop at five**. If more than five clear the bar, the inputs are
wrong — say so rather than emitting thirty questions.

The instrument-level source is the FactSet DCS debt export **taken at last fiscal
year end**. An export taken at today's date is the commonest production error and
announces itself as an unexplained residual against reported gross debt. A failed
reconciliation is not a question — no answer from the user fixes a stale export —
so it is a hard stop and a re-supply, with the three numbers stated.

Do not proceed past the coverage gate until a material gap is resolved or
documented within the residual-debt threshold, with the residual on the face of
the model.

## Forecast authority waterfall

Forecast authority is selected **per semantic row and per forecast period**.
FY1, FY2 and FY3 may use different paths.  Do not treat `brokers`, `linking`,
`zero` and `grey` as interchangeable forecast methods: first establish the
row's role, then select evidence for any independent forecast input.

### Gate the row role first

1. A subtotal or accounting identity is formula-derived from visible rows.
2. A schedule-owned line links from its sole authority: interest, debt, lease,
   RCF, acquisition and cash mechanics are never independently forecast on a
   statement consumer.
3. Detail that is deliberately not forecast separately is blank and grey while
   its parent remains forecast.  This is not a zero.
4. A genuinely non-applicable row is blank and grey.
5. Only an independent forecast input enters the evidence ladder below.

### Independent-input evidence ladder

Apply in this order, subject to exact metric, scope and period compatibility:

1. reported-to-date actual plus a separately selected forecast remainder;
2. contractual or committed amount and timing;
3. formal company guidance;
4. a clear numeric company indication that is not formally labelled guidance;
5. compatible broker consensus or the selected broker case;
6. an explicit user assumption;
7. a visible company-specific driver or roll-forward;
8. historical seasonality or run-rate;
9. recent historical average;
10. trend or CAGR;
11. carry-forward of the last supported level;
12. explicit zero, but only with an economic no-recurrence or inapplicability
    rationale; and
13. unresolved.

`Unresolved` never becomes a silent zero.  A material unresolved row triggers
one targeted question or blocks.  An immaterial detail row may be marked not
separately forecast only when a forecast parent already captures the amount.

After every sourced, linked, schedule-owned and captured path has been tested,
a non-schedule historical input may use a visible last-supported-level carry or
an explicit zero as the final deterministic fallback. The selection and reason
remain in the forecast receipt; grey is a presentation state, not a forecast
method.

For a partial period:

```text
full-year forecast = reported YTD / H1 / Q3 amount + forecast remainder
```

Select the remainder from: committed amounts; remaining company guidance;
full-year broker forecast less reported-to-date actual; broker quarterly
estimates; historical seasonality; straight-line run-rate where economically
sensible; or an explicit user assumption.  Never add a full-year broker number
on top of reported-to-date actuals.

Every selected authority records method, source kind, period, source/as-of
information where applicable, confidence, any range-selection policy and the
reason for zero or non-forecast treatment.  `forecast_authority_contract_version:
waterfall_v1` carries these decisions as `forecast_period_authorities` on the
semantic row.  Deterministic code compiles that declaration into exactly one of
formula, cross-sheet broker link, visible hardcode, formula-driven zero,
intentional blank or fail-closed unresolved.

Authority is immutable once declared for a period. A presentation capture or
compiler fallback may never erase a direct broker link, sourced formula, user
assumption or supplied value. The compiler records every eligible candidate,
the selected candidate and any parent-capture certificate. A capture is valid
only when the parent is a genuine disclosed or semantic aggregation, the child
has no stronger direct authority, and the parent includes that child exactly
once. Accounting identities such as EBIT, EBITDA, PBT, tax, net income and cash
totals are never used as generic capture buckets.

Before selecting those authorities, record `forecast_context` in the evidence
run: every annual/interim result reviewed, the latest publication-dated result,
and whether guidance was used or reviewed and absent. Bind company methods to
those inventoried source IDs. An actual-plus-remainder method binds the reported
actual and the remainder separately. A material line cannot be called
`not_applicable`; parent capture, a sourced forecast, a stated historical
inference or a targeted unresolved question is required.

Do not prefer an aggregate broker number over a more compatible supplied metric.
Do not manufacture consensus from illustrative values. Distinguish supplied
values, user inputs and inferred assumptions.

## Minimum operating forecast

Forecast only the detail needed to connect operations to cash, debt, interest, liquidity and leverage:

- revenue;
- operating profit / EBIT;
- D&A;
- recurring disclosed adjustments;
- adjusted EBITDA;
- net interest from the Interest Schedule;
- pre-tax income;
- tax;
- net income;
- aggregate change in working capital;
- capex;
- other material operating, investing or financing cash flows;
- dividends and buybacks when relevant.

Do not force segment, product or detailed working-capital forecasts that do not improve the debt overlay.

## Visible drivers

Prefer simple copy-across formulas:

```text
revenue = prior-year revenue × (1 + growth)
EBITDA = revenue × EBITDA margin
D&A = revenue × D&A / sales
EBIT = EBITDA - D&A - recurring adjustments
net interest amount = gross interest expense - interest income
P&L net interest line = -net interest amount
pre-tax income = EBIT + P&L net interest + other non-operating items
tax charge = pre-tax income × effective tax rate
P&L tax line = -tax charge
net income = pre-tax income + P&L tax line
capex requirement = revenue × capex / sales
capex cash-flow line = -capex requirement
```

Use supplied EBIT or EBITDA directly when available and derive the counterpart using D&A. Keep disclosed adjustments visible.

Do not assume that EBIT or EBITDA is always the supplied forecast authority.
Resolve the issuer's declared statement graph in either direction.  A valid
alternative authority may be PBT or net income when the remaining bridge is
complete and visible.  For example, a PBT-led forecast may use:

```text
EBIT = PBT - interest income - interest expense - other non-operating items
adjusted EBITDA = EBIT + D&A + approved recurring adjustments
```

Here interest expense retains its P&L sign, so subtracting a negative expense
adds the gross interest amount.  Circularity off must zero both interest legs;
the reverse bridge must then recalculate EBIT and EBITDA rather than retaining
stale broker values.  Never add an artificial EBIT/EBITDA hardcode merely to
satisfy a preferred forecast shape.

Keep every supplied value and user-editable forecast driver in a visible cell on
the consolidated sheet, in blue font. Blue font is the only mark an input
carries — there is no input fill.

**No row may be hidden.** There is no hidden support block; every mechanical row
is emitted on the face of the schedule it belongs to. Never put a source value,
an editable assumption, a material judgement or a business decision anywhere a
reader cannot see it.

For losses, do not apply a normal tax rate mechanically. Use a visible zero or limited-benefit assumption where appropriate.

## Cash-flow bridge

```text
cash from operations
= net income
+ D&A
+ other non-cash adjustments
+ aggregate change in working capital

cash from investing
= capex
+ other investing

free cash flow
= cash from operations
+ capex
```

Present capex as negative. Forecast aggregate working capital from supplied consensus, a percentage of revenue, a percentage of revenue change or a recent-history average. Show the selected method.

Include dividends, buybacks, restructuring and other cash items only when supplied, historically material or necessary to explain debt movement.

## Broker cases

Broker research covers a **minimum of 3 and up to 10** houses. Three is the
minimum for meaningful consensus coverage across the selected forecast
authorities. Count contributors separately in each forecast period; a house supplying
only FY1 is not an FY2 or FY3 contributor. Select exactly one headline anchor
between EBIT and Adjusted EBITDA, first on minimum period coverage and then on
total coverage. Use D&A as the separate bridge driver and derive the other
headline; never take EBIT and Adjusted EBITDA as two independent inputs. Ties
fall back toward EBIT. When another broker line is the authority, accept it only if the
declared formula graph resolves both EBIT and Adjusted EBITDA from fully
covered leaves and solved model quantities.

Brokers are authoritative for the **forecast anchor and consensus lines only.
Never for history.** Historic movements come from the filings without exception.

When broker data is supplied or available:

- retain used values on `Brokers`;
- require the full-table semantic coverage ledger to disposition every detected
  annual and partial-period row before selecting an authority;
- create a visible selector or consensus choice;
- preserve metric and period definitions;
- preserve stable definition ids and never average reported, adjusted, restated,
  lease-including, lease-excluding, FCFE or broker-defined FCF variants merely
  because they share a broad consensus family;
- keep quarterly/half-year evidence outside annual consensus, keep narrative
  guidance as company guidance, keep broker-derived annual points in their own
  lane, and retain supplemental debt/cash/output metrics as
  explicitly labelled checks rather than silent omissions;
- link the selected case into the main model;
- exclude synthetic values unless explicitly instructed;
- derive compatible model metrics visibly when definitions differ.

The production workflow requires the 3–10-house broker set and retains the
approved `Brokers` sheet. A synthetic stress test may use an explicitly
indicative broker fixture, but it must be labelled as test data and must never
be presented as sourced research. Do not fabricate broker observations for a
real-company production run.

For an autonomous public-company test, isolate the indicative forecasts inside
`public-test-run/1.0`. Use visibly synthetic house identities and preserve the
`SYNTHETIC TEST DATA` label in the case and workbook. Public filings may support
historical and debt facts; the synthetic pack may support forecasts only. The
result remains `TEST_ONLY_NOT_PRODUCTION_EVIDENCE` regardless of model quality
and cannot substitute for the production FactSet or broker inputs.

## Interest and cash

Do not forecast net interest independently from debt except through the visible permitted other-interest line.

Feed instrument interest and cash-linked interest income into the Income Statement. Feed net income into cash flow. Let the RCF waterfall determine financing need.

## Assumption visibility

Never hide:

- growth or margin assumptions;
- tax rates;
- capex ratios;
- working-capital methods;
- dividends or buybacks;
- debt rates and maturities;
- minimum cash;
- cash yield;
- lease mode;
- acquisition inference ratios.

Embedded constants are acceptable only for immaterial items and only when a labelled assumption would not improve auditability.
