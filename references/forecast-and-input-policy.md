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
answer, and show **at most five per round**. If more than five clear the bar,
persist the answers and show the next deterministic round; the input pack is
not defective merely because the company has more than five material decisions.

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

In the production controller, `selected-authority-contract/1.0` is the
executable resolver and sole forecast writer. The pre-resolution forecast plan
is a candidate ledger, not economic authority; the model case is materialised
again from the sealed selected states, and parity is checked before Build.

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

## Broker consumption tiers

The lossless broker evidence preserves everything the houses published. What
the MODEL consumes from it is a separate, deliberately narrow decision. A
forecast surface that wires hundreds of broker line items into the workbook is
an evidence dump wearing a model's clothes: cross-house consensus is only
meaningful for concepts whose definitions genuinely align, every wired link is
a maintenance and audit liability, and the analyst opened a debt overlay, not
a broker database. Consumption is therefore tiered, and the wall between the
tiers is enforced at the crosswalk, in the forecast waterfall, and by the
independent semantic verifier.

Every tier is defined in one place: `assets/broker-metric-dictionary.json`. The
consumable set, the electable concepts, the banned totals and the overlap groups
are read from it by the pack compiler, the coverage gate and the renderer, each
of which refuses if the asset's digest drifts or its own derived set disagrees.
The dictionary is also what the runtime READS when deciding that a broker's row
means capex: its definitions, disambiguations and counter-examples are addressed
to the reader making that judgment. What the machinery enforces is the vocabulary,
not the judgment — a crosswalk may only emit ids the dictionary declares. One
concept may occur several times in a house (two reported segments, three
impairment lines) under an instance qualifier after `__`; a core driver may never
be instanced, because a component consumed as the driver is exactly the
granularity error the tiers exist to prevent.

**Tier 1 — the fixed core, always consumed.** Nine ids: the headline anchor
(EBIT or adjusted EBITDA), revenue, D&A, effective tax rate, capex, AGGREGATE
change in working capital, dividends, and share buybacks. The anchor is consumed
as a live consensus link on the anchor row itself — whenever the waterfall
resolves an anchor from broker evidence, primary or supplemental, the anchor
row's forecast formula IS that link. An anchor that exists only in solver caches
leaves the statement identities under-determined, which the equation-graph rank
gate blocks.

Buybacks are consumed but NOT required of a house. A debt overlay that ignores
the largest discretionary call on cash is missing a real claim, so the row is
permanent and the waterfall runs broker consensus, then company guidance, then
nil with a visible note. But plenty of legitimate coverage notes do not forecast
buybacks, and demoting an otherwise complete house for a metric houses commonly
omit would be self-harm: house eligibility still turns on the six required
metrics plus one complete headline anchor.

**Tier 2 — declared flex, consumed only by election.** Tier 2 is a SHAPE, not a
list of blessed names: an individual cash-flow line item. A concept whitelist
needed maintaining every time a sector printed something new and still admitted
the wrong things. An election is legal only when ALL of the following hold: the
concept sits in the cash-flow statement; it is an individual line, not a
subtotal — checked against the dictionary's leaf flag AND the banned-totals list,
so operating, investing and financing cash flow, net change in cash and free cash
flow can never be elected however they are labelled; it does not share an overlap
group with a core driver, because consuming a lease payment already inside a
lease-inclusive capex spends the same cash twice; it is supported by at least
three houses under one common definition id — the same "three is the minimum for
a meaningful consensus" bar the intake screen states for the pack itself; and the
election is recorded as a reviewed crosswalk disposition with a rationale, to a
ceiling of ten. An elected line renders in the cash-flow section and nowhere
else; an election can never create an income-statement or balance-sheet row.
Fewer than three compatible houses means the concept stays evidence, however
interesting it looks. Silence never promotes.

The rule is deliberately cash-only. The overlay is a cash model, so a flow
several houses think material enough to print separately — a large recurring
impairment addback, a restructuring outflow — can change the debt path and costs
nothing structurally to admit. Re-cutting the income statement would instead
duplicate lines the model already derives.

**The attributed route — one or two houses, admitted by name.** House-count
measures whether a consensus exists, not whether a flow matters, and a critical
line one analyst models is information, not noise. The danger of a single source
was never that one analyst might be right; it was averaging one voice into
consensus clothing. Attribution un-launders it: a shape-legal cash-flow line
supported by fewer than three houses may be elected with `basis: attributed`,
naming its `source_house_id`, and it is consumed as that house's OWN series —
the named house must supply all three forecast periods, because an attributed
row has no pool to substitute from — and rendered wearing the house's name on
the Brokers sheet, never as a consensus row. The inclusion is the USER'S call:
the election carries `confirmed_by_user: true`, recorded from one consolidated
Stage-2 question, and the compiler refuses an attributed election without it.
Where three or more houses support the concept, attribution is refused the other
way — a genuine consensus exists and must be consumed as one. The ten-election
ceiling spans both routes. A disclosed commitment remains better than any
broker's estimate of it: when the flow is company-confirmed, it enters through
the company-evidence lane with filing provenance and the attribution drops away.

**The election gauge — nothing silently dropped, nothing silently adopted.** The
pack compiler weighs every cash-flow leaf concept any house printed and records
the verdict in `election_gauge`: elected as consensus, included by name,
candidate for the user's question (one or two houses, at or above five per cent
of the headline-anchor consensus at peak), or parked — below materiality or
structurally inadmissible — with house counts and the computed ratio on the
record. Stage 2 asks about the `candidate_attributed` bin in ONE consolidated
question per run; no candidates, no question. The parked remainder stays visible
on the house tabs and in the gauge itself, so the weighing can always be
audited after the fact.

**Tier 3 — everything else is evidence, full stop.** It remains lossless in
the run artifact and visible on the B01-B10 sheets, and it never receives a
consensus row wired into any model formula.

Two consequences are load-bearing. First, the central Brokers sheet renders
ONLY consumed metrics — the fixed core plus elected flex, one row per house
per metric with a consensus row — a compact grid an analyst can read whole,
not the candidate universe. Second, statement detail rows that the model does
not consume are captured under their anchor with a certificate and show GREY
forecast cells: history in full, forecast deliberately not calculated. Grey
capture is the default fate of operating detail between revenue and the
anchor; a populated forecast cell on a detail row must trace to a Tier 1
concept, an elected Tier 2 concept, a schedule, or a declared derivation —
never to "the broker happened to publish a number".

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
- require exact semantic coverage and provenance only for broker cells proposed
  as model authority; preserve all other rows/pages as non-blocking evidence;
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

The 3–10 reports are the supplied evidence set, not a minimum consumption
quota. If no house has a verified value for a concept-period, consume no broker
value there and continue down the ordinary authority waterfall. If every house
is unusable for model authority, retain every report on its image-evidence tab,
record zero broker consumption and build from company evidence, schedules,
visible assumptions or historical methods. Broker absence alone is never a
delivery blocker.

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
