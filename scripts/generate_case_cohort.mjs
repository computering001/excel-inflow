#!/usr/bin/env node
/**
 * P7.3 — Generated-case cohort CLI.
 *
 * Volume is a PARAMETER, not a constant:
 *   node scripts/generate_case_cohort.mjs --tier pr
 *   node scripts/generate_case_cohort.mjs --count 25000 --seed 7730000
 *   node scripts/generate_case_cohort.mjs --tier nightly --out /tmp/cohort.json --report /tmp/dist.json
 *
 * Maintenance modes:
 *   --emit-space            re-derive assets/generated-case-dimension-space-v1.json from the
 *                           support envelope (the ONLY way that file should change)
 *   --update-seed-registry  regenerate ci/generated_case_seeds.json from a discovery sweep
 *
 * The seed registry is GENERATED, never hand-written: it records the seeds whose
 * cases violated a property, each with its failure signature, its shrunk minimal
 * reproduction and the case digest that makes it replayable by seed alone. Every
 * entry declares a PROVENANCE: a real product-property violation, or the
 * synthetic shrink-proof oracle that keeps the persist/replay/shrink mechanism
 * proved on the day no real defect is left to prove it with (P7.3a). A synthetic
 * entry is never a product claim and is never counted as a violation.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadSupportEnvelope } from "./lib/support_envelope.mjs";
import {
  CASE_GENERATOR_VERSION,
  PROPERTIES,
  UNKNOWN_VALUE,
  buildGeneratorContext,
  distributionReport,
  evaluateCase,
  generateCase,
  generateCohort,
  loadArchetypeSeedShapes,
  loadDimensionSpace,
  probeOracleSignature,
  reasonTerminalClosureTable,
  shrinkCase,
  spaceSize,
} from "./lib/case_generator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SPACE_PATH = path.join(ROOT, "assets", "generated-case-dimension-space-v1.json");
const SEED_REGISTRY_PATH = path.join(ROOT, "ci", "generated_case_seeds.json");

const DEFAULT_ROOT_SEED = 7730000;

/**
 * The generator-owned axes. These are NOT support-envelope claims: they are the
 * construction pathologies a real ingress produces (a model-host JSON payload, a
 * broker-pack cell, an XBRL fact with an empty value) plus the intake facts the
 * envelope's early-stop predicates read outside the dimension table.
 */
const GENERATOR_DIMENSIONS = {
  identity_verdict: {
    statement: "Intake identity resolution verdict, read by the irreconcilable_entity_perimeter early-stop predicate.",
    values: ["unstated", "match", "reconciled_by_identifier_tier", "mismatch"],
  },
  declared_language_adapter: {
    statement: "Whether a versioned language adapter is declared, read by the unadapted_language early-stop predicate.",
    values: ["absent", "declared"],
  },
  declared_value_pathology: {
    statement:
      "The typed state of the first instrument's declared opening balance. Every non-number here is a NEVER-ZERO probe: missing, nil, blank, whitespace, boolean and empty-array raws must never become numbers.",
    values: [
      "well_formed",
      "nil",
      "reported_blank",
      "whitespace_only",
      "boolean_false",
      "boolean_true",
      "empty_array",
      "non_numeric_text",
      "numeric_text",
      "negative",
    ],
  },
  instrument_book: {
    statement: "Size of the declared instrument register.",
    values: ["none", "single", "small_book", "large_book"],
  },
  historical_periods_declared: {
    statement: "How many historical periods the case actually carries, independent of the envelope's period claim.",
    values: ["one", "two", "three", "five"],
  },
  currency_mix: {
    statement: "Whether foreign-currency instruments appear and whether a translation authority is declared for them.",
    values: ["reporting_only", "foreign_with_declared_fx", "foreign_with_absent_fx"],
  },
  refusal_pressure: {
    statement: "Which lawful refusal category the case is under pressure to reach; the reason code always comes from the terminal reason registry.",
    values: [
      "none",
      "source_identity_unresolved",
      "source_opening_debt_unresolved",
      "internal_equation_unsolved",
      "internal_forecast_ownership_blocked",
      "internal_runtime_budget_overrun",
      "user_material_economic_choice",
      "degraded_broker_unavailable",
    ],
  },
};

const TIERS = { ci_default: 300, pr: 2500, nightly: 10000, weekly: 25000 };

