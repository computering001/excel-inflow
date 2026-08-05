# Template and formatting contract

`assets/standardised-design-runtime.v2.json` is the production projection of the measured workbook authority.
`assets/style-tokens.json` states the portable token subset. This file explains
both and states the rules the machine-readable files cannot express. Where this
prose disagrees with either asset, the applicable asset wins — **but never edit
an authority asset to make a check pass.**

## Reference hierarchy

1. Use the v2 dynamic compiler for a new production workbook.
2. Select the maximal or net-cash authority profile from the normalised case.
3. Preserve the authority profile's fixed A:U grammar, block order, controls and
   named expansion-zone boundaries while inserting company-specific semantic rows.
4. Preserve a supplied user template only for a guided repair or conversion.
5. Use a separately supplied standardised reference workbook as supporting
   physical evidence, never as a remotely fetched dependency or competing
   topology authority.

The standardised maximal and net-cash workbooks are the presentation and topology
authorities. Never reproduce company-specific values, embedded constants, flat
interest income, lease inconsistency or transaction defects from an example
workbook.

## The four channels

This is the governing idea of the whole formatting layer. Each channel does one
job, and they are independent.

| channel | carries | never carries |
|---|---|---|
| **font colour** | provenance | anything else, ever |
| **fill** | the rank hierarchy | inputs, blocks, forecast shading |
| **rules** (single, double, box) | arithmetic closure — where a sum ends | emphasis |
| **bold** | every semantic total/subtotal, plus a small declared headline set | provenance or rank fill |

Bold follows the semantic total contract, not label spelling or row number.
An unfamiliar issuer-specific total therefore receives the same weight as
Revenue, Gross Profit, Operating Profit, PBT or Net Income. A numbered
subsection parent such as Change in Working Capital is not a total and remains
unbold unless the source statement itself declares it as one.

### Font colour is the provenance layer

| colour | meaning |
|---|---|
| blue `#0000FF` | a genuine hardcode — a typed, sourced fact |
| black `#000000` | a formula on the same sheet |
| green `#008000` | a link to another sheet in the same workbook |
| white `#FFFFFF` | section-band titles and chrome |
| red `#FF0000` | reserved for external links, which are prohibited, so it never appears |

Grey is a **fill** and never a font colour. It marks a cell that was
intentionally not calculated.

Labels and metadata are black. Colour a calculated date or value by its formula
class, not by what it looks like.

Two rules protect this layer, and both exist because it has been destroyed
before:

- **A conditional-formatting rule may set fill, border, bold, italic and number
  format. It may NEVER set font colour on a body cell.** A rule that overrides
  font colour silently destroys the provenance of every cell it touches while
  every structural check still passes.
- **Never assign a full font object to a body cell.** Partial font assignment
  merges, so `{bold: true}` preserves colour. A full object resets colour to
  black. The instrument-terms block is entirely blue inputs plus a few black and
  green formulas; one full font assignment there erases the provenance of the
  whole block.

## There is no input fill

An editable input is **blue font and nothing else**, wherever it sits.

The history matters, because it is why this is stated so absolutely.
`#D9EAF7` was the total fill *and* the input fill, so a subtotal row and a cell
the reader is meant to type over were the same colour — a real provenance
collision. A yellow input fill (`#FFF2CC`) was introduced to break it and was
reversed the same day: 411 tinted cells on one case is a highlighter pass, not a
reference model. The collision is broken instead by giving fill to the rank
hierarchy alone and leaving every input unfilled. An input has no fill to collide
with, so the collision cannot recur by any route.

`total_fill` is gone as a name, because it was a synonym for `answer_fill` while
block subtotals actually carry `subsection_fill` — one name covering two
different treatments.

**Consequence: blue font is now the only thing marking an input.** That makes the
provenance layer more load-bearing than before, not less.

An input that is *also* a total — a subtotal whose history is hardcoded — carries
its own rank's fill, because the fill states the row's identity and the blue font
states the cell's provenance. The two channels do not compete.

## Rank — three ranks, and rank is contextual

Rank is keyed on **`(row_id | semantic_role, section)`**. It is resolved in the
row-plan compiler and the emitter looks the physical row up through the compiled
plan.

**Rank is never a list of physical row numbers.** It was, and the arrays were
wrong the moment an instrument was inserted while still reading as authoritative
— which contradicts the standing rule that physical rows are compiled output and
never canonical.

