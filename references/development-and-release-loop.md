# Development and release loop

## Purpose

Development and release are different control regimes. Development must be fast
enough to run cohorts and find architectural patterns. Release must be exhaustive
enough to prove a frozen candidate. Mixing them made every small repair trigger
slow packaging, router, golden and certification work before the economics had
been proved.

## Authority hierarchy

1. The two hash-pinned standardised workbooks govern physical design.
2. `references/model-intent.md` governs product economics and flexibility.
3. The normalized case and semantic graph govern issuer-specific content.
4. The local source tree governs development.
5. Generated workbooks, old goldens and installed candidates are evidence, not
   source authorities.

Never edit an authority during repair. Never copy an output defect back into a
contract merely because the reference workbook contained it.

## Four execution modes

### 1. Read-only diagnosis

Inventory exact sources, versions, digests and evidence. Reproduce the failure
and assign it to one class:

- product economics;
- normalization or evidence mapping;
- semantic compiler or renderer;
- test fixture;
- independent validator;
- runtime or environment; or
- release/install process.

Do not mutate the model or skill in this mode.

### 2. Lean development

Use `scripts/run_development_gate.mjs`. It runs only local, deterministic test
layers and never compiles, installs, promotes, updates goldens, opens Excel or
invokes release governance.

```text
node scripts/run_development_gate.mjs \
  --profile portable \
  --phase workflow,evidence,forecast \
  --cases <v2-case-directory> \
  --representative <representative-compiled-case.json> \
  --fixed-point-cases-manifest <external-case-manifest.json> \
  --out <development-evidence-directory>
```

`--profile portable` selects every registry test that does not require an
external custody input. `--profile custody` selects every test that requires a
broker corpus, real pack, fixed-point manifest, raw canary, real-filings pair or
installed-host receipt. Omitting the profile selects both partitions. The
partition is derived from each test's declared `requires` list; it is never a
second hand-maintained test inventory.

Every report binds the source commit, dirty-worktree state, registry SHA-256,
selected-test-set SHA-256 and the SHA-256 of each supplied input. Commands,
paths, stdout and stderr are replaced by byte counts and hashes so protected
corpus details cannot enter CI artifacts. Use
`scripts/aggregate_development_gate_reports.mjs` to prove exact-once coverage
for one partition or for the joined portable and custody reports. The aggregate
fails on missing or duplicate IDs, source or registry drift, a dirty source
tree, or any non-PASS test.

The installed-host broker seam requires
`installed-host-broker-canary/2.0`. Its verifier resolves active source,
package, deployment and installation identity, recomputes the raw-PDF,
model-host-response and workbook hashes from contained regular artifacts, and
joins every selected source cell exactly once to workbook consumption. A v1,
self-asserted or path-escaping receipt is not certification evidence.

Phases come from `assets/development-test-registry.json` and are the only
selector the gate accepts:

- `workflow`: state contract, intake, question flow, fixed-point constitution;
- `evidence`: broker/DCS/filings controllers, degraded-close and carrier
  migration, attachment ingress, broker preview gate;
- `graph`: equation graph, SCC and layered-graph constitution;
- `forecast`: behavior, observation ledger and topology;
- `economics`: instrument state, opening debt, value semantics;
- `cohort` / `proof` / `real_corpus`: cohort keel, delivery proof and external
  real-corpus suites (the latter BLOCK without their custody inputs);
- omit `--phase` to run every phase.

The command writes one report with command, duration, status, exit code and
captured output for every gate. Missing required inputs are `BLOCKED`, never
silently skipped. A development failure is useful evidence; it does not trigger
a release transaction.

### 3. Frozen cohort repair

1. Freeze case files, seeds, authority hashes and current source digest.
2. Run the full selected cohort without editing.
3. Record all failures before touching source.
4. Cluster by earliest broken graph edge or module contract.
5. Reject fixture defects and environment defects from the product-fix queue.
6. Select one bounded repair cluster.
7. Declare expected-to-move and expected-unchanged nodes.
8. Repair the earliest responsible source layer.
9. Add a positive test and targeted mutation.
10. Rerun affected cases plus one sentinel for every adjacent module.
11. Re-run the whole frozen cohort after all clusters close.
12. Rebuild twice from clean directories and compare semantic output.

The frozen-cohort report is always labelled
`AUTOMATED_DEVELOPMENT_EVIDENCE_ONLY` with release readiness not evaluated.
Never collapse its case count into a production-pass claim: native Excel,
exact authority replay, visual review, source parity and mutation sensitivity
remain separate release evidence.

Do not repair between cases inside the initial cohort run. Do not add an issuer
name, case ID, physical row or output-cell exception.

### 4. Release certification

Release begins only after the frozen local cohort is clean. Run, in order:

1. full physical-authority validation;
2. independent economic/formula/provenance validators;
3. deterministic clean builds;
4. render and visual comparison;
5. authoritative native Excel control restoration;
6. golden regeneration from the now-frozen source, twice;
7. assemble one hash-bound certification-evidence manifest for exact authority
   replay, rendered pages, screenshots, native Excel, finance mutations and
   source parity;
8. minimal package compilation and a real clean-root case compile, workbook
   render and independent validation smoke;
