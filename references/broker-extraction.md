# Broker extraction and source-table lineage

## Contents

1. Product outcome
2. Evidence chain
3. Extraction waterfall
4. Completeness gates
5. Semantic crosswalk
6. Workbook presentation
7. Runtime commands
8. Failure handling

## Product outcome

Convert three to ten broker documents into two distinct products without
conflating them:

1. a lossless, hash-bound source-table bundle that preserves every extracted
   table, cell, unit, heading, blank, dash, footnote and source location; and
2. the small normalized `broker-pack/1.0` forecast vocabulary consumed by the
   model.

The source-table bundle is evidence. The normalized pack is calculation input.
A value can enter the normalized pack only through a reviewed, cell-addressed
crosswalk back to the evidence. Never discard the full tables merely because
the model uses only a subset of their metrics.

## Evidence chain

The chain is:

```text
raw document bytes
-> broker-extraction-bundle/1.0
-> broker-source-tables/1.0
-> broker-crosswalk/1.2 + semantic coverage ledger + PASS receipt
-> broker-pack/1.0
-> model-case broker source mappings
-> values-only broker evidence sheets
-> Brokers sheet
-> Operating Model
```

Every boundary is content-hash-bound. The model case must preserve the source
tables and crosswalk receipt exactly. A table cell must not be retyped into a
later artifact without its table id, row, column and source reference.

## Extraction waterfall

Inventory and hash every document before reading it. Use this fallback order
for each page or sheet:

1. source-native XLSX cell extraction with formulas, cached values, formats,
   merged ranges and used-range geometry;
2. native PDF metadata, text and word coordinates;
3. vector-line table reconstruction;
4. embedded-image extraction;
5. page or table-crop rendering, grid-line removal and cell-level OCR;
6. two independent image-table transcriptions; and
7. one bounded, conflict-manifest-bound targeted adjudication when displayed
   economic cells disagree.

Do not run raw whole-page OCR on a dense raster table and accept the resulting
paragraph. Crop the table, identify the grid, remove lines, OCR cells and retain
row/column positions. Raw whole-page OCR is diagnostic only.

Write one surface ledger entry for every PDF page, workbook sheet or text
document. Retain native text and word geometry even when a table was found.
Render a page when it has a material image, sparse native text, or at least six
numeric tokens without a native table. Image-only or difficult pages are not
rejected merely for lacking a text layer; they become unresolved vision tasks
and block normalization until verified.

The deployment-host capability baseline proved all required lanes: Python/Node
handoff, PDF metadata, native text and coordinates, vector tables, embedded
images, page/crop rendering, OCR, image-table transcription, XLSX readback and
atomic hash-bound checkpoints. The controlled fixture achieved exact cells on
native/vector PDF tables, raster tables and XLSX. Keep the fallback ordering;
do not assume an optional library or one extraction lane is universally best.

## Completeness gates

The extraction bundle may be `PASS`, `NEEDS_VISION`, `NEEDS_RESOLUTION` or
`BLOCKED`. `NEEDS_RESOLUTION` is an internal resumable state and must not be
presented to the user as a request for new source files.

Only `PASS` may enter a build. `NEEDS_VISION` and `NEEDS_RESOLUTION` are work
instructions addressed to this run: execute the vision passes, adjudicate the
conflicts, carry the bundle to `PASS`. A run may not proceed on the portion
that happened to resolve, and may not substitute values assembled in
conversation for the surfaces that did not. When broker documents are present,
ingress requires the passing bundle before Stage 2 opens; there is no path from
a stalled extraction to a delivered workbook.

Require all of the following before `PASS`:

- every input document is represented once by its computed SHA-256;
- every page or sheet has one surface-ledger row;
- every detected table is retained separately rather than flattened into one
  arbitrary matrix;
- every cell retains raw text, typed value, row, column and source reference;
- native table numeric-token recall is 100%; missing and duplicate tokens are
  empty;
- every material raster/table page has two economically agreeing passes or a
  reviewed resolution bound to the page-image and exact conflict-manifest hash;
- blanks, dashes, zeros, parentheses, percentages and multiples remain
  distinct;
- table continuations, landscape pages, units and footnotes are preserved; and
- a gate that visited zero pages, tables or cells cannot report success.