**Why the section is part of the key.** The same line is legitimately an ANSWER
where it concludes a build-up and a STEP where it feeds one. `net_interest_expense`
is the answer of the interest schedule and a step on the income statement. Keyed
on the id alone it could only be one of the two, and the set — written from the
debt overlay's point of view — declared it an answer everywhere. The income
statement then gave the reader a double-ruled, answer-filled INTEREST line with
net income below it in a lighter treatment.

| rank | means | treatment |
|---|---|---|
| **component sum** | closes a run of like items | thin top rule over the number cells · **no fill** · bold |
| **block subtotal** | closes a block of the model | thin top rule · `#EFF5F9` · bold |
| **answer** | the figure the reader came for, **in this section** | thin top rule · **double bottom rule** · `#D9EAF7` · bold |

Block subtotal is the default for any total not otherwise classified — an
unclassified total keeps a fill and can never silently lose its weight.

The double rule is a **border**, not a font underline: a border spans the whole
cell and aligns across all four column blocks, which a double-accounting
underline does not.

Two ratio rows are the deliberate exception to "a ratio is a reading of the rows
above it and stays italic": a leverage multiple is not a step to anything, it is
what the reader opened the model for, so it takes the answer rank.

**The two bases terminate identically.** `net_debt_company_reported` and its
multiple take the same rank as their model-basis counterparts. The
company-reported figure used to fall through to the block-subtotal default, so
the formatting asserted that one basis is the real number and the other a
footnote. They are two answers to the same question.

### Bold — totals plus the headline set

Every compiled semantic total or subtotal is bold. The decision is structural:
`style_role: total`, `row_type: subtotal`, or a declared mechanical total. It is
never inferred from a familiar label and never attached to a physical row.

Additional headline prominence is declared per section as a **ladder**, not as a row-id list: the first id
present in the compiled section wins and the rest are ignored. That is how the
set adapts to what a company actually reports — a case stating `operating_profit`
bolds that line, a case stating only `ebit` bolds that one, and neither is forced
on a company presenting neither.

Chrome is bold because it is chrome, not because it is prominent, and is not part
of the headline set: section bands, the period header and period-group header,
the control and acquisition blocks, and label-only sub-block titles. A **numbered**
row carrying the `subsection` style role — a consolidated parent with its
constituents indented beneath it — is not chrome and is not bold.

**The rank set is the authority; citation count is the independent check.** A row
may carry the answer fill only if at least one other row's formula references it,
or it is a ratio row, or no other ranked row lies below it in its own section.
The compiler and the validator must not trust the same classification.

## Geometry

```text
A       narrow left gutter (width 1)
B       row labels (39)
C:E     instrument terms and visible assumptions (10, 10, 12)
F       gutter (2) — CARRIES FORMATTING THROUGH
G:I     three historical standalone periods (10)
J:L     three forecast standalone periods (10)
M       gutter (2) — BREAKS
N:P     three forecast acquisition-adjustment periods (10)
Q       gutter (2) — BREAKS
R       latest historical pro-forma reference (10)
S:U     three forecast pro-forma periods (10)
```

Sections, in order: `1. CONTROL`, `2. ACQUISITION CASE`, `3. INCOME STATEMENT`,
`4. CASH FLOW`, `5. DEBT SCHEDULE`, `6. RCF CASH SWEEP`, `7. INTEREST SCHEDULE`.
Adjusted EBITDA, free cash flow, leverage and liquidity are subsections inside
those sections, not additional major sections.

### The gutter policy — a narrow column is not automatically a break

`A`, `F`, `M` and `Q` are all width-1-or-2 spacers. **Only `A`, `M` and `Q` are
breaks.** They must remain white and unbordered. `F` carries fills and rules
through.

`F` sits between the instrument term columns `C:E` and the period grid from `G`.
Both sides of it belong to the same line item on the same basis — a bond's
currency and that bond's 2027 balance are two facts about one row — so a fill or
a rule that stops at `F` splits one row into two halves with no reason to be
apart, and leaves a section band reading as a labelled block plus a detached
rectangle over the period columns.

`M` and `Q` separate STANDALONE from ADJUSTMENT and ADJUSTMENT from PRO FORMA:
three different **bases** of the same figure, which the reader must never
conflate. The white gap is what makes three column blocks read as three column
blocks, so it stays. `A` is the sheet's left margin — there is nothing to its
left to carry across to.

The boundary between the terms block and the period grid is marked by **the terms
block's own vertical edges**, not by a white gap. A vertical division belongs in a
vertical channel.

**Recorded reversal:** `gutter_columns_must_remain_white` previously included `F`
and the build honoured it. Reviewer round 4 approved carrying formatting across
`F`. This was a contract change, not a tweak.

