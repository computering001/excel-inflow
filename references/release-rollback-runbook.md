Release rollback runbook (P8.6a, portable half)

A release rollback is a declared, executable, evidence-preserving procedure. The
machine-readable authority is `assets/release-rollback-policy-v1.json`
(contract: `assets/release-rollback-policy-v1.schema.json`). This runbook is the
human path through it and adds nothing the policy does not declare. If the two
ever disagree, the policy asset and its validator win.

Nothing here mutates a live install. The installed-host leg is permanently
EXCLUDED, not deferred: the three clauses `active_pointer_repoint`,
`installed_identity_readback` and `post_rollback_installed_parity` are marked
`EXCLUDED_INSTALLED_HOST` in the policy, carry no procedure steps, and are never
counted as a portable-gate pass. Do not attempt them from this repository and do
not report a rollback as complete on the strength of them.

## What this is not

Release rollback is not per-run resumability. The `rollback_is_not_run_resume`
clause exists because the two were repeatedly conflated: the checkpoint receipts
in `scripts/lib/release_checkpoint_store.mjs` resume ONE RUN from that run's own
artefacts and say nothing about which package is the release. Only the release
journal says that.

## Before you can roll back anything

The `retained_previous_known_good` clause is a precondition of promotion, not a
reaction to failure. Before promoting any package:

1. Confirm the outgoing package's deterministic archive, its external
   release-package attestation and its release manifest are retained outside the
   package directory and are readable.
2. Append a `retain` journal record carrying that package's full identity block.
   The validator refuses a rollback whose target has no earlier `retain` record —
   an unretained release has no rollback.

## Procedure

1. **Name the trigger.** `trigger_conditions` declares the only conditions that
   open a rollback, each with the mechanism that detects it. Capture that
   mechanism's own output as the trigger finding and write it to the rollback
   evidence directory first. If nothing on the list matches, stop: fix forward,
   or add a trigger to the policy and bump `policy_version`.

2. **Get authorisation.** `authorisation` allows exactly one authoriser — the
   human release owner. Automation may detect, assemble and record; it may never
   decide. Open an issue card naming the trigger, the identity being withdrawn
   and the target identity, and cite it from the journal record. A rollback
   record with an automation actor is refused.

3. **Prove the target.** `rollback_target_identity` requires one exact package
   identity in `product-identity/2.0` terms. Run
   `verifyRollbackTargetAttestation` from `scripts/lib/release_journal.mjs` over
   the retained package root, its attestation and its archive, passing the
   runtime-code closure digest you intend to return to. It wraps
   `verifyReleasePackageAttestation`, so the target rides the same
   source -> inventory -> archive chain as any release. Verdict not PASS means
   there is no rollback: the retained bytes moved, the archive disagrees, or the
   attestation binds a different closure.

4. **Decide the in-flight runs.** `in_flight_run_package_pinning` is the pinning
   rule: a run's package identity is resolved once at run start
   (`resolveActiveSourceIdentity` in `scripts/lib/source_identity.mjs`) and is
   immutable for the life of that run. A rollback never re-points an in-flight
   run. Default is `pinned_continue`. Stop a run only when the trigger makes its
   output untrustworthy, and stop it with the already-registered
   `CANCELLED.user_or_system_stop` reason — checkpoint-required and
   evidence-preserving. No new reason code is minted for a rollback. Record every
   in-flight run, with its disposition, in the rollback record.

5. **Preserve the evidence.** `evidence_preservation` marks five never-delete
   classes: the withdrawn package's bytes and attestation, the target's bytes and
   attestation, the trigger finding, the release journal itself, and the run
   artefacts of every in-flight run. Copy the withdrawn package's archive and
   attestation into the rollback evidence directory before recording the
   withdrawal. Nothing is deleted to make a rollback tidy; a superseded artefact
   is retired with a `supersede` record, never by removal.

6. **Record it.** Append the rollback record last, via
   `appendReleaseJournalRecord` in `scripts/lib/release_journal.mjs`. Per
   `deployment_status_transitions`, the record's `release` block is the WITHDRAWN
   package and its `deployment_status` must be `rollback`; the target goes in
   `rollback.to` and is not restamped. A withdrawn closure may never appear in a
   later `promote` record — fix forward with a new compile instead.

7. **Stop here.** Steps 8-10 of the installed path (re-point the active route,
   read the installed identity back from a fresh session, run installed
   behaviour parity) are the EXCLUDED_INSTALLED_HOST clauses. On the portable
   tier the rollback is complete when the journal record is appended and the
   evidence is preserved. Say that, and do not imply a live route changed.

## The journal

`release_journal_record` governs it: one append-only record per
release-affecting event (`compile`, `attest`, `tag`, `retain`, `promote`,
`rollback`, `supersede`), one canonical JSON object per line in
`release-journal.jsonl`, contract `assets/release-journal-v1.schema.json`.
Records are hash-chained the same way the user-flow stage receipts are:
`record_hash` is the canonical digest of the record body with `record_hash`
removed, `previous_record_hash` is the preceding record's hash, and sequence 0
opens the chain with `null`. Every record carries the digest of the policy in
force, so a policy edit is visible on every record sealed after it.

Appends are lock-serialised, written with O_APPEND, fsynced, then byte-prefix
verified. Consequences to expect:

- A journal that does not validate cannot be appended to. Repair it by
  declaration — a later record that says what was wrong — never by rewriting.
- A record edited, reordered, deleted or forked after sealing is caught by the
  chain, not repaired.
- A rollback with no attestable target is refused before any bytes are written.

## Verification

`node scripts/run_release_rollback_policy_tests.mjs` proves the policy is
complete against the code-declared clause contract, that the exclusions are
declared rather than claimed, and that the journal is well-formed, chained and
append-only — including that a missing clause, an out-of-chain record and an
unattestable target are each refused.
