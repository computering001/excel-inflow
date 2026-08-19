/**
 * P7.3 — Seeded property-case generator (v3.7.7).
 *
 * Invariant: cases are GENERATED from a declared dimension space by a seeded,
 * reproducible generator. A seed fully determines a case; the generator reports
 * its distribution over the dimension space; a failing seed is PERSISTED and
 * replayable; and a failure is SHRUNK to a minimal reproducing case.
 *
 * The existing cohort (compile_synthetic_cohort.mjs) enumerates 32 named
 * recipes. This module does not replace it and does not touch it: it samples a
 * declared space of ~4e10 points, of which those 32 are one hand-picked corner.
 *
 * Structure of a generated case:
 *   - an INTAKE DESCRIPTOR over the 11 support-envelope dimensions, which is
 *     the only input the envelope classifier is allowed to read;
 *   - a MODEL CASE skeleton (issuer, periods, instrument register, fx) large
 *     enough for the opening-instrument compiler, which is where the programme's
 *     never-zero law lives;
 *   - the generator-owned pathology axes (declared value states, currency mix,
 *     refusal pressure) that decide which lawful refusal the case should reach.
 *
 * When an archetype catalogue is present under test-fixtures/archetypes/, an
 * archetype case is used as a SEED SHAPE: its own statement structure and
 * register are carried in and the generator varies the axes on top. When the
 * directory is absent the loader returns a TYPED ABSENCE and the generator
 * produces skeleton cases — never a crash and never a silent empty cohort.
 *
 * This module is PURE with respect to the product: it compiles, classifies and
 * asserts. It never repairs a case to make a property pass.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifySupport, loadSupportEnvelope } from "./support_envelope.mjs";
import { compileOpeningInstrumentState } from "./instrument_period_state.mjs";
import {
  OPENING_INSTRUMENT_NOT_SELECTED_REASONS,
  typedDeclaredAmount,
} from "./opening_instrument_provenance.mjs";

export const CASE_GENERATOR_VERSION = "excel-inflow-generated-case-generator/1.0.0";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SPACE_PATH = path.join(ROOT, "assets", "generated-case-dimension-space-v1.json");
const REASON_REGISTRY_PATH = path.join(ROOT, "assets", "terminal-reason-registry-v1.json");
const ARCHETYPE_ROOT = path.join(ROOT, "test-fixtures", "archetypes");

/** The value marker for "this dimension was not stated at intake". */
export const UNKNOWN_VALUE = "__unknown";

/**
 * The same mulberry32 the pinned cohort decorates its fixed cases with
 * (compile_synthetic_cohort.mjs:68). It is not exported there, so it is
 * reproduced here byte-for-byte rather than forked: run_generated_cohort_tests
 * pins the sequence for seed 1 so a drift is a failure, not a new sample.
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable, key-sorted JSON so a case digest depends on content, never on key order. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// The declared space
// ---------------------------------------------------------------------------

/**
 * Load the declared dimension space and re-derive its envelope axes from the
 * live support envelope. Divergence between the recorded derivation and the
 * envelope is returned as typed DRIFT, never absorbed: the space is allowed to
 * describe the envelope, never to contradict it.
 */
export function loadDimensionSpace(spacePath = SPACE_PATH) {
  const bytes = fs.readFileSync(spacePath);
  const contract = JSON.parse(bytes.toString("utf8"));
  const envelope = loadSupportEnvelope();
  const drift = [];
  if (contract.derived_from.envelope_version !== envelope.version) {
    drift.push(
      `envelope_version ${contract.derived_from.envelope_version} recorded, ${envelope.version} loaded`,
    );
  }
  if (contract.derived_from.envelope_sha256 !== envelope.sha256) {
    drift.push(`envelope_sha256 ${contract.derived_from.envelope_sha256} recorded, ${envelope.sha256} loaded`);
  }
  const liveNames = Object.keys(envelope.contract.dimensions).sort();
  const recordedNames = Object.keys(contract.envelope_dimensions).sort();
  if (canonicalJson(liveNames) !== canonicalJson(recordedNames)) {
    drift.push(`envelope dimension names differ: recorded ${recordedNames.join(",")}`);
  }
  for (const name of liveNames) {
    const recorded = contract.envelope_dimensions[name];
    if (!recorded) continue;
    const liveValues = [...Object.keys(envelope.contract.dimensions[name].values), UNKNOWN_VALUE];
    if (canonicalJson([...liveValues].sort()) !== canonicalJson([...recorded.values].sort())) {
      drift.push(`${name} values differ from the envelope`);
    }
    if (recorded.unknown_value_class !== envelope.contract.dimensions[name].unknown_value_class) {
      drift.push(`${name} unknown_value_class differs from the envelope`);
    }
  }
  return {
    contract,
    sha256: sha256(bytes.toString("utf8")),
    envelope: { contract: envelope.contract, version: envelope.version, sha256: envelope.sha256 },
    drift,
    path: spacePath,
  };
}

/**
 * Flatten the declared space into the ordered axis list the sampler draws from.
 * Envelope axes come first, in envelope order, so a case's axis draw is stable
 * against generator-owned axes being added later.
 */
export function buildGeneratorContext(space, { seedShapes = null } = {}) {
  const axes = [];
  for (const [dimension, spec] of Object.entries(space.envelope.contract.dimensions)) {
    axes.push({
      dimension,
      origin: "support_envelope",
      values: [...Object.keys(spec.values), UNKNOWN_VALUE],
      classes: { ...spec.values, [UNKNOWN_VALUE]: spec.unknown_value_class },
    });
  }
  for (const [dimension, spec] of Object.entries(space.contract.generator_dimensions)) {
    axes.push({ dimension, origin: "generator", values: [...spec.values], classes: null });
  }
  const registry = JSON.parse(fs.readFileSync(REASON_REGISTRY_PATH, "utf8"));
  // The seed-shape inventory is a VERSIONED INPUT, not ambient state: two sibling
  // packages author the archetype catalogues, so the inventory changes under this
  // generator. Binding the pinned corpus to it would make every archetype
  // addition invalidate every persisted seed, so the space DECLARES a mode:
  // "off" keeps the corpus independent (the registered default), "inventory"
  // varies archetype cases. Either way a case stamps the inventory digest it was
  // drawn against, so a replay against a different inventory is a TYPED
  // staleness report rather than a silently different case.
  const mode = space.contract.seed_shape_mode ?? "off";
  const inventory =
    seedShapes !== null ? seedShapes : mode === "inventory" ? loadArchetypeSeedShapes().shapes : [];
  const sorted = [...inventory].sort((left, right) => left.case_path.localeCompare(right.case_path));
  return {
    space,
    axes,
    envelope: space.envelope,
    reasonCodes: registry.reason_codes,
    registry,
    notSelectedReasons: new Set(OPENING_INSTRUMENT_NOT_SELECTED_REASONS),
    seedShapeMode: seedShapes !== null ? "explicit" : mode,
    seedShapes: sorted,
    seedShapeInventorySha256: sorted.length
      ? sha256(canonicalJson(sorted.map((shape) => shape.case_path)))
      : null,
  };
}