Numeric recall is a completeness test, not a truth test. The semantic mapping
still needs definition, units, period and sign review. Conversely, a clean
semantic mapping does not cure an incomplete source extraction.

## Semantic crosswalk

Create one `broker-crosswalk/1.2` only after the extraction bundle is `PASS`.
Map by stable house id, metric id and forecast period. Each mapped value names
one or more source table cells, a coefficient, optional constant, optional
multiplier, rationale and review status. This declarative form supports a direct
cell, a transparent sum or a documented scale/FX conversion without executing
free-form formulas.

Do not infer a missing broker estimate as zero. Leave the period `null`. Do not
force every source row into the model vocabulary. Unused rows remain visible in
the source evidence. Required normalized metrics remain the existing broker
contract: revenue, D&A, effective tax rate, capex, aggregate working capital and
dividends, plus at least one supported headline anchor such as EBIT or Adjusted
EBITDA. Preserve any additional usable broker metrics; the forecast-authority
graph decides whether the model consumes them.

The metric vocabulary is closed. `assets/broker-metric-dictionary.json` declares
every id a crosswalk may emit, with a definition, unit class, statement family,
leaf/subtotal flag, tier and overlap group. Read the definitions — they exist to
inform the judgment, and their disambiguation notes name the confusions that
matter (a margin is not the profit it derives from; an authorisation is not cash
spent; an impairment addback in the cash-flow bridge is not the income-statement
charge). Map by meaning, then record the meaning under a dictionary id. An id
that is not in the dictionary is a blocking offence, not a naming preference: an
invented id cannot be compared across houses, checked for double-counting or
rendered in a standardised digest. Where one concept genuinely occurs more than
once in a house — two reported segments, several impairment lines — add an
instance qualifier after `__` (`revenue_component__segment_a`). Core drivers may
never be instanced. Encountering a concept the dictionary lacks is a reason to
extend the asset under review, never to improvise at runtime.

Consumption is tiered, and the pack compiler enforces it. The nine Tier-1 ids
(revenue, EBIT, adjusted EBITDA, D&A, effective tax rate, capex, aggregate
working capital, dividends, share buybacks) are always consumable. Any OTHER
metric declared as an active input requires a recorded `flex_elections` entry
whose concept is an individual CASH-FLOW line item — cash-flow statement family,
leaf, absent from the banned-totals list, and sharing no overlap group with a
core driver — with a rationale, AND at least three houses supplying it in all
three forecast periods under the one declared definition, the same three-house
bar the intake screen states for the pack itself. Fewer compatible houses, a
subtotal, an income-statement concept, an overlap with a driver already consumed,
or no election at all means the metric stays evidence: reclassify it
`reference_only` rather than widening the forecast surface. Never elect more than
ten concepts, and never map working-capital COMPONENTS as active metrics when the
aggregate exists. The central Brokers sheet renders only consumed metrics — an
analyst reads a consensus grid, not the candidate universe.

Mapping is COMPREHENSIVE, not selective. Walk every analytical table; every row
whose meaning matches a dictionary definition must be mapped — `reference_only`
at minimum — and every remaining row still receives a disposition. The narrow
consumption wall above is exactly what makes this breadth safe: a mapped
reference metric costs the model nothing, and it is what fills the standardised
digest that opens each house tab — the display surface a reader audits a broker
from. Stopping at the consumed core is not caution, it is data loss: an EPS, a
net-debt path or an FCF bridge left unmapped is a number the digest cannot show
and the reader cannot compare. The disposition ledger makes under-mapping
visible — a pile of `not_model_relevant` dispositions over rows that plainly
match dictionary definitions is a review defect, and the independent semantic
verifier challenges it. Breadth failures degrade gracefully by design: a
disputed reference mapping demotes to the raw tables with a note; only the
consumed core blocks.

Each house's digest is compiled from these mappings automatically — dictionary
order, the broker's verbatim caption, per-period values, verification grades and
source locations — and preserved exactly from pack to case to workbook, where
the independent validator re-reads every rendered cell. Nothing is asked of the
reviewer beyond mapping honestly and broadly; the digest is derived, never
authored.

Before compilation, review every extracted table once. Declare its class,
header rows and any annual or partial-period columns. Then disposition every
nonblank row intersecting those columns in one semantic coverage ledger as:

- `mapped_metric` — an annual forecast candidate with exact mapping IDs;
- `supplemental_check` — a distinct annual balance or output check retained on
  `Brokers` but marked `reference_only`;
- `mapped_guidance` — narrative or range guidance retained without inventing a
  point estimate;
- `broker_derived_estimate` — a broker calculation or implied annual value kept
  separate from company guidance and from ordinary annual consensus;
- `partial_period_evidence` — quarterly, half-year or other partial-period
  evidence kept outside the annual consensus;
- `duplicate` — an exact or definition-equivalent repeat naming its canonical
  candidate;
- `not_model_relevant` — preserved source detail outside the debt overlay; or
- `unusable` — a dash, ambiguous definition or otherwise unusable estimate.

Every disposition carries an exact source-cell set, a rationale and reviewed
status. It also carries an evidence kind, semantic role, stable definition id
and definition evidence. The compiler independently enumerates all rows touched by the declared
period columns. One missing row, shifted period, unowned mapping, cross-house
reference or unresolved candidate blocks. Quarterly values never enter an
annual slot. Reported, adjusted and restated definitions; different FCF or net
debt definitions; and working-capital balances versus changes remain separate
metrics unless a transparent transformation is declared.

Semantic completeness is stricter than row coverage. A numeric row cannot be
called unusable. A model-relevant operating, cash-flow, debt, lease, interest,
leverage or tax row cannot be excluded merely because the normalized vocabulary
does not yet contain it; retain it as a distinct reference-only metric. A
duplicate must match the canonical candidate's house, period basis, periods,
definition, evidence kind, semantic role and exact values. Valuation rows may be
excluded from the debt-overlay calculation only while remaining preserved as
market-data evidence.

Never combine source definitions merely because their labels are nearby. Bare,
reported, adjusted, restated and core profit definitions; aggregate, PPE-only
and intangible capex; FCFE and broker-defined FCF; and net debt including or
excluding leases use distinct definition ids. The optional consensus family may
relate them without asserting equivalence. A normalized metric may combine
houses only when the exact definition id is common.

Use `derived_mappings` for transparent arithmetic supported by more than one
candidate, such as D&A from compatible EBITDA less EBIT or PBT from operating
profit plus identified non-operating components. Each derivation names every
input candidate and one ordinary coefficient-based mapping. Free-form executable
formula text is forbidden; the expression field explains the already-declared
linear components and does not execute.

The compiler must prove:

- three to ten distinct houses;
- exactly three forecast periods;
- no duplicate house/metric/period writer;
- every referenced source cell exists and belongs to the same house;
- the compiled value equals its declared components, constant and multiplier;
- every normalized estimate retains publication and document metadata; and
- every extracted table has exactly one semantic review;
- every detected forecast candidate has exactly one reviewed disposition;
- every mapping is owned by at least one candidate and no candidate is
  unresolved;
- every disposition passes the independent semantic relevance, provenance,
  definition and duplicate-equivalence gates;
- every transparent derived mapping consumes all declared input candidates and
  remains cell-addressed;
- guidance and partial-period evidence retain their original basis; and
- the crosswalk receipt is hash-bound to both bundle and crosswalk and carries
  the zero-unresolved coverage summary.

## Workbook presentation

When full broker evidence is supplied, extend the three core sheets with one
optional evidence group:

```text
Operating Model
> Brokers
Brokers
B01 <house name>
...
B10 <house name>
Forward Curves
```

`> Brokers` is a lightweight divider. Each `B01`-`B10` sheet presents the
house's analytical and financial tables in clean vertical blocks with title,
source location, units, publication date, filename and source hash. Preserve
source row and column order, use two blank rows between blocks, keep numeric
values as blue hardcodes and labels as black text, and never place tables side
by side. It contains values only and must not be an economic calculation
surface. Legal boilerplate, third-party disclosure tables and narrative-only
material remain losslessly preserved in the run artifact with
`workbook_presentation=evidence_only` but are not rendered in the analyst
workbook. Every table used by a model mapping must be rendered.