9. exact release manifest and closure digest, recorded only when steps 7-8 are
   bound to that digest and pass;
10. versioned candidate installation without overwriting rollback;
11. fresh-session installed identity and active-pointer verification, without
    starting a company run or building a workbook;
12. explicitly authorised installed behaviour parity and any native Excel
    review as a separate post-install gate; and
13. one explicit production promotion.

## Development gate selection

Run the smallest scope that covers a local change, plus sentinels:

| Changed layer | Primary scope | Required sentinels |
|---|---|---|
| Schema or contracts | `contracts` | `workflow`, one economics case |
| Intake, coverage or questions | `workflow` | `contracts`, one economics case |
| Solver or economic graph | `economics` | `contracts`, one workflow case |
| Row plan or renderer contract | `economics,authority` | `contracts` |
| Design contract or styling | `authority` | `contracts`, one economics case |
| Release compiler only | clean-root compiler smoke | Frozen cohort digest unchanged |

Heavy native Excel, full renders, goldens and installation are not development
sentinels. They run at the representative-workbook and release phases.

The workflow scope includes the unattended six-milestone user-journey suite. It
must prove clean no-question delivery, one consolidated question round,
deterministic multi-round batching when more than five decisions survive,
broker-preview confirmation and stale-confirmation rejection, defective
evidence stops, simulated answers, ASCII screen limits, hash-bound checkpoint
integrity, fresh-session replay, timeout resume, targeted invalidation and
whole-journey determinism. The suite supplies its own answers and must never
wait for a person.

The timeout claim requires the real Stage-4 checkpoint test, not only a
simulated receipt chain. `scripts/run_stage4_checkpoint_tests.mjs` delays the
LibreOffice boundary, forces the production shell to time out after completed
semantic, plan and emit receipts exist, resumes the same run, and proves those
receipts are reused. It also removes one completed output, proves only that
checkpoint re-executes when the rebuilt bytes are identical, and then proves an
identical replay reuses all five user stages. The report must state zero total
violations.

The `economics` scope also runs the permanent forecast-authority cohort. It
must prove, from one representative v2 source case, all five non-standard paths:
PBT-to-EBIT reverse bridge, net-income/tax reverse bridge, segment-profit
consolidation including an issuer-specific impairment, FCF-to-CFO reverse
bridge, and direct-method CFO. Every path is tested with circularity on, off and
restored on. A future change that silently reintroduces EBITDA as a mandatory
forecast authority therefore fails the lean gate before workbook certification.

The installed instrument-period compiler contract can also be replayed directly:

```text
node scripts/run_instrument_period_state_tests.mjs
```

It proves one state for every semantic instrument and each of the three forecast
periods, exact definition-basis graph ownership, amount-basis FX treatment,
lease separation, RCF discretion, row-order invariance and non-vacuous double-FX
and mandatory-RCF mutations.

The semantic and economic graphs are release inputs, not explanatory diagrams.
The layered constitution must close evidence, statement, forecast, economic
equation and physical row-plan ownership with one writer per node and a sealed
hash per layer. The fixed-point constitution must independently prove that the
case-semantic cash-flow start, cash, RCF and finance nodes form exactly the
declared on-state SCC, that breaker mode removes the SCC and zeros every
model-generated finance role, and that debt, maturity, cash and liquidity
mechanics remain live. A converged workbook with an undeclared edge or cycle is
a failed candidate.

The product constitution and its joined run graph have standalone executable
sentinels:

```text
node scripts/run_product_constitution_tests.mjs
node scripts/run_run_constitution_graph_tests.mjs
```

The first proves the causal `LOG / DEGRADE / ASK ONCE / BLOCK` matrix and that
broker-only faults cannot become delivery blockers. The second proves exact
model-demand coverage, one selected authority per demand node, source-to-model
reachability and hash-bound graph closure. Both are required whenever evidence
criticality, authority selection, blocker policy or the visible journey changes.

A gate that reads workbook geometry — section rows, sheet spans, zone extents,
row counts — must ship with a positive test on at least one EXPANDED and one
CONTRACTED synthetic shape, never on the standardised exemplars alone. Both
production-blocking geometry gates to date failed the same way: green against
the exemplars from birth, wrong on the first real issuer, because the
exemplars are exactly the one shape a company never has. The two standardised
fixtures are the anchor of the design lattice; they are not a sample of the
world.

## Failure and repair records

Every failure record names:

- case and immutable input digest;
- expected and actual result;
- earliest responsible layer;
- whether it is product, fixture, harness, environment or release process;
- affected graph nodes and modules;
- expected-to-move and expected-unchanged outputs;
- chosen repair and why it is general; and
- evidence that closes it.

If the same underlying failure recurs in more than one case, stop serial repair
and raise the cluster to an architectural change. If a repair causes a new
violation, revert the candidate change or isolate it before continuing.

## Promotion semantics

These terms are not interchangeable:

- **compiled:** package written from a frozen source;
- **installed candidate:** versioned files exist in the target environment;
- **active candidate route:** test chats resolve to that candidate;
- **production promoted:** the user explicitly authorised the final route after
  parity evidence;
- **rollback:** prior exact route and files remain available.

No prompt or script may infer production promotion from installation. A route
switch must be declared, hash-read back from a fresh session and separately
recorded from final promotion.