/** The declared space size as an exact bigint — the cohort is a sample of this. */
export function spaceSize(space) {
  const context = space.axes ? space : buildGeneratorContext(space);
  return context.axes.reduce((total, axis) => total * BigInt(axis.values.length), 1n);
}

// ---------------------------------------------------------------------------
// Archetype seed shapes (typed absence)
// ---------------------------------------------------------------------------

/**
 * Read archetype cases as seed shapes. Two sibling packages author catalogues
 * under test-fixtures/archetypes/<group>/; either may land after this one, so
 * every absence is a declared typed state and never an exception.
 */
export function loadArchetypeSeedShapes(root = ROOT) {
  const archetypeRoot = path.join(root, "test-fixtures", "archetypes");
  if (!fs.existsSync(archetypeRoot)) {
    return { present: false, reason: "archetype_root_absent", root: archetypeRoot, groups: [], shapes: [] };
  }
  let groups;
  try {
    groups = fs
      .readdirSync(archetypeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    return {
      present: false,
      reason: "archetype_groups_absent",
      root: archetypeRoot,
      groups: [],
      shapes: [],
      detail: String(error?.message ?? error),
    };
  }
  const shapes = [];
  const unreadable = [];
  for (const group of groups) {
    const groupDir = path.join(archetypeRoot, group);
    const files = fs
      .readdirSync(groupDir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const file of files) {
      const absolute = path.join(groupDir, file);
      try {
        const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
        shapes.push({
          archetype_id: parsed.case_id ?? path.basename(file, ".json"),
          group,
          case_path: path.relative(root, absolute).split(path.sep).join("/"),
          base_case: parsed,
        });
      } catch (error) {
        // A malformed archetype is named, not silently skipped, and never
        // aborts the generator: the sibling package owns its own file.
        unreadable.push({ case_path: path.relative(root, absolute), detail: String(error?.message ?? error) });
      }
    }
  }
  if (!shapes.length) {
    return { present: false, reason: "archetype_groups_absent", root: archetypeRoot, groups, shapes: [], unreadable };
  }
  return { present: true, reason: null, root: archetypeRoot, groups, shapes, unreadable };
}

// ---------------------------------------------------------------------------
// Case construction
// ---------------------------------------------------------------------------

const INSTRUMENT_CLASSES = [
  "bond_fixed",
  "bond_floating",
  "term_loan_fixed",
  "term_loan_floating",
  "commercial_paper",
  "securitisation",
  "rcf",
  "lease_liability",
  "overdraft",
  "other_explicit",
];

const BOOK_SIZE = { none: 0, single: 1, small_book: 3, large_book: 9 };
const HISTORICAL_COUNT = { one: 1, two: 2, three: 3, five: 5 };

/**
 * The declared-value pathologies the register is sampled over. Every one of
 * these arrives in the real world (a model-host JSON payload, a broker pack
 * cell, an XBRL fact with an empty value) and every one of them is a NON-NUMBER:
 * the programme's law is that none of them may ever become a number.
 */
const PATHOLOGY_RAW = {
  well_formed: () => null, // replaced by a real number by the caller
  nil: () => null,
  reported_blank: () => "",
  whitespace_only: () => " ",
  boolean_false: () => false,
  boolean_true: () => true,
  empty_array: () => [],
  non_numeric_text: () => "n/a",
  numeric_text: () => "1500.5",
  negative: () => -1,
};

/** A pathology whose raw value is not a finite JSON number. */
const NON_NUMBER_PATHOLOGIES = new Set([
  "nil",
  "reported_blank",
  "whitespace_only",
  "boolean_false",
  "boolean_true",
  "empty_array",
  "non_numeric_text",
]);

function pick(values, random) {
  return values[Math.floor(random() * values.length) % values.length];
}

export const STRATA = Object.freeze([
  "in_envelope",
  "degraded_target",
  "certified_target",
  "unrestricted",
]);

/** Which declared stratum a seed falls in. Drawn from the seed, never ambient. */
function drawStratum(context, draw) {
  const declared = context.space.contract.stratification ?? {};
  const inEnvelope = declared.in_envelope_share ?? 0;
  const degraded = declared.degraded_target_share ?? 0;
  const certified = declared.certified_target_share ?? 0;
  if (draw < inEnvelope) return "in_envelope";
  if (draw < inEnvelope + degraded) return "degraded_target";
  if (draw < inEnvelope + degraded + certified) return "certified_target";
  return "unrestricted";
}

/**
 * Uniform sampling over the whole space spends most of its budget on cases the
 * envelope stops at preflight — five of the eleven entity types are financial
 * institutions — so the deep lanes (the compiled instrument register, the
 * refusal lane) would be starved however large the cohort. The space therefore
 * declares a STRATIFICATION: a share of seeds is drawn from the in-envelope
 * stratum, where no axis takes an UNSUPPORTED value. Which stratum a seed falls
 * in is itself drawn from the seed, so nothing about determinism is given up,
 * and the distribution report names both the strata and the lane coverage.
 */
function drawAxes(context, random, stratum) {
  const axes = {};
  for (const axis of context.axes) {
    axes[axis.dimension] = pick(valuePoolFor(axis, stratum), random);
  }
  if (stratum === "degraded_target") {
    // SUPPORTED_DEGRADED is the class that carries the workbook disclosure
    // requirement, and it is the hardest class to hit by chance: it needs every
    // dimension at CERTIFIED or SUPPORTED_DEGRADED and at least one actually
    // degraded. The stratum therefore forces one degradable dimension rather
    // than leaving the disclosure lane to luck.
    const degradable = context.axes.filter(
      (axis) =>
        axis.origin === "support_envelope" &&
        axis.values.some((value) => axis.classes[value] === "SUPPORTED_DEGRADED"),
    );
    const alreadyDegraded = degradable.some(
      (axis) => axis.classes[axes[axis.dimension]] === "SUPPORTED_DEGRADED",
    );
    if (degradable.length && !alreadyDegraded) {
      const axis = pick(degradable, random);
      const pool = axis.values.filter((value) => axis.classes[value] === "SUPPORTED_DEGRADED");
      axes[axis.dimension] = pick(pool, random);
    }
  }
  return axes;
}

const RESTRICTED_GENERATOR_VALUES = { identity_verdict: ["mismatch"] };

function valuePoolFor(axis, stratum) {
  if (stratum === "unrestricted") return axis.values;
  if (axis.origin === "support_envelope") {
    const forbidden = {
      certified_target: ["UNSUPPORTED", "EXPERIMENTAL", "SUPPORTED_DEGRADED"],
      degraded_target: ["UNSUPPORTED", "EXPERIMENTAL"],
      in_envelope: ["UNSUPPORTED"],
    }[stratum] ?? ["UNSUPPORTED"];
    const pool = axis.values.filter((value) => !forbidden.includes(axis.classes[value]));
    return pool.length ? pool : axis.values;
  }
  const excluded = RESTRICTED_GENERATOR_VALUES[axis.dimension] ?? [];
  const pool = axis.values.filter((value) => !excluded.includes(value));
  return pool.length ? pool : axis.values;
}

function descriptorFromAxes(context, axes) {
  const descriptor = {};
  for (const axis of context.axes) {
    if (axis.origin !== "support_envelope") continue;
    if (axes[axis.dimension] === UNKNOWN_VALUE) continue;
    descriptor[axis.dimension] = axes[axis.dimension];
  }
  // The two early-stop predicates that read intake facts outside the dimension
  // table are drawn from their own generator axes, so the stop paths are sampled
  // rather than assumed unreachable.
  if (axes.identity_verdict && axes.identity_verdict !== "unstated") {
    descriptor.identity_verdict = axes.identity_verdict;
  }
  if (axes.declared_language_adapter === "declared") {
    descriptor.declared_language_adapter = "generated-case-language-adapter/1.0";
  }
  return descriptor;
}

function buildPeriods(historicalCount, forecastCount) {
  const periods = [];
  for (let index = 0; index < historicalCount; index += 1) {
    periods.push({ date: `${2019 + index}-12-31`, status: "historical" });
  }
  for (let index = 0; index < forecastCount; index += 1) {
    periods.push({ date: `${2019 + historicalCount + index}-12-31`, status: "forecast" });
  }
  return periods;
}

function buildInstrument({ ordinal, axes, random, forecastCount, foreignCurrency }) {
  const instrumentClass =
    axes.debt_instruments === "within_declared_matrix" || axes.debt_instruments === UNKNOWN_VALUE
      ? INSTRUMENT_CLASSES[ordinal % INSTRUMENT_CLASSES.length]
      : pick(INSTRUMENT_CLASSES, random);
  const magnitude = Math.round((random() * 2000 + 25) * 10) / 10;
  const pathology = ordinal === 0 ? axes.declared_value_pathology : "well_formed";
  const declared = pathology === "well_formed" ? magnitude : PATHOLOGY_RAW[pathology]();
  const currency =
    axes.currency_mix === "reporting_only" || ordinal % 2 === 0 ? "USD" : foreignCurrency;
  return {
    instrument_id: `gen_${String(ordinal + 1).padStart(2, "0")}_${instrumentClass}`,
    display_order: ordinal + 1,
    name: `Generated ${instrumentClass.replaceAll("_", " ")} ${ordinal + 1}`,
    class: instrumentClass,
    currency,
    opening_balance: declared,
    balance_basis: "native_principal",
    maturity_date: `${2030 + (ordinal % 7)}-06-30`,
    maturity_precision: "day",
    maturity_treatment: "contractual",
    scheduled_amortisation: Array(forecastCount).fill(0),
    new_issuance: Array(forecastCount).fill(0),
    rate_type: instrumentClass.endsWith("floating") ? "floating" : "fixed",
    coupon_or_all_in_rate: Array(forecastCount).fill(0.05),
    benchmark: instrumentClass.endsWith("floating") ? "sofr" : null,
    benchmark_rate: Array(forecastCount).fill(instrumentClass.endsWith("floating") ? 0.032 : 0),
    spread_bps: instrumentClass.endsWith("floating") ? 175 : null,
    facility_capacity: instrumentClass === "rcf" ? Math.round(magnitude * 2) : null,
    include_in_gross_debt: true,
    include_in_net_debt: true,
    cash_interest: instrumentClass !== "lease_liability",
    other_non_cash_movement: Array(forecastCount).fill(0),
  };
}

/**
 * Carry an archetype instrument into a case whose forecast horizon differs from
 * the archetype's. Only the per-period arrays are resized; every economic field
 * the archetype declared is left exactly as authored.
 */
function resizeInstrumentPeriods(instrument, forecastCount, ordinal) {
  const resize = (values, fallback) =>
    Array.from({ length: forecastCount }, (_, index) => values?.[index] ?? values?.[0] ?? fallback);
  const carried = { ...instrument, display_order: ordinal + 1 };
  for (const [field, fallback] of [
    ["scheduled_amortisation", 0],
    ["new_issuance", 0],
    ["other_non_cash_movement", 0],
    ["coupon_or_all_in_rate", 0.05],
    ["benchmark_rate", 0],
  ]) {
    if (instrument[field] === undefined) continue;
    carried[field] = resize(instrument[field], fallback);
  }
  return carried;
}

/**
 * Which lawful refusal this case is under pressure to reach. The axis names the
 * reason CATEGORY the case exercises; the reason code itself always comes from
 * the registry so an unregistered refusal is impossible to construct here.
 */
const REFUSAL_PRESSURE_REASON = {
  none: null,
  source_identity_unresolved: "SOURCE.issuer_or_reporting_period_unresolved",
  source_opening_debt_unresolved: "SOURCE.opening_debt_unresolved",
  internal_equation_unsolved: "INTERNAL.equation_system_unsolved",
  internal_forecast_ownership_blocked: "INTERNAL.forecast_ownership_blocked",
  internal_runtime_budget_overrun: "INTERNAL.runtime_budget_overrun",
  user_material_economic_choice: "USER.material_economic_choice",
  degraded_broker_unavailable: "DEGRADED.broker_evidence_unavailable",
};

/**
 * Generate the case for one seed. A (seed, dimension-space version) pair fully
 * determines the result: every draw comes from the seeded stream, in a fixed
 * order, and nothing reads the clock, the filesystem or the environment.
 */
export function generateCase({ seed, context, seedShape = undefined, inflate = false }) {
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`seed must be a non-negative integer; got ${seed}`);
  const random = mulberry32(seed);
  const stratum = drawStratum(context, random());
  const axes = drawAxes(context, random, stratum);
  if (inflate) {
    axes.instrument_book = "large_book";
    axes.historical_periods_declared = "five";
    axes.declared_value_pathology = "well_formed";
  }
  const descriptor = descriptorFromAxes(context, axes);
  const support = classifySupport(context.envelope.contract, descriptor);

  const historicalCount =
    axes.historical_periods === "fewer_than_two"
      ? 1
      : HISTORICAL_COUNT[axes.historical_periods_declared] ?? 3;
  const forecastCount = 3;
  const periods = buildPeriods(historicalCount, forecastCount);
  const foreignCurrency = axes.currency_mix === "reporting_only" ? "USD" : "EUR";
  const bookSize = inflate ? BOOK_SIZE.large_book : BOOK_SIZE[axes.instrument_book] ?? 1;
  const instruments = [];
  for (let ordinal = 0; ordinal < bookSize; ordinal += 1) {
    instruments.push(buildInstrument({ ordinal, axes, random, forecastCount, foreignCurrency }));
  }
  const modelCase = {
    contract_version: 2,
    case_id: `generated_${seed}`,
    execution_profile: "production_model",
    issuer: {
      name: `Generated Issuer ${seed} (GENERATED PROPERTY CASE — NOT A REAL COMPANY)`,
      reporting_currency: "USD",
      units: "millions",
      fiscal_year_end: axes.fiscal_calendar === "week_52_53" ? "52-53-week" : "12-31",
    },
    periods,
    instruments,
  };
  if (axes.currency_mix === "foreign_with_declared_fx") {
    modelCase.fx = {
      [foreignCurrency]: {
        quote: "reporting_per_native",
        average_rates: periods.map(() => 1.1),
        period_end_rates: periods.map(() => 1.09),
      },
    };
  }
  // foreign_with_absent_fx deliberately omits the fx block so the translation
  // authority is genuinely absent and must be refused, not defaulted to 1.0.

  // The seed shape is drawn from the seeded stream LAST, so an inventory that
  // appears or grows never shifts any earlier draw: the axes and the register of
  // a given seed are stable whether or not the archetype catalogues have landed.
  const inventory = context.seedShapes ?? [];
  const resolvedShape =
    seedShape !== undefined
      ? seedShape
      : inventory.length
        ? inventory[Math.floor(random() * inventory.length) % inventory.length]
        : null;
  const seedShapeRecord = resolvedShape
    ? { archetype_id: resolvedShape.archetype_id, group: resolvedShape.group, case_path: resolvedShape.case_path }
    : null;
  let registerOrigin = "generated";
  const supersededAxes = [];
  if (resolvedShape?.base_case) {
    // The archetype supplies the accounting shape; the generator VARIES the axes
    // on top of it. Structure the archetype owns is carried, never overwritten.
    for (const key of ["statement_structure", "modules", "controls", "operating_metrics", "forecast_assumptions", "presentation_profile"]) {
      if (resolvedShape.base_case[key] !== undefined) modelCase[key] = resolvedShape.base_case[key];
    }
    modelCase.case_id = `generated_${seed}_from_${resolvedShape.archetype_id}`;
    // The archetype's instrument register is the shape under test, so it becomes
    // the base register and the pathology axis is applied to its first row. The
    // instrument_book axis then selects how much of that register is carried, so
    // both the archetype and the axis stay meaningful — and the case records
    // which axes the seed shape superseded rather than misreporting them.
    const baseRegister = resolvedShape.base_case.instruments;
    if (Array.isArray(baseRegister) && baseRegister.length > 0) {
      registerOrigin = "archetype";
      supersededAxes.push("currency_mix");
      const carried = structuredClone(baseRegister)
        .slice(0, Math.max(bookSize, 0))
        .map((instrument, ordinal) => resizeInstrumentPeriods(instrument, forecastCount, ordinal));
      while (carried.length < bookSize) {
        carried.push(
          buildInstrument({ ordinal: carried.length, axes, random, forecastCount, foreignCurrency }),
        );
      }
      if (carried.length > 0 && axes.declared_value_pathology !== "well_formed") {
        carried[0] = { ...carried[0], opening_balance: PATHOLOGY_RAW[axes.declared_value_pathology]() };
      }
      modelCase.instruments = carried;
      // The archetype's own FX authority is carried, except when the axis is
      // deliberately probing an absent translation authority.
      if (axes.currency_mix === "foreign_with_absent_fx") delete modelCase.fx;
      else if (resolvedShape.base_case.fx) modelCase.fx = structuredClone(resolvedShape.base_case.fx);
    }
  }

  const body = {
    generator_version: CASE_GENERATOR_VERSION,
    dimension_space_version: context.space.contract.space_version,
    envelope_version: context.envelope.version,
    seed,
    stratum,
    axes,
    descriptor,
    support_class: support.support_class,
    early_stop: support.early_stop,
    // Structural, not advisory: an early-stopped case carries the permission
    // denial in the case itself, so no consumer needs to remember the ordering.
    expensive_processing_permitted: !support.early_stop.stopped,
    degraded_dimensions: support.degraded_dimensions,
    legal_terminals: support.legal_terminals,
    refusal_pressure: axes.refusal_pressure,
    refusal_reason_code: REFUSAL_PRESSURE_REASON[axes.refusal_pressure] ?? null,
    seed_shape: seedShapeRecord,
    seed_shape_inventory_sha256: context.seedShapeInventorySha256 ?? null,
    register_origin: registerOrigin,
    axes_superseded_by_seed_shape: supersededAxes,
    model_case: modelCase,
  };
  const canonical = canonicalJson(body);
  return { ...body, canonical_json: canonical, sha256: sha256(canonical) };
}

