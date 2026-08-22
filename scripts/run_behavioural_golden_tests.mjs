#!/usr/bin/env node
/**
 * P7.2 — behavioural goldens: the comparison gate.
 *
 * Invariant under test: v3.7.7 behaviour is frozen as a set of GOLDEN records
 * whose primary economic truth is the canonical Economic IR (not the workbook);
 * every golden difference is classified by a declared taxonomy; regeneration is
 * an audited, single documented command that records WHO approved and WHY; and a
 * golden can never be silently updated to make a test pass.
 *
 * TWO LAWFUL STATES. The genesis freeze is a HUMAN act, so the mechanism must be
 * verifiable before any human has reviewed the pinned facts:
 *
 *   PRE_FREEZE  no approval ledger exists. Nothing is frozen; a missing record is
 *               NOT a coverage gap. The suite reports this loudly on stderr and
 *               as `"frozen": false` in its JSON, asserts the MECHANISM instead,
 *               and passes.
 *   FROZEN      an approval ledger exists. Every rule applies at full strength.
 *
 * The discriminator is the LEDGER'S EXISTENCE, never whether records happen to be
 * readable — so a corrupted or partially deleted frozen set stays FROZEN and is
 * refused, and PRE_FREEZE can never be used to hide a real gap. Section (F)
 * proves both directions.
 *
 * Whatever the real tree's state, this suite ALWAYS exercises the frozen half at
 * full strength by freezing into a throwaway temp directory. The real goldens/
 * is never written to; check (G3) proves that structurally.
 *
 * Red proof (this tree before the work package):
 *   - `goldens/` did not exist (ENOENT), and neither did
 *     scripts/lib/behavioural_golden.mjs, assets/behavioural-golden-v1.schema.json,
 *     assets/golden-difference-taxonomy-v1.json,
 *     scripts/regenerate_behavioural_goldens.mjs or this file.
 *   - assets/development-test-registry.json:6 declares
 *     `golden_actions_performed: false`, mirrored in
 *     scripts/run_development_gate.mjs:377; scripts/run_frozen_cohort.mjs lists
 *     `golden_update` under `prohibitions` and `golden_or_baseline_promotion`
 *     under `not_claimed`. Those declarations were TRUE.
 *   - Five files referenced the Economic IR seal and NONE compared it to a
 *     frozen expected value: `grep -rl 'expected_seal|frozen_seal|golden_seal'
 *     scripts/ assets/` returned nothing. No comparison was possible.
 *   - No approval ledger for goldens existed anywhere (the only `approved_by`
 *     in the tree is scripts/render/baseline.py:43, a render baseline field).
 *
 * Red proof for the PRE_FREEZE half (captured against this suite's first
 * revision, which had no such state): with the frozen set absent the suite died
 * at `every certified fixture has a golden record (missing: standard-maximal-v2,
 * standard-net-cash-v2)`, and `status` reported two `golden_coverage_gap`s — the
 * mechanism could not tell "never frozen" from "somebody deleted a golden", so
 * the only way to a green gate was to manufacture a human approval.
 *   Documented in programme/P7.2_issue_card.md.
 *
 * This gate COMPARES. It cannot update a golden: it imports neither
 * regenerateBehaviouralGoldens nor freezeBehaviouralGoldens for the real tree,
 * and check (G) proves that by scanning its own source.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ALL_TYPED_STATES,
  BEHAVIOURAL_GOLDEN_SCHEMA_VERSION,
  FROZEN_SET_STATES,
  GOLDEN_APPROVAL_SCHEMA_VERSION,
  GOLDEN_DIFFERENCE_CLASSES,
  GOLDEN_DIFFERENCE_CLASS_CONTRACT,
  NEVER_ACCEPTABLE,
  NEVER_ACCEPTABLE_CLASSES,
  REGENERATION_REFUSAL_CODES,
  REQUIRES_APPROVAL,
  appendGoldenApprovalRecord,
  approvalLedgerPath,
  behaviouralGoldenRecordSha256,
  compareBehaviouralGolden,
  compareFrozenSet,
  compileBehaviouralGolden,
  compileFixtureEconomicIr,
  createGoldenApprovalRecord,
  currentCommit,
  freezeBehaviouralGoldens,
  frozenSetState,
  goldenApprovalRecordHash,
  goldenRecordPath,
  goldensDirOf,
  isNeverAcceptable,
  listBehaviouralGoldens,
  listCertifiedFixtures,
  loadGoldenDifferenceTaxonomy,
  readBehaviouralGolden,
  readGoldenApprovalLedger,
  validateBehaviouralGolden,
  validateGoldenApprovalLedger,
  validateGoldenDifferenceTaxonomy,
} from "./lib/behavioural_golden.mjs";
import { NEVER_ZERO_STATES, VALUE_BEARING_STATES } from "./lib/typed_financial_value.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const COMMAND = path.join(ROOT, "scripts", "regenerate_behavioural_goldens.mjs");
const REAL_GOLDENS_DIR = goldensDirOf();

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Re-seal a mutated record, exactly as a well-meaning-but-wrong actor would. */
function reseal(record) {
  const next = clone(record);
  delete next.record_sha256;
  next.record_sha256 = behaviouralGoldenRecordSha256(next);
  return next;
}

