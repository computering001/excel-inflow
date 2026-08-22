# Excel Inflow — MP2 FINISH HANDOVER

**Date:** 2026-08-22 · **Repo:** ~/excel-inflow (GitHub computering001/excel-inflow)
**Integration branch:** `agent/mp2-integration` @ `8ae31c3` (70 commits ahead of main, all local suites green)
**MP1:** ✅ DONE (PR #15 merged, main=`d61b95f`, tag v3.7.10-integration.1)
**MP2 progress:** ~85% — everything below is the finish.

---

## STATE SUMMARY (what exists now)

Merged into `agent/mp2-integration`: E1 forecast-stop gate, E2 output-persistence
(absence gate + reuseStage re-verify), E3 evidence reuse enacted (4 pure nodes),
E5 waterfall split, E6 realisable family vectors, E6b scale-envelope finding,
E7 absolute ceiling probe, E9 order-dependence canonicalisation, E10 convergence
dossier, B HTML-lane wiring, C review sealing (sealed briefing + user-review-
receipt/1.0), D coercion typing + generated-artifact register (8 artifacts, 9
checks), E11 terminal taxonomy (21 outcomes, 4 classes), F2 four P0 invariant
provers, F3 survivor-honest mutation schema, F4 portable-aggregate CI job,
A release-identity single source (v3.7.10, channel gates), G harness batches
(68 runners migrated).

Known-good reconciliation state: ownership census classifies
lib/forecast_plan_status.mjs; terminal-exit inventory has delegate exit
"forecast_plan_blocked" (owner BLOCK, literal signature); taxonomy/registry/
contract agree on INTERNAL_WORK classification; oracle-matrix bindings current.

## REMAINING WORK — 4 PHASES, IN ORDER

### PHASE 1 — E8 fixture finish (~30 min, 1 subagent)
Worktree: ~/mp-worktrees/mp2-E8 (branch agent/mp2-E8-az-replay; dirty=2:
blocked-wc-carrier.json fixture + case_compiler.mjs Phase-G deferral patch).
Current blocker: fixture gets PAST Checkpoint B/materialisation but lands
PAUSED-at-answers instead of plan-BLOCKED. The dividends-lane strip
(case_patch.operating_metrics.dividends_and_buybacks.values=[null×6]) makes
the flow ask questions; "extends":"no-questions" should auto-answer them —
check flow_questions.mjs for which card the nulled lane raises and either
(a) add an answers block to the fixture answering "remove/no data", or
(b) pick a different material row whose blocking doesn't raise a question card.
Harness scripts/run_az_replay_tests.mjs is WRITTEN and asserts: status BLOCKED,
outcome forecast_plan_blocked, forecast-plan-status.json exists, NO selected-
authority-contract.json. Exit contract: 0=PASS, 1=CONTRACT_VIOLATED,
2=GATE_SHADOWED.
Then: commit on that branch → merge into agent/mp2-integration → regenerate
ci/test_registry_census.json (node scripts/compile_test_registry_census.mjs
--out ci/test_registry_census.json) → run_generated_artifact_checks (expect
9 PASS) → push.

### PHASE 2 — Hosted checkpoint (~20 min wall clock, no subagent)
1. cd ~/excel-inflow && git push origin agent/mp2-integration
2. gh pr create --base main --head agent/mp2-integration --title "Excel Inflow
   v3.7.10-candidate — Master Plan #2: authority architecture & production
   hardening (audit §1–§11 closure)" --body "E1–E11 model-closure programme,
   review sealing, ladder wiring, coercion typing, invariant provers,
   aggregate CI topology. E4 steps 2–3 deferred pending CI parity-evidence
   accumulation (step 1 evidence machine landed)."
3. Poll ONE-OFF (no watcher): gh pr checks <N> after ~15 min.
   Expect: 13 checks green (new topology has portable-aggregate job).
4. If red: pull failing shard artifact, diagnose, fix, push again.

### PHASE 3 — Wave Z closeout (~1 hour, coordinator + optional subagent)
1. Merge PR to main (gh pr merge --merge). Tag v3.7.11.
2. Flip the 5 custody-deferred D52 findings in audit/v379/d52-closure-ledger.json
   (deferred→closed with hosted-green evidence SHAs); re-run
   compile_external_ci_evidence to refresh attestation.
3. §11 audit scorecard re-score: update the scorecard section at the bottom of
   ~/.hermes/plans/2026-08-21-excel-inflow-master-plan-2.md against each audit
   finding (§1–§11) — closed / deferred-with-reason.
4. Final report: every OpenAI-audit finding → its landing commit or explicit
   deferral. Post to user.

### PHASE 4 — explicitly DEFERRED (do NOT start)
- E4 steps 2–3 (IR gating→cutover): needs weeks of parity evidence from CI
  (economic-ir-parity suite registered, runs nightly). Known finding to fix
  first when resumed: net-cash rows 58/59 rcf_draw/rcf_repayment blank-vs-zero
  (6 slot mismatches).
- F1 remaining ~140 runner migrations: continuous background batches.
- G2 solver decomposition, S3/S4: post-E4.

---

## SUBAGENT PLAN (max 10 concurrent; briefs must be self-contained)

Wave 1 (NOW): 1 agent — E8 fixture finish (Phase 1 above).
Wave 2: coordinator-only (hosted checkpoint).
Wave 3: 1 optional agent — D52 flips + scorecard draft while coordinator merges.
Nothing else parallel: this is a closeout, not a build-out.

## OPERATIONAL RULES (learned the hard way)
- Subagents die at ~50 tool calls (iteration cap) or provider outages. Briefs:
  self-contained, exact file anchors, "commit within first 10 calls" for small
  jobs, commit-per-cluster for big ones. Relays point at predecessor summaries
  in ~/.hermes/cache/delegation/subagent-summary-*.txt.
- After ANY merge touching scripts/**: re-record certified closure (node
  scripts/run_certified_code_closure_tests.mjs --record then verify),
  regenerate ownership census (--write), regenerate ci/test_registry_census.json,
  rebind oracle matrix (python3 scripts/run_critical_invariant_oracle_matrix_tests.py
  --record-bindings). Then node scripts/run_generated_artifact_checks.mjs → 9 PASS.
- LO-dependent suites need EXCEL_INFLOW_TEST_PYTHON=$HOME/mp-venv/bin/python
  SOFFICE_BIN=/Applications/LibreOffice.app/Contents/MacOS/soffice.
- Branch protection on main: required checks have numeric prefixes ("1 - Exact…"),
  strict:false. Never recreate the phantom-pending bug (unprefixed contexts +
  strict:true).
- NEVER put secrets in output. gh CLI is authed as computering001.
- Poll hosted checks one-off (sleep N; gh pr checks) — never background watchers.

## KEY FILES
- Plan: ~/.hermes/plans/2026-08-21-excel-inflow-master-plan-2.md (+ .v1-backup.md)
- Audit ledger mapping: inside the plan file (every §1–§11 finding → phase)
- E8 harness: scripts/run_az_replay_tests.mjs (exit contract above)
- E8 fixture: scripts/flow-fixtures/blocked-wc-carrier.json (dirty in worktree)
- Phase-G deferral patch: case_compiler.mjs catch-block keyed on
  "blocked forecast plan cannot be materialized" (in mp2-E8 worktree, NOT yet
  on integration — merge carries it)
- D52 ledger: audit/v379/d52-closure-ledger.json (28 findings, 23 closed,
  5 custody-deferred)
- Registry: assets/development-test-registry.json (241 tests)

## VERIFICATION BASELINE (all green at 8ae31c3 unless noted)
workflow_state 24/24 · programme_control 483 · mutation_adequacy 74 ·
evidence_work_graph 370 · differential_invalidation 373 · broker_consensus 54 ·
scale_invariant 37 · solver_hardening 29 · goldens 249 frozen ·
ceiling probe 151 · taxonomy 28 · review_sealing 12 · semantic_stop 5 ·
provers 13+6+14+8 · governance PASS (12 jobs) · generated-artifacts 9 PASS ·
user_flow 12/14 ← KNOWN ISSUE, see below

## KNOWN OPEN ISSUES (2)
1. user_flow 12/14: "tampered stage output invalidates only that stage" fails
   at HEAD — bisected to E3 (5e759ec): enacted reuse skips the action on a hit,
   so the tampered model-case.json surfaces as an invalid behavior-map instead
   of a clean decisions-stage re-execution. The test's expectation is correct;
   the enactment gate needs a tamper-awareness condition (e.g., refuse
   enactment when any key-component FILE's mtime/hash changed vs receipt even
   if digest-key matched — or recompute key components from disk before
   enacting). Second failure "delivery blocker constitution covers every
   terminal outcome: forecast_plan_blocked lacks one of the declared fatal
   delivery reasons" — forecast_plan_blocked was moved OUT of contract
   blocked_outcomes (it is INTERNAL_WORK); the constitution check enumerates
   blocked_outcomes only, so EITHER add forecast_plan_blocked to
   delivery_blocker_constitution.blocked_outcomes with fatal_reason
   equation_system_unsolved AND relax the taxonomy cross-check to allow
   INTERNAL_WORK for it specifically, OR teach the user_flow test that
   INTERNAL_WORK outcomes are exempt from that coverage assertion. Pick one
   doctrine and make taxonomy+contract+test agree.
2. E8 PAUSED-vs-BLOCKED (Phase 1 above).
