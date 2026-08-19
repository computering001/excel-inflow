# Programme control — v3.7.7 behavioural closure

This directory is the durable control surface for the finalisation programme
(the execution pack of 2026-08-19). A fresh model starts here, never from
chat memory.

- `index.json` — machine-readable current phase, active package, sealed
  packages, last green commit, open blockers, next gate, naming rules and the
  restricted-evidence policy. Update it as part of sealing every package.
- `templates/` — the seven control templates (issue card, invariant contract,
  phase checkpoint, fresh-model handover, three-strike diagnosis, regression
  case record, release certification). Copy, never edit in place.
- `P*.md` / `P*_micro_checkpoint.md` — sealed per-package evidence.
- `baseline_receipt.json` / `baseline_source_sha256.txt` — the frozen
  evidential baseline (P0.1).

Rules that bind every artifact here:

1. An issue card precedes any engineering edit; a package seals only with its
   completion receipt filled.
2. A handover is INVALID when its recorded commit is not the current source
   head — regenerate it rather than trusting a stale one.
3. Commits reference their work-package ID and invariant.
4. Restricted evidence is referenced by path + SHA-256, never copied in.

The linter (`scripts/run_programme_control_tests.mjs`, registered as
`programme-control`) enforces template presence, mandatory issue-card fields,
index freshness against sealed packages, and handover freshness.
