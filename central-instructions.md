# Excel Inflow

## Outcome
Build a formula-driven corporate debt-overlay workbook with exactly **three historical and three forecast years**. The output must follow one of two standardised design profiles: maximal for full debt, lease, RCF, interest and optional acquisition topology; net cash only for a simple opening-net-cash issuer with no more than two instruments and acquisition off.

### Non-bypassable end-user route

An end-user company workbook has exactly one top-level producer. The vNext
candidate uses `scripts/run_excel_inflow_vnext.mjs`; it owns raw evidence,
authority resolution and quality classification, then delegates the unchanged
workbook stage internally to `scripts/run_user_flow.mjs`. That workbook-stage
controller is a package-retained internal delegate, not a second end-user entry
point. Rollback is selected only by a versioned installed-package identity,
never by a hard-coded controller nickname. Never
sequence both routes by hand, and never
construct a workbook directly in chat, with ad-hoc Python/OpenPyXL, from a
compact or generic template, through a lower-level emitter command, or by
patching cells. If the controlled route cannot run, **BLOCK** and preserve the
carrier; a smaller substitute is never a valid fallback.

Attach only the workbook path returned by a final `user-flow-run/1.0` result
whose controller version matches the installed production manifest, whose
terminal internal checkpoint is
`delivery`, status is `PASS_PENDING_MANUAL`, total violations are zero, and
`live_delivery_attestation_sha256` is present. The matching
`live-delivery-attestation/1.0` artifact must be `PASS` and must bind the
workbook, Build receipt, active maximal/net-cash authority, design epoch, A:U
topology and every required sidecar. The delivery screen must visibly show
**BUILD IDENTITY**. Absence of any one of these facts means no workbook may be
delivered.

The package contains the design contract, style tokens and renderer, but no workbook or PNG files. Physical reference workbooks are supplied separately after installation and remain immutable design authorities. An ordinary deployment run never manufactures or depends on a PNG baseline. It proves presentation through authority structure, exact workbook identity where a frozen canary exists, structural rendering of every visible sheet and native Excel review. Pixel baselines remain external local release evidence only; never write them into the skill or repository.

`assets/standardised-design-runtime.v4.json` carries the default portable measured design contract without embedding a physical workbook. Preserve its A:U geometry, section order, control treatment, named expansion zones and profile identity. Company reporting determines rows inside those zones; it never creates a competing layout. `EXCEL_INFLOW_DESIGN_EPOCH=2` and `=3` are explicit rollback routes; any other non-empty value fails closed.

Deliver a model, not a populated form. Totals, ratios, roll-forwards, pro forma outputs and cross-sheet values are formulas. Hardcode only sourced or expressly supplied inputs. Use blue font for hardcodes, black for same-sheet formulas, green for links to another sheet and white for section titles. Grey fill means intentionally not calculated, never zero and never forecast generally.

## Production architecture
Run one deterministic graph:

`normalise evidence -> classify issuer rows -> compile semantic graph -> coverage gate -> solve economics -> compile row plan -> emit -> recalculate -> terminal patch -> verify -> render -> deliver`

### vNext model-first control plane

`scripts/run_excel_inflow_vnext.mjs` is the candidate end-to-end owner above
that proven graph. It invokes the raw filings, broker and DCS transaction,
pauses at the compiled model-decision boundary, seals one model-demand graph,
one `selected-authority-contract/1.0` and one run-constitution graph, and only
then delegates the unchanged workbook stage to `run_user_flow.mjs`. The
workbook-stage controller remains package-retained for compatibility; it is not
rewritten or removed during candidate certification and it is never itself a
product-version or installation selector.

The selected-authority contract is the executable evidence resolver and the
sole upstream forecast writer. It is compiled from the complete candidate
ledger, then projects the sealed forecast plan into the model case; a plan
authored or changed elsewhere cannot write workbook economics. The joined
run-constitution graph carries source-to-observation-to-authority reachability,
quarantines, blocker ownership and a quality receipt. Large source tables and
PDFs remain in the run store and are referenced by hash rather than copied into
the case. Filings own historical statements, DCS owns contractual debt
hardcodes and broker research contributes only verified model-driving forecast
cells.

The model is built by default. Optional evidence uncertainty reduces authority
through the declared forecast waterfall and produces `DEGRADED`; it does not
stop delivery. A user interruption is permitted only when a material economic
node remains unresolved after the complete waterfall. Internal work is hidden
and resumable. A terminal block is limited to a fatal source/identity/opening-
debt boundary, an underdetermined economic graph, or workbook integrity.

The ordinary candidate command is:

```text
node scripts/run_excel_inflow_vnext.mjs \
  --attachment-spec <attachment-evidence-controller.json> \
  --out <run-folder> [--answers <answers.json>] \
  [--python <python>] [--soffice <soffice>] \
  [--runtime-budget <budget-overrides.json>]
```

The controller enforces a versioned runtime-budget policy rather than one
hour-long catch-all timeout. Defaults are two minutes for source acquisition,
eight minutes for filing extraction, two minutes per broker document, three
minutes per bounded broker semantic frontier, twelve minutes for all optional
broker work, ninety seconds for case compilation and ownership, two minutes
for the solver, three minutes for workbook construction, four minutes for
recalculation and three minutes for validation. The ordinary end-to-end target
is fifteen minutes and the hard ceiling is twenty-five minutes. A JSON object
of millisecond overrides may be supplied with `--runtime-budget`, but it must
retain a 20–30 second heartbeat, a target no greater than the hard ceiling and
an ownership-resolution bound no greater than two minutes.

An optional broker timeout preserves all captured evidence and checkpoints,
terminates the complete descendant process tree, and continues through the
declared partial/zero-broker authority waterfall without restarting or asking
for a re-upload. An ownership-preflight failure cancels unnecessary descendants,
preserves the sealed checkpoint, resolves the topology and resumes downstream;
it never reruns optional broker work whose target has disappeared. Every
long-running activity reports stage, documents complete/total, elapsed time and
`Action required: No` at least every thirty seconds. The controller emits a
hash-bound runtime-budget receipt beside its progress and performance receipts.

For a read-only inspection or fixture that already has a sealed evidence run,
compile the same cross-lane resolution artifact directly with:

```text
node scripts/compile_evidence_resolution_v2.mjs <evidence-run.json> \
  [--forecast-plan <forecast-plan.json>] \
  [--attachment-state <attachment-state.json>] \
  [--case-report <case-compile-report.json>] \
  --out <evidence-resolution-v2.json>
```

The source-owned contract and adversarial test is runnable as:

```text
node scripts/run_evidence_resolution_v2_tests.mjs
```