A rank rule therefore spans `B:L`, `N:P` and `R:U` — three runs, not one band, and
`B:L` is one run rather than `B:E` plus `G:L`. The rule runs under the label it
closes, which is why it starts at `B` and not at `C`.

### Section bands

A band spans **the column blocks its section actually uses**. Every statement
section spans all three period blocks. The CONTROL section does not: it is two
panels, the model controls at `B:E` and the acquisition case at `N:P`, with no
period grid at all. Banded across all blocks it emitted navy over `G:L` and again
over `R:U` — ten columns of section header over permanently empty sheet, marking
nothing. **Filling a column block a section does not reach is a claim the sheet
cannot honour.**

Navy `#092064`, white bold text. Band spans carry through the carrying gutter and
exclude the breaking ones.

### Freeze, panels and spacers

The freeze pane is **compiled output**, exactly as physical rows are. It freezes
at column `G` — leaving the label and terms block `B:E` visible — on the row after
the compiled period row. Never lint the emitted freeze row against the static
template's; the template freezes where it does for reasons of its own and any
agreement is a coincidence of row counts. The invariant that survives compilation
is the split at column `G`.

Two bases, two panels, separated by a blank row. The model-basis box and the
company-reported box must not share an edge: two frames touching read as one
region with a line through the middle rather than as two statements of the same
figure on two bases. A blank row sits above the model-basis panel and between the
two panels. Spacer positions derive from the compiled plan; the spacer consumes a
row number and lands in no index, so no emitter can address it. **A spacer carries
no label, no formula, no fill and no rule.**

The company-reported panel exists only when the case supplies genuinely non-zero
named reconciling items. Where the model basis is the company basis, suppress the
panel and say so in the model-basis header. One row answers the question; five
rows of zeros do not.

Hide gridlines. The sheet's explicit formatting defines the structure.

## Indentation

Use `alignment indent`, never leading spaces in the label string. Leading spaces
are invisible to the style layer, impossible to change globally, and they corrupt
column-width measurement. Strip them from label strings wherever the indent lands,
or the two compound.

- level 0 — sections, subsection headers, totals
- level 1 — ordinary children under a subtotal
- level 2 — constituents beneath a consolidated line

Indent depth is tree depth. It is derived from the row hierarchy, not declared
per row.

## Fills — one fill, one meaning

| fill | meaning |
|---|---|
| `#092064` | section bands |
| `#EFF5F9` | subsection headers **and** block subtotals |
| `#D9EAF7` | answer rows only — roughly ten rows, never an input |
| `#EFEFEF` | intentionally not calculated, or not applicable |
| `#FFEB9C` | conditional: revolver drawn in that year |
| `#FFC7CE` | conditional: liquidity shortfall in that year |
| white | ordinary body, formulas, calculated zero, and **every component sum** |

The palette is closed. A blanket fill over the forecast, adjustment or pro-forma
column blocks is forbidden — a fill that appears because a condition holds is not
blanket, which is why conditional formatting is the only compliant way to shade a
block at all.

A blank or broken formula may never be hidden behind the grey fill.

Two adjacent block subtotals from different sections carry the same fill by
design, so a block subtotal whose next row opens a sub-section also takes a thin
dark grey **bottom** rule. Without it `Net Cash from Operations` and
`Cash from Investing` blend into one another.

## Borders — frames, not a grid

Every rule either closes a run or draws a box round a panel. **No body cell is
ruled on all four sides.**

| where | treatment |
|---|---|
| period header row | thin dark grey bottom rule per column block, breaking at the breaking gutters only |
| period headers, internal | thin white verticals |
| standalone forecast boundary | thin dark grey left border at `J`, full model height |
| column-block left edges | `J`, `N`, `S` |
| control block · acquisition block | thin grey box round the entry fields |
| instrument terms `C:E` | thin light grey box on the debt and interest schedules |
| interest assumptions | thin dark grey outer with a thin internal divider |
| section close | thin dark grey bottom rule on the last row of each section, per column block |
| totals hierarchy | see rank — carried by line weight |

**Ordering is not optional.** A partial border assignment silently clears the
RIGHT perimeter edge of the range it touches while preserving the left. Draw
every box **after** every rule that crosses it, and draw a panel's own header
rule **before** its box. This has produced false bug reports more than once.

## Number formats — a closed ladder

No number format may reach `xl/styles.xml` that is not declared. A raw `0.0000`
and a bare `0` were once in active use with nothing to say what they meant.

