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

Convert one to ten broker documents into two distinct products without
conflating them:

1. a lossless, hash-bound source-table bundle that preserves every extracted
   table, cell, unit, heading, blank, dash, footnote and source location; and
2. the small normalized `broker-pack/1.0` forecast vocabulary consumed by the
   model.

The source-table bundle is evidence. The normalized pack is calculation input.
A value can enter the normalized pack only through a reviewed, cell-addressed
crosswalk back to the evidence. Never discard the full tables merely because
the model uses only a subset of their metrics.

For vNext, full-table preservation is not a permission gate for the model.
Render and retain every page, then locate and verify only model-driving
concept-period cells for authority. The semantic ledger may continue to enrich
reference-only tables, but an incomplete unused table can only degrade evidence
quality. It cannot prevent Debt, Build or Deliver. A selected-cell conflict is
removed from authority and routed through the ordinary forecast waterfall; it
does not poison its row, sibling periods, house or document.

Multi-page tables are one physical continuation graph, not one flattened
guess. Header inheritance requires an adjacent-page, same-document certificate
with compatible title/units/column geometry. Repeated headers remain their own
source cells; omitted headers inherit only through that certificate; truncated
headers use a hash-bound rendered-header read or quarantine that period. Every
continued value retains its own page/table/row/column/crop provenance.

## Evidence chain

The chain is:

```text
raw document bytes
-> hash-bound archive/capture lane (always retained)
-> filings-derived model-demand graph
-> selected-cell recovery and authority lane
-> broker-crosswalk/1.2 + selected-cell semantic receipt
-> broker-pack/1.0 (verified subset, possibly empty)
-> model-case selected observations + broker source mappings
-> hash-bound horizontal page-image evidence sheets
-> Brokers sheet
-> Operating Model
```

Every boundary is content-hash-bound. The evidence envelope preserves source
tables and the crosswalk receipt exactly; the model case carries the selected
projection and immutable page images. A value may not be retyped into a later
artifact without its table id, row, column and source reference.

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
document. Retain native text and word geometry even when a table was found,
and render every supplied page for the immutable archive. After filings compile
the model-demand and material-output-reachability graph, create recovery tasks
only for candidate cells that can satisfy a demanded concept-period. Apply the
native/vector/image waterfall cell by cell with bounded retries. An unresolved
selected cell is quarantined locally and removed from authority; an unused page,
row or cell remains archive evidence and never creates an OCR obligation or a
delivery dependency.

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

Only a CLOSED lane may enter a build, and the broker lane closes in exactly
two ways: `PASS`, or `PASS_DEGRADED` after the bounded recovery budget is
exhausted. `NEEDS_VISION` and `NEEDS_RESOLUTION` are work instructions
addressed to this run: execute the vision passes, adjudicate the conflicts,
carry the bundle toward `PASS`. A run may not proceed on the portion that
happened to resolve while ordinary work remains, and may not substitute values
assembled in conversation for the surfaces that did not resolve.

The internal controller is an append-only work graph, not an ordered stage
machine. A task discovered after crosswalk or resolution may be another vision
task when a later compiler exposes a previously hidden physical ambiguity.
That transition is legal. The prior checkpoint/task/receipt nodes must remain
present, the new task is appended, and a separately computed graph hash binds
the current frontier. An unchanged poll is byte-identical and consumes no
budget. Only a new accepted execution receipt, bound to the stable task id and
response bytes, consumes that task's finite budget. The closed graph has no
open task ids and is independently re-hashed again at attachment ingress.

A page that passed native extraction can be promoted to rendered recovery only
after canonical token reconciliation. Such a page has no extraction-time
`vision_task` by construction, so the canonical compiler must mint one
deterministically from the sealed page image, census and complete canonical
finding set. The same task path and bytes must recur after restart; a missing or
changed referenced task invalidates the cached canonical checkpoint. Both
`NEEDS_VISION` and pre-transcription `NEEDS_RESOLUTION` promotions begin with
the two independent grid reads. Targeted cell adjudication is permitted only
after those reads produce a conflict manifest.

For a legacy carrier created before canonical task minting, bounded exhaustion
may close a taskless late promotion only when the original page image is
present and hash-valid and every canonical physical-capture finding is
explicitly `model_linked: false`. The controller then seals an image-, finding-
and response-bound quarantine receipt, sets `model_use=prohibited`, preserves
the raw page and token census, removes the page from the pending set, and
continues with surviving clean broker authority. A missing or mismatched page
image, unknown linkage, any `model_linked: true` finding, or any selected
mapping that touches the page remains fail-closed.