The standalone `evidence-resolution/2.0` compiler is a read-only audit
projection over sealed inputs. It cannot replace the executable
`selected-authority-contract/1.0` resolver in a company run, and its output
cannot become a second workbook writer.

`PASS_PENDING_MANUAL` may carry quality `VERIFIED` or `DEGRADED`. Both require
zero workbook violations; degraded means only that optional evidence was
quarantined or a lower, disclosed authority rung was selected. No degraded path
may invent a value.

The semantic graph is canonical; physical row numbers are compiled output. Preserve the issuer label, attach a semantic role and evidence class, and route unmatched material rows to one targeted question or a fail-closed stop. Never solve from workbook coordinates or add a cell-specific exception.

Compile the statement-topology subgraph before allocating physical rows. Its
visible-successor edges preserve face-statement order and its parent edges own
contiguous collapsible families. Never build a generic short statement and
append remaining issuer rows afterwards. A source-order inversion, duplicate
visible authority, orphan numeric row, child before its parent or
non-contiguous family blocks before emission.

The semantic graph also carries one resolved forecast authority for each row
and forecast period.  Formula identities and schedule-owned rows resolve before
the independent-input evidence waterfall.  A first forecast year may be
reported-to-date actual plus a forecast remainder while later years use broker,
guidance or visible driver paths.  The compiler must distinguish a formula, a
cross-sheet broker link, a visible hardcode, a formula-driven zero and an
intentional grey blank.  An unresolved material forecast path blocks; it never
falls through to `=0`.

For a production evidence run, set
`statement_authority_contract_version=authority_v1`. Every visible non-header
statement row must declare one historical authority: `source_input`,
`derived_formula`, `reported_total_reconciled`, `schedule_link` or
`not_applicable`. When a filed subtotal and its visible components are both
shown, emit the subtotal as a formula, retain the filed value in
`reported_historical_values`, and prove the reconciliation. Never turn a
derived total into a blue hardcode merely because the filing printed it.
The same production run must set
`forecast_authority_contract_version=waterfall_v1`; legacy implicit zeros or
unexplained grey forecast cells are forbidden. Every material historical line
must either have its own executable forecast path or be a declared child of a
visible parent whose forecast captures it in the same period.

The Model Decisions milestone always emits the material forecast plan before
Build. For each
independent row and forecast period it states the method, selected value and
source or parent capture. Totals, ratios and schedule links are not forecast
judgements and remain formula driven. A production build may not enter the
renderer as a legacy case merely because a caller bypassed the user-flow
screen; the solver independently requires `production_model`, `evidence_v1`,
`authority_v1` and `waterfall_v1`.

Every instrument also declares `balance_basis`. Keep legal denomination in
`currency`, but set `native_principal` only when the supplied balance and
principal movements are genuinely native-currency amounts. Use
`reporting_currency_carrying_value` for a debt-export carrying value already
translated into the issuer's reporting currency. The latter must never pass
through FX again; a placeholder 1.0 curve is not an acceptable workaround.
On the workbook face, preserve legal denomination separately from the amount
basis and label the amount column generically. Every instrument amount must
state whether it is native principal, reporting-currency carrying value or
facility capacity; never describe a reporting-currency carrying value as
foreign-currency nominal merely because the instrument is legally denominated
in that foreign currency.

The portable controller owns the stage order and module registry. Each module declares inputs, outputs, invariants and allowed remedies. A stage may not silently skip, widen a tolerance, change a validator or infer a material missing term. Convergence must be declared before solving; non-convergence is a failure.

Read only the reference needed for the current stage:

- `model-contract.md` for horizon, signs, column blocks and statement topology;
- `calculation-rules.md` for debt, interest, lease, cash, RCF and leverage equations;
- `forecast-and-input-policy.md` for broker anchors, historical provenance and forecast hierarchy;
- `acquisition.md` for the lightweight overlay;
- `advanced-history-and-fx.md` for predecessor, calendarisation, restatement and FX cases;
- `template-and-formatting.md` for the standardised presentation contract;
- `validation.md` before interpreting or reporting a validation result.

## Scope
Always include visible controls, company-specific income-statement and cash-flow rows required by the debt overlay, adjusted EBITDA, free cash flow, instrument-level debt, RCF liquidity, interest, leases when relevant, leverage and an optional lightweight acquisition case.

Use exactly three historical periods and three forecast periods. Do not add ratings analysis, a full balance sheet, a central checks sheet, detailed working-capital schedules, a central source register, debt-issuance-cost roll-forwards or target net debt for acquisitions.

The model is flexible in semantic rows and instrument count, not in presentation grammar. It may handle IFRS or US GAAP labels, net cash or levered issuers, fixed or floating debt, multi-currency instruments, predecessor combinations, calendarisation, restatements, large cash-flow statements, unusual working-capital splits, unusual debt cash-flow splits and RCF capacity stress.

## User flow and evidence
### Ordinary chat invocation

**Strict fresh-chat isolation.** On an exact bare `run excel inflow` request,
the only admissible input is the text and attachments in that current user
message in that current chat. A company name, attachment, project file, saved
memory, prior chat, recent upload, run carrier or earlier run state is not a
current input and must not be inferred or consumed. Emit the canonical Company
screen and end the turn immediately. Do not advance company selection, retrieve
filings, inspect attachments or resume a carrier in the same turn. Only a later
user message in this chat, sent after the Company screen, may supply the company
or authorize a resume. If the invocation itself also names a company or carries
attachments, still show the Company screen and end the turn before processing
them.

On the exact bare request `run excel inflow`, and on any equivalent request to
start a new model, invoke the canonical production controller before asking a
question:

```text
node scripts/run_excel_inflow_vnext.mjs --screen company
```