/**
 * Generate `count` cases from a root seed. Seeds are the root plus an index so
 * the cohort is a contiguous, restatable seed range: a reviewer can regenerate
 * exactly case k without regenerating the cohort.
 */
export function generateCohort({ count, seed, context }) {
  if (!Number.isInteger(count) || count <= 0) throw new Error(`count must be a positive integer; got ${count}`);
  const rootSeed = Number.isInteger(seed) ? seed : context.space.contract.default_root_seed;
  const cases = [];
  for (let index = 0; index < count; index += 1) {
    // The seed alone determines the case, including which archetype seed shape
    // it varies: nothing about the cohort's ordering leaks into a case.
    cases.push(generateCase({ seed: rootSeed + index, context }));
  }
  return {
    generator_version: CASE_GENERATOR_VERSION,
    dimension_space_version: context.space.contract.space_version,
    root_seed: rootSeed,
    count,
    seed_shape_inventory_sha256: context.seedShapeInventorySha256 ?? null,
    seed_shapes_available: context.seedShapes.length,
    cases,
  };
}

// ---------------------------------------------------------------------------
// Distribution report
// ---------------------------------------------------------------------------

/**
 * How many generated cases hit each declared dimension value. An under-sampled
 * corner is NAMED here rather than assumed covered, which is the whole point of
 * declaring the space instead of enumerating a cohort.
 */