When the finite budget is spent — vision attempts, fixed-point retries or an
aggregate internal defect — the controller closes the lane itself as
`PASS_DEGRADED`: the smallest defensible regions (a cell conflict, or a whole
surface) are quarantined `model_use=prohibited`, every raw report stays
preserved verbatim on its evidence tab, and quarantine counts are disclosed in
the state summary and the Stage-2 preview. Broker uncertainty REDUCES broker
authority — through continuation, quarantine, mapping exclusion, another
coherent house, down to FORECAST_WATERFALL with zero broker consumption — and
never blocks Debt, Build or Delivery. Only the four declared fatal reasons
(issuer/period unresolved, material opening debt unresolved, equation system
unsolved, workbook emission/validation failed) may block delivery, and none of
them is a broker reason. Never render broker-only uncertainty as "cannot
advance"; never delete unresolved evidence to fake an ordinary `PASS`; never
ask the user to re-upload unchanged readable research. `BLOCKED` and
`BLOCKED_INTERNAL` remain only for genuine controller corruption or tampered
artifacts.

Require all of the following before `PASS`:

- every input document is represented once by its computed SHA-256;
- every page or sheet has one surface-ledger row;
- every detected table is retained separately rather than flattened into one
  arbitrary matrix;
- every cell retains raw text, typed value, row, column and source reference;
- each model-selected native table has a closed physical receipt; missing and
  duplicate tokens outside selected authority remain disclosed archive census,
  not a model gate;
- every selected raster/table cell has two economically agreeing passes or a
  reviewed resolution bound to the page-image and exact conflict-manifest hash;
- blanks, dashes, zeros, parentheses, percentages and multiples remain
  distinct;
- table continuations, landscape pages, units and footnotes are preserved; and
- an archive gate that visited zero supplied pages, or an authority gate that
  claims selected cells while visiting zero selected cells, cannot report
  success. A lawful zero-authority close records zero selected cells while
  proving that all supplied pages remain archived.

Numeric recall is a completeness test, not a truth test. The semantic mapping
still needs definition, units, period and sign review. Conversely, a clean
semantic mapping does not cure an incomplete source extraction.

## Semantic crosswalk

Create one `broker-crosswalk/1.2` only after the physical lane is closed —
the extraction bundle is `PASS`, or it carries a degraded-close physical
capture receipt (`PASS_DEGRADED` path). Quarantined candidates may only be
preserved in evidence quarantine; a crosswalk that activates one for model use
is refused by the semantic verifier.
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

The canonical vocabulary is closed by default.
`assets/broker-metric-dictionary.json` declares every reusable id, with a
definition, unit class, statement family, leaf/subtotal flag, tier and overlap
group. Read the definitions and map by meaning. Where one canonical concept
genuinely occurs more than once in a house, add an instance qualifier after
`__`; core drivers may never be instanced.

One narrow run-scoped exception supports genuinely company-specific concepts.
An unknown id may exist only under the `run.*` namespace with a reviewed,
hash-bound `run-scoped-broker-concept/1.0` contract. The contract binds the run,
definition, section, unit/sign, materiality, forecast behavior, parent and exact
placement anchor, additive status, double-count proof, and row relation. Active
authority may bind only an already-established non-header company row and must
be material. A broker-only new row may be inserted only as non-additive
`reference_only` evidence; filings must establish any new additive company
economics before broker authority can bind it. Invalid or stale contracts are
rejected, never guessed, and never promoted into the reusable dictionary.

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

Physical CAPTURE is comprehensive; semantic mapping is demand-driven. Preserve
every supplied PDF, render every page, retain every discovered table/crop and
keep its immutable candidate inventory. Map only rows that can satisfy a node
in the current model-demand graph or that the controller can classify safely as
useful supplemental evidence. Everything else remains sealed evidence without
requiring a semantic disposition. This is not data loss: the original page
image is the audit surface, while the structured mapping is calculation
authority. An unmapped EPS, valuation table or product row cannot stop a debt
model that does not consume it.

Demand-driven recovery is also house-bounded. Choose at most one deterministic
coherent house for optional OCR/vision (latest supplied publication, stable
house/document tie-break). Already clean native cells from other houses remain
eligible, but ambiguous pages from those houses close archive-only rather than
opening parallel recovery fronts. If the selected house cannot close within
the finite cell budget, remove its broker authority and continue through the
forecast waterfall; do not reconstruct every report before building.

Each house's digest is compiled from these mappings automatically — dictionary
order, the broker's verbatim caption, per-period values, verification grades and
source locations — and preserved exactly from pack to case to workbook, where
the independent validator re-reads every rendered cell. Nothing is asked of the
reviewer beyond mapping honestly and broadly; the digest is derived, never
authored.

Before compilation, review the selected table/cell regions proposed for model
use. Declare their class, header rows and annual or partial-period columns. Each
selected or safely supplemental row receives one semantic disposition as:

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