That command's stdout IS a fenced code block (it begins with ```text and ends
with ```). Return it verbatim and whole as the first visible response — the
fence included — so the screen renders in monospace. Never retype it, restyle
it as Markdown headings, or replace it with a conversational company/ticker
question. If the command cannot be executed in this runtime, reproduce the
canonical screen below EXACTLY, fence and all:

```text
+=[ EXCEL INFLOW ]==============================[ COMPANY ]=+
|
|  [>]Company  [ ]Filings  [ ]Brokers
|  [ ]Debt  [ ]Build  [ ]Deliver
|
|  DEBT OVERLAY
|  Debt, leverage and liquidity - fully formula-driven.
|  Three years back, three years forward. Every figure
|  traces to its source.
|
|  Name the company. Nothing else is needed yet.
|
|  Filings ............ pulled for you where the runtime
|                       has access; attach 3 full years
|                       to override
|  Broker research .... requested at Brokers
|  FactSet export ..... requested at Debt
|
|  Attach everything now if you prefer - the flow then
|  stops only for a genuine model decision, if one remains.
|
|  Currency, fiscal calendar and periods follow the
|  company. You will not be asked to confirm them.
+--[ REPLY ]-------------------------------------------------
|
|     > company name (e.g. AstraZeneca)
|
+============================================================
```

This entry rule still applies when the request already names the company or
includes attachments; the supplied information is consumed after the canonical
screen is shown.

The entry screen asks for the COMPANY ONLY. Filings use an explicit source mode. `internal` is the production default: Rogo/runtime-library/public-filings sourcing owns the filing set. `user_supplied` is an intentional override only when the user explicitly directs the run to use supplied filings. `internal_fallback` records a user-supplied fallback plus the failed internal-source reason. Never silently merge internal and user-supplied filing sets. A company whose mandatory filings cannot be sourced under the selected mode blocks at intake. Broker research is optional, but the Brokers
milestone is not optional: it must close through either 1-10 supplied reports
or the exact recorded choice `continue without brokers`. Zero attachments,
silence, a missing picker or an unavailable research library never implies
skip. The FactSet debt export - date toggle at LAST FISCAL
YEAR END - at Debt. A user who attaches everything up front takes the fast
path: the flow then stops only for a genuine model decision, if one remains.

After filings close, invoke the installed Brokers checkpoint before requesting
the FactSet export:

```text
node scripts/run_broker_intake.mjs <broker-intake-request.json> --out <run-folder>/broker-intake
```

With no attachments and no exact skip phrase, the command returns
`ACTION_REQUIRED`, writes no choice receipt and its canonical screen is the
entire visible reply. With 1-10 attachments it verifies and hashes every file,
mints `broker-intake-choice/1.0` with `intake_state=supplied`, and broker
processing proceeds internally. With the exact phrase it mints
`intake_state=explicitly_skipped` and `authority_state=zero`, then advances to
Debt. The attachment controller and run carrier independently revalidate and
retain that receipt. They refuse a broker lane without a supplied receipt, a
skip receipt beside broker files, changed attachment bytes, another run ID or
an implicit legacy skip. Broker extraction, OCR, reconciliation, house
selection and fallback remain one internal non-blocking step after upload; do
not introduce a second preview or confirmation interaction.

The bare trigger is presentation-only. Do not certify the installed release,
inspect package bytes, emit progress prose, search for tools, read evidence or
perform any other work before returning the Company screen. Deployment
certification belongs to the versioned installation transaction, never to an
ordinary end-user invocation. After the Company screen is visible, later
milestones may perform their declared checks and persist their normal receipts.

The entry screen collects the company only; the remaining pack arrives at its own stage as the screen states. Under `source_mode=internal`, AUTO-PULL the last three full-year filings for the resolved issuer and record the selected filing identities on the intake receipt. Under `source_mode=user_supplied`, use only the explicitly selected user filing set. Under `source_mode=internal_fallback`, use the declared fallback set and preserve the internal-source failure reason. User attachments do not override internally sourced filings merely by existing. A prior
case file and known transaction assumptions are optional. Resolve fiscal year
end, reporting currency, units and period range from the filings; never ask the
user to confirm them. For autonomous testing, use only UK- or Irish-listed
issuers whose public disclosures contain enough debt detail, and use indicative
broker forecasts rather than presenting them as sourced research.

deployment host reads the supplied files and the required public company documents, then
creates one `evidence-run/1.0` envelope under
`assets/evidence-run-v1.schema.json`. Deterministic code validates that envelope
before the question flow can start. Normalise the broker pack and debt export
into their schemas before modelling. Reconcile entity, date and gross debt to
audited filings. Use this evidence waterfall for current facts: latest audited
filing; later interim or trading update; debt note and maturity table; facility
or bond documents; company transaction announcement; supplied debt export;
supplied broker pack; explicit user answer. Preserve source dates for company
facts. Market curves do not need source dates in the workbook.

Before taxonomy or normalization, create one independent
`face-statement-manifest/1.0` for every selected income statement and cash-flow
statement. Bind it to the raw filing SHA-256, preserve every row in source order
with its raw label, three historical values, page and hierarchy, and hash the
ordered rows. The extracted filing ledger and source coverage must each match
that manifest exactly in both membership and order. Every included line must
also have a visible issuer-labelled statement row carrying its source-line ID;
an aggregate may have a visible formula parent, but it may not replace its
children with a generic row. A missing manifest, omitted line, reordered line,
cross-statement line or aggregate without child lineage blocks before the case
enters the semantic graph.

Where the runtime can access the attachments, compile that envelope from an
`attachment-ingress/1.0` spec first:

```text
node scripts/compile_evidence_run.mjs <attachment-ingress.json> --out <run-folder>
```

This writes a raw-byte-hash-bound attachment manifest and evidence run. Pass the
resulting `<run-folder>/evidence-run.json` to the resumable production shell;
do not handcraft hashes or treat normalized JSON as proof of the original file.

Restated figures replace superseded comparatives only when the filing clearly states the restated basis. Preserve predecessor history and calendarise only with an explicit bridge. Never splice differently scoped periods without a visible reconciliation.

At the broker checkpoint, compile one internal receipt from the SEALED pack.
Accept the recommended clean coherent house automatically, or select the
ordinary forecast waterfall when no coherent house exists. Keep exact selected
source cells, alternates and the complete evidence inventory in artifacts, not
as multiple chat stages. An explicit override may choose only another clean
house and can never waive a selected-cell conflict.

Decisions are collected on native question cards: the ASCII screen is the
receipt, the cards are the instrument. One checkpoint's cards form one
contiguous round (batches of at most four, two to six options each, the
default marked in its label). "Skip" records the marked default as a decision.
Checkpoint confirmations are cards too. Every card answer lands in
`case-source.answers` under its stable question id; the compiler refuses a
declaration pointing at an answer that was never recorded.

Ask at most five targeted questions in one decision round after deterministic
pruning. Ask only for material facts that change debt, liquidity, interest,
leverage or acquisition outputs and cannot be resolved from supplied evidence.
Typical questions cover an unreconciled debt residual, unknown fixed/floating
terms, missing RCF capacity or drawn amount, unclear cash eligibility, lease
mode, refinancing treatment or transaction timing. If more than five genuine
decisions survive, persist the answers and present the next deterministic round;
question cardinality alone is never evidence that the source pack is defective.

The visible run has exactly one six-milestone journey:

1. `COMPANY`;
2. `FILINGS`;
3. `BROKERS`;
4. `DEBT`;
5. `BUILD`; and
6. `DELIVER`.

The controller may retain its five internal receipt stages, but their numbers
are machine metadata and never appear as a competing user-visible scale.
Evidence review is shown as `PROGRESS: 4 OF 6 COMPLETE - BUILD NEXT` with
`CHECKPOINT: INPUT PACK REVIEW`; it never carries an internal stage number.

Use plain ASCII status screens no wider than 61 columns or 70 lines. Return each
screen as exactly one fenced `text` block so spacing survives the chat renderer.
Every screen states progress on the six-milestone journey, its checkpoint,
status and one unambiguous next action when user action is required. A screen
that says no response is required must continue automatically and may not also
show a reply action. Internal work is never a user-visible terminal screen. Do
not expose raw logs, stack traces or internal file machinery. Preserve full
detail in the stage artifact when the screen is a summary. Return controller
screen output verbatim and whole; never hand-compose, merge or relabel progress
in chat. Count labels must name their source lane explicitly: for example,
`FactSet debt-export rows` and `FactSet populated cells`, never the ambiguous
`Source rows preserved`.

Every internal checkpoint writes a small hash-bound receipt containing run ID,
controller version, checkpoint ID, input and output hashes, prior-receipt hash,
status and next stage. Only a verified `success` receipt is resumable. A stale,
foreign, failed, blocked or tampered receipt never skips work. State travels in
the receipts and case files, never in chat history.

The Build milestone has thirteen silent leaf checkpoints: semantic gates; plan; emit;
LibreOffice recalculation; terminal patch; dynamic, style, cache, finance and
semantic verification; verification aggregation; structural render; and
publication. They do not create additional user messages. Each checkpoint
stores a separate atomic success receipt and is reusable only when its recipe,
named input hashes and exact output hashes still agree. A killed invocation
therefore restarts at the first incomplete or invalid checkpoint in the same
chat instead of repeating the entire workbook build. No checkpoint is assumed
to survive across chats.

Invalidate from the earliest affected user milestone: a new filing, debt export,
broker pack or prior case restarts evidence review; a changed answer,
assumption or transaction input restarts build and checks; a formatting-only
change restarts rendering and visual checks inside Build; delivery wording
alone restarts Deliver. Internal graph hashes continue to reuse unaffected work
inside the selected milestone.

After answers, record them in `case-source.answers` and recompile; the model
case is regenerated, never edited. Do not patch a workbook. Before delivery,
give a concise read of the selected profile, broker anchor, opening debt/cash
reconciliation, forecast leverage direction, liquidity headroom and any
remaining explicit limitation.

### Autonomous public-company test route

This route exists only for local product testing when no supplied FactSet export
or licensed broker pack is being used. It is not a relaxed production mode.

- Use `assets/public-test-run-v1.schema.json` through the public-test compiler,
  never `evidence-run/1.0`.
- Use public issuer filings, debt notes, facility documents and transaction
  announcements for historical and instrument facts. Every debt instrument and
  term cites at least one used public-company source.
- Use 3–10 clearly named indicative houses and retain a source label beginning
  `SYNTHETIC TEST DATA`. Synthetic forecasts never support a debt fact.
- Preserve the real issuer name, reporting basis and statement topology, but
  retain `promotion_status: TEST_ONLY_NOT_PRODUCTION_EVIDENCE` and
  `production_eligible: false` in the test receipt.
- If public disclosures do not resolve a material balance, maturity, rate,
  currency, RCF capacity or drawn amount, the test blocks. It does not create a
  FactSet-looking fixture, invent a residual term or ask the user to treat test
  data as production evidence.

Compile the hash-bound TEST_ONLY envelope with:

```text
node scripts/compile_public_test_run.mjs <source-spec.json> --out <folder>
```

The public-test validator may hand its case to the same graph, solver and
renderer so the product is exercised end to end. Its receipt can never be used
as the production evidence-run receipt required for delivery.

When raw broker documents are supplied, preserve the complete extracted tables
before normalising model metrics. Run the hash-bound resumable broker
controller outside the immutable skill tree:

```text
python3 scripts/run_broker_pipeline.py <broker-extraction-request.json> --out <run-folder>/broker [--responses <responses-folder>] [--crosswalk <broker-crosswalk.json>]
```

The controller owns the component sequence, immutable-source/runtime cache key,
checkpoint validation and resume. Never recreate that sequence in chat logic.
Its internal `NEEDS_*` states are not user blockers. Ordinary readable PDFs
must be exhausted through native lanes, 300-DPI-or-better table crops, two
independent structured reads and one bounded cell adjudication before any cell
is quarantined.

Treat the broker state as a sealed append-only work graph, not a linear stage
cursor. Checkpoints, internal tasks and accepted execution receipts are
immutable graph nodes; only the current task frontier changes. A later
canonical or semantic pass may lawfully discover new vision work after
resolution or crosswalk work, and that is an appended obligation rather than a
stage regression. Every task names its deterministic remedy, response
contract, exact output filename and finite execution budget. Polling or
re-presenting identical response bytes consumes no attempt; only a new,
hash-bound model-host execution receipt tied to the stable task id does. The
model host authors visual or semantic responses; Python sequences and verifies
them. Resume the same controller after each response and reuse every valid
checkpoint. Never present `NEEDS_VISION`, `NEEDS_RESOLUTION`,
`NEEDS_CROSSWALK` or `NEEDS_CROSSWALK_REVIEW` as an end-user question.

Exhausted ordinary evidence ambiguity never terminates the run. Once the
bounded recovery budget is spent (vision attempts, fixed-point retries or an
aggregate internal defect), the controller closes the physical lane itself as
`PASS_DEGRADED`: the smallest defensible regions are quarantined
`model_use=prohibited`, every raw report stays preserved verbatim, quarantine
counts are disclosed in the state summary, and the run continues to Debt,
Build and Delivery on the surviving broker authority (down to
FORECAST_WATERFALL with zero broker consumption). `BLOCKED_INTERNAL` remains
only for genuine controller corruption or tampered artifacts — never for
readable research that would not reconcile.

A truncated native period token is ordinary evidence ambiguity. Prefer the
complete period label visibly transcribed from the hash-bound rendered grid;
otherwise prohibit only that column. Preserve multi-page tables through an
explicit continuation certificate so a header on the first page owns the
continuation pages without being guessed again. If a remaining semantic defect
belongs to a house whose selected mapping consumes the affected cell, remove
that house from model authority, retain all of its evidence, independently
reverify the pruned crosswalk, and continue through the forecast waterfall. The
company model must not stop merely because a broker house becomes unusable.

A sealed broker run may cross an intentional controller upgrade without losing
its receipted progress or its exhaustion history. Migrate — never resume
blind — with the fail-closed migration tool, pinning the exact prior runtime
closure digest recorded in the run's `broker-run-state.json`:

```text
python3 scripts/migrate_broker_run_state.py <broker-extraction-request.json> --state <run-folder>/broker/broker-run-state.json --out <run-folder>/broker --from-closure <prior-runtime-closure-sha256>
```

The tool refuses on any request, source-hash, receipt or vintage mismatch,
re-homes only receipt-verified checkpoints, writes a migration receipt beside
the state, and never asks the user to re-upload unchanged sources.

Do not force the complete broker-page inventory into model authority. Raw
files, page renders and capture ledgers remain lossless run artifacts.
Attachment ingress projects page images and raw-document custody into the
separate `broker_archive` lane; only selected-cell mappings and values enter
`broker_pack`. Archive-only material needs no semantic pack. Every supplied
house remains represented in the archive, while every mapped model cell lands
on a selected analytical table with exact cell provenance.

The extractor captures native text, geometry, tables, workbook cells and
images. Image-only surfaces remain unresolved until the vision command proves
two independent hash-bound economic cell transcriptions agree or records one
conflict-manifest-bound targeted resolution. A `NEEDS_RESOLUTION` result is an
internal Stage-2 checkpoint: resolve it once before any user-facing stop.
Structural differences with identical economic observations do not block;
unresolved economic cells become quarantined evidence. The pack compiler
accepts only reviewed, cell-addressed mappings. Before it can pass, every
selected candidate cell has one reasoned semantic disposition; unused rows,
tables and pages remain archive-only. A missing selected mapping removes that
authority edge. Coverage count alone is
not enough: the semantic-quality gate also rejects numeric rows called unusable,
model-relevant rows discarded as irrelevant, non-equivalent duplicates,
broker-derived values described as company guidance, incompatible definition
collisions and unowned derivations. Full unused source tables, guidance,
broker-derived and partial-period evidence, distinct metric definitions and
supplemental checks remain evidence rather than disappearing or being forced
into annual consensus.

Compile the filings-derived model-demand and material-output-reachability graph
before broker semantics. Archive every raw broker file and render every page,
but create OCR/vision work only for selected candidate cells that can satisfy a
demanded concept-period. Open at most one deterministic coherent-house recovery
frontier; other reports remain archived and do not multiply optional OCR work.
Retries are bounded and cell-local. If recovery does not yield one coherent
house, close at zero broker authority and continue. Archive-only files require
no semantic pack.

Reusable broker metric ids remain dictionary-owned. A genuinely
company-specific concept may use the `run.*` namespace only with a reviewed,
hash-bound `run-scoped-broker-concept/1.0` contract covering definition,
unit/sign, materiality, forecast behavior, parent/placement, additive status,
double-count proof and row relation. Active authority may bind only an existing
company row established upstream. A new broker-only row is permitted solely as
non-additive `reference_only` evidence; filings must establish new additive
economics first.

Keep the central `Brokers` sheet compact: selected values, periods, house,
definition and cell-level provenance only. `B01`-`B10` are screenshot-only
evidence sheets with full pages arranged horizontally in source order. They
contain no formulas or reconstructed tables, and no calculation sheet may
reference them.

Derive broker-house eligibility after the cell ledger closes. A complete
primary-eligible house may support the model even if other supplied houses are
partial or contain quarantined cells. Keep the chosen house coherent; another
house is an alternate authority, never proof that a disputed cell in the first
house said the same thing. Use the recommended complete house when the user did
not choose one. Ask only if no complete house or later forecast-waterfall route
can supply a material concept.

When a raw DCS export is supplied, preserve its entire source-owned row and cell
universe before projecting instruments. Run the lossless lane outside the
immutable skill tree:

```text
python3 scripts/extract_dcs_evidence.py <dcs-extraction-request.json> --out <run-folder>/dcs-extract
python3 scripts/compile_dcs_evidence.py <dcs-source-tables.json> <dcs-candidate-manifest.json> <dcs-crosswalk.json> --out <run-folder>/dcs
python3 scripts/verify/dcs_evidence_oracle.py --source <dcs-source-tables.json> --manifest <dcs-candidate-manifest.json> --crosswalk <dcs-crosswalk.json> --projection <dcs-projection.json> --receipt <dcs-evidence-receipt.json> --out <dcs-independent-verification.json>
```

The crosswalk must disposition every captured row and cell exactly once and
bind every model-driving instrument term to source cells or a visible reviewed
supplement. The compiler receipt and independent oracle must both be PASS with
zero violations. Preserve zero-balance commercial paper and undrawn RCFs, and
retain issue date, price, YTW and OAS as audit evidence even when they do not
drive the model. Month and year maturities remain visibly non-exact while the
annual model uses a declared month-end or year-end timing convention. The
projected day is a modelling convention, not source precision; an unresolved
bucket still blocks. Keep the raw DCS and its ledgers outside the workbook and
write selected terms as visible blue debt-schedule hardcodes.

The resumable production shell handles all five user-facing stages. Run the
same command again after supplying answers or after an interruption; it verifies
the input and output hashes on each receipt, reuses every unchanged successful
stage and restarts only at the earliest affected stage:

```text
node scripts/run_user_flow.mjs <evidence-run.json> --out <run-folder> \
  [--answers <answers.txt|json>] [--python <python>] [--soffice <path>] \
  [--workspace-token <token>] [--json]
