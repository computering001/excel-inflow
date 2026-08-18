# Validation

Every gate here fails closed. A gate that cannot evaluate is a failure, never a
warning and never a pass. A check that degrades to a warning is worse than no
check, because it turns a hard failure into a green tick.

**Report a validator's exit status and its TOTAL violation count. Never report a
sub-metric.** Three separate agents once reported `FLATTENED_FORMULA: 2` while
the validator was exiting FAIL with four violations; a 24-cell defect stayed
hidden for hours because nobody printed the total.

**Never edit a contract, a schema, a style token, a validator or the exception
registry to make a check pass.** If a check fails, either the model is wrong or
the check is wrong, and deciding it is the check requires a human. A validator
may be widened by a human; it may never be narrowed by a machine.

## Order

Validate in dependency order:

1. scope and structure;
2. historical mapping;
3. operating forecast;
4. opening debt and debt roll-forward;
5. cash and RCF;
6. interest;
7. leverage and liquidity;
8. leases;
9. acquisition;
10. FX and predecessor combinations;
11. visual presentation.

Before the native Excel and visual gates, run the representative dynamic,
recursive-mutation and repeat-build suites. Repeat-build identity means the
semantic row map, solver output, visible values, formulas and styles are
identical. Raw package hashes need not match when fresh relationship or
threaded-comment identifiers are the only differences.

The second half of the pipeline — build, recalculate, patch, then reopen, render
and validate — is where the Python stages sit. The recalculate step is now a
**check on the emitter's own arithmetic rather than the source of it**, and on
the plan-only path it does not run at all; see *Where the cached values come
from* below before assuming a converter produced any number in the file. Steps 1
to 10 above are checked by
`verify/validate_dynamic_model.py`; step 11 is checked by
`render/check_render.py`, with `render/selftest.py` standing in for the checks
themselves wherever `soffice` is absent. Run the render stage on the patched
workbook, never on the pre-patch one: the patch stage is terminal, and a render
of the pre-patch file measures a workbook nobody will open.

The portable Stage-4 controller checkpoints semantic gates, plan, emit,
recalculate/patch, independent verification, render and publication separately.
A checkpoint may be reused only after its receipt and every declared output are
rehash-verified. A timeout-resume claim is valid only when a real killed build
has reused its completed checkpoints and produced the same delivered workbook;
constructing a shorter receipt list in memory is not evidence of runtime
recovery.

## What each gate proves, and what it cannot see

This section is as important as the checks themselves. A validator whose blind
spots are undocumented invites exactly the over-trust that has already cost this
project real time. Read the right-hand column before quoting the left.

### `validate_dynamic_model.mjs` — the primary gate

```text
validate_dynamic_model.mjs <workbook.xlsx> --out <folder>
                           [--visual-reviewed <file>] [--finance-reviewed <json>]
```

Requires five sidecars beside the workbook and hard-fails without them:
`.row-map.json`, `.solution.json`, `.coverage.json`, `.semantic-manifest.json`,
`.source-crosswalk.csv`.

Twenty-nine checks: `sheet-contract`, `coverage-gate`,
`semantic-artifact-completeness`, `semantic-artifact-case-binding`,
`dynamic-section-map`, `three-historical-three-forecast`,
`fiscal-year-period-contract`, `single-rcf-input-authority`,
`no-unintended-drawings`, `statement-arithmetic`,
`independent-solver-parity`, `cfs-waterfall-component-parity`,
`interest-cash-rcf-ties`, `pro-forma-actual-tie`,
`standalone-adjustment-pro-forma-tie`, `liquidity-certification`,
`formula-errors`, `external-workbook-links`, `control-formula-gates`,
`binary-controls`, `iteration-contract`, `hidden-mechanics`,
`visible-interest-assumption-references`, `historical-provenance-comments`,
`font-colour-contract`, `number-format-colour-contract`, `typography-contract`,
`native-excel-toggle-restoration`, `visual-review`.

**Proves:** the workbook contains the three approved calculation-authority
sheets and, when declared by a PASS hash-bound broker bundle, no more than the
optional image-only `B01`-`B10` evidence group; the
period structure is three historical plus three forecast; every statement
subtotal foots; the workbook agrees with the independently computed solution;
debt, cash, RCF, interest, liquidity and leverage tie; standalone plus
adjustment equals pro forma; the control gates are present in formula text; no
formula error, external link or stray drawing part survives; nothing on the
`Operating Model` is hidden and nothing sits below the last visible row;
historical hardcodes carry provenance comments; font colours match their
declared roles.

**Cannot see:**

- **Whether the answer is plausible.** It checks internal consistency only. A
  model can tie perfectly and still say something absurd. Nothing here
  substitutes for the plain-English read at delivery.
- **Whether the numbers are the company's.** Parity is against the solver, and
  the solver reads the same case. If the case is wrong, both agree and both are
  wrong. This is why the case is gated separately at coverage.
- **`PASS_PENDING_MANUAL` exits 0.** Two checks —
  `native-excel-toggle-restoration` and `visual-review` — degrade to `manual`
  when their evidence is absent, and the process still exits zero. A green exit
  code is therefore not a PASS. Read the report's `status` field, which is one
  of `PASS`, `PASS_PENDING_MANUAL` or `FAIL`. There is no
  `MANUAL_REVIEW_REQUIRED` status; earlier documentation naming one was wrong.
- **`--visual-reviewed` accepts almost anything.** A non-JSON file passes on
  non-zero length alone. A screenshot of an unrelated sheet satisfies the flag.
  The evidence is only as good as the human who produced it.