export function distributionReport(cases, context, { underSampledThreshold = null } = {}) {
  const threshold =
    underSampledThreshold ?? context.space.contract.distribution_report.under_sampled_threshold;
  const dimensions = context.axes.map((axis) => ({
    dimension: axis.dimension,
    origin: axis.origin,
    values: Object.fromEntries(axis.values.map((value) => [value, 0])),
  }));
  const byName = new Map(dimensions.map((entry) => [entry.dimension, entry]));
  for (const generated of cases) {
    for (const [dimension, value] of Object.entries(generated.axes)) {
      const record = byName.get(dimension);
      if (!record) continue;
      if (record.values[value] === undefined) record.values[value] = 0;
      record.values[value] += 1;
    }
  }
  const underSampled = [];
  for (const record of dimensions) {
    for (const [value, count] of Object.entries(record.values)) {
      if (count < threshold) underSampled.push({ dimension: record.dimension, value, count });
    }
  }
  const supportClasses = {};
  for (const generated of cases) {
    supportClasses[generated.support_class] = (supportClasses[generated.support_class] ?? 0) + 1;
  }
  const earlyStops = {};
  for (const generated of cases) {
    if (!generated.early_stop.stopped) continue;
    earlyStops[generated.early_stop.reason_code] = (earlyStops[generated.early_stop.reason_code] ?? 0) + 1;
  }
  const strata = {};
  for (const generated of cases) {
    strata[generated.stratum ?? "unrestricted"] = (strata[generated.stratum ?? "unrestricted"] ?? 0) + 1;
  }
  // Value coverage alone can hide a starved LANE: every dimension value can be
  // well sampled while almost no case ever reaches the compiled register. The
  // lanes are therefore counted and thin ones are named.
  const lanes = {
    early_stop: 0,
    register_compiled: 0,
    empty_register: 0,
    refusal_lane: 0,
    certified_release_promise: 0,
    degraded_disclosure: 0,
    translation_authority_absent: 0,
    archetype_register: 0,
  };
  for (const generated of cases) {
    if (generated.early_stop?.stopped) lanes.early_stop += 1;
    const compiles =
      generated.expensive_processing_permitted === true && generated.model_case.instruments.length > 0;
    if (compiles) lanes.register_compiled += 1;
    if (generated.model_case.instruments.length === 0) lanes.empty_register += 1;
    if (generated.refusal_reason_code && generated.support_class !== "UNSUPPORTED") lanes.refusal_lane += 1;
    if (generated.support_class === "CERTIFIED") lanes.certified_release_promise += 1;
    if (generated.support_class === "SUPPORTED_DEGRADED") lanes.degraded_disclosure += 1;
    if (compiles && generated.axes.currency_mix === "foreign_with_absent_fx") {
      lanes.translation_authority_absent += 1;
    }
    if (generated.register_origin === "archetype") lanes.archetype_register += 1;
  }
  const minimumLaneShare = context.space.contract.distribution_report.minimum_lane_share ?? 0;
  const underSampledLanes = Object.entries(lanes)
    .filter(([lane, count]) => lane !== "archetype_register" && count / cases.length < minimumLaneShare)
    .map(([lane, count]) => ({ lane, count, share: Number((count / cases.length).toFixed(4)) }));
  return {
    cases: cases.length,
    under_sampled_threshold: threshold,
    minimum_lane_share: minimumLaneShare,
    total_value_slots: context.axes.reduce((total, axis) => total + axis.values.length, 0),
    dimensions,
    under_sampled: underSampled,
    strata,
    lane_coverage: lanes,
    under_sampled_lanes: underSampledLanes,
    support_class_distribution: supportClasses,
    early_stop_distribution: earlyStops,
  };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

export const PROPERTIES = Object.freeze([
  {
    id: "envelope_verdicts_complete",
    statement: "Every declared envelope dimension receives a verdict in one of the four declared support classes, from intake facts alone.",
  },
  {
    id: "support_class_is_worst_of_dimensions",
    statement: "The case's support class is the worst dimension verdict, independently recomputed from the envelope table.",
  },
  {
    id: "unsupported_early_stops_typed",
    statement: "A case outside the support envelope early-stops with a typed reason code and the UNSUPPORTED_PROFILE terminal, and that outcome is a PASS.",
  },
  {
    id: "early_stop_reason_is_registered",
    statement: "An early-stop reason code resolves through the declared PROFILE mirror to a registered terminal reason code.",
  },
  {
    id: "early_stop_terminal_is_legal",
    statement: "An early-stopped case's terminal state is legal for its support class under the envelope's terminal-state mapping.",
  },
  {
    id: "early_stop_precedes_expensive_work",
    statement: "An early-stopped case never has its instrument register compiled — the stop happens before expensive processing.",
  },
  {
    id: "declared_absence_never_becomes_number",
    statement: "A declared value that carries no number — missing, nil, blank, whitespace-only, boolean, array, object or unparseable text — never reads as a numeric typed state: it never becomes zero and never becomes any other number.",
  },
  {
    id: "absent_declared_balance_never_selected",
    statement: "An instrument whose declared opening balance carries no number is never selected into the opening register with a numeric balance; it is registered not-selected with a typed reason.",
  },
  {
    id: "not_selected_reason_is_registered",
    statement: "Every not-selected opening candidate carries one of the declared not-selected reasons, never an untyped drop.",
  },
  {
    id: "translation_authority_absent_is_refused",
    statement: "An instrument that requires translation — foreign currency on a native_principal basis — with no declared FX authority is refused typed, never translated at an implied rate. A reporting-currency carrying value needs no rate and is out of scope.",
  },
  {
    id: "internal_reason_never_action_required",
    statement: "A reason code owned by an internal layer never admits the user-owned ACTION_REQUIRED terminal.",
  },
  {
    id: "refusal_reason_is_registered",
    statement: "The refusal the case is under pressure to reach is a registered terminal reason code with a declared owner and terminal states.",
  },
  {
    id: "refusal_terminal_legal_for_support_class",
    statement: "The refusal's registered terminal states intersect the terminals the envelope declares legal for the case's support class.",
  },
  {
    id: "certified_release_promise_holds",
    statement: "For a CERTIFIED or SUPPORTED_DEGRADED case, no internal compiler-owned reason code may produce ACTION_REQUIRED, SOURCE_REQUIRED or UNSUPPORTED_PROFILE — the release promise the envelope makes for those classes.",
  },
  {
    id: "degraded_class_names_its_dimensions",
    statement: "A SUPPORTED_DEGRADED case names at least one degraded dimension so the workbook disclosure has something to disclose.",
  },
  {
    id: "shrink_proof_oracle",
    statement: "Synthetic oracle used only to prove the shrinker reduces and preserves a failure signature; it is never a product claim.",
  },
]);

const CLASS_RANK = { UNSUPPORTED: 0, EXPERIMENTAL: 1, SUPPORTED_DEGRADED: 2, CERTIFIED: 3 };
const PROBE_THRESHOLD = 1500;

/** The signature the shrink-proof oracle raises. */
export function probeOracleSignature() {
  return "shrink_proof_oracle|instrument_above_probe_threshold";
}

function violation(list, propertyId, key, detail) {
  list.push({ property_id: propertyId, signature: `${propertyId}|${key}`, detail });
}

/**
 * Evaluate every declared property on one generated case. Returns the typed
 * violations; it never mutates the case and never adjusts a property to fit.
 */
export function evaluateCase(generated, context, { probe = false } = {}) {
  const violations = [];
  let assertions = 0;
  const envelope = context.envelope.contract;
  const support = classifySupport(envelope, generated.descriptor);

  // 1. Verdict completeness.
  for (const dimension of Object.keys(envelope.dimensions)) {
    assertions += 1;
    const verdict = support.dimension_verdicts[dimension];
    if (!verdict || !(verdict.class in CLASS_RANK)) {
      violation(violations, "envelope_verdicts_complete", dimension, `no classified verdict for ${dimension}`);
    }
  }

  // 2. Worst-of, recomputed independently from the envelope table.
  assertions += 1;
  const worst = Object.entries(support.dimension_verdicts).reduce((current, [, verdict]) => {
    return CLASS_RANK[verdict.class] < CLASS_RANK[current] ? verdict.class : current;
  }, "CERTIFIED");
  const expectedClass = support.early_stop.stopped ? "UNSUPPORTED" : worst;
  if (support.support_class !== expectedClass) {
    violation(
      violations,
      "support_class_is_worst_of_dimensions",
      `${support.support_class}_vs_${expectedClass}`,
      `classifier said ${support.support_class}; worst-of the envelope table is ${expectedClass}`,
    );
  }

  // 3-6. The early-stop lane. An UNSUPPORTED case stopping typed is a PASS: it
  // is the lawful outcome for a case outside the envelope, not a failure.
  // The violation is the reverse — UNSUPPORTED with NO typed stop, which leaves
  // UNSUPPORTED_PROFILE (the class's only legal terminal) with no reason code to
  // report. One violation per responsible dimension, so each uncovered
  // UNSUPPORTED value is pinned and shrunk separately.
  if (support.support_class === "UNSUPPORTED" && !support.early_stop.stopped) {
    for (const [dimension, verdict] of Object.entries(support.dimension_verdicts)) {
      if (verdict.class !== "UNSUPPORTED") continue;
      assertions += 1;
      violation(
        violations,
        "unsupported_early_stops_typed",
        `${dimension}=${verdict.value}`,
        `${dimension}=${verdict.value} classifies UNSUPPORTED but no early-stop predicate covers it, ` +
          "so the case carries no typed reason code for its only legal terminal UNSUPPORTED_PROFILE",
      );
    }
  }
  if (support.early_stop.stopped) {
    assertions += 3;
    const registered = resolveRegisteredReasonCode(support.early_stop.reason_code, context);
    if (!registered) {
      violation(
        violations,
        "early_stop_reason_is_registered",
        support.early_stop.reason_code,
        `${support.early_stop.reason_code} is not a registered terminal reason code`,
      );
    }
    const legal = envelope.terminal_state_mapping[support.support_class]?.legal_terminals ?? [];
    if (!legal.includes(support.early_stop.terminal_state)) {
      violation(
        violations,
        "early_stop_terminal_is_legal",
        `${support.support_class}|${support.early_stop.terminal_state}`,
        `${support.early_stop.terminal_state} is not legal for ${support.support_class}`,
      );
    }
    if (generated.expensive_processing_permitted !== false) {
      violation(
        violations,
        "early_stop_precedes_expensive_work",
        "processing_permitted_after_stop",
        "an early-stopped case still permits expensive processing; the stop must be structural, not advisory",
      );
    }
  }

  // 7. NEVER-ZERO on the typed reading of each declared value. Pure oracle.
  for (const instrument of generated.model_case.instruments) {
    assertions += 1;
    const raw = instrument.opening_balance;
    if (!carriesNoNumber(raw)) continue;
    const typed = typedDeclaredAmount(raw);
    if (typed.state === "reported_zero" || typed.state === "reported_number") {
      violation(
        violations,
        "declared_absence_never_becomes_number",
        `${describeRaw(raw)}_became_${typed.state}`,
        `declared opening balance ${describeRaw(raw)} is not a number but typed as ${typed.state} with value ${typed.value}`,
      );
    }
  }

  // 8-10. The compiled register — only for cases the envelope did not stop.
  // The gate is the same fact the case carries, so a stopped case genuinely
  // never reaches the compiler here either.
  let compiled = false;
  if (
    generated.expensive_processing_permitted === true &&
    !support.early_stop.stopped &&
    generated.model_case.instruments.length > 0
  ) {
    compiled = true;
    let state;
    try {
      state = compileOpeningInstrumentState(generated.model_case);
    } catch (error) {
      // A throw out of the opening compiler is itself an untyped drop: the
      // compiler's contract is a typed register, not an exception.
      violation(
        violations,
        "not_selected_reason_is_registered",
        "compiler_threw",
        `opening compiler threw instead of registering a typed rejection: ${String(error?.message ?? error)}`,
      );
      state = null;
    }
    if (state) {
      assertions += 3;
      const selected = new Map(state.rows.map((row) => [row.instrument_id, row]));
      for (const instrument of generated.model_case.instruments) {
        const raw = instrument.opening_balance;
        if (!carriesNoNumber(raw)) continue;
        const row = selected.get(instrument.instrument_id);
        if (row) {
          violation(
            violations,
            "absent_declared_balance_never_selected",
            `${describeRaw(raw)}_selected`,
            `${instrument.instrument_id} declared ${describeRaw(raw)} yet was selected with ` +
              `basis ${JSON.stringify(row.opening_balance ?? row.basis_amount ?? row.reporting_amount)}`,
          );
        }
      }
      for (const entry of state.source_inventory?.not_selected ?? []) {
        if (!context.notSelectedReasons.has(entry.reason)) {
          violation(
            violations,
            "not_selected_reason_is_registered",
            entry.reason,
            `${entry.instrument_id} was registered not-selected for undeclared reason ${entry.reason}`,
          );
        }
      }
      if (generated.axes.currency_mix === "foreign_with_absent_fx") {
        // Only an instrument that actually REQUIRES translation is in scope. A
        // foreign-currency instrument declared on a reporting_currency_carrying_value
        // basis is already stated in the reporting currency and needs no rate, so
        // selecting it without FX assumptions is lawful, not a coercion.
        const reportingCurrency = generated.model_case.issuer.reporting_currency;
        const needsTranslation = generated.model_case.instruments.filter(
          (item) =>
            item.currency !== reportingCurrency &&
            (item.balance_basis ?? "native_principal") === "native_principal",
        );
        const registeredIds = new Set(
          (state.source_inventory?.not_selected ?? []).map((entry) => entry.instrument_id),
        );
        for (const instrument of needsTranslation) {
          if (selected.has(instrument.instrument_id) && !registeredIds.has(instrument.instrument_id)) {
            violation(
              violations,
              "translation_authority_absent_is_refused",
              `${instrument.currency}_translated_without_authority`,
              `${instrument.instrument_id} in ${instrument.currency} was selected with no declared FX authority`,
            );
          }
        }
      }
    }
  }

  // 11-13. The refusal lane, against the terminal reason registry. An
  // UNSUPPORTED case never reaches a downstream refusal — the envelope stops it
  // at preflight — so the lane is evaluated only for cases that proceed.
  const reasonCode = support.support_class === "UNSUPPORTED" ? null : generated.refusal_reason_code;
  if (reasonCode) {
    assertions += 3;
    const reason = context.reasonCodes[reasonCode];
    if (!reason) {
      violation(
        violations,
        "refusal_reason_is_registered",
        reasonCode,
        `${reasonCode} is not a registered terminal reason code`,
      );
    } else {
      if (reason.category === "internal" && (reason.allowed_terminal_states ?? []).includes("ACTION_REQUIRED")) {
        violation(
          violations,
          "internal_reason_never_action_required",
          reasonCode,
          `internal reason ${reasonCode} admits ACTION_REQUIRED, which the registry declares an illegal cause`,
        );
      }
      const legal = envelope.terminal_state_mapping[support.support_class]?.legal_terminals ?? [];
      const intersect = (reason.allowed_terminal_states ?? []).filter((state) => legal.includes(state));
      if (!intersect.length) {
        violation(
          violations,
          "refusal_terminal_legal_for_support_class",
          `${support.support_class}|${reasonCode}`,
          `${reasonCode} allows [${(reason.allowed_terminal_states ?? []).join(", ")}] but ` +
            `${support.support_class} declares legal terminals [${legal.join(", ")}] — the case has no lawful terminal`,
        );
      }
    }
  }

  // 14. The release promise the envelope makes for the two delivering classes:
  // an internal, compiler-owned condition may never surface as a user-owned or
  // contract-owned terminal.
  if (["CERTIFIED", "SUPPORTED_DEGRADED"].includes(support.support_class) && reasonCode) {
    assertions += 1;
    const reason = context.reasonCodes[reasonCode];
    const forbidden = ["ACTION_REQUIRED", "SOURCE_REQUIRED", "UNSUPPORTED_PROFILE"];
    const leaked = (reason?.allowed_terminal_states ?? []).filter((state) => forbidden.includes(state));
    if (reason?.category === "internal" && leaked.length) {
      violation(
        violations,
        "certified_release_promise_holds",
        `${support.support_class}|${reasonCode}|${leaked.join(",")}`,
        `${support.support_class} promises no internal condition produces ${forbidden.join("/")}, ` +
          `but internal reason ${reasonCode} permits ${leaked.join(", ")}`,
      );
    }
  }

  // 15. A degraded class must have something to disclose.
  if (support.support_class === "SUPPORTED_DEGRADED") {
    assertions += 1;
    if (!support.degraded_dimensions.length) {
      violation(
        violations,
        "degraded_class_names_its_dimensions",
        "no_named_dimension",
        "SUPPORTED_DEGRADED with no degraded dimension named — the disclosure would be empty",
      );
    }
  }

  // 15. The shrink-proof oracle. Off by default; it is a shrinker self-test,
  // never a claim about the product.
  if (probe) {
    assertions += 1;
    const over = generated.model_case.instruments.filter(
      (item) => typeof item.opening_balance === "number" && item.opening_balance > PROBE_THRESHOLD,
    );
    if (over.length) {
      violations.push({
        property_id: "shrink_proof_oracle",
        signature: probeOracleSignature(),
        detail: `${over.length} instrument(s) above the probe threshold ${PROBE_THRESHOLD}`,
      });
    }
  }

  return { violations, assertions, support, compiled };
}

/**
 * The exact domain of the never-zero properties: a declared value that CARRIES
 * NO NUMBER. A finite number carries one. A numeric string carries one too and
 * parsing it is lossless (the typed state keeps raw_text), so numeric text is
 * deliberately outside the domain — the law is about absence becoming a number,
 * not about text that spells a number. Everything else — missing, nil, blank,
 * whitespace-only, boolean, array, object, unparseable text — carries no number
 * and must never read as one.
 */
export function carriesNoNumber(raw) {
  if (typeof raw === "number") return !Number.isFinite(raw);
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return true;
    return !Number.isFinite(Number(trimmed));
  }
  return true;
}

