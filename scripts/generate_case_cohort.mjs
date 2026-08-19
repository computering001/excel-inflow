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
 * reproduction and the case digest that makes it replayable by seed alone.
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
 */
const DISPOSITIONED_DEFECTS = [
  {
    signature: "declared_absence_never_becomes_number|whitespace_only_became_reported_zero",
    property_id: "declared_absence_never_becomes_number",
    severity: "high",
    owner: "opening_instrument_provenance",
    statement:
      "typedDeclaredAmount(' ') returns reported_zero with value 0. A whitespace-only cell is a blank cell in every spreadsheet sense; the empty string is correctly typed reported_blank but whitespace is coerced through Number(' ') === 0 and enters the register as a genuine reported zero.",
    repair_pointer: "scripts/lib/opening_instrument_provenance.mjs typedDeclaredAmount — treat a whitespace-only string as reported_blank before the Number() coercion.",
  },
  {
    signature: "declared_absence_never_becomes_number|boolean_false_became_reported_zero",
    property_id: "declared_absence_never_becomes_number",
    severity: "high",
    owner: "opening_instrument_provenance",
    statement:
      "typedDeclaredAmount(false) returns reported_zero with value 0. instrument_period_state.mjs's own NEVER-ZERO comment names Number(false) as one of the three coercions it defends against, but the guard only rejects the nil and reported_blank states, so a boolean false becomes a real zero opening balance.",
    repair_pointer: "scripts/lib/opening_instrument_provenance.mjs typedDeclaredAmount — reject non-number, non-string raws before Number().",
  },
  {
    signature: "declared_absence_never_becomes_number|boolean_true_became_reported_number",
    property_id: "declared_absence_never_becomes_number",
    severity: "medium",
    owner: "opening_instrument_provenance",
    statement:
      "typedDeclaredAmount(true) returns reported_number with value 1. A boolean becomes a real balance of 1 with raw_text 'true' — the same coercion class as boolean false, on the non-zero side.",
    repair_pointer: "scripts/lib/opening_instrument_provenance.mjs typedDeclaredAmount — same repair as boolean_false.",
  },
  {
    signature: "declared_absence_never_becomes_number|empty_array_became_reported_zero",
    property_id: "declared_absence_never_becomes_number",
    severity: "medium",
    owner: "opening_instrument_provenance",
    statement:
      "typedDeclaredAmount([]) returns reported_zero with value 0 and raw_text ''. An empty array is not a reported zero; the typed state makes a false provenance claim about what the source said.",
    repair_pointer: "scripts/lib/opening_instrument_provenance.mjs typedDeclaredAmount — same repair as boolean_false.",
  },
  {
    signature: "absent_declared_balance_never_selected|whitespace_only_selected",
    property_id: "absent_declared_balance_never_selected",
    severity: "high",
    owner: "instrument_period_state",
    statement:
      "An instrument whose declared opening balance is whitespace-only is SELECTED into the opening register with a zero basis amount, because the never-zero guard tests only the nil and reported_blank typed states. Downstream this is indistinguishable from a company that genuinely reported zero.",
    repair_pointer: "scripts/lib/instrument_period_state.mjs compileOpeningInstrumentState — gate on 'the typed state is not a number', not on an allow-list of two absence states.",
  },
  {
    signature: "absent_declared_balance_never_selected|boolean_false_selected",
    property_id: "absent_declared_balance_never_selected",
    severity: "high",
    owner: "instrument_period_state",
    statement:
      "An instrument whose declared opening balance is boolean false is SELECTED with a zero basis amount — exactly the Number(false) coercion the compiler's own comment claims to have closed.",
    repair_pointer: "scripts/lib/instrument_period_state.mjs compileOpeningInstrumentState — same repair as whitespace_only.",
  },
  {
    signature: "absent_declared_balance_never_selected|boolean_true_selected",
    property_id: "absent_declared_balance_never_selected",
    severity: "medium",
    owner: "instrument_period_state",
    statement:
      "An instrument whose declared opening balance is boolean true is SELECTED with a basis amount of 1 and contributes to the reporting total.",
    repair_pointer: "scripts/lib/instrument_period_state.mjs compileOpeningInstrumentState — same repair as whitespace_only.",
  },
  {
    signature: "absent_declared_balance_never_selected|empty_array_selected",
    property_id: "absent_declared_balance_never_selected",
    severity: "medium",
    owner: "instrument_period_state",
    statement:
      "An instrument whose declared opening balance is an empty array is SELECTED with a zero basis amount.",
    repair_pointer: "scripts/lib/instrument_period_state.mjs compileOpeningInstrumentState — same repair as whitespace_only.",
  },
  {
    signature: "unsupported_early_stops_typed|accounting_framework=other_or_unknown",
    property_id: "unsupported_early_stops_typed",
    severity: "high",
    owner: "support_envelope_contract",
    statement:
      "accounting_framework=other_or_unknown classifies the case UNSUPPORTED, whose only legal terminal is UNSUPPORTED_PROFILE, but no early_stop_predicate covers it. The case therefore reaches an UNSUPPORTED verdict with early_stop.stopped=false and no typed reason code to report at preflight.",
    repair_pointer: "assets/support-envelope-v377.json early_stop_predicates — add an unsupported_accounting_framework predicate with a registered PROFILE.* reason code (registry addition required too).",
  },
  {
    signature: "unsupported_early_stops_typed|accounting_framework=unknown",
    property_id: "unsupported_early_stops_typed",
    severity: "high",
    owner: "support_envelope_contract",
    statement:
      "An unstated accounting_framework takes unknown_value_class=UNSUPPORTED and hits the same gap: UNSUPPORTED with no covering early-stop predicate and therefore no typed reason code.",
    repair_pointer: "assets/support-envelope-v377.json early_stop_predicates — the accounting-framework predicate must also fire on an unstated framework.",
  },
  {
    signature: "unsupported_early_stops_typed|historical_periods=unknown",
    property_id: "unsupported_early_stops_typed",
    severity: "high",
    owner: "support_envelope_contract",
    statement:
      "historical_periods unknown_value_class is UNSUPPORTED, but insufficient_history_stop keys on the literal value fewer_than_two, so an unstated period count classifies UNSUPPORTED with no typed stop.",
    repair_pointer: "assets/support-envelope-v377.json insufficient_history_stop — the rule must cover the unknown value as well as fewer_than_two.",
  },
  {
    signature: "unsupported_early_stops_typed|filing_language_format=non_english",
    property_id: "unsupported_early_stops_typed",
    severity: "medium",
    owner: "support_envelope_contract",
    statement:
      "A declared language adapter suppresses unadapted_language_stop but does not change the filing_language_format dimension verdict, which stays UNSUPPORTED. The case is classified UNSUPPORTED and not stopped — the envelope has no mechanism for an adapter to lift a dimension class.",
    repair_pointer: "assets/support-envelope-v377.json — either declare an adapter-conditional dimension value for non_english, or make the adapter a dimension of its own rather than a predicate suppressor.",
  },
  {
    signature: "refusal_terminal_legal_for_support_class|EXPERIMENTAL|SOURCE.issuer_or_reporting_period_unresolved",
    property_id: "refusal_terminal_legal_for_support_class",
    severity: "medium",
    owner: "support_envelope_contract",
    statement:
      "SOURCE.issuer_or_reporting_period_unresolved allows only SOURCE_REQUIRED, but the envelope's EXPERIMENTAL class declares legal terminals [DELIVERED_DEGRADED, INTERNAL_FAILURE, CANCELLED]. An experimental-ring case with unresolvable identity has no lawful terminal: the product cannot ask for a better source.",
    repair_pointer: "assets/support-envelope-v377.json terminal_state_mapping.EXPERIMENTAL — decide whether the experimental ring inherits the user-owned terminals, and say so in the contract.",
  },
  {
    signature: "refusal_terminal_legal_for_support_class|EXPERIMENTAL|SOURCE.opening_debt_unresolved",
    property_id: "refusal_terminal_legal_for_support_class",
    severity: "medium",
    owner: "support_envelope_contract",
    statement:
      "Same hole for opening debt: a REIT or condensed-interim case (both EXPERIMENTAL) whose opening debt cannot be reconciled has no lawful SOURCE_REQUIRED terminal to reach.",
    repair_pointer: "assets/support-envelope-v377.json terminal_state_mapping.EXPERIMENTAL — as above.",
  },
  {
    signature: "refusal_terminal_legal_for_support_class|EXPERIMENTAL|USER.material_economic_choice",
    property_id: "refusal_terminal_legal_for_support_class",
    severity: "medium",
    owner: "support_envelope_contract",
    statement:
      "USER.material_economic_choice allows only ACTION_REQUIRED, which EXPERIMENTAL does not admit. An experimental-ring case facing a genuine material economic choice cannot lawfully ask the user.",
    repair_pointer: "assets/support-envelope-v377.json terminal_state_mapping.EXPERIMENTAL — as above.",
  },
];

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
        "The shrinker is proved against a synthetic oracle (an instrument above a probe threshold) so the proof survives the repair of every real defect below.",
    },
    properties: PROPERTIES.map((property) => ({ id: property.id, statement: property.statement })),
    dispositioned_defects: DISPOSITIONED_DEFECTS.map((entry) => ({ ...entry, seed: null, case_sha256: null })),
    disposition_doctrine:
      "A dispositioned signature is a KNOWN OPEN DEFECT, never accepted behaviour. The property still fires, the seed is still replayed, the suite prints it every run, and a pin that stops reproducing fails the suite so it must be retired rather than left standing. No property is ever loosened to make a case pass.",
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
  const interesting = [...bySignature.values()]
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
    const registry = {
      schema_version: "excel-inflow-generated-case-seed-registry/1.0",
      work_package: "P7.3",
      invariant:
        "A failing seed is PERSISTED with its failure signature and its shrunk minimal reproduction, so a regression is replayable by seed alone.",
      generated_by: `scripts/generate_case_cohort.mjs --update-seed-registry (${CASE_GENERATOR_VERSION})`,
      generator_version: CASE_GENERATOR_VERSION,
      dimension_space_version: space.contract.space_version,
      dimension_space_sha256: space.sha256,
      envelope_version: space.envelope.version,
      envelope_sha256: space.envelope.sha256,
      declared_space_size: spaceSize(context).toString(),
      tiers: space.contract.tiers,
      discovery_sweep: { root_seed: rootSeed, cases: count, tier, violations: violationCount },
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
      `wrote ${path.relative(ROOT, SEED_REGISTRY_PATH)} (${interesting.length} interesting seeds from ${count} cases)\n`,
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