```

The shell writes a compact `run-carrier.json` beside the run evidence at every
normal pause and delivery boundary. A fresh chat resumes from files, never chat
memory, by reattaching that carrier and using the same workspace/session token:

```text
node scripts/run_user_flow.mjs --carrier <run-folder>/run-carrier.json \
  --out <same-run-folder> --workspace-token <same-token> \
  [--answers <answers.txt|json>] [--python <python>] [--soffice <path>] \
  [--json]
```

When an older carrier must cross a controller or installation identity
boundary, migrate it explicitly; never weaken ordinary carrier verification:

```text
node scripts/migrate_run_carrier.mjs <run-folder>/run-carrier.json \
  --run-root <run-folder> --out <run-folder>/identity-migration-receipt.json \
  --workspace-token <same-token>
```

The carrier contains only run-relative paths and exact hashes. It is bound to
the immutable run identity, issuer, controller and workspace/session token;
absolute paths, traversal, symlink escapes, changed bytes or a different token
fail closed. `action_required` is never reusable as success. Receipts bind each
stage to its own relevant runtime subset, so a delivery-wording change does not
rebuild a workbook and a formatting change does not repeat evidence review.
Changed evidence or answers still invalidate the earliest economically affected
stage and every dependent stage. The lower-level commands remain fixtures and
diagnostics only:

```text
node scripts/flow_cli.mjs welcome
node scripts/flow_cli.mjs start <evidence-run.json> --out <intake-result.json>
node scripts/flow_cli.mjs answer-run <evidence-run.json> <answers.txt> --case-out <answered-case.json> --out <answer-result.json>
node scripts/flow_cli.mjs deliver <answered-case.json> --out <delivery-result.json>
```

## Build rules
Select the profile from the normalised case. Net cash requires opening debt plus lease liabilities less eligible cash below zero, no more than two instruments and acquisition off; otherwise use maximal. Expand semantic rows only inside the selected profile's zones.

Use issuer-reported rows where material. Preserve unusual impairment, restructuring, pension, working-capital, tax, investing and financing lines rather than forcing generic labels. A cash-flow impairment reversal is distinct from an income-statement impairment charge even when wording overlaps. Aggregate detailed working-capital and debt cash-flow components into visible parent rows only when every child remains represented in the semantic graph and the parent formula closes.

For every debt instrument show the opening and ending balance and every sourced
issuance, scheduled-amortisation, acquisition, FX or other non-cash movement
needed to explain that path. Automatic contractual maturity repayment is
calculated inside the visible balance formula and summed into one visible
mandatory-repayment answer; do not repeat a technical helper line beneath every
instrument. Cash repayment and FX translation are separate. A non-amortising
instrument remains flat until maturity absent another sourced movement.
Optional sourced forecast ending balances corroborate this formula path; they
never replace it, and any divergence blocks. Maturity roll and refinancing
intent remain economically distinct.

Calculate fixed and floating interest from average balances, with explicit period fractions for material mid-year maturity or closing timing. Floating rates equal the relevant curve plus margin. RCF interest uses average drawn balance. Commitment fee uses average undrawn committed capacity and its own fee rate, not the RCF margin. Other interest must be a visible, documented plug if used. Forecast **interest income** from average eligible cash and a visible yield; never hold it flat by default. When reliable instrument or RCF pricing is unavailable, retain its debt and liquidity mechanics, classify it `unpriced`, leave the rate cells intentionally blank and capture only the residual required to reconcile the selected total-interest authority through `Other / unallocated interest`; never create a sourced 0% rate.

Resolve cash by semantic basis, not by one overloaded number. Cash-flow rows use
the buckets marked as cash-flow cash, the RCF waterfall uses only the balancing
liquidity bucket, interest uses interest-eligible cash, and net debt uses
net-debt-eligible cash. When a debt balance is netted from cash-flow-statement
cash but shown separately in gross debt, use `linked_debt_addback` with explicit
instrument IDs. The runtime must derive that bucket from those instruments in
every forecast and reject missing, duplicated, RCF, non-gross-debt or
non-net-debt links, non-zero yield, liquidity inclusion, stale opening balances
and independent forecast values.

**RCF is the only balancing liquidity source.** Specifically, the balancing facility is the RCF named by `rcf_policy.instrument_id`. Draw only to restore minimum cash, capped by remaining capacity. Repay only from surplus cash, capped by opening drawn balance. Other revolving or bilateral facilities may coexist, but they are ordinary instrument-level debt and never join the balancing waterfall. Keep residual shortfall visible when capacity is exhausted. The circularity control is a kill switch for all forecast interest calculations; it does not switch off the RCF waterfall. Circularity, maturity roll and acquisition controls store numeric 0/1 and display Off/On through formatting.

Keep total lease liability and any separately supplied interest-bearing lease balance visible. Use a sourced closing-balance path, a simple roll-forward or an explicit **Flat replacement** assumption where principal repayments are replenished by replacement additions. For US GAAP, require an explicit interest basis so operating lease cost is not counted again as interest. Apply the selected lease basis consistently to debt, cash flow, interest and leverage.

The acquisition overlay uses enterprise value and entry EV/EBITDA to infer target EBITDA, plus a separately supplied absolute acquisition-debt amount, rate, close year and close month. It has no sources-and-uses, equity funding residual or EV-minus-debt RCF funding. Infer only approved operating metrics from visible ratios. Recompute pro forma amounts and ratios; never add ratios. Each adjustment is `pro forma - standalone`, so unchanged standalone debt, maturity, lease and cash-sweep legs cancel from the adjustment.

For an ordinary production run, invoke only the resumable production shell
shown under *User flow and evidence*. Its Build milestone owns the semantic gates,
solver, plan, renderer, recalculation, terminal patch, independent per-run
validation and structural render. Do not invoke the lower-level build commands
or validators separately around it; that repeats work without strengthening the
company-run evidence.

The following lower-level build commands are diagnostics for a targeted repair
or an explicitly isolated build-path investigation only:

```text
node scripts/debt-model-economics.mjs validate-case <case.json>
node scripts/build_dynamic_model.mjs <case.json> --plan-only --out <workbook.xlsx>
python3 scripts/emit/__main__.py validate <workbook.xlsx>.plan.json
python3 scripts/emit/__main__.py build <workbook.xlsx>.plan.json --out <workbook.xlsx>
node scripts/inspect_workbook_semantics.mjs <workbook.xlsx> --out <inventory.json>
python3 scripts/prepare_local_workbook_review.py <workbook.xlsx> --out <review-folder> [--soffice <path>]
node scripts/validate_local_workbook_review.mjs <review-folder>/local-workbook-review-evidence.json
```

The plan must report zero unresolved caches. Recalculate in an isolated LibreOffice profile, then apply only the declared terminal patch. Do not treat LibreOffice as the authority for circularity restoration or Excel rendering.

The model case is COMPILED, never written. Model Decisions authors exactly one
artifact: `case-source.json` under `assets/case-source.schema.json` —
declarations only; the schema cannot express economic values or formula text,
so transcription mistakes are structurally unwritable. The compiler projects
every fact from the sealed evidence lanes and mints every rule through the
doctrine libraries, then reports ALL findings at once or emits the case:

```
node scripts/compile_case.mjs <case-source.json> <evidence.json> --out <model-case.json>
```

There is no partial success and no second repair verb: a finding is fixed by
amending the named declaration or answering the named question, then
recompiling. Point-editing `model-case.json` is a doctrine violation and trips
the stage-carrier hash check — the build refuses a case whose bytes are not
the compiler's. A clean compile passes silently through the CASE COMPILED
screen; a dirty one stops once at the COMPILE FINDINGS screen with the
complete list, nothing serial.

## Validation and certification
Every gate fails closed. A missing dependency, absent sidecar, unresolvable row, formula error, external link, non-zero acyclic cache disagreement, unsupported function, failed conversion, missing required evidence or unreviewed native Excel control is a failure or `BLOCKED`, never a warning or pass. A pixel baseline is required only by an explicitly invoked exact-pixel release replay; it is not required by an ordinary structural company render.

An ordinary production company run invokes only `scripts/run_excel_inflow_vnext.mjs`.
The Build milestone already runs the required per-run gates and returns their hash-bound
evidence. During an ordinary company run, do **not** run mutation suites, exact
authority replays, double-build determinism, render self-tests or any package,
installation or promotion procedure.

The standalone commands below are available only for read-only diagnosis, a
targeted source repair, frozen-cohort work or explicit release certification.
Select only the command required by that mode; this is a catalogue, not an
ordinary-run sequence:

The runtime gate list is executable policy in
`assets/delivery-constitution-v1.json`: identity/period/unit closure, mandatory
filings and debt, selected-cell provenance, forecast reachability, equation
determinacy and convergence, debt/cash/RCF/interest identities, OOXML/cache
integrity and basic structural render. Release certification is a separate
superset over frozen cohorts and installed packages. Unused broker enrichment,
pixel baselines, full mutation cohorts and installation/native-Excel checks may
fail a release candidate, but they are never injected into a live company run
and cannot convert optional broker evidence into a delivery blocker.

Do not create a pixel baseline from an attached raw authority workbook in the
deployment host. The raw workbook has no semantic row-map sidecar and may carry
a different producer row model; treating its pagination as the shipping
baseline is invalid. Physical authorities are instead checked against the
portable design contract and the frozen canary structure. Exact pixel evidence,
when required for local release certification, comes from the frozen shipping-
path replay and an independently approved external baseline epoch.

```text
node scripts/orchestrate_release.mjs <case.json> --out <run-folder> [--dcs-export <json>] [--broker-pack <json>] [--filings <json>] [--soffice <path>] [--json]
node scripts/run_statement_classifier_tests.mjs <representative-v2-case.json>
node scripts/run_forecast_observation_tests.mjs
node scripts/run_forecast_behavior_tests.mjs
node scripts/run_product_constitution_tests.mjs
node scripts/run_run_constitution_graph_tests.mjs
node scripts/run_delivery_constitution_tests.mjs
node scripts/run_controller_exit_inventory_tests.mjs
node scripts/run_broker_dynamic_concept_tests.mjs
node scripts/run_broker_exit_fault_injection_tests.mjs
node scripts/run_universal_broker_delivery_matrix.mjs <degraded-delivery-report.json> <usable-broker-workbook.xlsx>
node scripts/run_raw_input_black_box_canary.mjs <raw-canary-evidence.json> <python> <soffice>
node scripts/run_equation_graph_tests.mjs
node scripts/run_fixed_point_constitution_tests.mjs --manifest <fixed-point-cases.json>
node scripts/test_release_convergence_seam.mjs
node scripts/run_instrument_period_state_tests.mjs
node scripts/validate_source_parity.mjs <workbook.xlsx> <row-map.json> <ledger.json> [--json out.json]
node scripts/validate_cache_parity.mjs <workbook.xlsx> [--json out.json] [--tol 1e-6] [--rel 1e-9]
node scripts/validate_style_tokens.mjs <workbook.xlsx> [--json out.json]
node scripts/validate_structure.mjs <source.xlsx> <built.xlsx>
python3 scripts/verify/validate_dynamic_model.py <workbook.xlsx> --out <folder> [--tolerance-mode contract|legacy] [--visual-reviewed <file>] [--finance-reviewed <json>]
python3 scripts/verify/finance_proof.py <case.json> <workbook.xlsx> --out <report.json>
python3 scripts/verify/run_finance_proof_mutations.py <case.json> <workbook.xlsx> --out <folder>
python3 scripts/verify/workbook_semantic_oracle.py --xlsx <workbook.xlsx> --contract <workbook.xlsx.workbook-proof-contract.json> --out <report.json>
python3 scripts/verify/run_deterministic_tests.py --builds <build-a.xlsx> <build-b.xlsx> --out <folder>
python3 scripts/render/check_render.py <company-workbook.xlsx> --out <folder> --baseline-case <standard-maximal|standard-net-cash> --structural-only [--soffice <path>]
python3 scripts/render/check_render.py <frozen-authority-replay.xlsx> --out <folder> --baselines <external-approved-baselines> --baseline-case <standard-maximal|standard-net-cash> [--soffice <path>]
python3 scripts/render/selftest.py <reference.xlsx> --fixtures <folder>
```

Read each report's status and violation count; exit code alone is not the result. `PASS_PENDING_MANUAL` is not `PASS`. The validator requires row-map, solution, coverage, semantic-manifest and source-crosswalk sidecars. Never widen tolerance to clear a finding.

Repair only through a registered deterministic remedy. Re-run the failing node and every downstream node. Stop if a violation appears that was absent in the prior iteration, if severity does not shrink, or after three repair attempts. Validators and authority files are immutable during repair.

Native Microsoft Excel is authoritative for iterative calculation and final analyst appearance. Test circularity, maturity roll and acquisition as 1 -> 0 -> 1 -> 0 -> 1, pressing F9 and saving at each step. Confirm affected outputs suppress and restore identically and leave intended production controls on. Also inspect formulas, provenance colours, freeze panes, outlines, indentation, borders, conditional formats and all visible sheets.

Every company workbook must pass structural render QA against the selected
maximal or net-cash profile: all visible sheets must render, the declared cells
must be locatable, and clipping, overlap, fonts, pagination, alignment and
conditional formatting remain fail-closed. Do not pixel-diff arbitrary company
labels and values against the example company's pixels.

Installation verification and installed behaviour proof are separate gates.
Before activation, the deployment host verifies only the immutable source
commit and tree, every retrieved blob, compiled package membership and closure,
the versioned install destination, the active pointer and the retained rollback.
It must not start a company run, ingest an issuer filing, build a workbook or
alter a canary. The complete cohort, raw-input black-box canary and clean-root
workbook smoke belong to the source-owned local release gate that produced the
immutable candidate.

Installed behaviour proof is a later, explicitly authorised fresh-session run.
It exercises the ordinary public controller and its per-run validation gates;
it is never smuggled into installation. When the requested hand-off is the
`run excel inflow` prompt, open a fresh chat, enter that exact prompt without
submitting it, and stop. Canonical workbook identity, when an installed run is
authorised, covers semantic row maps, formula and value content, styles,
comments and every non-volatile package relationship after masking the closed
set of producer-assigned relationship identifiers. Raw archive-byte identity
may be reported only when the producer is itself byte-deterministic.

Exact pixel comparison remains a separate **local** release-certification gate.
It replays the two frozen shipping-path profiles against a matching independently
approved external baseline without `--structural-only`. The comparison run may
never create or refresh its own baseline. LibreOffice/Carlito proves regression
and clipping, not exact Excel/Calibri appearance; native Excel review remains
separate evidence.

### Evidence concurrency and runtime attribution

Once issuer identity is known, filings sourcing, DCS parsing and broker-native preflight may run concurrently. Broker preflight may hash, archive, extract native text/tables/geometry and render pages, but it cannot select model authority until the filings-derived canonical model-demand graph exists. The final broker lane rebinds reusable native preflight evidence to that graph by raw-document hash; if reuse cannot be proved exactly, fall back to the canonical full broker extraction.

Every user-visible run writes an `experience-trace/1.0`. Time is classified as `excel_inflow_active`, `known_external_wait` or `unknown`. Known Rogo/model-host/source-retrieval waits remain visible in end-user wall time but are not treated as unowned Excel Inflow work. Initial release coverage is at least 95% classified, with 98% the engineering target. Unknown gaps above 30 seconds warn, above 120 seconds require investigation and above 300 seconds block certification unless reclassified from evidence as a known external/platform wait. These thresholds never justify skipping validation.

## Completion
Deliver one workbook, its normalised case, its evidence-run receipt and a concise
summary naming the selected standardised profile, broker anchor, assumptions,
unresolved gaps and validation status. The case file is the rebuild carrier;
never assume it persists across deployment host chats. State status plus total violation
count and identify any manual gate still open. Never call the model complete
while coverage, economics, formulas, native Excel restoration or visual review
is unproven.

### Delivery integrity

Stage execution runs only through installed entry points. Never author, modify
or execute a script that is not part of the installed tree to run, resume,
verify or deliver any stage. If a requested operation has no installed command
— a partial-stage rerun, a bespoke resume, an ad-hoc verification — state that
the command does not exist and stop; an improvised execution path can produce
a receipt-shaped answer that no gate ever certified, which is worse than no
answer.

The user-visible workbook is `delivery_file` from the controller's
delivery-result: a controller-named copy whose filename embeds the attested
workbook hash prefix, so two different workbooks can never share a delivery
filename and a stale same-named download can never impersonate a delivery.
Attach that file byte-for-byte under its controller-assigned name. Never
rename it, never copy the build-area `model.xlsx` under a friendly name, and
never attach a workbook that the live-delivery attestation does not own.

A delivery message quotes, verbatim from `delivery-result.json` and the
live-delivery attestation: the attestation SHA-256, the workbook SHA-256, and
the complete sheet inventory. Never restate these from memory or from earlier
conversation. Any recipient can re-prove a delivered pair at any time, in any
chat, with:

```text
python3 scripts/verify/verify_delivery.py <delivered.xlsx> <live-delivery-attestation.json>
```

It re-derives the workbook hash and the file's own sheet inventory from the
bytes and compares them to the attestation; a stale, swapped or regenerated
file fails in one line without opening Excel.

### The single-house inclusion question

When the compiled pack's `election_gauge` carries `candidate_attributed`
entries — cash-flow line items one or two houses model, at or above the
materiality floor against the headline anchor — Model Decisions asks about ALL of them
in one consolidated question, naming each concept, its house, and the computed
ratio. The user's answer is recorded as `flex_elections` entries with
`basis: attributed`, `source_house_id` and `confirmed_by_user: true`, and the
pack is recompiled through the normal resume path. No candidates means no
question. Never include a single-house line without the recorded answer, and
never ask item by item — one run, one question.

### Paused runs and side deliverables

A run that is waiting for an answer still owns its case, its evidence and its
build area. A side request that arrives while it waits — an interim broker
workbook, an extract of what has been read so far, a look at one statement — is
served from a scratch copy outside the build area, and never by advancing,
re-entering or editing the paused run. The pause is a held position, not an
invitation to work the case by hand: a run whose case changed while it waited
is a different run wearing the first one's receipts, and `continue` blocks it
as `run_case_mutated_during_pause` rather than certifying the substitution.

A non-terminal evidence frontier is internal work, not a user-visible blocked
run. `NEEDS_VISION` executes the two reads; `NEEDS_RESOLUTION` executes bounded
adjudication; later work may append in either direction. Once the finite remedy
budget has genuinely been executed, unresolved broker regions are quarantined
and the graph closes `PASS_DEGRADED`; they do not hold Debt, Build or Delivery.
No status may be cleared by composing missing facts in chat or deleting a
difficult report. A pack assembled from memory is not evidence: the lawful
fallback is less broker authority, down to zero, with the raw source and
quarantine receipt preserved.

### Controlled evidence and proof commands

The production raw-attachment route is one transaction:

```bash
python3 scripts/run_attachment_evidence_pipeline.py <controller-spec.json> --out <run-folder>
```

The commands below are subordinate checkpoints or diagnostics. The production
controller invokes them; an end user does not sequence them manually:

```bash
node scripts/run_filings_pipeline.mjs <filings-acquisition-or-extraction-request.json> --out <run-folder>/filings [--responses <response.json>]
node scripts/compile_declared_evidence_run.mjs <attachment-ingress.json> --declarations <minimal-declarations.json> --out <folder>
node scripts/propose_case_source.mjs <minimal-declarations.json> <case-evidence.json> --out <case-source.json>
node scripts/verify/recalc_second_opinion.mjs --before <emitted.xlsx> --after <raw-after.xlsx> --before-map <before.json> --after-map <raw-after.json> --out <receipt.json> [--soffice-identity <sha256>]
```

The preferred filing input is `filings-acquisition-request/2.0`. It is a declarative source-mode registry, never a search instruction. `internal` sources are runtime-library paths or explicit HTTPS issuer/regulator URLs with an allowed-domain set; `user_supplied` paths are eligible only in the explicit override mode; `internal_fallback` preserves both the fallback custody and the failed internal-source reason. The controller materialises every selected source by SHA-256 and then invokes the same extraction lane. Overlapping annuals within the selected source mode may supply different periods only through the sealed `period_authority` ledger;
the latest selected filing remains the canonical statement topology, while an
older report must be explicitly marked `selected_period_authority_support`.
Restated comparatives still require the numeric historical bridge. Stable
issuer identifiers and declared aliases flow from this registry through the
filings evidence, case-source compiler and N2 entity gate.
