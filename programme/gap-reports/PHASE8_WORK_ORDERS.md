# Phase 8 work orders (discovery agent 2026-08-19, HEAD 5154936; pack playbook §Phase 8 rows 66–73)

**Native-Excel exclusion (user directive, permanent).** P8.3, P8.4, P8.5 and the installed half of
P8.6 require Rogo/native Excel — EXCLUDED, not deferred. Structural consequence: REQUIRED_EVIDENCE
in lib/release_certification.mjs:19-27 names native_excel + visual_review, so --certify can never
pass (compile_skill_release.mjs:1129-1146) and PACKAGE_MODES (lib/identity_vocabulary.mjs:7) has no
third tier. v3.7.7 must freeze as portable-sealed development, or Phase 8 first mints a
`portable_certified` mode with native/visual as permanent DECLARED EXCLUSIONS (not waivers).

- **P8.0 (new, prerequisite)** — mint portable_certified in PACKAGE_MODES; split REQUIRED_EVIDENCE
  into portable-required vs permanently-excluded. Without it P8.1/P8.7/P8.8 are dead ends.
- **P8.1** GAP (partial-strong): determinism ingredients good (ES-scanner closure
  release_js_import_scanner.mjs:101; dynamic-import refusal :375-379; two-way allowlist gate
  :413-431; commit-date timestamp :288-310; canonical ustar, zeroed mode/uid/gid/mtime,
  release_package_attestation.mjs:102-144). MISSING: the A/B package itself — nothing builds from
  two clean checkouts and compares; no smallest-difference report. Manifest binds commit/tree/closure
  but NOT contract v2 / golden / support-envelope 3.7.7 (envelope_version referenced NOWHERE in the
  compiler) / toolchain hashes (only nodeVersion + python basename inside smokeTest :1879-1995).
  96 of 114 allowlisted assets are declared_only — shipped+hashed, never proven loaded.
- **P8.2** GAP: attestation chain stops at the archive. (a) TWO runtime-closure definitions
  (compile_skill_release.mjs:1094-1128 vs runtime_isolation.mjs:779-818), no test they agree;
  (b) active_runtime_code_closure (source_identity.mjs:205-222) computed, consumed by NOTHING;
  (c) assertCertifiedProductionIdentity (:224-250) zero production callers; (d) publication.json
  (orchestrate_release.mjs:1313-1335) carries no input hashes / IR hashes / source commit / run id;
  (e) workbook "BUILD IDENTITY / QUALITY" panel (build_dynamic_model.mjs:2552, :1425-1470) contains
  no build identity; (f) no standalone custody-receipt verification CLI; (g) ownership census pins
  release_identity as a FIVE-writer family, target owner "Release/package compiler (Phase 8)".
  **Cheapest high-value close (P3.5 precedent): the closure-convergence slice — one closure
  definition, make active_runtime_code_closure load-bearing (~50 lines).**
- **P8.3** EXCLUDED (Rogo install/active-pointer). Portable remainder that must still land: install
  contract, release journal, runtime doctor; only installed-host registry item is permanently
  BLOCKED custody ($INSTALLED_HOST_BROKER_RECEIPT).
- **P8.4** EXCLUDED (two fresh Rogo sessions). Honest substitute exists and is strong: runSmokeTest
  (:1509-1841) — clean temp root, node_modules ancestry refusal, NODE_PATH/PYTHONPATH strip,
  39 JS + 29 Python entry points, real case → workbook → independent validation. Achievable P8.4:
  two fresh PORTABLE clean-root sessions with A/B outcome comparison — does not exist.
- **P8.5** EXCLUDED entirely; PASS_PENDING_MANUAL / PENDING_NATIVE_EXCEL_AND_VISUAL_REVIEW
  (:1810-1821; orchestrate_release.mjs:1352, exit 0 :1433) is the PERMANENT terminal state of the
  physical lane — the freeze must say so once, explicitly.
- **P8.6** installed half EXCLUDED; portable half greenfield+cheap: rollback runbook, retained
  previous-known-good package, run package-pinning policy, evidence-preservation rule. grep rollback
  → only the enum + linter field. ReleaseCheckpointStore is per-RUN resume, NOT release rollback.
- **P8.7** GAP: validateReleaseCertificationEvidence (release_certification.mjs:385-448 + CLI) is
  real and hash-bound — and unsatisfiable (2 of 7 evidence classes are the excluded native ones).
  No evidence/release_v377/ dir; audit/ stops at v375. No waiver/exclusion register, no approvals.
  Re-specify the dossier around a portable gate set with the exclusions declared permanent.
