# Excel Inflow runtime core

## Outcome

Build a formula-driven corporate debt-overlay workbook with exactly **three historical and three forecast years**. The output must follow one of two standardised design profiles: maximal for full debt, lease, RCF, interest and optional acquisition topology; net cash only for a simple opening-net-cash issuer with no more than two instruments and acquisition off.

The package contains the design contract, style tokens and renderer, but no workbook or PNG files. Physical reference workbooks are supplied separately after installation and remain immutable design authorities. An ordinary deployment run never manufactures or depends on a PNG baseline. It proves presentation through authority structure, exact workbook identity where a frozen canary exists, structural rendering of every visible sheet and native Excel review. Pixel baselines remain external local release evidence only; never write them into the skill or repository.

`assets/standardised-design-runtime.v2.json` carries the portable measured design contract without identifying or embedding a physical workbook. Preserve its A:U geometry, section order, control treatment, named expansion zones and profile identity. Company reporting determines rows inside those zones; it never creates a competing layout.

Deliver a model, not a populated form. Totals, ratios, roll-forwards, pro forma outputs and cross-sheet values are formulas. Hardcode only sourced or expressly supplied inputs. Use blue font for hardcodes, black for same-sheet formulas, green for links to another sheet and white for section titles. Grey fill means intentionally not calculated, never zero and never forecast generally.

## Production architecture

Run one deterministic graph:

`normalise evidence -> classify issuer rows -> compile semantic graph -> coverage gate -> solve economics -> compile row plan -> emit -> recalculate -> terminal patch -> verify -> render -> deliver`

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

Stage 3 always emits the material forecast plan before build. For each
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

On the exact bare request `run excel inflow`, and on any equivalent request to
start a new model, invoke the canonical production controller before asking a
question:

```text
node scripts/run_user_flow.mjs --screen inputs
```

Return that command's Stage 1 ASCII stdout verbatim as the first visible
response. Do not replace it with a conversational company/ticker question or a
Markdown summary. This rule still applies when the user already names the
company or supplies attachments; consume those inputs only after displaying
the canonical Stage 1 screen.

The bare trigger is presentation-only. Do not certify the installed release,
inspect package bytes, emit progress prose, search for tools, read evidence or
perform any other work before returning the Stage 1 screen. Deployment
certification belongs to the versioned installation transaction, never to an
ordinary end-user invocation. After Stage 1 is visible, intake and later stages
may perform their declared checks and persist their normal receipts.

Begin with one compact request for the company name, the FactSet debt export
taken at the last fiscal year end, and broker research from 3–10 houses. A prior
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

Ask at most once and at most five targeted questions after deterministic pruning. Ask only for material facts that change debt, liquidity, interest, leverage or acquisition outputs and cannot be resolved from supplied evidence. Typical questions cover an unreconciled debt residual, unknown fixed/floating terms, missing RCF capacity or drawn amount, unclear cash eligibility, lease mode, refinancing treatment or transaction timing. If more than five survive, say the inputs appear incomplete and request a corrected pack rather than presenting a questionnaire.

The visible run has exactly five labelled stages:

1. `INPUTS` — receive the company, evidence pack and optional prior case;
2. `EVIDENCE REVIEW` — validate, read and reconcile without user contact unless the pack is defective;
3. `DECISIONS` — the only normal stop, containing zero to five questions together;
4. `BUILD AND CHECKS` — solve, emit and validate without user contact; and
5. `DELIVERY` — return the workbook, assumptions, findings and gate status.

Use plain ASCII status screens no wider than 61 columns or 70 lines. Return each
screen as exactly one fenced `text` block so spacing survives the chat renderer.
Every screen states `STAGE n OF 5`, status and one unambiguous next action when
user action is required. Do not expose raw logs, stack traces or internal file
machinery. Preserve full detail in the stage artifact when the screen is a
summary.

Every stage writes a small hash-bound receipt containing run ID, controller
version, stage number and ID, input and output hashes, prior-receipt hash,
status and next stage. Only a verified `success` receipt is resumable. A stale,
foreign, failed, blocked or tampered receipt never skips work. State travels in
the receipts and case files, never in chat history.

Stage 4 has seven silent internal checkpoints: semantic gates, plan, emit,
recalculate and terminal patch, independent verification, structural render,
and publication. They do not create additional user messages. Each checkpoint
stores a separate atomic success receipt and is reusable only when its recipe,
named input hashes and exact output hashes still agree. A killed invocation
therefore restarts at the first incomplete or invalid checkpoint in the same
chat instead of repeating the entire workbook build. No checkpoint is assumed
to survive across chats.

