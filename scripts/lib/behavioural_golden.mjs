/**
 * P7.2 — behavioural goldens over the canonical Economic IR.
 *
 * v3.7.7 behaviour is frozen as a set of GOLDEN RECORDS whose primary economic
 * truth is the canonical Economic IR (scripts/lib/economic_ir.mjs), NOT the
 * emitted workbook. Four things make the freeze real and this module owns all
 * four:
 *
 *   1. THE RECORD. compileBehaviouralGolden drives a certified fixture through
 *      the REAL pipeline (compileModelIrV3, which shadow-attaches the IR), reads
 *      the IR the pipeline actually produced, and derives every pinned fact from
 *      it. Nothing here is hand-transcribed: the census, the histogram and the
 *      schedule pattern are computed by walking the IR's own typed slots.
 *
 *   2. THE TAXONOMY. Every difference between an expected and an actual record
 *      is CLASSIFIED. The class set and — critically — each class's
 *      acceptability live HERE, in code (GOLDEN_DIFFERENCE_CLASS_CONTRACT), in
 *      the same discipline as release_journal.mjs's clause contract, so the
 *      asset can never quietly drop a class or promote a never-acceptable class
 *      to an approvable one. A pinned fact that differs and matches no class
 *      becomes `unclassified_difference`, which is never acceptable — the
 *      classifier cannot be defeated by adding a new fact.
 *
 *   3. THE LEDGER. goldens/approval-ledger.jsonl is append-only and
 *      hash-chained in the discipline of scripts/lib/release_journal.mjs
 *      (P8.6a): record_hash is the canonical digest of the body with
 *      record_hash removed, previous_record_hash is the preceding record's
 *      record_hash. It records WHO approved a regeneration, WHEN, WHY, against
 *      WHICH commit and for WHICH difference classes. An approval is single-use.
 *
 *   4. THE REFUSALS. Validators validate and never repair. compareBehaviouralGolden
 *      returns a verdict; it has no update path and no "--fix" affordance, by
 *      construction. Regeneration lives in a SEPARATE, explicitly-invoked
 *      command (scripts/regenerate_behavioural_goldens.mjs) that refuses without
 *      an approval record, refuses an approval granted against a different
 *      commit, refuses an approval that does not name the classes actually
 *      observed, and refuses ALWAYS — approval or not — when any observed
 *      difference is never-acceptable.
 *
 * The never-acceptable classes are the point of the whole package. A
 * `bare_number_slots` count moving off 0, or `missing`/`unresolved`/
 * `not_applicable` collapsing into `reported_zero`, is precisely the
 * never-zero regression the freeze exists to catch. No approval record, no
 * actor and no reason can make those regenerable.
 *
 * Deliberate non-goal: this module pins NO workbook artefact. Not the bytes,
 * not the manifest, not a cell address, not a formula string. The register
 * warns against whole-workbook goldens and the Economic IR exists precisely so
 * the freeze can name economic truth instead. See goldens/README.md.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ECONOMIC_IR_SCHEMA_VERSION,
  ECONOMIC_IR_SHADOW_PROPERTY,
  compileEconomicIr,
  economicIrTypedSlots,
  shadowEconomicIrOf,
  validateEconomicIr,
} from "./economic_ir.mjs";
import { canonicaliseIdentity, identitySha256 } from "./identity_vocabulary.mjs";
import { validateJsonSchema } from "./json_schema.mjs";
import { NEVER_ZERO_STATES, VALUE_BEARING_STATES } from "./typed_financial_value.mjs";
import { compileInstrumentPeriodState } from "./instrument_period_state.mjs";
import { compileModelIrV3 } from "./model_ir_v3.mjs";
import { compileRowPlan } from "./row_plan.mjs";
import { compileSemanticManifest } from "./semantic_graph.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../..");
const ASSETS = path.join(REPO_ROOT, "assets");
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

export const BEHAVIOURAL_GOLDEN_SCHEMA_VERSION = "excel-inflow-behavioural-golden/1.0";
export const GOLDEN_APPROVAL_SCHEMA_VERSION = "excel-inflow-golden-approval/1.0";
export const GOLDEN_DIFFERENCE_TAXONOMY_SCHEMA_VERSION =
  "excel-inflow-golden-difference-taxonomy/1.0";

export const GOLDENS_DIRNAME = "goldens";
export const GOLDEN_RECORD_SUBDIR = "economic-ir";
export const APPROVAL_LEDGER_FILENAME = "approval-ledger.jsonl";
export const CERTIFIED_FIXTURE_DIR = path.join(REPO_ROOT, "test-fixtures", "cases");

/** The frozen release these goldens certify. */
export const FROZEN_RELEASE = "v3.7.7";

/** The twelve typed states, in one declared order, so a census is comparable. */
export const ALL_TYPED_STATES = Object.freeze([
  ...VALUE_BEARING_STATES,
  ...NEVER_ZERO_STATES,
]);

/** The schedule families the IR compiles per forecast period. */
export const SCHEDULE_FAMILIES = Object.freeze(["acquisition", "cash", "rcf"]);

export const GOLDEN_APPROVAL_EVENT_TYPES = Object.freeze([
  "freeze",
  "approve",
  "regenerate",
]);

export const NEVER_ACCEPTABLE = "never_acceptable";
export const REQUIRES_APPROVAL = "requires_approval";

/**
 * THE DIFFERENCE TAXONOMY, declared in code.
 *
 * `acceptability` is the whole safety property. A class marked
 * NEVER_ACCEPTABLE can never be approved, never be pre-declared on an approval
 * record, and never be regenerated past — regardless of who asks or why. The
 * asset assets/golden-difference-taxonomy-v1.json must mirror this contract
 * exactly; validateGoldenDifferenceTaxonomy refuses any asset that drops a
 * class, invents one, or flips an acceptability.
 */
export const GOLDEN_DIFFERENCE_CLASS_CONTRACT = Object.freeze({
  fixture_identity_drift: Object.freeze({
    acceptability: REQUIRES_APPROVAL,
    detects: "case_id, case_sha256 or evidence_epoch_sha256 moved: the fixture itself was re-cut.",
  }),
  contract_version_bump: Object.freeze({
    acceptability: REQUIRES_APPROVAL,
    detects:
      "a declared contract version moved (economic-ir, typed_financial_value, schedule_typed_states or the proof projection schema).",
  }),
  economic_drift: Object.freeze({
    acceptability: REQUIRES_APPROVAL,
    detects: "the Economic IR seal content hash moved: economic truth changed.",
  }),
  coverage_census_drift: Object.freeze({
    acceptability: REQUIRES_APPROVAL,
    detects:
      "the twelve-state census moved in a direction that is not a never-zero collapse.",
  }),
  slot_shape_drift: Object.freeze({
    acceptability: REQUIRES_APPROVAL,
    detects:
      "a typed-slot shape count moved (total, historical, forecast, schedule, value-bearing or never-zero).",
  }),
  historical_basis_drift: Object.freeze({
    acceptability: REQUIRES_APPROVAL,
    detects: "the historical_basis histogram or the economic node count moved.",
  }),
  schedule_shape_drift: Object.freeze({
    acceptability: REQUIRES_APPROVAL,
    detects:
      "the forecast schedule period count, period ids, or a family's slot count or non-collapse state mix moved.",
  }),
  never_zero_collapse: Object.freeze({
    acceptability: NEVER_ACCEPTABLE,
    detects:
      "a never-zero state became a number: bare_number_slots moved off 0, or never-zero slots collapsed into value-bearing readings, or a schedule family's not_applicable slots became numbers. This is the regression the freeze exists to catch.",
  }),
  shadow_boundary_violation: Object.freeze({
    acceptability: NEVER_ACCEPTABLE,
    detects:
      "the Economic IR stopped being shadow: mode, gates_delivery, shadow status, or the non-enumerable attachment changed. Promoting the IR is a new schema version, never a golden update.",
  }),
  golden_record_corruption: Object.freeze({
    acceptability: NEVER_ACCEPTABLE,
    detects:
      "the golden record on disk does not satisfy its schema or its own record_sha256; it was edited after sealing.",
  }),
  golden_coverage_gap: Object.freeze({
    acceptability: NEVER_ACCEPTABLE,
    detects:
      "a certified fixture has no golden record, or a golden record names a fixture that no longer exists. Deleting a golden is not a way to pass.",
  }),
  uncertified_golden_present: Object.freeze({
    acceptability: NEVER_ACCEPTABLE,
    detects:
      "golden records exist but there is no approval ledger, so nothing certifies them. Shedding the certification history while keeping the records is not a route back to PRE_FREEZE.",
  }),
  unclassified_difference: Object.freeze({
    acceptability: NEVER_ACCEPTABLE,
    detects:
      "a pinned fact differs and no declared class named it. A new pinned fact must get a class before it can ever be approved.",
  }),
});

