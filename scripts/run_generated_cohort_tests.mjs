#!/usr/bin/env node
/**
 * P7.3 — Property/generated case cohort tests.
 *
 * Invariant: cases are GENERATED from a declared dimension space by a seeded,
 * reproducible generator. A seed fully determines a case; the generator reports
 * its distribution over the dimension space; a failing seed is PERSISTED and
 * replayable; and a failure is SHRUNK to a minimal reproducing case.
 *
 * This suite is the registrable entrypoint. It runs a CHEAP default slice
 * (the `ci_default` tier declared in the dimension space) so CI pays a small
 * fixed cost, and accepts `--cases N` / `--tier NAME` so the same suite drives
 * the PR, nightly and weekly volumes without a second script.
 *
 * A property violation is never repaired by loosening the property. A violation
 * whose signature is not declared in the dimension space's dispositioned set
 * FAILS this suite and prints its shrunk minimal reproduction. A violation whose
 * signature IS dispositioned is replayed from its persisted seed and must still
 * reproduce exactly — a pin that has stopped reproducing is itself a failure,
 * because the pin must then be retired rather than left standing.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CASE_GENERATOR_VERSION,
  PROPERTIES,
  STRATA,
  buildGeneratorContext,
  canonicalJson,
  distributionReport,
  evaluateCase,
  generateCase,
  generateCohort,
  loadArchetypeSeedShapes,
  loadDimensionSpace,
  mulberry32,
  probeOracleSignature,
  reasonTerminalClosureTable,
  shrinkCase,
  spaceSize,
} from "./lib/case_generator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SEED_REGISTRY_PATH = path.join(ROOT, "ci", "generated_case_seeds.json");

let checks = 0;
const failures = [];
function check(condition, message) {
  if (!condition) throw new Error(message);
  checks += 1;
}

function parseArgs(argv) {
  const options = { tier: "ci_default", cases: null, seed: null, seeds: SEED_REGISTRY_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--tier") options.tier = argv[++index];
    else if (token === "--cases") options.cases = Number(argv[++index]);
    else if (token === "--seed") options.seed = Number(argv[++index]);
    else if (token === "--seeds") options.seeds = path.resolve(argv[++index]);
    else if (/^\d+$/.test(token) && options.cases === null) options.cases = Number(token);
    else throw new Error(`Unrecognised argument ${token}. Usage: [--tier NAME] [--cases N] [--seed S] [--seeds PATH]`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// 1. The declared space binds to the support envelope it was derived from.
// ---------------------------------------------------------------------------
const space = loadDimensionSpace();
check(
  space.contract.schema_version === "excel-inflow-generated-case-dimension-space/1.0",
  "dimension space must declare its schema version",
);
check(/^[0-9a-f]{64}$/.test(space.sha256), "dimension space must bind by digest");
check(
  space.contract.derived_from.envelope_version === space.envelope.version,
  `dimension space claims envelope ${space.contract.derived_from.envelope_version} but loaded ${space.envelope.version}`,
);
check(
  space.contract.derived_from.envelope_sha256 === space.envelope.sha256,
  "dimension space must record the exact envelope digest it was derived from — divergence is a refusal, never silent",
);
check(space.drift.length === 0, `dimension space diverged from the envelope: ${space.drift.join("; ")}`);

const context = buildGeneratorContext(space);
check(
  Object.keys(context.reasonCodes).length > 0,
  "generator context must bind the terminal reason registry",
);
// The archetype catalogues are authored by sibling packages, so the seed-shape
// inventory is a VERSIONED GENERATOR INPUT. The space declares which mode governs
// the pinned corpus; in "inventory" mode the pinned digests are only replayable
// against the inventory they were drawn on, and a changed inventory is a typed
// staleness report telling you to regenerate, never a silently different case.
const seedShapeMode = space.contract.seed_shape_mode ?? "off";
check(
  (space.contract.seed_shape_modes ?? []).includes(seedShapeMode),
  `seed_shape_mode ${seedShapeMode} is not one of the declared modes`,
);
const liveInventory = context.seedShapeInventorySha256;
if (seedShapeMode === "inventory") {
  const pinnedInventory = space.contract.discovery_sweep?.seed_shape_inventory_sha256 ?? null;
  check(
    pinnedInventory === liveInventory,
    "the archetype seed-shape inventory changed since the dimension space was derived " +
      `(pinned ${pinnedInventory}, live ${liveInventory}). Re-derive with ` +
      "`node scripts/generate_case_cohort.mjs --emit-space --seed-shapes` then regenerate the seed registry.",
  );
} else {
  check(
    liveInventory === null && context.seedShapes.length === 0,
    "in mode 'off' the pinned corpus must be independent of the archetype inventory",
  );
}

// ---------------------------------------------------------------------------
// 2. The space is a SPACE, not a list. Tier volumes are declared, ordered and
//    parameters rather than constants.
// ---------------------------------------------------------------------------
const size = spaceSize(space);
check(typeof size === "bigint" && size > 1000000n, `declared space must be large; got ${size}`);
const tiers = space.contract.tiers;
for (const tier of ["ci_default", "pr", "nightly", "weekly"]) {
  check(Number.isInteger(tiers[tier]) && tiers[tier] > 0, `tier ${tier} must declare a positive volume`);
}
check(tiers.ci_default < tiers.pr, "the CI default slice must be cheaper than the PR tier");
check(tiers.pr >= 2000 && tiers.pr <= 3000, `PR tier must be the declared 2-3k volume; got ${tiers.pr}`);
check(tiers.nightly >= 10000, `nightly tier must be at least 10k; got ${tiers.nightly}`);
check(tiers.weekly >= 25000, `weekly tier must be at least 25k; got ${tiers.weekly}`);

// ---------------------------------------------------------------------------
// 3. Deterministic PRNG. The pinned vector is the mulberry32 sequence that
//    compile_synthetic_cohort.mjs decorates its fixed cases with; a generated
//    cohort that drifts off it is a different generator, not a new sample.
// ---------------------------------------------------------------------------
const pinnedSequence = [
  0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
  0.9810509674716741, 0.9683778982143849,
];
const random = mulberry32(1);
for (const [index, expected] of pinnedSequence.entries()) {
  const actual = random();
  check(
    Math.abs(actual - expected) < 1e-15,
    `mulberry32(1)[${index}] must be ${expected}; got ${actual}`,
  );
}

// ---------------------------------------------------------------------------
// 4. REPLAY PROOF. A (seed, space version) pair reproduces a byte-identical
//    case. Proved in-process, and across processes against the digests the
//    generator persisted into the seed registry.
// ---------------------------------------------------------------------------
const replaySeeds = [1, 7, 4242, 99991, 2 ** 31 - 1];
let seedsReplayed = 0;
for (const seed of replaySeeds) {
  const first = generateCase({ seed, context });
  const second = generateCase({ seed, context });
  check(
    first.canonical_json === second.canonical_json,
    `seed ${seed} must reproduce a byte-identical case`,
  );
  check(first.sha256 === second.sha256, `seed ${seed} must reproduce an identical digest`);
  check(
    first.dimension_space_version === space.contract.space_version,
    `seed ${seed} case must stamp the dimension-space version it was drawn from`,
  );
  seedsReplayed += 1;
}
check(
  new Set(replaySeeds.map((seed) => generateCase({ seed, context }).sha256)).size === replaySeeds.length,
  "distinct seeds must produce distinct cases — a generator that collapses is not sampling",
);

const registryPresent = fs.existsSync(options.seeds);
check(registryPresent, `seed registry ${options.seeds} must exist — generate it with scripts/generate_case_cohort.mjs`);
const seedRegistry = JSON.parse(fs.readFileSync(options.seeds, "utf8"));
check(
  seedRegistry.schema_version === "excel-inflow-generated-case-seed-registry/1.0",
  "seed registry must declare its schema version",
);
check(
  seedRegistry.dimension_space_version === space.contract.space_version &&
    seedRegistry.dimension_space_sha256 === space.sha256,
  "seed registry must be bound to the dimension space that produced it — a stale registry is not a replay",
);
check(
  (seedRegistry.seed_shape_inventory_sha256 ?? null) === liveInventory,
  "seed registry was generated against a different archetype seed-shape inventory " +
    `(registry ${seedRegistry.seed_shape_inventory_sha256}, live ${liveInventory}). ` +
    "Regenerate with `node scripts/generate_case_cohort.mjs --tier pr --update-seed-registry`.",
);
check(
  (seedRegistry.seed_shape_mode ?? "off") === seedShapeMode,
  `seed registry was generated in seed-shape mode ${seedRegistry.seed_shape_mode}, space declares ${seedShapeMode}`,
);
check(
  Array.isArray(seedRegistry.interesting_seeds) && seedRegistry.interesting_seeds.length > 0,
  "seed registry must persist at least one interesting seed",
);
for (const entry of seedRegistry.interesting_seeds) {
  const replayed = generateCase({ seed: entry.seed, context });
  check(
    replayed.sha256 === entry.case_sha256,
    `persisted seed ${entry.seed} no longer replays to ${entry.case_sha256} (got ${replayed.sha256})`,
  );
  seedsReplayed += 1;
}

// ---------------------------------------------------------------------------
// 5. Archetype seed shapes: typed absence, never a crash.
// ---------------------------------------------------------------------------
const declaredPropertyIdsEarly = new Set(PROPERTIES.map((property) => property.id));
const shapes = loadArchetypeSeedShapes(ROOT);
check(typeof shapes.present === "boolean", "archetype seed-shape loader must report presence as a typed boolean");
if (shapes.present) {
  check(shapes.shapes.length > 0, "a present archetype directory must yield at least one seed shape");
  for (const shape of shapes.shapes) {
    check(typeof shape.archetype_id === "string" && shape.archetype_id.length > 0, "each seed shape needs an archetype id");
    check(shape.group.length > 0, `seed shape ${shape.archetype_id} needs its catalogue group`);
  }
  // The variation capability is asserted in BOTH modes: an explicit inventory
  // context drives the archetype path even when the pinned corpus is independent
  // of it, so the capability is proved rather than merely declared.
  const shapeContext = buildGeneratorContext(space, { seedShapes: shapes.shapes });
  check(
    typeof shapeContext.seedShapeInventorySha256 === "string" &&
      /^[0-9a-f]{64}$/.test(shapeContext.seedShapeInventorySha256),
    "a present inventory must bind by digest",
  );
  const varied = generateCase({ seed: 31337, context: shapeContext, seedShape: shapes.shapes[0] });
  check(
    varied.seed_shape?.archetype_id === shapes.shapes[0].archetype_id,
    "a case varied from an archetype seed shape must record the shape it varied",
  );
  const variedAgain = generateCase({ seed: 31337, context: shapeContext, seedShape: shapes.shapes[0] });
  check(
    varied.canonical_json === variedAgain.canonical_json,
    "an archetype-seeded case must replay byte-identically too",
  );
  // The shape is chosen BY THE SEED, so a plain replay carries the archetype too.
  const bySeed = generateCase({ seed: 31337, context: shapeContext });
  check(
    bySeed.seed_shape !== null && bySeed.seed_shape.case_path.startsWith("test-fixtures/archetypes/"),
    "with an inventory present, a seed alone must select its archetype seed shape",
  );
  // The archetype overlay is drawn LAST, so the axes of a seed do not shift when
  // the catalogues land: the pinned corpus stays comparable across modes.
  const withoutInventory = generateCase({ seed: 31337, context });
  check(
    canonicalJson(withoutInventory.axes) === canonicalJson(bySeed.axes),
    "an appearing seed-shape inventory must not shift the axis draw of a seed",
  );
  // An archetype that declares a register must actually supersede the generated
  // one, otherwise the case would only be decorated rather than varied.
  const archetypeRegisters = shapes.shapes.filter(
    (shape) => Array.isArray(shape.base_case?.instruments) && shape.base_case.instruments.length > 0,
  );
  if (archetypeRegisters.length) {
    let overlaid = null;
    for (let seed = 40000; seed < 40400 && overlaid === null; seed += 1) {
      const candidate = generateCase({ seed, context: shapeContext, seedShape: archetypeRegisters[0] });
      if (candidate.register_origin === "archetype" && candidate.model_case.instruments.length > 0) {
        overlaid = candidate;
      }
    }
    check(overlaid !== null, "an archetype declaring a register must be able to supersede the generated register");
    check(
      overlaid.model_case.instruments[0].instrument_id ===
        archetypeRegisters[0].base_case.instruments[0].instrument_id,
      "the archetype's own instrument must be the one carried into the varied case",
    );
    check(
      overlaid.axes_superseded_by_seed_shape.includes("currency_mix"),
      "a case whose register came from an archetype must name the axes the seed shape superseded",
    );
    check(
      evaluateCase(overlaid, context).violations.every((violation) =>
        declaredPropertyIdsEarly.has(violation.property_id),
      ),
      "an archetype-varied case must be evaluable by the declared properties",
    );
  }
  seedsReplayed += 1;
} else {
  check(
    typeof shapes.reason === "string" && shapes.reason.length > 0,
    "an absent archetype directory must carry a typed reason, never an untyped empty",
  );
  check(
    shapes.reason === "archetype_root_absent" || shapes.reason === "archetype_groups_absent",
    `absence reason must be one of the declared typed reasons; got ${shapes.reason}`,
  );
  check(Array.isArray(shapes.shapes) && shapes.shapes.length === 0, "typed absence yields an empty shape list");
}

// ---------------------------------------------------------------------------
// 6. Every declared property is asserted by the evaluator — a property the
//    evaluator cannot reach is a claim, not a test.
// ---------------------------------------------------------------------------
check(PROPERTIES.length >= 10, `the evaluator must declare at least 10 properties; got ${PROPERTIES.length}`);
for (const property of PROPERTIES) {
  check(typeof property.id === "string" && /^[a-z0-9_]+$/.test(property.id), `property id ${property.id} must be snake_case`);
  check(typeof property.statement === "string" && property.statement.length > 20, `property ${property.id} needs a real statement`);
}
const declaredPropertyIds = new Set(PROPERTIES.map((property) => property.id));

// ---------------------------------------------------------------------------
// 7. Generate the slice and evaluate every property on every case.
// ---------------------------------------------------------------------------
const requestedCount = options.cases ?? tiers[options.tier];
check(Number.isInteger(requestedCount) && requestedCount > 0, `unknown tier ${options.tier} and no --cases override`);
const cohort = generateCohort({
  count: requestedCount,
  seed: options.seed ?? space.contract.default_root_seed,
  context,
});
check(cohort.cases.length === requestedCount, `cohort must hold exactly ${requestedCount} cases`);
check(
  new Set(cohort.cases.map((item) => item.seed)).size === requestedCount,
  "a cohort must never reuse a seed — a repeated seed is a smaller cohort wearing a larger number",
);

const dispositioned = new Map(
  (space.contract.dispositioned_defects ?? []).map((entry) => [entry.signature, entry]),
);
for (const entry of dispositioned.values()) {
  check(
    declaredPropertyIds.has(entry.property_id),
    `dispositioned defect ${entry.signature} names unknown property ${entry.property_id}`,
  );
  check(
    typeof entry.owner === "string" && typeof entry.statement === "string" && entry.statement.length > 20,
    `dispositioned defect ${entry.signature} must name an owner and state the defect`,
  );
}

const observed = new Map();
let evaluations = 0;
for (const generated of cohort.cases) {
  const verdict = evaluateCase(generated, context);
  evaluations += verdict.assertions;
  for (const violation of verdict.violations) {
    check(
      declaredPropertyIds.has(violation.property_id),
      `violation reported for undeclared property ${violation.property_id}`,
    );
    if (!observed.has(violation.signature)) {
      observed.set(violation.signature, { violation, seed: generated.seed, count: 0 });
    }
    observed.get(violation.signature).count += 1;
  }
}
check(evaluations >= cohort.cases.length * 5, "every case must be put through the property battery, not skipped");

// ---------------------------------------------------------------------------
// 8. New violations FAIL, with a shrunk minimal reproduction. Dispositioned
//    violations must still reproduce from their persisted seed.
// ---------------------------------------------------------------------------
const newDefects = [];
for (const [signature, record] of observed) {
  if (dispositioned.has(signature)) continue;
  const shrunk = shrinkCase(
    cohort.cases.find((item) => item.seed === record.seed),
    signature,
    context,
  );
  newDefects.push({
    signature,
    property_id: record.violation.property_id,
    seed: record.seed,
    occurrences: record.count,
    detail: record.violation.detail,
    minimal: shrunk.summary,
    shrink_steps: shrunk.steps.length,
  });
}
for (const defect of newDefects) {
  failures.push(
    `DEFECT FOUND ${defect.signature} seed=${defect.seed} occurrences=${defect.occurrences}\n` +
      `  detail: ${defect.detail}\n` +
      `  minimal: ${JSON.stringify(defect.minimal)}`,
  );
}

const knownDefects = [];
for (const [signature, entry] of dispositioned) {
  const replayed = generateCase({ seed: entry.seed, context });
  const verdict = evaluateCase(replayed, context);
  const reproduced = verdict.violations.some((violation) => violation.signature === signature);
  check(
    replayed.sha256 === entry.case_sha256,
    `dispositioned seed ${entry.seed} must replay to its persisted digest ${entry.case_sha256}`,
  );
  check(
    reproduced,
    `dispositioned defect ${signature} no longer reproduces from seed ${entry.seed} — retire the pin instead of leaving it standing`,
  );
  seedsReplayed += 1;
  knownDefects.push({ signature, seed: entry.seed, owner: entry.owner });
}

// ---------------------------------------------------------------------------
// 9. SHRINK PROOF. The shrinker is proved against a synthetic oracle whose
//    failure is independent of any product defect, so the proof survives the
//    day the real defects are repaired.
// ---------------------------------------------------------------------------
const shrinkSubject = generateCase({ seed: space.contract.shrink_proof.seed, context, inflate: true });
check(
  shrinkSubject.model_case.instruments.length >= space.contract.shrink_proof.min_instruments,
  `the shrink subject must start large; got ${shrinkSubject.model_case.instruments.length} instruments`,
);
const probeSignature = probeOracleSignature();
const probeVerdict = evaluateCase(shrinkSubject, context, { probe: true });
check(
  probeVerdict.violations.some((violation) => violation.signature === probeSignature),
  "the shrink-proof oracle must fail on the inflated subject before shrinking",
);
const shrunk = shrinkCase(shrinkSubject, probeSignature, context, { probe: true });
check(shrunk.steps.length > 0, "the shrinker must accept at least one reduction");
check(
  shrunk.minimal.model_case.instruments.length < shrinkSubject.model_case.instruments.length,
  `the shrinker must reduce the instrument register: ${shrinkSubject.model_case.instruments.length} -> ${shrunk.minimal.model_case.instruments.length}`,
);
check(
  shrunk.minimal.model_case.periods.length <= shrinkSubject.model_case.periods.length,
  "the shrinker must never grow the period list",
);
const shrunkVerdict = evaluateCase(shrunk.minimal, context, { probe: true });
check(
  shrunkVerdict.violations.some((violation) => violation.signature === probeSignature),
  "the shrunk minimal case must still reproduce the failure signature",
);
for (const step of shrunk.steps) {
  check(
    step.signature_preserved === true,
    `shrink step ${step.operator} was accepted without preserving the failure signature`,
  );
}
const shrunkAgain = shrinkCase(shrinkSubject, probeSignature, context, { probe: true });
check(
  canonicalJson(shrunkAgain.minimal.model_case) === canonicalJson(shrunk.minimal.model_case),
  "shrinking must be deterministic — the same failure shrinks to the same minimal case",
);
check(
  shrunk.minimal.model_case.instruments.length <= space.contract.shrink_proof.expected_minimal_instruments,
  `the shrinker must reach the declared minimum of ${space.contract.shrink_proof.expected_minimal_instruments} instruments; got ${shrunk.minimal.model_case.instruments.length}`,
);

// ---------------------------------------------------------------------------
// 10. DISTRIBUTION REPORT. Under-sampled corners must be visible, and every
//     declared dimension value must actually be reached by the default slice.
// ---------------------------------------------------------------------------
const distribution = distributionReport(cohort.cases, context);
check(distribution.dimensions.length === context.axes.length, "the distribution report must cover every declared axis");
const unreached = [];
for (const dimension of distribution.dimensions) {
  for (const [value, count] of Object.entries(dimension.values)) {
    if (count === 0) unreached.push(`${dimension.dimension}=${value}`);
  }
}
check(
  unreached.length === 0,
  `the default slice left ${unreached.length} declared dimension values unreached: ${unreached.slice(0, 8).join(", ")}`,
);
check(
  Array.isArray(distribution.under_sampled),
  "the distribution report must name under-sampled corners rather than assume them covered",
);
check(
  distribution.total_value_slots === context.axes.reduce((total, axis) => total + axis.values.length, 0),
  "the distribution report must count every declared value slot",
);
// Value coverage can be complete while a whole evaluation lane is starved, so the
// lanes are asserted too: a property nothing reaches is a claim, not a test.
check(
  distribution.under_sampled_lanes.length === 0,
  `starved evaluation lane(s): ${JSON.stringify(distribution.under_sampled_lanes)} ` +
    `(minimum share ${distribution.minimum_lane_share})`,
);
for (const stratum of STRATA) {
  check(
    (distribution.strata[stratum] ?? 0) > 0,
    `the declared ${stratum} stratum must be sampled by the default slice`,
  );
}
for (const lane of Object.keys(distribution.lane_coverage)) {
  // The archetype-register lane is only populated in seed-shape mode "inventory";
  // in mode "off" the capability is asserted above against an explicit inventory.
  if (lane === "archetype_register" && seedShapeMode !== "inventory") continue;
  check(
    distribution.lane_coverage[lane] > 0,
    `evaluation lane ${lane} was never reached: ${JSON.stringify(distribution.lane_coverage)}`,
  );
}
// All four declared support classes must appear, CERTIFIED included: the class
// that carries the release promise was reached zero times under uniform sampling.
const classesSeen = Object.keys(distribution.support_class_distribution);
for (const supportClass of context.envelope.contract.class_order_worst_first) {
  check(
    classesSeen.includes(supportClass),
    `support class ${supportClass} was never sampled: ${JSON.stringify(distribution.support_class_distribution)}`,
  );
}

// ---------------------------------------------------------------------------
// 11. Cross-contract closure: every registered reason code has at least one
//     support class whose legal terminals admit it, and the table is reported.
// ---------------------------------------------------------------------------
const closure = reasonTerminalClosureTable(context);
check(closure.rows.length === Object.keys(context.reasonCodes).length, "the closure table must cover every registered reason code");
check(
  closure.rows.every((row) => Array.isArray(row.legal_in_classes)),
  "each closure row must name the support classes that admit its terminal states",
);

// ---------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------
if (failures.length) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.stderr.write(
    `\n${failures.length} new property violation(s). Persist the seeds with ` +
      "scripts/generate_case_cohort.mjs --update-seed-registry and disposition them in " +
      "assets/generated-case-dimension-space-v1.json; never loosen the property.\n",
  );
  console.log(
    JSON.stringify({
      status: "FAIL",
      checks,
      cases: cohort.cases.length,
      seeds_replayed: seedsReplayed,
      defects_new: newDefects.length,
      known_defects: knownDefects.length,
    }),
  );
  process.exit(1);
}

for (const defect of knownDefects) {
  process.stderr.write(`KNOWN DEFECT (dispositioned) ${defect.signature} seed=${defect.seed} owner=${defect.owner}\n`);
}

console.log(
  JSON.stringify({
    status: "PASS",
    checks,
    cases: cohort.cases.length,
    seeds_replayed: seedsReplayed,
    generator_version: CASE_GENERATOR_VERSION,
    dimension_space_version: space.contract.space_version,
    declared_space_size: size.toString(),
    tier: options.cases ? "explicit" : options.tier,
    properties: PROPERTIES.length,
    property_assertions: evaluations,
    defects_new: 0,
    known_defects: knownDefects.length,
    under_sampled: distribution.under_sampled.length,
  }),
);