function describeRaw(raw) {
  if (raw === undefined) return "missing";
  if (raw === null) return "nil";
  if (raw === "") return "reported_blank";
  if (typeof raw === "string" && raw.trim() === "") return "whitespace_only";
  if (typeof raw === "boolean") return `boolean_${raw}`;
  if (Array.isArray(raw)) return raw.length === 0 ? "empty_array" : "array";
  if (typeof raw === "object") return "object";
  return `text_${String(raw)}`;
}

/**
 * Resolve an early-stop reason code against the registry through the declared
 * mirror (the envelope emits UNSUPPORTED_PROFILE.x; the registry registers
 * PROFILE.x — run_terminal_reason_registry_tests pins that mirror).
 */
export function resolveRegisteredReasonCode(reasonCode, context) {
  if (!reasonCode) return null;
  if (context.reasonCodes[reasonCode]) return reasonCode;
  const mirrored = reasonCode.replace(/^UNSUPPORTED_PROFILE\./, "PROFILE.");
  return context.reasonCodes[mirrored] ? mirrored : null;
}

/**
 * The closed reason-code x support-class table. Reported so a corner where a
 * registered reason has no lawful terminal under any support class is visible
 * rather than discovered case by case.
 */
export function reasonTerminalClosureTable(context) {
  const mapping = context.envelope.contract.terminal_state_mapping;
  const rows = Object.entries(context.reasonCodes).map(([reasonCode, reason]) => {
    const legalIn = Object.entries(mapping)
      .filter(([, spec]) => (reason.allowed_terminal_states ?? []).some((state) => spec.legal_terminals.includes(state)))
      .map(([supportClass]) => supportClass);
    return {
      reason_code: reasonCode,
      category: reason.category,
      allowed_terminal_states: reason.allowed_terminal_states ?? [],
      legal_in_classes: legalIn,
      unlawful_in_classes: Object.keys(mapping).filter((supportClass) => !legalIn.includes(supportClass)),
    };
  });
  return { rows, support_classes: Object.keys(mapping) };
}