```text
amount              #,##0;(#,##0);"–"
adjustment delta    "+"#,##0;(#,##0);"–"      N:P only
percentage          0.0%;(0.0%);"–"
coupon              0.000%
benchmark / spread  0.00%
multiple            0.0x;(0.0x);"–"
fx rate             0.0000;(0.0000);"–"
historical period   mmm-yy
forecast period     mmm-yy"E"
date                dd-mmm-yy
binary control      [=1]"On";[=0]"Off"
```

The adjustment block gets its own amount format because `N:P` is the middle term
of A + B = C: it states what the transaction *adds*, and a signed format says so.

**The invariant:** a true zero shows an en-dash on a white ground; an
uncalculated cell shows grey. **These two must never converge.** That distinction
is the only thing telling a reader which is which — so grey is always a fill and
never a number format, and a dash is always a format and never a fill.

Right-align numeric values and periods; left-align row labels. Use real dates
where dates are required.

## Instrument terms — an attribute is not a step in the arithmetic

`C:E` state what an instrument **is**: currency, face value, maturity on the debt
schedule; rate type, coupon or spread, benchmark on the interest schedule. Every
column from `G` rightwards states what **happens** to it, period by period, and
that is the left-to-right flow the reader is meant to trace.

The term *values* are italic; the header row keeps its upright bold. Italic is
the vocabulary this sheet already uses for the same idea one axis over — a ratio
row is italic because it is a reading of the arithmetic rather than a term in it.
The box round `C:E` says where the boundary is; it cannot say which side of it
matters more, and the answer is less weight on the terms, not more ink round them.

Every one of these cells is a blue hardcode or a black/green formula. **Partial
font assignment is mandatory here.**

## Conditional state

Fill only, on cells that already exist, driven by the control block. Structure
does not depend on state — no conditional rule sets a border, so every rank rule
and every double underline stays put when a toggle flips. Formula text is
unchanged in both states, and off/on/off/on must restore exactly.

| when | effect |
|---|---|
| circularity = 0 | interest schedule **forecast** cells take the grey fill and italic; history untouched — history was never circular |
| maturity roll = 0 | the maturity column and scheduled repayment rows read as suppressed rather than as zero |
| adjustment columns = 0 | `N:P` recedes; pro forma `S:U` stays live, because A + B = C means it correctly equals standalone |
| ending RCF > 0 | amber on `ending_rcf`, that year only |
| cash surplus / (deficit) < 0 | red on `cash_surplus_deficit`, that year only |
| broker case | tested in **both** directions — off-fill when the control reads `Consensus`, on-fill when anything has been selected over it |

The broker-case rule is written in both directions because the earlier one-way
rule fired only in the non-default state and used a near-white fill identical to
every subtotal, so on five of six cases the control carried no mark at all — and
passed every structural check.

On the `Brokers` sheet, the live case row is marked: on-fill and bold across the
whole row for a derived candidate, and on the name cell only for a named house.
The live case resolves into **one** ordinary cross-sheet formula cell and every
rule tests that same-sheet absolute — a conditional-format formula reaching
across sheets is not portable.

Control addresses resolve from the compiled plan and are never hardcoded.

**Explicitly forbidden: red font on negatives.** The parenthesis format already
carries the sign, and red is reserved by the contract for external links.

## Block titles

`Standalone` / `Adjustment` / `Pro Forma` on the period-group row are centred
across their blocks by alignment — `centerContinuous` over every cell of `G:L`,
`N:P` and `R:U`, with the text in `G`, `N` and `R`. **Merging is forbidden**:
merged cells in a calculation grid break addressing and range arithmetic.

`centerContinuous` does **not** survive the LibreOffice round trip. It is one of
the few things that legitimately belongs in the terminal patch stage, applied
after recalculation and never re-fed through LibreOffice.

## Fonts and page setup

Calibri, and no other font. Calibri maps to the metric-compatible Carlito on
Linux. **Never introduce Aptos** — it falls back to DejaVu Sans, which is not
metric-compatible, so every rendered-geometry assertion silently measures the
wrong thing while still passing. Lint for it.

Use fit-to-width, never explicit page scaling. Explicit 85% scaling silently
became 100% through the round trip; fit-to-width survives, which removes page
scaling from the patch stage entirely.

## Nothing is hidden

There is no hidden support block. Every mechanical row the model needs — balance
roll-forward, interest, repayment — is emitted on the face of the schedule it
belongs to, so the last allocated row is the last row of the model. **No row on
the `Operating Model` may be hidden and nothing may be written below the last
visible row.** Excel row *outlining* is not hiding: a collapsible group whose
parent shows the answer and whose children show its workings is visible model.

Never put an assumption, a source value or a business judgement anywhere a reader
cannot see it. Never disguise a supplied forecast as a formula such as `=1040`.