/**
 * The dispositioned defect set. A signature listed here is a KNOWN OPEN DEFECT:
 * the property still fires, the seed is still persisted and replayed, and the
 * suite prints it every run. It is NOT accepted behaviour and it is NOT a
 * loosened property — it is a defect with an owner and a pointer.
 *
 * P7.3a: the set is EMPTY, and that is a result rather than a default. All
 * fifteen signatures it carried were REPAIRED at their earliest responsible
 * layer and then verified not to reproduce — none of the fifteen fires on its own
 * pinned seed and none fires anywhere in a 25,000-seed sweep. The suite's own
 * doctrine ("a pin that stops reproducing fails the suite so it must be retired
 * rather than left standing") therefore required their retirement: a pin kept
 * past its repair documents a defect that no longer exists, which is a false
 * claim in the opposite direction. The retirement record below names each one and
 * the commit that repaired it, so nothing is lost by the list being empty; the
 * undeclared-signature path in bindDispositionSeeds() and the new-defect path in
 * the suite are untouched, so the next real defect still fails the suite loudly.
 */
const DISPOSITIONED_DEFECTS = [];

/**
 * Signatures retired because the DEFECT WAS REPAIRED, never because the pin was
 * inconvenient. Each row names the property, the layer that was repaired and the
 * commit that repaired it. This is documentation carried in the generated space
 * so a reader of the asset can see why the dispositioned set is empty; nothing
 * reads it as a control input, and re-appearance of any signature below is a
 * NEW_UNDISPOSITIONED defect that fails the suite exactly like any other.
 */
const RETIRED_DISPOSITIONS = [
  {
    signature: "declared_absence_never_becomes_number|whitespace_only_became_reported_zero",
    property_id: "declared_absence_never_becomes_number",
    repaired_layer: "scripts/lib/opening_instrument_provenance.mjs typedDeclaredAmount",
    repaired_by: "P4.1a (defects D11+D12) at 3cd9f97 — a whitespace-only string classifies reported_blank before any Number() coercion",
    retired_by: "P7.3a",
  },
  {
    signature: "declared_absence_never_becomes_number|boolean_false_became_reported_zero",
    property_id: "declared_absence_never_becomes_number",
    repaired_layer: "scripts/lib/opening_instrument_provenance.mjs typedDeclaredAmount",
    repaired_by: "P4.1a (defects D11+D12) at 3cd9f97 — a non-number, non-string raw classifies parse_failure with its real raw text",
    retired_by: "P7.3a",
  },
  {
    signature: "declared_absence_never_becomes_number|boolean_true_became_reported_number",
    property_id: "declared_absence_never_becomes_number",
    repaired_layer: "scripts/lib/opening_instrument_provenance.mjs typedDeclaredAmount",
    repaired_by: "P4.1a (defects D11+D12) at 3cd9f97 — same repair as boolean_false, on the non-zero side",
    retired_by: "P7.3a",
  },
  {
    signature: "declared_absence_never_becomes_number|empty_array_became_reported_zero",
    property_id: "declared_absence_never_becomes_number",
    repaired_layer: "scripts/lib/opening_instrument_provenance.mjs typedDeclaredAmount",
    repaired_by: "P4.1a (defects D11+D12) at 3cd9f97 — an array raw classifies parse_failure, never reported_zero",
    retired_by: "P7.3a",
  },
  {
    signature: "absent_declared_balance_never_selected|whitespace_only_selected",
    property_id: "absent_declared_balance_never_selected",
    repaired_layer: "scripts/lib/instrument_period_state.mjs compileOpeningInstrumentState",
    repaired_by: "P4.1a (defects D11+D12) at 3cd9f97 — selection gates on 'the typed state is not a number' rather than an allow-list of two absence states",
    retired_by: "P7.3a",
  },
  {
    signature: "absent_declared_balance_never_selected|boolean_false_selected",
    property_id: "absent_declared_balance_never_selected",
    repaired_layer: "scripts/lib/instrument_period_state.mjs compileOpeningInstrumentState",
    repaired_by: "P4.1a (defects D11+D12) at 3cd9f97 — same repair as whitespace_only",
    retired_by: "P7.3a",
  },
  {
    signature: "absent_declared_balance_never_selected|boolean_true_selected",
    property_id: "absent_declared_balance_never_selected",
    repaired_layer: "scripts/lib/instrument_period_state.mjs compileOpeningInstrumentState",
    repaired_by: "P4.1a (defects D11+D12) at 3cd9f97 — same repair as whitespace_only",
    retired_by: "P7.3a",
  },
  {
    signature: "absent_declared_balance_never_selected|empty_array_selected",
    property_id: "absent_declared_balance_never_selected",
    repaired_layer: "scripts/lib/instrument_period_state.mjs compileOpeningInstrumentState",
    repaired_by: "P4.1a (defects D11+D12) at 3cd9f97 — same repair as whitespace_only",
    retired_by: "P7.3a",
  },
  {
    signature: "unsupported_early_stops_typed|accounting_framework=other_or_unknown",
    property_id: "unsupported_early_stops_typed",
    repaired_layer: "assets/support-envelope-v377.json early_stop_predicates",
    repaired_by: "P2.11 (defects D13+D14) at 5b6f31b — unsupported_accounting_framework_stop fires on the dimension VERDICT, with a registered UNSUPPORTED_PROFILE reason code",
    retired_by: "P7.3a",
  },
  {
    signature: "unsupported_early_stops_typed|accounting_framework=unknown",
    property_id: "unsupported_early_stops_typed",
    repaired_layer: "assets/support-envelope-v377.json early_stop_predicates",
    repaired_by: "P2.11 (defects D13+D14) at 5b6f31b — the same predicate covers an unstated framework taking its declared unknown_value_class",
    retired_by: "P7.3a",
  },
  {
    signature: "unsupported_early_stops_typed|historical_periods=unknown",
    property_id: "unsupported_early_stops_typed",
    repaired_layer: "assets/support-envelope-v377.json insufficient_history_stop",
    repaired_by: "P2.11 (defects D13+D14) at 5b6f31b — the rule keys on the UNSUPPORTED verdict, not the literal fewer_than_two value",
    retired_by: "P7.3a",
  },
  {
    signature: "unsupported_early_stops_typed|filing_language_format=non_english",
    property_id: "unsupported_early_stops_typed",
    repaired_layer: "assets/support-envelope-v377.json filing_language_format.conditional_class_lift",
    repaired_by: "P2.11 (defects D13+D14) at 5b6f31b — a declared language adapter now lifts the VERDICT to EXPERIMENTAL, not only suppresses the stop; absent the adapter the value stays UNSUPPORTED and the stop fires",
    retired_by: "P7.3a",
  },
  {
    signature: "refusal_terminal_legal_for_support_class|EXPERIMENTAL|SOURCE.issuer_or_reporting_period_unresolved",
    property_id: "refusal_terminal_legal_for_support_class",
    repaired_layer: "assets/support-envelope-v377.json terminal_state_mapping.EXPERIMENTAL",
    repaired_by: "P2.11 (defects D13+D14) at 5b6f31b — EXPERIMENTAL admits SOURCE_REQUIRED and ACTION_REQUIRED, the user-owned terminals a continuing run can genuinely reach; DELIVERED_VERIFIED stays unlawful there",
    retired_by: "P7.3a",
  },
  {
    signature: "refusal_terminal_legal_for_support_class|EXPERIMENTAL|SOURCE.opening_debt_unresolved",
    property_id: "refusal_terminal_legal_for_support_class",
    repaired_layer: "assets/support-envelope-v377.json terminal_state_mapping.EXPERIMENTAL",
    repaired_by: "P2.11 (defects D13+D14) at 5b6f31b — as above",
    retired_by: "P7.3a",
  },
  {
    signature: "refusal_terminal_legal_for_support_class|EXPERIMENTAL|USER.material_economic_choice",
    property_id: "refusal_terminal_legal_for_support_class",
    repaired_layer: "assets/support-envelope-v377.json terminal_state_mapping.EXPERIMENTAL",
    repaired_by: "P2.11 (defects D13+D14) at 5b6f31b — as above",
    retired_by: "P7.3a",
  },
];

