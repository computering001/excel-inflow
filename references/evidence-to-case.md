# Evidence to case

## Purpose

This is the boundary between deployment host's document reading and the deterministic
model runtime. deployment host may read uploaded and retrieved documents semantically; the
runtime never pretends that one fixed parser understands every FactSet layout,
annual report, broker PDF or issuer label.

The output of evidence reading is exactly one `evidence-run/1.0` object validated
against `assets/evidence-run-v1.schema.json` and
`scripts/lib/evidence_run.mjs`. The proposed normalized v2 case is embedded in
that envelope. No question or workbook build begins until this gate passes.

When raw attachments are available to the runtime, begin from an
`attachment-ingress/1.0` spec and run `scripts/compile_evidence_run.mjs`. The
compiler reads the raw bytes itself, computes SHA-256, binds every source ID to
exactly one attachment and writes both `evidence-run.json` and
`attachment-manifest.json` outside the skill tree. JSON is accepted directly;
CSV and XLSX require an explicit normalized contract, and PDF/document/text
sources require an explicit extraction artifact bound to the raw attachment ID,
raw hash and source IDs. Never accept a caller-stated hash in place of bytes.

## First-run inputs

Mandatory:

1. company name;
2. FactSet DCS instrument export taken at the last fiscal year end;
3. broker research from 3–10 distinct houses.

Optional:

- the case file returned by an earlier run;
- known acquisition assumptions or a user-supplied company document.

Never ask for reporting currency, units, fiscal year end or the 3+3 horizon.
Those follow the company and the product contract.

These are production inputs. Autonomous public-company stress tests use the
separate `public-test-run/1.0` contract. Do not make FactSet or real broker
sources optional inside `evidence-run/1.0`; that would erase the distinction
between a model test and production evidence.

## Public-company test boundary

For a deliberately non-production test, build one object under
`assets/public-test-run-v1.schema.json` and validate it with
`validatePublicTestRun`.

The envelope must be marked `TEST_ONLY_NOT_PRODUCTION_EVIDENCE`. Public company
documents are authoritative for history and debt. An explicitly synthetic
3–10-house forecast pack may drive the forecast mechanics, but every identity
must visibly say synthetic, indicative or illustrative and the case must retain
the `SYNTHETIC TEST DATA` source label. The validator always returns
`production_eligible: false` even when every test gate passes.

Missing public debt detail is a useful negative test. It must block and identify
the missing balance, maturity, rate, currency, RCF capacity or drawn amount. Do
not manufacture a DCS-shaped FactSet export from public information; production
still requires the user-supplied export taken at the last fiscal year end.

## Evidence-reading procedure

1. Hash and inventory every uploaded or retrieved source before extracting a
   fact. Prefer the raw-attachment compiler so the runtime, rather than the
   caller, computes and verifies the bytes. An image-only broker source may
   support a numeric fact only after the hash-bound image lane in
   `broker-extraction.md` reaches PASS through two agreeing independent
   transcriptions or an explicit reviewed resolution. An unverified image-only
   source blocks.
2. Retrieve only the documents needed for the company and periods. Use the
   source waterfall in `runtime-core.md`; do not load a broad archive.
3. Resolve entity, reporting currency, units, calendar kind and exactly three
   historical period ends from the filings.
4. Capture every face income-statement and cash-flow line into an independent,
   source-ordered `face-statement-manifest/1.0` before classification. Bind each
   manifest to the raw filing SHA-256 and record the issuer label, three
   historical values, page/note, hierarchy, row ordinal and ordered-row digest.
   The manifest is the statement universe; never derive it from source coverage
   or the normalized case.