// ---------------------------------------------------------------------------
// Shrinker
// ---------------------------------------------------------------------------

function stillFails(candidate, signature, context, probe) {
  const verdict = evaluateCase(candidate, context, { probe });
  return verdict.violations.some((item) => item.signature === signature);
}

/**
 * Bisect one instrument's declared magnitude downward to the smallest value that
 * still reproduces the failure. The invariant of the search is that `high`
 * always reproduces, so the returned case always reproduces by construction.
 */
function bisectMagnitude(subject, index, signature, context, probe) {
  const instrument = subject.model_case.instruments[index];
  if (typeof instrument?.opening_balance !== "number") return null;
  let low = 0;
  let high = instrument.opening_balance;
  if (!(high > 0.1)) return null;
  let best = null;
  for (let iteration = 0; iteration < 24 && high - low > 0.05; iteration += 1) {
    const mid = Math.round(((low + high) / 2) * 10) / 10;
    if (mid >= high || mid <= low) break;
    const candidate = withInstrumentValue(subject, index, mid);
    if (stillFails(candidate, signature, context, probe)) {
      high = mid;
      best = candidate;
    } else {
      low = mid;
    }
  }
  return best;
}

function withInstrumentValue(item, index, value) {
  const instruments = item.model_case.instruments.map((instrument, position) =>
    position === index ? { ...instrument, opening_balance: value } : instrument,
  );
  return withInstruments(item, instruments);
}