/**
 * The two provenances a persisted seed can carry.
 *
 * `product_property` — a real violation of a declared product property, found by
 * the sweep. This is what the registry exists to persist.
 *
 * `synthetic_mechanism_proof` — the shrink-proof oracle (an instrument above a
 * probe threshold), which is NOT a product claim and never has been. It is
 * persisted so the registry keeps proving that a failing seed can be recorded,
 * replayed byte-identically and shrunk EVEN WHEN THE PRODUCT SECTION IS EMPTY.
 * Without it, the day every real defect is repaired is the day the persistence
 * and replay machinery stops being exercised at all — and the only ways to keep a
 * bare counter satisfied would be to invent a product defect (a lie) or delete
 * the counter (losing the proof). The synthetic entry is drawn from the same
 * sweep, replayed by the same seed-only path and shrunk by the same shrinker as a
 * product entry, so the mechanism it proves is the identical mechanism.
 */
const PRODUCT_PROVENANCE = "product_property";
const SYNTHETIC_PROVENANCE = "synthetic_mechanism_proof";

const CERTIFIED_BASELINE = {
  accounting_framework: "ifrs",
  entity_type: "non_financial_corporate",
  filing_language_format: "english_text_pdf",
  historical_periods: "three_or_more",
  statement_topology: "standard_three_statement",
  cash_flow_method: "indirect",
  fiscal_calendar: "fixed_date",
  debt_instruments: "within_declared_matrix",
  broker_availability: "broker_pack_present",
  acquisition_overlay: "none",
  restructuring_complexity: "none",
};

