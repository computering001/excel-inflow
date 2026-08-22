# D52 Findings Closure Summary

<!-- generated-document:d52-closure-summary/1.0 BEGIN -->
<!-- DERIVED DOCUMENT: every claim below is generated from audit/v379/d52-closure-ledger.json and commit-to-finding-map.json. -->
<!-- Writer: node scripts/generate_d52_closure_summary.mjs -->
<!-- Read-only check: node scripts/generate_d52_closure_summary.mjs --check -->
<!-- Do not hand-edit. Drift remedy: change the authoritative JSON evidence, then run the writer. -->
<!-- generated-document:d52-closure-summary/1.0 END -->

- **Ledger:** [`audit/v379/d52-closure-ledger.json`](./d52-closure-ledger.json) (`excel-inflow-d52-closure-ledger/1.0`)
- **Source map:** [`audit/v379/commit-to-finding-map.json`](./commit-to-finding-map.json) (`excel-inflow-commit-to-finding-map/1.0`)
- **Ledger SHA-256:** `eff1f1e968dc47b7b8a71df967bf5c1a1174e712e6413b2c3ec3328808d3a5f5`
- **Ledger generated at:** `2026-08-21T13:42:08Z`

## Result

| Status | Count |
| --- | ---: |
| Closed | 23 |
| Custody-deferred | 5 |
| Open | 0 |
| **Total** | **28** |

These counts are a projection of all 28 ledger findings; they are not an
independent closure claim. The source map's audited base is
`e8eb91f958e1f7c12007a27ffd01be159799772f`.

## Commit verification

| Role | SHA | Subject | Verified in history |
| --- | --- | --- | --- |
| implementation commit | `d5eea9dee3d6bb04fb7908f64c414f065331809e` | harden Excel Inflow v3.7.9 candidate | yes |
| exact head fixture commit | `07779c751d6c41c01d3be3ed7c6defe237382fe4` | fix exact-head release smoke fixture | yes |
| head containing map | `eba52045b238d2777167ee0025476728cae00e0a` | document v3.7.9 candidate audit mapping | yes |

Principal paths for every work package were checked at the implementation commit via git cat-file; all resolved except RELEASE_NOTES.md, which was added by the map-bearing commit listed under work package 8 (consistent with that package's commit list).

## Custody-deferred findings (5)

1. **`inline_xbrl_host_unproven`** — Probe module and its synthetic test suite are verified locally, but the capability claim itself requires execution on an installed inactive-slot host (map external_evidence_required: 'inactive-slot installation receipt', 'installed-host black-box matrix'). No such host is available to this closure pass.
2. **`committed_self_attestation`** — Exact-head CI machinery is verified locally via synthetic suites, but genuine closure requires a real GitHub Actions exact-head run binding external evidence ('GitHub Actions exact-head run and artifact hashes' per map external_evidence_required); no hosted run exists yet.
3. **`untruthful_exact_head_gate`** — Gate compiler/verifier scripts verified locally; final proof requires the actual hosted exact-head CI run whose receipts the gate now projects ('GitHub Actions exact-head run and artifact hashes' per map external_evidence_required).
4. **`package_reproducibility_unproven`** — Double-build comparison tooling verified locally; reproducibility is only proven by a real hosted double build producing matching archive identities ('final reproducible package identities' per map external_evidence_required).
5. **`mutation_measurement_omission`** — Mutation-measurement receipt projection verified locally against synthetic inputs; authoritative survived-mutant measurement must come from the hosted exact-head mutation job ('GitHub Actions exact-head run and artifact hashes' per map external_evidence_required).

## Closure policy

- **Closed:** Mapped commit verified in history AND every mapped proof suite resolves to a registered assets/development-test-registry.json entry or an in-repo verifier/runner script; the remediation is demonstrable entirely within the repository.
- **Custody-deferred:** Local remediation tooling verified as above, but the finding asserts a fact about an environment this repository/workstation cannot produce (hosted GitHub Actions exact-head runs, installed-host receipts); recorded honestly instead of claiming closure.
- **Open:** A mapped commit is absent, a mapped proof suite cannot be resolved to any registry entry or script, or verification otherwise fails.