- **The Node validator still uses one absolute tolerance for currency and ratios.**
  Its default is `0.05`, applied to `net_leverage` as readily as to a balance.
  It is development evidence only. Production native evidence is schema v3.1
  and must use the metric-class policy in `production-contract-v2.json`, report
  maximum observed drift by class, and bind the exact certified closure.
  **Never widen a tolerance to clear a violation.**
- It imports the local artifact tooling and therefore **cannot ship**. It is now
  ported: `verify/validate_dynamic_model.py` reproduces all twenty-nine checks
  with the standard library alone and is the version that runs inside the
  released package. Where both are available, run both — they read the same
  workbook through different readers, and where they agree the agreement means
  something. Where only one can run, it is the port.

### `validate_source_parity.mjs` — did the source's formula survive

```text
validate_source_parity.mjs <workbook.xlsx> <row-map.json> <ledger.json> [--json out.json]
```

Kinds: `FLATTENED_FORMULA`, `FLATTENED_LINK`, `FORMULA_COLOURED_AS_INPUT`,
`LINK_NOT_GREEN`, `GREEN_NOT_LINK`, `HARDCODE_NOT_BLUE`, `MISSING_PROVENANCE`,
`EXCEPTION_UNDOCUMENTED`, `EXCEPTION_LEAKED_COMBINATION`.

**Proves:** a cell the source calculated is still calculated here, and a cell
this model types is blue and carries a source comment. It is the only check that
can judge *intent*, because the lineage ledger is the only artifact that records
what a cell was supposed to be.

**Cannot see:**

- **Only two kinds block.** `FLATTENED_FORMULA` and `FLATTENED_LINK` exit 1;
  every colour, provenance and exception violation returns `WARN` and **exits
  0**. A run that destroys the provenance of two hundred cells passes its exit
  code. Read the violation total, not the exit status.
- **Unmapped rows and sheets are invisible to pass 1.** The ledger covers what
  the crosswalk mapped. Pass 1 alone once reported two link-colour violations on
  a workbook that had twenty-six; the workbook-wide second pass exists because
  of that. Read `skipped_no_target_row`, `skipped_no_column` and `skipped_empty`
  — they quantify what was never examined.
- Ledger entries that are unmapped, text, or carry no period role are dropped
  before the skip counters, so they appear in no total at all.

### `validate_cache_parity.mjs` — does the file lie to a reader who does not recalculate

```text
validate_cache_parity.mjs <workbook.xlsx> [--json out.json] [--tol 1e-6] [--rel 1e-9]
                          [--limit 40] [--sheet <name>] [--only <A1>] [--show-noise]
                          [--circ-tol <n>] [--circ-rel <n>]
```

Buckets: `mismatches`, `circular_mismatches`, `circular_noise`, `unsupported`,
`parse_errors`, `eval_errors`.

**Proves:** every acyclic formula, re-evaluated from its precedents' cached
values, reproduces its own cached value. This is the check that catches a
workbook whose displayed numbers disagree with its formulas — the failure an
analyst never notices because Excel recalculates on open and quietly changes the
model in front of them.

**Cannot see:**

- **Only `mismatches` and `circular_mismatches` affect the status.**
  `unsupported`, `parse_errors` and `eval_errors` are printed as "not checked"
  and **never fail the run**. A formula the evaluator could not parse is not a
  formula that agrees; it is a formula nobody checked. Report those three counts
  every time — they are the size of the hole, and a PASS with a large
  `unsupported` count means very little.
- **Circular cells are never expected to agree exactly.** Disagreement inside
  the convergence band is classified as noise and suppressed unless
  `--show-noise` is passed. The band derives from the workbook's own
  `iterateDelta`, so a loose delta makes the check loose. On a model denominated
  in millions, a delta of 0.001 is a tolerance of about a thousand currency
  units on cells that feed the leverage ratio.
- **Array and data-table slave cells cannot be reconstructed** and are skipped.
- Re-evaluation is deliberately single-step. It localises blame; it does not
  chase a wrong value upstream to its cause.

### Where the cached values come from — and why LibreOffice is now the check, not the source

This changed, and the change is a strengthening. Read it before quoting cache
parity at anybody.

**The emitter computes every cached value itself.** Three sources, and between
them they cover the workbook:

- typed historical hardcodes, which are facts from the case;
- the solver's own outputs, for every cell the declared economics states;
- a **closed formula evaluator** for the remainder, which walks each emitted
  formula and terminates on the two above.

On the `--plan-only` path that is the *only* source. No converter runs, nothing
is read back out of a file, and the plan carries a value for every formula cell
before any workbook exists. The run prints the three counts — typically a few
hundred historical, roughly a thousand solver, and a hundred-odd evaluated on a
representative case — plus `unresolved_caches`. **A non-zero `unresolved_caches`
fails the build.** There is deliberately no fallback to the converter: a formula
the evaluator cannot close over is a formula whose displayed value nobody
derived, and shipping it would put an unexplained number in front of a reader.

**On the `--out` path LibreOffice still recalculates, but it is now the second
opinion rather than the authority.** The same run also synthesises the
`--plan-only` cache map and compares the two cell by cell: for every cell the
solver patches, the value seeded from LibreOffice's recalculated historical
columns and the value seeded from the plan's own arithmetic must agree to a
relative `1e-9`, scaled by `max(|a|, |b|, 1)`. A disagreement throws and the
build produces nothing. The recalculated-cell count must also still be non-zero,
for the reason under *The build's own report is not evidence*.