5. Capture the raw DCS source into `dcs-source-tables/1.0` and its immutable
   `dcs-candidate-manifest/1.0` before normalising anything. Require one reviewed
   disposition for every captured row and cell, compile the cell-addressed term
   authorities and run the independent DCS oracle. Only a PASS compiler receipt
   and separate PASS oracle may produce the `dcs-export/1.0` compatibility
   projection. Preserve zero-balance instruments, RCF capacity and drawn terms,
   native-principal versus carrying-value basis, and audit-only issue date,
   price, YTW and OAS evidence. Month- and year-precision maturities remain
   visibly non-exact and preserve their source representation; the annual model
   may use a separately declared month-end or year-end timing convention. A
   bucket with no resolvable forecast timing still blocks. The DCS remains a
   per-run artifact outside the workbook; selected terms populate the visible
   debt schedule as sourced blue hardcodes. Normalize
   broker research to `broker-pack/1.0`. Preserve house publication dates and
   source filenames in the model case's `broker_pack.house_metadata`. For a
   full-table broker lane,
   require its semantic coverage ledger to review every table, disposition every
   detected forecast row and report both zero unresolved candidates and zero
   semantic-quality violations before treating the normalized pack as complete.
   Preserve exact definition ids, semantic roles and evidence kinds through the
   crosswalk receipt. Company guidance, broker-derived estimates, partial-period
   evidence and ordinary annual estimates remain separate lanes.
6. Build `forecast_context` before selecting a forecast assumption. Inventory
   every annual/interim result reviewed, identify the latest publication-dated
   result, and record whether company guidance was used or explicitly reviewed
   and absent. A global filing citation is not row-level forecast evidence.
7. Resolve historical interest authority before building the case. State
   `historical_interest_reconciliation.reported_interest_basis` explicitly:
   filed total including lease interest, reported debt interest excluding a
   separately disclosed lease charge, or identified components only. Bind the
   reported series and lease series to their own source lines. Never infer the
   basis merely because lease interest is present, and never add lease interest
   until both reported and identified series have been canonicalised to the
   same basis.
8. Build the proposed v2 case while preserving issuer-specific rows. The filing
   ledger and source coverage must each equal the manifest in both directions
   and source order. Every included line must map to a visible row retaining the
   issuer label and `source_line_id`; aggregation requires separately represented
   named children and a formula parent. Exclude only an explained immaterial
   non-applicable line. A generic aggregate is not lineage.
9. Record one basis decision for each historical period. A restated comparative
   replaces the superseded figure only when the filing explicitly says so.
   Predecessor or calendarised history requires a complete bridge.
10. Record manual debt supplements only for a named field and instrument, with a
   company-document or user-answer source. A residual is not permission to
   invent a maturity, rate, capacity or currency.
11. Run `validateEvidenceRun`. It must bind every row-level company forecast
   source (including both legs of an actual-plus-remainder forecast) back to a
   used inventoried document. If it blocks, correct the extraction or request a
   specific re-supply; never weaken the gate.
12. Enter `flow_cli start` only after the evidence run passes.

## Arbitrary issuer rows

The semantic taxonomy is a small set of economic roles, not a list of every
caption a company can publish. Preserve an unusual material row under its
original label and give it a declared contributor role in the case graph.
Automatic classification may abstain. A manual review is valid only when its
source evidence, proposed treatment and downstream cash/debt consequence are
recorded. Unmatched material rows reach the single stage-3 stop or block; they
never disappear.

## Rebuilds

A rebuild uses `mode: rebuild`, inventories the prior case as a source and
records its SHA-256 in `prior_case_receipt`. Preserve settled answers unless new
evidence changes the fact they answered. Re-run entity, date, debt, broker and
source-line checks. The prior case accelerates extraction; it is never stronger
than current filings.

Settled answers travel only in the hash-bound case as
`stage_three_answers: {question_id: option_id}`. On a rebuild,
`prior_case_receipt.answers_preserved` must exactly equal those carried IDs.
If current evidence invalidates an answer, remove it from both places so the
question planner can reassess it; never rely on chat or sandbox memory.

## The v3 compiler is the only case producer

Stage 3 authors `case-source.json` and nothing else. A case-source
(declarations only — the schema at `assets/case-source.schema.json` cannot
express values or formula text) plus the sealed evidence lanes compile into a
model case, or into a complete findings report; there is no partial success.
Point-editing the compiled `model-case.json` is a doctrine violation and a
hash trip; every repair is an amended declaration or a recorded answer,
followed by one recompile.

```
node scripts/compile_case.mjs <case-source.json> <evidence.json> --out <model-case.json>
```
