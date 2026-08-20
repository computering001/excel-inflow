# Phases 2–5 work orders (condensed from the 2026-08-19 discovery agents)

Each line is the package's GAP verdict; execution targets exactly these. Full
agent transcripts are session artifacts; file:line anchors verified at head.

## Phase 2
- **P2.1** GAP: no balance-sheet/equity inventory (extractor + response schema admit only IS+CF); `model_statement_scope()` deletes OCI/EPS/dividend rows with no out-of-scope record; printed unit labels never reconciled vs declared units.
- **P2.2** GAP: no structured-fact↔visible-row reconciler — `extract_inline_xbrl.py` is unplugged from `run_filings_pipeline.mjs`; no concept→role crosswalk; provenanceEntry has no context_ref/unit_ref/decimals fields.
- **P2.3** GAP: no resolution ledger and no independent resolver — `case_compiler.compileSourceCoverage()` auto-stamps non-accepted classifications `manual_reviewed` with a canned rationale, suppressing all ambiguity questions. Needs a classification-resolution ledger mirroring `forecast_authority_ledger.mjs`.
- **P2.4** GAP: no required-role closure artifact BEFORE forecast compilation; uniqueness enforced only over the hardcoded `UNIQUE_VISIBLE_ROLES` subset (~7 required roles missing; role_aliases ignored); `assessCoverage()` runs after `compileForecastPlan`.
- **P2.5** GAP: no residual treatment for statement families (only debt pools/broker bridge); an unfooted material total silently passes as `source_input`; protected-identity role set is a hardcoded literal (`model_ir_v3.mjs:847`); empty member-sets skip silently.
- **P2.6** GAP: the stitch lane is schema-illegal (response schema forbids `period_support_required`/`prior_filing_support` states and the stitch fields under additionalProperties:false) and unplugged from the pipeline; documented issuer/unit fail-closed checks absent from `stitch_manifest()`; no restatement guard. **[DONE 2026-08-19: schema declarations + P2.8-wire commit]** ← update as executed
- **P2.7** GAP: no policy registry asset; policy objects unversioned in the case (rcf/cash/lease carry no version field) and cover 3 of ~10 model-owned assumption families; no {policy_id, version, owned_assumption, evidence_hierarchy} contract.
- **P2.8** GAP (original): envelope inert. **[WIRED 2026-08-19: `run_excel_inflow_vnext.mjs` preflight classifies from evidence facts; early stops fire typed (suite support-preflight-wire, 7 checks); canary delivers with the wire live.]** Remaining: direct-method CF has zero code (neither handled nor refused pre-extraction); discontinued ops never detected in the filings lane; restatements declared-not-detected; 53-week years never normalised in forecast drivers.

## Phase 3
- **P3.1** GAP: no Economic IR — `model_ir_v3` is a blocking, value-free proof projection with no shadow mode, no typed values, no schedules, no registered suite.
- **P3.2** GAP: completion census covers IS+CF only (no debt/interest/lease/RCF/acquisition cells); ownership classified by method label not executable producer witness; parity receipt never verified post-Build; three periods hard-wired.
- **P3.3** GAP: ETR not DAG-safe as proven — tax nodes absent from the equation graph; the three policy operators undeclared in the formula DSL (string-prefix detection); census says Phase-2 owner, programme says Phase-3.
- **P3.4** GAP: scoring not period-specific — Preflight A collapses periods; only strongest-child-vs-parent (no family aggregate score); no rank vectors persisted; certificate sealing outside the period loop; recovery pass gated on an env var.
- **P3.5** GAP: FOUR capture writers (capture_transition + row_plan + case_compiler + forecast_candidate_compiler); capture is a mutable row-level scalar (not period-specific, not immutable, no transaction/journal); the ownership-census test PINS the defect as expected text. Cheapest high-value close per the agent.
- **P3.6** GAP: eleven identity schemes, no canonical binding; completion keyed by unjoined tuple; capture period-less; semantic manifest not period-scoped; no crosswalk artifact or bijectivity proof.
- **P3.7** GAP: only Preflight A yields a resumable outcome — stage-parity/Preflight-B/solver non-convergence throw raw Errors ending in a stack print; no forecast reason codes in the registry; the five internal_failure payload fields never emitted; no forecast-stage checkpoint recipe.
- **P3.8** GAP: no authority seal over an Economic IR; parity receipt binds neither IR, manifest, instrument state, equation graph nor solution; `verifyEconomicStageParity` has no production caller; transformation receipt never re-verified.