**Why that is stronger than what it replaced.** When LibreOffice owned the
caches, a validator reading them back was checking one party against itself: the
converter's arithmetic was both the value and the standard it was judged by.
Two independently derived values that are made to agree is two parties, and the
agreement carries the information the old arrangement only appeared to.

**Cannot see:**

- **Agreement is not correctness.** The solver, the evaluator and LibreOffice
  can all be right about a case that is wrong. Nothing here validates the case.
- **Circular cells are the solver's fixed point.** They are excluded from the
  acyclic comparison by construction, and native Excel may settle on a slightly
  different fixed point that nothing in this sandbox can observe. That is the
  human Excel certification, not this.
- **The evaluator is closed over the functions the emitter emits**, and nothing
  wider. It is not a general spreadsheet engine, and it must not be treated as
  one; a formula written outside that closure surfaces as
  `unresolved_caches`, not as a quietly approximated number.
- The 1e-9 comparison covers the cells the solver patches. Cells outside that
  set are not compared across the two derivations by this assertion — cache
  parity above is what covers them, in the emitted file.

### `validate_style_tokens.mjs` — did the formatting reach the file

```text
validate_style_tokens.mjs <workbook.xlsx> [--json out.json]
```

Sixteen checks, including `border-definitions-present`, `double-rule-present`,
`column-block-left-edges`, `breaking-gutter-columns-white-and-unbordered`,
`carry-through-gutters-carry-the-formatting`, `answer-fill-reaches-the-file`,
`no-input-fill-is-declared`, `answer-fill-lands-on-answer-rows-only`,
`fill-palette-is-closed`, `bold-appears-only-on-declared-headline-rows`,
`declared-total-rows-are-bold`,
`ordinary-detail-rows-have-no-horizontal-rules`,
`net-debt-panels-terminate-identically`, `answer-rank-is-earned-not-asserted`,
`conditional-format-sets-no-font-colour-on-body-cells`,
`conditional-state-rules-present`.

**Proves:** what `style-tokens.json` states actually reached `xl/styles.xml`.
This check exists because **the writer silently drops formatting calls** —
`format.indentLevel` and the freeze-pane API were both called correctly and both
reached the XML as nothing, and the five border treatments the token file
described were absent from every emitted workbook while the token file read as
authoritative. The token file is a statement of intent. Only the emitted OOXML
is evidence.

**Cannot see:**

- **Six of the sixteen checks auto-pass when the `.row-map.json` sidecar is
  missing**, and they are reported as `pass` with a "Not asserted" message:
  `bold-appears-only-on-declared-headline-rows`,
  `declared-total-rows-are-bold`,
  `ordinary-detail-rows-have-no-horizontal-rules`,
  `net-debt-panels-terminate-identically`, `answer-rank-is-earned-not-asserted`
  and `answer-fill-lands-on-answer-rows-only`. A sidecar-less run reports PASS on
  four checks it never ran. **Always run it beside the row map.**
- **A declared rule is not a fired rule.** Conditional formatting is declared in
  XML and only executes at render. A rule with a broken formula does nothing at
  all while this check confirms the rule exists. Only a render proves a rule
  fired — see the visual pass.
- It reads styles, not geometry. Nothing here knows whether a label is clipped.

### `validate_structure.mjs` — a diagnostic, not a gate

```text
validate_structure.mjs <source.xlsx> <built.xlsx>
```

Reports rows missing from the built model, ordering inversions, fill-pattern
differences and indent-level differences.

**Cannot see, and this is the headline:** it **has no exit code**. It always
exits 0, regardless of what it finds. It is explicitly diagnostic and leaves the
judgement to a reviewer. Do not count it as a passing gate and never cite its
exit status as evidence.

Further limits: sheet names are hardcoded — the source sheet must be `Model` and
the built sheet `Operating Model`; the scan ranges are hardcoded rows and
columns on both sides; matching is sequential-greedy because labels repeat
across sections; **unmatched rows in the BUILT model are never reported at all**,
so a spurious extra row is invisible; output truncates at 40 fill differences
and 20 indent differences.

### `verify/validate_dynamic_model.py` — the port that runs where the Node validator cannot

```text
python3 scripts/verify/validate_dynamic_model.py <workbook.xlsx> --out <folder>
        [--tolerance-mode contract|legacy] [--tolerance 0.05]
        [--visual-reviewed <file>] [--finance-reviewed <json>]
```

Standard library only, Python 3.9+. It exists because the Node validator imports
private artifact tooling that cannot be redistributed, and that validator holds
the **only independent solver-parity check in the system** — the sole in-sandbox
authority on whether the emitted workbook agrees with the independently computed
economics, including the circular set's fixed point. Losing it would leave the
certification claim standing with nothing under it.

It reproduces every check the Node suite defines, all twenty-nine, and needs the
same five sidecars beside the workbook: `.row-map.json`, `.solution.json`,
`.coverage.json`, `.semantic-manifest.json`, `.source-crosswalk.csv`. It
hard-fails without them.

Two deliberate differences from the incumbent. It defaults to
`--tolerance-mode contract`, which applies metric-class tolerances rather than
one absolute `0.05` across currency and ratios alike. And supplying `--tolerance`
now forces the legacy scalar policy **and** stamps `tolerance_override` on the
face of the report, so a run loosened from the command line can never again be
mistaken for a contract run. `legacy` exists only so the port can be diffed
check-for-check against the Node original. **Never widen a tolerance to clear a
violation.**

It must never import a third-party package, and it must never import from
`emit/`. Both are enforced by the release compiler, not merely asserted in a
docstring — the build fails on either import. A validator that shared a reader
with the emitter it checks could agree with it about a misreading of the file,
and the agreement would mean nothing.

