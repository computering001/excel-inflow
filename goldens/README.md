# Behavioural goldens — v3.7.7 (P7.2)

This tree holds the frozen record of what v3.7.7 **does**: one record per
certified fixture, in `economic-ir/`, plus one append-only hash-chained
`approval-ledger.jsonl` that is the certification history.

> ## CURRENT STATE: PRE-FREEZE — nothing is frozen
>
> There is no `approval-ledger.jsonl` in this directory, so **no golden record
> exists and no v3.7.7 behaviour is pinned**. The mechanism below is built,
> committed and verified; the genesis freeze has not happened.
>
> That is deliberate. A golden pins what "correct" means, so the act of freezing
> must be performed by a **named human** who has actually reviewed the facts
> being pinned. Automation that can freeze can pin its own defects as correct.
> No agent, script or CI job will do this — the actor rule is enforced in code
> (`createGoldenApprovalRecord`) and in the schema (`frozen_by.kind` is
> `const: "human"`).
>
> To freeze, a named human runs:
>
> ```
> node scripts/regenerate_behavioural_goldens.mjs freeze \
>     --actor <your id> --role <your role> \
>     --reason "<at least 40 characters saying what you reviewed>"
> ```
>
> Run `node scripts/regenerate_behavioural_goldens.mjs status` first to see
> exactly what would be pinned.

The primary economic truth of a golden is the **canonical Economic IR**
(`economic-ir/1.0`, compiled by `scripts/lib/economic_ir.mjs` and shadow-attached
to the proof projection by `compileModelIrV3`). It is **not** the workbook. The
register warns against whole-workbook goldens — they pin formatting, cell
addresses and byte layout, so they break for reasons that have nothing to do with
economics and get "updated" until they mean nothing. P3.1 landed the Economic IR
precisely so the freeze could name economic truth instead. That is what happened
here.

Every number in a record is **derived** by walking the IR's own typed slots at
compile time. Nothing is hand-transcribed.

## What each record pins

1. **The seal.** `seal.content_sha256` — the IR's own content hash — and
   `sealed_slots`. One case, one seal: if any economic content moves, this moves.
2. **The contract versions.** `contracts.economic_ir`,
   `contracts.typed_financial_value`, `contracts.schedule_typed_states`,
   `contracts.proof_projection_schema_version`. A version bump is a declarable
   difference; an *undeclared* one is not.
3. **The full twelve-state coverage census, including the zeros.**
   `twelve_state_census` carries all twelve `typed_financial_value` states with
   explicit counts. The zeros are the load-bearing half: `reported_zero: 0` on
   `standard-maximal-v2` is a claim that nothing in that case fabricates a zero,
   and a count moving off 0 is exactly what the freeze exists to catch.
4. **The slot shapes.** `slot_shape` — total, historical, forecast, schedule,
   value-bearing, never-zero, and `bare_number_slots`, which is structurally `0`
   in both the schema and the record. Every economic slot is a typed value.
5. **The `historical_basis` histogram.** How many economic nodes carry each
   basis (`filed_face_series`, `structural_header`, `model_projection`,
   `no_plan_row`), plus `node_count`.
6. **Schedule period counts and the RCF / acquisition `not_applicable`
   pattern.** `schedules.period_count`, the period ids, and per family
   (`rcf`, `acquisition`, `cash`) the slot count, the per-state census, the
   `not_applicable` slot count and a single comparable
   `not_applicable_pattern` token. `standard-net-cash-v2` declares no
   acquisition, so its 15 acquisition quantities read
   `not_applicable_in_every_period` — in a real fixture, reading null, never a
   fabricated zero. That token turning into numbers is a never-acceptable
   regression.
7. **The shadow-boundary invariant itself.** `shadow_boundary` pins that the IR
   declares `mode: "shadow"`, declares `gates_delivery: false`, is attached
   **non-enumerably** and is therefore absent from the serialised projection.
   Promoting the IR out of shadow is a new schema version, never a golden update.

Plus the fixture identity (`case_id`, `case_sha256`, `evidence_epoch_sha256`) so
a record cannot silently start describing different input bytes.

## What a record deliberately does NOT pin

- **The workbook.** No bytes, no `.xlsx`, no manifest, no sheet name, no cell
  address, no formula string, no number format, no column width, no styling.
- **Individual economic magnitudes.** A record pins the *shape and typing* of
  economic truth and the seal that covers the values; it is not a table of
  numbers to eyeball. The seal is the value-level pin.
- **Solved forecast or schedule numbers.** The IR compiles before the solver
  runs, so those slots are correctly `unresolved` (231 of 336 on
  `standard-maximal-v2`). Freezing a solved lane is a later package's job and is
  closed by passing `solvedSchedules` in, never by weakening a state.
- **The proof projection's blockers, warnings or findings.** Those are other
  suites' territory.
- **Timings, paths, hostnames, or anything about the machine.**
- **Provenance.** The `certification` block (who froze it, when, under which
  approval) is recorded but is *not* compared — provenance is not behaviour.

## The difference taxonomy

The class set and each class's **acceptability** are owned by *code*
(`GOLDEN_DIFFERENCE_CLASS_CONTRACT` in `scripts/lib/behavioural_golden.mjs`); the
asset must mirror it verbatim, down to each class's description. Editing the
asset cannot make a never-acceptable difference approvable.

`assets/golden-difference-taxonomy-v1.json` declares thirteen difference classes.
Seven **require approval**: `fixture_identity_drift`, `contract_version_bump`,
`economic_drift`, `coverage_census_drift`, `slot_shape_drift`,
`historical_basis_drift`, `schedule_shape_drift`.

Six classes are **never acceptable** and can never be approved, by anyone, for
any reason:

| class | what it means |
| --- | --- |
| `never_zero_collapse` | `bare_number_slots` moved off 0, or never-zero states (`missing`, `unresolved`, `nil`, `reported_blank`, `not_applicable`, …) collapsed into value-bearing readings, or a schedule family's `not_applicable` slots became numbers. |
| `shadow_boundary_violation` | the IR stopped being shadow, or stopped being non-enumerable. |
| `golden_record_corruption` | a record does not satisfy its schema or its own `record_sha256` — it was edited after sealing. |
| `golden_coverage_gap` | a certified fixture has no golden, or a golden names a fixture that no longer exists. Deleting a golden is not a way to pass. |
| `uncertified_golden_present` | golden records exist but there is no approval ledger, so nothing certifies them. Shedding the certification history while keeping the records is not a route back to PRE-FREEZE. |
| `unclassified_difference` | a pinned fact differs and no declared class named it. A new pinned fact must get a class before it can ever be approved. |

A never-acceptable difference is a **regression, not a change**. It is fixed in
the code that produced it.

## PRE-FREEZE and FROZEN

Which state this tree is in is decided by **one thing: whether
`approval-ledger.jsonl` exists.** Never by whether golden records happen to be
present, readable, or valid. That matters in both directions:

- **PRE-FREEZE** (no ledger) — nothing was ever frozen, so a missing record is
  *not* a coverage gap. The suite reports `"frozen": false`, prints a loud
  stderr banner, asserts the mechanism instead, and passes. The frozen half of
  the gate is still exercised at full strength against a throwaway temp freeze.
- **FROZEN** (ledger present) — every rule applies at full strength. A record
  that has been deleted is still `golden_coverage_gap`; a record that has been
  corrupted is still `golden_record_corruption`. **Deleting records does not
  return you to PRE-FREEZE**, so PRE-FREEZE can never be used to hide a real
  gap.
- Records **without** a ledger are `uncertified_golden_present`, so you cannot
  keep the pins and shed the certification history either.

Both directions are proven by mutation in `run_behavioural_golden_tests.mjs`
section (F).

## How to compare, and how to regenerate

Comparison — what CI runs, and what a human runs to see what moved:

```
node scripts/run_behavioural_golden_tests.mjs      # the gate; fails on any difference
node scripts/regenerate_behavioural_goldens.mjs status   # the classified verdict
```

Neither can update a golden. There is no `--update`, no `--fix`, no `--accept`
and no `--force` flag anywhere in this mechanism, deliberately.

Regeneration is a **separate, explicitly invoked, approval-recording command**:

```
node scripts/regenerate_behavioural_goldens.mjs approve \
    --actor <who> --role <role> \
    --reason "<at least 40 characters saying why this difference is a change and not a regression>" \
    --fixtures standard-maximal-v2,standard-net-cash-v2 \
    --classes coverage_census_drift,economic_drift
# prints an approval_record_hash

node scripts/regenerate_behavioural_goldens.mjs regenerate --approval <approval_record_hash>
```

Regeneration is refused when:

- no approval record is named (`no_approval_record_named`);
- the approval ledger does not validate (`approval_ledger_invalid`);
- the named record does not exist, or is not an `approve` event;
- the approval was granted against a **different commit** than `HEAD`
  (`approval_commit_mismatch`) — an approval binds the tree it was read against;
- the approval was already used (`approval_already_consumed`) — approvals are
  single-use;
- a differing fixture, or an observed difference class, is not named on the
  approval (`approval_fixture_not_named`, `approval_class_not_declared`);
- **any** observed difference is never-acceptable
  (`difference_never_acceptable`) — checked before anything is written and
  independently of what the approval says;
- nothing actually differs (`nothing_to_regenerate`).

`freeze` performs the one-time genesis freeze and is refused once a ledger
exists, so it cannot be used as a back door around the approval gate.

## The approval ledger

`approval-ledger.jsonl` is append-only and hash-chained in the discipline of
`scripts/lib/release_journal.mjs` (P8.6a): `record_hash` is the canonical digest
of the record body with `record_hash` removed, and `previous_record_hash` is the
preceding record's hash. It refuses gaps, reorders, forks, replays, backdating,
edits after sealing, automation actors, reasons under 40 characters, and any
approval that tries to declare a never-acceptable class. Record 0 is the genesis
freeze; every later golden change is an `approve` followed by the `regenerate`
that consumed it.

## What the genesis freeze will pin, when a human performs it

The facts are already known and reproducible — running `status` in PRE-FREEZE, or
the suite's temp freeze, compiles them from the live pipeline every time:

- `standard-maximal-v2` — IR seal `284a00d3…`, 336 typed slots (153 historical /
  138 forecast / 45 schedule), census 45 `reported_number` / 24 `derived_number` /
  12 `captured` / 12 `not_applicable` / 12 `missing` / 231 `unresolved`, and
  **0 `reported_zero`, 0 bare numbers**; 51 nodes; 3 schedule periods.
- `standard-net-cash-v2` — IR seal `126bc386…`, 36 / 9 / 24 / 12 / 12 / 27 / 216,
  with its 15 acquisition quantities `not_applicable_in_every_period`.

Both seals match the ones P3.1 recorded independently at `b3dd728`, and were
re-confirmed in a clean detached worktree at `e31b53e`, so they are stable facts
about the code rather than artefacts of one dirty working tree.

An earlier revision of this package *did* write a genesis freeze, attributed to
the programme owner "on the owner's instruction". That was withdrawn as a false
audit record: the owner had not run the command, had not reviewed the pinned
facts, and had asked for the phases to be implemented — not for a freeze to be
signed in their name. An approval ledger whose first entry misattributes a human
approval undermines the entire mechanism it exists to provide. Hence PRE-FREEZE.