## Phase 4
- **P4.1** GAP: source inventory exists only for the DCS lane; `compileOpeningInstrumentState` carries no source-row provenance/candidate ids/crosswalk hash; no not-selected register at the opening-debt boundary.
- **P4.2** GAP: no reconciliation bridge — one signed-residual scalar into one pool row; no schema/artifact/taxonomy/FX line; years 1–2 asserted not reconciled; BLOCK result not the registry reason code.
- **P4.3** GAP (strongest package): RCF draw/repay/ending, acquisition debt and cash buckets have no typed states; amounts untyped; definition-basis selectors are prose; three periods hard-wired.
- **P4.4** GAP: the 9-module contract (`assets/canonical-model-graph-v2.json`) is implemented by NOTHING — all economics inside ~1,520-line `solveCase`; no interest/RCF/cash schedule modules; six invariants unvalidated.
- **P4.5** GAP: no Formula AST — flat one-level rules emitting A1 strings; `ast_depth` hardcoded 1; four operators unimplemented; ONE production call site vs 264 raw template-literal formulas; no registered suite.
- **P4.6** GAP: four separately-sealed graphs, none canonical; equation graph is a static 35-node single-period role template (no instruments/leases/acquisitions/tax/rows); layered constitution's economic layer has zero cross-layer edges.
- **P4.7** GAP: no DAG solving (hand-written order); Tarjan never runs on the case's own graph at solve time; iteration vector is a 13-entry literal; cash loop is a hardcoded min/max branch (no active set, no binding-constraint record, no per-SCC residual); solver-hardening suite is 3 asserts.
- **P4.8** GAP: no oracle independently recomputes the solver fixed point or RCF draw/repay from cash need (only a same-language mirror); no debt-roll-forward oracle from typed states; the 15-domain matrix lacks convergence/roll-forward/opening-debt/ETR domains; `finance_proof.py` unregistered as a dev suite.

## Phase 5
- **P5.1** GAP: plan not pure — `funded_acquisition_plan.mjs` injects economics at plan time AND post-serialisation by label matching; images/page_setup/defined_names unrecordable by the builder (bolted on post-toPlan); plan-y never diffed vs plan although `emit compare` exists unused; no registered plan-contract suite.
- **P5.2** GAP: no Formula AST (see P4.5); adjustment gate applied by string concat + regex over sheet XML; no emitted-`<f>`-derivability test.
- **P5.3** GAP: provenance styling self-referential (emitter and validator share the same regex); colour never bound to an authority record; comment TRUTH unchecked by all validators; oracle reads no comments; only IS+CF rows scanned.
- **P5.4** GAP: the reverse verifier consumes the build's own proof contract (forward expectation); the one hand-authored binding oracle runs on synthetic OOXML; comments/CF/DV/numFmt/merges/drawings/calcPr/widths/freeze unread; no plan reconstruction from .xlsx (`extract_plan.mjs` absent).
- **P5.5** GAP: consensus genuinely proven physically; authority and capture mutations edit JSON receipts not cells; capture has no adversarial workbook mutation; 5 of 15 matrix domains are toy string comparisons yet report detection 1.0; one hardcoded-address representative.
- **P5.6** GAP: charts do not exist and are actively forbidden by `no-unintended-drawings`; greenfield (plan-schema chart contract, renderer, oracle reader, geometry check, amended invariant). Certification native-gated.
- **P5.7** GAP: verifier/schema/gate complete + mutation-tested; ZERO native evidence (Rogo/Excel hard-gated); contract lacks a reopen leg; PASS_PENDING_MANUAL exits 0.
- **P5.8** GAP: mutation and visual halves disjoint — matrix has no rendered_geometry scope; check_render/selftest and the design-contract harness unregistered (harness ORPHANED); no style-mutation→visual-detection pairing; visual_manual audit class declared and unused.

## Sequencing (from the P3/P4 agent, code-implied)
P3.6 identity → unblocks P3.1/P3.2/P4.6 · P4.5 AST → P4.4 modules → P4.7 graph-driven solving → P4.8 real solver oracle · P3.5 is the cheapest high-value close (four writers → one module).

## P5.6 — DEFERRED, not attempted (owner decision, 2026-08-20)
The pack titles P5.6 "Redesign charts around semantic decision questions" and lists charts as
part of the physical projection. That premise does not hold in this codebase: discovery found
charts DO NOT EXIST and drawings are actively forbidden by the `no-unintended-drawings`
invariant. So P5.6 is not "improve the charts" — it is build a charting feature from scratch,
which requires amending a guarantee that currently holds, and its certification half is
native-gated and therefore permanently excluded.

Declined on the owner's challenge: this is an Excel MODEL BUILDER, and charts are presentation
rather than model correctness. Weakening a live guarantee (no undeclared drawings) to add a
presentation feature is a poor trade in a programme whose purpose is behavioural closure.

If charts are wanted later, the work is well-scoped and the prerequisites now exist: P5.4's
reconstruction oracle already reads drawing anchors and media digests, and P5.8's
rendered-geometry scope gives pixel-baseline visual detection. The invariant would become
"no UNDECLARED drawing" with a plan-declared chart contract binding series to plan row
identities (not A1 literals — see P3.6a on why address and label bindings drift).