**Cannot see:**

- **It does not recalculate the workbook.** Every value it reads is the cached
  value the emitter wrote into `<v>`. If the emitter cached a value Excel would
  not reproduce from the formula beside it, this validator agrees with the cache.
  The circular set's fixed point is checked as "the cache agrees with the
  independent Python solver", never as "Excel converges here". Only the manual
  native-Excel gate can see that, and it is unsupplied by default.
- **It sees one control state.** The workbook ships with circularity on or off;
  `control-formula-gates` asserts the caches agree with whichever state is
  present and that the formula text survives a toggle, but **it cannot execute
  the toggle.** Off/on/off/on restoration is manual evidence and nothing else.
- **`formula-errors` searches cached values only** — faithfully to the
  incumbent, whose match probe returned zero hits for `IFERROR` across hundreds
  of formulas. A formula that would evaluate to `#REF!` but whose cached value is
  stale and numeric is invisible to it.
- **With no evidence supplied the status is `PASS_PENDING_MANUAL`, which is not
  `PASS`,** and the process still exits 0. Read the `status` field. The two
  manual checks are not coverage.
- Sheets 2 and 3 are barely checked: only `sheet-contract` and `formula-errors`
  look at `Brokers` and `Forward Curves` at all.
- No rendering and no layout. Column widths, freeze panes, print areas,
  conditional formatting and borders are outside every check here.
  `typography-contract` covers font name, size and section-title colour only.
- `historical-provenance-comments` checks presence, not truth. A comment saying
  the wrong thing passes. Comments are read from `xl/comments1.xml` only, so a
  workbook that spilled into `comments2.xml` would have those anchors read as
  missing.
- `semantic-artifact-*`, `coverage-gate` and `independent-solver-parity` all read
  sidecars produced by the same build that produced the workbook. They detect
  disagreement between a build's own artefacts; they cannot detect a build that
  is consistently wrong.
- It does not validate the case inputs. Garbage in the case that the solver and
  the emitter both honour is agreement, not correctness.
- `statement-arithmetic` accepts link-compiled rows on the strength of the link
  resolving to a named row. It no longer asserts the emitter chose the **right**
  row to link to; that binding is checked by the row plan and the semantic
  manifest, not here.

### `verify/run_deterministic_tests.py` — determinism without a builder

```text
python3 scripts/verify/run_deterministic_tests.py --builds A.xlsx B.xlsx --out <folder>
python3 scripts/verify/run_deterministic_tests.py <representative-v2-case.json> [output-folder]
```

Thirteen comparisons. The `--builds` form compares two workbooks that already
exist and needs no builder, no Node and no third-party package — which is what
makes determinism provable inside the released package. The positional form
builds twice from a case and does need the local Node emitter.

It compares the sidecars as canonical JSON, the crosswalk as raw CSV text, and
the workbook's cached values, formulas, row topology, comment anchors and
comment text, plus `sheet1.xml` with volatile identifiers masked and the stable
package parts.

**It reads cached values from the workbook's own `<v>` elements, never from
`.inspect.ndjson`.** That file's `table.values` is a **pre-recalculation**
snapshot: on one case it records finance income and finance costs as zero across
all three forecast periods while the shipped workbook caches 13.2522 and -61.94
in the same cells. Comparing two pre-recalculation snapshots therefore cannot see
nondeterminism in the values a reader will actually open — precisely where the
circular solve lives, and precisely the drift the harness exists to catch.

**Cannot see:** anything about correctness. Two identical builds of a wrong model
pass thirteen out of thirteen. Fresh relationship and threaded-comment
identifiers are masked deliberately, so raw `.xlsx` byte equality is not claimed
and must not be reported as though it were.

### `verify/finance_proof.py` — independent finance recomputation

```text
python3 scripts/verify/finance_proof.py <case.json> <workbook.xlsx> --out <report.json>
python3 scripts/verify/run_finance_proof_mutations.py <case.json> <workbook.xlsx> --out <folder>
```

The finance proof is a standard-library OOXML reader and a separate economic
implementation. It does not import the Node solver, renderer, formula evaluator
or generated `.solution.json`. It independently recomputes control states,
instrument debt and interest, the RCF waterfall and capacity, acquisition debt
and interest, leases, interest income and expense, debt summaries, leverage and
liquidity, then compares those results with workbook caches.

The mutation harness changes cached values only in disposable copies and must
show that the proof rejects corruption in each covered economic family. A clean
finance report without a green mutation report proves agreement, but not that
the independent implementation is sensitive enough to close a release gate.

**Cannot see:** statement-classification correctness outside its named finance
families, native Excel iterative restoration, or rendered presentation. It also
cannot prove that a wrong case input is economically true; evidence intake and
source reconciliation remain separate gates.

### `verify/workbook_semantic_oracle.py` — independent physical semantic proof

```text
python3 scripts/verify/workbook_semantic_oracle.py --xlsx <workbook.xlsx> --contract <workbook.xlsx.workbook-proof-contract.json> --out <report.json>
```

This standard-library-only verifier reads raw OOXML rather than compiler or
renderer objects. It proves unique answer ownership, independent-writer limits,
forecast capture membership, parent-before-child hierarchy and statement-to-
schedule authority direction against the hash-bound proof contract emitted from
the sealed model IR. It also reconstructs the physical forecast formula graph:
every Derived semantic dependency must be reachable at the declared period,
and every direct statement-to-statement formula reference must remain inside
the semantic graph's transitive closure. The graph contract has its own
canonical closure hash and must contain non-vacuous path and closure coverage.
A physical mutation to any of those relationships blocks publication even when
formula caches and headline values still agree.

