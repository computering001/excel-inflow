# D52 Findings Closure Summary

- **Ledger:** [`audit/v379/d52-closure-ledger.json`](./d52-closure-ledger.json) (`excel-inflow-d52-closure-ledger/1.0`)
- **Source map:** [`audit/v379/commit-to-finding-map.json`](./commit-to-finding-map.json) (`excel-inflow-commit-to-finding-map/1.0`)
- **Generated:** 2026-08-21 (UTC)

## Result

| Status | Count |
| --- | --- |
| Closed | 23 |
| Custody-deferred | 5 |
| Open | 0 |
| **Total** | **28** |

Every one of the 28 findings from the post-audit register was checked against
history and the in-repo proof inventory. No finding is open: each mapped commit
exists and each mapped proof suite resolves to a registered
development-test-registry entry or an in-repo verifier script.

## Commit verification

| Role | SHA | Subject | Verified |
| --- | --- | --- | --- |
| Consolidated implementation | `d5eea9de` | harden Excel Inflow v3.7.9 candidate | yes |
| Exact-head fixture correction | `07779c7` | fix exact-head release smoke fixture | yes |
| `HEAD_CONTAINING_THIS_MAP` (WP8) | `eba5204` | document v3.7.9 candidate audit mapping | yes |

The placeholder `HEAD_CONTAINING_THIS_MAP` used by work package 8 resolves to
`eba5204`, the commit introducing the finding map itself. Principal paths for
all eight work packages were spot-checked at `d5eea9de` with `git cat-file`;
all resolved except `RELEASE_NOTES.md`, which was added by `eba5204` — the very
commit WP8 lists, closing `candidate_release_notes_missing`.

## Proof-suite resolution

Most suites match a `development-test-registry.json` test id exactly
(`public-bootstrap`, `runtime-doctor`, `disk-space-policy`,
`disk-space-measurement-builder`, `runtime-compatibility`,
`installed-filings-capability`, `libreoffice-workbook-capability`,
`installed-inline-xbrl-capability`, `installed-capability-independent-oracle`,
`installed-capability-receipt-v13`, `screen-session-one-use-binding`,
`phase3-runtime-session-integration`, `packaged-path-acceptance`,
`skill-version-declaration`). Five map labels are aliases of registered ids:

| Map label | Registered test id |
| --- | --- |
| `user-flow` | `production-user-flow` |
| `runtime-mode` | `runtime-mode-derived-installed-identity` |
| `ci-governance` | `ci-governance-read-only` |
| `exact-head-package-ci` | `independent-exact-head-package-ci` |
| `exact-head-ci-job-receipt` | `exact-head-ci-job-receipt-projection` |

`v378-preservation` has no registry entry and is evidenced by the standalone
verifier `scripts/verify_v378_preservation.mjs`.

## Custody-deferred findings (5)

These are recorded honestly rather than closed: their remediation tooling is
verified locally, but the finding asserts a fact about an environment this
workstation cannot produce.

1. **`inline_xbrl_host_unproven`** (WP4) — needs an installed inactive-slot
   host run (installation receipt / installed-host black-box matrix).
2. **`committed_self_attestation`** (WP7) — needs a real GitHub Actions
   exact-head run binding external evidence.
3. **`untruthful_exact_head_gate`** (WP7) — needs the hosted run whose receipts
   the gate now projects.
4. **`package_reproducibility_unproven`** (WP7) — needs a hosted double build
   producing matching archive identities.
5. **`mutation_measurement_omission`** (WP7) — needs the hosted exact-head
   mutation job for an authoritative survived-mutant measurement.

These correspond to the map's `external_evidence_required` entries ("GitHub
Actions exact-head run and artifact hashes", "final reproducible package
identities", "inactive-slot installation receipt", "installed-host black-box
matrix"). They flip to closed when that custody exists.

## Attestation-gate compatibility

No repository script currently reads the finding map or a D52 closure ledger
(scanned `*.mjs` for `commit-to-finding-map`, `closure-ledger`, `D52`; the only
hit is a governance mutation string naming workflow job **"11 - All-needs
exact-head D52 attestation"**). That job (`final-aggregate` in
`.github/workflows/read-only-development-gate.yml`) compiles the all-needs
attestation purely from raw CI job receipts via
`scripts/compile_exact_head_ci_job_receipt.mjs` and
`scripts/compile_external_ci_evidence.mjs`; it does not consume this ledger, so
the ledger imposes no schema coupling on CI. Its shape is self-describing v1:
per-finding entries plus summary counts that always sum to the total, so a
future validator can enforce it without code changes. Wiring the ledger into
the attestation compiler would be a code-side change outside this pass's file
ownership.