Every selected disposition carries an exact source-cell set, rationale,
evidence kind, semantic role, stable definition id and definition evidence. A
shifted period, cross-house reference or unresolved SELECTED candidate removes
only that authority edge and reruns the forecast waterfall. Quarterly values
never enter an annual slot. Unselected rows/pages never block and remain
auditable through the sealed page-image inventory.

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

- zero to ten distinct houses; a zero-house pack is an explicit no-broker-authority result and the forecast waterfall continues;
- exactly three forecast periods;
- no duplicate house/metric/period writer;
- every referenced source cell exists and belongs to the same house;
- the compiled value equals its declared components, constant and multiplier;
- every normalized estimate retains publication and document metadata; and
- every model-selected table has a semantic review;
- every selected forecast candidate has exactly one reviewed disposition;
- every mapping is owned by at least one candidate and no model-selected
  candidate is unresolved;
- a bounded-review terminal quarantine may close only immutable candidates
  independently proven to have no mapping or mapped-cell overlap; a potential
  core-driver identity is recorded as unavailable and routed through the
  forecast waterfall rather than deleted; it remains evidence, permits no
  model consumption and is counted separately in the receipt;
- every disposition passes the independent semantic relevance, provenance,
  definition and duplicate-equivalence gates;
- every transparent derived mapping consumes all declared input candidates and
  remains cell-addressed;
- guidance and partial-period evidence retain their original basis; and
- the crosswalk receipt is hash-bound to both bundle and crosswalk and carries
  the zero-unresolved coverage summary.

## Workbook presentation

When broker PDF evidence is supplied, extend the three core sheets with one
optional image-evidence group:

```text
Operating Model
Brokers
B01 <house name>
...
B10 <house name>
Forward Curves
```

There is no divider sheet. Each `B01`-`B10` sheet embeds every page of that
house's PDF as a large immutable image, left to right in source-page order.
The source filename and SHA-256 appear above the images. These sheets are visual
evidence only: they contain no calculations, no reconstructed tables and no
cell-level model authority. Multi-page tables remain visually continuous
because consecutive full pages are adjacent; repeated headers and continuation
labels remain exactly as published.

These are deliberately separate artifacts. `broker-source-tables/1.0` keeps
the complete reviewed page/table inventory for validation. The model case
carries only selected metric values, their source-cell mappings and the
hash-bound full-page image inventory used for Bxx presentation. Attachment
ingress verifies every image byte against the extraction artifact root. A
mapped source cell on an `evidence_only` table remains prohibited, but unused
tables never become workbook structure.

The main `Brokers` sheet writes mapped house estimates as blue sealed inputs
with provenance retained in the evidence receipt.
The Operating Model continues to link only to `Brokers`; it must never reference
a raw evidence sheet directly. Evidence sheets are optional for legacy or
synthetic cases with no full-table bundle, in which case the workbook retains
the three core sheets exactly.

The independent OOXML oracle proves the Bxx sheets contain no formulas, their
embedded media hashes equal the sealed page inventory, and no calculation sheet
references Bxx.

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

The deployment host must own these states as a bounded fixed-point loop. It
reads and completes every task packet itself, writes the requested hash-bound
vision response, targeted resolution or semantic crosswalk into the run folder,
and immediately resumes the same controller command. It must not display an
internal task as a user question or stop merely because native, table, OCR and
rendered lanes disagree. A normal readable report reaches the semantic stage;
only corrupt/encrypted/absent/hash-mismatched bytes may become a user input
block. At the semantic stage, preserve every captured row broadly, map model
inputs narrowly, submit the machine-authored proposal to the independent
semantic verifier, repair all reported crosswalk findings together, and resume.
Do not ask the user to hand-author a crosswalk. A material conflict in a cell
actually selected for model use must be resolved or have that mapping removed
before the cell can be quarantined; it blocks broker consumption, not delivery
of the company model. An evidence-only/non-tabular surface or an unused-table
conflict does not interrupt the run.

After the ordinary semantic-repair budget is consumed, the controller may
enter `terminal_materiality_recovery`. This is not an evidence-dropping path.
The model host must write `broker-terminal-materiality-review.json`, bound to
the exact bundle bytes, candidate manifest, source crosswalk and semantic
report. Every reviewed candidate is then preserved with its exact source cells
under `preserve_unconsumed_quarantine` and `model_consumption=prohibited`.
The compiler independently reconstructs cells actually selected by mappings as
well as potential core drivers from immutable labels, forecast-period context
and the canonical broker metric dictionary. An actually selected conflicted
cell cannot be quarantined while it is consumed: remove that mapping and route
the affected model node through the forecast waterfall. A potential Revenue,
EBIT/EBITDA, D&A, tax, capex, working-capital, dividend or buyback candidate is
preserved and explicitly marked unavailable; its label alone does not stop the
company model. Global source-integrity findings still remain internal defects.
No value may be inferred or invented.