`verify/validate_dynamic_model.py` separately ports the five-layer graph
constitution into Python. It recomputes every layer and closure hash; rebuilds
evidence, statement, forecast-writer, economic-equation and row-plan
inventories from the semantic manifest, canonical equation-graph asset and row
map; and closes shared economic roles through their unique statement and
physical projections. It does not accept the Node compiler's PASS label as
proof. The authoring-only
`verify/run_layered_graph_python_tests.py` reseals deliberately corrupted
forecast-writer, statement-edge, economic-role and row-projection layers and
proves that the independent source reconstruction still rejects them. The
authoring-only
`verify/run_workbook_semantic_oracle_mutations.py` proves sensitivity to a
corrupted closure, a missing required formula path and an unauthorised physical
edge before release work proceeds.

The architecture repair gate additionally proves: exact 3H/3F rejection before
and after normalisation; direct forecast authority cannot be overwritten by
capture; every capture has period certificates; investing and financing contain
no invented catch-all aggregation; Change in Debt remains a visible child sum;
mandatory repayment membership follows instrument states rather than row
ranges; leverage-basis wording cannot claim company parity without evidence;
acquisition timing helpers remain internal; every user screen is one fenced ASCII
block; and optional raw broker sheets are evidence-only. The local authoring
tree runs a dedicated architecture-repair development gate on a representative
case before the broader development gate. That authoring-only harness is not a
deployed entry point; installed packages enforce the same physical workbook
relationships through `workbook_semantic_oracle.py` and its hash-bound proof
contract.

### The Python render stage — `render/check_render.py` and `render/selftest.py`

```text
python3 scripts/render/check_render.py <workbook.xlsx> [more.xlsx ...] --out <folder>
        [--baselines <external-approved-baselines>]
        [--baseline-case standard-maximal|standard-net-cash]
        [--structural-only] [--baseline-row-model excel-compat|declared]
        [--sheet "Operating Model"] [--soffice <path>] [--expect-pages N]
        [--dpi N] [--timeout S] [--probe] [--static]
python3 scripts/render/selftest.py <reference.xlsx> --fixtures <folder>
```

`check_render.py` is node N14. It converts through `soffice`, reads the PDF back
through either PyMuPDF or the fail-closed `pypdf` + `pdfplumber` + Poppler
backend, and asserts clipping, overlap, presence of every planned cell, the
font set, structure, alignment and whether each conditional-formatting rule
actually fired. It writes `<out>/<case>.render-evidence.json` plus the page PNGs
and prints one verdict per case, and it needs the workbook's `.row-map.json`
sidecar beside it. Exit status is 0 only if every case is PASS.

There are two deliberately distinct invocations. A normal company build uses
`--structural-only` with its selected reusable profile in `--baseline-case` and
does not need or consume `--baselines`.
It renders the actual workbook and enforces every applicable structural and
geometry check, but does not compare issuer-specific labels and numbers with the
example authority's pixels. Exact pixel regression omits `--structural-only`
and is reserved for frozen maximal and net-cash authority replays during release
certification. A company run cannot substitute for that replay, and an authority
replay cannot be weakened to structural-only.

**There is deliberately no code path that turns any of its findings into a
warning.** A missing `soffice`, absence of both complete PDF-reading backends, a
text/glyph stream mismatch, a failed Poppler raster, a timeout, a zero-byte PDF,
an unlocatable cell or an unexpected font returns BLOCKED, and BLOCKED is a
failure. A render stage that degraded to a warning on a failed conversion would
go green exactly when the evidence was missing.

Pixel baselines are also bound to their raster family in `BASELINES.json`.
MuPDF and Poppler do not produce byte-identical antialiasing for the same PDF;
cross-backend comparison is therefore BLOCKED rather than reported as workbook
drift. Changing the baseline raster family requires a separately attributed
baseline epoch, never an automatic fallback.

`selftest.py` lays out a synthetic PDF with known geometry from a real workbook,
injects one fault at a time and asserts that the corresponding check reports a
new finding relative to the clean fixture. The clean fixture may retain
pre-existing defects inherited from its source geometry; those must be stable
and are subtracted rather than silently called clean. **It does not need
LibreOffice.** Where `soffice` is unavailable it is the only evidence the checks
work at all, which is why it ships as an entry point rather than as a test.

**Cannot see:** `selftest.py` proves the *checks*, never that any workbook
renders correctly. That still requires a real conversion, and a self-test result
must never be reported as a render result.

Baselines are populated only by a real LibreOffice conversion, via
`--update-baseline`. A baseline written from any other renderer makes the
regression check assert against fiction for the life of the file.

Do not generate a baseline tree from a separately supplied raw authority
workbook in a deployment host. It has no semantic row-map sidecar and may use a
different producer row model. Deployment parity instead binds physical-
authority structure to a frozen local canary, requires exact installed canonical
package identity for that canary, and requires the installed structural render
to match the expected visible-sheet and pagination contract. Canonical identity
masks only the closed set of volatile producer-assigned relationship identifiers;
formulas, values, semantics, styles, comments and all other package content must
match. Pixel baselines are external local release evidence only and are never a
production-run dependency.