function reseal(candidate) {
  const { canonical_json: _ignoredJson, sha256: _ignoredDigest, ...body } = candidate;
  const canonical = canonicalJson(body);
  return { ...body, canonical_json: canonical, sha256: sha256(canonical) };
}

/**
 * Reduce a failing case while the failure signature persists, and report the
 * minimal reproduction. Operators run worst-first (drop the most structure
 * first) and each accepted step records that the signature was preserved, so a
 * shrink that silently changed the failure is impossible to accept.
 */
export function shrinkCase(generated, signature, context, { probe = false, maxSteps = 400 } = {}) {
  if (!generated) throw new Error("shrinkCase needs the failing case");
  let current = generated;
  const steps = [];
  // Axes the model case is DERIVED from cannot be reset without rebuilding the
  // case, and rebuilding would undo the structural reduction. Resetting them
  // anyway would leave a minimal case whose axes lie about its own contents, so
  // they are declared model-shaping and excluded from the reset operators.
  const modelShaping = new Set(context.space.contract.shrink_proof.model_shaping_axes ?? []);
  const conditional = context.space.contract.shrink_proof.conditional_model_shaping ?? {};
  const resetBlocked = (dimension, currentValue) =>
    modelShaping.has(dimension) || (conditional[dimension] ?? []).includes(currentValue);
  if (!stillFails(current, signature, context, probe)) {
    return {
      minimal: current,
      steps,
      shrunk: false,
      reason: "signature_absent_from_subject",
      summary: summariseCase(current),
    };
  }
  const operators = [
    // Halve the instrument register, then peel single instruments.
    ...[0.5, 0.5, 0.5, 0.5].map((fraction, index) => ({
      name: `halve_instruments_${index + 1}`,
      apply: (item) => {
        const keep = Math.max(1, Math.floor(item.model_case.instruments.length * fraction));
        if (keep === item.model_case.instruments.length) return null;
        return withInstruments(item, item.model_case.instruments.slice(0, keep));
      },
    })),
    {
      name: "drop_each_instrument",
      each: (item) =>
        item.model_case.instruments.map((_, index) => ({
          name: `drop_instrument_${index}`,
          apply: (subject) =>
            subject.model_case.instruments.length <= 1
              ? null
              : withInstruments(
                  subject,
                  subject.model_case.instruments.filter((__, position) => position !== index),
                ),
        })),
    },
    {
      name: "drop_trailing_forecast_period",
      apply: (item) => {
        const periods = item.model_case.periods;
        const forecast = periods.filter((period) => period.status === "forecast");
        if (forecast.length <= 1) return null;
        return withPeriods(item, periods.slice(0, periods.length - 1));
      },
      repeat: true,
    },
    {
      name: "drop_leading_historical_period",
      apply: (item) => {
        const periods = item.model_case.periods;
        const historical = periods.filter((period) => period.status === "historical");
        if (historical.length <= 1) return null;
        return withPeriods(item, periods.slice(1));
      },
      repeat: true,
    },
    {
      name: "simplify_instrument_magnitudes",
      apply: (item) => {
        const simplified = item.model_case.instruments.map((instrument) => {
          if (typeof instrument.opening_balance !== "number") return instrument;
          const reduced = Math.round(instrument.opening_balance);
          if (reduced === instrument.opening_balance) return instrument;
          return { ...instrument, opening_balance: reduced };
        });
        if (canonicalJson(simplified) === canonicalJson(item.model_case.instruments)) return null;
        return withInstruments(item, simplified);
      },
    },
    {
      // Bisect each numeric magnitude downward to the smallest value that still
      // reproduces. Bisection carries no knowledge of any oracle's threshold, so
      // the operator stays honest when the properties change.
      name: "bisect_instrument_magnitudes",
      each: (item) =>
        item.model_case.instruments.map((_, index) => ({
          name: `bisect_instrument_magnitude_${index}`,
          apply: (subject) => bisectMagnitude(subject, index, signature, context, probe),
        })),
    },
    {
      name: "reset_generator_axes_to_baseline",
      each: () =>
        Object.keys(context.space.contract.generator_dimensions)
          .filter((dimension) => !modelShaping.has(dimension))
          .map((dimension) => ({
            name: `reset_axis_${dimension}`,
            apply: (subject) => {
              const baseline = context.space.contract.shrink_proof.axis_baseline[dimension];
              if (baseline === undefined || subject.axes[dimension] === baseline) return null;
              const axes = { ...subject.axes, [dimension]: baseline };
              const descriptor = descriptorFromAxes(context, axes);
              const support = classifySupport(context.envelope.contract, descriptor);
              return reseal({
                ...subject,
                axes,
                descriptor,
                support_class: support.support_class,
                early_stop: support.early_stop,
                expensive_processing_permitted: !support.early_stop.stopped,
                degraded_dimensions: support.degraded_dimensions,
                legal_terminals: support.legal_terminals,
                refusal_pressure: axes.refusal_pressure,
                refusal_reason_code: REFUSAL_PRESSURE_REASON[axes.refusal_pressure] ?? null,
              });
            },
          })),
    },
    {
      name: "reset_envelope_axes_to_certified_baseline",
      each: (item) =>
        Object.keys(context.envelope.contract.dimensions)
          .filter((dimension) => !resetBlocked(dimension, item.axes[dimension]))
          .map((dimension) => ({
          name: `reset_envelope_${dimension}`,
          apply: (subject) => {
            const baseline = context.space.contract.certified_baseline[dimension];
            if (baseline === undefined || subject.axes[dimension] === baseline) return null;
            if (resetBlocked(dimension, subject.axes[dimension])) return null;
            const axes = { ...subject.axes, [dimension]: baseline };
            const descriptor = descriptorFromAxes(context, axes);
            const support = classifySupport(context.envelope.contract, descriptor);
            return reseal({
              ...subject,
              axes,
              descriptor,
              support_class: support.support_class,
              early_stop: support.early_stop,
              expensive_processing_permitted: !support.early_stop.stopped,
              degraded_dimensions: support.degraded_dimensions,
              legal_terminals: support.legal_terminals,
            });
          },
        })),
    },
  ];

  let budget = maxSteps;
  let progressed = true;
  while (progressed && budget > 0) {
    progressed = false;
    for (const operator of operators) {
      const candidates = operator.each ? operator.each(current) : [operator];
      for (const candidateOperator of candidates) {
        let keepGoing = true;
        while (keepGoing && budget > 0) {
          keepGoing = false;
          budget -= 1;
          const reduced = candidateOperator.apply(current);
          if (!reduced) break;
          if (!stillFails(reduced, signature, context, probe)) break;
          steps.push({
            operator: candidateOperator.name,
            instruments: reduced.model_case.instruments.length,
            periods: reduced.model_case.periods.length,
            signature_preserved: true,
          });
          current = reduced;
          progressed = true;
          keepGoing = Boolean(candidateOperator.repeat ?? operator.repeat);
        }
      }
    }
  }
  return { minimal: current, steps, shrunk: steps.length > 0, reason: null, summary: summariseCase(current) };
}