async function runCommand(args, { cwd = ROOT } = {}) {
  try {
    const { stdout, stderr } = await exec("node", [COMMAND, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function refusal(result) {
  try {
    return JSON.parse(result.stderr);
  } catch {
    return { status: "UNPARSEABLE", raw: result.stderr };
  }
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "p72-goldens-"));

/**
 * Freeze into a throwaway temp directory so the FROZEN half of the gate is
 * exercised at full strength whatever the real tree's state. The guard below is
 * load-bearing: this suite must be structurally incapable of freezing the real
 * goldens/ tree, because that is precisely the false-audit-record failure the
 * PRE_FREEZE state exists to avoid.
 */
async function freezeIntoTempDir(label) {
  const dir = await fs.mkdtemp(path.join(scratch, `${label}-`));
  assert.ok(
    dir.startsWith(os.tmpdir()) && path.resolve(dir) !== path.resolve(REAL_GOLDENS_DIR),
    "a suite freeze target must be a throwaway temp directory, never the real goldens/ tree",
  );
  const result = await freezeBehaviouralGoldens({
    goldensDir: dir,
    actor: {
      kind: "human",
      id: "p72-suite-fixture@example.invalid",
      role: "synthetic suite fixture in a temp directory — NOT an audit record",
    },
    reason:
      "Synthetic freeze performed by run_behavioural_golden_tests.mjs inside a throwaway temp directory, so the FROZEN half of the gate is exercised without touching the real frozen set.",
  });
  return { dir, result };
}

// ===========================================================================
// (A) The taxonomy is declared, and the ASSET cannot weaken it.
// ===========================================================================
const taxonomy = await loadGoldenDifferenceTaxonomy();
check(
  validateGoldenDifferenceTaxonomy(taxonomy).length === 0,
  `the committed difference taxonomy must validate: ${validateGoldenDifferenceTaxonomy(taxonomy)[0]}`,
);
check(GOLDEN_DIFFERENCE_CLASSES.length === 13, "thirteen difference classes are declared");
check(
  NEVER_ACCEPTABLE_CLASSES.length === 6 &&
    [
      "golden_coverage_gap",
      "golden_record_corruption",
      "never_zero_collapse",
      "shadow_boundary_violation",
      "uncertified_golden_present",
      "unclassified_difference",
    ].every((id) => NEVER_ACCEPTABLE_CLASSES.includes(id)),
  "six classes are declared NEVER acceptable, including never_zero_collapse and uncertified_golden_present",
);
check(
  Object.keys(taxonomy.classes).every(
    (id) => taxonomy.classes[id].acceptability === GOLDEN_DIFFERENCE_CLASS_CONTRACT[id].acceptability,
  ),
  "every asset acceptability mirrors the code contract",
);
check(
  NEVER_ACCEPTABLE_CLASSES.every((id) => taxonomy.classes[id].approvable_by_any_actor_or_reason === false),
  "every never-acceptable class declares it is approvable by no actor and no reason",
);
check(
  taxonomy.regeneration_prohibited_inside_any_gate === true,
  "the taxonomy declares that no gate may regenerate a golden",
);
{
  const dropped = clone(taxonomy);
  delete dropped.classes.never_zero_collapse;
  check(
    validateGoldenDifferenceTaxonomy(dropped).some((finding) => finding.includes("never_zero_collapse is missing")),
    "a taxonomy asset that DROPS never_zero_collapse is refused",
  );
  const flipped = clone(taxonomy);
  flipped.classes.never_zero_collapse.acceptability = REQUIRES_APPROVAL;
  check(
    validateGoldenDifferenceTaxonomy(flipped).some((finding) =>
      finding.includes("acceptability may not be changed by editing the asset"),
    ),
    "a taxonomy asset that promotes never_zero_collapse to approvable is refused",
  );
  const uncertified = clone(taxonomy);
  uncertified.classes.uncertified_golden_present.acceptability = REQUIRES_APPROVAL;
  check(
    validateGoldenDifferenceTaxonomy(uncertified).some((finding) =>
      finding.includes("acceptability may not be changed by editing the asset"),
    ),
    "a taxonomy asset that makes uncertified goldens approvable is refused",
  );
  const paraphrased = clone(taxonomy);
  paraphrased.classes.shadow_boundary_violation.detects = "the shadow moved a bit, probably fine";
  check(
    validateGoldenDifferenceTaxonomy(paraphrased).some((finding) =>
      finding.includes("does not match the code contract verbatim"),
    ),
    "a taxonomy asset that paraphrases what a class detects is refused",
  );
  const invented = clone(taxonomy);
  invented.classes.probably_fine_drift = { acceptability: REQUIRES_APPROVAL, detects: "x".repeat(30) };
  check(
    validateGoldenDifferenceTaxonomy(invented).some((finding) => finding.includes("is not a declared difference class")),
    "a taxonomy asset that invents a class is refused",
  );
  const shortened = clone(taxonomy);
  shortened.never_acceptable_classes = ["never_zero_collapse"];
  check(
    validateGoldenDifferenceTaxonomy(shortened).some((finding) =>
      finding.includes("never_acceptable_classes must be exactly"),
    ),
    "a taxonomy asset that shortens the never-acceptable list is refused",
  );
  const unlocked = clone(taxonomy);
  unlocked.regeneration_prohibited_inside_any_gate = false;
  check(
    validateGoldenDifferenceTaxonomy(unlocked).some((finding) =>
      finding.includes("may compare goldens but may never regenerate"),
    ),
    "a taxonomy asset that permits in-gate regeneration is refused",
  );
}

// ===========================================================================
// (B) Which state is the real tree in? Determined by the LEDGER, and reported.
// ===========================================================================
const certified = await listCertifiedFixtures();
check(certified.length >= 2, "there are at least two certified fixtures");
check(FROZEN_SET_STATES.length === 2, "exactly two frozen-set states are declared");

const realState = await frozenSetState();
check(
  FROZEN_SET_STATES.includes(realState.state),
  `the real tree is in a declared frozen-set state (got ${realState.state})`,
);
check(
  realState.determined_by.includes("existence of the approval ledger"),
  "the state discriminator is documented as the ledger's existence",
);
const FROZEN = realState.frozen;

// ===========================================================================
// (C) The MECHANISM, provable with nothing frozen at all: compile a record,
// compare it to itself, and prove the comparator and taxonomy work.
// ===========================================================================
{
  const bare = await fs.mkdtemp(path.join(scratch, "unfrozen-"));
  const verdict = await compareFrozenSet({ goldensDir: bare });
  check(verdict.status === "PRE_FREEZE", "an empty goldens directory reports PRE_FREEZE");
  check(verdict.frozen === false, "PRE_FREEZE reports frozen: false");
  check(
    verdict.coverage_gaps.length === 0 && verdict.never_acceptable.length === 0,
    "with nothing ever frozen, a missing record is NOT a coverage gap",
  );
  // The record compiler and comparator work with no ledger in sight.
  for (const fixtureId of certified) {
    const record = await compileBehaviouralGolden(fixtureId);
    const findings = await validateBehaviouralGolden(record, { label: fixtureId });
    check(findings.length === 0, `PRE_FREEZE: ${fixtureId} compiles a schema-valid record: ${findings[0]}`);
    check(
      compareBehaviouralGolden(record, clone(record)).status === "MATCH",
      `PRE_FREEZE: ${fixtureId}'s freshly compiled record compares MATCH against itself`,
    );
    const drifted = reseal({ ...clone(record), seal: { ...record.seal, content_sha256: "f".repeat(64) } });
    const driftVerdict = compareBehaviouralGolden(drifted, clone(record));
    check(
      driftVerdict.status === "DIFFERENT" && driftVerdict.classes.includes("economic_drift"),
      `PRE_FREEZE: ${fixtureId}'s comparator still classifies an economic drift`,
    );
  }
}

// A record present with NO ledger is never acceptable: you cannot keep the pins
// and shed the certification history to slip back into PRE_FREEZE.
{
  const orphaned = await fs.mkdtemp(path.join(scratch, "orphan-"));
  await fs.mkdir(path.join(orphaned, "economic-ir"), { recursive: true });
  const record = await compileBehaviouralGolden(certified[0]);
  await fs.writeFile(
    goldenRecordPath(certified[0], orphaned),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  const verdict = await compareFrozenSet({ goldensDir: orphaned });
  check(
    verdict.status === "DIFFERENT" && verdict.never_acceptable_classes.includes("uncertified_golden_present"),
    "golden records with no approval ledger are a never-acceptable uncertified_golden_present",
  );
  check(
    verdict.frozen === false && verdict.uncertified_goldens.length === 1,
    "the uncertified-goldens finding names the record it found without a ledger",
  );
}

// ===========================================================================
// (D) The FROZEN half at FULL STRENGTH. Always exercised, against a temp freeze
// when the real tree is unfrozen, and against the real tree when it is frozen.
// ===========================================================================
const temp = await freezeIntoTempDir("frozen");
check(temp.result.status === "FROZEN", "the temp freeze reports FROZEN");
check(
  temp.result.goldens.length === certified.length,
  "the temp freeze produced one record per certified fixture",
);
check(
  (await frozenSetState({ goldensDir: temp.dir })).state === "FROZEN",
  "a directory with an approval ledger is FROZEN",
);

/** Every full-strength assertion over one frozen set. */
async function assertFrozenSetAtFullStrength(goldensDir, label) {
  const pinned = await listBehaviouralGoldens({ goldensDir });
  check(
    certified.every((fixtureId) => pinned.includes(fixtureId)),
    `${label}: every certified fixture has a golden record (missing: ${certified.filter((id) => !pinned.includes(id)).join(", ")})`,
  );
  check(
    pinned.every((fixtureId) => certified.includes(fixtureId)),
    `${label}: no golden record names a fixture that is no longer certified`,
  );

  const records = new Map();
  for (const fixtureId of certified) {
    const record = await readBehaviouralGolden(fixtureId, { goldensDir });
    records.set(fixtureId, record);
    const findings = await validateBehaviouralGolden(record, { label: `${label}/${fixtureId}` });
    check(findings.length === 0, `${label}: golden ${fixtureId} must validate: ${findings[0]}`);
    check(
      record.schema_version === BEHAVIOURAL_GOLDEN_SCHEMA_VERSION && record.golden_kind === "economic_ir",
      `${label}: ${fixtureId} declares the behavioural-golden schema and the economic_ir kind`,
    );
    check(
      record.primary_economic_truth.is_workbook === false,
      `${label}: ${fixtureId} declares the Economic IR — NOT the workbook — as its primary economic truth`,
    );
    check(
      record.record_sha256 === behaviouralGoldenRecordSha256(record),
      `${label}: ${fixtureId} carries a record_sha256 over its own body`,
    );

    // (1) the seal, (2) the contracts.
    check(/^[a-f0-9]{64}$/.test(record.seal.content_sha256), `${label}: ${fixtureId} pins the IR seal content hash`);
    check(
      record.contracts.economic_ir === "economic-ir/1.0" &&
        record.contracts.typed_financial_value === "1.0.0" &&
        record.contracts.schedule_typed_states === "schedule-typed-states/1.0",
      `${label}: ${fixtureId} pins the declared contract versions`,
    );
    // (3) the twelve-state census INCLUDING the zeros.
    check(
      ALL_TYPED_STATES.every((state) => Number.isInteger(record.twelve_state_census[state])),
      `${label}: ${fixtureId} pins all twelve typed states with explicit counts`,
    );
    check(
      ALL_TYPED_STATES.some((state) => record.twelve_state_census[state] === 0),
      `${label}: ${fixtureId} pins at least one state at zero — the zeros catch a collapse`,
    );
    check(
      ALL_TYPED_STATES.reduce((total, state) => total + record.twelve_state_census[state], 0) ===
        record.slot_shape.typed_slots,
      `${label}: ${fixtureId}'s census sums to its typed-slot total`,
    );
    // (4) the slot shapes, and the never-zero anchor.
    check(record.slot_shape.bare_number_slots === 0, `${label}: ${fixtureId} pins bare_number_slots at 0`);
    check(
      record.slot_shape.historical_slots + record.slot_shape.forecast_slots + record.slot_shape.schedule_slots ===
        record.slot_shape.typed_slots,
      `${label}: ${fixtureId}'s slot shapes partition the typed slots`,
    );
    check(
      record.slot_shape.value_bearing_slots + record.slot_shape.never_zero_slots === record.slot_shape.typed_slots,
      `${label}: ${fixtureId} partitions every typed slot into value-bearing or never-zero`,
    );
    // (5) the historical_basis histogram.
    check(
      Object.keys(record.historical_basis_histogram).length > 0 &&
        Object.values(record.historical_basis_histogram).reduce((a, b) => a + b, 0) === record.node_count,
      `${label}: ${fixtureId}'s historical_basis histogram covers every economic node`,
    );
    // (6) schedule period counts and the family patterns.
    check(
      record.schedules.period_count === record.schedules.forecast_period_count &&
        record.schedules.period_ids.length === record.schedules.period_count,
      `${label}: ${fixtureId} pins one schedule per forecast period`,
    );
    check(
      Object.values(record.schedules.families).reduce((total, family) => total + family.slot_count, 0) ===
        record.slot_shape.schedule_slots,
      `${label}: ${fixtureId}'s schedule families account for every schedule slot`,
    );
    check(
      Object.values(record.schedules.families).every((family) => family.bare_number_slots === 0),
      `${label}: ${fixtureId} has no bare number in any schedule family`,
    );
    // (7) the shadow-boundary invariant.
    check(
      record.shadow_boundary.ir_mode === "shadow" &&
        record.shadow_boundary.ir_gates_delivery === false &&
        record.shadow_boundary.shadow_status === "sealed" &&
        record.shadow_boundary.attached_enumerably === false &&
        record.shadow_boundary.present_in_serialised_projection === false,
      `${label}: ${fixtureId} pins the shadow boundary: sealed, gating nothing, non-enumerable, absent from the serialised projection`,
    );
    check(
      record.certification.frozen_by.kind === "human" &&
        /^[0-9a-f]{7,40}$/.test(record.certification.frozen_at_commit),
      `${label}: ${fixtureId} records a human freezer and the commit it was frozen against`,
    );
  }

  // The pinned seal is DERIVED, not transcribed.
  for (const fixtureId of certified) {
    const { ir } = await compileFixtureEconomicIr(fixtureId);
    check(
      ir.seal.content_sha256 === records.get(fixtureId).seal.content_sha256,
      `${label}: ${fixtureId}'s pinned seal is the seal the live pipeline produces`,
    );
    check(ir.coverage.bare_number_slots === 0, `${label}: ${fixtureId}'s live IR types every economic slot`);
  }

  // The specific never-zero fact the freeze exists to protect.
  {
    const netCash = records.get("standard-net-cash-v2");
    const acquisition = netCash.schedules.families.acquisition;
    check(
      acquisition.not_applicable_pattern === "not_applicable_in_every_period" &&
        acquisition.not_applicable_slots === acquisition.slot_count &&
        acquisition.value_bearing_slots === 0 &&
        acquisition.by_state.reported_zero === 0,
      `${label}: standard-net-cash-v2 pins its acquisition schedule as not_applicable in every period, zero value-bearing, zero reported_zero`,
    );
    const maximal = records.get("standard-maximal-v2");
    check(
      maximal.twelve_state_census.reported_zero === 0,
      `${label}: standard-maximal-v2 pins reported_zero at 0 — nothing in that case fabricates a zero`,
    );
  }

  // THE GATE for this set.
  const frozenVerdict = await compareFrozenSet({ goldensDir });
  check(
    frozenVerdict.status === "MATCH",
    `${label}: the frozen set must match the live tree; observed ${frozenVerdict.classes.join(", ")} — ${
      frozenVerdict.verdicts.flatMap((verdict) => verdict.differences).map((d) => d.detail)[0] ??
      frozenVerdict.coverage_gaps[0]?.detail ??
      ""
    }`,
  );
  check(frozenVerdict.frozen === true, `${label}: a frozen set reports frozen: true`);
  check(frozenVerdict.never_acceptable.length === 0, `${label}: no never-acceptable difference is present`);

  // The ledger.
  const ledger = await readGoldenApprovalLedger(approvalLedgerPath(goldensDir));
  check(ledger.status === "PASS", `${label}: the approval ledger must validate: ${ledger.findings[0]}`);
  check(
    ledger.records[0].event_type === "freeze" &&
      ledger.records[0].sequence === 0 &&
      ledger.records[0].previous_record_hash === null,
    `${label}: record 0 is the genesis freeze and chains onto nothing`,
  );
  check(
    ledger.records[0].schema_version === GOLDEN_APPROVAL_SCHEMA_VERSION,
    `${label}: the ledger declares its record schema version`,
  );
  check(
    ledger.records.every((record) => record.record_hash === goldenApprovalRecordHash(record)),
    `${label}: every ledger record's hash covers its own body`,
  );
  const latestMaterialisation = [...ledger.records]
    .reverse()
    .find((record) => record.event_type === "freeze" || record.event_type === "regenerate");
  check(
    latestMaterialisation?.goldens.length === certified.length &&
      latestMaterialisation.goldens.every(
        (entry) => entry.record_sha256 === records.get(entry.fixture_id)?.record_sha256,
      ),
    `${label}: the latest freeze or approved regeneration binds the record_sha256 of every current golden`,
  );
  check(
    ledger.records[0].reason.length >= 40 && ledger.records[0].actor.kind === "human",
    `${label}: the genesis freeze records WHO froze the set and WHY`,
  );

  // Determinism.
  for (const fixtureId of certified) {
    const first = await compileBehaviouralGolden(fixtureId);
    const second = await compileBehaviouralGolden(fixtureId);
    check(
      JSON.stringify(first) === JSON.stringify(second),
      `${label}: ${fixtureId}: two compiles of one golden are byte-identical`,
    );
  }
  return records;
}

const tempRecords = await assertFrozenSetAtFullStrength(temp.dir, "temp-frozen");
if (FROZEN) {
  await assertFrozenSetAtFullStrength(REAL_GOLDENS_DIR, "committed");
}

// ===========================================================================
// (E) The comparator classifies. Five mutations plus the anti-defeat proofs.
// ===========================================================================
const baseline = tempRecords.get("standard-net-cash-v2");
check(compareBehaviouralGolden(baseline, clone(baseline)).status === "MATCH", "a record compared against itself MATCHes");

// MUTATION 1 — ECONOMIC DRIFT must fail.
{
  const drifted = reseal({ ...clone(baseline), seal: { ...baseline.seal, content_sha256: "f".repeat(64) } });
  const verdict = compareBehaviouralGolden(drifted, clone(baseline));
  check(verdict.status === "DIFFERENT", "MUTATION 1: an economic drift FAILS the comparison");
  check(
    verdict.classes.includes("economic_drift") && verdict.classes.length === 1,
    `MUTATION 1: the difference classifies as economic_drift alone (got ${verdict.classes.join(", ")})`,
  );
  check(
    verdict.never_acceptable_count === 0 && verdict.differences[0].acceptability === REQUIRES_APPROVAL,
    "MUTATION 1: economic drift requires approval — it is a change, not automatically a regression",
  );
}

// MUTATION 2 — COVERAGE-CENSUS DRIFT must fail. Moved WITHIN the value-bearing
// band so it is a census drift and not a collapse.
{
  const drifted = clone(baseline);
  drifted.twelve_state_census.reported_number -= 6;
  drifted.twelve_state_census.derived_number += 6;
  const verdict = compareBehaviouralGolden(reseal(drifted), clone(baseline));
  check(verdict.status === "DIFFERENT", "MUTATION 2: a coverage-census drift FAILS the comparison");
  check(
    verdict.classes.includes("coverage_census_drift"),
    `MUTATION 2: the difference classifies as coverage_census_drift (got ${verdict.classes.join(", ")})`,
  );
  check(
    verdict.never_acceptable_count === 0,
    "MUTATION 2: a census drift inside the value-bearing band is approvable, not never-acceptable",
  );
  check(
    verdict.differences.every((difference) => difference.fact[0].startsWith("twelve_state_census.")),
    "MUTATION 2: the classifier names the exact census facts that moved",
  );
}

// MUTATION 3 — NEVER-ZERO COLLAPSE must fail as NEVER-ACCEPTABLE.
{
  const before = clone(baseline);
  before.twelve_state_census.reported_zero -= 9;
  before.twelve_state_census.unresolved += 9;
  before.slot_shape.value_bearing_slots -= 9;
  before.slot_shape.never_zero_slots += 9;
  const verdict = compareBehaviouralGolden(reseal(before), clone(baseline));
  check(verdict.status === "DIFFERENT", "MUTATION 3: a never-zero collapse FAILS the comparison");
  check(
    verdict.classes.includes("never_zero_collapse"),
    `MUTATION 3: the difference classifies as never_zero_collapse (got ${verdict.classes.join(", ")})`,
  );
  check(
    verdict.never_acceptable_classes.includes("never_zero_collapse") &&
      verdict.differences.some(
        (difference) => difference.class === "never_zero_collapse" && difference.acceptability === NEVER_ACCEPTABLE,
      ),
    "MUTATION 3: the collapse is classified NEVER ACCEPTABLE, not merely as a census drift",
  );
  check(
    verdict.differences.some(
      (difference) => difference.detail.includes("unresolved") && difference.detail.includes("reported_zero"),
    ),
    "MUTATION 3: the finding names which never-zero state collapsed into which reading",
  );
  check(
    verdict.differences
      .filter((difference) => difference.class === "coverage_census_drift")
      .every((difference) => !difference.fact.includes("twelve_state_census.reported_zero")),
    "MUTATION 3: the collapsed census facts are claimed by never_zero_collapse, never by coverage_census_drift",
  );
}

// MUTATION 3b — a bare number appearing at all is a collapse.
{
  const after = clone(baseline);
  after.slot_shape.bare_number_slots = 1;
  const verdict = compareBehaviouralGolden(clone(baseline), reseal(after));
  check(
    verdict.classes.includes("never_zero_collapse") && verdict.never_acceptable_classes.includes("never_zero_collapse"),
    "MUTATION 3b: bare_number_slots moving off 0 is a never-acceptable collapse",
  );
}

// MUTATION 3c — the sharpest instance.
{
  const after = clone(baseline);
  const acquisition = after.schedules.families.acquisition;
  acquisition.by_state.not_applicable = 0;
  acquisition.by_state.reported_zero = 15;
  acquisition.not_applicable_slots = 0;
  acquisition.value_bearing_slots = 15;
  acquisition.not_applicable_pattern = "not_applicable_in_no_period";
  const verdict = compareBehaviouralGolden(clone(baseline), reseal(after));
  check(
    verdict.never_acceptable_classes.includes("never_zero_collapse"),
    "MUTATION 3c: a not_applicable schedule family turning into reported zeros is never-acceptable",
  );
  check(
    verdict.differences.some((difference) => difference.detail.includes("never a zero")),
    "MUTATION 3c: the finding says a schedule for a thing the case does not have is never a zero",
  );
}

// Shadow-boundary flips are never acceptable.
{
  const after = clone(baseline);
  after.shadow_boundary.ir_gates_delivery = true;
  const verdict = compareBehaviouralGolden(clone(baseline), reseal(after));
  check(
    verdict.classes.includes("shadow_boundary_violation") &&
      verdict.never_acceptable_classes.includes("shadow_boundary_violation"),
    "an IR that starts gating delivery is a never-acceptable shadow-boundary violation",
  );
  const enumerable = clone(baseline);
  enumerable.shadow_boundary.present_in_serialised_projection = true;
  check(
    compareBehaviouralGolden(clone(baseline), reseal(enumerable)).never_acceptable_classes.includes(
      "shadow_boundary_violation",
    ),
    "an IR that became enumerable on the projection is a never-acceptable shadow-boundary violation",
  );
}

// Approvable classes still fail the comparison — they just have a lawful route.
{
  const after = clone(baseline);
  after.contracts.typed_financial_value = "1.1.0";
  const verdict = compareBehaviouralGolden(clone(baseline), reseal(after));
  check(
    verdict.status === "DIFFERENT" &&
      verdict.classes.includes("contract_version_bump") &&
      verdict.never_acceptable_count === 0,
    "a contract-version bump is a distinct, approvable class that still fails the comparison",
  );
  const identity = clone(baseline);
  identity.identity.case_sha256 = "a".repeat(64);
  check(
    compareBehaviouralGolden(clone(baseline), reseal(identity)).classes.includes("fixture_identity_drift"),
    "a re-cut fixture classifies as fixture_identity_drift",
  );
  const schedule = clone(baseline);
  schedule.schedules.period_count = 4;
  check(
    compareBehaviouralGolden(clone(baseline), reseal(schedule)).classes.includes("schedule_shape_drift"),
    "a changed forecast schedule period count classifies as schedule_shape_drift",
  );
  const basis = clone(baseline);
  basis.historical_basis_histogram.model_projection += 1;
  basis.node_count += 1;
  check(
    compareBehaviouralGolden(clone(baseline), reseal(basis)).classes.includes("historical_basis_drift"),
    "a changed historical_basis histogram classifies as historical_basis_drift",
  );
  const shape = clone(baseline);
  shape.slot_shape.historical_slots += 1;
  check(
    compareBehaviouralGolden(clone(baseline), reseal(shape)).classes.includes("slot_shape_drift"),
    "a changed typed-slot shape count classifies as slot_shape_drift",
  );
}

// ANTI-DEFEAT: a pinned fact that differs and matches no class is never-acceptable.
{
  const after = clone(baseline);
  after.fixture_path = "test-fixtures/cases/somewhere-else.json";
  const verdict = compareBehaviouralGolden(clone(baseline), reseal(after));
  check(
    verdict.classes.includes("unclassified_difference") &&
      verdict.never_acceptable_classes.includes("unclassified_difference"),
    "a pinned fact no class names classifies as the never-acceptable unclassified_difference",
  );
}

// A record edited after sealing fails its own hash.
{
  const tampered = clone(baseline);
  tampered.twelve_state_census.unresolved += 1;
  const findings = await validateBehaviouralGolden(tampered, { label: "tampered" });
  check(
    findings.some((finding) => finding.includes("edited after sealing")),
    "a golden edited after sealing fails its own record_sha256",
  );
}

// ===========================================================================
// (F) PRE_FREEZE vs FROZEN is decided by the LEDGER, never by record readability.
// A frozen set that has lost or corrupted a record is still FROZEN and refused.
// ===========================================================================

/** A fresh copy of the temp frozen set, ledger included. */
async function freshGoldensDir() {
  const dir = await fs.mkdtemp(path.join(scratch, "set-"));
  await fs.mkdir(path.join(dir, "economic-ir"), { recursive: true });
  for (const fixtureId of certified) {
    await fs.copyFile(goldenRecordPath(fixtureId, temp.dir), goldenRecordPath(fixtureId, dir));
  }
  await fs.copyFile(approvalLedgerPath(temp.dir), approvalLedgerPath(dir));
  return dir;
}

// THE MUTATION THAT MATTERS: a frozen set with one record DELETED is still
// FROZEN, and the gap is still the never-acceptable golden_coverage_gap. This is
// what stops PRE_FREEZE from being a hiding place for a real gap.
{
  const dir = await freshGoldensDir();
  await fs.rm(goldenRecordPath("standard-net-cash-v2", dir));
  const state = await frozenSetState({ goldensDir: dir });
  check(
    state.state === "FROZEN",
    "a frozen set with a deleted record is STILL FROZEN — deleting records does not return you to PRE_FREEZE",
  );
  const verdict = await compareFrozenSet({ goldensDir: dir });
  check(
    verdict.status === "DIFFERENT" && verdict.never_acceptable_classes.includes("golden_coverage_gap"),
    "deleting a golden from a frozen set is a never-acceptable coverage gap, never a way to pass",
  );
  check(
    verdict.frozen === true && verdict.coverage_gaps.some((gap) => gap.fixture_id === "standard-net-cash-v2"),
    "the coverage gap names the fixture whose record was deleted",
  );
  // Deleting EVERY record still does not reach PRE_FREEZE while the ledger stands.
  await fs.rm(goldenRecordPath("standard-maximal-v2", dir));
  const emptied = await compareFrozenSet({ goldensDir: dir });
  check(
    emptied.frozen === true && emptied.coverage_gaps.length === certified.length,
    "emptying the record directory while the ledger stands is a full set of coverage gaps, not PRE_FREEZE",
  );
}

// A corrupted-but-PRESENT frozen set is golden_record_corruption, never PRE_FREEZE.
{
  const dir = await freshGoldensDir();
  const tampered = clone(baseline);
  tampered.twelve_state_census.unresolved += 1; // not re-sealed
  await fs.writeFile(
    goldenRecordPath("standard-net-cash-v2", dir),
    `${JSON.stringify(tampered, null, 2)}\n`,
    "utf8",
  );
  check(
    (await frozenSetState({ goldensDir: dir })).state === "FROZEN",
    "a frozen set with a corrupted record is still FROZEN",
  );
  const verdict = await compareFrozenSet({ goldensDir: dir });
  check(
    verdict.never_acceptable_classes.includes("golden_record_corruption"),
    "a corrupted-but-present record is golden_record_corruption, not silently treated as pre-freeze",
  );
  check(
    !verdict.never_acceptable_classes.includes("uncertified_golden_present"),
    "a corrupted record with an intact ledger is not misreported as uncertified",
  );
  // Unreadable garbage on disk is likewise corruption, not pre-freeze.
  await fs.writeFile(goldenRecordPath("standard-maximal-v2", dir), "{ not json at all", "utf8");
  await assert.rejects(
    compareFrozenSet({ goldensDir: dir }),
    /JSON/,
    "an unparseable golden raises rather than silently reading as pre-freeze",
  );
  checks += 1;
}

// A golden naming a fixture that is not certified is still a coverage gap.
{
  const dir = await freshGoldensDir();
  await fs.writeFile(
    goldenRecordPath("standard-does-not-exist", dir),
    `${JSON.stringify(baseline, null, 2)}\n`,
    "utf8",
  );
  check(
    (await compareFrozenSet({ goldensDir: dir })).never_acceptable_classes.includes("golden_coverage_gap"),
    "a golden naming a fixture that is not certified is a never-acceptable coverage gap",
  );
}

// The real tree's state, asserted explicitly in whichever state it is in.
{
  const verdict = await compareFrozenSet();
  if (FROZEN) {
    check(verdict.status === "MATCH" && verdict.frozen === true, "the committed frozen set matches");
  } else {
    check(
      verdict.status === "PRE_FREEZE" && verdict.frozen === false,
      `the committed tree is PRE_FREEZE (got ${verdict.status})`,
    );
    check(
      verdict.never_acceptable.length === 0,
      "PRE_FREEZE in the committed tree raises no never-acceptable finding",
    );
    const ledger = await readGoldenApprovalLedger(approvalLedgerPath());
    check(
      ledger.status === "FAIL" && ledger.findings.some((finding) => finding.includes("no certification history")),
      "reading a non-existent ledger reports that there is no certification history",
    );
  }
}

// ===========================================================================
// (G) The approval ledger: hash-chained, append-only, single-use.
// ===========================================================================
const ledgerFixture = await readGoldenApprovalLedger(approvalLedgerPath(temp.dir));
{
  const head = await currentCommit();
  const genesis = ledgerFixture.records[0];
  const approve = createGoldenApprovalRecord({
    sequence: 1,
    previousRecordHash: genesis.record_hash,
    eventType: "approve",
    recordedAt: new Date(Date.now() + 1000).toISOString(),
    actor: { kind: "human", id: "reviewer@example.invalid", role: "reviewer" },
    approvedCommit: head,
    reason: "Approving the coverage census drift caused by the deliberate reclassification landed in this commit.",
    fixtures: ["standard-net-cash-v2"],
    differenceClasses: ["coverage_census_drift"],
  });
  check(validateGoldenApprovalLedger([genesis, approve]).status === "PASS", "a well-formed two-record chain validates");
  const edited = { ...clone(approve), reason: `${approve.reason} (and also everything else)` };
  check(
    validateGoldenApprovalLedger([genesis, edited]).findings.some((finding) => finding.includes("edited after sealing")),
    "a ledger record edited after sealing is refused",
  );
  check(
    validateGoldenApprovalLedger([genesis, { ...clone(approve), sequence: 2 }]).findings.some((finding) =>
      finding.includes("contiguous from 0"),
    ),
    "a sequence gap in the ledger is refused",
  );
  check(
    validateGoldenApprovalLedger([approve, genesis]).findings.some((finding) => finding.includes("does not chain onto")),
    "a reordered ledger is refused",
  );
  check(
    validateGoldenApprovalLedger([genesis, approve, approve]).findings.some((finding) => finding.includes("replay")),
    "a replayed ledger record is refused",
  );
  check(
    validateGoldenApprovalLedger([approve]).findings.some((finding) => finding.includes("genesis")),
    "a ledger whose first record is not the genesis freeze is refused",
  );
  check(validateGoldenApprovalLedger([]).status === "FAIL", "an empty ledger is not a freeze");
  const regenerate = createGoldenApprovalRecord({
    sequence: 2,
    previousRecordHash: approve.record_hash,
    eventType: "regenerate",
    recordedAt: new Date(Date.now() + 2000).toISOString(),
    actor: approve.actor,
    approvedCommit: head,
    reason: approve.reason,
    fixtures: ["standard-net-cash-v2"],
    differenceClasses: ["coverage_census_drift"],
    approvalRecordHash: approve.record_hash,
    goldens: [{ fixture_id: "standard-net-cash-v2", record_sha256: "b".repeat(64) }],
  });
  check(
    validateGoldenApprovalLedger([genesis, approve, regenerate]).status === "PASS",
    "approve-then-regenerate is a valid chain",
  );
  const second = createGoldenApprovalRecord({
    sequence: 3,
    previousRecordHash: regenerate.record_hash,
    eventType: "regenerate",
    recordedAt: new Date(Date.now() + 3000).toISOString(),
    actor: approve.actor,
    approvedCommit: head,
    reason: approve.reason,
    fixtures: ["standard-net-cash-v2"],
    differenceClasses: ["coverage_census_drift"],
    approvalRecordHash: approve.record_hash,
    goldens: [{ fixture_id: "standard-net-cash-v2", record_sha256: "c".repeat(64) }],
  });
  check(
    validateGoldenApprovalLedger([genesis, approve, regenerate, second]).findings.some((finding) =>
      finding.includes("single-use"),
    ),
    "one approval may not authorise a second regeneration",
  );
  const backdated = { ...clone(approve), recorded_at: "1999-01-01T00:00:00.000Z" };
  check(
    validateGoldenApprovalLedger([
      genesis,
      { ...backdated, record_hash: goldenApprovalRecordHash(backdated) },
    ]).findings.some((finding) => finding.includes("backwards in time")),
    "a backdated ledger record is refused",
  );
}

// An approval CANNOT be constructed for a never-acceptable class, by anyone, for
// any reason. This is the lock that makes a collapse unregenerable.
for (const classId of NEVER_ACCEPTABLE_CLASSES) {
  assert.throws(
    () =>
      createGoldenApprovalRecord({
        sequence: 1,
        previousRecordHash: "d".repeat(64),
        eventType: "approve",
        recordedAt: new Date().toISOString(),
        actor: { kind: "human", id: "someone@example.invalid" },
        approvedCommit: "e31b53e",
        reason: "I have read the diff and I am satisfied that this regression is actually fine, honestly.",
        fixtures: ["standard-net-cash-v2"],
        differenceClasses: [classId],
      }),
    new RegExp(`${classId} is NEVER acceptable`),
    `an approval record declaring ${classId} must be impossible to construct`,
  );
  checks += 1;
}
// AUTOMATION MAY NOT APPROVE, AND MAY NOT FREEZE. A golden pins what "correct"
// means; automation that can freeze can pin its own defects as correct.
assert.throws(
  () =>
    createGoldenApprovalRecord({
      sequence: 1,
      previousRecordHash: "d".repeat(64),
      eventType: "approve",
      recordedAt: new Date().toISOString(),
      actor: { kind: "automation", id: "ci" },
      approvedCommit: "e31b53e",
      reason: "CI decided the new numbers look better than the old numbers, so it updated them.",
      fixtures: ["x"],
      differenceClasses: ["economic_drift"],
    }),
  /humans approve/,
  "automation may not approve a golden regeneration",
);
checks += 1;
assert.throws(
  () =>
    createGoldenApprovalRecord({
      sequence: 0,
      previousRecordHash: null,
      eventType: "freeze",
      recordedAt: new Date().toISOString(),
      actor: { kind: "automated_agent", id: "some-agent" },
      approvedCommit: "e31b53e",
      reason: "An agent freezing the behaviour it just implemented, with a perfectly plausible reason attached.",
      fixtures: ["x"],
      differenceClasses: [],
      goldens: [{ fixture_id: "x", record_sha256: "a".repeat(64) }],
    }),
  /humans approve/,
  "no non-human actor kind can perform the genesis freeze either",
);
checks += 1;
assert.throws(
  () =>
    createGoldenApprovalRecord({
      sequence: 1,
      previousRecordHash: "d".repeat(64),
      eventType: "approve",
      recordedAt: new Date().toISOString(),
      actor: { kind: "human", id: "someone@example.invalid" },
      approvedCommit: "e31b53e",
      reason: "fix tests",
      fixtures: ["x"],
      differenceClasses: ["economic_drift"],
    }),
  /at least 40 characters/,
  '"fix tests" is not a reason',
);
checks += 1;
assert.throws(
  () =>
    createGoldenApprovalRecord({
      sequence: 1,
      previousRecordHash: "d".repeat(64),
      eventType: "approve",
      recordedAt: new Date().toISOString(),
      actor: { kind: "human", id: "someone@example.invalid" },
      approvedCommit: "e31b53e",
      reason: "A perfectly good reason that is comfortably longer than the minimum length required here.",
      fixtures: ["x"],
      differenceClasses: [],
    }),
  /must declare the difference classes/,
  "an approval that names no difference class is refused",
);
checks += 1;
// The schema itself pins the human rule, so a hand-written record cannot dodge it.
{
  const schema = JSON.parse(
    await fs.readFile(path.join(ROOT, "assets", "behavioural-golden-v1.schema.json"), "utf8"),
  );
  check(
    schema.properties.certification.properties.frozen_by.properties.kind.const === "human",
    "the golden schema pins certification.frozen_by.kind at the constant \"human\"",
  );
}

// ===========================================================================
// (H) The regeneration gate, driven through the real command.
// ===========================================================================

// MUTATION 4 — regeneration WITHOUT an approval record must refuse.
{
  const dir = await freshGoldensDir();
  const result = await runCommand(["regenerate", "--goldens-dir", dir]);
  const body = refusal(result);
  check(result.code === 3, "MUTATION 4: regeneration without an approval record exits non-zero");
  check(
    body.status === "REFUSED" && body.reason_code === "no_approval_record_named",
    `MUTATION 4: the refusal reason is no_approval_record_named (got ${body.reason_code})`,
  );
  check(
    /never regenerated to make a test pass/.test(body.message),
    "MUTATION 4: the refusal says a golden is never regenerated to make a test pass",
  );
  check(
    JSON.parse(await fs.readFile(goldenRecordPath("standard-net-cash-v2", dir), "utf8")).record_sha256 ===
      baseline.record_sha256,
    "MUTATION 4: the refused regeneration wrote nothing",
  );
}

// MUTATION 5 — an approval record for a DIFFERENT commit must refuse.
{
  const dir = await freshGoldensDir();
  const { stdout: parent } = await exec("git", ["rev-parse", "HEAD~1"], { cwd: ROOT });
  const tip = await readGoldenApprovalLedger(approvalLedgerPath(dir));
  const stale = createGoldenApprovalRecord({
    sequence: tip.record_count,
    previousRecordHash: tip.tip_record_hash,
    eventType: "approve",
    recordedAt: new Date().toISOString(),
    actor: { kind: "human", id: "reviewer@example.invalid", role: "reviewer" },
    approvedCommit: parent.trim(),
    workingTreeState: "clean",
    reason: "Approved yesterday against the previous commit, before the tree moved underneath the approval.",
    fixtures: [...certified],
    differenceClasses: ["economic_drift", "coverage_census_drift"],
  });
  await appendGoldenApprovalRecord({ goldensDir: dir, record: stale });
  const body = refusal(await runCommand(["regenerate", "--goldens-dir", dir, "--approval", stale.record_hash]));
  check(
    body.reason_code === "approval_commit_mismatch",
    `MUTATION 5: an approval for another commit is refused with approval_commit_mismatch (got ${body.reason_code})`,
  );
  check(
    body.message.includes(parent.trim()) && body.message.includes(await currentCommit()),
    "MUTATION 5: the refusal names both the approved commit and HEAD",
  );
}

// An approval cannot launder a NEVER-ACCEPTABLE difference.
{
  const dir = await freshGoldensDir();
  const collapsed = clone(baseline);
  collapsed.twelve_state_census.reported_zero -= 9;
  collapsed.twelve_state_census.unresolved += 9;
  collapsed.slot_shape.value_bearing_slots -= 9;
  collapsed.slot_shape.never_zero_slots += 9;
  await fs.writeFile(
    goldenRecordPath("standard-net-cash-v2", dir),
    `${JSON.stringify(reseal(collapsed), null, 2)}\n`,
    "utf8",
  );
  const tip = await readGoldenApprovalLedger(approvalLedgerPath(dir));
  const approval = createGoldenApprovalRecord({
    sequence: tip.record_count,
    previousRecordHash: tip.tip_record_hash,
    eventType: "approve",
    recordedAt: new Date().toISOString(),
    actor: { kind: "human", id: "reviewer@example.invalid", role: "reviewer" },
    approvedCommit: await currentCommit(),
    workingTreeState: "dirty",
    reason: "Approving every approvable class across both fixtures so the frozen set can be brought forward.",
    fixtures: [...certified],
    differenceClasses: GOLDEN_DIFFERENCE_CLASSES.filter((id) => !isNeverAcceptable(id)),
  });
  await appendGoldenApprovalRecord({ goldensDir: dir, record: approval });
  const body = refusal(await runCommand(["regenerate", "--goldens-dir", dir, "--approval", approval.record_hash]));
  check(
    body.reason_code === "difference_never_acceptable",
    `a never-acceptable difference refuses regeneration even under a valid approval (got ${body.reason_code})`,
  );
  check(/Fix the code, not the golden/.test(body.message), "the refusal tells the caller to fix the code");
  check(
    JSON.parse(await fs.readFile(goldenRecordPath("standard-net-cash-v2", dir), "utf8")).twelve_state_census
      .unresolved === collapsed.twelve_state_census.unresolved,
    "the refused regeneration wrote nothing and repaired nothing",
  );
}

// An approval that does not NAME the observed class is refused.
{
  const dir = await freshGoldensDir();
  const drifted = clone(baseline);
  drifted.seal.content_sha256 = "1".repeat(64);
  await fs.writeFile(
    goldenRecordPath("standard-net-cash-v2", dir),
    `${JSON.stringify(reseal(drifted), null, 2)}\n`,
    "utf8",
  );
  const tip = await readGoldenApprovalLedger(approvalLedgerPath(dir));
  const narrow = createGoldenApprovalRecord({
    sequence: tip.record_count,
    previousRecordHash: tip.tip_record_hash,
    eventType: "approve",
    recordedAt: new Date().toISOString(),
    actor: { kind: "human", id: "reviewer@example.invalid", role: "reviewer" },
    approvedCommit: await currentCommit(),
    workingTreeState: "dirty",
    reason: "Approving only a contract-version bump; nothing about the economics of either fixture was reviewed.",
    fixtures: [...certified],
    differenceClasses: ["contract_version_bump"],
  });
  await appendGoldenApprovalRecord({ goldensDir: dir, record: narrow });
  check(
    refusal(await runCommand(["regenerate", "--goldens-dir", dir, "--approval", narrow.record_hash])).reason_code ===
      "approval_class_not_declared",
    "an approval covers only the classes it names",
  );
}

// A no-op regeneration is refused rather than silently consuming an approval.
{
  const dir = await freshGoldensDir();
  const tip = await readGoldenApprovalLedger(approvalLedgerPath(dir));
  const approval = createGoldenApprovalRecord({
    sequence: tip.record_count,
    previousRecordHash: tip.tip_record_hash,
    eventType: "approve",
    recordedAt: new Date().toISOString(),
    actor: { kind: "human", id: "reviewer@example.invalid", role: "reviewer" },
    approvedCommit: await currentCommit(),
    workingTreeState: "dirty",
    reason: "Speculatively approving an economic drift that has not actually happened in this tree yet.",
    fixtures: [...certified],
    differenceClasses: ["economic_drift"],
  });
  await appendGoldenApprovalRecord({ goldensDir: dir, record: approval });
  check(
    refusal(await runCommand(["regenerate", "--goldens-dir", dir, "--approval", approval.record_hash])).reason_code ===
      "nothing_to_regenerate",
    "a no-op regeneration is refused rather than consuming an approval",
  );
}

// The LAWFUL path works, is recorded, and the approval is then spent.
{
  const dir = await freshGoldensDir();
  const drifted = clone(baseline);
  drifted.seal.content_sha256 = "2".repeat(64);
  await fs.writeFile(
    goldenRecordPath("standard-net-cash-v2", dir),
    `${JSON.stringify(reseal(drifted), null, 2)}\n`,
    "utf8",
  );
  const tip = await readGoldenApprovalLedger(approvalLedgerPath(dir));
  const approval = createGoldenApprovalRecord({
    sequence: tip.record_count,
    previousRecordHash: tip.tip_record_hash,
    eventType: "approve",
    recordedAt: new Date().toISOString(),
    actor: { kind: "human", id: "reviewer@example.invalid", role: "reviewer" },
    approvedCommit: await currentCommit(),
    workingTreeState: "dirty",
    reason: "Reviewed the economic drift on standard-net-cash-v2 line by line and confirmed it is the intended change.",
    fixtures: [...certified],
    differenceClasses: ["economic_drift"],
  });
  await appendGoldenApprovalRecord({ goldensDir: dir, record: approval });
  const before = await fs.readFile(approvalLedgerPath(dir), "utf8");
  const result = await runCommand(["regenerate", "--goldens-dir", dir, "--approval", approval.record_hash]);
  check(result.code === 0, `the lawful regeneration path succeeds: ${result.stderr}`);
  check(JSON.parse(result.stdout).status === "REGENERATED", "the lawful path reports REGENERATED");
  const regenerated = JSON.parse(await fs.readFile(goldenRecordPath("standard-net-cash-v2", dir), "utf8"));
  check(
    regenerated.seal.content_sha256 === baseline.seal.content_sha256,
    "the regenerated record carries the seal the live pipeline actually produces",
  );
  check(
    regenerated.certification.freeze_event === "approved_regeneration" &&
      regenerated.certification.approval_record_hash === approval.record_hash &&
      regenerated.certification.frozen_by.id === "reviewer@example.invalid" &&
      regenerated.certification.approval_reason === approval.reason,
    "the regenerated record records WHO approved it, WHY, and under which approval",
  );
  const after = await fs.readFile(approvalLedgerPath(dir), "utf8");
  check(after.startsWith(before), "the regeneration APPENDED to the ledger without touching earlier bytes");
  const reread = await readGoldenApprovalLedger(approvalLedgerPath(dir));
  check(reread.status === "PASS", `the ledger still validates after the regeneration: ${reread.findings[0]}`);
  check(
    reread.records.at(-1).event_type === "regenerate" &&
      reread.records.at(-1).consumed_approval_record_hash === approval.record_hash,
    "the regeneration appended a record consuming its approval",
  );
  check(
    (await compareFrozenSet({ goldensDir: dir })).status === "MATCH",
    "after the lawful regeneration the frozen set matches",
  );
  check(
    refusal(await runCommand(["regenerate", "--goldens-dir", dir, "--approval", approval.record_hash])).reason_code ===
      "approval_already_consumed",
    "a spent approval cannot authorise a second regeneration",
  );
}

// Unknown or non-approve record hashes, and a tampered ledger.
{
  const dir = await freshGoldensDir();
  check(
    refusal(await runCommand(["regenerate", "--goldens-dir", dir, "--approval", "9".repeat(64)])).reason_code ===
      "approval_record_absent",
    "an approval hash that does not exist is refused",
  );
  const genesisHash = (await readGoldenApprovalLedger(approvalLedgerPath(dir))).records[0].record_hash;
  check(
    refusal(await runCommand(["regenerate", "--goldens-dir", dir, "--approval", genesisHash])).reason_code ===
      "approval_not_an_approve_event",
    "the genesis freeze is not an approval and cannot authorise a regeneration",
  );
}
{
  const dir = await freshGoldensDir();
  const text = await fs.readFile(approvalLedgerPath(dir), "utf8");
  await fs.writeFile(approvalLedgerPath(dir), text.replace(/"reason":"[^"]*"/, '"reason":"tampered"'), "utf8");
  check(
    refusal(await runCommand(["regenerate", "--goldens-dir", dir, "--approval", "9".repeat(64)])).reason_code ===
      "approval_ledger_invalid",
    "a tampered ledger refuses every regeneration",
  );
  const tip = await readGoldenApprovalLedger(approvalLedgerPath(dir));
  await assert.rejects(
    appendGoldenApprovalRecord({
      goldensDir: dir,
      record: createGoldenApprovalRecord({
        sequence: 1,
        previousRecordHash: tip.tip_record_hash ?? "e".repeat(64),
        eventType: "approve",
        recordedAt: new Date().toISOString(),
        actor: { kind: "human", id: "reviewer@example.invalid" },
        approvedCommit: await currentCommit(),
        reason: "Trying to append a fresh approval on top of a ledger that has already been tampered with.",
        fixtures: [...certified],
        differenceClasses: ["economic_drift"],
      }),
    }),
    /does not validate/,
    "an append onto a tampered ledger is refused rather than repaired",
  );
  checks += 1;
}

// `freeze` is refused once a ledger exists, so it is not a back door.
{
  const dir = await freshGoldensDir();
  const body = refusal(
    await runCommand([
      "freeze",
      "--goldens-dir",
      dir,
      "--actor",
      "someone@example.invalid",
      "--reason",
      "Re-freezing the whole set from scratch instead of getting an approval for the difference.",
    ]),
  );
  check(
    body.reason_code === "approval_ledger_invalid" && /genesis freeze happens once/.test(body.message),
    "freeze is refused once a ledger exists, so it is not a back door around the approval gate",
  );
}

// The bare command regenerates nothing and says so.
{
  const bare = await runCommand([]);
  check(bare.code === 2, "the command with no verb does nothing and exits non-zero");
  check(
    /No verb regenerates anything by default, and no CI gate may invoke this command/.test(bare.stderr),
    "the usage text states that nothing regenerates by default and no gate may invoke the command",
  );
}

// `status` compares and refuses to update.
{
  const dir = await freshGoldensDir();
  const drifted = clone(baseline);
  drifted.seal.content_sha256 = "3".repeat(64);
  await fs.writeFile(
    goldenRecordPath("standard-net-cash-v2", dir),
    `${JSON.stringify(reseal(drifted), null, 2)}\n`,
    "utf8",
  );
  const result = await runCommand(["status", "--goldens-dir", dir]);
  check(result.code === 1, "status exits non-zero when the frozen set does not match");
  check(/will not update it for you/.test(result.stderr), "status states that it will not update the frozen set");
  check(
    JSON.parse(await fs.readFile(goldenRecordPath("standard-net-cash-v2", dir), "utf8")).seal.content_sha256 ===
      "3".repeat(64),
    "status changed nothing on disk",
  );
}

// `status` reports PRE-FREEZE loudly and does not treat it as a failure.
{
  const bare = await fs.mkdtemp(path.join(scratch, "status-unfrozen-"));
  const result = await runCommand(["status", "--goldens-dir", bare]);
  check(result.code === 0, "status exits 0 in PRE-FREEZE: nothing frozen is a lawful state, not a mismatch");
  const body = JSON.parse(result.stdout);
  check(
    body.status === "PRE_FREEZE" && body.frozen === false && body.frozen_set_state === "PRE_FREEZE",
    "status reports PRE_FREEZE and frozen: false in its JSON",
  );
  check(
    /PRE-FREEZE: NOTHING IS FROZEN/.test(result.stderr),
    "status announces PRE-FREEZE loudly on stderr",
  );
  check(
    /a HUMAN act/.test(result.stderr) && /--actor/.test(result.stderr),
    "the PRE-FREEZE banner says the genesis freeze is a human act and shows the command a human runs",
  );
  check(
    /automation that can freeze can pin its own defects as correct/.test(
      result.stderr.replace(/\s+/g, " "),
    ),
    "the PRE-FREEZE banner explains WHY nothing automated may freeze",
  );
}

// ===========================================================================
// (I) Structural proofs: this gate cannot update the real frozen set, and no
// flag exists anywhere that would let a caller accept a difference.
// ===========================================================================
{
  const gateSource = await fs.readFile(fileURLToPath(import.meta.url), "utf8");
  const importBlock = /import \{([\s\S]*?)\} from "\.\/lib\/behavioural_golden\.mjs";/.exec(gateSource);
  check(importBlock !== null, "the gate imports its mechanism from the golden library");
  check(
    !/\bregenerateBehaviouralGoldens\b/.test(importBlock[1]),
    "the gate does not import the regeneration function at all",
  );
  // (G3) The gate DOES import freezeBehaviouralGoldens — to build a throwaway
  // fixture — so prove structurally that it can only ever target a temp dir.
  check(
    /goldensDir: dir,/.test(
      /async function freezeIntoTempDir[\s\S]*?^}/m.exec(gateSource)?.[0] ?? "",
    ) &&
      /freezeBehaviouralGoldens\(/g.test(gateSource) &&
      (gateSource.match(/freezeBehaviouralGoldens\(/g) ?? []).length === 1,
    "the only freeze call in this gate is the guarded temp-directory fixture",
  );
  check(
    /assert\.ok\(\s*dir\.startsWith\(os\.tmpdir\(\)\)/.test(gateSource),
    "that single freeze call is guarded by an assertion that its target is a temp directory",
  );
  const commandSource = await fs.readFile(COMMAND, "utf8");
  for (const flag of ["--update", "--fix", "--accept", "--force", "--yes", "--bless"]) {
    check(
      !commandSource.includes(`"${flag}"`) && !commandSource.includes(`'${flag}'`),
      `no ${flag} flag exists in the regeneration command`,
    );
  }
  check(
    !/--actor-kind/.test(commandSource),
    "the command offers no way to declare a non-human actor kind",
  );
  const librarySource = await fs.readFile(path.join(ROOT, "scripts", "lib", "behavioural_golden.mjs"), "utf8");
  check(
    !/function compareBehaviouralGolden[\s\S]{0,4000}writeFile/.test(librarySource),
    "the comparator writes no file: it cannot rewrite its own expectation",
  );
  check(REGENERATION_REFUSAL_CODES.length === 10, "the regeneration path declares its ten refusal codes");
  check(
    VALUE_BEARING_STATES.length === 4 && NEVER_ZERO_STATES.length === 8,
    "the never-zero predicate is built on the contract's own four value-bearing and eight never-zero states",
  );
  const readme = await fs.readFile(path.join(ROOT, "goldens", "README.md"), "utf8");
  check(
    readme.includes("What a record deliberately does NOT pin"),
    "goldens/README.md states what is NOT pinned as well as what is",
  );
  check(
    /PRE-FREEZE/.test(readme),
    "goldens/README.md documents the PRE-FREEZE state",
  );
  // The real tree was not written to by this run.
  const realNow = await frozenSetState();
  check(
    realNow.state === realState.state,
    "this run left the real frozen set in exactly the state it found it",
  );
  if (!FROZEN) {
    check(
      (await listBehaviouralGoldens()).length === 0,
      "this run created no golden record in the real tree",
    );
  }
}

await fs.rm(scratch, { recursive: true, force: true });

if (!FROZEN) {
  console.error(
    [
      "",
      "  PRE-FREEZE: the behavioural-golden MECHANISM is verified, but NOTHING IS",
      "  FROZEN. There is no approval ledger, so no golden record exists and no",
      "  v3.7.7 behaviour is pinned. The frozen half of this gate was exercised at",
      "  full strength against a throwaway temp freeze.",
      "",
      "  The genesis freeze is a HUMAN act and is still pending:",
      "    node scripts/regenerate_behavioural_goldens.mjs freeze \\",
      "        --actor <your id> --role <your role> --reason \"<why>\"",
      "",
    ].join("\n"),
  );
}

console.log(JSON.stringify({ status: "PASS", checks, frozen: FROZEN }));
