# Phase 6 work orders — Runtime deadlines, caching, fault isolation, resumability
(Discovery agent 2026-08-19 @ 5154936. NUMBERING: pack register rows 50-57 = P6.1–P6.8 is THIS layer;
pack Phase 7 is corpus/oracles/behavioural freeze — separate work-orders file.)

- **P6.1** GAP: two clocks, one persisted one not. run_deadline.mjs ledger opened once
  (run_user_flow.mjs:484), consulted at ONE boundary (:1889 workbook_build_outer); stages 1/2/3/5
  never check budget; vnext uses a VOLATILE ceiling reset every main() (run_excel_inflow_vnext.mjs:327
  → :814 → runtime_budget_policy.mjs:91-95) so resume restarts the 25-min ceiling. Ledger has no
  run_id/version/commit/policy digest (run_deadline.mjs:51-65) — stale/foreign ledgers accepted.
  Killed/thrown runs record NO segment (:2198 catch); DEFAULT_RUNTIME_BUDGETS_MS sums ~35.5min vs
  25min ceiling; deadline receipts written, never read; INTERNAL.runtime_budget_overrun has zero
  producers; wiring "proven" by regexing controller source (run_run_deadline_tests.mjs:101).
- **P6.2** GAP: FIVE unreconciled checkpoint schemes; four of five user stages recipe-less.
  (1) user-stage-receipt/1.0 (flow_runtime.mjs:162-204) sound but no recipe field; guard is
  FLOW_CONTROLLER_VERSION + HAND-MAINTAINED STAGE_RUNTIME_MEMBERS (run_user_flow.mjs:171-244, no
  closure test) while build_checks is a catch-all (:259-260 — README edit cold-starts build).
  (2) stage4-checkpoint/1.0 correct+recipe-versioned. (3) vnext checkpoints[] reporting-only.
  (4) attachment/broker python run-states = fourth protocol. (5) run_store.mjs RunStore — the
  documented §2 resume mechanism — ZERO production callers. Blocked-path inputHashes shape differs
  from success path (:1363-1366 vs :1489-1494) so a miss can't be explained.
- **P6.3** GAP: no work DAG over the evidence half. Only real cache-keyed graph is stage-4's
  checkpoint() (orchestrate_release.mjs:626-703, 14 ids + per-sheet render leaves) — reuse it
  verbatim upstream. Hit/miss/invalid REASONS never recorded. Doc drift: SKILL.md:409 et al say
  "thirteen silent leaf checkpoints" vs 14+N.
- **P6.4** GAP: differential invalidation proven ONLY in stage 4 (run_stage4_checkpoint_tests
  covers interruption, scratch loss, published-workbook deletion → exactly emit,publish). Upstream
  reused_stages is NOT honest: runIntake runs unconditionally BEFORE the stage-2 reuse check
  (:1072 vs :1063); compileCase (:1343) + intake replay (:1397) run before the stage-3 check
  (:1506). CHANGE_INVALIDATION + earliestInvalidatedStage (flow_runtime.mjs:118-133): ZERO callers,
  dead 12-entry literal. No error classification table, no attempt receipts.
- **P6.5** GAP: ThreadPoolExecutor(max_workers=len(lanes)) — no CPU/memory/budget bound
  (run_attachment_evidence_pipeline.py:1877); only resource-aware limit is stage-4
  validator_concurrency. Broker circuit-breaker containment real, but no mandatory-vs-optional
  budget priority, no per-lane resource receipts, no late-enrichment-invalidates-authority event.
- **P6.6** GAP (cheapest high-value): performance receipt mislabels spans — solver ←
  timings.semantic_gates, case_compilation ← timings.plan (performance_receipt.mjs:52-53);
  render_sheet_* excluded from validation reduce (:56); NO unattributed bucket/threshold;
  validatePerformanceReceipt has no production caller (vnext ships INCOMPLETE without failing,
  :894-906); finiteDuration>0 makes every warm/resumed run (duration 0) emit MISSING spans BY
  CONSTRUCTION; registry id says unit/synthetic — inverted.
- **P6.7** GAP: NO runtime doctor (zero grep hits); fault injection = one boundary (stage-4
  recalculation) + process-tree kills; cancellation only on ownership-preflight path;
  CANCELLED.user_or_system_stop no general producer; checkpoint_required/evidence_preserved only
  shape-asserted — nothing verifies a checkpoint actually exists on those exits.
- **P6.8** GAP: no phase-6 SLO evidence, no programme/checkpoints/ convention, no cold/warm cohort,
  no percentile aggregation, no hard-ceiling enforcement test; P6.6's receipt structurally cannot
  pass warm.

## Cross-cutting resume gaps
- Recipe-less: stages 1/2/3/5 + all 8 vnext checkpoints. Decisions stage worst: ONE receipt
  (:1489-1505) covers recompile+decisions+forecast plan+behaviour map+demand graph+authority
  contract+constitution graph indivisibly (the P3.7 deferred follow-on).
