# Portable release certification dossier — v3.7.7

Minted by P8.7. Regenerate or re-check it with:

```
node scripts/assemble_release_dossier.mjs --plan evidence/release_v377/assembly-plan.json
node scripts/assemble_release_dossier.mjs --verify
node scripts/validate_release_certification.mjs \
    --manifest evidence/release_v377/portable-certification-manifest.json \
    --closure-hash <runtime-code closure> --tier portable_certified
```

## What this directory is

| file | what it is |
| --- | --- |
| `dossier-assembly-receipt.json` | the dossier. Per-class disposition, the declared exclusions, the waiver verdict, the approval expiry model, and the certification receipt (or the refusal to produce one). Every artifact it names is bound by a SHA-256 that the assembler computed from the bytes itself. |
| `assembly-plan.json` | what the dossier CLAIMS, class by class, as input to the assembler. Carries no digests — a digest can only be computed, never declared. |
| `waiver-register.json` | the waiver-register verdict: `DECLARED_UNNECESSARY_ZERO_WAIVERS`, with the closed-case argument for why a populated register would have no legitimate subject. |
| `blockers/` | the captured, hash-bound evidence that each typed absence is real: a refusal transcript, a host pre-flight report, a companion-input probe. |
| `approvals/` | approval documents. Empty until a named human approves; see `approvals/README.md`. |
| `release-journal.jsonl` | the approvals record — P8.6a's hash-chained append-only release journal, reused. Absent while there are no approvals, which `readReleaseJournal` already reports as zero records rather than as an error. |
| `portable-certification-manifest.json` | the P8.0-contract manifest the certification validator reads. **Written only when all five portable-required classes are satisfied.** Absent today, deliberately. |

## Current state

`ASSEMBLED_NOT_CERTIFIABLE`. All five portable-required evidence classes are
TYPED ABSENCES, each hash-bound to the captured block, each carrying a reason
and a revisit condition. No certification manifest exists, so **no portable
certification exists for this tree** — and `assemble_release_dossier.mjs` exits
non-zero to say so, in case a caller reads exit 0 as "certified".

That is a refusal, not a soft pass. The three things it is NOT:

- It is **not** a waiver. Nothing here permits certification to proceed without
  the evidence. See `waiver-register.json`.
- It is **not** an exclusion. The two native-host classes (`native_excel`,
  `visual_review`) are PERMANENT declared exclusions with `revisit_condition:
  null`; these five are producible classes with real revisit conditions.
- It is **not** silence. Each absence names the earliest layer that blocked it,
  and cites bytes proving the block fired.

## Reading it honestly

Two facts about the tree this was assembled from, both recorded in
`identity` on the receipt rather than smoothed over:

- `worktree_clean: false` — this dossier was assembled in a worktree shared with
  concurrent work packages. A dossier claiming `CERTIFIABLE` from a dirty
  worktree is refused by the validator; that check is live, it simply is not the
  thing blocking today.
- `runtime_code_closure_identity_source` — the closure identity comes from
  `resolveActiveSourceIdentity` over live bytes, not from the release compiler's
  deployment-profile closure. The Phase-8 work order records that the two
  closure definitions have never been proven equal. Until P8.2's
  closure-convergence slice lands, this dossier's closure must not be asserted
  to be a package's closure.

The `blockers/` transcripts record the commit at which each block was captured.
On a frozen tree that commit and the receipt's `source_commit` are the same
value; in a shared worktree they can differ by whatever concurrent packages
committed in between, and both values are recorded rather than reconciled.