export const GOLDEN_DIFFERENCE_CLASSES = Object.freeze(
  Object.keys(GOLDEN_DIFFERENCE_CLASS_CONTRACT).sort(),
);

export const NEVER_ACCEPTABLE_CLASSES = Object.freeze(
  GOLDEN_DIFFERENCE_CLASSES.filter(
    (id) => GOLDEN_DIFFERENCE_CLASS_CONTRACT[id].acceptability === NEVER_ACCEPTABLE,
  ),
);

export function isNeverAcceptable(classId) {
  return GOLDEN_DIFFERENCE_CLASS_CONTRACT[classId]?.acceptability === NEVER_ACCEPTABLE;
}

function acceptabilityOf(classId) {
  return GOLDEN_DIFFERENCE_CLASS_CONTRACT[classId]?.acceptability ?? NEVER_ACCEPTABLE;
}

// ---------------------------------------------------------------------------
// Paths and small helpers.
// ---------------------------------------------------------------------------

export function goldensDirOf(root = REPO_ROOT) {
  return path.join(root, GOLDENS_DIRNAME);
}

export function goldenRecordPath(fixtureId, goldensDir = goldensDirOf()) {
  return path.join(goldensDir, GOLDEN_RECORD_SUBDIR, `${fixtureId}.json`);
}

export function approvalLedgerPath(goldensDir = goldensDirOf()) {
  return path.join(goldensDir, APPROVAL_LEDGER_FILENAME);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedCounts(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

/** The current HEAD commit, full sha. */
export async function currentCommit(root = REPO_ROOT) {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
  return stdout.trim();
}

/** "clean" or "dirty": whether the tree carries uncommitted changes. */
export async function workingTreeState(root = REPO_ROOT) {
  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: root });
  return stdout.trim() === "" ? "clean" : "dirty";
}

/**
 * Whether `candidate` is an ancestor-or-equal of HEAD. Used only to describe an
 * approval's commit in a refusal message; the refusal itself is equality.
 */
export async function isAncestorOfHead(candidate, root = REPO_ROOT) {
  const head = await currentCommit(root);
  return exec("git", ["merge-base", "--is-ancestor", candidate, head], { cwd: root }).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// Certified fixtures.
// ---------------------------------------------------------------------------

/**
 * The certified fixture roster is READ FROM DISK, never hard-coded, so a newly
 * certified fixture with no golden record raises golden_coverage_gap
 * automatically instead of being silently unfrozen.
 */
export async function listCertifiedFixtures(dir = CERTIFIED_FIXTURE_DIR) {
  const entries = await fs.readdir(dir);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.replace(/\.json$/, ""))
    .sort();
}

// ---------------------------------------------------------------------------
// (1) The record compiler. Every fact is DERIVED from the IR, never transcribed.
// ---------------------------------------------------------------------------

/**
 * Drive one certified fixture through the real pipeline and return both the
 * proof projection and the Economic IR the pipeline shadow-attached to it.
 */
export async function compileFixtureEconomicIr(fixtureId, { fixtureDir = CERTIFIED_FIXTURE_DIR } = {}) {
  const modelCase = JSON.parse(
    await fs.readFile(path.join(fixtureDir, `${fixtureId}.json`), "utf8"),
  );
  const instrumentPeriodState = compileInstrumentPeriodState(modelCase);
  const rowPlan = compileRowPlan(modelCase, { instrumentPeriodState });
  const semanticManifest = compileSemanticManifest(modelCase, rowPlan, {
    instrumentPeriodState,
  });
  const modelIr = compileModelIrV3({
    modelCase,
    rowPlan,
    semanticManifest,
    sourceCrosswalk: [],
  });
  const shadow = shadowEconomicIrOf(modelIr);
  if (!shadow || shadow.status !== "sealed" || !shadow.economic_ir) {
    throw new Error(
      `The pipeline attached no sealed Economic IR for ${fixtureId} (status ${JSON.stringify(
        shadow?.status ?? "absent",
      )}); a behavioural golden cannot be compiled from an unavailable IR.`,
    );
  }
  // The record pins the IR the PIPELINE produced. An independent direct compile
  // must agree — a shadow attach that diverged from compileEconomicIr would
  // make the golden pin the wrong object.
  const direct = compileEconomicIr({ modelCase, rowPlan, semanticManifest, modelIr });
  if (direct.seal.content_sha256 !== shadow.economic_ir.seal.content_sha256) {
    throw new Error(
      `The shadow-attached Economic IR for ${fixtureId} (${shadow.economic_ir.seal.content_sha256}) disagrees with a direct compile (${direct.seal.content_sha256}); the golden would pin an ambiguous object.`,
    );
  }
  const irErrors = validateEconomicIr(shadow.economic_ir);
  if (irErrors.length > 0) {
    throw new Error(
      `The Economic IR for ${fixtureId} is invalid (${irErrors.length}): ${irErrors[0]}`,
    );
  }
  return { modelCase, rowPlan, semanticManifest, modelIr, shadow, ir: shadow.economic_ir };
}

/** The historical_basis histogram over the IR's economic nodes. */
function historicalBasisHistogram(ir) {
  const counts = new Map();
  for (const node of ir.nodes) {
    const basis = String(node.historical_basis);
    counts.set(basis, (counts.get(basis) ?? 0) + 1);
  }
  return sortedCounts(counts.entries());
}

/**
 * Per-schedule-family state census, computed by walking the IR's own typed
 * slots. This is where the RCF / acquisition not_applicable pattern is pinned:
 * a case with no acquisition must read not_applicable in EVERY period, and a
 * regeneration that turns those into numbers is a never-zero collapse.
 */