- Cross-version: only broker has migrate-never-resume discipline (migrate_broker_run_state.py,
  closure-digest pinned). Stage receipts/stage-4 checkpoints have NO version guard. Run carrier
  refuses mutated paused runs typed — but that outcome + seven siblings (:553,720,1327,1390,1642,
  1951,2038) are NOT in the terminal-reason registry.
- Raw canary: donor pin enforced + CI-checked (portable); the canaries themselves are custody-
  BLOCKED on CI (never execute there). Tree-integrity violation throws UNTYPED → misfiled as
  INTERNAL.compiler_or_graph_defect with full-rerun scope — operator mutation misread as compiler
  defect; check skill-integrity.json before believing that code. Canary script never captures
  integrity itself.
- internal-failure.json: five fields emitted but resumable_checkpoint_path = whole stages/ dir and
  preserved_source_hashes = an English sentence; **vnext :928-931 writes NO payload at all** — the
  outer controller still dies in a bare stack print (the exact condition P3.7 closed one layer down).

## Sequencing
P6.1 → P6.2 → P6.3 → P6.4 → (P6.6 EARLY+CHEAP any time) → P6.5 → P6.7 → P6.8.
Cheapest closes in order: P6.6 receipt honesty (~1 file); vnext typed-failure writer + registry
rewiring (owed by the registry's own migration_wiring_status); P6.2 stage recipe field (unblocks
P3.7 forecast recipes).

## Overlap holds
- P6.4's hoist edits the compileCase call site — sequence AFTER in-flight case_compiler work lands.
- solver.mjs P3.7 typed payloads (:1640,:2957) are consumed by P6.7 rewiring — one side at a time.
- While semantic_graph/row_plan/extractor are mid-edit, build_checks cold-starts every stage-4 run:
  trust stage4-content-addressed-resume only on a quiescent tree.
- raw_canary_fixture/optional_broker_circuit_breaker/run_constitution_graph are census-pinned:
  census update in the same commit or programme-control goes red.

# Phase 6 carry-in — terminal outcome compiler (second scout, same commit)
- **TOC.A** 27 finish sites, ZERO registry-bound statuses (vnext 9 literals :456-911; delegate 18);
  six further unbound vocabularies (flow outcomes ×11, question statuses, stage_receipt statuses,
  carrier states, lane pipeline_status, quality_mode ×5). Only code naming the 7 declared terminal
  states: generated support_envelope_contract.mjs:13 TerminalState — no consumers.
- **TOC.B** public schema admits ONLY the 4 legacy tokens (excel-inflow-vnext-run.schema.json) —
  DELIVERED_*/SOURCE_REQUIRED/UNSUPPORTED_PROFILE/INTERNAL_FAILURE/CANCELLED unmintable; no
  terminal_reason property; assertPublicStateOwnership has ZERO production callers and is weaker
  than the registry; dead NEEDS_USER_INPUT branch at vnext:282.
- **TOC.C** 17 codes, 5 emitters; UNSUPPORTED_PROFILE.* vs PROFILE.* spelling crosswalked only
  inside a test; 618 untyped throws across 70 lib files (3 files typed);
  internal-failure.json read by NOTHING (parent maps delegate exit≠0 to NEEDS_INTERNAL_WORK and
  discards the typed code, vnext:612-632,834-858); untyped path payload: 3 of 5 fields placeholders.
- **TOC.D** category firewall enforced NOWHERE; three live crossings:
  (1) run_user_flow.mjs:1140-1168 decision_replay/graph_blocked → ACTION_REQUIRED +
  blocker INTERNAL_WORK → workflow contract admits only USER_DECISION → GUARANTEED UNCAUGHT THROW
  (highest-value cheap fix in the phase, per scout);
  (2) SOURCE.opening_debt_unresolved surfaces publicly as NEEDS_INTERNAL_WORK;
  (3) support-envelope early stop discards early_stop.terminal_state/legal_terminals and mints
  BLOCKED/FATAL_SOURCE (vnext:554-569). P3.7's "no-internal-ACTION_REQUIRED scan" does not exist.
- **TOC.E** two unlinked reason vocabularies: delivery-constitution fatal_reasons are registry codes
  with the category prefix STRIPPED; nothing asserts alignment. The BLOCKED-outcome binding
  (workflow_state.mjs:160-195) is the strong pattern to generalise. No ACTION_REQUIRED outcome
  carries a reason code.
- **TOC.F** confidentiality live: vnext :623-630/:849-856 slice 4000 chars of delegate
  stdout+stderr into public summary; :928-931 full stack; delegate :2199 full stack; :2021/:2039
  raw error.message on the user screen; :1918-1922 stage-4 stderr into build-result.json.

Sequencing: TOC.A/TOC.B (one compiled status+reason writer) PRECEDES P6.2/P6.7 (journal needs one
vocabulary). Cross-phase: TOC.C ← P3.7; TOC.B/D ← P0.5; P6.3/6.4/6.7-resume ← P3.6 identity;
P6.8 cohort ← P7.1 corpus. Overlaps: P2.7 findings shape ↔ blocked_outcomes map; P4.3 must attach
typed_internal_outcome at new refusals; P2.1 owns the envelope descriptor — P6 binds legal_terminals.