- **P8.8** GAP (largest): nothing creates/verifies/defends a release tag; post-tag mutation
  invalidation depends on certified_runtime_code_closure_sha256 ABSENT from runtime-manifest.json
  (so non-development compile throws by design :1148-1189 — only --development reachable);
  programme/checkpoints/ absent (Phase 0/1 sealed as prose); index current_phase stale.

## Version-contract flip defect (own package-let)
skill_version 3.7.6 enforced by FOUR hard-coded literals with no enumeration test:
run_runtime_version_contract_tests.mjs:18, run_source_identity_tests.mjs:22-23 (+display string),
run_release_identity_governance_tests.mjs:35, run_governance_evidence_tests.mjs:46. The corpus
already immortalises this failure ('3.7.6' !== '3.7.5', corpus_manifest.json:113-115). Centralise
(read the manifest once, one declared expected version) BEFORE the 3.7.7 flip. Also stale:
KNOWN_LIMITATIONS.md:1 says v3.7.5 and is governance-required (release_identity_governance.mjs:63).

## CI-gate findings
- All eight Phase-8 suites are phase:"proof" → ONE matrix lane (owner release-proof).
- programme-control suite has NO phase → runs only in portable-serial/custody-inventory.
- Committed CI receipts stale and unchecked: ci/exact_head_gate_report.json pins 431ef3e;
  ci/test_registry_census.json pins one-commit-behind; CI never compares its census to the
  committed copy.
- run_current_package_source_identity_check.mjs:24 refuses dirty worktrees — freeze precondition.
- classifyCiIdentityRoles (release_identity_governance.mjs:88-122) good; validateIdentityConvergence
  (:12-70) validates a record NOTHING produces.

## Sequencing
P8.0 → P8.2-identity-convergence → P8.1-A/B → P8.7-portable-dossier → P8.8-tag+seal → v3.8 branch
origin receipt (P9 entry). P8.6-portable parallel/cheap. P8.3/P8.4/P8.5 + installed P8.6: EXCLUDED,
record once.

## v3.7.7 FREEZE criteria (14 items; enforcement today)
1 phase checkpoints as programme/checkpoints/phase_N.json + validator — NO (dir absent)
2 index open_blockers empty + card per sealed package — PARTIAL (cards yes, blockers no)
3 clean worktree; HEAD==candidate==package source — YES
4 A/B byte-identical from two clean checkouts — NO
5 package binds contract/golden/envelope-3.7.7/toolchain hashes — NO
6 active closure == package closure asserted at run start + delivery — NO
7 workbook carries release+run id; custody receipt independently verifiable — NO
8 portable dossier PASS, native/visual permanent declared exclusions, zero waivers — NO
9 version flip at ALL FOUR tripwires + KNOWN_LIMITATIONS retitle, one commit — NO (no enumeration test)
10 immutable tag bound to source+inventory+archive+dossier shas — NO
11 post-tag mutation invalidates certification — NO (manifest lacks the field)
12 rollback package retained; run pinning policy — NO
13 committed CI receipts regenerated at seal commit, asserted == HEAD — NO (stale)
14 v3.8 branch from the tag with origin receipt — NO

## What Phases 9–10 need from Phase 8
1. Freeze the ACTUAL Phase-3 IR object into the tag (P9.4/6/7 diff target) — no Economic IR exists yet.
2. Universal old/new dual-run harness (equivalence harness is case-compiler-only; custody run is the
   pinned KNOWN RED 55/90/1 — freeze those totals into the tag as declared baseline).
3. Seal the ownership census at the tag (P9.1 re-census becomes a diff, not an opinion); no size
   budget / dependency-direction rules / ADRs exist yet.
4. Freeze decomposition-target sizes in the checkpoint: build_dynamic_model 12,787 · row_plan 4,783 ·
   case_compiler 4,190 · validate_dynamic_model 3,233 · solver 3,166 · evidence_run 3,044
   (total scripts/**/*.mjs = 119,328 lines).
5. P9.8 inherits the two-closure/five-writer debt — converge in P8.2, strictly cheaper.
6. Deletion-register seed: five ORPHANED scripts already deferred to Phase 9 by
   run_ci_census_tests.mjs:59-72, plus the 96 declared-only assets.
7. Phase 10 rings/promotion/active-pointer have no substrate with the installed path excluded —
   scope Phase 10 to the portable/staging tier NOW (record in P8.8).