/**
 * Axes the model case is DERIVED from. The shrinker never resets these: doing so
 * without rebuilding the case would leave a minimal reproduction whose recorded
 * axes contradict its own instrument register and period list.
 */
const MODEL_SHAPING_AXES = [
  "declared_value_pathology",
  "instrument_book",
  "historical_periods_declared",
  "currency_mix",
  "fiscal_calendar",
  "debt_instruments",
];

/**
 * Axes that shape the model case only at particular values. historical_periods
 * changes the period list only through its fewer_than_two branch, so it may be
 * reset from any other value — which lets a minimal reproduction reach the
 * certified baseline instead of stalling on an unrelated UNSUPPORTED verdict.
 */
const CONDITIONAL_MODEL_SHAPING = { historical_periods: ["fewer_than_two"] };

const AXIS_BASELINE = {
  identity_verdict: "unstated",
  declared_language_adapter: "absent",
  declared_value_pathology: "well_formed",
  instrument_book: "single",
  historical_periods_declared: "three",
  currency_mix: "reporting_only",
  refusal_pressure: "none",
};

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArgs(argv) {
  const options = {
    tier: null,
    count: null,
    seed: null,
    out: null,
    report: null,
    emitSpace: false,
    updateSeedRegistry: false,
    discovery: null,
    seedShapes: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--tier") options.tier = argv[++index];
    else if (token === "--count") options.count = Number(argv[++index]);
    else if (token === "--seed") options.seed = Number(argv[++index]);
    else if (token === "--out") options.out = path.resolve(argv[++index]);
    else if (token === "--report") options.report = path.resolve(argv[++index]);
    else if (token === "--emit-space") options.emitSpace = true;
    else if (token === "--update-seed-registry") options.updateSeedRegistry = true;
    else if (token === "--discovery-count") options.discovery = Number(argv[++index]);
    else if (token === "--seed-shapes") options.seedShapes = true;
    else throw new Error(`Unrecognised argument ${token}.`);
  }
  return options;
}

/**
 * Re-derive the declared space from the live support envelope. The envelope
 * dimension values are MIRRORED, never authored: the generator refuses to run if
 * the mirror and the envelope diverge, so this is the only lawful way the asset
 * changes.
 */