Source authority is cell- and period-granular. When one visible row contains
both verified and conflicted cells, the immutable candidate manifest partitions
that row by authority while retaining the same source row and label. The clean
periods remain eligible for review and mapping; the conflicted period alone is
quarantined. A single bad cell must never contaminate clean sibling periods.

Treat a truncated native-text year such as `202` or `203` as an extraction
fragment, not as a disputed economic value and never as a year that may be
completed by guesswork. If the preserved rendered grid shows the full header,
one hash-bound `period_header_adjudication` may transcribe that visible label
and record `rendered_header_review` as the effective header authority while the
raw fragment remains byte-for-byte unchanged. If the read is still unavailable,
quarantine only that period column and continue with its clean sibling columns.
Repeated headers and table continuations across pages inherit periods only
through a source-owned continuation certificate; a page number, narrative year
or nearby table never supplies the missing header.

If a semantic conflict remains in a cell that an active mapping consumes, the
controller first removes every mapping, consensus component and eligibility
claim for the finding-owned house, independently re-runs the semantic verifier,
and resumes with the surviving houses or the ordinary forecast waterfall. This
is a deterministic house-local authority fallback, not deletion: all raw tables
and candidates for the excluded house remain preserved as model-prohibited
evidence. A global integrity finding, an unowned finding or a finding spanning
unidentifiable houses is not eligible for this transition.

Every internal task packet must carry a deterministic task ID, a registered
remedy, a finite attempt budget, a stage-local progress measure, the exact
expected response filename(s), the response-schema hash and an instruction to
reuse valid checkpoints. The response seam is declared by
`assets/broker-model-host-response-boundary-v1.json`. Python may sequence and
validate this seam but may not author a visual transcription, targeted economic
judgment or semantic crosswalk. The model host writes those artifacts; the
controller re-enters them only after their source, image, manifest and schema
bindings pass.

`bounded_capture_adjudication` is not cell-conflict adjudication. Canonical
physical-overlap work may have no conflict manifest and must never invent
`bvc-*` IDs to satisfy the vision-resolution schema. Its exact response is
`<surface>.bounded-capture-decision.json` under
`broker-bounded-capture-decision/1.0`. The decision binds the stable task,
task input, rendered source image and round. It can only bind two genuinely
changed replacement pass files or prohibit the remaining regions from model
use; it cannot carry cells or values. Two accepted rounds exhaust the task and
close unresolved physical overlap through evidence-preserving quarantine.

Progress is monotonic on one source/runtime cache key: full-surface reads may
advance to targeted resolution, then to initial crosswalk, verified crosswalk
and pack. A return to an earlier stage, loss of a passed checkpoint, an
unchanged frontier beyond its retry limit or an exhausted task budget collapses
to exactly one `internal_fixed_point_defect`. That defect remains
`user_blocking=false`; it owns a controller or model-host implementation repair,
not a request to replace unchanged readable research. A successor run must
reuse every unaffected hash-bound checkpoint.

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

The required model-host reader is Rogo. An installed host may additionally use
the provider-neutral `broker_table_engine.py` adapter with a registered optional
Surya or Docling installation. Optional engines are accelerators, not new
authorities: their output is normalized to the same grid contract and still
requires the existing independent dual-read, source-binding, period, unit and
semantic gates. The skill does not bundle their model weights or compiled
dependencies and must continue correctly when neither is installed.

Pass the resulting broker pack, archive bundle, selected-cell crosswalk and
receipt into attachment ingress before compiling the evidence run. Do not
hand-edit `model_case.broker_pack`, `model_case.broker_archive` or
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

Stage 2 is one broker step. It may show one optional, hash-bound confirmation
for the recommended clean coherent house. With no response it accepts that
recommendation automatically; with no clean house it selects the ordinary
forecast waterfall. A malformed or stale optional override is logged and the
deterministic recommendation remains active. Do not expose native extraction,
OCR, vision or reconciliation as separate user stages, and never create a
second broker preview or confirmation round. Quarantine a disputed selected
observation and let that concept/period fall through the waterfall. A conflict
in an unused cell/table, a partial broker or an unselected house cannot stop the
model. Surface one consolidated Stage-3 question only if the complete waterfall
still lacks a material model driver.

Only a genuinely unreadable source boundary — encrypted/corrupt bytes or a
missing immutable object — can request the smallest corrected source, such as
an unprotected PDF or original spreadsheet. A readable low-resolution or
awkward page stays controller-owned: render, crop, recover, adjudicate, then
quarantine locally if still uncertain. Never substitute public consensus for
a missing supplied broker source inside a production evidence run.