Invalidate from the earliest affected user stage: a new filing, debt export,
broker pack or prior case restarts evidence review; a changed answer,
assumption or transaction input restarts build and checks; a formatting-only
change restarts rendering and visual checks inside stage 4; delivery wording
alone restarts stage 5. Internal graph hashes continue to reuse unaffected work
inside the selected stage.

After answers, rebuild from the normalised case. Do not patch a workbook. Before delivery, give a concise read of the selected profile, broker anchor, opening debt/cash reconciliation, forecast leverage direction, liquidity headroom and any remaining explicit limitation.

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
before normalising model metrics. Run the hash-bound broker evidence lane
outside the immutable skill tree:

```text
python3 scripts/extract_broker_evidence.py <broker-extraction-request.json> --out <run-folder>/extract
python3 scripts/compile_broker_vision.py <bundle.json> --responses <responses-folder> --out <verified-bundle.json>
python3 scripts/compile_broker_pack.py <verified-bundle.json> <broker-crosswalk.json> --out <run-folder>/broker
```

The first command captures native text, geometry, tables, workbook cells and
images. Image-only surfaces remain unresolved until the second command proves
two independent hash-bound cell transcriptions agree or records an explicit
reviewed resolution. The third command compiles only reviewed, cell-addressed
mappings. Before it can pass, every extracted table is reviewed and every
nonblank annual or partial-period candidate row has one reasoned semantic
disposition; a missing row or unowned mapping blocks. Full unused source tables,
guidance, partial-period evidence, distinct metric definitions and supplemental
checks remain evidence rather than disappearing or being forced into annual
consensus.

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

Calculate fixed and floating interest from average balances, with explicit period fractions for material mid-year maturity or closing timing. Floating rates equal the relevant curve plus margin. RCF interest uses average drawn balance. Commitment fee uses average undrawn committed capacity and its own fee rate, not the RCF margin. Other interest must be a visible, documented plug if used. Forecast **interest income** from average eligible cash and a visible yield; never hold it flat by default.

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
shown under *User flow and evidence*. Its Stage 4 owns the semantic gates,
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
```

The plan must report zero unresolved caches. Recalculate in an isolated LibreOffice profile, then apply only the declared terminal patch. Do not treat LibreOffice as the authority for circularity restoration or Excel rendering.

## Validation and certification

Every gate fails closed. A missing dependency, absent sidecar, unresolvable row, formula error, external link, non-zero acyclic cache disagreement, unsupported function, failed conversion, missing required evidence or unreviewed native Excel control is a failure or `BLOCKED`, never a warning or pass. A pixel baseline is required only by an explicitly invoked exact-pixel release replay; it is not required by an ordinary structural company render.

An ordinary production company run invokes only `scripts/run_user_flow.mjs`.
Stage 4 already runs the required per-run gates and returns their hash-bound
evidence. During an ordinary company run, do **not** run mutation suites, exact
authority replays, double-build determinism, render self-tests or any package,
installation or promotion procedure.

The standalone commands below are available only for read-only diagnosis, a
targeted source repair, frozen-cohort work or explicit release certification.
Select only the command required by that mode; this is a catalogue, not an
ordinary-run sequence:

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
node scripts/test_release_convergence_seam.mjs
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

Installed parity is transitive and non-vacuous: first validate each physical
authority against the portable design contract; then prove the frozen local
canary against that authority; then require the installed host to produce the
same canonical workbook package and a PASS structural render with the same
visible sheets and pagination. Canonical identity covers semantic row maps,
formula and value content, styles, comments and every non-volatile package
relationship after masking the closed set of producer-assigned relationship
identifiers. Raw archive-byte identity may be reported only when the producer
is itself byte-deterministic; it is never substituted for canonical parity.
This is the deployment-host gate and needs no PNG upload.

Exact pixel comparison remains a separate **local** release-certification gate.
It replays the two frozen shipping-path profiles against a matching independently
approved external baseline without `--structural-only`. The comparison run may
never create or refresh its own baseline. LibreOffice/Carlito proves regression
and clipping, not exact Excel/Calibri appearance; native Excel review remains
separate evidence.

## Completion

Deliver one workbook, its normalised case, its evidence-run receipt and a concise
summary naming the selected standardised profile, broker anchor, assumptions,
unresolved gaps and validation status. The case file is the rebuild carrier;
never assume it persists across deployment host chats. State status plus total violation
count and identify any manual gate still open. Never call the model complete
while coverage, economics, formulas, native Excel restoration or visual review
is unproven.