function withInstruments(item, instruments) {
  return reseal({ ...item, model_case: { ...item.model_case, instruments } });
}

function withPeriods(item, periods) {
  const forecastCount = periods.filter((period) => period.status === "forecast").length;
  const instruments = item.model_case.instruments.map((instrument) => ({
    ...instrument,
    scheduled_amortisation: Array(forecastCount).fill(0),
    new_issuance: Array(forecastCount).fill(0),
    coupon_or_all_in_rate: Array(forecastCount).fill(instrument.coupon_or_all_in_rate?.[0] ?? 0.05),
    benchmark_rate: Array(forecastCount).fill(instrument.benchmark_rate?.[0] ?? 0),
    other_non_cash_movement: Array(forecastCount).fill(0),
  }));
  const modelCase = { ...item.model_case, periods, instruments };
  if (modelCase.fx) {
    modelCase.fx = Object.fromEntries(
      Object.entries(modelCase.fx).map(([currency, rates]) => [
        currency,
        {
          ...rates,
          average_rates: periods.map(() => rates.average_rates?.[0] ?? 1.1),
          period_end_rates: periods.map(() => rates.period_end_rates?.[0] ?? 1.09),
        },
      ]),
    );
  }
  return reseal({ ...item, model_case: modelCase });
}

/** The minimal reproduction, small enough to paste into an issue card. */
export function summariseCase(generated) {
  return {
    seed: generated.seed,
    sha256: generated.sha256,
    support_class: generated.support_class,
    early_stop: generated.early_stop?.reason_code ?? null,
    refusal_reason_code: generated.refusal_reason_code,
    instruments: generated.model_case.instruments.length,
    periods: generated.model_case.periods.length,
    declared_opening_balances: generated.model_case.instruments.map((item) => item.opening_balance),
    axes: generated.axes,
  };
}
