# Phase 0 checkpoint — Freeze, evidence custody and programme control

Status: **PENDING FINAL RECEIPT** — every package sealed; this checkpoint
finalises when the authoritative gate run at the current head concludes
green and its receipt is recorded below.

## Source identity

- Evidence baseline: `433bd237b73e15bc844d5cd64175f0758ebe1d9f` (tree `d9c9fa56…`), immutable tag `excel-inflow-v376-evidence-baseline`
- Closure branch: `agent/excel-inflow-v377-behavioural-closure`
- Phase 0 seals: P0.1 `6a64f74` · P0.2 `af51edc`+`431ef3e` · P0.3 `9b8b646`+`7743229`+`6a96ecf` (tripwire family) · P0.4 `ecccef5` · P0.5 `e937a18` · P0.6 `dfb17e7` · P0.7 `df91663`
- Working tree at each seal: clean (issue cards record per-package status)

## Phase 0 invariants — proof state

1. *Every result ties to one exact source commit/package identity/raw-input hash set* — P0.1 receipts + archive sha `422fea6b…`; PASS.
2. *Every known blocker reproduces deterministically or is classified non-reproducible with missing evidence named* — P0.2 corpus (6 cases, hash-bound, tamper-refusing); AZ evidence gaps named; heavy replays since EXECUTED: AZ equivalence clean (0 diffs), Apple canary DELIVERS with the canonical donor. PASS.
3. *A failed critical test makes the authoritative CI gate fail* — live red-canary proof (run 32270208703: 4 failed lanes, aggregate skipped); four stale tripwires + audit census repaired; three further head failures surfaced by the truthful gate and repaired (portability path, canary donor pin, stage4 floor-vs-explicit-budget). PASS pending the final green receipt below.
4. *Every possible terminal reason has an owner and a legal terminal-state mapping* — P0.5 registry (15 codes, category firewall, migration map, 228 checks). PASS.
5. *No engineering task begins without an issue card and rollback point* — P0.6 templates + index + 37-check linter (handover freshness enforced). PASS.

## Tests executed at seal (local ladder, all exit 0)

registry contract 755 · ci-census 309 · blocker corpus 79 · programme-control 41 · ownership-census (469 sites/49 files) · support-envelope 87 · terminal-reason 228 · identity-governance · governance-evidence · version-contract · source-identity · oracle matrix (1.0 detection) · filings 43 · user-flow 14/14 · classifier · tax 24 · deadline 17 · stitch 19 · stage4 kill/resume · portability · canary-fixture custody · equivalence (0 diffs) · canary DELIVERS (PASS_PENDING_MANUAL)

## Corpus cases executed

AZ equivalence (clean) · Apple raw canary (delivered) · ETR policy (24) · deadline (17) · package identity (green) · WC decisions replay (children-owned)

## Known remaining defects

- None red at head after the stage4/pin/portability repairs (final green receipt pending).
- Documented latent (not red): build_dynamic_model.mjs ~9020 plan-path grey-fill read-back; validateJsonSchema had no oneOf/anyOf until P1.4 (now enforced); orphaned scripts named in ci/test_registry_census.json for Phase 9 disposition.

## Rollback point

Tag `excel-inflow-v376-evidence-baseline`; every package seal is an atomic commit on the closure branch.

## Phase 1 prerequisites — met

Sealed baseline ✔ · contract toolchain decision (P1.1, repository-owned IDL) ✔ · JS+Python producer access ✔

## Final gate receipt

- Canary-red proof: https://github.com/computering001/excel-inflow/actions/runs/32270208703 (lanes failed, aggregate skipped — cannot present green)
- Head-green receipt: _pending — recorded on conclusion of the run at the current head_

Approval: engineering-model seal; user owns merge/rollout decisions.