**A comparison run cannot create or extend a baseline.** Not on the first run,
not for a page the baseline does not yet have, not for anything. Writing one
requires `--update-baseline` *and* an `--attribution` file carrying a `reason`;
either alone is refused. The reason this is enforced in code rather than
described in prose is that a gate which writes the file it is about to compare
against has authored its own expected output — the run that creates the baseline
may still fail, but the next identical run passes against a picture nobody ever
approved. That is a validator editing its own contract.

**What BLOCKED means here.** Beyond the environment failures above, this gate
returns BLOCKED for a case with no baseline at all: a check that visited nothing
has not passed, and the gate cannot make a regression statement about a picture
it has never seen. A case that *has* a baseline but is missing an individual page
reports that page missing and counts it as unattributed — it is neither silently
created nor silently skipped. A page-count mismatch is a separate finding and a
defect in its own right: three pages against a four-page baseline means the
pagination moved, which is precisely what this gate exists to catch, and it is
never resolved by extending the baseline to fit.

**The baselines come from the shipping path only, and `--baseline-row-model`
states which path that is.** LibreOffice honours declared row heights differently
depending on whether `docProps/app.xml`'s `<Application>` string starts with
"Microsoft": on that path a 12.5pt row renders 12.0pt, off it 12.47pt, which over
a full sheet is more than a row of drift. The shipping producer declares a
Microsoft-compatible application string — that is `excel-compat`, the default,
and the model every PNG in an external approved release baseline was produced under.
The local direct-to-workbook certification tool writes no `docProps` at all and
so falls under `declared`; a no-baseline run may diagnose its geometry but
remains **BLOCKED**. A passing regression verdict requires a separately approved
tree populated from that producer and named with `--baseline-row-model declared`.
A producer whose implied row model differs from the baselines' is refused
outright as BLOCKED rather than diffed, and the mismatch is never grounds for
rewriting the baseline: the diff would report the row model as hundreds of
regressions, and rewriting to silence them would pin the wrong renderer for the
life of the file.

### openpyxl is available; `render/` chose not to use it

Two shipped statements disagree, and this is the position that governs.

**openpyxl 3.1.5 is native where this package runs.** The tenant capability audit
confirms it, the release profile declares it `provision: native` and
`required_at: import`, and `emit/` writes the workbook through it. That is
correct and must not be softened.

`render/xlsx_model.py`'s module docstring says the platform "does NOT guarantee
openpyxl". That clause is **stale and must not be relied on.** What remains true
in it is the *decision*, not the *reason*: `render/` is stdlib-only on purpose,
because the image-check stage reads the rendered PDF rather than the workbook
object model and must not acquire a dependency it has no use for. `verify/` is
stdlib-only for a stronger reason — it is the independent checker of what `emit/`
writes, so it must share no reader with it. The release compiler enforces both:
an `openpyxl` import anywhere under `render/` or `verify/` fails the build.

Nobody may edit that docstring to make this file agree with it, and nobody may
edit this file to agree with the docstring. The docstring belongs to the owner of
`scripts/render/`; it is flagged for correction there. Until it is corrected,
treat the sentence above as authoritative and treat the docstring's availability
claim as a comment about a decision, not about the platform.

### The render pass — what only a picture can catch

This is the reasoning behind the stage above; `render/check_render.py` is the
thing that runs it. Three classes are structurally invisible to any XML
assertion:

1. **Text metrics.** The emitter never knows rendered text width, so clipping
   and overlap cannot be asserted from the package. Extract per-word bounding
   boxes and compare against the emitted column widths.
2. **Whether a conditional-formatting rule actually fires.** On 2026-07-26 the
   broker-case rule fired in one direction only and used a near-white fill
   identical to every subtotal, so on five of six cases the control carried no
   mark at all — and passed every structural check.
3. **Font substitution.** The font set must be exactly `{Carlito}`. Calibri maps
   to Carlito, which is metric-compatible. Aptos maps to DejaVu Sans, which is
   not, and a non-metric-compatible substitution silently invalidates every
   geometry assertion while the checks keep passing.

Fail closed: conversion exit 0, page count matched, every planned cell located,
zero clips, zero overlaps, font set exactly `{Carlito}`, pixel diff empty or
wholly attributed. Conversion failure, timeout, a zero-byte PDF or an unexpected
font is BLOCKED, never a warning.

**The honest limit:** this proves LibreOffice rendering with Carlito. It is
authoritative for regression and for clipping. It is **not** authoritative for
how the workbook looks to an analyst in Excel.

### The build's own report is not evidence

`.inspect.ndjson`'s `table.values` is a **pre-recalculation** snapshot and
disagrees with the emitted caches. Anything validating against it is validating
the wrong thing.

Likewise, a recalculation step that prints a count is not a recalculation that
happened. Assert the count is non-zero. A healthy build recalculates on the
order of 1,500-plus formula cells; a build reporting zero has silently failed to
resolve the office binary and must fail rather than continue. This still binds
on the certification path even though the converter no longer owns the values —
a recalculation that did not happen is a second opinion that was never taken,
and the 1e-9 agreement then asserts nothing.

## Scope and structure

Confirm:

- exactly three historical and three forecast years;
- the required major sections in order, with adjusted EBITDA, free cash flow,
  leverage and liquidity retained as subsections;
- no full forecast balance sheet;
- no ratings;
- no dedicated central checks sheet;
- no central source register;
- no external workbook links;
- visible editable assumptions;
- supplied exact-period forecast values held in visible input cells and linked
  into calculation rows;
- expanded debt instruments inside the Debt Schedule and their interest rows
  inside the Interest Schedule;
- the production workbook contains the three calculation-authority sheets
  `Operating Model`, `Brokers` and `Forward Curves`; an optional `B01`-`B10`
  evidence group is permitted only when every embedded page image is hash-bound
  and every selected value is crosswalked through `Brokers`;