## Formula style

- Use one copy-across pattern across forecast years.
- Use direct `SUM` ranges for totals.
- Use absolute and relative references deliberately.
- Avoid `INDIRECT` and `OFFSET`.
- Use `='Sheet Name'!A1` for a same-workbook link, and spend a cross-sheet
  reference **once** — resolve it into an ordinary cell and let the rest of the
  sheet read that.
- Prefix modern functions (`=_xlfn.ISFORMULA(...)`), or they cache as `#NAME?`.
- Never bury a material assumption as an arithmetic constant inside a formula.
- Use simple helper rows instead of dense nested formulas.

## Verify in the emitted OOXML — never trust the API call

**The writer silently drops formatting calls.** The indent-level and freeze-pane
APIs were both called correctly and both reached the XML as nothing. The five
border treatments the token file described were absent from every emitted
workbook while the token file read as authoritative.

Therefore:

1. Verify every formatting decision by reading the emitted `xl/styles.xml` and
   worksheet parts, not by trusting that the call was made.
2. `validate_style_tokens.mjs` exists for exactly this, and it must run **beside
   the row-map sidecar** — four of its fifteen checks auto-pass without it.
3. Watch namespace prefixes. The build emits `<x:border>`, `<x:xf>`, `<x:c>`.
   Every regex over OOXML needs an optional `(?:\w+:)?`.
4. Watch self-closing cells. An empty cell emits as `<c r="C41" s="1"/>`; a regex
   requiring `</c>` skips it and pairs the reference with the next populated
   cell's body. This produced two false bug reports.
5. When a hand-rolled audit disagrees with a validator, **the audit has been
   wrong every single time.** Resolve the actual style indices — `s=` to
   `cellXfs` to `fontId` to `fonts` — and show the resolution for a disputed cell
   before disputing anything.

## Adapting an existing workbook

Before editing:

1. Render every relevant user-facing sheet.
2. Inspect current values, formulas, styles, merged cells, names and period
   columns.
3. Identify row and cell classes.
4. Preserve valid formulas, layout, names, tables and navigation.
5. Make the smallest structural changes that satisfy the model contract.

Extend nearby formulas, conditional formatting and borders when adding rows or
columns. Do not apply a workbook-wide restyle unless requested.

## Visual completion gate

Render every user-facing sheet after substantive changes. Fix clipped labels or
numbers; unreadable formulas or notes; inconsistent input, formula and link
colours; overlapping objects; excessively wide unused ranges; blank default
sheets; inconsistent actual/forecast boundaries; and totals without clear
hierarchy.

**Nothing in this contract changes a number. If a build's values move because of
a formatting change, something is wrong.**

For ordinary company builds, render every visible sheet and enforce structural
geometry directly: pagination, presence, clipping, overlap, alignment, fonts,
section bands, gutters and conditional formatting. Do not compare issuer-
specific labels and values with an example company's pixels, and do not require
PNG files in the skill or deployment runtime.

For a frozen local release replay only, diff rendered pages against an external,
independently approved baseline epoch. Any pixel change must be attributable to
an intended change. This extends the same discipline applied to numbers — zero
unexplained changed values, formulas or font colours — to the fixed authority
replay without turning a production run into its own visual authority.

`render/check_render.py` performs both modes. `--structural-only` needs no
baseline. Exact release replay omits that flag and uses `--update-baseline` only
in a separately authorised baseline-adoption transaction. Populate such a
baseline only from a real LibreOffice conversion of the frozen shipping-path
replay; a baseline written from another renderer or a raw attached authority
makes the regression check assert against the wrong producer. Run it on the
**patched** workbook — the patch stage is terminal, and a render of the pre-
patch file measures a workbook nobody will open.

**What the render evidence is worth, stated exactly:** it proves LibreOffice
rendering with Carlito. It is authoritative for visual regression and for
clipping. It is **not** authoritative for how the workbook looks to an analyst in
Microsoft Excel with Calibri. Keep Calibri in the workbook and record the Carlito
substitution in the evidence; never change the workbook font to match the
renderer, and never introduce Aptos, which falls back to DejaVu Sans and is not
metric-compatible, so every geometry assertion would silently measure the wrong
thing while still passing. Excel appearance closes on the human certification
checklist and on nothing else.

The emitter writes the workbook through openpyxl 3.1.5, which is native where
this package runs. `render/` reads no workbook object model and is stdlib-only by
choice, not by scarcity — see *openpyxl is available; `render/` chose not to use
it* in `references/validation.md` before quoting any docstring on the subject.