These are two deliberately different artifacts. `broker-source-tables/1.0`
keeps the complete reviewed page inventory. `model_case.broker_pack.raw_tables`
is the deterministic projection of that inventory containing every house but
only its `analytical_table` tables. Never require their table counts or hashes
to be identical, never discard an evidence-only table from the run artifact,
and never hand-select a narrower workbook subset. Attachment ingress compiles
the projection and the evidence gate independently recomputes it from the
per-table disposition ledger. A mapped source cell on an `evidence_only` table
is a blocker.

The main `Brokers` sheet links mapped house estimates to those evidence cells.
The Operating Model continues to link only to `Brokers`; it must never reference
a raw evidence sheet directly. Evidence sheets are optional for legacy or
synthetic cases with no full-table bundle, in which case the workbook retains
the three core sheets exactly.

The independent OOXML oracle proves the evidence sheets are values-only, every
sealed source-cell reference is used by `Brokers`, and no other sheet bypasses
that authority direction.

## Runtime commands

Run one content-addressed, resumable transaction outside the immutable skill
tree. Re-run this exact command after completing any machine-authored task; the
controller verifies and reuses every unchanged checkpoint:

```text
python3 scripts/run_broker_pipeline.py <broker-extraction-request.json> --out <run-folder>/broker [--responses <responses-folder>] [--crosswalk <broker-crosswalk.json>]
```

The returned `broker-run-state/1.0` is the sole broker-stage status authority.
`NEEDS_VISION`, `NEEDS_RESOLUTION`, `NEEDS_CROSSWALK` and
`NEEDS_CROSSWALK_REVIEW` are resumable internal states and must have
`user_blocking=false`. The controller runs and hash-binds all of these component
commands; they remain available for diagnosis, not host-side sequencing:

```text
python3 scripts/extract_broker_evidence.py <broker-extraction-request.json> --out <run-folder>/extract
python3 scripts/compile_broker_surface_census.py <bundle.json> --out <run-folder>/broker-surface-census.json
python3 scripts/compile_broker_vision.py <bundle.json> --responses <responses-folder> --out <verified-bundle.json>
python3 scripts/verify_broker_semantics.py <verified-bundle.json> <broker-crosswalk.json> --out <run-folder>/broker-semantic-verification-report.json
python3 scripts/compile_broker_pack.py <verified-bundle.json> <broker-crosswalk.json> --out <run-folder>/broker
```

Every PDF surface is attempted through native text, word geometry, ruled-table
discovery, unruled-column reconstruction and embedded-image discovery. A weak
native result creates high-resolution region crops (minimum 300 DPI) alongside
the whole-page context image. Two independent reads must transcribe grids with
labels, period headers, values, units, footnotes and bboxes; a flat OCR number
list is not a table. Disagreement produces a cell-level conflict manifest. One
targeted third read resolves or quarantines only those cells and overlays the
result onto the richer agreed transcription; it never replaces the full table
surface.

Pass the resulting broker pack, source tables, crosswalk and receipt into the
attachment ingress `broker_evidence` declaration before compiling the evidence
run. Do not hand-edit `model_case.broker_pack.raw_tables` or
`source_mappings`.

### External real-layout regression cohort

Keep public or licensed regression PDFs and their hashes outside the universal
skill and outside the release package. They are test evidence, never modelling
authority. Run the optional host-side cohort with:

```text
python3 scripts/run_broker_public_layout_tests.py --corpus <external-corpus.json> --out <disposable-test-folder>
```

The test must prove every page enters the source inventory, every raw hash and
page count matches, any weak surface produces 300-DPI-or-better region crops,
`NEEDS_VISION` remains an internal state with `user_blocking=false`, and a clean
restart reuses extraction and census checkpoints. A report can join the corpus
only after its public or licensed source and exact hash are recorded. Never
bundle the PDFs, promote their values into a company case, or weaken production
evidence rules because a layout-only report is difficult.

## Failure handling

Pause once at Stage 2 only when a material modelling authority is still absent
after native extraction, two reads, one targeted adjudication, cell quarantine,
primary-house selection and the semantic forecast waterfall. A conflict in an
unused table, a partial broker, or a house that is not selected cannot stop a
complete eligible house. Present all surviving concept/period questions
together. Do not expose raw conflict counts or stop once per document.

If extraction fails, request the smallest corrected source: an unprotected PDF,
the original spreadsheet, a higher-resolution page, or confirmation of one
specific unit/period. Never substitute public consensus for a missing supplied
broker source inside a production evidence run.
