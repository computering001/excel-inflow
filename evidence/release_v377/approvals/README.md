# Approvals — none, and why

This directory holds portable-certification approval documents. It is empty.

That is not an oversight and not a pending automation task. **Automation may not
approve.** `APPROVAL_EXPIRY_MODEL.automation_may_approve` is `false`, and
`createPortableDossierApproval` refuses any actor whose `kind` is not `human`
with a real identity — the same discipline P8.6a set for the release journal:
automation records, humans authorise.

Two things therefore have to happen before a document appears here, in this
order:

1. The dossier reaches `assembly_status: CERTIFIABLE`. `--approve` refuses
   outright while any class is a typed absence, because approving incomplete
   evidence is exactly the waiver this tier does not admit.
2. A named human runs:

   ```
   node scripts/assemble_release_dossier.mjs --approve \
       --approval-id <id> --approver "<name>" \
       --statement "<what is being approved and on what evidence>" \
       [--validity-days N]
   ```

   which writes `<id>.json` here **and** appends one hash-chained record to
   `../release-journal.jsonl`. An approval document that is not in the chain is
   reported as not journalled and is never counted.

## Expiry

Two-dimensional, and an approval must survive both tests at the moment it is
read:

- **Clock.** `expires_at` is absolute, at most 90 days out, 30 by default. An
  expired approval is refused. It is never extended, re-dated or renewed in
  place — a lapse is closed by appending a NEW approval, so the lapse stays
  visible in the chain forever.
- **Subject.** Each approval binds the assembly receipt's file digest, the
  runtime-code closure and the certification tier. Reassembling the dossier
  changes the receipt digest, and every prior approval stops applying by
  identity even if its clock has not run out.