function emitDimensionSpace() {
  const envelope = loadSupportEnvelope();
  const envelopeDimensions = {};
  let declaredValueCount = 0;
  for (const [dimension, spec] of Object.entries(envelope.contract.dimensions)) {
    const values = [...Object.keys(spec.values), UNKNOWN_VALUE];
    declaredValueCount += Object.keys(spec.values).length;
    envelopeDimensions[dimension] = {
      mirrored_from: `assets/support-envelope-v377.json#/dimensions/${dimension}`,
      values,
      unknown_value_class: spec.unknown_value_class,
      value_classes: { ...spec.values, [UNKNOWN_VALUE]: spec.unknown_value_class },
    };
  }
  const contract = {
    schema_version: "excel-inflow-generated-case-dimension-space/1.0",
    space_version: "1.0.0",
    work_package: "P7.3",
    invariant:
      "Cases are GENERATED from this declared space by a seeded, reproducible generator: a seed fully determines a case, the distribution over the space is reported, a failing seed is persisted and replayable, and a failure is shrunk to a minimal reproducing case.",
    generated_by: `scripts/generate_case_cohort.mjs --emit-space (${CASE_GENERATOR_VERSION})`,
    derived_from: {
      envelope_path: "assets/support-envelope-v377.json",
      envelope_version: envelope.version,
      envelope_sha256: envelope.sha256,
      envelope_declared_value_count: declaredValueCount,
      derivation_rule:
        "Every envelope dimension is sampled over its declared values PLUS the __unknown value that exercises its unknown_value_class. No value is added to, removed from or renamed within an envelope dimension. loadDimensionSpace() re-derives this mirror at load time and returns typed DRIFT if it disagrees; the suite refuses on any drift.",
    },
    envelope_dimensions: envelopeDimensions,
    generator_dimensions: GENERATOR_DIMENSIONS,
    certified_baseline: CERTIFIED_BASELINE,
    seed_shape_mode: "off",
    seed_shape_modes: ["off", "inventory"],
    seed_shape_doctrine:
      "The archetype catalogues under test-fixtures/archetypes/ are authored by sibling packages and grow independently of this one. In mode 'off' (the registered default) the generated corpus is INDEPENDENT of them, so an archetype addition never invalidates a persisted seed. In mode 'inventory' each seed also selects an archetype case as a SEED SHAPE and varies it — the archetype's statement structure, instrument register and FX authority are carried and the axes are varied on top. The capability is asserted in both modes: the suite always drives the archetype path with an explicit inventory, and an absent directory is a typed absence rather than a crash.",
    default_root_seed: DEFAULT_ROOT_SEED,
    tiers: TIERS,
    tier_notes: {
      ci_default: "The cheap slice the registered suite runs by default; large enough to reach every declared dimension value.",
      pr: "The 2-3k volume required per pull request.",
      nightly: "The 10k volume.",
      weekly: "The 25k volume.",
    },
    stratification: {
      in_envelope_share: 0.3,
      degraded_target_share: 0.15,
      certified_target_share: 0.15,
      strata: ["in_envelope", "degraded_target", "certified_target", "unrestricted"],
      statement:
        "Uniform sampling spends most of its budget on cases the envelope stops at preflight (five of eleven entity types are financial institutions), starving the compiled-register and refusal lanes at any volume, and SUPPORTED_DEGRADED — the class that carries the workbook disclosure requirement — is almost unreachable by chance because it needs every dimension at CERTIFIED or SUPPORTED_DEGRADED with at least one degraded. in_envelope_share of seeds is therefore drawn with no UNSUPPORTED value on any axis, degraded_target_share with no UNSUPPORTED or EXPERIMENTAL value and one degradable dimension forced, and certified_target_share at CERTIFIED values only — CERTIFIED needs all eleven dimensions certified at once and was reached ZERO times in 2,500 uniform draws, which would have left the headline release promise entirely unsampled. The stratum is drawn FROM THE SEED, so determinism is untouched, and the distribution report names both the strata and the lane coverage.",
    },
    distribution_report: {
      under_sampled_threshold: 5,
      minimum_lane_share: 0.05,
      statement:
        "A dimension value seen fewer than under_sampled_threshold times in a cohort is NAMED as an under-sampled corner rather than assumed covered. Value coverage alone can hide a starved LANE, so the evaluation lanes are counted too and any lane below minimum_lane_share is named.",
    },
    shrink_proof: {
      seed: null,
      min_instruments: 9,
      expected_minimal_instruments: 1,
      axis_baseline: AXIS_BASELINE,
      model_shaping_axes: MODEL_SHAPING_AXES,
      conditional_model_shaping: CONDITIONAL_MODEL_SHAPING,
      statement:
        "The shrinker is proved against a synthetic oracle (an instrument above a probe threshold) so the proof survives the repair of every real defect below. That day has arrived: the dispositioned set is empty, and the same synthetic oracle is what keeps the shrinker proof and the seed-registry persistence/replay proof alive with nothing real left to fail on. It is never a product claim.",
    },
    properties: PROPERTIES.map((property) => ({ id: property.id, statement: property.statement })),
    dispositioned_defects: DISPOSITIONED_DEFECTS.map((entry) => ({ ...entry, seed: null, case_sha256: null })),
    disposition_doctrine:
      "A dispositioned signature is a KNOWN OPEN DEFECT, never accepted behaviour. The property still fires, the seed is still replayed, the suite prints it every run, and a pin that stops reproducing fails the suite so it must be retired rather than left standing. No property is ever loosened to make a case pass.",
    retired_dispositions: RETIRED_DISPOSITIONS,
    retirement_doctrine:
      "dispositioned_defects is EMPTY as a RESULT, not as a default: every signature it once carried was repaired at its earliest responsible layer and then verified — none reproduces on its own pinned seed and none appears anywhere in the discovery sweep. Retirement is compulsory under the disposition doctrine above, because a pin kept past its repair asserts a defect that no longer exists. retired_dispositions records what was retired and which commit repaired it. Nothing reads that list as a control input: if any signature in it reappears it is reported as NEW_UNDISPOSITIONED and fails the suite exactly like any other new defect.",
  };
  return contract;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const options = parseArgs(process.argv.slice(2));

if (options.emitSpace) {
  // Pass 1: write the space with null seeds so the generator can load it.
  const draft = emitDimensionSpace();
  if (options.seedShapes) draft.seed_shape_mode = "inventory";
  draft.shrink_proof.seed = DEFAULT_ROOT_SEED;
  fs.writeFileSync(SPACE_PATH, stableJson(draft));
  // Pass 2: bind the shrink-proof seed to a subject the oracle actually fails on
  // and bind every dispositioned defect to a real reproducing seed.
  const space = loadDimensionSpace();
  if (space.drift.length) throw new Error(`emitted space diverges from the envelope: ${space.drift.join("; ")}`);
  const context = buildGeneratorContext(space);
  const shrinkSeed = findShrinkProofSeed(context, DEFAULT_ROOT_SEED);
  draft.shrink_proof.seed = shrinkSeed;
  const bound = bindDispositionSeeds(context, draft, options.discovery ?? 4000);
  fs.writeFileSync(SPACE_PATH, stableJson(bound));
  process.stderr.write(
    `wrote ${path.relative(ROOT, SPACE_PATH)} (space_version ${bound.space_version}, shrink seed ${shrinkSeed})\n`,
  );
}

function findShrinkProofSeed(context, from) {
  for (let seed = from; seed < from + 5000; seed += 1) {
    const subject = generateCase({ seed, context, inflate: true });
    if (subject.model_case.instruments.length < 9) continue;
    const verdict = evaluateCase(subject, context, { probe: true });
    const large = subject.model_case.instruments.filter(
      (item) => typeof item.opening_balance === "number" && item.opening_balance > 1500,
    );
    if (verdict.violations.some((item) => item.property_id === "shrink_proof_oracle") && large.length >= 2) {
      return seed;
    }
  }
  throw new Error("no shrink-proof seed found in the searched range");
}

/** Discovery sweep: find the first seed that reproduces each dispositioned signature. */
function bindDispositionSeeds(context, draft, discoveryCount) {
  const found = new Map();
  const rootSeed = draft.default_root_seed;
  for (let index = 0; index < discoveryCount; index += 1) {
    const seed = rootSeed + index;
    const generated = generateCase({ seed, context });
    for (const violation of evaluateCase(generated, context).violations) {
      if (found.has(violation.signature)) continue;
      found.set(violation.signature, { seed, case_sha256: generated.sha256, detail: violation.detail });
    }
  }
  const unbound = [];
  draft.dispositioned_defects = draft.dispositioned_defects.map((entry) => {
    const hit = found.get(entry.signature);
    if (!hit) {
      unbound.push(entry.signature);
      return entry;
    }
    return { ...entry, seed: hit.seed, case_sha256: hit.case_sha256, observed_detail: hit.detail };
  });
  const undeclared = [...found.keys()].filter(
    (signature) => !draft.dispositioned_defects.some((entry) => entry.signature === signature),
  );
  if (unbound.length) {
    process.stderr.write(
      `WARNING: ${unbound.length} dispositioned signature(s) were not reproduced in the discovery sweep: ${unbound.join(", ")}\n`,
    );
  }
  if (undeclared.length) {
    process.stderr.write(
      `DEFECT FOUND (undeclared): ${undeclared.length} signature(s) with no disposition: ${undeclared.join(", ")}\n`,
    );
  }
  draft.discovery_sweep = {
    root_seed: rootSeed,
    seeds_swept: discoveryCount,
    signatures_found: found.size,
    unbound_dispositions: unbound,
    undeclared_signatures: undeclared,
    // The archetype inventory is a versioned generator input; the pinned case
    // digests above are only replayable against the inventory they were drawn on.
    seed_shape_inventory_sha256: context.seedShapeInventorySha256,
    seed_shapes_available: context.seedShapes.length,
  };
  return draft;
}

/**
 * The registry's PERSISTENCE-AND-REPLAY proof, which must survive an empty
 * product section.
 *
 * The registry's reason to exist is that a failing seed can be recorded, replayed
 * by seed alone to a byte-identical case, and shrunk to a minimal reproduction.
 * With every dispositioned defect repaired the product sweep finds nothing, so
 * with product entries alone that machinery would go unexercised — and the two
 * ways to keep a bare "at least one entry" counter satisfied would both be
 * dishonest: invent a product defect, or delete the counter and lose the proof.
 *
 * So the proof is carried by the SYNTHETIC shrink-proof oracle, the device the
 * dimension space already declares for exactly this eventuality ("so the proof
 * survives the repair of every real defect"). The entry is found in the same
 * cohort, keyed by the same signature machinery, replayed by the same seed-only
 * path and shrunk by the same shrinker as a product entry, so what it proves is
 * the identical mechanism — while its provenance and its property id both say, in
 * the artifact, that it asserts nothing about the product.
 *
 * The FIRST qualifying seed in cohort order is chosen, so the choice is
 * deterministic and restatable rather than a lucky draw.
 */
function synthesiseMechanismProof(cohort, context) {
  const signature = probeOracleSignature();
  let subject = null;
  let occurrences = 0;
  for (const generated of cohort.cases) {
    const fires = evaluateCase(generated, context, { probe: true }).violations.some(
      (violation) => violation.signature === signature,
    );
    if (!fires) continue;
    occurrences += 1;
    if (subject === null) subject = generated;
  }
  if (subject === null) {
    throw new Error(
      `the synthetic mechanism-proof oracle (${signature}) found no subject in this cohort, so the registry ` +
        "cannot prove persistence and replay. Widen the tier rather than persisting an entry the oracle does not fail on.",
    );
  }
  const detail = evaluateCase(subject, context, { probe: true }).violations.find(
    (violation) => violation.signature === signature,
  ).detail;
  const shrunk = shrinkCase(subject, signature, context, { probe: true });
  return {
    seed: subject.seed,
    case_sha256: subject.sha256,
    signature,
    property_id: "shrink_proof_oracle",
    provenance: SYNTHETIC_PROVENANCE,
    failure_detail: detail,
    occurrences_in_sweep: occurrences,
    disposition: {
      state: "SYNTHETIC_MECHANISM_PROOF",
      severity: "not_a_defect",
      owner: "generated_case_cohort_suite",
      repair_pointer: null,
    },
    not_a_product_claim:
      "The shrink-proof oracle fails on any instrument above a probe threshold. It is a self-test of the shrinker and of this registry's persist/replay path; it makes NO claim about the product and must never be read as an open defect. It is persisted so that persistence and replay stay proved on the day — now — when no real defect remains to prove them with.",
    minimal_case: shrunk.summary,
    shrink_steps: shrunk.steps.length,
    shrink_operators: shrunk.steps.map((step) => step.operator),
  };
}

if (options.updateSeedRegistry || options.out || options.report || options.tier || options.count) {
  const space = loadDimensionSpace();
  if (space.drift.length) {
    throw new Error(
      `assets/generated-case-dimension-space-v1.json diverges from the support envelope: ${space.drift.join("; ")}. ` +
        "Re-derive it with --emit-space; never edit it by hand.",
    );
  }
  const shapes = loadArchetypeSeedShapes(ROOT);
  // --seed-shapes overrides the declared mode for one run, so the deeper tiers can
  // be swept against the live archetype inventory without repinning the corpus.
  const context = buildGeneratorContext(space, options.seedShapes ? { seedShapes: shapes.shapes } : {});
  const tier = options.tier ?? "ci_default";
  const count = options.count ?? space.contract.tiers[tier];
  if (!Number.isInteger(count) || count <= 0) throw new Error(`unknown tier ${tier} and no --count`);
  const rootSeed = options.seed ?? space.contract.default_root_seed;
  const cohort = generateCohort({ count, seed: rootSeed, context });
  const distribution = distributionReport(cohort.cases, context);

  const bySignature = new Map();
  let violationCount = 0;
  for (const generated of cohort.cases) {
    for (const violation of evaluateCase(generated, context).violations) {
      violationCount += 1;
      if (bySignature.has(violation.signature)) {
        bySignature.get(violation.signature).occurrences += 1;
        continue;
      }
      bySignature.set(violation.signature, {
        signature: violation.signature,
        property_id: violation.property_id,
        seed: generated.seed,
        case_sha256: generated.sha256,
        detail: violation.detail,
        occurrences: 1,
      });
    }
  }
  const dispositions = new Map(
    (space.contract.dispositioned_defects ?? []).map((entry) => [entry.signature, entry]),
  );
  const productSeeds = [...bySignature.values()]
    .sort((left, right) => left.signature.localeCompare(right.signature))
    .map((entry) => {
      const disposition = dispositions.get(entry.signature);
      const subject = cohort.cases.find((item) => item.seed === entry.seed);
      const shrunk = shrinkCase(subject, entry.signature, context);
      return {
        seed: entry.seed,
        case_sha256: entry.case_sha256,
        signature: entry.signature,
        property_id: entry.property_id,
        provenance: PRODUCT_PROVENANCE,
        failure_detail: entry.detail,
        occurrences_in_sweep: entry.occurrences,
        disposition: disposition
          ? { state: "DISPOSITIONED_OPEN_DEFECT", severity: disposition.severity, owner: disposition.owner, repair_pointer: disposition.repair_pointer }
          : { state: "NEW_UNDISPOSITIONED", severity: "unknown", owner: "unassigned", repair_pointer: null },
        minimal_case: shrunk.summary,
        shrink_steps: shrunk.steps.length,
        shrink_operators: shrunk.steps.map((step) => step.operator),
      };
    });

  if (options.updateSeedRegistry) {
    // Computed only when the registry is being written: the probe sweep and the
    // synthetic shrink are real work, and a --tier/--out reporting run has no
    // reason to pay for them.
    const mechanismProof = synthesiseMechanismProof(cohort, context);
    const interesting = [...productSeeds, mechanismProof];
    const registry = {
      schema_version: "excel-inflow-generated-case-seed-registry/1.0",
      work_package: "P7.3",
      invariant:
        "A failing seed is PERSISTED with its failure signature and its shrunk minimal reproduction, so a regression is replayable by seed alone.",
      provenance_doctrine:
        `Every entry declares a provenance. '${PRODUCT_PROVENANCE}' is a real violation of a declared product property found by the sweep — the thing this registry exists to persist. '${SYNTHETIC_PROVENANCE}' is the shrink-proof oracle, which is NOT a product claim and never was; it is persisted so the persist/replay/shrink mechanism stays PROVED when the product section is empty, rather than that proof lapsing silently or being faked with an invented defect. The suite asserts both: at least one synthetic entry must exist and must be the declared oracle signature, and every entry — product or synthetic — must replay byte-identically AND still raise the exact signature it was persisted with.`,
      generated_by: `scripts/generate_case_cohort.mjs --update-seed-registry (${CASE_GENERATOR_VERSION})`,
      generator_version: CASE_GENERATOR_VERSION,
      dimension_space_version: space.contract.space_version,
      dimension_space_sha256: space.sha256,
      envelope_version: space.envelope.version,
      envelope_sha256: space.envelope.sha256,
      declared_space_size: spaceSize(context).toString(),
      tiers: space.contract.tiers,
      // `violations` counts PRODUCT property violations only; the synthetic
      // mechanism proof is deliberately excluded so the product count stays a
      // truthful zero and cannot be inflated by the suite's own self-test.
      discovery_sweep: {
        root_seed: rootSeed,
        cases: count,
        tier,
        violations: violationCount,
        product_signatures: bySignature.size,
        synthetic_mechanism_proofs: 1,
      },
      seed_shape_mode: context.seedShapeMode,
      seed_shape_inventory_sha256: context.seedShapeInventorySha256,
      archetype_seed_shapes: {
        present: shapes.present,
        reason: shapes.reason,
        groups: shapes.groups,
        count: shapes.shapes.length,
        unreadable: shapes.unreadable ?? [],
        shapes: shapes.shapes.map((shape) => shape.case_path),
      },
      replay_instruction:
        "node -e \"import('./scripts/lib/case_generator.mjs').then(async m => { const s = m.loadDimensionSpace(); const c = m.buildGeneratorContext(s); const g = m.generateCase({ seed: SEED, context: c }); console.log(g.sha256); })\"",
      interesting_seeds: interesting,
      reason_terminal_closure: reasonTerminalClosureTable(context).rows.filter(
        (row) => row.unlawful_in_classes.length > 0,
      ),
      distribution_summary: {
        cases: distribution.cases,
        under_sampled_threshold: distribution.under_sampled_threshold,
        under_sampled: distribution.under_sampled,
        strata: distribution.strata,
        lane_coverage: distribution.lane_coverage,
        under_sampled_lanes: distribution.under_sampled_lanes,
        support_class_distribution: distribution.support_class_distribution,
        early_stop_distribution: distribution.early_stop_distribution,
      },
    };
    fs.writeFileSync(SEED_REGISTRY_PATH, stableJson(registry));
    process.stderr.write(
      `wrote ${path.relative(ROOT, SEED_REGISTRY_PATH)} (${productSeeds.length} product seed(s) + 1 synthetic ` +
        `mechanism proof at seed ${mechanismProof.seed}, from ${count} cases)\n`,
    );
  }

  if (options.out) {
    fs.writeFileSync(
      options.out,
      stableJson({
        generator_version: CASE_GENERATOR_VERSION,
        dimension_space_version: space.contract.space_version,
        dimension_space_sha256: space.sha256,
        root_seed: rootSeed,
        tier,
        count,
        cases: cohort.cases,
      }),
    );
  }
  if (options.report) fs.writeFileSync(options.report, stableJson(distribution));

  console.log(
    JSON.stringify({
      status: "OK",
      tier,
      cases: count,
      root_seed: rootSeed,
      declared_space_size: spaceSize(context).toString(),
      distinct_signatures: bySignature.size,
      violations: violationCount,
      undispositioned: [...bySignature.keys()].filter((signature) => !dispositions.has(signature)),
      under_sampled: distribution.under_sampled.length,
      dimension_space_sha256: space.sha256,
    }),
  );
} else if (!options.emitSpace) {
  process.stderr.write(
    "usage: generate_case_cohort.mjs [--tier ci_default|pr|nightly|weekly] [--count N] [--seed S]\n" +
      "                               [--out FILE] [--report FILE] [--emit-space] [--update-seed-registry]\n",
  );
  process.exit(2);
}