- broker evidence tabs contain every source PDF page horizontally as large
  images and no formulas or reconstructed tables;
- no raw FactSet/DCS evidence sheet is present; selected DCS terms appear as
  blue hardcodes in the debt schedule and are checked against the external
  lossless receipt;
- **no hidden rows on the `Operating Model` and no content below the last
  visible row.** There is no hidden support block; every mechanical row is on
  the face of the schedule it belongs to. `hidden-mechanics` asserts both halves;
- no unintended DrawingML shapes or charts remain after a native Excel save.

## Formula integrity

Scan for `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?` and `#N/A`; broken names or
ranges; inconsistent copy-across patterns; unintended hardcodes in forecast
ranges; uncontrolled circular references.

The convergence set is **declared before solving**, not discovered afterwards.
Assert that the set the graph computes matches the set the solver declared, and
treat non-convergence as a gate failure with `converged`, `iterations` and
`residual` all reported. An undeclared cycle is a defect even when it converges.

The statement member of that set is the issuer's declared **cash-flow start**,
not a hard-coded net-income row. A net-income-led reconciliation and a
profit-before-tax-led reconciliation therefore share one economic contract
without pretending their physical graphs are identical. The sealed workbook
proof contract binds the canonical equation-graph, convergence-contract and
solve-policy hashes to the actual forecast rows. The independent OOXML oracle
must derive one and only one formula SCC in each forecast column, and its bound
semantic nodes must equal the solver vector exactly. It must also prove direct
kill-switch gates on interest leaves, gated closure on interest aggregates and
the absence of a direct circularity kill gate on debt, maturity, RCF and cash
mechanics.

Confirm the circularity breaker produces stable, coherent results in both
states, and that off/on/off/on restores values identically. Nothing may latch.
The authoritative restoration report is
`native-excel-restoration-evidence/3.1`: it records the fixed metric-class
tolerance policy, maximum observed drift, exact candidate workbook hashes and
the certified closure hash. A scalar blanket tolerance is not certification.

## Historical and forecast checks

Confirm:

- each selected income statement and cash-flow statement has an independent,
  raw-filing-hash-bound face-statement manifest created before taxonomy;
- manifest rows are contiguous, unique and source ordered, and their row digest
  is valid;
- extracted filing lines and source coverage each match the manifest exactly in
  membership, order, label, values, source and page;
- every mapped or aggregated face line has a visible issuer-labelled statement
  row carrying its source-line lineage; no generic parent silently replaces
  disclosed children;
- the compiled statement-topology graph preserves source order after declared
  consolidation groups, carries one visible successor for each adjacent row,
  and contains no source-order inversion, duplicate visible authority, orphan
  numeric prefix, child-before-parent edge or non-contiguous family;
- no residual issuer-row list is appended after net income, free cash flow or
  another overlay-only terminal row;
- units, currency, periods and signs are consistent;
- missing prior-year instrument detail is represented by a visible reported
  aggregate or left unavailable, never silently treated as zero debt;
- mapped operating lines tie to supplied totals;
- revenue, EBIT, EBITDA, tax, net income and cash-flow subtotals calculate;
- forecasts reference the selected case or visible assumptions;
- each semantic row carries one resolved authority for each forecast period,
  and the solver, semantic manifest and workbook mechanism agree on it;
- partial-period forecasts equal reported-to-date actual plus the declared
  remainder without double-counting a full-year broker value;
- guidance ranges preserve low, high, selected value and selection policy;
- formula, schedule link, broker link, hardcode, explicit zero, intentionally
  uncalculated and unresolved states remain mutually distinct;
- an explicit zero carries a no-recurrence or inapplicability rationale, while
  a material unresolved path blocks instead of emitting `=0`;
- **historic figures come from the filings, never from a broker.** Brokers are
  authoritative for the forecast anchor only;
- capex and aggregate working capital flow into cash with correct signs;
- material assumptions are not embedded as constants.

## Debt

Confirm:

```text
ending debt
= opening debt
+ draws / issuance
- amortisation
- maturity repayment
+ acquisition additions
+ FX / other non-cash movement
```

Check opening reconciliation, instrument totals, balance carry-forwards,
maturities, amortisation, no unsupported refinancing, mandatory repayments and
acquisition-debt separation.

**The instrument list must foot to reported gross debt, and the residual is
signed.** Instruments exceeding reported gross debt is a failure exactly as
instruments falling short is; never clamp the residual at zero, or an export
taken after a new issue overstates gross debt, net debt and every leverage ratio
at any magnitude with no gate firing. Where the book is multi-currency,
translate at the declared rate before summing — a sum of native balances is not
a currency — and state the rate on the face of the reconciliation.

Any residual carries its own visible line and is never absorbed silently.

Unreconciled opening debt or a materially invented debt term is critical.

## Cash and RCF

Confirm:

```text
ending cash
= opening cash
+ cash from operations
+ cash from investing
+ cash from financing
+ FX effect on cash
```

Check:

- RCF draw is between zero and available capacity;
- repayment is between zero and drawn balance;
- ending RCF is between zero and capacity;
- minimum cash is met when capacity permits;
- any remaining deficit is shown as a shortfall;
- surplus repays only the RCF and remains as cash afterward;
- mandatory repayments and RCF movements enter financing cash flow once;
- cash-flow ending cash equals waterfall ending cash.

Cash roll-forward failure or an out-of-bounds RCF is critical.

## Interest

Confirm:

- fixed and floating interest follow applicable balances and rates;
- an unpriced instrument has blank individual rate cells, a declared
  `residual_interest_plug` treatment and no synthetic 0% source term;
- maturity timing and the acquisition close-month fraction are reflected when
  applicable;
- the acquisition leg is priced on the average of its opening and closing
  balance, the same convention every instrument leg uses. Opening equals closing
  whenever a tranche never amortises, which is why a divergent convention can sit
  undetected across an entire test suite;
- RCF interest and commitment fees are distinct;
- **the unallocated residual is shown as a reconciliation, not typed.** Reported
  gross interest, less interest identified instrument by instrument, equals the
  residual. The residual falls out as a difference; the two derivation rows are
  grouped beneath it and are excluded from gross interest, because adding them
  would count reported interest twice. A typed plug a reader cannot check
  against anything is the defect this replaced;
- RCF and lease interest are not double-counted;
- net P&L interest ties to the Income Statement;
- forecast interest income is zero in breaker mode and equals average eligible
  cash times the visible yield in the calculated state;
- interest income changes when cash changes.

Flat forecast interest income without a cash-based formula is critical.

## Leases

Confirm one mode is selected and applied consistently:

- exclude: remove debt, principal and interest;
- flat replacement: hold liability flat and show additions equal principal;
- simple roll-forward: opening plus additions less principal.

State whether leverage includes leases.

## Acquisition

Test off and on.

When off, adjustments are zero and standalone outputs do not change.

When on, confirm:

- target EBITDA equals transaction enterprise value divided by the entry
  EV/EBITDA multiple;
- acquisition debt equals the separately supplied acquisition-debt amount;
- target operating lines use the visible approved target ratios;
- contribution and interest timing are visible;
- transaction value is used once as consideration and acquisition debt once as
  financing proceeds;
- debt remains outstanding after close throughout the forecast;
- amount rows tie standalone plus adjustment to pro forma;
- pro forma growth rates, margins and cash-conversion ratios recalculate from
  pro forma amounts rather than adding ratios;
- net debt, EBITDA, interest, leverage and liquidity update coherently.

Acquisition contamination in the off state is critical.

Confirm that the canonical case contains no funding percentage, target net debt
or cash, synergies, fees, acquisition repayment/maturity input or
`acquisition_debt` instrument-register class.

## Advanced cases

When enabled, confirm:

- each historical target period is covered once;
- entities combine without double-counting;
- average FX is used for flows and period-end FX for balances;
- debt cash movement is separated from translation;
- RCF capacity is tested in the facility currency;
- interest uses the instrument-currency benchmark;
- a missing FX or forward-rate row blocks at the coverage gate. It must never
  reach the emitter and throw there — a gate-placement failure produces a stack
  trace where the user needed a named missing input.

## Visual and audit pass

Render every user-facing sheet. Inspect representative inputs, formulas,
same-workbook links, totals and key outputs.

Check:

- labels and values are not clipped and nothing overlaps;
- actual and forecast periods are distinct;
- input, formula and link colours match the contract;
- fill marks rank and nothing else; bold marks semantic totals/subtotals plus
  the declared headline set; rules mark arithmetic closure and nothing else;
- no conditional rule has set a font colour on a body cell;
- totals and section hierarchy are consistent;
- formulas are traceable;
- no blank default sheets or accidental used-range expansion remain.

## Release gate

For a formal release gate, assemble a
`release-certification-evidence/1.0` manifest. Every entry carries its exact
path and SHA-256 and every inner report is bound to the same computed closure.
It must include exact immutable-baseline replays for maximal and net-cash,
hash-bound rendered pages, native Excel v3.1 restoration, hash-bound visual
screenshots and reviewed workbooks, the explicitly development-only 32-case
cohort, passing finance-proof mutations and applicable non-vacuous source
parity. `scripts/validate_release_certification.mjs` validates that bundle.

`compile_skill_release.mjs --certify` additionally requires the evidence
manifest and a representative smoke case. The copied release must compile that
case, render a real workbook and independently validate it from a clean root
before the closure hash can be recorded. Import-only smoke is insufficient.

A workbook is release-ready only when every binding above passes and the
workbook report's `status` field reads `PASS`. `PASS_PENDING_MANUAL` exits 0 and
is **not** a release pass.

Block delivery for:

- wrong horizon or model scope;
- common formula errors;
- failed debt or cash roll-forward;
- unreconciled opening debt in either direction;
- RCF outside limits;
- flat forecast interest income;
- acquisition contamination;
- materially invented debt terms;
- a hidden row or content below the last visible row;
- a conditional rule that sets font colour on a body cell;
- unreadable or materially inconsistent workbook presentation.

## Repair

For a routine failure:

1. identify the earliest broken dependency;
2. repair only the affected mapping, formula or assumption;
3. rerun that check and all downstream checks.

Do not rebuild the entire model for one isolated formula or formatting defect.

A violation may be repaired automatically only where its class has a declared,
deterministic remedy. Everything else stops and reports. The repair may change
the case, the plan or the emitter's inputs. **It may never change a check, a
schema, a style token or the exception registry.**

Stop repairing if any violation identifier present in one iteration was absent
in the previous one, if any severity class fails to shrink, or after three
attempts — whichever comes first. A remedy that clears three formatting
violations while introducing one parity violation has not narrowed anything.

Escalate rather than retry identically. Retrying an ambiguity at the tier that
could not resolve it is how a repair loop spends its budget without narrowing.

When a check fails and stops the run, say **what failed and what would fix it**.
A failed invariant that merely halts is a defect in itself.