function scheduleFamilyCensus(ir) {
  const families = new Map();
  const notApplicableByPeriod = new Map();
  for (const [slotPath, slot] of economicIrTypedSlots(ir)) {
    const match = /^schedules\[(\d+)\]\.([a-z_]+)\./.exec(slotPath);
    if (!match) continue;
    const periodIndex = Number(match[1]);
    const family = match[2];
    if (!families.has(family)) {
      families.set(family, {
        slot_count: 0,
        by_state: Object.fromEntries(ALL_TYPED_STATES.map((state) => [state, 0])),
        not_applicable_slots: 0,
        value_bearing_slots: 0,
        bare_number_slots: 0,
      });
      notApplicableByPeriod.set(family, new Map());
    }
    const bucket = families.get(family);
    bucket.slot_count += 1;
    const state = isPlainObject(slot) ? slot.state : null;
    if (state === null || !Object.hasOwn(bucket.by_state, state)) {
      bucket.bare_number_slots += 1;
      continue;
    }
    bucket.by_state[state] += 1;
    if (VALUE_BEARING_STATES.includes(state)) bucket.value_bearing_slots += 1;
    if (state === "not_applicable") {
      bucket.not_applicable_slots += 1;
      const perPeriod = notApplicableByPeriod.get(family);
      perPeriod.set(periodIndex, (perPeriod.get(periodIndex) ?? 0) + 1);
    }
  }
  const periodCount = ir.schedules.length;
  const out = {};
  for (const [family, bucket] of [...families.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const perPeriod = notApplicableByPeriod.get(family);
    const slotsPerPeriod = periodCount > 0 ? bucket.slot_count / periodCount : 0;
    const fullPeriods = [...perPeriod.entries()]
      .filter(([, count]) => count === slotsPerPeriod)
      .map(([index]) => index)
      .sort((a, b) => a - b);
    let pattern;
    if (bucket.not_applicable_slots === 0) pattern = "not_applicable_in_no_period";
    else if (bucket.not_applicable_slots === bucket.slot_count)
      pattern = "not_applicable_in_every_period";
    else pattern = `not_applicable_in_periods:${JSON.stringify(fullPeriods)}`;
    out[family] = {
      slot_count: bucket.slot_count,
      slots_per_period: slotsPerPeriod,
      by_state: bucket.by_state,
      not_applicable_slots: bucket.not_applicable_slots,
      value_bearing_slots: bucket.value_bearing_slots,
      bare_number_slots: bucket.bare_number_slots,
      not_applicable_pattern: pattern,
    };
  }
  return out;
}

/**
 * The shadow-boundary invariant, pinned as a FACT rather than assumed. The IR
 * must declare shadow mode, must declare it gates nothing, must be attached
 * non-enumerably, and must therefore be ABSENT from the serialised projection.
 */
function shadowBoundaryFacts(modelIr, shadow, ir) {
  const serialised = JSON.stringify(modelIr);
  return {
    ir_mode: ir.mode,
    ir_gates_delivery: ir.gates_delivery,
    shadow_status: shadow.status,
    shadow_mode: shadow.mode,
    shadow_gates_delivery: shadow.gates_delivery,
    attachment_property: ECONOMIC_IR_SHADOW_PROPERTY,
    attached_enumerably: Object.keys(modelIr).includes(ECONOMIC_IR_SHADOW_PROPERTY),
    present_in_serialised_projection: serialised.includes(ECONOMIC_IR_SHADOW_PROPERTY),
  };
}

/** The record body hash: the canonical digest of the body sans record_sha256. */
export function behaviouralGoldenRecordSha256(record) {
  const { record_sha256: _ignored, ...body } = record;
  return identitySha256(body);
}

/**
 * Compile the behavioural golden record for one certified fixture. `certification`
 * is provenance (who froze it, when, against which commit, under which approval)
 * and is NOT compared; the pinned facts are everything else.
 */
export async function compileBehaviouralGolden(
  fixtureId,
  { fixtureDir = CERTIFIED_FIXTURE_DIR, certification = null } = {},
) {
  const { modelIr, shadow, ir } = await compileFixtureEconomicIr(fixtureId, { fixtureDir });
  const census = Object.fromEntries(
    ALL_TYPED_STATES.map((state) => [state, ir.coverage.by_state[state] ?? 0]),
  );
  const body = {
    schema_version: BEHAVIOURAL_GOLDEN_SCHEMA_VERSION,
    golden_kind: "economic_ir",
    frozen_release: FROZEN_RELEASE,
    fixture_id: fixtureId,
    fixture_path: path
      .relative(REPO_ROOT, path.join(fixtureDir, `${fixtureId}.json`))
      .split(path.sep)
      .join("/"),
    primary_economic_truth: {
      source: "scripts/lib/economic_ir.mjs::compileEconomicIr (shadow-attached by compileModelIrV3)",
      is_workbook: false,
      note: "The workbook is NOT pinned. See goldens/README.md for what is and is not frozen.",
    },
    certification: certification ?? null,
    identity: {
      case_id: ir.case_id,
      case_sha256: ir.case_sha256,
      evidence_epoch_sha256: ir.evidence_epoch_sha256,
    },
    contracts: {
      economic_ir: ir.schema_version,
      typed_financial_value: ir.contracts.typed_financial_value,
      schedule_typed_states: ir.contracts.schedule_typed_states,
      proof_projection_schema_version: ir.contracts.proof_projection_schema_version,
    },
    seal: {
      content_sha256: ir.seal.content_sha256,
      sealed_slots: ir.seal.sealed_slots,
    },
    slot_shape: {
      typed_slots: ir.coverage.typed_slots,
      historical_slots: ir.coverage.historical_slots,
      forecast_slots: ir.coverage.forecast_slots,
      schedule_slots: ir.coverage.schedule_slots,
      value_bearing_slots: ir.coverage.value_bearing_slots,
      never_zero_slots: ir.coverage.never_zero_slots,
      bare_number_slots: ir.coverage.bare_number_slots,
    },
    twelve_state_census: census,
    node_count: ir.nodes.length,
    historical_basis_histogram: historicalBasisHistogram(ir),
    schedules: {
      period_count: ir.schedules.length,
      historical_period_count: ir.periods.historical.length,
      forecast_period_count: ir.periods.forecast.length,
      period_ids: ir.schedules.map((period) => period.period_id),
      families: scheduleFamilyCensus(ir),
    },
    shadow_boundary: shadowBoundaryFacts(modelIr, shadow, ir),
  };
  const record = canonicaliseIdentity(body);
  record.record_sha256 = behaviouralGoldenRecordSha256(record);
  return record;
}

// ---------------------------------------------------------------------------
// Schema + taxonomy asset validation.
// ---------------------------------------------------------------------------

let cached = null;
async function assets(assetsDir = ASSETS) {
  if (cached && cached.dir === assetsDir) return cached;
  const [recordSchema, taxonomy] = await Promise.all([
    fs
      .readFile(path.join(assetsDir, "behavioural-golden-v1.schema.json"), "utf8")
      .then(JSON.parse),
    fs
      .readFile(path.join(assetsDir, "golden-difference-taxonomy-v1.json"), "utf8")
      .then(JSON.parse),
  ]);
  cached = { dir: assetsDir, recordSchema, taxonomy };
  return cached;
}

export async function loadGoldenDifferenceTaxonomy({ assetsDir = ASSETS } = {}) {
  const { taxonomy } = await assets(assetsDir);
  return taxonomy;
}

export async function loadBehaviouralGoldenSchema({ assetsDir = ASSETS } = {}) {
  const { recordSchema } = await assets(assetsDir);
  return recordSchema;
}

/**
 * The asset must mirror the code contract EXACTLY. This is the lock that stops
 * a future edit from making never_zero_collapse approvable by editing JSON.
 */
export function validateGoldenDifferenceTaxonomy(taxonomy) {
  const findings = [];
  if (!isPlainObject(taxonomy)) return ["the golden difference taxonomy is not an object."];
  if (taxonomy.schema_version !== GOLDEN_DIFFERENCE_TAXONOMY_SCHEMA_VERSION) {
    findings.push(
      `taxonomy.schema_version must be ${JSON.stringify(GOLDEN_DIFFERENCE_TAXONOMY_SCHEMA_VERSION)}; got ${JSON.stringify(taxonomy.schema_version)}.`,
    );
  }
  if (taxonomy.frozen_release !== FROZEN_RELEASE) {
    findings.push(
      `taxonomy.frozen_release must be ${JSON.stringify(FROZEN_RELEASE)}; got ${JSON.stringify(taxonomy.frozen_release)}.`,
    );
  }
  const classes = isPlainObject(taxonomy.classes) ? taxonomy.classes : {};
  for (const id of GOLDEN_DIFFERENCE_CLASSES) {
    const declared = classes[id];
    if (!isPlainObject(declared)) {
      findings.push(
        `taxonomy.classes.${id} is missing; the class set is declared in GOLDEN_DIFFERENCE_CLASS_CONTRACT and the asset may not drop a class.`,
      );
      continue;
    }
    const expected = GOLDEN_DIFFERENCE_CLASS_CONTRACT[id].acceptability;
    if (declared.acceptability !== expected) {
      findings.push(
        `taxonomy.classes.${id}.acceptability is ${JSON.stringify(declared.acceptability)} but the code contract declares ${JSON.stringify(expected)}; acceptability may not be changed by editing the asset.`,
      );
    }
    if (declared.detects !== GOLDEN_DIFFERENCE_CLASS_CONTRACT[id].detects) {
      findings.push(
        `taxonomy.classes.${id}.detects does not match the code contract verbatim; what a class detects is owned by GOLDEN_DIFFERENCE_CLASS_CONTRACT, so the asset cannot describe a class as catching something it does not.`,
      );
    }
    if (
      expected === NEVER_ACCEPTABLE &&
      declared.approvable_by_any_actor_or_reason !== false
    ) {
      findings.push(
        `taxonomy.classes.${id} is never-acceptable and must declare approvable_by_any_actor_or_reason: false.`,
      );
    }
  }
  for (const id of Object.keys(classes)) {
    if (!GOLDEN_DIFFERENCE_CLASSES.includes(id)) {
      findings.push(
        `taxonomy.classes.${id} is not a declared difference class; a class must exist in GOLDEN_DIFFERENCE_CLASS_CONTRACT before the asset may name it.`,
      );
    }
  }
  const neverList = Array.isArray(taxonomy.never_acceptable_classes)
    ? [...taxonomy.never_acceptable_classes].sort()
    : null;
  if (!neverList || JSON.stringify(neverList) !== JSON.stringify([...NEVER_ACCEPTABLE_CLASSES].sort())) {
    findings.push(
      `taxonomy.never_acceptable_classes must be exactly ${JSON.stringify([...NEVER_ACCEPTABLE_CLASSES].sort())}.`,
    );
  }
  if (taxonomy.regeneration_prohibited_inside_any_gate !== true) {
    findings.push(
      "taxonomy.regeneration_prohibited_inside_any_gate must be true: a gate may compare goldens but may never regenerate one.",
    );
  }
  return findings;
}

/** Validate a golden record: schema, then its own seal. Never repairs. */
export async function validateBehaviouralGolden(record, { assetsDir = ASSETS, label = "golden" } = {}) {
  const schema = await loadBehaviouralGoldenSchema({ assetsDir });
  const findings = validateJsonSchema(record, schema).map((error) => `${label}: ${error}`);
  if (!isPlainObject(record)) return findings;
  if (record.record_sha256 !== behaviouralGoldenRecordSha256(record)) {
    findings.push(
      `${label}: record_sha256 does not match the record body; the golden was edited after sealing.`,
    );
  }
  const census = isPlainObject(record.twelve_state_census) ? record.twelve_state_census : {};
  const missing = ALL_TYPED_STATES.filter((state) => !Object.hasOwn(census, state));
  if (missing.length > 0) {
    findings.push(
      `${label}: twelve_state_census omits ${missing.join(", ")}; the census pins all twelve states INCLUDING the zeros, because a state moving off zero is the regression.`,
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------
// (2) The comparator. Classifies; never repairs; has no update path.
// ---------------------------------------------------------------------------

/**
 * The pinned fact families. `certification` and `record_sha256` are deliberately
 * NOT compared: provenance is not behaviour. Everything else is.
 */
const COMPARED_FACT_KEYS = Object.freeze([
  "schema_version",
  "golden_kind",
  "frozen_release",
  "fixture_id",
  "fixture_path",
  "primary_economic_truth",
  "identity",
  "contracts",
  "seal",
  "slot_shape",
  "twelve_state_census",
  "node_count",
  "historical_basis_histogram",
  "schedules",
  "shadow_boundary",
]);

function flattenFacts(record, prefix = "", into = new Map()) {
  if (prefix === "") {
    for (const key of COMPARED_FACT_KEYS) {
      flattenFacts(record?.[key], key, into);
    }
    return into;
  }
  if (isPlainObject(record)) {
    for (const key of Object.keys(record).sort()) {
      flattenFacts(record[key], `${prefix}.${key}`, into);
    }
    return into;
  }
  if (Array.isArray(record)) {
    into.set(`${prefix}.length`, record.length);
    record.forEach((item, index) => flattenFacts(item, `${prefix}[${index}]`, into));
    return into;
  }
  into.set(prefix, record ?? null);
  return into;
}

function differingFactPaths(expected, actual) {
  const left = flattenFacts(expected);
  const right = flattenFacts(actual);
  const paths = new Set([...left.keys(), ...right.keys()]);
  const differing = [];
  for (const factPath of [...paths].sort()) {
    const a = left.has(factPath) ? left.get(factPath) : "<absent>";
    const b = right.has(factPath) ? right.get(factPath) : "<absent>";
    if (JSON.stringify(a) !== JSON.stringify(b)) differing.push(factPath);
  }
  return differing;
}

function sumStates(census, states) {
  return states.reduce((total, state) => total + Number(census?.[state] ?? 0), 0);
}

/**
 * The never-zero collapse predicate — the sharpest rule in the package.
 *
 * Three independent detections, any of which is never-acceptable:
 *   (a) bare_number_slots moved off 0: an untyped bare number appeared where a
 *       typed slot is required.
 *   (b) never-zero slots fell while value-bearing slots rose: missing /
 *       unresolved / nil / reported_blank / not_applicable collapsed into a
 *       reading. Named explicitly when reported_zero is what rose.
 *   (c) a schedule family's not_applicable slots fell while its value-bearing
 *       slots rose: the acquisition schedule of a case with no acquisition
 *       started producing numbers.
 */
function neverZeroCollapses(expected, actual) {
  const differences = [];
  const expectedShape = expected?.slot_shape ?? {};
  const actualShape = actual?.slot_shape ?? {};
  if (Number(expectedShape.bare_number_slots ?? 0) === 0 && Number(actualShape.bare_number_slots ?? 0) > 0) {
    differences.push({
      class: "never_zero_collapse",
      fact: ["slot_shape.bare_number_slots"],
      expected: expectedShape.bare_number_slots ?? null,
      actual: actualShape.bare_number_slots ?? null,
      detail:
        "bare_number_slots moved off 0: an economic slot is no longer a typed financial value. Never acceptable.",
    });
  }
  const expectedCensus = expected?.twelve_state_census ?? {};
  const actualCensus = actual?.twelve_state_census ?? {};
  const expectedNeverZero = sumStates(expectedCensus, NEVER_ZERO_STATES);
  const actualNeverZero = sumStates(actualCensus, NEVER_ZERO_STATES);
  const expectedBearing = sumStates(expectedCensus, VALUE_BEARING_STATES);
  const actualBearing = sumStates(actualCensus, VALUE_BEARING_STATES);
  if (actualNeverZero < expectedNeverZero && actualBearing > expectedBearing) {
    const collapsedInto = VALUE_BEARING_STATES.filter(
      (state) => Number(actualCensus[state] ?? 0) > Number(expectedCensus[state] ?? 0),
    );
    const collapsedFrom = NEVER_ZERO_STATES.filter(
      (state) => Number(actualCensus[state] ?? 0) < Number(expectedCensus[state] ?? 0),
    );
    differences.push({
      class: "never_zero_collapse",
      fact: [
        ...collapsedFrom.map((state) => `twelve_state_census.${state}`),
        ...collapsedInto.map((state) => `twelve_state_census.${state}`),
        "slot_shape.never_zero_slots",
        "slot_shape.value_bearing_slots",
      ],
      expected: { never_zero_slots: expectedNeverZero, value_bearing_slots: expectedBearing },
      actual: { never_zero_slots: actualNeverZero, value_bearing_slots: actualBearing },
      detail: `${collapsedFrom.join("/") || "never-zero"} collapsed into ${collapsedInto.join("/") || "a value-bearing reading"}: ${expectedNeverZero - actualNeverZero} never-zero slot(s) became numbers. Never acceptable.`,
    });
  }
  const expectedFamilies = expected?.schedules?.families ?? {};
  const actualFamilies = actual?.schedules?.families ?? {};
  for (const family of Object.keys(expectedFamilies).sort()) {
    const before = expectedFamilies[family] ?? {};
    const after = actualFamilies[family] ?? {};
    if (!isPlainObject(after)) continue;
    const naFell = Number(after.not_applicable_slots ?? 0) < Number(before.not_applicable_slots ?? 0);
    const bearingRose =
      Number(after.value_bearing_slots ?? 0) > Number(before.value_bearing_slots ?? 0);
    const bareRose =
      Number(before.bare_number_slots ?? 0) === 0 && Number(after.bare_number_slots ?? 0) > 0;
    if ((naFell && bearingRose) || bareRose) {
      differences.push({
        class: "never_zero_collapse",
        fact: [
          `schedules.families.${family}.not_applicable_slots`,
          `schedules.families.${family}.value_bearing_slots`,
          `schedules.families.${family}.bare_number_slots`,
          `schedules.families.${family}.not_applicable_pattern`,
          ...ALL_TYPED_STATES.map((state) => `schedules.families.${family}.by_state.${state}`),
        ],
        expected: {
          not_applicable_slots: before.not_applicable_slots ?? null,
          value_bearing_slots: before.value_bearing_slots ?? null,
          not_applicable_pattern: before.not_applicable_pattern ?? null,
        },
        actual: {
          not_applicable_slots: after.not_applicable_slots ?? null,
          value_bearing_slots: after.value_bearing_slots ?? null,
          not_applicable_pattern: after.not_applicable_pattern ?? null,
        },
        detail: `the ${family} schedule family stopped reading not_applicable and started producing values; a schedule for a thing the case does not have is never a zero. Never acceptable.`,
      });
    }
  }
  return differences;
}

function simpleClass(classId, factPrefix, expectedBlock, actualBlock, detail) {
  const differences = [];
  const keys = new Set([
    ...Object.keys(isPlainObject(expectedBlock) ? expectedBlock : {}),
    ...Object.keys(isPlainObject(actualBlock) ? actualBlock : {}),
  ]);
  for (const key of [...keys].sort()) {
    const before = expectedBlock?.[key] ?? null;
    const after = actualBlock?.[key] ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    differences.push({
      class: classId,
      fact: [`${factPrefix}.${key}`],
      expected: before,
      actual: after,
      detail: `${detail} (${key}: ${JSON.stringify(before)} -> ${JSON.stringify(after)})`,
    });
  }
  return differences;
}

/**
 * Compare an expected (frozen) golden record against a freshly compiled actual
 * record and CLASSIFY every difference. Returns a verdict. There is no update
 * path here, deliberately: a comparator that could rewrite its own expectation
 * is not a freeze.
 */
export function compareBehaviouralGolden(expected, actual) {
  const differences = [];

  // Never-acceptable structural checks first, so a collapse is never
  // downgraded to a benign census drift by classification order.
  differences.push(
    ...simpleClass(
      "shadow_boundary_violation",
      "shadow_boundary",
      expected?.shadow_boundary,
      actual?.shadow_boundary,
      "the Economic IR's shadow boundary moved",
    ),
  );
  differences.push(...neverZeroCollapses(expected, actual));

  const covered = new Set(differences.flatMap((difference) => difference.fact));

  const remaining = (classId, factPrefix, before, after, detail) => {
    for (const difference of simpleClass(classId, factPrefix, before, after, detail)) {
      if (difference.fact.every((factPath) => covered.has(factPath))) continue;
      differences.push(difference);
      for (const factPath of difference.fact) covered.add(factPath);
    }
  };

  remaining(
    "fixture_identity_drift",
    "identity",
    expected?.identity,
    actual?.identity,
    "the fixture identity moved",
  );
  remaining(
    "contract_version_bump",
    "contracts",
    expected?.contracts,
    actual?.contracts,
    "a declared contract version moved",
  );
  remaining(
    "coverage_census_drift",
    "twelve_state_census",
    expected?.twelve_state_census,
    actual?.twelve_state_census,
    "the twelve-state coverage census moved",
  );
  remaining(
    "slot_shape_drift",
    "slot_shape",
    expected?.slot_shape,
    actual?.slot_shape,
    "a typed-slot shape count moved",
  );
  remaining(
    "historical_basis_drift",
    "historical_basis_histogram",
    expected?.historical_basis_histogram,
    actual?.historical_basis_histogram,
    "the historical_basis histogram moved",
  );
  if (Number(expected?.node_count ?? -1) !== Number(actual?.node_count ?? -2)) {
    differences.push({
      class: "historical_basis_drift",
      fact: ["node_count"],
      expected: expected?.node_count ?? null,
      actual: actual?.node_count ?? null,
      detail: "the economic node count moved",
    });
    covered.add("node_count");
  }

  // Schedules: period shape, then per-family shape (collapses already claimed).
  remaining(
    "schedule_shape_drift",
    "schedules",
    {
      period_count: expected?.schedules?.period_count,
      historical_period_count: expected?.schedules?.historical_period_count,
      forecast_period_count: expected?.schedules?.forecast_period_count,
      period_ids: expected?.schedules?.period_ids,
    },
    {
      period_count: actual?.schedules?.period_count,
      historical_period_count: actual?.schedules?.historical_period_count,
      forecast_period_count: actual?.schedules?.forecast_period_count,
      period_ids: actual?.schedules?.period_ids,
    },
    "the forecast schedule period shape moved",
  );
  {
    const families = new Set([
      ...Object.keys(expected?.schedules?.families ?? {}),
      ...Object.keys(actual?.schedules?.families ?? {}),
    ]);
    for (const family of [...families].sort()) {
      remaining(
        "schedule_shape_drift",
        `schedules.families.${family}`,
        expected?.schedules?.families?.[family],
        actual?.schedules?.families?.[family],
        `the ${family} schedule family shape moved`,
      );
      remaining(
        "schedule_shape_drift",
        `schedules.families.${family}.by_state`,
        expected?.schedules?.families?.[family]?.by_state,
        actual?.schedules?.families?.[family]?.by_state,
        `the ${family} schedule family state mix moved`,
      );
    }
  }

  remaining("economic_drift", "seal", expected?.seal, actual?.seal, "the Economic IR seal moved");

  // Anti-defeat: every differing pinned fact must have been named by a class.
  for (const factPath of differingFactPaths(expected, actual)) {
    if (covered.has(factPath)) continue;
    // Array/object container paths are covered when their leaves are.
    if ([...covered].some((claimed) => claimed.startsWith(`${factPath}.`) || factPath.startsWith(`${claimed}.`))) {
      continue;
    }
    const left = flattenFacts(expected);
    const right = flattenFacts(actual);
    differences.push({
      class: "unclassified_difference",
      fact: [factPath],
      expected: left.has(factPath) ? left.get(factPath) : null,
      actual: right.has(factPath) ? right.get(factPath) : null,
      detail: `pinned fact ${factPath} differs and no declared difference class named it; classify it before it can ever be approved.`,
    });
    covered.add(factPath);
  }

  const classified = differences.map((difference) =>
    Object.freeze({ ...difference, acceptability: acceptabilityOf(difference.class) }),
  );
  const neverAcceptable = classified.filter((difference) => isNeverAcceptable(difference.class));
  return Object.freeze({
    status: classified.length === 0 ? "MATCH" : "DIFFERENT",
    fixture_id: expected?.fixture_id ?? actual?.fixture_id ?? null,
    differences: Object.freeze(classified),
    classes: Object.freeze([...new Set(classified.map((difference) => difference.class))].sort()),
    never_acceptable_count: neverAcceptable.length,
    never_acceptable_classes: Object.freeze(
      [...new Set(neverAcceptable.map((difference) => difference.class))].sort(),
    ),
  });
}

// ---------------------------------------------------------------------------
// (3) The approval ledger. Append-only, hash-chained (P8.6a discipline).
// ---------------------------------------------------------------------------

function approvalBody(record) {
  const { record_hash: _ignored, ...body } = record;
  return body;
}

export function goldenApprovalRecordHash(record) {
  return identitySha256(approvalBody(record));
}

export function serialiseGoldenApprovalRecord(record) {
  const line = JSON.stringify(canonicaliseIdentity(record));
  if (line.includes("\n")) {
    throw new Error("A golden approval record must serialise to a single line.");
  }
  return line;
}

/**
 * Build one sealed approval record. Sequence and previousRecordHash come from
 * the ledger tip, never from a caller's imagination.
 *
 * A never-acceptable difference class may NOT be declared on an approval. This
 * is the second structural lock: you cannot pre-authorise a never-zero collapse
 * even with a valid actor and a stated reason.
 */
export function createGoldenApprovalRecord({
  sequence,
  previousRecordHash = null,
  eventType,
  recordedAt,
  actor,
  approvedCommit,
  workingTreeState = null,
  reason,
  fixtures = [],
  differenceClasses = [],
  approvalRecordHash = null,
  goldens = [],
}) {
  if (!GOLDEN_APPROVAL_EVENT_TYPES.includes(eventType)) {
    throw new Error(
      `Unknown golden-approval event type: ${JSON.stringify(eventType)}; expected one of ${GOLDEN_APPROVAL_EVENT_TYPES.join(", ")}.`,
    );
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error(`A golden-approval sequence must be a non-negative integer; got ${JSON.stringify(sequence)}.`);
  }
  if (sequence === 0) {
    if (eventType !== "freeze") {
      throw new Error("The genesis golden-approval record must be the initial freeze.");
    }
    if (previousRecordHash !== null) {
      throw new Error("The genesis golden-approval record must have previous_record_hash null.");
    }
  } else if (!SHA256.test(String(previousRecordHash ?? ""))) {
    throw new Error("A non-genesis golden-approval record must chain onto the previous record hash.");
  }
  if (!COMMIT.test(String(approvedCommit ?? ""))) {
    throw new Error(
      `A golden-approval record must name the commit it was granted against; got ${JSON.stringify(approvedCommit)}.`,
    );
  }
  if (typeof reason !== "string" || reason.trim().length < 40) {
    throw new Error(
      "A golden-approval record must state WHY, in at least 40 characters. A regeneration with no stated reason is exactly what this ledger exists to prevent.",
    );
  }
  if (!isPlainObject(actor) || actor.kind !== "human" || typeof actor.id !== "string" || actor.id.trim() === "") {
    throw new Error(
      "A golden approval must name a HUMAN actor with an id; automation records, humans approve.",
    );
  }
  const declared = [...new Set(differenceClasses.map(String))].sort();
  for (const classId of declared) {
    if (!GOLDEN_DIFFERENCE_CLASSES.includes(classId)) {
      throw new Error(`Unknown golden difference class ${JSON.stringify(classId)}.`);
    }
    if (isNeverAcceptable(classId)) {
      throw new Error(
        `Difference class ${classId} is NEVER acceptable and may not be declared on an approval record. ${GOLDEN_DIFFERENCE_CLASS_CONTRACT[classId].detects}`,
      );
    }
  }
  if (eventType === "approve" && declared.length === 0) {
    throw new Error("An approval must declare the difference classes it approves.");
  }
  if (eventType === "approve" && fixtures.length === 0) {
    throw new Error("An approval must name the fixtures it approves regeneration for.");
  }
  if (eventType === "regenerate" && !SHA256.test(String(approvalRecordHash ?? ""))) {
    throw new Error("A regeneration record must name the approval record it consumed.");
  }
  if (eventType !== "regenerate" && approvalRecordHash !== null) {
    throw new Error("Only a regeneration record may name a consumed approval.");
  }
  if (eventType !== "approve" && goldens.length === 0) {
    throw new Error(
      "A freeze or regeneration record must name the golden records it produced, by record_sha256.",
    );
  }
  const body = {
    schema_version: GOLDEN_APPROVAL_SCHEMA_VERSION,
    sequence,
    event_type: eventType,
    recorded_at: recordedAt,
    actor: { kind: actor.kind, id: actor.id, role: actor.role ?? null },
    approved_commit: String(approvedCommit),
    working_tree_state: workingTreeState,
    reason: reason.trim(),
    fixtures: [...fixtures.map(String)].sort(),
    difference_classes: declared,
    consumed_approval_record_hash: approvalRecordHash,
    goldens: goldens
      .map((entry) => ({ fixture_id: String(entry.fixture_id), record_sha256: String(entry.record_sha256) }))
      .sort((left, right) => (left.fixture_id < right.fixture_id ? -1 : 1)),
    previous_record_hash: previousRecordHash,
  };
  return Object.freeze({ ...body, record_hash: identitySha256(body) });
}

export function validateGoldenApprovalRecord(record, { label = "record" } = {}) {
  const findings = [];
  if (!isPlainObject(record)) return [`${label} is not an object.`];
  if (record.schema_version !== GOLDEN_APPROVAL_SCHEMA_VERSION) {
    findings.push(`${label}: schema_version must be ${JSON.stringify(GOLDEN_APPROVAL_SCHEMA_VERSION)}.`);
  }
  if (!GOLDEN_APPROVAL_EVENT_TYPES.includes(record.event_type)) {
    findings.push(`${label}: event_type ${JSON.stringify(record.event_type)} is not a declared event type.`);
  }
  if (record.record_hash !== goldenApprovalRecordHash(record)) {
    findings.push(`${label}: record_hash does not match the record body; the record was edited after sealing.`);
  }
  if (!COMMIT.test(String(record.approved_commit ?? ""))) {
    findings.push(`${label}: approved_commit must be a commit sha.`);
  }
  if (typeof record.reason !== "string" || record.reason.trim().length < 40) {
    findings.push(`${label}: reason must state WHY in at least 40 characters.`);
  }
  if (record.actor?.kind !== "human" || typeof record.actor?.id !== "string") {
    findings.push(`${label}: actor must be a human with an id; automation may not approve a golden regeneration.`);
  }
  for (const classId of record.difference_classes ?? []) {
    if (!GOLDEN_DIFFERENCE_CLASSES.includes(classId)) {
      findings.push(`${label}: difference class ${JSON.stringify(classId)} is not declared.`);
    } else if (isNeverAcceptable(classId)) {
      findings.push(
        `${label}: difference class ${classId} is NEVER acceptable and may never appear on an approval record.`,
      );
    }
  }
  if (record.event_type === "regenerate" && !SHA256.test(String(record.consumed_approval_record_hash ?? ""))) {
    findings.push(`${label}: a regeneration must name the approval record it consumed.`);
  }
  if (record.event_type !== "regenerate" && record.consumed_approval_record_hash !== null) {
    findings.push(`${label}: only a regeneration may name a consumed approval.`);
  }
  return findings;
}

/** Validate the whole chain: contiguity, linkage, replay, time, single-use. */
export function validateGoldenApprovalLedger(records) {
  const findings = [];
  if (!Array.isArray(records)) {
    return Object.freeze({
      status: "FAIL",
      record_count: 0,
      tip_record_hash: null,
      findings: Object.freeze(["the golden approval ledger is not an array of records."]),
    });
  }
  if (records.length === 0) {
    return Object.freeze({
      status: "FAIL",
      record_count: 0,
      tip_record_hash: null,
      findings: Object.freeze([
        "the golden approval ledger has no genesis freeze record; goldens with no certification history are not frozen, they are just files.",
      ]),
    });
  }
  const seenHashes = new Set();
  const approvals = new Map();
  const consumed = new Map();
  records.forEach((record, index) => {
    const label = `record ${index} (${record?.event_type ?? "unknown"})`;
    findings.push(...validateGoldenApprovalRecord(record, { label }));
    if (record?.sequence !== index) {
      findings.push(
        `record at index ${index} has sequence ${JSON.stringify(record?.sequence)}; the ledger must be contiguous from 0 with no gap, no reorder and no deletion.`,
      );
    }
    if (index === 0 && record?.event_type !== "freeze") {
      findings.push("the genesis golden-approval record must be the initial freeze.");
    }
    const expectedPrevious = index === 0 ? null : (records[index - 1]?.record_hash ?? null);
    if ((record?.previous_record_hash ?? null) !== expectedPrevious) {
      findings.push(
        `${label}: previous_record_hash ${JSON.stringify(record?.previous_record_hash ?? null)} does not chain onto the preceding record (${JSON.stringify(expectedPrevious)}); a record inserted, forked or removed from the chain is refused.`,
      );
    }
    if (seenHashes.has(record?.record_hash)) {
      findings.push(`${label}: record_hash is a replay of an earlier record.`);
    }
    seenHashes.add(record?.record_hash);
    if (index > 0) {
      const previous = records[index - 1]?.recorded_at ?? null;
      if (previous && record?.recorded_at && record.recorded_at < previous) {
        findings.push(
          `${label}: recorded_at ${record.recorded_at} is earlier than the preceding record (${previous}); an approval ledger never runs backwards in time.`,
        );
      }
    }
    if (record?.event_type === "approve") approvals.set(record.record_hash, index);
    if (record?.event_type === "regenerate") {
      const consumedHash = record?.consumed_approval_record_hash ?? null;
      if (!approvals.has(consumedHash)) {
        findings.push(
          `${label}: consumed approval ${JSON.stringify(consumedHash)} has no earlier approve record; a regeneration without a preceding approval is refused.`,
        );
      } else if (consumed.has(consumedHash)) {
        findings.push(
          `${label}: approval ${consumedHash} was already consumed by the regeneration at sequence ${consumed.get(consumedHash)}; an approval is single-use and may not authorise a second regeneration.`,
        );
      } else {
        consumed.set(consumedHash, index);
      }
    }
  });
  return Object.freeze({
    status: findings.length === 0 ? "PASS" : "FAIL",
    record_count: records.length,
    tip_record_hash: records[records.length - 1]?.record_hash ?? null,
    findings: Object.freeze(findings),
  });
}

export function parseGoldenApprovalLedger(text) {
  const findings = [];
  const records = [];
  const lines = String(text ?? "").split("\n");
  lines.forEach((line, index) => {
    if (line.trim() === "") {
      if (index !== lines.length - 1) {
        findings.push(`ledger line ${index + 1} is blank; the ledger is one record per line.`);
      }
      return;
    }
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      findings.push(`ledger line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
  return { records, findings };
}

export async function readGoldenApprovalLedger(ledgerPath) {
  let text;
  try {
    text = await fs.readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        status: "FAIL",
        record_count: 0,
        tip_record_hash: null,
        records: Object.freeze([]),
        findings: Object.freeze([
          `no golden approval ledger at ${ledgerPath}; there is no certification history, so no golden may be regenerated.`,
        ]),
      });
    }
    throw error;
  }
  const parsed = parseGoldenApprovalLedger(text);
  const verdict = validateGoldenApprovalLedger(parsed.records);
  const findings = [...parsed.findings, ...verdict.findings];
  return Object.freeze({
    status: findings.length === 0 ? "PASS" : "FAIL",
    record_count: parsed.records.length,
    tip_record_hash: verdict.tip_record_hash,
    records: Object.freeze(parsed.records),
    findings: Object.freeze(findings),
  });
}

/**
 * Append one record. Refuses to append onto a ledger that does not validate —
 * a tampered ledger is a refusal, never a repair — and byte-prefix-verifies the
 * append afterwards so a write that changed an earlier byte is a hard error.
 */
export async function appendGoldenApprovalRecord({ goldensDir = goldensDirOf(), record }) {
  const ledgerPath = approvalLedgerPath(goldensDir);
  const existing = await readGoldenApprovalLedger(ledgerPath).catch(() => null);
  const isGenesis = record.sequence === 0;
  if (!isGenesis) {
    if (!existing || existing.status !== "PASS") {
      throw new Error(
        `Refusing to append to the golden approval ledger: it does not validate (${existing?.findings?.[0] ?? "unreadable"}). A tampered ledger is refused, never repaired.`,
      );
    }
    if (record.sequence !== existing.record_count) {
      throw new Error(
        `Refusing to append: record sequence ${record.sequence} is not the ledger tip ${existing.record_count}.`,
      );
    }
    if (record.previous_record_hash !== existing.tip_record_hash) {
      throw new Error("Refusing to append: the record does not chain onto the ledger tip.");
    }
  }
  const before = await fs.readFile(ledgerPath, "utf8").catch(() => "");
  await fs.mkdir(goldensDir, { recursive: true });
  const line = `${serialiseGoldenApprovalRecord(record)}\n`;
  const handle = await fs.open(ledgerPath, "a");
  try {
    await handle.write(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const after = await fs.readFile(ledgerPath, "utf8");
  if (!after.startsWith(before) || after !== `${before}${line}`) {
    throw new Error(
      "The golden approval ledger append changed earlier bytes; that is not an append and the ledger is now suspect.",
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// (4) Reading and comparing the frozen set.
// ---------------------------------------------------------------------------

export const FROZEN_SET_STATES = Object.freeze(["PRE_FREEZE", "FROZEN"]);

/**
 * Is v3.7.7 behaviour frozen yet?
 *
 * The discriminator is THE EXISTENCE OF THE APPROVAL LEDGER FILE and nothing
 * else — never whether golden records happen to be present, readable, or valid.
 * That matters in both directions:
 *
 *   - a frozen set whose records have been corrupted or deleted is still FROZEN,
 *     so it is refused as golden_record_corruption / golden_coverage_gap and can
 *     never be laundered into "oh, we simply never froze";
 *   - a genuinely unfrozen tree is PRE_FREEZE, which is a lawful, loudly
 *     declared state rather than a fake coverage gap.
 *
 * PRE_FREEZE exists because the genesis freeze is a HUMAN act. The mechanism can
 * be built, committed and verified before any human has reviewed the pinned
 * facts; what it must never do is manufacture a human approval to get there.
 */
export async function frozenSetState({ goldensDir = goldensDirOf() } = {}) {
  const ledgerPath = approvalLedgerPath(goldensDir);
  const ledgerPresent = await fs.access(ledgerPath).then(
    () => true,
    () => false,
  );
  return Object.freeze({
    state: ledgerPresent ? "FROZEN" : "PRE_FREEZE",
    frozen: ledgerPresent,
    ledger_present: ledgerPresent,
    ledger_path: ledgerPath,
    determined_by:
      "the existence of the approval ledger file, never whether golden records happen to be readable",
  });
}

export async function readBehaviouralGolden(fixtureId, { goldensDir = goldensDirOf() } = {}) {
  const recordPath = goldenRecordPath(fixtureId, goldensDir);
  try {
    return JSON.parse(await fs.readFile(recordPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function listBehaviouralGoldens({ goldensDir = goldensDirOf() } = {}) {
  const dir = path.join(goldensDir, GOLDEN_RECORD_SUBDIR);
  const entries = await fs.readdir(dir).catch(() => []);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.replace(/\.json$/, ""))
    .sort();
}

/**
 * The full comparison over the frozen set.
 *
 * PRE_FREEZE short-circuits: with no approval ledger nothing has been frozen, so
 * there is no expectation to compare against and a missing record is NOT a
 * coverage gap. The one thing that is never lawful in PRE_FREEZE is records
 * without a ledger — keeping the pins while shedding the certification history.
 *
 * Once FROZEN, every rule below applies at full strength.
 */
export async function compareFrozenSet({
  goldensDir = goldensDirOf(),
  fixtureDir = CERTIFIED_FIXTURE_DIR,
  assetsDir = ASSETS,
} = {}) {
  const certified = await listCertifiedFixtures(fixtureDir);
  const pinned = await listBehaviouralGoldens({ goldensDir });
  const freezeState = await frozenSetState({ goldensDir });

  if (!freezeState.frozen) {
    const uncertified = pinned.map((fixtureId) =>
      Object.freeze({
        class: "uncertified_golden_present",
        acceptability: NEVER_ACCEPTABLE,
        fixture_id: fixtureId,
        detail: `golden record ${fixtureId} exists but there is no approval ledger at ${freezeState.ledger_path}; nothing certifies it. Restore the ledger or remove the record — a pin with no certification history is not a freeze.`,
      }),
    );
    return Object.freeze({
      status: uncertified.length === 0 ? "PRE_FREEZE" : "DIFFERENT",
      frozen: false,
      frozen_set_state: freezeState.state,
      freeze_state: freezeState,
      certified_fixtures: Object.freeze(certified),
      pinned_fixtures: Object.freeze(pinned),
      coverage_gaps: Object.freeze([]),
      uncertified_goldens: uncertified,
      verdicts: Object.freeze([]),
      classes: Object.freeze(uncertified.length === 0 ? [] : ["uncertified_golden_present"]),
      never_acceptable: uncertified,
      never_acceptable_classes: Object.freeze(
        uncertified.length === 0 ? [] : ["uncertified_golden_present"],
      ),
    });
  }

  const verdicts = [];
  const coverage = [];
  for (const fixtureId of certified) {
    if (!pinned.includes(fixtureId)) {
      coverage.push({
        class: "golden_coverage_gap",
        acceptability: NEVER_ACCEPTABLE,
        fixture_id: fixtureId,
        detail: `certified fixture ${fixtureId} has no golden record; v3.7.7 behaviour is not frozen for it.`,
      });
    }
  }
  for (const fixtureId of pinned) {
    if (!certified.includes(fixtureId)) {
      coverage.push({
        class: "golden_coverage_gap",
        acceptability: NEVER_ACCEPTABLE,
        fixture_id: fixtureId,
        detail: `golden record ${fixtureId} names a fixture that is no longer certified; a golden may not outlive its fixture silently.`,
      });
    }
  }
  for (const fixtureId of certified.filter((id) => pinned.includes(id))) {
    const expected = await readBehaviouralGolden(fixtureId, { goldensDir });
    const corruption = await validateBehaviouralGolden(expected, {
      assetsDir,
      label: `golden ${fixtureId}`,
    });
    if (corruption.length > 0) {
      verdicts.push(
        Object.freeze({
          status: "DIFFERENT",
          fixture_id: fixtureId,
          differences: Object.freeze(
            corruption.map((finding) =>
              Object.freeze({
                class: "golden_record_corruption",
                acceptability: NEVER_ACCEPTABLE,
                fact: ["record_sha256"],
                expected: null,
                actual: null,
                detail: finding,
              }),
            ),
          ),
          classes: Object.freeze(["golden_record_corruption"]),
          never_acceptable_count: corruption.length,
          never_acceptable_classes: Object.freeze(["golden_record_corruption"]),
        }),
      );
      continue;
    }
    const actual = await compileBehaviouralGolden(fixtureId, { fixtureDir });
    verdicts.push(compareBehaviouralGolden(expected, actual));
  }
  const differences = verdicts.flatMap((verdict) => verdict.differences);
  const neverAcceptable = [
    ...coverage,
    ...differences.filter((difference) => isNeverAcceptable(difference.class)),
  ];
  const classes = [
    ...new Set([...coverage.map((entry) => entry.class), ...differences.map((entry) => entry.class)]),
  ].sort();
  return Object.freeze({
    status: coverage.length === 0 && differences.length === 0 ? "MATCH" : "DIFFERENT",
    frozen: true,
    frozen_set_state: freezeState.state,
    freeze_state: freezeState,
    certified_fixtures: Object.freeze(certified),
    pinned_fixtures: Object.freeze(pinned),
    coverage_gaps: Object.freeze(coverage),
    uncertified_goldens: Object.freeze([]),
    verdicts: Object.freeze(verdicts),
    classes: Object.freeze(classes),
    never_acceptable: Object.freeze(neverAcceptable),
    never_acceptable_classes: Object.freeze(
      [...new Set(neverAcceptable.map((entry) => entry.class))].sort(),
    ),
  });
}

// ---------------------------------------------------------------------------
// (5) Regeneration — gated, single-use, and structurally unable to launder a
// never-acceptable difference.
// ---------------------------------------------------------------------------

export class GoldenRegenerationRefused extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "GoldenRegenerationRefused";
    this.reason_code = reasonCode;
  }
}

export const REGENERATION_REFUSAL_CODES = Object.freeze([
  "no_approval_record_named",
  "approval_record_absent",
  "approval_ledger_invalid",
  "approval_not_an_approve_event",
  "approval_already_consumed",
  "approval_commit_mismatch",
  "approval_fixture_not_named",
  "approval_class_not_declared",
  "difference_never_acceptable",
  "nothing_to_regenerate",
]);

/**
 * Regenerate the frozen set under an approval record.
 *
 * Every refusal below is a REFUSAL, never a prompt and never a fallback. Note
 * the ordering: `difference_never_acceptable` is checked against the observed
 * differences BEFORE any file is written and independently of what the approval
 * declares, so a never-zero collapse cannot be regenerated past even by an
 * approval that (impossibly) named it.
 */
export async function regenerateBehaviouralGoldens({
  goldensDir = goldensDirOf(),
  fixtureDir = CERTIFIED_FIXTURE_DIR,
  assetsDir = ASSETS,
  approvalRecordHash = null,
  root = REPO_ROOT,
  recordedAt = new Date().toISOString(),
  write = true,
} = {}) {
  if (!approvalRecordHash) {
    throw new GoldenRegenerationRefused(
      "no_approval_record_named",
      "REFUSED: regeneration requires --approval <record_hash> naming an approval record in goldens/approval-ledger.jsonl. A golden is never regenerated to make a test pass; someone must approve it, on the record, with a reason.",
    );
  }
  const ledgerPath = approvalLedgerPath(goldensDir);
  const ledger = await readGoldenApprovalLedger(ledgerPath);
  if (ledger.status !== "PASS") {
    throw new GoldenRegenerationRefused(
      "approval_ledger_invalid",
      `REFUSED: the golden approval ledger does not validate — ${ledger.findings[0]}`,
    );
  }
  const approval = ledger.records.find((record) => record.record_hash === approvalRecordHash);
  if (!approval) {
    throw new GoldenRegenerationRefused(
      "approval_record_absent",
      `REFUSED: no approval record with hash ${approvalRecordHash} exists in ${ledgerPath}.`,
    );
  }
  if (approval.event_type !== "approve") {
    throw new GoldenRegenerationRefused(
      "approval_not_an_approve_event",
      `REFUSED: record ${approvalRecordHash} is a ${approval.event_type} event, not an approval.`,
    );
  }
  const consumer = ledger.records.find(
    (record) =>
      record.event_type === "regenerate" && record.consumed_approval_record_hash === approvalRecordHash,
  );
  if (consumer) {
    throw new GoldenRegenerationRefused(
      "approval_already_consumed",
      `REFUSED: approval ${approvalRecordHash} was already consumed by the regeneration at sequence ${consumer.sequence}. An approval is single-use; obtain a new one.`,
    );
  }
  const head = await currentCommit(root);
  if (approval.approved_commit !== head) {
    throw new GoldenRegenerationRefused(
      "approval_commit_mismatch",
      `REFUSED: approval ${approvalRecordHash} was granted against commit ${approval.approved_commit} but HEAD is ${head}. An approval binds the tree it was granted for; re-approve against this commit after re-reading the differences.`,
    );
  }

  const comparison = await compareFrozenSet({ goldensDir, fixtureDir, assetsDir });
  if (comparison.never_acceptable.length > 0) {
    throw new GoldenRegenerationRefused(
      "difference_never_acceptable",
      `REFUSED: ${comparison.never_acceptable.length} observed difference(s) are NEVER acceptable (${comparison.never_acceptable_classes.join(", ")}) and no approval can authorise regenerating past them. First: ${comparison.never_acceptable[0].detail} Fix the code, not the golden.`,
    );
  }
  if (comparison.status === "MATCH") {
    throw new GoldenRegenerationRefused(
      "nothing_to_regenerate",
      "REFUSED: the frozen set already matches; there is nothing to regenerate. A no-op regeneration would consume an approval and rewrite provenance for nothing.",
    );
  }

  const changedFixtures = comparison.verdicts
    .filter((verdict) => verdict.status === "DIFFERENT")
    .map((verdict) => verdict.fixture_id)
    .sort();
  const approvedFixtures = new Set(approval.fixtures ?? []);
  for (const fixtureId of changedFixtures) {
    if (!approvedFixtures.has(fixtureId)) {
      throw new GoldenRegenerationRefused(
        "approval_fixture_not_named",
        `REFUSED: fixture ${fixtureId} differs but approval ${approvalRecordHash} names only ${[...approvedFixtures].join(", ") || "(none)"}.`,
      );
    }
  }
  const approvedClasses = new Set(approval.difference_classes ?? []);
  for (const classId of comparison.classes) {
    if (!approvedClasses.has(classId)) {
      throw new GoldenRegenerationRefused(
        "approval_class_not_declared",
        `REFUSED: observed difference class ${classId} is not declared on approval ${approvalRecordHash} (declares ${[...approvedClasses].join(", ") || "(none)"}). An approval covers the classes it names and nothing else.`,
      );
    }
  }

  const certification = {
    release: FROZEN_RELEASE,
    work_package: "P7.2",
    freeze_event: "approved_regeneration",
    frozen_at: recordedAt,
    frozen_by: { ...approval.actor },
    frozen_at_commit: head,
    working_tree_state: await workingTreeState(root),
    approval_record_hash: approvalRecordHash,
    approval_reason: approval.reason,
    approved_difference_classes: [...approvedClasses].sort(),
  };
  const produced = [];
  for (const fixtureId of await listCertifiedFixtures(fixtureDir)) {
    const record = await compileBehaviouralGolden(fixtureId, { fixtureDir, certification });
    produced.push({ fixtureId, record });
  }
  if (write) {
    await fs.mkdir(path.join(goldensDir, GOLDEN_RECORD_SUBDIR), { recursive: true });
    for (const { fixtureId, record } of produced) {
      await fs.writeFile(
        goldenRecordPath(fixtureId, goldensDir),
        `${JSON.stringify(record, null, 2)}\n`,
        "utf8",
      );
    }
    await appendGoldenApprovalRecord({
      goldensDir,
      record: createGoldenApprovalRecord({
        sequence: ledger.record_count,
        previousRecordHash: ledger.tip_record_hash,
        eventType: "regenerate",
        recordedAt,
        actor: approval.actor,
        approvedCommit: head,
        workingTreeState: certification.working_tree_state,
        reason: approval.reason,
        fixtures: produced.map((entry) => entry.fixtureId),
        differenceClasses: [...approvedClasses].sort(),
        approvalRecordHash,
        goldens: produced.map((entry) => ({
          fixture_id: entry.fixtureId,
          record_sha256: entry.record.record_sha256,
        })),
      }),
    });
  }
  return Object.freeze({
    status: "REGENERATED",
    approval_record_hash: approvalRecordHash,
    commit: head,
    changed_fixtures: Object.freeze(changedFixtures),
    classes: comparison.classes,
    goldens: Object.freeze(
      produced.map((entry) => ({ fixture_id: entry.fixtureId, record_sha256: entry.record.record_sha256 })),
    ),
  });
}

/**
 * The one-time genesis freeze. Refused once a ledger exists: after the initial
 * freeze there IS a prior expectation, and overwriting it is a regeneration
 * requiring an approval record. This is why `freeze` cannot be used as a
 * back door around the approval gate.
 */
export async function freezeBehaviouralGoldens({
  goldensDir = goldensDirOf(),
  fixtureDir = CERTIFIED_FIXTURE_DIR,
  root = REPO_ROOT,
  actor,
  reason,
  recordedAt = new Date().toISOString(),
} = {}) {
  const ledgerPath = approvalLedgerPath(goldensDir);
  const exists = await fs
    .access(ledgerPath)
    .then(() => true, () => false);
  if (exists) {
    throw new GoldenRegenerationRefused(
      "approval_ledger_invalid",
      `REFUSED: an approval ledger already exists at ${ledgerPath}. The genesis freeze happens once; changing a frozen golden afterwards is a regeneration and requires an approval record.`,
    );
  }
  const head = await currentCommit(root);
  const tree = await workingTreeState(root);
  const certification = {
    release: FROZEN_RELEASE,
    work_package: "P7.2",
    freeze_event: "genesis_freeze",
    frozen_at: recordedAt,
    frozen_by: { kind: actor?.kind, id: actor?.id, role: actor?.role ?? null },
    frozen_at_commit: head,
    working_tree_state: tree,
    approval_record_hash: null,
    approval_reason: typeof reason === "string" ? reason.trim() : reason,
    approved_difference_classes: [],
  };
  const produced = [];
  for (const fixtureId of await listCertifiedFixtures(fixtureDir)) {
    produced.push({
      fixtureId,
      record: await compileBehaviouralGolden(fixtureId, { fixtureDir, certification }),
    });
  }
  if (produced.length === 0) {
    throw new GoldenRegenerationRefused(
      "nothing_to_regenerate",
      "REFUSED: there are no certified fixtures to freeze.",
    );
  }
  const genesis = createGoldenApprovalRecord({
    sequence: 0,
    previousRecordHash: null,
    eventType: "freeze",
    recordedAt,
    actor,
    approvedCommit: head,
    workingTreeState: tree,
    reason,
    fixtures: produced.map((entry) => entry.fixtureId),
    differenceClasses: [],
    goldens: produced.map((entry) => ({
      fixture_id: entry.fixtureId,
      record_sha256: entry.record.record_sha256,
    })),
  });
  await fs.mkdir(path.join(goldensDir, GOLDEN_RECORD_SUBDIR), { recursive: true });
  for (const { fixtureId, record } of produced) {
    await fs.writeFile(
      goldenRecordPath(fixtureId, goldensDir),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }
  await appendGoldenApprovalRecord({ goldensDir, record: genesis });
  return Object.freeze({
    status: "FROZEN",
    commit: head,
    genesis_record_hash: genesis.record_hash,
    goldens: Object.freeze(
      produced.map((entry) => ({ fixture_id: entry.fixtureId, record_sha256: entry.record.record_sha256 })),
    ),
  });
}

/** sha256 of arbitrary text — used by the suite to prove append-only on disk. */
export function textSha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

export default {
  BEHAVIOURAL_GOLDEN_SCHEMA_VERSION,
  GOLDEN_DIFFERENCE_CLASS_CONTRACT,
  NEVER_ACCEPTABLE_CLASSES,
  compileBehaviouralGolden,
  compareBehaviouralGolden,
  compareFrozenSet,
  regenerateBehaviouralGoldens,
};
